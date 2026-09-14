/**
 * evidence-window-identity.test.ts — AM-22 and AM-23 (2026-08-31): the evidence
 * window asks WHICH LINK, and it asks before it creates.
 *
 * THE TWO DEFECTS THIS FILE PINS.
 *
 * AM-22. The junction's identity and address were both functions of
 * `basename()`. Two releases of one framework — the case release isolation
 * exists to support — share control file names, so `Frameworks/NIST-r4/AC-2.md`
 * and `Frameworks/NIST-r5/AC-2.md` produced one path and one curie. Linking
 * evidence to r5 therefore PASSED AM-17's identity door (the strings matched)
 * and replaced r4's link in full: its approval, its reviewer, its review date,
 * its `reviewed_against` baseline, and the reviewer's own prose. The notice said
 * the link had been updated. Nothing could report it afterwards, because the
 * identifier never changed, so no duplicate existed to be found.
 *
 * AM-23. The lookup ran only on the branch that OVERWRITES. The create branch
 * asked the address and nothing else, so renaming or dragging a junction note in
 * Obsidian — which Obsidian invites — left nothing at the address and the next
 * link for that pair created a SECOND note holding the same curie. Two notes
 * with one identity is a permanent `Ambiguous identity` collision that fails
 * every later import in the vault, plus a link double-counted by every coverage
 * tally.
 *
 * WHY A SECOND FILE. `evidence-window-ownership.test.ts` pins the DOOR (AM-17):
 * what happens to whatever sits at the address. This file pins the LOOKUP: which
 * note is this link, wherever it sits, and which notes are emphatically not it.
 * Both drive the same private `create()` handler against a vault double, because
 * what is written to the vault is the subject, not the modal's DOM.
 */

import { TFile, TFolder } from 'obsidian';
import { EvidenceLinkModal, type ControlCandidate } from '../src/views/evidence-link-modal';
import {
	evidenceLinkCurie,
	evidenceLinkPath,
	legacyEvidenceLinkCurie,
	legacyEvidenceLinkPath,
} from '../src/views/evidence-link';
import type { App } from 'obsidian';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

// ---------------------------------------------------------------------------
// Notices, swapped on the LIVE module object (see the sibling file for why a
// namespace import would leave src/ calling the original).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const obsidianModule = require('obsidian') as { Notice: new (message: string, timeout?: number) => unknown };
const RealNotice = obsidianModule.Notice;
const notices: string[] = [];

beforeAll(() => {
	obsidianModule.Notice = class {
		constructor(message: string) { notices.push(message); }
	} as unknown as typeof RealNotice;
});
afterAll(() => { obsidianModule.Notice = RealNotice; });
beforeEach(() => { notices.length = 0; });

const said = (): string => notices.join('\n');

function makeVault() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const opened: string[] = [];
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((p) => new TFile(p)),
			// S5 (2026-09-04) fix follow-up: buildLinkFallbackIndex reads getFiles(),
			// not getMarkdownFiles() -- a stub missing it throws the moment a scan
			// falls back to the vault file list. No non-markdown fixture here, so this
			// answers the same set; see tests/vault-path-normalization-s5.test.ts for
			// the PDF/non-markdown case.
			getFiles: () => [...files.keys()].map((p) => new TFile(p)),
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			create: async (path: string, content: string) => { files.set(path, content); return new TFile(path); },
			modify: async (file: { path: string }, content: string) => { files.set(file.path, content); },
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const text = files.get(file.path);
				if (text === undefined) return null;
				const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
				if (!match) return { frontmatter: undefined };
				try {
					return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> };
				} catch {
					return { frontmatter: undefined };
				}
			},
			/**
			 * AM-30. Obsidian's own link resolution, modelled the way it actually
			 * behaves: the recorded path first, then a unique file name anywhere in
			 * the vault. This is what lets a recorded wikilink still name a document
			 * the user has dragged into another folder — the case the amendment
			 * exists for, and one no amount of recomputation can cover.
			 */
			getFirstLinkpathDest: (linkpath: string) => {
				if (files.has(linkpath)) return new TFile(linkpath);
				const withExtension = linkpath.endsWith('.md') ? linkpath : `${linkpath}.md`;
				if (files.has(withExtension)) return new TFile(withExtension);
				const name = (linkpath.split('/').pop() ?? linkpath).replace(/\.md$/, '');
				const found = [...files.keys()].filter((path) => path.split('/').pop() === `${name}.md`);
				return found.length === 1 ? new TFile(found[0]) : null;
			},
		},
		workspace: {
			getLeaf: () => ({ openFile: async (file: { path: string }) => { opened.push(file.path); } }),
		},
	};
	return { app: app as unknown as App, files, folders, opened };
}

