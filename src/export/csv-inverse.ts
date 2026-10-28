/**
 * csv-inverse.ts — turn a note back into the source row its recipe read.
 *
 * Import runs `recipe(row) -> note`. A recipe-aware CSV export runs the inverse
 * per column, using only the destinations the recipe itself declares: a
 * frontmatter property, a managed body section, a folder or file level, or the
 * automatic H1. Nothing here guesses from folder names, file names, or how a
 * column looks.
 *
 * A column comes back exactly only when its template is a bare `{column}`
 * (the `optional` filter is allowed, because it only decides whether an empty
 * value is written). Anything else (literals around the value, a filter that
 * reshapes it, a nested path) cannot be reversed, so the column is left out and
 * the export notice names it with a plain reason.
 *
 * Header order is the recipe's column order: the order columns are first
 * referenced across layout, the automatic heading, managed frontmatter,
 * managed link lists, and body projections. That is the order the recipe is
 * written in, not necessarily the source file's own column order, which the
 * recipe does not record.
 */

import type { CrosswalkerImportRecipe } from '../types/generated/recipe';
import { parseTemplateSegments, interpolationColumn, type Interpolation } from '../render/template';
import { splitNoteText } from '../generation/note-text';
import { scanRegions, findSpan } from '../generation/managed-body';

// ---------------------------------------------------------------------------
// Plan: which columns a recipe can give back, and from where
// ---------------------------------------------------------------------------

type BodyFormat = 'text' | 'code' | 'quote' | 'list';

export type ColumnSource =
	| { kind: 'property'; key: string }
	| { kind: 'section'; index: number; heading: string; depth: number; format: BodyFormat }
	| { kind: 'append'; format: BodyFormat }
	| { kind: 'folder'; level: string; folderIndex: number; lossy: boolean }
	| { kind: 'file'; lossy: boolean }
	| { kind: 'heading' };

export interface ColumnPlan {
	column: string;
	/** Destinations this column can be read back from, in the order they were declared. */
	sources: ColumnSource[];
}

export interface OmittedColumn {
	column: string;
	/** Plain-language reason, written to follow the column name in the notice. */
	reason: string;
}

export interface RecipeColumnPlan {
	columns: ColumnPlan[];
	omitted: OmittedColumn[];
	/** Number of folder levels the layout declares, for the path fallback. */
	folderCount: number;
	/** Whether the note body starts with an automatic H1. */
	autoHeading: boolean;
}

export const OMIT_REASONS = {
	template: 'is built from a template that cannot be reversed',
	tags: 'is only stored as tags, which cannot be turned back into the original value',
	links: 'is only stored as links, which cannot be turned back into the original value',
	sharedHeading: 'is only stored as a heading inside a shared note, which this export does not read yet',
	variadic: 'is split across several folder levels, which cannot be joined back exactly',
	records: 'is only stored as records inside a section, which cannot be separated again',
	shared: 'shares the note text with other content and cannot be separated again',
	nested: 'reads a nested value that a flat table cannot hold',
} as const;

type Bare = { ok: true; column: string; lossy: boolean } | { ok: false; reason: string; column?: string };

/**
 * Is `template` a bare `{column}`? `allowFsSafe` admits the file-name filter on
 * folder and file levels (the value comes back, but characters a file name
 * cannot hold may differ). `allowMdSuffix` admits the trailing `.md` of a file
 * template.
 */
function bareColumn(template: string, opts: { allowFsSafe?: boolean; allowMdSuffix?: boolean } = {}): Bare {
	const segments = parseTemplateSegments(template);
	const interps = segments.filter((s): s is { kind: 'interp'; interp: Interpolation } => s.kind === 'interp');
	if (interps.length !== 1) {
		return { ok: false, reason: OMIT_REASONS.template, column: interps.length > 0 ? columnOf(interps[0].interp) : undefined };
	}
	const interp = interps[0].interp;
	const column = columnOf(interp);
	if (interp.path.length !== 1) return { ok: false, reason: OMIT_REASONS.nested, column };
	const lits = segments.filter((s) => s.kind === 'lit').map((s) => (s as { text: string }).text);
	const last = segments[segments.length - 1];
	const litsOk =
		lits.length === 0 ||
		(opts.allowMdSuffix === true && lits.length === 1 && last.kind === 'lit' && last.text === '.md');
	if (!litsOk) return { ok: false, reason: OMIT_REASONS.template, column };
	let lossy = false;
	for (const f of interp.filters) {
		if (f.malformed) return { ok: false, reason: OMIT_REASONS.template, column };
		if (f.name === 'optional' && f.arg === undefined) continue;
		if (f.name === 'fs-safe' && f.arg === undefined && opts.allowFsSafe) {
			lossy = true;
			continue;
		}
		return { ok: false, reason: OMIT_REASONS.template, column };
	}
	return { ok: true, column, lossy };
}

