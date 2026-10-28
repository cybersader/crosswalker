/**
 * recipe-for-note.ts — find the recipe that wrote a note, by identity.
 *
 * A recipe-aware CSV export inverts each note's recipe. Which recipe that is
 * comes from the note's own provenance (`_crosswalker.recipe.id`, plus
 * `recipe_document_digest` when stamped), loaded through the same library
 * lookup an import uses. Never from the folder, the file name, or how similar
 * a recipe's columns look: two releases of one framework can sit side by side,
 * and a guess there exports the wrong columns without saying so.
 *
 * When the recipe cannot be found or is not the revision that wrote the note,
 * the note falls back to a frontmatter-only row and the reason is counted, so
 * the export notice can say what happened and what to do.
 */

import type { CrosswalkerImportRecipe } from '../types/generated/recipe';
import { loadForImport, type RecipeLibraryFiles } from '../import/recipe-library';
import { recipeRunDigest } from '../import/recipe-runs';
import { LEGACY_RECIPE_ID_SENTINEL } from '../generation/legacy-recipe-shim';

/** Why a note exported without its recipe. */
export type RecipeFallbackReason =
	/** The note carries no recipe id at all. */
	| 'no-recipe'
	/** The note was written by the older column-mapping import (no portable recipe). */
	| 'legacy'
	/** The recipe id is in neither the saved library nor the built-in list. */
	| 'missing'
	/** A recipe with that id exists, but it is not the revision that wrote the note. */
	| 'digest-mismatch';

export type NoteRecipe =
	| { ok: true; id: string; recipe: CrosswalkerImportRecipe; key: string }
	| { ok: false; reason: RecipeFallbackReason };

/** A library with nothing saved in it. Built-in recipes still resolve. */
export const EMPTY_RECIPE_LIBRARY: RecipeLibraryFiles = {
	exists: async () => false,
	listFiles: async () => [],
	read: async () => {
		throw new Error('empty library');
	},
	write: async () => {
		throw new Error('empty library');
	},
	mkdir: async () => {
		throw new Error('empty library');
	},
	trash: async () => {
		throw new Error('empty library');
	},
	rename: async () => {
		throw new Error('empty library');
	},
};

function recipeStamp(frontmatter: Record<string, unknown>): { id?: string; digest?: string } {
	const provenance = frontmatter._crosswalker;
	if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return {};
	const recipe = (provenance as Record<string, unknown>).recipe;
	if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) return {};
	const r = recipe as Record<string, unknown>;
	const id = typeof r.id === 'string' && r.id.trim() !== '' ? r.id.trim() : undefined;
	const digest =
		typeof r.recipe_document_digest === 'string' && r.recipe_document_digest !== ''
			? r.recipe_document_digest
			: undefined;
	return { id, digest };
}

/**
 * Resolves and caches recipes per id plus digest for one export run. One
 * library read per distinct recipe revision, however many notes it wrote.
 */
export class NoteRecipeResolver {
	private readonly cache = new Map<string, Promise<NoteRecipe>>();
	/** Fallback counts by reason, for the export notice. */
	readonly fallbacks: Record<RecipeFallbackReason, number> = {
		'no-recipe': 0,
		legacy: 0,
		missing: 0,
		'digest-mismatch': 0,
	};

	constructor(private readonly files: RecipeLibraryFiles = EMPTY_RECIPE_LIBRARY) {}

	async resolve(frontmatter: Record<string, unknown>): Promise<NoteRecipe> {
		const result = await this.lookup(frontmatter);
		if (!result.ok) this.fallbacks[result.reason]++;
		return result;
	}

	private lookup(frontmatter: Record<string, unknown>): Promise<NoteRecipe> {
		const { id, digest } = recipeStamp(frontmatter);
		if (!id) return Promise.resolve({ ok: false, reason: 'no-recipe' });
		if (id === LEGACY_RECIPE_ID_SENTINEL) return Promise.resolve({ ok: false, reason: 'legacy' });
		const key = `${id}\u0000${digest ?? ''}`;
		let pending = this.cache.get(key);
		if (!pending) {
			pending = this.load(id, digest, key);
			this.cache.set(key, pending);
		}
		return pending;
	}

	private async load(id: string, digest: string | undefined, key: string): Promise<NoteRecipe> {
		let loaded: Awaited<ReturnType<typeof loadForImport>>;
		try {
			loaded = await loadForImport(this.files, id);
		} catch {
			return { ok: false, reason: 'missing' };
		}
		if (!loaded.ok) return { ok: false, reason: 'missing' };
		// A stamped digest proves which revision wrote the note. A library recipe
		// that has since been edited would invert into the wrong columns, so a
		// mismatch (or a digest that cannot be computed) is a fallback, not a guess.
		if (digest !== undefined && recipeRunDigest(loaded.recipe) !== digest) {
			return { ok: false, reason: 'digest-mismatch' };
		}
		return { ok: true, id, recipe: loaded.recipe, key };
	}
}
