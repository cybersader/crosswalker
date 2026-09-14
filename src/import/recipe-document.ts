import {
	canonicalStringify,
	computeRecipeDocumentDigest,
	computeRecipeHash,
} from '../generation/hash';
import type { CrosswalkerImportRecipe } from '../types/generated/recipe';
import { validateRecipe } from '../validation/validator';
import {
	fromRecipe,
	toRecipeRegions,
	type RecipeRegions,
} from './mapping/serialize';
import type { ImportMapping } from './mapping/types';
import { DEFAULT_MISSING } from './mapping/types';
import { interpolationColumn, parseTemplateSegments } from '../render/template';

export const CURRENT_RECIPE_SPEC = 'https://crosswalker.dev/spec/recipe.schema.json' as const;

export type RecipeDocumentOrigin = 'bundled' | 'user' | 'fresh' | 'legacy';
export type RecipeDiagnosticSeverity = 'warning' | 'blocking';

export interface RecipeDocumentDiagnostic {
	code: string;
	severity: RecipeDiagnosticSeverity;
	path: string;
	message: string;
}

export interface RecipeDocumentWarning extends RecipeDocumentDiagnostic {
	severity: 'warning';
}

export interface RecipeDocumentSession {
	selectedSourcePath?: string;
	selectedSourceHash?: string;
	verifiedSourceVersion?: string;
	sourceFingerprint?: string;
	configMatchScore?: number;
}

/**
 * Lossless boundary between the portable ImportRecipe and the workbench's
 * editable model. `original` remains the preservation authority; patching
 * always starts from a deep clone and replaces only workbench-owned regions.
 */
export interface RecipeDocument {
	original: CrosswalkerImportRecipe;
	mapping: ImportMapping;
	origin: RecipeDocumentOrigin;
	sourcePath?: string;
	session?: RecipeDocumentSession;
	/** Current schema/semantic/source/editable diagnostics for the session. */
	diagnostics: RecipeDocumentDiagnostic[];
	warnings: RecipeDocumentWarning[];
	dirty: boolean;
}

export interface RecipeDocumentOptions {
	origin: RecipeDocumentOrigin;
	sourcePath?: string;
	session?: RecipeDocumentSession;
	sourceColumns?: string[];
}

export type RecipeDocumentLoadResult =
	| { ok: true; document: RecipeDocument; diagnostics: RecipeDocumentDiagnostic[] }
	| { ok: false; diagnostics: RecipeDocumentDiagnostic[] };

export interface RecipePatchOptions {
	mapping?: ImportMapping;
	/**
	 * Optional final workbench regions after the demoted all-columns layer has
	 * been applied. The mapping remains the diagnostics authority.
	 */
	regions?: RecipeRegions;
}

export type RecipePatchResult =
	| {
			ok: true;
			recipe: CrosswalkerImportRecipe;
			diagnostics: RecipeDocumentDiagnostic[];
			dirty: boolean;
	  }
	| { ok: false; diagnostics: RecipeDocumentDiagnostic[]; dirty: boolean };

/** Validate unknown JSON, normalize it, and construct the editable document. */
export function loadRecipeDocument(
	input: unknown,
	options: RecipeDocumentOptions,
): RecipeDocumentLoadResult {
	const validation = validateRecipe(input);
	if (!validation.valid) {
		return {
			ok: false,
			diagnostics: validation.errors.map((message, index) => ({
				code: 'schema-invalid',
				severity: 'blocking' as const,
				path: validation.rawErrors?.[index]?.instancePath || '(root)',
				message,
			})),
		};
	}

	const original = normalizeRecipe(input as CrosswalkerImportRecipe);
	const diagnostics = [
		...diagnoseCanonicalRecipe(original),
		...diagnoseSourceCompatibility(original, options.sourceColumns, options.session?.verifiedSourceVersion),
	];
	const warnings = diagnostics.filter(
		(diagnostic): diagnostic is RecipeDocumentWarning => diagnostic.severity === 'warning',
	);

	return {
		ok: true,
		diagnostics,
		document: {
			original,
			mapping: canonicalToMapping(original),
			origin: options.origin,
			...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
			...(options.session ? { session: deepClone(options.session) } : {}),
			diagnostics,
			warnings,
			dirty: false,
		},
	};
}

