import { TIER2_SCHEMA_VERSION, applyMigrations, getCurrentSchemaVersion } from '../src/tier2/migrations';
import {
	closureFromConcept,
	precomputeClosureForOntologyPair,
	type ClosureEntry,
} from '../src/tier2/queries';
import { projectFromTier1 } from '../src/tier2/projector';

const { DatabaseSync } = require('node:sqlite');

interface ExecOptions {
	sql: string;
	bind?: Record<string, unknown>;
	rowMode?: 'array';
	returnValue?: 'resultRows';
}

interface TestDb {
	exec(input: string | ExecOptions): unknown[][] | void;
	close(): void;
	getRecursiveQueryCount(): number;
}

function createTestDb(): TestDb {
	const sqlite = new DatabaseSync(':memory:');
	let recursiveQueryCount = 0;

	return {
		exec(input: string | ExecOptions): unknown[][] | void {
			if (typeof input === 'string') {
				sqlite.exec(input);
				return;
			}

			if (/WITH\s+RECURSIVE/.test(input.sql)) recursiveQueryCount += 1;
			const statement = sqlite.prepare(input.sql);
			if (input.rowMode === 'array') statement.setReturnArrays(true);
			const bind = input.bind ?? {};

			if (input.returnValue === 'resultRows') {
				return Object.keys(bind).length > 0 ? statement.all(bind) : statement.all();
			}

			if (Object.keys(bind).length > 0) statement.run(bind);
			else statement.run();
		},
		close(): void {
			sqlite.close();
		},
		getRecursiveQueryCount(): number {
			return recursiveQueryCount;
		},
	};
}

const PREDICATE = 'is_broader_than';
const OTHER_PREDICATE = 'is_narrower_than';
const CACHE_PREFIX = 'predicate-characteristics-v2|';
const CHAIN = [
	['example:A', 'example:B'],
	['example:B', 'example:C'],
	['example:C', 'example:D'],
] as const;

function insertMapping(
	db: TestDb,
	subject: string,
	predicate: string,
	object: string,
	suffix: string,
): void {
	db.exec({
		sql: `
			INSERT INTO mappings
				(subject_id, predicate_id, object_id, source_path, source_hash)
			VALUES ($subject, $predicate, $object, $path, $hash)
		`,
		bind: {
			$subject: subject,
			$predicate: predicate,
			$object: object,
			$path: `Mappings/edge-${suffix}.md`,
			$hash: `hash-${suffix}`,
		},
	});
}

function seedMappingChain(db: TestDb): void {
	for (const [index, [subject, object]] of CHAIN.entries()) {
		insertMapping(db, subject, PREDICATE, object, String(index + 1));
	}
}

function queryRows(db: TestDb, sql: string, bind: Record<string, unknown> = {}): unknown[][] {
	return db.exec({
		sql,
		bind,
		rowMode: 'array',
		returnValue: 'resultRows',
	}) as unknown[][];
}

function targets(entries: ClosureEntry[]): Array<[string, number]> {
	return entries.map((entry) => [entry.target_curie, entry.shortest_depth]);
}

