/**
 * tier2-clear-sidecar.test.ts — the reset command actually resets.
 *
 * The bug these tests exist for: `clearSidecar()` opened the sidecar through
 * the OPFS **SAH pool** VFS but tried to delete it through the **plain** OPFS
 * API (`sqlite3.opfs.unlink`). `sqlite3.opfs` is not on the namespace when the
 * sahpool VFS is in use, so the `typeof === 'function'` guard was never true,
 * the function returned having done nothing, and the command still told the
 * user the index had been cleared. Every row survived behind a success notice.
 *
 * That shape is why none of these tests assert "clearSidecar did not throw".
 * The old code did not throw either. They assert the **post-condition**: the
 * pool entry is gone, and a reopened sidecar cannot see a single row written
 * before the reset. A test that only checked the function was reached would
 * have stayed green through the entire life of the defect.
 *
 * Same error class as the cache-lag family logged elsewhere in this project:
 * an unobserved absence was treated as a verified one.
 *
 * Seam. `src/tier2/sidecar.ts` loads the WASM runtime by Blob-URL dynamic
 * import, which ts-jest downlevels to `require(<url string>)`. Overriding
 * `URL.createObjectURL` to return the absolute path of
 * `tests/helpers/fake-sqlite-wasm.ts` therefore substitutes a modelled
 * sqlite3 namespace with no change to `src/`. See that helper for what the
 * SAH pool model does and does not reproduce.
 */

import * as path from 'node:path';
import {
	installFakeSqlite3,
	clearFakeSqlite3,
	fakeSqlite3InitCalls,
	FakeSahPool,
} from './helpers/fake-sqlite-wasm';

const FAKE_MODULE_PATH = path.join(__dirname, 'helpers', 'fake-sqlite-wasm.ts');
const DEFAULT_PATH = '.crosswalker.sqlite';
const DEFAULT_KEY = '/.crosswalker.sqlite';

type SidecarModule = typeof import('../src/tier2/sidecar');

interface TestPlugin {
	manifest: { id: string };
	app: Record<string, unknown>;
}

function createPlugin(): TestPlugin {
	return {
		manifest: { id: 'crosswalker' },
		app: {
			vault: {
				configDir: '.obsidian',
				adapter: {
					// Inert regression scaffolding. The inline loader must never reach the
					// vault adapter for executable SQLite assets.
					readBinary: jest.fn(() => { throw new Error('unexpected sqlite asset readBinary'); }),
					read: jest.fn(() => { throw new Error('unexpected sqlite asset read'); }),
					getResourcePath: jest.fn(() => { throw new Error('unexpected sqlite asset resource path'); }),
				},
			},
		},
	};
}

/** Rows written before the reset. If any survive it, the reset did not work. */
function seedClosureCache(db: any): void {
	db.exec(`
		INSERT INTO closure_cache
			(subject_id, predicate_id, object_id, shortest_depth, computed_at)
		VALUES ('example:A', 'is_broader_than', 'example:B', 1, '2026-08-27T00:00:00.000Z');
		INSERT INTO closure_cache_state
			(subject_id, predicate_id, computed_max_depth, computed_at)
		VALUES ('example:A', 'is_broader_than', 3, '2026-08-27T00:00:00.000Z');
	`);
}

function countRows(db: any, table: string): number {
	const rows = db.exec({
		sql: `SELECT COUNT(*) FROM ${table}`,
		rowMode: 'array',
		returnValue: 'resultRows',
	}) as unknown[][];
	return Number(rows[0][0]);
}

function unlinkedNames(pool: FakeSahPool): string[] {
	return pool.events.filter((e) => e.op === 'unlink').map((e) => e.name);
}

