/**
 * mapping/view-model.ts — the view-coherence law made executable (spec §3a½/§7a).
 *
 * ONE `ImportMapping` is the only state. The preset bar, the shape cards, the
 * matrix, and the vault preview all read and write it THROUGH this module. Every
 * function here is pure — it takes state and returns new state (or a derived
 * read), never mutating in place — so a deeper view always shows exactly what a
 * shallower one wrote and there is no second "simple mode" codepath.
 *
 * Two kinds of operation live here:
 *   - WRITES that a coarse view performs on the model: toggling a shape card
 *     (`toggleDestinationAcrossMapping`), merging/splitting matrix rows
 *     (`mergeRows` / `splitRow`), adding/removing a single destination.
 *   - READS the views render from the model: the per-mapping shape-card summary
 *     (`deriveShapeCards`, which reports a genuinely mixed row set as `'mixed'`,
 *     never as a wrong binary), and the preset-drift check that flips the preset
 *     chip to `Custom (based on X)` (`isUnmodifiedPreset`).
 *
 * Pure module: NO Obsidian imports.
 */

import type { Detection } from '../detection';
import type { Preset } from './presets';
import { instantiate } from './instantiate';
import type {
	ImportMapping,
	StructureMapping,
	LevelRule,
	TailRule,
	Destination,
	DestinationPrimitive,
	LevelSource,
	SourceRef,
	PartRef,
} from './types';
import { destinationRank, toSourceRefs, isConstantRef, DEFAULT_MISSING } from './types';
import { normalizeFolderSetting } from '../../settings/folder-settings';

// ============================================================================
// Shape cards (the coarse, per-mapping summary view — M2)
// ============================================================================

/** The six shape-card ids, in mockup (M2) display order. */
export type ShapeCardId = 'folder' | 'name' | 'tag' | 'heading' | 'link' | 'property';

/** Display order + labels for the six cards (sentence case, no em dashes). */
export const SHAPE_CARDS: { id: ShapeCardId; label: string; primitive: DestinationPrimitive }[] = [
	{ id: 'folder', label: 'Folders', primitive: 'folder' },
	{ id: 'name', label: 'File names', primitive: 'name' },
	{ id: 'tag', label: 'Tags', primitive: 'tag' },
	{ id: 'heading', label: 'One file', primitive: 'heading' },
	{ id: 'link', label: 'Links', primitive: 'link' },
	{ id: 'property', label: 'Properties', primitive: 'property' },
];

/**
 * A card's state across a mapping's rows:
 *   - `on`    — the primitive is present on every row that could carry it.
 *   - `off`   — present on none (or no row can carry it).
 *   - `mixed` — present on some rows but not all. This is the honest tri-state
 *               (spec §7a): a single toggle cannot represent a divergent row set,
 *               so the card reports `mixed` rather than lie with a binary.
 */
export type ShapeCardState = 'on' | 'off' | 'mixed';

/** A matrix row is either a level rule or the variadic tail. */
interface Row {
	kind: 'level' | 'tail';
	destinations: Destination[];
	isLeaf: boolean;
}

/** The rows of a mapping in matrix order: every level, then the tail (if any). */
function rowsOf(m: StructureMapping): Row[] {
	const rows: Row[] = m.levels.map((l) => ({
		kind: 'level' as const,
		destinations: l.destinations,
		isLeaf: l.destinations.some((d) => d.primitive === 'name'),
	}));
	if (m.tail) {
		rows.push({ kind: 'tail', destinations: m.tail.destinations, isLeaf: false });
	}
	return rows;
}

/**
 * The rows a given primitive is eligible to land on:
 *   - `name` lives on the leaf (the note itself), so its card is computed over
 *     leaf rows only and is therefore never mixed.
 *   - every other primitive lives on the structural (non-leaf) rows + the tail.
 *   A single-level mapping (a facet or a bare link) has no leaf marker, so its
 *   only row is eligible for the non-name primitives.
 */
