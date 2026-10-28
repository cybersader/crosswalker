/**
 * recipe-loader.ts — Phase 4a foundation module.
 *
 * Loads recipes from two sources for the Phase 4 picker UX:
 *   1. **Shipped recipes** — the 6 reference recipes in `recipes/v0-1/*.json`,
 *      embedded into main.js at build time via static ES module imports.
 *      Always available; no vault dependency.
 *   2. **User recipes** — `.json` files under `_crosswalker/recipes/` in the
 *      vault, loaded at runtime via `app.vault.adapter.read()`. Optional.
 *
 * Architectural commitment #5 (runtime-agnostic recipe schema): every
 * recipe — shipped OR user-authored — flows through AJV validation
 * (`validateRecipe`). The loader never trusts disk; rejects invalid recipes
 * with structured errors. Phase 4 picker dispatches on `query.shape` STRING
 * value from validated JSON, not on TS discriminated unions — so a future
 * `cards` shape (v0.2) doesn't need loader code changes.
 */

import { App, TFolder, TFile } from 'obsidian';
import type { DebugLog } from '../utils/debug';
import { validateRecipe } from '../validation/validator';

// Static imports — bundled at build time. Adding a new shipped recipe means
// (a) drop a JSON file in `recipes/v0-1/`, (b) add an import + entry below.
// Per commitment #5, the picker reads `query.shape` from JSON at runtime;
// adding a new shape never requires picker code changes — only adding a new
// recipe import here changes the shipped catalog.
import coverageMatrix from '../../recipes/v0-1/coverage-matrix.json';
import crosswalkDensity from '../../recipes/v0-1/crosswalk-density.json';
import orphanControls from '../../recipes/v0-1/orphan-controls.json';
import hierarchyView from '../../recipes/v0-1/hierarchy-view.json';
import listView from '../../recipes/v0-1/list-view.json';
import mitreCoverage from '../../recipes/v0-1/mitre-coverage.json';

const SHIPPED_RECIPES: ReadonlyArray<Record<string, unknown>> = [
	coverageMatrix as Record<string, unknown>,
	crosswalkDensity as Record<string, unknown>,
	orphanControls as Record<string, unknown>,
	hierarchyView as Record<string, unknown>,
	listView as Record<string, unknown>,
	mitreCoverage as Record<string, unknown>,
];

// User recipes live here. Same gitignored folder as other plugin-emitted
// files (per Phase 3 design); user-authored .json files are not gitignored
// from the user's perspective — they're just inside the gitignored test-vault
// path. The plugin reads them via the Obsidian Vault API.
const USER_RECIPES_DIR = '_crosswalker/recipes';

/**
 * One loaded + validated recipe + its provenance.
 */
export interface LoadedRecipe {
	/** Stable ID — the JSON's `recipe` field. */
	id: string;
	/** Origin — affects display in picker ("shipped" vs "user"). */
	source: 'shipped' | 'user';
	/** The raw recipe JSON, already AJV-validated. */
	recipe: Record<string, unknown>;
	/** Display title — pulled from `query.title` if present, else `recipe` ID. */
	title: string;
	/** Display description — pulled from `query.description` if present, else empty. */
	description: string;
	/** View shape — read from `query.shape` (string value, not TS enum). Unknown shapes are passed through as-is so the picker can render "Unknown shape" placeholders for future shapes. */
	shape: string;
	/** Path to the source file (vault-relative for user; "shipped:<id>" for shipped). */
	originPath: string;
}

/**
 * A validation problem with a recipe load attempt — surfaced in the picker
 * as "this recipe couldn't load: ..." so users can see what's wrong instead
 * of the recipe just being silently absent.
 */
export interface RecipeLoadError {
	source: 'shipped' | 'user';
	originPath: string;
	error: string;
}

export interface LoadResult {
	recipes: LoadedRecipe[];
	errors: RecipeLoadError[];
}

/**
 * Load all available recipes (shipped + user) + validate each. Returns
 * structured results so the picker can surface both successes + failures.
 *
 * The `schemaStyle` parameter routes to the right AJV schema (Phase 1 added
 * both styles A + B). No longer settings-exposed; callers pass 'A'
 * (settings-redesign report, 2026-07-11).
 */
