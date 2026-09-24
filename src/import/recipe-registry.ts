/**
 * recipe-registry.ts — the recognized-source registry (spec §7m, the vetted fast path).
 *
 * A pure, unit-testable index over the BUNDLED import recipes (`recipes/import/*.json`).
 * On file selection the wizard fingerprints the parsed columns against every entry;
 * a confident match lets the wizard lead with a calm, trust-forward recognized-source
 * card ("Recognized: NIST CSF 2.0 (CPRT export) · vetted recipe · Built-in") whose
 * primary action loads the recipe straight into the review screen via `fromRecipe`
 * (the round-trip law). No match → the ordinary detection flow is unchanged.
 *
 * HOW RECIPES ARE ACCESSED AT RUNTIME
 * -----------------------------------
 * The recipes are imported as JSON modules and BUNDLED into main.js by esbuild
 * (`resolveJsonModule: true`; same mechanism `src/views/recipe-loader.ts` uses for
 * `recipes/v0-1/*.json`). The JSON files remain the single source of truth — there
 * is NO hand-maintained duplicate to keep in sync. Adding a recognized source is a
 * one-line import + one registry entry below.
 *
 * THE MATCH SIGNATURE
 * -------------------
 * A recipe references the source columns it needs directly in its templates
 * (`{element_identifier|split(.,0)}` → the `element_identifier` column). We extract
 * those `{column}` tokens (the text before the first `|`) as the entry's SIGNATURE
 * columns, and the tokens used by STRUCTURAL layout entries (folder/file/heading)
 * as its REQUIRED columns. A source that carries a recipe's required + most of its
 * signature columns almost certainly IS that export. See `matchScore`.
 *
 * EVERY region that consumes a column counts: layout, tags, aliases, managed
 * properties, managed links, AND `also_emit.body` projections. The body region was
 * missing until 2026-08-26; see the comment in `deriveSignature` for why leaving it
 * out is a correctness bug rather than a tuning choice, and for the corpus numbers.
 *
 * Columns behind a leading `optional` filter are deliberately NOT discounted in the
 * denominator. Discounting them was considered and REJECTED on measurement: the
 * MITRE recipe marks 16 of its 19 columns `optional`, so excluding them collapses
 * its signature to 3 (`ID`, `name`, `description`) and every other sheet in the
 * ATT&CK workbook (tactics, software, groups, campaigns, mitigations, datasources)
 * plus `tools/fixtures/synthetic/nist-mini.csv` auto-matches it at 100 — 14 new
 * false positives across the corpus, against 0 for the rule as written. `optional`
 * declares what render() may skip, not what identifies a source.
 *
 * THRESHOLD TUNING (2026-07-11, against the real-world corpus)
 * --------------------------------------------------------------
 * `CONFIDENT_MATCH_THRESHOLD` was raised from 75 to 90 after running the matcher
 * headlessly against every parseable file under the (gitignored, local-only)
 * `Frameworks/` corpus — 300+ real CIS/SCF/NIST/CRI/ATT&CK exports and workbook
 * sheets — plus the tracked `tools/fixtures/realistic/` set. At 75, three CIS
 * Controls v8 "Change Log" sheets (metadata about what changed between versions,
 * NOT a safeguard catalog) scored exactly 75 against `cis-controls-v8-flat` (6 of
 * its 8 signature columns present — the sheets rename `Asset Class` /
 * `Security Function` to `Asset Class v8.1` / `Security Function v8.1`, so those
 * two miss) and would have been confidently MIS-recognized as a full safeguard
 * import. The one true full-catalog export in the corpus scored 100. A companion
 * SCF sheet ("Data Privacy Mgmt Principles" — a real but narrower SCF subset
 * missing the `SCF Domain` column) also scored 75 against `scf-2026-flat`.
 * Across every recipe's signature size (2–11 columns), missing even a single
 * column caps the score at 50–87.5%, so a threshold of 90 requires essentially
 * complete signature coverage: every real full export found in the corpus landed
 * at exactly 100; anything short of that is still surfaced as a (non-auto-
 * selected) candidate via `findRecognizedRecipes` — it's just never auto-picked
 * by `bestRecognizedRecipe`. `CANDIDATE_FLOOR` (40) was left unchanged — it only
 * gates the informational candidate list, and the corpus showed no noise problem
 * there (the handful of sub-75 candidates were legitimately related-but-different
 * shapes, e.g. an 800-53 assessment-procedures export scoring 50 against the
 * control-catalog recipe on `identifier` alone — a fair "maybe" for a human to
 * glance at and dismiss, not a false positive).
 *
 * ROUTING KIND
 * ------------
 * A recipe's LEAF layout entry may declare `kind` (spec §7's
 * `concept | junction-note | crosswalk-edge`) — the Tier 1 shape it produces.
 * `routingKind` reads that straight off the bundled JSON so the wizard can label
 * a crosswalk/mapping source distinctly ("This looks like a crosswalk/mapping
 * file") instead of presenting it as an ordinary concept import.
 *
 * CURATED DEFAULTS
 * -----------------
 * `suggestedFolder` and `recommendedEnrichment` are curated, registry-only
 * metadata (see the `DEFAULTS` map below) — NOT written into the bundled recipe
 * JSON. `recommendedEnrichment` in particular is advisory: it names the Pass 1.5
 * enrichment (`target.enrichment` — children lists / facet hub notes, see
 * `src/generation/enrich.ts`) that WOULD suit each source's shape, without
 * flipping it on in the shipped recipe. None of the ten bundled recipes emit the
 * `parent` frontmatter link or `also_emit.tags` facet destination that pass
 * depends on today, so turning it on live would be the first real exercise of
 * that (2026-07-10, brand-new) code path against production recipes — out of
 * this pass's surface. The hint documents the target state for whoever wires it.
 *
 * Pure module: NO Obsidian imports, NO settings — the wizard composes the UI copy.
 */

