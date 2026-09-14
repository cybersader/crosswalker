/**
 * sssom-crosswalk-ownership.test.ts -- AM-11: the crosswalk modal follows AM-5.
 *
 * WHY THIS SURFACE HAD ITS OWN COPY OF THE BUG
 *
 * A crosswalk lands in a folder named after the ontology PAIR
 * (`_crosswalker/mappings/<subject>-to-<object>`), which is deterministic. Two
 * releases of the same pair therefore always share a folder -- a vendor
 * crosswalk and an in-house one between the same two frameworks are different
 * bodies of work at one address. This modal read that address as an owner: it
 * preselected the single set it found there and let the importer default to
 * `replace`. Opening a second crosswalk file, previewing it and pressing Import
 * therefore overwrote the first release assertion by assertion, with no
 * ownership click anywhere and no orphan count on any screen.
 *
 * The folder is deterministic; the owner is not. AM-11 gives this modal the
 * wizard shape -- every set at the destination listed, a new set as the default,
 * a refresh only on a click -- and AM-9 removes the engine's own version of the
 * same guess underneath it, so "no click means a new set" is true all the way
 * down rather than being re-established on each surface.
 *
 * WHY THE TWO TSVs SHARE A MAPPING
 *
 * Under `endpoint-v1` an edge curie is `cw-<subject>-<object>` with nothing
 * naming the set, so two releases asserting anything about the same pair claim
 * one identity and one path. The shared row below is what makes "the first
 * release is untouched" a real assertion rather than a coincidence of disjoint
 * inputs, and it is why a new crosswalk set is minted `set-qualified-v1`.
 *
 * AM-8's half of this modal -- that a failed run draws its errors instead of
 * closing on a Notice -- lives in tests/sssom-import-modal-errors.test.ts.
 */

import { TFile, TFolder } from 'obsidian';
import { SssomImportModal } from '../src/import/sssom-import-modal';
import { discoverImportSets } from '../src/generation/import-set';
import type CrosswalkerPlugin from '../src/main';
import type { App } from 'obsidian';
import type { DebugLog } from '../src/utils/debug';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

// ---------------------------------------------------------------------------
// Notices and Setting, swapped on the LIVE module object. Under esModuleInterop
// a namespace import would be a copy, and a spy on the copy would leave src/
// calling the original -- the same reason the D1 acceptance suite does this.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const obsidianModule = require('obsidian') as {
	Notice: new (message: string, timeout?: number) => unknown;
	Setting: new (containerEl: HTMLElement) => { addDropdown(cb: (d: unknown) => void): unknown };
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
// A stateful in-memory vault. Real TFile/TFolder instances matter: the identity
// index and resolveWriteTarget both branch on `instanceof TFile`, and plain
// objects there would make every existing note invisible, which is the opposite
// of the collision these cases are about.
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
	const modify = jest.fn(async (file: { path: string }, content: string) => { files.set(file.path, content); });

	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((path) => new TFile(path)),
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			create: async (path: string, content: string) => { files.set(path, content); return new TFile(path); },
			modify,
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
	return { app: app as unknown as App, files, modify, rename };
}

const debugStub = {
	info() {}, trace() {}, warn() {}, error() {},
	currentTraceId: () => undefined,
	newTraceId: () => 'test-trace',
	withTrace: <T>(_id: string, fn: () => T): T => fn(),
} as unknown as DebugLog;

const HEADER = 'subject_id\tsubject_label\tpredicate_id\tobject_id\tobject_label\tmapping_justification\tconfidence';

/** One provider's crosswalk between csf and iso27001. */
const VENDOR_TSV = [
	HEADER,
	'csf:GV.OC-01\tOrganizational context\tskos:closeMatch\tiso27001:A.5.1\tPolicies\tsemapv:ManualMappingCuration\t0.9',
	'csf:GV.OC-02\tStakeholders\tskos:closeMatch\tiso27001:A.5.2\tRoles\tsemapv:ManualMappingCuration\t0.9',
].join('\n');

/**
 * A different body of work about the same pair. The FIRST row asserts something
 * about the same (subject, object) as the vendor file, with a different
 * predicate and a different confidence: the case where an adopting refresh
 * silently replaces one organisation's judgement with another's.
 */
const INHOUSE_TSV = [
	HEADER,
	'csf:GV.OC-01\tOrganizational context\tskos:relatedMatch\tiso27001:A.5.1\tPolicies\tsemapv:ManualMappingCuration\t0.4',
	'csf:GV.RM-01\tRisk strategy\tskos:closeMatch\tiso27001:A.5.4\tManagement\tsemapv:ManualMappingCuration\t0.8',
].join('\n');

const FOLDER = '_crosswalker/mappings/csf-to-iso27001';

