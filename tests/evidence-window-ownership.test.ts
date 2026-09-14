/**
 * evidence-window-ownership.test.ts — AM-17 (2026-08-31): every writer of a
 * Crosswalker artifact passes the same door, not just the engine.
 *
 * THE STAKE. AM-14 closed the last unguarded route into a note INSIDE the
 * generation engine: a rendered address. The evidence-link window carried the
 * same code the engine had just been fixed of —
 *
 *     const existing = this.app.vault.getAbstractFileByPath(note.path);
 *     if (existing instanceof TFile) await this.app.vault.modify(existing, note.markdown);
 *
 * — `resolveWriteTarget`'s pre-AM-14 body, verbatim, on a different window. The
 * path is deterministic (`<evidence folder>/<control>--has_evidence--<evidence>.md`)
 * and the folder is a user SETTING, so pointing it at a folder that already
 * holds notes, or having any note whose basename matches that shape, replaced a
 * person's note in full while the notice said the link had been "updated".
 *
 * THE RULE, AND WHY IT IS AN IDENTITY TEST. The legitimate case here is "update
 * this link": the same control and the same evidence document, re-linked with a
 * different coverage or status. That pair has a stable curie, stamped by the
 * same function that builds the path, so the note already at the address may be
 * updated exactly when its own `curie` IS the junction being written. Anything
 * else there — another set's junction, a note from before import sets existed,
 * a person's note, a note nothing can be read off — is a named refusal through
 * the engine's own `addressRefusal` / `crossSetAddressMessage`, not a second
 * copy of the answer.
 */

import { TFile, TFolder } from 'obsidian';
import { EvidenceLinkModal, type ControlCandidate } from '../src/views/evidence-link-modal';
import { evidenceLinkCurie, evidenceLinkPath } from '../src/views/evidence-link';
import type { App } from 'obsidian';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

// ---------------------------------------------------------------------------
// Notices, swapped on the LIVE module object. Under esModuleInterop a namespace
// import would be a copy, and a spy on the copy would leave src/ calling the
// original — the same reason the D1 acceptance suite does this.
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

// ---------------------------------------------------------------------------
// Vault double. `getFileCache` mimics the real metadata cache: Obsidian does not
// index frontmatter it cannot parse, so a damaged note answers with none.
// ---------------------------------------------------------------------------

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
		},
		workspace: {
			getLeaf: () => ({ openFile: async (file: { path: string }) => { opened.push(file.path); } }),
		},
	};
	return { app: app as unknown as App, files, folders, opened };
}

const FOLDER = 'Evidence/Junctions';
const CONTROL: ControlCandidate = {
	path: 'Frameworks/NIST/AC-2.md',
	title: 'AC-2',
	curie: 'nist-800-53:AC-2',
	reviewCid: null,
};
const EVIDENCE = 'Evidence/MFA policy.md';
// AM-22 (2026-08-31): the pair's identity and address are functions of the
// CONTROL'S CURIE, not of its file name. Computed through the shipped functions
// rather than written out, so this file pins the window's behaviour and never a
// second opinion about what the identity is.
const LINK_PATH = evidenceLinkPath(FOLDER, CONTROL.curie, CONTROL.path, EVIDENCE);
const LINK_CURIE = evidenceLinkCurie(CONTROL.curie, CONTROL.path, EVIDENCE);

interface ModalInternals {
	control: ControlCandidate | null;
	evidencePath: string;
	coverage: string;
	status: string;
	pairRefusal: string | null;
	resolvePair(control: ControlCandidate, evidencePath: string): Promise<void>;
	create(): Promise<void>;
}

/**
 * Press "Create link" for the fixed control/evidence pair.
 *
 * Reaches the private handler rather than the button because the modal's DOM is
 * not the subject here; what is written to the vault is. The two fields set are
 * exactly the two the form collects.
 *
 * AM-43 (2026-09-02): the pair lookup is now a separate, awaited step —
 * `resolvePair` is driven directly, mirroring what the DOM's change/blur
 * handlers would trigger.
 */
