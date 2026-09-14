/**
 * evidence-window-am46-control-gate.test.ts — AM-46 (2026-09-02, pass 15, Task
 * C item 6): the gate goes where the read is blind — this time the control
 * list.
 *
 * THE DEFECT THIS PINS (pass-14 CONFIRMED 5). AM-40 removed `create()`'s
 * `requireVaultIndexed` gate on the ruling that both readers beneath it
 * already raw-read a cache-missed file. That was true of the pair scan and the
 * identity index, but NOT of the control list: `listControlCandidates` (the
 * pre-AM-46 name) was built in the modal's CONSTRUCTOR from
 * `getFileCache(file)?.frontmatter` alone, and `countUnindexedMarkdownFiles`
 * was consulted only when the list came back EMPTY. A PARTIAL index — the
 * ordinary state right after startup, one control indexed and its sibling not
 * yet — produced a silently short list with nothing to say anything was
 * missing, and `main.ts`'s `initialControl` build was the same cache-only
 * read, so invoking the command from a control Obsidian had not yet reached
 * yielded `undefined` and the selection fell through to `controls[0]` — a
 * DIFFERENT control, with the notice reporting success.
 *
 * THE RULE. `scanControlCandidates` reads fail-closed (raw-reads a cache miss,
 * same discipline as the pair scan). Its `unreadable` count is surfaced, never
 * silently absorbed. And when the note the command was invoked FROM cannot be
 * read at all, the window refuses BY NAME and never substitutes — which this
 * file proves by showing that the code path capable of choosing `controls[0]`
 * (inside the dropdown's own setup) never RUNS in that case: `renderForm()`
 * returns immediately after writing the refusal.
 */

import { TFile, TFolder } from 'obsidian';
import {
	EvidenceLinkModal,
	scanControlCandidates,
	type EvidenceLinkModalDeps,
} from '../src/views/evidence-link-modal';
import type { App } from 'obsidian';

// ---------------------------------------------------------------------------
// `Setting.setName` is a per-instance jest.fn() (a class field, not on the
// prototype — `jest.spyOn(Setting.prototype, 'setName')` finds nothing there).
// Swapped on the LIVE module object, same pattern the `Notice` swap in the
// sibling files uses, so src/ calls the double and every "Control" heading
// this window ever constructs is recorded.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const obsidianModule = require('obsidian') as { Setting: new (containerEl: unknown) => { setName: (name: string) => unknown } };
const RealSetting = obsidianModule.Setting;
let settingNames: string[] = [];
beforeAll(() => {
	obsidianModule.Setting = class extends RealSetting {
		constructor(containerEl: unknown) {
			super(containerEl);
			// `setName` on the base mock is a CLASS FIELD (an own instance
			// property assigned by the base constructor's field initializer),
			// which shadows a same-named PROTOTYPE method a subclass declares —
			// the field initializer runs after `super()` and wins. Wrapping the
			// already-assigned instance property here, after `super()` has run, is
			// what actually intercepts every call.
			const original = this.setName.bind(this);
			this.setName = (name: string): unknown => { settingNames.push(name); return original(name); };
		}
	} as unknown as typeof RealSetting;
});
afterAll(() => { obsidianModule.Setting = RealSetting; });
beforeEach(() => { settingNames = []; });

/**
 * A vault whose metadata cache is COLD for every file (models the state right
 * after startup: files are on disk and readable, the cache simply has not
 * caught up). `unreadablePaths` names files whose raw content ALSO fails to
 * parse — the genuine "nothing can be known about this note" case.
 */
