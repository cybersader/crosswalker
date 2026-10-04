/**
 * evidence-coverage.test.ts — the anti-join a compliance reader relies on
 * (2026-08-21, Challenge 45 §4.3).
 *
 * The bar here is not "the query runs". It is that the two ways this went wrong
 * before cannot come back:
 *
 *   1. A control with NO evidence must appear in the gap report. The withdrawn
 *      Base could not express this at all, and the failure was invisible.
 *   2. A junction that exists but does not qualify must NOT quietly count, and
 *      must be explainable — otherwise a team sees zero coverage and cannot
 *      tell a data problem from a compliance problem.
 */

import { applyMigrations } from '../src/tier2/migrations';
import {
	CANONICAL_EVIDENCE_PREDICATE,
	conceptsWithoutValidEvidence,
	diagnoseExcludedJunctions,
	evidenceCoverageByConcept,
	evidenceCoverageSummary,
} from '../src/tier2/evidence-coverage';

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

const ONTOLOGY = 'nist-800-53';

/** Register an ontology so concept rows satisfy their foreign key. */
function addOntology(db: TestDb, id: string): void {
	db.exec({
		sql: `INSERT OR IGNORE INTO ontologies (id, name, base_path, recipe_id, imported_at)
		      VALUES ($id, $id, 'Frameworks', 'test', '2026-08-21')`,
		bind: { $id: id },
	});
}

function addConcept(db: TestDb, curie: string, title = curie, ontology = ONTOLOGY): void {
	addOntology(db, ontology);
	db.exec({
		sql: `INSERT INTO concepts (ontology_id, curie, vault_path, source_hash, title, status, imported_at, modified_at)
		      VALUES ($o, $c, $p, 'h', $t, 'active', '2026-08-21', '2026-08-21')`,
		bind: { $o: ontology, $c: curie, $p: `Frameworks/${ontology}/${title}.md`, $t: title },
	});
}

/** A junction, valid by default; pass overrides to break exactly one rule. */
function addJunction(db: TestDb, path: string, overrides: Record<string, unknown> = {}): void {
	const row = {
		vault_path: path,
		curie: `cwk:${path}`,
		subject: '[[AC-1]]',
		subject_curie: `${ONTOLOGY}:AC-1`,
		predicate: CANONICAL_EVIDENCE_PREDICATE,
		object: '[[MFA-Policy]]',
		object_curie: null,
		coverage: 'full',
		status: 'approved',
		// No review_date/expires_at => freshness 'not-set', which is admitted.
		review_date: null,
		expires_at: null,
		source_hash: 'h',
		modified_at: '2026-08-21',
		...overrides,
	};
	db.exec({
		sql: `INSERT INTO junction_notes
		        (vault_path, curie, subject, subject_curie, predicate, object, object_curie,
		         coverage, status, review_date, expires_at, source_hash, modified_at)
		      VALUES ($vault_path, $curie, $subject, $subject_curie, $predicate, $object, $object_curie,
		              $coverage, $status, $review_date, $expires_at, $source_hash, $modified_at)`,
		bind: Object.fromEntries(Object.entries(row).map(([k, v]) => [`$${k}`, v])),
	});
}

describe('evidence coverage anti-join', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = createTestDb();
		await applyMigrations(db as any);
	});
	afterEach(() => db.close());

	it('reports a control that has no evidence at all', async () => {
		// The original failure: this row could not exist, because a Bases filter
		// has no note to emit for an absent relationship.
		addConcept(db, `${ONTOLOGY}:AC-1`);
		const gaps = await conceptsWithoutValidEvidence(db, ONTOLOGY);
		expect(gaps.map((r) => r.curie)).toEqual([`${ONTOLOGY}:AC-1`]);
		expect(gaps[0].coverage_state).toBe('uncovered');
	});

	it('does not report a control that has valid evidence', async () => {
		addConcept(db, `${ONTOLOGY}:AC-1`);
		addJunction(db, 'Evidence/j1.md');
		expect(await conceptsWithoutValidEvidence(db, ONTOLOGY)).toHaveLength(0);
	});

	it('separates partial evidence from full coverage', async () => {
		// Partial evidence is not a gap, and is also not coverage. Collapsing the
		// two is how a half-satisfied control gets reported as satisfied.
		addConcept(db, `${ONTOLOGY}:AC-1`);
		addJunction(db, 'Evidence/j1.md', { coverage: 'partial' });
		const [row] = await evidenceCoverageByConcept(db, ONTOLOGY);
		expect(row.coverage_state).toBe('partial');
		expect(row.valid_count).toBe(1);
		expect(row.full_count).toBe(0);
		expect(await conceptsWithoutValidEvidence(db, ONTOLOGY)).toHaveLength(0);
	});

	it('counts a control once regardless of how many junctions it has', async () => {
		addConcept(db, `${ONTOLOGY}:AC-1`);
		addJunction(db, 'Evidence/j1.md');
		addJunction(db, 'Evidence/j2.md', { curie: 'cwk:j2' });
		const summary = await evidenceCoverageSummary(db, ONTOLOGY);
		expect(summary.total_concepts).toBe(1);
		expect(summary.covered).toBe(1);
	});
});

