/**
 * Crosswalker Configuration Types
 *
 * Defines the schema for import configurations.
 */

// ============================================================================
// Top-Level Config
// ============================================================================

export interface ImportRecipe {
	// Metadata
	name: string;
	version: string;
	description?: string;

	// Source
	source: SourceConfig;

	// Transformations (per-column)
	transforms: Record<string, TransformRule[]>;

	// Mapping (structure)
	mapping: MappingConfig;

	// Output
	output: OutputConfig;
}

// ============================================================================
// Source Config
// ============================================================================

export interface SourceConfig {
	type: 'csv' | 'xlsx' | 'json';

	// For XLSX
	sheet?: string;
	headerRow?: number;

	// For JSON
	rootPath?: string;

	// Common
	encoding?: string;
	delimiter?: string;
}

// ============================================================================
// Transform Rules
// ============================================================================

export interface TransformRule {
	type: TransformType;
	params?: Record<string, any>;
}

export type TransformType =
	// String operations
	| 'trim'
	| 'lowercase'
	| 'uppercase'
	| 'titlecase'
	| 'replace'
	| 'regex_extract'
	| 'prefix'
	| 'suffix'
	| 'template'

	// Array operations
	| 'split'
	| 'join'
	| 'unique'
	| 'filter'
	| 'first'
	| 'last'
	| 'map'

	// Type conversions
	| 'to_number'
	| 'to_boolean'
	| 'to_date'
	| 'to_tags'
	| 'to_wikilinks'

	// Conditional
	| 'if_empty'
	| 'if_matches'
	| 'coalesce'
	| 'lookup'

	// Custom
	| 'custom';

// ============================================================================
// Mapping Config
// ============================================================================

export interface MappingConfig {
	hierarchy: HierarchyMapping[];
	frontmatter: FrontmatterMapping[];
	links: LinkMapping[];
	body: BodyMapping[];
	/**
	 * Optional. When omitted, the legacy-recipe-shim falls back to the first
	 * frontmatter column → `{<column>}.md`, then to `{id}.md` as last resort.
	 * The wizard omits this when no column is marked as "Note title".
	 */
	filename?: FilenameConfig;
}

export interface HierarchyMapping {
	column: string;
	level: number;
	transform?: TransformRule[];
	/** Explicit folder template, overriding the default `{<column>}`. Used to
	 *  derive a folder level from part of a value — e.g. `{id|split(.,0)}` to
	 *  turn a taxonomy id like `DE.AE-02` into nested `DE/ → DE.AE/` folders. */
	template?: string;
}

export interface FrontmatterMapping {
	column: string;
	key: string;
	format?: 'string' | 'number' | 'boolean' | 'array' | 'date';
	transform?: TransformRule[];
	nested?: string;
	omitIfEmpty?: boolean;
}

export interface LinkMapping {
	column: string;
	type: 'wikilink' | 'markdown';
	location: 'frontmatter' | 'body' | 'both';
	frontmatterKey?: string;
	bodySection?: string;
	transform?: TransformRule[];
	targetFramework?: string;
	matchPattern?: string;
}

export interface BodyMapping {
	column: string;
	heading?: string;
	format?: 'text' | 'code' | 'quote' | 'list';
	transform?: TransformRule[];
}

export interface FilenameConfig {
	template: string;
	sanitize: boolean;
	maxLength?: number;
	transform?: TransformRule[];
}

// ============================================================================
// Output Config
// ============================================================================

export interface OutputConfig {
	basePath: string;
	createFolders: boolean;
	overwrite: 'skip' | 'replace' | 'merge' | 'error';

	frontmatter: {
		style: 'flat' | 'nested';
		quoteStrings: boolean;
		arrayStyle: 'flow' | 'block';
	};
}

// ============================================================================
// Parsed Data (from source files)
// ============================================================================

/**
 * Type guard — checks if a ParsedData's rows are an eager array (the
 * wizard preview / config-matching / column-analysis path) vs an
 * AsyncIterable (the streaming-import path).
 *
 * Code that needs random access (`.slice()`, `[index]`, `.map()`,
 * `.length`) should narrow via this guard before operating on rows.
 * Streaming consumers iterate via `for await ... of` which works on
 * both forms.
 */
