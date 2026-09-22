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
 *     (`mergeRows` / `splitRow`), exploding one packed row into a level per piece
 *     (`splitIntoLevels`), adding/removing a single destination.
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
	CrosswalkDest,
	CrosswalkPredicate,
	LevelSource,
	SourceRef,
	PartRef,
	MissingPolicy,
} from './types';
import { destinationRank, toSourceRefs, isConstantRef, DEFAULT_MISSING } from './types';
import { normalizeFolderSetting } from '../../settings/folder-settings';
import type { NestedRecordLevel } from '../../types/generated/recipe';

// ============================================================================
// Shape cards (the coarse, per-mapping summary view — M2)
// ============================================================================

/** Shape-card ids in workbench display order. */
export type ShapeCardId = 'folder' | 'name' | 'tag' | 'heading' | 'link' | 'property' | 'crosswalk';

/** Display order + labels for the cards (sentence case, no em dashes). */
export const SHAPE_CARDS: { id: ShapeCardId; label: string; primitive: DestinationPrimitive }[] = [
	{ id: 'folder', label: 'Folders', primitive: 'folder' },
	{ id: 'name', label: 'File names', primitive: 'name' },
	{ id: 'tag', label: 'Tags', primitive: 'tag' },
	{ id: 'heading', label: 'One file', primitive: 'heading' },
	{ id: 'link', label: 'Links', primitive: 'link' },
	{ id: 'property', label: 'Properties', primitive: 'property' },
	{ id: 'crosswalk', label: 'Crosswalks', primitive: 'crosswalk' },
];

/**
 * A card's state across a mapping's rows:
 *   - `on`    — the destination kind is present on every row that could carry it.
 *   - `off`   — present on none (or no row can carry it).
 *   - `mixed` — present on some rows but not all. This is the honest tri-state
 *               (spec §7a): a single toggle cannot represent a divergent row set,
 *               so the card reports `mixed` rather than lie with a binary.
 */
export type ShapeCardState = 'on' | 'off' | 'mixed';

/** A matrix row is either a level rule or the variadic tail. */
interface Row {
	kind: 'level' | 'tail';
	source: LevelSource;
	destinations: Destination[];
	isLeaf: boolean;
}

/** The rows of a mapping in matrix order: every level, then the tail (if any). */
function rowsOf(m: StructureMapping): Row[] {
	const rows: Row[] = m.levels.map((l) => ({
		kind: 'level' as const,
		source: l.source,
		destinations: l.destinations,
		isLeaf: l.destinations.some((d) => d.primitive === 'name'),
	}));
	if (m.tail) {
		rows.push({ kind: 'tail', source: m.tail.source, destinations: m.tail.destinations, isLeaf: false });
	}
	return rows;
}

/** Folder depth of a mapping: the count of leading rows whose destinations include `folder`. Null when the rows are not in the shape "N folders, then a leaf" (e.g. a folder after a name row), so the dial shows "Custom". */
export function folderDepthOf(m: StructureMapping): number | null {
	const nameRows = m.levels
		.map((level, index) => level.destinations.some((d) => d.primitive === 'name') ? index : -1)
		.filter((index) => index >= 0);
	if (nameRows.length !== 1) return null;
	const leafIndex = nameRows[0];
	for (let index = 0; index < m.levels.length; index++) {
		const destinations = m.levels[index].destinations;
		const hasFolder = destinations.some((d) => d.primitive === 'folder');
		const hasName = destinations.some((d) => d.primitive === 'name');
		if (index < leafIndex && (!hasFolder || hasName)) return null;
		if (index === leafIndex && (hasFolder || !hasName)) return null;
		if (index > leafIndex && (hasFolder || hasName)) return null;
	}
	if (!m.tail) return leafIndex;
	const tailHasFolder = m.tail.destinations.some((d) => d.primitive === 'folder');
	const tailHasName = m.tail.destinations.some((d) => d.primitive === 'name');
	return tailHasFolder && !tailHasName && leafIndex === m.levels.length - 1
		? leafIndex + 1
		: null;
}

/** The maximum meaningful depth: the number of level rows (the tail, when present, counts as one more). */
export function maxFolderDepthOf(m: StructureMapping): number {
	return Math.max(0, m.levels.length - 1) + (m.tail ? 1 : 0);
}