function columnOf(interp: Interpolation): string {
	return interpolationColumn(interp).column;
}

/** Every column a template mentions, in order. */
function columnsIn(template: string): string[] {
	const out: string[] = [];
	for (const s of parseTemplateSegments(template)) {
		if (s.kind === 'interp') out.push(columnOf(s.interp));
	}
	return out;
}

/** Every template-looking string anywhere under `value`, in document order. */
function templatesUnder(value: unknown, out: string[] = []): string[] {
	if (typeof value === 'string') {
		if (value.includes('{')) out.push(value);
	} else if (Array.isArray(value)) {
		for (const v of value) templatesUnder(v, out);
	} else if (value && typeof value === 'object') {
		for (const v of Object.values(value as Record<string, unknown>)) templatesUnder(v, out);
	}
	return out;
}

/** Reserved engine columns (nest lineage) are never source columns. */
function isEngineColumn(column: string): boolean {
	return column.startsWith('_cw');
}

/**
 * Work out, once per recipe, which source columns come back and from where.
 * Pure. Columns are listed in first-reference order.
 */
export function planRecipeColumns(recipe: CrosswalkerImportRecipe): RecipeColumnPlan {
	const order: string[] = [];
	const sources = new Map<string, ColumnSource[]>();
	const reasons = new Map<string, string>();

	const mention = (column: string | undefined) => {
		if (!column || isEngineColumn(column)) return;
		if (!order.includes(column)) order.push(column);
	};
	const addSource = (column: string, source: ColumnSource) => {
		mention(column);
		const list = sources.get(column) ?? [];
		list.push(source);
		sources.set(column, list);
	};
	const addReason = (column: string | undefined, reason: string) => {
		if (!column || isEngineColumn(column)) return;
		mention(column);
		if (!reasons.has(column)) reasons.set(column, reason);
	};
	const noteAll = (template: string, reason: string) => {
		for (const c of columnsIn(template)) addReason(c, reason);
	};

	const target = (recipe.target ?? {}) as unknown as Record<string, unknown>;
	const layout = Array.isArray(target.layout) ? (target.layout as Array<Record<string, unknown>>) : [];

	// Layout, outer to inner.
	let folderIndex = 0;
	for (const entry of layout) {
		const template = typeof entry.template === 'string' ? entry.template : '';
		const level = typeof entry.level === 'string' ? entry.level : '';
		switch (entry.mechanism) {
			case 'folder': {
				const index = folderIndex++;
				if (entry.variadic) {
					noteAll(template, OMIT_REASONS.variadic);
					break;
				}
				const bare = bareColumn(template, { allowFsSafe: true });
				if (bare.ok) addSource(bare.column, { kind: 'folder', level, folderIndex: index, lossy: bare.lossy });
				else noteAll(template, bare.reason);
				break;
			}
			case 'file': {
				const bare = bareColumn(template, { allowFsSafe: true, allowMdSuffix: true });
				if (bare.ok) addSource(bare.column, { kind: 'file', lossy: bare.lossy });
				else noteAll(template, bare.reason);
				break;
			}
			case 'heading':
				noteAll(template, OMIT_REASONS.sharedHeading);
				break;
			case 'tag':
				noteAll(template, OMIT_REASONS.tags);
				break;
			case 'wikilink':
				noteAll(template, OMIT_REASONS.links);
				break;
			default:
				noteAll(template, OMIT_REASONS.template);
		}
	}

	// The automatic H1. Only an explicit bare template names a column; the
	// default heading is derived from the title, not from a declared column.
	const autoHeadingValue = target.auto_heading;
	if (typeof autoHeadingValue === 'string') {
		const bare = bareColumn(autoHeadingValue);
		if (bare.ok) addSource(bare.column, { kind: 'heading' });
		else noteAll(autoHeadingValue, bare.reason);
	}

	const alsoEmit = (target.also_emit ?? {}) as Record<string, unknown>;
	const frontmatter = (alsoEmit.frontmatter ?? {}) as Record<string, unknown>;
	const managed = (frontmatter.managed ?? {}) as Record<string, unknown>;
	for (const [key, raw] of Object.entries(managed)) {
		if (typeof raw !== 'string') continue;
		if (raw.includes('[[')) {
			noteAll(raw, OMIT_REASONS.links);
			continue;
		}
		const bare = bareColumn(raw);
		if (bare.ok) addSource(bare.column, { kind: 'property', key });
		else noteAll(raw, bare.reason);
	}
	for (const template of templatesUnder(frontmatter.managed_links)) noteAll(template, OMIT_REASONS.links);

	// Body projections. A section is exact only when nothing that could run on
	// into it follows (the next projection is absent or is itself a section).
	const body = Array.isArray(alsoEmit.body) ? (alsoEmit.body as Array<Record<string, unknown>>) : [];
	const plain = body.map((p, i) => ({ p, i })).filter(({ p }) => typeof p.level !== 'string');
	const hasRecordSections = body.some((p) => typeof p.level === 'string');
	plain.forEach(({ p, i }, k) => {
		const template = typeof p.template === 'string' ? p.template : '';
		const format = (typeof p.format === 'string' ? p.format : 'text') as BodyFormat;
		const next = plain[k + 1]?.p;
		const isLast = k === plain.length - 1;
		const tailFree = isLast ? !hasRecordSections : next?.position === 'section';
		if (p.position === 'section') {
			if (!tailFree) {
				noteAll(template, OMIT_REASONS.shared);
				return;
			}
			const bare = bareColumn(template);
			if (!bare.ok) {
				noteAll(template, bare.reason);
				return;
			}
			const depth = typeof p.heading_depth === 'number' ? p.heading_depth : 2;
			addSource(bare.column, { kind: 'section', index: i, heading: String(p.heading ?? ''), depth, format });
			return;
		}
		// An append has no heading of its own, so only a single leading one,
		// followed by sections or nothing, can be cut back out.
		if (k !== 0 || !tailFree) {
			noteAll(template, OMIT_REASONS.shared);
			return;
		}
		const bare = bareColumn(template);
		if (bare.ok) addSource(bare.column, { kind: 'append', format });
		else noteAll(template, bare.reason);
	});
	for (const p of body) {
		if (typeof p.level === 'string' && typeof p.template === 'string') noteAll(p.template, OMIT_REASONS.records);
	}

	// Tags, aliases, crosswalks and graph edges only ever hold derived forms.
	for (const template of templatesUnder(alsoEmit.tags)) noteAll(template, OMIT_REASONS.tags);
	for (const template of templatesUnder(alsoEmit.aliases)) noteAll(template, OMIT_REASONS.template);
	for (const template of templatesUnder(target.crosswalks)) noteAll(template, OMIT_REASONS.links);
	for (const template of templatesUnder(target.graph_edges)) noteAll(template, OMIT_REASONS.links);

	const columns: ColumnPlan[] = [];
	const omitted: OmittedColumn[] = [];
	for (const column of order) {
		const list = sources.get(column);
		if (list && list.length > 0) columns.push({ column, sources: list });
		else omitted.push({ column, reason: reasons.get(column) ?? OMIT_REASONS.template });
	}
	return { columns, omitted, folderCount: folderIndex, autoHeading: autoHeadingValue !== false };
}

