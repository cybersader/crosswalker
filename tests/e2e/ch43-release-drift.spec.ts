/**
 * ch43-release-drift.spec.ts — the Ch 43 central claim, end to end, in real
 * Obsidian, against a real publisher release pair.
 *
 * WHAT THIS PROVES THAT THE JEST SUITE CANNOT
 *   `tests/ch43-real-release-drift.test.ts` measures the same claim over the
 *   whole 637-technique population, but it inserts Tier 2 rows directly. It
 *   therefore assumes the two ends of the chain rather than exercising them:
 *   that the GENERATION ENGINE stamps `_crosswalker.review_cid` into a note it
 *   writes, that it stamps `reviewed_against` onto an approved attestation from
 *   the subject's own fingerprint, and that the PROJECTOR reads both back out
 *   of real frontmatter.
 *
 *   This spec runs the actual chain: real recipe -> real `runImportFromRecipe`
 *   -> real files on disk -> real metadata cache -> real `runProjection()` ->
 *   real `junction_notes_with_freshness`. Then it RE-IMPORTS the 16.1 rows over
 *   the same identities and re-projects, which is the operation the whole
 *   feature exists to survive.
 *
 *   Both approved-link authoring paths are covered: the evidence-link modal and
 *   ordinary recipe generation. Each must stamp canonical Tier 1 provenance and
 *   a complete review baseline before the projector can classify release drift.
 *
 * RIGHTS: ATT&CK content is reproduced under the MITRE terms of use. Only a
 * handful of techniques are imported and no prose is asserted on.
 *
 * Run:
 *   DISPLAY=:0 bun run e2e -- --spec tests/e2e/ch43-release-drift.spec.ts
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { buildEvidenceLink } from '../../src/views/evidence-link';
import { readFrontmatterFromDisk, requireFrontmatterIndexed } from './helpers/vault-readiness';

const ROOT = path.resolve(__dirname, '..', '..');
const V15 = path.join(ROOT, 'Frameworks', 'enterprise-attack-v15.1.xlsx');
const V16 = path.join(ROOT, 'Frameworks', 'enterprise-attack-v16.1.xlsx');
const RECIPE = JSON.parse(
	readFileSync(path.join(ROOT, 'recipes', 'import', 'mitre-attack-technique.json'), 'utf8'),
);

const DESTINATION = 'Frameworks/ch43-attack';
const JUNCTIONS = 'Evidence/ch43';
const MODAL_FOLDER = 'Evidence/ch43-modal';

/**
 * The scenario set. Every classification here was MEASURED from the two
 * workbooks, not chosen by hand:
 *   material     — body-projected description changed: wording
 *   rename       — name and description both changed: wording wins
 *   steady       — the normalized whole source row is unchanged
 *   cosmetic     — only removed citation text changed: unchanged
 *   managed      — publisher version moved and the recipe manages it: scope
 *   housekeeping — only source fields outside body/managed declarations moved
 */
const SCENARIOS = [
	{ id: 'T1496', kind: 'material', expectFlag: true, changeKind: 'wording' },
	{ id: 'T1558', kind: 'material', expectFlag: true, changeKind: 'wording' },
	{ id: 'T1001.003', kind: 'rename', expectFlag: true, changeKind: 'wording' },
	{ id: 'T1574.001', kind: 'managed', expectFlag: true, changeKind: 'scope' },
	{ id: 'T1548.002', kind: 'housekeeping', expectFlag: true, changeKind: 'housekeeping' },
	{ id: 'T1134.003', kind: 'housekeeping', expectFlag: true, changeKind: 'housekeeping' },
	{ id: 'T1548.004', kind: 'steady', expectFlag: false, changeKind: null },
	{ id: 'T1650', kind: 'steady', expectFlag: false, changeKind: null },
	{ id: 'T1595', kind: 'steady', expectFlag: false, changeKind: null },
	{ id: 'T1548.001', kind: 'cosmetic', expectFlag: false, changeKind: null },
] as const;

/** Attested with no baseline — the pre-feature vault. Materially rewritten. */
const NO_BASELINE_ID = 'T1496';

/**
 * A junction recipe that goes through the ORDINARY generation path, so the
 * engine's own approval stamping (generation-engine.ts, `resolveSubjectReviewCid`)
 * writes `reviewed_against` from the control's `_crosswalker.review_cid`. The
 * spec never computes a fingerprint itself.
 */
