/**
 * mapping/instantiate.ts — preset × detection → ImportMapping (spec §3c½).
 *
 * Instantiation is the intentional relationship between the chooser page and the
 * matrix page: a preset is generic policy (quantified rules); a detection supplies
 * the actual levels/facets/links of THIS source; instantiation stamps the preset's
 * rules onto concrete matrix rows. The matrix page IS the instantiated preset,
 * made editable.
 *
 * Guarantee (the defaults law, spec §3a½): the matrix is never empty when any
 * detection exists — accept-all-defaults always produces a usable vault.
 *
 * Detection taxonomy coverage (detection.ts is the source of truth; do not edit
 * it here): packed-hierarchy and level-column-chain → structural mappings; facet
 * → tag mapping; parent-column and multi-value-link → link mappings; a detected
 * crosswalk column → a crosswalk destination. The remaining kinds
 * (title-candidate, row-type-discriminator, edge-file, body-candidate) carry no
 * clean recipe-region projection yet and are skipped
 * (they surface in the UI as flags / route elsewhere) — the defaults law still
 * guarantees a non-empty matrix.
 *
 * Pure module: NO Obsidian imports.
 */

import type { Detection, LayoutProposal, EdgeProposal } from '../detection';
import type { Preset, PresetDestination } from './presets';
import { enrichmentForPreset } from './presets';
import type {
	ImportMapping,
	StructureMapping,
	LevelRule,
	TailRule,
	Destination,
	LevelSource,
	LevelNaming,
} from './types';
import { DEFAULT_MISSING, isConstantRef } from './types';
import { markDetectionBackedLink, parseStructuralTemplate } from './serialize';

/** A detection that would carry structural destinations (folders + a file leaf). */
type StructuralDetection = Extract<Detection, { kind: 'packed-hierarchy' | 'level-column-chain' }>;

/** Does this detection produce a structural mapping (folders/file leaf)? */
function isStructural(d: Detection): d is StructuralDetection {
	return d.kind === 'packed-hierarchy' || d.kind === 'level-column-chain';
}

/**
 * Precedence rank for a structural detection — LOWER wins (spec §7g,
 * single-structural constraint). One recipe = one primary address per row, so
 * EXACTLY ONE mapping may carry structural destinations (folder/file/heading);
 * two structural mappings concatenate into one recipe layout and render() walks
 * them in order, interleaving the paths into garbage
 * (`T1055/T1055.011.md/defense/defense-evasion.md`). When a source freezes its
 * hierarchy in more than one place (separate level columns AND a packed id),
 * instantiate must elect a single structural winner; the losers are DEMOTED (see
 * `instantiate`), not dropped.
 *
 * Ordering rationale (strongest → weakest evidence, per the task precedence):
 *   0. level-column-chain  — explicit, separate columns are the least ambiguous
 *                            signal of an intended hierarchy.
 *   1. packed-hierarchy uniform — a clean, same-depth delimiter across the id.
 *   2. packed-hierarchy ragged  — a mixed-depth delimiter (weakest).
 * Ties break by higher coverage, then by earlier appearance in `detections`
 * (which the detection engine emits in source-column order, deterministically).
 *
 * This ranking is applied ONLY within the set of detections that can own a
 * per-row-unique leaf (see `canOwnUniqueLeaf`) — the §7g eligibility gate. That
 * gate is why NIST-CSF elects its packed id (unique) over its function/category
 * chain (whose deepest column repeats): electing the chain would collapse 25 rows
 * onto 9 notes, which violates "one primary address per row" more severely than
 * the interleave it replaces. See the report for the architect-decision note.
 */
function structuralRank(d: StructuralDetection): number {
	if (d.kind === 'level-column-chain') return 0;
	return d.classification === 'uniform' ? 1 : 2;
}

/** Coverage proxy for the tie-break: packed uses its measured coverage; a chain
 * (never more than one per source, so it never ties) uses its weakest FD agreement. */
function structuralCoverage(d: StructuralDetection): number {
	if (d.kind === 'packed-hierarchy') return d.coverage;
	return d.agreements.length > 0 ? Math.min(...d.agreements) : 1;
}

