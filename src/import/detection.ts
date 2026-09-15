/**
 * detection.ts — the structure-detection engine (shape-first wizard, Step 2a).
 *
 * Pure module: NO Obsidian imports, unit-testable headlessly. Given a parsed
 * source (`ParsedData` + `ColumnInfo[]`), it decodes the *shapes frozen in the
 * source* — a packed id hierarchy, a parent column, a low-cardinality facet, a
 * distinct title column — and returns each as a `Detection` carrying its own
 * receipts (matched sample values, coverage %, depth histogram). Per the
 * 2026-07-05 shape-first-wizard spec §2 and the order-of-information decision
 * spine §4 ("detection is the trust engine"): the system never silently decides
 * structure; it *proposes with evidence*, and the wizard confirms.
 *
 * Every `Detection` carries a `proposal` payload (except `title-candidate`,
 * which is an identity hint, not a structural relation) shaped so the wizard can
 * serialize it straight into a recipe region — folder templates / a `variadic`
 * block / an `also_emit` tag — with no re-derivation. That 1:1 mapping is the
 * parity contract (spec §5).
 *
 * Determinism is a hard constraint (same input → deep-equal output): columns are
 * visited in source order, delimiters in a fixed order, and all ties break by
 * that fixed order.
 */

import type { ParsedData, ColumnInfo } from '../types/config';
import { isTier1Curie } from '../validation/validator';
import { isEagerRows } from '../types/config';
import type { VariadicConfig } from '../render/types';

// ============================================================================
// Public detection types
// ============================================================================

/**
 * Candidate delimiters for a packed id hierarchy, in the fixed evaluation order
 * that also breaks ties. Mirrors the set used by the engine's
 * `deriveIdSplitTemplates` so uniform detection tracks today's behavior exactly.
 */
export const PACKED_DELIMITERS = ['.', '-', '_', '/', ':'] as const;

/** Common list separators for multi-value cells (facet cardinality counting). */
export const LIST_DELIMITERS = [',', ';'] as const;

/**
 * How a confirmed packed-hierarchy detection re-encodes in the vault.
 *
 * `fixed-folders`  — one folder template per delimiter level, matching today's
 *   `deriveIdSplitTemplates` output; serializes to `HierarchyMapping.template`
 *   entries (fixed layout folder levels).
 * `variadic-folders` — a single `variadic` block on a folder entry; serializes
 *   to `layout_entry.variadic` (`VariadicConfig`). This is the ragged case the
 *   current 80% threshold silently flattens — the reason ATT&CK imported flat.
 */
export type LayoutProposal =
	| { mechanism: 'fixed-folders'; templates: string[] }
	| { mechanism: 'variadic-folders'; variadic: VariadicConfig };

/**
 * How a confirmed parent-column detection re-encodes.
 *
 * Interim (v0.1): a managed frontmatter wikilink from each child to its parent
 * note (`frontmatterKey` → `[[<parent>]]`, the --depad pattern). Forward-compat:
 * once the `wikilink` layout mechanism ships (v0.2), `predicate` feeds a
 * `graph_edges` entry (`{ from, via: predicate, to }`). The wizard presents
 * folders-vs-links as a genuine D3 choice; this proposal is the links option.
 */
export interface EdgeProposal {
	/** Column holding parent identifiers (values that reference the id column). */
	parentColumn: string;
	/** Column whose value set the parent identifiers point into. */
	idColumn: string;
	/** Interim serialization: managed frontmatter key holding the parent wikilink. */
	frontmatterKey: string;
	/** Forward-compat `graph_edges` predicate (SKOS broader by default). */
	predicate: string;
}

/**
 * How a confirmed facet detection re-encodes: an `also_emit.tags` template
 * (`#<facet>/<value|tagsafe>`), so every note gains one tag per cell value.
 */
export interface TagProposal {
	/** Source column the facet is drawn from. */
	column: string;
	/**
	 * Template string for `also_emit.tags`. Literal facet namespace + the cell
	 * value through the `tagsafe` filter, e.g. `tactic/{tactic|tagsafe}`.
	 */
	tagTemplate: string;
	/** True when cells hold several values (split on `,`/`;`) → several tags. */
	multiValue: boolean;
}

/**
 * How a confirmed body-candidate re-encodes: the column's cell value becomes the
 * note body (a `BodyMapping` destination). No re-derivation needed — the wizard
 * marks the column as the body source.
 */
export interface BodyProposal {
	/** Destination primitive — always the note body for this detection. */
	destination: 'body';
}

/**
 * A row-type-discriminator carries no auto-recipe yet (spec §7d: "proposal kind
 * only … flag for the UI"). The wizard surfaces the finding and lets the user
 * decide how to split the mixed-level file; the engine does not act on it in
 * v0.1.
 */
export interface DiscriminatorProposal {
	/** Marker: this detection is a UI flag, not a serializable recipe region. */
	mechanism: 'flag-for-ui';
	/** Human-readable note for the wizard card. */
	note: string;
}

/**
 * A single structural finding with its receipts. The discriminant `kind` selects
 * the payload; `proposal` (where present) is directly serializable to a recipe
 * region per the parity contract (spec §5).
 */
