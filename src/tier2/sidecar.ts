/**
 * Tier 2 sidecar lifecycle.
 *
 * Initializes sqlite-wasm using the OPFS sahpool VFS, opens the
 * .crosswalker.sqlite file at vault root, applies schema migrations,
 * and returns a handle for the projector + query API.
 *
 * **WASM packaging**: v0.1.5 ships **WASM-A** — plain
 * `@sqlite.org/sqlite-wasm` (no sqlite-vec). Its installed WASM bytes and
 * module text are embedded into main.js at build time, decoded lazily when
 * this sidecar initializes, and require no loose plugin-folder assets. The
 * official SQLite-team build is hardened for Electron's hybrid
 * `window`+`process` renderer environment via well-established
 * Obsidian-plugin precedent. WASM-B (sqlite-vec
 * compiled in via sqlite-vec-wasm-demo) hit 5 emscripten env-detection
 * issues in succession during integration; the demo artifact assumes
 * pure-browser semantics that Electron's renderer doesn't satisfy.
 *
 * **Vector layer (sqlite-vec) — deferred + revisit-by 2026-11-06**.
 * Tracked in Ch 24 §5 Q4 as a date-bound revisit. Most-likely
 * resolution paths: (1) `@sqlite.org/sqlite-wasm` ships sqlite-vec
 * compiled in; (2) Alex Garcia ships a production-quality
 * `sqlite-vec-wasm` separate from the demo. Either makes integration
 * ~30 min instead of multi-day. Schema reserves `concept_embeddings`
 * vec0 virtual table commented out so vec lands additively.
 *
 * Per [Ch 23 §9.5](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-04-bundle-engine-language-synthesis/), Web
 * Workers are unreliable for this workload — sqlite-wasm runs on the
 * main thread with cooperative yielding handled by the projector.
 */

import { App, Plugin } from 'obsidian';
import { normalizeSidecarPath } from '../settings/folder-settings';
import { getSqlite3MjsText, getSqlite3WasmBytes } from './sqlite-assets';

/**
 * Handle returned from openSidecar(). Wraps the sqlite-wasm
 * connection + provides lifecycle methods.
 *
 * The `db` field is intentionally typed loosely (`any`) because
 * sqlite-wasm's TypeScript types are brittle across versions and
 * the API surface we use is small + well-known. Wrapping helpers
 * in projector.ts/queries.ts narrow the surface area.
 */
export interface SidecarHandle {
	/** Underlying sqlite-wasm OO1 DB instance. */
	db: any;
	/** Path within the vault where the .crosswalker.sqlite lives. */
	sidecarPath: string;
	/** Close the sqlite handle (commits + flushes OPFS). */
	/**
	 * Close the database. Resolves `true` when it actually closed, `false` when
	 * the underlying close threw.
	 *
	 * It reports rather than throws because plugin unload calls this without
	 * awaiting, and an unhandled rejection there helps nobody. But the result
	 * is load-bearing for `clearSidecar()`: deleting a pool file whose access
	 * handle is still open returns that handle to the pool's free list while a
	 * live `sqlite3_file` still points at it, so a later open can be handed the
	 * same handle for a different logical file. Callers that are about to
	 * delete MUST check this and stop if it is `false`.
	 */
	close(): Promise<boolean>;
	/**
	 * True when opening this handle rebuilt the schema, which empties every
	 * derived table. Query results are meaningless until a projection runs, so
	 * the owner of this handle must reproject before serving queries.
	 */
	schemaRebuilt: boolean;
	/**
	 * Returns the SQLite library version for diagnostics.
	 * v0.1.5 ships plain sqlite-wasm; sqlite-vec is deferred — see Ch 24
	 * §5 Q4 for the date-bound revisit (2026-11-06).
	 */
	sqliteVersion(): string;
}

let cachedSqlite3: any = null;

/**
 * The utility object handed back by `installOpfsSAHPoolVfs`. It is the only
 * route to deleting a sahpool-backed file: pool files are stored inside an
 * opaque OPFS directory under randomized names, so the path the sidecar was
 * opened with does not exist on disk and cannot be unlinked by path.
 *
 * Cached next to `cachedSqlite3` because both are live runtime handles, not
 * data. Clearing the sidecar must never null either one: the WASM runtime and
 * the installed VFS outlive the file they happen to be holding.
 */
let cachedSahPoolUtil: any = null;