/**
 * The §7g eligibility gate: can this detection own a PER-ROW-UNIQUE primary
 * address (a distinct leaf note per row)?
 *
 *   - A packed hierarchy's leaf is the whole id column, which cleared detection's
 *     id-distinctness guard (`PACKED_MIN_DISTINCTNESS`) — it can carry a unique
 *     address. Eligible.
 *   - A level-column-chain's leaf is its DEEPEST column, which is low-cardinality
 *     BY CONSTRUCTION (chain candidates require distinctness ≤ 0.5 in detection).
 *     Such a column repeats across rows, so electing the chain as the structural
 *     leaf collapses many rows onto one note (NIST-CSF: `GV.OC-01…05` all land on
 *     `GOVERN/GV.OC/GV.OC.md`). A chain therefore cannot own a unique leaf and is
 *     eligible only as a last resort (a chain-only source with no packed id).
 *
 * This gate is the reconciliation between the task's stated precedence
 * (chain strongest) and §7g's load-bearing invariant (one primary address per
 * row): the precedence orders the ELIGIBLE detections, the gate keeps a chain
 * from silently eating rows when a unique packed id is present.
 */
function canOwnUniqueLeaf(d: StructuralDetection): boolean {
	return d.kind === 'packed-hierarchy';
}

/**
 * Elect the single structural winner (spec §7g). Ranks by `structuralRank`, then
 * coverage, then source order, WITHIN the set of detections that can own a unique
 * leaf (`canOwnUniqueLeaf`); if none qualify, falls back to the same ranking over
 * every structural detection (a chain-only source still gets its hierarchy).
 * Returns undefined when there is no structural detection at all. Replacement is
 * on a STRICT improvement only, so on a full tie the earliest-appearing detection
 * wins (the deterministic source-column-order tiebreak).
 */
function selectStructuralWinner(detections: Detection[]): StructuralDetection | undefined {
	const structural = detections.filter(isStructural);
	if (structural.length === 0) return undefined;
	const eligible = structural.filter(canOwnUniqueLeaf);
	const pool = eligible.length > 0 ? eligible : structural;

	let winner = pool[0];
	let winnerRank = structuralRank(winner);
	let winnerCoverage = structuralCoverage(winner);
	for (const d of pool.slice(1)) {
		const rank = structuralRank(d);
		const coverage = structuralCoverage(d);
		if (rank < winnerRank || (rank === winnerRank && coverage > winnerCoverage)) {
			winner = d;
			winnerRank = rank;
			winnerCoverage = coverage;
		}
	}
	return winner;
}

/**
 * Instantiate a preset over a source's detections. Output order mirrors detection
 * order so the result is deterministic.
 *
 * Single-structural constraint (spec §7g): only ONE structural detection may
 * carry folders + a file leaf. `selectStructuralWinner` elects it; every other
 * structural detection is DEMOTED — it emits no structural mapping here and its
 * column simply remains available to the per-column destination layer (typically
 * a property). Losers are intentionally invisible as structural cards in the
 * workbench, which is the acceptable UI signal for the demotion.
 */
export function instantiate(preset: Preset, detections: Detection[]): ImportMapping {
	const mappings: StructureMapping[] = [];
	const structuralWinner = selectStructuralWinner(detections);

	for (const detection of detections) {
		switch (detection.kind) {
			case 'packed-hierarchy':
				// Demoted losers contribute nothing structural (no folders/files).
				if (detection === structuralWinner) {
					mappings.push(instantiateStructural(preset, detection.proposal, detection.column));
				}
				break;
			case 'level-column-chain':
				if (detection === structuralWinner) {
					mappings.push(
						instantiateStructural(preset, detection.proposal, lastColumn(detection.columns)),
					);
				}
				break;
			case 'facet-candidate': {
				const m = instantiateFacet(preset, detection.column);
				if (m) mappings.push(m);
				break;
			}
			case 'parent-column': {
				const m = instantiateLink(preset, detection.column, detection.proposal, false);
				if (m) mappings.push(m);
				break;
			}
			case 'multi-value-link': {
				// A multi-value link cell holds several ids → a list-valued managed
				// wikilink array (`related: ["[[…]]", …]`), not one scalar link.
				const m = instantiateLink(preset, detection.column, detection.proposal, true);
				if (m) mappings.push(m);
				break;
			}
			case 'crosswalk-column':
				mappings.push(instantiateCrosswalk(detection));
				break;
			case 'title-candidate':
			case 'row-type-discriminator':
			case 'edge-file':
			case 'body-candidate':
				// No clean recipe-region projection yet — skipped (defaults law covers emptiness).
				break;
		}
	}

	// Defaults law: never leave the matrix empty when detections exist.
	if (mappings.length === 0 && detections.length > 0) {
		const column = detectionColumn(detections[0]);
		if (column) mappings.push(fallbackNameMapping(column));
	}

	// Batch enrichment (Pass 1.5): stamp the preset's enrichment defaults onto the
	// mapping when it actually produced structure. An empty matrix (no detections)
	// carries none — there is nothing to enrich. Serializes to recipe
	// target.enrichment via toRecipeRegions.
	const enrichment = enrichmentForPreset(preset.preset);
	return enrichment && mappings.length > 0 ? { mappings, enrichment } : { mappings };
}