const FOLDER = 'Evidence/Junctions';
const EVIDENCE = 'Evidence/MFA policy.md';

/**
 * Two releases of one framework, coexisting as two import sets. Same control id,
 * same file name, different folders and different curies — which is exactly what
 * `set-qualified-v1` mints and what the old scheme could not tell apart.
 */
const R4: ControlCandidate = {
	path: 'Frameworks/NIST-r4/AC-2.md',
	title: 'AC-2',
	curie: 'nist:AC-2',
	reviewCid: null,
};
const R5: ControlCandidate = {
	path: 'Frameworks/NIST-r5/AC-2.md',
	title: 'AC-2',
	curie: 'nist-iset-bbbbbb:AC-2',
	reviewCid: null,
};

const pathFor = (c: ControlCandidate, evidence = EVIDENCE): string =>
	evidenceLinkPath(FOLDER, c.curie, c.path, evidence);
const curieFor = (c: ControlCandidate, evidence = EVIDENCE): string =>
	evidenceLinkCurie(c.curie, c.path, evidence);

interface ModalInternals {
	control: ControlCandidate | null;
	evidencePath: string;
	pairRefusal: string | null;
	resolvePair(control: ControlCandidate, evidencePath: string): Promise<void>;
	create(): Promise<void>;
}

/**
 * Press "Create link" for one control/evidence pair.
 *
 * AM-43 (2026-09-02): the pair lookup is a separate, awaited step — driven
 * directly here, mirroring the DOM's change/blur handlers.
 */
async function pressCreateLink(app: App, control: ControlCandidate, evidence = EVIDENCE): Promise<ModalInternals> {
	const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
	modal.control = control;
	modal.evidencePath = evidence;
	await modal.resolvePair(control, evidence);
	await modal.create();
	return modal;
}

/**
 * The pair lookup alone, for a scan the design means to REFUSE. `create()` is
 * deliberately not called: with no resolution it only re-triggers the lookup
 * (`pairChanged()` clears `pairRefusal` before the async re-run lands) and
 * shows a generic "Checking..." notice, which a real UI never reaches because
 * the submit button stays disabled while `pairRefusal` is set.
 */
async function resolveOnly(app: App, control: ControlCandidate, evidence = EVIDENCE): Promise<ModalInternals> {
	const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
	modal.control = control;
	modal.evidencePath = evidence;
	await modal.resolvePair(control, evidence);
	return modal;
}

const note = (frontmatter: string, body = 'Body.\n'): string => `---\n${frontmatter}\n---\n${body}`;

/** A junction note as the window itself would have written it, at any address. */
function junction(opts: {
	curie: string;
	control: ControlCandidate;
	evidence?: string;
	setId?: string | null;
	body?: string;
}): string {
	const lines = [
		`curie: "${opts.curie}"`,
		'kind: junction-note',
		`subject: "[[${opts.control.path}|AC-2]]"`,
		...(opts.control.curie ? [`subject_curie: "${opts.control.curie}"`] : []),
		'predicate: has_evidence',
		`object: "[[${opts.evidence ?? EVIDENCE}|MFA policy]]"`,
		'coverage: full',
		'status: approved',
		'reviewer: "A reviewer"',
	];
	if (opts.setId !== null) {
		lines.push('_crosswalker:', '  import_set:', `    id: ${opts.setId ?? 'iset-r4r4r4'}`);
	}
	return note(lines.join('\n'), opts.body ?? 'Reviewer prose that must survive.\n');
}

// ---------------------------------------------------------------------------
// AM-22 at the window: release isolation.
// ---------------------------------------------------------------------------