/**
 * Whether the most recent `openSidecar()` in this session fell back to
 * `:memory:`. Tri-state on purpose:
 *
 *   `null`  — no open has been attempted yet, so nothing is known.
 *   `true`  — this session demonstrably never persisted anything.
 *   `false` — this session opened a real pool-backed file.
 *
 * `clearSidecar()` needs this because "the pool will not install right now" is
 * NOT evidence that no file exists. The installer also rejects when another
 * holder owns the pool's access handles (a second vault window, or a previous
 * WASM instance after a plugin disable/enable, whose handles are never
 * released), and it caches that rejection for the rest of the session. In that
 * case the sidecar is intact on disk and will be served again the moment the
 * contention clears. Inferring "in-memory only" from a failed install would
 * therefore tell the user their data was discarded while every row survived.
 */
let openedInMemoryThisSession: boolean | null = null;

/**
 * Initialize the sqlite-wasm runtime once per plugin lifetime.
 * Subsequent calls return the cached module.
 *
 * `@sqlite.org/sqlite-wasm` ships an Electron-compatible build (no
 * env-detection throws on hybrid `window`+`process` renderer environments).
 * The build embeds its WASM bytes and module text into main.js. WASM decoding
 * happens per initialization attempt; the module text still loads through the
 * established Blob-URL import because Obsidian's app:// URLs cannot be
 * dynamic-imported as ES modules.
 */
async function initSqlite3(_plugin: Plugin): Promise<any> {
	if (cachedSqlite3) return cachedSqlite3;

	const wasmBytes = getSqlite3WasmBytes();
	const mjsText = getSqlite3MjsText();
	const mjsBlob = new Blob([mjsText], { type: 'application/javascript' });
	const mjsBlobUrl = URL.createObjectURL(mjsBlob);

	let mod: any;
	try {
		mod = await import(/* @vite-ignore */ /* webpackIgnore: true */ mjsBlobUrl);
	} finally {
		URL.revokeObjectURL(mjsBlobUrl);
	}
	const sqlite3InitModule = mod.default ?? mod.sqlite3InitModule ?? mod;

	cachedSqlite3 = await sqlite3InitModule({
		// Pass the embedded .wasm bytes directly, bypassing fetch entirely.
		wasmBinary: wasmBytes,
		locateFile: (filename: string) => {
			// The pinned module calls locateFile for sqlite3.wasm even when
			// wasmBinary is supplied. Returning the ordinary filename is expected and
			// silent; Emscripten consumes wasmBinary before attempting a fetch.
			if (filename === 'sqlite3.wasm') return filename;
			const error = new Error(
				`SQLite reporting database requested unexpected runtime asset "${filename}". `
				+ 'Reload Obsidian, then use "Developer tools: copy troubleshooting details to clipboard" '
				+ 'when reporting the problem.',
			);
			error.name = 'UnexpectedSqliteAssetRequestError';
			throw error;
		},
		print: () => {},
		printErr: (msg: string) => {
			if (msg && !msg.includes('OPFS')) console.warn('[crosswalker tier2]', msg);
		},
	});

	return cachedSqlite3;
}

/**
 * Install (or re-obtain) the OPFS sahpool VFS and return its utility object.
 *
 * The installer memoizes per VFS name, so a second call returns the same pool
 * utility rather than installing a second VFS. That is what lets the clear
 * path get a deletion handle on the same pool an open database is using.
 *
 * Throws when OPFS is unavailable (older WebViews, sandboxed test runners).
 * A failed install is cached as a rejected promise, so every later call throws
 * too. Callers must treat that as "no persistent store exists", not as
 * "deletion failed".
 */
async function installSahPool(sqlite3: any): Promise<any> {
	if (cachedSahPoolUtil) return cachedSahPoolUtil;
	const installer = sqlite3.installOpfsSAHPoolVfs;
	if (typeof installer !== 'function') {
		throw new Error('This sqlite-wasm build does not expose installOpfsSAHPoolVfs');
	}
	cachedSahPoolUtil = await installer({});
	return cachedSahPoolUtil;
}

/**
 * The key a file is registered under inside the sahpool.
 *
 * This MUST stay byte-identical to the pool's own derivation, which is
 * `new URL(name, 'file://localhost/').pathname` (its xOpen calls `getPath()`
 * on the name before using it as a map key). So this calls the same
 * expression rather than describing it.
 *
 * Two things that construction does, which an "add a leading slash" version
 * silently gets wrong:
 *   - It PERCENT-ENCODES. A sidecar path of `Vault Notes/.cw.sqlite` is keyed
 *     as `/Vault%20Notes/.cw.sqlite`, and a hand-rolled `/` + path yields
 *     `/Vault Notes/.cw.sqlite`, which matches nothing. The path is a
 *     user-editable setting, so spaces and non-ASCII are ordinary, not exotic.
 *   - It truncates at `#` and `?` exactly as the pool does.
 *
 * A mismatch here does not throw. It finds no files, deletes nothing, and
 * reports the index as already empty — the precise silent no-op this whole
 * change exists to remove. Reimplementing the rule is how that came back.
 */
