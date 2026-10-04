/**
 * ch43-real-release-drift.test.ts — the central Ch 43 claim, measured against a
 * REAL publisher release pair rather than synthetic edits.
 *
 * THE CLAIM UNDER TEST
 *   When a framework release changes a control's meaning, the attestations that
 *   depended on it stop counting as valid and say why -- while attestations
 *   whose subjects did not change, and attestations that predate this feature,
 *   are untouched.
 *
 * WHY REAL DATA
 *   A synthetic edit proves the SQL branch fires. It cannot answer the question
 *   that decides whether anybody will use this: what fraction of a real release
 *   gets flagged, and is the flagged set the set a reviewer would agree with?
 *   Both MITRE ATT&CK Enterprise workbooks (v15.1 and v16.1) are tracked in
 *   `Frameworks/`, so the whole 637-technique survivor population is available
 *   as a corpus. Every count in this file is computed from those two files at
 *   test time, never hard-coded from a prior report -- the numbers ARE the
 *   assertion, and a recount that disagrees is a regression.
 *
 * RIGHTS: ATT&CK content is reproduced under the MITRE terms of use. This file
 * asserts on identifiers, hashes and counts. It never embeds ATT&CK prose.
 *
 * The CSF lineage section uses `recipes/import/crosswalks/nist-csf-2-withdrawal-lineage.csv`,
 * derived from NIST's public-domain CSF 2.0 workbook.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { applyMigrations } from '../src/tier2/migrations';
import {
	computeReviewCid,
	computeConceptCid,
	computeReviewGroupCids,
	normalizeReviewString,
	type ReviewGroupCids,
} from '../src/generation/hash';
import type { Recipe } from '../src/render';
import {
	CANONICAL_EVIDENCE_PREDICATE,
	diagnoseExcludedJunctions,
	evidenceCoverageSummary,
	listSupersededSubjects,
	listUnbaselinedValidJunctions,
} from '../src/tier2/evidence-coverage';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// Corpus loading — mirrors src/import/parsers/xlsx-parser.ts exactly, so the
// row a test hashes is byte-identical to the row the plugin would hash.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');
const V15 = path.join(ROOT, 'Frameworks', 'enterprise-attack-v15.1.xlsx');
const V16 = path.join(ROOT, 'Frameworks', 'enterprise-attack-v16.1.xlsx');
const LINEAGE_CSV = path.join(ROOT, 'recipes', 'import', 'crosswalks', 'nist-csf-2-withdrawal-lineage.csv');
const ATTACK_RECIPE = JSON.parse(
	readFileSync(path.join(ROOT, 'recipes', 'import', 'mitre-attack-technique.json'), 'utf8'),
) as Recipe;

const CORPUS_PRESENT = existsSync(V15) && existsSync(V16);
const describeCorpus = CORPUS_PRESENT ? describe : describe.skip;

const normKey = (key: string): string => key.replace(/\s+/g, ' ').trim();

function loadSheet(file: string, sheet: string): Record<string, string>[] {
	const workbook = XLSX.read(readFileSync(file), { type: 'buffer' });
	const worksheet = workbook.Sheets[sheet];
	if (!worksheet) throw new Error(`sheet "${sheet}" missing in ${path.basename(file)}`);
	const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
		range: 0, defval: '', blankrows: false, raw: false,
	});
	return raw.map((record) => {
		const row: Record<string, string> = {};
		for (const [key, value] of Object.entries(record)) {
			row[normKey(key)] = value === null || value === undefined ? '' : String(value).trim();
		}
		return row;
	});
}

const ONTOLOGY = 'mitre-attack';
const curieOf = (row: Record<string, string>): string => `${ONTOLOGY}:${row['ID']}`;
/** The exact call the generation engine makes: whole raw source row as scope. */
const reviewCidOf = (row: Record<string, string>): string =>
	computeReviewCid({ curie: curieOf(row), scope: row });
