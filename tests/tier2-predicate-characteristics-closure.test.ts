import { applyMigrations } from '../src/tier2/migrations';
import {
	closureFromConcept,
	crosswalkBetween,
	precomputeClosureForOntologyPair,
	type ClosureEntry,
} from '../src/tier2/queries';

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
}

function createTestDb(): TestDb {
	const sqlite = new DatabaseSync(':memory:');
	return {
		exec(input: string | ExecOptions): unknown[][] | void {
			if (typeof input === 'string') {
				sqlite.exec(input);
				return;
			}
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
	};
}

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

function targets(entries: ClosureEntry[]): Array<[string, number]> {
	return entries.map((entry) => [entry.target_curie, entry.shortest_depth]);
}

function queryRows(db: TestDb, sql: string, bind: Record<string, unknown> = {}): unknown[][] {
	return db.exec({
		sql,
		bind,
		rowMode: 'array',
		returnValue: 'resultRows',
	}) as unknown[][];
}

describe('Tier 2 predicate-characteristic closure', () => {
	let db: TestDb;

	beforeEach(async () => {
		db = createTestDb();
		await applyMigrations(db);
	});

	afterEach(() => {
		db.close();
	});

	it('derives directional inverse chains for broader and narrower predicates', async () => {
		insertMapping(db, 'example:A', 'is_broader_than', 'example:B', 'broader-1');
		insertMapping(db, 'example:B', 'is_broader_than', 'example:C', 'broader-2');

		expect(targets(await closureFromConcept(db, 'example:A', 'is_broader_than', 10))).toEqual([
			['example:B', 1],
			['example:C', 2],
		]);
		expect(targets(await closureFromConcept(db, 'example:C', 'is_narrower_than', 10))).toEqual([
			['example:B', 1],
			['example:A', 2],
		]);
		expect(targets(await closureFromConcept(db, 'example:B', 'is_narrower_than', 10))).toEqual([
			['example:A', 1],
		]);
	});

	it('traverses equivalence symmetrically and transitively in either direction', async () => {
		insertMapping(db, 'example:P', 'is_equivalent_to', 'example:Q', 'equivalent-1');
		insertMapping(db, 'example:Q', 'is_equivalent_to', 'example:R', 'equivalent-2');

		expect(targets(await closureFromConcept(db, 'example:P', 'is_equivalent_to', 10))).toEqual([
			['example:Q', 1],
			['example:R', 2],
		]);
		expect(targets(await closureFromConcept(db, 'example:R', 'is_equivalent_to', 10))).toEqual([
			['example:Q', 1],
			['example:P', 2],
		]);
	});

	it.each([
		['is_approximate_to', 'approximate'],
		['intersects_with', 'intersects'],
		['no_relationship', 'none'],
	] as const)('traverses %s symmetrically without chaining', async (predicate, suffix) => {
		insertMapping(db, 'example:A', predicate, 'example:B', `${suffix}-1`);
		insertMapping(db, 'example:B', predicate, 'example:C', `${suffix}-2`);

		expect(targets(await closureFromConcept(db, 'example:B', predicate, 10))).toEqual([
			['example:A', 1],
			['example:C', 1],
		]);
		expect(targets(await closureFromConcept(db, 'example:A', predicate, 10))).toEqual([
			['example:B', 1],
		]);
	});

	it('does not switch predicates between hops in unfiltered closure', async () => {
		insertMapping(db, 'example:A', 'is_broader_than', 'example:B', 'mixed-1');
		insertMapping(db, 'example:B', 'intersects_with', 'example:D', 'mixed-2');
		insertMapping(db, 'example:D', 'is_broader_than', 'example:E', 'mixed-3');
		insertMapping(db, 'example:A', 'intersects_with', 'example:X', 'mixed-4');

		expect(targets(await closureFromConcept(db, 'example:A', undefined, 10))).toEqual([
			['example:B', 1],
			['example:X', 1],
		]);
	});

	it('deduplicates explicit reverse storage and terminates on cycles', async () => {
		insertMapping(db, 'example:A', 'is_equivalent_to', 'example:B', 'duplicate-1');
		insertMapping(db, 'example:B', 'is_equivalent_to', 'example:A', 'duplicate-2');
		insertMapping(db, 'example:B', 'is_equivalent_to', 'example:C', 'cycle-1');
		insertMapping(db, 'example:C', 'is_equivalent_to', 'example:A', 'cycle-2');

		expect(targets(await closureFromConcept(db, 'example:A', 'is_equivalent_to', 10))).toEqual([
			['example:B', 1],
			['example:C', 1],
		]);
	});

	it('rejects unknown explicit filters before reading a matching cache partition', async () => {
		db.exec(`
			INSERT INTO closure_cache_state
				(subject_id, predicate_id, computed_max_depth, computed_at)
			VALUES ('example:A', 'predicate-characteristics-v2|unknown', 99, 'old')
		`);

		await expect(closureFromConcept(db, 'example:A', 'unknown', 1)).rejects.toThrow(
			new RangeError('Unknown Crosswalker predicate: unknown'),
		);
		await expect(
			precomputeClosureForOntologyPair(db, 'example', 'target', 'unknown', 1),
		).rejects.toThrow(new RangeError('Unknown Crosswalker predicate: unknown'));
	});

	it('excludes unknown stored predicates from filtered and unfiltered closure', async () => {
		insertMapping(db, 'example:A', 'unknown', 'example:Ignored', 'unknown');
		insertMapping(db, 'example:A', 'is_broader_than', 'example:B', 'known');

		expect(targets(await closureFromConcept(db, 'example:A', undefined, 2))).toEqual([
			['example:B', 1],
		]);
		expect(targets(await closureFromConcept(db, 'example:A', 'is_broader_than', 2))).toEqual([
			['example:B', 1],
		]);
	});

	it('keeps negated equivalence directly queryable but excludes both closure directions and precompute', async () => {
		db.exec({
			sql: `
				INSERT INTO mappings
					(mapping_set_id, subject_id, predicate_id, predicate_modifier, object_id, source_path, source_hash)
				VALUES ($set, $subject, $predicate, 'NOT', $object, $path, $hash)
			`,
			bind: {
				$set: 'set:negation-proof',
				$subject: 'example:A',
				$predicate: 'is_equivalent_to',
				$object: 'example:B',
				$path: 'Mappings/negated-equivalence.md',
				$hash: 'hash-negated-equivalence',
			},
		});

		expect(await crosswalkBetween(db, 'example', 'example', 'is_equivalent_to')).toEqual([
			expect.objectContaining({
				mapping_set_id: 'set:negation-proof',
				subject_id: 'example:A',
				predicate_modifier: 'NOT',
				object_id: 'example:B',
				source_path: 'Mappings/negated-equivalence.md',
			}),
		]);
		expect(await closureFromConcept(db, 'example:A', 'is_equivalent_to', 1)).toEqual([]);
		expect(await closureFromConcept(db, 'example:B', 'is_equivalent_to', 1)).toEqual([]);
		db.exec('DELETE FROM closure_cache_state');
		expect(
			await precomputeClosureForOntologyPair(db, 'example', 'example', 'is_equivalent_to', 1),
		).toBe(0);
		expect(queryRows(db, 'SELECT COUNT(*) FROM closure_cache_state')).toEqual([[0]]);
		expect(queryRows(db, 'SELECT COUNT(*) FROM closure_cache')).toEqual([[0]]);
		expect(queryRows(db, 'SELECT COUNT(*) FROM mappings')).toEqual([[1]]);
	});

	// The characteristics table is an INPUT to every cached closure result, so
	// the physical cache key carries a version of it. Ch 43 added the lineage
	// pair and moved that version to v2; a partition written under v1 must be
	// ignored rather than reused. A cache key that does not cover its own inputs
	// is the exact bug fixed on 2026-08-20, and the only reason this is cheap to
	// get right is that the cache is rebuildable.
	it('does not reuse a closure partition written under the previous semantics version', async () => {
		insertMapping(db, 'example:A', 'is_broader_than', 'example:B', 'version-1');

		// A stale v1 partition claiming a target that does not exist. If the
		// version were still part of the key by name only, this would be returned.
		db.exec(`
			INSERT INTO closure_cache_state
				(subject_id, predicate_id, computed_max_depth, computed_at)
			VALUES ('example:A', 'predicate-characteristics-v1|is_broader_than', 9, 'old')
		`);
		db.exec(`
			INSERT INTO closure_cache
				(subject_id, predicate_id, object_id, shortest_depth, computed_at)
			VALUES ('example:A', 'predicate-characteristics-v1|is_broader_than', 'example:STALE', 1, 'old')
		`);

		expect(targets(await closureFromConcept(db, 'example:A', 'is_broader_than', 5))).toEqual([
			['example:B', 1],
		]);
		expect(
			queryRows(
				db,
				`SELECT predicate_id FROM closure_cache_state
				 WHERE subject_id = 'example:A' ORDER BY predicate_id`,
			),
		).toEqual([
			['predicate-characteristics-v1|is_broader_than'],
			['predicate-characteristics-v2|is_broader_than'],
		]);
	});

	// Lineage rides the same recursive CTE as every other transitive predicate.
	// No bespoke traversal exists, and this is the assertion that says so.
	it('walks lineage chains through the ordinary closure machinery', async () => {
		insertMapping(db, 'r4:AC-2', 'superseded_by', 'r5:AC-2', 'lineage-1');
		insertMapping(db, 'r5:AC-2', 'superseded_by', 'r6:PT-1', 'lineage-2');

		expect(targets(await closureFromConcept(db, 'r4:AC-2', 'superseded_by', 5))).toEqual([
			['r5:AC-2', 1],
			['r6:PT-1', 2],
		]);
		expect(await closureFromConcept(db, 'r6:PT-1', 'superseded_by', 5)).toEqual([]);
	});

	it('precomputes concepts that are subjects only through a derived inverse edge', async () => {
		insertMapping(db, 'source:A', 'is_broader_than', 'target:B', 'inverse-subject');

		expect(
			await precomputeClosureForOntologyPair(db, 'target', 'source', 'is_narrower_than', 2),
		).toBe(1);
		expect(
			queryRows(
				db,
				`SELECT subject_id, predicate_id FROM closure_cache_state
				 WHERE subject_id = 'target:B'`,
			),
		).toEqual([['target:B', 'predicate-characteristics-v2|is_narrower_than']]);
	});
});
