/**
 * fake-sqlite-wasm.ts — an in-process stand-in for the vendored
 * `@sqlite.org/sqlite-wasm` ES module, plus a behavioural model of the OPFS
 * SAH pool VFS.
 *
 * Why this exists. `src/tier2/sidecar.ts` reaches the embedded module text
 * through `sqlite-assets`, wraps it in a Blob, and dynamic-imports the
 * resulting object URL. Under ts-jest that dynamic import downlevels to
 * `require(<url string>)`, so a test can hand
 * `URL.createObjectURL` the absolute path of THIS file and the sidecar loads
 * it as if it were the real WASM module. Nothing in `src/` is modified or
 * re-exported to make that work.
 *
 * What is modelled, and why each piece is load-bearing for the reset bug:
 *
 * - **Pool files are keyed, not path-addressed.** The real sahpool stores
 *   `new URL(name, 'file://localhost/').pathname`, which always carries a
 *   leading slash. `poolKeyFromFilename()` below derives the key by that same
 *   documented rule rather than by calling the product's own helper, so a
 *   wrong key in `src/` shows up as a miss here instead of cancelling out.
 * - **Deleting requires the pool util.** There is deliberately no
 *   `sqlite3.opfs` on the namespace, because the real bootstrap deletes it
 *   when the sahpool VFS is the one in use. That absence is exactly what made
 *   the old `typeof sqlite3.opfs.unlink === 'function'` guard silently false.
 * - **A file outlives the handle that opened it.** Closing a pool-backed DB
 *   does not discard its contents; reopening the same key sees the same rows.
 *   Without that, "the data really is gone after a purge" would be untestable.
 * - **Unlinking under an open access handle is an error.** The real VFS calls
 *   that undefined behaviour; here it throws, so the close-before-delete
 *   precondition is enforced rather than assumed.
 *
 * Storage is backed by `node:sqlite` (same choice as tier2-pruning.test.ts) so
 * the real `applyMigrations()` runs against real SQL.
 */

const { DatabaseSync } = require('node:sqlite');

export interface ExecOptions {
	sql: string;
	bind?: Record<string, unknown>;
	rowMode?: 'array';
	returnValue?: 'resultRows';
}

/** One observable pool operation, in the order it happened. */
export interface PoolEvent {
	op: 'open' | 'close' | 'unlink';
	name: string;
}

/**
 * The bytes behind one pool entry. Held by the pool, not by the DB wrapper:
 * a pool file survives `close()` and is destroyed only by `unlink()`.
 */
interface PoolFile {
	sqlite: any;
	openHandles: number;
}

/**
 * Derive the pool key for a sqlite-wasm filename URI.
 *
 * Mirrors the real VFS: `xOpen` stores `pool.getPath(zName)`, and `getPath` is
 * `new URL(arg, 'file://localhost/').pathname`. Returns null for filenames
 * that do not target the sahpool VFS (`:memory:`, plain temp files).
 */
export function poolKeyFromFilename(filename: string): string | null {
	if (!filename.includes('vfs=opfs-sahpool')) return null;
	const withoutScheme = filename.replace(/^file:/, '');
	const pathPart = withoutScheme.split('?')[0];
	return new URL(pathPart, 'file://localhost/').pathname;
}

/** Behavioural model of the `OpfsSAHPoolUtil` handed back by the installer. */
export class FakeSahPool {
	private files = new Map<string, PoolFile>();
	/** Every open/close/unlink, in order. Lets a test assert ordering. */
	readonly events: PoolEvent[] = [];
	/**
	 * Optional override used to model a delete that does not take: a stuck
	 * file, a wrong key, or the old implementation doing nothing at all. When
	 * set, it replaces the real removal entirely.
	 */
	unlinkOverride: ((name: string) => void) | null = null;

	/** Seed a pool entry that no test ever opened (unrelated neighbour). */
	seed(name: string): void {
		if (!this.files.has(name)) this.files.set(name, { sqlite: null, openHandles: 0 });
	}

	getFileNames(): string[] {
		return Array.from(this.files.keys());
	}