import type { CrosswalkerImportRecipe } from '../types/generated/recipe';
import type { ParsedData } from '../types/config';
import { canonicalToMapping } from './recipe-document';
import { interpolationColumn, parseTemplateSegments } from '../render/template';
import type { ImportMapping } from './mapping/types';

// Bundled import recipes — esbuild inlines these JSON modules into main.js.
import nistCsf2CprtHierarchical from '../../recipes/import/nist-csf-2-cprt-hierarchical.json';
import nistCsf2Cprt from '../../recipes/import/nist-csf-2-cprt.json';
import nistCsf2Flat from '../../recipes/import/nist-csf-2.json';
import mitreAttackTechnique from '../../recipes/import/mitre-attack-technique.json';
import cisControlsV8Controls from '../../recipes/import/cis-controls-v8-controls.json';
import cisControlsV8Flat from '../../recipes/import/cis-controls-v8.json';
import scf2026Flat from '../../recipes/import/scf-2026-flat.json';
import nist80053Flat from '../../recipes/import/nist-800-53-flat.json';
import nist80053Nested from '../../recipes/import/nist-800-53-nested.json';
import criProfileV22 from '../../recipes/import/cri-profile-v2-2.json';
import criProfileV22Nested from '../../recipes/import/cri-profile-v2-2-nested.json';
import crosswalkEdge from '../../recipes/import/crosswalk-edge.json';
import nistCsf2WithdrawalLineage from '../../recipes/import/nist-csf-2-withdrawal-lineage.json';
import evidenceJunctionNotes from '../../recipes/starter/evidence-junction-notes.json';

/** The Tier 1 shape a recipe's leaf layout entry produces (spec §7's `layout_entry.kind`). */
export type RegistryRoutingKind = 'concept' | 'junction-note' | 'crosswalk-edge';

/** Complete canonical bundled recipe. The registry never trims deferred fields. */
type RawRecipe = CrosswalkerImportRecipe;

/** Read a layout entry's optional routing kind. */
function layoutEntryKind(entry: unknown): RegistryRoutingKind {
	const kind = (entry as { kind?: string } | undefined)?.kind;
	return kind === 'crosswalk-edge' || kind === 'junction-note' ? kind : 'concept';
}

/** A recipe's routing kind — its LEAF layout entry's `kind` (the level that names notes). */
function deriveRoutingKind(raw: RawRecipe): RegistryRoutingKind {
	const layout = raw.target.layout ?? [];
	return layoutEntryKind(layout[layout.length - 1]);
}

/**
 * Advisory Pass 1.5 enrichment recommendation for a source shape. Field names
 * mirror `target.enrichment` (`src/import/mapping/types.ts` `Enrichment`) so the
 * hint can be dropped straight in once a recipe is enhanced to carry the
 * `parent` link / facet tag the corresponding pass depends on. NOT applied to
 * the bundled recipe automatically — see the module doc comment.
 */
export interface RecipeEnrichmentHint {
	/** Would a managed `children` wikilink array on parent notes suit this shape? */
	childrenLists: boolean;
	/** Facet hub note recommendation ('none' | 'tags-only' | 'notes'). */
	facetNotes: 'none' | 'tags-only' | 'notes';
	/** The frontmatter/tag field the facet hub would group by, when facetNotes !== 'none'. */
	facetField?: string;
	/** One line of reasoning — why this recommendation (or why 'none'). */
	rationale: string;
}

/** One recognized source: a bundled recipe plus its derived match signature + label. */
export interface RecipeRegistryEntry {
	/** Stable id — the recipe JSON's `recipe` field. */
	id: string;
	/** Human, GRC-first label shown on the card ("NIST CSF 2.0 (CPRT export)"). */
	label: string;
	/** One-line, plain-language description of what the recipe produces (sentence case, no em dashes). */
	description: string;
	/** Source ontology id (`nist-csf-2`, `cis-v8`, …). */
	ontology: string;
	/**
	 * Case-insensitive header substrings that name this ontology in another
	 * source. Recognition data only; moves into recipe JSON with the
	 * 2026-09-14 spec's deliverable C.
	 */
	ontologyAliases: string[];
	/**
	 * Anchored RegExp source matching one identifier from this ontology, or null.
	 * Recognition data only; moves into recipe JSON with the 2026-09-14 spec's
	 * deliverable C.
	 */
	idPattern: string | null;
	/** Declared source level names. */
	levels: string[];
	/** Tier 1 shape this recipe's leaf entry produces — lets the UI route crosswalk/junction sources distinctly. */
	routingKind: RegistryRoutingKind;
	/** Curated default destination folder offered by the wizard. */
	suggestedFolder: string;
	/** Curated, advisory Pass 1.5 enrichment recommendation for this shape (see module doc comment). */
	recommendedEnrichment: RecipeEnrichmentHint;
	/** Where a GRC team obtains the file this preset expects. Absent for a user's own spreadsheet. */
	sourceLink?: { label: string; url: string; note?: string };
	/** Docs page section explaining which export or sheet to use and the import gotchas. */
	docsUrl: string;
	/** Every `{column}` token the recipe references (normalized-compared at match). */
	signatureColumns: string[];
	/** Columns used by STRUCTURAL layout entries — a hard gate for a confident match. */
	requiredColumns: string[];
	/** Count of folder/heading layout entries — the recipe's nesting depth (tiebreak). */
	structuralDepth: number;
	/** Published display headers mapped to canonical recipe columns. */
	headerAliases?: Record<string, string[]>;
	/** The complete canonical recipe. Never trim this to workbench-only regions. */
	recipe: CrosswalkerImportRecipe;
}

/** Result of scoring one entry against a source. */
export interface RecipeMatch {
	entry: RecipeRegistryEntry;
	/** 0–100 recipe-coverage score (see `matchScore`). */
	score: number;
}

