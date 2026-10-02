/**
 * recipe-library.ts — the vault's saved import recipe library (slice 1).
 *
 * A saved recipe is one JSON file in `_crosswalker/import-recipes/`, and its
 * content is exactly a canonical import recipe: the output of
 * `patchRecipeDocument()` over the wizard's RecipeDocument, never a rebuild from
 * the workbench model, and never wrapped in another object. The display name
 * lives in `metadata.title`, the description in `metadata.description`, and the
 * lineage in the existing `metadata.based_on`.
 *
 * Identity is the `recipe` field, never the file path. File names are a
 * convenience derived from the display name; renaming changes the title and the
 * file name, never the id.
 *
 * Pure module: every function takes an injected file API, so the whole library
 * is unit-testable over an in-memory map. The Obsidian adapter lives in
 * `obsidianRecipeLibraryFiles()` in recipe-library-modal.ts. Nothing here throws to the UI:
 * failures come back as `{ ok: false, cause, action }`.
 */

import type { CrosswalkerImportRecipe } from '../types/generated/recipe';
import { validateRecipe } from '../validation/validator';
import {
	patchRecipeDocument,
	recipeBasedOn,
	serializeCanonicalRecipe,
	type RecipeDocument,
	type RecipePatchOptions,
} from './recipe-document';
import {
	RECIPE_REGISTRY,
	isGenericRecipe,
	libraryRegistryEntry,
	type RecipeRegistryEntry,
} from './recipe-registry';
import { interpolationColumn, parseTemplateSegments } from '../render/template';

/** Vault-relative folder holding saved import recipes. Created on first save. */
export const RECIPE_LIBRARY_FOLDER = '_crosswalker/import-recipes';

