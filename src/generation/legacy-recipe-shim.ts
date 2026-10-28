/**
 * legacy-recipe-shim.ts — Phase-0 compatibility shim
 *
 * Translates a v0.1.0 column-role `ImportRecipe` (the legacy shape with
 * mapping.hierarchy / mapping.frontmatter / mapping.filename) into a Ch 22
 * `Recipe` shape (target.layout with folder/file mechanisms +
 * also_emit.frontmatter.managed).
 *
 * Per Ch 22 §10.7, four-phase migration plan:
 *   - Phase 0 (this shim, v0.1.3): legacy recipes still load; translated at
 *     the engine boundary
 *   - Phase 1 (v0.2): both forms accepted; new form preferred
 *   - Phase 2 (v0.5): legacy form deprecated
 *   - Phase 3 (post-v1.0): legacy form removed
 *
 * Pure function. Output is structurally identical for identical inputs.
 */

import type { ImportRecipe as LegacyImportRecipe } from '../types/config';
import type { BodyProjection, Recipe } from '../render';
import { pathTextFor } from '../render/template';

/**
 * Convert a legacy v0.1.0 ImportRecipe to a Ch 22 Recipe.
 *
 * Mapping rules:
 *   - mapping.hierarchy → ordered folder mechanisms (sorted by level)
 *     Each hierarchy entry produces `{ mechanism: 'folder', template: '{<column>}' }`
 *   - mapping.filename → leaf file mechanism using the filename's column or template
 *   - mapping.frontmatter → also_emit.frontmatter.managed entries
 *     (key → `{<column>|optional}` by default; explicit omitIfEmpty:false keeps
 *     `{<column>}` strict; transforms still happen via the engine's formatValue
 *     helper since render's filter set is closed)
 *   - mapping.body → also_emit.body section/append projections, all or
 *     nothing (see legacyBodyToProjections)
 */
/**
 * Pass 1.5 batch enrichment defaults for the classic (non-workbench) wizard
 * path. Mirrors `PRESET_ENRICHMENT_DEFAULTS['browsable-framework']` in
 * `src/import/mapping/presets.ts` — the uniformity promise (CHANGELOG
 * "children lists, facet hub notes, edgeCount" ships on BOTH generation entry
 * points) otherwise silently breaks for classic-mode imports, since
 * `generateNotes` only runs `applyEnrichment` when `recipe.target.enrichment`
 * is present (see generation-engine.ts `enrichmentEnabled`). `facet_notes:
 * 'notes'` is a harmless no-op today (the classic `MappingConfig` has no tag
 * role yet, so `facetMembershipsFromTags` never has tags to split — see
 * generation-engine.ts's `facetsForRow` fallback), but `children_lists` is
 * live wherever a classic config maps a `parent` link column, and future tag
 * support inherits the wiring for free.
 */
/**
 * AM-1 (2026-08-30). The placeholder identity values this shim mints when a
 * classic (non-workbench) import carries no config name. Defined HERE, at the
 * single site that mints them, because the wizard has to recognise them to
 * exclude them from import-set matching: a copy of these literals in the wizard
 * is a copy that drifts, and the day it drifts the exclusion silently stops
 * working and every classic import pairs with every other one again.
 *
 * Failure mode prevented: a placeholder read as an identity. `unknown` and
 * `legacy-config` are stamped on EVERY nameless classic import, so treating
 * them as facts makes any two unrelated classic imports look like the same
 * source, and the second import is then attributed to the first one's set.
 */
export const LEGACY_ONTOLOGY_SENTINEL = 'unknown';
export const LEGACY_RECIPE_ID_SENTINEL = 'legacy-config';

/** Every identity value that means "nobody told us", in mint order. */
export const IDENTITY_SENTINELS: readonly string[] = [
	LEGACY_ONTOLOGY_SENTINEL,
	LEGACY_RECIPE_ID_SENTINEL,
];

/**
 * AM-1. The real ontology a nameless classic import stamps going forward: the
 * source file's stem. A fact the source actually carries, the same way the
 * workbench path carries `sourceOntology` -- as opposed to the sentinel, which
 * carries nothing and therefore cannot distinguish two sources.
 *
 * Returns null when there is no usable stem, so the caller falls back to the
 * sentinel rather than inventing an ontology out of an empty string.
 */
export function sourceStemOntology(sourceFileName: string | null | undefined): string | null {
	if (typeof sourceFileName !== 'string') return null;
	// Strip the directory (a caller may pass a vault path, not just a name) and
	// the final extension only: `nist.800-53.csv` keeps `nist.800-53`.
	const base = sourceFileName.split('/').pop() ?? '';
	const stem = base.replace(/\.[^.]+$/, '').trim();
	return stem.length > 0 ? stem : null;
}

const LEGACY_DEFAULT_ENRICHMENT: NonNullable<Recipe['target']['enrichment']> = {
	children_lists: true,
	facet_notes: 'notes',
	parent_note: 'sibling',
};