function sahPoolKeyFor(sidecarPath: string): string {
	// S10 (2026-09-04). THE ONE normalization for this setting, shared with the
	// open path and with the settings accessor. A bare `normalizePath` here was a
	// second spelling: it does not trim, and it answers `'/'` where the accessor
	// answers the default file name, so a pasted leading space keyed the pool
	// under a name the pool does not hold - and a clear that finds no files
	// deletes nothing and reports the index as already empty. The leading-slash
	// strip is kept as a defensive no-op: the normalizer already removes edge
	// separators, and the URL constructor must not be handed an absolute path.
	return new URL(normalizeSidecarPath(sidecarPath).replace(/^\/+/, ''), 'file://localhost/').pathname;
}

/**
 * Open (or create + initialize) the Tier 2 sidecar at .crosswalker.sqlite
 * in the vault root.
 *
 * Uses the OPFS sahpool VFS (works on Capacitor without COOP/COEP,
 * per Ch 24 §4 mobile-portable path). On desktop Electron, OPFS is
 * available via Chromium; on mobile Capacitor it's available via the
 * Capacitor WebView's OPFS implementation.
 *
 * Schema migrations are applied at open time per migrations.ts.
 */
export async function openSidecar(
	plugin: Plugin,
	app: App,
	options: { sidecarPath?: string } = {},
): Promise<SidecarHandle> {
	const sqlite3 = await initSqlite3(plugin);
	// S10. Same reading as `sahPoolKeyFor` and as the settings accessor, so open
	// and clear cannot disagree about which file the query index is.
	const sidecarPath = normalizeSidecarPath(options.sidecarPath);

	// OPFS sahpool VFS is registered by sqlite-wasm at init when available.
	// We open the database via the OPFS path. sqlite-wasm exposes the OO1
	// DB API at sqlite3.oo1.DB.
	let db: any;
	try {
		// The OPFS sahpool VFS (mobile-portable; no COOP/COEP needed). Its
		// return value is retained: it is the only object that can delete a
		// pool-backed file later. The former `?? sqlite3.installOpfsVfs`
		// fallback was dead code. That symbol is module-local inside
		// sqlite-wasm and is never assigned onto the sqlite3 namespace.
		await installSahPool(sqlite3);

		// Open the database. The vault path is relative to the OPFS root
		// (which sqlite-wasm sees as its filesystem). For v0.1.5 we put
		// it at the OPFS root with the sidecar name.
		db = new sqlite3.oo1.DB({
			filename: `file:${sidecarPath}?vfs=opfs-sahpool`,
			flags: 'ct',
		});
		// Recorded only after the open succeeds, because this `try` covers both
		// the install and the open: a `:memory:` fallback does not imply the
		// pool failed to install, and vice versa.
		openedInMemoryThisSession = false;
	} catch (err) {
		// Fall back to in-memory if OPFS isn't available (test environments,
		// sandbox restrictions). Data won't persist across reload but the
		// engine still works — projector reprojects from canonical Tier 1
		// per Ch 24 §2 recovery property.
		console.warn('[crosswalker tier2] OPFS unavailable; falling back to in-memory sidecar', err);
		db = new sqlite3.oo1.DB(':memory:');
		openedInMemoryThisSession = true;
	}

	// Apply schema migrations (drops + recreates if version mismatch)
	const { applyMigrations } = await import('./migrations');
	const schemaRebuilt = applyMigrations(db);

	const sqliteVersion = (): string => {
		try {
			const rows = db.exec({
				sql: 'SELECT sqlite_version()',
				rowMode: 'array',
				returnValue: 'resultRows',
			}) as unknown[][];
			if (rows.length === 0) return '(unknown)';
			return String(rows[0][0]);
		} catch (err) {
			return `(error: ${(err as Error).message})`;
		}
	};

	return {
		db,
		sidecarPath,
		sqliteVersion,
		schemaRebuilt,
		async close() {
			try {
				db.close();
				return true;
			} catch (err) {
				// OPFS sahpool flushes on close, so a throw here means the file
				// may still hold its access handle. Reported, not swallowed:
				// see the interface doc for why a delete must not follow.
				console.warn('[crosswalker tier2] sidecar close failed', err);
				return false;
			}
		},
	};
}

