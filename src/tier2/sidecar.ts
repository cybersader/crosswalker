/**
 * Tier 2 sidecar lifecycle.
 *
 * Opens the query index (`.crosswalker.sqlite`) on the persistent OPFS sahpool
 * VFS, applies schema migrations, and returns a handle for the projector and
 * query API.
 *
 * **Where sqlite runs (2026-10-03).** In a dedicated Worker built from a Blob
 * URL of text inlined in main.js (`worker-source.ts`, `worker-db.ts`). The
 * sahpool VFS needs `FileSystemFileHandle.createSyncAccessHandle`, which
 * Chromium exposes only inside dedicated Workers; when it was installed on the
 * main thread it failed on every host with "Missing required OPFS APIs" and the
 * index silently ran in memory. If no Worker can be created, the Worker cannot
 * load sqlite, or persistent storage is unavailable inside it, the index opens
 * in memory on the main thread exactly as before and says so through
 * `info().persistent === false` (W5).
 *
 * **WASM packaging**: v0.1.5 ships **WASM-A** — plain
 * `@sqlite.org/sqlite-wasm` (no sqlite-vec). Its installed WASM bytes and
 * module text are embedded into main.js at build time and require no loose
 * plugin-folder assets. The Worker receives both in one init message (the wasm
 * bytes transferred, not copied) and imports the module from its own Blob URL,
 * the same path the main thread uses for the in-memory fallback. WASM-B
 * (sqlite-vec compiled in via sqlite-vec-wasm-demo) hit 5 emscripten
 * env-detection issues in succession during integration; the demo artifact
 * assumes pure-browser semantics that Electron's renderer doesn't satisfy.
 *
 * **Vector layer (sqlite-vec) — deferred + revisit-by 2026-11-06**.
 * Tracked in Ch 24 §5 Q4 as a date-bound revisit. Most-likely
 * resolution paths: (1) `@sqlite.org/sqlite-wasm` ships sqlite-vec
 * compiled in; (2) Alex Garcia ships a production-quality
 * `sqlite-vec-wasm` separate from the demo. Either makes integration
 * ~30 min instead of multi-day. Schema reserves `concept_embeddings`
 * vec0 virtual table commented out so vec lands additively.
 *
 * Per [Ch 23 §9.5](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-04-bundle-engine-language-synthesis/)
 * the engine runs on the main thread with cooperative yielding and does not
 * depend on Web Workers — narrowed 2026-10-03: applies to the import engine,
 * not to a pure sqlite host. This Worker touches neither the Obsidian API nor
 * the DOM; the projector still walks the vault on the main thread and yields.
 */

import { App, Plugin } from 'obsidian';
import { normalizeSidecarPath } from '../settings/folder-settings';
import { getSqlite3MjsText, getSqlite3WasmBytes } from './sqlite-assets';
import { LocalDb, type Tier2Db, type Tier2DbInfo } from './db';
import { Tier2WorkerHost, tier2WorkerSupported, UNLOAD_GRACE_MS } from './worker-db';
import { getTier2WorkerText } from './worker-text';

/**
 * Handle returned from openSidecar(). Wraps the Tier 2 database and its
 * lifecycle.
 */
export interface SidecarHandle {
	/** The database. Every call is async; see `db.ts` for the contract. */
	db: Tier2Db;
	/** Path within the vault where the .crosswalker.sqlite lives. */
	sidecarPath: string;
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
	 * Where the rows live: the VFS, whether they survive a restart, and sqlite's
	 * name for the file. The settings tab and diagnostics read `persistent`.
	 */
	info(): Tier2DbInfo;
	/**
	 * Returns the SQLite library version for diagnostics, read once at open.
	 * v0.1.5 ships plain sqlite-wasm; sqlite-vec is deferred — see Ch 24
	 * §5 Q4 for the date-bound revisit (2026-11-06).
	 */
	sqliteVersion(): string;
}

/** Main-thread sqlite runtime. Loaded only for the in-memory fallback. */
let cachedSqlite3: any = null;

/**
 * The Worker hosting sqlite and the persistent pool, kept for the plugin's
 * lifetime. Reusing it across close, clear, and reopen is what keeps the
 * pool's file handles in one owner: a second Worker would have to wait for the
 * first to release them. Terminated by `shutdownSidecarHost()` at unload.
 */
let host: Tier2WorkerHost | null = null;