const JUNCTION_RECIPE = {
	$schema: 'https://crosswalker.dev/spec/recipe.schema.json',
	recipe: 'ch43-evidence-junctions',
	spec_version: 'https://crosswalker.dev/spec/recipe.schema.json',
	source: { ontology: 'ch43-evidence', levels: ['evidence'] },
	target: {
		layout: [{
			level: 'evidence',
			mechanism: 'file',
			template: '{link_id|fs-safe}.md',
			kind: 'junction-note',
		}],
		also_emit: {
			frontmatter: {
				managed: {
					title: '{link_id}',
					subject: '[[{subject_path}]]',
					subject_curie: '{subject_curie}',
					predicate: 'has_evidence',
					object: '[[Evidence/EDR-Runbook]]',
					coverage: 'full',
					reviewer: 'control-owner',
					review_date: '2026-08-01T00:00:00Z',
					status: '{status}',
				},
			},
		},
	},
};

const normKey = (key: string): string => key.replace(/\s+/g, ' ').trim();

function loadTechniques(file: string): Record<string, string>[] {
	const workbook = XLSX.read(readFileSync(file), { type: 'buffer' });
	const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets['techniques'], {
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

function subset(rows: Record<string, string>[]): { columns: string[]; rows: Record<string, string>[] } {
	const wanted = new Set<string>(SCENARIOS.map((s) => s.id));
	const picked = rows.filter((row) => wanted.has(row['ID']));
	const columns: string[] = [];
	const seen = new Set<string>();
	// Column order comes from the FULL sheet, not the subset, so both import
	// passes present identically-shaped rows.
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (!seen.has(key)) { seen.add(key); columns.push(key); }
		}
	}
	return { columns, rows: picked };
}

async function runRecipe(
	columns: string[],
	rows: Record<string, string>[],
	recipe: unknown,
	destination: string,
	sourceFileName: string,
	/**
	 * AM-16. The ownership decision, named explicitly on any call that writes
	 * over identities an earlier call already minted. Since AM-9 the engine no
	 * longer adopts a set it happens to find in the destination, so omitting this
	 * on a re-import asks for a NEW set, which AM-12 then correctly refuses row
	 * by row as a cross-set collision. This is the E2E stand-in for the ownership
	 * click a person makes in the wizard. Omitted on a first import, which
	 * genuinely is a new set.
	 */
	importSet?: { id: string },
): Promise<any> {
	return browser.executeObsidian(async ({ app }, args) => {
		// @ts-expect-error — Crosswalker E2E API
		const plugin = app.plugins.plugins['crosswalker'];
		return plugin.runImportFromRecipe(
			{
				columns: args.columns,
				rows: args.rows,
				rowCount: args.rows.length,
				source: { type: 'xlsx' },
				headerRow: 0,
			},
			args.recipe,
			{
				basePath: args.destination,
				overwriteMode: 'replace',
				createFolders: true,
				strictValidation: true,
				sourceFileName: args.sourceFileName,
				...(args.importSet ? { importSet: args.importSet } : {}),
			},
		);
	}, { columns, rows, recipe, destination, sourceFileName, importSet });
}

async function importRelease(
	rows: Record<string, string>[],
	sourceFileName: string,
	importSet?: { id: string },
): Promise<any> {
	const { columns, rows: picked } = subset(rows);
	return runRecipe(columns, picked, RECIPE, DESTINATION, sourceFileName, importSet);
}

/**
 * AM-16. The import set the 15.1 import minted, read off a note it generated.
 * The note on disk is where ownership is actually recorded, and it is read from
 * the file's own bytes rather than the metadata cache, which may not have
 * indexed a just-written note yet.
 */
async function ownedImportSet(): Promise<{ id: string }> {
	const fm = await readFrontmatterFromDisk(`${DESTINATION}/${SCENARIOS[0].id}.md`) as Record<string, any> | null;
	const id = fm?._crosswalker?.import_set?.id;
	if (typeof id !== 'string') throw new Error('the 15.1 import stamped no import set id');
	return { id };
}

/** Projection result plus every junction's freshness, keyed by note path. */
async function project(): Promise<{
	counts: Record<string, number>;
	rows: Record<string, { freshness: string; baseline: string; changeKind: string | null }>;
}> {
	return browser.executeObsidian(async ({ app }) => {
		// @ts-expect-error — Crosswalker E2E API
		const plugin = app.plugins.plugins['crosswalker'];
		const result = await plugin.runProjection();
		const handle = await plugin.openTier2();
		const rows = handle.db.exec({
			sql: 'SELECT vault_path, freshness, subject_baseline, change_kind FROM junction_notes_with_freshness ORDER BY vault_path',
			rowMode: 'array',
			returnValue: 'resultRows',
		}) as unknown[][];
		const out: Record<string, { freshness: string; baseline: string; changeKind: string | null }> = {};
		for (const row of rows) {
			out[String(row[0])] = {
				freshness: String(row[1]),
				baseline: String(row[2]),
				changeKind: row[3] === null ? null : String(row[3]),
			};
		}
		return { counts: result.counts, rows: out };
	});
}