/**
 * Outcome of a clear, reported so the caller can phrase the user-facing
 * message truthfully. "Nothing was deleted" and "a file was deleted" are
 * different facts, and the command must not present the first as the second.
 */
export interface ClearSidecarResult {
	/**
	 * True when the OPFS sahpool installed, i.e. a persisted sidecar file
	 * could exist in this environment. False means the session ran on the
	 * `:memory:` fallback and there was never a file to remove.
	 */
	hadPersistentStore: boolean;
	/** Pool entries actually removed: the sidecar plus any journal/WAL sibling. */
	removed: string[];
}

/**
 * Delete the sidecar file from the OPFS sahpool (used by the
 * `clear-tier-2-sidecar` command). The next openSidecar() call recreates the
 * file, migrations report `schemaRebuilt`, and the projector reprojects from
 * canonical Tier 1, so losing Tier 2 is safe by design.
 *
 * **Precondition: the caller must close and drop its handle first.** Unlinking
 * a file that still has an open sahpool access handle is undefined behavior,
 * and a surviving handle would keep answering queries out of the data the user
 * asked to destroy.
 *
 * **Why this does not use the plain OPFS API.** The previous implementation
 * called `sqlite3.opfs.unlink(path)` behind a `typeof === 'function'` guard.
 * `sqlite3.opfs` belongs to the async-proxy OPFS VFS and is deleted from the
 * namespace during sqlite-wasm's own bootstrap, so the guard was never true:
 * the function returned having done nothing while the command still announced
 * success. Deleting nothing must never look like success. That is the same
 * "absent is not fine" error class as the cache-lag bugs.
 *
 * Deletion is surgical (`unlink` per file) rather than `wipeFiles()`, which
 * would destroy unrelated pool files, or `removeVfs()`, which bricks the VFS
 * until the JS context reloads.
 *
 * @throws when the file is still present in the pool after unlinking, so the
 * command surfaces a real failure instead of a false success notice.
 */
export async function clearSidecar(
	plugin: Plugin,
	sidecarPath: string = '.crosswalker.sqlite',
): Promise<ClearSidecarResult> {
	const sqlite3 = await initSqlite3(plugin);

	let pool: any;
	try {
		pool = await installSahPool(sqlite3);
	} catch (err) {
		if (openedInMemoryThisSession === true) {
			// This session opened `:memory:` and the caller has already closed
			// that database, which destroyed the only copy of the rows. Absence
			// is established by what we did, not inferred from what we cannot
			// see, so reporting "nothing persisted" here is truthful.
			console.warn('[crosswalker tier2] in-memory session; no persisted sidecar to delete', err);
			return { hadPersistentStore: false, removed: [] };
		}
		// Otherwise we simply cannot see the pool, and not seeing it is not the
		// same as it being empty. The installer rejects while another holder
		// owns the pool's access handles (a second vault window, a stale WASM
		// instance after a plugin reload), and it caches that rejection for the
		// session. The file is intact in every one of those cases. Claiming a
		// reset here would be the original bug restated: a reassuring message
		// over work that did not happen.
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(
			'could not open the query index storage to clear it, so nothing was deleted. '
			+ 'Another vault window may be holding it. Close other windows and try again. '
			+ `(${detail})`,
		);
	}

	const key = sahPoolKeyFor(sidecarPath);
	// Rollback journals and WAL files are pool-persistent too (the schema sets
	// no journal_mode, so rollback journals exist transiently and a crash can
	// strand one). Leaving a sibling behind would let a later open recover rows
	// the user asked us to destroy.
	const matches = (name: string): boolean => name === key || name.startsWith(`${key}-`);

	const targets: string[] = (pool.getFileNames() as string[]).filter(matches);
	for (const name of targets) {
		// Synchronous despite the name: a map delete plus a header zero-fill
		// and truncate, not a Promise.
		pool.unlink(name);
	}

	// Re-read the pool instead of trusting the unlink return value. Gating the
	// success path on observing the file gone is the whole point of this fix.
	const survivors: string[] = (pool.getFileNames() as string[]).filter(matches);
	if (survivors.length > 0) {
		throw new Error(`the query index file is still present (${survivors.join(', ')})`);
	}

	// No separate cache invalidation is needed: the closure cache lives in the
	// `closure_cache` / `closure_cache_state` tables inside this very file, so
	// it dies with it. Nothing else in the plugin holds Tier 2 rows in memory.
	return { hadPersistentStore: true, removed: targets };
}
