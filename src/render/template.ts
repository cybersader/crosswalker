/**
 * Template engine — R2RML-style `{var|filter}` interpolation.
 *
 * Per Ch 22 §3.3: closed filter set; computation beyond filters escapes into
 * a `Function` primitive (Ch 20) which v0.1 doesn't ship.
 *
 * Closed filter set:
 *   lower, upper, title, slug, tagsafe, fs-safe, truncate(N), trim, trim(chars),
 *   number, split(delim,index), split(delim), regex(pattern), reject(pattern),
 *   join(sep), wikilink, curie-prefix(prefix), plus first-position `optional`.
 *
 * ## Variable resolution (2026-08-26 template-engine contract §1)
 *
 * A path is a sequence of segments; a segment is **bare** (`a.b.c` — traversal
 * into nested source data) or **quoted** (`['weird.key']` — one literal key).
 * Quoting is segment-level so it *composes* with traversal at any depth:
 * `{['weird.parent'].child.0.['odd.leaf']}`. That is deliberately a capability
 * ("address any segment literally") rather than a case ("allow one dotted
 * column name"): a path-level quoting design would have fixed the CRI workbook
 * and nothing else.
 *
 * `resolvePath` is ONE algorithm with a documented order:
 *   1. tokenize into segments;
 *   2. exact-key fast path — an all-bare multi-segment path whose *raw* text is
 *      an own key of the scope resolves to that key (a dotted CSV/XLSX header
 *      needs no recipe edit); a competing nested reading is reported, never
 *      silently preferred;
 *   3. otherwise traverse segment by segment;
 *   4. `optional` suppresses a missing value at EVERY segment, not just the last.
 *
 * ## Values may be lists (contract §2)
 *
 * The capability is not "a splitMap filter"; it is that **a value may be a list
 * and every filter — existing or future — maps over it automatically** (L1).
 * Empty items are elided after each application (L2), and a list never silently
 * stringifies into a text template (L3 — `RenderError` naming `join`).
 *
 * Determinism: pure function. Same `(template, scope)` → byte-identical output.
 */

import type { SourceScope, RenderReport } from './types';
import { isTier1CuriePrefix } from '../validation/validator';

/** Context handed to filters so they can record deviations without throwing. */
interface FilterCtx {
	template: string;
	report?: RenderReport;
}

export class RenderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RenderError';
	}
}

// ===========================================================================
// R0 — the single tokenizer
//
// Four modules used to parse `{...}` bodies with four different regexes (render,
// mapping/serialize, recipe-registry, recipe-document), each doing
// `body.split('|')[0]`. Any syntax added in one and not the others produced
// silent, shape-dependent divergence — a recipe that renders correctly but
// fingerprints wrong. All four now call `parseTemplateSegments` /
// `parseInterpolation`, so the NEXT syntax addition lands in exactly one file.
// ===========================================================================

/** One resolved path segment. `literal` marks `['...']` quoting. */
export interface PathSegment {
	name: string;
	literal: boolean;
}

/** One parsed filter call in an interpolation's chain. */
export interface FilterCall {
	name: string;
	/** Argument text, already unescaped. Absent for a bare `name` filter. */
	arg?: string;
	/** Raw text exactly as written (untrimmed) — for exact re-serialization. */
	raw: string;
	/** Set when `raw` is not `name` or `name(arg)`. Render throws when applied. */
	malformed?: boolean;
}

export interface Interpolation {
	/** Ordered path segments, already unquoted. */
	path: PathSegment[];
	/** Raw path text as written (for error messages + exact re-serialization). */
	rawPath: string;
	filters: FilterCall[];
}

export type TemplateSegment =
	| { kind: 'lit'; text: string }
	| { kind: 'interp'; interp: Interpolation };

/**
 * Split a template into ordered literal + interpolation segments.
 *
 * A `}` inside a `['...']` quoted path segment does NOT terminate the
 * interpolation (contract acceptance 1.7 — the "do not terminate" branch was
 * chosen over "reject"). A bare `{` inside the body aborts the interpolation,
 * matching the historical `[^{}]+` body class; an empty `{}` stays literal,
 * matching render + registry (serialize's `[^}]*` previously differed here on a
 * form no recipe uses).
 */