/**
 * Reshape a mapping to exactly `depth` folder levels, immutably:
 *   rows 0..depth-1 gain `folder`, lose `name`;
 *   row depth becomes the leaf: gains `name`, loses `folder`;
 *   rows depth+1..end lose `folder` and `name`, gain `property` (key = the row's level id) when they have no other destination;
 *   a variadic tail is kept when depth >= levels.length and dropped otherwise, with its folder destination gone.
 * Other destinations on every row are untouched. Nested folder rows gain `leaf: folder-note`; other nested leaf values stay as-is.
 * Returns `m` unchanged when depth is out of range or already equals folderDepthOf(m).
 */
export function setFolderDepth(
	m: StructureMapping,
	depth: number,
	nest?: NestedRecordLevel[],
): { mapping: StructureMapping; nest?: NestedRecordLevel[] } {
	const maximum = maxFolderDepthOf(m);
	if (!Number.isInteger(depth) || depth < 0 || depth > maximum) {
		return { mapping: m, nest };
	}
	if (folderDepthOf(m) === depth) return { mapping: m, nest };

	const keepTail = m.tail !== undefined && depth === maximum;
	const fixedFolderDepth = keepTail ? Math.max(0, m.levels.length - 1) : depth;
	const levels = m.levels.map((level, index) => {
		const other = level.destinations.filter(
			(destination) => destination.primitive !== 'folder' && destination.primitive !== 'name',
		);
		let destinations: Destination[];
		if (index < fixedFolderDepth) {
			destinations = [...other, { primitive: 'folder' }];
		} else if (index === fixedFolderDepth) {
			destinations = [...other, { primitive: 'name' }];
		} else {
			destinations = other.length > 0
				? other
				: [{ primitive: 'property', key: level.level }];
		}
		return { ...level, destinations: sortDestinations(destinations) };
	});
	const tail = keepTail && m.tail
		? {
			...m.tail,
			destinations: sortDestinations([
				...m.tail.destinations.filter(
					(destination) => destination.primitive !== 'folder' && destination.primitive !== 'name',
				),
				{ primitive: 'folder' },
			]),
		}
		: undefined;
	const mapping = { ...m, levels, ...(tail ? { tail } : { tail: undefined }) };
	const folderLevels = new Set(levels.slice(0, fixedFolderDepth).map((level) => level.level));
	const nextNest = nest?.map((entry) =>
		folderLevels.has(entry.level) && entry.leaf !== 'folder-note'
			? { ...entry, leaf: 'folder-note' as const }
			: entry,
	);
	return { mapping, nest: nextNest };
}

/**
 * The rows a given destination kind is eligible to land on:
 *   - `name` lives on the leaf (the note itself), so its card is computed over
 *     leaf rows only and is therefore never mixed.
 *   - every other destination kind lives on the structural (non-leaf) rows + the tail.
 *
 * Either set can be EMPTY, and an empty set is not an error — it means no row of
 * this mapping can carry that destination kind, so the card has nothing to write to:
 *   - a single-level mapping instantiated leaf-only (`instantiate.leafLevel`, and
 *     the first manual mapping added by hand) is ALL leaf, so every non-name
 *     destination kind has zero eligible rows;
 *   - a facet / property-only mapping carries no `name` destination anywhere, so
 *     `name` has zero eligible rows.
 * Callers must not silently swallow that case: `shapeCardHint` explains it to the
 * user instead (an earlier version of this comment claimed a single-level mapping
 * "has no leaf marker", which is wrong and is why the Folders card sat dead with
 * no explanation).
 */
function eligibleRows(rows: Row[], primitive: DestinationPrimitive): Row[] {
	if (primitive === 'crosswalk') return rows;
	if (primitive === 'name') return rows.filter((r) => r.isLeaf);
	return rows.filter((r) => !r.isLeaf);
}

/** Derive the on/off/mixed state of all seven cards for one mapping. */
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
// Why a card can't be turned on / off (no silent no-ops)
// ============================================================================

/** Separators a packed id splits on (same set `detection.ts` scans for). */
const LEVEL_SEPARATOR = /[._\-/:]/;

/** Worked example used when the mapped column offers no usable sample value. */
const GENERIC_SPLIT_EXAMPLE = 'GV.OC-01';

/** The destination kinds that decide where a note lands in the vault. */
const PLACING_PRIMITIVES = new Set<DestinationPrimitive>(['folder', 'name', 'heading']);

