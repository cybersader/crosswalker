/**
 * evidence-window-am51-write-snapshot.test.ts -- AM-51 (2026-09-04, pass 17,
 * Task C item 1): the write captures the form once.
 *
 * THE DEFECT THIS PINS (pass-16 Ground 1 / CONFIRMED 1). AM-48 gave the LOOKUP
 * an owner (a generation token, so a stale lookup can never overwrite a
 * decision made after it started), but the WRITE reads `this.control` four
 * times, one of them across its own `await`: `create()` reaches
 * `readNoteFrontmatterState(this.app, controlFile)` only when the control's
 * `reviewCid` is cache-cold, so that read is disk I/O by construction, and the
 * control dropdown stayed LIVE and enabled throughout it. A reviewer who
 * switched the dropdown during that read got a junction whose SUBJECT was the
 * new control but whose `reviewed_against.review_cid` was the OLD control's
 * fingerprint -- a fact recorded against a control the reviewer had already
 * left, for a pair the scan never checked.
 *
 * THE RULE. `create()` snapshots every field it will write -- `control`,
 * `resolution`, `coverage`, `status`, `scope`, the act flag -- into locals
 * BESIDE the pair check, ABOVE the first `await`, and reads only those locals
 * below. The control dropdown, the evidence field and submit are disabled for
 * the duration of the write (a display of the fact, not the fact itself -- the
 * re-entry guard is the fact). After the write settles (or refuses without
 * closing the window), the pair is RE-RESOLVED rather than restored from
 * memory, so a second submit reads the vault as it now stands.
 *
 * HOW THIS FILE CONTROLS THE RACE. Same choke-point technique as
 * evidence-window-am48-generation-token.test.ts, moved one level down:
 * `app.vault.cachedRead` (preferred by `readNoteFrontmatterState` over `read`)
 * never resolves on its own here -- each call returns a promise the test
 * settles by hand, which is what lets the dropdown be switched WHILE the one
 * disk read inside `create()` is still pending.
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
 * `app.vault.cachedRead` never resolves on its own -- the test resolves each
 * call explicitly. `coldPaths` marks which files answer a cold (null) cache
 * entry, so a read of them goes to `cachedRead` and lands in `pendingReads`;
 * every other file's frontmatter is read straight from the cache, so
 * bookkeeping reads (the pair scan, `buildIdentityIndex`) do not add noise to
 * the one read this file cares about.
 */
