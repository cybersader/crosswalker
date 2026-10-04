import { applyMigrations } from '../src/tier2/migrations';
import { diagnoseExcludedJunctions } from '../src/tier2/evidence-coverage';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite');

interface ExecOptions { sql: string; bind?: Record<string, unknown>; rowMode?: 'array'; returnValue?: 'resultRows' }
interface TestDb { exec(input: string | ExecOptions): unknown[][] | void; close(): void }

const hash = (character: string): string => `sha256-${character.repeat(64)}`;
const OLD = { review: hash('a'), wording: hash('b'), scope: hash('c'), housekeeping: hash('d') };
const NEW = { review: hash('e'), wording: hash('f'), scope: hash('0'), housekeeping: hash('1') };

async function createDb(): Promise<TestDb> {
	const sqlite = new DatabaseSync(':memory:');
	const db: TestDb = {
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
	await applyMigrations(db as any);
	db.exec(`INSERT INTO ontologies (id, name, base_path, recipe_id, imported_at)
	         VALUES ('test', 'test', 'Frameworks', 'test', '2026-08-28')`);
	return db;
}

function seed(
	db: TestDb,
	current: typeof OLD,
	baseline: Partial<typeof OLD> | null,
): void {
	db.exec({
		sql: `INSERT INTO concepts
		        (ontology_id, curie, vault_path, source_hash, title, review_cid,
		         review_wording_cid, review_scope_cid, review_housekeeping_cid,
		         status, imported_at, modified_at)
		      VALUES ('test', 'test:C1', 'Frameworks/C1.md', 'h', 'C1', $review,
		              $wording, $scope, $housekeeping, 'active', '2026-08-28', '2026-08-28')`,
		bind: {
			$review: current.review,
			$wording: current.wording,
			$scope: current.scope,
			$housekeeping: current.housekeeping,
		},
	});
	db.exec({
		sql: `INSERT INTO junction_notes
		        (vault_path, curie, subject, subject_curie, predicate, object, coverage, status,
		         reviewed_against_curie, reviewed_against_cid,
		         reviewed_wording_cid, reviewed_scope_cid, reviewed_housekeeping_cid,
		         source_hash, modified_at)
		      VALUES ('Evidence/j1.md', 'cwk:j1', '[[C1]]', 'test:C1', 'has_evidence', '[[Evidence]]',
		              'full', 'approved', 'test:C1', $review, $wording, $scope, $housekeeping,
		              'h', '2026-08-28')`,
		bind: {
			$review: baseline?.review ?? null,
			$wording: baseline?.wording ?? null,
			$scope: baseline?.scope ?? null,
			$housekeeping: baseline?.housekeeping ?? null,
		},
	});
}

async function verdict(db: TestDb) {
	const rows = await diagnoseExcludedJunctions(db);
	expect(rows).toHaveLength(1);
	return rows[0];
}

describe('attestation change-kind priority', () => {
	it('wording outranks simultaneous scope and housekeeping changes', async () => {
		const db = await createDb();
		try {
			seed(db, NEW, OLD);
			expect(await verdict(db)).toMatchObject({ subject_baseline: 'changed', change_kind: 'wording' });
		} finally { db.close(); }
	});

	it('scope outranks housekeeping when wording matches', async () => {
		const db = await createDb();
		try {
			seed(db, { ...NEW, wording: OLD.wording }, OLD);
			expect((await verdict(db)).change_kind).toBe('scope');
		} finally { db.close(); }
	});

	it('housekeeping is used only when wording and scope match', async () => {
		const db = await createDb();
		try {
			seed(db, { ...NEW, wording: OLD.wording, scope: OLD.scope }, OLD);
			expect((await verdict(db)).change_kind).toBe('housekeeping');
		} finally { db.close(); }
	});

	it('a changed legacy baseline defaults to wording, never dismissible housekeeping', async () => {
		const db = await createDb();
		try {
			seed(db, NEW, { review: OLD.review });
			expect((await verdict(db)).change_kind).toBe('wording');
		} finally { db.close(); }
	});

	it('a matching whole-row fingerprint has no change kind even if group hashes differ', async () => {
		const db = await createDb();
		try {
			seed(db, NEW, { ...OLD, review: NEW.review });
			const rows = db.exec({
				sql: `SELECT subject_baseline, change_kind FROM junction_notes_with_freshness`,
				rowMode: 'array', returnValue: 'resultRows',
			}) as unknown[][];
			expect(rows).toEqual([['match', null]]);
		} finally { db.close(); }
	});
});
