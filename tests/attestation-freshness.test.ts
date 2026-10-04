/**
 * attestation-freshness.test.ts — content is the third driver of freshness
 * (Ch 43 re-attestation, 2026-08-28).
 *
 * THE ABSENCE RULING IS THE POINT OF THIS FILE
 *
 * A link that never recorded a review baseline is `unrecorded`. It COUNTS, and
 * it is REPORTED BY NAME. Two wrong answers were available and both are pinned
 * against here:
 *
 *   - "absent means changed" would invalidate every attestation in every
 *     existing vault the moment the plugin updates, dropping coverage to near
 *     zero for work nobody touched.
 *   - "absent means unchanged" would exempt every pre-existing link from
 *     content invalidation forever, invisibly, and the exemption would grow
 *     every time somebody hand-writes a note.
 *
 * The precedent is already in the file being extended: `not-set` freshness is
 * admitted because refusing it "reports a data-entry gap as a compliance gap".
 * A never-recorded fingerprint is not evidence of change.
 */

import { applyMigrations, TIER2_SCHEMA_VERSION } from '../src/tier2/migrations';
import {
	CANONICAL_EVIDENCE_PREDICATE,
	diagnoseExcludedJunctions,
	evidenceCoverageByConcept,
	evidenceCoverageSummary,
	listUnbaselinedValidJunctions,
} from '../src/tier2/evidence-coverage';

// eslint-disable-next-line @typescript-eslint/no-var-requires
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
const AC1 = `${ONTOLOGY}:AC-1`;
const CID_OLD = `sha256-${'a'.repeat(64)}`;
const CID_NEW = `sha256-${'b'.repeat(64)}`;

function addConcept(
	db: TestDb,
	curie: string,
	reviewCid: string | null = CID_OLD,
	ontology = ONTOLOGY,
): void {
	db.exec({
		sql: `INSERT OR IGNORE INTO ontologies (id, name, base_path, recipe_id, imported_at)
		      VALUES ($id, $id, 'Frameworks', 'test', '2026-08-28')`,
		bind: { $id: ontology },
	});
	db.exec({
		sql: `INSERT INTO concepts (ontology_id, curie, vault_path, source_hash, title, review_cid, status, imported_at, modified_at)
		      VALUES ($o, $c, $p, 'h', $c, $rc, 'active', '2026-08-28', '2026-08-28')`,
		bind: { $o: ontology, $c: curie, $p: `Frameworks/${ontology}/${curie}.md`, $rc: reviewCid },
	});
}

/** A junction that is valid by default; each override breaks exactly one thing. */
function addJunction(db: TestDb, path: string, overrides: Record<string, unknown> = {}): void {
	const row = {
		vault_path: path,
		curie: `cwk:${path}`,
		subject: '[[AC-1]]',
		subject_curie: AC1,
		predicate: CANONICAL_EVIDENCE_PREDICATE,
		object: '[[MFA-Policy]]',
		object_curie: null,
		coverage: 'full',
		status: 'approved',
		review_date: null,
		expires_at: null,
		reviewed_against_curie: null,
		reviewed_against_cid: null,
		source_hash: 'h',
		modified_at: '2026-08-28',
		...overrides,
	};
	db.exec({
		sql: `INSERT INTO junction_notes
		        (vault_path, curie, subject, subject_curie, predicate, object, object_curie,
		         coverage, status, review_date, expires_at, reviewed_against_curie, reviewed_against_cid,
		         source_hash, modified_at)
		      VALUES ($vault_path, $curie, $subject, $subject_curie, $predicate, $object, $object_curie,
		              $coverage, $status, $review_date, $expires_at, $reviewed_against_curie, $reviewed_against_cid,
		              $source_hash, $modified_at)`,
		bind: Object.fromEntries(Object.entries(row).map(([k, v]) => [`$${k}`, v])),
	});
}

function viewRow(db: TestDb, path: string): { freshness: string; subject_baseline: string } {
	const rows = db.exec({
		sql: `SELECT freshness, subject_baseline FROM junction_notes_with_freshness WHERE vault_path = $p`,
		bind: { $p: path },
		rowMode: 'array',
		returnValue: 'resultRows',
	}) as unknown[][];
	expect(rows).toHaveLength(1);
	return { freshness: String(rows[0][0]), subject_baseline: String(rows[0][1]) };
}