export function parseTemplateSegments(template: string): TemplateSegment[] {
	const out: TemplateSegment[] = [];
	let lit = '';
	let i = 0;
	while (i < template.length) {
		if (template[i] !== '{') {
			lit += template[i];
			i++;
			continue;
		}
		const end = findInterpolationEnd(template, i + 1);
		if (end < 0 || end === i + 1) {
			lit += template[i];
			i++;
			continue;
		}
		if (lit !== '') {
			out.push({ kind: 'lit', text: lit });
			lit = '';
		}
		out.push({ kind: 'interp', interp: parseInterpolation(template.slice(i + 1, end)) });
		i = end + 1;
	}
	if (lit !== '') out.push({ kind: 'lit', text: lit });
	return out;
}

/** Index of the `}` closing the interpolation body starting at `start`, or -1. */
function findInterpolationEnd(s: string, start: number): number {
	let i = start;
	while (i < s.length) {
		const c = s[i];
		if (c === '[' && s[i + 1] === "'") {
			const quoted = readQuoted(s, i + 2);
			if (quoted) {
				i = quoted.next;
				continue;
			}
		}
		if (c === '{') return -1;
		if (c === '}') return i;
		i++;
	}
	return -1;
}

/**
 * Parse one interpolation body (`col|split(.,0)|fs-safe`) into path + filters.
 *
 * R2.4 — the filter-chain splitter is depth aware: a `|` at parenthesis depth
 * greater than zero is argument text, and an argument runs from `(` to its
 * BALANCING `)`. That is what finally makes `regex(:\s*(.+)$)` and `regex(A|B)`
 * writable. Depth tracking starts only AFTER the first top-level `|`, because
 * real column names carry parentheses (`Micro-Small Business (<10 staff)`) and
 * the path portion never holds a filter argument.
 */
export function parseInterpolation(body: string): Interpolation {
	const pieces = splitFilterChain(body);
	const rawPath = pieces[0];
	return {
		rawPath,
		path: parsePathSegments(rawPath.trim()),
		filters: pieces.slice(1).map(parseFilterCall),
	};
}

/**
 * The source column an interpolation references, for signature/fingerprint use.
 * A single quoted segment yields its unquoted name (so `{['A.B']}` is ONE column
 * named `A.B`, not two); anything else yields the raw path text as written.
 */
export function interpolationColumn(interp: Interpolation): { column: string; literal: boolean } {
	if (interp.path.length === 1 && interp.path[0].literal) {
		return { column: interp.path[0].name, literal: true };
	}
	return { column: interp.rawPath.trim(), literal: false };
}

