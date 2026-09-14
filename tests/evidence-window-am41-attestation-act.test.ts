/**
 * evidence-window-am41-attestation-act.test.ts — AM-41 (2026-09-02, pass 15,
 * Task C item 1): an attestation is an act; the window never re-performs one.
 *
 * THE DEFECT THIS PINS (pass-14 CONFIRMED 1). Before AM-41, `reviewed_against`
 * was `WINDOW_MANAGED_KEYS` and was rebuilt on every update from the CONTROL'S
 * CURRENT fingerprint, whatever the person actually touched. A reviewer
 * approved a link, the control was re-imported with changed wording (so its
 * fingerprint drifted and the drift query correctly flagged the link as needing
 * re-review), and a reviewer who opened the window only to fix the SCOPE — never
 * touching status — silently re-baselined the approval to the control's new
 * content. The notice said "Updated". That is a fabricated audit fact: the one
 * outcome the whole Ch 43 re-attestation mechanism exists to prevent.
 *
 * THE RULE (from the closing log). "A fact is recorded by the act that produced
 * it, never reconstructed from the state of the form that displays it."
 * `statusSetInThisWindow` is that act, set ONLY by the status dropdown's
 * `onChange`. Three outcomes:
 *   - status untouched            -> the note's OWN `reviewed_against` is carried
 *                                     byte-for-byte, whatever the control's
 *                                     fingerprint has become.
 *   - status set to `approved`    -> `reviewed_against` is written against the
 *                                     control's CURRENT fingerprint.
 *   - status set to anything else -> `reviewed_against` is REMOVED (a revoked
 *                                     approval has no baseline).
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
			getFirstLinkpathDest: () => null,
		},
		workspace: { getLeaf: () => ({ openFile: async () => undefined }) },
	};
	return { app: app as unknown as App, files };
}

const FOLDER = 'Evidence/Junctions';
const EVIDENCE = 'Evidence/MFA policy.md';
const OLD_CID = `sha256-${'a'.repeat(64)}`;
const NEW_CID = `sha256-${'b'.repeat(64)}`;

/** The control as it stands NOW — its fingerprint has drifted to NEW_CID. */
const CONTROL: ControlCandidate = {
	path: 'Frameworks/NIST/AC-2.md',
	title: 'AC-2',
	curie: 'nist:AC-2',
	reviewCid: NEW_CID,
};

const LINK_PATH = evidenceLinkPath(FOLDER, CONTROL.curie, CONTROL.path, EVIDENCE);
const LINK_CURIE = evidenceLinkCurie(CONTROL.curie, CONTROL.path, EVIDENCE);

interface ModalInternals {
	control: ControlCandidate | null;
	evidencePath: string;
	coverage: string;
	status: string;
	evidenceScope: string;
	statusSetInThisWindow: boolean;
	resolvePair(control: ControlCandidate, evidencePath: string): Promise<void>;
	create(): Promise<void>;
}

/** A junction already APPROVED against the control's OLD (pre-drift) fingerprint. */
function drifted(): string {
	return [
		'---',
		`curie: ${LINK_CURIE}`,
		'kind: junction-note',
		`subject: "[[${CONTROL.path}|AC-2]]"`,
		`subject_curie: "${CONTROL.curie}"`,
		'predicate: has_evidence',
		`object: "[[${EVIDENCE}|MFA policy]]"`,
		'coverage: full',
		'status: approved',
		'scope: "Original scope"',
		'reviewed_against:',
		`  curie: ${CONTROL.curie}`,
		`  review_cid: ${OLD_CID}`,
		'---',
		'',
		'# AC-2 has evidence: MFA policy',
		'',
	].join('\n');
}

const fmOf = (text: string): Record<string, unknown> => {
	const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	return (yaml.load(match![1]) ?? {}) as Record<string, unknown>;
};