/**
 * Confident-match threshold. A recipe references exactly the columns it needs, so
 * a source presenting its required column(s) plus almost the whole of its
 * signature is almost certainly that export. Tuned to 90 against the real-world
 * corpus (see the module doc comment "THRESHOLD TUNING") — every genuine full
 * export found scored 100; two near-miss real-world sheets (a CIS "Change Log"
 * export and a narrower SCF subset) scored 75 and must NOT confidently match.
 * Below this we stay quiet and run ordinary detection.
 */
export const CONFIDENT_MATCH_THRESHOLD = 90;

/** Floor for `findRecognizedRecipes` to surface a partial (non-confident) candidate. */
export const CANDIDATE_FLOOR = 40;

// ============================================================================
// Signature extraction (pure)
// ============================================================================

/**
 * Extract the `{column}` tokens a template references (the path, before the
 * first filter). Thin wrapper over the shared tokenizer (contract R0) so a
 * quoted literal key (`{['A.B']}`) counts as ONE column named `A.B`, not two
 * dotted segments — the match signature and render() can no longer diverge.
 */
function templateColumns(template: string): string[] {
	const out: string[] = [];
	for (const segment of parseTemplateSegments(template)) {
		if (segment.kind !== 'interp') continue;
		const token = interpolationColumn(segment.interp).column;
		if (token) out.push(token);
	}
	return out;
}

/** Normalize a column name for tolerant comparison (mirrors config-manager fingerprinting). */
export function normalizeColumn(name: string): string {
	return name.toLowerCase().trim().replace(/[^a-z0-9]/g, '_');
}

/** Find the first registry ontology named by a case-insensitive header substring. */
export function ontologyForHeader(
	header: string,
	registry: RecipeRegistryEntry[],
): { ontology: string; entryId: string } | null {
	const normalizedHeader = header.toLowerCase();
	for (const entry of registry) {
		if (entry.ontologyAliases.some((alias) => containsHeaderAlias(normalizedHeader, alias.toLowerCase()))) {
			return { ontology: entry.ontology, entryId: entry.id };
		}
	}
	return null;
}

/** Require alphanumeric boundaries so short aliases such as CRI do not match "description". */
function containsHeaderAlias(header: string, alias: string): boolean {
	let from = 0;
	while (from <= header.length - alias.length) {
		const index = header.indexOf(alias, from);
		if (index === -1) return false;
		const before = index === 0 ? '' : header[index - 1];
		const afterIndex = index + alias.length;
		const after = afterIndex >= header.length ? '' : header[afterIndex];
		if ((before === '' || !/[a-z0-9]/.test(before)) && (after === '' || !/[a-z0-9]/.test(after))) {
			return true;
		}
		from = index + 1;
	}
	return false;
}

/** Group registry entries by ontology while preserving declaration order. */
export function entriesByOntology(registry: RecipeRegistryEntry[]): Map<string, RecipeRegistryEntry[]> {
	const grouped = new Map<string, RecipeRegistryEntry[]>();
	for (const entry of registry) {
		const entries = grouped.get(entry.ontology) ?? [];
		entries.push(entry);
		grouped.set(entry.ontology, entries);
	}
	return grouped;
}

/** All signature + required columns of a raw recipe. */
function deriveSignature(raw: RawRecipe): { signature: string[]; required: string[] } {
	const signature = new Set<string>();
	const required = new Set<string>();

	for (const entry of raw.target.layout ?? []) {
		const cols = templateColumns(entry.template);
		for (const c of cols) signature.add(c);
		// Structural entries (folder/file/heading) carry the identity — required.
		if (entry.mechanism === 'folder' || entry.mechanism === 'file' || entry.mechanism === 'heading') {
			for (const c of cols) required.add(c);
		}
	}

	const emit = raw.target.also_emit;
	if (emit) {
		for (const t of emit.tags ?? []) for (const c of templateColumns(t)) signature.add(c);
		for (const a of emit.aliases ?? []) for (const c of templateColumns(a)) signature.add(c);
		const managed = emit.frontmatter?.managed ?? {};
		for (const [key, tmpl] of Object.entries(managed)) {
			// Generation supplies these optional provenance defaults; their absence
			// must not prevent recognition of legacy crosswalk source columns.
			// Edge endpoint links are vault-derived, not source-file columns.
			if (key === 'mapping_set_id' || key === 'predicate_modifier'
				|| (raw.recipe === 'olir-crosswalk-edge' && (key === 'subject_note' || key === 'object_note'))) continue;
			for (const c of templateColumns(tmpl)) signature.add(c);
		}
		const managedLinks = emit.frontmatter?.managed_links ?? {};
		for (const spec of Object.values(managedLinks)) {
			for (const c of templateColumns(spec.template)) signature.add(c);
		}
		// Body projections consume source columns exactly as properties do. Where a
		// recipe author puts a column's prose (a YAML property vs a `## Description`
		// section) is a RENDERING choice; whether the source carries that column is a
		// SOURCE-SHAPE fact, and only the second is the matcher's business. Omitting
		// body columns made recognition depend on the first, which is how the Wave 2
		// prose-into-body rewrites silently shrank five signatures. Measured against
		// the local Frameworks/ corpus (357 parseable sheets, 2026-08-26): with body
		// columns OUT, four CIS "Change Log" sheets auto-matched
		// `cis-controls-v8-controls` at 100 (its signature had fallen to 2 columns);
		// with them IN, the corpus yields 8 confident matches and ZERO false
		// positives. See the `also_emit.body` note under THE MATCH SIGNATURE above.
		for (const body of emit.body ?? []) {
			for (const c of templateColumns(body.template)) signature.add(c);
		}
	}

	return { signature: [...signature], required: [...required] };
}

// ============================================================================
// Registry assembly
// ============================================================================

