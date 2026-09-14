/**
 * sssom-import-modal-errors.test.ts -- AM-8: every entry point shows its errors.
 *
 * AM-4 made an identity collision reach the user in the import wizard: the run
 * stops closing the window, the results screen leads with the error list, and
 * the notice says how many there were. AM-8 says the same rule applies to every
 * other way an import can be started, and names the SSSOM importer, which had
 * two independent versions of the same failure:
 *
 *   1. A run that FAILED printed `result.generation.errors.join('; ')` over an
 *      array of `{row, message}` objects, so the Notice read `[object Object]`,
 *      and drew nothing at all: a refusal reached the user as one unreadable
 *      line that then expired.
 *   2. A run that SUCCEEDED with row-level errors reported only the created
 *      count and closed the window on them.
 *
 * WHICH BRANCH A COLLISION ACTUALLY TAKES, AND WHY (2) IS NOT ASSERTED HERE
 *
 * The SSSOM importer generates through `generateFromRecipe`, which ends with
 * `if (result.errors.length > 0) result.success = false`. A run with row errors
 * is therefore never a success on this path, so an `Ambiguous identity` refusal
 * lands in the FAILURE branch and the modal's success-with-errors branch is not
 * reachable through this entry point at all. It is asserted nowhere below
 * because a test would have to mock the importer to reach it, and a mocked
 * importer proves only that the modal renders a list it was handed.
 *
 * (1) is asserted below against a REAL collision, produced by importing a
 * mapping file and then duplicating one of the junction notes it wrote: the
 * curie the duplicate claims is the curie the engine really mints, and the
 * refusal is the one the engine really raises.
 */

import { TFile, TFolder } from 'obsidian';
import { importSssom } from '../src/import/sssom-importer';
import { SssomImportModal } from '../src/import/sssom-import-modal';
import type CrosswalkerPlugin from '../src/main';
import type { App } from 'obsidian';
import type { DebugLog } from '../src/utils/debug';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

// ---------------------------------------------------------------------------
// Notices. The same live-module swap tests/legacy-vault-refresh.test.ts uses:
// under esModuleInterop a namespace import would be a COPY, and a spy on the
// copy would leave src/ calling the original.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const obsidianModule = require('obsidian') as {
	Notice: new (message: string, timeout?: number) => unknown;
};
const RealNotice = obsidianModule.Notice;
const notices: string[] = [];

beforeAll(() => {
	obsidianModule.Notice = class {
		constructor(message: string) { notices.push(message); }
		setMessage(message: string) { notices.push(message); }
		hide() { /* the progress notice is dismissed, not reported */ }
	} as unknown as typeof RealNotice;
});

afterAll(() => { obsidianModule.Notice = RealNotice; });
beforeEach(() => { notices.length = 0; });

const noticeText = (): string => notices.join('\n');

// ---------------------------------------------------------------------------
// A stateful in-memory vault, same shape as the one the D1 acceptance suite
// uses. Real `TFile` / `TFolder` instances matter: `resolveWriteTarget` and the
// identity index both branch on `instanceof TFile`, and a plain object there
// would make every existing note invisible -- which is the opposite of the
// collision this file needs.
// ---------------------------------------------------------------------------
function makeVault() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);

	const rename = jest.fn(async (file: { path: string }, newPath: string) => {
		const content = files.get(file.path);
		if (content === undefined) throw new Error(`Missing source file: ${file.path}`);
		files.delete(file.path);
		files.set(newPath, content);
		file.path = newPath;
	});

	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((path) => new TFile(path)),
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
			rename,
			delete: async (file: { path: string }) => { files.delete(file.path); },
		},
		fileManager: { renameFile: rename },
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const text = files.get(file.path);
				if (!text) return null;
				const m = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
				if (!m) return { frontmatter: {} };
				return { frontmatter: (yaml.load(m[1]) as Record<string, unknown>) ?? {} };
			},
			on: () => ({}),
			offref: () => {},
		},
	};
	return { app: app as unknown as App, files, rename };
}

const debugStub = {
	info() {}, trace() {}, warn() {}, error() {},
	currentTraceId: () => undefined,
	newTraceId: () => 'test-trace',
	withTrace: <T>(_id: string, fn: () => T): T => fn(),
} as unknown as DebugLog;

/** Two mappings, enough to have one to duplicate and one to leave alone. */
const TSV = [
	'subject_id\tsubject_label\tpredicate_id\tobject_id\tobject_label\tmapping_justification\tconfidence',
	'csf:GV.OC-01\tOrganizational context\tskos:closeMatch\tiso27001:A.5.1\tPolicies\tsemapv:ManualMappingCuration\t0.9',
	'csf:GV.OC-02\tStakeholders\tskos:closeMatch\tiso27001:A.5.2\tRoles\tsemapv:ManualMappingCuration\t0.9',
].join('\n');

const FOLDER = '_crosswalker/mappings/csf-to-iso27001';

