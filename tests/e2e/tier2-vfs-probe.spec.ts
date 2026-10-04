/**
 * tier2-vfs-probe.spec.ts — the search index persists across an Obsidian restart.
 *
 * Origin. An evidence-only probe (2026-10-03) found that on real desktop
 * Obsidian `plugin.openTier2()` landed on `unix-none` with an empty filename:
 * the OPFS sahpool VFS was installed on the main thread, where Chromium does
 * not expose `createSyncAccessHandle`, so the index silently fell back to
 * memory and was rebuilt on every launch. sqlite now runs in a dedicated
 * Worker built from a Blob URL (src/tier2/worker-source.ts, worker-db.ts).
 *
 * What this gates, on a real Obsidian (Electron renderer):
 *   1. `handle.info()` reports `vfs: "opfs-sahpool"` and `persistent: true`.
 *   2. A marker row written before a full Obsidian restart reads back after it.
 *      `reloadObsidian()` with no vault argument relaunches the app on the same
 *      user-data directory, so OPFS survives exactly as it does for a user.
 *
 * The marker lives in its own table, which schema migrations never drop, so a
 * schema rebuild on the second launch cannot mask or fake the result.
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';

const MARKER_TABLE = 'e2e_persistence_probe';

describe('Crosswalker Tier 2 — search index persists across restart', function () {
	this.timeout(180000);

	it('opens on the persistent pool and keeps a marker row across an Obsidian restart', async () => {
		const token = `marker-${Date.now()}-${Math.random().toString(36).slice(2)}`;

		const before = await browser.executeObsidian(async ({ app }, marker: string, table: string) => {
			// @ts-expect-error - internal plugin lookup
			const plugin = app.plugins.plugins['crosswalker'];
			const consoleHits: string[] = [];
			const originalWarn = console.warn;
			console.warn = (...args: unknown[]) => {
				const line = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' ');
				if (line.includes('OPFS unavailable') || line.includes('falling back')) consoleHits.push(line);
				return originalWarn.apply(console, args as any);
			};
			try {
				const handle = await plugin.openTier2();
				await handle.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (marker TEXT NOT NULL)`);
				await handle.db.exec(`DELETE FROM ${table}`);
				await handle.db.exec({ sql: `INSERT INTO ${table} (marker) VALUES ($m)`, bind: { $m: marker } });
				const info = handle.info();
				return {
					vfs: info.vfs,
					persistent: info.persistent,
					filename: info.filename,
					sqliteVersion: handle.sqliteVersion(),
					mainThreadHasSyncAccessHandle:
						typeof FileSystemFileHandle !== 'undefined'
						&& 'createSyncAccessHandle' in FileSystemFileHandle.prototype,
					consoleHits,
				};
			} finally {
				console.warn = originalWarn;
			}
		}, token, MARKER_TABLE);

		await browser.reloadObsidian();

		const after = await browser.executeObsidian(async ({ app }, table: string) => {
			// @ts-expect-error - internal plugin lookup
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const info = handle.info();
			let markers: string[] = [];
			let readError: string | null = null;
			try {
				const rows = await handle.db.exec({
					sql: `SELECT marker FROM ${table}`,
					rowMode: 'array',
					returnValue: 'resultRows',
				}) as unknown[][];
				markers = rows.map((row) => String(row[0]));
			} catch (error) {
				readError = error instanceof Error ? error.message : String(error);
			}
			return { vfs: info.vfs, persistent: info.persistent, filename: info.filename, markers, readError };
		}, MARKER_TABLE);

		const probe = { before, after, markerWritten: token, markerReadBack: after.markers.includes(token) };
		console.log('[tier2-vfs-probe] result=' + JSON.stringify(probe));

		expect(before.vfs).toBe('opfs-sahpool');
		expect(before.persistent).toBe(true);
		expect(before.consoleHits).toEqual([]);
		expect(after.vfs).toBe('opfs-sahpool');
		expect(after.persistent).toBe(true);
		expect(after.readError).toBeNull();
		expect(after.markers).toContain(token);
	});
});