/** Shown when a toggle would leave the import with nowhere to put its notes. */
export const NO_PLACE_TO_LAND =
	'This is the only thing placing notes in the vault. Turn on Folders, File names, or One file first, then turn this off.';

export interface ShapeCardHintOptions {
	/** A real value from the mapped column, used to build the worked example. */
	sampleValue?: string | null;
}

/**
 * Why a shape card cannot be turned on for this mapping, in plain language, or
 * `null` when the card IS actionable.
 *
 * A card with zero eligible rows used to render as a normal "Off" card whose
 * checkbox did nothing at all (`toggleDestinationAcrossMapping` returned the
 * mapping unchanged). This is the explanation the user gets instead. Pure, so
 * the workbench and any test can ask the same question of the same model.
 */
export function shapeCardHint(
	m: StructureMapping,
	primitive: DestinationPrimitive,
	options: ShapeCardHintOptions = {},
): string | null {
	const rows = rowsOf(m);
	if (primitive === 'crosswalk') {
		return rows.some((row) => isSingleColumnSource(row.source))
			? null
			: 'Crosswalks need a level that reads one column. This mapping has none.';
	}
	if (eligibleRows(rows, primitive).length > 0) return null;
	if (primitive === 'name') {
		return 'No level here is the note itself, so there is no name to set. Open Arrange levels and add File name to the level that should become the note.';
	}
	const cause = rows.length === 1
		? 'This column has one level, the note itself, so there is no level above it to put this on.'
		: 'Every level of this column is the note itself, so there is no level above it to put this on.';
	return `${cause} Levels come from values that split on a separator such as a dot, dash, slash, underscore, or colon. For example, ${splitExample(options.sampleValue)}. Map a column whose values split that way to get more levels.`;
}

/** "GV.OC-01 splits into GV, then GV.OC, then GV.OC-01" from a sample value. */
function splitExample(sampleValue?: string | null): string {
	const value = (sampleValue ?? '').trim();
	const usable = value.length > 0 && value.length <= 24 && LEVEL_SEPARATOR.test(value);
	const parts = splitPrefixes(usable ? value : GENERIC_SPLIT_EXAMPLE).slice(0, 4);
	return `${parts[parts.length - 1]} splits into ${parts.join(', then ')}`;
}

/** Cumulative prefixes of a packed value: GV.OC-01 → GV, GV.OC, GV.OC-01. */
function splitPrefixes(value: string): string[] {
	const out: string[] = [];
	let acc = '';
	for (const piece of value.split(/([._\-/:])/)) {
		if (piece === '') continue;
		acc += piece;
		if (!LEVEL_SEPARATOR.test(piece)) out.push(acc);
	}
	return out.length > 0 ? out : [value];
}

/** True when any row of this mapping places a note in the vault. */
export function hasPlacingDestination(m: StructureMapping): boolean {
	return rowsOf(m).some((r) => r.destinations.some((d) => PLACING_PRIMITIVES.has(d.primitive)));
}

/**
 * The message to show INSTEAD of applying a card toggle that would leave the
 * whole import with no place to put its notes (every mapping stripped of folder,
 * file name and one file at once). Returns `null` when the toggle is safe.
 *
 * Scoped to the whole `ImportMapping` on purpose: one mapping legitimately ends
 * up with no placing destination when a user resolves the two-structural-mapping
 * conflict by unticking Folders and File names on one of them. Only the state
 * where NOTHING places notes is the failure (`layout` serializes empty, and both
 * `source.levels` and `target.layout` then fail their minimum of one entry).
 */
export function blockedPlacingToggle(
	mapping: ImportMapping,
	mappingIndex: number,
	primitive: DestinationPrimitive,
	on: boolean,
): string | null {
	if (on || !PLACING_PRIMITIVES.has(primitive)) return null;
	const target = mapping.mappings[mappingIndex];
	if (!target) return null;
	const next = toggleDestinationAcrossMapping(target, primitive, on);
	const after = mapping.mappings.map((m, i) => (i === mappingIndex ? next : m));
	return after.some(hasPlacingDestination) ? null : NO_PLACE_TO_LAND;
}

// ============================================================================
// Toggle a shape card across a mapping (coarse write — M2)
// ============================================================================