const reviewGroupsOf = (row: Record<string, string>): ReviewGroupCids =>
	computeReviewGroupCids({ curie: curieOf(row), scope: row }, ATTACK_RECIPE);

// ---------------------------------------------------------------------------
// Tier 2 harness — same in-memory shape the other Tier 2 suites use.
// ---------------------------------------------------------------------------

interface ExecOptions { sql: string; bind?: Record<string, unknown>; rowMode?: 'array'; returnValue?: 'resultRows' }
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

function addOntology(db: TestDb, id: string): void {
	db.exec({
		sql: `INSERT OR IGNORE INTO ontologies (id, name, base_path, recipe_id, imported_at)
		      VALUES ($id, $id, 'Frameworks', 'mitre-attack-technique-flat', '2026-08-28')`,
		bind: { $id: id },
	});
}

/** Import (or re-import) one technique as a concept carrying its review_cid. */
function upsertConcept(
	db: TestDb,
	curie: string,
	reviewCid: string | null,
	title: string,
	ontology = ONTOLOGY,
	reviewGroups: ReviewGroupCids | null = null,
): void {
	addOntology(db, ontology);
	db.exec({
		sql: `INSERT OR REPLACE INTO concepts
		        (ontology_id, curie, vault_path, source_hash, title, review_cid,
		         review_wording_cid, review_scope_cid, review_housekeeping_cid,
		         status, imported_at, modified_at)
		      VALUES ($o, $c, $p, 'h', $t, $rc, $rw, $rs, $rh,
		              'active', '2026-08-28', '2026-08-28')`,
		bind: {
			$o: ontology,
			$c: curie,
			$p: `Frameworks/ATTACK/${title}.md`,
			$t: title,
			$rc: reviewCid,
			$rw: reviewGroups?.wording ?? null,
			$rs: reviewGroups?.scope ?? null,
			$rh: reviewGroups?.housekeeping ?? null,
		},
	});
}

/**
 * One approved attestation. `baselineCid === null` is the pre-feature vault:
 * a link written before `reviewed_against` existed, which must be untouched.
 */
function addAttestation(
	db: TestDb,
	notePath: string,
	subjectCurie: string,
	baselineCid: string | null,
	baselineGroups: ReviewGroupCids | null = null,
): void {
	db.exec({
		sql: `INSERT OR REPLACE INTO junction_notes
		        (vault_path, curie, subject, subject_curie, predicate, object, object_curie,
		         coverage, status, review_date, expires_at, reviewed_against_curie, reviewed_against_cid,
		         reviewed_wording_cid, reviewed_scope_cid, reviewed_housekeeping_cid,
		         source_hash, modified_at)
		      VALUES ($path, $curie, $subject, $sc, $pred, '[[Evidence/EDR-Runbook]]', NULL,
		              'full', 'approved', NULL, NULL, $rac, $racid, $rw, $rs, $rh,
		              'h', '2026-08-28')`,
		bind: {
			$path: notePath,
			$curie: `cwk:${notePath}`,
			$subject: `[[${subjectCurie}]]`,
			$sc: subjectCurie,
			$pred: CANONICAL_EVIDENCE_PREDICATE,
			$rac: baselineCid === null ? null : subjectCurie,
			$racid: baselineCid,
			$rw: baselineGroups?.wording ?? null,
			$rs: baselineGroups?.scope ?? null,
			$rh: baselineGroups?.housekeeping ?? null,
		},
	});
}

function viewRow(db: TestDb, notePath: string): { freshness: string; subject_baseline: string } {
	const rows = db.exec({
		sql: `SELECT freshness, subject_baseline FROM junction_notes_with_freshness WHERE vault_path = $p`,
		bind: { $p: notePath }, rowMode: 'array', returnValue: 'resultRows',
	}) as unknown[][];
	expect(rows).toHaveLength(1);
	return { freshness: String(rows[0][0]), subject_baseline: String(rows[0][1]) };
}

const notePathFor = (id: string): string => `Evidence/Junctions/jn-${id}.md`;