export type Detection =
	| {
			kind: 'packed-hierarchy';
			column: string;
			/** Operative delimiter (primary one, for the multi-delimiter uniform case). */
			delimiter: string;
			/** % non-empty sampled values containing the delimiter with content on both sides. */
			coverage: number;
			/** parts-count (after split+filter(Boolean)) → number of sampled values. */
			depthHistogram: Record<number, number>;
			classification: 'uniform' | 'ragged';
			/** Up to 5 matched sample values — the card's receipts. */
			sampleValues: string[];
			proposal: LayoutProposal;
	  }
	| {
			kind: 'parent-column';
			column: string;
			idColumn: string;
			/** % of the column's sampled non-empty values found in the id column's value set. */
			matchRate: number;
			parentIdentityMode: 'raw-curie' | 'source-prefix';
			sampleValues: string[];
			proposal: EdgeProposal;
	  }
	| {
			kind: 'facet-candidate';
			column: string;
			/** Distinct atomic values after splitting multi-value cells. */
			cardinality: number;
			sampleValues: string[];
			proposal: TagProposal;
	  }
	| {
			kind: 'title-candidate';
			column: string;
			/** distinct / non-empty count — closeness to 1 means "one note name per row". */
			distinctness: number;
			sampleValues: string[];
	  }
	| {
			/**
			 * Hierarchy spread across separate columns (function, category,
			 * subcategory) — the CPRT/SCF shape. Ordered parent→child; each column
			 * becomes one fixed folder level. Detected by a functional-dependency
			 * test: a child column's values map n:1 onto its parent's.
			 */
			kind: 'level-column-chain';
			/** Ordered column list, parent (fewest distinct) → child (most distinct). */
			columns: string[];
			/** Per-column distinct-value count (the "fewer→more" evidence). */
			cardinalities: Record<string, number>;
			/** Per consecutive pair (parent[k], child[k+1]): the child→parent FD agreement. */
			agreements: number[];
			/** Up to 5 rendered "parent / … / child" sample paths — the card's receipts. */
			sampleValues: string[];
			/** One fixed folder level per chained column. */
			proposal: LayoutProposal;
	  }
	| {
			/**
			 * One file mixes hierarchy levels as rows (CPRT does this): a
			 * low-cardinality column whose values name levels AND correlate with
			 * distinct column-fill patterns. Proposal is a UI flag only (spec §7d).
			 */
			kind: 'row-type-discriminator';
			column: string;
			/** Per discriminator value: its row count + which other columns it fills. */
			values: { value: string; rowCount: number; filledColumns: string[] }[];
			/** Max pairwise Jaccard distance between the per-value fill-sets (≥ 0.3 to fire). */
			maxJaccardDistance: number;
			/** Up to 5 discriminator values — the card's receipts. */
			sampleValues: string[];
			proposal: DiscriminatorProposal;
	  }
	| {
			/**
			 * File-level classification: the FILE is relationships, not concepts
			 * (SSSOM/crosswalks). ≥2 id-like columns + optional predicate column,
			 * no strong concept title. Routes to the crosswalk import path later.
			 */
			kind: 'edge-file';
			subjectColumn: string;
			/** Fraction of the subject column's values that match the id pattern. */
			subjectConfidence: number;
			objectColumn: string;
			/** Fraction of the object column's values that match the id pattern. */
			objectConfidence: number;
			predicateColumn?: string;
			/** Fraction of the predicate column's values that match the predicate shape. */
			predicateConfidence?: number;
			/** Up to 5 "subject | predicate | object" sample tuples — the card's receipts. */
			sampleValues: string[];
	  }
	| {
			/**
			 * A column whose cells, after list-splitting, hold several ids from
			 * another column's set (`related: T1055, T1548`). Proposes multiple
			 * edges per row — distinct from the single-value parent-column.
			 */
			kind: 'multi-value-link';
			column: string;
			idColumn: string;
			/** Fraction of exploded (list-split) values found in the id column's set. */
			matchRate: number;
			/** Mean number of list-split values per non-empty cell (> 1 to fire). */
			avgValuesPerCell: number;
			sampleValues: string[];
			proposal: EdgeProposal;
	  }
	| {
			/**
			 * A long-text column → the note body. Fires on average length or on a
			 * medium length with sentence punctuation, plus high distinctness.
			 */
			kind: 'body-candidate';
			column: string;
			/** Mean character length over the column's non-empty values. */
			avgLength: number;
			/** distinct / non-empty count. */
			distinctness: number;
			/** Up to 5 (truncated) sample values — the card's receipts. */
			sampleValues: string[];
			proposal: BodyProposal;
	  };

// ============================================================================
// Thresholds (spec §2 — every one is pinned by a test in detection.test.ts)
// ============================================================================

/** Max non-empty values sampled per column for packed-hierarchy analysis. */
const HIERARCHY_SAMPLE_LIMIT = 500;
/**
 * Prose guard: taxonomy ids do not contain spaces. If more than this fraction
 * of sampled values contains internal whitespace, the column is text (a title,
 * a description), and its periods/colons are punctuation, not level delimiters.
 * Without this guard a description column's sentences read as a ragged
 * hierarchy and the preview grows folders named with full sentences (found via
 * E2E screenshot 2026-07-06). Columns like CSF's packed "DE.AE-01: Adverse
 * events are analyzed" are also excluded by design: extract-the-leading-token
 * detection is a future refinement; a false folder tree is worse than a missed
 * proposal (the user can still add the mapping manually).
 */
const PACKED_MAX_WHITESPACE_FRACTION = 0.2;
/**
 * Id guard: taxonomy ids are (near-)unique per row. A low-cardinality column
 * (a facet like "defense-evasion" repeated across rows) must never read as a
 * packed hierarchy just because its values contain hyphens; without this guard
 * the facet's pieces became folder levels concatenated onto the real
 * hierarchy's paths (found via the workbench path regression test).
 */
const PACKED_MIN_DISTINCTNESS = 0.5;
/** Max values sampled per column when computing a parent match rate. */
const PARENT_SAMPLE_LIMIT = 500;
/** Delimiter coverage below this → no packed-hierarchy signal at all. */
const COVERAGE_FLOOR = 0.2;
/** Coverage at/above this (with a dominant part-count) → uniform, not ragged. */
const COVERAGE_UNIFORM = 0.8;
/** Fraction of covered rows that must share one part-count for `uniform`. */
const UNIFORM_DEPTH_AGREEMENT = 0.9;
/** Parent-column match rate at/above this → a parent-column detection. */
const PARENT_MATCH_MIN = 0.6;
/** A column counts as "id-like" (identity/reference target) at/above this distinctness. */
const ID_DISTINCTNESS_MIN = 0.9;
/** A column counts as a title candidate at/above this distinctness. */
const TITLE_DISTINCTNESS_MIN = 0.9;
/** Fraction of values that must be non-numeric for a title candidate. */
const TITLE_NONNUMERIC_MIN = 0.5;
/** Facet cardinality cap floor (spec: max(20, rows × 0.05)). */
const FACET_CARDINALITY_FLOOR = 20;
const FACET_CARDINALITY_RATIO = 0.05;
/** Number of receipt sample values surfaced per detection. */
const SAMPLE_VALUES = 5;

// --- level-column-chain (spec §7d) ---
/** Max aligned rows materialized for functional-dependency + fill-pattern tests. */
const ROW_SAMPLE_LIMIT = 500;
/**
 * A column is a level-chain candidate only if its distinctness is at or below
 * this — a hierarchy level *repeats* (function/category values recur across many
 * rows). Near-unique columns (ids, titles, bodies) are excluded here.
 */
const LEVEL_CANDIDATE_MAX_DISTINCTNESS = 0.5;
/**
 * Functional-dependency agreement floor: the fraction of sampled rows whose
 * child value maps to its dominant parent value. ≥ 0.95 tolerates dirt while
 * still demanding a genuine n:1 child→parent dependency.
 */
const FD_AGREEMENT = 0.95;

// --- row-type-discriminator (spec §7d) ---
/** A discriminator column has at most this many distinct level-naming values. */
const DISCRIMINATOR_MAX_CARDINALITY = 8;
/**
 * A discriminator's values must each recur (a level *type* labels many rows):
 * cardinality must be at or below rows × this ratio, so per-value groups average
 * ≥ 2 rows and single-row-per-value id columns are excluded.
 */
const DISCRIMINATOR_MAX_CARD_RATIO = 0.5;
/** Fraction of a value's rows in which a column must be non-empty to count as "filled". */
const DISCRIMINATOR_FILL_MIN = 0.5;
/** Fraction of a candidate's values that must be non-numeric to "look like level names". */
const DISCRIMINATOR_NONNUMERIC_MIN = 0.8;
/**
 * Max pairwise Jaccard distance between per-value fill-sets must reach this for
 * the fill patterns to count as "materially different" (spec §7d).
 */
const DISCRIMINATOR_JACCARD_MIN = 0.3;

// --- edge-file (spec §7d) ---
/** Fraction of a column's values that must match the id pattern to be "id-like". */
const EDGE_ID_PATTERN_MIN = 0.8;
/** Fraction of a candidate predicate column's values that must match the predicate shape. */
const EDGE_PREDICATE_SHAPE_MIN = 0.6;
/** A predicate column holds at most this many distinct values. */
const EDGE_PREDICATE_MAX_CARDINALITY = 8;
/**
 * If any column is a near-unique, non-numeric label at least this long on
 * average, the file reads as *concept-shaped* (rows are concepts with names),
 * which suppresses the edge-file (relationships) classification.
 */
