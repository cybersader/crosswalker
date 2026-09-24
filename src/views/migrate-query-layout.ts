/**
 * migrate-query-layout.ts — Phase 4.6 one-shot migration.
 *
 * Migrates Phase 4.5 host-note-frontmatter queries to Layout B+ per-query
 * folders. Idempotent — re-running the command on a migrated vault is a no-op.
 *
 * For each host note with `crosswalker_query:` (schema_version 1) frontmatter:
 *   1. Derive a slug from the recipe display name (collision-suffix on conflict)
 *   2. Create `_crosswalker/queries/<slug>/index.md` with v2 frontmatter
 *   3. Create `_crosswalker/queries/<slug>/view.base` from recipe + params
 *   4. Rewrite the embed in the host note from
 *      `![[_crosswalker/views/q-<id>.base]]` →  `![[<slug>/view.base]]`
 *   5. Strip `crosswalker_query:` from the host note (or rename to
 *      `crosswalker_query_legacy:` for one minor version of read-only safety)
 *   6. Leave the legacy `_crosswalker/views/q-<id>.base` file in place for one
 *      minor version (a future v0.2 cleanup command removes them).
 *
 * Decision chain: synthesis log `2026-05-18-query-state-location-synthesis` §7.
 */

import type { App, TFile } from 'obsidian';
import type { DebugLog } from '../utils/debug';
import { renderRecipeTemplate } from './recipe-templates';
import {
	slugify,
	addCollisionSuffix,
	queryFolderFor,
	indexFileFor,
	viewFileFor,
	validateQueryFrontmatterV1,
	QUERY_FRONTMATTER_SCHEMA_VERSION_V1,
	type CrosswalkerQueryFrontmatter,
} from './query-frontmatter-schema';
import { buildBaseFileContent, buildIndexBody } from './apply-query-to-note';
import { buildEmbed } from './insert-base-block';
import { writeQueryFrontmatter, buildFrontmatter } from './query-frontmatter-io';
import type { LoadedRecipe } from './recipe-loader';

export interface MigrateResult {
	scanned: number;
	migrated: number;
	skipped: number;
	errors: Array<{ note: string; reason: string }>;
}

export interface MigrateOptions {
	app: App;
	debug?: DebugLog;
	/** Recipe catalog — used to look up display names for slug derivation. */
	recipes?: LoadedRecipe[];
	/** Default behavior: rename host frontmatter to crosswalker_query_legacy. Set false to delete. */
	preserveLegacyFrontmatter?: boolean;
}

/**
 * Run the one-shot migration. Idempotent — a host note with no v1 frontmatter
 * is skipped. A host note whose v1 frontmatter has already been migrated (the
 * target folder exists with matching query_id) is also skipped.
 */
export async function migrateQueriesToFolderLayout(options: MigrateOptions): Promise<MigrateResult> {
	const { app, debug, recipes = [], preserveLegacyFrontmatter = true } = options;
	const result: MigrateResult = {
		scanned: 0,
		migrated: 0,
		skipped: 0,
		errors: [],
	};

	const allFiles = app.vault.getMarkdownFiles();
	for (const file of allFiles) {
		// Skip notes that ARE the new canonical state
		if (file.path.startsWith('_crosswalker/queries/') && file.path.endsWith('/index.md')) {
			continue;
		}

		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || !fm.crosswalker_query) continue;

		result.scanned += 1;

		// Validate as v1 — if not v1 shape, skip with note
		const legacyResult = validateQueryFrontmatterV1(fm.crosswalker_query);
		if (!legacyResult.valid) {
			// Could be a v2 reference (rare during migration), or malformed — skip
			result.skipped += 1;
			debug?.info('view', 'migrate-skip-non-v1', `Skipping non-v1 frontmatter on ${file.path}`, {
				note: file.path,
				errors: legacyResult.errors,
			});
			continue;
		}

		try {
			const subResult = await migrateOneNote(app, file, fm.crosswalker_query as LegacyV1Block, recipes, preserveLegacyFrontmatter, debug);
			if (subResult === 'migrated') result.migrated += 1;
			else if (subResult === 'skipped') result.skipped += 1;
			else result.errors.push({ note: file.path, reason: subResult });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			result.errors.push({ note: file.path, reason: msg });
		}
	}

	debug?.info('view', 'migrate-complete', `Migration scan complete`, {
		scanned: result.scanned,
		migrated: result.migrated,
		skipped: result.skipped,
		errorCount: result.errors.length,
	});

	return result;
}

interface LegacyV1Block {
	query_id: string;
	recipe: string;
	shape: string;
	params: Record<string, unknown>;
	view_file: string;
	generated_at: string;
	schema_version: typeof QUERY_FRONTMATTER_SCHEMA_VERSION_V1;
}

type MigrateOneResult = 'migrated' | 'skipped' | string;