interface ModalInternals {
	parsedTsv: string | null;
	detectedSource: string | null;
	detectedTarget: string | null;
	importSetChoice: unknown;
	runImport(): Promise<void>;
	renderImportSetChoice(container: HTMLElement, basePath: string): Promise<boolean>;
	selectedImportSet(): Promise<unknown>;
	refreshPreview(): Promise<void>;
	contentEl: HTMLElement;
	close: jest.Mock;
}

const inner = (modal: SssomImportModal): ModalInternals => modal as unknown as ModalInternals;

/** One dropdown as the modal built it, in the order the user sees it. */
interface DropdownRecord {
	options: Array<{ value: string; label: string }>;
	value: string | null;
	onChange: ((value: string) => void) | null;
}

/**
 * A container that absorbs the whole Obsidian element surface, recording the
 * text of everything drawn into it and every click handler by the text of the
 * element it was attached to. Hand-listing the members the modal touches is a
 * guessing game that fails as an obscure "is not a function"; a proxy removes
 * that failure mode while capturing the two things the assertions are about.
 */
function makeRecordingEl(texts: string[], clicks?: Map<string, () => void>, ownText?: string): HTMLElement {
	const target = function () { /* elements are called for nothing; see apply */ };
	return new Proxy(target, {
		get(_t, prop) {
			if (prop === 'then') return undefined;
			if (prop === 'setText') return (t: string) => { texts.push(t); };
			if (prop === 'addEventListener' && clicks && ownText !== undefined) {
				return (event: string, handler: () => void) => {
					if (event === 'click') clicks.set(ownText, handler);
				};
			}
			if (prop === 'createEl' || prop === 'createDiv' || prop === 'createSpan') {
				return (first?: unknown, second?: { text?: string }) => {
					const opts = (typeof first === 'object' ? first : second) as { text?: string } | undefined;
					if (opts?.text) texts.push(opts.text);
					return makeRecordingEl(texts, clicks, opts?.text);
				};
			}
			if (prop === 'value' || prop === 'textContent' || prop === 'innerHTML') return '';
			if (prop === 'style' || prop === 'dataset' || prop === 'classList') return makeRecordingEl(texts, clicks, ownText);
			return () => makeRecordingEl(texts, clicks, ownText);
		},
		set: () => true,
		apply: () => makeRecordingEl(texts, clicks, ownText),
	}) as unknown as HTMLElement;
}

/**
 * Draw the ownership review and keep everything a user could act on.
 *
 * The obsidian mock declares `addDropdown` as an INSTANCE field, so patching the
 * prototype is silently shadowed and the control that carries the default would
 * be invisible to every assertion. The whole exported class is swapped for the
 * duration of the render and restored in a `finally`.
 */
async function captureReview(modal: SssomImportModal, basePath = FOLDER): Promise<{
	texts: string[];
	dropdown: DropdownRecord | null;
	clicks: Map<string, () => void>;
	ready: boolean;
}> {
	const texts: string[] = [];
	const clicks = new Map<string, () => void>();
	const dropdowns: DropdownRecord[] = [];
	const original = obsidianModule.Setting;
	class RecordingSetting extends original {
		constructor(containerEl: HTMLElement) {
			super(containerEl);
			(this as unknown as Record<string, unknown>).addDropdown = (cb: (dropdown: unknown) => void) => {
				const record: DropdownRecord = { options: [], value: null, onChange: null };
				const stub = {
					addOption: (value: string, label: string) => { record.options.push({ value, label }); return stub; },
					setValue: (value: string) => { record.value = value; return stub; },
					onChange: (fn: (value: string) => void) => { record.onChange = fn; return stub; },
				};
				cb(stub);
				dropdowns.push(record);
				return this;
			};
		}
	}
	obsidianModule.Setting = RecordingSetting as unknown as typeof original;
	try {
		const ready = await inner(modal).renderImportSetChoice(makeRecordingEl(texts, clicks), basePath);
		return { texts, dropdown: dropdowns[0] ?? null, clicks, ready };
	} finally {
		obsidianModule.Setting = original;
	}
}

/** A modal wired to one TSV, with the picker and parse steps already done. */
function openModal(app: App, tsv: string) {
	const plugin = {
		settings: {},
		debug: debugStub,
		runProjection: null,
		precomputeClosure: null,
	} as unknown as CrosswalkerPlugin;
	const modal = new SssomImportModal(app, plugin);
	const texts: string[] = [];
	inner(modal).contentEl = makeRecordingEl(texts);
	inner(modal).parsedTsv = tsv;
	inner(modal).detectedSource = 'csf';
	inner(modal).detectedTarget = 'iso27001';
	return { modal, texts };
}