function eligibleRows(rows: Row[], primitive: DestinationPrimitive): Row[] {
	if (primitive === 'name') return rows.filter((r) => r.isLeaf);
	return rows.filter((r) => !r.isLeaf);
}

/** Derive the on/off/mixed state of all six cards for one mapping. */
export function deriveShapeCards(m: StructureMapping): Record<ShapeCardId, ShapeCardState> {
	const rows = rowsOf(m);
	const out = {} as Record<ShapeCardId, ShapeCardState>;
	for (const card of SHAPE_CARDS) {
		const eligible = eligibleRows(rows, card.primitive);
		if (eligible.length === 0) {
			out[card.id] = 'off';
			continue;
		}
		const present = eligible.filter((r) => r.destinations.some((d) => d.primitive === card.primitive)).length;
		out[card.id] = present === 0 ? 'off' : present === eligible.length ? 'on' : 'mixed';
	}
	return out;
}

// ============================================================================
// Toggle a shape card across a mapping (coarse write — M2)
// ============================================================================

/**
 * Add or remove a primitive across every eligible row of a mapping (the card
 * toggle). Returns a NEW mapping; the input is never mutated.
 *
 * `on: true`  — adds the primitive (with sensible default params) to each
 *               eligible row that lacks it, then canonicalizes destination order.
 * `on: false` — removes the primitive from every eligible row.
 *
 * This is the single coupling point that keeps the card view and the matrix view
 * coherent: both are just this write against the same model.
 */
export function toggleDestinationAcrossMapping(
	m: StructureMapping,
	primitive: DestinationPrimitive,
	on: boolean,
): StructureMapping {
	const leafPrimitive = primitive === 'name';
	const touchLevel = (rule: LevelRule): LevelRule => {
		const isLeaf = rule.destinations.some((d) => d.primitive === 'name');
		const eligible = leafPrimitive ? isLeaf : !isLeaf;
		if (!eligible) return rule;
		return withPrimitive(rule, primitive, on);
	};

	const levels = m.levels.map(touchLevel);
	let tail = m.tail;
	if (tail && !leafPrimitive) {
		tail = withPrimitiveTail(tail, primitive, on);
	}
	return tail ? { levels, tail } : { levels };
}

/** Add/remove a primitive on one level rule (immutable). */
function withPrimitive(rule: LevelRule, primitive: DestinationPrimitive, on: boolean): LevelRule {
	const has = rule.destinations.some((d) => d.primitive === primitive);
	if (on === has) return rule;
	const destinations = on
		? sortDestinations([...rule.destinations, defaultDestination(primitive, rule.source, rule.level)])
		: rule.destinations.filter((d) => d.primitive !== primitive);
	return { ...rule, destinations };
}

/** Add/remove a primitive on the tail rule (immutable). */
function withPrimitiveTail(tail: TailRule, primitive: DestinationPrimitive, on: boolean): TailRule {
	const has = tail.destinations.some((d) => d.primitive === primitive);
	if (on === has) return tail;
	const destinations = on
		? sortDestinations([...tail.destinations, defaultDestination(primitive, tail.source, 'tail')])
		: tail.destinations.filter((d) => d.primitive !== primitive);
	return { ...tail, destinations };
}

// ============================================================================
// Add / remove a single destination (matrix ⊕ menu + chip remove-x — M2b)
// ============================================================================

/**
 * Add a fully-specified destination to one level of a mapping (the two-stage ⊕
 * menu commits here). Idempotent on `(primitive, key)` identity. Returns a new
 * mapping.
 */
export function addDestination(m: StructureMapping, levelIndex: number, dest: Destination): StructureMapping {
	if (levelIndex < 0 || levelIndex >= m.levels.length) return m;
	const levels = m.levels.map((rule, i) => {
		if (i !== levelIndex) return rule;
		if (rule.destinations.some((d) => sameDestination(d, dest))) return rule;
		return { ...rule, destinations: sortDestinations([...rule.destinations, dest]) };
	});
	return m.tail ? { levels, tail: m.tail } : { levels };
}

