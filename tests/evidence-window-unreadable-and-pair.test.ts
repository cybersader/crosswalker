/**
 * evidence-window-unreadable-and-pair.test.ts — AM-35 and AM-36 (2026-09-01):
 * the pair scan fails closed, and the pair wins.
 *
 * AM-35 — ABSENCE IS NOT A FACT, eighth appearance. The scan that answers "which
 * note IS this link" read `readNoteFrontmatterState(...).state !== 'ok'` as
 * *continue*. `NoteFrontmatterRead` is a tri-state built for exactly this
 * distinction: `none` is a FACT about the file (it has no properties, so it is
 * not a junction) while `unreadable` is the ABSENCE of a fact (the bytes would
 * not read, or the properties block will not parse, so nothing at all is known,
 * including whether this is the very junction being looked for). Collapsing them
 * meant a junction whose YAML a hand edit damaged dropped silently out of the
 * answer, the window concluded that nothing recorded the pair, and it MINTED A
 * SECOND JUNCTION — the exact outcome the whole lookup exists to prevent,
 * produced by the rule the surrounding code cites. Everything else in that
 * window fails closed; that one line failed open into a mint.
 *
 * AM-36 — THE PAIR WINS. AM-30 made the pair scan the lookup, and the
 * contested-identity refusal beneath it then began firing on UPDATES. The
 * pre-AM-22 junction identifier was basename-derived and therefore never unique,
 * so two releases of one framework share it by construction: a reviewer clicking
 * "create link" on release 4 was refused because release 5's perfectly
 * legitimate link also holds that old identifier, and was told to delete it.
 * AM-30 does not repeal AM-23. When the pair scan names exactly one junction,
 * that note IS this link — positively identified by a fact it records — and
 * updating it under the identity it already carries adds no claimant, so a
 * pre-existing contest is neither caused nor worsened. A MINT is the real error
 * case: that identity is being introduced now, and introducing it onto an
 * existing claim is a collision this window would itself create.
 *
 * WHY A THIRD FILE. `evidence-window-ownership.test.ts` pins the DOOR (what
 * happens to whatever sits at the address); `evidence-window-identity.test.ts`
 * pins the LOOKUP (which note is this link). This one pins what the lookup does
 * when it CANNOT ANSWER, and what the guard beneath it may and may not refuse.
 */

import { TFile, TFolder } from 'obsidian';
import { EvidenceLinkModal, type ControlCandidate } from '../src/views/evidence-link-modal';
import { evidenceLinkCurie, evidenceLinkPath, legacyEvidenceLinkCurie } from '../src/views/evidence-link';
import type { App } from 'obsidian';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

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
	return { app: app as unknown as App, files, opened };
}

const FOLDER = 'Evidence/Junctions';
const EVIDENCE = 'Evidence/MFA policy.md';

/** Two releases of one framework: same control id and file name, different sets. */
const R4: ControlCandidate = { path: 'Frameworks/NIST-r4/AC-2.md', title: 'AC-2', curie: 'nist:AC-2', reviewCid: null };
const R5: ControlCandidate = { path: 'Frameworks/NIST-r5/AC-2.md', title: 'AC-2', curie: 'nist-iset-bbbbbb:AC-2', reviewCid: null };

const pathFor = (c: ControlCandidate, evidence = EVIDENCE): string => evidenceLinkPath(FOLDER, c.curie, c.path, evidence);
const curieFor = (c: ControlCandidate, evidence = EVIDENCE): string => evidenceLinkCurie(c.curie, c.path, evidence);

interface ModalInternals {
	control: ControlCandidate | null;
	evidencePath: string;
	pairRefusal: string | null;
	resolvePair(control: ControlCandidate, evidencePath: string): Promise<void>;
	create(): Promise<void>;
}

/**
 * AM-43 (2026-09-02): the pair lookup runs once, before `create()`, so it is
 * driven explicitly here rather than left for `create()` to discover it never
 * ran. `create()` is still exercised afterwards for the legitimate paths (a
 * pair the scan resolved, whether to an update or a mint) — see
 * `pairRefusalFor` below for the pair-scan-level refusal cases, which now
 * surface in `pairRefusal` rather than as a `Notice`.
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
 * (clearing `pairRefusal`) and shows a generic "Checking..." notice, which a
 * real UI never reaches because the submit button stays disabled while
 * `pairRefusal` is set.
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
function junction(opts: { curie: string; control: ControlCandidate; evidence?: string; setId?: string | null }): string {
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
	if (opts.setId !== null) lines.push('_crosswalker:', '  import_set:', `    id: ${opts.setId ?? 'iset-r4r4r4'}`);
	return note(lines.join('\n'), 'Reviewer prose that must survive.\n');
}

/** Properties that are present and will not parse. Not "no properties" — unreadable. */
const DAMAGED = note(': : :\ncurie: something');

