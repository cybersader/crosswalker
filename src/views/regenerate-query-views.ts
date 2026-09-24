/**
 * regenerate-query-views.ts — Phase 4.6 (Layout B+)
 *
 * Scans the vault for canonical query state at `_crosswalker/queries/**\/index.md`
 * and regenerates each query's `view.base` from the frontmatter's recipe + params.
 * Idempotent — skips files whose generated content already matches what would
 * be written.
 *
 * Backward-compat detection: also flags legacy Phase 4.5 host-note frontmatter
 * (`crosswalker_query:` with schema_version 1) — these are NOT regenerated in
 * place; instead they're surfaced as `legacyDetected` count for the migration
 * command to handle.
 *
 * Two entry points:
 *   - `regenerateAll(app, debug)` — scan + regenerate every query
 *   - `regenerateOne(app, file, debug)` — single index.md
 *
 * Runs on plugin load (onLayoutReady) as stale-state recovery + as the
 * explicit `Crosswalker: Maintenance: refresh saved query views` command.
 */

import type { App, TFile } from 'obsidian';
import type { DebugLog } from '../utils/debug';
import { readQueryFrontmatter } from './query-frontmatter-io';
import { renderRecipeTemplate } from './recipe-templates';
import { buildBaseFileContent } from './apply-query-to-note';

const QUERY_FOLDER_PREFIX = '_crosswalker/queries/';

export interface RegenerateResult {
	scanned: number;
	regenerated: number;
	skipped: number;
	legacyDetected: number;
	errors: Array<{ note: string; reason: string }>;
}

/**
 * Scan the vault for canonical query state (`_crosswalker/queries/<slug>/index.md`)
 * and regenerate each one's view.base. Also detects legacy Phase 4.5 host-note
 * frontmatter for migration prompting.
 */
export async function regenerateAll(app: App, debug?: DebugLog): Promise<RegenerateResult> {
	const result: RegenerateResult = {
		scanned: 0,
		regenerated: 0,
		skipped: 0,
		legacyDetected: 0,
		errors: [],
	};

	const allFiles = app.vault.getMarkdownFiles();
	for (const file of allFiles) {
		const isCanonical = file.path.startsWith(QUERY_FOLDER_PREFIX) && file.path.endsWith('/index.md');

		if (isCanonical) {
			result.scanned += 1;
			try {
				const subResult = await regenerateOne(app, file, debug, { _shared: true });
				if (subResult === 'skipped') result.skipped += 1;
				else if (subResult === 'regenerated') result.regenerated += 1;
				else if (subResult === 'not-applicable') {
					// No crosswalker_query: block on a canonical index.md — odd, not an error
				} else {
					result.errors.push({ note: file.path, reason: subResult });
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				result.errors.push({ note: file.path, reason: msg });
			}
		} else {
			// Legacy detection — host note with v1 crosswalker_query: frontmatter
			const fmResult = await readQueryFrontmatter(app, file);
			if (fmResult.present) {
				result.legacyDetected += 1;
			}
		}
	}

	debug?.info('view', 'regenerate-all-complete', `Regeneration scan complete`, {
		scanned: result.scanned,
		regenerated: result.regenerated,
		skipped: result.skipped,
		legacyDetected: result.legacyDetected,
		errorCount: result.errors.length,
	});

	return result;
}

type SingleResult = 'regenerated' | 'skipped' | 'not-applicable' | string;

/**
 * Regenerate a single canonical index.md's view.base sibling.
 */
export async function regenerateOne(
	app: App,
	file: TFile,
	debug?: DebugLog,
	opts: { _shared?: boolean } = {},
): Promise<SingleResult> {
	const fm = await readQueryFrontmatter(app, file);

	if (!fm.present) {
		return 'not-applicable';
	}
	if (!fm.data) {
		const err = `Malformed crosswalker_query block: ${fm.errors.join('; ')}`;
		if (!opts._shared) {
			debug?.warn('view', 'regenerate-malformed-frontmatter', `Skipping query with malformed frontmatter`, {
				note: file.path,
				errors: fm.errors,
			});
		}
		return err;
	}

	const { recipe, params, view_file: viewFile, query_id: queryId, slug } = fm.data;

	// Re-render the template
	const baseBody = renderRecipeTemplate(recipe, params);
	if (baseBody === null) {
		const err = `No template registered for recipe '${recipe}': cannot regenerate`;
		if (!opts._shared) {
			debug?.warn('view', 'regenerate-missing-template', err, {
				note: file.path,
				recipe,
			});
		}
		return err;
	}

	const newContent = buildBaseFileContent(baseBody, {
		recipeId: recipe,
		queryId,
		slug,
		sourceNotePath: file.path,
	});

	// Idempotent check — compare semantic YAML body, skip if identical
	const existing = app.vault.getAbstractFileByPath(viewFile);
	if (existing && 'path' in existing && typeof (existing as { extension?: string }).extension === 'string') {
		const existingFile = existing as TFile;
		try {
			const existingContent = await app.vault.read(existingFile);
			if (yamlBodyMatches(existingContent, newContent)) {
				return 'skipped';
			}
			await app.vault.modify(existingFile, newContent);
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
	} else {
		// view.base missing — create it
		const parentPath = viewFile.split('/').slice(0, -1).join('/');
		if (parentPath && !app.vault.getAbstractFileByPath(parentPath)) {
			try {
				await app.vault.createFolder(parentPath);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (!msg.includes('already exists')) {
					return msg;
				}
			}
		}
		try {
			await app.vault.create(viewFile, newContent);
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
	}

	if (!opts._shared) {
		debug?.info('view', 'query-regenerated', `Regenerated view.base: ${viewFile}`, {
			note: file.path,
			viewFile,
			queryId,
			slug,
			recipe,
		});
	}

	return 'regenerated';
}

/**
 * Compare two `.base` file contents by their YAML body (strips the header
 * comment block which always contains a timestamp). Exported for testing.
 */
export function yamlBodyMatches(a: string, b: string): boolean {
	return stripHeaderComments(a) === stripHeaderComments(b);
}

function stripHeaderComments(content: string): string {
	const lines = content.split('\n');
	let i = 0;
	while (i < lines.length && (lines[i].startsWith('#') || lines[i].trim() === '')) {
		i += 1;
	}
	return lines.slice(i).join('\n').trim();
}