/**
 * Add or remove one destination kind across every eligible row of a mapping
 * (the card toggle). Returns a NEW mapping; the input is never mutated.
 *
 * `on: true`  — adds the destination (with sensible default params) to each
 *               eligible row that lacks it, then canonicalizes destination order.
 * `on: false` — removes the destination from every eligible row.
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
	const allRows = primitive === 'crosswalk';
	const touchLevel = (rule: LevelRule): LevelRule => {
		const isLeaf = rule.destinations.some((d) => d.primitive === 'name');
		const eligible = allRows || (leafPrimitive ? isLeaf : !isLeaf);
		if (!eligible) return rule;
		return withPrimitive(rule, primitive, on);
	};

	const levels = m.levels.map(touchLevel);
	let tail = m.tail;
	if (tail && (allRows || !leafPrimitive)) {
		tail = withPrimitiveTail(tail, primitive, on);
	}
	return tail ? { levels, tail } : { levels };
}

/** Add/remove a destination kind on one level rule (immutable). */
function withPrimitive(rule: LevelRule, primitive: DestinationPrimitive, on: boolean): LevelRule {
	const has = rule.destinations.some((d) => d.primitive === primitive);
	if (on === has) return rule;
	const destinations = on
		? sortDestinations([...rule.destinations, defaultDestination(primitive, rule.source, rule.level)])
		: rule.destinations.filter((d) => d.primitive !== primitive);
	return { ...rule, destinations };
}

/** Add/remove a destination kind on the tail rule (immutable). */
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
 * menu commits here). Idempotent on destination-kind and key identity. Returns a new
 * mapping.
 */
export interface AddDestinationParams {
	toOntology?: string;
	predicate?: CrosswalkPredicate;
}

export function addDestination(
	m: StructureMapping,
	levelIndex: number,
	destination: Destination | DestinationPrimitive,
	params: AddDestinationParams = {},
): StructureMapping {
	if (levelIndex < 0 || levelIndex >= m.levels.length) return m;
	const rule = m.levels[levelIndex];
	let dest = typeof destination === 'string'
		? defaultDestination(destination, rule.source, rule.level)
		: destination;
	if (dest.primitive === 'crosswalk') {
		dest = {
			...dest,
			toOntology: params.toOntology ?? dest.toOntology ?? null,
			predicate: params.predicate ?? dest.predicate ?? 'is_approximate_to',
		};
	}
	const levels = m.levels.map((candidate, i) => {
		if (i !== levelIndex) return candidate;
		if (candidate.destinations.some((d) => sameDestination(d, dest))) return candidate;
		return { ...candidate, destinations: sortDestinations([...candidate.destinations, dest]) };
	});
	return m.tail ? { levels, tail: m.tail } : { levels };
}

/** Remove a destination (by kind + optional key) from one level. New mapping. */
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

