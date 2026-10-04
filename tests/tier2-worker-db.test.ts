/**
 * tier2-worker-db.test.ts — the Worker-hosted query index (W1-W6, 2026-10-03).
 *
 * The real Worker program (`src/tier2/worker-source.ts`) runs in-process
 * behind `helpers/in-process-worker.ts`, which crosses a macrotask boundary and
 * structured-clones every message both ways. sqlite is the `node:sqlite`
 * backed fake from `helpers/fake-sqlite-wasm.ts`, loaded through the same
 * Blob-URL import the Worker uses for real.
 */

import * as path from 'node:path';
import { installFakeSqlite3, clearFakeSqlite3, FakeSahPool } from './helpers/fake-sqlite-wasm';
import { createInProcessWorkerFactory, type InProcessWorkerFactory } from './helpers/in-process-worker';
import { LocalDb, Tier2DbError, type Tier2Db } from '../src/tier2/db';
import { Tier2WorkerHost, WorkerDb, setTier2WorkerFactory } from '../src/tier2/worker-db';
import { TIER2_WORKER_PROTOCOL } from '../src/tier2/worker-source';
import { applyMigrations } from '../src/tier2/migrations';
import { precomputeClosureForOntologyPair, closureFromConcept } from '../src/tier2/queries';
import { projectFromTier1 } from '../src/tier2/projector';

const { DatabaseSync } = require('node:sqlite');

const FAKE_MODULE_PATH = path.join(__dirname, 'helpers', 'fake-sqlite-wasm.ts');
const WASM = (): Uint8Array => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

function startOptions() {
	return { workerText: '/* unused by the in-process transport */', mjsText: '// fake', wasmBytes: WASM(), poolDirectory: 'crosswalker/vault-test' };
}

async function count(db: Tier2Db, table: string): Promise<number> {
	const rows = await db.exec({ sql: `SELECT COUNT(*) FROM ${table}`, rowMode: 'array', returnValue: 'resultRows' });
	return Number(rows[0][0]);
}

