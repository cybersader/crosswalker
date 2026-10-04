/**
 * tier2-projection-abort.test.ts — a projection can be called off safely
 * (2026-08-28).
 *
 * A projection holds the sidecar database across many cooperative yields. The
 * reset command closes and deletes that database. Before this, the two could
 * interleave: the reset would show its success notice while the projector
 * resumed against a dead handle and surfaced a separate error, for a user who
 * had done nothing wrong.
 *
 * The reset now signals an abort and WAITS for the projector to let go. This
 * file covers the projector half of that contract, and specifically the trap
 * inside it: a full projection prunes rows for notes it did not see, so a full
 * pass that stopped early must NOT prune — otherwise calling off a projection
 * would silently delete real data. Coverage, not intent, licenses a prune.
 */

import { applyMigrations } from '../src/tier2/migrations';
import { projectFromTier1 } from '../src/tier2/projector';

const { DatabaseSync } = require('node:sqlite');

interface ExecOptions {
	sql: string;
	bind?: Record<string, unknown>;
	rowMode?: 'array';
	returnValue?: 'resultRows';
}
interface TestDb { exec(input: string | ExecOptions): unknown[][] | void; close(): void }

function createTestDb(): TestDb {
	const sqlite = new DatabaseSync(':memory:');
	return {
		exec(input) {
			if (typeof input === 'string') { sqlite.exec(input); return; }
			const statement = sqlite.prepare(input.sql);
			if (input.rowMode === 'array') statement.setReturnArrays(true);
			const bind = input.bind ?? {};
			if (input.returnValue === 'resultRows') return Object.keys(bind).length ? statement.all(bind) : statement.all();
			if (Object.keys(bind).length) statement.run(bind); else statement.run();
		},
		close: () => sqlite.close(),
	};
}

const provenance = {
	spec_version: 'https://crosswalker.dev/spec/tier1.schema.json',
	source_ref: { file: 'source.csv' },
	produced_at: '2026-08-28T00:00:00.000Z',
};

function control(id: string): Record<string, unknown> {
	return { curie: `nist-800-53:${id}`, title: `${id} control`, _crosswalker: provenance };
}

function mockApp(entries: Array<[string, Record<string, unknown>]>): any {
	const files = entries.map(([path]) => ({ path, stat: { mtime: 0 } }));
	const byPath = new Map(entries);
	return {
		vault: { getMarkdownFiles: () => files },
		metadataCache: { getFileCache: (file: { path: string }) => ({ frontmatter: byPath.get(file.path) }) },
	};
}

const A: [string, Record<string, unknown>] = ['F/AC-1.md', control('AC-1')];
const B: [string, Record<string, unknown>] = ['F/AC-2.md', control('AC-2')];
const C: [string, Record<string, unknown>] = ['F/AC-3.md', control('AC-3')];

function conceptCuries(db: TestDb): string[] {
	const rows = db.exec({
		sql: 'SELECT curie FROM concepts ORDER BY curie',
		rowMode: 'array',
		returnValue: 'resultRows',
	}) as unknown[][];
	return rows.map((r) => String(r[0]));
}

describe('a projection that is called off', () => {
	let db: TestDb;
	beforeEach(async () => { db = createTestDb(); await applyMigrations(db as any); });
	afterEach(() => db.close());

	it('stops early and reports an abort, not a failure', async () => {
		const result = await projectFromTier1(mockApp([A, B, C]), db as any, {
			projectionMode: 'full',
			yieldEvery: 1,
			shouldAbort: () => true,
		});

		expect(result.aborted).toBe(true);
		// Nothing went wrong. The work was called off, which is a different
		// thing, and reporting it as an error would send a user hunting a bug
		// that does not exist.
		expect(result.success).toBe(true);
		expect(result.errors).toEqual([]);
		// It stopped rather than running to completion.
		expect(result.counts.concepts).toBeLessThan(3);
	});

	it('runs to completion when nothing asks it to stop', async () => {
		const result = await projectFromTier1(mockApp([A, B, C]), db as any, {
			projectionMode: 'full',
			yieldEvery: 1,
			shouldAbort: () => false,
		});

		expect(result.aborted).toBeFalsy();
		expect(conceptCuries(db)).toEqual(['nist-800-53:AC-1', 'nist-800-53:AC-2', 'nist-800-53:AC-3']);
	});

	// The trap. A full projection prunes rows whose notes it did not see, which
	// is correct only when it truly saw the whole vault. An aborted pass sees a
	// prefix, so pruning on that basis deletes rows for notes that exist and
	// were simply never reached — turning "cancel this" into "delete my data".
	it('does not prune notes it never reached', async () => {
		// Establish three rows from a complete pass.
		await projectFromTier1(mockApp([A, B, C]), db as any, { projectionMode: 'full', yieldEvery: 1 });
		expect(conceptCuries(db)).toHaveLength(3);

		// Now a full pass that is called off immediately. B and C are still in
		// the vault; the projector just never got to them.
		let calls = 0;
		const result = await projectFromTier1(mockApp([A, B, C]), db as any, {
			projectionMode: 'full',
			yieldEvery: 1,
			shouldAbort: () => { calls += 1; return calls >= 1; },
		});

		expect(result.aborted).toBe(true);
		// All three survive. A prune here would have deleted the two it had not
		// visited yet.
		expect(conceptCuries(db)).toHaveLength(3);
	});

	it('records itself as partial coverage, whatever it set out to be', async () => {
		await projectFromTier1(mockApp([A, B, C]), db as any, {
			projectionMode: 'full',
			yieldEvery: 1,
			shouldAbort: () => true,
		});

		const rows = db.exec({
			sql: "SELECT value FROM schema_meta WHERE key = 'last_projection_mode'",
			rowMode: 'array',
			returnValue: 'resultRows',
		}) as unknown[][];

		// A run that stopped early cannot speak for the whole vault. Stamping it
		// `full` is how a partial picture later gets read as the complete one.
		expect(rows.length === 0 || String(rows[0][0])).not.toBe('full');
	});
});
