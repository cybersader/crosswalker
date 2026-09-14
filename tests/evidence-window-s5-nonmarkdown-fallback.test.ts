/**
 * evidence-window-s5-nonmarkdown-fallback.test.ts -- S5 ruling (2026-09-04,
 * pass 16 ruling, implemented pass 17, Task C item 4): the S6 fallback index
 * is built from the vault's WHOLE file list, not `getMarkdownFiles()`, so a
 * non-markdown evidence document still resolves through it.
 *
 * THE DEFECT THIS PINS. An evidence document is the user's own file and is
 * routinely not a markdown note -- a PDF policy, a screenshot, an exported
 * spreadsheet. `create()` accepts one (the existence check at the top is a
 * warning, not a gate). `buildLinkFallbackIndex` used to walk
 * `app.vault.getMarkdownFiles()`: for a NON-markdown target, when the metadata
 * cache's link resolver has gone silent (a cold cache -- not yet indexed --
 * OR a recorded link whose text was never rewritten after the file moved) AND
 * the recorded link text is not byte-equal to the current path, the fallback
 * looked the file up in an index that never contained it, answered `false`,
 * and the pair scan concluded nothing records the pair -- minting a SECOND
 * junction for a pair that already has one. That is the exact error the whole
 * scan exists to prevent, closed for markdown and left open for every other
 * file type an evidence document actually is.
 *
 * THE RULE. `buildLinkFallbackIndex` walks `app.vault.getFiles()`.
 * `getMarkdownFiles()` is a strict subset of it and only the `.md` extension
 * is stripped for the basename bucket, so no markdown behaviour changes -- a
 * markdown file lands in the same two entries it always did; a PDF lands under
 * its FULL path AND its extension-carrying basename (`Policy.pdf`), which is
 * the form Obsidian itself resolves a non-markdown wikilink target by.
 *
 * THIS FILE'S MOCK DELIBERATELY FILTERS `getMarkdownFiles()` TO `.md` PATHS
 * ONLY -- unlike the shared vault stubs elsewhere in this suite (which return
 * every file for both methods and therefore cannot distinguish the two at
 * all) -- because that distinction is the entire thing under test here.
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
			// DELIBERATELY markdown-only -- the exact host contract S5's fix relies
			// on: a PDF (or any non-.md file) must be ABSENT here and present below.
			getMarkdownFiles: () => [...files.keys()].filter((p) => p.toLowerCase().endsWith('.md')).map((p) => new TFile(p)),
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
			// THE SILENT RESOLVER, unconditionally -- the state S6/S5 exist for: a
			// cache that has not finished indexing links yet answers null regardless
			// of what the vault actually contains, and a non-markdown file's link is
			// exactly the kind Obsidian is slowest to resolve.
			getFirstLinkpathDest: () => null,
		},
		workspace: {
			getLeaf: () => ({ openFile: async (file: { path: string }) => { opened.push(file.path); } }),
		},
	};
	return { app: app as unknown as App, files, opened };
}

const FOLDER = 'Evidence/Junctions';
const PDF_EVIDENCE = 'Evidence/Vendor Security Policy.pdf';
const R4: ControlCandidate = { path: 'Frameworks/NIST-r4/AC-2.md', title: 'AC-2', curie: 'nist:AC-2', reviewCid: null };

const pathFor = (c: ControlCandidate, evidence = PDF_EVIDENCE): string => evidenceLinkPath(FOLDER, c.curie, c.path, evidence);
const curieFor = (c: ControlCandidate, evidence = PDF_EVIDENCE): string => evidenceLinkCurie(c.curie, c.path, evidence);

const note = (frontmatter: string, body = 'Body.\n'): string => `---\n${frontmatter}\n---\n${body}`;

function junction(opts: { curie: string; control: ControlCandidate; objectLinkText: string }): string {
	const lines = [
		`curie: "${opts.curie}"`,
		'kind: junction-note',
		`subject: "[[${opts.control.path}|AC-2]]"`,
		`subject_curie: "${opts.control.curie}"`,
		'predicate: has_evidence',
		`object: "[[${opts.objectLinkText}|Vendor Security Policy]]"`,
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

async function pressCreateLink(app: App, control: ControlCandidate, evidence = PDF_EVIDENCE): Promise<ModalInternals> {
	const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
	modal.control = control;
	modal.evidencePath = evidence;
	await modal.resolvePair(control, evidence);
	await modal.create();
	return modal;
}

describe('S5: a non-markdown (PDF) evidence document resolves through the fallback, not just through getMarkdownFiles()', () => {
	it('updates the existing junction rather than minting a second one, though the resolver stays silent and the target is a PDF -- link text is the FULL PATH', async () => {
		const { app, files } = makeVault();
		files.set(PDF_EVIDENCE, '%PDF-1.4 (not real bytes, just present in the vault)\n');
		const junctionPath = `${FOLDER}/the link.md`;
		files.set(junctionPath, junction({
			curie: curieFor(R4),
			control: R4,
			objectLinkText: PDF_EVIDENCE, // the full path form
		}));

		const modal = await pressCreateLink(app, R4);

		expect(modal.pairRefusal).toBeNull();
		expect(said()).toContain('Updated the existing link');
		expect(said()).not.toContain('Evidence link created');
		expect([...files.keys()].filter((p) => p.startsWith(`${FOLDER}/`))).toEqual([junctionPath]);
	});

	it('updates the existing junction when the recorded link is a BARE basename (WITH its non-.md extension, the form the vault-wide index preserves for a non-markdown file)', async () => {
		const { app, files } = makeVault();
		files.set(PDF_EVIDENCE, '%PDF-1.4\n');
		const junctionPath = `${FOLDER}/the link.md`;
		files.set(junctionPath, junction({
			curie: curieFor(R4),
			control: R4,
			// Only the .md extension is stripped when the fallback index is built
			// (S5's own doc comment), so a non-markdown file's basename bucket keeps
			// its extension -- this IS that bucket key.
			objectLinkText: 'Vendor Security Policy.pdf',
		}));

		const modal = await pressCreateLink(app, R4);

		expect(modal.pairRefusal).toBeNull();
		expect(said()).toContain('Updated the existing link');
		expect([...files.keys()].filter((p) => p.startsWith(`${FOLDER}/`))).toEqual([junctionPath]);
	});

	it('a dangling link naming no PDF at all is answered false, not guessed at -- a fresh mint is still the right outcome', async () => {
		const { app, files } = makeVault();
		files.set(PDF_EVIDENCE, '%PDF-1.4\n');
		const junctionPath = `${FOLDER}/the link.md`;
		files.set(junctionPath, junction({
			curie: curieFor(R4),
			control: R4,
			objectLinkText: 'Evidence/Some Other Document.pdf', // names nothing in this vault
		}));
		const before = new Map(files);

		const modal = await pressCreateLink(app, R4);

		expect(modal.pairRefusal).toBeNull();
		expect(said()).toContain('Evidence link created.');
		expect(files.get(junctionPath)).toBe(before.get(junctionPath)); // the old note is untouched
		expect(files.has(pathFor(R4))).toBe(true); // a new note was minted for THIS pair
	});
});