describe('AM-22: linking against a second release never touches the first', () => {
	it('leaves release 4\'s link byte-for-byte intact when release 5 is linked', async () => {
		// THE defect. Before AM-22 this second click replaced the first note in
		// full and reported it as an update.
		const { app, files } = makeVault();
		await pressCreateLink(app, R4);
		const r4Path = pathFor(R4);
		const r4Before = files.get(r4Path)!;
		expect(r4Before).toBeDefined();
		notices.length = 0;

		await pressCreateLink(app, R5);

		expect(files.get(r4Path)).toBe(r4Before);
		expect(files.has(pathFor(R5))).toBe(true);
		expect(files.size).toBe(2);
		expect(said()).toContain('Evidence link created.');
		expect(said()).not.toContain('Updated the existing link');
	});

	it('keeps the reviewer\'s work on the first link', async () => {
		// What was actually lost: an approved attestation and the prose under it.
		// Asserted separately from the byte comparison above so a future change to
		// the note's shape cannot quietly turn that test green for the wrong reason.
		const { app, files } = makeVault();
		files.set(pathFor(R4), junction({ curie: curieFor(R4), control: R4, body: 'Approved 2026-08-01 by a reviewer.\n' }));
		await pressCreateLink(app, R5);
		expect(files.get(pathFor(R4))).toContain('Approved 2026-08-01 by a reviewer.');
		expect(files.get(pathFor(R4))).toContain('reviewer: "A reviewer"');
	});

	it('still updates in place when the SAME release is linked twice', async () => {
		// The control. A window that refused every second click would pass both
		// tests above and be useless.
		const { app, files } = makeVault();
		await pressCreateLink(app, R4);
		notices.length = 0;
		await pressCreateLink(app, R4);
		expect(files.size).toBe(1);
		expect(said()).toContain('Updated the existing link');
	});
});

// ---------------------------------------------------------------------------
// AM-22 at the window: the legacy alias, and its limit.
// ---------------------------------------------------------------------------