async function migrateOneNote(
	app: App,
	hostNote: TFile,
	legacy: LegacyV1Block,
	recipes: LoadedRecipe[],
	preserveLegacyFrontmatter: boolean,
	debug?: DebugLog,
): Promise<MigrateOneResult> {
	// 1. Derive slug from recipe display name (fallback to recipe id, then query_id)
	const recipe = recipes.find((r) => r.id === legacy.recipe);
	const displayName = recipe?.title ?? legacy.recipe;
	let slug = slugify(displayName, legacy.query_id);

	// 2. Idempotency check — if a folder already exists with matching query_id, treat as already migrated
	const targetFolder = queryFolderFor(slug);
	const folderExists = !!app.vault.getAbstractFileByPath(targetFolder);
	if (folderExists) {
		// Verify it's our query_id; if so, skip — already migrated
		const idxPath = indexFileFor(slug);
		const idxFile = app.vault.getAbstractFileByPath(idxPath);
		if (idxFile && 'path' in idxFile) {
			const fm = app.metadataCache.getFileCache(idxFile as TFile)?.frontmatter;
			if (fm?.crosswalker_query?.query_id === legacy.query_id) {
				return 'skipped';
			}
		}
		// Folder exists but is a different query — append collision suffix
		slug = addCollisionSuffix(slug);
	}

	// 3. Render view.base body from recipe + params
	const baseBody = renderRecipeTemplate(legacy.recipe, legacy.params);
	if (baseBody === null) {
		return `No template registered for recipe '${legacy.recipe}'. Cannot migrate (note: ${hostNote.path})`;
	}

	// 4. Build v2 frontmatter
	const viewFilePath = viewFileFor(slug);
	const newFrontmatter: CrosswalkerQueryFrontmatter = buildFrontmatter({
		query_id: legacy.query_id, // preserve!
		slug,
		recipe: legacy.recipe,
		shape: legacy.shape,
		params: legacy.params,
		view_file: viewFilePath,
	});

	// 5. Create folder + index.md
	const folderPath = queryFolderFor(slug);
	if (!app.vault.getAbstractFileByPath(folderPath)) {
		try {
			await app.vault.createFolder(folderPath);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes('already exists')) throw err;
		}
	}

	const indexPath = indexFileFor(slug);
	if (!app.vault.getAbstractFileByPath(indexPath)) {
		await app.vault.create(indexPath, buildIndexBody(newFrontmatter, slug));
	}

	const indexFile = app.vault.getAbstractFileByPath(indexPath) as TFile;
	const writeFmResult = await writeQueryFrontmatter(app, indexFile, newFrontmatter);
	if (!writeFmResult.ok) {
		return `Failed to write index.md frontmatter: ${(writeFmResult.errors ?? []).join('; ')}`;
	}

	// 6. Create view.base
	const baseFileContent = buildBaseFileContent(baseBody, {
		recipeId: legacy.recipe,
		queryId: legacy.query_id,
		slug,
		sourceNotePath: hostNote.path,
	});
	const existingBase = app.vault.getAbstractFileByPath(viewFilePath);
	if (existingBase && 'path' in existingBase && typeof (existingBase as { extension?: string }).extension === 'string') {
		await app.vault.modify(existingBase as TFile, baseFileContent);
	} else {
		await app.vault.create(viewFilePath, baseFileContent);
	}

	// 7. Rewrite embed in host note + strip legacy frontmatter
	await rewriteHostNote(app, hostNote, legacy.view_file, viewFilePath, preserveLegacyFrontmatter);

	debug?.info('view', 'migrate-one-note-complete', `Migrated query to Layout B+`, {
		hostNote: hostNote.path,
		slug,
		queryId: legacy.query_id,
		newIndexFile: indexPath,
		newViewFile: viewFilePath,
		legacyViewFile: legacy.view_file,
	});

	return 'migrated';
}

async function rewriteHostNote(
	app: App,
	hostNote: TFile,
	legacyViewFile: string,
	newViewFile: string,
	preserveLegacyFrontmatter: boolean,
): Promise<void> {
	const content = await app.vault.read(hostNote);
	const newEmbed = buildEmbed(newViewFile);
	const legacyEmbedRe = new RegExp(`!\\[\\[${escapeRegex(legacyViewFile)}(\\#[^\\]]+)?\\]\\]`, 'g');

	let newContent: string;
	if (legacyEmbedRe.test(content)) {
		newContent = content.replace(legacyEmbedRe, newEmbed);
	} else {
		newContent = content;
	}

	await app.vault.modify(hostNote, newContent);

	// Strip / rename legacy frontmatter via processFrontMatter
	type FileManagerLike = { processFrontMatter(file: TFile, cb: (fm: Record<string, unknown>) => void): Promise<void> };
	const fileManager = (app as unknown as { fileManager: FileManagerLike }).fileManager;
	await fileManager.processFrontMatter(hostNote, (fm: Record<string, unknown>) => {
		if (preserveLegacyFrontmatter && fm.crosswalker_query) {
			fm.crosswalker_query_legacy = fm.crosswalker_query;
		}
		delete fm.crosswalker_query;
	});
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