const CONCEPT_TITLE_MIN_AVG_LEN = 25;

// --- multi-value-link (spec §7d) ---
/** Fraction of exploded (list-split) values that must hit the id set. */
const MULTI_LINK_MATCH_MIN = 0.6;
/** Mean list-split values per non-empty cell must exceed this (distinguishes from single-value parent). */
const MULTI_LINK_AVG_MIN = 1;

// --- body-candidate (spec §7d) ---
/** Average length at/above which a column is a body candidate outright. */
const BODY_AVG_LONG = 200;
/** Average length at/above which a column is a body candidate *if* it also reads as prose. */
const BODY_AVG_MEDIUM = 80;
/** Fraction of samples that must contain sentence punctuation for the medium-length branch. */
const BODY_PUNCT_MIN = 0.6;
/** Body text is mostly one-per-row; require at least this distinctness. */
const BODY_DISTINCTNESS_MIN = 0.7;
/** Max characters of a body value surfaced as a receipt (longer values are truncated). */
const BODY_SAMPLE_MAXLEN = 160;

// ============================================================================
// Entry point
// ============================================================================

/**
 * Detect the structural shapes frozen in a parsed source.
 *
 * Operates on eager rows (the wizard's preview/sample path). Streaming sources
 * (`AsyncIterable` rows) can't be scanned synchronously, so this falls back to
 * the sample values already carried on `ColumnInfo`; detection is then
 * best-effort on that small sample. Full-fidelity detection assumes an eager
 * `ParsedData` — which is what the wizard hands over at Step 2a.
 *
 * Output order is deterministic: packed-hierarchy, level-column-chain,
 * edge-file, parent-column, multi-value-link, row-type-discriminator, facet,
 * body-candidate, title-candidate — each pass visiting columns in source order.
 */
export function detectStructure(data: ParsedData, columns: ColumnInfo[]): Detection[] {
	const columnInfo = new Map(columns.map((c) => [c.name, c]));
	// Materialize normalized non-empty values per column once — every detector
	// reads from this map so the source is scanned a single time.
	const valuesByColumn = collectColumnValues(data, columns);
	// Aligned, normalized sample rows (empties preserved) for the cross-column
	// detectors (chain FD, discriminator fill-patterns, edge tuples). Null when
	// the source is streaming — those detectors then no-op (spec §2: full-fidelity
	// detection assumes the eager ParsedData the wizard hands over at Step 2a).
	const sampleRows = collectSampleRows(data);

	// Distinctness + raw cardinality per column drive id-likeness / level / facet.
	const distinctnessByColumn = new Map<string, number>();
	const cardinalityByColumn = new Map<string, number>();
	for (const col of data.columns) {
		const values = valuesByColumn.get(col) ?? [];
		const card = new Set(values).size;
		cardinalityByColumn.set(col, card);
		distinctnessByColumn.set(col, values.length === 0 ? 0 : card / values.length);
	}

	// id-like columns: mostly-unique value sets. Used as parent-column reference
	// sets and to exclude id columns from facet/title proposals.
	const idColumns = data.columns.filter((c) => (distinctnessByColumn.get(c) ?? 0) >= ID_DISTINCTNESS_MIN);
	const idColumnSet = new Set(idColumns);

	const rowCount = countRows(data, valuesByColumn);

	// --- Pass 1: packed-hierarchy (one detection per column, at most) ---
	const packedByColumn = new Map<string, Detection>();
	for (const col of data.columns) {
		const detection = detectPackedHierarchy(col, valuesByColumn.get(col) ?? []);
		if (detection) packedByColumn.set(col, detection);
	}

	// --- Pass 2: level-column-chain (functional-dependency chain across columns) ---
	// The single longest chain, if any. Its columns are "claimed" — excluded from
	// facet/title candidacy below so a folder level isn't also proposed as a tag.
	const chain = detectLevelColumnChain(data.columns, sampleRows, valuesByColumn, distinctnessByColumn, cardinalityByColumn);
	const chainColumns = new Set<string>(chain ? chain.columns : []);

	// --- Pass 3: parent-column (child column ⊆ an id column's value set) ---
	const parents: Extract<Detection, { kind: 'parent-column' }>[] = [];
	const parentColumns = new Set<string>();
	for (const child of data.columns) {
		if (idColumnSet.size === 0) break;
		for (const idCol of idColumns) {
			if (child === idCol) continue;
			const detection = detectParentColumn(
				child,
				idCol,
				valuesByColumn.get(child) ?? [],
				valuesByColumn.get(idCol) ?? [],
			);
			if (detection) {
				parents.push(detection);
				parentColumns.add(child);
				// One parent target is enough — a child references a single id scheme.
				break;
			}
		}
	}

	// --- Pass 4: edge-file (file-level classification: relationships, not concepts) ---
	// Needs the parent detections (to tell a self-referential hierarchy from a
	// crosswalk) and the average-length map (to spot a concept title).
	const avgLengthByColumn = new Map<string, number>();
	for (const col of data.columns) avgLengthByColumn.set(col, averageLength(valuesByColumn.get(col) ?? []));
	const edgeFile = detectEdgeFile(
		data.columns,
		valuesByColumn,
		sampleRows,
		distinctnessByColumn,
		cardinalityByColumn,
		avgLengthByColumn,
		parents,
	);
	// Suppression: an edge-file classification claims its subject/object id
	// columns; a crosswalk file's subject ids must NOT propose folder nesting, so
	// drop any packed-hierarchy proposals on the claimed id columns (spec §7d).
	if (edgeFile) {
		packedByColumn.delete(edgeFile.subjectColumn);
		packedByColumn.delete(edgeFile.objectColumn);
	}
	const packed = data.columns.map((c) => packedByColumn.get(c)).filter((d): d is Detection => d !== undefined);
	const packedColumns = new Set(packedByColumn.keys());

	// --- Pass 5: multi-value-link (list-split cells hit another column's id set) ---
	const multiLinks: Detection[] = [];
	for (const col of data.columns) {
		if (idColumnSet.size === 0) break;
		for (const idCol of idColumns) {
			if (col === idCol) continue;
			const detection = detectMultiValueLink(col, idCol, valuesByColumn.get(col) ?? [], valuesByColumn.get(idCol) ?? []);
			if (detection) {
				multiLinks.push(detection);
				break; // one id scheme per column
			}
		}
	}

	// --- Pass 6: row-type-discriminator (mixed-level file — UI flag only) ---
	const discriminators = detectRowTypeDiscriminators(data.columns, sampleRows, distinctnessByColumn, cardinalityByColumn, rowCount);

	// --- Pass 7: facet-candidate (low cardinality, not id/title/parent/chain) ---
	const facets: Detection[] = [];
	for (const col of data.columns) {
		// Suppression: chain columns are claimed folder levels, not facets (spec §7d).
		if (idColumnSet.has(col) || packedColumns.has(col) || parentColumns.has(col) || chainColumns.has(col)) continue;
		const detection = detectFacet(col, valuesByColumn.get(col) ?? [], rowCount);
		if (detection) facets.push(detection);
	}

	// --- Pass 8: body-candidate (long-text columns → body destination) ---
	const bodies: Detection[] = [];
	for (const col of data.columns) {
		const detection = detectBody(col, valuesByColumn.get(col) ?? [], distinctnessByColumn.get(col) ?? 0, avgLengthByColumn.get(col) ?? 0);
		if (detection) bodies.push(detection);
	}

	// --- Pass 9: title-candidate (high distinctness, non-numeric, not id/chain) ---
	const titles: Detection[] = [];
	for (const col of data.columns) {
		if (packedColumns.has(col)) continue; // packed id columns are identity, not title
		// Suppression: chain columns are claimed folder levels, not titles (spec §7d).
		if (chainColumns.has(col)) continue;
		const detection = detectTitle(col, valuesByColumn.get(col) ?? [], distinctnessByColumn.get(col) ?? 0, columnInfo.get(col));
		if (detection) titles.push(detection);
	}

	return [
		...packed,
		...(chain ? [chain] : []),
		...(edgeFile ? [edgeFile] : []),
		...parents,
		...multiLinks,
		...discriminators,
		...facets,
		...bodies,
		...titles,
	];
}