/** Remove a destination (by primitive + optional key) from one level. New mapping. */
export function removeDestination(
	m: StructureMapping,
	levelIndex: number,
	primitive: DestinationPrimitive,
	key?: string,
): StructureMapping {
	if (levelIndex < 0 || levelIndex >= m.levels.length) return m;
	const levels = m.levels.map((rule, i) => {
		if (i !== levelIndex) return rule;
		return {
			...rule,
			destinations: rule.destinations.filter((d) => !(d.primitive === primitive && destKey(d) === key)),
		};
	});
	return m.tail ? { levels, tail: m.tail } : { levels };
}

// ============================================================================
// Merge / split matrix rows (regroup levels — M2b, buttons not drag for v1)
// ============================================================================

/**
 * Merge level `index` with the next level into one row (spec §3a½: the "regroup"
 * gesture = aggregation). The merged source becomes a contiguous part range when
 * both levels index the same column consecutively, otherwise a cross-column
 * `PartRef[]`. Naming flips to `joined`; destinations are the union of both.
 * No-op when `index` is out of range or is the last level. Returns a new mapping.
 */
export function mergeRows(m: StructureMapping, index: number): StructureMapping {
	if (index < 0 || index >= m.levels.length - 1) return m;
	const a = m.levels[index];
	const b = m.levels[index + 1];

	const merged: LevelRule = {
		level: `${a.level}+${b.level}`,
		source: mergeSources(a, b),
		destinations: sortDestinations(unionDestinations(a.destinations, b.destinations)),
		naming: 'joined',
		missing: a.missing,
		materialize: a.materialize || b.materialize,
	};
	const delimiter = a.delimiter ?? b.delimiter;
	if (delimiter !== undefined) merged.delimiter = delimiter;
	const join = a.join ?? a.delimiter ?? b.delimiter;
	if (join !== undefined) merged.join = join;
	const filters = a.filters ?? b.filters;
	if (filters !== undefined) merged.filters = filters;

	const levels = [...m.levels.slice(0, index), merged, ...m.levels.slice(index + 2)];
	return m.tail ? { levels, tail: m.tail } : { levels };
}

/**
 * Split level `index` back into one row per part (the inverse regroup gesture).
 * A part range `[i,j]` explodes into `j - i + 1` single-part levels; a
 * cross-column `PartRef[]` explodes into one level per ref. A single-part /
 * whole-column / constant source is not splittable — returns the mapping
 * unchanged. Returns a new mapping.
 */
export function splitRow(m: StructureMapping, index: number): StructureMapping {
	if (index < 0 || index >= m.levels.length) return m;
	const rule = m.levels[index];
	const pieces = splitSource(rule.source);
	if (pieces.length < 2) return m;

	const newLevels: LevelRule[] = pieces.map((source, k) => {
		const level: LevelRule = {
			level: `${rule.level}.${k + 1}`,
			source,
			destinations: sortDestinations(rule.destinations.map((d) => ({ ...d }))),
			naming: 'part',
			missing: rule.missing,
			materialize: rule.materialize,
		};
		if (rule.delimiter !== undefined) level.delimiter = rule.delimiter;
		if (rule.filters !== undefined) level.filters = [...rule.filters];
		return level;
	});

	const levels = [...m.levels.slice(0, index), ...newLevels, ...m.levels.slice(index + 1)];
	return m.tail ? { levels, tail: m.tail } : { levels };
}

// ============================================================================
// Preset drift — the Custom label (spec §3c½ step 4)
// ============================================================================

/**
 * True when `current` is exactly what `preset` instantiates over `detections`
 * (no manual edits). The preset chip stays as the preset's name while this holds;
 * the first edit that makes it false flips the chip to `Custom (based on X)`.
 * Comparison is structural (key-order independent).
 */
export function isUnmodifiedPreset(current: ImportMapping, preset: Preset, detections: Detection[]): boolean {
	return structuralEqual(current, instantiate(preset, detections));
}