/**
 * Everything the modal reads that is normally filled in by the file picker and
 * the parse step. Reached through a cast for the same reason the wizard's
 * acceptance suite does it: the modal's DOM is not mountable under the obsidian
 * mock, and these are the inputs, not incidental internals.
 */
interface ModalInternals {
	parsedTsv: string | null;
	detectedSource: string | null;
	detectedTarget: string | null;
	runImport(): Promise<void>;
	contentEl: HTMLElement;
	close: jest.Mock;
}

/**
 * A container that absorbs the whole Obsidian element surface and records the
 * text of everything drawn into it.
 */
function makeRecordingEl(texts: string[]): HTMLElement {
	const target = function () { /* elements are called for nothing; see apply */ };
	return new Proxy(target, {
		get(_t, prop) {
			if (prop === 'then') return undefined;
			if (prop === 'setText') return (t: string) => { texts.push(t); };
			if (prop === 'createEl' || prop === 'createDiv' || prop === 'createSpan') {
				return (first?: unknown, second?: { text?: string }) => {
					const opts = (typeof first === 'object' ? first : second) as { text?: string } | undefined;
					if (opts?.text) texts.push(opts.text);
					return makeRecordingEl(texts);
				};
			}
			if (prop === 'value' || prop === 'textContent' || prop === 'innerHTML') return '';
			if (prop === 'style' || prop === 'dataset' || prop === 'classList') return makeRecordingEl(texts);
			return () => makeRecordingEl(texts);
		},
		set: () => true,
		apply: () => makeRecordingEl(texts),
	}) as unknown as HTMLElement;
}

/**
 * Seed a mapping import, optionally leave a second file claiming one junction
 * identity, then run the SSSOM modal's own import over the result.
 *
 * The duplicate is what a user's vault looks like after a mapping release was
 * imported twice under two folders, or after a note was copied in the file
 * explorer. It is created by copying a file the engine really wrote, so the
 * curie it claims is the curie the engine really mints.
 */
async function importThroughTheModal(duplicate: boolean) {
	const vault = makeVault();
	const seed = await importSssom(vault.app, TSV, null, null, { runTier2Projection: false, overwriteMode: 'replace' });
	expect(seed.generation?.success).toBe(true);
	expect(seed.generation?.created.length).toBe(2);

	let victim: string | null = null;
	if (duplicate) {
		victim = [...vault.files.keys()].find((path) => path.startsWith(`${FOLDER}/`))!;
		vault.files.set(`${FOLDER}/Copy of ${victim.split('/').pop()}`, vault.files.get(victim)!);
	}

	const plugin = {
		settings: {},
		debug: debugStub,
		runProjection: null,
		precomputeClosure: null,
	} as unknown as CrosswalkerPlugin;

	const modal = new SssomImportModal(vault.app, plugin);
	const internals = modal as unknown as ModalInternals;
	const texts: string[] = [];
	internals.contentEl = makeRecordingEl(texts);
	internals.parsedTsv = TSV;
	internals.detectedSource = 'csf';
	internals.detectedTarget = 'iso27001';

	notices.length = 0;
	await internals.runImport();
	return { vault, modal, texts, victim, close: internals.close };
}

describe('an identity collision reached through the SSSOM importer', () => {
	it('does not close the window on it', async () => {
		const { close } = await importThroughTheModal(true);
		expect(close).not.toHaveBeenCalled();
	});

	it('names the refusal in the notice, with its row and its reason', async () => {
		// The regression this rule exists for: `errors.join('; ')` over an array of
		// `{row, message}` renders the array's default string form, so the one line
		// the user got said `[object Object]`.
		await importThroughTheModal(true);
		expect(noticeText()).not.toContain('[object Object]');
		expect(noticeText()).toMatch(/SSSOM import failed: Row \d+: Ambiguous identity /);
	});

	it('draws a results screen with the refusal on it, and both claimants named', async () => {
		const { texts, victim } = await importThroughTheModal(true);
		expect(texts).toContain('SSSOM import results');
		expect(texts).toContain('Errors');
		const collision = texts.filter((line) => /Ambiguous identity/.test(line));
		expect(collision.length).toBeGreaterThan(0);
		expect(collision[0]).toContain(victim!);
		expect(collision[0]).toContain('Copy of');
		// A row error carries its row number, so the user can find the mapping.
		expect(collision[0]).toMatch(/^Row \d+: /);
	});

	it('closes quietly on the same run without the collision, which is the control', async () => {
		// Without this, every assertion above is satisfied by a modal that draws an
		// error screen unconditionally.
		const { texts, close } = await importThroughTheModal(false);
		expect(close).toHaveBeenCalledTimes(1);
		expect(texts.filter((line) => /Errors|Ambiguous/.test(line))).toEqual([]);
		expect(noticeText()).not.toMatch(/finished with|failed:/);
		expect(noticeText()).toContain(`junction notes created under ${FOLDER}`);
	});
});
