/**
 * lineage-superseded-by.test.ts — release lineage as an ordinary crosswalk
 * (Ch 43, 2026-08-28).
 *
 * The verdict this pins: a version transition is a MAPPING between two release
 * ontologies, not a bespoke subsystem. A rename is one edge, a split is N edges
 * sharing a subject, a merge is N edges sharing an object. The flat
 * `previous_ids` field that was rejected cannot express the split or the merge
 * at all, so those two cases are asserted here explicitly rather than assumed.
 *
 * The other thing this file exists to prevent: a report that INVENTS a
 * successor. An orphaned attestation with no lineage edge must say so, and a
 * successor asserted by an edge but not imported in this vault must still be
 * named. Both wrong answers look identical to a correct one in a table.
 */

import { applyMigrations } from '../src/tier2/migrations';
import {
	CANONICAL_EVIDENCE_PREDICATE,
	SUCCESSOR_WALK_MAX_DEPTH,
	diagnoseExcludedJunctions,
	listSupersededSubjects,
} from '../src/tier2/evidence-coverage';
import { closureFromConcept } from '../src/tier2/queries';
import { renderEvidenceReport } from '../src/views/evidence-report';

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
		exec(input) {
			if (typeof input === 'string') {
				sqlite.exec(input);
				return;
			}
			const statement = sqlite.prepare(input.sql);
			if (input.rowMode === 'array') statement.setReturnArrays(true);
			const bind = input.bind ?? {};
			if (input.returnValue === 'resultRows') {
				return Object.keys(bind).length ? statement.all(bind) : statement.all();
			}
			if (Object.keys(bind).length) statement.run(bind);
			else statement.run();
		},
		close: () => sqlite.close(),
	};
}

/** The NEW release. The old release is deliberately never imported: that IS the
 *  structural-transition regime this feature is for. */
const NEW_RELEASE = 'nist-r5';
const OLD = 'nist-r4';

function addOntology(db: TestDb, id: string): void {
	db.exec({
		sql: `INSERT OR IGNORE INTO ontologies (id, name, base_path, recipe_id, imported_at)
		      VALUES ($id, $id, 'Frameworks', 'test', '2026-08-28')`,
		bind: { $id: id },
	});
}

function addConcept(db: TestDb, curie: string, title = curie, ontology = NEW_RELEASE): void {
	addOntology(db, ontology);
	db.exec({
		sql: `INSERT INTO concepts (ontology_id, curie, vault_path, source_hash, title, status, imported_at, modified_at)
		      VALUES ($o, $c, $p, 'h', $t, 'active', '2026-08-28', '2026-08-28')`,
		bind: { $o: ontology, $c: curie, $p: `Frameworks/${ontology}/${title}.md`, $t: title },
	});
}

/**
 * A lineage edge, stored exactly the way the ordinary crosswalk path stores one.
 * Nothing here is a lineage-specific table, column, or code path: the whole
 * point of the verdict is that this row is indistinguishable in shape from an
 * `is_equivalent_to` row.
 */
function addLineageEdge(
	db: TestDb,
	subject: string,
	object: string,
	options: { predicate?: string; modifier?: '' | 'NOT'; path?: string } = {},
): void {
	const predicate = options.predicate ?? 'superseded_by';
	const path = options.path ?? `Crosswalks/${subject}-${predicate}-${object}.md`;
	db.exec({
		sql: `INSERT INTO mappings
		        (mapping_set_id, subject_id, predicate_id, predicate_modifier, object_id,
		         mapping_justification, mapping_provider, source_path, source_hash)
		      VALUES ($set, $s, $p, $m, $o, 'semapv:ManualMappingCuration',
		              'NIST CPRT withdrawal records', $path, 'h')`,
		bind: {
			$set: 'https://crosswalker.dev/lineage/nist/r4-to-r5',
			$s: subject,
			$p: predicate,
			$m: options.modifier ?? '',
			$o: object,
			$path: path,
		},
	});
}

/** An attestation pointing at `subjectCurie`. Valid in every other respect. */
function addAttestation(db: TestDb, path: string, subjectCurie: string): void {
	db.exec({
		sql: `INSERT INTO junction_notes
		        (vault_path, curie, subject, subject_curie, predicate, object, object_curie,
		         coverage, status, review_date, expires_at, source_hash, modified_at)
		      VALUES ($path, $curie, $subject, $sc, $pred, '[[MFA-Policy]]', NULL,
		              'full', 'approved', NULL, NULL, 'h', '2026-08-28')`,
		bind: {
			$path: path,
			$curie: `cwk:${path}`,
			$subject: `[[${subjectCurie}]]`,
			$sc: subjectCurie,
			$pred: CANONICAL_EVIDENCE_PREDICATE,
		},
	});
}

