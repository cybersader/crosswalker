/**
 * evidence-window-s6-link-fallback.test.ts -- S6 (2026-09-04, pass 16, Task C
 * item 6): a silent link resolver falls back to the vault's own file list
 * before the pair scan concludes, so an existing junction is updated rather
 * than duplicated.
 *
 * THE DEFECT THIS PINS. `getFirstLinkpathDest` was the LAST cache-only read on
 * the command -> window -> write path. A null answer used to be read as the
 * FACT "this junction does not name the pair," when it is not a fact: it is
 * either that, or the resolver has not been built yet (a cold cache -- see
 * `project_cache_lag_is_not_absence`). A junction dropped from the scan for
 * the second reason leaves the scan reporting that nothing records the pair,
 * and the window then MINTS A SECOND JUNCTION for a pair that already has one
 * -- the exact error the whole scan exists to prevent.
 *
 * THE RULE. On a null resolver answer, the scan falls back to the vault's own
 * file list (`LinkFallbackIndex`) rather than concluding from silence. Three
 * link forms are answered: an exact path, a path without its extension, and a
 * BARE basename that exactly ONE file in the vault carries (a duplicated
 * basename is answered `false` -- Obsidian's own tie-break for that case is a
 * proximity rule this cannot reproduce, and guessing would put the scan back
 * to concluding from something it does not know).
 */

import { TFile, TFolder } from 'obsidian';
import { EvidenceLinkModal, type ControlCandidate } from '../src/views/evidence-link-modal';
import { evidenceLinkCurie, evidenceLinkPath } from '../src/views/evidence-link';
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
				try { return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> }; }
				catch { return { frontmatter: undefined }; }
			},
			// THE SILENT RESOLVER -- the state S6 exists for: the cache has not
			// finished indexing links yet, so every lookup returns null regardless
			// of what the vault actually contains.
			getFirstLinkpathDest: () => null,
		},
		workspace: {
			getLeaf: () => ({ openFile: async (file: { path: string }) => { opened.push(file.path); } }),
		},
	};
	return { app: app as unknown as App, files, opened };
}

const FOLDER = 'Evidence/Junctions';
const EVIDENCE = 'Evidence/MFA policy.md';
const R4: ControlCandidate = { path: 'Frameworks/NIST-r4/AC-2.md', title: 'AC-2', curie: 'nist:AC-2', reviewCid: null };

const pathFor = (c: ControlCandidate, evidence = EVIDENCE): string => evidenceLinkPath(FOLDER, c.curie, c.path, evidence);
const curieFor = (c: ControlCandidate, evidence = EVIDENCE): string => evidenceLinkCurie(c.curie, c.path, evidence);

const note = (frontmatter: string, body = 'Body.\n'): string => `---\n${frontmatter}\n---\n${body}`;

/** A junction whose OBJECT is recorded as a bare basename wikilink -- the
 *  shape exact-text matching alone cannot answer, and the shape this test's
 *  silent resolver cannot answer either. */
function junctionWithBareObjectLink(opts: { curie: string; control: ControlCandidate; objectLinkText: string }): string {
	const lines = [
		`curie: "${opts.curie}"`,
		'kind: junction-note',
		`subject: "[[${opts.control.path}|AC-2]]"`,
		`subject_curie: "${opts.control.curie}"`,
		'predicate: has_evidence',
		`object: "[[${opts.objectLinkText}|MFA policy]]"`,
		'coverage: full',
		'status: proposed',
		'reviewer: "A reviewer"',
	];
	return note(lines.join('\n'), 'Reviewer prose that must survive.\n');
}

interface ModalInternals {
	control: ControlCandidate | null;
	evidencePath: string;
	pairRefusal: string | null;
	resolvePair(control: ControlCandidate, evidencePath: string): Promise<void>;
	create(): Promise<void>;
}

async function pressCreateLink(app: App, control: ControlCandidate, evidence = EVIDENCE): Promise<ModalInternals> {
	const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
	modal.control = control;
	modal.evidencePath = evidence;
	await modal.resolvePair(control, evidence);
	await modal.create();
	return modal;
}

describe('S6: a null getFirstLinkpathDest falls back to the vault file list before the scan concludes', () => {
	it('updates the existing junction rather than minting a second one, though the resolver answers null throughout', async () => {
		const { app, files } = makeVault();
		files.set(EVIDENCE, 'Evidence body.\n');
		const junctionPath = `${FOLDER}/the link.md`;
		files.set(junctionPath, junctionWithBareObjectLink({
			curie: curieFor(R4),
			control: R4,
			objectLinkText: 'MFA policy', // bare basename -- exactly one file carries it
		}));

		const modal = await pressCreateLink(app, R4);

		expect(modal.pairRefusal).toBeNull();
		expect(said()).toContain('Updated the existing link');
		expect(said()).not.toContain('Evidence link created');
		// No second junction minted: the pre-existing note is still the only one
		// under FOLDER.
		expect([...files.keys()].filter((p) => p.startsWith(`${FOLDER}/`))).toEqual([junctionPath]);
		expect(files.has(pathFor(R4))).toBe(junctionPath === pathFor(R4));
	});

	it('a dangling bare-basename object link (names no file at all) is answered false, not guessed at', async () => {
		const { app, files } = makeVault();
		files.set(EVIDENCE, 'Evidence body.\n');
		const junctionPath = `${FOLDER}/the link.md`;
		files.set(junctionPath, junctionWithBareObjectLink({
			curie: curieFor(R4),
			control: R4,
			objectLinkText: 'Nonexistent evidence document',
		}));
		const before = new Map(files);

		// The recorded link names nothing in the vault, so this junction does NOT
		// name the pair -- the scan correctly finds no existing link, and a fresh
		// mint is the right outcome (never a false "update" of an unrelated note).
		const modal = await pressCreateLink(app, R4);

		expect(modal.pairRefusal).toBeNull();
		expect(said()).toContain('Evidence link created.');
		expect(files.get(junctionPath)).toBe(before.get(junctionPath)); // untouched
		expect(files.has(pathFor(R4))).toBe(true); // a new note was minted
	});

	it('a bare basename shared by two files in the vault is answered false -- an ambiguous tie-break is never guessed', async () => {
		const { app, files } = makeVault();
		// TWO files share the basename "MFA policy.md" -- Obsidian's own
		// tie-break for this is a proximity rule the vault file list cannot
		// reproduce.
		files.set('Evidence/MFA policy.md', 'Evidence body A.\n');
		files.set('Other/MFA policy.md', 'Evidence body B.\n');
		const junctionPath = `${FOLDER}/the link.md`;
		files.set(junctionPath, junctionWithBareObjectLink({
			curie: curieFor(R4),
			control: R4,
			objectLinkText: 'MFA policy',
		}));
		const before = new Map(files);

		// The scan cannot tell which "MFA policy.md" the junction is about, so it
		// does not name THIS pair (Evidence/MFA policy.md) -- a fresh mint for
		// this specific evidence path is the outcome, and the old note is left
		// alone rather than being guessed at and silently updated.
		const modal = await pressCreateLink(app, R4, 'Evidence/MFA policy.md');

		expect(modal.pairRefusal).toBeNull();
		expect(files.get(junctionPath)).toBe(before.get(junctionPath));
	});
});