// ============================================================================
// Source merge / split helpers
// ============================================================================

/** Combine two level sources into one merged source (range when possible). */
function mergeSources(a: LevelRule, b: LevelRule): LevelSource {
	const refs = [...toSourceRefs(a.source), ...toSourceRefs(b.source)];
	const asParts = refs.filter((r): r is PartRef => !isConstantRef(r));
	if (
		asParts.length === refs.length &&
		asParts.every((r) => typeof r.part === 'number') &&
		asParts.every((r) => r.column === asParts[0].column)
	) {
		const indices = (asParts as (PartRef & { part: number })[]).map((r) => r.part).sort((x, y) => x - y);
		const consecutive = indices.every((n, i) => i === 0 || n === indices[i - 1] + 1);
		if (consecutive) {
			return { column: asParts[0].column, part: [indices[0], indices[indices.length - 1]] };
		}
	}
	return refs;
}

/** Explode a source into its constituent single-ref sources (for split). */
function splitSource(source: LevelSource): LevelSource[] {
	const refs = toSourceRefs(source);
	if (refs.length > 1) return refs.map((r) => r);
	const only = refs[0];
	if (!isConstantRef(only) && Array.isArray(only.part)) {
		const [i, j] = only.part;
		const out: LevelSource[] = [];
		for (let k = i; k <= j; k++) out.push({ column: only.column, part: k });
		return out;
	}
	return [source];
}

// ============================================================================
// Destination helpers
// ============================================================================

/** A sensible default destination for a primitive toggled on over a source. */
function defaultDestination(primitive: DestinationPrimitive, source: LevelSource, levelId: string): Destination {
	const column = firstColumn(source);
	switch (primitive) {
		case 'folder':
			return { primitive: 'folder' };
		case 'name':
			return { primitive: 'name' };
		case 'note':
			return { primitive: 'note' };
		case 'alias':
			return { primitive: 'alias' };
		case 'tag':
			return { primitive: 'tag', namespace: slug(column) };
		case 'heading':
			return { primitive: 'heading', hostRule: 'root', depth: 2 };
		case 'link':
			return { primitive: 'link', key: 'parent', direction: 'parent-on-child' };
		case 'property':
			return { primitive: 'property', key: propertyKey(column, levelId) };
		case 'body':
			return { primitive: 'body', position: 'section' };
	}
}

/** The identity key of a destination (frontmatter key for property/link, else undefined). */
export function destKey(d: Destination): string | undefined {
	if (d.primitive === 'property' || d.primitive === 'link') return d.key;
	return undefined;
}

/** Two destinations collide when they share a primitive and (for keyed ones) a key. */
function sameDestination(a: Destination, b: Destination): boolean {
	return a.primitive === b.primitive && destKey(a) === destKey(b);
}

/** Union two destination lists, de-duplicating on (primitive, key). */
function unionDestinations(a: Destination[], b: Destination[]): Destination[] {
	const out = [...a];
	for (const d of b) {
		if (!out.some((x) => sameDestination(x, d))) out.push(d);
	}
	return out;
}

/** Canonical destination order for stable, round-trip-safe output. */
function sortDestinations(destinations: Destination[]): Destination[] {
	return [...destinations].sort((a, b) => destinationRank(a.primitive) - destinationRank(b.primitive));
}

// ============================================================================
// Small helpers
// ============================================================================

/** First column (or literal) referenced by a source. */
function firstColumn(source: LevelSource): string {
	const ref: SourceRef = toSourceRefs(source)[0];
	return isConstantRef(ref) ? ref.constant : ref.column;
}

/** A frontmatter-safe property key from a column, falling back to the level id. */
function propertyKey(column: string, levelId: string): string {
	const base = column || levelId;
	return base.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || levelId;
}