/** No-op enrichment hint — the default for shapes with no facet-worthy column. */
const NO_ENRICHMENT: RecipeEnrichmentHint = {
	childrenLists: false,
	facetNotes: 'none',
	rationale: 'No column in this shape groups rows into a small, meaningful set of facet values.',
};

/**
 * Curated per-recipe defaults keyed by recipe id (falls back to a generic default).
 * `label`/`description` feed the recognized-source card; `suggestedFolder` seeds
 * the wizard's destination field; `recommendedEnrichment` is advisory only (see
 * the module doc comment "CURATED DEFAULTS" — not applied to the recipe JSON).
 * All copy is plain language, sentence case, no em dashes (per UI-copy convention).
 */
const DEFAULTS: Record<
	string,
	{
		label: string;
		description: string;
		suggestedFolder: string;
		recommendedEnrichment: RecipeEnrichmentHint;
		ontologyAliases?: string[];
		idPattern?: string | null;
	}
> = {
	'nist-csf-2-cprt-hierarchical': {
		label: 'NIST CSF 2.0 (CPRT export, nested)',
		description: 'Functions and categories become folders; subcategories become notes.',
		suggestedFolder: 'Frameworks/NIST CSF 2.0',
		ontologyAliases: ['NIST CSF', 'CSF v2', 'CSF 2.0', 'CSF 2', 'Cybersecurity Framework'],
		idPattern: '^[A-Z]{2}\\.[A-Z]{2}-\\d{2}(\\.\\d{2})?$',
		recommendedEnrichment: {
			childrenLists: false,
			facetNotes: 'notes',
			facetField: 'function',
			rationale:
				'Six functions (GV/ID/PR/DE/RS/RC) is a clean, small facet: a hub note per function would gather every subcategory beneath it. Not turned on: the recipe emits `function` as plain frontmatter, not an also_emit.tags destination, so the facet pass has nothing to group by yet.',
		},
	},
	'nist-csf-2-cprt': {
		label: 'NIST CSF 2.0 (CPRT export)',
		description: 'Each CSF element becomes a note with its id, level, and description.',
		suggestedFolder: 'Frameworks/NIST CSF 2.0',
		ontologyAliases: ['NIST CSF', 'CSF v2', 'CSF 2.0', 'CSF 2', 'Cybersecurity Framework'],
		idPattern: '^[A-Z]{2}\\.[A-Z]{2}-\\d{2}(\\.\\d{2})?$',
		recommendedEnrichment: {
			childrenLists: false,
			facetNotes: 'notes',
			facetField: 'element_type',
			rationale:
				'This recipe emits function, category, and subcategory rows all at one level via `element_type`: a facet hub per level would let a reader jump to "all subcategories". Not turned on: `element_type` is plain frontmatter, not a tag destination.',
		},
	},
	'nist-csf-2-flat': {
		label: 'NIST CSF 2.0 (subcategories)',
		description: 'Each subcategory becomes a note.',
		suggestedFolder: 'Frameworks/NIST CSF 2.0',
		ontologyAliases: ['NIST CSF', 'CSF v2', 'CSF 2.0', 'CSF 2', 'Cybersecurity Framework'],
		idPattern: '^[A-Z]{2}\\.[A-Z]{2}-\\d{2}(\\.\\d{2})?$',
		recommendedEnrichment: NO_ENRICHMENT,
	},
	'mitre-attack-technique-flat': {
		label: 'MITRE ATT&CK techniques',
		description: 'Each technique becomes a note keyed by its technique id.',
		suggestedFolder: 'Frameworks/MITRE ATT&CK',
		ontologyAliases: ['ATT&CK', 'MITRE', 'ATTACK'],
		idPattern: '^T\\d{4}(\\.\\d{3})?$',
		recommendedEnrichment: {
			childrenLists: false,
			facetNotes: 'notes',
			facetField: 'tactic',
			rationale:
				'Grouping techniques by tactic (kill-chain phase) is the single most useful ATT&CK facet. Facet hub notes stay off, but the reasoning below is no longer why: as of 2026-08-26 the recipe binds the ATT&CK xlsx, which ships explicit clean `tactics` and `sub-technique of` columns, so the recipe now emits a `tactics` property and a real `parent` wikilink (453 of 656 techniques). The former blockers -- no tactic column in the STIX shape, and a naive prefix split self-referencing top-level techniques -- no longer apply. What still argues against hub notes is that a technique can carry several tactics and the grammar has no split-into-plain-array, so `tactics` lands as a comma-joined scalar rather than a facetable list.',
		},
	},
	'cis-controls-v8-controls': {
		label: 'CIS Controls v8 (controls)',
		description: 'Each CIS control becomes a note with its title and description.',
		suggestedFolder: 'Frameworks/CIS Controls v8',
		ontologyAliases: ['CIS Controls', 'CIS v8', 'CIS CSC', 'CIS'],
		idPattern: '^\\d{1,2}(\\.\\d{1,2})?$',
		recommendedEnrichment: NO_ENRICHMENT,
	},
	'cis-controls-v8-flat': {
		label: 'CIS Controls v8 (safeguards)',
		description: 'Each safeguard becomes a note with its control and implementation groups.',
		suggestedFolder: 'Frameworks/CIS Controls v8',
		ontologyAliases: ['CIS Controls', 'CIS v8', 'CIS CSC', 'CIS'],
		idPattern: '^\\d{1,2}(\\.\\d{1,2})?$',
		recommendedEnrichment: {
			childrenLists: false,
			facetNotes: 'notes',
			facetField: 'security_function',
			rationale:
				'Security Function (Govern/Identify/Protect/Detect/Respond/Recover) already rides along as plain frontmatter on every safeguard and is a clean, small facet. Not turned on: it is not yet an also_emit.tags destination.',
		},
	},
	'scf-2026-flat': {
		label: 'Secure Controls Framework (2026)',
		description: 'Each SCF control becomes a note with its domain and description.',
		suggestedFolder: 'Frameworks/Secure Controls Framework',
		ontologyAliases: ['SCF', 'Secure Controls Framework'],
		idPattern: '^[A-Z]{3}-\\d{2}(\\.\\d)?$',
		recommendedEnrichment: {
			childrenLists: false,
			facetNotes: 'notes',
			facetField: 'domain',
			rationale:
				'SCF Domain groups the (very long) control list into a manageable set of hub notes. Not turned on: `domain` is not yet an also_emit.tags destination.',
		},
	},
	'nist-800-53-r5-flat': {
		label: 'NIST 800-53 Rev 5',
		description: 'Each control becomes a note keyed by its identifier.',
		suggestedFolder: 'Frameworks/NIST 800-53',
		ontologyAliases: ['800-53', 'SP 800-53', 'NIST 800-53'],
		idPattern: '^[A-Z]{2}-\\d{1,2}(\\(\\d{1,2}\\))?$',
		recommendedEnrichment: {
			childrenLists: false,
			facetNotes: 'notes',
			facetField: 'family',
			rationale:
				'800-53 identifiers are family-prefixed (AC-2, AU-3, …); a facet hub per family (derivable via a split filter on `identifier`) would mirror the catalog\'s own structure. Not turned on: this recipe does not yet emit a `family` field at all, only `identifier` and `name`.',
		},
	},
	'nist-800-53-r5-nested': {
		label: 'NIST 800-53 Rev 5',
		description: 'Families become folders; controls become folder notes and enhancements become notes.',
		suggestedFolder: 'Frameworks/NIST 800-53',
		ontologyAliases: ['800-53', 'SP 800-53', 'NIST 800-53'],
		idPattern: '^[A-Z]{2}-\\d{1,2}(\\(\\d{1,2}\\))?$',
		recommendedEnrichment: {
			childrenLists: false,
			facetNotes: 'notes',
			facetField: 'family',
			rationale:
				'800-53 identifiers are family-prefixed (AC-2, AU-3, …). The nested recipe emits a family field and family folders, but no family concept notes; facet enrichment remains advisory until family identity and re-import semantics are designed.',
		},
	},
	'cri-profile-v2-2-flat': {
		label: 'CRI Profile v2.2',
		description: 'Each CRI Profile statement becomes a note.',
		suggestedFolder: 'Frameworks/CRI Profile',
		ontologyAliases: ['CRI Profile', 'CRI'],
		idPattern: '^[A-Z]{2}\\.[A-Z]{2}-\\d{2}\\.\\d{2}$',
		recommendedEnrichment: {
			childrenLists: false,
			facetNotes: 'notes',
			facetField: 'level',
			rationale:
				'`level` (Function/Category/Diagnostic Statement) already rides along as plain frontmatter and is a clean, small facet. Not turned on: it is not yet an also_emit.tags destination.',
		},
	},
	'cri-profile-v2-2-nested': {
		label: 'CRI Profile v2.2',
		description: 'Functions, categories, and subcategories become folder notes; diagnostic statements become notes.',
		suggestedFolder: 'Frameworks/CRI Profile',
		ontologyAliases: ['CRI Profile', 'CRI'],
		idPattern: '^[A-Z]{2}\\.[A-Z]{2}-\\d{2}\\.\\d{2}$',
		recommendedEnrichment: {
			childrenLists: false,
			facetNotes: 'notes',
			facetField: 'level',
			rationale:
				'`level` (Function/Category/Diagnostic Statement) already rides along as plain frontmatter and is a clean, small facet. Not turned on: it is not yet an also_emit.tags destination.',
		},
	},
	'olir-crosswalk-edge': {
		label: 'Crosswalk / mapping edges (OLIR-style)',
		description: 'Each mapping row becomes a linked edge between two framework elements.',
		suggestedFolder: '_crosswalker/mappings',
		recommendedEnrichment: {
			...NO_ENRICHMENT,
			rationale:
				'Crosswalk edges are meant to be browsed through the query/pivot layer (crosswalkerPivot Bases view), not through facet hub notes.',
		},
	},
	'nist-csf-2-withdrawal-lineage': {
		label: 'NIST CSF 2.0 withdrawal lineage',
		description:
			'Each withdrawn CSF v1.1 subcategory becomes an edge to the CSF 2.0 subcategory that replaced it, one edge per replacement.',
		suggestedFolder: '_crosswalker/mappings',
		recommendedEnrichment: {
			...NO_ENRICHMENT,
			rationale:
				'Lineage edges answer "what replaced this control", which the review report asks by walking the edges. Facet hub notes over the edges themselves would not answer it.',
		},
	},
	'evidence-junction-notes': {
		label: 'Evidence links (control to document)',
		description:
			'Bulk-import evidence links from a spreadsheet. Each row records one control, the document that evidences it, and how much of the control that document covers.',
		suggestedFolder: 'Evidence/Junctions',
		recommendedEnrichment: {
			...NO_ENRICHMENT,
			rationale:
				'Evidence links are read through coverage reports, which count controls rather than junctions, so facet hub notes over the junctions themselves would not answer the question anyone asks.',
		},
	},
};