describe('Tier 2 reset (clearSidecar)', () => {
	let sidecar: SidecarModule;
	let plugin: TestPlugin;
	let originalCreate: unknown;
	let originalRevoke: unknown;
	let warnSpy: jest.SpyInstance;

	beforeEach(() => {
		// The sidecar caches the sqlite3 runtime and the pool util at module
		// scope for the plugin's lifetime. A fresh module per test is the only
		// way to exercise a first open.
		jest.resetModules();
		sidecar = require('../src/tier2/sidecar');
		plugin = createPlugin();

		const urlCtor = URL as unknown as Record<string, unknown>;
		originalCreate = urlCtor.createObjectURL;
		originalRevoke = urlCtor.revokeObjectURL;
		urlCtor.createObjectURL = jest.fn(() => FAKE_MODULE_PATH);
		urlCtor.revokeObjectURL = jest.fn();

		// The OPFS-unavailable path warns by design; keep the run readable.
		warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
	});

	afterEach(() => {
		const urlCtor = URL as unknown as Record<string, unknown>;
		urlCtor.createObjectURL = originalCreate;
		urlCtor.revokeObjectURL = originalRevoke;
		warnSpy.mockRestore();
		clearFakeSqlite3();
	});

	// ------------------------------------------------------------------
	// 1. A purge removes the sidecar file
	// ------------------------------------------------------------------

	describe('removing the file', () => {
		it('deletes the pool entry and names what it deleted', async () => {
			const setup = installFakeSqlite3();
			const pool = setup.pool as FakeSahPool;

			const handle = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: DEFAULT_PATH,
			});
			await handle.close();
			expect(pool.getFileNames()).toContain(DEFAULT_KEY);

			const result = await sidecar.clearSidecar(plugin as any, DEFAULT_PATH);

			// The old implementation returned void having deleted nothing, so
			// both halves of this fail against it.
			expect(result).toEqual({ hadPersistentStore: true, removed: [DEFAULT_KEY] });
			expect(pool.getFileNames()).not.toContain(DEFAULT_KEY);
		});

		it('unlinks the leading-slash pool key, not the bare vault path', async () => {
			const setup = installFakeSqlite3();
			const pool = setup.pool as FakeSahPool;

			const handle = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: DEFAULT_PATH,
			});
			await handle.close();
			await sidecar.clearSidecar(plugin as any, DEFAULT_PATH);

			// The pool registers `new URL(name, 'file://localhost/').pathname`,
			// which always has a leading slash, while normalizePath() strips
			// one. Passing the normalized vault path straight through misses
			// every time and reports "no such file" for a file sitting right
			// there. Pin the exact key so that regression cannot come back.
			expect(unlinkedNames(pool)).toEqual([DEFAULT_KEY]);
			expect(unlinkedNames(pool)).not.toContain(DEFAULT_PATH);
		});

		it('handles a sidecar configured into a subfolder', async () => {
			const setup = installFakeSqlite3();
			const pool = setup.pool as FakeSahPool;
			const nested = '.crosswalker/index.sqlite';

			const handle = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: nested,
			});
			await handle.close();
			const result = await sidecar.clearSidecar(plugin as any, nested);

			expect(result.removed).toEqual(['/.crosswalker/index.sqlite']);
			expect(pool.getFileNames()).toEqual([]);
		});

		// Regression, 2026-08-28. The first version of this fix built the pool
		// key as '/' + normalizePath(p), which is only correct while the path
		// contains nothing a URL would escape. The pool keys on
		// `new URL(name, 'file://localhost/').pathname`, which PERCENT-ENCODES,
		// so a space made the key miss, deleted nothing, threw nothing, and
		// reported the index as already empty. The sidecar path is a
		// user-editable setting with a folder picker attached, so a space in it
		// is ordinary. This is the original silent no-op in new clothing.
		it('unlinks a path containing characters a URL escapes', async () => {
			const setup = installFakeSqlite3();
			const pool = setup.pool as FakeSahPool;
			const spaced = 'Vault Notes/.crosswalker.sqlite';

			const handle = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: spaced,
			});
			await handle.close();

			// The pool stored the escaped form, so the naive key would miss.
			expect(pool.getFileNames()).toEqual(['/Vault%20Notes/.crosswalker.sqlite']);

			const result = await sidecar.clearSidecar(plugin as any, spaced);

			expect(result.removed).toEqual(['/Vault%20Notes/.crosswalker.sqlite']);
			expect(pool.getFileNames()).toEqual([]);
		});

		it('removes journal siblings but leaves unrelated pool files alone', async () => {
			const setup = installFakeSqlite3();
			const pool = setup.pool as FakeSahPool;

			const handle = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: DEFAULT_PATH,
			});
			await handle.close();
			// A rollback journal stranded by a crash. Leaving it behind would
			// let a later open recover rows the user asked us to destroy.
			pool.seed(`${DEFAULT_KEY}-journal`);
			// A file belonging to something else entirely. Deletion has to be
			// surgical: wipeFiles() would take this with it.
			pool.seed('/some-other-plugin.sqlite');

			const result = await sidecar.clearSidecar(plugin as any, DEFAULT_PATH);

			expect(result.removed.sort()).toEqual([DEFAULT_KEY, `${DEFAULT_KEY}-journal`]);
			expect(pool.getFileNames()).toEqual(['/some-other-plugin.sqlite']);
		});

		it('closes the handle before it unlinks', async () => {
			const setup = installFakeSqlite3();
			const pool = setup.pool as FakeSahPool;

			const handle = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: DEFAULT_PATH,
			});
			await handle.close();
			await sidecar.clearSidecar(plugin as any, DEFAULT_PATH);

			const closeAt = pool.events.findIndex((e) => e.op === 'close');
			const unlinkAt = pool.events.findIndex((e) => e.op === 'unlink');
			expect(closeAt).toBeGreaterThanOrEqual(0);
			expect(unlinkAt).toBeGreaterThan(closeAt);
		});

		it('surfaces an unlink attempted while an access handle is still open', async () => {
			installFakeSqlite3();

			// Deliberately no close(). Unlinking under a live access handle is
			// undefined behaviour in the real VFS, so the precondition has to
			// fail loudly rather than half-succeed.
			await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: DEFAULT_PATH,
			});

			await expect(sidecar.clearSidecar(plugin as any, DEFAULT_PATH)).rejects.toThrow(
				/access handle/,
			);
		});
	});

	// ------------------------------------------------------------------
	// 2. Data written before the reset does not survive it
	// ------------------------------------------------------------------

	describe('the data is really gone', () => {
		it('control: without a reset, rows survive a close and reopen', async () => {
			// Establishes that the fixture models persistence at all. Without
			// this, the purge assertion below could pass for the wrong reason.
			installFakeSqlite3();

			const first = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: DEFAULT_PATH,
			});
			seedClosureCache(first.db);
			await first.close();

			const second = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: DEFAULT_PATH,
			});
			expect(second.schemaRebuilt).toBe(false);
			expect(countRows(second.db, 'closure_cache')).toBe(1);
			await second.close();
		});

		it('leaves nothing readable from before the reset', async () => {
			installFakeSqlite3();

			const first = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: DEFAULT_PATH,
			});
			seedClosureCache(first.db);
			expect(countRows(first.db, 'closure_cache')).toBe(1);
			await first.close();

			await sidecar.clearSidecar(plugin as any, DEFAULT_PATH);

			const reopened = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: DEFAULT_PATH,
			});
			// A rebuilt schema is the signal the caller reprojects on. Getting
			// false here would mean the old file came back.
			expect(reopened.schemaRebuilt).toBe(true);
			expect(countRows(reopened.db, 'closure_cache')).toBe(0);
			expect(countRows(reopened.db, 'concepts')).toBe(0);
			await reopened.close();
		});

		it('takes the closure cache with it, since the cache lives inside the file', async () => {
			// The implementation performs no separate cache invalidation on the
			// grounds that `closure_cache` and `closure_cache_state` are tables
			// inside the deleted file. This is that claim, asserted.
			installFakeSqlite3();

			const first = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: DEFAULT_PATH,
			});
			seedClosureCache(first.db);
			expect(countRows(first.db, 'closure_cache_state')).toBe(1);
			await first.close();

			await sidecar.clearSidecar(plugin as any, DEFAULT_PATH);

			const reopened = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: DEFAULT_PATH,
			});
			expect(countRows(reopened.db, 'closure_cache')).toBe(0);
			expect(countRows(reopened.db, 'closure_cache_state')).toBe(0);
			await reopened.close();
		});
	});

	// ------------------------------------------------------------------
	// 3. A reset that cannot be verified reports failure
	// ------------------------------------------------------------------

	describe('failing loudly', () => {
		it('rejects when the unlink silently does nothing', async () => {
			const setup = installFakeSqlite3();
			const pool = setup.pool as FakeSahPool;

			const handle = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: DEFAULT_PATH,
			});
			await handle.close();

			// Exactly the old failure mode: the delete call is made and has no
			// effect. Trusting its return value is what produced a success
			// notice for work that never happened.
			pool.unlinkOverride = () => undefined;

			await expect(sidecar.clearSidecar(plugin as any, DEFAULT_PATH)).rejects.toThrow(
				/still present/,
			);
			// And the failure names the survivor, so the notice is actionable.
			await expect(sidecar.clearSidecar(plugin as any, DEFAULT_PATH)).rejects.toThrow(
				/\/\.crosswalker\.sqlite/,
			);
			expect(pool.getFileNames()).toContain(DEFAULT_KEY);
		});

		it('propagates an unlink that throws rather than swallowing it', async () => {
			const setup = installFakeSqlite3();
			const pool = setup.pool as FakeSahPool;

			const handle = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: DEFAULT_PATH,
			});
			await handle.close();
			pool.unlinkOverride = () => {
				throw new Error('SAHPool: no available handles');
			};

			await expect(sidecar.clearSidecar(plugin as any, DEFAULT_PATH)).rejects.toThrow(
				/no available handles/,
			);
		});

		it('distinguishes an empty persistent store from having no store at all', async () => {
			// The command phrases three different outcomes off this result.
			// Collapsing "nothing to delete" into "no persistent store" is how
			// a silent no-op passes for success, so the two must not converge.
			installFakeSqlite3();

			const handle = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: DEFAULT_PATH,
			});
			await handle.close();

			const result = await sidecar.clearSidecar(plugin as any, 'never-created.sqlite');

			expect(result.hadPersistentStore).toBe(true);
			expect(result.removed).toEqual([]);
		});
	});

	// ------------------------------------------------------------------
	// 4. Runtime handles survive the reset
	// ------------------------------------------------------------------

	describe('runtime state the reset must not destroy', () => {
		it('reuses the cached WASM runtime and pool util across open, clear, reopen', async () => {
			const setup = installFakeSqlite3();

			const first = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: DEFAULT_PATH,
			});
			await first.close();
			await sidecar.clearSidecar(plugin as any, DEFAULT_PATH);
			const second = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: DEFAULT_PATH,
			});
			await second.close();

			// Booting the runtime again would mean the reset nulled a live
			// handle rather than a file. Both caches are runtime, not data.
			expect(fakeSqlite3InitCalls()).toBe(1);
			expect(setup.installCalls()).toBe(1);
			// The sidecar asks the vendored installer exactly once and holds
			// the util it got back. Nulling that cache during a reset, which
			// the implementation notes forbid, would push this above 1: the
			// later paths would go back to the installer. (They would still
			// land on the same pool, because the vendored installer memoizes
			// per VFS name, so only this count catches the regression.)
			expect(setup.installInvocations()).toBe(1);
		});
	});

	// ------------------------------------------------------------------
	// 5. In-memory fallback
	// ------------------------------------------------------------------

	describe('in-memory fallback', () => {
		it('reports a discarded in-memory session, not a failure', async () => {
			const setup = installFakeSqlite3({
				installError: new Error('OPFS is not available in this environment'),
			});
			expect(setup.pool).toBeNull();

			const handle = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: DEFAULT_PATH,
			});
			// The fallback is a working database, just not a persisted one.
			expect(handle.schemaRebuilt).toBe(true);
			seedClosureCache(handle.db);
			await handle.close();

			// No pool ever installed means no pool file can exist, so absence
			// here is verified rather than merely unobserved. That is why this
			// resolves instead of throwing.
			const result = await sidecar.clearSidecar(plugin as any, DEFAULT_PATH);
			expect(result).toEqual({ hadPersistentStore: false, removed: [] });
		});

		// Regression, 2026-08-28. A failed install was originally read as "no
		// persistent store exists", but the installer also rejects when another
		// holder owns the pool's access handles (a second vault window, or a
		// stale WASM instance after a plugin reload) and it caches that
		// rejection for the session. The file is intact in those cases. Absence
		// must be earned by having opened `:memory:` ourselves, never inferred
		// from a pool we simply cannot see.
		it('refuses to claim a reset when the pool cannot be opened and nothing ran in memory', async () => {
			installFakeSqlite3({ installError: new Error('NoModificationAllowedError') });

			// No openSidecar() first: this session knows nothing about the file,
			// which is exactly the state a second vault window produces.
			await expect(sidecar.clearSidecar(plugin as any, DEFAULT_PATH)).rejects.toThrow(
				/could not open the query index storage/i,
			);
		});

		it('claims no deletion it did not make', async () => {
			installFakeSqlite3({ installError: new Error('OPFS is not available') });

			const handle = await sidecar.openSidecar(plugin as any, plugin.app as any, {
				sidecarPath: DEFAULT_PATH,
			});
			await handle.close();

			const result = await sidecar.clearSidecar(plugin as any, DEFAULT_PATH);
			expect(result.removed).toHaveLength(0);
			// Repeat calls stay idempotent and stay honest.
			const again = await sidecar.clearSidecar(plugin as any, DEFAULT_PATH);
			expect(again).toEqual({ hadPersistentStore: false, removed: [] });
		});
	});
});