const PAST = '2020-01-01T00:00:00Z';

describe('a never-recorded baseline is `unrecorded`, counts, and is named', () => {
	let db: TestDb;
	beforeEach(async () => { db = createTestDb(); await applyMigrations(db as any); });
	afterEach(() => db.close());

	it('A1: no reviewed_against, no dates — not-set, unrecorded, and it COUNTS', async () => {
		// THE test that fails if a never-recorded attestation ever starts being
		// treated as changed. Every pre-existing vault is exactly this shape.
		addConcept(db, AC1);
		addJunction(db, 'Evidence/j1.md');

		expect(viewRow(db, 'Evidence/j1.md')).toEqual({
			freshness: 'not-set',
			subject_baseline: 'unrecorded',
		});
		expect((await evidenceCoverageByConcept(db, ONTOLOGY))[0].valid_count).toBe(1);
		expect(await diagnoseExcludedJunctions(db)).toEqual([]);
		expect((await evidenceCoverageSummary(db, ONTOLOGY)).unbaselined_valid_junctions).toBe(1);
	});

	it('A2: no reviewed_against but a fresh review date — fresh, unrecorded, still counts', async () => {
		addConcept(db, AC1);
		addJunction(db, 'Evidence/j1.md', { review_date: new Date().toISOString() });

		expect(viewRow(db, 'Evidence/j1.md')).toEqual({
			freshness: 'fresh',
			subject_baseline: 'unrecorded',
		});
		expect((await evidenceCoverageSummary(db, ONTOLOGY)).covered).toBe(1);
		expect((await evidenceCoverageSummary(db, ONTOLOGY)).unbaselined_valid_junctions).toBe(1);
	});

	it('A3: a whole vault of pre-existing links reports the same coverage as before', async () => {
		// The upgrade case. Nothing the user did may change their number.
		addConcept(db, AC1);
		addConcept(db, `${ONTOLOGY}:AC-2`);
		addConcept(db, `${ONTOLOGY}:AC-3`);
		addJunction(db, 'Evidence/j1.md');
		addJunction(db, 'Evidence/j2.md', { curie: 'cwk:j2', subject_curie: `${ONTOLOGY}:AC-2`, coverage: 'partial' });

		const summary = await evidenceCoverageSummary(db, ONTOLOGY);
		expect(summary.covered).toBe(1);
		expect(summary.partial).toBe(1);
		expect(summary.uncovered).toBe(1);
		expect(summary.excluded_junctions).toBe(0);
		// Only this is new, and it is additive.
		expect(summary.unbaselined_valid_junctions).toBe(2);
	});

	it('A5: a half-record never becomes a half-comparison', async () => {
		// Tier 1 validation rejects `reviewed_against` with only one sub-field.
		// If one reaches the index anyway, the projector binds both NULL — so the
		// worst case is `unrecorded`, never a comparison against a missing half.
		addConcept(db, AC1, CID_NEW);
		addJunction(db, 'Evidence/j1.md', { reviewed_against_curie: AC1, reviewed_against_cid: null });
		expect(viewRow(db, 'Evidence/j1.md').subject_baseline).toBe('unrecorded');
		expect((await evidenceCoverageByConcept(db, ONTOLOGY))[0].valid_count).toBe(1);
	});

	it('C5: a subject with no fingerprint is subject-unhashed, and still counts', async () => {
		// The absence rule applied at the other endpoint: an external producer
		// that computed no fingerprint has not asserted that anything changed.
		addConcept(db, AC1, null);
		addJunction(db, 'Evidence/j1.md', { reviewed_against_curie: AC1, reviewed_against_cid: CID_OLD });

		expect(viewRow(db, 'Evidence/j1.md')).toEqual({
			freshness: 'not-set',
			subject_baseline: 'subject-unhashed',
		});
		expect((await evidenceCoverageByConcept(db, ONTOLOGY))[0].valid_count).toBe(1);
		expect((await listUnbaselinedValidJunctions(db)).map((j) => j.baseline)).toEqual(['subject-unhashed']);
	});
});

