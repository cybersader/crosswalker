/**
 * mapping-review-view.ts — review a table-form mapping set inside Obsidian.
 *
 * Slice 5 of the mapping table form (2026-09-30), Part B. A table-form set has
 * no notes, so the review columns a notes-form user edits as frontmatter
 * (`review_status`, `reviewer`, review notes) need their own editor. This view
 * opens one `*.mapping-table.tsv`, shows its rows in a searchable, sortable,
 * windowed grid, and hands every review edit to `TableReviewStore`, which
 * saves it back into the file through the one table writer.
 *
 * Failure modes prevented:
 * - a large set freezing Obsidian: only the rows in and near the viewport are
 *   in the DOM (`windowRange`), whatever the row count;
 * - a review edit rewriting what a mapping asserts: only the review columns
 *   are inputs; every managed column is text;
 * - an edit accepted that cannot be saved: when the store says the table is
 *   read-only (a conversion owns it, unreadable rows, a refused save), every
 *   input is disabled and a banner names the cause, the action and Reopen.
 */

import { ItemView, Notice, TFile, setIcon, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import type CrosswalkerPlugin from '../main';
import { plural } from '../utils/plural';
import { MAPPING_TABLE_SUFFIX, type MappingTableFile } from '../mappings/mapping-table-reader';
import { readConversionReadState } from '../mappings/conversion-marker';
import {
	REVIEW_STATUSES,
	filterRows,
	isReviewStatus,
	mergeEdit,
	reviewRowsOf,
	sortRows,
	statusCounts,
	type ReviewEdit,
	type ReviewRowView,
	type SortKey,
	type StatusFilter,
} from '../mappings/table-review-model';
import { TableReviewStore, type ReadOnlyReason, type ReviewSaveStatus } from '../mappings/table-review-store';
import { mappingSetLabel, predicateLabel, releaseSectionOf, scrollToRevealRow, visibleSelection, wikilinkPath, windowRange } from './mapping-review-helpers';

export const VIEW_TYPE_MAPPING_REVIEW = 'crosswalker-mapping-review';

/** Fixed row height the window math and the stylesheet share. */
const ROW_HEIGHT = 34;
/** Rows rendered beyond each edge of the viewport. */
const OVERSCAN = 10;
/** Pause after the last keystroke in the search box before filtering. */
const SEARCH_DELAY_MS = 150;
/** How much of a `.tsv` that is not a mapping table the preview shows. */
const PREVIEW_CHARS = 20_000;

const STATUS_LABELS: Record<string, string> = {
	unset: 'Unset',
	proposed: 'Proposed',
	in_review: 'In review',
	approved: 'Approved',
	deprecated: 'Deprecated',
	other: 'Other',
};

interface Column {
	key: SortKey;
	label: string;
}

const COLUMNS: Column[] = [
	{ key: 'subject', label: 'Subject' },
	{ key: 'predicate', label: 'Predicate' },
	{ key: 'object', label: 'Object' },
	{ key: 'justification', label: 'Justification' },
	{ key: 'confidence', label: 'Confidence' },
	{ key: 'review_status', label: 'Review status' },
	{ key: 'reviewer', label: 'Reviewer' },
	{ key: 'review_notes', label: 'Review notes' },
	{ key: 'mapping_set_id', label: 'Set id' },
];

export function statusLabel(status: string | undefined): string {
	if (status === undefined || status === '') return STATUS_LABELS.unset;
	return STATUS_LABELS[status] ?? status;
}

/** The status line after a save that found the file changed underneath and reloaded it. */
const RELOADED_MESSAGE = 'The file changed since it was opened and was reloaded. Your edits were kept.';

/** Which grid control had focus, so a rebuild of the rendered rows can give it back. */
interface GridFocus {
	rowId: string;
	field: string;
	selectionStart: number | null;
	selectionEnd: number | null;
}

/** Apply one review edit to a view row in place: the optimistic copy the grid shows. */
function applyToView(row: ReviewRowView, edit: ReviewEdit): void {
	const clean = (value: string | null | undefined): string | undefined =>
		value === null || value === '' ? undefined : value ?? undefined;
	if (edit.review_status !== undefined) row.review_status = clean(edit.review_status);
	if (edit.reviewer !== undefined) row.reviewer = clean(edit.reviewer);
	if (edit.review_notes !== undefined) row.review_notes = clean(edit.review_notes);
}

export class MappingReviewView extends ItemView {
	private path = '';
	private store: TableReviewStore | null = null;
	private table: MappingTableFile | null = null;
	private readOnly: ReadOnlyReason | undefined;
	/** Every row of the table, with unsaved edits applied. */
	private allRows: ReviewRowView[] = [];
	private rowsById = new Map<string, ReviewRowView>();
	/** Rows after search, filter and sort, in display order. */
	private visible: ReviewRowView[] = [];
	/** Edits not yet confirmed saved, re-applied when the store reloads the file. */
	private unsaved = new Map<string, ReviewEdit>();
	private selected = new Set<string>();
	private searchText = '';
	private statusFilter: StatusFilter = 'any';
	private sortKey: SortKey | null = null;
	private sortDirection: 'asc' | 'desc' = 'asc';
	private activeIndex = -1;
	private drawerOpen = false;
	/** Bumped on every open so a slow load for an older path cannot paint. */
	private openToken = 0;
	private searchTimer: number | null = null;
	private frame: number | null = null;
	/**
	 * Set when a save reloaded the table because the file changed underneath.
	 * The store announces the reload and then a plain 'saved'; the flag makes
	 * that 'saved' keep saying the file was reloaded instead of a bare Saved.
	 */
	private reloadPending = false;

	// Elements of the rendered table view.
	private rootEl: HTMLElement | null = null;
	private pillsEl: HTMLElement | null = null;
	private metaEl: HTMLElement | null = null;
	private releaseEl: HTMLElement | null = null;
	private bannerEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private selectionEl: HTMLElement | null = null;
	private scrollerEl: HTMLElement | null = null;
	private headerRowEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private rowsEl: HTMLElement | null = null;
	private drawerEl: HTMLElement | null = null;
	private controls: Array<HTMLInputElement | HTMLSelectElement | HTMLButtonElement> = [];

	constructor(leaf: WorkspaceLeaf, private plugin: CrosswalkerPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_MAPPING_REVIEW;
	}

	getDisplayText(): string {
		if (!this.path) return 'Mapping review';
		const name = this.path.slice(this.path.lastIndexOf('/') + 1).replace(/\.mapping-table\.tsv$/, '');
		return `Review ${name}`;
	}

	getIcon(): string {
		return 'table';
	}

	/** The table path this view shows, for callers that reuse an open review. */
	getPath(): string {
		return this.path;
	}

	getState(): Record<string, unknown> {
		return { path: this.path };
	}

	/**
	 * Accepts `{ path }` (the command, Installed stacks, a restored layout) and
	 * `{ file }` (the file explorer, when the `.tsv` extension is registered).
	 */
	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const record = (state ?? {}) as { path?: unknown; file?: unknown };
		const path = typeof record.path === 'string' ? record.path : typeof record.file === 'string' ? record.file : '';
		if (path && path !== this.path) await this.openPath(path);
		await super.setState(state, result);
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('crosswalker-mapping-review');
		// Registered once for the life of the view: renderTable runs on every open,
		// and a listener per render would pile up.
		this.registerDomEvent(window, 'resize', () => this.scheduleGrid());
		if (!this.path) this.renderMessage('No mapping table is open.', 'Open one from Installed stacks, or run Review a mapping table from the command palette.');
	}

	async onClose(): Promise<void> {
		this.openToken++;
		await this.closeStore();
		this.contentEl.empty();
	}

	/** Save what is pending and stop the store. Unsaved edits are named in a notice by the store. */
	private async closeStore(): Promise<void> {
		if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.searchTimer = null;
		this.frame = null;
		const store = this.store;
		this.store = null;
		if (store) await store.dispose();
	}

	/** Open `path`: a mapping table in the grid, any other `.tsv` as a read-only preview. */
	async openPath(path: string): Promise<void> {
		const token = ++this.openToken;
		await this.closeStore();
		this.path = path;
		this.resetState();
		this.contentEl.empty();
		this.contentEl.addClass('crosswalker-mapping-review');
		this.contentEl.dataset.path = path;
		// Obsidian redraws the tab title from getDisplayText on the next layout pass.
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
		if (!path.endsWith(MAPPING_TABLE_SUFFIX)) {
			await this.renderNotATable(path, token);
			return;
		}
		this.contentEl.createDiv({ cls: 'crosswalker-mr-loading', text: 'Loading the mapping table...' });
		const store = new TableReviewStore(this.app, {
			project: (tablePath) => this.plugin.projectMappingTable(tablePath),
			markers: () => readConversionReadState(this.app),
		}, path);
		this.store = store;
		store.onStatus((status, message) => this.onStoreStatus(store, status, message));
		store.onReload((table) => { if (this.store === store) this.useTable(table, true); });
		const loaded = await store.load();
		if (token !== this.openToken) return;
		this.readOnly = loaded.readOnly;
		this.renderTable();
		this.useTable(loaded.table, false);
	}

	private resetState(): void {
		this.table = null;
		this.readOnly = undefined;
		this.allRows = [];
		this.rowsById = new Map();
		this.visible = [];
		this.unsaved = new Map();
		this.selected = new Set();
		this.searchText = '';
		this.statusFilter = 'any';
		this.sortKey = null;
		this.sortDirection = 'asc';
		this.activeIndex = -1;
		this.drawerOpen = false;
		this.reloadPending = false;
	}

	private renderMessage(reason: string, action: string): void {
		this.contentEl.empty();
		const banner = this.contentEl.createDiv({ cls: 'crosswalker-mr-banner' });
		banner.createDiv({ text: reason });
		banner.createDiv({ cls: 'crosswalker-mr-banner-action', text: action });
	}

	/**
	 * A `.tsv` that is not a Crosswalker mapping table: say so, say how to open
	 * `.tsv` files elsewhere, and show the text read-only. Never an editor, so
	 * claiming the extension cannot damage another tool's file.
	 */
	private async renderNotATable(path: string, token: number): Promise<void> {
		this.contentEl.dataset.readOnly = 'not-a-table';
		const banner = this.contentEl.createDiv({ cls: 'crosswalker-mr-banner' });
		banner.createDiv({ text: 'This is not a Crosswalker mapping table.' });
		banner.createDiv({
			cls: 'crosswalker-mr-banner-action',
			text: 'Crosswalker opens .tsv files because Open mapping tables in Crosswalker is on. To open .tsv files with another plugin, turn it off in Crosswalker settings under Advanced, then reload Obsidian.',
		});
		const file = this.app.vault.getAbstractFileByPath(path);
		let text: string;
		if (!(file instanceof TFile)) {
			text = '';
			banner.createDiv({ cls: 'crosswalker-mr-banner-action', text: `The file ${path} no longer exists. It may have been moved or renamed.` });
		} else {
			try {
				text = await this.app.vault.cachedRead(file);
			} catch {
				text = '';
				banner.createDiv({ cls: 'crosswalker-mr-banner-action', text: 'Could not read this file. Check it is not open in another program, then open it again.' });
			}
		}
		if (token !== this.openToken) return;
		const shown = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}\n...` : text;
		this.contentEl.createEl('pre', { cls: 'crosswalker-mr-preview', text: shown });
	}

	// ---------------------------------------------------------------------
	// Data
	// ---------------------------------------------------------------------

	/** Take a table from the store: first load, or a reload after the file changed underneath. */
	private useTable(table: MappingTableFile, reloaded: boolean): void {
		this.table = table;
		this.allRows = reviewRowsOf(table);
		this.rowsById = new Map(this.allRows.map((row) => [row.row_id, row]));
		for (const [rowId, edit] of this.unsaved) {
			const row = this.rowsById.get(rowId);
			if (row) applyToView(row, edit);
			else this.unsaved.delete(rowId);
		}
		const activeId = this.visible[this.activeIndex]?.row_id;
		this.recompute();
		// A reloaded file can drop rows or move them out of the filter; the
		// selection never holds a row that is not on screen.
		this.pruneSelection();
		if (activeId) this.activeIndex = this.visible.findIndex((row) => row.row_id === activeId);
		if (reloaded) {
			this.reloadPending = true;
			this.setStatus('saved', RELOADED_MESSAGE);
		}
		this.renderSelection();
		this.renderHeader();
		this.renderGrid();
		this.renderDrawer();
	}

	/** Search, filter and sort `allRows` into `visible`. */
	private recompute(): void {
		const filtered = filterRows(this.allRows, { text: this.searchText, status: this.statusFilter });
		this.visible = this.sortKey ? sortRows(filtered, this.sortKey, this.sortDirection) : filtered;
		if (this.activeIndex >= this.visible.length) this.activeIndex = this.visible.length - 1;
		if (this.countEl) {
			this.countEl.setText(this.visible.length === this.allRows.length
				? `Showing all ${plural(this.allRows.length, 'mapping')}`
				: `Showing ${this.visible.length.toLocaleString()} of ${plural(this.allRows.length, 'mapping')}`);
		}
	}

	/**
	 * Hand edits to the store and show them at once. A read-only or closed
	 * store refuses; the refusal reaches the status line, never a silent drop.
	 */
	private queue(edits: ReviewEdit[]): number {
		const store = this.store;
		if (!store || this.readOnly) return 0;
		let queued = 0;
		try {
			for (const edit of edits) {
				store.queueEdit(edit);
				this.unsaved.set(edit.row_id, mergeEdit(this.unsaved.get(edit.row_id), edit));
				const row = this.rowsById.get(edit.row_id);
				if (row) applyToView(row, edit);
				queued++;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Could not queue this edit. Reopen the table, then try again.';
			this.setStatus('error', message);
			this.syncReadOnly();
		}
		this.renderPills();
		return queued;
	}

	private onStoreStatus(store: TableReviewStore, status: ReviewSaveStatus, message?: string): void {
		if (this.store !== store) return;
		if (status === 'saved' && store.pendingCount() === 0) this.unsaved.clear();
		this.setStatus(status, message);
		if (status === 'error') this.syncReadOnly();
	}

	/** A refused save turns the store read-only; mirror that in the banner and inputs. */
	private syncReadOnly(): void {
		const reason = this.store?.readOnlyReason();
		if (reason === this.readOnly) return;
		this.readOnly = reason;
		this.renderBanner();
		this.renderGrid();
	}

	private setStatus(status: ReviewSaveStatus, message?: string): void {
		if (status === 'saved' && !message && this.reloadPending) {
			this.reloadPending = false;
			message = RELOADED_MESSAGE;
		} else if (status === 'error') {
			this.reloadPending = false;
		}
		if (!this.statusEl) return;
		this.statusEl.dataset.state = status;
		this.statusEl.toggleClass('is-error', status === 'error');
		const text = status === 'saving' ? 'Saving' : status === 'saved' ? 'Saved' : '';
		this.statusEl.setText(message ? (text ? `${text}. ${message}` : message) : text);
	}

	// ---------------------------------------------------------------------
	// Layout
	// ---------------------------------------------------------------------

	private renderTable(): void {
		const root = this.contentEl;
		root.empty();
		this.controls = [];
		this.rootEl = root;
		const header = root.createDiv({ cls: 'crosswalker-mr-header' });
		const titles = header.createDiv({ cls: 'crosswalker-mr-titles' });
		titles.createEl('h2', { cls: 'crosswalker-mr-title', text: 'Mapping review' });
		this.metaEl = titles.createDiv({ cls: 'crosswalker-mr-meta' });
		this.pillsEl = header.createDiv({ cls: 'crosswalker-mr-pills' });
		this.releaseEl = root.createDiv({ cls: 'crosswalker-mr-release', attr: { role: 'region', 'aria-label': 'Release' } });
		this.bannerEl = root.createDiv({ cls: 'crosswalker-mr-banner-host' });

		const toolbar = root.createDiv({ cls: 'crosswalker-mr-toolbar' });
		const search = toolbar.createEl('input', {
			cls: 'crosswalker-mr-search',
			attr: { type: 'search', placeholder: 'Search ids, labels and justification', 'aria-label': 'Search mappings' },
		});
		search.addEventListener('input', () => {
			if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
			this.searchTimer = window.setTimeout(() => {
				this.searchTimer = null;
				this.searchText = search.value;
				this.afterQueryChange();
			}, SEARCH_DELAY_MS);
		});
		const filter = toolbar.createEl('select', { cls: 'dropdown crosswalker-mr-filter', attr: { 'aria-label': 'Filter by review status' } });
		filter.createEl('option', { value: 'any', text: 'Any status' });
		filter.createEl('option', { value: 'unset', text: 'Unset' });
		for (const status of REVIEW_STATUSES) filter.createEl('option', { value: status, text: statusLabel(status) });
		filter.addEventListener('change', () => {
			this.statusFilter = filter.value as StatusFilter;
			this.afterQueryChange();
		});
		this.countEl = toolbar.createDiv({ cls: 'crosswalker-mr-count' });
		this.statusEl = toolbar.createDiv({ cls: 'crosswalker-mr-status', attr: { 'aria-live': 'polite' } });

		const bulk = root.createDiv({ cls: 'crosswalker-mr-bulk' });
		const selectAll = bulk.createEl('button', { cls: 'crosswalker-mr-select-all', text: 'Select all matching' });
		selectAll.addEventListener('click', () => {
			for (const row of this.visible) this.selected.add(row.row_id);
			this.renderSelection();
			this.renderGrid();
		});
		const clear = bulk.createEl('button', { cls: 'crosswalker-mr-clear-selection', text: 'Clear selection' });
		clear.addEventListener('click', () => {
			this.selected.clear();
			this.renderSelection();
			this.renderGrid();
		});
		this.selectionEl = bulk.createDiv({ cls: 'crosswalker-mr-selection' });
		const bulkStatus = bulk.createEl('select', { cls: 'dropdown crosswalker-mr-bulk-status', attr: { 'aria-label': 'Set status for the selected mappings' } });
		bulkStatus.createEl('option', { value: '', text: 'Set status' });
		for (const status of REVIEW_STATUSES) bulkStatus.createEl('option', { value: status, text: statusLabel(status) });
		bulkStatus.createEl('option', { value: 'unset', text: 'Clear status' });
		bulkStatus.addEventListener('change', () => {
			const value = bulkStatus.value;
			bulkStatus.value = '';
			if (!value) return;
			this.bulkEdit((rowId) => ({ row_id: rowId, review_status: value === 'unset' ? null : value }));
		});
		const reviewer = bulk.createEl('input', {
			cls: 'crosswalker-mr-bulk-reviewer',
			attr: { type: 'text', placeholder: 'Reviewer name', 'aria-label': 'Reviewer for the selected mappings' },
		});
		const setReviewer = bulk.createEl('button', { cls: 'crosswalker-mr-set-reviewer', text: 'Set reviewer' });
		setReviewer.addEventListener('click', () => {
			const name = reviewer.value.trim();
			if (!name) {
				this.setStatus('error', 'No reviewer name was typed. Type a name, then choose Set reviewer.');
				return;
			}
			this.bulkEdit((rowId) => ({ row_id: rowId, reviewer: name }));
		});
		this.controls.push(bulkStatus, reviewer, setReviewer);

		const body = root.createDiv({ cls: 'crosswalker-mr-body' });
		// The frame paints the grid's focus ring above the rows; on the scroller
		// itself the ring sits under the opaque rows and only the edges show.
		const frame = body.createDiv({ cls: 'crosswalker-mr-frame' });
		const scroller = frame.createDiv({ cls: 'crosswalker-mr-scroller', attr: { tabindex: '0', role: 'grid', 'aria-label': 'Mappings' } });
		this.scrollerEl = scroller;
		const inner = scroller.createDiv({ cls: 'crosswalker-mr-inner' });
		this.headerRowEl = inner.createDiv({ cls: 'crosswalker-mr-grid-row crosswalker-mr-head', attr: { role: 'row' } });
		this.bodyEl = inner.createDiv({ cls: 'crosswalker-mr-grid-body' });
		this.rowsEl = this.bodyEl.createDiv({ cls: 'crosswalker-mr-rows' });
		this.drawerEl = body.createDiv({ cls: 'crosswalker-mr-drawer' });
		scroller.addEventListener('scroll', () => this.scheduleGrid());
		scroller.addEventListener('keydown', (event) => this.onKey(event));
		this.renderHead();
		this.renderBanner();
		this.renderSelection();
		// Nothing has been edited yet, so the status line says nothing: "Saved"
		// before any edit would claim work that never happened.
		if (this.statusEl) this.statusEl.dataset.state = 'idle';
	}

	private afterQueryChange(): void {
		this.activeIndex = -1;
		this.recompute();
		this.pruneSelection();
		this.renderSelection();
		if (this.scrollerEl) this.scrollerEl.scrollTop = 0;
		this.renderGrid();
		this.renderDrawer();
	}

	/** Keep only selected rows that the search and filter still show. */
	private pruneSelection(): void {
		this.selected = visibleSelection(this.selected, this.visible.map((row) => row.row_id));
	}

	private bulkEdit(make: (rowId: string) => ReviewEdit): void {
		// Only rows on screen: a row selected before the filter changed and now
		// hidden is never edited by a bulk action.
		const ids = [...visibleSelection(this.selected, this.visible.map((row) => row.row_id))];
		if (!ids.length) {
			this.setStatus('error', 'No mappings are selected. Tick rows, or choose Select all matching, then try again.');
			return;
		}
		const queued = this.queue(ids.map(make));
		if (queued) new Notice(`Updated ${plural(queued, 'mapping')}. Saving to the table.`, 4000);
		this.renderGrid();
		this.renderDrawer();
	}

	private renderHeader(): void {
		if (!this.table || !this.metaEl) return;
		const title = this.rootEl?.querySelector('.crosswalker-mr-title');
		title?.setText(mappingSetLabel(this.table.header, this.path));
		this.metaEl.setText(`${plural(this.allRows.length, 'mapping')} in ${this.path}`);
		this.renderPills();
		this.renderRelease();
	}

	/**
	 * The Release section: what this set is (its release record) and whether the
	 * rows still match it. Recomputed from the table on every load and reload;
	 * review edits never change it.
	 */
	private renderRelease(): void {
		const host = this.releaseEl;
		if (!host || !this.table) return;
		host.empty();
		const section = releaseSectionOf(this.table);
		host.dataset.state = section.state;
		const head = host.createDiv({ cls: 'crosswalker-mr-release-head' });
		head.createSpan({ cls: 'crosswalker-mr-release-label', text: 'Release' });
		if (section.state !== 'recorded') {
			head.createSpan({ cls: 'crosswalker-mr-release-note', text: section.text });
			return;
		}
		head.createSpan({ cls: 'crosswalker-mr-release-name', text: section.heading });
		const membership = head.createSpan({
			cls: `crosswalker-mr-release-membership ${section.membership.intact ? 'is-intact' : 'is-changed'}`,
			attr: { 'data-intact': section.membership.intact ? 'yes' : 'no' },
		});
		const icon = membership.createSpan({ cls: 'crosswalker-mr-release-icon' });
		setIcon(icon, section.membership.intact ? 'check-circle' : 'alert-triangle');
		membership.createSpan({ text: section.membership.text });
		const facts = host.createEl('dl', { cls: 'crosswalker-mr-release-facts' });
		for (const fact of section.facts) {
			const item = facts.createDiv({ cls: 'crosswalker-mr-release-fact' });
			item.createEl('dt', { text: fact.label });
			item.createEl('dd', { text: fact.value });
		}
	}

	private renderPills(): void {
		const host = this.pillsEl;
		if (!host) return;
		host.empty();
		const counts = statusCounts(this.allRows);
		const order: Array<keyof typeof counts> = ['unset', ...REVIEW_STATUSES, 'other'];
		for (const key of order) {
			const count = counts[key];
			if (key === 'other' && count === 0) continue;
			const pill = host.createEl('button', {
				cls: `crosswalker-mr-pill is-${key.replace('_', '-')}`,
				attr: { 'data-status': key, 'aria-label': `Show ${statusLabel(key).toLowerCase()} mappings` },
			});
			pill.createSpan({ cls: 'crosswalker-mr-pill-label', text: statusLabel(key) });
			pill.createSpan({ cls: 'crosswalker-mr-pill-count', text: count.toLocaleString() });
			if (key === 'other') { pill.disabled = true; continue; }
			pill.addEventListener('click', () => {
				this.statusFilter = this.statusFilter === key ? 'any' : key as StatusFilter;
				const filter = this.rootEl?.querySelector<HTMLSelectElement>('.crosswalker-mr-filter');
				if (filter) filter.value = this.statusFilter;
				this.afterQueryChange();
			});
		}
	}

	private renderBanner(): void {
		const host = this.bannerEl;
		if (!host) return;
		host.empty();
		this.contentEl.dataset.readOnly = this.readOnly ? 'yes' : 'no';
		for (const control of this.controls) control.disabled = !!this.readOnly;
		if (!this.readOnly) return;
		const banner = host.createDiv({ cls: 'crosswalker-mr-banner' });
		const icon = banner.createSpan({ cls: 'crosswalker-mr-banner-icon' });
		setIcon(icon, 'lock');
		const copy = banner.createDiv({ cls: 'crosswalker-mr-banner-copy' });
		copy.createDiv({ text: this.readOnly.reason });
		copy.createDiv({ cls: 'crosswalker-mr-banner-action', text: this.readOnly.action });
		const reopen = banner.createEl('button', { cls: 'mod-cta crosswalker-mr-reopen', text: 'Reopen' });
		reopen.addEventListener('click', () => { void this.reopen(); });
	}

	/** Re-run `load`: re-checks the file and markers, and saves kept edits once editable again. */
	private async reopen(): Promise<void> {
		const store = this.store;
		if (!store) return;
		const loaded = await store.load();
		if (this.store !== store) return;
		this.readOnly = loaded.readOnly;
		this.renderBanner();
		this.useTable(loaded.table, false);
		if (!loaded.readOnly && store.pendingCount()) this.setStatus('saving');
	}

	private renderSelection(): void {
		if (!this.selectionEl) return;
		this.selectionEl.setText(this.selected.size ? `${this.selected.size.toLocaleString()} selected` : 'None selected');
	}

	private renderHead(): void {
		const head = this.headerRowEl;
		if (!head) return;
		head.empty();
		head.createDiv({ cls: 'crosswalker-mr-cell crosswalker-mr-check', attr: { role: 'columnheader' } });
		for (const column of COLUMNS) {
			const cell = head.createDiv({
				cls: 'crosswalker-mr-cell crosswalker-mr-sortable',
				attr: { role: 'columnheader', 'data-sort': column.key, tabindex: '-1' },
			});
			cell.createSpan({ text: column.label });
			if (this.sortKey === column.key) {
				cell.addClass('is-sorted');
				cell.setAttr('aria-sort', this.sortDirection === 'asc' ? 'ascending' : 'descending');
				const arrow = cell.createSpan({ cls: 'crosswalker-mr-sort-arrow' });
				setIcon(arrow, this.sortDirection === 'asc' ? 'arrow-up' : 'arrow-down');
			}
			cell.addEventListener('click', () => {
				if (this.sortKey === column.key) this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
				else { this.sortKey = column.key; this.sortDirection = 'asc'; }
				this.renderHead();
				this.afterQueryChange();
			});
		}
	}

	// ---------------------------------------------------------------------
	// The windowed grid
	// ---------------------------------------------------------------------

	private scheduleGrid(): void {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.renderGrid();
		});
	}

	/** The scroll offset and height of the row area, below the sticky column header. */
	private viewport(): { top: number; height: number } {
		const scroller = this.scrollerEl;
		if (!scroller) return { top: 0, height: 0 };
		const head = this.headerRowEl?.offsetHeight ?? ROW_HEIGHT;
		// Before the first layout pass clientHeight is 0; assume a screenful so the
		// first paint is not empty.
		const height = scroller.clientHeight > 0 ? scroller.clientHeight - head : ROW_HEIGHT * 20;
		return { top: Math.max(0, scroller.scrollTop), height: Math.max(ROW_HEIGHT, height) };
	}

	/** Render only the rows `windowRange` names; the body keeps the full height. */
	private renderGrid(): void {
		const body = this.bodyEl;
		const rowsEl = this.rowsEl;
		if (!body || !rowsEl) return;
		body.style.height = `${this.visible.length * ROW_HEIGHT}px`;
		const { top, height } = this.viewport();
		const range = windowRange(top, height, ROW_HEIGHT, this.visible.length, OVERSCAN);
		// Rebuilding the rows (a scroll, a reload after the file changed) would
		// drop focus from an input mid-typing; remember it and give it back.
		const focus = this.gridFocus();
		rowsEl.style.transform = `translateY(${range.padTop}px)`;
		rowsEl.empty();
		if (!this.visible.length) {
			body.style.height = `${ROW_HEIGHT * 2}px`;
			rowsEl.createDiv({
				cls: 'crosswalker-mr-empty',
				text: this.allRows.length ? 'No mappings match. Clear the search or choose Any status.' : 'This table has no mappings to review.',
			});
			return;
		}
		for (let index = range.start; index < range.end; index++) this.renderRow(rowsEl, this.visible[index], index);
		if (focus) this.restoreGridFocus(focus);
	}

	/** The row control that has focus, when focus is inside the rendered rows. */
	private gridFocus(): GridFocus | null {
		const rowsEl = this.rowsEl;
		const active = rowsEl?.ownerDocument.activeElement;
		if (!rowsEl || !(active instanceof HTMLElement) || !rowsEl.contains(active)) return null;
		const field = active.dataset.field;
		const rowId = active.closest<HTMLElement>('[data-row-id]')?.dataset.rowId;
		if (!field || !rowId) return null;
		const text = active instanceof HTMLInputElement && active.type === 'text' ? active : null;
		return { rowId, field, selectionStart: text?.selectionStart ?? null, selectionEnd: text?.selectionEnd ?? null };
	}

	/** Focus the same control in the rebuilt row, with the cursor where it was. A row scrolled out of the window stays unfocused. */
	private restoreGridFocus(focus: GridFocus): void {
		const row = Array.from(this.rowsEl?.children ?? []).find((el) => el instanceof HTMLElement && el.dataset.rowId === focus.rowId);
		const control = row?.querySelector<HTMLElement>(`[data-field="${focus.field}"]`);
		if (!control) return;
		control.focus({ preventScroll: true });
		if (control instanceof HTMLInputElement && control.type === 'text' && focus.selectionStart !== null) {
			const end = Math.min(focus.selectionEnd ?? focus.selectionStart, control.value.length);
			control.setSelectionRange(Math.min(focus.selectionStart, end), end);
		}
	}

	private renderRow(host: HTMLElement, row: ReviewRowView, index: number): void {
		const el = host.createDiv({
			cls: 'crosswalker-mr-grid-row crosswalker-mr-row',
			attr: { role: 'row', 'data-row-id': row.row_id, 'data-index': String(index) },
		});
		if (index === this.activeIndex) el.addClass('is-active');
		if (this.selected.has(row.row_id)) el.addClass('is-selected');
		el.addEventListener('click', () => this.setActive(index, false));
		el.addEventListener('dblclick', () => this.setActive(index, true));

		const checkCell = el.createDiv({ cls: 'crosswalker-mr-cell crosswalker-mr-check' });
		const check = checkCell.createEl('input', { attr: { type: 'checkbox', 'data-field': 'selected', 'aria-label': `Select mapping ${row.subject_id} to ${row.object_id}` } });
		check.checked = this.selected.has(row.row_id);
		check.addEventListener('click', (event) => event.stopPropagation());
		check.addEventListener('change', () => {
			if (check.checked) this.selected.add(row.row_id);
			else this.selected.delete(row.row_id);
			el.toggleClass('is-selected', check.checked);
			this.renderSelection();
		});

		this.endpointCell(el, row.subject_id, row.subject_label, row.subject_note);
		const predicate = el.createDiv({ cls: 'crosswalker-mr-cell', text: predicateLabel(row.predicate_id) });
		predicate.setAttr('title', row.predicate_id);
		this.endpointCell(el, row.object_id, row.object_label, row.object_note);
		this.textCell(el, row.justification);
		this.textCell(el, row.confidence, 'crosswalker-mr-number');

		const disabled = !!this.readOnly;
		const statusCell = el.createDiv({ cls: 'crosswalker-mr-cell' });
		const status = statusCell.createEl('select', { cls: 'dropdown crosswalker-mr-status-select', attr: { 'data-field': 'review_status', 'aria-label': 'Review status' } });
		status.createEl('option', { value: '', text: 'Unset' });
		for (const value of REVIEW_STATUSES) status.createEl('option', { value, text: statusLabel(value) });
		// A legacy value outside the enum stays visible rather than silently shown as Unset.
		if (row.review_status && !isReviewStatus(row.review_status)) status.createEl('option', { value: row.review_status, text: row.review_status });
		status.value = row.review_status ?? '';
		status.disabled = disabled;
		status.addEventListener('click', (event) => event.stopPropagation());
		status.addEventListener('change', () => {
			this.queue([{ row_id: row.row_id, review_status: status.value || null }]);
			if (this.drawerOpen && this.visible[this.activeIndex]?.row_id === row.row_id) this.renderDrawer();
		});

		this.editCell(el, row, 'reviewer', 'Reviewer', disabled);
		this.editCell(el, row, 'review_notes', 'Review notes', disabled);
		this.textCell(el, row.mapping_set_id, 'crosswalker-mr-muted');
	}

	private textCell(row: HTMLElement, value: string | undefined, cls?: string): void {
		const cell = row.createDiv({ cls: `crosswalker-mr-cell${cls ? ` ${cls}` : ''}`, text: value ?? '' });
		if (value) cell.setAttr('title', value);
	}

	private editCell(rowEl: HTMLElement, row: ReviewRowView, field: 'reviewer' | 'review_notes', label: string, disabled: boolean): void {
		const cell = rowEl.createDiv({ cls: 'crosswalker-mr-cell' });
		const input = cell.createEl('input', {
			cls: `crosswalker-mr-input crosswalker-mr-${field.replace('_', '-')}`,
			attr: { type: 'text', 'data-field': field, 'aria-label': label },
		});
		input.value = row[field] ?? '';
		input.disabled = disabled;
		input.addEventListener('click', (event) => event.stopPropagation());
		input.addEventListener('keydown', (event) => event.stopPropagation());
		// Every keystroke is queued; the store waits for a pause before it saves.
		input.addEventListener('input', () => {
			this.queue([{ row_id: row.row_id, [field]: input.value || null }]);
		});
	}

	/** Id and label, linked to the concept note when the stored wikilink resolves. */
	private endpointCell(rowEl: HTMLElement, id: string, label: string | undefined, note: string | undefined): void {
		const cell = rowEl.createDiv({ cls: 'crosswalker-mr-cell crosswalker-mr-endpoint' });
		const target = this.resolveEndpoint(note);
		const idEl = target
			? cell.createEl('a', { cls: 'crosswalker-mr-link', text: id, attr: { href: '#', title: `Open ${target.path}` } })
			: cell.createSpan({ cls: 'crosswalker-mr-id', text: id });
		if (target) {
			idEl.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				void this.app.workspace.getLeaf('tab').openFile(target);
			});
		}
		if (label) cell.createSpan({ cls: 'crosswalker-mr-label', text: label });
		cell.setAttr('title', label ? `${id} ${label}` : id);
	}

	private resolveEndpoint(note: string | undefined): TFile | null {
		const link = wikilinkPath(note);
		if (!link) return null;
		return this.app.metadataCache.getFirstLinkpathDest(link, this.path);
	}

	// ---------------------------------------------------------------------
	// Keyboard, selection and the details drawer
	// ---------------------------------------------------------------------

	private setActive(index: number, openDrawer: boolean): void {
		if (index < 0 || index >= this.visible.length) return;
		this.activeIndex = index;
		if (openDrawer) this.drawerOpen = true;
		const scroller = this.scrollerEl;
		if (scroller) {
			const { top, height } = this.viewport();
			const next = scrollToRevealRow(index, top, height, ROW_HEIGHT);
			if (next !== top) scroller.scrollTop = next;
		}
		this.renderGrid();
		this.renderDrawer();
	}

	private onKey(event: KeyboardEvent): void {
		const target = event.target as HTMLElement | null;
		if (target && target !== this.scrollerEl && /^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(target.tagName)) return;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const step = event.key === 'ArrowDown' ? 1 : -1;
			const start = this.activeIndex < 0 ? (step > 0 ? -1 : this.visible.length) : this.activeIndex;
			this.setActive(Math.min(this.visible.length - 1, Math.max(0, start + step)), false);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (this.activeIndex >= 0) this.setActive(this.activeIndex, true);
		} else if (event.key === 'Escape' && this.drawerOpen) {
			event.preventDefault();
			this.drawerOpen = false;
			this.renderDrawer();
		}
	}

	private renderDrawer(): void {
		const drawer = this.drawerEl;
		if (!drawer) return;
		drawer.empty();
		const row = this.visible[this.activeIndex];
		const open = this.drawerOpen && !!row;
		drawer.toggleClass('is-open', open);
		if (!open || !row) return;
		const top = drawer.createDiv({ cls: 'crosswalker-mr-drawer-top' });
		top.createEl('h3', { text: 'Mapping details' });
		const close = top.createEl('button', { cls: 'clickable-icon crosswalker-mr-drawer-close', attr: { 'aria-label': 'Close details' } });
		setIcon(close, 'x');
		close.addEventListener('click', () => {
			this.drawerOpen = false;
			this.renderDrawer();
			this.scrollerEl?.focus();
		});
		const list = drawer.createEl('dl', { cls: 'crosswalker-mr-details' });
		const add = (term: string, value: string | undefined, link?: TFile | null) => {
			list.createEl('dt', { text: term });
			const dd = list.createEl('dd');
			if (link) {
				const a = dd.createEl('a', { cls: 'crosswalker-mr-link', text: value ?? link.basename, attr: { href: '#' } });
				a.addEventListener('click', (event) => {
					event.preventDefault();
					void this.app.workspace.getLeaf('tab').openFile(link);
				});
			} else {
				dd.setText(value === undefined || value === '' ? 'None' : value);
				if (value === undefined || value === '') dd.addClass('crosswalker-mr-muted');
			}
		};
		add('Subject', row.subject_id, this.resolveEndpoint(row.subject_note));
		add('Subject label', row.subject_label);
		add('Predicate', `${predicateLabel(row.predicate_id)} (${row.predicate_id})`);
		add('Object', row.object_id, this.resolveEndpoint(row.object_note));
		add('Object label', row.object_label);
		add('Justification', row.justification);
		add('Confidence', row.confidence);
		add('Review status', statusLabel(row.review_status));
		add('Reviewer', row.reviewer);
		add('Review notes', row.review_notes);
		add('Set id', row.mapping_set_id);
		add('Row id', row.row_id);
		const other = Object.entries(row.other_notes);
		if (other.length) {
			drawer.createEl('h4', { text: 'Other notes' });
			const notes = drawer.createEl('dl', { cls: 'crosswalker-mr-details' });
			for (const [key, value] of other) {
				notes.createEl('dt', { text: key });
				notes.createEl('dd', { text: value });
			}
		}
		drawer.createDiv({ cls: 'crosswalker-mr-muted crosswalker-mr-drawer-hint', text: 'Edit review status, reviewer and review notes in the grid. The other columns come from the mapping source.' });
	}
}