export function isEagerRows(
	rows: Record<string, any>[] | AsyncIterable<Record<string, any>>,
): rows is Record<string, any>[] {
	return Array.isArray(rows);
}

/**
 * ParsedData — the bundled engine's structured-row input shape.
 *
 * `rows` may be either:
 *  - An eager array (small/medium data — wizard preview, in-memory imports)
 *  - An AsyncIterable (true streaming — large files via PapaParse step callback,
 *    external pipes from ChunkyCSV/JSONaut, etc.)
 *
 * The generation engine consumes either form via `for await ... of`.
 *
 * Per the [2026-05-05 two-mode architecture decision](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-05-two-mode-architecture/):
 * external producers can hand a ParsedData with AsyncIterable rows directly to
 * the bundled engine via `plugin.runImportFromRecipe()`, enabling
 * streaming-by-design composition with external ETL tools.
 *
 * NOT a tier or persisted format. Implementation detail of Mode 1 (bundled
 * projector). External producers that emit Tier 1 directly (Mode 2) never
 * touch this interface.
 */
export interface ParsedData {
	columns: string[];
	rows: Record<string, any>[] | AsyncIterable<Record<string, any>>;
	sheetName?: string;
	/** Total row count if known. -1 (or undefined) if streaming and count is unknown. */
	rowCount: number;
	/**
	 * Digest of the complete pre-parse source bytes associated with these rows.
	 * Native XLSX parsing emits `sha256-<64 lowercase hex>` from its captured
	 * workbook payload. Absent means byte identity was not recorded, never that
	 * the source is unchanged. Programmatic producers are responsible for keeping
	 * any supplied digest associated with the rows it describes.
	 */
	sourceByteDigest?: string;
	/**
	 * The container the PRIMARY collection was read out of, so `source.joins`
	 * can locate a secondary collection inside the SAME source bytes (Ch 46
	 * source contract 4.2). Absent means no container was recorded, and a
	 * recipe declaring `joins` against it fails loud rather than silently
	 * finding nothing.
	 *
	 * Every accessor is LAZY and async on purpose: a parser attaches a handle,
	 * never a retained decoded workbook or document. Native XLSX retains its
	 * private captured byte snapshot while this handle is reachable so every
	 * joined sheet comes from the same bytes; each access re-decodes a defensive
	 * copy. A run with no join avoids secondary workbook decoding, but still pays
	 * the captured payload's actual byteLength plus transient hash/decoder copies.
	 */
	container?: SourceContainer;
}

/**
 * Where a secondary collection can live (Ch 46 source contract 4.2).
 *
 * Both forms are INSIDE THE SAME SOURCE BYTES. The `source` block's stated
 * scope is "out-of-scope: where the source bytes come from"; a join naming a
 * second file would break that rule and single-file portability with it.
 *
 * `flat` is not a gap to be filled later. A CSV file IS one collection: there
 * is no second thing to name, so `joins` over one is a recipe defect and is
 * reported as one (acceptance case C10).
 */
export type SourceContainer =
	| { kind: 'flat' }
	| {
		kind: 'workbook';
		/** Sheet names, for selection and for the "available sheets" error detail. */
		sheetNames: string[];
		/** Read one sheet as rows, skipping `headerRow` banner rows above the header. */
		readSheet(sheet: string, headerRow: number): Promise<Record<string, unknown>[]>;
	}
	| {
		kind: 'json';
		/** Re-read the document root. Called at most once per join declaration. */
		readDocument(): Promise<unknown>;
	};

export interface ColumnInfo {
	name: string;
	sampleValues: any[];
	detectedType: 'string' | 'number' | 'boolean' | 'array' | 'mixed';
	hasEmptyValues: boolean;
	uniqueCount: number;
}

// ============================================================================
// Saved Configuration (for persistence & sharing)
// ============================================================================

/**
 * Current schema version for SavedConfig.
 * Increment this when making breaking changes to the schema.
 * See https://cybersader.github.io/crosswalker/agent-context/config-schema-design/ for migration strategy.
 */
export const SAVED_CONFIG_SCHEMA_VERSION = 1;