// ---------------------------------------------------------------------------
// Read a note's managed body back into its projections
// ---------------------------------------------------------------------------

export interface ParsedBody {
	/** Text of the automatic H1, when the note has one. */
	h1?: string;
	/** Section content by projection index. Absent: the section was not written. */
	sections: Map<number, string>;
	/** Text before the first section (a leading append's slot). */
	lead: string;
}

/**
 * Split a note's managed body region back into the pieces the recipe wrote.
 * Returns null when the note has no readable body region.
 */
export function parseManagedBody(noteText: string, plan: RecipeColumnPlan, recipe: CrosswalkerImportRecipe): ParsedBody | null {
	const { body } = splitNoteText(noteText);
	const scan = scanRegions(body);
	if (!scan.ok) return null;
	const span = findSpan(scan.spans, 'body');
	if (!span) return null;
	let content = body.slice(span.contentStart, span.contentEnd).replace(/\r\n/g, '\n');
	if (content.endsWith('\n')) content = content.slice(0, -1);

	let h1: string | undefined;
	if (plan.autoHeading && content.startsWith('# ')) {
		const nl = content.indexOf('\n');
		h1 = (nl === -1 ? content : content.slice(0, nl)).slice(2);
		content = nl === -1 ? '' : content.slice(nl + 1).replace(/^\n+/, '');
	}

	// Locate every declared section heading in order, at line starts.
	const projections = (((recipe.target as unknown as Record<string, unknown>).also_emit ?? {}) as Record<string, unknown>).body;
	const list = Array.isArray(projections) ? (projections as Array<Record<string, unknown>>) : [];
	const found: Array<{ index: number; lineStart: number; contentStart: number }> = [];
	let cursor = 0;
	list.forEach((p, index) => {
		if (p.position !== 'section' || typeof p.level === 'string') return;
		const depth = typeof p.heading_depth === 'number' ? p.heading_depth : 2;
		const line = `${'#'.repeat(depth)} ${String(p.heading ?? '')}`;
		let at = cursor;
		while (at <= content.length) {
			const hit = content.indexOf(line, at);
			if (hit === -1) return;
			const atLineStart = hit === 0 || content[hit - 1] === '\n';
			const end = hit + line.length;
			const atLineEnd = end === content.length || content[end] === '\n';
			if (atLineStart && atLineEnd) {
				let start = end;
				if (content.startsWith('\n\n', start)) start += 2;
				else if (content.startsWith('\n', start)) start += 1;
				found.push({ index, lineStart: hit, contentStart: start });
				cursor = start;
				return;
			}
			at = hit + 1;
		}
	});

	const sections = new Map<number, string>();
	found.forEach((f, k) => {
		const stop = k + 1 < found.length ? found[k + 1].lineStart : content.length;
		let text = content.slice(f.contentStart, stop);
		if (k + 1 < found.length) text = text.replace(/\n\n$/, '');
		sections.set(f.index, text);
	});
	const leadEnd = found.length > 0 ? found[0].lineStart : content.length;
	const lead = content.slice(0, leadEnd).replace(/\n\n$/, '');
	return { h1, sections, lead };
}

