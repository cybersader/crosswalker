/**
 * crosswalker-pivot-view.ts — Phase 3 v0.1.6 (per Settled #2 + Ch 30)
 *
 * The single custom Bases view registered in v0.1.6: `crosswalkerPivot`.
 * Renders a pivot grid (rows × cols × cells) from Bases-filtered entries.
 *
 * Lifecycle (Component):
 *   - constructor: Bases injects controller + containerEl + plugin ref
 *   - onload: setup container + initial render
 *   - onDataUpdated: Bases calls when filters/entries change → re-render
 *   - onunload: clean up DOM
 *
 * Data flow:
 *   1. Bases applies its global+view filters → controller.entries (BasesEntry[])
 *   2. View options provide rows axis, cols axis, cell op, optional heatmap
 *   3. computePivotGrid (pure helper) shapes entries into rows × cols matrix
 *   4. View renders matrix as <table> with optional heatmap CSS variables
 *
 * Per Ch 29 §4 + Ch 30 §5: pivot is Layer B (presentation); data shaping
 * lives in pivot-grid.ts (pure function); this file is the DOM renderer.
 */

import { Component, setIcon } from 'obsidian';
import {
	computePivotGrid,
	heatmapIntensity,
	type PivotAggregationOp,
	type PivotEntry,
	type PivotGridResult,
} from './pivot-grid';

/**
 * Minimal subset of the Bases controller surface we depend on. We don't import
 * Bases types directly because they aren't exported from the public Obsidian
 * `obsidian` package (they live behind `obsidian-typings` or internal paths).
 * Casting through this interface keeps Crosswalker compile-clean even when
 * Obsidian Bases types churn.
 */
interface MinimalBasesController {
	/** Filtered entries — Bases applies its global + view filters before passing. */
	entries?: unknown[];
	/** Bases view config object (read-only at our layer). */
	config?: {
		/** View options keyed by ViewOption.key. */
		[key: string]: unknown;
	};
	/** Subscribe to data-update events; we use onDataUpdated() lifecycle instead. */
	on?: (event: string, callback: () => void) => void;
}

/** Bases Entry shape — minimal subset. Real BasesEntry has more (file ref, properties, etc.). */
interface MinimalBasesEntry {
	properties?: Record<string, unknown>;
	file?: { path: string; basename: string };
	/** Some Bases versions expose properties at the top level. */
	[key: string]: unknown;
}

/**
 * Factory that returns a CrosswalkerPivotView constructor. Adapter pattern
 * matching TaskNotes v4: Bases calls `factory(controller, containerEl)` to get
 * an instance, but we need access to the plugin handle for queryCrosswalk +
 * settings. Closure captures the plugin ref.
 */
export type PivotPluginRef = {
	queryCrosswalk?: (subjectOntology: string, objectOntology: string, predicateId?: string) => Promise<unknown[]>;
	debug?: { info?: (category: string, op: string, msg: string, data?: Record<string, unknown>) => void };
};

export function buildCrosswalkerPivotViewFactory(plugin: PivotPluginRef) {
	return (controller: unknown, containerEl: HTMLElement) => {
		const view = new CrosswalkerPivotView(controller as MinimalBasesController, containerEl, plugin);
		// Bases calls onload() on the returned object (it's a Component).
		// Our load() is a no-op until Bases sets app/config/data on us.
		return view;
	};
}

class CrosswalkerPivotView extends Component {
	private controller: MinimalBasesController;
	private containerEl: HTMLElement;
	private plugin: PivotPluginRef;
	private rootEl: HTMLElement | null = null;
	/** Debounce re-renders during rapid Bases data updates. */
	private renderDebounce: number | null = null;
	/** Limits the entry-source diagnostic to the first few renders per instance. */
	private diagCount = 0;
	/** Set once we've logged a render that actually produced entries. */
	private loggedNonEmpty = false;
	/** Set once we've logged where the view config was found. */
	private configProbeLogged = false;

	constructor(
		controller: MinimalBasesController,
		containerEl: HTMLElement,
		plugin: PivotPluginRef,
	) {
		super();
		this.controller = controller;
		this.containerEl = containerEl;
		this.plugin = plugin;
	}

