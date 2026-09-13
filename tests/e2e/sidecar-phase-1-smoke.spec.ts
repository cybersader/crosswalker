/**
 * sidecar-phase-1-smoke.spec.ts — Phase 1 substrate-scaffolding smoke test
 *
 * Verifies that v0.1.5 Phase 1 substrate is wired correctly (WASM-A path):
 *   1. ordinary installation contains only the standard plugin files, with no
 *      loose SQLite runtime assets
 *   2. automatic startup projection completes against the real embedded runtime
 *      and yields the exact seeded query result
 *   3. plugin.openTier2() succeeds without throwing
 *   4. sqlite-wasm DB is operational (SELECT 1 returns 1)
 *   5. sqlite_version() returns a real version string (smoke check that
 *      the runtime is fully initialized — sqlite-vec deferred per Ch 24
 *      §5 Q4, revisit by 2026-11-06)
 *   6. Schema migrations applied (schema_meta reaches the CURRENT authoritative
 *      version, `TIER2_SCHEMA_VERSION` from src/tier2/migrations.ts)
 *   7. clear-tier-2-sidecar command exists and registers
 *
 * NOT a milestone gate (that's the bigger sidecar.spec.ts in Phase 5).
 * This is a Phase-1-specific smoke test to confirm the substrate stands up.
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
// Compare against the exported constant, never a hard-coded literal. The old
// `tier2-sqlite-v2` expectation survived two schema migrations and reported
// test rot as a substrate failure (triage 2026-08-24 §4 B2). migrations.ts has
// no imports of its own, so pulling it in Node-side costs nothing.
import { TIER2_SCHEMA_VERSION } from '../../src/tier2/migrations';

describe('Crosswalker plugin — v0.1.5 Phase 1 substrate scaffolding (smoke)', function () {
	this.timeout(120000);

	it('ordinary install has the standard three distribution files and no loose SQLite assets', async () => {
		const found = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error - internal plugin lookup
			const plugin = app.plugins.plugins['crosswalker'];
			const pluginPath = `${app.vault.configDir}/plugins/${plugin.manifest.id}`;
			const listed = await app.vault.adapter.list(pluginPath);
			const fileNames = listed.files.map((value: string) => value.split('/').pop() ?? value).sort();
			const distributionFiles = fileNames.filter((value: string) =>
				['main.js', 'manifest.json', 'styles.css', 'sqlite3.wasm', 'sqlite3.mjs'].includes(value));
			return { fileNames, distributionFiles };
		});
		expect(found.distributionFiles).toEqual(['main.js', 'manifest.json', 'styles.css']);
		expect(found.fileNames).not.toContain('sqlite3.wasm');
		expect(found.fileNames).not.toContain('sqlite3.mjs');
	});

	it('automatic startup projection completes and yields the exact seeded SQLite query result', async () => {
		const startup = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error - internal plugin lookup
			const plugin = app.plugins.plugins['crosswalker'];
			const deadline = Date.now() + 30_000;
			let terminal: any = null;
			while (Date.now() < deadline) {
				const events = plugin.debug.getRingBuffer();
				terminal = events.find((event: any) =>
					event.category === 'tier2'
					&& (event.op === 'auto-projection-complete' || event.op === 'auto-projection-failed'));
				if (terminal) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const handle = plugin.tier2Handle;
			const diagnostics = terminal ? {
				trace_id: terminal.trace_id,
				readiness: terminal.readiness,
				errorTotal: terminal.errorTotal,
				errorSamples: terminal.errorSamples,
				errorSamplesTruncated: terminal.errorSamplesTruncated,
			} : null;
			if (!terminal || terminal.op !== 'auto-projection-complete' || !handle) {
				return { terminal, diagnostics, handlePresent: Boolean(handle), concepts: [], status: {} };
			}
			const concepts = handle.db.exec({
				sql: 'SELECT curie FROM concepts ORDER BY curie',
				rowMode: 'array',
				returnValue: 'resultRows',
			}) as unknown[][];
			const statusRows = handle.db.exec({
				sql: "SELECT key, value FROM schema_meta WHERE key IN ('last_projected_at','last_projection_mode','last_projection_success') ORDER BY key",
				rowMode: 'array',
				returnValue: 'resultRows',
			}) as unknown[][];
			return {
				terminal,
				diagnostics,
				handlePresent: true,
				concepts: concepts.map((row) => String(row[0])),
				status: Object.fromEntries(statusRows.map((row) => [String(row[0]), String(row[1])])),
			};
		});
		console.log('[tier2-startup-witness] ' + JSON.stringify({
			terminal: startup.terminal,
			diagnostics: startup.diagnostics,
		}));

		expect(startup.terminal?.op).toBe('auto-projection-complete');
		expect(startup.terminal?.success).toBe(true);
		expect(startup.terminal?.aborted).toBe(false);
		expect(startup.terminal?.readiness?.pending).toBe(0);
		expect(startup.terminal?.readiness?.timedOut).toBe(false);
		expect(startup.terminal?.counts?.concepts).toBe(9);
		expect(startup.handlePresent).toBe(true);
		expect(startup.status.last_projection_mode).toBe('full');
		expect(startup.status.last_projection_success).toBe('true');
		expect(startup.status.last_projected_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(startup.concepts).toEqual([
			'e2e-seed-secondary:CONTROL-1',
			'nist-mini:AC-1',
			'nist-mini:AC-2',
			'nist-mini:AC-2(1)',
			'nist-mini:AC-2(2)',
			'nist-mini:AC-3',
			'nist-mini:AU-1',
			'nist-mini:AU-2',
			'nist-mini:AU-3',
		]);
	});

	it('plugin.openTier2() opens the sidecar without throwing', async () => {
		const result = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error - internal plugin lookup
			const plugin = app.plugins.plugins['crosswalker'];
			if (typeof plugin.openTier2 !== 'function') {
				return { ok: false, error: 'plugin.openTier2 not exposed' };
			}
			try {
				const handle = await plugin.openTier2();
				return {
					ok: true,
					hasDb: !!handle.db,
					sidecarPath: handle.sidecarPath,
					sqliteVersion: handle.sqliteVersion(),
				};
			} catch (err: any) {
				return { ok: false, error: err?.message ?? String(err) };
			}
		});

		if (!result.ok) console.log('openTier2 result:', JSON.stringify(result));
		expect(result.ok).toBe(true);
		expect(result.hasDb).toBe(true);
		expect(typeof result.sidecarPath).toBe('string');
		expect(typeof result.sqliteVersion).toBe('string');
		// SQLite returns a version like '3.53.0' or similar
		expect(result.sqliteVersion.length).toBeGreaterThan(0);
		expect(result.sqliteVersion.startsWith('(error')).toBe(false);
	});

	it('sqlite-wasm DB is operational — SELECT 1 returns 1', async () => {
		const value = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error - internal plugin lookup
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const rows = handle.db.exec({
				sql: 'SELECT 1 AS v',
				rowMode: 'array',
				returnValue: 'resultRows',
			}) as unknown[][];
			return rows[0]?.[0] ?? null;
		});

		// sqlite-wasm returns 1 as either number or BigInt depending on flags
		expect(Number(value)).toBe(1);
	});

	it('schema migrations applied — schema_meta reports the current authoritative version', async () => {
		const version = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error - internal plugin lookup
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const rows = handle.db.exec({
				sql: "SELECT value FROM schema_meta WHERE key = 'schema_version' LIMIT 1",
				rowMode: 'array',
				returnValue: 'resultRows',
			}) as unknown[][];
			return rows[0]?.[0] ?? null;
		});

		// The assertion is "migration reaches the current version", not "v2 forever".
		expect(version).toBe(TIER2_SCHEMA_VERSION);
	});

	it('all expected tables exist after migration', async () => {
		const tables = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error - internal plugin lookup
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const rows = handle.db.exec({
				sql: "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name",
				rowMode: 'array',
				returnValue: 'resultRows',
			}) as unknown[][];
			return rows.map((r) => String(r[0]));
		});

		const expectedTables = [
			'closure_cache',
			'closure_cache_state',
			'concepts',
			'junction_notes',
			'junction_notes_with_freshness',
			'mappings',
			'ontologies',
			'schema_meta',
		];
		for (const t of expectedTables) {
			if (!tables.includes(t)) console.log('Missing table:', t, 'in', JSON.stringify(tables));
			expect(tables).toContain(t);
		}
	});

	it('clear-tier-2-sidecar command is registered', async () => {
		const found = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error - private API
			const cmd = app.commands.commands['crosswalker:clear-tier-2-sidecar'];
			return !!cmd;
		});
		expect(found).toBe(true);
	});
});
