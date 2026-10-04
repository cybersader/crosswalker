/**
 * The Tier 2 Worker program (W2, 2026-10-03).
 *
 * This file is bundled on its own by the build into a text string that main.js
 * carries (`virtual:tier2-worker-text`). At runtime the main thread turns that
 * text into a Blob URL and starts a module Worker from it, so the plugin still
 * ships only main.js, manifest.json and styles.css.
 *
 * Why a Worker at all: the persistent OPFS pool sqlite uses (`opfs-sahpool`)
 * needs `FileSystemFileHandle.createSyncAccessHandle`, which Chromium exposes
 * only inside dedicated Workers. On the main thread the pool never installed,
 * so the index silently ran in memory on every host.
 *
 * Rules for this file: no Obsidian import and no DOM. It runs in a Worker, and
 * in unit tests the same handler runs in-process behind a fake transport.
 *
 * Protocol: the main thread sends one request at a time, each with an id. The
 * handler also serializes internally, so a request that arrives while `init` is
 * still loading the module waits for it rather than racing it.
 */

import { runBatch, runOne, toTier2DbError, type ExecInput, type RawExecDb, type Tier2DbInfo } from './db';

/** Bumped when the message shapes change. Also the build's embed sentinel. */
export const TIER2_WORKER_PROTOCOL = 'cw-tier2-worker-v1';

/** Name the persistent pool VFS registers under. Probes assert on it. */
export const SAHPOOL_VFS_NAME = 'opfs-sahpool';

export type Tier2WorkerRequest =
	| {
		id: number;
		type: 'init';
		protocol: string;
		mjsText: string;
		wasmBytes: Uint8Array;
		poolDirectory: string;
	}
	| { id: number; type: 'open'; sidecarPath: string }
	| { id: number; type: 'exec'; input: ExecInput }
	| { id: number; type: 'execBatch'; statements: ExecInput[] }
	| { id: number; type: 'close' }
	| { id: number; type: 'unlink'; key: string };

export interface Tier2WorkerInitResult {
	protocol: string;
	sqliteVersion: string;
	/** False when the persistent pool could not be installed in this Worker. */
	poolAvailable: boolean;
	/** The install failure, when there was one. */
	poolError: { name: string; message: string } | null;
}

export interface Tier2WorkerUnlinkResult {
	removed: string[];
	survivors: string[];
}

export interface Tier2WorkerErrorPayload {
	name: string;
	message: string;
	statementIndex: number | null;
	sql: string | null;
}

export type Tier2WorkerResponse =
	| { id: number; ok: true; value: unknown }
	| { id: number; ok: false; error: Tier2WorkerErrorPayload };

type Post = (message: Tier2WorkerResponse) => void;

/**
 * Install attempts when another holder still owns the pool's file handles. A
 * previous plugin instance's Worker releases them when it terminates, but not
 * synchronously, so a plugin reload can briefly see them as taken.
 */
const POOL_INSTALL_ATTEMPTS = 8;
const POOL_INSTALL_RETRY_MS = 250;