async function junctionState(paths: string[]): Promise<Record<string, {
	status: string | null;
	reviewer: string | null;
	reviewDate: string | null;
	coverage: string | null;
	baselineCid: string | null;
	subjectBaseline: string;
	changeKind: string | null;
}>> {
	return browser.executeObsidian(async ({ app }, selectedPaths) => {
		// @ts-expect-error — Crosswalker E2E API
		const plugin = app.plugins.plugins['crosswalker'];
		const handle = await plugin.openTier2();
		const out: Record<string, {
			status: string | null;
			reviewer: string | null;
			reviewDate: string | null;
			coverage: string | null;
			baselineCid: string | null;
			subjectBaseline: string;
			changeKind: string | null;
		}> = {};
		for (const selectedPath of selectedPaths) {
			const rows = handle.db.exec({
				sql: `SELECT status, reviewer, review_date, coverage, reviewed_against_cid,
				             subject_baseline, change_kind
				      FROM junction_notes_with_freshness WHERE vault_path = $path`,
				bind: { $path: selectedPath },
				rowMode: 'array',
				returnValue: 'resultRows',
			}) as unknown[][];
			if (rows.length !== 1) throw new Error(`missing projected junction ${selectedPath}`);
			const row = rows[0];
			out[selectedPath] = {
				status: row[0] === null ? null : String(row[0]),
				reviewer: row[1] === null ? null : String(row[1]),
				reviewDate: row[2] === null ? null : String(row[2]),
				coverage: row[3] === null ? null : String(row[3]),
				baselineCid: row[4] === null ? null : String(row[4]),
				subjectBaseline: String(row[5]),
				changeKind: row[6] === null ? null : String(row[6]),
			};
		}
		return out;
	}, paths);
}