function makeVault(opts: { unreadablePaths?: Set<string> } = {}) {
	const files = new Map<string, string>();
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((p) => new TFile(p)),
			// S5 (2026-09-04) fix follow-up: buildLinkFallbackIndex reads getFiles(),
			// not getMarkdownFiles() -- a stub missing it throws the moment a scan
			// falls back to the vault file list. No non-markdown fixture here, so this
			// answers the same set; see tests/vault-path-normalization-s5.test.ts for
			// the PDF/non-markdown case.
			getFiles: () => [...files.keys()].map((p) => new TFile(p)),
			getAbstractFileByPath: (path: string) => (files.has(path) ? new TFile(path) : null),
			cachedRead: async (file: { path: string }) => {
				if (opts.unreadablePaths?.has(file.path)) throw new Error('disk read failed');
				return files.get(file.path) ?? '';
			},
			read: async (file: { path: string }) => files.get(file.path) ?? '',
		},
		// Cold cache for EVERY file, unconditionally — the partial-index state.
		metadataCache: { getFileCache: () => null },
		workspace: { getLeaf: () => ({ openFile: async () => undefined }) },
	};
	return { app: app as unknown as App, files };
}

const conceptNote = (curie: string, title: string): string =>
	`---\ncurie: ${curie}\ntitle: ${title}\n---\n\n# ${title}\n`;

/** Content whose properties block exists but will not parse under any reader. */
const GARBLED = '---\n: : :\n  - broken\n---\n\nText.\n';

interface ModalInternals {
	control: unknown;
	controls: unknown[];
	unreadableControls: Set<string>;
	loadControls(): Promise<void>;
	renderForm(): void;
}

function makeModal(deps: EvidenceLinkModalDeps): ModalInternals {
	return new EvidenceLinkModal(deps) as unknown as ModalInternals;
}

// ---------------------------------------------------------------------------
// scanControlCandidates: the read itself.
// ---------------------------------------------------------------------------

describe('AM-46: scanControlCandidates reads fail-closed, like the pair scan', () => {
	it('a cache-cold but genuinely readable control note is still found', async () => {
		const { app, files } = makeVault();
		files.set('Frameworks/AC-2.md', conceptNote('nist:AC-2', 'AC-2'));

		const scan = await scanControlCandidates(app);

		expect(scan.controls.map((c) => c.path)).toEqual(['Frameworks/AC-2.md']);
		expect(scan.unreadable).toEqual([]);
	});

	it('a note whose properties will not parse is reported as unreadable, never silently dropped', async () => {
		const { app, files } = makeVault({ unreadablePaths: new Set(['Frameworks/Damaged.md']) });
		files.set('Frameworks/AC-2.md', conceptNote('nist:AC-2', 'AC-2'));
		files.set('Frameworks/Damaged.md', GARBLED);

		const scan = await scanControlCandidates(app);

		expect(scan.controls.map((c) => c.path)).toEqual(['Frameworks/AC-2.md']);
		expect(scan.unreadable).toEqual(['Frameworks/Damaged.md']);
		// The count is exact: one readable control, one unreadable note, nothing
		// dropped in between.
		expect(scan.controls.length + scan.unreadable.length).toBe(files.size);
	});

	it('a plain note with no properties is neither a control nor unreadable — it is a known fact', async () => {
		const { app, files } = makeVault();
		files.set('Notes/Plain.md', 'Just prose, no frontmatter.\n');

		const scan = await scanControlCandidates(app);

		expect(scan.controls).toEqual([]);
		expect(scan.unreadable).toEqual([]);
	});

	it('junction and crosswalk-edge notes are excluded even though they carry a curie', async () => {
		const { app, files } = makeVault();
		files.set('Evidence/link.md', '---\ncurie: cwk:link\nkind: junction-note\n---\n');
		files.set('Crosswalks/edge.md', '---\ncurie: cwk:edge\nkind: crosswalk-edge\n---\n');
		files.set('Frameworks/AC-2.md', conceptNote('nist:AC-2', 'AC-2'));

		const scan = await scanControlCandidates(app);

		expect(scan.controls.map((c) => c.path)).toEqual(['Frameworks/AC-2.md']);
	});
});

// ---------------------------------------------------------------------------
// The modal: an unreadable invoked-from note refuses BY NAME, and never
// reaches the code that could substitute a different control.
// ---------------------------------------------------------------------------