// ============================================================================
// Per-column default destination (spec §7k item 2)
// ============================================================================

/**
 * The default destination for a non-structural column, given the source's
 * structural detections. A body-candidate column (long prose — a control's
 * description, a technique's detail) defaults to the note BODY so the generated
 * note reads as a document, not a stub with its prose stuffed into a property.
 * Every other column defaults to a frontmatter PROPERTY.
 *
 * Pure + deterministic. Only 'body' and 'property' are returned; tag / title /
 * alias / link stay explicit user choices, never silent defaults. Wire this
 * into the workbench's per-column seed in one line (see the seedColumnDests
 * default `'property'`).
 */
export function defaultDestinationForColumn(
	columnName: string,
	detections: Detection[],
): 'body' | 'property' {
	for (const d of detections) {
		if (d.kind === 'body-candidate' && d.column === columnName) return 'body';
	}
	return 'property';
}

// ============================================================================
// Packed-hierarchy detection
// ============================================================================

/**
 * Per-delimiter measurements over a column's sampled values.
 */
interface DelimiterStats {
	delimiter: string;
	/** % of values with the delimiter present and content on both sides. */
	coverage: number;
	/** parts-count → count, over ALL sampled values (uncovered rows contribute their 1 part). */
	histogram: Record<number, number>;
	/** Among covered rows only, the fraction sharing the most common part-count. */
	modeFraction: number;
	classification: 'uniform' | 'ragged' | 'none';
}

/**
 * Classify a column's id structure and, when present, return the packed-hierarchy
 * detection with a directly-serializable layout proposal.
 *
 * Uniform (a clean, same-depth delimiter across ≥80% of rows) reuses the exact
 * `deriveIdSplitTemplates` semantics — mirrored here as `deriveFixedSplitTemplates`
 * to keep this module Obsidian-free; a parity test pins the two outputs equal.
 * Ragged (the 20–79% coverage case, or ≥80% coverage with mixed depths) proposes
 * a `variadic` block instead of silently flattening.
 */
function detectPackedHierarchy(column: string, allValues: string[]): Detection | null {
	const sample = allValues.slice(0, HIERARCHY_SAMPLE_LIMIT);
	if (sample.length === 0) return null;

	// Prose guard — see PACKED_MAX_WHITESPACE_FRACTION.
	const withWhitespace = sample.filter((v) => /\s/.test(v)).length;
	if (withWhitespace / sample.length > PACKED_MAX_WHITESPACE_FRACTION) return null;

	// Id guard — see PACKED_MIN_DISTINCTNESS.
	const distinct = new Set(sample).size;
	if (distinct / sample.length < PACKED_MIN_DISTINCTNESS) return null;

	const stats = PACKED_DELIMITERS.map((d) => analyzeDelimiter(sample, d));
	const uniform = stats.filter((s) => s.classification === 'uniform');

	if (uniform.length >= 1) {
		// Fixed levels — delegate to the mirrored engine semantics so multi-delimiter
		// ordering (CSF `.` then `-`) matches today's recipe exactly.
		const templates = deriveFixedSplitTemplates(column, sample);
		const fixed = templates.length > 0 ? templates : uniform.map((u) => `{${column}|split(${u.delimiter},0)}`);
		// Primary delimiter = the first fixed level's delimiter (first by rep position);
		// a set template `prefix(D,0)` contributes the first char of its set.
		const primaryDelim =
			parseSplitDelimiter(fixed[0]) ?? firstCharOf(parseSetDelimiters(fixed[0])) ?? uniform[0].delimiter;
		const primaryStats = stats.find((s) => s.delimiter === primaryDelim) ?? uniform[0];
		return {
			kind: 'packed-hierarchy',
			column,
			delimiter: primaryDelim,
			coverage: round(primaryStats.coverage),
			depthHistogram: primaryStats.histogram,
			classification: 'uniform',
			sampleValues: sample.slice(0, SAMPLE_VALUES),
			proposal: { mechanism: 'fixed-folders', templates: fixed },
		};
	}

	// No uniform delimiter — take the strongest ragged signal, if any.
	const ragged = stats.filter((s) => s.classification === 'ragged');
	if (ragged.length === 0) return null;
	// Highest coverage wins; PACKED_DELIMITERS order breaks ties (stable sort input).
	const best = ragged.reduce((a, b) => (b.coverage > a.coverage ? b : a));
	const variadic: VariadicConfig = { delimiter: best.delimiter, segment: 'prefix', drop_last: true };
	return {
		kind: 'packed-hierarchy',
		column,
		delimiter: best.delimiter,
		coverage: round(best.coverage),
		depthHistogram: best.histogram,
		classification: 'ragged',
		sampleValues: sample.slice(0, SAMPLE_VALUES),
		proposal: { mechanism: 'variadic-folders', variadic },
	};
}

/**
 * Measure one delimiter over a sample. "Covered" means the delimiter appears
 * with content on both sides (index in `(0, len-1)`), matching the engine's
 * qualifying test. Part-count is `split(d).filter(Boolean).length` — empty
 * pieces (e.g. `A..B`) don't inflate depth, consistent with render's folder
 * mechanism which drops empty segments.
 */
function analyzeDelimiter(values: string[], delimiter: string): DelimiterStats {
	let covered = 0;
	const histogram: Record<number, number> = {};
	const coveredParts: Record<number, number> = {};
	for (const v of values) {
		const i = v.indexOf(delimiter);
		const isCovered = i > 0 && i < v.length - 1;
		if (isCovered) covered++;
		const parts = v.split(delimiter).filter(Boolean).length;
		histogram[parts] = (histogram[parts] ?? 0) + 1;
		if (isCovered) coveredParts[parts] = (coveredParts[parts] ?? 0) + 1;
	}
	const coverage = values.length === 0 ? 0 : covered / values.length;
	let modeFraction = 0;
	if (covered > 0) {
		const max = Math.max(...Object.values(coveredParts));
		modeFraction = max / covered;
	}
	let classification: DelimiterStats['classification'];
	if (coverage < COVERAGE_FLOOR) {
		classification = 'none';
	} else if (coverage >= COVERAGE_UNIFORM && modeFraction >= UNIFORM_DEPTH_AGREEMENT) {
		classification = 'uniform';
	} else {
		classification = 'ragged';
	}
	return { delimiter, coverage, histogram, modeFraction, classification };
}