const FRAMEWORK_DATA_SOURCES_URL =
	'https://cybersader.github.io/crosswalker/reference/framework-data-sources/';

/** Publisher-download and import-instruction links shown by the shared preset guide. */
const SOURCE_GUIDANCE: Record<
	string,
	{ sourceLink?: { label: string; url: string; note?: string }; docsUrl: string }
> = {
	'nist-csf-2-cprt-hierarchical': {
		sourceLink: { label: 'Get the CPRT export from NIST', url: 'https://csrc.nist.gov/projects/cprt' },
		docsUrl: `${FRAMEWORK_DATA_SOURCES_URL}#nist-csf-20`,
	},
	'nist-csf-2-cprt': {
		sourceLink: { label: 'Get the CPRT export from NIST', url: 'https://csrc.nist.gov/projects/cprt' },
		docsUrl: `${FRAMEWORK_DATA_SOURCES_URL}#nist-csf-20`,
	},
	'nist-csf-2-flat': {
		sourceLink: {
			label: 'Get the CSF 2.0 core workbook from NIST',
			url: 'https://www.nist.gov/cyberframework',
		},
		docsUrl: `${FRAMEWORK_DATA_SOURCES_URL}#nist-csf-20`,
	},
	'nist-csf-2-withdrawal-lineage': {
		sourceLink: {
			label: 'Get the CSF 2.0 core workbook from NIST',
			url: 'https://www.nist.gov/cyberframework',
			note: 'Derived from the core workbook.',
		},
		docsUrl: `${FRAMEWORK_DATA_SOURCES_URL}#withdrawal-lineage`,
	},
	'mitre-attack-technique-flat': {
		sourceLink: {
			label: 'Get the ATT&CK Excel export from MITRE',
			url: 'https://attack.mitre.org/resources/attack-data-and-tools/',
			note: 'Use the Excel export, not the STIX bundle.',
		},
		docsUrl: `${FRAMEWORK_DATA_SOURCES_URL}#mitre-attck-enterprise`,
	},
	'cis-controls-v8-controls': {
		sourceLink: {
			label: 'Get CIS Controls v8 from CIS',
			url: 'https://www.cisecurity.org/controls',
			note: 'Free registration required. Crosswalker does not distribute this file.',
		},
		docsUrl: `${FRAMEWORK_DATA_SOURCES_URL}#cis-controls-v812`,
	},
	'cis-controls-v8-flat': {
		sourceLink: {
			label: 'Get CIS Controls v8 from CIS',
			url: 'https://www.cisecurity.org/controls',
			note: 'Free registration required. Crosswalker does not distribute this file.',
		},
		docsUrl: `${FRAMEWORK_DATA_SOURCES_URL}#cis-controls-v812`,
	},
	'scf-2026-flat': {
		sourceLink: {
			label: 'Get the SCF workbook from the Secure Controls Framework',
			url: 'https://securecontrolsframework.com/scf-download/',
			note: 'Free download under the SCF terms of use.',
		},
		docsUrl: `${FRAMEWORK_DATA_SOURCES_URL}#secure-controls-framework-20261`,
	},
	'nist-800-53-r5-nested': {
		sourceLink: { label: 'Get SP 800-53 Rev. 5 from NIST', url: 'https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final' },
		docsUrl: `${FRAMEWORK_DATA_SOURCES_URL}#nist-sp-800-53-rev-5`,
	},
	'nist-800-53-r5-flat': {
		sourceLink: {
			label: 'Get SP 800-53 Rev. 5 from NIST',
			url: 'https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final',
		},
		docsUrl: `${FRAMEWORK_DATA_SOURCES_URL}#nist-sp-800-53-rev-5`,
	},
	'cri-profile-v2-2-nested': {
		sourceLink: { label: 'Get the CRI Profile from the Cyber Risk Institute', url: 'https://cyberriskinstitute.org/the-profile/', note: 'Free registration required. Crosswalker does not distribute this file.' },
		docsUrl: `${FRAMEWORK_DATA_SOURCES_URL}#cri-profile-v22`,
	},
	'cri-profile-v2-2-flat': {
		sourceLink: {
			label: 'Get the CRI Profile from the Cyber Risk Institute',
			url: 'https://cyberriskinstitute.org/the-profile/',
			note: 'Free registration required. Crosswalker does not distribute this file.',
		},
		docsUrl: `${FRAMEWORK_DATA_SOURCES_URL}#cri-profile-v22`,
	},
	'olir-crosswalk-edge': {
		sourceLink: {
			label: 'Get a crosswalk from the NIST OLIR catalog',
			url: 'https://csrc.nist.gov/projects/olir/informative-reference-catalog',
			note: 'Download an Informative Reference or Derived Relationship Mapping as a spreadsheet.',
		},
		docsUrl: `${FRAMEWORK_DATA_SOURCES_URL}#crosswalk-data-sources`,
	},
	'evidence-junction-notes': {
		docsUrl: FRAMEWORK_DATA_SOURCES_URL,
	},
};

