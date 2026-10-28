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
	/** Nothing to keep: the keys are malformed, the recipe does not hash to the digest, or the source named no columns. */
	| { ok: true; outcome: 'skipped'; reason: 'bad-key' | 'digest-differs' | 'no-columns' }
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
			await ensureParentFolders(files, path);
		}
		await files.write(path, text);
		return { ok: true, outcome: 'written', path };
	} catch (err) {
		return { ok: false, path, error: err instanceof Error ? err.message : String(err) };
	}
}

async function ensureParentFolders(files: ImportSetRecipeFiles, path: string): Promise<void> {
	const parts = path.split('/').slice(0, -1);
	for (let i = 1; i <= parts.length; i++) {
		const folder = parts.slice(0, i).join('/');
		if (!(await files.exists(folder))) await files.mkdir(folder);
	}
}

// ---------------------------------------------------------------------------
// Source column order
// ---------------------------------------------------------------------------
//
// A recipe names the columns it reads, in the order its layout and properties
// mention them, but not the order the source file lists them in. That order
// is a fact about the source, not the recipe, so the run records it next to
// the recipe copy:
//
//   `_crosswalker/import-sets/<import set id>/source-columns.json`
//
// The CSV export lays its recipe columns out in this order, so a round trip
// gives back the source's own header. It records the latest run into the set:
// a refresh from a reordered file reorders the export to match.

export interface SourceColumnsRecord {
	kind: 'source-columns';
	columns: string[];
}

/** The path for one set's source column order, or null when the set id is malformed. */
export function importSetSourceColumnsPath(importSetId: string): string | null {
	if (!SET_ID_RE.test(importSetId)) return null;
	return `${IMPORT_SET_RECIPES_FOLDER}/${importSetId}/source-columns.json`;
}

function serializeSourceColumns(columns: string[]): string {
	const record: SourceColumnsRecord = { kind: 'source-columns', columns };
	return `${JSON.stringify(record, null, 2)}\n`;
}

/** Null unless `text` is a source column record with a non-empty list of distinct names. */
function parseSourceColumns(text: string): string[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const record = parsed as Partial<SourceColumnsRecord>;
	if (record.kind !== 'source-columns' || !Array.isArray(record.columns)) return null;
	const columns = record.columns;
	if (columns.length === 0 || !columns.every((c) => typeof c === 'string')) return null;
	if (new Set(columns).size !== columns.length) return null;
	return columns;
}

/**
 * Record the source's column order for a set. Writes nothing when the same
 * order is already recorded. Empty names (a blank header cell) are dropped;
 * duplicates keep their first position.
 */
export async function keepImportSetSourceColumns(
	files: ImportSetRecipeFiles,
	importSetId: string,
	columns: readonly string[],
): Promise<KeepRecipeResult> {
	const path = importSetSourceColumnsPath(importSetId);
	if (!path) return { ok: true, outcome: 'skipped', reason: 'bad-key' };
	const distinct = Array.from(new Set(columns.filter((c) => typeof c === 'string' && c !== '')));
	if (distinct.length === 0) return { ok: true, outcome: 'skipped', reason: 'no-columns' };
	const text = serializeSourceColumns(distinct);
	try {
		if (await files.exists(path)) {
			const existing = await files.read(path);
			const recorded = parseSourceColumns(existing);
			if (recorded && recorded.join('\u0000') === distinct.join('\u0000')) return { ok: true, outcome: 'unchanged', path };
		} else {
			await ensureParentFolders(files, path);
		}
		await files.write(path, text);
		return { ok: true, outcome: 'written', path };
	} catch (err) {
		return { ok: false, path, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Read a set's source column order. Null when absent or not a valid record. */
export async function readImportSetSourceColumns(
	files: Pick<ImportSetRecipeFiles, 'exists' | 'read'>,
	importSetId: string,
): Promise<string[] | null> {
	const path = importSetSourceColumnsPath(importSetId);
	if (!path) return null;
	try {
		if (!(await files.exists(path))) return null;
		return parseSourceColumns(await files.read(path));
	} catch {
		return null;
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