// ---------------------------------------------------------------------------

describeCorpus('Ch 43 central claim, measured on MITRE ATT&CK Enterprise 15.1 -> 16.1', () => {
	let oldRows: Record<string, string>[];
	let newById: Map<string, Record<string, string>>;
	let survivors: Record<string, string>[];
	/** Survivor IDs whose review_cid moved across the release. */
	let flagged: string[];
	/** Survivor IDs whose review_cid is identical across the release. */
	let unflagged: string[];

	beforeAll(() => {
		oldRows = loadSheet(V15, 'techniques');
		const newRows = loadSheet(V16, 'techniques');
		newById = new Map(newRows.map((row) => [row['ID'], row]));
		survivors = oldRows.filter((row) => newById.has(row['ID']));
		flagged = [];
		unflagged = [];
		for (const row of survivors) {
			const next = newById.get(row['ID'])!;
			(reviewCidOf(row) === reviewCidOf(next) ? unflagged : flagged).push(row['ID']);
		}
	});

	// -----------------------------------------------------------------
	// 0. The corpus is what the evidence brief said it is.
	// -----------------------------------------------------------------

	it('R0: the release pair is fully additive — every 15.1 technique ID survives into 16.1', () => {
		// If this ever fails, the corpus changed and every count below is about
		// a different population. It is the first assertion on purpose.
		expect(oldRows.length).toBe(637);
		expect(survivors.length).toBe(637);
		expect(newById.size).toBe(656);
		expect(flagged.length + unflagged.length).toBe(637);
	});

	// -----------------------------------------------------------------
	// 1 + 2. Changed subjects flag. Unchanged subjects do not.
	// -----------------------------------------------------------------

	it('R1: a whole real release, attested and then re-imported, partitions exactly once', async () => {
		const db = createTestDb();
		try {
			await applyMigrations(db as any);

			// Import 15.1 and attest EVERY surviving technique, approved, with a
			// baseline recorded at approval -- the state a diligent team is in.
			for (const row of survivors) {
				upsertConcept(db, curieOf(row), reviewCidOf(row), row['ID'], ONTOLOGY, reviewGroupsOf(row));
				addAttestation(db, notePathFor(row['ID']), curieOf(row), reviewCidOf(row), reviewGroupsOf(row));
			}

			const before = await evidenceCoverageSummary(db, ONTOLOGY);
			expect(before.total_concepts).toBe(637);
			expect(before.covered).toBe(637);
			expect(before.excluded_junctions).toBe(0);
			expect(before.unbaselined_valid_junctions).toBe(0);

			// Re-import 16.1 over the same identities. Nothing else changes: not
			// the attestations, not the reviewers, not the dates.
			for (const row of survivors) {
				const next = newById.get(row['ID'])!;
				upsertConcept(db, curieOf(next), reviewCidOf(next), next['ID'], ONTOLOGY, reviewGroupsOf(next));
			}

			const after = await evidenceCoverageSummary(db, ONTOLOGY);
			// The partition is total and disjoint: every attestation either still
			// counts or is excluded for exactly one reason.
			expect(after.covered).toBe(unflagged.length);
			expect(after.uncovered).toBe(flagged.length);
			expect(after.excluded_junctions).toBe(flagged.length);
			expect(after.covered + after.uncovered).toBe(637);

			const reasons = await diagnoseExcludedJunctions(db);
			expect(reasons).toHaveLength(flagged.length);
			expect(new Set(reasons.map((row) => row.reason))).toEqual(new Set(['subject-changed']));
			const kindCounts = { wording: 0, scope: 0, housekeeping: 0 };
			for (const row of reasons) {
				expect(row.subject_baseline).toBe('changed');
				expect(row.change_kind).not.toBeNull();
				kindCounts[row.change_kind as keyof typeof kindCounts] += 1;
			}
			expect(kindCounts).toEqual({ wording: 57, scope: 110, housekeeping: 260 });
			expect(Object.values(kindCounts).reduce((sum, count) => sum + count, 0)).toBe(flagged.length);
			// It says WHICH ones, not just how many.
			expect(new Set(reasons.map((row) => row.vault_path)))
				.toEqual(new Set(flagged.map(notePathFor)));

			// And no counted link silently lost its baseline in the process.
			expect(after.unbaselined_valid_junctions).toBe(0);
		} finally { db.close(); }
	});

	it('R2: the named material rewrites from the release-diff evidence all flag', () => {
		// T1496 / T1558 are the two largest description rewrites under a stable
		// ID; T1001.003 is the release's only stable-ID rename.
		for (const id of ['T1496', 'T1558', 'T1001.003']) {
			const before = oldRows.find((row) => row['ID'] === id)!;
			const after = newById.get(id)!;
			expect(normalizeReviewString(before['description']))
				.not.toBe(normalizeReviewString(after['description']));
			expect(flagged).toContain(id);
		}
		// The rename is a NAME change, and the name is part of what was read.
		expect(oldRows.find((r) => r['ID'] === 'T1001.003')!['name'])
			.not.toBe(newById.get('T1001.003')!['name']);
	});

	it('R3: subjects whose source row did not move are untouched, and stay counted', async () => {
		const db = createTestDb();
		try {
			await applyMigrations(db as any);
			// A control group drawn from the corpus, not chosen by hand.
			const sample = unflagged.slice(0, 25);
			expect(sample.length).toBe(25);
			for (const id of sample) {
				const row = oldRows.find((r) => r['ID'] === id)!;
				upsertConcept(db, curieOf(row), reviewCidOf(row), id);
				addAttestation(db, notePathFor(id), curieOf(row), reviewCidOf(row));
			}
			for (const id of sample) {
				const next = newById.get(id)!;
				upsertConcept(db, curieOf(next), reviewCidOf(next), id);
			}
			for (const id of sample) {
				// `not-set`, not `fresh`: these links carry no review_date and no
				// expiry, which is the ordinary shape. What matters is that the
				// baseline MATCHES and the link still counts -- the ladder puts
				// `not-set` BELOW `subject-changed` precisely so this population
				// is not exempt from content invalidation.
				expect(viewRow(db, notePathFor(id))).toEqual({ freshness: 'not-set', subject_baseline: 'match' });
			}
			expect(await diagnoseExcludedJunctions(db)).toEqual([]);
			expect((await evidenceCoverageSummary(db, ONTOLOGY)).covered).toBe(25);
		} finally { db.close(); }
	});

	// -----------------------------------------------------------------
	// 3. The cosmetic case.
	// -----------------------------------------------------------------

	it('R4: real citation churn is folded away and does NOT flag', async () => {
		// T1548.001's `relationship citations` cell changed outright between
		// releases -- a different citation set, same length by coincidence.
		// Normalization step 2 deletes `(Citation: ...)` spans, so the row folds
		// to the same fingerprint and the attestation survives untouched. This
		// is the whole reason `review_cid` is a second, tolerant hash: the
		// IDENTITY hash `concept_cid` does move on exactly this row.
		const before = oldRows.find((row) => row['ID'] === 'T1548.001')!;
		const after = newById.get('T1548.001')!;
		expect(before['relationship citations']).not.toBe(after['relationship citations']);
		expect(computeConceptCid({ curie: curieOf(before), scope: before }))
			.not.toBe(computeConceptCid({ curie: curieOf(after), scope: after }));
		expect(reviewCidOf(before)).toBe(reviewCidOf(after));

		const db = createTestDb();
		try {
			await applyMigrations(db as any);
			upsertConcept(db, curieOf(before), reviewCidOf(before), 'T1548.001');
			addAttestation(db, notePathFor('T1548.001'), curieOf(before), reviewCidOf(before));
			upsertConcept(db, curieOf(after), reviewCidOf(after), 'T1548.001');
			expect(viewRow(db, notePathFor('T1548.001')))
				.toEqual({ freshness: 'not-set', subject_baseline: 'match' });
			expect(await diagnoseExcludedJunctions(db)).toEqual([]);
		} finally { db.close(); }
	});

	it('R5: normalization measurably earns its keep on this pair', () => {
		// Raw whole-row equality vs normalized whole-row equality, both computed
		// here. Recorded as a floor, not an exact figure, so the test survives a
		// corpus refresh while still failing if normalization stops working.
		let rawIdentical = 0;
		for (const row of survivors) {
			const next = newById.get(row['ID'])!;
			const keys = new Set([...Object.keys(row), ...Object.keys(next)]);
			if ([...keys].every((k) => (row[k] ?? '') === (next[k] ?? ''))) rawIdentical += 1;
		}
		expect(rawIdentical).toBe(94);
		expect(unflagged.length).toBe(210);
		// 116 rows survive re-review only because of normalization.
		expect(unflagged.length - rawIdentical).toBe(116);
	});

	it('R6: HONEST LIMIT — a cosmetic description edit still flags when bookkeeping columns moved', () => {
		// This is the measured limit of whole-row scope, pinned so it cannot be
		// discovered later as a surprise. T1574.001 and T1055.015 are the only
		// two techniques in the pair whose description drift is purely cosmetic
		// (it folds under normalization). Both still flag, because `version` and
		// `last modified` are in the hashed row.
		//
		// NOT a bug in normalization: it is fork F4 (scope is the whole row)
		// meeting a publisher that stamps a timestamp on every touched row. The
		// named extension point is a recipe-declared `review_scope` field list.
		for (const id of ['T1574.001', 'T1055.015']) {
			const before = oldRows.find((row) => row['ID'] === id)!;
			const after = newById.get(id)!;
			expect(before['description']).not.toBe(after['description']);
			expect(normalizeReviewString(before['description']))
				.toBe(normalizeReviewString(after['description']));
			expect(flagged).toContain(id);
		}
	});

	it('R7: recipe declarations split every real flag once, with wording matching description drift', () => {
		const counts = { wording: 0, scope: 0, housekeeping: 0 };
		let descriptionMoved = 0;
		for (const id of flagged) {
			const before = oldRows.find((row) => row['ID'] === id)!;
			const after = newById.get(id)!;
			const oldGroups = reviewGroupsOf(before);
			const newGroups = reviewGroupsOf(after);
			const kind = oldGroups.wording !== newGroups.wording ? 'wording'
				: oldGroups.scope !== newGroups.scope ? 'scope'
					: 'housekeeping';
			counts[kind] += 1;
			if (normalizeReviewString(before['description'] ?? '')
				!== normalizeReviewString(after['description'] ?? '')) descriptionMoved += 1;
		}
		expect(flagged.length).toBe(427);
		expect(counts).toEqual({ wording: 57, scope: 110, housekeeping: 260 });
		expect(descriptionMoved).toBe(57);
		expect(counts.wording + counts.scope + counts.housekeeping).toBe(flagged.length);
	});

	// -----------------------------------------------------------------
	// 4. The backward-compatible case.
	// -----------------------------------------------------------------

	it('R8: attestations with no recorded fingerprint are unaffected by the release', async () => {
		const db = createTestDb();
		try {
			await applyMigrations(db as any);
			// One materially-rewritten subject and one untouched subject, each
			// attested WITHOUT a baseline -- every link in every existing vault.
			const material = oldRows.find((row) => row['ID'] === 'T1496')!;
			const steady = oldRows.find((row) => row['ID'] === unflagged[0])!;
			for (const row of [material, steady]) {
				upsertConcept(db, curieOf(row), reviewCidOf(row), row['ID']);
				addAttestation(db, notePathFor(row['ID']), curieOf(row), null);
			}
			const before = await evidenceCoverageSummary(db, ONTOLOGY);
			expect(before.covered).toBe(2);
			expect(before.unbaselined_valid_junctions).toBe(2);

			for (const row of [material, steady]) {
				const next = newById.get(row['ID'])!;
				upsertConcept(db, curieOf(next), reviewCidOf(next), next['ID']);
			}

			// The subject the reviewer read was rewritten. We cannot tell, we do
			// not pretend to, and we do not invalidate anything.
			for (const row of [material, steady]) {
				expect(viewRow(db, notePathFor(row['ID'])))
					.toEqual({ freshness: 'not-set', subject_baseline: 'unrecorded' });
			}
			const after = await evidenceCoverageSummary(db, ONTOLOGY);
			expect(after.covered).toBe(2);
			expect(after.excluded_junctions).toBe(0);
			expect(await diagnoseExcludedJunctions(db)).toEqual([]);
			// Counted, and named. Both halves matter: silence here would make the
			// exemption invisible and permanent.
			expect(after.unbaselined_valid_junctions).toBe(2);
			expect((await listUnbaselinedValidJunctions(db)).map((row) => row.baseline))
				.toEqual(['unrecorded', 'unrecorded']);
		} finally { db.close(); }
	});

	it('R9: a pre-feature link and a baselined link coexist in one vault without interfering', async () => {
		// The realistic mid-migration vault: some links re-approved under the new
		// UI, most not. The two populations must not contaminate each other.
		const db = createTestDb();
		try {
			await applyMigrations(db as any);
			const material = oldRows.find((row) => row['ID'] === 'T1496')!;
			upsertConcept(db, curieOf(material), reviewCidOf(material), 'T1496');
			addAttestation(db, 'Evidence/Junctions/baselined.md', curieOf(material), reviewCidOf(material));
			addAttestation(db, 'Evidence/Junctions/pre-feature.md', curieOf(material), null);

			const next = newById.get('T1496')!;
			upsertConcept(db, curieOf(next), reviewCidOf(next), 'T1496');

			expect(viewRow(db, 'Evidence/Junctions/baselined.md'))
				.toEqual({ freshness: 'subject-changed', subject_baseline: 'changed' });
			expect(viewRow(db, 'Evidence/Junctions/pre-feature.md'))
				.toEqual({ freshness: 'not-set', subject_baseline: 'unrecorded' });
			const summary = await evidenceCoverageSummary(db, ONTOLOGY);
			expect(summary.excluded_junctions).toBe(1);
			expect(summary.unbaselined_valid_junctions).toBe(1);
			// One concept, still covered, because one valid link remains.
			expect(summary.covered).toBe(1);
		} finally { db.close(); }
	});

	it('R10: re-approving against the new release restores the count', async () => {
		// The claim says a flag is a call to act, not a permanent downgrade.
		const db = createTestDb();
		try {
			await applyMigrations(db as any);
			const before = oldRows.find((row) => row['ID'] === 'T1558')!;
			const after = newById.get('T1558')!;
			upsertConcept(db, curieOf(before), reviewCidOf(before), 'T1558');
			addAttestation(db, notePathFor('T1558'), curieOf(before), reviewCidOf(before));
			upsertConcept(db, curieOf(after), reviewCidOf(after), 'T1558');
			expect(viewRow(db, notePathFor('T1558')).freshness).toBe('subject-changed');

			// The reviewer reads the new text and re-approves: the modal restamps
			// `reviewed_against` from the control's current fingerprint.
			addAttestation(db, notePathFor('T1558'), curieOf(after), reviewCidOf(after));
			expect(viewRow(db, notePathFor('T1558')))
				.toEqual({ freshness: 'not-set', subject_baseline: 'match' });
			expect((await evidenceCoverageSummary(db, ONTOLOGY)).covered).toBe(1);
		} finally { db.close(); }
	});
});