/** NIST catalog workbook display headers mapped to the recipe's canonical source keys. */
export const NIST_CATALOG_HEADER_ALIASES: Record<string, string[]> = {
	identifier: ['Control Identifier', 'Control ID'],
	name: ['Control (or Enhancement) Name', 'Control (or Control Enhancement) Name', 'Control Name', 'Control or Enhancement Name'],
	control_text: ['Control Text'],
	discussion: ['Discussion'],
	related: ['Related Controls', 'Related Control'],
};

/** Registry aliases are opt-in for stack recognition, not global CSV auto-recognition. */
export function canonicalHeaderColumns(columns: string[], entry: RecipeRegistryEntry): string[] {
	const have = new Set(columns.map((column) => column.trim().toLowerCase()));
	return [...columns, ...Object.entries(entry.headerAliases ?? {}).flatMap(([canonical, aliases]) =>
		!columns.includes(canonical) && aliases.some((alias) => have.has(alias.toLowerCase()))
			? [canonical] : [])];
}

/** Preserve source columns while adding canonical keys consumed by recipe templates. */
export function applyHeaderAliases<T extends ParsedData>(data: T, entry: RecipeRegistryEntry): T {
	if (!entry.headerAliases) return data;
	const lookup = new Map(data.columns.map((column) => [column.trim().toLowerCase(), column]));
	const chosen = Object.entries(entry.headerAliases).flatMap(([canonical, aliases]) => {
		if (data.columns.includes(canonical)) return [];
		const actual = aliases.map((alias) => lookup.get(alias.toLowerCase())).find(Boolean);
		return actual ? [{ canonical, actual }] : [];
	});
	if (!chosen.length) return data;
	const mapRow = (row: Record<string, any>): Record<string, any> => {
		const mapped = { ...row };
		for (const { canonical, actual } of chosen) mapped[canonical] = row[actual] ?? '';
		return mapped;
	};
	const rows = Array.isArray(data.rows) ? data.rows.map(mapRow) : (async function* () {
		for await (const row of data.rows) yield mapRow(row);
	})();
	return { ...data, columns: [...data.columns, ...chosen.map(({ canonical }) => canonical)], rows };
}