/**
 * Fixed-layout template inference for a packed id column.
 *
 * Single qualifying delimiter: a byte-identical mirror of
 * `deriveIdSplitTemplates` (generation-engine.ts) — `split(d,0)` per level.
 * Two or more: the spec §3 upgrade — a uniform depth over the delimiter SET
 * proposes `prefix(D,i)` cumulative-prefix levels (the engine still emits
 * `split()` per delimiter there, so the old parity assertions hold only for
 * the single-delimiter case). Kept private so this module stays free of the
 * Obsidian-importing engine; the single-delimiter output is pinned equal to
 * `deriveIdSplitTemplates` by parity assertions in tests/detection.test.ts.
 */
function deriveFixedSplitTemplates(column: string, values: string[]): string[] {
	const samples = values.map((v) => String(v ?? '').trim()).filter(Boolean).slice(0, 200);
	if (samples.length === 0) return [];

	const threshold = Math.max(1, Math.floor(samples.length * 0.8));
	const qualifying = (PACKED_DELIMITERS as readonly string[]).filter((d) => {
		let hits = 0;
		for (const s of samples) {
			const i = s.indexOf(d);
			if (i > 0 && i < s.length - 1) hits++;
		}
		return hits >= threshold;
	});
	if (qualifying.length === 0) return [];

	// Order delimiters by their first position in a representative (longest) value,
	// for display only — the part/prefix filters are order-free over the set.
	const rep = samples.reduce((a, b) => (b.length > a.length ? b : a), samples[0]);
	const ordered = qualifying
		.map((d) => ({ d, pos: rep.indexOf(d) }))
		.filter((x) => x.pos >= 0)
		.sort((a, b) => a.pos - b.pos)
		.map((x) => x.d);
	if (ordered.length === 0) return [];

	// Two or more qualifying delimiters: propose cumulative-prefix levels over the
	// SET (spec §3). Depth = piece count when every sample is tokenized on the set
	// (empty pieces dropped, matching the render filter). Uniform depth → fixed
	// `prefix(D,i)` levels with the untouched column as the leaf; ragged depth →
	// fall back to the single-delimiter behaviour until `variadic.delimiters`
	// exists (spec §8).
	if (ordered.length >= 2) {
		const set = ordered.join('');
		const depths = samples.map((s) => splitOnSet(s, set).length);
		const counts = new Map<number, number>();
		for (const d of depths) counts.set(d, (counts.get(d) ?? 0) + 1);
		let modalDepth = 0;
		let modalCount = 0;
		for (const [depth, count] of counts) {
			if (count > modalCount) {
				modalDepth = depth;
				modalCount = count;
			}
		}
		const modalShare = modalCount / samples.length;
		if (modalShare >= UNIFORM_DEPTH_AGREEMENT) {
			return Array.from({ length: modalDepth - 1 }, (_, i) => `{${column}|prefix(${set},${i})}`);
		}
		return ordered.map((d) => `{${column}|split(${d},0)}`);
	}

	return ordered.map((d) => `{${column}|split(${d},0)}`);
}

/**
 * Tokenize a value on a delimiter SET: split on any single character of `set`
 * and drop empty pieces (identical semantics to the `part` template filter, so
 * a preview built on this helper matches what generation renders). Exported for
 * the workbench "Split into levels" panel; `splitOnSet` below delegates here.
 */
export function splitOnDelimiterSet(value: string, set: string): string[] {
	return value.split(new RegExp(`[${escapeCharClass(set)}]`)).filter(Boolean);
}

/** Tokenize on a delimiter set: split on any single char of the set, dropping empty pieces. */
function splitOnSet(value: string, set: string): string[] {
	return splitOnDelimiterSet(value, set);
}

/** Escape every character of `set` for use inside a regex character class. */
function escapeCharClass(set: string): string {
	return set.replace(/[-\\\]\^]/g, '\\$&');
}

/** Pull the delimiter `X` out of a `{col|split(X,0)}` template, or null. */
function parseSplitDelimiter(template: string): string | null {
	const m = /\|split\((.),0\)\}$/.exec(template);
	return m ? m[1] : null;
}

/**
 * Pull the delimiter set `D` out of a `{col|prefix(D,0)}` (or `part(D,0)`)
 * template, or null. `D` is a raw string of single-character delimiters; any
 * one of them separates parts.
 */
export function parseSetDelimiters(template: string): string | null {
	const m = /\|(?:prefix|part)\(([^,()]+),0\)\}$/.exec(template);
	return m ? m[1] : null;
}

/** First character of a set string, or undefined when empty. */
function firstCharOf(set: string | null): string | undefined {
	return set && set.length > 0 ? set[0] : undefined;
}

// ============================================================================
// Parent-column detection
// ============================================================================

/**
 * A parent column holds other rows' ids (SKOS broader). Match rate = the fraction
 * of the child's sampled non-empty values found in the id column's full value
 * set. The id column must be mostly-unique (checked by the caller) so the set is
 * a genuine identity space, not a low-cardinality attribute.
 */
function detectParentColumn(
	childColumn: string,
	idColumn: string,
	childValues: string[],
	idValues: string[],
): Extract<Detection, { kind: 'parent-column' }> | null {
	if (childValues.length === 0 || idValues.length === 0) return null;
	const idSet = new Set(idValues);
	const sample = childValues.slice(0, PARENT_SAMPLE_LIMIT);
	let hits = 0;
	for (const v of sample) if (idSet.has(v)) hits++;
	const matchRate = hits / sample.length;
	if (matchRate < PARENT_MATCH_MIN) return null;
	const parentIdentityMode = sample.every(isTier1Curie) ? 'raw-curie' : 'source-prefix';
	return {
		kind: 'parent-column',
		column: childColumn,
		idColumn,
		matchRate: round(matchRate),
		parentIdentityMode,
		sampleValues: sample.slice(0, SAMPLE_VALUES),
		proposal: {
			parentColumn: childColumn,
			idColumn,
			frontmatterKey: 'parent',
			predicate: 'skos:broader',
		},
	};
}

// ============================================================================
// Facet-candidate detection
// ============================================================================

/**
 * A facet is a low-cardinality attribute — few distinct values across many rows —
 * that belongs in `also_emit.tags` (post-coordinated classification). Multi-value
 * cells (`a, b`) are split on list delimiters before counting, so a "Tactics"
 * column reads as its handful of tactics, not as hundreds of distinct cell
 * strings.
 */
function detectFacet(column: string, values: string[], rowCount: number): Detection | null {
	if (values.length === 0) return null;
	const atoms = new Set<string>();
	let multiValue = false;
	for (const v of values) {
		const pieces = splitMultiValue(v);
		if (pieces.length > 1) multiValue = true;
		for (const p of pieces) if (p) atoms.add(p);
	}
	const cardinality = atoms.size;
	const cap = Math.max(FACET_CARDINALITY_FLOOR, Math.floor(rowCount * FACET_CARDINALITY_RATIO));
	// Need at least two distinct values (a single-value column isn't a useful
	// facet) and cardinality within the cap.
	if (cardinality < 2 || cardinality > cap) return null;
	return {
		kind: 'facet-candidate',
		column,
		cardinality,
		sampleValues: values.slice(0, SAMPLE_VALUES),
		proposal: {
			column,
			tagTemplate: `${tagRoot(column)}/{${column}|tagsafe}`,
			multiValue,
		},
	};
}

/** Split a cell on common list delimiters (`,` `;`), trimming pieces. */
function splitMultiValue(value: string): string[] {
	let pieces = [value];
	for (const d of LIST_DELIMITERS) {
		pieces = pieces.flatMap((p) => p.split(d));
	}
	return pieces.map((p) => p.trim()).filter((p) => p !== '');
}

