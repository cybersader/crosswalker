/**
 * evidence-window-am43-write-equals-display.test.ts — AM-43 (2026-09-02, pass
 * 15, Task C item 3): what the form shows is what it writes.
 *
 * THE DEFECT THIS PINS (pass-14 CONFIRMED 3). The controls used to be
 * reconciled at WRITE time (`answered()` compared the current value to a
 * hardcoded default) rather than prefilled at DISPLAY time. Two consequences:
 * the form showed `Full` / `Proposed` / no scope while the note said otherwise,
 * and — the safety-critical one — REVOKING AN APPROVAL WAS IMPOSSIBLE: an
 * Obsidian dropdown fires no `onChange` when the value picked equals the value
 * already shown, so picking `Proposed` on a dropdown already displaying
 * `Proposed` (because that happened to be the FORM's hardcoded default, not
 * because it was the note's approved value) looked exactly like not choosing.
 * The note kept its `approved` and the notice reported "Updated".
 *
 * THE RULE. The pair lookup runs ONCE, before the controls are answerable
 * (disabled during the lookup, with a visible status line); it sets the
 * controls from the NOTE's own recorded state, or the form's defaults when
 * nothing records the pair; and at submit, the WRITTEN values are the
 * DISPLAYED values, unconditionally — no comparison to a default, no "did they
 * answer" question. Revoking an approval back to a value that happens to equal
 * a hardcoded default is therefore a real, written change, because what makes
 * it "the default" is irrelevant — it differs from what was DISPLAYED.
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
const CONTROL: ControlCandidate = {
	path: 'Frameworks/NIST/AC-2.md',
	title: 'AC-2',
	curie: 'nist:AC-2',
	reviewCid: null,
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
	resolution: unknown;
	resolving: boolean;
	pairRefusal: string | null;
	coverageDrop: { disabled?: boolean } | null;
	statusDrop: { disabled?: boolean } | null;
	submitButton: { disabled?: boolean } | null;
	pairChanged(): void;
	resolvePair(control: ControlCandidate, evidencePath: string): Promise<void>;
	applyPairState(): void;
	create(): Promise<void>;
}

const fmTextOf = (text: string): string =>
	/^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/\r\n/g, '\n'))?.[1] ?? '';
const fmOf = (text: string): Record<string, unknown> => (yaml.load(fmTextOf(text)) ?? {}) as Record<string, unknown>;

function approvedJunction(): string {
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
		'scope: "Some scope"',
		'---',
		'',
		'# AC-2 has evidence: MFA policy',
		'',
	].join('\n');
}

// ---------------------------------------------------------------------------
// Revoking an approval: the case that used to fail silently.
// ---------------------------------------------------------------------------

describe('AM-43: revoking an approval back to a value equal to the form default IS written', () => {
	it('the dropdown displays approved (from the note), and picking proposed writes it', async () => {
		const { app, files } = makeVault();
		files.set(CONTROL.path, `---\ncurie: ${CONTROL.curie}\n---\n\n# AC-2\n`);
		files.set(EVIDENCE, '# MFA policy\n');
		files.set(LINK_PATH, approvedJunction());

		const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
		modal.control = CONTROL;
		modal.evidencePath = EVIDENCE;
		await modal.resolvePair(CONTROL, EVIDENCE);

		// The prefill: the dropdown shows what the note actually says.
		expect(modal.status).toBe('approved');

		// The person selects `proposed` — which happens to equal the FORM's
		// hardcoded default (`FORM_DEFAULT_STATUS`), but they picked it FROM a
		// display of `approved`, so it is a real, fired change.
		modal.status = 'proposed';
		modal.statusSetInThisWindow = true;

		await modal.create();

		const fm = fmOf(files.get(LINK_PATH)!);
		expect(fm.status).toBe('proposed');
		expect(said()).toContain('Updated the existing link');
	});
});

// ---------------------------------------------------------------------------
// The pair lookup runs once per pair.
// ---------------------------------------------------------------------------

describe('AM-43: the pair lookup runs once per pair, not once per interaction', () => {
	it('resolvePair is not re-invoked when pairChanged sees the SAME pair again', async () => {
		const { app, files } = makeVault();
		files.set(CONTROL.path, `---\ncurie: ${CONTROL.curie}\n---\n\n# AC-2\n`);
		files.set(EVIDENCE, '# MFA policy\n');
		files.set(LINK_PATH, approvedJunction());

		const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
		modal.control = CONTROL;
		modal.evidencePath = EVIDENCE;
		const spy = jest.spyOn(modal, 'resolvePair');

		await modal.resolvePair(CONTROL, EVIDENCE);
		expect(spy).toHaveBeenCalledTimes(1);

		// Simulate the evidence field losing focus again with the SAME text — the
		// blur handler fires `pairChanged()` on every blur, not only on a real edit.
		modal.pairChanged();
		modal.pairChanged();
		modal.pairChanged();

		// The pair did not change (same control, same evidence path), so the
		// resolution already in hand is kept and no second lookup starts.
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it('resolvePair DOES re-run when the pair actually changes', async () => {
		const { app, files } = makeVault();
		files.set(CONTROL.path, `---\ncurie: ${CONTROL.curie}\n---\n\n# AC-2\n`);
		files.set('Evidence/Other.md', '# Other\n');
		files.set(EVIDENCE, '# MFA policy\n');

		const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
		modal.control = CONTROL;
		modal.evidencePath = EVIDENCE;
		await modal.resolvePair(CONTROL, EVIDENCE);
		const resolvedFirst = modal.resolution;
		expect(resolvedFirst).not.toBeNull();

		modal.evidencePath = 'Evidence/Other.md';
		modal.pairChanged();
		// A genuine pair change drops the stale resolution immediately, before the
		// new (async) lookup lands — this is what disables the controls mid-flight.
		expect(modal.resolution).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Submit is blocked while the pair is unresolved.
// ---------------------------------------------------------------------------

describe('AM-43: create() never writes without a resolution for the pair it is about', () => {
	it('a submit with no resolution yet writes nothing and does not report success', async () => {
		const { app, files } = makeVault();
		files.set(CONTROL.path, `---\ncurie: ${CONTROL.curie}\n---\n\n# AC-2\n`);
		files.set(EVIDENCE, '# MFA policy\n');

		const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
		modal.control = CONTROL;
		modal.evidencePath = EVIDENCE;
		// Deliberately NOT calling resolvePair: this is the state right after the
		// person types the evidence path and clicks the button before the blur
		// event (and its lookup) has landed.
		await modal.create();

		expect(files.has(LINK_PATH)).toBe(false);
		expect(said()).not.toContain('Evidence link created.');
		expect(said()).not.toContain('Updated the existing link');
		// The actual guard, not just its absence of success: `create()` starts the
		// lookup and tells the person to look again, rather than either writing or
		// falling through into destructuring a null resolution.
		expect(said()).toContain('Checking for an existing link');
	});

	it('the three review controls and the submit button are disabled until resolved', async () => {
		const { app, files } = makeVault();
		files.set(CONTROL.path, `---\ncurie: ${CONTROL.curie}\n---\n\n# AC-2\n`);
		files.set(EVIDENCE, '# MFA policy\n');

		const modal = new EvidenceLinkModal({ app, folder: FOLDER }) as unknown as ModalInternals;
		modal.control = CONTROL;
		modal.evidencePath = EVIDENCE;
		modal.coverageDrop = { disabled: false };
		modal.statusDrop = { disabled: false };
		modal.submitButton = { disabled: false };
		(modal.coverageDrop as any).setDisabled = function (v: boolean) { this.disabled = v; };
		(modal.statusDrop as any).setDisabled = function (v: boolean) { this.disabled = v; };
		(modal.submitButton as any).setDisabled = function (v: boolean) { this.disabled = v; };
		// resolvePair's prefill also calls `.setValue(...)` on the two dropdowns —
		// stub it so the prefill does not throw and mask the assertion under test.
		(modal.coverageDrop as any).setValue = () => undefined;
		(modal.statusDrop as any).setValue = () => undefined;

		// Before any resolution exists.
		modal.applyPairState();
		expect((modal.coverageDrop as any).disabled).toBe(true);
		expect((modal.statusDrop as any).disabled).toBe(true);
		expect((modal.submitButton as any).disabled).toBe(true);

		await modal.resolvePair(CONTROL, EVIDENCE);

		expect((modal.coverageDrop as any).disabled).toBe(false);
		expect((modal.statusDrop as any).disabled).toBe(false);
		expect((modal.submitButton as any).disabled).toBe(false);
	});
});