describe('Ch 43 — a real ATT&CK release re-import, end to end', function () {
	this.timeout(8 * 60_000);

	let v15: Record<string, string>[];
	let v16: Record<string, string>[];
	let coverageReportPath = '';
	/** Whole-row and recipe-group fingerprints as the generation engine stamped them. */
	let stamped: Record<string, {
		curie: string;
		reviewCid: string;
		reviewGroups: { wording: string; scope: string; housekeeping: string };
	}>;
	/** AM-74. When the second import started, so a later `produced_at` is provable. */
	let reimportStartedAt = '';

	before(() => {
		v15 = loadTechniques(V15);
		v16 = loadTechniques(V16);
	});

	/**
	 * AM-74 (2026-09-04). WAIT FOR WHAT THE SECOND IMPORT CHANGED.
	 *
	 * `requireFrontmatterIndexed({ requireKeys: ['curie', '_crosswalker'] })` is
	 * satisfied by the state the FIRST import left in the cache: both keys were
	 * already there. So it cannot detect re-indexing after the SECOND write, and the
	 * two declarations that read `review_cid` (and, through the projector, Tier 2)
	 * ran against a cache that had not caught up. That is
	 * `project_cache_lag_is_not_absence` in its documented shape: a cache read that
	 * cannot tell "not there" from "not indexed yet". The engine's end state is
	 * correct - the two later declarations in this file assert it and pass - and the
	 * fix belongs here, in the spec's readiness gate, not in the engine.
	 *
	 * The gate waits for a fact only the re-import can produce: for every subject
	 * this release genuinely changed, the cached `review_cid` differs from the value
	 * snapshotted BEFORE the re-import (`stamped`, written by the first import),
	 * or the note's `_crosswalker.produced_at` is later than the re-import's start.
	 * If it never arrives, the re-import did not restamp what it should have, and
	 * that is an engine finding rather than a timing one - which is why the failure
	 * message says so.
	 */
	const awaitReimportVisible = async (startedAtIso: string): Promise<void> => {
		const expectChanged = SCENARIOS.filter((s) => s.expectFlag).map((s) => s.id);
		await browser.waitUntil(
			async () => {
				const seen = await browser.executeObsidian(async ({ app, obsidian }, args) => {
					const out: Record<string, { cid: string; producedAt: string }> = {};
					for (const id of args.ids) {
						const file = app.vault.getAbstractFileByPath(`${args.destination}/${id}.md`);
						if (!(file instanceof obsidian.TFile)) return null;
						const fm = app.metadataCache.getFileCache(file)?.frontmatter;
						if (!fm) return null;
						const cw = (fm._crosswalker || {}) as Record<string, unknown>;
						out[id] = { cid: String(cw.review_cid || ''), producedAt: String(cw.produced_at || '') };
					}
					return out;
				}, { ids: expectChanged, destination: DESTINATION });
				if (!seen) return false;
				return expectChanged.every((id) => {
					const row = seen[id];
					if (!row) return false;
					return row.cid !== stamped[id].reviewCid || row.producedAt > startedAtIso;
				});
			},
			{
				timeout: 120000,
				interval: 250,
				timeoutMsg: 'the re-import\'s own restamp never reached the metadata cache for every changed subject '
					+ '(if the notes on disk do carry new review_cid values, this is a cache-lag gate problem; if they '
					+ 'do not, the re-import did not restamp them and that is an engine finding)',
			},
		);
	};

	it('starts from a clean destination', async () => {
		const cleaned = await browser.executeObsidian(async ({ app }, folders) => {
			for (const folder of folders) {
				const node = app.vault.getAbstractFileByPath(folder);
				// @ts-expect-error — internal trash API, isolated E2E vault only
				if (node) await app.vault.trash(node, false);
			}
			const deadline = Date.now() + 20000;
			while (folders.some((f) => app.vault.getAbstractFileByPath(f)) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			return folders.every((f) => !app.vault.getAbstractFileByPath(f));
		}, [DESTINATION, JUNCTIONS, MODAL_FOLDER]);
		expect(cleaned).toBe(true);
	});

	it('imports the 15.1 rows and proves the engine stamped a review fingerprint on every note', async () => {
		const result = await importRelease(v15, 'enterprise-attack-v15.1.xlsx');
		expect(result.success).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.created.length).toBe(SCENARIOS.length);

		await requireFrontmatterIndexed({
			pathPrefixes: DESTINATION,
			expectedCount: SCENARIOS.length,
			requireKeys: ['curie', '_crosswalker'],
			timeoutMs: 120000,
		});

		stamped = await browser.executeObsidian(async ({ app, obsidian }, args) => {
			const out: Record<string, {
				curie: string;
				reviewCid: string;
				reviewGroups: { wording: string; scope: string; housekeeping: string };
			}> = {};
			for (const id of args.ids) {
				const file = app.vault.getAbstractFileByPath(`${args.destination}/${id}.md`);
				if (!(file instanceof obsidian.TFile)) throw new Error(`missing note for ${id}`);
				const fm = app.metadataCache.getFileCache(file)?.frontmatter;
				if (!fm) throw new Error(`no frontmatter cached for ${id}`);
				const provenance = fm._crosswalker || {};
				const groups = provenance.review_groups || {};
				out[id] = {
					curie: String(fm.curie),
					reviewCid: String(provenance.review_cid || ''),
					reviewGroups: {
						wording: String(groups.wording || ''),
						scope: String(groups.scope || ''),
						housekeeping: String(groups.housekeeping || ''),
					},
				};
			}
			return out;
		}, { ids: SCENARIOS.map((s) => s.id), destination: DESTINATION });

		// The chain's first link: no stamp, no feature.
		for (const scenario of SCENARIOS) {
			expect(stamped[scenario.id].curie).toMatch(/^mitre-attack:/);
			expect(stamped[scenario.id].reviewCid).toMatch(/^sha256-[0-9a-f]{64}$/);
			for (const cid of Object.values(stamped[scenario.id].reviewGroups)) {
				expect(cid).toMatch(/^sha256-[0-9a-f]{64}$/);
			}
		}
		// Distinct content must produce distinct fingerprints, or the whole
		// comparison below is vacuous.
		expect(new Set(SCENARIOS.map((s) => stamped[s.id].reviewCid)).size).toBe(SCENARIOS.length);
	});

	it('PATH A: a modal-authored attestation carries provenance and reaches Tier 2', async () => {
		// The bytes here are produced by the SHIPPED builder, not hand-written:
		// this is exactly what a user gets from "Link evidence to control".
		const note = buildEvidenceLink({
			folder: MODAL_FOLDER,
			controlPath: `${DESTINATION}/${SCENARIOS[0].id}`,
			evidencePath: 'Evidence/EDR-Runbook',
			coverage: 'full',
			status: 'approved',
			reviewer: 'control-owner',
			controlCurie: stamped[SCENARIOS[0].id].curie,
			controlReviewCid: stamped[SCENARIOS[0].id].reviewCid,
			controlReviewGroups: stamped[SCENARIOS[0].id].reviewGroups,
		} as any);

		// The baseline IS written. The modal half of Ch 43 works.
		expect(note.markdown).toContain('reviewed_against:');
		expect(note.markdown).toContain(stamped[SCENARIOS[0].id].reviewCid);
		expect(note.markdown).toContain('review_groups:');
		for (const cid of Object.values(stamped[SCENARIOS[0].id].reviewGroups)) {
			expect(note.markdown).toContain(cid);
		}
		// Modal-authored links are canonical Tier 1, so projection can carry the
		// same whole-row and recipe-group baseline as an imported junction.
		expect(note.markdown).toContain('_crosswalker:');

		await browser.executeObsidian(async ({ app }, args) => {
			const folder = args.notePath.slice(0, args.notePath.lastIndexOf('/'));
			await app.vault.createFolder(folder).catch(() => undefined);
			const existing = app.vault.getAbstractFileByPath(args.notePath);
			// @ts-expect-error — internal trash API, isolated E2E vault only
			if (existing) await app.vault.trash(existing, false);
			await app.vault.create(args.notePath, args.markdown);
		}, { notePath: note.path, markdown: note.markdown });

		await requireFrontmatterIndexed({
			pathPrefixes: MODAL_FOLDER,
			expectedCount: 1,
			requireKeys: ['curie', 'subject_curie', 'reviewed_against', '_crosswalker'],
			timeoutMs: 120000,
		});

		const projected = await project();
		expect(projected.rows[note.path]).toEqual({
			freshness: 'not-set',
			baseline: 'match',
			changeKind: null,
		});
		expect(projected.counts.junction_notes).toBe(1);

		// Keep the release-pair count below independent from this alternate authoring path.
		await browser.executeObsidian(async ({ app }, folder) => {
			const node = app.vault.getAbstractFileByPath(folder);
			// @ts-expect-error — internal trash API, isolated E2E vault only
			if (node) await app.vault.trash(node, false);
		}, MODAL_FOLDER);
	});

	it('PATH B: an imported approved attestation is stamped by the engine itself', async () => {
		const rows = [
			...SCENARIOS.map((s) => ({
				link_id: `jn-${s.id}`,
				subject_path: `${DESTINATION}/${s.id}`,
				subject_curie: stamped[s.id].curie,
				status: 'approved',
			})),
			{
				// The pre-feature link: `proposed` at write time, so the engine
				// records no baseline. It is promoted to `approved` below, which is
				// exactly how a link written before this feature existed looks.
				link_id: `jn-${NO_BASELINE_ID}-pre-feature`,
				subject_path: `${DESTINATION}/${NO_BASELINE_ID}`,
				subject_curie: stamped[NO_BASELINE_ID].curie,
				status: 'proposed',
			},
		];
		const result = await runRecipe(
			['link_id', 'subject_path', 'subject_curie', 'status'],
			rows,
			JUNCTION_RECIPE,
			JUNCTIONS,
			'ch43-evidence.csv',
		);
		expect(result.errors).toEqual([]);
		expect(result.success).toBe(true);
		expect(result.created.length).toBe(rows.length);

		await requireFrontmatterIndexed({
			pathPrefixes: JUNCTIONS,
			expectedCount: rows.length,
			requireKeys: ['curie', 'subject_curie', '_crosswalker'],
			timeoutMs: 120000,
		});

		const written = await browser.executeObsidian(async ({ app, obsidian }, args) => {
			const out: Record<string, {
				baselineCid: string | null;
				baselineCurie: string | null;
				baselineGroups: Record<string, string> | null;
			}> = {};
			for (const id of args.ids) {
				const file = app.vault.getAbstractFileByPath(`${args.junctions}/${id}.md`);
				if (!(file instanceof obsidian.TFile)) throw new Error(`missing junction ${id}`);
				const ra = app.metadataCache.getFileCache(file)?.frontmatter?.reviewed_against;
				out[id] = {
					baselineCid: ra ? String(ra.review_cid) : null,
					baselineCurie: ra ? String(ra.curie) : null,
					baselineGroups: ra?.review_groups
						? {
							wording: String(ra.review_groups.wording),
							scope: String(ra.review_groups.scope),
							housekeeping: String(ra.review_groups.housekeeping),
						}
						: null,
				};
			}
			return out;
		}, { ids: rows.map((r) => r.link_id), junctions: JUNCTIONS });

		// The engine resolved each subject through the identity index and stamped
		// the control's OWN fingerprint. Nothing in this spec computed a hash.
		for (const scenario of SCENARIOS) {
			expect({ id: scenario.id, ...written[`jn-${scenario.id}`] }).toEqual({
				id: scenario.id,
				baselineCid: stamped[scenario.id].reviewCid,
				baselineCurie: stamped[scenario.id].curie,
				baselineGroups: stamped[scenario.id].reviewGroups,
			});
		}
		// A non-approved link is never stamped: nobody reviewed anything yet.
		expect(written[`jn-${NO_BASELINE_ID}-pre-feature`])
			.toEqual({ baselineCid: null, baselineCurie: null, baselineGroups: null });

		// Promote the unbaselined link to approved WITHOUT adding a baseline —
		// the exact shape of every attestation written before this feature.
		await browser.executeObsidian(async ({ app, obsidian }, notePath) => {
			const file = app.vault.getAbstractFileByPath(notePath);
			if (!(file instanceof obsidian.TFile)) throw new Error(`missing ${notePath}`);
			const text = await app.vault.read(file);
			await app.vault.modify(file, text.replace('status: proposed', 'status: approved'));
		}, `${JUNCTIONS}/jn-${NO_BASELINE_ID}-pre-feature.md`);

		await browser.waitUntil(
			async () => browser.executeObsidian(({ app }, notePath) => {
				const file = app.vault.getAbstractFileByPath(notePath);
				// @ts-expect-error — TFile at runtime
				return app.metadataCache.getFileCache(file)?.frontmatter?.status === 'approved';
			}, `${JUNCTIONS}/jn-${NO_BASELINE_ID}-pre-feature.md`),
			{ timeout: 60000, interval: 250, timeoutMsg: 'status promotion never reached the cache' },
		);
	});

	it('before the re-import, every baselined link matches and the pre-feature link is unrecorded', async () => {
		const { counts, rows } = await project();
		expect(counts.junction_notes).toBe(SCENARIOS.length + 1);
		for (const scenario of SCENARIOS) {
			expect({ id: scenario.id, ...rows[`${JUNCTIONS}/jn-${scenario.id}.md`] })
				.toEqual({ id: scenario.id, freshness: 'fresh', baseline: 'match', changeKind: null });
		}
		expect(rows[`${JUNCTIONS}/jn-${NO_BASELINE_ID}-pre-feature.md`])
			.toEqual({ freshness: 'fresh', baseline: 'unrecorded', changeKind: null });
	});

	it('THE CLAIM: re-importing 16.1 invalidates exactly the changed subjects', async () => {
		// AM-74. The instant before the write, so `produced_at` can be compared
		// against it: everything the gate below waits for is later than this.
		reimportStartedAt = new Date().toISOString();
		const result = await importRelease(v16, 'enterprise-attack-v16.1.xlsx', await ownedImportSet());
		expect(result.success).toBe(true);
		expect(result.errors).toEqual([]);

		await requireFrontmatterIndexed({
			pathPrefixes: DESTINATION,
			expectedCount: SCENARIOS.length,
			requireKeys: ['curie', '_crosswalker'],
			timeoutMs: 120000,
		});
		// AM-74. Both keys above predate this import, so that gate cannot see the
		// second write. See `awaitReimportVisible`.
		await awaitReimportVisible(reimportStartedAt);

		// The engine must have re-stamped: a changed row means a changed hash,
		// and an unchanged row means a byte-identical one.
		const restamped = await browser.executeObsidian(async ({ app, obsidian }, args) => {
			const out: Record<string, string> = {};
			for (const id of args.ids) {
				const file = app.vault.getAbstractFileByPath(`${args.destination}/${id}.md`);
				if (!(file instanceof obsidian.TFile)) throw new Error(`missing note for ${id}`);
				const fm = app.metadataCache.getFileCache(file)?.frontmatter;
				out[id] = String(((fm || {})._crosswalker || {}).review_cid || '');
			}
			return out;
		}, { ids: SCENARIOS.map((s) => s.id), destination: DESTINATION });

		for (const scenario of SCENARIOS) {
			const moved = restamped[scenario.id] !== stamped[scenario.id].reviewCid;
			expect({ id: scenario.id, moved }).toEqual({ id: scenario.id, moved: scenario.expectFlag });
		}

		const { rows } = await project();
		for (const scenario of SCENARIOS) {
			expect({ id: scenario.id, ...rows[`${JUNCTIONS}/jn-${scenario.id}.md`] }).toEqual({
				id: scenario.id,
				freshness: scenario.expectFlag ? 'subject-changed' : 'fresh',
				baseline: scenario.expectFlag ? 'changed' : 'match',
				changeKind: scenario.changeKind,
			});
		}

		// The backward-compatibility guarantee, after the same re-import that
		// invalidated six of its neighbours: untouched, and named.
		expect(rows[`${JUNCTIONS}/jn-${NO_BASELINE_ID}-pre-feature.md`])
			.toEqual({ freshness: 'fresh', baseline: 'unrecorded', changeKind: null });
	});

	it('the vault can name which links stopped counting and which cannot be judged', async () => {
		// AM-74. The same gate as the declaration above, for the same reason: these
		// rows are the projection of frontmatter read through the metadata cache
		// (`src/tier2/projector.ts`), so they can only be as current as that cache.
		// Satisfied already when the previous declaration ran, and asserted here so
		// this declaration does not depend on that ordering.
		await awaitReimportVisible(reimportStartedAt);
		const report = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error — Crosswalker E2E API
			const plugin = app.plugins.plugins['crosswalker'];
			const handle = await plugin.openTier2();
			const changed = handle.db.exec({
				sql: "SELECT vault_path FROM junction_notes_with_freshness WHERE freshness = 'subject-changed' ORDER BY vault_path",
				rowMode: 'array', returnValue: 'resultRows',
			}) as unknown[][];
			const unbaselined = handle.db.exec({
				sql: "SELECT vault_path FROM junction_notes_with_freshness WHERE subject_baseline = 'unrecorded' ORDER BY vault_path",
				rowMode: 'array', returnValue: 'resultRows',
			}) as unknown[][];
			return {
				changed: changed.map((r) => String(r[0])),
				unbaselined: unbaselined.map((r) => String(r[0])),
			};
		});

		expect(report.changed.slice().sort()).toEqual(
			SCENARIOS.filter((s) => s.expectFlag).map((s) => `${JUNCTIONS}/jn-${s.id}.md`).sort(),
		);
		expect(report.unbaselined).toEqual([`${JUNCTIONS}/jn-${NO_BASELINE_ID}-pre-feature.md`]);
	});

	it('and the report a human opens says all of it in words', async () => {
		// The last link in the chain. Everything above proves the index knows;
		// this proves the artifact a control owner actually reads says so.
		const written = await browser.executeObsidian(async ({ app, obsidian }, args) => {
			// @ts-expect-error — internal commands API
			app.commands.executeCommandById('crosswalker:evidence-coverage-report');
			await new Promise((resolve) => setTimeout(resolve, 900));
			// The vault holds several frameworks, so a chooser appears. Pick by
			// name rather than taking whatever is highlighted.
			const input = document.querySelector('.prompt input') as HTMLInputElement | null;
			if (input) {
				input.value = args.ontology;
				input.dispatchEvent(new Event('input', { bubbles: true }));
				await new Promise((resolve) => setTimeout(resolve, 500));
				input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
			}
			const deadline = Date.now() + 30000;
			while (Date.now() < deadline) {
				const file = app.vault.getMarkdownFiles()
					.find((f) => f.path.includes('coverage') && f.path.includes(args.ontology));
				if (file instanceof obsidian.TFile) return { path: file.path, text: await app.vault.read(file) };
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			return { path: '', text: '' };
		}, { ontology: 'mitre-attack' });

		expect(written.path).not.toBe('');
		coverageReportPath = written.path;
		const wordingAt = written.text.indexOf('### Wording changes (3)');
		const scopeAt = written.text.indexOf('### Scope changes (1)');
		const housekeepingAt = written.text.indexOf('### Housekeeping changes (2)');
		expect(wordingAt).toBeGreaterThan(-1);
		expect(scopeAt).toBeGreaterThan(wordingAt);
		expect(housekeepingAt).toBeGreaterThan(scopeAt);
		// Every invalidated link is named, with a reason a reader can act on.
		for (const scenario of SCENARIOS.filter((s) => s.expectFlag)) {
			expect(written.text).toContain(`jn-${scenario.id}.md`);
		}
		expect(written.text).toContain('subject-changed');
		// And the pre-feature link is reported as un-judgeable, never as fine.
		expect(written.text).toContain(`jn-${NO_BASELINE_ID}-pre-feature.md`);
		expect(written.text.toLowerCase()).toContain('cannot tell');
	});

	it('re-baselines exactly one selected real housekeeping row without changing review facts', async () => {
		const selected = `${JUNCTIONS}/jn-T1548.002.md`;
		const unselected = `${JUNCTIONS}/jn-T1134.003.md`;
		const before = await junctionState([selected, unselected]);
		expect(before[selected]).toMatchObject({
			status: 'approved',
			reviewer: 'control-owner',
			reviewDate: '2026-08-01T00:00:00Z',
			coverage: 'full',
			subjectBaseline: 'changed',
			changeKind: 'housekeeping',
		});
		expect(before[unselected]).toMatchObject({
			subjectBaseline: 'changed',
			changeKind: 'housekeeping',
		});

		await browser.executeObsidian(async ({ app, obsidian }, args) => {
			const report = app.vault.getAbstractFileByPath(args.reportPath);
			if (!(report instanceof obsidian.TFile)) throw new Error(`missing report ${args.reportPath}`);
			await app.workspace.getLeaf(false).openFile(report);
			const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
			if (!view) throw new Error('coverage report did not open in a Markdown view');
			const lines = view.editor.getValue().split('\n');
			const line = lines.findIndex((value) => value.includes(`[[${args.selected}]]`));
			if (line < 0) throw new Error(`selected housekeeping row not found: ${args.selected}`);
			view.editor.setSelection(
				{ line, ch: 0 },
				{ line, ch: lines[line].length },
			);
			// @ts-expect-error — internal commands API
			app.commands.executeCommandById('crosswalker:record-selected-housekeeping-baseline');
		}, { reportPath: coverageReportPath, selected });

		await browser.waitUntil(
			async () => browser.execute(() => Array.from(document.querySelectorAll('button'))
				.some((button) => button.textContent?.trim() === 'Record baseline')),
			{ timeout: 30000, interval: 200, timeoutMsg: 'housekeeping confirmation did not open' },
		);
		mkdirSync(path.resolve('test-screenshots'), { recursive: true });
		await browser.saveScreenshot(path.resolve('test-screenshots', 'ch43-housekeeping-confirm.png'));
		await browser.execute(() => {
			const button = Array.from(document.querySelectorAll('button'))
				.find((candidate) => candidate.textContent?.trim() === 'Record baseline') as HTMLButtonElement | undefined;
			if (!button) throw new Error('Record baseline button disappeared');
			button.click();
		});

		await browser.waitUntil(async () => {
			const state = await junctionState([selected, unselected]);
			return state[selected].subjectBaseline === 'match';
		}, { timeout: 30000, interval: 250, timeoutMsg: 'selected housekeeping row stayed changed' });

		const after = await junctionState([selected, unselected]);
		expect(after[selected]).toMatchObject({
			status: before[selected].status,
			reviewer: before[selected].reviewer,
			reviewDate: before[selected].reviewDate,
			coverage: before[selected].coverage,
			subjectBaseline: 'match',
			changeKind: null,
		});
		expect(after[selected].baselineCid).not.toBe(before[selected].baselineCid);
		expect(after[unselected]).toEqual(before[unselected]);

		const canonical = await browser.executeObsidian(async ({ app, obsidian }, args) => {
			const junction = app.vault.getAbstractFileByPath(args.junctionPath);
			const concept = app.vault.getAbstractFileByPath(args.conceptPath);
			if (!(junction instanceof obsidian.TFile) || !(concept instanceof obsidian.TFile)) {
				throw new Error('selected junction or subject concept is missing');
			}
			const junctionFm = app.metadataCache.getFileCache(junction)?.frontmatter;
			const conceptFm = app.metadataCache.getFileCache(concept)?.frontmatter;
			return {
				status: junctionFm?.status,
				reviewer: junctionFm?.reviewer,
				reviewDate: junctionFm?.review_date,
				coverage: junctionFm?.coverage,
				reviewedAgainst: junctionFm?.reviewed_against,
				currentReviewCid: conceptFm?._crosswalker?.review_cid,
				currentGroups: conceptFm?._crosswalker?.review_groups,
			};
		}, {
			junctionPath: selected,
			conceptPath: `${DESTINATION}/T1548.002.md`,
		});
		expect(canonical).toMatchObject({
			status: 'approved',
			reviewer: 'control-owner',
			reviewDate: '2026-08-01T00:00:00Z',
			coverage: 'full',
			reviewedAgainst: {
				curie: stamped['T1548.002'].curie,
				review_cid: canonical.currentReviewCid,
				review_groups: canonical.currentGroups,
			},
		});
	});
});