/** Slug a column into a tag namespace (mirrors serialize.slug). */
function slug(column: string): string {
	return column.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Structural (key-order independent) deep equality for plain JSON-ish values. */
export function structuralEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (a === null || b === null) return a === b;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((v, i) => structuralEqual(v, b[i]));
	}
	if (typeof a === 'object') {
		const ao = a as Record<string, unknown>;
		const bo = b as Record<string, unknown>;
		const ak = Object.keys(ao);
		const bk = Object.keys(bo);
		if (ak.length !== bk.length) return false;
		return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && structuralEqual(ao[k], bo[k]));
	}
	return false;
}

/** Re-export so callers building matrices need the same default policy value. */
export { DEFAULT_MISSING };

// ============================================================================
// Review-screen helpers (spec §7j) — pure, unit-tested
// ============================================================================

/**
 * The default vault destination for an import (spec §7j #2). `outputPath` is the
 * GLOBAL root (the plugin setting) and becomes the parent; the per-import root
 * is `<root>/<source basename>` with the extension stripped. An empty / unknown
 * source falls back to a stable `<root>/Imported` so the field is never blank,
 * and an empty root falls back to `Frameworks`.
 */
export function deriveDestinationDefault(outputPath: string, sourceFileName: string | null | undefined): string {
	// Every import nests under its OWN root folder inside the global output
	// path (owner, 2026-07-11). Writing straight into the shared root flattens
	// every import's top-level folders together, and the real damage is
	// ownership: with one collection already in that folder, the review screen
	// preselects refreshing it, so the NEXT unrelated source is attributed to the
	// first and every concept in the first is reported missing from the new one.
	// AM-53, extended (2026-09-04). THROUGH THE ONE NORMALIZATION. This was a
	// second spelling of it - trim plus TRAILING separators, verbatim the
	// `stripSlashes` shape AM-49 records as insufficient - so the destination this
	// derives and DISPLAYS for the user to accept was not the destination the
	// engine went on to write. `Frame//works` was shown as `Frame//works/nist` and
	// written as `Frame/works/nist`.
	const root = normalizeFolderSetting(outputPath ?? '') || 'Frameworks';
	const base = basenameNoExt(sourceFileName ?? '');
	return base ? `${root}/${base}` : `${root}/Imported`;
}

/** Strip directory + extension from a file name, leaving the trimmed stem. */
function basenameNoExt(fileName: string): string {
	const name = fileName.split(/[\\/]/).pop() ?? '';
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	return stem.trim();
}

/** Where an applied mapping came from (spec §7j #3). */
export type ProvenanceOrigin = 'built-in' | 'yours' | 'custom';

export interface Provenance {
	origin: ProvenanceOrigin;
	/** Short badge text: "Built-in" | "Yours" | "Custom (based on X)". */
	badge: string;
	/** True when this is the detection-recommended default (adds a Recommended tag). */
	recommended: boolean;
	/** One-line step-3 summary, e.g. "Browsable framework · built-in preset · unmodified". */
	line: string;
}

export interface ProvenanceInput {
	presetLabel: string;
	isBuiltIn: boolean;
	unmodified: boolean;
	recommended: boolean;
	appliedConfigName?: string | null;
}

/**
 * Derive the provenance badge + line for a preset/config surface (spec §7j #3).
 *   - a user-saved config that was applied reads as "Yours" (whatever the preset);
 *   - an unmodified built-in preset reads as "Built-in" (and may be Recommended);
 *   - anything edited off a preset reads as "Custom (based on <name>)".
 */
export function deriveProvenance(input: ProvenanceInput): Provenance {
	const { presetLabel, isBuiltIn, unmodified, recommended, appliedConfigName } = input;
	if (appliedConfigName) {
		return {
			origin: 'yours',
			badge: 'Yours',
			recommended: false,
			line: `${appliedConfigName} · your saved config${unmodified ? '' : ' · edited'}`,
		};
	}
	if (unmodified && isBuiltIn) {
		return {
			origin: 'built-in',
			badge: 'Built-in',
			recommended,
			line: `${presetLabel} · built-in preset · unmodified`,
		};
	}
	return {
		origin: 'custom',
		badge: `Custom (based on ${presetLabel})`,
		recommended: false,
		line: `${presetLabel} · custom · edited`,
	};
}