/** Deterministic tag-namespace slug for a column name (literal segment root). */
function tagRoot(column: string): string {
	return column
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

// ============================================================================
// Title-candidate detection
// ============================================================================

/**
 * A title candidate is a near-unique, mostly-non-numeric column — one distinct
 * human-readable name per row — that could name notes. Packed id columns are
 * excluded by the caller (they're identity, not title).
 */
function detectTitle(
	column: string,
	values: string[],
	distinctness: number,
	info: ColumnInfo | undefined,
): Detection | null {
	if (values.length === 0) return null;
	if (distinctness < TITLE_DISTINCTNESS_MIN) return null;
	// A numeric column (or one the parser already typed numeric) is an id/measure,
	// not a title.
	if (info?.detectedType === 'number') return null;
	const numericCount = values.reduce((n, v) => (isNumeric(v) ? n + 1 : n), 0);
	const nonNumericFraction = 1 - numericCount / values.length;
	if (nonNumericFraction < TITLE_NONNUMERIC_MIN) return null;
	return {
		kind: 'title-candidate',
		column,
		distinctness: round(distinctness),
		sampleValues: values.slice(0, SAMPLE_VALUES),
	};
}

// ============================================================================
// Level-column-chain detection (spec §7d)
// ============================================================================

/**
 * Detect a hierarchy spread across separate columns (function, category,
 * subcategory) — the CPRT/SCF shape. A parent column has fewer distinct values
 * than its child, and the child's values map n:1 onto the parent's (functional
 * dependency). We chain qualifying pairs into the single longest ordered path
 * (fewer distinct → more distinct) and emit one detection with a fixed folder
 * level per column.
 *
 * Row-alignment is required (which value co-occurs with which), so this reads
 * `sampleRows`; on a streaming source (`sampleRows === null`) it no-ops.
 */
function detectLevelColumnChain(
	columns: string[],
	sampleRows: Record<string, string>[] | null,
	valuesByColumn: Map<string, string[]>,
	distinctnessByColumn: Map<string, number>,
	cardinalityByColumn: Map<string, number>,
): Extract<Detection, { kind: 'level-column-chain' }> | null {
	if (!sampleRows || sampleRows.length === 0) return null;

	// Candidate level columns: low-ish cardinality (values repeat), not near-unique.
	const candidates = columns.filter((c) => {
		const card = cardinalityByColumn.get(c) ?? 0;
		const distinct = distinctnessByColumn.get(c) ?? 0;
		return card >= 2 && (valuesByColumn.get(c)?.length ?? 0) > 0 && distinct <= LEVEL_CANDIDATE_MAX_DISTINCTNESS;
	});
	if (candidates.length < 2) return null;

	// Order by cardinality ascending; source order breaks ties. Edges run strictly
	// from lower-cardinality (parent) to higher-cardinality (child), so this is a
	// DAG in list order and the longest path is a simple DP.
	const sourceIndex = new Map(columns.map((c, i) => [c, i]));
	const sorted = [...candidates].sort((a, b) => {
		const d = (cardinalityByColumn.get(a) ?? 0) - (cardinalityByColumn.get(b) ?? 0);
		return d !== 0 ? d : (sourceIndex.get(a) ?? 0) - (sourceIndex.get(b) ?? 0);
	});

	const n = sorted.length;
	// dp[j] = length of the longest chain ending at sorted[j] as the child (deepest).
	const dp = new Array<number>(n).fill(1);
	const prev = new Array<number>(n).fill(-1);
	// Cache pairwise FD agreement so we only compute each once.
	const agreementCache = new Map<string, number>();
	const fd = (child: string, parent: string): number => {
		const key = `${child}\u0000${parent}`;
		let a = agreementCache.get(key);
		if (a === undefined) {
			a = functionalDependencyAgreement(sampleRows, child, parent);
			agreementCache.set(key, a);
		}
		return a;
	};

	for (let j = 0; j < n; j++) {
		for (let i = 0; i < j; i++) {
			const parentCard = cardinalityByColumn.get(sorted[i]) ?? 0;
			const childCard = cardinalityByColumn.get(sorted[j]) ?? 0;
			if (parentCard >= childCard) continue; // need strictly fewer→more
			if (fd(sorted[j], sorted[i]) < FD_AGREEMENT) continue;
			if (dp[i] + 1 > dp[j]) {
				dp[j] = dp[i] + 1;
				prev[j] = i;
			}
		}
	}

	// Pick the longest chain; earliest end index breaks ties (determinism).
	let best = 0;
	for (let j = 1; j < n; j++) if (dp[j] > dp[best]) best = j;
	if (dp[best] < 2) return null;

	// Reconstruct parent→child.
	const path: number[] = [];
	for (let k = best; k !== -1; k = prev[k]) path.push(k);
	path.reverse();
	const chainCols = path.map((k) => sorted[k]);

	const cardinalities: Record<string, number> = {};
	for (const c of chainCols) cardinalities[c] = cardinalityByColumn.get(c) ?? 0;
	const agreements: number[] = [];
	for (let k = 0; k + 1 < chainCols.length; k++) {
		agreements.push(round(fd(chainCols[k + 1], chainCols[k])));
	}

	// Receipts: up to 5 rendered "parent / … / child" sample paths (rows where the
	// whole chain is present).
	const sampleValues: string[] = [];
	for (const row of sampleRows) {
		if (chainCols.every((c) => row[c] !== '')) {
			const path2 = chainCols.map((c) => row[c]).join(' / ');
			if (!sampleValues.includes(path2)) sampleValues.push(path2);
			if (sampleValues.length >= SAMPLE_VALUES) break;
		}
	}

	return {
		kind: 'level-column-chain',
		columns: chainCols,
		cardinalities,
		agreements,
		sampleValues,
		proposal: { mechanism: 'fixed-folders', templates: chainCols.map((c) => `{${c}}`) },
	};
}

/**
 * Functional-dependency agreement of `childColumn → parentColumn`: over aligned
 * rows where both are non-empty, group by the child value, take each group's
 * dominant (most common) parent value, and return the fraction of rows that
 * match their group's dominant parent. 1.0 = a clean n:1 dependency.
 */
function functionalDependencyAgreement(
	rows: Record<string, string>[],
	childColumn: string,
	parentColumn: string,
): number {
	const byChild = new Map<string, Map<string, number>>();
	let considered = 0;
	for (const row of rows) {
		const c = row[childColumn];
		const p = row[parentColumn];
		if (c === '' || c === undefined || p === '' || p === undefined) continue;
		considered++;
		let counts = byChild.get(c);
		if (!counts) {
			counts = new Map();
			byChild.set(c, counts);
		}
		counts.set(p, (counts.get(p) ?? 0) + 1);
	}
	if (considered === 0) return 0;
	let agree = 0;
	for (const counts of byChild.values()) {
		agree += Math.max(...counts.values());
	}
	return agree / considered;
}

// ============================================================================
// Row-type-discriminator detection (spec §7d)
// ============================================================================

/**
 * Detect a column that mixes hierarchy levels as rows: a low-cardinality column
 * whose values name levels (mostly non-numeric) AND correlate with distinct
 * column-fill patterns (per value, a materially different set of other columns
 * is non-empty). "Materially different" = max pairwise Jaccard distance between
 * the per-value fill-sets ≥ 0.3. Emits a UI-flag proposal only (no auto recipe).
 *
 * Requires row alignment (which columns each row fills), so reads `sampleRows`;
 * no-ops on a streaming source.
 */
function detectRowTypeDiscriminators(
	columns: string[],
	sampleRows: Record<string, string>[] | null,
	distinctnessByColumn: Map<string, number>,
	cardinalityByColumn: Map<string, number>,
	rowCount: number,
): Detection[] {
	if (!sampleRows || sampleRows.length === 0) return [];
	const out: Detection[] = [];

	for (const col of columns) {
		const card = cardinalityByColumn.get(col) ?? 0;
		if (card < 2 || card > DISCRIMINATOR_MAX_CARDINALITY) continue;
		// A level *type* labels many rows: cardinality small relative to rows, so
		// per-value groups average ≥ 2 (excludes 1-row-per-value id columns).
		if (card > rowCount * DISCRIMINATOR_MAX_CARD_RATIO) continue;

		// Group rows by this column's non-empty value.
		const groups = new Map<string, Record<string, string>[]>();
		let nonNumeric = 0;
		let nonEmpty = 0;
		for (const row of sampleRows) {
			const v = row[col];
			if (v === '' || v === undefined) continue;
			nonEmpty++;
			if (!isNumeric(v)) nonNumeric++;
			let g = groups.get(v);
			if (!g) {
				g = [];
				groups.set(v, g);
			}
			g.push(row);
		}
		if (groups.size < 2 || nonEmpty === 0) continue;
		// Values must "look like level names" — mostly non-numeric.
		if (nonNumeric / nonEmpty < DISCRIMINATOR_NONNUMERIC_MIN) continue;

		// Fill-set per value: other columns non-empty in ≥ 50% of the group's rows.
		const fillSets: { value: string; rowCount: number; filled: Set<string> }[] = [];
		for (const [value, rows] of groups) {
			const filled = new Set<string>();
			for (const other of columns) {
				if (other === col) continue;
				let hits = 0;
				for (const r of rows) if (r[other] !== '' && r[other] !== undefined) hits++;
				if (hits / rows.length >= DISCRIMINATOR_FILL_MIN) filled.add(other);
			}
			fillSets.push({ value, rowCount: rows.length, filled });
		}

		// Max pairwise Jaccard distance between fill-sets.
		let maxDistance = 0;
		for (let i = 0; i < fillSets.length; i++) {
			for (let j = i + 1; j < fillSets.length; j++) {
				const dist = jaccardDistance(fillSets[i].filled, fillSets[j].filled);
				if (dist > maxDistance) maxDistance = dist;
			}
		}
		if (maxDistance < DISCRIMINATOR_JACCARD_MIN) continue;

		out.push({
			kind: 'row-type-discriminator',
			column: col,
			values: fillSets.map((f) => ({
				value: f.value,
				rowCount: f.rowCount,
				filledColumns: [...f.filled].sort(),
			})),
			maxJaccardDistance: round(maxDistance),
			sampleValues: [...groups.keys()].slice(0, SAMPLE_VALUES),
			proposal: {
				mechanism: 'flag-for-ui',
				note: 'This column mixes hierarchy levels as rows. Confirm how to split it in the wizard.',
			},
		});
	}
	return out;
}

/** Jaccard distance between two string sets: 1 - |A∩B| / |A∪B| (empty∪empty → 0). */
function jaccardDistance(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let intersection = 0;
	for (const x of a) if (b.has(x)) intersection++;
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : 1 - intersection / union;
}

// ============================================================================
// Edge-file detection (spec §7d)
// ============================================================================

/** An id-like value: a code token with a digit and no whitespace (T1055.011, GV.OC-01). */
const ID_LIKE_RE = /^[A-Za-z0-9]+([._:-][A-Za-z0-9]+)*$/;
/** A predicate-like value: a bare token or prefixed token (broader, skos:exactMatch). */
const PREDICATE_LIKE_RE = /^[A-Za-z][A-Za-z0-9_]*(:[A-Za-z][A-Za-z0-9_]*)?$/;

function isIdLikeValue(value: string): boolean {
	if (value === '' || /\s/.test(value)) return false;
	if (!/[0-9]/.test(value)) return false; // a pure word is a predicate/facet, not an id
	return ID_LIKE_RE.test(value);
}

function isPredicateLikeValue(value: string): boolean {
	if (value === '' || /\s/.test(value)) return false;
	// A colon-namespaced token (skos:exactMatch) is fine even with no digit; a bare
	// token with digits is an id, not a predicate.
	if (/[0-9]/.test(value) && !value.includes(':')) return false;
	return PREDICATE_LIKE_RE.test(value);
}

/**
 * File-level classification: is the FILE relationships (SSSOM/crosswalks) rather
 * than concepts? Fires when ≥2 columns are id-like (mostly id-pattern values),
 * those two are NOT a self-referential hierarchy (no parent-column linking them),
 * and no column reads as a concept title (a long near-unique label). Carries the
 * subject/object/predicate guesses and confidences; no proposal (routes to the
 * crosswalk import path later).
 */
function detectEdgeFile(
	columns: string[],
	valuesByColumn: Map<string, string[]>,
	sampleRows: Record<string, string>[] | null,
	distinctnessByColumn: Map<string, number>,
	cardinalityByColumn: Map<string, number>,
	avgLengthByColumn: Map<string, number>,
	parents: Extract<Detection, { kind: 'parent-column' }>[],
): Extract<Detection, { kind: 'edge-file' }> | null {
	// id-like columns (by value pattern, not just distinctness — crosswalk subjects
	// repeat, so distinctness alone would miss them).
	const idLikeCols: { column: string; confidence: number }[] = [];
	for (const col of columns) {
		const values = valuesByColumn.get(col) ?? [];
		if (values.length === 0 || (cardinalityByColumn.get(col) ?? 0) < 2) continue;
		const fraction = values.reduce((n, v) => (isIdLikeValue(v) ? n + 1 : n), 0) / values.length;
		if (fraction >= EDGE_ID_PATTERN_MIN) idLikeCols.push({ column: col, confidence: round(fraction) });
	}
	if (idLikeCols.length < 2) return null;

	const subject = idLikeCols[0];
	const object = idLikeCols[1];

	// Suppression of a false positive: a self-referential hierarchy (id + parent_id)
	// also has two id-like columns, but a parent-column detection links them. That
	// is a hierarchy, not a crosswalk — do not classify as an edge-file.
	const idLikeSet = new Set(idLikeCols.map((c) => c.column));
	const hasHierarchyPair = parents.some((p) => idLikeSet.has(p.column) && idLikeSet.has(p.idColumn));
	if (hasHierarchyPair) return null;

	// Concept-shaped signal: a long, near-unique label means rows are concepts with
	// names, not relationships. Its presence suppresses the edge-file classification.
	const hasConceptTitle = columns.some(
		(c) => (distinctnessByColumn.get(c) ?? 0) >= TITLE_DISTINCTNESS_MIN && (avgLengthByColumn.get(c) ?? 0) >= CONCEPT_TITLE_MIN_AVG_LEN,
	);
	if (hasConceptTitle) return null;

	// Optional predicate column: low-cardinality, predicate-shaped, not an id column.
	let predicateColumn: string | undefined;
	let predicateConfidence: number | undefined;
	for (const col of columns) {
		if (col === subject.column || col === object.column) continue;
		if ((cardinalityByColumn.get(col) ?? 0) > EDGE_PREDICATE_MAX_CARDINALITY) continue;
		const values = valuesByColumn.get(col) ?? [];
		if (values.length === 0) continue;
		const fraction = values.reduce((n, v) => (isPredicateLikeValue(v) ? n + 1 : n), 0) / values.length;
		if (fraction >= EDGE_PREDICATE_SHAPE_MIN) {
			predicateColumn = col;
			predicateConfidence = round(fraction);
			break;
		}
	}

	// Receipts: up to 5 "subject | predicate | object" tuples.
	const sampleValues: string[] = [];
	if (sampleRows) {
		for (const row of sampleRows) {
			const s = row[subject.column];
			const o = row[object.column];
			if (s === '' || s === undefined || o === '' || o === undefined) continue;
			const p = predicateColumn ? row[predicateColumn] : '';
			const tuple = predicateColumn ? `${s} | ${p} | ${o}` : `${s} | ${o}`;
			if (!sampleValues.includes(tuple)) sampleValues.push(tuple);
			if (sampleValues.length >= SAMPLE_VALUES) break;
		}
	}

	return {
		kind: 'edge-file',
		subjectColumn: subject.column,
		subjectConfidence: subject.confidence,
		objectColumn: object.column,
		objectConfidence: object.confidence,
		...(predicateColumn ? { predicateColumn, predicateConfidence } : {}),
		sampleValues,
	};
}

// ============================================================================
// Multi-value-link detection (spec §7d)
// ============================================================================

/**
 * A multi-value link column holds several ids per cell (`related: T1055, T1548`).
 * After list-splitting, the exploded values hit another column's id set at
 * `matchRate` ≥ 0.6, and there is on average more than one value per non-empty
 * cell — the "> 1" test is what separates it from the single-value parent-column
 * (which matches raw whole-cell values). Proposes multiple edges per row.
 */
function detectMultiValueLink(
	column: string,
	idColumn: string,
	columnValues: string[],
	idValues: string[],
): Detection | null {
	if (columnValues.length === 0 || idValues.length === 0) return null;
	const idSet = new Set(idValues);
	let cells = 0;
	let atoms = 0;
	let matched = 0;
	for (const cell of columnValues) {
		const pieces = splitMultiValue(cell);
		if (pieces.length === 0) continue;
		cells++;
		for (const p of pieces) {
			atoms++;
			if (idSet.has(p)) matched++;
		}
	}
	if (cells === 0 || atoms === 0) return null;
	const avgValuesPerCell = atoms / cells;
	if (avgValuesPerCell <= MULTI_LINK_AVG_MIN) return null; // single-value → parent-column's job
	const matchRate = matched / atoms;
	if (matchRate < MULTI_LINK_MATCH_MIN) return null;
	return {
		kind: 'multi-value-link',
		column,
		idColumn,
		matchRate: round(matchRate),
		avgValuesPerCell: round(avgValuesPerCell),
		sampleValues: columnValues.slice(0, SAMPLE_VALUES),
		proposal: {
			parentColumn: column,
			idColumn,
			frontmatterKey: 'related',
			predicate: 'skos:related',
		},
	};
}

// ============================================================================
// Body-candidate detection (spec §7d)
// ============================================================================

/**
 * A long-text column belongs in the note body. Fires when the average value is
 * long (≥ 200 chars) OR medium (≥ 80 chars) and reads as prose (sentence
 * punctuation in ≥ 60% of samples), with high distinctness (body text is mostly
 * one-per-row, which separates it from a repeated facet label).
 */
function detectBody(column: string, values: string[], distinctness: number, avgLength: number): Detection | null {
	if (values.length === 0) return null;
	if (distinctness < BODY_DISTINCTNESS_MIN) return null;
	const punctCount = values.reduce((n, v) => (/[.!?]/.test(v) ? n + 1 : n), 0);
	const punctFraction = punctCount / values.length;
	const isLong = avgLength >= BODY_AVG_LONG;
	const isProse = avgLength >= BODY_AVG_MEDIUM && punctFraction >= BODY_PUNCT_MIN;
	if (!isLong && !isProse) return null;
	return {
		kind: 'body-candidate',
		column,
		avgLength: round(avgLength),
		distinctness: round(distinctness),
		sampleValues: values.slice(0, SAMPLE_VALUES).map(truncateSample),
		proposal: { destination: 'body' },
	};
}

/** Truncate a long body value for receipt display. */
function truncateSample(value: string): string {
	return value.length <= BODY_SAMPLE_MAXLEN ? value : value.slice(0, BODY_SAMPLE_MAXLEN) + '...';
}

/** Mean character length over non-empty values (0 for an empty column). */
function averageLength(values: string[]): number {
	if (values.length === 0) return 0;
	let total = 0;
	for (const v of values) total += v.length;
	return total / values.length;
}

// ============================================================================
// Shared helpers
// ============================================================================

/**
 * Normalized, non-empty values per column. Eager rows are scanned directly;
 * streaming rows fall back to the (small) sample already on `ColumnInfo`.
 */
function collectColumnValues(data: ParsedData, columns: ColumnInfo[]): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const col of data.columns) out.set(col, []);

	if (isEagerRows(data.rows)) {
		for (const row of data.rows) {
			for (const col of data.columns) {
				const s = normalize(row[col]);
				if (s !== '') out.get(col)!.push(s);
			}
		}
	} else {
		// Streaming source — no synchronous scan possible. Use the pre-computed
		// samples; detection is best-effort on that limited sample.
		for (const info of columns) {
			const list = out.get(info.name);
			if (!list) continue;
			for (const v of info.sampleValues) {
				const s = normalize(v);
				if (s !== '') list.push(s);
			}
		}
	}
	return out;
}

