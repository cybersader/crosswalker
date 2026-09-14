/**
 * evidence-window-am48-generation-token.test.ts — AM-48 (2026-09-04, pass 16,
 * Task C item 1): the form's contents have one owner.
 *
 * THE DEFECT THIS PINS (pass-15 Ground 2 / CONFIRMED 1). `resolvePair` used to
 * track its lifecycle with a single boolean (`resolving`), and `pairChanged`'s
 * early return fired only on a SETTLED resolution — during a lookup
 * `resolution` is null, so re-entering the same pair started a SECOND lookup.
 * Whichever lookup landed FIRST re-enabled the controls while the other was
 * still running. A reviewer selected Approved between the two landings; the
 * second (older-started, later-landing) lookup then ran its prefill
 * UNCONDITIONALLY, resetting `status` back to the note's own recorded value and
 * clearing `statusSetInThisWindow` — the act flag that is the sole authority
 * for writing `reviewed_against`. The write reported "Updated the existing
 * link", silently discarding the reviewer's decision.
 *
 * THE RULE. Every lookup captures a generation token at its start. Everything
 * that writes to the form's fields is gated behind ONE check: a lookup whose
 * token is no longer the latest discards its whole result — no control, no
 * flag, no resolution, and nothing re-enabled. `pairChanged` also records the
 * in-flight pair AT START (not only on settle), so re-entering the SAME pair
 * while its lookup is still running starts no second lookup at all.
 *
 * HOW THIS TEST CONTROLS THE RACE. `app.vault.read` is the one call
 * `readExistingNote` always makes (`src/generation/existing-note.ts`), so it is
 * the choke point held open here: each call returns a promise the test resolves
 * by hand, which is what lets an OLDER lookup be made to land AFTER a NEWER
 * one — the exact ordering the defect needed.
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

interface PendingRead { path: string; resolve: () => void }

/**
 * `app.vault.read` never resolves on its own — the test resolves each call
 * explicitly, in whatever order it chooses, which is what makes the two
 * overlapping lookups' landing order controllable rather than incidental.
 */
function makeVault() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const opened: string[] = [];
	const pendingReads: PendingRead[] = [];
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
			read: (file: { path: string }) => new Promise<string>((resolve) => {
				pendingReads.push({ path: file.path, resolve: () => resolve(files.get(file.path) ?? '') });
			}),
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
	return { app: app as unknown as App, files, opened, pendingReads };
}

/** Poll microtasks until `pendingReads` has grown to at least `n`, or give up. */
async function untilPendingReads(pendingReads: PendingRead[], n: number): Promise<void> {
	for (let i = 0; i < 200 && pendingReads.length < n; i++) await Promise.resolve();
	if (pendingReads.length < n) throw new Error(`expected ${n} pending reads, got ${pendingReads.length}`);
}

/** Let queued microtasks run without asserting anything grew. */
async function flush(ticks = 30): Promise<void> {
	for (let i = 0; i < ticks; i++) await Promise.resolve();
}

const FOLDER = 'Evidence/Junctions';
const EVIDENCE = 'Evidence/MFA policy.md';
const R4: ControlCandidate = { path: 'Frameworks/NIST-r4/AC-2.md', title: 'AC-2', curie: 'nist:AC-2', reviewCid: 'cid-nist-ac2' };

const pathFor = (c: ControlCandidate, evidence = EVIDENCE): string => evidenceLinkPath(FOLDER, c.curie, c.path, evidence);
const curieFor = (c: ControlCandidate, evidence = EVIDENCE): string => evidenceLinkCurie(c.curie, c.path, evidence);

const note = (frontmatter: string, body = 'Body.\n'): string => `---\n${frontmatter}\n---\n${body}`;

function junction(opts: { curie: string; control: ControlCandidate; status: string; evidence?: string }): string {
	const lines = [
		`curie: "${opts.curie}"`,
		'kind: junction-note',
		`subject: "[[${opts.control.path}|AC-2]]"`,
		`subject_curie: "${opts.control.curie}"`,
		'predicate: has_evidence',
		`object: "[[${opts.evidence ?? EVIDENCE}|MFA policy]]"`,
		'coverage: full',
		`status: ${opts.status}`,
		'reviewer: "A reviewer"',
	];
	return note(lines.join('\n'), 'Reviewer prose that must survive.\n');
}