// ---------------------------------------------------------------------------
// AM-35: the scan cannot answer, so nothing is written.
// ---------------------------------------------------------------------------

describe('AM-35: a junction whose properties cannot be read stops the link', () => {
	it('refuses, naming the file the user has to fix', async () => {
		// The note nothing could be read off MAY be the junction being looked for.
		// A refusal that does not say which file it is about is one the user cannot
		// act on, so the path is the load-bearing half of this message.
		//
		// AM-43 (2026-09-02): this refusal now lives in the pair lookup, run once
		// BEFORE `create()` — the submit button stays disabled while it is set, so
		// a real UI never reaches `create()` here. It is asserted on `pairRefusal`
		// rather than on a `Notice`.
		const { app, files } = makeVault();
		const damagedPath = `${FOLDER}/damaged.md`;
		files.set(damagedPath, DAMAGED);

		const modal = await resolveOnly(app, R4);

		expect(modal.pairRefusal).toContain(damagedPath);
		expect(modal.pairRefusal).toContain('could not be read');
		expect(files.has(pathFor(R4))).toBe(false);
	});

	it('writes nothing at all, so no second junction is minted for this pair', async () => {
		// THE defect. The damaged note dropped out of the answer, the window
		// concluded nothing recorded this pair, and it created a duplicate — with the
		// reviewer's approval and prose left on the one it could not see.
		const { app, files, opened } = makeVault();
		const damagedPath = `${FOLDER}/damaged.md`;
		files.set(damagedPath, DAMAGED);
		const before = new Map(files);

		await resolveOnly(app, R4);

		expect([...files.keys()].sort()).toEqual([...before.keys()].sort());
		expect(files.get(damagedPath)).toBe(DAMAGED);
		expect(files.has(pathFor(R4))).toBe(false);
		expect(opened).toEqual([]);
	});

	it('refuses even when the damaged note is nowhere near the address it would use', async () => {
		// The scan is vault-wide because the question is vault-wide: a junction the
		// user dragged anywhere still records this pair. So a note that cannot be
		// read anywhere in the vault is a note that might be it.
		const { app, files } = makeVault();
		files.set('Somewhere else/a damaged note.md', DAMAGED);

		const modal = await resolveOnly(app, R4);

		expect(modal.pairRefusal).toContain('Somewhere else/a damaged note.md');
		expect(files.has(pathFor(R4))).toBe(false);
	});

	it('does not accuse the user of anything, and attaches no destructive instruction', async () => {
		// AM-19's rule at this site: nothing was established about the note, so
		// nothing may be claimed about it. "Not Crosswalker's" and "move or rename
		// it" are both causes nothing supports.
		const { app, files } = makeVault();
		files.set(`${FOLDER}/damaged.md`, DAMAGED);

		const modal = await resolveOnly(app, R4);

		expect(modal.pairRefusal).not.toContain("not Crosswalker's");
		expect(modal.pairRefusal).not.toContain('Move or rename');
		expect(modal.pairRefusal).not.toContain('Delete');
	});

	it('keeps scanning past a note that has NO properties, which is a fact', async () => {
		// The other side of the tri-state, and the reason it is a tri-state. A file
		// with no properties block is not a junction, and saying so is knowledge, not
		// a guess. Treating it like an unreadable note would make the window refuse
		// in any vault containing one plain note — that is, every vault.
		const { app, files } = makeVault();
		files.set('Notes/A plain note.md', 'Just prose, no properties block.\n');

		await pressCreateLink(app, R4);

		expect(said()).toContain('Evidence link created.');
		expect(files.has(pathFor(R4))).toBe(true);
	});

	it('still finds the junction it is looking for when an unrelated note is merely empty', async () => {
		// The same fact, in the update direction: a plain note does not hide an
		// existing link.
		const { app, files } = makeVault();
		files.set(`${FOLDER}/the link.md`, junction({ curie: curieFor(R4), control: R4 }));
		files.set('Notes/A plain note.md', 'Just prose.\n');

		const modal = await pressCreateLink(app, R4);
		expect(modal.pairRefusal).toBeNull();

		expect(said()).toContain('Updated the existing link');
		expect([...files.keys()].filter((p) => p.startsWith(`${FOLDER}/`))).toEqual([`${FOLDER}/the link.md`]);
	});
});

// ---------------------------------------------------------------------------
// AM-36: the pair wins on an update; a mint is still guarded.
// ---------------------------------------------------------------------------