// ============================================================================
// Structural (packed hierarchy or level-column chain) → structural mapping
// ============================================================================

/**
 * Build a structural mapping from a LayoutProposal (fixed levels or a variadic
 * tail). `primaryColumn` names the leaf note and, for variadic, the tail source.
 * Each fixed level's own column is recovered from its template so a
 * level-column-chain (distinct column per level) and a packed hierarchy (one
 * column split per level) both work.
 */
function instantiateStructural(
	preset: Preset,
	proposal: LayoutProposal,
	primaryColumn: string,
): StructureMapping {
	const everyLevelDests: PresetDestination[] =
		preset.structural.every_level?.destinations ?? [{ primitive: 'folder' }];

	if (proposal.mechanism === 'fixed-folders') {
		const levels: LevelRule[] = [];
		proposal.templates.forEach((template, i) => {
			const parsed = parseStructuralTemplate(template);
			const levelColumn = firstColumn(parsed.source);
			const rule: LevelRule = {
				level: `level-${i + 1}`,
				source: parsed.source,
				destinations: everyLevelDests.map((d) =>
					mapDestination(d, { column: levelColumn, propertyKey: `level-${i + 1}` }),
				),
				naming: parsed.naming ?? 'part',
				missing: DEFAULT_MISSING,
				materialize: false,
			};
			if (parsed.delimiter !== undefined) rule.delimiter = parsed.delimiter;
			if (parsed.delimiters !== undefined) rule.delimiters = parsed.delimiters;
			if (parsed.filters.length > 0) rule.filters = parsed.filters;
			levels.push(rule);
		});
		levels.push(leafLevel(preset, primaryColumn));
		return { levels };
	}

	// Ragged — variadic tail + leaf.
	const variadic = proposal.variadic;
	const folderDest: PresetDestination = { primitive: 'folder' };
	const tailDests = everyLevelDests.filter((d) => d.primitive === 'folder');
	const tail: TailRule = {
		source: { column: primaryColumn },
		delimiter: variadic.delimiter,
		drop_last: variadic.drop_last,
		destinations: (tailDests.length ? tailDests : [folderDest]).map((d) =>
			mapDestination(d, { column: primaryColumn }),
		),
		naming: variadic.segment === 'part' ? 'part' : 'prefix',
	};
	const presetTail = preset.structural.tail;
	if (presetTail?.max_depth !== undefined) tail.max_depth = presetTail.max_depth;
	if (presetTail?.on_overflow !== undefined) tail.on_overflow = presetTail.on_overflow;
	if (presetTail?.placement !== undefined) tail.placement = presetTail.placement;

	return { levels: [leafLevel(preset, primaryColumn)], tail };
}

/** Build the leaf level (the note that keeps the full packed id). */
function leafLevel(preset: Preset, column: string): LevelRule {
	const leaf = preset.structural.leaf;
	const dests: PresetDestination[] = leaf?.destinations ?? [{ primitive: 'name' }];
	return {
		level: 'leaf',
		source: { column },
		destinations: dests.map((d) => mapDestination(d, { column, propertyKey: column })),
		naming: presetNamingToLevel(leaf?.naming),
		missing: DEFAULT_MISSING,
		materialize: false,
	};
}

// ============================================================================
// Facet → tag mapping; parent-like → link mapping
// ============================================================================

function instantiateFacet(preset: Preset, column: string): StructureMapping | null {
	const dests = preset.facets?.destinations;
	if (!dests || dests.length === 0) return null;
	return {
		levels: [
			{
				level: column,
				source: { column },
				destinations: dests.map((d) => mapDestination(d, { column })),
				naming: 'part',
				missing: DEFAULT_MISSING,
				materialize: false,
			},
		],
	};
}