export function legacyConfigToRecipe(
	config: LegacyImportRecipe,
	/**
	 * AM-1. The source this config was built from, used ONLY to fill
	 * `source.ontology` when the config has no name. Optional so every existing
	 * caller keeps its behaviour; a caller that omits it gets the sentinel.
	 */
	options?: { sourceFileName?: string | null },
): Recipe {
	const layout: Recipe['target']['layout'] = [];

	// 1. Hierarchy → folder mechanisms (sorted by level)
	const hierarchy = config.mapping?.hierarchy ?? [];
	if (hierarchy.length > 0) {
		const sorted = [...hierarchy].sort((a, b) => a.level - b.level);
		for (const h of sorted) {
			layout.push({
				level: `hierarchy-${h.level}`,
				mechanism: 'folder',
				// An explicit template (e.g. `{id|split(.,0)}` for id-derived
				// folder trees) wins; otherwise the whole column value is the segment.
				template: h.template ?? `{${h.column}}`,
			});
		}
	}

	// 2. Filename → file mechanism (leaf)
	// If config.mapping.filename has a template like "{title}.md", use that.
	// If just a column, use {<column>}.md
	const filenameTemplate = resolveFilenameTemplate(config);
	layout.push({
		level: 'leaf',
		mechanism: 'file',
		template: filenameTemplate,
	});

	// 3. Frontmatter mappings → also_emit.frontmatter.managed
	const managed: Record<string, string> = {};
	const fm = config.mapping?.frontmatter ?? [];
	for (const entry of fm) {
		managed[entry.key] = entry.omitIfEmpty === false
			? `{${entry.column}}`
			: `{${entry.column}|optional}`;
	}

	// 4. Body columns → also_emit.body (see legacyBodyToProjections).
	const body = legacyBodyToProjections(config);

	// AM-1. Ontology precedence: the config's own name, else the source file
	// stem, else the sentinel. The recipe id keeps its sentinel -- AM-1 changes
	// what a classic import calls its ONTOLOGY, not what it calls its recipe,
	// and the matching exclusion covers the recipe id instead.
	const ontology = config.name
		?? sourceStemOntology(options?.sourceFileName)
		?? LEGACY_ONTOLOGY_SENTINEL;

	return {
		recipe: config.name ?? LEGACY_RECIPE_ID_SENTINEL,
		source: {
			ontology,
			levels: [...hierarchy.map((_, i) => `hierarchy-${i}`), 'leaf'],
		},
		target: {
			layout,
			also_emit: Object.keys(managed).length > 0 || body.length > 0
				? {
					...(Object.keys(managed).length > 0 ? { frontmatter: { managed } } : {}),
					...(body.length > 0 ? { body } : {}),
				}
				: undefined,
			enrichment: LEGACY_DEFAULT_ENRICHMENT,
		},
	};
}

/**
 * Translate the classic `mapping.body` columns into canonical
 * `also_emit.body` projections, so the recipe a classic import keeps says
 * what the import wrote and the recipe-aware CSV export can read those
 * columns back.
 *
 * Shape (mirrors the legacy writer in generation-engine.ts `buildNoteData`):
 *   - a truthy `heading` → `position: 'section'` at the default depth 2
 *     (the legacy writer emits `## <heading>`)
 *   - no heading (or '') → `position: 'append'`
 *   - `format` copied unless it is the default `text`
 *   - template `{<column>|optional}`: legacy skips a missing or empty value,
 *     which is `|optional` plus the default `omit_if_empty: true`. The column
 *     is written bare when it can be, quoted (`['...']`) when it cannot.
 *
 * All or nothing. The engine turns the legacy body writer off entirely once a
 * recipe declares any canonical body, so a mix is impossible. The canonical
 * form is emitted only when EVERY body column can be expressed; otherwise
 * none is, and the legacy writer keeps producing today's output (those notes
 * export their body columns as omitted, as before). Not expressible:
 *   - a column with a legacy `transform` (the canonical schema excludes legacy
 *     transforms; RecipeDocument blocks them as `body-transform-not-portable`).
 *     The legacy writer never applied body transforms, but a recipe that
 *     silently dropped the declared intent would misdescribe the config.
 *   - a heading-less column when any link is also written to the body: the
 *     engine places link sections first (legacy order), so the append text no
 *     longer leads the body and could not be cut back out on export.
 *   - a body heading equal to a body-link section heading: export finds
 *     sections by heading text, so the two would be confused.
 */
export function legacyBodyToProjections(config: LegacyImportRecipe): BodyProjection[] {
	const entries = config.mapping?.body ?? [];
	if (entries.length === 0) return [];
	const bodyLinks = (config.mapping?.links ?? []).filter(
		(link) => link.location === 'body' || link.location === 'both',
	);
	const linkHeadings = new Set(bodyLinks.map((link) => link.bodySection || 'Related'));
	for (const entry of entries) {
		if ((entry.transform?.length ?? 0) > 0) return [];
		if (!entry.heading && bodyLinks.length > 0) return [];
		if (entry.heading && linkHeadings.has(entry.heading)) return [];
	}
	return entries.map((entry): BodyProjection => {
		const template = `{${pathTextFor(entry.column)}|optional}`;
		const format = entry.format && entry.format !== 'text' ? { format: entry.format } : {};
		return entry.heading
			? { template, position: 'section', heading: entry.heading, ...format }
			: { template, position: 'append', ...format };
	});
}

/**
 * Resolve the filename template for the leaf-bearing file entry.
 *
 * Falls back through several strategies (mirrors generation-engine's existing
 * `buildNoteData` filename-resolution logic):
 *   1. Explicit filename template if config.mapping.filename.template is set
 *   2. First frontmatter column as a last resort (template = `{<column>}.md`)
 *   3. `{id}.md` convention; engine will catch the missing-var error
 */
function resolveFilenameTemplate(config: LegacyImportRecipe): string {
	const filenameConfig = config.mapping?.filename;

	if (filenameConfig?.template) {
		// Existing template — pass through but ensure .md suffix
		const t = filenameConfig.template;
		return t.endsWith('.md') ? t : `${t}.md`;
	}

	// Fall back to first frontmatter column
	const fm = config.mapping?.frontmatter;
	if (fm && fm.length > 0) {
		return `{${fm[0].column}}.md`;
	}

	// Fall back to `id` column convention; engine will catch the missing-var error
	return `{id}.md`;
}