async function pressCreateLink(app: App): Promise<ModalInternals> {
	const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
	modal.control = CONTROL;
	modal.evidencePath = EVIDENCE;
	await modal.resolvePair(CONTROL, EVIDENCE);
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
async function resolveOnly(app: App): Promise<ModalInternals> {
	const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
	modal.control = CONTROL;
	modal.evidencePath = EVIDENCE;
	await modal.resolvePair(CONTROL, EVIDENCE);
	return modal;
}

const note = (frontmatter: string, body = 'Body.\n'): string => `---\n${frontmatter}\n---\n${body}`;

// ---------------------------------------------------------------------------
// The legitimate cases. These are what the window is FOR, and a door that
// refuses them is worse than no door.
// ---------------------------------------------------------------------------

describe('the link the window is for', () => {
	it('creates the junction note when nothing is at that address', async () => {
		const { app, files } = makeVault();
		await pressCreateLink(app);
		expect(files.has(LINK_PATH)).toBe(true);
		expect(files.get(LINK_PATH)).toContain(`curie: ${LINK_CURIE}`);
		expect(said()).toContain('Evidence link created.');
	});

	it('updates its own link in place when the same pair is linked again', async () => {
		// One note per control/evidence pair is the whole point of the stable
		// path: two would be double-counted by any tally of links. The identity
		// door must not turn a legitimate re-link into a refusal.
		const { app, files } = makeVault();
		await pressCreateLink(app);
		const first = files.get(LINK_PATH)!;
		notices.length = 0;

		await pressCreateLink(app);
		expect(files.size).toBe(1);
		expect(said()).toContain('Updated the existing link');
		expect(said()).not.toContain('Could not create the link');
		// Same identity, rewritten content.
		expect(files.get(LINK_PATH)).toContain(`curie: ${LINK_CURIE}`);
		expect(typeof first).toBe('string');
	});

	it('updates a link written before import sets existed, which carries no ownership stamp', async () => {
		// A pre-2026-08-28 link carries no `_crosswalker` import_set block, so it is
		// invisible to the identity index. An ownership check that treated that
		// absence as "somebody else's" would refuse a note the window itself wrote.
		//
		// AM-30 (2026-08-31) changed what makes this note findable. It used to be
		// found by the curie this window would MINT today, which is a function of the
		// evidence document's vault path; it is now found by the pair it RECORDS,
		// which is what every version of `buildEvidenceLink` has written and what
		// survives a rename. The seed therefore carries the subject and object it
		// always had in a real vault — a note recording only a curie was never a
		// shape this window produced.
		const { app, files } = makeVault();
		files.set(LINK_PATH, note([
			`curie: ${LINK_CURIE}`,
			'kind: junction-note',
			`subject: "[[${CONTROL.path}|AC-2]]"`,
			`subject_curie: "${CONTROL.curie}"`,
			'predicate: has_evidence',
			`object: "[[${EVIDENCE}|MFA policy]]"`,
		].join('\n'), 'Old link.\n'));
		await pressCreateLink(app);
		expect(said()).toContain('Updated the existing link');
		expect(files.get(LINK_PATH)).toContain('has_evidence');
	});
});

// ---------------------------------------------------------------------------
// The refusals. Each names its own cause, and each leaves the file alone.
// ---------------------------------------------------------------------------

describe('what sits at that address, when it is not this link', () => {
	async function refuse(existing: string) {
		const { app, files } = makeVault();
		files.set(LINK_PATH, existing);
		const modal = await pressCreateLink(app);
		return { files, before: existing, modal };
	}

	/** Same shape, for a refusal that lives in the pair scan (see `resolveOnly`). */
	async function refuseAtScan(existing: string) {
		const { app, files } = makeVault();
		files.set(LINK_PATH, existing);
		const modal = await resolveOnly(app);
		return { files, before: existing, modal };
	}

	it('refuses another set\'s junction note, naming the set that owns it', async () => {
		// A different control/evidence pair whose sanitized basename collides, or
		// the same folder reused by a second import set. Either way it is not this
		// link, and merging into it would silently retarget somebody's evidence.
		const { files, before } = await refuse(note(
			'curie: "cwk:AC-3--has_evidence--Other policy"\nkind: junction-note\n'
			+ '_crosswalker:\n  import_set:\n    id: iset-aaaaaa',
		));
		expect(files.get(LINK_PATH)).toBe(before);
		expect(said()).toContain('Could not create the link');
		expect(said()).toContain('Cross-set address collision');
		expect(said()).toContain('iset-aaaaaa');
		expect(said()).not.toContain('Updated the existing link');
	});

	it('refuses a person\'s own note, and tells them to move it or change the folder', async () => {
		// The evidence link folder is a SETTING. Pointing it at a folder that
		// already holds notes is an ordinary thing to do, and the note that got
		// replaced was never recoverable.
		const { files, before } = await refuse(note('title: My own working note', 'Notes I typed.\n'));
		expect(files.get(LINK_PATH)).toBe(before);
		expect(said()).toContain("not Crosswalker's");
		expect(said()).toContain('Move or rename that note');
		expect(said()).not.toContain('Updated the existing link');
	});

	it('refuses a note it cannot read, and never calls it a stranger\'s', async () => {
		// AM-19's rule, at this window: the note may be one Crosswalker wrote and a
		// hand edit damaged. "Move or rename that note" would be a destructive
		// instruction attached to a cause nothing established.
		//
		// REALIGNED for AM-35 (2026-09-01), not weakened. Same claim, same outcome,
		// different refusing site: the pair scan now fails closed on an unreadable
		// note before the address is consulted, because that note may be the junction
		// being looked for. The message names the file and the action, so it is still
		// one a user can act on; it no longer speaks of importing again, because the
		// thing to fix is that note's properties.
		//
		// AM-43 (2026-09-02): the pair scan is vault-wide and runs BEFORE `create()`
		// now, so this refusal is asserted on `pairRefusal`, not on a `Notice` —
		// `create()` itself never got far enough to see this note (`resolution` is
		// null, so it only re-checked and reported "Checking...").
		const { files, before, modal } = await refuseAtScan(note(': : :\ncurie: something'));
		expect(files.get(LINK_PATH)).toBe(before);
		expect(modal.pairRefusal).toContain('could not be read');
		expect(modal.pairRefusal).toContain(LINK_PATH);
		expect(modal.pairRefusal).toContain('Fix that note');
		expect(modal.pairRefusal).not.toContain("not Crosswalker's");
		expect(modal.pairRefusal).not.toContain('Move or rename');
		expect(said()).not.toContain('Updated the existing link');
		expect(said()).not.toContain('Could not create the link');
	});

	it('refuses a note with no properties at all', async () => {
		const { files, before } = await refuse('Just prose, no properties block.\n');
		expect(files.get(LINK_PATH)).toBe(before);
		expect(said()).toContain("not Crosswalker's");
		expect(said()).not.toContain('Updated the existing link');
	});

	it('never opens a note it refused to write', async () => {
		// The window opens what it wrote. Opening a file it declined to touch
		// would read as success.
		const { app, files, opened } = makeVault();
		files.set(LINK_PATH, note('title: My own working note'));
		await pressCreateLink(app);
		expect(opened).toEqual([]);
	});
});