/** One row of the step-3 shape-map recap table (spec §7j #1). */
export interface ShapeMapRecapRow {
	from: string;
	becomes: string;
	count: string;
}

/**
 * Assemble the shape-map recap rows: a header row ("Each row → Notes, one per
 * row → N") followed by one row per non-empty mapping (its source columns → the
 * vault shapes it lands as). Pure — the wizard just renders these to a table.
 */
export function buildShapeMapRecap(mapping: ImportMapping, totalRows: number): ShapeMapRecapRow[] {
	const rows: ShapeMapRecapRow[] = [{
		from: 'Each row',
		becomes: 'Notes, one per row',
		count: totalRows.toLocaleString(),
	}];
	for (const m of mapping.mappings) {
		const cards = deriveShapeCards(m);
		const shapes = SHAPE_CARDS.filter((c) => cards[c.id] !== 'off').map((c) => c.label.toLowerCase());
		if (shapes.length === 0) continue;
		rows.push({ from: mappingColumnsLabel(m), becomes: shapes.join(', '), count: '-' });
	}
	return rows;
}

/** Up to three source columns (or literals) a mapping draws from — the recap "from" cell. */
function mappingColumnsLabel(m: StructureMapping): string {
	const cols = new Set<string>();
	const collect = (source: LevelSource) => {
		for (const ref of toSourceRefs(source)) {
			cols.add(isConstantRef(ref) ? `"${ref.constant}"` : ref.column);
		}
	};
	for (const l of m.levels) collect(l.source);
	if (m.tail) collect(m.tail.source);
	return [...cols].slice(0, 3).join(', ') || 'mapping';
}

// ============================================================================
// Connections (Pass 1.5 batch enrichment UI helpers, spec §7k + the
// 2026-07-10 batch-enrichment design). The workbench's "Connections" card
// reads/writes `ImportMapping.enrichment` directly (a plain field write, same
// pattern as `updateMapping`); these are the READ helpers it needs to render
// honest controls: which column(s) are currently tagged (for the facet-hubs
// label) and the side-by-side sibling/folder-note placement mini-trees from
// the variadic-split design §4.
// ============================================================================

/**
 * Columns currently carrying a `tag` destination anywhere in the mapping — the
 * facet(s) a "create hub notes for" control would group by. Deterministic
 * (mapping → level → tail order); a column appears once even if tagged more
 * than once. Empty when no mapping has a tag destination yet (the facet-hubs
 * control has nothing to group by until a "Tags" shape card is toggled on).
 */
export function facetTagColumns(mapping: ImportMapping): string[] {
	const cols: string[] = [];
	const seen = new Set<string>();
	const collect = (destinations: Destination[], source: LevelSource) => {
		if (!destinations.some((d) => d.primitive === 'tag')) return;
		const col = firstColumn(source);
		if (!seen.has(col)) {
			seen.add(col);
			cols.push(col);
		}
	};
	for (const m of mapping.mappings) {
		for (const l of m.levels) collect(l.destinations, l.source);
		if (m.tail) collect(m.tail.destinations, m.tail.source);
	}
	return cols;
}

/** One row of a mini vault-tree preview (folder or file, indented by depth). */
export interface PathTreeNode {
	depth: number;
	label: string;
	isFile: boolean;
	/** Parent-child relation role for the placement previews (accent overlay). */
	relation?: 'parent' | 'child';
	/** Index into the flat node list of this node's relation group's parent —
	 *  lets the renderer draw one connector rail per parent group. */
	relationParentIndex?: number;
}

/**
 * Build a deduplicated folder/file tree from a flat list of relative note
 * paths (first appearance wins for a folder's position — order-preserving, so
 * the tree matches the sample rows' own order). Pure: no `Address` dependency,
 * so it renders equally over real preview output or hand-built test fixtures.
 */