/** A raw node:sqlite handle in the OO1 shape, for LocalDb parity checks. */
function rawNodeDb() {
	const sqlite = new DatabaseSync(':memory:');
	return {
		exec(input: any) {
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

describe('Tier 2 Worker database', () => {
	let factory: InProcessWorkerFactory;
	let originalCreate: unknown;
	let originalRevoke: unknown;

	beforeEach(() => {
		const urlCtor = URL as unknown as Record<string, unknown>;
		originalCreate = urlCtor.createObjectURL;
		originalRevoke = urlCtor.revokeObjectURL;
		urlCtor.createObjectURL = jest.fn(() => FAKE_MODULE_PATH);
		urlCtor.revokeObjectURL = jest.fn();
		factory = createInProcessWorkerFactory();
		setTier2WorkerFactory(factory);
	});

	afterEach(() => {
		setTier2WorkerFactory(null);
		const urlCtor = URL as unknown as Record<string, unknown>;
		urlCtor.createObjectURL = originalCreate;
		urlCtor.revokeObjectURL = originalRevoke;
		clearFakeSqlite3();
	});

	it('initializes in one message carrying the module text and wasm bytes, and reports persistent info', async () => {
		installFakeSqlite3();
		const db = await WorkerDb.create({ ...startOptions(), sidecarPath: '.crosswalker.sqlite' });
		const worker = factory.created[0];

		expect(worker.sent[0]).toMatchObject({ type: 'init', protocol: TIER2_WORKER_PROTOCOL, poolDirectory: 'crosswalker/vault-test' });
		expect(worker.sent[0]).toHaveProperty('mjsText', '// fake');
		expect(Array.from((worker.sent[0] as any).wasmBytes)).toEqual(Array.from(WASM()));
		expect(db.info()).toEqual({ vfs: 'opfs-sahpool', persistent: true, filename: '' });
		await db.close();
	});

	it('returns rows for a resultRows exec and nothing for a write', async () => {
		installFakeSqlite3();
		const db = await WorkerDb.create({ ...startOptions(), sidecarPath: '.crosswalker.sqlite' });
		expect(await db.exec('CREATE TABLE t (v INTEGER)')).toBeUndefined();
		expect(await db.exec({ sql: 'INSERT INTO t (v) VALUES ($v)', bind: { $v: 7 } })).toBeUndefined();
		expect(await db.exec({ sql: 'SELECT v FROM t', rowMode: 'array', returnValue: 'resultRows' })).toEqual([[7]]);
		await db.close();
	});

	it('execBatch is atomic: a failing statement rolls back the whole batch and names its index', async () => {
		installFakeSqlite3();
		const db = await WorkerDb.create({ ...startOptions(), sidecarPath: '.crosswalker.sqlite' });
		await db.exec('CREATE TABLE t (v INTEGER NOT NULL)');

		const failure = await db.execBatch([
			{ sql: 'INSERT INTO t (v) VALUES (1)' },
			{ sql: 'INSERT INTO t (v) VALUES (2)' },
			{ sql: 'INSERT INTO t (v) VALUES (NULL)' },
			{ sql: 'INSERT INTO t (v) VALUES (4)' },
		]).then(() => null, (error: unknown) => error);

		expect(failure).toBeInstanceOf(Tier2DbError);
		expect((failure as Tier2DbError).statementIndex).toBe(2);
		expect((failure as Tier2DbError).message).toMatch(/NOT NULL/i);
		expect(await count(db, 't')).toBe(0);

		await db.execBatch([{ sql: 'INSERT INTO t (v) VALUES (1)' }, { sql: 'INSERT INTO t (v) VALUES (2)' }]);
		expect(await count(db, 't')).toBe(2);
		await db.close();
	});

	it('LocalDb runs the identical batch contract', async () => {
		const db = new LocalDb(rawNodeDb());
		await db.exec('CREATE TABLE t (v INTEGER NOT NULL)');
		const failure = await db.execBatch([
			{ sql: 'INSERT INTO t (v) VALUES (1)' },
			{ sql: 'INSERT INTO t (v) VALUES (NULL)' },
		]).then(() => null, (error: unknown) => error);
		expect(failure).toBeInstanceOf(Tier2DbError);
		expect((failure as Tier2DbError).statementIndex).toBe(1);
		expect(await count(db, 't')).toBe(0);
		expect(db.info().persistent).toBe(false);
		await db.close();
	});

	it('keeps one request in flight and answers concurrent callers in issue order', async () => {
		installFakeSqlite3();
		const db = await WorkerDb.create({ ...startOptions(), sidecarPath: '.crosswalker.sqlite' });
		await db.exec('CREATE TABLE t (seq INTEGER)');
		const worker = factory.created[0];
		const before = worker.sent.length;

		worker.hold();
		const writes = [1, 2, 3, 4].map((seq) => db.exec({ sql: 'INSERT INTO t (seq) VALUES ($s)', bind: { $s: seq } }));
		const read = db.exec({ sql: 'SELECT seq FROM t ORDER BY rowid', rowMode: 'array', returnValue: 'resultRows' });
		await new Promise((resolve) => setTimeout(resolve, 10));
		// Only the first request has been posted; the rest wait their turn.
		expect(worker.sent.length - before).toBe(1);
		worker.release();

		await Promise.all(writes);
		expect(await read).toEqual([[1], [2], [3], [4]]);
		const ids = worker.sent.slice(before).map((request) => request.id);
		expect(ids).toEqual([...ids].sort((a, b) => a - b));
		await db.close();
	});

	it('acknowledges close, refuses later calls, and the file outlives the handle', async () => {
		const setup = installFakeSqlite3();
		const pool = setup.pool as FakeSahPool;
		const host = await Tier2WorkerHost.start(startOptions());
		const db = await host.open('.crosswalker.sqlite');
		await db.exec('CREATE TABLE t (v INTEGER)');
		await db.exec('INSERT INTO t (v) VALUES (42)');
		await db.close();

		expect(pool.events.map((event) => event.op)).toEqual(['open', 'close']);
		await expect(db.exec('SELECT 1')).rejects.toThrow(/closed/);

		const reopened = await host.open('.crosswalker.sqlite');
		expect(await count(reopened, 't')).toBe(1);
		await reopened.close();
		host.terminate();
	});

	it('unlinks only after close, on the same Worker, and refuses while the file is open', async () => {
		const setup = installFakeSqlite3();
		const pool = setup.pool as FakeSahPool;
		const host = await Tier2WorkerHost.start(startOptions());
		const db = await host.open('.crosswalker.sqlite');

		await expect(host.unlink('/.crosswalker.sqlite')).rejects.toThrow(/access handle/);
		expect(pool.getFileNames()).toContain('/.crosswalker.sqlite');

		await db.close();
		const result = await host.unlink('/.crosswalker.sqlite');
		expect(result).toEqual({ removed: ['/.crosswalker.sqlite'], survivors: [] });
		expect(pool.events.map((event) => event.op)).toEqual(['open', 'close', 'unlink']);
		expect(factory.created).toHaveLength(1);
		host.terminate();
	});

	it('reports an unavailable pool so the caller can fall back to memory', async () => {
		installFakeSqlite3({ installError: new Error('Missing required OPFS APIs.') });
		const host = await Tier2WorkerHost.start(startOptions());
		expect(host.poolAvailable).toBe(false);
		expect(host.poolError?.message).toBe('Missing required OPFS APIs.');
		host.terminate();

		await expect(WorkerDb.create({ ...startOptions(), sidecarPath: '.crosswalker.sqlite' })).rejects.toThrow(
			'Missing required OPFS APIs.',
		);
		expect(factory.created.every((worker) => worker.terminated)).toBe(true);
	});

	it('rejects pending requests when the Worker dies', async () => {
		installFakeSqlite3();
		const db = await WorkerDb.create({ ...startOptions(), sidecarPath: '.crosswalker.sqlite' });
		const worker = factory.created[0];
		worker.hold();
		const pending = db.exec('SELECT 1');
		await new Promise((resolve) => setTimeout(resolve, 5));
		worker.crash('out of memory');
		await expect(pending).rejects.toThrow(/stopped: out of memory/);
		await expect(db.exec('SELECT 1')).rejects.toThrow(/stopped/);
	});

	it('shutdown terminates after the close acknowledgement', async () => {
		installFakeSqlite3();
		const db = await WorkerDb.create({ ...startOptions(), sidecarPath: '.crosswalker.sqlite' });
		await db.host.shutdown(500);
		expect(factory.created[0].terminated).toBe(true);
		const sent = factory.created[0].sent;
		expect(sent[sent.length - 1]).toMatchObject({ type: 'close' });
	});

	it('shutdown still terminates within the grace period when no acknowledgement comes', async () => {
		installFakeSqlite3();
		const db = await WorkerDb.create({ ...startOptions(), sidecarPath: '.crosswalker.sqlite' });
		factory.created[0].hold();
		const started = Date.now();
		await db.host.shutdown(30);
		expect(Date.now() - started).toBeLessThan(1000);
		expect(factory.created[0].terminated).toBe(true);
	});

	it('precomputes each subject in at most two Worker messages (W4)', async () => {
		installFakeSqlite3();
		const db = await WorkerDb.create({ ...startOptions(), sidecarPath: '.crosswalker.sqlite' });
		await applyMigrations(db);
		const subjects = ['a:1', 'a:2', 'a:3', 'a:4'];
		await db.execBatch(subjects.map((subject, index) => ({
			sql: `INSERT INTO mappings (subject_id, predicate_id, predicate_modifier, object_id, source_path, source_hash)
				VALUES ($s, 'is_equivalent_to', '', $o, $p, 'h')`,
			bind: { $s: subject, $o: `b:${index}`, $p: `edge-${index}.md` },
		})));
		const worker = factory.created[0];
		const before = worker.sent.length;

		const cached = await precomputeClosureForOntologyPair(db, 'a', 'b');
		const messages = worker.sent.length - before;
		// One subjects query, one count query, and at most two per subject.
		expect(messages).toBeLessThanOrEqual(2 + 2 * subjects.length);
		expect(cached).toBe(subjects.length);

		// Same rows a lazy closure query computes and caches.
		expect(await closureFromConcept(db, 'a:1')).toEqual([
			{ start_curie: 'a:1', predicate_filter: '*', target_curie: 'b:0', shortest_depth: 1 },
		]);
		// A second run reads the cache only: one message per subject.
		const again = worker.sent.length;
		await precomputeClosureForOntologyPair(db, 'a', 'b');
		expect(worker.sent.length - again).toBe(2 + subjects.length);
		await db.close();
	});
});

describe('projection writes through the Worker', () => {
	let factory: InProcessWorkerFactory;
	let originalCreate: unknown;
	let originalRevoke: unknown;

	beforeEach(() => {
		const urlCtor = URL as unknown as Record<string, unknown>;
		originalCreate = urlCtor.createObjectURL;
		urlCtor.createObjectURL = jest.fn(() => FAKE_MODULE_PATH);
		originalRevoke = urlCtor.revokeObjectURL;
		urlCtor.revokeObjectURL = jest.fn();
		factory = createInProcessWorkerFactory();
		setTier2WorkerFactory(factory);
	});

	afterEach(() => {
		setTier2WorkerFactory(null);
		(URL as unknown as Record<string, unknown>).createObjectURL = originalCreate;
		(URL as unknown as Record<string, unknown>).revokeObjectURL = originalRevoke;
		clearFakeSqlite3();
	});

	function concept(path: string, curie: string) {
		return [{ path, stat: { mtime: Date.parse('2026-10-03T00:00:00.000Z') } },
			{ _crosswalker: { produced_at: '2026-10-03T00:00:00.000Z' }, kind: 'concept', curie, title: curie }] as const;
	}

	function app(entries: ReadonlyArray<readonly [{ path: string; stat: { mtime: number } }, Record<string, unknown>]>): any {
		const byPath = new Map(entries.map(([file, fm]) => [file.path, fm]));
		return {
			vault: { getMarkdownFiles: () => entries.map(([file]) => file), getAbstractFileByPath: () => null, getFiles: () => [] },
			metadataCache: { getFileCache: (file: { path: string }) => ({ frontmatter: byPath.get(file.path) }) },
		};
	}

	it('writes one batch per yield window, not one message per statement', async () => {
		installFakeSqlite3();
		const db = await WorkerDb.create({ ...startOptions(), sidecarPath: '.crosswalker.sqlite' });
		await applyMigrations(db);
		const entries = Array.from({ length: 120 }, (_, index) => concept(`F/c${index}.md`, `ex:C${index}`));
		const worker = factory.created[0];
		const before = worker.sent.length;

		const result = await projectFromTier1(app(entries), db, { projectionMode: 'full', yieldEvery: 50 });

		expect(result.success).toBe(true);
		expect(result.counts.concepts).toBe(120);
		expect(await count(db, 'concepts')).toBe(120);
		const sent = worker.sent.slice(before);
		const batches = sent.filter((request) => request.type === 'execBatch');
		// Three windows of rows (49, 50, 21 files) plus marks, prune and stamp
		// batches; far fewer than the ~360 per-row statements.
		expect(sent.length).toBeLessThan(20);
		expect(batches.length).toBeGreaterThanOrEqual(3);
		await db.close();
	});

	it('attributes a statement failure to its own note and keeps the rest of the window', async () => {
		const db = new LocalDb(rawNodeDb());
		await applyMigrations(db);
		// A trigger that rejects one curie models a SQL-level row failure.
		await db.exec(`CREATE TRIGGER reject_bad BEFORE INSERT ON concepts
			WHEN NEW.curie = 'ex:BAD' BEGIN SELECT RAISE(ABORT, 'rejected by test trigger'); END`);
		const entries = [concept('F/a.md', 'ex:A'), concept('F/bad.md', 'ex:BAD'), concept('F/c.md', 'ex:C')];

		const result = await projectFromTier1(app(entries), db, { projectionMode: 'partial' });

		expect(result.errors).toEqual([{ vault_path: 'F/bad.md', message: expect.stringMatching(/rejected by test trigger/) }]);
		expect(result.counts.concepts).toBe(2);
		expect(result.counts.errors).toBe(1);
		const curies = await db.exec({ sql: 'SELECT curie FROM concepts ORDER BY curie', rowMode: 'array', returnValue: 'resultRows' });
		expect(curies).toEqual([['ex:A'], ['ex:C']]);
		await db.close();
	});
});
