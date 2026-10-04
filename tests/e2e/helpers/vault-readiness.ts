/**
 * vault-readiness.ts — condition-based barriers for E2E specs.
 *
 * WHY THIS EXISTS (triage 2026-08-24 §5.2 / §5.3)
 * ------------------------------------------------
 * 42 of 52 failures in the 2026-08-22 run were harness/environment verdicts.
 * Two recurring shapes:
 *
 *   1. `await browser.pause(200..500)` used as a stand-in for "Obsidian has
 *      finished indexing the files we just wrote". A fixed sleep asserts
 *      nothing. When it was too short the spec read `getFileCache(file)` as
 *      `null` and reported a *generation* failure, or ran a full Tier 2
 *      projection that fails closed on unreadable frontmatter. See the project
 *      memory rule "cache lag is not absence".
 *
 *   2. Exact-count Tier 2 assertions run against a sidecar carrying rows from
 *      an earlier spec, because the `before` hook closed `plugin.tier2Handle`
 *      but never emptied the database.
 *
 * The helpers below wait on the actual precondition instead, and each one
 * returns its diagnostics so a failing spec reports *what* was not ready
 * rather than just a downstream symptom.
 *
 * All polling runs renderer-side inside a single `executeObsidian` call — one
 * round trip, not one per poll.
 */

import { browser } from '@wdio/globals';

/** Result of a metadata-readiness barrier. Always returned, never thrown. */
export interface FrontmatterReadiness {
	/** True when every matched file satisfied the condition before the timeout. */
	ready: boolean;
	/** Markdown files matched by the path prefixes at the final poll. */
	total: number;
	/** Of those, how many had a readable frontmatter entry (plus `requireKeys`). */
	indexed: number;
	/** Up to 20 paths that were still not ready (empty when `ready`). */
	missing: string[];
	/** Wall-clock time spent waiting. */
	waitedMs: number;
}

/**
 * Wait until every Markdown file under `pathPrefixes` has a readable
 * metadata-cache frontmatter entry.
 *
 * **The condition:** for each matched file,
 * `app.metadataCache.getFileCache(file)?.frontmatter` is a non-null object and
 * contains every key in `requireKeys`. Optionally the *number* of matched files
 * must equal `expectedCount` first, which also covers "the writer has not
 * finished creating files yet".
 *
 * Use this before anything that reads the metadata cache or runs a full Tier 2
 * projection (`src/tier2/projector.ts` deliberately fails closed when a file
 * has no cache entry).
 *
 * For a pure writer-contract assertion — "did generation emit the right
 * frontmatter?" — prefer {@link readFrontmatterFromDisk}, which does not depend
 * on the cache at all.
 */
export async function waitForFrontmatterIndexed(options: {
	/** One or more vault-relative folder paths (or exact file paths). */
	pathPrefixes: string | string[];
	/** Wait for exactly this many matched files. Omit to accept "at least one". */
	expectedCount?: number;
	/** Frontmatter keys that must be present, e.g. `['_crosswalker']`. */
	requireKeys?: string[];
	timeoutMs?: number;
	pollMs?: number;
}): Promise<FrontmatterReadiness> {
	const prefixes = Array.isArray(options.pathPrefixes) ? options.pathPrefixes : [options.pathPrefixes];
	return browser.executeObsidian(
		async ({ app }, args) => {
			const started = Date.now();
			const matched = () =>
				app.vault.getMarkdownFiles().filter((file) =>
					args.prefixes.some((prefix) =>
						file.path === prefix || file.path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
					),
				);
			let total = 0;
			let missing: string[] = [];
			for (;;) {
				const files = matched();
				total = files.length;
				missing = [];
				for (const file of files) {
					const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
					const hasKeys = !!frontmatter
						&& args.requireKeys.every((key) => Object.prototype.hasOwnProperty.call(frontmatter, key));
					if (!hasKeys) missing.push(file.path);
				}
				const countOk = args.expectedCount < 0 ? total > 0 : total === args.expectedCount;
				if (countOk && missing.length === 0) {
					return { ready: true, total, indexed: total, missing: [], waitedMs: Date.now() - started };
				}
				if (Date.now() - started >= args.timeoutMs) break;
				await new Promise((resolve) => setTimeout(resolve, args.pollMs));
			}
			return {
				ready: false,
				total,
				indexed: total - missing.length,
				missing: missing.slice(0, 20),
				waitedMs: Date.now() - started,
			};
		},
		{
			prefixes,
			expectedCount: options.expectedCount ?? -1,
			requireKeys: options.requireKeys ?? [],
			timeoutMs: options.timeoutMs ?? 20_000,
			pollMs: options.pollMs ?? 100,
		},
	);
}