describe('junctions that must not count', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = createTestDb();
		await applyMigrations(db as any);
		addConcept(db, `${ONTOLOGY}:AC-1`);
	});
	afterEach(() => db.close());

	const cases: Array<[string, Record<string, unknown>, string]> = [
		['a near-miss predicate', { predicate: 'evidences' }, 'predicate-not-canonical'],
		['an unapproved status', { status: 'proposed' }, 'not-approved'],
		['coverage explicitly none', { coverage: 'none' }, 'coverage-not-asserted'],
		['expired evidence', { expires_at: '2020-01-01T00:00:00Z' }, 'expired'],
		['stale evidence', { review_date: '2020-01-01T00:00:00Z' }, 'stale'],
		['no stable identity', { subject_curie: null }, 'no-subject-identity'],
		['an identity matching no concept', { subject_curie: 'nist-800-53:NOPE' }, 'subject-not-a-known-concept'],
	];

	it.each(cases)('%s leaves the control uncovered', async (_label, overrides) => {
		addJunction(db, 'Evidence/j1.md', overrides);
		expect(await conceptsWithoutValidEvidence(db, ONTOLOGY)).toHaveLength(1);
	});

	it.each(cases)('%s is diagnosed rather than silently dropped', async (_label, overrides, reason) => {
		addJunction(db, 'Evidence/j1.md', overrides);
		const excluded = await diagnoseExcludedJunctions(db);
		expect(excluded).toHaveLength(1);
		expect(excluded[0].reason).toBe(reason);
	});

	it('reports the inverted direction as a findable problem, not as zero coverage', async () => {
		// The GRC guide published `subject: [[MFA-Policy]]`, `object: [[AC-2]]`.
		// Read literally that says the policy has evidence, so the control gets
		// nothing. Without a diagnostic the team sees 0% and no reason why.
		addJunction(db, 'Evidence/inverted.md', {
			subject: '[[MFA-Policy]]',
			subject_curie: 'evidence:MFA-Policy',
			object: '[[AC-1]]',
		});
		expect(await conceptsWithoutValidEvidence(db, ONTOLOGY)).toHaveLength(1);
		expect((await diagnoseExcludedJunctions(db))[0].reason).toBe('subject-not-a-known-concept');
	});

	it('counts excluded junctions in the summary so a reader can ask about them', async () => {
		addJunction(db, 'Evidence/j1.md', { predicate: 'implements' });
		const summary = await evidenceCoverageSummary(db, ONTOLOGY);
		expect(summary.uncovered).toBe(1);
		expect(summary.excluded_junctions).toBe(1);
	});

	it('leaves valid junctions out of the exclusion report', async () => {
		addJunction(db, 'Evidence/good.md');
		expect(await diagnoseExcludedJunctions(db)).toHaveLength(0);
	});
});

describe('scoping', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = createTestDb();
		await applyMigrations(db as any);
	});
	afterEach(() => db.close());

	it('does not leak concepts from another ontology into the report', async () => {
		addConcept(db, `${ONTOLOGY}:AC-1`);
		addConcept(db, 'cis-v8:1.1', '1.1', 'cis-v8');
		expect((await evidenceCoverageByConcept(db, ONTOLOGY)).map((r) => r.curie)).toEqual([`${ONTOLOGY}:AC-1`]);
	});

	it('returns an empty report for an ontology with no concepts rather than throwing', async () => {
		expect((await evidenceCoverageSummary(db, 'not-imported')).total_concepts).toBe(0);
	});
});