/** The injected file API. Paths are vault-relative. */
export interface RecipeLibraryFiles {
	exists(path: string): Promise<boolean>;
	/** Files directly inside `folder` (non-recursive), as vault-relative paths. */
	listFiles(folder: string): Promise<string[]>;
	read(path: string): Promise<string>;
	/** Create or overwrite. */
	write(path: string, text: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	/** Send to the trash (never a hard delete). */
	trash(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	/** Last-modified time in ms, when known. */
	mtime?(path: string): Promise<number | null>;
}

/** One saved recipe. */
export interface LibraryEntry {
	id: string;
	name: string;
	description: string;
	path: string;
	savedAt: number | null;
	recipe: CrosswalkerImportRecipe;
}

/** One unreadable file in the library folder. */
export interface LibraryProblem {
	file: string;
	cause: string;
	action: string;
}

export interface LibraryListing {
	entries: LibraryEntry[];
	problems: LibraryProblem[];
}

export type LibraryFailure = { ok: false; cause: string; action: string };
export type LibraryResult<T> = ({ ok: true } & T) | LibraryFailure;

export interface SaveOptions {
	name: string;
	description?: string;
	mode: 'new' | 'replace';
	/** Patch inputs (current mapping + regions). Omitted means the document as is. */
	patch?: RecipePatchOptions;
}

const FOLDER_PROBLEM: LibraryFailure = {
	ok: false,
	cause: 'Crosswalker could not read or write the recipe folder.',
	action: 'Check that the vault folder is writable, then try again.',
};

const NOT_A_RECIPE: LibraryFailure = {
	ok: false,
	cause: 'This file is not a Crosswalker import recipe.',
	action: 'Choose a .json file exported from Crosswalker.',
};

// ============================================================================
// Naming helpers (pure)
// ============================================================================

/** Lowercase ASCII slug for ids and file names. Never empty. */
export function recipeSlug(name: string): string {
	const slug = name
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60)
		.replace(/-+$/g, '');
	return slug.length > 0 ? slug : 'recipe';
}

/** `base`, else `base-2`, `base-3`, ... whichever is not taken. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base}-${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/**
 * `name`, else `name 2`, `name 3`, ... whichever no saved recipe uses yet.
 * Compared case-insensitively, so two cards never read the same to a person
 * (ids already differ; names must too). `exceptId` skips one entry, for a
 * recipe being replaced under its own name.
 */
export function uniqueDisplayName(
	name: string,
	entries: readonly { id?: string; name: string }[],
	exceptId?: string,
): string {
	const base = name.trim();
	const taken = new Set(
		entries.filter((e) => exceptId === undefined || e.id !== exceptId).map((e) => e.name.trim().toLowerCase()),
	);
	if (!taken.has(base.toLowerCase())) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base} ${n}`;
		if (!taken.has(candidate.toLowerCase())) return candidate;
	}
}

/** Every bundled recipe id. A saved recipe never reuses one. */
export function builtInRecipeIds(): Set<string> {
	return new Set(RECIPE_REGISTRY.map((entry) => entry.id));
}

/** Built-in recipes shown in the browser and picker. */
export function builtInRecipes(): RecipeRegistryEntry[] {
	return RECIPE_REGISTRY.filter(isGenericRecipe);
}

function displayName(recipe: CrosswalkerImportRecipe): string {
	const title = recipe.metadata?.title?.trim();
	return title && title.length > 0 ? title : recipe.recipe;
}

function deepClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function withDisplay(
	recipe: CrosswalkerImportRecipe,
	name: string,
	description: string | undefined,
): CrosswalkerImportRecipe {
	const out = deepClone(recipe);
	const metadata = { ...(out.metadata ?? {}) };
	metadata.title = name.trim();
	const desc = description?.trim();
	if (desc) metadata.description = desc;
	else delete metadata.description;
	out.metadata = metadata;
	return out;
}

function fileFor(name: string, takenPaths: ReadonlySet<string>): string {
	const takenStems = new Set(
		[...takenPaths]
			.filter((p) => p.startsWith(`${RECIPE_LIBRARY_FOLDER}/`))
			.map((p) => p.slice(RECIPE_LIBRARY_FOLDER.length + 1).replace(/\.json$/i, '').toLowerCase()),
	);
	return `${RECIPE_LIBRARY_FOLDER}/${uniqueName(recipeSlug(name), takenStems)}.json`;
}

// ============================================================================
// Loader
// ============================================================================

/**
 * Scan the library folder (non-recursive), parse, validate, and index by the
 * `recipe` id. A missing folder is an empty library. Duplicate ids: the first
 * file by path sort wins and each other file becomes a problem.
 */
export async function listLibrary(files: RecipeLibraryFiles): Promise<LibraryListing> {
	const entries: LibraryEntry[] = [];
	const problems: LibraryProblem[] = [];
	let paths: string[];
	try {
		if (!(await files.exists(RECIPE_LIBRARY_FOLDER))) return { entries, problems };
		paths = (await files.listFiles(RECIPE_LIBRARY_FOLDER))
			.filter((p) => p.toLowerCase().endsWith('.json'))
			.sort();
	} catch {
		return {
			entries,
			problems: [{ file: RECIPE_LIBRARY_FOLDER, cause: FOLDER_PROBLEM.cause, action: FOLDER_PROBLEM.action }],
		};
	}
	const builtIns = builtInRecipeIds();
	const seen = new Set<string>();
	for (const path of paths) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await files.read(path));
		} catch {
			problems.push({
				file: path,
				cause: 'This file is not valid JSON.',
				action: 'Fix it in a text editor, or delete it.',
			});
			continue;
		}
		if (!validateRecipe(parsed).valid) {
			problems.push({
				file: path,
				cause: 'This file is not a valid import recipe.',
				action: 'Delete it, or replace it with a recipe exported from Crosswalker.',
			});
			continue;
		}
		const recipe = parsed as CrosswalkerImportRecipe;
		if (seen.has(recipe.recipe)) {
			problems.push({
				file: path,
				cause: `Two recipe files use the id ${recipe.recipe}.`,
				action: 'Rename one of them in a text editor, or delete the copy.',
			});
			continue;
		}
		if (builtIns.has(recipe.recipe)) {
			problems.push({
				file: path,
				cause: `This recipe uses the id ${recipe.recipe}, which belongs to a built-in recipe.`,
				action: 'Change its id in a text editor, or delete it.',
			});
			continue;
		}
		seen.add(recipe.recipe);
		let savedAt: number | null = null;
		try {
			savedAt = files.mtime ? await files.mtime(path) : null;
		} catch {
			savedAt = null;
		}
		entries.push({
			id: recipe.recipe,
			name: displayName(recipe),
			description: recipe.metadata?.description?.trim() ?? '',
			path,
			savedAt,
			recipe,
		});
	}
	return { entries, problems };
}

async function takenIds(listing: LibraryListing): Promise<Set<string>> {
	return new Set([...builtInRecipeIds(), ...listing.entries.map((e) => e.id)]);
}

async function existingPaths(files: RecipeLibraryFiles): Promise<Set<string>> {
	try {
		if (!(await files.exists(RECIPE_LIBRARY_FOLDER))) return new Set();
		return new Set(await files.listFiles(RECIPE_LIBRARY_FOLDER));
	} catch {
		return new Set();
	}
}

async function ensureFolder(files: RecipeLibraryFiles): Promise<void> {
	if (await files.exists(RECIPE_LIBRARY_FOLDER)) return;
	const parent = RECIPE_LIBRARY_FOLDER.split('/').slice(0, -1).join('/');
	if (parent && !(await files.exists(parent))) await files.mkdir(parent);
	await files.mkdir(RECIPE_LIBRARY_FOLDER);
}

function invalid(recipe: CrosswalkerImportRecipe): LibraryFailure | null {
	const validation = validateRecipe(recipe);
	if (validation.valid) return null;
	return {
		ok: false,
		cause: 'This setup cannot be saved as a recipe yet because part of it is incomplete.',
		action: 'Fix the highlighted problems in the review step, then save again.',
	};
}

// ============================================================================
// Save
// ============================================================================

/**
 * Save the wizard's current setup. The content is the output of
 * `patchRecipeDocument(document, patch)` with only the display metadata and,
 * for a new recipe, the id and lineage set.
 *
 * - `new`: id = slug of the name, suffixed `-2`, `-3` when it collides with a
 *   built-in or saved id. Lineage is the `based_on` the patch stamps; an
 *   unedited built-in or saved recipe gets the same stamp via `recipeBasedOn`.
 *   A fresh setup has no lineage.
 * - `replace`: only for a document opened from the library. Keeps that id and
 *   its existing lineage, sends the old file to the trash, writes the new one.
 */
export async function saveToLibrary(
	files: RecipeLibraryFiles,
	document: RecipeDocument,
	options: SaveOptions,
): Promise<LibraryResult<{ id: string; name: string; path: string; recipe: CrosswalkerImportRecipe }>> {
	const typed = options.name.trim();
	if (!typed) return { ok: false, cause: 'The recipe needs a name.', action: 'Type a name, then save.' };

	const patched = patchRecipeDocument(document, options.patch ?? {});
	if (!patched.ok) {
		const first = patched.diagnostics.find((d) => d.severity === 'blocking');
		return {
			ok: false,
			cause: first?.message ?? 'This setup has a problem that blocks saving.',
			action: 'Fix it in the review step, then save again.',
		};
	}

	try {
		const listing = await listLibrary(files);
		const replacingId = options.mode === 'replace' && document.origin === 'user' ? document.original.recipe : undefined;
		const name = uniqueDisplayName(typed, listing.entries, replacingId);
		let recipe = withDisplay(patched.recipe, name, options.description);
		let replaced: LibraryEntry | undefined;

		if (options.mode === 'replace') {
			if (document.origin !== 'user') {
				return {
					ok: false,
					cause: 'Only a recipe you saved yourself can be replaced.',
					action: 'Save it as a new recipe instead.',
				};
			}
			replaced = listing.entries.find((e) => e.id === document.original.recipe);
			if (!replaced) {
				return {
					ok: false,
					cause: 'The saved recipe this setup came from is no longer in the library.',
					action: 'Save it as a new recipe instead.',
				};
			}
			recipe.recipe = replaced.id;
			const metadata = { ...(recipe.metadata ?? {}) };
			const keep = document.original.metadata?.based_on;
			if (keep) metadata.based_on = deepClone(keep);
			else delete metadata.based_on;
			recipe.metadata = metadata;
		} else {
			recipe.recipe = uniqueName(recipeSlug(name), await takenIds(listing));
			if (document.origin === 'fresh') {
				if (recipe.metadata) delete recipe.metadata.based_on;
			} else if (!patched.dirty && (document.origin === 'bundled' || document.origin === 'user')) {
				recipe.metadata = { ...(recipe.metadata ?? {}), based_on: recipeBasedOn(document.original) };
			}
		}
		recipe = JSON.parse(serializeCanonicalRecipe(recipe)) as CrosswalkerImportRecipe;
		const bad = invalid(recipe);
		if (bad) return bad;

		await ensureFolder(files);
		const paths = await existingPaths(files);
		if (replaced) paths.delete(replaced.path);
		const path = fileFor(name, paths);
		const text = serializeCanonicalRecipe(recipe);
		if (replaced) {
			if (replaced.path === path) {
				await files.trash(replaced.path);
				await files.write(path, text);
			} else {
				await files.write(path, text);
				await files.trash(replaced.path);
			}
		} else {
			await files.write(path, text);
		}
		return { ok: true, id: recipe.recipe, name, path, recipe };
	} catch {
		return FOLDER_PROBLEM;
	}
}

// ============================================================================
// Read side
// ============================================================================

/** Find a recipe by id: a saved recipe first, then a built-in one. */
export async function loadForImport(
	files: RecipeLibraryFiles,
	id: string,
): Promise<LibraryResult<{ recipe: CrosswalkerImportRecipe; origin: 'user' | 'bundled'; name: string }>> {
	const listing = await listLibrary(files);
	const saved = listing.entries.find((e) => e.id === id);
	if (saved) return { ok: true, recipe: deepClone(saved.recipe), origin: 'user', name: saved.name };
	const builtIn = RECIPE_REGISTRY.find((e) => e.id === id);
	if (builtIn) return { ok: true, recipe: deepClone(builtIn.recipe), origin: 'bundled', name: builtIn.label };
	return {
		ok: false,
		cause: 'That recipe is no longer in the library.',
		action: 'Open the recipe list again and choose another one.',
	};
}

/** Canonical bytes plus a download file name for a saved or built-in recipe. */
export async function exportRecipe(
	files: RecipeLibraryFiles,
	id: string,
): Promise<LibraryResult<{ fileName: string; text: string }>> {
	const found = await loadForImport(files, id);
	if (!found.ok) return found;
	const fileName = `${found.origin === 'user' ? recipeSlug(found.name) : found.recipe.recipe}.json`;
	return { ok: true, fileName, text: serializeCanonicalRecipe(found.recipe) };
}

/**
 * Add an exported recipe file to the library. Content is kept as is, except a
 * colliding id is suffixed `-2`, `-3`. A file without a title gets its id as
 * the name.
 */
export async function importRecipeFile(
	files: RecipeLibraryFiles,
	text: string,
): Promise<LibraryResult<{ id: string; name: string; path: string }>> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return NOT_A_RECIPE;
	}
	if (!parsed || typeof parsed !== 'object' || !validateRecipe(parsed).valid) return NOT_A_RECIPE;
	try {
		let recipe = deepClone(parsed as CrosswalkerImportRecipe);
		const listing = await listLibrary(files);
		recipe.recipe = uniqueName(recipe.recipe, await takenIds(listing));
		const name = uniqueDisplayName(displayName(recipe), listing.entries);
		// Only a colliding name is touched; everything else stays as exported.
		if (name !== displayName(recipe)) recipe = withDisplay(recipe, name, recipe.metadata?.description);
		await ensureFolder(files);
		const path = fileFor(name, await existingPaths(files));
		await files.write(path, serializeCanonicalRecipe(recipe));
		return { ok: true, id: recipe.recipe, name, path };
	} catch {
		return FOLDER_PROBLEM;
	}
}

/** Send a saved recipe to the trash. Built-in recipes cannot be deleted. */
export async function deleteFromLibrary(
	files: RecipeLibraryFiles,
	id: string,
): Promise<LibraryResult<{ name: string }>> {
	const listing = await listLibrary(files);
	const entry = listing.entries.find((e) => e.id === id);
	if (!entry) {
		return builtInRecipeIds().has(id)
			? { ok: false, cause: 'Built-in recipes cannot be deleted.', action: 'Duplicate it if you want your own copy.' }
			: { ok: false, cause: 'That recipe is no longer in the library.', action: 'Close and reopen the recipe list.' };
	}
	try {
		await files.trash(entry.path);
		return { ok: true, name: entry.name };
	} catch {
		return FOLDER_PROBLEM;
	}
}

/**
 * Make a saved copy of a saved or built-in recipe. The copy gets a new id, the
 * name "<name> copy", and `based_on` pointing at the source.
 */
export async function duplicate(
	files: RecipeLibraryFiles,
	id: string,
): Promise<LibraryResult<{ id: string; name: string; path: string }>> {
	const found = await loadForImport(files, id);
	if (!found.ok) return found;
	try {
		const listing = await listLibrary(files);
		const name = uniqueDisplayName(`${found.name} copy`, listing.entries);
		const copy = withDisplay(found.recipe, name, found.recipe.metadata?.description);
		copy.recipe = uniqueName(recipeSlug(name), await takenIds(listing));
		copy.metadata = { ...(copy.metadata ?? {}), based_on: recipeBasedOn(found.recipe) };
		const bad = invalid(copy);
		if (bad) return bad;
		await ensureFolder(files);
		const path = fileFor(name, await existingPaths(files));
		await files.write(path, serializeCanonicalRecipe(copy));
		return { ok: true, id: copy.recipe, name, path };
	} catch {
		return FOLDER_PROBLEM;
	}
}

/** Change a saved recipe's name and file name. The id never changes. */
export async function rename(
	files: RecipeLibraryFiles,
	id: string,
	newName: string,
): Promise<LibraryResult<{ name: string; path: string }>> {
	const name = newName.trim();
	if (!name) return { ok: false, cause: 'The recipe needs a name.', action: 'Type a name, then save.' };
	const listing = await listLibrary(files);
	const entry = listing.entries.find((e) => e.id === id);
	if (!entry) {
		return builtInRecipeIds().has(id)
			? { ok: false, cause: 'Built-in recipes cannot be renamed.', action: 'Duplicate it, then rename the copy.' }
			: { ok: false, cause: 'That recipe is no longer in the library.', action: 'Close and reopen the recipe list.' };
	}
	try {
		const updated = withDisplay(entry.recipe, name, entry.recipe.metadata?.description);
		await files.write(entry.path, serializeCanonicalRecipe(updated));
		const paths = await existingPaths(files);
		paths.delete(entry.path);
		const path = fileFor(name, paths);
		if (path !== entry.path) await files.rename(entry.path, path);
		return { ok: true, name, path };
	} catch {
		return FOLDER_PROBLEM;
	}
}

// ============================================================================
// Recognition + display helpers (pure)
// ============================================================================

/** Registry entries for recognition: every saved recipe, labeled by its name. */
export function libraryRecognitionEntries(listing: LibraryListing): RecipeRegistryEntry[] {
	const out: RecipeRegistryEntry[] = [];
	for (const entry of listing.entries) {
		try {
			out.push(libraryRegistryEntry(entry.recipe));
		} catch {
			// A recipe the matcher cannot fingerprint is simply not offered.
		}
	}
	return out;
}

/**
 * The quiet lineage line: "Based on NIST CSF 2.0 (built in)", "Based on your
 * recipe Quarterly CSF", or null when there is no lineage.
 */
export function lineageLine(
	recipe: CrosswalkerImportRecipe,
	library: readonly LibraryEntry[] = [],
): string | null {
	const ancestor = recipe.metadata?.based_on?.recipe;
	if (!ancestor) return null;
	const builtIn = RECIPE_REGISTRY.find((e) => e.id === ancestor);
	if (builtIn) return `Based on ${builtIn.label} (built in)`;
	const saved = library.find((e) => e.id === ancestor);
	if (saved) return `Based on your recipe "${saved.name}"`;
	return 'Based on a recipe that is no longer in your library';
}

/** Lineage line for the save dialog, from the document being saved. */
export function saveLineageLine(
	document: RecipeDocument,
	library: readonly LibraryEntry[] = [],
): string | null {
	if (document.origin === 'fresh' || document.origin === 'legacy') return null;
	if (document.origin === 'bundled') {
		const builtIn = RECIPE_REGISTRY.find((e) => e.id === document.original.recipe);
		return builtIn ? `Based on ${builtIn.label} (built in)` : null;
	}
	const saved = library.find((e) => e.id === document.original.recipe);
	return `Based on your recipe "${saved?.name ?? displayName(document.original)}"`;
}

export type ColumnRole = 'folder' | 'note name' | 'heading' | 'property' | 'link' | 'tag' | 'note text';

function templateColumns(template: string): string[] {
	const out: string[] = [];
	try {
		for (const segment of parseTemplateSegments(template)) {
			if (segment.kind !== 'interp') continue;
			const column = interpolationColumn(segment.interp).column;
			if (column && !column.startsWith('_cw')) out.push(column);
		}
	} catch {
		// Unparseable template: no columns to show.
	}
	return out;
}

/** "column -> role" rows for the inspect panel, in layout order, de-duplicated. */
export function summarizeRecipeColumns(recipe: CrosswalkerImportRecipe): { column: string; role: ColumnRole }[] {
	const out: { column: string; role: ColumnRole }[] = [];
	const seen = new Set<string>();
	const add = (template: string, role: ColumnRole) => {
		for (const column of templateColumns(template)) {
			const key = `${column}\u0000${role}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ column, role });
		}
	};
	const layoutRole: Record<string, ColumnRole> = {
		folder: 'folder',
		file: 'note name',
		heading: 'heading',
		tag: 'tag',
		wikilink: 'link',
	};
	for (const entry of recipe.target.layout ?? []) add(entry.template, layoutRole[entry.mechanism] ?? 'property');
	const emit = recipe.target.also_emit;
	for (const t of emit?.tags ?? []) add(t, 'tag');
	for (const tmpl of Object.values(emit?.frontmatter?.managed ?? {})) {
		add(tmpl, tmpl.includes('[[') ? 'link' : 'property');
	}
	for (const spec of Object.values(emit?.frontmatter?.managed_links ?? {})) add(spec.template, 'link');
	for (const body of emit?.body ?? []) add(body.template, 'note text');
	return out;
}

