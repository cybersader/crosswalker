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
 * When the library has no such recipe, or holds a later revision of it, the
 * copy the import kept under `_crosswalker/import-sets/<set id>/` is tried
 * next, keyed by the note's import set id and digest. That covers recipes that
 * were never saved, saved recipes edited after the run, and classic
 * column-mapping imports, whose recipe id names no library recipe at all.
 *
 * When the recipe still cannot be found, the note falls back to a frontmatter-only row and the reason is counted, so
 * the export notice can say what happened and what to do.
 */

import type { CrosswalkerImportRecipe } from '../types/generated/recipe';
import { loadForImport, type RecipeLibraryFiles } from '../import/recipe-library';
import { recipeRunDigest } from '../import/recipe-runs';
import { LEGACY_RECIPE_ID_SENTINEL } from '../generation/legacy-recipe-shim';
import { readImportSetRecipe, type ImportSetRecipeFiles } from '../import/import-set-recipes';

/** Why a note exported without its recipe. */
export type RecipeFallbackReason =
	/** The note carries no recipe id at all. */
	| 'no-recipe'
	/** The note was written by the classic column-mapping import and its set kept no recipe copy (imports from before copies were kept). */
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

function recipeStamp(frontmatter: Record<string, unknown>): { id?: string; digest?: string; setId?: string } {
	const provenance = frontmatter._crosswalker;
	if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return {};
	const importSet = (provenance as Record<string, unknown>).import_set;
	const setIdRaw =
		importSet && typeof importSet === 'object' && !Array.isArray(importSet)
			? (importSet as Record<string, unknown>).id
			: undefined;
	const setId = typeof setIdRaw === 'string' && setIdRaw !== '' ? setIdRaw : undefined;
	const recipe = (provenance as Record<string, unknown>).recipe;
	if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) return {};
	const r = recipe as Record<string, unknown>;
	const id = typeof r.id === 'string' && r.id.trim() !== '' ? r.id.trim() : undefined;
	const digest =
		typeof r.recipe_document_digest === 'string' && r.recipe_document_digest !== ''
			? r.recipe_document_digest
			: undefined;
	return { id, digest, setId };
}

/**
 * Resolves and caches recipes per id plus digest for one export run. One
 * library read per distinct recipe revision, however many notes it wrote.
 */
export class NoteRecipeResolver {
	private readonly cache = new Map<string, Promise<NoteRecipe>>();
	private readonly snapshots = new Map<string, Promise<CrosswalkerImportRecipe | null>>();
	/** Fallback counts by reason, for the export notice. */
	readonly fallbacks: Record<RecipeFallbackReason, number> = {
		'no-recipe': 0,
		legacy: 0,
		missing: 0,
		'digest-mismatch': 0,
	};

	/**
	 * `copies` reads the recipe copies imports keep with their sets. Those are
	 * vault state, not library state, so they are read even when no saved
	 * library is passed. Default: the library's own file layer.
	 */
	constructor(
		private readonly files: RecipeLibraryFiles = EMPTY_RECIPE_LIBRARY,
		private readonly copies: Pick<ImportSetRecipeFiles, 'exists' | 'read'> = files,
	) {}

	async resolve(frontmatter: Record<string, unknown>): Promise<NoteRecipe> {
		const result = await this.lookup(frontmatter);
		if (!result.ok) this.fallbacks[result.reason]++;
		return result;
	}

	private async lookup(frontmatter: Record<string, unknown>): Promise<NoteRecipe> {
		const { id, digest, setId } = recipeStamp(frontmatter);
		if (!id) return { ok: false, reason: 'no-recipe' };
		if (id === LEGACY_RECIPE_ID_SENTINEL) {
			// The sentinel names no library recipe, but a classic import keeps the
			// exact recipe it ran with its set, keyed by set id and digest. Only a
			// note with no such copy (older imports) is truly legacy.
			const snapshot = digest && setId ? await this.snapshot(setId, digest) : null;
			return snapshot
				? { ok: true, id, recipe: snapshot, key: `${id}\u0000${digest}` }
				: { ok: false, reason: 'legacy' };
		}
		const key = `${id}\u0000${digest ?? ''}`;
		let pending = this.cache.get(key);
		if (!pending) {
			pending = this.load(id, digest, key);
			this.cache.set(key, pending);
		}
		const found = await pending;
		if (found.ok || !digest || !setId) return found;
		// The library cannot supply this revision. The import kept the exact recipe
		// it ran with its set, so try that copy before giving up.
		const snapshot = await this.snapshot(setId, digest);
		return snapshot ? { ok: true, id, recipe: snapshot, key } : found;
	}

	/** One read per (import set, digest), however many notes share it. */
	private snapshot(setId: string, digest: string): Promise<CrosswalkerImportRecipe | null> {
		const key = `${setId}\u0000${digest}`;
		let pending = this.snapshots.get(key);
		if (!pending) {
			pending = readImportSetRecipe(this.copies, setId, digest);
			this.snapshots.set(key, pending);
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