function isContention(error: unknown): boolean {
	const name = error instanceof Error ? error.name : '';
	return name === 'NoModificationAllowedError' || name === 'InvalidStateError';
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorPayload(error: unknown): Tier2WorkerErrorPayload {
	const wrapped = toTier2DbError(error);
	return {
		name: wrapped.name,
		message: wrapped.message,
		statementIndex: wrapped.statementIndex,
		sql: wrapped.sql,
	};
}

/** Pool key, identical to the pool's own `getPath()` derivation. */
function poolKeyOf(filename: string): string {
	return new URL(filename, 'file://localhost/').pathname;
}

/**
 * Build the request handler. `post` delivers a response to the main thread.
 * Returned function accepts one request; responses go through `post`.
 */
export function createTier2WorkerHandler(post: Post): (request: Tier2WorkerRequest) => Promise<void> {
	let sqlite3: any = null;
	let pool: any = null;
	let poolError: { name: string; message: string } | null = null;
	let db: (RawExecDb & { close(): unknown }) | null = null;
	let openKey: string | null = null;
	let chain: Promise<void> = Promise.resolve();

	async function loadModule(mjsText: string, wasmBytes: Uint8Array): Promise<any> {
		const url = URL.createObjectURL(new Blob([mjsText], { type: 'text/javascript' }));
		let mod: any;
		try {
			mod = await import(/* @vite-ignore */ /* webpackIgnore: true */ url);
		} finally {
			URL.revokeObjectURL(url);
		}
		const initModule = mod.default ?? mod.sqlite3InitModule ?? mod;
		return initModule({
			wasmBinary: wasmBytes,
			locateFile: (filename: string) => {
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
			printErr: () => {},
		});
	}

	async function installPool(directory: string): Promise<void> {
		const installer = sqlite3.installOpfsSAHPoolVfs;
		if (typeof installer !== 'function') {
			poolError = { name: 'Error', message: 'This sqlite-wasm build does not expose installOpfsSAHPoolVfs' };
			return;
		}
		for (let attempt = 1; attempt <= POOL_INSTALL_ATTEMPTS; attempt += 1) {
			try {
				// Default VFS name, so probes and diagnostics read `opfs-sahpool`;
				// a plugin-private directory, so this pool never contends with the
				// host's own OPFS files or another vault's pool (W3).
				pool = await installer({ directory, forceReinitIfPreviouslyFailed: attempt > 1 });
				poolError = null;
				return;
			} catch (error) {
				poolError = {
					name: error instanceof Error ? error.name : 'Error',
					message: error instanceof Error ? error.message : String(error),
				};
				if (!isContention(error) || attempt === POOL_INSTALL_ATTEMPTS) return;
				await delay(POOL_INSTALL_RETRY_MS);
			}
		}
	}

	function describeOpen(): Tier2DbInfo {
		let vfs = SAHPOOL_VFS_NAME;
		let filename = '';
		try { vfs = (db as any).dbVfsName?.() || SAHPOOL_VFS_NAME; } catch { /* keep default */ }
		try { filename = (db as any).dbFilename?.() ?? ''; } catch { /* keep default */ }
		return { vfs, persistent: true, filename };
	}

	async function handle(request: Tier2WorkerRequest): Promise<unknown> {
		switch (request.type) {
			case 'init': {
				if (request.protocol !== TIER2_WORKER_PROTOCOL) {
					throw new Error(`Search index worker protocol mismatch (${request.protocol})`);
				}
				if (!sqlite3) sqlite3 = await loadModule(request.mjsText, request.wasmBytes);
				if (!pool) await installPool(request.poolDirectory);
				let sqliteVersion = '(unknown)';
				try { sqliteVersion = String(sqlite3.version?.libVersion ?? sqlite3.capi?.sqlite3_libversion?.() ?? '(unknown)'); } catch { /* diagnostic only */ }
				const result: Tier2WorkerInitResult = {
					protocol: TIER2_WORKER_PROTOCOL,
					sqliteVersion,
					poolAvailable: pool !== null,
					poolError,
				};
				return result;
			}
			case 'open': {
				if (!sqlite3) throw new Error('Search index worker used before init');
				if (!pool) throw new Error(poolError?.message ?? 'Persistent storage is unavailable');
				if (db) throw new Error('Search index worker already has an open database');
				db = new sqlite3.oo1.DB({
					filename: `file:${request.sidecarPath}?vfs=${SAHPOOL_VFS_NAME}`,
					flags: 'c',
				});
				openKey = poolKeyOf(request.sidecarPath);
				return describeOpen();
			}
			case 'exec': {
				if (!db) throw new Error('The search index is closed');
				return runOne(db, request.input);
			}
			case 'execBatch': {
				if (!db) throw new Error('The search index is closed');
				runBatch(db, request.statements);
				return undefined;
			}
			case 'close': {
				if (!db) return true;
				const closing = db;
				// Cleared before closing: a close that throws must not leave a
				// half-closed handle that later requests keep using.
				db = null;
				openKey = null;
				closing.close();
				return true;
			}
			case 'unlink': {
				if (!pool) throw new Error(poolError?.message ?? 'Persistent storage is unavailable');
				const key = request.key;
				const matches = (name: string): boolean => name === key || name.startsWith(`${key}-`);
				if (db && openKey !== null && matches(openKey)) {
					throw new Error('the query index is still open (an access handle is held), so it was not deleted');
				}
				const targets = (pool.getFileNames() as string[]).filter(matches);
				for (const name of targets) pool.unlink(name);
				const survivors = (pool.getFileNames() as string[]).filter(matches);
				const result: Tier2WorkerUnlinkResult = { removed: targets, survivors };
				return result;
			}
			default:
				throw new Error(`Unknown search index worker request ${(request as { type?: unknown }).type}`);
		}
	}

	return (request: Tier2WorkerRequest): Promise<void> => {
		const run = async (): Promise<void> => {
			try {
				post({ id: request.id, ok: true, value: await handle(request) });
			} catch (error) {
				post({ id: request.id, ok: false, error: errorPayload(error) });
			}
		};
		chain = chain.then(run, run);
		return chain;
	};
}

// Self-wiring, only inside a real dedicated Worker. In Jest (jsdom) and on the
// main thread `WorkerGlobalScope` is undefined, so importing this file is inert.
declare const WorkerGlobalScope: any;
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
	const scope = self as any;
	const onRequest = createTier2WorkerHandler((message) => scope.postMessage(message));
	scope.onmessage = (event: { data: Tier2WorkerRequest }) => {
		void onRequest(event.data);
	};
}