export function buildPathTree(paths: string[]): PathTreeNode[] {
	const seen = new Set<string>();
	const nodes: PathTreeNode[] = [];
	for (const full of paths) {
		if (!full) continue;
		const parts = full.split('/');
		let prefix = '';
		parts.forEach((part, depth) => {
			prefix += (prefix ? '/' : '') + part;
			const isFile = depth === parts.length - 1;
			if (!isFile) {
				if (seen.has(prefix)) return;
				seen.add(prefix);
				nodes.push({ depth, label: part, isFile: false });
			} else {
				nodes.push({ depth, label: part, isFile: true });
			}
		});
	}
	return nodes;
}

/**
 * Rewrite a flat list of relative note paths as if `parent_note: 'folder-note'`
 * had relocated every concept that is also a parent (variadic-split + folder-
 * note design §4): a leaf whose stem exactly matches an existing folder prefix
 * moves inside that folder (`Techniques/T1055.md` → `Techniques/T1055/T1055.md`).
 * Childless leaves are untouched. Pure string transform — v0.1's actual
 * relocation pass isn't implemented yet (schema falls back to 'sibling' at
 * render time), so this previews the choice the UI offers without depending on
 * the not-yet-built Pass 1.5 relocation code.
 */
export function toFolderNotePaths(paths: string[]): string[] {
	const folderPaths = new Set<string>();
	for (const p of paths) {
		const parts = p.split('/');
		for (let i = 1; i < parts.length; i++) folderPaths.add(parts.slice(0, i).join('/'));
	}
	return paths.map((p) => {
		const dot = p.lastIndexOf('.');
		const stem = dot > 0 ? p.slice(0, dot) : p;
		if (!folderPaths.has(stem)) return p;
		const name = p.split('/').pop();
		return `${stem}/${name}`;
	});
}

/**
 * Case-insensitive plugin-id match against a known-id set plus substring
 * fallbacks (a manifest id like `aidenlx-folder-note` or a fork's own naming
 * still matches on `folder-note` alone). Shared by every enabled-plugin
 * detection helper in this module — `preferredParentNote` and
 * `detectWaypointPlugin` both match the same way; only the id set differs.
 */
function matchesPluginId(enabledPluginIds: Iterable<string>, knownIds: Set<string>, substrings: string[]): boolean {
	for (const id of enabledPluginIds) {
		const norm = id.toLowerCase();
		if (knownIds.has(norm)) return true;
		if (substrings.some((s) => norm.includes(s))) return true;
	}
	return false;
}

/**
 * Adaptive parent-note default (owner: "if they're using a folder-notes
 * related plugin, we should probably make it the default"): when the vault
 * runs a folder-note-style community plugin, the user has already chosen how
 * parents should live — match them. Pure over the enabled-plugin id set.
 */
export function preferredParentNote(enabledPluginIds: Iterable<string>): {
	value: 'sibling' | 'folder-note';
	reason?: string;
} {
	// Folder-note is the default outright (owner, 2026-07-11): relocation is
	// real, re-import safe, and contained parents read better. Detecting a
	// folder-notes plugin only sharpens the explanation shown to the user.
	const KNOWN = new Set(['folder-notes', 'folder-note-plugin', 'folder-note-core', 'aidenlx-folder-note', 'waypoint']);
	if (matchesPluginId(enabledPluginIds, KNOWN, ['folder-note', 'foldernote'])) {
		return { value: 'folder-note', reason: 'Matches the folder notes plugin this vault uses.' };
	}
	return { value: 'folder-note' };
}

/**
 * Detect a Waypoint-style community plugin (2026-07-11 ICSB audit §4 verdict):
 * gates the workbench's opt-in "also mark folder notes for Waypoint" toggle.
 * Narrower and orthogonal to `preferredParentNote`'s folder-note detection —
 * that treats an enabled Waypoint as evidence for the folder-note PLACEMENT
 * default; this is specifically about whether to offer the complementary
 * marker toggle at all (level hubs stay Crosswalker's own primary mechanism
 * regardless of this result — see the audit's "generate-our-own" verdict).
 */