/** Undo a body format's wrapping. */
export function unwrapBodyFormat(text: string, format: BodyFormat): string {
	switch (format) {
		case 'quote':
			return text
				.split('\n')
				.map((line) => (line === '>' ? '' : line.startsWith('> ') ? line.slice(2) : line))
				.join('\n');
		case 'list':
			return text
				.split('\n')
				.map((line) => (line.startsWith('- ') ? line.slice(2) : line))
				.join('\n');
		case 'code': {
			const lines = text.split('\n');
			if (lines.length >= 2 && /^`{3,}$/.test(lines[0]) && lines[lines.length - 1] === lines[0]) {
				return lines.slice(1, -1).join('\n');
			}
			return text;
		}
		case 'text':
		default:
			return text;
	}
}

// ---------------------------------------------------------------------------
// One cell
// ---------------------------------------------------------------------------

export interface InverseNote {
	path: string;
	frontmatter: Record<string, unknown>;
	/** The note's full text, when it was read. */
	text?: string;
	/** Level values from the folder hubs above this note, by level name. */
	hubValues?: Map<string, string>;
}

export interface CellResult {
	value: string;
	/** True when the value was read back from a folder or file name. */
	fromName: boolean;
}

function joinValue(v: unknown): string {
	if (v === undefined || v === null) return '';
	if (Array.isArray(v)) return v.map((x) => String(x)).join('|');
	return String(v);
}

/** The `_crosswalker.layout_values` stamp, grouped by level. */
function stampedLevels(frontmatter: Record<string, unknown>): Map<string, string> | undefined {
	const provenance = frontmatter._crosswalker as Record<string, unknown> | undefined;
	const raw = provenance && typeof provenance === 'object' ? provenance.layout_values : undefined;
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	const byLevel = new Map<string, string[]>();
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const { level, value } = item as Record<string, unknown>;
		if (typeof level !== 'string' || typeof value !== 'string') continue;
		const list = byLevel.get(level) ?? [];
		list.push(value);
		byLevel.set(level, list);
	}
	const out = new Map<string, string>();
	for (const [level, values] of byLevel) out.set(level, values.join('/'));
	return out;
}

/** Where the set was written, as recorded at import. */
export function setDestination(frontmatter: Record<string, unknown>): string | undefined {
	const provenance = frontmatter._crosswalker as Record<string, unknown> | undefined;
	const set = provenance && typeof provenance === 'object' ? (provenance.import_set as Record<string, unknown> | undefined) : undefined;
	const destination = set && typeof set === 'object' ? set.destination : undefined;
	return typeof destination === 'string' && destination !== '' ? destination.replace(/\/+$/, '') : undefined;
}

/** The directory segments between the set's recorded destination and the note. */
function folderSegments(note: InverseNote): string[] | undefined {
	const destination = setDestination(note.frontmatter);
	if (!destination || !note.path.startsWith(`${destination}/`)) return undefined;
	const parts = note.path.slice(destination.length + 1).split('/');
	parts.pop();
	return parts;
}

function fileStem(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	return name.endsWith('.md') ? name.slice(0, -3) : name;
}

/**
 * Read one column back from one note. Precedence: a frontmatter property; a
 * body section or leading append; the folder levels the note recorded at
 * import; the level values on the folder hubs above it; the automatic H1; and
 * only then the folder or file name, which is flagged so the notice can warn.
 */
export function inverseCell(
	plan: ColumnPlan,
	note: InverseNote,
	body: ParsedBody | null,
	recipePlan: RecipeColumnPlan,
): CellResult {
	const kinds = (k: ColumnSource['kind']) => plan.sources.filter((s) => s.kind === k);

	for (const s of kinds('property')) {
		const key = (s as { key: string }).key;
		return { value: joinValue(note.frontmatter[key]), fromName: false };
	}
	if (body) {
		for (const s of kinds('section')) {
			const sec = s as Extract<ColumnSource, { kind: 'section' }>;
			const text = body.sections.get(sec.index);
			return { value: text === undefined ? '' : unwrapBodyFormat(text, sec.format), fromName: false };
		}
		for (const s of kinds('append')) {
			return { value: unwrapBodyFormat(body.lead, (s as { format: BodyFormat }).format), fromName: false };
		}
	}

	const folders = kinds('folder') as Array<Extract<ColumnSource, { kind: 'folder' }>>;
	if (folders.length > 0) {
		const stamp = stampedLevels(note.frontmatter);
		if (stamp?.has(folders[0].level)) return { value: stamp.get(folders[0].level) ?? '', fromName: false };
		const hub = note.hubValues?.get(folders[0].level);
		if (hub !== undefined) return { value: hub, fromName: false };
	}
	if (body?.h1 !== undefined && kinds('heading').length > 0) return { value: body.h1, fromName: false };

	if (folders.length > 0) {
		const segments = folderSegments(note);
		// Only trust the path when it has exactly one segment per declared folder
		// level; a skipped empty level would shift every value after it.
		if (segments && segments.length === recipePlan.folderCount) {
			return { value: segments[folders[0].folderIndex] ?? '', fromName: true };
		}
		return { value: '', fromName: false };
	}
	if (kinds('file').length > 0) return { value: fileStem(note.path), fromName: true };
	return { value: '', fromName: false };
}

// ---------------------------------------------------------------------------
// Notice
// ---------------------------------------------------------------------------

export interface CsvNoticeInput {
	rowCount: number;
	omittedColumns: OmittedColumn[];
	recoveredFromNames: string[];
	fallbacks: Record<'no-recipe' | 'legacy' | 'missing' | 'digest-mismatch', number>;
	mixedRecipes: boolean;
	skippedCount: number;
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * The export notice: plain words, sentence case, no internal vocabulary.
 * Pure, so its wording is pinned by tests.
 */
export function csvExportNotice(input: CsvNoticeInput, destination: string): string {
	const lines: string[] = [`Exported ${plural(input.rowCount, 'row', 'rows')} to ${destination}.`];
	for (const o of input.omittedColumns) lines.push(`Not included: ${o.column} ${o.reason}.`);
	if (input.recoveredFromNames.length > 0) {
		lines.push(
			`${input.recoveredFromNames.join(', ')} recovered from the folder or file name; characters a file name cannot hold may differ.`,
		);
	}
	const f = input.fallbacks;
	if (f.missing > 0) {
		lines.push(
			`${plural(f.missing, 'note', 'notes')} exported properties only, recipe no longer in the library: restore it from Recipes, then export again.`,
		);
	}
	if (f['digest-mismatch'] > 0) {
		lines.push(
			`${plural(f['digest-mismatch'], 'note', 'notes')} exported properties only, recipe changed since these notes were written: run the import again, then export again.`,
		);
	}
	const plainOnly = f.legacy + f['no-recipe'];
	if (plainOnly > 0) {
		lines.push(`${plural(plainOnly, 'note', 'notes')} exported properties only, written without a saved recipe.`);
	}
	if (input.mixedRecipes) {
		lines.push('This folder holds notes from more than one recipe, so some cells are empty.');
	}
	if (input.skippedCount > 0) lines.push(`${plural(input.skippedCount, 'note', 'notes')} skipped.`);
	return lines.join('\n');
}