/**
 * What the most recent `openSidecar()` in this session opened. Tri-state on
 * purpose, read by `clearSidecar()`:
 *
 *   `null`                      — no open has been attempted yet.
 *   `{ persistent: false, ... }` — this session demonstrably never persisted.
 *   `{ persistent: true, ... }`  — this session opened a real pool-backed file.
 *
 * "The pool will not install right now" is NOT evidence that no file exists:
 * the installer also fails while another holder owns the pool's access handles
 * (a previous plugin instance's Worker still letting go). In that case the
 * index is intact on disk, so a clear must not claim it was discarded.
 */
let lastOpenInfo: Tier2DbInfo | null = null;

/** The current session's search index state, for the settings tab and diagnostics. */
export function lastSidecarInfo(): Tier2DbInfo | null {
	return lastOpenInfo ? { ...lastOpenInfo } : null;
}

/**
 * W5. The one user-facing sentence for where the search index lives. Shown in
 * settings and carried in the troubleshooting details, so the in-memory mode is
 * never silent.
 */
export function searchIndexStatusLine(info: Tier2DbInfo | null): string {
	if (!info) return 'Search index: starts the first time a search needs it';
	return info.persistent
		? 'Search index: stored on this device'
		: 'Search index: in memory, rebuilt each time Obsidian starts';
}

/**
 * Initialize the main-thread sqlite-wasm runtime once per plugin lifetime.
 * Only the in-memory fallback needs it.
 *
 * The module text still loads through the established Blob-URL import because
 * Obsidian's app:// URLs cannot be dynamic-imported as ES modules.
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
 * FNV-1a, for a short stable directory name. Not a security boundary: it only
 * keeps one vault's pool apart from another's under the same origin.
 */