/**
 * A saved import configuration that can be reused across imports.
 *
 * Design principle: Configs are SUGGESTIONS, not mandates.
 * They pre-fill the wizard but users can always modify.
 *
 * See https://cybersader.github.io/crosswalker/agent-context/config-schema-design/ for full design documentation.
 */
export interface SavedConfig {
	/**
	 * Schema version for future migrations.
	 * When loading old configs, check this and run migrations if needed.
	 */
	schemaVersion: number;

	// ---- Metadata ----

	/** Unique identifier (generated, not user-editable) */
	id: string;

	/** User-friendly display name */
	name: string;

	/** Optional description explaining what this config is for */
	description?: string;

	/** ISO timestamp when config was created */
	createdAt: string;

	/** ISO timestamp when config was last modified */
	updatedAt: string;

	/** ISO timestamp when config was last used (for recency ranking) */
	lastUsedAt?: string;

	// ---- Fingerprint (for auto-matching) ----

	/**
	 * Fingerprint data used to automatically suggest this config
	 * when a user loads a file with similar characteristics.
	 */
	fingerprint: ConfigFingerprint;

	// ---- The Actual Configuration ----

	/**
	 * Partial ImportRecipe - merged with defaults when applied.
	 * Being Partial allows configs to only specify what they care about.
	 */
	config: Partial<ImportRecipe>;
}

/**
 * Fingerprint data for smart config matching.
 *
 * When a user loads a file, we create a fingerprint from the parsed data
 * and compare it against saved config fingerprints to suggest matches.
 *
 * Match scoring (see config-schema-design KB page):
 * - Exact column name match: 40%
 * - Normalized column match: 15%
 * - Column count similarity: 10%
 * - Source type match: 5%
 * - Data pattern match: 15%
 * - Filename pattern match: 10%
 * - Recency bonus: 5%
 */
export interface ConfigFingerprint {
	// ---- Column Matching ----

	/** Original column names exactly as they appear in the source file */
	columnNames: string[];

	/**
	 * Normalized column names for fuzzy matching.
	 * Lowercase, trimmed, special chars replaced with underscores.
	 * e.g., "Control ID" -> "control_id"
	 */
	columnNamesNormalized: string[];

	/** Number of columns (for quick filtering) */
	columnCount: number;

	// ---- Data Pattern Hints ----

	/**
	 * Patterns detected in sample data, used for smarter matching.
	 * e.g., detecting "AC-1", "AC-2" pattern suggests NIST control IDs.
	 */
	samplePatterns?: {
		/** Column where pattern was detected */
		column: string;
		/** Regex pattern (as string) */
		pattern: string;
		/** Example values that matched the pattern */
		examples: string[];
	}[];

	// ---- Source File Hints ----

	/** Type of source file this config was created from */
	sourceType?: 'csv' | 'xlsx' | 'json';

	/**
	 * Glob-like pattern for filename matching.
	 * e.g., "*nist*800-53*" matches "NIST_800-53_rev5.csv"
	 */
	fileNamePattern?: string;

	// ---- Future Extensions (documented but not implemented) ----
	// columnAliases?: Record<string, string[]>;  // {"Control ID": ["ctrl_id", "id"]}
}

/**
 * Result of applying a saved config to parsed data.
 * Used to show warnings/info to the user about what matched and what didn't.
 */
export interface ConfigApplicationResult {
	/** Whether the config was successfully applied */
	applied: boolean;

	/** The config that was applied */
	config: SavedConfig;

	/** Columns that matched between config and file */
	matchedColumns: string[];

	/** Columns the config expected but file doesn't have */
	missingColumns: string[];

	/** Columns in file that config doesn't mention (will default to Skip) */
	extraColumns: string[];

	/** Columns that matched via fuzzy matching (user should confirm) */
	fuzzyMatches: {
		configColumn: string;
		fileColumn: string;
		similarity: number;
	}[];

	/** Warning messages to display to user */
	warnings: string[];
}

// ============================================================================
// Generation Result
// ============================================================================

export interface GeneratedNote {
	path: string;
	fileName: string;
	frontmatter: Record<string, any>;
	content: string;
	links: WikiLink[];
}

export interface WikiLink {
	target: string;
	alias?: string;
	metadata?: Record<string, any>;
}