	/** Component lifecycle: called when Bases instantiates the view. */
	onload(): void {
		this.containerEl.empty();
		this.rootEl = this.containerEl.createDiv({ cls: 'crosswalker-pivot-grid' });
		try {
			this.render();
		} catch (err) {
			this.renderError(err instanceof Error ? err.message : String(err));
		}
	}

	/** No-op focus handler. Obsidian's workspace restore may call focus() on the
	 *  active leaf's view during reload; without this it can throw
	 *  "n.focus is not a function" and abort app load. */
	focus(): void {
		/* intentionally empty */
	}

	/**
	 * Obsidian / Bases probe these when a leaf is switched away or resized — to
	 * save scroll/selection state before teardown. If a method is missing, the
	 * call throws ("x is not a function") and Obsidian SILENTLY ABORTS the
	 * navigation — the exact symptom of "I can't switch away from this base."
	 * Safe no-op defaults (same fix shape as `focus()` above).
	 */
	getEphemeralState(): Record<string, unknown> {
		this.plugin.debug?.info?.('view', 'pivot-lifecycle', 'getEphemeralState (switching away)');
		return {};
	}
	setEphemeralState(): void {
		/* no-op */
	}
	getState(): Record<string, unknown> {
		return {};
	}
	setState(): void {
		/* no-op */
	}
	onResize(): void {
		/* no-op */
	}

	/** Component lifecycle: clean up on unmount. */
	onunload(): void {
		this.plugin.debug?.info?.('view', 'pivot-lifecycle', 'onunload (teardown)');
		if (this.renderDebounce !== null) {
			window.clearTimeout(this.renderDebounce);
			this.renderDebounce = null;
		}
		this.rootEl?.empty();
		this.rootEl = null;
	}

	/**
	 * BasesView lifecycle: called by Bases whenever filters change or entries update.
	 * Debounced 100ms to avoid thrashing during rapid filter typing.
	 */
	onDataUpdated(): void {
		if (!this.rootEl?.isConnected) return;

		if (this.renderDebounce !== null) window.clearTimeout(this.renderDebounce);
		const win = this.containerEl.ownerDocument.defaultView ?? window;
		this.renderDebounce = win.setTimeout(() => {
			this.renderDebounce = null;
			try {
				this.render();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.renderError(msg);
			}
		}, 100);
	}

	/** Render the pivot grid into rootEl. */
	private render(): void {
		if (!this.rootEl) return;
		this.rootEl.empty();

		const entries = this.collectEntries();
		const config = this.collectConfig();

		// Empty-state cases — Phase 5: explicit diagnostic, not generic "No entries"
		if (entries.length === 0) {
			this.renderDiagnosticEmpty(config);
			return;
		}

		// Default axes: prefer the rolled-up group fields (compact, readable — a
		// function×family matrix) when the edges carry them; fall back to the leaf id
		// fields; always honor explicit config.
		const sample = (entries[0] ?? {}) as PivotEntry;
		const pick = (cfg: string | undefined, group: string, leaf: string): string =>
			(cfg ?? (group in sample ? group : leaf in sample ? leaf : '')).trim();
		const rowsBy = pick(config.rowsBy, 'subject_group', 'subject_id');
		const colsBy = pick(config.colsBy, 'object_group', 'object_id');
		if (!rowsBy || !colsBy) {
			this.renderEmpty('Set rows-by and cols-by in the view options to render this pivot.');
			return;
		}

		const result = computePivotGrid(entries, {
			rowsBy: (e: PivotEntry) => extractProp(e, rowsBy),
			colsBy: (e: PivotEntry) => extractProp(e, colsBy),
			cellOp: config.cellOp,
			cellOf: config.cellOf ? (e: PivotEntry) => extractProp(e, config.cellOf as string) : undefined,
			empty: config.empty,
			rowSort: config.rowSort,
			colSort: config.colSort,
		});

		// Phase 5 sparse-pivot HARD guard — block render when the result is
		// degenerate (zero non-empty cells OR over the hard cell-count ceiling).
		const cellCount = result.rowKeys.length * result.colKeys.length;
		const HARD_CELL_CEILING = 250_000;
		if (cellCount > HARD_CELL_CEILING) {
			this.renderEmpty(
				`Pivot is too large to render: ${result.rowKeys.length.toLocaleString()} rows × ` +
				`${result.colKeys.length.toLocaleString()} cols = ${cellCount.toLocaleString()} cells ` +
				`(ceiling: ${HARD_CELL_CEILING.toLocaleString()}). Narrow the Bases filter, use more ` +
				`selective row/col axes, or pre-aggregate before pivoting.`,
			);
			return;
		}
		if (result.rowKeys.length === 0 || result.colKeys.length === 0) {
			this.renderDiagnosticEmpty(config);
			return;
		}

		// Coverage matrices are inherently sparse (most subject×object pairs are
		// unmapped), so a "sparse" banner is just noise here — intentionally omitted.
		this.renderTable(result, config.heatmap === true);
	}