interface ModalInternals {
	control: ControlCandidate | null;
	evidencePath: string;
	status: string;
	statusSetInThisWindow: boolean;
	resolution: { controlPath: string; evidencePath: string } | null;
	resolveToken: number;
	inFlightPair: { controlPath: string; evidencePath: string } | null;
	pairChanged(): void;
	resolvePair(control: ControlCandidate, evidencePath: string): Promise<void>;
	create(): Promise<void>;
}

// ---------------------------------------------------------------------------

describe('AM-48: a stale lookup can never overwrite a decision made after it started', () => {
	it('older lookup lands AFTER a newer one and after the reviewer approves; the approval and the act flag both survive', async () => {
		const { app, files, pendingReads } = makeVault();
		const junctionPath = `${FOLDER}/the link.md`;
		files.set(junctionPath, junction({ curie: curieFor(R4), control: R4, status: 'proposed' }));

		const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
		modal.control = R4;
		modal.evidencePath = EVIDENCE;

		// Lookup #1 — the OLDER one. Started first; held open on its read of the
		// existing note.
		const p1 = modal.resolvePair(R4, EVIDENCE);
		await untilPendingReads(pendingReads, 1);
		expect(modal.resolveToken).toBe(1);

		// Lookup #2 — the NEWER one, started while #1 is still in flight. Called
		// directly (bypassing `pairChanged`'s own in-flight dedup) so this test
		// isolates the token guard inside `resolvePair` itself — the mechanism
		// AM-48 actually added.
		const p2 = modal.resolvePair(R4, EVIDENCE);
		await untilPendingReads(pendingReads, 2);
		expect(modal.resolveToken).toBe(2);

		// #2 lands FIRST — the ordinary prefill, from the note's own "proposed".
		pendingReads[1].resolve();
		await p2;
		expect(modal.status).toBe('proposed');
		expect(modal.statusSetInThisWindow).toBe(false);
		expect(modal.resolution).not.toBeNull();

		// Between the two lookups landing, the reviewer acts: selects Approved.
		// This is exactly what the Status dropdown's own onChange handler does.
		modal.status = 'approved';
		modal.statusSetInThisWindow = true;

		// #1 — the STALE one — finally lands.
		pendingReads[0].resolve();
		await p1;

		// The stale lookup touched nothing: the reviewer's selection and the act
		// flag both survive it.
		expect(modal.status).toBe('approved');
		expect(modal.statusSetInThisWindow).toBe(true);
		expect(modal.resolution?.evidencePath).toBe(EVIDENCE);

		await modal.create();

		expect(said()).toContain('Updated the existing link');
		const written = files.get(junctionPath)!;
		const match = /^---\n([\s\S]*?)\n---/.exec(written.replace(/\r\n/g, '\n'));
		const fm = yaml.load(match![1]) as Record<string, unknown>;
		expect(fm.status).toBe('approved');
		// The act flag being set is what authorises writing a baseline at all.
		expect(fm.reviewed_against).toBeDefined();
		// Exactly one note for this pair — the stale lookup did not, in landing,
		// cause a second write of any kind.
		expect([...files.keys()].filter((p) => p.startsWith(`${FOLDER}/`))).toEqual([junctionPath]);
	});

	it('re-entering the same pair while its lookup is still running starts no second lookup', async () => {
		const { app, files, pendingReads } = makeVault();
		// An existing junction so the lookup actually reaches `readExistingNote`
		// (and therefore `app.vault.read`, this test's choke point) rather than
		// resolving with nothing to read and no pending read to observe.
		files.set(`${FOLDER}/the link.md`, junction({ curie: curieFor(R4), control: R4, status: 'proposed' }));
		const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
		modal.control = R4;
		modal.evidencePath = EVIDENCE;

		modal.pairChanged();
		// AM-48: recorded at START, synchronously, before any await — this is
		// what stops a second call from ever reaching `resolvePair`.
		expect(modal.inFlightPair).toEqual({ controlPath: R4.path, evidencePath: EVIDENCE });
		const tokenAfterFirst = modal.resolveToken;

		// The ordinary UI trigger this guards against: the evidence field's blur
		// handler fires again for the SAME pair while the first lookup is still
		// running (type, click away, click back, click away).
		modal.pairChanged();
		expect(modal.resolveToken).toBe(tokenAfterFirst);

		await untilPendingReads(pendingReads, 1);
		// Give a wrongly-started second lookup every chance to register its own
		// read before asserting there is only the one.
		await flush(30);
		expect(pendingReads).toHaveLength(1);
		expect(modal.resolveToken).toBe(tokenAfterFirst);

		pendingReads[0].resolve();
	});
});