export interface GenerationResult {
	success: boolean;
	created: string[];
	skipped: string[];
	errors: GenerationError[];
	/**
	 * Notes relocated by identity reconciliation (2026-08-21): the vault already
	 * held this concept at a different address, so it was MOVED to the address the
	 * recipe now renders rather than duplicated beside it. Moves go through
	 * Obsidian's rename API, so wikilinks pointing at the note follow it.
	 * Surfaced so a re-import that quietly rearranges a vault is never a mystery.
	 */
	moved?: Array<{ curie: string; from: string; to: string }>;
	/**
	 * Identities previously produced by this recipe that a complete, successful
	 * run no longer produced. Orphans are kept by default, flagged for review,
	 * and excluded from coverage counts. Deletion requires a separate confirmed
	 * action and is never performed by generation.
	 */
	orphans?: Array<{ curie: string; path: string }>;
	/**
	 * AM-7. Whether orphan detection actually ran.
	 *
	 * Failure mode prevented: an uncomputed orphan count read as zero. Detection
	 * is suppressed whenever the run cannot prove it saw the whole source (a row
	 * error, a short read, incomplete enrichment bookkeeping), and `orphans` is
	 * then absent for exactly the same reason it is absent when a complete run
	 * found none. Reporting the second case as the first tells a user their
	 * framework is intact when nobody checked. Tri-state, same rule as the
	 * metadata cache: absent-because-pending is never absent-because-none.
	 *
	 * Optional so producers written before this stay valid; a reader treats only
	 * an explicit `false` as `not checked`.
	 */
	orphansChecked?: boolean;
	/**
	 * Per-row render deviations (v0.1.6): rows that imported fine but didn't
	 * fully fit the recipe's expected shape (skipped folder level, split/regex
	 * fallback). Never blocks the import — surfaced so a "weird vault" is
	 * never a mystery.
	 */
	warnings?: GenerationError[];
	/**
	 * Graph edges materialized by Pass 1.5 batch enrichment (v0.1.6): parent
	 * links + children-list entries + facet-hub member entries. Surfaces the
	 * connectedness of the imported vault on the review screen ("K graph edges").
	 * A run that ships 0 edges is a visible warning, not a silent dead graph
	 * (spec §7k). Undefined when enrichment did not run.
	 */
	edgeCount?: number;
	/**
	 * Notes this run refused to modify because it could not prove what it would be
	 * doing to them. Never data loss: the file on disk is untouched. Surfaced so a
	 * re-import that silently skips notes is never a mystery.
	 *
	 * Distinct from `errors` (the row failed to produce a note) and from
	 * `warnings` (the note was written with a deviation). A conflict means a good
	 * note was produced and DELIBERATELY not written.
	 */
	conflicts?: Array<{ path: string; curie?: string; code: string; detail: string }>;
	/**
	 * Source rows the declared `source.where` predicate excluded (Ch 46 source
	 * contract; 2026-08-27 contract §11.4). Surfaced so "200 rows in, 40 notes
	 * out" is never a mystery: the wizard previously showed a "(N filtered out)"
	 * notice at parse time, and the predicate has since moved to generation.
	 *
	 * Undefined when no source shaping was declared, so a plain import says
	 * nothing about filtering rather than claiming zero.
	 */
	filteredOut?: number;
	/** Crosswalk edge notes written by a declared target.crosswalks pass. */
	crosswalkEdges?: { created: number; sets: string[]; summary?: string[] };
	/**
	 * Approved evidence links this run wrote WITHOUT a review baseline, because
	 * their subject control was not resolvable in this vault (Ch 43
	 * re-attestation). The links are valid and count toward coverage; what they
	 * cannot do is notice a later upstream change to the control.
	 *
	 * Undefined when there were none, so a plain concept import says nothing
	 * about baselines rather than claiming a zero it never measured. Never
	 * back-filled by a second pass: a fingerprint the importer computed against
	 * content no human read is not an approval.
	 */
	unbaselinedJunctions?: number;
	duration: number;
}

export interface GenerationError {
	row: number;
	column?: string;
	message: string;
	/**
	 * Recipe declaration path that produced this error, e.g. `source.where`.
	 * Additive (Ch 46 source contract §7): only source-stage failures set it,
	 * every existing producer of a GenerationError leaves it absent.
	 */
	declaration?: string;
}
