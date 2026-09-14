/**
 * attestation-stamping.test.ts — where the review baseline comes from, and
 * where it must never come from (Ch 43 re-attestation, 2026-08-28).
 *
 * The recurring hazard in this area is fabrication. Stamping the CURRENT
 * content as "what was reviewed" asserts that a human read text they may never
 * have seen — an invented audit fact, in the one report whose reader is an
 * auditor. So a baseline is written only where a human actually approved
 * something, and every other path omits it and says so.
 *
 * The counterpart hazard is reading a null as a fact. `getFileCache()` returns
 * null both for "no frontmatter" and for "not indexed yet", and treating the
 * second as the first would stamp "no baseline" onto a link whose control has a
 * perfectly good fingerprint (`project_cache_lag_is_not_absence`).
 */

import { TFile, TFolder } from 'obsidian';
import { applyMigrations } from '../src/tier2/migrations';
import { projectFromTier1 } from '../src/tier2/projector';
import { generateFromRecipe } from '../src/generation/generation-engine';
import { computeReviewCid, computeReviewGroupCids } from '../src/generation/hash';
import { buildEvidenceLink, evidenceLinkPath, reviewedAgainstFor, type EvidenceLinkInput } from '../src/views/evidence-link';
import { EvidenceLinkModal, readReviewCid, readReviewGroups } from '../src/views/evidence-link-modal';
import {
	evidenceCoverageByConcept,
	diagnoseExcludedJunctions,
	listUnbaselinedValidJunctions,
} from '../src/tier2/evidence-coverage';
import type { Recipe } from '../src/render';
import type { ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

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

function frontmatterOf(markdown: string): Record<string, any> {
	const match = /^---\n([\s\S]*?)\n---/.exec(markdown.replace(/\r\n/g, '\n'));
	if (!match) throw new Error('generated note has no frontmatter block');
	return yaml.load(match[1]) as Record<string, any>;
}

const CID_OLD = `sha256-${'a'.repeat(64)}`;
const CID_NEW = `sha256-${'b'.repeat(64)}`;
const REVIEW_GROUPS = {
	wording: `sha256-${'c'.repeat(64)}`,
	scope: `sha256-${'d'.repeat(64)}`,
	housekeeping: `sha256-${'e'.repeat(64)}`,
};
const CONTROL_PATH = 'Frameworks/NIST/AC-2.md';
const CONTROL_CURIE = 'nist-800-53:AC-2';

function linkInput(over: Partial<EvidenceLinkInput> = {}): EvidenceLinkInput {
	return {
		controlPath: CONTROL_PATH,
		controlCurie: CONTROL_CURIE,
		controlReviewCid: CID_OLD,
		evidencePath: 'Evidence/MFA policy.md',
		coverage: 'full',
		status: 'approved',
		folder: 'Evidence/Junctions',
		...over,
	};
}

// ---------------------------------------------------------------------------
// The one shared helper
// ---------------------------------------------------------------------------

describe('reviewedAgainstFor writes both facts or neither', () => {
	it('records the pair when both are known', () => {
		expect(reviewedAgainstFor(CONTROL_CURIE, CID_OLD))
			.toEqual({ curie: CONTROL_CURIE, review_cid: CID_OLD });
	});

	it('records complete group hashes beside the whole-row fingerprint', () => {
		expect(reviewedAgainstFor(CONTROL_CURIE, CID_OLD, REVIEW_GROUPS)).toEqual({
			curie: CONTROL_CURIE,
			review_cid: CID_OLD,
			review_groups: REVIEW_GROUPS,
		});
	});

	it('refuses a fingerprint with no subject', () => {
		// A fingerprint alone cannot say WHICH control it came from once a rename
		// or a re-point happens, so it is not a fact worth recording.
		expect(reviewedAgainstFor(null, CID_OLD)).toBeNull();
	});

	it('refuses a subject with no fingerprint', () => {
		expect(reviewedAgainstFor(CONTROL_CURIE, null)).toBeNull();
	});

	it('treats an empty string as absence, not as a value', () => {
		expect(reviewedAgainstFor(CONTROL_CURIE, '')).toBeNull();
		expect(reviewedAgainstFor('', CID_OLD)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// The link modal's pure half
// ---------------------------------------------------------------------------

describe('the link note records what was approved', () => {
	it('E1: an approved link carries the control curie and fingerprint', () => {
		const fm = frontmatterOf(buildEvidenceLink(linkInput()).markdown);
		expect(fm.reviewed_against).toEqual({ curie: CONTROL_CURIE, review_cid: CID_OLD });
	});

	it('an approved link records the complete group baseline when available', () => {
		const fm = frontmatterOf(buildEvidenceLink(linkInput({ controlReviewGroups: REVIEW_GROUPS })).markdown);
		expect(fm.reviewed_against).toEqual({
			curie: CONTROL_CURIE,
			review_cid: CID_OLD,
			review_groups: REVIEW_GROUPS,
		});
	});

	it('E2: a proposed link records nothing — there is no review to describe', () => {
		const { markdown } = buildEvidenceLink(linkInput({ status: 'proposed' }));
		expect(markdown).not.toContain('reviewed_against');
	});

	it('E2: an in_review link records nothing either', () => {
		expect(buildEvidenceLink(linkInput({ status: 'in_review' })).markdown)
			.not.toContain('reviewed_against');
	});

	it('E3: a control with no fingerprint yields no block and an honest note body', () => {
		const { markdown } = buildEvidenceLink(linkInput({ controlReviewCid: null }));
		expect(markdown).not.toContain('reviewed_against');
		expect(markdown).toContain('cannot tell you later if it changes');
		// It still counts, and the note says so rather than implying the link is
		// defective.
		expect(markdown).toContain('This link still counts toward coverage.');
	});

	it('never invents a baseline when the control has no identity', () => {
		expect(buildEvidenceLink(linkInput({ controlCurie: null })).markdown)
			.not.toContain('reviewed_against');
	});

	it('emits YAML a parser reads back as a two-key mapping', () => {
		// The block is written line by line, so this is the test that catches an
		// indentation slip turning it into a string.
		const fm = frontmatterOf(buildEvidenceLink(linkInput()).markdown);
		expect(typeof fm.reviewed_against).toBe('object');
		expect(Object.keys(fm.reviewed_against).sort()).toEqual(['curie', 'review_cid']);
	});
});

describe('readReviewCid reads a fingerprint, and nothing else', () => {
	it('finds it in the provenance block', () => {
		expect(readReviewCid({ _crosswalker: { review_cid: CID_OLD } })).toBe(CID_OLD);
	});

	it('reads only complete recipe-group blocks', () => {
		expect(readReviewGroups({ _crosswalker: { review_groups: REVIEW_GROUPS } }))
			.toEqual(REVIEW_GROUPS);
		expect(readReviewGroups({ _crosswalker: { review_groups: { wording: REVIEW_GROUPS.wording } } }))
			.toBeNull();
	});

	it('returns null, not undefined-ish junk, for every absent shape', () => {
		expect(readReviewCid(undefined)).toBeNull();
		expect(readReviewCid({})).toBeNull();
		expect(readReviewCid({ _crosswalker: {} })).toBeNull();
		expect(readReviewCid({ _crosswalker: { review_cid: '  ' } })).toBeNull();
		expect(readReviewCid({ _crosswalker: { review_cid: 42 } })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// The loop closes: create -> project -> count -> upstream change -> flagged
// ---------------------------------------------------------------------------

describe('a stamped link survives projection and notices an upstream change', () => {
	const provenance = (reviewCid: string | null) => ({
		spec_version: 'https://crosswalker.dev/spec/tier1.schema.json',
		source_ref: { file: 'nist.csv' },
		produced_at: '2026-08-28T00:00:00.000Z',
		concept_cid: CID_OLD,
		...(reviewCid ? { review_cid: reviewCid } : {}),
	});

	function mockApp(entries: Array<[string, Record<string, unknown>]>): any {
		const files = entries.map(([path]) => ({ path, stat: { mtime: 0 } }));
		const byPath = new Map(entries);
		return {
			vault: { getMarkdownFiles: () => files },
			metadataCache: { getFileCache: (file: { path: string }) => ({ frontmatter: byPath.get(file.path) }) },
		};
	}

	async function project(db: TestDb, controlReviewCid: string | null, link: Record<string, unknown>): Promise<void> {
		const app = mockApp([
			[CONTROL_PATH, {
				curie: CONTROL_CURIE,
				title: 'AC-2 Account Management',
				_crosswalker: provenance(controlReviewCid),
			}],
			// Junction notes need provenance to be projected, exactly as generated
			// ones do. The link builder is a pure function and does not add it.
			['Evidence/Junctions/AC-2--has_evidence--MFA policy.md', { ...link, _crosswalker: provenance(null) }],
		]);
		await projectFromTier1(app, db as any, { projectionMode: 'full' });
	}

	let db: TestDb;
	beforeEach(() => { db = createTestDb(); applyMigrations(db as any); });
	afterEach(() => db.close());

	it('counts while the control is unchanged, and flags it once it changes', async () => {
		const link = frontmatterOf(buildEvidenceLink(linkInput()).markdown);

		await project(db, CID_OLD, link);
		expect(evidenceCoverageByConcept(db, 'nist-800-53')[0].valid_count).toBe(1);
		expect(diagnoseExcludedJunctions(db)).toEqual([]);

		// The control is re-imported from a new release. Same identifier, new text.
		await project(db, CID_NEW, link);
		expect(evidenceCoverageByConcept(db, 'nist-800-53')[0].valid_count).toBe(0);
		expect(diagnoseExcludedJunctions(db).map((j) => j.reason)).toEqual(['subject-changed']);
	});

	it('E7: a hand-edited approved link is unrecorded, and projection never writes to fix that', async () => {
		// Tier 2 is a deletable projection of canonical Tier 1. Writing the
		// baseline back from here would make a rebuildable index a producer of
		// canonical data, and would be the silent backfill the contract forbids.
		const handEdited = {
			curie: 'cwk:hand-written',
			kind: 'junction-note',
			subject: `[[${CONTROL_PATH}|AC-2]]`,
			subject_curie: CONTROL_CURIE,
			predicate: 'has_evidence',
			object: '[[Evidence/MFA policy.md|MFA policy]]',
			coverage: 'full',
			status: 'approved',
			_crosswalker: provenance(null),
		};
		const before = JSON.stringify(handEdited);

		await project(db, CID_NEW, handEdited);

		expect(JSON.stringify(handEdited)).toBe(before);
		// It counts, and it is named.
		expect(evidenceCoverageByConcept(db, 'nist-800-53')[0].valid_count).toBe(1);
		expect(listUnbaselinedValidJunctions(db).map((j) => j.baseline)).toEqual(['unrecorded']);
	});
});

// ---------------------------------------------------------------------------
// Bulk import
// ---------------------------------------------------------------------------

describe('bulk import stamps what it can prove and counts what it cannot', () => {
	const JUNCTION_RECIPE: Recipe = {
		recipe: 'junction-baseline-test',
		source: { ontology: 'cwk', levels: ['edge'] },
		target: {
			layout: [{ level: 'edge', mechanism: 'file', template: 'junction/{edge_id}.md', kind: 'junction-note' }],
			also_emit: {
				frontmatter: {
					managed: {
						subject: '{subject_id}',
						subject_curie: '{subject_id}',
						predicate: 'has_evidence',
						object: '{object_id}',
						status: '{status}',
						coverage: 'full',
					},
				},
			},
		},
	};

	const ROW = {
		edge_id: 'edge-1',
		subject_id: CONTROL_CURIE,
		object_id: 'Evidence/MFA policy',
		status: 'approved',
	};

	function parsed(over: Record<string, unknown> = {}): ParsedData {
		const row = { ...ROW, ...over };
		return { columns: Object.keys(row), rows: [row], rowCount: 1 };
	}

	/** A vault whose control note carries `review_cid`, or which has no control. */
	function makeApp(controlReviewCid: string | null) {
		const files = new Map<string, string>();
		const folders = new Set<string>(['', 'Mappings', 'Mappings/junction']);
		if (controlReviewCid !== null) {
			files.set(CONTROL_PATH, [
				'---',
				`curie: ${CONTROL_CURIE}`,
				'_crosswalker:',
				'  spec_version: https://crosswalker.dev/spec/tier1.schema.json',
				'  source_ref:',
				'    file: nist.csv',
				'  produced_at: "2026-08-28T00:00:00.000Z"',
				`  review_cid: ${controlReviewCid}`,
				'---',
				'',
			].join('\n'));
		}
		const app = {
			vault: {
				getMarkdownFiles: () => [...files.keys()].map((path) => new TFile(path)),
				getAbstractFileByPath: (path: string) => {
					if (files.has(path)) return new TFile(path);
					if (folders.has(path)) return new TFolder(path);
					return null;
				},
				create: async (path: string, content: string) => { files.set(path, content); return new TFile(path); },
				modify: async (file: TFile, content: string) => { files.set(file.path, content); },
				read: async (file: TFile) => files.get(file.path) ?? '',
				cachedRead: async (file: TFile) => files.get(file.path) ?? '',
				createFolder: async (path: string) => { folders.add(path); },
			},
			fileManager: { renameFile: async () => undefined },
			metadataCache: {
				getFileCache: (file: TFile) => {
					const content = files.get(file.path);
					if (!content) return null;
					const match = /^---\n([\s\S]*?)\n---/.exec(content.replace(/\r\n/g, '\n'));
					return { frontmatter: match ? (yaml.load(match[1]) as Record<string, unknown>) : {} };
				},
			},
		};
		return { app: app as any, files };
	}

	const OPTIONS = {
		basePath: 'Mappings',
		importSet: { id: 'iset-abc123' as const },
		overwriteMode: 'replace' as const,
		createFolders: true,
		curiePrefix: 'cwk',
		curieLocalPart: () => 'edge-1',
	};

	it('E5: stamps an approved row whose control is in the vault', async () => {
		const { app, files } = makeApp(CID_OLD);
		const result = await generateFromRecipe(app, parsed(), JUNCTION_RECIPE, OPTIONS as any);
		expect(result.errors).toEqual([]);

		const fm = frontmatterOf(files.get('Mappings/junction/edge-1.md')!);
		expect(fm.reviewed_against).toEqual({ curie: CONTROL_CURIE, review_cid: CID_OLD });
		expect(result.unbaselinedJunctions).toBeUndefined();
	});

	it('E6: omits and COUNTS when the control is not in this vault', async () => {
		// No second pass exists to fill this in later, on purpose: a fingerprint
		// the importer computed against content no human read is not an approval.
		const { app, files } = makeApp(null);
		const result = await generateFromRecipe(app, parsed(), JUNCTION_RECIPE, OPTIONS as any);
		expect(result.errors).toEqual([]);

		expect(frontmatterOf(files.get('Mappings/junction/edge-1.md')!).reviewed_against).toBeUndefined();
		expect(result.unbaselinedJunctions).toBe(1);
	});

	it('omits and counts when the control carries no fingerprint', async () => {
		const { app, files } = makeApp(null);
		app.vault.getMarkdownFiles = () => [];
		const result = await generateFromRecipe(app, parsed(), JUNCTION_RECIPE, OPTIONS as any);
		expect(frontmatterOf(files.get('Mappings/junction/edge-1.md')!).reviewed_against).toBeUndefined();
		expect(result.unbaselinedJunctions).toBe(1);
	});

	it('does not stamp a proposed row, and does not count it as unbaselined', async () => {
		// Nothing was approved, so there is nothing missing.
		const { app, files } = makeApp(CID_OLD);
		const result = await generateFromRecipe(app, parsed({ status: 'proposed' }), JUNCTION_RECIPE, OPTIONS as any);
		expect(frontmatterOf(files.get('Mappings/junction/edge-1.md')!).reviewed_against).toBeUndefined();
		expect(result.unbaselinedJunctions).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Concept notes carry the fingerprint the links compare against
// ---------------------------------------------------------------------------

describe('generated concept notes carry review_cid beside concept_cid', () => {
	const CONCEPT_RECIPE: Recipe = {
		recipe: 'concept-review-cid-test',
		source: { ontology: 'nist', levels: ['control'] },
		target: {
			layout: [{ level: 'control', mechanism: 'file', template: '{control_id}.md', kind: 'concept' }],
			also_emit: { frontmatter: { managed: { title: '{title}' } } },
		},
	};

	function makeApp() {
		const files = new Map<string, string>();
		const folders = new Set<string>(['', 'Frameworks']);
		const app = {
			vault: {
				getMarkdownFiles: () => [...files.keys()].map((path) => new TFile(path)),
				getAbstractFileByPath: (path: string) =>
					files.has(path) ? new TFile(path) : folders.has(path) ? new TFolder(path) : null,
				create: async (path: string, content: string) => { files.set(path, content); return new TFile(path); },
				modify: async (file: TFile, content: string) => { files.set(file.path, content); },
				read: async (file: TFile) => files.get(file.path) ?? '',
				createFolder: async (path: string) => { folders.add(path); },
			},
			fileManager: { renameFile: async () => undefined },
			metadataCache: { getFileCache: () => null },
		};
		return { app: app as any, files };
	}

	it('stamps a fingerprint computed from the raw source row', async () => {
		// The title carries a curly apostrophe, so the two hashes are forced apart
		// and the assertion below proves review_cid is the NORMALIZED one rather
		// than a copy of concept_cid. On plain ASCII content they legitimately
		// agree — the hashes differ in tolerance, not in input.
		const row = { control_id: 'AC-2', title: 'The organization\u2019s account management' };
		const { app, files } = makeApp();
		const result = await generateFromRecipe(
			app,
			{ columns: Object.keys(row), rows: [row], rowCount: 1 },
			CONCEPT_RECIPE,
			{
				basePath: 'Frameworks',
				importSet: { id: 'iset-abc123' },
				overwriteMode: 'replace',
				createFolders: true,
				curiePrefix: 'nist',
				curieLocalPart: () => 'AC-2',
			} as any,
		);
		expect(result.errors).toEqual([]);

		const fm = frontmatterOf(files.get('Frameworks/AC-2.md')!);
		expect(fm._crosswalker.review_cid)
			.toBe(computeReviewCid({ curie: 'nist:AC-2', scope: row }));
		expect(fm._crosswalker.review_groups).toEqual(
			computeReviewGroupCids({ curie: 'nist:AC-2', scope: row }, CONCEPT_RECIPE),
		);
		// And the identity hash is a different value, computed a different way.
		expect(fm._crosswalker.review_cid).not.toBe(fm._crosswalker.concept_cid);
	});
});

// ---------------------------------------------------------------------------
// E4 — a null metadata cache is "not read yet", not "no fingerprint"
// ---------------------------------------------------------------------------

describe('the modal looks at the file before concluding a control has no fingerprint', () => {
	/**
	 * A vault where the metadata cache deliberately returns null for the control
	 * even though the file on disk has perfectly good frontmatter. This is the
	 * observed startup-indexing state, and reading it as "no fingerprint" would
	 * write `unrecorded` onto a link whose control is fully fingerprinted.
	 */
	function makeVault(opts: { onDisk: string | null; cacheReturnsNull: boolean }) {
		const files = new Map<string, string>();
		if (opts.onDisk !== null) files.set(CONTROL_PATH, opts.onDisk);
		files.set('Evidence/MFA policy.md', '# MFA policy\n');
		const created = new Map<string, string>();
		const folders = new Set<string>(['Evidence', 'Evidence/Junctions', 'Frameworks', 'Frameworks/NIST']);
		// The control note EXISTS regardless; `onDisk: null` models a file whose
		// bytes are not yet readable, which is the state that must block rather
		// than a file that is simply absent.
		const paths = new Set<string>([...files.keys(), CONTROL_PATH]);

		const app: any = {
			vault: {
				getMarkdownFiles: () => [...files.keys()].map((path) => new TFile(path)),
				getAbstractFileByPath: (path: string) => {
					if (paths.has(path) || created.has(path)) return new TFile(path);
					if (folders.has(path)) return new TFolder(path);
					return null;
				},
				create: async (path: string, content: string) => { created.set(path, content); paths.add(path); return new TFile(path); },
				modify: async (file: TFile, content: string) => { created.set(file.path, content); },
				cachedRead: async (file: TFile) => {
					const content = files.get(file.path);
					if (content === undefined) throw new Error(`unreadable: ${file.path}`);
					return content;
				},
				read: async (file: TFile) => files.get(file.path) ?? '',
				createFolder: async (path: string) => { folders.add(path); },
			},
			metadataCache: {
				getFileCache: (file: TFile) => {
					if (file.path === CONTROL_PATH && opts.cacheReturnsNull) return null;
					const content = files.get(file.path);
					if (!content) return null;
					const match = /^---\n([\s\S]*?)\n---/.exec(content);
					return { frontmatter: match ? (yaml.load(match[1]) as Record<string, unknown>) : {} };
				},
			},
			workspace: { getLeaf: () => ({ openFile: async () => undefined }) },
		};
		return { app, created };
	}

	const CONTROL_NOTE = [
		'---',
		`curie: ${CONTROL_CURIE}`,
		'title: Account Management',
		'_crosswalker:',
		'  spec_version: https://crosswalker.dev/spec/tier1.schema.json',
		'  source_ref:',
		'    file: nist.csv',
		'  produced_at: "2026-08-28T00:00:00.000Z"',
		`  review_cid: ${CID_OLD}`,
		'  review_groups:',
		`    wording: ${REVIEW_GROUPS.wording}`,
		`    scope: ${REVIEW_GROUPS.scope}`,
		`    housekeeping: ${REVIEW_GROUPS.housekeeping}`,
		'---',
		'',
	].join('\n');

	// AM-22 (2026-08-31): the address carries a pair hash, so two controls sharing
	// a file name no longer want one file. Computed through the shipped function
	// rather than written out, so this file pins the window's behaviour and never
	// a second, stale opinion about where a link goes. The literal it replaced was
	// the pre-AM-22 address, and it silently made all three assertions below look
	// at a file the window had never written.
	const LINK_PATH = evidenceLinkPath('Evidence/Junctions', CONTROL_CURIE, CONTROL_PATH, 'Evidence/MFA policy.md');

	/**
	 * AM-43 (2026-09-02): the pair lookup runs once, before `create()`, and
	 * prefill is display-time — so it is driven directly here before the review
	 * controls are set. AM-41: `statusSetInThisWindow` is the record of the ACT
	 * of choosing `approved`, and it is what gates whether `reviewed_against` is
	 * even considered — every scenario below is "the reviewer approves this link
	 * right now", so the act really did happen in this window.
	 */
	async function runModal(app: any, control: { path: string; title: string; curie: string | null; reviewCid: string | null }) {
		const modal = new EvidenceLinkModal({ app, folder: 'Evidence/Junctions', initialControlPath: control.path });
		(modal as any).control = control;
		(modal as any).evidencePath = 'Evidence/MFA policy.md';
		await (modal as any).resolvePair(control, 'Evidence/MFA policy.md');
		(modal as any).status = 'approved';
		(modal as any).coverage = 'full';
		(modal as any).statusSetInThisWindow = true;
		await (modal as any).create();
	}

	it('E4: falls back to a file read and stamps correctly', async () => {
		const { app, created } = makeVault({ onDisk: CONTROL_NOTE, cacheReturnsNull: true });
		// A candidate built while the cache was cold carries reviewCid: null.
		await runModal(app, { path: CONTROL_PATH, title: 'AC-2', curie: CONTROL_CURIE, reviewCid: null });

		const markdown = created.get(LINK_PATH);
		expect(markdown).toBeDefined();
		expect(frontmatterOf(markdown!).reviewed_against).toEqual({
			curie: CONTROL_CURIE,
			review_cid: CID_OLD,
			review_groups: REVIEW_GROUPS,
		});
	});

	it('E4: refuses to create the link at all when the control cannot be read', async () => {
		// The control exists and is approved against, but neither the cache nor a
		// read can produce its frontmatter yet. Writing `unrecorded` here would
		// permanently record an absence caused by timing, so nothing is written
		// and the user is told to try again.
		const { app, created } = makeVault({ onDisk: null, cacheReturnsNull: true });
		await runModal(app, { path: CONTROL_PATH, title: 'AC-2', curie: CONTROL_CURIE, reviewCid: null });
		expect(created.has(LINK_PATH)).toBe(false);
	});

	it('writes the link with no baseline when the control genuinely has none', async () => {
		const noFingerprint = CONTROL_NOTE.replace(`  review_cid: ${CID_OLD}\n`, '');
		const { app, created } = makeVault({ onDisk: noFingerprint, cacheReturnsNull: true });
		await runModal(app, { path: CONTROL_PATH, title: 'AC-2', curie: CONTROL_CURIE, reviewCid: null });

		const markdown = created.get(LINK_PATH);
		expect(markdown).toBeDefined();
		expect(markdown).not.toContain('reviewed_against');
		expect(markdown).toContain('cannot tell you later if it changes');
	});

	it('does not read from disk at all for a proposed link', async () => {
		// Nothing is being approved, so there is no baseline to resolve and no
		// reason to block on indexing.
		const { app, created } = makeVault({ onDisk: '# no frontmatter\n', cacheReturnsNull: true });
		const control = { path: CONTROL_PATH, title: 'AC-2', curie: CONTROL_CURIE, reviewCid: null };
		const modal = new EvidenceLinkModal({
			app,
			folder: 'Evidence/Junctions',
			initialControlPath: control.path,
		});
		(modal as any).control = control;
		(modal as any).evidencePath = 'Evidence/MFA policy.md';
		await (modal as any).resolvePair(control, 'Evidence/MFA policy.md');
		(modal as any).status = 'proposed';
		await (modal as any).create();
		expect(created.has(LINK_PATH)).toBe(true);
	});
});