async function reasonFor(db: TestDb, path: string): Promise<string | undefined> {
	return (await diagnoseExcludedJunctions(db)).find((row) => row.vault_path === path)?.reason;
}

function targets(entries: ReturnType<typeof closureFromConcept>): [string, number][] {
	return entries.map((e) => [e.target_curie, e.shortest_depth]);
}

describe('release lineage travels the ordinary crosswalk path', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = createTestDb();
		await applyMigrations(db as any);
	});
	afterEach(() => db.close());

	// --- the four cardinalities the verdict names --------------------------

	it('one-to-one: a rename resolves to a single successor', async () => {
		addConcept(db, `${NEW_RELEASE}:AC-2`, 'AC-2');
		addLineageEdge(db, `${OLD}:AC-2`, `${NEW_RELEASE}:AC-2`);
		addAttestation(db, 'Evidence/j1.md', `${OLD}:AC-2`);

		expect(await reasonFor(db, 'Evidence/j1.md')).toBe('subject-superseded');
		const [row] = await listSupersededSubjects(db);
		expect(row.subject_curie).toBe(`${OLD}:AC-2`);
		expect(row.attestation_count).toBe(1);
		expect(row.successors.map((s) => [s.curie, s.depth])).toEqual([
			[`${NEW_RELEASE}:AC-2`, 1],
		]);
		expect(row.successors[0].vault_path).toBe(`Frameworks/${NEW_RELEASE}/AC-2.md`);
	});

	// THE case a flat `previous_ids` field could not express. One old control,
	// two replacements, and the reader has to see both — picking one for them is
	// exactly the inference this design refuses to make.
	it('one-to-many: a split lists every replacement, at depth 1', async () => {
		addConcept(db, `${NEW_RELEASE}:PT-1`, 'PT-1');
		addConcept(db, `${NEW_RELEASE}:PT-2`, 'PT-2');
		addLineageEdge(db, `${OLD}:AR-1`, `${NEW_RELEASE}:PT-1`);
		addLineageEdge(db, `${OLD}:AR-1`, `${NEW_RELEASE}:PT-2`);
		addAttestation(db, 'Evidence/j1.md', `${OLD}:AR-1`);

		const [row] = await listSupersededSubjects(db);
		expect(row.successors.map((s) => [s.curie, s.depth])).toEqual([
			[`${NEW_RELEASE}:PT-1`, 1],
			[`${NEW_RELEASE}:PT-2`, 1],
		]);
		// Two edges, one attestation. The split did not multiply the link count.
		expect(row.attestation_count).toBe(1);
	});

	// The mirror case: two old controls folded into one. Each dangling subject
	// is its own row, both naming the same replacement, because each carries its
	// own attestations and its own re-review decision.
	it('many-to-one: a merge reports each old control separately', async () => {
		addConcept(db, `${NEW_RELEASE}:AC-2`, 'AC-2');
		addLineageEdge(db, `${OLD}:AC-2`, `${NEW_RELEASE}:AC-2`);
		addLineageEdge(db, `${OLD}:AC-2(1)`, `${NEW_RELEASE}:AC-2`);
		addAttestation(db, 'Evidence/j1.md', `${OLD}:AC-2`);
		addAttestation(db, 'Evidence/j2.md', `${OLD}:AC-2(1)`);
		addAttestation(db, 'Evidence/j3.md', `${OLD}:AC-2(1)`);

		const rows = await listSupersededSubjects(db);
		expect(rows.map((r) => [r.subject_curie, r.attestation_count])).toEqual([
			[`${OLD}:AC-2`, 1],
			[`${OLD}:AC-2(1)`, 2],
		]);
		for (const row of rows) {
			expect(row.successors.map((s) => s.curie)).toEqual([`${NEW_RELEASE}:AC-2`]);
		}
		expect(rows[1].attestation_paths).toEqual(['Evidence/j2.md', 'Evidence/j3.md']);
	});

	// The honesty case. No lineage edge means nobody asserted a replacement, and
	// the answer is "nobody knows", never a name Crosswalker guessed from a
	// similar-looking identifier.
	it('an orphan with no successor edge reports honestly and invents nothing', async () => {
		addConcept(db, `${NEW_RELEASE}:AC-2`, 'AC-2');
		addAttestation(db, 'Evidence/j1.md', `${OLD}:AC-2`);

		expect(await reasonFor(db, 'Evidence/j1.md')).toBe('subject-not-a-known-concept');
		expect(await listSupersededSubjects(db)).toEqual([]);
	});

	// --- walk semantics ----------------------------------------------------

	it('follows a multi-release chain and labels its depth', async () => {
		addConcept(db, 'nist-r6:PT-1', 'PT-1', 'nist-r6');
		addLineageEdge(db, `${OLD}:AC-2`, `${NEW_RELEASE}:AC-2`);
		addLineageEdge(db, `${NEW_RELEASE}:AC-2`, 'nist-r6:PT-1');

		expect(targets(await closureFromConcept(db, `${OLD}:AC-2`, 'superseded_by', SUCCESSOR_WALK_MAX_DEPTH))).toEqual([
			[`${NEW_RELEASE}:AC-2`, 1],
			['nist-r6:PT-1', 2],
		]);
	});

	// A subtle dependency on the shape of EFFECTIVE_EDGES_CTE, which materialises
	// each stored row's inverse under the inverse predicate. Filtering the walk
	// on `superseded_by` therefore travels old -> new only. Pinned rather than
	// commented, because a change to that CTE would silently reverse it.
	it('walks forward only: querying from the newest end returns nothing', async () => {
		addLineageEdge(db, `${OLD}:AC-2`, `${NEW_RELEASE}:AC-2`);
		addLineageEdge(db, `${NEW_RELEASE}:AC-2`, 'nist-r6:PT-1');

		expect(await closureFromConcept(db, 'nist-r6:PT-1', 'superseded_by', SUCCESSOR_WALK_MAX_DEPTH)).toEqual([]);
		// ...and the inverse spelling walks the other way, which is why it has to
		// be a real enum member rather than an implied direction.
		expect(targets(await closureFromConcept(db, 'nist-r6:PT-1', 'supersedes', SUCCESSOR_WALK_MAX_DEPTH))).toEqual([
			[`${NEW_RELEASE}:AC-2`, 1],
			[`${OLD}:AC-2`, 2],
		]);
	});

	// Lineage recorded from the newer end is the SAME assertion. The diagnosis
	// has to agree with the walk, or a vault whose mapping set spells it
	// `supersedes` would be told no successor exists while the walk found one.
	it('recognises lineage stored under the inverse spelling', async () => {
		addConcept(db, `${NEW_RELEASE}:AC-2`, 'AC-2');
		addLineageEdge(db, `${NEW_RELEASE}:AC-2`, `${OLD}:AC-2`, { predicate: 'supersedes' });
		addAttestation(db, 'Evidence/j1.md', `${OLD}:AC-2`);

		expect(await reasonFor(db, 'Evidence/j1.md')).toBe('subject-superseded');
		expect((await listSupersededSubjects(db))[0].successors.map((s) => s.curie)).toEqual([
			`${NEW_RELEASE}:AC-2`,
		]);
	});

	// An explicit denial is not a lead. `NOT superseded_by` states that the
	// object does NOT replace the subject; walking it would manufacture a
	// successor out of the exact assertion that there is none.
	it('never walks an explicitly negated lineage edge', async () => {
		addConcept(db, `${NEW_RELEASE}:PT-9`, 'PT-9');
		addLineageEdge(db, `${OLD}:AC-2`, `${NEW_RELEASE}:PT-9`, { modifier: 'NOT' });
		addAttestation(db, 'Evidence/j1.md', `${OLD}:AC-2`);

		expect(await reasonFor(db, 'Evidence/j1.md')).toBe('subject-not-a-known-concept');
		expect(await listSupersededSubjects(db)).toEqual([]);
		expect(await closureFromConcept(db, `${OLD}:AC-2`, 'superseded_by', SUCCESSOR_WALK_MAX_DEPTH)).toEqual([]);
	});

	it('names a successor that is asserted but not imported here', async () => {
		addConcept(db, `${NEW_RELEASE}:AC-2`, 'AC-2'); // an unrelated concept, so the ontology exists
		addLineageEdge(db, `${OLD}:AR-1`, `${NEW_RELEASE}:PT-3`);
		addAttestation(db, 'Evidence/j1.md', `${OLD}:AR-1`);

		const [row] = await listSupersededSubjects(db);
		expect(row.successors).toEqual([
			{ curie: `${NEW_RELEASE}:PT-3`, depth: 1, title: null, vault_path: null },
		]);
	});

	// The count in the superseded table and the rows in the exclusions table are
	// the same population by construction. This asserts the construction.
	it('derives its rows from the exclusion diagnosis, not a parallel query', async () => {
		addConcept(db, `${NEW_RELEASE}:AC-2`, 'AC-2');
		addLineageEdge(db, `${OLD}:AC-2`, `${NEW_RELEASE}:AC-2`);
		addAttestation(db, 'Evidence/j1.md', `${OLD}:AC-2`);
		addAttestation(db, 'Evidence/j2.md', `${OLD}:AC-2`);

		const excluded = await diagnoseExcludedJunctions(db);
		const supersededRows = excluded.filter((r) => r.reason === 'subject-superseded');
		const [group] = await listSupersededSubjects(db, excluded);
		expect(group.attestation_count).toBe(supersededRows.length);
	});

	// A non-evidence predicate is diagnosed on the predicate, not on lineage:
	// the ladder puts the more actionable problem first, and this pins that
	// lineage did not jump the queue.
	it('does not relabel a junction whose real problem is its predicate', async () => {
		addLineageEdge(db, `${OLD}:AC-2`, `${NEW_RELEASE}:AC-2`);
		db.exec({
			sql: `INSERT INTO junction_notes
			        (vault_path, curie, subject, subject_curie, predicate, object, object_curie,
			         coverage, status, review_date, expires_at, source_hash, modified_at)
			      VALUES ('Evidence/j1.md', 'cwk:j1', '[[x]]', $sc, 'mentions', '[[y]]', NULL,
			              'full', 'approved', NULL, NULL, 'h', '2026-08-28')`,
			bind: { $sc: `${OLD}:AC-2` },
		});
		expect(await reasonFor(db, 'Evidence/j1.md')).toBe('predicate-not-canonical');
		expect(await listSupersededSubjects(db)).toEqual([]);
	});
});