/** Build a registry entry from a bundled raw recipe. */
function toEntry(raw: unknown): RecipeRegistryEntry {
	const r = raw as RawRecipe;
	const { signature, required } = deriveSignature(r);
	const meta = DEFAULTS[r.recipe] ?? {
		label: r.recipe,
		description: 'Bundled import recipe.',
		suggestedFolder: 'Frameworks',
		recommendedEnrichment: NO_ENRICHMENT,
	};
	const guidance = SOURCE_GUIDANCE[r.recipe] ?? { docsUrl: FRAMEWORK_DATA_SOURCES_URL };
	const structuralDepth = (r.target.layout ?? []).filter(
		(e) => e.mechanism === 'folder' || e.mechanism === 'heading',
	).length;
	return {
		id: r.recipe,
		label: meta.label,
		description: meta.description,
		ontology: r.source?.ontology ?? 'unknown',
		ontologyAliases: meta.ontologyAliases ?? [],
		idPattern: meta.idPattern ?? null,
		levels: r.source?.levels ?? [],
		routingKind: deriveRoutingKind(r),
		suggestedFolder: meta.suggestedFolder,
		recommendedEnrichment: meta.recommendedEnrichment,
		sourceLink: guidance.sourceLink,
		docsUrl: guidance.docsUrl,
		signatureColumns: signature,
		requiredColumns: required,
		...(r.recipe === 'nist-800-53-r5-flat' || r.recipe === 'nist-800-53-r5-nested'
			? { headerAliases: NIST_CATALOG_HEADER_ALIASES } : {}),
		structuralDepth,
		recipe: raw as CrosswalkerImportRecipe,
	};
}

/**
 * The recognized-source registry. Declaration order is the tiebreak for equal
 * scores, so richer/more-specific recipes (the nested CPRT export) are listed
 * before their flatter siblings.
 */
export const RECIPE_REGISTRY: RecipeRegistryEntry[] = [
	toEntry(nistCsf2CprtHierarchical),
	toEntry(nistCsf2Cprt),
	toEntry(nistCsf2Flat),
	toEntry(mitreAttackTechnique),
	toEntry(cisControlsV8Controls),
	toEntry(cisControlsV8Flat),
	toEntry(scf2026Flat),
	toEntry(nist80053Flat),
	toEntry(nist80053Nested),
	toEntry(criProfileV22),
	toEntry(criProfileV22Nested),
	toEntry(crosswalkEdge),
	toEntry(nistCsf2WithdrawalLineage),
	toEntry(evidenceJunctionNotes),
];

// ============================================================================
// Matching (pure, deterministic)
// ============================================================================

/**
 * Score how well a source matches one recipe, 0–100.
 *
 * Base = fraction of the recipe's SIGNATURE columns present in the source (the
 * recipe references exactly what it consumes, so this reads as "how much of what
 * this recipe needs does the source supply"). A recipe whose REQUIRED (structural)
 * columns are missing can never be confident — its score is capped at
 * `CANDIDATE_FLOOR - 1` so it never crosses the confident threshold, however many
 * incidental columns happen to overlap.
 *
 * Deterministic: depends only on the two column sets, never on row order. The
 * optional `sampleRows` argument is accepted for future value-pattern refinement
 * (e.g. verifying a nested recipe's id column actually carries its delimiter); the
 * v0.1 score is column-shape only.
 */
export function matchScore(
	entry: RecipeRegistryEntry,
	columns: string[],
	_sampleRows?: Record<string, unknown>[],
): number {
	if (entry.signatureColumns.length === 0) return 0;
	const have = new Set(columns.map(normalizeColumn));

	const matched = entry.signatureColumns.filter((c) => have.has(normalizeColumn(c))).length;
	const base = Math.round((matched / entry.signatureColumns.length) * 100);

	const requiredPresent = entry.requiredColumns.every((c) => have.has(normalizeColumn(c)));
	if (!requiredPresent) return Math.min(base, CANDIDATE_FLOOR - 1);

	return base;
}

/** Nested variants are chosen by the stack, never proposed for a generic dropped file. */
const STACK_ONLY_RECIPES = new Set(['nist-800-53-r5-nested', 'cri-profile-v2-2-nested']);

/** Exclude stack-specific variants from every generic source-discovery path. */
export function isGenericRecipe(entry: RecipeRegistryEntry): boolean {
	return !STACK_ONLY_RECIPES.has(entry.id);
}

/**
 * Score every registry entry against the source and return the candidates at or
 * above `CANDIDATE_FLOOR`, best first. Ties break by richer vault structure
 * (more folder/heading depth — a nested recipe beats its flat sibling), then more
 * signature columns (more specific), then registry declaration order. All
 * deterministic.
 */
export function findRecognizedRecipes(
	columns: string[],
	sampleRows?: Record<string, unknown>[],
): RecipeMatch[] {
	const scored: (RecipeMatch & { order: number })[] = RECIPE_REGISTRY.filter(isGenericRecipe).map((entry, order) => ({
		entry,
		score: matchScore(entry, columns, sampleRows),
		order,
	}));
	return scored
		.filter((m) => m.score >= CANDIDATE_FLOOR)
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			if (b.entry.structuralDepth !== a.entry.structuralDepth) {
				return b.entry.structuralDepth - a.entry.structuralDepth;
			}
			if (b.entry.signatureColumns.length !== a.entry.signatureColumns.length) {
				return b.entry.signatureColumns.length - a.entry.signatureColumns.length;
			}
			return a.order - b.order;
		})
		.map(({ entry, score }) => ({ entry, score }));
}