/**
 * Import one file through the modal.
 *
 * `click: refresh` presses the button the review draws, which under AM-11 is the
 * one-click route into a refresh. Deliberately goes through the rendered button
 * rather than assigning the field: a test that reached past the UI would still
 * pass on a build that stopped drawing the offer at all.
 */
async function importThroughTheModal(app: App, tsv: string, opts: { click?: 'refresh' } = {}) {
	const { modal, texts } = openModal(app, tsv);
	const review = await captureReview(modal);
	if (opts.click === 'refresh') {
		const label = [...review.clicks.keys()].find((text) => text.startsWith('Refresh '));
		if (!label) {
			throw new Error(`No refresh button was drawn. Buttons: ${[...review.clicks.keys()].join(' | ') || 'none'}`);
		}
		review.clicks.get(label)!();
	}
	notices.length = 0;
	await inner(modal).runImport();
	return { modal, texts, review, close: inner(modal).close };
}

/** The crosswalk notes one import produced, by path. */
function junctionNotes(files: Map<string, string>): Map<string, string> {
	return new Map([...files].filter(([path]) => path.startsWith(`${FOLDER}/`)));
}

function setIdOf(text: string): string | null {
	const m = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	const fm = m ? (yaml.load(m[1]) as Record<string, unknown>) : {};
	const provenance = fm?._crosswalker as Record<string, unknown> | undefined;
	const block = provenance?.import_set as Record<string, unknown> | undefined;
	return typeof block?.id === 'string' ? block.id : null;
}

describe('a second crosswalk release for the same ontology pair', () => {
	/** The vendor file imported, then the in-house file, with NO ownership click. */
	async function twoReleasesNoClick() {
		const vault = makeVault();
		const first = await importThroughTheModal(vault.app, VENDOR_TSV);
		expect(first.close).toHaveBeenCalledTimes(1);
		const before = junctionNotes(vault.files);
		expect(before.size).toBe(2);
		vault.modify.mockClear();

		const second = await importThroughTheModal(vault.app, INHOUSE_TSV);
		return { vault, before, second };
	}

	it('lands in its own set, with nobody having chosen one', async () => {
		const { vault, before, second } = await twoReleasesNoClick();
		expect(second.close).toHaveBeenCalledTimes(1);
		const sets = await discoverImportSets(vault.app, FOLDER);
		expect(sets).toHaveLength(2);
		const firstId = setIdOf([...before.values()][0]);
		const fresh = [...junctionNotes(vault.files)].filter(([path]) => !before.has(path));
		expect(fresh.length).toBe(2);
		for (const [, text] of fresh) expect(setIdOf(text)).not.toBe(firstId);
	});

	it('leaves the first release exactly as it was, mapping for mapping', async () => {
		// The two files assert different predicates about the SAME pair, so an
		// adopting refresh would replace one organisation's judgement with another's
		// in place, at the same path, under the same curie.
		const { vault, before } = await twoReleasesNoClick();
		for (const [path, text] of before) expect(vault.files.get(path)).toBe(text);
		expect(vault.modify).not.toHaveBeenCalled();
	});

	it('mints the new set SET-QUALIFIED, so the shared mapping cannot collide', async () => {
		// An `endpoint-v1` edge curie is `cw-<subject>-<object>` with nothing naming
		// the set. Two releases about one pair would claim one identity, which is a
		// duplicate-identity refusal at best and a silent overwrite at worst.
		const { vault } = await twoReleasesNoClick();
		const sets = await discoverImportSets(vault.app, FOLDER);
		const schemes = sets.map((set) => set.scheme).sort();
		expect(schemes).toEqual(['endpoint-v1', 'set-qualified-v1']);
		const curies = [...junctionNotes(vault.files).values()]
			.map((text) => String((yaml.load(/^---\n([\s\S]*?)\n---/.exec(text)![1]) as Record<string, unknown>).curie));
		expect(new Set(curies).size).toBe(curies.length);
	});

	it('reports no error and no refusal on either run', async () => {
		const { second } = await twoReleasesNoClick();
		expect(noticeText()).not.toMatch(/failed|finished with|Ambiguous/);
		expect(second.texts.filter((line) => /Errors/.test(line))).toEqual([]);
	});
});