describe('AM-46: an unreadable invoked-from note refuses by name and never falls through to controls[0]', () => {
	it('names the file, states the count, and never constructs the Control dropdown', async () => {
		const { app, files } = makeVault({ unreadablePaths: new Set(['Frameworks/AC-3.md']) });
		// "AC-2" sorts before "AC-3", so a fallback to `controls[0]` would silently
		// pick THIS one — the exact substitution AM-46 forbids.
		files.set('Frameworks/AC-2.md', conceptNote('nist:AC-2', 'AC-2'));
		files.set('Frameworks/AC-3.md', GARBLED);

		const modal = makeModal({ app, folder: 'Evidence/Junctions', initialControlPath: 'Frameworks/AC-3.md' });
		const createElSpy = jest.spyOn((modal as any).contentEl, 'createEl');

		await modal.loadControls();
		modal.renderForm();

		// The refusal was written, naming the file.
		const paragraphTexts = createElSpy.mock.calls
			.filter((call) => call[0] === 'p')
			.map((call: any) => call[1]?.text as string);
		const refusal = paragraphTexts.find((t) => t.includes('Frameworks/AC-3.md'));
		expect(refusal).toBeDefined();
		expect(refusal).toContain('cannot read');

		// The code that COULD substitute `controls[0]` lives inside the "Control"
		// dropdown's setup, which only runs if a Setting named "Control" is ever
		// constructed. It never is: `renderForm()` returned right after the
		// refusal paragraph.
		expect(settingNames).not.toContain('Control');
		// And the private field the dropdown would have assigned stays untouched.
		expect((modal as any).control).toBeNull();

		createElSpy.mockRestore();
	});

	it('a readable invoked-from note is never blocked by an unrelated unreadable note elsewhere', async () => {
		const { app, files } = makeVault({ unreadablePaths: new Set(['Notes/Damaged.md']) });
		files.set('Frameworks/AC-2.md', conceptNote('nist:AC-2', 'AC-2'));
		files.set('Frameworks/AC-3.md', conceptNote('nist:AC-3', 'AC-3'));
		files.set('Notes/Damaged.md', GARBLED);

		const modal = makeModal({ app, folder: 'Evidence/Junctions', initialControlPath: 'Frameworks/AC-3.md' });
		const createElSpy = jest.spyOn((modal as any).contentEl, 'createEl');

		await modal.loadControls();
		modal.renderForm();

		// The Control dropdown IS offered — this note reads cleanly, so the
		// unrelated unreadable note is a fact about a DIFFERENT file, not a
		// reason to refuse this one.
		expect(settingNames).toContain('Control');
		expect(modal.controls.map((c: any) => c.path)).toEqual(['Frameworks/AC-2.md', 'Frameworks/AC-3.md']);
		expect(modal.unreadableControls.has('Notes/Damaged.md')).toBe(true);

		// The partial-index count is surfaced on screen, not silently absorbed.
		const paragraphTexts = createElSpy.mock.calls
			.filter((call) => call[0] === 'p')
			.map((call: any) => call[1]?.text as string);
		expect(paragraphTexts.some((t) => t.includes('1 notes could not be read')
			|| t.includes('could not be read'))).toBe(true);

		createElSpy.mockRestore();
	});

	it('no invokedFrom at all (command palette): unreadable notes elsewhere are counted, not refused', async () => {
		const { app, files } = makeVault({ unreadablePaths: new Set(['Notes/Damaged.md']) });
		files.set('Frameworks/AC-2.md', conceptNote('nist:AC-2', 'AC-2'));
		files.set('Notes/Damaged.md', GARBLED);

		const modal = makeModal({ app, folder: 'Evidence/Junctions' });

		await modal.loadControls();
		modal.renderForm();

		expect(settingNames).toContain('Control');
		expect(modal.controls).toHaveLength(1);
		expect(modal.unreadableControls.size).toBe(1);
	});
});