function seed(files: Map<string, string>): void {
	files.set(CONTROL.path, `---\ncurie: ${CONTROL.curie}\n_crosswalker:\n  review_cid: ${NEW_CID}\n---\n\n# AC-2\n`);
	files.set(EVIDENCE, '# MFA policy\n');
	files.set(LINK_PATH, drifted());
}

async function press(
	app: App,
	act: { status?: string; scope?: string } = {},
): Promise<void> {
	const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
	modal.control = CONTROL;
	modal.evidencePath = EVIDENCE;
	await modal.resolvePair(CONTROL, EVIDENCE);
	if (act.status !== undefined) { modal.status = act.status; modal.statusSetInThisWindow = true; }
	if (act.scope !== undefined) modal.evidenceScope = act.scope;
	await modal.create();
}

describe('AM-41: reviewed_against is written only by the act that produces it', () => {
	it('status untouched, only scope edited: the OLD baseline survives, still drifted', async () => {
		const { app, files } = makeVault();
		seed(files);

		await press(app, { scope: 'A different scope, nothing about status' });

		const fm = fmOf(files.get(LINK_PATH)!);
		expect(fm.scope).toBe('A different scope, nothing about status');
		// The baseline is UNCHANGED: still the OLD cid, not silently re-baselined to
		// the control's current (drifted) fingerprint.
		expect(fm.reviewed_against).toEqual({ curie: CONTROL.curie, review_cid: OLD_CID });
		expect(said()).toContain('Updated the existing link');
	});

	it('status set to approved IN THIS WINDOW: the baseline moves to the CURRENT fingerprint', async () => {
		const { app, files } = makeVault();
		seed(files);

		// The dropdown already displays `approved` (prefilled); the person picks it
		// again is not how attestation works. AM-41's act is real re-approval: the
		// person explicitly (re-)confirms approved.
		await press(app, { status: 'approved' });

		const fm = fmOf(files.get(LINK_PATH)!);
		expect(fm.reviewed_against).toEqual({ curie: CONTROL.curie, review_cid: NEW_CID });
	});

	it('status set to anything else IN THIS WINDOW: the baseline is REMOVED, not carried', async () => {
		const { app, files } = makeVault();
		seed(files);

		await press(app, { status: 'in_review' });

		const after = files.get(LINK_PATH)!;
		const fm = fmOf(after);
		expect(fm.status).toBe('in_review');
		// A revoked/downgraded approval has no baseline left to describe.
		expect(fm.reviewed_against).toBeUndefined();
		expect(after).not.toContain('reviewed_against');
	});

	it('a note with NO recorded baseline whose status prefills approved does not acquire one', async () => {
		// Closed "by construction" per the implement report: not attesting means the
		// fresh note is built from the note's OWN record (null), never from the
		// control's current cid, even when the displayed status happens to already
		// read `approved`.
		const { app, files } = makeVault();
		files.set(CONTROL.path, `---\ncurie: ${CONTROL.curie}\n_crosswalker:\n  review_cid: ${NEW_CID}\n---\n\n# AC-2\n`);
		files.set(EVIDENCE, '# MFA policy\n');
		files.set(LINK_PATH, [
			'---',
			`curie: ${LINK_CURIE}`,
			'kind: junction-note',
			`subject: "[[${CONTROL.path}|AC-2]]"`,
			`subject_curie: "${CONTROL.curie}"`,
			'predicate: has_evidence',
			`object: "[[${EVIDENCE}|MFA policy]]"`,
			'coverage: full',
			'status: approved',
			// Deliberately NO reviewed_against block: an approval recorded before this
			// product tracked baselines at all, or written by hand.
			'---',
			'',
			'# AC-2 has evidence: MFA policy',
			'',
		].join('\n'));

		await press(app, { scope: 'touch something else, not status' });

		const fm = fmOf(files.get(LINK_PATH)!);
		expect(fm.status).toBe('approved');
		expect(fm.reviewed_against).toBeUndefined();
	});
});