describe('the crosswalk ownership review', () => {
	async function vaultWithOneRelease() {
		const vault = makeVault();
		await importThroughTheModal(vault.app, VENDOR_TSV);
		return vault;
	}

	it('preselects nothing, and opens on keeping this release as a new set', async () => {
		// The default is not only what the code resolves; it is what the control
		// SHOWS. A dropdown opening on an existing set is a preselect wearing a UI.
		const vault = await vaultWithOneRelease();
		const { modal } = openModal(vault.app, INHOUSE_TSV);
		const { dropdown, ready } = await captureReview(modal);

		expect(inner(modal).importSetChoice).toBeNull();
		expect(ready).toBe(true);
		expect(dropdown!.options[0].value).toBe('__new__');
		expect(dropdown!.options[0].label).toBe('Keep this release as a new set');
		expect(dropdown!.value).toBe('__new__');
	});

	it('lists every release already at this destination, with the facts that tell them apart', async () => {
		const vault = await vaultWithOneRelease();
		const [existing] = await discoverImportSets(vault.app, FOLDER);
		const { modal } = openModal(vault.app, INHOUSE_TSV);
		const { texts, dropdown } = await captureReview(modal);

		expect(texts.some((line) => line.startsWith(`${existing.id} `))).toBe(true);
		expect(texts.some((line) => line.includes(FOLDER))).toBe(true);
		expect(dropdown!.options.map((option) => option.value)).toEqual(['__new__', existing.id]);
	});

	it('never blocks the Import button on an unanswered question', async () => {
		// The old multi-set branch opened on a `Choose one` placeholder and returned
		// false until the user picked, which is what an ownership question with no
		// safe default looks like. There is a safe default now, so the only answer
		// that blocks is a discovery that threw.
		const vault = await vaultWithOneRelease();
		const { modal } = openModal(vault.app, INHOUSE_TSV);
		const { ready, dropdown } = await captureReview(modal);
		expect(ready).toBe(true);
		expect(dropdown!.options.map((option) => option.label)).not.toContain('Choose one');
	});

	it('refreshes that release when the button is pressed, which is the control', async () => {
		// Without this every assertion above is satisfied by a build that cannot
		// refresh a crosswalk at all.
		const vault = await vaultWithOneRelease();
		const [existing] = await discoverImportSets(vault.app, FOLDER);
		const before = junctionNotes(vault.files);

		await importThroughTheModal(vault.app, INHOUSE_TSV, { click: 'refresh' });

		const sets = await discoverImportSets(vault.app, FOLDER);
		expect(sets).toHaveLength(1);
		expect(sets[0].id).toBe(existing.id);
		// A refresh REPLACES the release it names: the shared pair now carries the
		// in-house predicate, at the path the vendor release wrote.
		const shared = [...before.keys()].find((path) => vault.files.has(path))!;
		expect(vault.files.get(shared)).not.toBe(before.get(shared));
		expect(vault.files.get(shared)).toContain('relatedMatch');
	});
});

describe('what a crosswalk import asks the engine to do to notes it does not own', () => {
	/**
	 * The options the modal hands the importer, captured without changing them.
	 *
	 * `require` rather than a namespace import: this is the same live module
	 * object the modal's own import resolves to, so the spy sees the real call
	 * rather than a copy. `jest.spyOn` with no implementation calls through, so
	 * the import still really happens and the vault assertions elsewhere in this
	 * file stay true of the same code path.
	 */
	async function optionsPassedFor(app: App, tsv: string, opts: { click?: 'refresh' } = {}) {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const importer = require('../src/import/sssom-importer') as Record<string, unknown>;
		const spy = jest.spyOn(importer as never, 'importSssom' as never);
		try {
			await importThroughTheModal(app, tsv, opts);
			expect(spy).toHaveBeenCalledTimes(1);
			return (spy.mock.calls[0] as unknown[])[4] as { importSet?: unknown; overwriteMode?: string };
		} finally {
			spy.mockRestore();
		}
	}

	it('asks for skip on a first import, because a new set owns nothing to replace', async () => {
		const vault = makeVault();
		const passed = await optionsPassedFor(vault.app, VENDOR_TSV);
		expect(passed.importSet).toBe('new');
		expect(passed.overwriteMode).toBe('skip');
	});

	it('asks for skip on a second release with no click, not the importer replace default', async () => {
		// `sssom-importer.ts` defaults `overwriteMode` to `replace` when the caller
		// names none, and this modal used to name none. Combined with the deleted
		// preselect that meant the second release rewrote the first in place. The
		// harmless value is the correct one when nothing was chosen.
		const vault = makeVault();
		await importThroughTheModal(vault.app, VENDOR_TSV);
		const passed = await optionsPassedFor(vault.app, INHOUSE_TSV);
		expect(passed.importSet).toBe('new-set-qualified');
		expect(passed.overwriteMode).toBe('skip');
	});

	it('asks for replace only after the click that says it replaces that release', async () => {
		const vault = makeVault();
		await importThroughTheModal(vault.app, VENDOR_TSV);
		const [existing] = await discoverImportSets(vault.app, FOLDER);
		const passed = await optionsPassedFor(vault.app, INHOUSE_TSV, { click: 'refresh' });
		expect(passed.importSet).toMatchObject({ id: existing.id });
		expect(passed.overwriteMode).toBe('replace');
	});
});