/**
 * Same barrier, but throws with the diagnostics when the condition is not met.
 * Use where an unmet precondition means the rest of the declaration is
 * meaningless (for example before a full projection).
 */
export async function requireFrontmatterIndexed(
	options: Parameters<typeof waitForFrontmatterIndexed>[0],
): Promise<FrontmatterReadiness> {
	const readiness = await waitForFrontmatterIndexed(options);
	if (!readiness.ready) {
		const where = Array.isArray(options.pathPrefixes) ? options.pathPrefixes.join(', ') : options.pathPrefixes;
		throw new Error(
			`metadata barrier timed out for [${where}] after ${readiness.waitedMs}ms: `
			+ `${readiness.indexed}/${readiness.total} files had readable frontmatter`
			+ (options.expectedCount === undefined ? '' : ` (expected ${options.expectedCount} files)`)
			+ `; still missing: ${readiness.missing.join(', ') || '(none — count mismatch)'}`,
		);
	}
	return readiness;
}

/**
 * Wait until Obsidian has a metadata-cache entry for every Markdown file in the
 * vault, and that has held for two consecutive polls.
 *
 * **The condition:** `app.metadataCache.getFileCache(file) !== null` for every
 * file in `app.vault.getMarkdownFiles()`. A `null` entry means "not indexed
 * yet" just as often as "no metadata", so this is the honest replacement for
 * the fixed 3–6 s "let the vault settle" sleeps that visual specs used to open
 * with.
 */
export async function waitForVaultIndexed(options: { timeoutMs?: number; pollMs?: number } = {}): Promise<{
	ready: boolean;
	total: number;
	pending: number;
	waitedMs: number;
}> {
	return browser.executeObsidian(
		async ({ app }, args) => {
			const started = Date.now();
			let total = 0;
			let pending = 0;
			let stableRounds = 0;
			for (;;) {
				const files = app.vault.getMarkdownFiles();
				total = files.length;
				pending = files.filter((file) => app.metadataCache.getFileCache(file) === null).length;
				if (pending === 0) {
					stableRounds += 1;
					if (stableRounds >= 2) {
						return { ready: true, total, pending: 0, waitedMs: Date.now() - started };
					}
				} else {
					stableRounds = 0;
				}
				if (Date.now() - started >= args.timeoutMs) break;
				await new Promise((resolve) => setTimeout(resolve, args.pollMs));
			}
			return { ready: false, total, pending, waitedMs: Date.now() - started };
		},
		{ timeoutMs: options.timeoutMs ?? 30_000, pollMs: options.pollMs ?? 150 },
	);
}

/**
 * Read a note's frontmatter straight from its file content, parsed with
 * Obsidian's own `parseYaml`. Bypasses `metadataCache` entirely.
 *
 * Writer-contract assertions ("generation emitted these keys") belong here:
 * the file on disk is the artifact under test, and reading it cannot turn an
 * indexing delay into a false generation failure. Reserve cache reads for
 * behavior that genuinely depends on cache integration.
 */
export async function readFrontmatterFromDisk(notePath: string): Promise<Record<string, unknown> | null> {
	return browser.executeObsidian(
		async ({ app, obsidian }, path) => {
			const file = app.vault.getAbstractFileByPath(path);
			if (!file || !(file instanceof obsidian.TFile)) return null;
			const content = await app.vault.read(file);
			const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
			if (!match) return null;
			try {
				return (obsidian.parseYaml(match[1]) ?? null) as Record<string, unknown> | null;
			} catch {
				return null;
			}
		},
		notePath,
	);
}