export async function loadAllRecipes(
	app: App,
	schemaStyle: 'A' | 'B',
	debug?: DebugLog,
): Promise<LoadResult> {
	const recipes: LoadedRecipe[] = [];
	const errors: RecipeLoadError[] = [];

	// Shipped recipes — always present
	for (const json of SHIPPED_RECIPES) {
		const id = typeof json.recipe === 'string' ? json.recipe : 'unknown';
		const originPath = `shipped:${id}`;
		const result = validateRecipe(json, schemaStyle);
		if (result.valid) {
			recipes.push(buildLoadedRecipe(json, 'shipped', originPath));
		} else {
			const err = (result.errors ?? []).join('; ');
			errors.push({ source: 'shipped', originPath, error: err });
			debug?.warn('view', 'recipe-validation-failed', `Shipped recipe ${id} failed validation`, {
				id,
				originPath,
				error: err,
			});
		}
	}

	// User recipes — loaded from vault if `_crosswalker/recipes/` exists
	try {
		const folder = app.vault.getAbstractFileByPath(USER_RECIPES_DIR);
		if (folder instanceof TFolder) {
			for (const child of folder.children) {
				if (!(child instanceof TFile)) continue;
				if (!child.name.endsWith('.json')) continue;
				try {
					const text = await app.vault.read(child);
					const json = JSON.parse(text) as Record<string, unknown>;
					const id = typeof json.recipe === 'string' ? json.recipe : child.basename;
					const result = validateRecipe(json, schemaStyle);
					if (result.valid) {
						recipes.push(buildLoadedRecipe(json, 'user', child.path));
					} else {
						const err = (result.errors ?? []).join('; ');
						errors.push({ source: 'user', originPath: child.path, error: err });
						debug?.warn('view', 'recipe-validation-failed', `User recipe ${child.path} failed validation`, {
							id,
							originPath: child.path,
							error: err,
						});
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					errors.push({ source: 'user', originPath: child.path, error: msg });
					debug?.warn('view', 'recipe-parse-failed', `User recipe ${child.path} parse failed`, {
						originPath: child.path,
						error: msg,
					});
				}
			}
		}
	} catch (err) {
		debug?.warn('view', 'user-recipes-scan-failed', 'User recipes folder scan failed', {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Sort: shipped first (preserves catalog order), then user alphabetically by ID
	recipes.sort((a, b) => {
		if (a.source !== b.source) return a.source === 'shipped' ? -1 : 1;
		return a.id.localeCompare(b.id);
	});

	debug?.info('view', 'recipes-loaded', `Loaded ${recipes.length} recipes (${errors.length} errors)`, {
		count: recipes.length,
		errorCount: errors.length,
		shipped: recipes.filter((r) => r.source === 'shipped').length,
		user: recipes.filter((r) => r.source === 'user').length,
	});

	return { recipes, errors };
}

/**
 * Build a LoadedRecipe from a validated JSON. Pulls title / description /
 * shape from the standard slots; falls back to recipe ID + empty string for
 * missing optional fields.
 *
 * Exported for direct unit testing without going through the full load
 * flow.
 */
export function buildLoadedRecipe(
	json: Record<string, unknown>,
	source: 'shipped' | 'user',
	originPath: string,
): LoadedRecipe {
	const query = (json.query ?? {}) as Record<string, unknown>;
	const id = typeof json.recipe === 'string' ? json.recipe : 'unknown';
	const title = typeof query.title === 'string' ? query.title : id;
	const description = typeof query.description === 'string' ? query.description : '';
	const shape = typeof query.shape === 'string' ? query.shape : 'unknown';
	return { id, source, recipe: json, title, description, shape, originPath };
}

/**
 * Get the list of `query.params` declarations for a recipe — these are the
 * ONLY fields the Phase 4 inline editor exposes (architectural commitment:
 * `primitives` is never user-editable; raw-YAML escape required for that).
 *
 * Returns an empty array if the recipe has no params block.
 */
export function getRecipeParams(recipe: LoadedRecipe): RecipeParam[] {
	const query = (recipe.recipe.query ?? {}) as Record<string, unknown>;
	const params = (query.params ?? {}) as Record<string, unknown>;
	const out: RecipeParam[] = [];
	for (const [name, decl] of Object.entries(params)) {
		if (!decl || typeof decl !== 'object') continue;
		const d = decl as Record<string, unknown>;
		const type = typeof d.type === 'string' ? d.type : 'string';
		const param: RecipeParam = {
			name,
			type: normalizeType(type),
			description: typeof d.description === 'string' ? d.description : '',
			defaultValue: d.default,
		};
		if (param.type === 'import-set') {
			param.kind = d.kind === 'mapping' ? 'mapping' : 'framework';
		}
		out.push(param);
	}
	return out;
}

/**
 * `import-set` (SchemaVer 1.19.0): the value is one imported set's minted id,
 * chosen by the user from the sets the vault holds. `kind` says which sets it
 * offers: frameworks (concept notes) or mapping sets (relationship notes).
 */
export type RecipeParamType = 'string' | 'number' | 'boolean' | 'import-set';

export interface RecipeParam {
	name: string;
	type: RecipeParamType;
	/** Only for type `import-set`. */
	kind?: 'framework' | 'mapping';
	description: string;
	defaultValue: unknown;
}

function normalizeType(t: string): RecipeParamType {
	if (t === 'number' || t === 'integer') return 'number';
	if (t === 'boolean') return 'boolean';
	if (t === 'import-set') return 'import-set';
	return 'string';
}