/**
 * Create a complete deterministic canonical draft for a fresh detection
 * session. It is in-memory only; persistence/browser UI remains out of scope.
 */
export function createFreshRecipeDocument(
	mapping: ImportMapping,
	sourceOntology: string,
	options: Omit<RecipeDocumentOptions, 'origin'> = {},
): RecipeDocumentLoadResult {
	let regions: RecipeRegions;
	try {
		regions = toRecipeRegions(mapping);
	} catch (error) {
		return {
			ok: false,
			diagnostics: [{
				code: 'mapping-invalid',
				severity: 'blocking',
				path: 'mapping',
				message: error instanceof Error ? error.message : String(error),
			}],
		};
	}

	if (regions.layout.length === 0) {
		regions.layout.push({ level: 'leaf', mechanism: 'file', template: '{row}.md' });
	}
	const levels = unique(regions.layout.map((entry) => entry.level));
	const ontology = slug(sourceOntology) || 'source';
	const canonical: CrosswalkerImportRecipe = {
		recipe: `custom-${ontology}`,
		spec_version: CURRENT_RECIPE_SPEC,
		source: { ontology, levels: levels as [string, ...string[]] },
		target: regions as CrosswalkerImportRecipe['target'],
	};
	return loadRecipeDocument(canonical, { ...options, origin: 'fresh' });
}

/** Convert a validated canonical recipe into the workbench's editable model. */
export function canonicalToMapping(recipe: CrosswalkerImportRecipe): ImportMapping {
	const editableTarget = {
		...deepClone(recipe.target),
		// Deferred layout mechanisms stay in `original` and produce blocking
		// diagnostics. fromRecipe only receives mechanisms it can model safely.
		layout: recipe.target.layout.filter((entry) =>
			entry.mechanism === 'folder' || entry.mechanism === 'file' || entry.mechanism === 'heading'),
	};
	return fromRecipe(
		{ target: editableTarget as RecipeRegions },
		{ preserveCanonicalOrder: true },
	);
}

/**
 * Patch only workbench-owned recipe regions. A blocked result never returns a
 * lossy/coerced canonical recipe.
 */
export function patchRecipeDocument(
	document: RecipeDocument,
	options: RecipePatchOptions = {},
): RecipePatchResult {
	const mapping = options.mapping ?? document.mapping;
	const diagnostics = uniqueDiagnostics([
		...document.diagnostics,
		...diagnoseCanonicalRecipe(document.original),
		...diagnoseEditableMapping(mapping),
	]);
	if (diagnostics.some((diagnostic) => diagnostic.severity === 'blocking')) {
		return { ok: false, diagnostics, dirty: true };
	}

	let regions: RecipeRegions;
	try {
		regions = options.regions ? deepClone(options.regions) : toRecipeRegions(mapping);
	} catch (error) {
		diagnostics.push({
			code: 'mapping-invalid',
			severity: 'blocking',
			path: 'mapping',
			message: error instanceof Error ? error.message : String(error),
		});
		return { ok: false, diagnostics, dirty: true };
	}

	const original = normalizeRecipe(document.original);
	const patched = deepClone(original);
	patchOwnedRegions(patched, regions, original);
	let normalized = normalizeRecipe(patched);
	const dirty = !recipesSemanticallyEqual(original, normalized);

	if (!dirty) {
		return { ok: true, recipe: original, diagnostics, dirty: false };
	}

	if (document.origin !== 'fresh') {
		normalized.recipe = `${original.recipe}-custom`;
		normalized.metadata = {
			...(normalized.metadata ?? {}),
			based_on: {
				recipe: original.recipe,
				hash: computeRecipeHash(original.target, original.source),
				recipe_document_digest: computeRecipeDocumentDigest(original),
				spec_version: original.spec_version ?? CURRENT_RECIPE_SPEC,
			},
		};
	}

	const validation = validateRecipe(normalized);
	const patchedDiagnostics: RecipeDocumentDiagnostic[] = validation.valid
		? diagnoseCanonicalRecipe(normalized)
		: validation.errors.map((message, index) => ({
			code: 'patched-schema-invalid',
			severity: 'blocking' as const,
			path: validation.rawErrors?.[index]?.instancePath || '(root)',
			message,
		}));
	if (!validation.valid || patchedDiagnostics.some((diagnostic) => diagnostic.severity === 'blocking')) {
		return {
			ok: false,
			dirty: true,
			diagnostics: [...diagnostics, ...patchedDiagnostics],
		};
	}

	return { ok: true, recipe: normalized, diagnostics, dirty: true };
}