/**
 * Locate the first Markdown file under `pathPrefix` whose path contains
 * `contains`, and read its frontmatter from disk. Returns the resolved path so
 * a failing assertion can report which note it read.
 */
export async function readFrontmatterMatching(
	pathPrefix: string,
	contains: string,
): Promise<{ path: string | null; frontmatter: Record<string, unknown> | null }> {
	return browser.executeObsidian(
		async ({ app, obsidian }, args) => {
			const file = app.vault
				.getMarkdownFiles()
				.filter((candidate) => candidate.path.startsWith(`${args.pathPrefix}/`) && candidate.path.includes(args.contains))
				.sort((left, right) => left.path.localeCompare(right.path))[0];
			if (!file) return { path: null, frontmatter: null };
			const content = await app.vault.read(file);
			const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
			if (!match) return { path: file.path, frontmatter: null };
			try {
				return {
					path: file.path,
					frontmatter: (obsidian.parseYaml(match[1]) ?? null) as Record<string, unknown> | null,
				};
			} catch {
				return { path: file.path, frontmatter: null };
			}
		},
		{ pathPrefix, contains },
	);
}

/**
 * Bring the Tier 2 sidecar to a known-empty state and return the resulting
 * row counts so the caller can assert the precondition actually held.
 *
 * **Why truncation instead of deleting `.crosswalker.sqlite`:** the sidecar is
 * not a vault file. `src/tier2/sidecar.ts` opens it through the
 * `opfs-sahpool` VFS, so the bytes live inside an opaque OPFS pool — there is
 * nothing for `app.vault.adapter.remove()` to delete. A spec that assumed that
 * path would silently keep observing another spec's rows.
 *
 * The product's own `clearSidecar()` *does* now delete the pool entry (it goes
 * through the sahpool util's `unlink`, having previously reached for
 * `sqlite3.opfs.unlink`, which belongs to the other OPFS VFS and never matched
 * a sahpool-backed file). Truncation is still the right tool here: it leaves
 * the file and the schema in place, so a spec does not have to re-run
 * migrations, and it reports per-table counts the caller can assert on.
 * Deleting the pool entry is the behaviour under test for the reset command
 * itself, not the setup other specs want.
 *
 * Emptying every derived table is equivalent for test purposes (the schema is
 * recreated by migrations, and `runProjection()` rebuilds all rows from
 * canonical Tier 1) and is verifiable from the test.
 */
export async function resetTier2Sidecar(): Promise<{
	closedExistingHandle: boolean;
	counts: Record<string, number>;
	errors: string[];
}> {
	return browser.executeObsidian(async ({ app }) => {
		const plugin = (app as unknown as {
			plugins: { plugins: Record<string, {
				tier2Handle: { close(): Promise<void> } | null;
				openTier2(): Promise<{ db: { exec(opts: Record<string, unknown>): unknown } }>;
			}> };
		}).plugins.plugins['crosswalker'];

		let closedExistingHandle = false;
		if (plugin.tier2Handle) {
			await plugin.tier2Handle.close();
			plugin.tier2Handle = null;
			closedExistingHandle = true;
		}

		const handle = await plugin.openTier2();
		// Order matters only for readability; no FK constraints span these.
		const tables = ['closure_cache', 'closure_cache_state', 'junction_notes', 'mappings', 'concepts', 'ontologies'];
		const errors: string[] = [];
		const counts: Record<string, number> = {};
		for (const table of tables) {
			try {
				await handle.db.exec({ sql: `DELETE FROM ${table}` });
				const rows = await handle.db.exec({
					sql: `SELECT COUNT(*) FROM ${table}`,
					rowMode: 'array',
					returnValue: 'resultRows',
				}) as unknown[][];
				counts[table] = Number(rows[0]?.[0] ?? -1);
			} catch (err) {
				errors.push(`${table}: ${(err as Error)?.message ?? String(err)}`);
			}
		}
		return { closedExistingHandle, counts, errors };
	});
}