/** The single confident recognized recipe for a source, or null if none crosses the threshold. */
export function bestRecognizedRecipe(
	columns: string[],
	sampleRows?: Record<string, unknown>[],
): RecipeMatch | null {
	const best = findRecognizedRecipes(columns, sampleRows)[0];
	return best && best.score >= CONFIDENT_MATCH_THRESHOLD ? best : null;
}

// ============================================================================
// Recipe → mapping + shape summary (for the card)
// ============================================================================

/** Reconstruct the workbench mapping for a recognized recipe (round-trip law). */
export function recipeMapping(entry: RecipeRegistryEntry): ImportMapping {
	return canonicalToMapping(entry.recipe);
}

/**
 * A short, plain-language list of the vault shapes the recipe produces
 * ("folders", "properties", "tags", …) for the card's what-you-get line.
 * Deterministic order: folders, headings, tags, links, properties.
 */
export function summarizeRecipeShapes(entry: RecipeRegistryEntry): string[] {
	const shapes: string[] = [];
	const target = (entry.recipe as unknown as RawRecipe).target;
	const layout = target.layout ?? [];
	if (layout.some((e) => e.mechanism === 'folder')) shapes.push('folders');
	if (layout.some((e) => e.mechanism === 'heading')) shapes.push('headings');

	const emit = target.also_emit;
	if (emit) {
		if ((emit.tags ?? []).length > 0) shapes.push('tags');
		const managed = emit.frontmatter?.managed ?? {};
		const managedLinks = emit.frontmatter?.managed_links ?? {};
		const hasLink = Object.values(managed).some((t) => t.includes('[[')) || Object.keys(managedLinks).length > 0;
		if (hasLink) shapes.push('links');
		const hasProperty = Object.values(managed).some((t) => !t.includes('[['));
		if (hasProperty) shapes.push('properties');
	}
	return shapes;
}

/** Setup-only composition data. No mapping file is imported until a later phase. */
export const ATTACK_MAPPING_RELEASE = '16.1';

export interface MappingPreset {
	id: string;
	label: string;
	from: string;
	to: string;
	kind: 'from-slot' | 'built-in' | 'download';
	optional?: boolean;
	defaultSelected: boolean;
	source: string;
	expectedFile: string;
	publisherLink?: { label: string; url: string };
	/** Provenance/refresh landing page, never shown as a download for built-in data. */
	refreshSource?: { label: string; url: string };
	licenceNote?: string;
	versionNote?: string;
}

export const MAPPING_PRESETS: readonly MappingPreset[] = [
	{
		id: 'cri-csf', label: 'CRI Profile to NIST CSF 2.0', from: 'cri-profile', to: 'nist-csf-2',
		kind: 'from-slot', defaultSelected: true, source: 'Comes from the CRI Profile workbook.',
		expectedFile: 'From the CRI Profile file',
		licenceNote: 'CRI registration and licence terms apply. Crosswalker does not distribute this file.',
	},
	{
		id: 'csf-80053', label: 'NIST CSF 2.0 to NIST 800-53', from: 'nist-csf-2', to: 'nist-800-53',
		kind: 'built-in', defaultSelected: true, source: 'Built in. No download needed.',
		expectedFile: 'No download needed',
		versionNote: 'Derived from NIST OLIR data dated 2026-05-04. Refresh source: NIST Concept Crosswalk.',
		refreshSource: { label: 'NIST Concept Crosswalk', url: 'https://csrc.nist.gov/Projects/Cybersecurity-Framework/Filters' },
	},
	{
		id: 'cri-80053', label: 'CRI Profile to NIST 800-53 (direct)', from: 'cri-profile', to: 'nist-800-53',
		kind: 'download', optional: true, defaultSelected: false,
		source: 'Optional CRI mapping workbook. Local use only.', expectedFile: 'CRI mapping workbook',
		publisherLink: { label: 'Cyber Risk Institute', url: 'https://cyberriskinstitute.org/the-profile/' },
		licenceNote: 'CRI licence terms apply. Use locally; Crosswalker does not distribute this file.',
	},
	{
		id: '80053-attack', label: 'NIST 800-53 to MITRE ATT&CK', from: 'nist-800-53', to: 'mitre-attack',
		kind: 'download', defaultSelected: true, source: 'CTID Mappings Explorer download.',
		expectedFile: 'CTID mapping file',
		publisherLink: { label: 'CTID Mappings Explorer', url: 'https://center-for-threat-informed-defense.github.io/mappings-explorer/' },
		versionNote: `Mappings cover ATT&CK release ${ATTACK_MAPPING_RELEASE}.`,
	},
	{
		id: 'cri-attack', label: 'CRI Profile to MITRE ATT&CK', from: 'cri-profile', to: 'mitre-attack',
		kind: 'download', optional: true, defaultSelected: false,
		source: 'Optional CRI mapping workbook. Local use only.', expectedFile: 'CRI ATT&CK mapping workbook',
		publisherLink: { label: 'Cyber Risk Institute', url: 'https://cyberriskinstitute.org/the-profile/' },
		licenceNote: 'CRI licence terms apply. Use locally; Crosswalker does not distribute this file.',
	},
];

export const STACK_PRESETS = [
	{
		id: 'financial-services-threat-informed', label: 'Financial services, threat-informed',
		frameworks: ['cri-profile', 'mitre-attack', 'nist-800-53'] as readonly string[],
		detail: 'max' as const,
	},
] as const;