/** Update one level's crosswalk target without mutating the mapping. */
export function setCrosswalkTarget(
	m: StructureMapping,
	levelIndex: number,
	patch: Partial<Pick<CrosswalkDest, 'toOntology' | 'predicate'>>,
): StructureMapping {
	if (levelIndex < 0 || levelIndex >= m.levels.length) return m;
	const levels = m.levels.map((rule, index) => {
		if (index !== levelIndex) return rule;
		let changed = false;
		const destinations = rule.destinations.map((destination) => {
			if (destination.primitive !== 'crosswalk') return destination;
			changed = true;
			return { ...destination, ...patch };
		});
		return changed ? { ...rule, destinations } : rule;
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
export function setNestLeaf(
	mapping: ImportMapping,
	level: string,
	leaf: 'folder-note' | 'none',
): ImportMapping {
	return {
		...mapping,
		nest: mapping.nest?.map((entry) => entry.level === level ? { ...entry, leaf } : entry),
	};
}

export function setNestIdentity(
	mapping: ImportMapping,
	level: string,
	identity: 'global' | 'path',
): ImportMapping {
	return {
		...mapping,
		nest: mapping.nest?.map((entry) => entry.level === level ? { ...entry, identity } : entry),
	};
}

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
	// A delimiter SET survives the merge the same way a single delimiter does, so
	// re-serializing the merged range still emits `part(D,k)` per piece. When
	// neither row carried a single delimiter there is nothing to join the pieces
	// with, so the first character of the set stands in: it is the one separator
	// we know occurs in the source, and it keeps `GV.OC-01.01` pieces 3+4 reading
	// as `01.01` rather than `0101`.
	const delimiters = a.delimiters ?? b.delimiters;
	if (delimiters !== undefined) merged.delimiters = delimiters;
	const join = a.join ?? a.delimiter ?? b.delimiter ?? firstDelimiterOf(delimiters);
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
// Split one row into N levels (the "Split into levels" apply — spec §4.3)
// ============================================================================

/** What the "Split into levels" panel commits (spec §4.3 input). */
export interface SplitIntoLevelsOptions {
	/**
	 * The delimiter SET: a string of single characters, any one of which
	 * separates two parts of the packed value (`.-` for `GV.OC-01.01`).
	 */
	delimiters: string;
	/** How many levels the value carries. Two or more; anything less is not a split. */
	depth: number;
	/**
	 * Naming for the NON-LEAF rows, outermost first, so `depth - 1` entries. The
	 * leaf has no naming choice (it is the untouched column), and any extra entry
	 * is ignored. A short array falls back to `prefix`, the cumulative name users
	 * already see on disk.
	 */
	naming: ('part' | 'prefix')[];
	/** Missing-value policy stamped on every produced level. */
	missing: MissingPolicy;
}

/**
 * Replace one matrix row with `depth` rows, one per piece of a packed value
 * tokenized on a delimiter SET (spec §4.3). This is the apply half of the
 * "Split into levels" panel; the panel owns the preview, this owns the model.
 *
 * Shape, not case (the essence rule): a packed id is a scalar tokenized on a
 * SET of delimiters with pieces addressed by index, so every NON-LEAF row is
 * `{ column, part: i }` + `delimiters`, and the serializer turns that into
 * `part(D,i)` / `prefix(D,i)`. The single-delimiter path is untouched.
 *
 * The leaf is the UNTOUCHED column, not the last piece: the leaf IS the id
 * (spec §4.1), so a ragged row that is short a level still renders its whole id
 * rather than an empty name. That is also exactly what detection + `instantiate`
 * emit, so the workbench apply and the detection path agree on the same input.
 *
 * Idempotent: re-splitting a row that an earlier split produced replaces the
 * WHOLE run (the contiguous same-column part rows plus the whole-column leaf
 * that follows them), never just the one row, so a user who applies depth 4 and
 * then depth 3 ends with three rows and not seven. Splitting from the leaf row
 * finds the same run.
 *
 * Returns `m` itself (not a copy) when there is nothing to do: an out-of-range
 * index, a depth below 2, an empty delimiter set, or a row whose source names no
 * column (a pure constant row has nothing to tokenize).
 */
export function splitIntoLevels(
	m: StructureMapping,
	levelIndex: number,
	opts: SplitIntoLevelsOptions,
): StructureMapping {
	if (levelIndex < 0 || levelIndex >= m.levels.length) return m;
	if (!Number.isInteger(opts.depth) || opts.depth < 2) return m;
	if (!opts.delimiters) return m;
	const column = firstPartColumn(m.levels[levelIndex].source);
	if (column === undefined) return m;

	const [start, end] = splitRunBounds(m.levels, levelIndex, column);
	const run = m.levels.slice(start, end + 1);
	// The run's LAST row is its leaf: it is the row that carried the note name (or
	// whatever else the user put there), and those destinations are what the new
	// leaf inherits. Every other destination in the run was folder scaffolding
	// this split is rebuilding.
	const leafDestinations = run[run.length - 1].destinations;
	// "Structural" here is the folder question only: does this run place folders?
	// Read across the whole run, because re-splitting from the run's leaf row
	// (which carries `name`, not `folder`) must not silently drop the folders the
	// earlier split created.
	const structural = run.some((rule) => rule.destinations.some((d) => d.primitive === 'folder'));
	const untouched = [...m.levels.slice(0, start), ...m.levels.slice(end + 1)];
	const ids = freeLevelIds(opts.depth, new Set(untouched.map((rule) => rule.level)));

	const produced: LevelRule[] = [];
	for (let i = 0; i < opts.depth - 1; i++) {
		produced.push({
			level: ids[i],
			source: [{ column, part: i }],
			delimiters: opts.delimiters,
			destinations: structural ? [{ primitive: 'folder' }] : [],
			naming: opts.naming[i] ?? 'prefix',
			missing: opts.missing,
			materialize: false,
		});
	}
	produced.push({
		level: ids[opts.depth - 1],
		source: [{ column }],
		destinations: sortDestinations(leafDestinations.map((d) => ({ ...d }))),
		naming: 'part',
		missing: opts.missing,
		materialize: false,
	});

	const levels = [...m.levels.slice(0, start), ...produced, ...m.levels.slice(end + 1)];
	return m.tail ? { levels, tail: m.tail } : { levels };
}

/**
 * The bounds of the contiguous run this split replaces (spec §4.3 step 3): the
 * maximal contiguous sequence of same-column part rows an earlier split
 * produced, PLUS the single whole-column row of that same column immediately
 * after it, which is the run's leaf. Splitting from any row of the run, the leaf
 * included, finds the whole run; any other row is replaced alone. Rows from
 * other sources before or after the run are untouched.
 */
function splitRunBounds(levels: LevelRule[], index: number, column: string): [number, number] {
	const isPart = (i: number): boolean => i >= 0 && i < levels.length && isSplitProduct(levels[i], column);
	const isWhole = (i: number): boolean => i >= 0 && i < levels.length && isWholeColumnRow(levels[i], column);

	let start = index;
	let end = index;
	if (isPart(index)) {
		while (isPart(start - 1)) start--;
		while (isPart(end + 1)) end++;
		// The whole-column row after the part rows is this run's leaf.
		if (isWhole(end + 1)) end++;
	} else if (isWhole(index)) {
		// Splitting from the leaf: the part rows in front of it belong to the same
		// run, so re-splitting from here rebuilds the run rather than appending to it.
		while (isPart(start - 1)) start--;
	}
	return [start, end];
}

/** True when this row looks like one piece of an earlier delimiter-set split. */
function isSplitProduct(rule: LevelRule, column: string): boolean {
	if (rule.delimiters === undefined) return false;
	const refs = toSourceRefs(rule.source);
	if (refs.length !== 1) return false;
	const only = refs[0];
	return !isConstantRef(only) && only.column === column && typeof only.part === 'number';
}

/**
 * True when this row is the untouched column itself (the leaf shape). Carries no
 * `delimiters` requirement: a leaf minted by detection never had one, and one
 * left over from an older mapping does not change what the row addresses.
 */
function isWholeColumnRow(rule: LevelRule, column: string): boolean {
	const refs = toSourceRefs(rule.source);
	if (refs.length !== 1) return false;
	const only = refs[0];
	return !isConstantRef(only) && only.column === column && only.part === undefined;
}

/**
 * `count` level ids of the form `level-N`, none of which collides with a row the
 * split leaves in place. `mergeRows` and `splitRow` do not renumber the mapping,
 * so neither does this; the offset scan is what keeps two rows from sharing an
 * id (layout entries are level-scoped, so a duplicate id is a real defect).
 */
function freeLevelIds(count: number, taken: Set<string>): string[] {
	// One taken id can block up to `count` consecutive offsets, so the scan runs
	// until a free window appears; `taken` is finite, so it always does.
	for (let offset = 0; ; offset++) {
		const ids = Array.from({ length: count }, (_, i) => `level-${i + 1 + offset}`);
		if (ids.every((id) => !taken.has(id))) return ids;
	}
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

/** Whether a level reads one real whole source column. */
function isSingleColumnSource(source: LevelSource): boolean {
	const refs = toSourceRefs(source);
	return refs.length === 1 && !isConstantRef(refs[0]) && refs[0].part === undefined;
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

/** A sensible default destination toggled on over a source. */
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
		case 'crosswalk':
			return { primitive: 'crosswalk', toOntology: null, predicate: 'is_approximate_to' };
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

/** Two destinations collide when they share a kind and (for keyed ones) a key. */
function sameDestination(a: Destination, b: Destination): boolean {
	return a.primitive === b.primitive && destKey(a) === destKey(b);
}

/** Union two destination lists, de-duplicating on destination kind and key. */
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

/**
 * The first real COLUMN a source names, skipping literals. Undefined when the
 * source is nothing but constants, which is a row with nothing to tokenize.
 */
function firstPartColumn(source: LevelSource): string | undefined {
	for (const ref of toSourceRefs(source)) {
		if (!isConstantRef(ref)) return ref.column;
	}
	return undefined;
}

/** The delimiter a set stands in with when no single delimiter was recorded. */
function firstDelimiterOf(delimiters: string | undefined): string | undefined {
	return delimiters !== undefined && delimiters.length > 0 ? delimiters[0] : undefined;
}

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
