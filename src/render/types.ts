/**
 * Render types — the input and output shapes of the render() function.
 *
 * Per Ch 22 (target-structure expressivity synthesis): render() is a pure
 * function with signature `(Recipe, ConceptIdentity, sourceScope) → Address`.
 * Pass 1 is vault-independent (deterministic, hashable, replayable).
 * Pass 2 (link minimizer with VaultIndex) is deferred to v0.3.
 */

/**
 * Variables available to template interpolation. Populated by the source
 * iteration step upstream of render — typically one entry per source level
 * (`catalog`, `family`, `control`, `enhancement` for NIST 800-53 r5; or
 * `domain`, `kingdom`, …, `species` for a biology taxonomy).
 *
 * Templates reach into scope via dotted paths: `{control.id}`, `{family.title}`.
 */
export type SourceScope = Record<string, unknown>;

/**
 * Identity of a single concept being rendered.
 *
 * `curie` is the canonical concept identity (`nist:AC-2`, `iso27001:A.9.2.1`).
 * `scope` is the variables available to template interpolation.
 */
export interface ConceptIdentity {
	curie: string;
	scope: SourceScope;
}

/**
 * Codes for per-row render deviations — the cases where a row didn't fit the
 * recipe's expected shape and render() applied a fallback instead of failing.
 * One visible rule (v0.1.6): every row imports; every deviation is recorded.
 */
export type RenderNoteCode =
	| 'folder-level-skipped' // folder segment rendered empty → level dropped, note lands one level up
	| 'split-no-delimiter' // split() found no delimiter in the value
	| 'split-index-missing' // split() index past the number of pieces → empty string
	| 'regex-no-match' // regex() matched nothing → empty string
	| 'literal-key-shadowed' // a dotted path read BOTH as a literal column name and as nested traversal; the column won
	| 'list-items-dropped' // a filter blanked one or more items of a list, and they were elided (contract §2 L2)
	| 'variadic-overflow-truncated'; // variadic split produced more segments than max_depth → extras dropped (full id still in the filename)

/**
 * Variable-depth folder expansion config for a `folder` layout entry.
 *
 * A fixed layout lists its folder levels ahead of time — one entry per level.
 * Ragged ids (`T1055` vs `T1055.011`) carry a *different* number of pieces per
 * row, so no fixed list fits every row. A `variadic` block explodes the entry's
 * rendered scalar *after* templating (templates stay scalar — one value in, one
 * value out) into a variable number of folder levels.
 *
 * Valid only on `mechanism: "folder"` (heading/tag variants deferred). Per the
 * 2026-07-05 variadic-split design (§1–3). Determinism is preserved: segments
 * derive only from the row's own value, so same input → same output.
 */
export interface VariadicConfig {
	/** Delimiter the rendered scalar is split on (e.g. `.` for ATT&CK ids). */
	delimiter: string;
	/**
	 * Folder-name shape per segment.
	 *   'prefix' (default) → cumulative prefixes joined by the delimiter
	 *     (`X.Y.Z` → `X`, `X.Y`); folder names stay globally unique + match the
	 *     existing CSF recipe convention.
	 *   'part' → raw pieces (`X.Y.Z` → `X`, `Y`).
	 */
	segment?: 'prefix' | 'part';
	/**
	 * Drop the final piece before building folders (default true) — the leaf
	 * belongs to the `file` entry, which names it with the full id anyway.
	 */
	drop_last?: boolean;
	/** Safety cap on the number of folder levels produced (default 6). */
	max_depth?: number;
	/**
	 * What to do when the split produces more than `max_depth` segments.
	 *   'truncate' (default) → keep the first `max_depth`, record a
	 *     `variadic-overflow-truncated` note (no data loss — full id is in the
	 *     filename).
	 *   'error' → throw a RenderError.
	 */
	on_overflow?: 'truncate' | 'error';
}

export interface RenderNote {
	code: RenderNoteCode;
	/** Layout level id, when the deviation is tied to a specific level. */
	level?: string;
	/** The template that produced the deviation. */
	template: string;
	/** Plain-language explanation, safe to surface directly in the wizard. */
	detail: string;
}

/**
 * Optional collector passed through render(). When provided, mechanisms and
 * template filters record deviations here. Never changes render() output —
 * determinism (Ch 22 Pass-1 hashability) is unaffected.
 */
export interface RenderReport {
	notes: RenderNote[];
}

/**
 * AM-33 / AM-37 (2026-09-01). One rendered DIRECTORY SEGMENT, beside the layout
 * level that produced it.
 *
 * A layout turns source facts into directory segments. Each segment is a value,
 * recorded here at the moment it is produced, in order, beside the level it
 * belongs to. One entry per segment, whatever appended it: a folder mechanism,
 * a literal separator inside a folder template (`Frameworks/{catalog.name}`
 * produces TWO, the second being the level's own rendered text), or the
 * directory prefix of a file template. A literal's rendered text is its value;
 * the level name beside it is descriptive, and repeats when one entry produced
 * several segments.
 *
 * The count is therefore never a matter of luck: it equals the depth of the
 * rendered directory by construction, so a consumer that compares them treats a
 * mismatch as the bug it is instead of falling back to reading the path.
 *
 * Failure mode prevented: hub identity being RECOMPUTED by parsing a note's
 * final vault path (`dirname(path)`) on every run and used as the lookup key.
 * A path is a place, not a fact: it carries the import root, it carries whatever
 * a relocation pass inserted, and it changes for reasons that have nothing to do
 * with what the folder is ABOUT. When the key moved, the hub that plainly
 * existed was found by nothing, a second one was written, and the first was
 * orphaned with the user's prose on it. A path may seed a one-time mint; it may
 * never be needed again after it (A-8 clause one).
 */
export interface LayoutValue {
	/** The layout entry's declared level name (e.g. `family`, `tactic`). */
	level: string;
	/** The value that level rendered for this row — the segment, before it became part of any path. */
	value: string;
}

/**
 * The Address output — what render() produces per concept.
 *
 * Per Ch 22 §3.1.
 */
export interface RenderedBodyRegion {
	/** Append emits content directly; section emits a heading before content. */
	position: 'append' | 'section';
	/** Fully rendered and formatted Markdown content. Generation never re-evaluates its template. */
	content: string;
	/** Literal section heading, present only for section regions. */
	heading?: string;
	/** Markdown heading depth, present only for section regions. */
	headingDepth?: 1 | 2 | 3 | 4 | 5 | 6;
}

export interface Address {
	/** Primary location — vault-relative path + optional heading anchor. */
	primary: {
		path: string;
		anchor?: string;
	};
	/**
	 * Exact string that goes inside `[[...]]` when a wikilink to this concept
	 * is emitted. Pass-1: full-path form (`Frameworks/NIST 800-53 r5/AC/AC-2`).
	 * Pass-2 link minimizer (v0.3) may downgrade to bare basename when unambiguous.
	 */
	wikilinkTarget: string;
	/** Tags emitted into the note's `tags` frontmatter array. */
	tags: string[];
	/** Aliases emitted into the note's `aliases` frontmatter array. */
	aliases: string[];
	/** Ordered, fully rendered recipe-managed body regions. */
	body: RenderedBodyRegion[];
	/**
	 * Recipe-managed frontmatter — keys + interpolated values.
	 * User-preserve frontmatter is merged in at write time, NOT here.
	 */
	frontmatter: Record<string, unknown>;
}