	/**
	 * Phase 5: explicit empty-state diagnostic. Instead of generic "No entries match,"
	 * tell the user the LIKELY cause: missing SSSOM-imported junction notes.
	 */
	private renderDiagnosticEmpty(config: { emptyMessage?: string }): void {
		if (!this.rootEl) return;
		this.rootEl.empty();
		const wrap = this.rootEl.createDiv({ cls: 'crosswalker-pivot-empty crosswalker-pivot-empty-diagnostic' });
		wrap.createEl('h4', { text: 'No data for this pivot' });
		if (config.emptyMessage) {
			wrap.createEl('p', { text: config.emptyMessage });
		} else {
			wrap.createEl('p', {
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Bases" is Obsidian's proper feature name
				text: 'The Bases filter matched 0 junction notes. Likely causes:',
			});
			const list = wrap.createEl('ul');
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- quotes the literal command palette entry name
			list.createEl('li', { text: 'No crosswalk mappings have been imported yet for the frameworks in this filter. Run "Crosswalker: Import and export: import crosswalk mapping file" to populate the mapping data.' });
			list.createEl('li', { text: "The query's filter targets a folder that does not exist in this vault." });
			list.createEl('li', { text: 'A confidence threshold or filter clause is excluding every junction.' });
		}
	}

	/** Render the pivot data as an HTML table. */
	private renderTable(result: PivotGridResult, heatmap: boolean): void {
		if (!this.rootEl) return;

		const table = this.rootEl.createEl('table', { cls: 'crosswalker-pivot-table' });
		const thead = table.createEl('thead');
		const headerRow = thead.createEl('tr');
		headerRow.createEl('th', { cls: 'crosswalker-pivot-corner', text: '' });
		for (const colKey of result.colKeys) {
			headerRow.createEl('th', { cls: 'crosswalker-pivot-col-header', text: colKey });
		}

		const tbody = table.createEl('tbody');
		for (let r = 0; r < result.rowKeys.length; r++) {
			const tr = tbody.createEl('tr');
			tr.createEl('th', { cls: 'crosswalker-pivot-row-header', text: result.rowKeys[r] });
			for (let c = 0; c < result.colKeys.length; c++) {
				const cell = result.cells[r][c];
				const td = tr.createEl('td', { cls: 'crosswalker-pivot-cell' });
				if (cell === null) {
					td.addClass('crosswalker-pivot-cell-empty');
					td.textContent = '—';
				} else {
					td.textContent = formatCellValue(cell);
				}
				if (heatmap) {
					const intensity = heatmapIntensity(cell, result.range);
					td.style.setProperty('--crosswalker-pivot-cell-intensity', String(intensity));
					td.addClass('crosswalker-pivot-cell-heatmap');
				}
			}
		}

		// Footer: totals + range info.
		const footer = this.rootEl.createDiv({ cls: 'crosswalker-pivot-footer' });
		footer.createSpan({
			text: `${result.rowKeys.length} rows × ${result.colKeys.length} cols · ${result.totalEntries.toLocaleString()} entries`,
		});
		if (result.range) {
			footer.createSpan({
				text: ` · range ${formatCellValue(result.range.min)}–${formatCellValue(result.range.max)}`,
			});
		}
	}