export function detectWaypointPlugin(enabledPluginIds: Iterable<string>): boolean {
	return matchesPluginId(enabledPluginIds, new Set(['waypoint']), ['waypoint']);
}

/**
 * Mark the parent-child relation on a placement-preview tree so the renderer
 * can draw the connector overlay (owner request: "show some sort of purple
 * line to show the connected pieces"). A file is a PARENT when a folder named
 * after its stem exists in the tree (sibling shape: `T1078.md` beside
 * `T1078/`) or when it sits inside a folder named after its own stem
 * (folder-note shape: `T1078/T1078.md`). Files directly inside that folder
 * are its CHILDREN. Pure walk over the flat node list; full paths are
 * reconstructed from depths with a folder stack.
 */
export function markPlacementRelations(nodes: PathTreeNode[]): PathTreeNode[] {
	// Reconstruct each node's full path.
	const stack: string[] = [];
	const fullPaths: string[] = nodes.map((n) => {
		stack.length = n.depth;
		const full = [...stack.slice(0, n.depth), n.label].join('/');
		if (!n.isFile) stack[n.depth] = n.label;
		return full;
	});
	const folderPaths = new Map<string, number>();
	nodes.forEach((n, i) => {
		if (!n.isFile) folderPaths.set(fullPaths[i], i);
	});
	const stemOf = (p: string): string => {
		const dot = p.lastIndexOf('.');
		return dot > 0 ? p.slice(0, dot) : p;
	};
	// Parent files: stem matches a folder path (sibling), or dir === stem's dir
	// with folder name === file stem (folder-note: dir itself IS the stem path).
	const parentFolderByPath = new Map<string, number>(); // folder path -> parent node index
	nodes.forEach((n, i) => {
		if (!n.isFile) return;
		const full = fullPaths[i];
		const stem = stemOf(full);
		const dir = full.slice(0, Math.max(0, full.lastIndexOf('/')));
		if (folderPaths.has(stem)) {
			// sibling shape: T1078.md beside a T1078/ folder — highlight BOTH
			// pieces so the connection is visible (owner: "show in purple the
			// sibling file and the sibling folder").
			n.relation = 'parent';
			nodes[folderPaths.get(stem)!].relation = 'parent';
			parentFolderByPath.set(stem, i);
		} else if (dir && dir.split('/').pop() === stemOf(n.label)) {
			// folder-note shape: T1078/T1078.md — file and its containing folder
			n.relation = 'parent';
			const folderIdx = folderPaths.get(dir);
			if (folderIdx !== undefined) nodes[folderIdx].relation = 'parent';
			parentFolderByPath.set(dir, i);
		}
	});
	// Children: files directly inside a parent's folder (excluding the parent itself).
	nodes.forEach((n, i) => {
		if (!n.isFile || n.relation === 'parent') return;
		const full = fullPaths[i];
		const dir = full.slice(0, Math.max(0, full.lastIndexOf('/')));
		const parentIdx = parentFolderByPath.get(dir);
		if (parentIdx !== undefined) {
			n.relation = 'child';
			n.relationParentIndex = parentIdx;
		}
	});
	return nodes;
}

/**
 * Both parent-note placement previews (sibling + folder-note), built from the
 * same sample paths — the side-by-side mini-tree chooser (variadic-split
 * design §4, "the placement choice is a UI moment, not just a config key"),
 * with parent-child relations marked for the connector overlay.
 */
export function buildParentPlacementPreview(
	paths: string[],
): { sibling: PathTreeNode[]; folderNote: PathTreeNode[] } {
	return {
		sibling: markPlacementRelations(buildPathTree(paths)),
		folderNote: markPlacementRelations(buildPathTree(toFolderNotePaths(paths))),
	};
}