	unlink(name: string): void {
		this.events.push({ op: 'unlink', name });
		if (this.unlinkOverride) {
			this.unlinkOverride(name);
			return;
		}
		const file = this.files.get(name);
		if (!file) return;
		if (file.openHandles > 0) {
			throw new Error(`fake sahpool: unlink of ${name} while an access handle is still open`);
		}
		if (file.sqlite) file.sqlite.close();
		this.files.delete(name);
	}

	/** @internal — used by the fake DB constructor. */
	acquire(name: string): PoolFile {
		let file = this.files.get(name);
		if (!file || !file.sqlite) {
			file = { sqlite: new DatabaseSync(':memory:'), openHandles: 0 };
			this.files.set(name, file);
		}
		file.openHandles += 1;
		this.events.push({ op: 'open', name });
		return file;
	}

	/** @internal */
	release(name: string): void {
		const file = this.files.get(name);
		if (file && file.openHandles > 0) file.openHandles -= 1;
		this.events.push({ op: 'close', name });
	}
}

/**
 * Stand-in for `sqlite3.oo1.DB`. Pool-backed instances share their storage
 * with the pool entry; `:memory:` instances own theirs and drop it on close.
 */
class FakeDB {
	private sqlite: any;
	private poolKey: string | null;
	private pool: FakeSahPool | null;
	private closed = false;

	constructor(arg: string | { filename: string; flags?: string }, pool: FakeSahPool | null) {
		const filename = typeof arg === 'string' ? arg : arg.filename;
		this.poolKey = poolKeyFromFilename(filename);
		this.pool = pool;

		if (this.poolKey !== null) {
			if (!pool) {
				throw new Error('fake sqlite3: opfs-sahpool requested but no pool is installed');
			}
			this.sqlite = pool.acquire(this.poolKey).sqlite;
		} else {
			this.sqlite = new DatabaseSync(':memory:');
		}
	}

	exec(input: string | ExecOptions): unknown[][] | void {
		if (this.closed) throw new Error('fake sqlite3: exec on a closed database');
		if (typeof input === 'string') {
			this.sqlite.exec(input);
			return;
		}
		const statement = this.sqlite.prepare(input.sql);
		if (input.rowMode === 'array') statement.setReturnArrays(true);
		const bind = input.bind ?? {};
		if (input.returnValue === 'resultRows') {
			return Object.keys(bind).length > 0 ? statement.all(bind) : statement.all();
		}
		if (Object.keys(bind).length > 0) statement.run(bind);
		else statement.run();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.poolKey !== null && this.pool) {
			// Pool-backed: the file outlives the handle. Only unlink destroys it.
			this.pool.release(this.poolKey);
			return;
		}
		this.sqlite.close();
	}
}

export interface FakeSqlite3InitOptions {
	wasmBinary?: Uint8Array;
	locateFile?: (filename: string) => string;
	[key: string]: unknown;
}

export interface FakeSqlite3Setup {
	/** The namespace object `sqlite3InitModule()` resolves to. */
	namespace: Record<string, unknown>;
	/** The pool the installer hands out, or null when installing fails. */
	pool: FakeSahPool | null;
	/**
	 * How many times the installer actually installed, as opposed to replaying
	 * a memoized result. Stays at 1 for the whole session.
	 */
	installCalls(): number;
	/**
	 * How many times `installOpfsSAHPoolVfs` was called at all. Every code path
	 * that wants a deletion handle has to ask, so this counts the asks.
	 */
	installInvocations(): number;
}

/**
 * Build a fake sqlite3 namespace and install it for the next
 * `sqlite3InitModule()` call.
 *
 * `installError` models an environment with no OPFS. The installer memoizes
 * both outcomes, matching the vendored artifact, which caches its install
 * promise (including a rejection) per VFS name. That memoization is what makes
 * `openSidecar()` and `clearSidecar()` provably act on the same pool.
 *
 * Note the deliberate omission: the namespace has **no `opfs` property**. The
 * real bootstrap removes it when the sahpool VFS is in play, which is why the
 * previous `sqlite3.opfs.unlink` guard never fired.
 */