function instantiateCrosswalk(
	detection: Extract<Detection, { kind: 'crosswalk-column' }>,
): StructureMapping {
	return {
		levels: [
			{
				level: detection.column,
				source: { column: detection.column },
				destinations: [
					{
						primitive: 'crosswalk',
						toOntology: detection.targetOntology,
						predicate: 'is_approximate_to',
					},
				],
				naming: 'part',
				missing: DEFAULT_MISSING,
				materialize: false,
			},
		],
	};
}

function instantiateLink(
	preset: Preset,
	column: string,
	proposal: EdgeProposal,
	list: boolean,
): StructureMapping | null {
	const dests = preset.links?.destinations;
	if (!dests || dests.length === 0) return null;
	return {
		levels: [
			{
				level: column,
				source: { column },
				destinations: dests.map((d) =>
					mapDestination(d, {
						column,
						linkKey: proposal.frontmatterKey,
						predicate: proposal.predicate,
						list,
					}),
				),
				naming: 'part',
				missing: DEFAULT_MISSING,
				materialize: false,
			},
		],
	};
}

/** Guaranteed non-empty fallback — a single name level from a column. */
function fallbackNameMapping(column: string): StructureMapping {
	return {
		levels: [
			{
				level: 'leaf',
				source: { column },
				destinations: [{ primitive: 'name' }],
				naming: 'part',
				missing: DEFAULT_MISSING,
				materialize: false,
			},
		],
	};
}

// ============================================================================
// Preset destination → concrete destination (fills column-bound params)
// ============================================================================

interface DestContext {
	column: string;
	propertyKey?: string;
	linkKey?: string;
	predicate?: string;
	/** True → a list-valued (multi-value) link destination. */
	list?: boolean;
}

/** Fill a preset's generic destination with this source's column-bound params. */
function mapDestination(preset: PresetDestination, ctx: DestContext): Destination {
	switch (preset.primitive) {
		case 'folder':
			return { primitive: 'folder' };
		case 'name':
			return { primitive: 'name' };
		case 'note':
			return { primitive: 'note' };
		case 'alias':
			return { primitive: 'alias' };
		case 'tag': {
			const dest: Destination = { primitive: 'tag', namespace: slug(ctx.column) };
			if (preset.order !== undefined) (dest as { order?: number }).order = preset.order;
			return dest;
		}
		case 'heading':
			return { primitive: 'heading', hostRule: 'root', depth: preset.depth ?? 2 };
		case 'link':
			return markDetectionBackedLink({
				primitive: 'link',
				key: ctx.linkKey ?? 'parent',
				direction: preset.direction ?? 'parent-on-child',
				...(ctx.predicate ? { predicate: ctx.predicate } : {}),
				...(ctx.list ? { list: true } : {}),
			});
		case 'property':
			return { primitive: 'property', key: ctx.propertyKey ?? ctx.column, ...(preset.list ? { list: true } : {}) };
		case 'body':
			return { primitive: 'body', position: preset.position ?? 'section' };
	}
}

/** Map a preset naming policy onto the level model's naming. */
function presetNamingToLevel(naming: string | undefined): LevelNaming {
	// 'joined-full' → the whole packed id (a single whole-column part) = 'part' in the model.
	switch (naming) {
		case 'prefix':
			return 'prefix';
		case 'joined':
			return 'joined';
		default:
			return 'part';
	}
}

// ============================================================================
// Small helpers
// ============================================================================

/** First column (or literal) referenced by a source. */
function firstColumn(source: LevelSource): string {
	const ref = Array.isArray(source) ? source[0] : source;
	return isConstantRef(ref) ? ref.constant : ref.column;
}

/** Last column of a chain (defensive: falls back to the first). */
function lastColumn(columns: string[]): string {
	return columns.length > 0 ? columns[columns.length - 1] : columns[0];
}

/** A representative column for any detection kind (undefined for shapes with none). */
function detectionColumn(detection: Detection): string | undefined {
	switch (detection.kind) {
		case 'packed-hierarchy':
		case 'parent-column':
		case 'facet-candidate':
		case 'title-candidate':
		case 'row-type-discriminator':
		case 'multi-value-link':
		case 'body-candidate':
			return detection.column;
		case 'level-column-chain':
			return detection.columns[detection.columns.length - 1];
		case 'edge-file':
			return detection.subjectColumn;
	}
}

/** Slug a column into a tag namespace (mirrors detection.tagRoot / serialize.slug). */
function slug(column: string): string {
	return column
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}