/**
 * Materialize aligned, normalized sample rows (empties preserved as '') for the
 * cross-column detectors that need to know which values co-occur — chain FD,
 * discriminator fill-patterns, edge tuples. Capped at `ROW_SAMPLE_LIMIT`.
 *
 * Returns null for a streaming source: an `AsyncIterable` can't be scanned
 * synchronously, and the per-column sample on `ColumnInfo` isn't row-aligned, so
 * the cross-column detectors simply no-op there (spec §2).
 */
function collectSampleRows(data: ParsedData): Record<string, string>[] | null {
	if (!isEagerRows(data.rows)) return null;
	const out: Record<string, string>[] = [];
	for (const row of data.rows) {
		const normalized: Record<string, string> = {};
		for (const col of data.columns) normalized[col] = normalize(row[col]);
		out.push(normalized);
		if (out.length >= ROW_SAMPLE_LIMIT) break;
	}
	return out;
}

/** Best available row count for the facet cardinality cap. */
function countRows(data: ParsedData, valuesByColumn: Map<string, string[]>): number {
	if (data.rowCount && data.rowCount > 0) return data.rowCount;
	// Streaming/unknown — approximate from the longest materialized column.
	let max = 0;
	for (const list of valuesByColumn.values()) if (list.length > max) max = list.length;
	return max;
}

function normalize(value: unknown): string {
	return String(value ?? '').trim();
}

function isNumeric(value: string): boolean {
	return value !== '' && !Number.isNaN(Number(value));
}

/** Round a fraction to 4 decimals so detection output is stable and readable. */
function round(n: number): number {
	return Math.round(n * 10000) / 10000;
}