describe('the superseded section of the report', () => {
	const baseInput = {
		ontologyId: NEW_RELEASE,
		summary: {
			ontology_id: NEW_RELEASE,
			total_concepts: 1,
			covered: 0,
			partial: 0,
			uncovered: 1,
			excluded_junctions: 1,
			unbaselined_valid_junctions: 0,
		},
		rows: [],
		excluded: [],
		status: { lastProjectedAt: '2026-08-28T00:00:00Z', mode: 'full' as const, succeeded: true },
		generatedAt: '2026-08-28T00:00:00Z',
	};

	it('names every replacement and marks the ones not imported here', () => {
		const md = renderEvidenceReport({
			...baseInput,
			superseded: [
				{
					subject_curie: 'nist-r4:AR-1',
					attestation_count: 2,
					attestation_paths: ['Evidence/j1.md', 'Evidence/j2.md'],
					successors: [
						{ curie: 'nist-r5:PT-1', title: 'PT-1', vault_path: 'Frameworks/nist-r5/PT-1.md', depth: 1 },
						{ curie: 'nist-r5:PT-3', title: null, vault_path: null, depth: 1 },
					],
				},
			],
		});

		expect(md).toContain('## Links whose control was superseded');
		expect(md).toContain('nist-r4:AR-1');
		expect(md).toContain('[[Frameworks/nist-r5/PT-1.md\\|PT-1 (nist-r5:PT-1)]]');
		expect(md).toContain('not imported in this vault');
		expect(md).toContain('nist-r5:PT-3');
	});

	it('marks a multi-release chain as one, rather than as a direct replacement', () => {
		const md = renderEvidenceReport({
			...baseInput,
			superseded: [
				{
					subject_curie: 'nist-r4:AC-2',
					attestation_count: 1,
					attestation_paths: ['Evidence/j1.md'],
					successors: [
						{ curie: 'nist-r6:PT-1', title: 'PT-1', vault_path: 'Frameworks/nist-r6/PT-1.md', depth: 2 },
					],
				},
			],
		});
		expect(md).toContain('via 2 releases');
		expect(md).not.toContain('(direct)');
	});

	it('never claims Crosswalker moved anything', () => {
		const md = renderEvidenceReport({
			...baseInput,
			superseded: [
				{
					subject_curie: 'nist-r4:AC-2',
					attestation_count: 1,
					attestation_paths: ['Evidence/j1.md'],
					successors: [
						{ curie: 'nist-r5:AC-2', title: 'AC-2', vault_path: 'Frameworks/nist-r5/AC-2.md', depth: 1 },
					],
				},
			],
		});
		expect(md).toContain('it does not move your evidence');
		for (const forbidden of ['re-pointed', 'automatically updated', 'has been moved']) {
			expect(md).not.toContain(forbidden);
		}
	});

	it('renders no section at all when the caller did not query it', () => {
		const md = renderEvidenceReport(baseInput);
		expect(md).not.toContain('Links whose control was superseded');
	});

	it('says so plainly when nothing was superseded', () => {
		const md = renderEvidenceReport({ ...baseInput, superseded: [] });
		expect(md).toContain('No links point at a control that a later release says was replaced.');
	});
});