describe('a changed subject invalidates the claim without breaking the link', () => {
	let db: TestDb;
	beforeEach(async () => { db = createTestDb(); await applyMigrations(db as any); });
	afterEach(() => db.close());

	it('B2/C3: no dates but a changed subject reports subject-changed, not not-set', async () => {
		// The branch-reorder test. `not-set` used to be the FIRST branch, which
		// would short-circuit content invalidation for every link with no review
		// dates — most links in most vaults, i.e. the whole feature.
		addConcept(db, AC1, CID_NEW);
		addJunction(db, 'Evidence/j1.md', { reviewed_against_curie: AC1, reviewed_against_cid: CID_OLD });

		expect(viewRow(db, 'Evidence/j1.md')).toEqual({
			freshness: 'subject-changed',
			subject_baseline: 'changed',
		});
		expect((await evidenceCoverageByConcept(db, ONTOLOGY))[0].valid_count).toBe(0);
		expect((await diagnoseExcludedJunctions(db)).map((j) => j.reason)).toEqual(['subject-changed']);
	});

	it('a matching fingerprint stays fresh and counts', async () => {
		addConcept(db, AC1, CID_OLD);
		addJunction(db, 'Evidence/j1.md', { reviewed_against_curie: AC1, reviewed_against_cid: CID_OLD });
		expect(viewRow(db, 'Evidence/j1.md')).toEqual({ freshness: 'not-set', subject_baseline: 'match' });
		expect((await evidenceCoverageSummary(db, ONTOLOGY)).unbaselined_valid_junctions).toBe(0);
	});

	it('re-approving against the current content restores the count', async () => {
		// The whole point of the feature: the link is not broken, the claim is
		// stale, and one human action fixes it.
		addConcept(db, AC1, CID_NEW);
		addJunction(db, 'Evidence/j1.md', { reviewed_against_curie: AC1, reviewed_against_cid: CID_OLD });
		expect((await evidenceCoverageByConcept(db, ONTOLOGY))[0].valid_count).toBe(0);

		db.exec({
			sql: `UPDATE junction_notes SET reviewed_against_cid = $cid WHERE vault_path = 'Evidence/j1.md'`,
			bind: { $cid: CID_NEW },
		});
		expect((await evidenceCoverageByConcept(db, ONTOLOGY))[0].valid_count).toBe(1);
	});

	it('compares against the subject AS REVIEWED, not a re-pointed one', () => {
		// Re-pointing `subject_curie` without re-approving must not silently
		// revalidate the claim against a control nobody reviewed.
		addConcept(db, AC1, CID_OLD);
		addConcept(db, `${ONTOLOGY}:AC-9`, CID_NEW);
		addJunction(db, 'Evidence/j1.md', {
			subject_curie: `${ONTOLOGY}:AC-9`,
			reviewed_against_curie: AC1,
			reviewed_against_cid: CID_OLD,
		});
		// Baseline still resolves to AC-1, which matches. The link now points at
		// AC-9, which is a different problem and a human decision.
		expect(viewRow(db, 'Evidence/j1.md').subject_baseline).toBe('match');
	});

	it('reports subject-absent when the reviewed subject left the index', async () => {
		addConcept(db, AC1, CID_OLD);
		addJunction(db, 'Evidence/j1.md', {
			reviewed_against_curie: `${ONTOLOGY}:GONE`,
			reviewed_against_cid: CID_OLD,
		});
		expect(viewRow(db, 'Evidence/j1.md').subject_baseline).toBe('subject-absent');
		// Still counts: its own subject_curie resolves, and absence of a
		// comparable baseline is not evidence of change.
		expect((await evidenceCoverageByConcept(db, ONTOLOGY))[0].valid_count).toBe(1);
		expect((await listUnbaselinedValidJunctions(db)).map((j) => j.baseline)).toEqual(['subject-absent']);
	});
});