describe('Tier 2 closure cache depth', () => {
	let db: TestDb;

	beforeEach(async () => {
		db = createTestDb();
		await applyMigrations(db);
		seedMappingChain(db);
	});

	afterEach(() => {
		db.close();
	});

	it('recomputes a deeper closure after a shallow query populated the cache', async () => {
		const shallow = await closureFromConcept(db, 'example:A', PREDICATE, 1);
		expect(targets(shallow)).toEqual([['example:B', 1]]);

		const deeper = await closureFromConcept(db, 'example:A', PREDICATE, 3);
		expect(targets(deeper)).toEqual([
			['example:B', 1],
			['example:C', 2],
			['example:D', 3],
		]);
		expect(db.getRecursiveQueryCount()).toBe(2);
		expect(queryRows(db, `SELECT computed_max_depth FROM closure_cache_state`)).toEqual([[3]]);
	});

	it('filters a cached deep closure when a shallow query runs second', async () => {
		const deeper = await closureFromConcept(db, 'example:A', PREDICATE, 3);
		expect(targets(deeper)).toEqual([
			['example:B', 1],
			['example:C', 2],
			['example:D', 3],
		]);

		const shallow = await closureFromConcept(db, 'example:A', PREDICATE, 1);
		expect(targets(shallow)).toEqual([['example:B', 1]]);
		expect(db.getRecursiveQueryCount()).toBe(1);
	});

	it('caches an empty closure with a state row instead of treating it as a miss', async () => {
		expect(await closureFromConcept(db, 'example:missing', PREDICATE, 4)).toEqual([]);
		expect(await closureFromConcept(db, 'example:missing', PREDICATE, 4)).toEqual([]);
		expect(db.getRecursiveQueryCount()).toBe(1);
		expect(
			queryRows(
				db,
				`SELECT subject_id, predicate_id, computed_max_depth FROM closure_cache_state
				 WHERE subject_id = $subject`,
				{ $subject: 'example:missing' },
			),
		).toEqual([['example:missing', `${CACHE_PREFIX}${PREDICATE}`, 4]]);
		expect(
			queryRows(db, `SELECT COUNT(*) FROM closure_cache WHERE subject_id = $subject`, {
				$subject: 'example:missing',
			}),
		).toEqual([[0]]);
	});

	it('ignores legacy raw cache keys even when their watermark covers the request', async () => {
		db.exec({
			sql: `
				INSERT INTO closure_cache
					(subject_id, predicate_id, object_id, shortest_depth, computed_at)
				VALUES ($subject, $predicate, 'example:stale', 1, 'old')
			`,
			bind: { $subject: 'example:A', $predicate: PREDICATE },
		});
		db.exec({
			sql: `
				INSERT INTO closure_cache_state
					(subject_id, predicate_id, computed_max_depth, computed_at)
				VALUES ($subject, $predicate, 99, 'old')
			`,
			bind: { $subject: 'example:A', $predicate: PREDICATE },
		});

		expect(targets(await closureFromConcept(db, 'example:A', PREDICATE, 2))).toEqual([
			['example:B', 1],
			['example:C', 2],
		]);
		expect(db.getRecursiveQueryCount()).toBe(1);
		expect(
			queryRows(
				db,
				`SELECT predicate_id, computed_max_depth FROM closure_cache_state
				 WHERE subject_id = $subject ORDER BY predicate_id`,
				{ $subject: 'example:A' },
			),
		).toEqual([
			[PREDICATE, 99],
			[`${CACHE_PREFIX}${PREDICATE}`, 2],
		]);
	});

	it('keeps wildcard and predicate-specific coverage in separate cache partitions', async () => {
		insertMapping(db, 'example:A', OTHER_PREDICATE, 'example:X', 'other-1');
		insertMapping(db, 'example:X', OTHER_PREDICATE, 'example:Y', 'other-2');

		expect(targets(await closureFromConcept(db, 'example:A', PREDICATE, 3))).toEqual([
			['example:B', 1],
			['example:C', 2],
			['example:D', 3],
		]);
		expect(targets(await closureFromConcept(db, 'example:A', undefined, 3))).toEqual([
			['example:B', 1],
			['example:X', 1],
			['example:C', 2],
			['example:Y', 2],
			['example:D', 3],
		]);
		expect(
			queryRows(
				db,
				`SELECT predicate_id, computed_max_depth FROM closure_cache_state
				 WHERE subject_id = $subject ORDER BY predicate_id`,
				{ $subject: 'example:A' },
			),
		).toEqual([
			[`${CACHE_PREFIX}*`, 3],
			[`${CACHE_PREFIX}${PREDICATE}`, 3],
		]);
	});

	it('rejects a literal star predicate before it can poison a wildcard cache', async () => {
		insertMapping(db, 'example:A', '*', 'example:Star', 'literal-star-edge-first');
		insertMapping(db, 'example:A', OTHER_PREDICATE, 'example:X', 'literal-star-first');

		await expect(closureFromConcept(db, 'example:A', '*', 2)).rejects.toThrow(
			new RangeError("predicateId '*' is reserved for unfiltered closure queries"),
		);
		await expect(
			precomputeClosureForOntologyPair(db, 'example', 'example', '*', 2),
		).rejects.toThrow(new RangeError("predicateId '*' is reserved for unfiltered closure queries"));
		expect(targets(await closureFromConcept(db, 'example:A', undefined, 2))).toEqual([
			['example:B', 1],
			['example:X', 1],
			['example:C', 2],
		]);
		expect(db.getRecursiveQueryCount()).toBe(1);
	});

	it('rejects a literal star predicate without disturbing an existing wildcard cache', async () => {
		insertMapping(db, 'example:A', '*', 'example:Star', 'literal-star-edge-second');
		insertMapping(db, 'example:A', OTHER_PREDICATE, 'example:X', 'wildcard-first');
		const expected: Array<[string, number]> = [
			['example:B', 1],
			['example:X', 1],
			['example:C', 2],
		];

		expect(targets(await closureFromConcept(db, 'example:A', undefined, 2))).toEqual(expected);
		await expect(closureFromConcept(db, 'example:A', '*', 2)).rejects.toThrow(
			new RangeError("predicateId '*' is reserved for unfiltered closure queries"),
		);
		expect(targets(await closureFromConcept(db, 'example:A', undefined, 2))).toEqual(expected);
		expect(db.getRecursiveQueryCount()).toBe(1);
	});

	it('terminates on cycles and preserves shortest depths', async () => {
		insertMapping(db, 'example:D', PREDICATE, 'example:A', 'cycle');

		expect(targets(await closureFromConcept(db, 'example:A', PREDICATE, 10))).toEqual([
			['example:B', 1],
			['example:C', 2],
			['example:D', 3],
		]);
	});

	it('returns an empty depth-zero closure without running the recursive CTE', async () => {
		expect(await closureFromConcept(db, 'example:A', PREDICATE, 0)).toEqual([]);
		expect(db.getRecursiveQueryCount()).toBe(0);
		expect(queryRows(db, `SELECT computed_max_depth FROM closure_cache_state`)).toEqual([[0]]);

		expect(targets(await closureFromConcept(db, 'example:A', PREDICATE, 1))).toEqual([
			['example:B', 1],
		]);
		expect(db.getRecursiveQueryCount()).toBe(1);
	});

	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		'rejects invalid maxDepth %s',
		async (maxDepth) => {
			await expect(closureFromConcept(db, 'example:A', PREDICATE, maxDepth)).rejects.toThrow(
			new RangeError('maxDepth must be a non-negative integer'),
			);
		},
	);

	it('scopes precompute counts to the requested predicate and depth', async () => {
		insertMapping(db, 'source:A', PREDICATE, 'target:B', 'precompute-1');
		insertMapping(db, 'target:B', PREDICATE, 'target:C', 'precompute-2');
		insertMapping(db, 'source:A', OTHER_PREDICATE, 'target:X', 'precompute-3');

		expect(await precomputeClosureForOntologyPair(db, 'source', 'target', PREDICATE, 2)).toBe(2);
		expect(await precomputeClosureForOntologyPair(db, 'source', 'target', undefined, 1)).toBe(2);
		expect(
			queryRows(
				db,
				`SELECT predicate_id, computed_max_depth FROM closure_cache_state
				 WHERE subject_id = 'source:A' ORDER BY predicate_id`,
			),
		).toEqual([
			[`${CACHE_PREFIX}*`, 1],
			[`${CACHE_PREFIX}${PREDICATE}`, 2],
		]);
	});

	it('matches ontology prefixes literally when precomputing underscore IDs', async () => {
		insertMapping(db, 'src_a:A', PREDICATE, 'dst_a:B', 'underscore-exact');
		insertMapping(db, 'srcXa:C', PREDICATE, 'dstXa:D', 'underscore-decoy');

		expect(await precomputeClosureForOntologyPair(db, 'src_a', 'dst_a', PREDICATE, 2)).toBe(1);
		expect(targets(await closureFromConcept(db, 'src_a:A', PREDICATE, 2))).toEqual([
			['dst_a:B', 1],
		]);
		expect(
			queryRows(
				db,
				`SELECT subject_id FROM closure_cache_state
				 WHERE subject_id IN ('src_a:A', 'srcXa:C') ORDER BY subject_id`,
			),
		).toEqual([['src_a:A']]);
	});

	it('invalidates cache rows and coverage state together after mapping projection', async () => {
		await closureFromConcept(db, 'example:A', PREDICATE, 3);
		expect(queryRows(db, `SELECT COUNT(*) FROM closure_cache`)).toEqual([[3]]);
		expect(queryRows(db, `SELECT COUNT(*) FROM closure_cache_state`)).toEqual([[1]]);

		const file = { path: 'Mappings/projected-edge.md', stat: { mtime: Date.now() } };
		const app = {
			vault: { getMarkdownFiles: () => [file] },
			metadataCache: {
				getFileCache: () => ({
					frontmatter: {
						_crosswalker: { produced_at: '2026-01-01T00:00:00.000Z' },
						kind: 'crosswalk-edge',
						subject_id: 'example:D',
						predicate_id: PREDICATE,
						object_id: 'example:E',
					},
				}),
			},
		};

		const result = await projectFromTier1(app as any, db, { yieldEvery: 100 });
		expect(result.success).toBe(true);
		expect(result.counts.mappings).toBe(1);
		expect(queryRows(db, `SELECT COUNT(*) FROM closure_cache`)).toEqual([[0]]);
		expect(queryRows(db, `SELECT COUNT(*) FROM closure_cache_state`)).toEqual([[0]]);
	});
});