/** Return a document snapshot with current mapping/dirty state, preserving original. */
export function updateRecipeDocumentMapping(
	document: RecipeDocument,
	mapping: ImportMapping,
	regions?: RecipeRegions,
): RecipeDocument {
	const patched = patchRecipeDocument(document, { mapping, ...(regions ? { regions } : {}) });
	return {
		...document,
		mapping,
		diagnostics: patched.diagnostics,
		dirty: patched.dirty,
		warnings: patched.diagnostics.filter(
			(diagnostic): diagnostic is RecipeDocumentWarning => diagnostic.severity === 'warning',
		),
	};
}

/** Normalize runtime defaults that participate in semantic equality. */
export function normalizeRecipe(recipe: CrosswalkerImportRecipe): CrosswalkerImportRecipe {
	const out = deepClone(recipe);
	out.spec_version ??= CURRENT_RECIPE_SPEC;
	out.target.linkStyle ??= 'absolute';
	for (const entry of out.target.layout) {
		if (entry.mechanism === 'folder' && entry.variadic) {
			entry.variadic.segment ??= 'prefix';
			entry.variadic.drop_last ??= true;
			entry.variadic.max_depth ??= 6;
			entry.variadic.on_overflow ??= 'truncate';
		}
	}
	for (const body of out.target.also_emit?.body ?? []) {
		body.position ??= 'append';
		body.format ??= 'text';
		body.omit_if_empty ??= true;
		if (body.position === 'section') body.heading_depth ??= 2;
	}
	return out;
}

export function recipesSemanticallyEqual(
	left: CrosswalkerImportRecipe,
	right: CrosswalkerImportRecipe,
): boolean {
	return canonicalStringify(normalizeRecipe(left)) === canonicalStringify(normalizeRecipe(right));
}

/** Sorted, two-space canonical JSON bytes plus a final newline. */
export function serializeCanonicalRecipe(recipe: CrosswalkerImportRecipe): string {
	return `${JSON.stringify(sortCanonical(normalizeRecipe(recipe)), null, 2)}\n`;
}