/** One location level in the "Where notes go" tree. */
export interface DestinationStep {
	kind: 'folder' | 'note';
	/** Source columns that name this level, in template order. */
	columns: string[];
	/** The fixed name when the level reads no column, else null. */
	literal: string | null;
}

/**
 * The location levels a recipe creates, in layout order: each `folder` entry,
 * then the `file` entry. Headings are inside a note, not a location, so they
 * stay in the column table only. The UI renders these in vault terms; nothing
 * here is shown as template syntax.
 */
export function destinationSteps(recipe: CrosswalkerImportRecipe): DestinationStep[] {
	const out: DestinationStep[] = [];
	for (const entry of recipe.target.layout ?? []) {
		if (entry.mechanism !== 'folder' && entry.mechanism !== 'file') continue;
		const columns = [...new Set(templateColumns(entry.template))];
		const literal = columns.length === 0 ? entry.template.trim() || null : null;
		out.push({ kind: entry.mechanism === 'folder' ? 'folder' : 'note', columns, literal });
	}
	return out;
}

/** Distinct source columns the recipe reads. */
export function expectedColumnCount(recipe: CrosswalkerImportRecipe): number {
	return new Set(summarizeRecipeColumns(recipe).map((r) => r.column)).size;
}

/** Plain description of the source the recipe expects. */
export function sourceFormatLine(recipe: CrosswalkerImportRecipe): string {
	const sheet = recipe.source.detect?.sheet;
	const count = expectedColumnCount(recipe);
	const columns = `${count} column${count === 1 ? '' : 's'}`;
	return sheet ? `A spreadsheet with a "${sheet}" sheet, reading ${columns}` : `A table or spreadsheet, reading ${columns}`;
}