function fnv1a32(text: string): string {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * W3. The plugin-private OPFS directory the pool lives in: one per vault, under
 * a `crosswalker` root, never the VFS default. Every vault window shares the
 * app's origin, so a shared directory would let two vaults contend for the same
 * file handles and read each other's index.
 */
export function poolDirectoryFor(app: App): string {
	const anyApp = app as unknown as { appId?: unknown; vault?: { getName?: () => string } };
	let vaultName = '';
	try { vaultName = anyApp.vault?.getName?.() ?? ''; } catch { vaultName = ''; }
	const appId = typeof anyApp.appId === 'string' ? anyApp.appId : '';
	return `crosswalker/vault-${fnv1a32(`${appId}|${vaultName}`)}`;
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
 * The live Worker host with persistent storage, starting one when needed.
 * Resolves `{ host: null, error }` when there is none to be had; the caller
 * decides what that absence means.
 */
async function acquireHost(app: App): Promise<{ host: Tier2WorkerHost | null; error: unknown }> {
	if (host && !host.dead && host.poolAvailable) return { host, error: null };
	if (host) {
		host.terminate();
		host = null;
	}
	if (!tier2WorkerSupported()) {
		return { host: null, error: new Error('Workers are not available in this environment') };
	}
	let started: Tier2WorkerHost;
	try {
		started = await Tier2WorkerHost.start({
			workerText: getTier2WorkerText(),
			mjsText: getSqlite3MjsText(),
			wasmBytes: getSqlite3WasmBytes(),
			poolDirectory: poolDirectoryFor(app),
		});
	} catch (error) {
		return { host: null, error };
	}
	if (!started.poolAvailable) {
		const error = started.poolError ?? new Error('Persistent storage is unavailable');
		started.terminate();
		return { host: null, error };
	}
	host = started;
	return { host, error: null };
}

/**
 * Open (or create + initialize) the Tier 2 sidecar.
 *
 * Tries the Worker-hosted persistent pool first; falls back to an in-memory
 * database on the main thread (W5). The fallback logs the same warning it
 * always has and reports `info().persistent === false`, which the settings
 * tab shows as "in memory, rebuilt each time Obsidian starts".
 *
 * Schema migrations are applied at open time per migrations.ts.
 */
export async function openSidecar(
	plugin: Plugin,
	app: App,
	options: { sidecarPath?: string } = {},
): Promise<SidecarHandle> {
	// S10. Same reading as `sahPoolKeyFor` and as the settings accessor, so open
	// and clear cannot disagree about which file the query index is.
	const sidecarPath = normalizeSidecarPath(options.sidecarPath);

	let db: Tier2Db | null = null;
	let fallbackReason: unknown = null;
	const acquired = await acquireHost(app);
	if (acquired.host) {
		try {
			db = await acquired.host.open(sidecarPath);
		} catch (err) {
			fallbackReason = err;
		}
	} else {
		fallbackReason = acquired.error;
	}

	if (!db) {
		// Data won't persist across reload but the engine still works: the
		// projector reprojects from canonical Tier 1 per Ch 24 §2 recovery.
		console.warn('[crosswalker tier2] OPFS unavailable; falling back to in-memory sidecar', fallbackReason);
		const sqlite3 = await initSqlite3(plugin);
		db = new LocalDb(new sqlite3.oo1.DB(':memory:'), { vfs: 'memory', persistent: false, filename: '' });
	}
	const opened = db;
	lastOpenInfo = opened.info();

	// Apply schema migrations (drops + recreates if version mismatch)
	const { applyMigrations } = await import('./migrations');
	const schemaRebuilt = await applyMigrations(opened);

	let version = '(unknown)';
	try {
		const rows = await opened.exec({
			sql: 'SELECT sqlite_version()',
			rowMode: 'array',
			returnValue: 'resultRows',
		});
		if (rows.length > 0) version = String(rows[0][0]);
	} catch (err) {
		version = `(error: ${(err as Error).message})`;
	}

	return {
		db: opened,
		sidecarPath,
		schemaRebuilt,
		sqliteVersion: () => version,
		info: () => opened.info(),
		async close() {
			try {
				await opened.close();
				return true;
			} catch (err) {
				// A throw here means the file may still hold its access handle.
				// Reported, not swallowed: see the interface doc for why a delete
				// must not follow.
				console.warn('[crosswalker tier2] sidecar close failed', err);
				return false;
			}
		},
	};
}

/**
 * W6 unload. Asks the Worker to close, then terminates it after the
 * acknowledgement or a 500 ms grace. Never throws and need not be awaited.
 */
export async function shutdownSidecarHost(graceMs: number = UNLOAD_GRACE_MS): Promise<void> {
	const current = host;
	host = null;
	if (current) await current.shutdown(graceMs);
}

/**
 * Outcome of a clear, reported so the caller can phrase the user-facing
 * message truthfully. "Nothing was deleted" and "a file was deleted" are
 * different facts, and the command must not present the first as the second.
 */
export interface ClearSidecarResult {
	/**
	 * True when the persistent pool was reachable, i.e. a persisted sidecar
	 * file could exist in this environment. False means the session ran on the
	 * in-memory fallback and there was never a file to remove.
	 */
	hadPersistentStore: boolean;
	/** Pool entries actually removed: the sidecar plus any journal/WAL sibling. */
	removed: string[];
}

/**
 * Delete the sidecar file from the persistent pool (used by the
 * `clear-tier-2-sidecar` command). The next openSidecar() call recreates the
 * file, migrations report `schemaRebuilt`, and the projector reprojects from
 * canonical Tier 1, so losing Tier 2 is safe by design.
 *
 * **Precondition: the caller must close and drop its handle first** (W6: await
 * the close, then delete). The delete is a request to the same Worker that
 * holds the pool, queued behind that close. Unlinking a file that still has an
 * open access handle is undefined behavior; the Worker refuses it.
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
	const acquired = await acquireHost(plugin.app);
	if (!acquired.host) {
		const err = acquired.error;
		if (lastOpenInfo !== null && !lastOpenInfo.persistent) {
			// This session opened in memory and the caller has already closed
			// that database, which destroyed the only copy of the rows. Absence
			// is established by what we did, not inferred from what we cannot
			// see, so reporting "nothing persisted" here is truthful.
			console.warn('[crosswalker tier2] in-memory session; no persisted sidecar to delete', err);
			return { hadPersistentStore: false, removed: [] };
		}
		// Otherwise we simply cannot see the pool, and not seeing it is not the
		// same as it being empty. Claiming a reset here would be the original
		// bug restated: a reassuring message over work that did not happen.
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(
			'could not open the query index storage to clear it, so nothing was deleted. '
			+ 'Another vault window may be holding it. Close other windows and try again. '
			+ `(${detail})`,
		);
	}

	// Rollback journals and WAL files are pool-persistent too, so the Worker
	// removes the key and every `<key>-` sibling. Leaving a sibling behind
	// would let a later open recover rows the user asked us to destroy.
	const { removed, survivors } = await acquired.host.unlink(sahPoolKeyFor(sidecarPath));

	// Gating the success path on observing the file gone, not on the unlink
	// call returning, is the whole point of this function.
	if (survivors.length > 0) {
		throw new Error(`the query index file is still present (${survivors.join(', ')})`);
	}

	// No separate cache invalidation is needed: the closure cache lives in the
	// `closure_cache` / `closure_cache_state` tables inside this very file, so
	// it dies with it. Nothing else in the plugin holds Tier 2 rows in memory.
	return { hadPersistentStore: true, removed };
}