describe('AM-22: a link written under the old scheme is adopted, not doubled', () => {
	const LEGACY_CURIE = legacyEvidenceLinkCurie(R4.path, EVIDENCE);
	const LEGACY_PATH = legacyEvidenceLinkPath(FOLDER, R4.path, EVIDENCE);

	it('updates the existing note in place when it carries a provenance block', async () => {
		// Found by the PAIR it records, not by any recomputed identifier. Without
		// that, a scheme change manufactures a second link for every pair a user
		// re-links, double-counted by every coverage tally, with the first abandoned.
		//
		// AM-30 (2026-08-31) narrowed what "adopted" means here. This declaration
		// used to require the note to be RESTAMPED with the curie a mint would
		// choose today; it now requires the opposite. A curie already recorded on a
		// note is that note's identity, and recomputing it is the defect the whole
		// amendment is about: the recomputation is a function of the evidence file's
		// vault path, so it changes when a user moves a document and the junction
		// that plainly exists is then found by nothing.
		const { app, files } = makeVault();
		files.set(LEGACY_PATH, junction({ curie: LEGACY_CURIE, control: R4 }));

		await pressCreateLink(app, R4);

		expect(files.size).toBe(1);
		expect(files.has(pathFor(R4))).toBe(false);
		expect(files.get(LEGACY_PATH)).toContain(`curie: ${LEGACY_CURIE}`);
		expect(said()).toContain('Updated the existing link');
	});

	it('adopts the oldest links too, which carry no provenance block at all', async () => {
		// The identity index admits only notes with a `_crosswalker` block, so these
		// are invisible to it — and were reachable before only through a guessed
		// former ADDRESS. The pair scan reads every era for free, because the filter
		// is `kind: junction-note`, which every version of this window has written.
		const { app, files } = makeVault();
		files.set(LEGACY_PATH, junction({ curie: LEGACY_CURIE, control: R4, setId: null }));

		await pressCreateLink(app, R4);

		expect(files.size).toBe(1);
		expect(files.get(LEGACY_PATH)).toContain(`curie: ${LEGACY_CURIE}`);
		expect(said()).toContain('Updated the existing link');
	});

	it('finds a legacy link that has ALSO been moved', async () => {
		// The case no address probe can reach: an old link the user renamed. The
		// note still SAYS which control and which document it is about, and that
		// statement survives every rename.
		const { app, files } = makeVault();
		const moved = `${FOLDER}/an old link I renamed.md`;
		files.set(moved, junction({ curie: LEGACY_CURIE, control: R4 }));

		await pressCreateLink(app, R4);

		expect(files.size).toBe(1);
		expect(files.get(moved)).toContain(`curie: ${LEGACY_CURIE}`);
		expect(said()).toContain('Updated the existing link');
	});

	it('names the note it updated when that note is not at the expected address', async () => {
		// "Updated the existing link" with no path, about a note somewhere else, is
		// how a user concludes nothing happened and clicks again.
		const { app, files } = makeVault();
		files.set(LEGACY_PATH, junction({ curie: LEGACY_CURIE, control: R4 }));
		await pressCreateLink(app, R4);
		expect(said()).toContain(LEGACY_PATH);
		expect(files.size).toBe(1);
	});

	it('does NOT adopt a legacy link that names a different pair', async () => {
		// The tightening the legacy alias needs, and the reason the alias alone is
		// not enough: the OLD identifier was basename-derived and is therefore not
		// unique, so r4's legacy link answers to r5's legacy curie. Adopting on the
		// alias alone would restage the original defect through its own migration
		// path. The note's recorded subject and object settle it.
		const { app, files } = makeVault();
		const r4Legacy = junction({ curie: LEGACY_CURIE, control: R4 });
		files.set(LEGACY_PATH, r4Legacy);

		await pressCreateLink(app, R5);

		expect(files.get(LEGACY_PATH)).toBe(r4Legacy);
		expect(files.has(pathFor(R5))).toBe(true);
		expect(files.size).toBe(2);
	});

	it('does NOT adopt a legacy link whose evidence is a different document', async () => {
		// Same rule on the object side: the pair is both halves.
		const { app, files } = makeVault();
		const other = junction({ curie: LEGACY_CURIE, control: R4, evidence: 'Evidence/Something else.md' });
		files.set(LEGACY_PATH, other);

		await pressCreateLink(app, R4);

		expect(files.get(LEGACY_PATH)).toBe(other);
		expect(files.has(pathFor(R4))).toBe(true);
		expect(files.size).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// AM-23: identity first, address second, create last.
// ---------------------------------------------------------------------------

describe('AM-23: the lookup comes before the create', () => {
	const RENAMED = `${FOLDER}/renamed by hand.md`;

	it('finds a junction the user renamed, and updates it where it sits', async () => {
		// A plain drag in Obsidian. The old order asked the address first, found
		// nothing, and created a twin holding the same curie.
		const { app, files } = makeVault();
		files.set(RENAMED, junction({ curie: curieFor(R4), control: R4 }));

		await pressCreateLink(app, R4);

		expect(files.size).toBe(1);
		expect(files.has(pathFor(R4))).toBe(false);
		expect(files.get(RENAMED)).toContain(`curie: ${curieFor(R4)}`);
		expect(said()).toContain('Updated the existing link');
		expect(said()).toContain(RENAMED);
	});

	it('never leaves two notes holding one identity', async () => {
		// The consequence, stated as the property rather than as the path: two
		// claimants poison every later import in the vault with `Ambiguous
		// identity`, from a window a user cannot connect to imports at all.
		const { app, files } = makeVault();
		files.set(RENAMED, junction({ curie: curieFor(R4), control: R4 }));
		await pressCreateLink(app, R4);
		// Counted by PARSED identity, not by substring. A substring count reads
		// `curie: "cwk:..."` and `curie: cwk:...` as different notes, which would
		// leave this test green in exactly the case it exists to catch: the window
		// creating a second, unquoted claimant beside a seeded quoted one.
		const holders = [...files.values()].filter((text) => {
			const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
			if (!match) return false;
			const fm = (yaml.load(match[1]) ?? {}) as Record<string, unknown>;
			return fm.curie === curieFor(R4);
		});
		expect(holders).toHaveLength(1);
	});

	it('creates only on a true identity miss', async () => {
		// The other half. A lookup that answered "found" too eagerly would make the
		// window unable to create anything.
		const { app, files } = makeVault();
		files.set(`${FOLDER}/unrelated junction.md`, junction({ curie: 'cwk:something-else', control: R5 }));

		await pressCreateLink(app, R4);

		expect(files.has(pathFor(R4))).toBe(true);
		expect(files.size).toBe(2);
		expect(said()).toContain('Evidence link created.');
	});

	it('refuses when two notes already claim this link, naming both', async () => {
		// `get()` picks the first claimant and would rewrite it arbitrarily. The
		// window must not add a third opinion to a vault that is already ambiguous;
		// it names the state so the user can fix it, rather than leaving them to
		// discover it as an import error weeks later.
		//
		// AM-43 (2026-09-02): this refusal ("N notes already record this pair")
		// lives in the pair SCAN too (more than one junction names the pair), so it
		// is asserted on `pairRefusal` via `resolveOnly` rather than on a `Notice`.
		const { app, files } = makeVault();
		const a = `${FOLDER}/claimant a.md`;
		const b = `${FOLDER}/claimant b.md`;
		files.set(a, junction({ curie: curieFor(R4), control: R4 }));
		files.set(b, junction({ curie: curieFor(R4), control: R4 }));
		const before = new Map(files);

		const modal = await resolveOnly(app, R4);

		expect([...files.keys()].sort()).toEqual([...before.keys()].sort());
		expect(files.get(a)).toBe(before.get(a));
		expect(files.get(b)).toBe(before.get(b));
		expect(modal.pairRefusal).toContain(a);
		expect(modal.pairRefusal).toContain(b);
	});

	it('a contested LEGACY identity does not block the link', async () => {
		// Different matter entirely: the old identifier was never unique, so
		// several notes legitimately hold it and none of them is necessarily ours.
		// Refusing there would make the window unusable in any vault carrying two
		// releases of one framework.
		//
		// REALIGNED for AM-30 + AM-36 (2026-09-01), not weakened. The claim under
		// test is unchanged and is asserted more strongly than before: no refusal.
		// What changed is where the write lands. This declaration used to require a
		// note to be CREATED at today's rendered address, which was the pre-AM-30
		// answer, reached because the lookup was a recomputed identifier that matched
		// nothing. Under AM-30 the lookup is the pair, and `old a.md` records exactly
		// this control and this evidence — so it IS the link and it is updated where
		// it sits (the sibling declaration `does not relocate the note it found`
		// pins that rule directly). AM-36 is what keeps the refusal off it.
		const { app, files } = makeVault();
		const legacyCurie = legacyEvidenceLinkCurie(R4.path, EVIDENCE);
		files.set(`${FOLDER}/old a.md`, junction({ curie: legacyCurie, control: R4 }));
		const bBefore = junction({ curie: legacyCurie, control: R5 });
		files.set(`${FOLDER}/old b.md`, bBefore);

		await pressCreateLink(app, R4);

		expect(said()).not.toContain('Could not create the link');
		expect(said()).toContain('Updated the existing link');
		expect(said()).toContain(`${FOLDER}/old a.md`);
		// The other release's link is untouched and no third note was written.
		expect(files.get(`${FOLDER}/old b.md`)).toBe(bBefore);
		expect(files.has(pathFor(R4))).toBe(false);
		expect(files.size).toBe(2);
	});

	it('does not open a note when it refused to write anything', async () => {
		const { app, files, opened } = makeVault();
		files.set(`${FOLDER}/claimant a.md`, junction({ curie: curieFor(R4), control: R4 }));
		files.set(`${FOLDER}/claimant b.md`, junction({ curie: curieFor(R4), control: R4 }));
		await pressCreateLink(app, R4);
		expect(opened).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AM-30: a junction's curie is minted once. Existence is answered by the pair.
//
// THE DEFECT PASS 11 CONFIRMED. `evidenceLinkCurie` is a function of the evidence
// document's vault path in both halves — the readable head and the pair hash — and
// that function was being used as a LOOKUP KEY on every click. So: link a control
// to `Evidence/pentest.md`, move the document to `Evidence/2026/pentest.md`, click
// again for the same real pair. The key changed, the address changed, and the
// pre-AM-22 basename form matched only notes written before that scheme. Nothing
// found the junction that plainly existed, and a SECOND note was written for the
// pair — double-counted by every coverage tally, with the reviewer's approval and
// prose left on the abandoned one.
//
// A path may seed a mint; it may never be needed again after it. So the question
// is put to the notes: a junction SAYS which subject and which object it is about,
// and that statement is a recorded fact that survives every rename.
// ---------------------------------------------------------------------------

describe('AM-30: moving the evidence document does not manufacture a second link', () => {
	const MOVED = 'Evidence/2026/MFA policy.md';

	/**
	 * The user drags the document into a subfolder. Obsidian rewrites wikilinks
	 * pointing at it, which is its default, so the junction now records the new
	 * path. Both this and the un-rewritten case below must find the same note.
	 */
	function moveEvidence(files: Map<string, string>, rewriteLinks: boolean): void {
		for (const [path, text] of [...files]) {
			if (!rewriteLinks) continue;
			files.set(path, text.split(EVIDENCE).join(MOVED));
		}
	}

	it('finds and updates the junction it just wrote, keeping the identity it minted', async () => {
		// The mint is stamped once. Recomputing it here is what produced the twin.
		const { app, files } = makeVault();
		await pressCreateLink(app, R4);
		const junctionPath = pathFor(R4);
		const minted = curieFor(R4);
		moveEvidence(files, true);
		notices.length = 0;

		await pressCreateLink(app, R4, MOVED);

		expect(files.size).toBe(1);
		expect(files.get(junctionPath)).toContain(`curie: ${minted}`);
		expect(said()).toContain('Updated the existing link');
	});

	it('proves the recomputed identity really did move, so the test above is not vacuous', () => {
		// If the mint happened to be stable across the move, every assertion in this
		// block would pass for the wrong reason. It is not stable: the pair hash and
		// the readable head both take the document's path.
		expect(curieFor(R4, MOVED)).not.toBe(curieFor(R4));
		expect(pathFor(R4, MOVED)).not.toBe(pathFor(R4));
	});

	it('finds it even when the recorded wikilink was never rewritten', async () => {
		// The harder half: the note still records the OLD path. Obsidian's own link
		// resolution follows the document, so the recorded statement still names it.
		const { app, files } = makeVault();
		await pressCreateLink(app, R4);
		const junctionPath = pathFor(R4);
		const minted = curieFor(R4);
		moveEvidence(files, false);
		files.set(MOVED, '# MFA policy\n');
		notices.length = 0;

		await pressCreateLink(app, R4, MOVED);

		expect(files.size).toBe(2);
		expect(files.get(junctionPath)).toContain(`curie: ${minted}`);
		expect(said()).toContain('Updated the existing link');
	});

	it('finds an AM-22-era junction after the document moved', async () => {
		// Seeded as the window wrote it between AM-22 and AM-30: the pair-hashed
		// curie at the pair-hashed address. Both were functions of the old path.
		const { app, files } = makeVault();
		files.set(pathFor(R4), junction({ curie: curieFor(R4), control: R4 }));
		files.set(MOVED, '# MFA policy\n');
		moveEvidence(files, true);

		await pressCreateLink(app, R4, MOVED);

		const junctions = [...files.keys()].filter((path) => path.startsWith(`${FOLDER}/`));
		expect(junctions).toHaveLength(1);
		expect(files.get(pathFor(R4))).toContain(`curie: ${curieFor(R4)}`);
		expect(said()).toContain('Updated the existing link');
	});

	it('finds a pre-AM-22 junction after the document moved', async () => {
		// The oldest era: a basename-derived curie, no provenance block, invisible to
		// the identity index. It still records the pair.
		const { app, files } = makeVault();
		const legacyCurie = legacyEvidenceLinkCurie(R4.path, EVIDENCE);
		const legacyPath = legacyEvidenceLinkPath(FOLDER, R4.path, EVIDENCE);
		files.set(legacyPath, junction({ curie: legacyCurie, control: R4, setId: null }));
		files.set(MOVED, '# MFA policy\n');
		moveEvidence(files, true);

		await pressCreateLink(app, R4, MOVED);

		const junctions = [...files.keys()].filter((path) => path.startsWith(`${FOLDER}/`));
		expect(junctions).toHaveLength(1);
		expect(files.get(legacyPath)).toContain(`curie: ${legacyCurie}`);
		expect(said()).toContain('Updated the existing link');
	});

	it('never leaves two notes recording one real pair, whatever era the first was', async () => {
		// The consequence, stated as the property rather than as a path. A second
		// junction for one pair is counted twice by every coverage tally, and the
		// first is silently abandoned with its approval on it.
		for (const seed of ['mint', 'am22', 'legacy'] as const) {
			const { app, files } = makeVault();
			if (seed === 'mint') await pressCreateLink(app, R4);
			if (seed === 'am22') files.set(pathFor(R4), junction({ curie: curieFor(R4), control: R4 }));
			if (seed === 'legacy') {
				files.set(
					legacyEvidenceLinkPath(FOLDER, R4.path, EVIDENCE),
					junction({ curie: legacyEvidenceLinkCurie(R4.path, EVIDENCE), control: R4, setId: null }),
				);
			}
			files.set(MOVED, '# MFA policy\n');
			moveEvidence(files, true);

			await pressCreateLink(app, R4, MOVED);

			const junctions = [...files.keys()].filter((path) => path.startsWith(`${FOLDER}/`));
			expect({ seed, junctions: junctions.length }).toEqual({ seed, junctions: 1 });
		}
	});

	it('does not relocate the note it found to the address a mint would choose today', async () => {
		// The note IS the record. Moving it to today's rendered address would
		// re-couple its identity to a path, which is the coupling being removed.
		const { app, files } = makeVault();
		const renamed = `${FOLDER}/a name the reviewer chose.md`;
		files.set(renamed, junction({ curie: curieFor(R4), control: R4 }));
		files.set(MOVED, '# MFA policy\n');
		moveEvidence(files, true);

		await pressCreateLink(app, R4, MOVED);

		expect([...files.keys()].filter((path) => path.startsWith(`${FOLDER}/`))).toEqual([renamed]);
		expect(said()).toContain(renamed);
	});

	it('gives a junction that records the pair but no identity one now', async () => {
		// These exist: a link written before junction notes carried a curie at all.
		// Projection cannot see them. Nothing is being recomputed here — there is
		// nothing recorded to recompute, so a mint is the only honest answer.
		const { app, files } = makeVault();
		const bare = `${FOLDER}/no identity.md`;
		files.set(bare, junction({ curie: '', control: R4, setId: null }).replace('curie: ""\n', ''));

		await pressCreateLink(app, R4);

		expect(files.size).toBe(1);
		expect(files.get(bare)).toContain(`curie: ${curieFor(R4)}`);
		expect(said()).toContain('Updated the existing link');
	});
});

// ---------------------------------------------------------------------------
// AM-23: what is found is not always adoptable.
// ---------------------------------------------------------------------------

describe('AM-23: a note at the address that is not this link is refused by name', () => {
	it('refuses a foreign set\'s junction sitting at the expected address', async () => {
		// Identity said nothing holds this curie, so the address is now the
		// question — and the answer is a refusal that names the owning set, not an
		// overwrite.
		const { app, files } = makeVault();
		const foreign = junction({ curie: 'cwk:some-other-link', control: R5, setId: 'iset-aaaaaa' });
		files.set(pathFor(R4), foreign);

		await pressCreateLink(app, R4);

		expect(files.get(pathFor(R4))).toBe(foreign);
		expect(said()).toContain('Could not create the link');
		expect(said()).toContain('iset-aaaaaa');
	});

	it('refuses a note whose properties cannot be read, and never calls it a stranger\'s', async () => {
		// AM-19's rule at this site: nothing was established about the note, so
		// nothing may be claimed about it, and no destructive instruction attached.
		//
		// REALIGNED for AM-35 (2026-09-01), not weakened. The claim is the same and
		// the outcome is the same — nothing written, no cause invented, no
		// destructive instruction — but the refusal now comes from the PAIR SCAN
		// rather than from the address branch beneath it, because the scan reaches
		// every markdown file and a file it cannot read may be the very junction it
		// is looking for. Consequence worth recording: with the scan failing closed
		// first, the address branch's own unreadable refusal is no longer reachable
		// for a damaged markdown note. `tests/evidence-window-unreadable-and-pair.test.ts`
		// pins the new refusal directly.
		//
		// AM-43 (2026-09-02): and since the scan is now a separate step BEFORE
		// `create()`, this refusal is asserted on `pairRefusal`, not on a `Notice`.
		const { app, files } = makeVault();
		const damaged = note(': : :\ncurie: something');
		files.set(pathFor(R4), damaged);

		const modal = await resolveOnly(app, R4);

		expect(files.get(pathFor(R4))).toBe(damaged);
		expect(files.size).toBe(1);
		expect(modal.pairRefusal).toContain('could not be read');
		expect(modal.pairRefusal).toContain(pathFor(R4));
		expect(modal.pairRefusal).not.toContain("not Crosswalker's");
		expect(modal.pairRefusal).not.toContain('Move or rename');
	});
});