/** Diagnostics for canonical semantics and deferred runtime fields. */
export function diagnoseCanonicalRecipe(recipe: CrosswalkerImportRecipe): RecipeDocumentDiagnostic[] {
	const diagnostics: RecipeDocumentDiagnostic[] = [];
	const levels = new Set(recipe.source.levels);
	let hasLeaf = false;
	for (const [index, entry] of recipe.target.layout.entries()) {
		if (!levels.has(entry.level)) {
			diagnostics.push({
				code: 'layout-level-undeclared',
				severity: 'blocking',
				path: `target.layout.${index}.level`,
				message: `Layout level "${entry.level}" is not declared in source.levels.`,
			});
		}
		if (entry.mechanism === 'file' || entry.mechanism === 'heading') hasLeaf = true;
		if (entry.mechanism === 'tag' || entry.mechanism === 'wikilink') {
			diagnostics.push({
				code: 'layout-mechanism-deferred',
				severity: 'blocking',
				path: `target.layout.${index}.mechanism`,
				message: `${entry.mechanism} layout output is not executable in this workbench yet.`,
			});
		}
	}
	if (!hasLeaf) {
		diagnostics.push({
			code: 'missing-leaf-output',
			severity: 'blocking',
			path: 'target.layout',
			message: 'Recipe must contain a file or heading leaf output.',
		});
	}
	if (recipe.target.graph_edges && recipe.target.graph_edges.length > 0) {
		diagnostics.push({
			code: 'graph-edges-deferred',
			severity: 'warning',
			path: 'target.graph_edges',
			message: 'Graph edges are preserved, but the current runtime does not execute them.',
		});
	}
	if (recipe.target.linkStyle === 'shortest') {
		diagnostics.push({
			code: 'shortest-links-deferred',
			severity: 'warning',
			path: 'target.linkStyle',
			message: 'Shortest link style is preserved, but the current runtime uses absolute links.',
		});
	}
	return diagnostics;
}

/** Explicitly reject every editable state with no lossless canonical surface. */
export function diagnoseEditableMapping(mapping: ImportMapping): RecipeDocumentDiagnostic[] {
	const diagnostics: RecipeDocumentDiagnostic[] = [];
	if (mapping.filters && mapping.filters.length > 0) {
		diagnostics.push(blocking(
			'row-filters-not-portable',
			'mapping.filters',
			'Row filters are not portable in import recipes yet. Remove them before applying this recipe.',
		));
	}

	for (const [mappingIndex, structure] of mapping.mappings.entries()) {
		for (const [levelIndex, level] of structure.levels.entries()) {
			const path = `mapping.mappings.${mappingIndex}.levels.${levelIndex}`;
			if (level.missing !== DEFAULT_MISSING) {
				diagnostics.push(blocking(
					'missing-policy-not-portable',
					`${path}.missing`,
					'Only the default Skip missing-value policy is portable in import recipes.',
				));
			}
			if (level.materialize) {
				diagnostics.push(blocking(
					'materialize-not-portable',
					`${path}.materialize`,
					'Materialized level notes are not portable in import recipes yet.',
				));
			}
			if (typeof level.naming === 'object') {
				diagnostics.push(blocking(
					'naming-lookup-not-portable',
					`${path}.naming`,
					'Lookup-based naming is not portable in import recipes yet.',
				));
			}
			for (const [destinationIndex, destination] of level.destinations.entries()) {
				const destPath = `${path}.destinations.${destinationIndex}`;
				if (destination.primitive === 'note') {
					diagnostics.push(blocking(
						'note-destination-not-portable',
						destPath,
						'Level note output is not portable in import recipes yet.',
					));
				} else if (destination.primitive === 'body') {
					if (destination.position === 'table-row') {
						diagnostics.push(blocking(
							'body-table-row-not-portable',
							destPath,
							'Table-row body output is not portable yet. Choose Section or Append.',
						));
					}
					if (destination.transform?.trim()) {
						diagnostics.push(blocking(
							'body-transform-not-portable',
							destPath,
							'Legacy body transforms are not portable yet. Use recipe template filters instead.',
						));
					}
				} else if (destination.primitive === 'link') {
					if (destination.predicate || destination.direction !== 'parent-on-child') {
						diagnostics.push(blocking(
							'link-semantics-not-portable',
							destPath,
							'This link predicate or direction cannot be represented losslessly in a portable import recipe.',
						));
					}
				} else if (destination.primitive === 'property' && destination.list) {
					diagnostics.push(blocking(
						'property-list-not-portable',
						destPath,
						'List-valued property output cannot be represented losslessly in a portable import recipe yet.',
					));
				}
			}
		}
	}
	return diagnostics;
}