describe('Tier 2 migration reports whether it rebuilt', () => {
	it('returns true when it rebuilds, so the caller knows to reproject', async () => {
		const db = createTestDb();
		try {
			// A fresh database has no schema at all, so migrating it is a rebuild:
			// every derived table ends up empty and MUST be reprojected before any
			// query answer can be trusted.
			expect(await applyMigrations(db)).toBe(true);
			expect(await getCurrentSchemaVersion(db)).toBe(TIER2_SCHEMA_VERSION);
		} finally {
			db.close();
		}
	});

	it('returns false when already current, so no needless reprojection happens', async () => {
		const db = createTestDb();
		try {
			await applyMigrations(db);
			expect(await applyMigrations(db)).toBe(false);
		} finally {
			db.close();
		}
	});

	it('does not claim a projection happened while the tables are empty', async () => {
		const db = createTestDb();
		try {
			await applyMigrations(db);
			// `projected_at` previously got stamped here, asserting a projection at
			// the exact moment every table was emptied. Nothing may record a
			// projection that did not occur.
			expect(
				queryRows(db, `SELECT COUNT(*) FROM schema_meta WHERE key = 'projected_at'`),
			).toEqual([[0]]);
		} finally {
			db.close();
		}
	});
});

describe('Tier 2 closure cache migration', () => {
	it.each([
		['versioned v1', true],
		['unversioned', false],
	])('rebuilds a %s database instead of preserving the old cache shape', async (_label, versioned) => {
		const db = createTestDb();
		try {
			db.exec(`
				${versioned ? 'CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);' : ''}
				CREATE TABLE closure_cache (
					subject_id TEXT NOT NULL,
					predicate_id TEXT NOT NULL,
					object_id TEXT NOT NULL,
					shortest_depth INTEGER NOT NULL,
					computed_at TEXT NOT NULL,
					PRIMARY KEY (subject_id, predicate_id, object_id)
				);
			`);
			if (versioned) {
				db.exec(`INSERT INTO schema_meta(key, value) VALUES ('schema_version', 'tier2-sqlite-v1')`);
			}
			db.exec(`
				INSERT INTO closure_cache
					(subject_id, predicate_id, object_id, shortest_depth, computed_at)
				VALUES ('example:A', '${PREDICATE}', 'example:B', 1, 'old')
			`);

			await applyMigrations(db);

			expect(await getCurrentSchemaVersion(db)).toBe(TIER2_SCHEMA_VERSION);
			expect(queryRows(db, `SELECT COUNT(*) FROM closure_cache`)).toEqual([[0]]);
			expect(
				queryRows(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'closure_cache_state'`),
			).toEqual([['closure_cache_state']]);
		} finally {
			db.close();
		}
	});
});