function makeVault(coldPaths: Set<string>) {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const opened: string[] = [];
	const pendingReads: PendingRead[] = [];
	const frontmatterOf = (text: string): Record<string, unknown> | undefined => {
		const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
		if (!match) return undefined;
		try { return (yaml.load(match[1]) ?? {}) as Record<string, unknown>; }
		catch { return undefined; }
	};
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((p) => new TFile(p)),
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
			cachedRead: (file: { path: string }) => new Promise<string>((resolve) => {
				pendingReads.push({ path: file.path, resolve: () => resolve(files.get(file.path) ?? '') });
			}),
			createFolder: async (path: string) => { folders.add(path); },
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				if (coldPaths.has(file.path)) return null;
				const text = files.get(file.path);
				if (text === undefined) return null;
				const fm = frontmatterOf(text);
				return { frontmatter: fm };
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

/**
 * Resolve every pending read as it appears until `promise` settles -- used
 * for setup phases (the pair scan, the identity index) this file does not
 * mean to control by hand.
 */
async function drainWhileAwaiting<T>(pendingReads: PendingRead[], promise: Promise<T>): Promise<T> {
	let settled = false;
	void promise.then(() => { settled = true; }, () => { settled = true; });
	while (!settled) {
		if (pendingReads.length > 0) pendingReads.shift()!.resolve();
		await Promise.resolve();
	}
	return promise;
}

const FOLDER = 'Evidence/Junctions';
const EVIDENCE = 'Evidence/MFA policy.md';
const CTRL_A: ControlCandidate = { path: 'Frameworks/A.md', title: 'A', curie: 'nist:A', reviewCid: null };
const CTRL_B: ControlCandidate = { path: 'Frameworks/B.md', title: 'B', curie: 'nist:B', reviewCid: null };

const pathFor = (c: ControlCandidate, evidence = EVIDENCE): string => evidenceLinkPath(FOLDER, c.curie, c.path, evidence);
const curieFor = (c: ControlCandidate, evidence = EVIDENCE): string => evidenceLinkCurie(c.curie, c.path, evidence);

const note = (frontmatter: string, body = 'Body.\n'): string => `---\n${frontmatter}\n---\n${body}`;
const frontmatterOfWritten = (text: string): Record<string, unknown> => {
	const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	return match ? (yaml.load(match[1]) as Record<string, unknown>) : {};
};

interface ModalInternals {
	control: ControlCandidate | null;
	evidencePath: string;
	coverage: string;
	status: string;
	statusSetInThisWindow: boolean;
	evidenceScope: string;
	resolution: unknown;
	writing: boolean;
	closed: boolean;
	resolvePair(control: ControlCandidate, evidencePath: string): Promise<void>;
	create(): Promise<void>;
}

// ---------------------------------------------------------------------------

describe('AM-51: the write captures the form once, beside the pair check, above the first await', () => {
	it('a control switched mid-write never contaminates the junction: it is minted for the ORIGINAL control, with its own fingerprint', async () => {
		const coldPaths = new Set([CTRL_A.path, CTRL_B.path]);
		const { app, files, pendingReads } = makeVault(coldPaths);
		files.set(CTRL_A.path, note(`curie: "${CTRL_A.curie}"\n_crosswalker:\n  review_cid: "cid-A-disk"`));
		files.set(CTRL_B.path, note(`curie: "${CTRL_B.curie}"\n_crosswalker:\n  review_cid: "cid-B-disk"`));
		files.set(EVIDENCE, 'Evidence body.\n');

		const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
		modal.control = CTRL_A;
		modal.evidencePath = EVIDENCE;

		// Setup: resolve the pair (mint case -- no existing junction). Every read
		// this needs (the junction scan, the identity index) is drained away; only
		// the read inside `create()` itself is meant to be observed.
		await drainWhileAwaiting(pendingReads, modal.resolvePair(CTRL_A, EVIDENCE));
		expect(pendingReads).toHaveLength(0);

		modal.coverage = 'full';
		modal.status = 'approved';
		modal.statusSetInThisWindow = true; // AM-41: the act, which is what reaches the reviewCid branch.

		// Click "Create link". `create()` runs synchronously up to its one real
		// await -- the disk read of the control's OWN frontmatter, reached only
		// because CTRL_A.reviewCid is null (cache-cold) -- and returns a pending
		// promise there.
		const writePromise = modal.create();
		await untilPendingReads(pendingReads, 1);
		expect(pendingReads[0].path).toBe(CTRL_A.path);

		// THE RACE: the reviewer switches the dropdown to B while A's disk read is
		// still in flight. This is exactly what `controlDrop.onChange` does.
		modal.control = CTRL_B;

		// A's read finally lands.
		pendingReads[0].resolve();
		await writePromise;

		expect(said()).toContain('Evidence link created.');

		// Exactly one junction, at A's address -- never B's.
		const underFolder = [...files.keys()].filter((p) => p.startsWith(`${FOLDER}/`));
		expect(underFolder).toEqual([pathFor(CTRL_A)]);
		expect(files.has(pathFor(CTRL_B))).toBe(false);

		const written = frontmatterOfWritten(files.get(pathFor(CTRL_A))!);
		// Subject is A, minted with A's identity -- never mixed with B's.
		expect(written.subject_curie).toBe(CTRL_A.curie);
		expect(written.subject).toContain(CTRL_A.path);
		expect(written.curie).toBe(curieFor(CTRL_A));
		// The fingerprint came from the read A's OWN await produced, never B's.
		const reviewedAgainst = written.reviewed_against as Record<string, unknown>;
		expect(reviewedAgainst.curie).toBe(CTRL_A.curie);
		expect(reviewedAgainst.review_cid).toBe('cid-A-disk');

		// Drain whatever the finally block's re-resolve (now for B, the currently
		// selected control) started, so nothing is left dangling.
		for (let i = 0; i < 50 && pendingReads.length === 0; i++) await Promise.resolve();
		while (pendingReads.length > 0) { pendingReads.shift()!.resolve(); await Promise.resolve(); }
	});

	it('a second click while a write is in flight is a no-op: no second read, no second file, no second notice', async () => {
		const coldPaths = new Set([CTRL_A.path]);
		const { app, files, pendingReads } = makeVault(coldPaths);
		files.set(CTRL_A.path, note(`curie: "${CTRL_A.curie}"\n_crosswalker:\n  review_cid: "cid-A-disk"`));
		files.set(EVIDENCE, 'Evidence body.\n');

		const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
		modal.control = CTRL_A;
		modal.evidencePath = EVIDENCE;
		await drainWhileAwaiting(pendingReads, modal.resolvePair(CTRL_A, EVIDENCE));
		expect(pendingReads).toHaveLength(0);

		modal.coverage = 'full';
		modal.status = 'approved';
		modal.statusSetInThisWindow = true;

		// First click. `create()` runs synchronously up to the disk-read await,
		// setting `writing = true` BEFORE it yields.
		const p1 = modal.create();
		expect(modal.writing).toBe(true);

		// Second click, dispatched before the button's disabled state could even
		// paint (or a test driving `create()` directly). The re-entry guard is the
		// first statement in `create()`, so this must return without starting a
		// second lookup of any kind.
		const p2 = modal.create();
		await p2;

		expect(pendingReads).toHaveLength(1); // still only p1's read
		expect(pendingReads[0].path).toBe(CTRL_A.path);
		expect([...files.keys()].filter((p) => p.startsWith(`${FOLDER}/`))).toEqual([]); // nothing written yet

		// Finish p1.
		pendingReads[0].resolve();
		await p1;

		expect(said()).toBe('Evidence link created.'); // exactly one notice, not two
		expect([...files.keys()].filter((p) => p.startsWith(`${FOLDER}/`))).toEqual([pathFor(CTRL_A)]);

		while (pendingReads.length > 0) { pendingReads.shift()!.resolve(); await Promise.resolve(); }
	});

	it('a refusal that does not close the window releases the lock and RE-RESOLVES the pair, rather than leaving the form stale', async () => {
		// No cold paths here: this test isolates the lock/re-resolve mechanism
		// from the reviewCid disk-read branch (status stays 'proposed', so
		// `attesting` is false and that branch never runs).
		const { app, files, pendingReads } = makeVault(new Set());
		files.set(CTRL_A.path, note(`curie: "${CTRL_A.curie}"\n_crosswalker:\n  review_cid: "cid-A-disk"`));
		files.set(EVIDENCE, 'Evidence body.\n');
		// A foreign note already occupies the address this mint would choose --
		// the refusal branch that returns WITHOUT setting `this.closed`.
		const targetPath = pathFor(CTRL_A);
		files.set(targetPath, 'Not one of ours.\n');

		const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
		modal.control = CTRL_A;
		modal.evidencePath = EVIDENCE;
		await drainWhileAwaiting(pendingReads, modal.resolvePair(CTRL_A, EVIDENCE));
		modal.coverage = 'full';
		// Captured BEFORE the write, by OBJECT IDENTITY -- `resolvePair` builds a
		// fresh `PairResolution` object every time it runs, so "the pair was
		// re-resolved" is provable only against a DIFFERENT object, never merely
		// "resolution is non-null" (which a stale, never-cleared value from
		// before the write would also satisfy here, since nothing this refusal
		// path changed on disk would visibly distinguish a fresh answer from a
		// stale one by content alone).
		const resolutionBeforeWrite = modal.resolution;
		expect(resolutionBeforeWrite).not.toBeNull();

		await modal.create();
		expect(said()).toContain('Could not create the link');
		expect(modal.closed).toBe(false);

		// THE LOCK: released even though the write refused rather than succeeded.
		expect(modal.writing).toBe(false);

		// THE RE-RESOLVE: `finally` set `resolution = null` and called
		// `pairChanged()` again, which fires a fresh `resolvePair`
		// (fire-and-forget -- `create()` does not hold a handle to it, exactly
		// like the real dropdown's own `onChange`). Any read it makes still goes
		// through the same held-open `cachedRead`, so it is drained the same way.
		// Waited for by OBJECT IDENTITY, not mere non-nullness: `finally`
		// skipped entirely would leave `this.resolution` holding the SAME
		// pre-write object forever, which is non-null and would make a weaker
		// assertion here pass for the wrong reason.
		for (let i = 0; i < 200 && (modal.resolution === null || modal.resolution === resolutionBeforeWrite); i++) {
			if (pendingReads.length > 0) pendingReads.shift()!.resolve();
			await Promise.resolve();
		}
		expect(modal.resolution).not.toBeNull();
		expect(modal.resolution).not.toBe(resolutionBeforeWrite);

		// And the window is genuinely usable again: a second click reaches the
		// SAME refusal cleanly, rather than doing nothing because the lock never
		// let go.
		notices.length = 0;
		await modal.create();
		expect(said()).toContain('Could not create the link');
	});
});