// ---------------------------------------------------------------------------
// 5. Split lineage and the honest orphan, on real NIST CSF withdrawal records.
// ---------------------------------------------------------------------------

describe('release lineage on real NIST CSF 1.1 -> 2.0 withdrawal records', () => {
	interface LineageRow { subject: string; object: string }

	function loadLineage(): LineageRow[] {
		const text = readFileSync(LINEAGE_CSV, 'utf8');
		const rows: LineageRow[] = [];
		for (const line of text.split(/\r?\n/).slice(1)) {
			// The middle column is quoted publisher prose; take first and last.
			const first = line.indexOf(',');
			const last = line.lastIndexOf(',');
			if (first < 0 || last <= first) continue;
			const curie = line.slice(0, first).trim();
			const successor = line.slice(last + 1).trim();
			if (!curie || !successor) continue;
			// `nist-csf-1-1-id-sc-01--nist-csf-2-gv-rm-05` -> old id `ID.SC-01`.
			const oldSlug = curie.replace(/^nist-csf-1-1-/, '').split('--')[0];
			rows.push({ subject: `nist-csf-1-1:${oldSlug}`, object: `nist-csf-2:${successor}` });
		}
		return rows;
	}

	function addLineageEdge(db: TestDb, subject: string, object: string): void {
		db.exec({
			sql: `INSERT OR REPLACE INTO mappings
			        (mapping_set_id, subject_id, predicate_id, predicate_modifier, object_id,
			         mapping_justification, mapping_provider, source_path, source_hash)
			      VALUES ('https://crosswalker.dev/lineage/nist-csf/1-1-to-2-0', $s, 'superseded_by', '', $o,
			              'semapv:ManualMappingCuration', 'NIST', $path, 'h')`,
			bind: { $s: subject, $o: object, $path: `Crosswalks/${subject}-${object}.md` },
		});
	}

	function addCsfConcept(db: TestDb, curie: string): void {
		db.exec({
			sql: `INSERT OR IGNORE INTO ontologies (id, name, base_path, recipe_id, imported_at)
			      VALUES ('nist-csf-2', 'nist-csf-2', 'Frameworks', 'nist-csf-2', '2026-08-28')`,
		});
		db.exec({
			sql: `INSERT OR REPLACE INTO concepts (ontology_id, curie, vault_path, source_hash, title, status, imported_at, modified_at)
			      VALUES ('nist-csf-2', $c, $p, 'h', $c, 'active', '2026-08-28', '2026-08-28')`,
			bind: { $c: curie, $p: `Frameworks/CSF2/${curie.split(':')[1]}.md` },
		});
	}

	it('R11: a real one-to-many split names every successor, and does not multiply the link', async () => {
		const lineage = loadLineage();
		// ID.SC-01 is NIST's own five-way split, verbatim from the CSF 2.0 workbook.
		const split = lineage.filter((row) => row.subject === 'nist-csf-1-1:id-sc-01');
		expect(split).toHaveLength(5);

		const db = createTestDb();
		try {
			await applyMigrations(db as any);
			for (const edge of split) { addLineageEdge(db, edge.subject, edge.object); addCsfConcept(db, edge.object); }
			// One attestation, against the withdrawn 1.1 control. The 2.0 import
			// left it orphaned: that is the structural-transition regime.
			db.exec({
				sql: `INSERT INTO junction_notes
				        (vault_path, curie, subject, subject_curie, predicate, object, object_curie,
				         coverage, status, review_date, expires_at, source_hash, modified_at)
				      VALUES ('Evidence/Junctions/jn-id-sc-01.md', 'cwk:jn-id-sc-01', '[[ID.SC-01]]',
				              'nist-csf-1-1:id-sc-01', $pred, '[[Evidence/Supplier-Policy]]', NULL,
				              'full', 'approved', NULL, NULL, 'h', '2026-08-28')`,
				bind: { $pred: CANONICAL_EVIDENCE_PREDICATE },
			});

			const excluded = await diagnoseExcludedJunctions(db);
			expect(excluded).toHaveLength(1);
			expect(excluded[0].reason).toBe('subject-superseded');

			const superseded = await listSupersededSubjects(db, excluded);
			expect(superseded).toHaveLength(1);
			expect(superseded[0].subject_curie).toBe('nist-csf-1-1:id-sc-01');
			// The attestation is counted ONCE despite five lineage edges.
			expect(superseded[0].attestation_count).toBe(1);
			expect(superseded[0].successors.map((s) => s.curie).sort()).toEqual([
				'nist-csf-2:GV.RM-05', 'nist-csf-2:GV.SC-01', 'nist-csf-2:GV.SC-06',
				'nist-csf-2:GV.SC-09', 'nist-csf-2:GV.SC-10',
			]);
			for (const successor of superseded[0].successors) {
				expect(successor.depth).toBe(1);
				expect(successor.vault_path).not.toBeNull();
			}
		} finally { db.close(); }
	});

	it('R12: a real many-to-one merge keeps the old controls as separate decisions', async () => {
		const lineage = loadLineage();
		// NIST folded several 1.1 awareness subcategories into one 2.0 successor.
		const byObject = new Map<string, string[]>();
		for (const row of lineage) {
			byObject.set(row.object, [...(byObject.get(row.object) ?? []), row.subject]);
		}
		const merged = [...byObject.entries()].filter(([, subjects]) => subjects.length > 1);
		expect(merged.length).toBeGreaterThan(0);
		const [target, subjects] = merged.sort((a, b) => b[1].length - a[1].length)[0];

		const db = createTestDb();
		try {
			await applyMigrations(db as any);
			addCsfConcept(db, target);
			for (const subject of subjects) addLineageEdge(db, subject, target);
			subjects.forEach((subject, index) => {
				db.exec({
					sql: `INSERT INTO junction_notes
					        (vault_path, curie, subject, subject_curie, predicate, object, object_curie,
					         coverage, status, review_date, expires_at, source_hash, modified_at)
					      VALUES ($p, $c, $s, $sc, $pred, '[[Evidence/Training-Records]]', NULL,
					              'full', 'approved', NULL, NULL, 'h', '2026-08-28')`,
					bind: {
						$p: `Evidence/Junctions/merge-${index}.md`, $c: `cwk:merge-${index}`,
						$s: `[[${subject}]]`, $sc: subject, $pred: CANONICAL_EVIDENCE_PREDICATE,
					},
				});
			});

			const superseded = await listSupersededSubjects(db, await diagnoseExcludedJunctions(db));
			// One row per OLD control, not one row for the shared successor: each
			// carries its own attestation and its own re-review decision.
			expect(superseded).toHaveLength(subjects.length);
			expect(new Set(superseded.map((row) => row.subject_curie))).toEqual(new Set(subjects));
			for (const row of superseded) {
				expect(row.successors.map((s) => s.curie)).toEqual([target]);
			}
		} finally { db.close(); }
	});

	it('R13: an orphan with no lineage edge says so rather than inventing a successor', async () => {
		const db = createTestDb();
		try {
			await applyMigrations(db as any);
			addCsfConcept(db, 'nist-csf-2:GV.OC-01');
			db.exec({
				sql: `INSERT INTO junction_notes
				        (vault_path, curie, subject, subject_curie, predicate, object, object_curie,
				         coverage, status, review_date, expires_at, source_hash, modified_at)
				      VALUES ('Evidence/Junctions/orphan.md', 'cwk:orphan', '[[ID.BE-99]]',
				              'nist-csf-1-1:id-be-99', $pred, '[[Evidence/Doc]]', NULL,
				              'full', 'approved', NULL, NULL, 'h', '2026-08-28')`,
				bind: { $pred: CANONICAL_EVIDENCE_PREDICATE },
			});
			const excluded = await diagnoseExcludedJunctions(db);
			expect(excluded).toHaveLength(1);
			// Not `subject-superseded`: nothing in the vault says it was replaced.
			expect(excluded[0].reason).toBe('subject-not-a-known-concept');
			expect(await listSupersededSubjects(db, excluded)).toEqual([]);
		} finally { db.close(); }
	});
});
