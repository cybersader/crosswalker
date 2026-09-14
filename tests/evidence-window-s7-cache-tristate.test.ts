/**
 * evidence-window-s7-cache-tristate.test.ts -- S7 (2026-09-04, pass 16, Task C
 * header item, S4..S7): the one retired `!getFileCache` discriminator is
 * removed from the control's review-cid backfill, routed through the tri-state
 * reader like every other fail-closed read in this file.
 *
 * THE DEFECT THIS PINS. `!this.app.metadataCache.getFileCache(controlFile)`
 * treats a cache ENTRY that EXISTS but carries no `frontmatter` the same as no
 * entry at all -- both read as "already answered, nothing to fetch" -- and
 * skipped the disk read that would have found the control's actual
 * `review_cid`. That is the SAME rule `project_cache_lag_is_not_absence`
 * names one level up: absence of a populated cache entry is not absence of
 * properties on disk, and treating it as absence stamped a control with "no
 * baseline" though it had a perfectly good fingerprint the cache simply had
 * not surfaced yet.
 *
 * THE RULE. The control's fingerprint read goes through
 * `readNoteFrontmatterState`, the tri-state (`ok` / `none` / `unreadable`)
 * this repo settled on 2026-09-02 (SUSPECTED 8): it accepts a cache entry only
 * when it actually carries properties, and reads the file otherwise -- so a
 * cache entry that exists but is empty no longer skips the disk read, and
 * costs nothing when the cache HAS already answered.
 */

import { TFile, TFolder } from 'obsidian';
import { EvidenceLinkModal, type ControlCandidate } from '../src/views/evidence-link-modal';
import { evidenceLinkPath } from '../src/views/evidence-link';
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
	const cacheOverrides = new Map<string, { frontmatter: Record<string, unknown> | undefined } | null>();
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
				if (cacheOverrides.has(file.path)) return cacheOverrides.get(file.path);
				const text = files.get(file.path);
				if (text === undefined) return null;
				const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
				if (!match) return { frontmatter: undefined };
				try { return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> }; }
				catch { return { frontmatter: undefined }; }
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
		workspace: { getLeaf: () => ({ openFile: async () => undefined }) },
	};
	return { app: app as unknown as App, files, cacheOverrides };
}

const FOLDER = 'Evidence/Junctions';
const EVIDENCE = 'Evidence/MFA policy.md';
const CONTROL_PATH = 'Frameworks/NIST-r4/AC-2.md';
const R4: ControlCandidate = { path: CONTROL_PATH, title: 'AC-2', curie: 'nist:AC-2', reviewCid: null };

const pathFor = (c: ControlCandidate, evidence = EVIDENCE): string => evidenceLinkPath(FOLDER, c.curie, c.path, evidence);

const note = (frontmatter: string, body = 'Body.\n'): string => `---\n${frontmatter}\n---\n${body}`;

interface ModalInternals {
	control: ControlCandidate | null;
	evidencePath: string;
	status: string;
	statusSetInThisWindow: boolean;
	resolvePair(control: ControlCandidate, evidencePath: string): Promise<void>;
	create(): Promise<void>;
}

describe('S7: a cache entry present but carrying no frontmatter still falls through to a disk read', () => {
	it('the control\'s review_cid is read off disk, though the cache entry EXISTS and is empty', async () => {
		const { app, files, cacheOverrides } = makeVault();
		files.set(EVIDENCE, 'Evidence body.\n');
		files.set(CONTROL_PATH, note('curie: "nist:AC-2"\n_crosswalker:\n  review_cid: "cid-from-disk"', 'Control body.\n'));
		// A cache entry that EXISTS but carries no frontmatter -- the retired
		// discriminator (`!getFileCache`) reads an object here as "already
		// answered" and never reaches the disk.
		cacheOverrides.set(CONTROL_PATH, { frontmatter: undefined });

		const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
		modal.control = R4;
		modal.evidencePath = EVIDENCE;
		await modal.resolvePair(R4, EVIDENCE);
		modal.status = 'approved';
		modal.statusSetInThisWindow = true;
		await modal.create();

		expect(said()).not.toContain('still reading this control');
		expect(said()).not.toContain('This control has no content fingerprint');
		const written = files.get(pathFor(R4))!;
		const match = /^---\n([\s\S]*?)\n---/.exec(written.replace(/\r\n/g, '\n'));
		const fm = yaml.load(match![1]) as Record<string, unknown>;
		const against = fm.reviewed_against as Record<string, unknown> | undefined;
		expect(against?.review_cid).toBe('cid-from-disk');
	});

	it('a control with NO properties at all still states the fact plainly -- \'none\' needs no disk read and no false cause', async () => {
		const { app, files } = makeVault();
		files.set(EVIDENCE, 'Evidence body.\n');
		files.set(CONTROL_PATH, 'Just prose, no properties block.\n');

		const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
		modal.control = R4;
		modal.evidencePath = EVIDENCE;
		await modal.resolvePair(R4, EVIDENCE);
		modal.status = 'approved';
		modal.statusSetInThisWindow = true;
		await modal.create();

		expect(said()).toContain('This control has no content fingerprint');
		expect(said()).not.toContain('still reading this control');
	});
});