describe('AM-36: a contest over an identity the found junction already carries does not block its update', () => {
	const LEGACY = legacyEvidenceLinkCurie(R4.path, EVIDENCE);

	it('updates the link the pair names, though a second note holds the same legacy identifier', async () => {
		// The case AM-23 already ruled on and AM-30 accidentally reversed. The
		// pre-AM-22 identifier is basename-derived and therefore NOT unique, so two
		// releases of one framework share it by construction. `old b.md` is release
		// 5's legitimate link; refusing here blocks a reviewer over a state they did
		// not cause and tells them to delete a perfectly good note.
		const { app, files } = makeVault();
		files.set(`${FOLDER}/old a.md`, junction({ curie: LEGACY, control: R4 }));
		const bBefore = junction({ curie: LEGACY, control: R5 });
		files.set(`${FOLDER}/old b.md`, bBefore);

		await pressCreateLink(app, R4);

		expect(said()).not.toContain('Could not create the link');
		expect(said()).toContain('Updated the existing link');
		expect(said()).toContain(`${FOLDER}/old a.md`);
		// The other release's link is not touched, and no third note appears.
		expect(files.get(`${FOLDER}/old b.md`)).toBe(bBefore);
		expect([...files.keys()].filter((p) => p.startsWith(`${FOLDER}/`)).sort())
			.toEqual([`${FOLDER}/old a.md`, `${FOLDER}/old b.md`]);
	});

	it('leaves that note under the identity it already carries, adding no claimant', async () => {
		// The argument the scoping rests on, asserted rather than assumed: the update
		// does not restamp, so the number of notes claiming the contested identifier
		// is the same after as before. A refusal could only be justified if the
		// window were making the ambiguity worse.
		const { app, files } = makeVault();
		files.set(`${FOLDER}/old a.md`, junction({ curie: LEGACY, control: R4 }));
		files.set(`${FOLDER}/old b.md`, junction({ curie: LEGACY, control: R5 }));

		await pressCreateLink(app, R4);

		const holders = [...files.values()].filter((text) => {
			const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
			return match ? ((yaml.load(match[1]) ?? {}) as Record<string, unknown>).curie === LEGACY : false;
		});
		expect(holders).toHaveLength(2);
	});

	it('also does not block when the contested identifier is the CURRENT scheme, and this is a judgement call', async () => {
		// Recorded here explicitly because AM-36's second sentence ("the contested
		// refusal applies to the current injective identity only") reads two ways.
		// The implemented reading is that a MINT is what introduces the current
		// injective identity, so the refusal is scoped to a mint; the other reading
		// would refuse here, on the grounds that a contest over the current form is
		// always a real error even when the pair positively named the note.
		//
		// The declaration pins the behaviour that ships rather than either argument.
		// The same reasoning applies either way: this update restamps nothing and
		// adds no claimant, so the contest is exactly as bad afterwards as before.
		const { app, files } = makeVault();
		const shared = curieFor(R4);
		files.set(`${FOLDER}/the link.md`, junction({ curie: shared, control: R4 }));
		files.set(`${FOLDER}/an impostor.md`, junction({ curie: shared, control: R5 }));

		await pressCreateLink(app, R4);

		expect(said()).not.toContain('Could not create the link');
		expect(said()).toContain('Updated the existing link');
	});

	it('still refuses a MINT onto an identity another note already claims', async () => {
		// The half that stays. Nothing records this pair, so the window is
		// INTRODUCING this identity, and introducing it onto an existing claim is a
		// permanent `Ambiguous identity` collision this window would itself create.
		// The claimants deliberately record a different pair, so the scan does not
		// name them and the mint branch is the one under test.
		const { app, files } = makeVault();
		const minted = curieFor(R4);
		const a = `${FOLDER}/claimant a.md`;
		const b = `${FOLDER}/claimant b.md`;
		files.set(a, junction({ curie: minted, control: R5 }));
		files.set(b, junction({ curie: minted, control: R5 }));
		const before = new Map(files);

		await pressCreateLink(app, R4);

		expect(said()).toContain('Could not create the link');
		expect(said()).toContain(minted);
		expect([...files.keys()].sort()).toEqual([...before.keys()].sort());
		expect(files.get(a)).toBe(before.get(a));
		expect(files.get(b)).toBe(before.get(b));
	});

	it('refuses a MINT onto a single existing claimant too, and says so in the singular', async () => {
		// One claimant is the commoner shape and it used to be reported as "1 note
		// already claim the identity". A message that reads as broken English reads
		// as a bug, and a user who does not trust the message does not act on it.
		const { app, files } = makeVault();
		const minted = curieFor(R4);
		files.set(`${FOLDER}/claimant.md`, junction({ curie: minted, control: R5 }));

		await pressCreateLink(app, R4);

		expect(said()).toContain('1 note already claims the identity');
		expect(said()).not.toContain('1 note already claim the identity');
		expect(files.has(pathFor(R4))).toBe(false);
	});

	it('creates normally when nothing else claims the identity it is about to mint', async () => {
		// The control. A guard that refused every mint would satisfy the two
		// declarations above and make the window unable to create anything.
		const { app, files } = makeVault();
		files.set(`${FOLDER}/unrelated.md`, junction({ curie: 'cwk:something-else', control: R5 }));

		await pressCreateLink(app, R4);

		expect(said()).toContain('Evidence link created.');
		expect(files.has(pathFor(R4))).toBe(true);
	});
});