/** Render a name back into path text, quoting it when it cannot be written bare. */
export function pathTextFor(column: string, literal?: boolean): string {
	const unrepresentable = column.includes('|') || column.includes('{') || column.includes('}');
	if (!literal && !unrepresentable) return column;
	return `['${column.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
}

/** Split an interpolation body on top-level `|`, preserving every character. */
function splitFilterChain(body: string): string[] {
	const pieces: string[] = [];
	let cur = '';
	let i = 0;
	let seenPipe = false;
	let depth = 0;
	let inClass = false;
	while (i < body.length) {
		const c = body[i];
		if (!seenPipe) {
			// Path portion: quote aware only. Parentheses here belong to a column
			// name and must not open a filter argument.
			if (c === '[' && body[i + 1] === "'") {
				const quoted = readQuoted(body, i + 2);
				if (quoted) {
					cur += body.slice(i, quoted.next);
					i = quoted.next;
					continue;
				}
			}
			if (c === '|') {
				pieces.push(cur);
				cur = '';
				seenPipe = true;
				i++;
				continue;
			}
			cur += c;
			i++;
			continue;
		}
		// Filter portion: balanced parentheses + backslash escapes.
		if ((depth > 0 || inClass) && c === '\\' && i + 1 < body.length) {
			cur += c + body[i + 1];
			i += 2;
			continue;
		}
		// A regex character class holds literal parens and pipes. `regex(^[^(]+)`
		// is a real chain from the CRI workbook and must be writable as one would
		// write the regex — the same reason the scanner balances parens at all.
		if (inClass) {
			if (c === ']') inClass = false;
			cur += c;
			i++;
			continue;
		}
		if (c === '[') inClass = true;
		else if (c === '(') depth++;
		else if (c === ')' && depth > 0) depth--;
		else if (c === '|' && depth === 0) {
			pieces.push(cur);
			cur = '';
			i++;
			continue;
		}
		cur += c;
		i++;
	}
	pieces.push(cur);
	return pieces;
}

/** Split raw path text into segments, honouring `['...']` quoting. */
function parsePathSegments(raw: string): PathSegment[] {
	const out: PathSegment[] = [];
	let i = 0;
	for (;;) {
		if (raw.startsWith("['", i)) {
			const quoted = readQuoted(raw, i + 2);
			// A quoted segment must span the WHOLE segment; `['a']x` reads as bare.
			if (quoted && (quoted.next === raw.length || raw[quoted.next] === '.')) {
				out.push({ name: quoted.value, literal: true });
				if (quoted.next >= raw.length) return out;
				i = quoted.next + 1;
				if (i === raw.length) {
					out.push({ name: '', literal: false });
					return out;
				}
				continue;
			}
		}
		const dot = raw.indexOf('.', i);
		if (dot < 0) {
			out.push({ name: raw.slice(i), literal: false });
			return out;
		}
		out.push({ name: raw.slice(i, dot), literal: false });
		i = dot + 1;
	}
}

/**
 * Read a quoted segment body starting just after `['`.
 * `\'` is a literal quote and `\\` a backslash; any other `\x` emits both
 * characters. Returns null when the segment is never closed.
 */
function readQuoted(raw: string, start: number): { value: string; next: number } | null {
	let value = '';
	let i = start;
	while (i < raw.length) {
		const c = raw[i];
		if (c === '\\') {
			const n = raw[i + 1];
			if (n === undefined) {
				value += '\\';
				i++;
				continue;
			}
			value += n === "'" || n === '\\' ? n : c + n;
			i += 2;
			continue;
		}
		if (c === "'" && raw[i + 1] === ']') return { value, next: i + 2 };
		value += c;
		i++;
	}
	return null;
}

function parseFilterCall(raw: string): FilterCall {
	const trimmed = raw.trim();
	const bare = /^([a-z][a-z0-9_-]*)$/.exec(trimmed);
	if (bare) return { name: bare[1], raw };
	const withArg = /^([a-z][a-z0-9_-]*)\(([\s\S]*)\)$/.exec(trimmed);
	if (withArg) return { name: withArg[1], arg: unescapeFilterArg(withArg[2]), raw };
	return { name: trimmed, raw, malformed: true };
}

/**
 * R2.4 backslash rule, stated precisely because it is easy to get wrong:
 * `\)`, `\(`, `\|`, `\,`, `\\` emit the single literal character; a backslash
 * followed by ANYTHING ELSE emits both characters, so `\d`, `\s`, `\.` survive
 * intact into the `RegExp` constructor.
 */
function unescapeFilterArg(arg: string): string {
	if (!arg.includes('\\')) return arg;
	let out = '';
	for (let i = 0; i < arg.length; i++) {
		if (arg[i] !== '\\') {
			out += arg[i];
			continue;
		}
		const n = arg[i + 1];
		if (n === undefined) {
			out += '\\';
			continue;
		}
		out += n === '(' || n === ')' || n === '|' || n === ',' || n === '\\' ? n : '\\' + n;
		i++;
	}
	return out;
}

/**
 * Decode a delimiter argument (`split`, `join`). `\n`, `\t`, `\r` become the
 * real control characters. This is filter-local on purpose: the GENERIC
 * argument unescaper must leave `\n` alone so `regex()` semantics are untouched,
 * but a delimiter has no regex reading and `split(\n)` is how a newline-
 * separated cell is written.
 */
function decodeDelimiter(arg: string): string {
	return arg.replace(/\\([ntr])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : '\r'));
}

// ===========================================================================
// Rendering
// ===========================================================================

/**
 * Render a single template against a scope.
 *
 * @example
 *   renderTemplate('{control.id}.md', { control: { id: 'AC-2' } })
 *   //=> 'AC-2.md'
 *
 *   renderTemplate('framework/{family.id|lower}/{control.id|tagsafe}', { ... })
 *   //=> 'framework/ac/ac-2'
 */
export function renderTemplate(template: string, scope: SourceScope, report?: RenderReport): string {
	return renderSegments(parseTemplateSegments(template), template, scope, report);
}

function renderSegments(
	segments: TemplateSegment[],
	template: string,
	scope: SourceScope,
	report?: RenderReport,
): string {
	let out = '';
	for (const segment of segments) {
		if (segment.kind === 'lit') {
			out += segment.text;
			continue;
		}
		const value = evaluateInterpolation(segment.interp, scope, template, report);
		// L3 — lists never silently stringify.
		if (Array.isArray(value)) {
			throw new RenderError(
				`Template variable "${segment.interp.rawPath.trim()}" produced a list of ${value.length} value(s) in template "${template}"; add |join(<sep>) to render this list inside a text template.`,
			);
		}
		out += String(value);
	}
	return out;
}

/**
 * Render a managed scalar while preserving an explicitly requested primitive
 * type. Mixed literal/interpolation templates remain strings; a template that
 * is exactly one interpolation can return the raw result of its filter chain —
 * including a list (contract §2.5).
 */
export function renderTemplateValue(
	template: string,
	scope: SourceScope,
	report?: RenderReport,
): unknown {
	const segments = parseTemplateSegments(template);
	if (segments.length === 1 && segments[0].kind === 'interp') {
		return evaluateInterpolation(segments[0].interp, scope, template, report);
	}
	return renderSegments(segments, template, scope, report);
}

function evaluateInterpolation(
	interp: Interpolation,
	scope: SourceScope,
	originalTemplate: string,
	report?: RenderReport,
): unknown {
	const optional = parseAndValidateLeadingOptional(interp.filters, originalTemplate);

	let value = resolvePath(interp, scope, originalTemplate, optional, report);

	const ctx: FilterCtx = { template: originalTemplate, report };
	for (const call of optional ? interp.filters.slice(1) : interp.filters) {
		value = applyFilter(call, value, ctx);
	}

	return value;
}

function resolvePath(
	interp: Interpolation,
	scope: SourceScope,
	originalTemplate: string,
	allowMissing: boolean,
	report?: RenderReport,
): unknown {
	const rawPath = interp.rawPath.trim();
	const segments = interp.path;

	// Step 2 — exact-key fast path. A compatibility affordance, not the feature:
	// a dotted CSV/XLSX header resolves with zero recipe edits. The quoted form
	// (`{['A.B']}`) is normative and skips this branch entirely.
	if (
		segments.length > 1 &&
		segments.every((s) => !s.literal) &&
		Object.prototype.hasOwnProperty.call(scope, rawPath)
	) {
		const shadowed = tryTraverse(segments, scope);
		if (shadowed !== undefined && shadowed !== null) {
			report?.notes.push({
				code: 'literal-key-shadowed',
				template: originalTemplate,
				detail: `"${rawPath}" reads both as a column named "${rawPath}" and as a path into nested data; the column was used. Write {['${rawPath}']} for the column to say which you meant.`,
			});
		}
		return finishValue(
			(scope as Record<string, unknown>)[rawPath],
			rawPath,
			originalTemplate,
			allowMissing,
		);
	}

	// Step 3 — ordinary traversal. Step 4 — `optional` fires at EVERY segment.
	let cur: unknown = scope;
	for (let index = 0; index < segments.length; index++) {
		const seg = segments[index];
		if (cur == null || typeof cur !== 'object') {
			if (allowMissing) return '';
			throw new RenderError(
				`Template variable "${rawPath}": segment "${seg.name}" hit non-object value while traversing in template "${originalTemplate}".`,
			);
		}
		cur = (cur as Record<string, unknown>)[seg.name];
		if ((cur === undefined || cur === null) && allowMissing) return '';
	}

	return finishValue(cur, rawPath, originalTemplate, allowMissing);
}

function finishValue(
	cur: unknown,
	rawPath: string,
	originalTemplate: string,
	allowMissing: boolean,
): unknown {
	if (cur === undefined || cur === null) {
		if (allowMissing) return '';
		throw new RenderError(
			`Template variable "${rawPath}" resolved to undefined/null in template "${originalTemplate}".`,
		);
	}
	return cur;
}

/** Non-throwing traversal, used only to detect a shadowed literal key. */
function tryTraverse(segments: PathSegment[], scope: SourceScope): unknown {
	let cur: unknown = scope;
	for (const seg of segments) {
		if (cur == null || typeof cur !== 'object') return undefined;
		cur = (cur as Record<string, unknown>)[seg.name];
	}
	return cur;
}

function parseAndValidateLeadingOptional(filters: FilterCall[], originalTemplate: string): boolean {
	const optionalIndexes: number[] = [];
	for (let i = 0; i < filters.length; i++) {
		if (filters[i].malformed) continue;
		if (filters[i].name === 'optional') {
			if (filters[i].arg !== undefined) {
				throw new RenderError(`optional filter accepts no argument in template "${originalTemplate}".`);
			}
			optionalIndexes.push(i);
		}
	}
	if (optionalIndexes.length > 1) {
		throw new RenderError(`optional filter may appear only once in template "${originalTemplate}".`);
	}
	if (optionalIndexes.length === 1 && optionalIndexes[0] !== 0) {
		throw new RenderError(`optional filter must be first in template "${originalTemplate}".`);
	}
	return optionalIndexes.length === 1;
}

/** Check an identity template's filter grammar without requiring source-row values. */
export function validateTemplateSyntax(template: string): void {
	for (const segment of parseTemplateSegments(template)) {
		if (segment.kind !== 'interp') continue;
		parseAndValidateLeadingOptional(segment.interp.filters, template);
		for (const filter of segment.interp.filters) {
			if (filter.malformed) {
				throw new RenderError(`Malformed filter expression "${filter.raw.trim()}" in template "${template}".`);
			}
			if (filter.name !== 'optional' && !Object.prototype.hasOwnProperty.call(FILTERS, filter.name)) {
				throw new RenderError(`Unknown filter "${filter.name}" in template "${template}".`);
			}
		}
	}
}

/**
 * Remove whitespace and any character in `chars` from both ends.
 * `trim` with no argument is byte-identical to `String.prototype.trim`.
 */
function trimChars(value: string, chars: string): string {
	const set = new Set(chars.split(''));
	const strip = (c: string): boolean => set.has(c) || /\s/.test(c);
	let a = 0;
	let b = value.length;
	while (a < b && strip(value[a])) a++;
	while (b > a && strip(value[b - 1])) b--;
	return value.slice(a, b);
}

const FILTERS: Record<string, (v: unknown, arg?: string, ctx?: FilterCtx) => unknown> = {
	lower: (v) => String(v).toLowerCase(),
	upper: (v) => String(v).toUpperCase(),
	title: (v) =>
		String(v).replace(
			/\w\S*/g,
			(w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
		),
	slug: (v) =>
		String(v)
			// Replace anything that's not a-z, A-Z, 0-9 with hyphen.
			// Then collapse multiple hyphens, strip leading/trailing.
			.replace(/[^A-Za-z0-9]+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '')
			.toLowerCase(),
	tagsafe: (v) =>
		String(v)
			// Tags allow [a-zA-Z0-9_-] plus `/`. We strip `/` collisions
			// because tagsafe is used at *segment* level — slash separators
			// come from template structure, not values.
			.replace(/[^A-Za-z0-9_-]+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '')
			.toLowerCase(),
	'fs-safe': (v) =>
		String(v)
			// Strip Windows-reserved + path separators + control chars.
			.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
			// Strip trailing dot/space (Windows quirk)
			.replace(/[\s.]+$/g, ''),
	truncate: (v, arg) => {
		if (arg === undefined) {
			throw new RenderError(`truncate filter requires a numeric argument, e.g. {var|truncate(60)}.`);
		}
		const n = parseInt(arg, 10);
		if (Number.isNaN(n) || n <= 0) {
			throw new RenderError(`truncate filter argument must be a positive integer; got "${arg}".`);
		}
		const s = String(v);
		return s.length > n ? s.slice(0, n) : s;
	},
	trim: (v, arg) => (arg === undefined || arg === '' ? String(v).trim() : trimChars(String(v), arg)),
	'curie-prefix': (value, arg) => {
		if (arg === undefined || !isTier1CuriePrefix(arg)) {
			throw new RenderError(
				`curie-prefix filter requires a lowercase CURIE prefix, e.g. {var|curie-prefix(nist)}.`,
			);
		}
		if (isEmptyListOrLinkValue(value)) return '';
		const local = String(value).trim();
		return `${arg}:${local}`;
	},
	number: (v) => {
		const value = typeof v === 'number' ? v : Number(String(v).trim());
		if (!Number.isFinite(value)) {
			throw new RenderError(`number filter requires a finite numeric value; got "${String(v)}".`);
		}
		return value;
	},
	split: (v, arg, ctx) => {
		// Two forms, the 2-argument one taking parse precedence:
		//   {var|split(<delim>,<index>)} — scalar to scalar, the n-th piece.
		//   {var|split(<delim>)}         — scalar to LIST (contract §2.3 "produce").
		if (arg === undefined) {
			throw new RenderError(
				`split filter requires "<delim>,<index>" or "<delim>", e.g. {var|split(:,0)}.`,
			);
		}
		const m = arg.match(/^(.*),(\d+)$/);
		if (!m) return splitToList(v, arg);
		const [, delim, idxStr] = m;
		const parts = String(v).split(delim);
		const idx = parseInt(idxStr, 10);
		if (parts.length === 1) {
			ctx?.report?.notes.push({
				code: 'split-no-delimiter',
				template: ctx.template,
				detail:
					idx === 0
						? `"${String(v)}" contains no "${delim}": the whole value was used as this piece.`
						: `"${String(v)}" contains no "${delim}": piece ${idx} came back empty.`,
			});
		} else if (idx >= parts.length) {
			ctx?.report?.notes.push({
				code: 'split-index-missing',
				template: ctx.template,
				detail: `"${String(v)}" splits on "${delim}" into ${parts.length} pieces: piece ${idx} doesn't exist, so it came back empty.`,
			});
		}
		return (parts[idx] ?? '').trim();
	},
	part: (v, arg, ctx) => {
		// Two forms, mirroring split but over a delimiter SET (any single
		// character of D separates pieces; order-free):
		//   {var|part(<delims>,<index>)} — scalar to scalar, the n-th (0-based)
		//     piece of the trimmed value; empty pieces are dropped before indexing.
		//   {var|part(<delims>)}         — scalar to LIST of the non-empty pieces.
		// The 2-arg form takes parse precedence, exactly like split. The greedy
		// match means the index is the digits after the LAST comma: a literal
		// comma in D is written `\,` and unescapes to a comma that still reads as
		// part of D when the trailing group is the index (`part(\,,1)` splits on
		// ","). The same ambiguity class split already has; multi-character
		// delimiters stay on `split`.
		if (arg === undefined) {
			throw new RenderError(
				`part filter requires "<delims>,<index>" or "<delims>", e.g. {var|part(.-,0)}.`,
			);
		}
		const m = arg.match(/^(.*),(\d+)$/);
		if (!m) return partToList(v, arg);
		const [, delims, idxStr] = m;
		const delimSet = decodeDelimiter(delims);
		if (delimSet === '') {
			throw new RenderError(`part filter requires a non-empty delimiter set; got "${delims}".`);
		}
		const source = String(v).trim();
		const idx = parseInt(idxStr, 10);
		if (!containsAnyChar(source, delimSet)) {
			// No character of D occurs: the whole (trimmed) value IS piece 0, so
			// index 0 has an answer and only a higher index is a miss (spec §2.1).
			if (idx > 0) {
				ctx?.report?.notes.push({
					code: 'part-no-delimiter',
					template: ctx.template,
					detail: `"${source}" contains none of the delimiter characters "${delimSet}" and piece ${idx} doesn't exist, so it came back empty.`,
				});
			}
			return idx === 0 ? source : '';
		}
		const pieces = splitOnSet(source, delimSet)
			.map((piece) => piece.text.trim())
			.filter((piece) => piece !== '');
		if (idx >= pieces.length) {
			ctx?.report?.notes.push({
				code: 'part-index-missing',
				template: ctx.template,
				detail: `"${source}" splits on any of "${delimSet}" into ${pieces.length} piece(s): piece ${idx} doesn't exist, so it came back empty.`,
			});
			return '';
		}
		return pieces[idx];
	},
	prefix: (v, arg, ctx) => {
		// {var|prefix(<delims>,<index>)} — scalar to scalar. The ORIGINAL text
		// truncated right after the end of the n-th non-empty piece, delimiters
		// preserved: `GV.OC-01.01` with D=`.-` gives `GV`, `GV.OC`, `GV.OC-01`.
		// No list form: a prefix of pieces is not a list use case, and `part(D)`
		// covers list production.
		if (arg === undefined || !/^(.*),(\d+)$/.test(arg)) {
			throw new RenderError(`prefix filter requires "<delims>,<index>", e.g. {var|prefix(.-,0)}.`);
		}
		const [, delims, idxStr] = arg.match(/^(.*),(\d+)$/) as RegExpMatchArray;
		const delimSet = decodeDelimiter(delims);
		if (delimSet === '') {
			throw new RenderError(`prefix filter requires a non-empty delimiter set; got "${delims}".`);
		}
		const source = String(v).trim();
		const idx = parseInt(idxStr, 10);
		const nonEmpty = splitOnSet(source, delimSet).filter((piece) => piece.text.trim() !== '');
		const piece = nonEmpty[idx];
		if (!piece) {
			ctx?.report?.notes.push({
				code: 'prefix-index-missing',
				template: ctx.template,
				detail: `"${source}" splits on any of "${delimSet}" into ${nonEmpty.length} piece(s): piece ${idx} doesn't exist, so the prefix came back empty.`,
			});
			return '';
		}
		return source.slice(0, piece.end);
	},
	join: (v, arg) => {
		// List to scalar. Identity on a scalar, so it composes harmlessly.
		if (arg === undefined) {
			throw new RenderError(`join filter requires a separator, e.g. {var|join(, )}.`);
		}
		if (!Array.isArray(v)) return v;
		return v.map((item) => String(item)).join(decodeDelimiter(arg));
	},
	reject: (v, arg) => {
		// Drop items matching the pattern. Lifts over a list like any other
		// filter; the shared empty-elision step (L2) removes what it blanks.
		if (arg === undefined) {
			throw new RenderError(`reject filter requires a pattern, e.g. {var|reject(^\\[None\\]$)}.`);
		}
		let re: RegExp;
		try {
			re = new RegExp(arg);
		} catch (e) {
			throw new RenderError(`reject filter pattern is invalid (${(e as Error).message}).`);
		}
		return re.test(String(v)) ? '' : v;
	},
	wikilink: (v) => {
		// Decorate. Supersedes the engine's hard-coded `v === '[[]]'` guard:
		// {parent|optional|wikilink} never produces an empty link in the first place.
		const s = String(v);
		return isEmptyListOrLinkValue(s) ? '' : `[[${s}]]`;
	},
	regex: (v, arg, ctx) => {
		// {var|regex(<pattern>)} — return the first match of <pattern> (or its
		// first capture group, if present). Since R2.4 the argument lexer is
		// balanced-paren and backslash aware, so `regex(:\s*(.+)$)` and
		// `regex(A|B)` are written exactly as one would write the regex.
		if (arg === undefined) {
			throw new RenderError(`regex filter requires a pattern, e.g. {var|regex([A-Z.]+-\\d+)}.`);
		}
		let re: RegExp;
		try {
			re = new RegExp(arg);
		} catch (e) {
			throw new RenderError(`regex filter pattern is invalid (${(e as Error).message}).`);
		}
		const found = String(v).match(re);
		if (!found) {
			ctx?.report?.notes.push({
				code: 'regex-no-match',
				template: ctx.template,
				detail: `"${String(v)}" doesn't match the pattern "${arg}": this piece came back empty.`,
			});
		}
		return found ? (found[1] ?? found[0]) : '';
	},
};

/** `split(<delim>)`: the produce step. Trims each piece and drops empties. */
function splitToList(value: unknown, arg: string): string[] {
	const delim = decodeDelimiter(arg);
	if (delim === '') {
		throw new RenderError(`split filter requires a non-empty delimiter; got "${arg}".`);
	}
	const source = Array.isArray(value) ? value : [value];
	return source
		.flatMap((item) => String(item).split(delim))
		.map((piece) => piece.trim())
		.filter((piece) => piece !== '');
}

/**
 * True when at least one character of `set` occurs in `s`.
 * Delimiter sets are tiny and values are short cell text, so a linear scan over
 * the set (not the string) is the cheap order.
 */
function containsAnyChar(s: string, set: string): boolean {
	return set.split('').some((c) => s.includes(c));
}

/**
 * Tokenize `s` on ANY single character of `set`. Returns the pieces WITH their
 * original end offsets so `prefix` can truncate while keeping the delimiters.
 * Adjacent delimiters yield empty pieces (dropped by the callers, per §2.1).
 */
function splitOnSet(s: string, set: string): { text: string; end: number }[] {
	const chars = new Set(set.split(''));
	const pieces: { text: string; end: number }[] = [];
	let start = 0;
	for (let i = 0; i < s.length; i++) {
		if (!chars.has(s[i])) continue;
		pieces.push({ text: s.slice(start, i), end: i });
		start = i + 1;
	}
	pieces.push({ text: s.slice(start), end: s.length });
	return pieces;
}

/** `part(<delims>)`: the produce step. Trimmed non-empty pieces of the set split. */
function partToList(value: unknown, arg: string): string[] {
	const delimSet = decodeDelimiter(arg);
	if (delimSet === '') {
		throw new RenderError(`part filter requires a non-empty delimiter set; got "${arg}".`);
	}
	const source = Array.isArray(value) ? value : [value];
	return source
		.flatMap((item) => splitOnSet(String(item).trim(), delimSet))
		.map((piece) => piece.text.trim())
		.filter((piece) => piece !== '');
}

/** True for the filter forms that consume a list directly instead of lifting. */
function isListAware(call: FilterCall): boolean {
	if (call.name === 'join') return true;
	// `split`'s 1-argument (list-producing) form; the 2-arg form is scalar to scalar.
	if (call.name === 'split' && call.arg !== undefined && !/^(.*),(\d+)$/.test(call.arg)) return true;
	// `part`'s 1-argument (list-producing) form; same shape as split.
	if (call.name === 'part' && call.arg !== undefined && !/^(.*),(\d+)$/.test(call.arg)) return true;
	return false;
}

/** Source placeholders represent absent links, not a note or CURIE named None. */
export function isEmptyListOrLinkValue(value: unknown): boolean {
	return /^(?:none\.?|n\/?a|-)$/i.test(String(value ?? '').trim()) || String(value ?? '').trim() === '';
}

/** L2 — elide items blanked by a filter, recording one note with the count. */
function elideEmpties(items: unknown[], filterName: string, ctx: FilterCtx): unknown[] {
	const kept = items.filter((item) => item !== '' && item !== null && item !== undefined);
	const dropped = items.length - kept.length;
	if (dropped > 0) {
		ctx.report?.notes.push({
			code: 'list-items-dropped',
			template: ctx.template,
			detail: `${dropped} ${dropped === 1 ? 'item was' : 'items were'} empty after ${filterName} and ${dropped === 1 ? 'was' : 'were'} left out of the list.`,
		});
	}
	return kept;
}

function applyFilter(call: FilterCall, value: unknown, ctx: FilterCtx): unknown {
	if (call.malformed) {
		throw new RenderError(`Malformed filter expression "${call.raw.trim()}" in template "${ctx.template}".`);
	}

	const fn = FILTERS[call.name];
	if (!fn) {
		throw new RenderError(
			`Unknown filter "${call.name}" in template "${ctx.template}". Allowed filters: optional, ${Object.keys(FILTERS).join(', ')}.`,
		);
	}

	// L1 — lifting. A filter that receives a list is applied to each item and
	// the results form a list. This is the capability: `curie-prefix`, `upper`,
	// `regex` and every filter added later become per-item for free.
	if (Array.isArray(value) && !isListAware(call)) {
		return elideEmpties(
			value.map((item) => fn(item, call.arg, ctx)),
			call.name,
			ctx,
		);
	}

	const out = fn(value, call.arg, ctx);
	return Array.isArray(out) ? elideEmpties(out, call.name, ctx) : out;
}