/** Source-column/version checks used when parsed source facts are available. */
export function diagnoseSourceCompatibility(
	recipe: CrosswalkerImportRecipe,
	columns?: string[],
	verifiedVersion?: string,
): RecipeDocumentDiagnostic[] {
	const diagnostics: RecipeDocumentDiagnostic[] = [];
	if (columns) {
		const available = new Set(columns);
		for (const column of referencedColumns(recipe)) {
			if (!available.has(column)) {
				diagnostics.push(blocking(
					'source-column-missing',
					'source',
					`The selected source does not contain recipe column "${column}".`,
				));
			}
		}
	}
	if (verifiedVersion && recipe.source.version && verifiedVersion !== recipe.source.version) {
		diagnostics.push({
			code: 'source-version-mismatch',
			severity: 'warning',
			path: 'source.version',
			message: `Recipe declares source version "${recipe.source.version}", but the selected source reports "${verifiedVersion}".`,
		});
	}
	return diagnostics;
}

function patchOwnedRegions(
	patched: CrosswalkerImportRecipe,
	regions: RecipeRegions,
	original: CrosswalkerImportRecipe,
): void {
	const originalLeafKind = [...original.target.layout]
		.reverse()
		.find((entry) => entry.kind)?.kind;
	const layout = deepClone(regions.layout) as CrosswalkerImportRecipe['target']['layout'];
	if (originalLeafKind) {
		const leaf = [...layout].reverse().find((entry) =>
			entry.mechanism === 'file' || entry.mechanism === 'heading');
		if (leaf) leaf.kind = originalLeafKind;
	}
	patched.target.layout = layout;
	// Layout level ids are editor-owned alongside the layout itself. Keep the
	// canonical source declaration synchronized so a legitimate workbench level
	// edit cannot produce a self-invalid recipe with undeclared levels.
	patched.source.levels = unique(layout.map((entry) => entry.level)) as [string, ...string[]];

	if (regions.also_emit) {
		patched.target.also_emit = deepClone(regions.also_emit) as CrosswalkerImportRecipe['target']['also_emit'];
	}
	else delete patched.target.also_emit;
	if (regions.enrichment) patched.target.enrichment = deepClone(regions.enrichment);
	else delete patched.target.enrichment;
}

function referencedColumns(recipe: CrosswalkerImportRecipe): string[] {
	const columns = new Set<string>();
	// Shared tokenizer (contract R0) — a quoted literal key (`{['A.B']}`) is ONE
	// column named `A.B`, matching what render() and the match signature see.
	const collect = (template: string): void => {
		for (const segment of parseTemplateSegments(template)) {
			if (segment.kind !== 'interp') continue;
			const column = interpolationColumn(segment.interp).column;
			if (column) columns.add(column);
		}
	};
	for (const entry of recipe.target.layout) collect(entry.template);
	for (const template of recipe.target.also_emit?.tags ?? []) collect(template);
	for (const template of recipe.target.also_emit?.aliases ?? []) collect(template);
	for (const template of Object.values(recipe.target.also_emit?.frontmatter?.managed ?? {})) collect(template);
	for (const link of Object.values(recipe.target.also_emit?.frontmatter?.managed_links ?? {})) collect(link.template);
	for (const body of recipe.target.also_emit?.body ?? []) collect(body.template);
	for (const edge of recipe.target.graph_edges ?? []) {
		collect(edge.from);
		collect(edge.via);
		collect(edge.to);
	}
	return [...columns];
}

function blocking(code: string, path: string, message: string): RecipeDocumentDiagnostic {
	return { code, severity: 'blocking', path, message };
}

function uniqueDiagnostics(diagnostics: RecipeDocumentDiagnostic[]): RecipeDocumentDiagnostic[] {
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = JSON.stringify([diagnostic.code, diagnostic.path, diagnostic.message]);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function deepClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function sortCanonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortCanonical);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, child]) => child !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, sortCanonical(child)]),
		);
	}
	return value;
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function slug(value: string): string {
	return value
		.toLowerCase()
		.replace(/\.[a-z0-9]+$/i, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