	private renderEmpty(message: string): void {
		if (!this.rootEl) return;
		const empty = this.rootEl.createDiv({ cls: 'crosswalker-pivot-empty' });
		const icon = empty.createSpan({ cls: 'crosswalker-pivot-empty-icon' });
		setIcon(icon, 'info');
		empty.createSpan({ text: ` ${message}` });
	}

	private renderError(message: string): void {
		if (!this.rootEl) return;
		this.rootEl.empty();
		const err = this.rootEl.createDiv({ cls: 'crosswalker-pivot-error' });
		const icon = err.createSpan({ cls: 'crosswalker-pivot-error-icon' });
		setIcon(icon, 'alert-triangle');
		err.createSpan({ text: ` Error: ${message}` });
	}

	/**
	 * Pull the Bases-filtered entries and normalize to PivotEntry shape. Bases has
	 * moved where the filtered entries live across versions (controller.entries →
	 * controller.data.entries → …), so we probe the known locations rather than
	 * assuming one — and log the controller shape so the truth is visible in
	 * crosswalker-debug.log when something doesn't line up.
	 */
	private collectEntries(): PivotEntry[] {
		const raw = this.resolveRawEntries();
		return raw.map((e) => normalizeBasesEntry(e as MinimalBasesEntry));
	}

	/** Find the entries wherever this Bases version exposes them — handling Array,
	 *  Map (current QueryController.results is a Map<file, BasesEntry>), and other
	 *  iterables. First non-empty source wins. */
	private resolveRawEntries(): unknown[] {
		const c = this.controller as unknown as Record<string, unknown>;
		const data = (c.data ?? {}) as Record<string, unknown>;
		const query = (c.query ?? {}) as Record<string, unknown>;
		const qstate = (c.queryState ?? {}) as Record<string, unknown>;
		const candidates: Array<[string, unknown]> = [
			['entries', c.entries],
			['results', c.results],
			['data', c.data],
			['data.entries', data.entries],
			['query.results', query.results],
			['queryState.results', qstate.results],
			['queryState.entries', qstate.entries],
		];
		let chosen = '(none)';
		let arr: unknown[] = [];
		for (const [name, val] of candidates) {
			const a = toEntryArray(val);
			if (a && a.length > 0) {
				chosen = name;
				arr = a;
				break;
			}
			if (a && chosen === '(none)') {
				chosen = `${name}(empty)`;
				arr = a;
			}
		}
		this.logEntryProbe(c, chosen, arr);
		return arr;
	}

	/** Diagnostic: where entries came from + their runtime shape. Logged for the
	 *  first few renders AND the first render that actually yields entries, so the
	 *  exact controller/entry layout is visible in crosswalker-debug.log. */
	private logEntryProbe(c: Record<string, unknown>, chosen: string, arr: unknown[]): void {
		const hasEntries = arr.length > 0;
		const firstPopulated = hasEntries && !this.loggedNonEmpty;
		// Log at most twice per instance: the first render + the first populated one.
		if (this.diagCount >= 1 && !firstPopulated) return;
		this.diagCount++;
		if (hasEntries) this.loggedNonEmpty = true;
		const sample = arr[0] as Record<string, unknown> | undefined;
		const propsRaw = sample?.properties;
		this.plugin.debug?.info?.('view', 'pivot-entry-probe', 'crosswalkerPivot entry probe', {
			chosenSource: chosen,
			entryCount: arr.length,
			resultsShape: shapeOf(c.results),
			dataShape: shapeOf(c.data),
			queryStateShape: shapeOf(c.queryState),
			sampleEntryKeys: sample ? Object.keys(sample).slice(0, 25) : [],
			samplePropsShape: shapeOf(propsRaw),
			samplePropKeys:
				propsRaw instanceof Map
					? [...propsRaw.keys()].slice(0, 25).map(String)
					: propsRaw && typeof propsRaw === 'object'
						? Object.keys(propsRaw as object).slice(0, 25)
						: [],
			hasGetValue: typeof (sample as { getValue?: unknown })?.getValue === 'function',
			hasFile: !!(sample as { file?: unknown })?.file,
			sampleSubjectId: sample
				? extractProp(normalizeBasesEntry(sample as MinimalBasesEntry), 'subject_id')
				: undefined,
		});
	}

