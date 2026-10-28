/**
 * import-set-recipes.ts — the exact recipe each import ran, kept per import set.
 *
 * Every import that runs a portable recipe writes that recipe's canonical bytes
 * (the same bytes the saved library writes, via `serializeCanonicalRecipe`) to
 *
 *   `_crosswalker/import-sets/<import set id>/recipe-<recipe document digest>.json`
 *
 * Both keys come from identity: the minted import set id the run wrote into,
 * and the document digest the notes are stamped with. Never from a folder or a
 * file name. Each recipe revision gets its own file; a file is never deleted,
 * and never replaced by a different revision.
 *
 * Why: a recipe-aware CSV export inverts each note's recipe, found by id plus
 * digest in the saved library. A run from a never-saved workbench recipe
 * (`custom-<ontology>`), or one whose saved recipe was edited afterwards,
 * resolves nowhere there. This copy is the durable fallback, so export stays
 * lossless for those notes too.
 *
 * Pure apart from `vaultImportSetRecipeFiles()`, the Obsidian adapter. Nothing
 * here throws: failures come back as `{ ok: false }` for the caller to report.
 */

import type { App } from 'obsidian';
import type { CrosswalkerImportRecipe } from '../types/generated/recipe';
import { validateRecipe } from '../validation/validator';
import { serializeCanonicalRecipe } from './recipe-document';
import { recipeRunDigest } from './recipe-runs';

/** Vault-relative folder holding one subfolder per import set. Created on first write. */
export const IMPORT_SET_RECIPES_FOLDER = '_crosswalker/import-sets';

/** The file API this module needs. `RecipeLibraryFiles` satisfies it. */
export interface ImportSetRecipeFiles {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	/** Create or overwrite. */
	write(path: string, text: string): Promise<void>;
	mkdir(path: string): Promise<void>;
}

const SET_ID_RE = /^iset-[a-z0-9]{6}$/;
const DIGEST_RE = /^sha256-[a-f0-9]{64}$/;

/**
 * The path for one set's copy of one recipe revision, or null when either key
 * is malformed. Both keys can come from note frontmatter, so they are checked
 * against their schema patterns before they ever become a path.
 */
export function importSetRecipePath(importSetId: string, digest: string): string | null {
	if (!SET_ID_RE.test(importSetId) || !DIGEST_RE.test(digest)) return null;
	return `${IMPORT_SET_RECIPES_FOLDER}/${importSetId}/recipe-${digest}.json`;
}

export type KeepRecipeResult =
	| { ok: true; outcome: 'written' | 'unchanged'; path: string }
	/** Nothing to keep: the keys are malformed, or the recipe does not hash to the digest. */
	| { ok: true; outcome: 'skipped'; reason: 'bad-key' | 'digest-differs' }
	| { ok: false; path: string; error: string };

/** Parse, validate, and check the digest. Null when the text is not this revision. */
function verifiedRecipe(text: string, digest: string): CrosswalkerImportRecipe | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || !validateRecipe(parsed).valid) return null;
	const recipe = parsed as CrosswalkerImportRecipe;
	return recipeRunDigest(recipe) === digest ? recipe : null;
}

/**
 * Keep a copy of the recipe a run executed. Writes nothing when an identical
 * file is already there, or when a file that verifies as this revision is
 * there with other bytes (a reformat is not a new revision). Other revisions'
 * files are never touched: the path is unique per digest.
 */
export async function keepImportSetRecipe(
	files: ImportSetRecipeFiles,
	importSetId: string,
	recipe: CrosswalkerImportRecipe,
	digest: string,
): Promise<KeepRecipeResult> {
	const path = importSetRecipePath(importSetId, digest);
	if (!path) return { ok: true, outcome: 'skipped', reason: 'bad-key' };
	let text: string;
	try {
		text = serializeCanonicalRecipe(recipe);
	} catch (err) {
		return { ok: false, path, error: err instanceof Error ? err.message : String(err) };
	}
	// The copy must resolve to the digest the notes carry, or it is useless to
	// the exporter. A recipe whose canonical form hashes differently is a caller
	// bug; keeping it under this name would be a file that lies about its key.
	if (recipeRunDigest(JSON.parse(text) as CrosswalkerImportRecipe) !== digest) {
		return { ok: true, outcome: 'skipped', reason: 'digest-differs' };
	}
	try {
		if (await files.exists(path)) {
			const existing = await files.read(path);
			if (existing === text || verifiedRecipe(existing, digest)) return { ok: true, outcome: 'unchanged', path };
			// A file at this name that is not this revision (damaged or hand-edited)
			// is replaced: the name promises this digest's content.
		} else {
			const parts = path.split('/').slice(0, -1);
			for (let i = 1; i <= parts.length; i++) {
				const folder = parts.slice(0, i).join('/');
				if (!(await files.exists(folder))) await files.mkdir(folder);
			}
		}
		await files.write(path, text);
		return { ok: true, outcome: 'written', path };
	} catch (err) {
		return { ok: false, path, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Read one set's copy of one recipe revision. Null when it is absent, not a
 * valid recipe, or not the revision its name claims.
 */
export async function readImportSetRecipe(
	files: Pick<ImportSetRecipeFiles, 'exists' | 'read'>,
	importSetId: string,
	digest: string,
): Promise<CrosswalkerImportRecipe | null> {
	const path = importSetRecipePath(importSetId, digest);
	if (!path) return null;
	try {
		if (!(await files.exists(path))) return null;
		return verifiedRecipe(await files.read(path), digest);
	} catch {
		return null;
	}
}

/**
 * The file API over the vault adapter, the same route the recipe library writes
 * through and the CSV export reads through, so the copy lands even where the
 * vault index lags. Null when the vault has no adapter (only in test doubles;
 * Obsidian always has one): the caller then keeps no copy, which costs export
 * fidelity, never the import.
 */
export function vaultImportSetRecipeFiles(app: App): ImportSetRecipeFiles | null {
	const adapter = (app.vault as { adapter?: Partial<App['vault']['adapter']> }).adapter;
	if (
		!adapter
		|| typeof adapter.exists !== 'function'
		|| typeof adapter.read !== 'function'
		|| typeof adapter.write !== 'function'
		|| typeof adapter.mkdir !== 'function'
	) return null;
	return {
		exists: (path) => adapter.exists!(path),
		read: (path) => adapter.read!(path),
		write: (path, text) => adapter.write!(path, text),
		mkdir: (path) => adapter.mkdir!(path),
	};
}