describe('one reason per link, and no fact is lost', () => {
	let db: TestDb;
	beforeEach(async () => { db = createTestDb(); await applyMigrations(db as any); });
	afterEach(() => db.close());

	it('C1: expired AND subject-changed reports expired, with the change carried separately', async () => {
		addConcept(db, AC1, CID_NEW);
		addJunction(db, 'Evidence/j1.md', {
			expires_at: PAST,
			reviewed_against_curie: AC1,
			reviewed_against_cid: CID_OLD,
		});
		// Expiry is a dated deadline the org owns and can act on today; the
		// content change is an upstream fact. Both point at re-review, so the one
		// carrying a date wins the single reason slot.
		expect(viewRow(db, 'Evidence/j1.md')).toEqual({ freshness: 'expired', subject_baseline: 'changed' });
		expect((await diagnoseExcludedJunctions(db)).map((j) => j.reason)).toEqual(['expired']);
	});

	it('C2: stale AND subject-changed reports stale, with the change carried separately', async () => {
		addConcept(db, AC1, CID_NEW);
		addJunction(db, 'Evidence/j1.md', {
			review_date: PAST,
			reviewed_against_curie: AC1,
			reviewed_against_cid: CID_OLD,
		});
		expect(viewRow(db, 'Evidence/j1.md')).toEqual({ freshness: 'stale', subject_baseline: 'changed' });
		expect((await diagnoseExcludedJunctions(db)).map((j) => j.reason)).toEqual(['stale']);
	});

	it('is deterministic across repeated runs', async () => {
		addConcept(db, AC1, CID_NEW);
		addJunction(db, 'Evidence/j1.md', {
			expires_at: PAST,
			reviewed_against_curie: AC1,
			reviewed_against_cid: CID_OLD,
		});
		const first = JSON.stringify(await diagnoseExcludedJunctions(db));
		for (let i = 0; i < 5; i++) expect(JSON.stringify(await diagnoseExcludedJunctions(db))).toBe(first);
	});

	it('C4: no dates and an unchanged subject is not-set and counts, exactly as before', async () => {
		addConcept(db, AC1, CID_OLD);
		addJunction(db, 'Evidence/j1.md', { reviewed_against_curie: AC1, reviewed_against_cid: CID_OLD });
		expect(viewRow(db, 'Evidence/j1.md').freshness).toBe('not-set');
		expect(await diagnoseExcludedJunctions(db)).toEqual([]);
	});

	it('never reports a content-invalidated link as merely stale', async () => {
		// `subject-changed` sits above the `ELSE stale` catch-all. Below it, the
		// report would confidently state a wrong reason, which is worse than none.
		addConcept(db, AC1, CID_NEW);
		addJunction(db, 'Evidence/j1.md', { reviewed_against_curie: AC1, reviewed_against_cid: CID_OLD });
		expect((await diagnoseExcludedJunctions(db))[0].reason).not.toBe('stale');
	});
});

describe('the view cannot double-count', () => {
	let db: TestDb;
	beforeEach(async () => { db = createTestDb(); await applyMigrations(db as any); });
	afterEach(() => db.close());

	it('a CURIE shared by two ontologies yields one row per junction', async () => {
		// `concepts` is keyed (ontology_id, curie). A plain curie join would fan
		// this view out and double every coverage tally built on it.
		addConcept(db, AC1, CID_OLD, ONTOLOGY);
		addConcept(db, AC1, CID_NEW, 'other-framework');
		addJunction(db, 'Evidence/j1.md');

		const rows = db.exec({
			sql: `SELECT vault_path FROM junction_notes_with_freshness`,
			rowMode: 'array',
			returnValue: 'resultRows',
		}) as unknown[][];
		expect(rows).toHaveLength(1);
		expect((await evidenceCoverageByConcept(db, ONTOLOGY))[0].valid_count).toBe(1);
	});
});

describe('the schema version moved so every sidecar rebuilds', () => {
	it('is tier2-sqlite-v6', () => {
		// The freshness view changed shape. A sidecar left on v5 would answer
		// with the old ladder and no subject_baseline column at all.
		expect(TIER2_SCHEMA_VERSION).toBe('tier2-sqlite-v6');
	});
});