	/**
	 * Pull view options. Reads the `.base` view's `config:` block wherever this Bases
	 * version exposes it (the controller no longer has a flat `.config`), and falls
	 * back to the canonical crosswalk axes — `subject_id` × `object_id`, count — so
	 * the coverage pivot renders out-of-the-box with no View-Options-panel fiddling.
	 */
	private collectConfig(): {
		rowsBy?: string;
		colsBy?: string;
		cellOp?: PivotAggregationOp;
		cellOf?: string;
		empty?: 'gap' | 'blank' | 'zero';
		heatmap?: boolean;
		rowSort?: 'asc' | 'desc' | 'none';
		colSort?: 'asc' | 'desc' | 'none';
		emptyMessage?: string;
	} {
		const cfg = this.resolveRawConfig();
		return {
			rowsBy: stringOption(cfg.rowsBy),
			colsBy: stringOption(cfg.colsBy),
			cellOp: aggregationOption(cfg.cellOp) ?? ('count' as PivotAggregationOp),
			cellOf: stringOption(cfg.cellOf),
			empty: emptyOption(cfg.empty),
			heatmap: cfg.heatmap === true,
			rowSort: sortOption(cfg.rowSort),
			colSort: sortOption(cfg.colSort),
			emptyMessage: stringOption(cfg.emptyMessage),
		};
	}

	/** Find the active view's pivot options. Bases parses each view's options into
	 *  `view.data` (the same place native table views keep `order`/`groupBy`);
	 *  `view.config` is a Bases-reserved field that is `null` for custom views.
	 *  Older `.base` files nested our options under `data.config`, so we prefer
	 *  top-level keys and fall back to that nested block for back-compat. */
	private resolveRawConfig(): Record<string, unknown> {
		const c = this.controller as unknown as Record<string, unknown>;
		const viewName = typeof c.viewName === 'string' ? c.viewName : undefined;
		const q = (c.query ?? {}) as Record<string, unknown>;
		let fromViews: Record<string, unknown> | undefined;
		const views = q.views;
		if (Array.isArray(views)) {
			const byName = viewName
				? views.find((v) => (v as Record<string, unknown>)?.name === viewName)
				: undefined;
			const byType = views.find(
				(v) => (v as Record<string, unknown>)?.type === 'crosswalker-pivot',
			);
			const v = (byName ?? byType ?? views[0]) as Record<string, unknown> | undefined;
			const data = v?.data as Record<string, unknown> | undefined;
			const nested = data?.config as Record<string, unknown> | undefined;
			if (data || nested) fromViews = { ...(nested ?? {}), ...(data ?? {}) };
		}
		const candidates: Array<[string, unknown]> = [
			['query.views[].data', fromViews],
			['config', c.config],
			['view.config', (c.view as Record<string, unknown>)?.config],
			['ctx.config', (c.ctx as Record<string, unknown>)?.config],
			['viewConfig', c.viewConfig],
		];
		let chosen = '(none)';
		let cfg: Record<string, unknown> = {};
		for (const [name, val] of candidates) {
			if (val && typeof val === 'object') {
				const o = val as Record<string, unknown>;
				if ('rowsBy' in o || 'colsBy' in o) {
					chosen = name;
					cfg = o;
					break;
				}
				if (chosen === '(none)' && Object.keys(o).length > 0) {
					chosen = `${name}(no-axes)`;
					cfg = o;
				}
			}
		}
		if (!this.configProbeLogged) {
			this.configProbeLogged = true;
			this.plugin.debug?.info?.('view', 'pivot-config-probe', 'crosswalkerPivot config probe', {
				chosenSource: chosen,
				configKeys: Object.keys(cfg).slice(0, 25),
				rowsBy: stringOption(cfg.rowsBy),
				colsBy: stringOption(cfg.colsBy),
			});
		}
		return cfg;
	}
}

// ============================================================================
// Helpers
// ============================================================================

/** Normalize a Bases entry to a flat property-bag for pivot extraction. Frontmatter
 *  lives in `entry.properties`, which across Bases versions is a plain object OR a
 *  Map, with values that are sometimes wrapped ({ value } / { data }). Flatten to a
 *  plain { key: scalar } bag, plus `file.*` paths mirroring Bases formula syntax. */