export function installFakeSqlite3(options: { installError?: Error; locateFileRequest?: string } = {}): FakeSqlite3Setup {
	const pool: FakeSahPool | null = options.installError ? null : new FakeSahPool();
	let installCalls = 0;
	let installInvocations = 0;
	let memo: Promise<FakeSahPool> | null = null;

	const namespace: Record<string, unknown> = {
		installOpfsSAHPoolVfs: (_opts: unknown): Promise<FakeSahPool> => {
			installInvocations += 1;
			if (memo) return memo;
			installCalls += 1;
			memo = options.installError
				? Promise.reject(options.installError)
				: Promise.resolve(pool as FakeSahPool);
			// A rejected memo that nobody has awaited yet would trip Node's
			// unhandled-rejection detector before the sidecar gets to it.
			memo.catch(() => undefined);
			return memo;
		},
		oo1: {
			DB: function DB(arg: string | { filename: string; flags?: string }) {
				return new FakeDB(arg, pool);
			} as unknown as new (arg: unknown) => FakeDB,
		},
	};

	const globals = globalThis as unknown as Record<string, unknown>;
	globals.__cwFakeSqlite3 = namespace;
	globals.__cwFakeSqlite3InitCalls = 0;
	delete globals.__cwFakeSqlite3InitOptions;
	if (options.locateFileRequest) globals.__cwFakeSqlite3LocateFileRequest = options.locateFileRequest;
	else delete globals.__cwFakeSqlite3LocateFileRequest;

	return {
		namespace,
		pool,
		installCalls: () => installCalls,
		installInvocations: () => installInvocations,
	};
}

/** How many times the sidecar booted the WASM runtime. Should stay at 1. */
export function fakeSqlite3InitCalls(): number {
	const globals = globalThis as unknown as Record<string, unknown>;
	return (globals.__cwFakeSqlite3InitCalls as number | undefined) ?? 0;
}

/** The exact options passed to the latest fake sqlite3 initialization attempt. */
export function fakeSqlite3InitOptions(): FakeSqlite3InitOptions | undefined {
	const globals = globalThis as unknown as Record<string, unknown>;
	return globals.__cwFakeSqlite3InitOptions as FakeSqlite3InitOptions | undefined;
}

/** Make the fake module exercise sqlite-wasm's locateFile callback during init. */
export function requestFakeSqlite3Asset(filename?: string): void {
	const globals = globalThis as unknown as Record<string, unknown>;
	if (filename) globals.__cwFakeSqlite3LocateFileRequest = filename;
	else delete globals.__cwFakeSqlite3LocateFileRequest;
}

/** Remove the installed namespace so a later test cannot inherit it. */
export function clearFakeSqlite3(): void {
	const globals = globalThis as unknown as Record<string, unknown>;
	delete globals.__cwFakeSqlite3;
	delete globals.__cwFakeSqlite3InitCalls;
	delete globals.__cwFakeSqlite3InitOptions;
	delete globals.__cwFakeSqlite3LocateFileRequest;
}

/**
 * The default export is what `sidecar.ts` picks up as `sqlite3InitModule`
 * (`mod.default ?? mod.sqlite3InitModule ?? mod`). State lives on globalThis
 * rather than in module scope so `jest.resetModules()` between tests does not
 * silently hand the sidecar a different instance than the test configured.
 */
export default async function sqlite3InitModule(options: FakeSqlite3InitOptions): Promise<unknown> {
	const globals = globalThis as unknown as Record<string, unknown>;
	globals.__cwFakeSqlite3InitCalls =
		((globals.__cwFakeSqlite3InitCalls as number | undefined) ?? 0) + 1;
	globals.__cwFakeSqlite3InitOptions = options;
	const requestedAsset = globals.__cwFakeSqlite3LocateFileRequest as string | undefined;
	if (requestedAsset) {
		if (typeof options.locateFile !== 'function') {
			throw new Error(`test setup: locateFile unavailable for ${requestedAsset}`);
		}
		options.locateFile(requestedAsset);
	}
	const namespace = globals.__cwFakeSqlite3;
	if (!namespace) throw new Error('test setup: installFakeSqlite3() was not called');
	return namespace;
}