function normalizeBasesEntry(entry: MinimalBasesEntry): PivotEntry {
	const e = entry as Record<string, unknown>;
	const out: PivotEntry = {};
	// Flatten the note's properties into a { key: scalar } bag. Bases versions differ:
	// current builds expose `entry.frontmatter` (plain object), older ones
	// `entry.properties` (object or Map). `implicit` holds computed/implicit props.
	// First non-undefined wins. Values are sometimes wrapped ({ value } / { data }).
	for (const src of [e.frontmatter, e.properties, e.implicit]) {
		const pairs: Array<[string, unknown]> =
			src instanceof Map
				? [...src.entries()]
				: src && typeof src === 'object'
					? Object.entries(src as Record<string, unknown>)
					: [];
		for (const [k, v] of pairs) if (out[k] === undefined) out[k] = unwrapValue(v);
	}
	const file = e.file as { path?: string; basename?: string } | undefined;
	if (file) {
		if (file.path) out['file.path'] = file.path;
		if (file.basename) out['file.name'] = file.basename;
	}
	return out;
}

/** Coerce a Bases results container (Array | Map | Set | iterable) to an array. */
function toEntryArray(v: unknown): unknown[] | null {
	if (Array.isArray(v)) return v;
	if (v instanceof Map || v instanceof Set) return [...v.values()];
	if (
		v &&
		typeof v === 'object' &&
		typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
	) {
		try {
			return [...(v as Iterable<unknown>)];
		} catch {
			return null;
		}
	}
	return null;
}

/** Unwrap a Bases property value one level: scalars pass through; wrapped values
 *  ({ value } / { data }) yield their inner value. */
function unwrapValue(v: unknown): unknown {
	if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
		const o = v as Record<string, unknown>;
		if ('value' in o) return o.value;
		if ('data' in o) return o.data;
	}
	return v;
}

/** Human-readable runtime shape, for the entry-probe diagnostic. */
function shapeOf(v: unknown): string {
	if (v === null || v === undefined) return String(v);
	if (Array.isArray(v)) return `array(${v.length})`;
	if (v instanceof Map) return `Map(${v.size})`;
	if (v instanceof Set) return `Set(${v.size})`;
	if (typeof v === 'object') {
		const name = (v as { constructor?: { name?: string } }).constructor?.name ?? 'Object';
		const iterable =
			typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
		return `object<${name}>${iterable ? '[iterable]' : ''}`;
	}
	return typeof v;
}

/** Extract a property by name; supports `file.path`, `note.x`, plain key. */
function extractProp(entry: PivotEntry, prop: string): string | undefined {
	if (prop in entry) {
		const v = entry[prop];
		if (v === null || v === undefined) return undefined;
		return String(v);
	}
	// Fallback: dotted-path traversal (e.g. note.frontmatter.status)
	const parts = prop.split('.');
	let cur: unknown = entry;
	for (const part of parts) {
		if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
			cur = (cur as Record<string, unknown>)[part];
		} else {
			return undefined;
		}
	}
	if (cur === null || cur === undefined) return undefined;
	return String(cur);
}

function stringOption(v: unknown): string | undefined {
	if (typeof v === 'string' && v.trim() !== '') return v;
	return undefined;
}

function aggregationOption(v: unknown): PivotAggregationOp | undefined {
	const valid: PivotAggregationOp[] = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max', 'first', 'last'];
	if (typeof v === 'string' && (valid as string[]).includes(v)) return v as PivotAggregationOp;
	return undefined;
}

function emptyOption(v: unknown): 'gap' | 'blank' | 'zero' | undefined {
	if (v === 'gap' || v === 'blank' || v === 'zero') return v;
	return undefined;
}

function sortOption(v: unknown): 'asc' | 'desc' | 'none' | undefined {
	if (v === 'asc' || v === 'desc' || v === 'none') return v;
	return undefined;
}

function formatCellValue(v: number | string): string {
	if (typeof v === 'number') {
		// Round non-integer cells to 3 decimal places for display.
		if (Number.isInteger(v)) return v.toLocaleString();
		return v.toFixed(3);
	}
	return v;
}
