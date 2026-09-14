/**
 * new-set-scheme.test.ts — AM-18 (2026-08-31): the qualification rule has ONE
 * implementation.
 *
 * THE QUESTION. Every route to a new import set has to answer "which new set":
 * `endpoint-v1`, whose curie prefix is the ontology slug alone, or
 * `set-qualified-v1`, whose prefix carries the set id so two releases of one
 * framework — or two crosswalks over one pair — coexist instead of meeting as an
 * AM-12 collision on every row.
 *
 * THE DEFECT. That rule had THREE implementations and two were wrong:
 *
 *   - the import wizard compared the source's ontology prefix against every set
 *     in the WHOLE vault. Correct.
 *   - the crosswalk modal asked whether the pair's mapping folder was empty
 *     (`sets.length === 0 ? 'new' : 'new-set-qualified'`, scoped to
 *     `_crosswalker/mappings/<a>-to-<b>`). A folder is an ADDRESS, and this
 *     project's own rule is that an address does not name an owner: drag that
 *     folder somewhere else in Obsidian and the next import of the pair saw an
 *     empty destination, minted an unqualified set straight into the moved
 *     set's occupied curie space, and met it as a collision on every row.
 *   - the developer fixture command passed the bare literal `'new'` and asked
 *     nothing at all.
 *
 * A rule with three copies is not implemented; it is re-guessed per window. This
 * file pins the rule once and then pins that each caller reaches it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { TFile, TFolder } from 'obsidian';
import {
	discoverImportSets,
	newSetSchemeFor,
	newSetSchemeFrom,
	type DiscoveredImportSet,
} from '../src/generation/import-set';
import { ImportFlow } from '../src/import/import-wizard';
import { SssomImportModal } from '../src/import/sssom-import-modal';
import { SSSOM_CURIE_PREFIX } from '../src/import/sssom-importer';
import { MappingWorkbench } from '../src/import/workbench';
import { analyzeColumns } from '../src/import/parsers/csv-parser';
import { DEFAULT_SETTINGS } from '../src/settings/settings-data';
// Imported, never retyped: these are the placeholder identities a nameless
// classic import stamps, and a second copy of the literals in a test is a copy
// that can agree with a drifted implementation instead of catching it.
import { LEGACY_ONTOLOGY_SENTINEL } from '../src/generation/legacy-recipe-shim';
import type { App } from 'obsidian';
import type CrosswalkerPlugin from '../src/main';
import type { DebugLog } from '../src/utils/debug';
import type { ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

const debugStub = {
	info() {}, trace() {}, warn() {}, error() {},
	currentTraceId: () => undefined,
	newTraceId: () => 'test-trace',
	withTrace: <T>(_id: string, fn: () => T): T => fn(),
} as unknown as DebugLog;

// ---------------------------------------------------------------------------
// Vault double, seeded by NOTES rather than by running an import. Discovery
// reads what notes carry, so a hand-seeded note is the same fact as an imported
// one -- and it is the only way to express "the same set, at a different
// address", which is the state this amendment is about.
// ---------------------------------------------------------------------------

function makeVault() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((p) => new TFile(p)),
			getAbstractFileByPath: (path_: string) => {
				if (files.has(path_)) return new TFile(path_);
				if (folders.has(path_)) return new TFolder(path_);
				return null;
			},
			create: async (path_: string, content: string) => { files.set(path_, content); return new TFile(path_); },
			modify: async (file: { path: string }, content: string) => { files.set(file.path, content); },
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path_: string) => { folders.add(path_); },
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
			on: () => ({}),
			offref: () => {},
		},
	};
	return { app: app as unknown as App, files };
}

/** One set's worth of notes, at whatever address the caller names. */
function seedSet(
	files: Map<string, string>,
	opts: { root: string; setId: string; prefix: string; count?: number },
): void {
	for (let i = 1; i <= (opts.count ?? 2); i += 1) {
		files.set(`${opts.root}/n${i}.md`, [
			'---',
			`curie: "${opts.prefix}:item-${i}"`,
			'kind: crosswalk-edge',
			'_crosswalker:',
			'  import_set:',
			`    id: ${opts.setId}`,
			'    scheme: endpoint-v1',
			'---',
			'Body.',
			'',
		].join('\n'));
	}
}

const PAIR_FOLDER = '_crosswalker/mappings/csf-to-iso27001';
const MOVED_FOLDER = 'Archive/an old crosswalk';

// ---------------------------------------------------------------------------
// 1. The rule itself.
// ---------------------------------------------------------------------------

const setWith = (prefixes: string[]): DiscoveredImportSet => ({
	id: 'iset-aaaaaa',
	scheme: 'endpoint-v1',
	paths: ['x.md'],
	root: 'x',
	destination: null,
	ontology: null,
	recipeIds: [],
	ontologyPrefixes: prefixes,
} as unknown as DiscoveredImportSet);

describe('the rule: which new set would this source mint', () => {
	it('qualifies when an existing set already writes under this prefix', () => {
		expect(newSetSchemeFrom([setWith(['sssom'])], 'sssom')).toBe('new-set-qualified');
	});

	it('stays plain when nothing occupies the prefix', () => {
		// Every pre-existing import path keeps the identities it already wrote.
		expect(newSetSchemeFrom([setWith(['attack'])], 'sssom')).toBe('new');
		expect(newSetSchemeFrom([], 'sssom')).toBe('new');
	});

	it('degrades to plain for a source with no prefix to compare', () => {
		expect(newSetSchemeFrom([setWith(['sssom'])], null)).toBe('new');
	});

	it('never treats the placeholder identity as an occupied space', () => {
		// The sentinel is what a nameless classic import stamps. It is not a fact
		// about any ontology, so two unrelated sources carrying it must not be read
		// as sharing an identity space.
		expect(newSetSchemeFrom([setWith([LEGACY_ONTOLOGY_SENTINEL])], LEGACY_ONTOLOGY_SENTINEL)).toBe('new');
	});

	it('reads the prefixes the notes actually carry, not a set\'s pinned ontology', () => {
		// A set already minted set-qualified pins the UNQUALIFIED ontology while its
		// notes carry the qualified prefix. It is the notes that decide whether a
		// space is taken, so a fresh import of the same ontology does not collide
		// with it and stays plain.
		const qualified = { ...setWith(['sssom-iset-aaaaaa']), ontology: 'sssom' } as DiscoveredImportSet;
		expect(newSetSchemeFrom([qualified], 'sssom')).toBe('new');
	});
});

// ---------------------------------------------------------------------------
// 2. The rule does not depend on WHERE the occupying set lives.
// ---------------------------------------------------------------------------

describe('a set that moved', () => {
	async function answerFor(root: string): Promise<'new' | 'new-set-qualified'> {
		const { app, files } = makeVault();
		seedSet(files, { root, setId: 'iset-aaaaaa', prefix: SSSOM_CURIE_PREFIX });
		return newSetSchemeFor(app, SSSOM_CURIE_PREFIX);
	}

	it('occupies its identity space from wherever it sits', async () => {
		// The E-3 scenario in one line: a plain Obsidian drag moves the pair folder
		// somewhere else. Under the folder-emptiness rule the second answer was
		// `new`, minted straight into the moved set's curie space.
		expect(await answerFor(PAIR_FOLDER)).toBe('new-set-qualified');
		expect(await answerFor(MOVED_FOLDER)).toBe('new-set-qualified');
		expect(await answerFor(MOVED_FOLDER)).toBe(await answerFor(PAIR_FOLDER));
	});

	it('and an empty vault still answers plainly', async () => {
		// The control. A rule that always qualified would pass the case above and
		// would silently change every first import in the product.
		const { app } = makeVault();
		expect(await newSetSchemeFor(app, SSSOM_CURIE_PREFIX)).toBe('new');
	});
});

// ---------------------------------------------------------------------------
// 3. Every caller reaches that one rule.
// ---------------------------------------------------------------------------

/** The wizard's `newSetOption()`, driven through a real ImportFlow. */
function wizardAnswer(app: App, sets: DiscoveredImportSet[], ontology: string): string {
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, defaultOutputPath: 'Ontologies' },
		debug: debugStub,
	} as unknown as ConstructorParameters<typeof ImportFlow>[1];
	const flow = new ImportFlow(
		app as ConstructorParameters<typeof ImportFlow>[0],
		plugin,
		{ containerEl: {} as HTMLElement, close: () => {} },
	);
	const data: ParsedData = {
		columns: ['id', 'name'],
		rows: [{ id: 'A-1', name: 'One' }],
		rowCount: 1,
	};
	flow.sourceFile = { name: `${ontology}.csv` } as File;
	flow.parsedData = data;
	flow.columnConfigs = new Map([
		['id', { useAs: 'title', outputKey: 'id' }],
		['name', { useAs: 'frontmatter', outputKey: 'name' }],
	] as unknown as ConstructorParameters<typeof Map>[0]);
	// The shipped path for a framework import is the shape workbench, and it is
	// the only path carrying a real ontology.
	flow.workbench = new MappingWorkbench({
		parsedData: data,
		columnInfos: analyzeColumns(data),
		outputPath: 'Ontologies',
		debug: debugStub,
		defaultPresetId: 'browsable-framework',
		sourceOntology: ontology,
		onChange: () => {},
	});
	const internals = flow as unknown as { discoveredSets: DiscoveredImportSet[] | null; newSetOption(): string };
	internals.discoveredSets = sets;
	return internals.newSetOption();
}

/** The crosswalk modal's `selectedImportSet()`, with the pair already detected. */
async function modalAnswer(app: App): Promise<unknown> {
	const plugin = {
		settings: {},
		debug: debugStub,
		runProjection: null,
		precomputeClosure: null,
	} as unknown as CrosswalkerPlugin;
	const modal = new SssomImportModal(app, plugin) as unknown as {
		detectedSource: string | null;
		detectedTarget: string | null;
		importSetChoice: unknown;
		selectedImportSet(): Promise<unknown>;
	};
	modal.detectedSource = 'csf';
	modal.detectedTarget = 'iso27001';
	modal.importSetChoice = null;
	return modal.selectedImportSet();
}

describe('every caller answers with that rule, and none with its own', () => {
	/**
	 * Deliberately driven at ONE prefix -- the space SSSOM edges occupy -- so
	 * "the three agree" is an equality between three answers to the same
	 * question, not three answers to three different ones.
	 */
	async function allThree(seed?: { root: string }) {
		const { app, files } = makeVault();
		if (seed) seedSet(files, { root: seed.root, setId: 'iset-aaaaaa', prefix: SSSOM_CURIE_PREFIX });
		const sets = await discoverImportSets(app, undefined);
		return {
			rule: newSetSchemeFrom(sets, SSSOM_CURIE_PREFIX),
			shared: await newSetSchemeFor(app, SSSOM_CURIE_PREFIX),
			wizard: wizardAnswer(app, sets, SSSOM_CURIE_PREFIX),
			modal: await modalAnswer(app),
		};
	}

	it('all say plain on an empty vault', async () => {
		const answers = await allThree();
		expect(answers).toEqual({ rule: 'new', shared: 'new', wizard: 'new', modal: 'new' });
	});

	it('all say qualified when the pair folder holds that set', async () => {
		const answers = await allThree({ root: PAIR_FOLDER });
		expect(answers).toEqual({
			rule: 'new-set-qualified',
			shared: 'new-set-qualified',
			wizard: 'new-set-qualified',
			modal: 'new-set-qualified',
		});
	});

	it('all say qualified when that set has been MOVED out of the pair folder', async () => {
		// The one state the three used to disagree about. `sets.length === 0` at the
		// pair folder is true here and says nothing about the identity space.
		const answers = await allThree({ root: MOVED_FOLDER });
		expect(answers).toEqual({
			rule: 'new-set-qualified',
			shared: 'new-set-qualified',
			wizard: 'new-set-qualified',
			modal: 'new-set-qualified',
		});
	});

	it('the modal answers the same way when it could not detect the pair at all', async () => {
		// This route used to return a bare `new`. There is no reason for an
		// undetected pair to answer the qualification question differently from
		// any other route to a new set.
		const { app, files } = makeVault();
		seedSet(files, { root: MOVED_FOLDER, setId: 'iset-aaaaaa', prefix: SSSOM_CURIE_PREFIX });
		const plugin = { settings: {}, debug: debugStub, runProjection: null, precomputeClosure: null } as unknown as CrosswalkerPlugin;
		const modal = new SssomImportModal(app, plugin) as unknown as {
			detectedSource: string | null;
			detectedTarget: string | null;
			selectedImportSet(): Promise<unknown>;
		};
		modal.detectedSource = null;
		modal.detectedTarget = null;
		expect(await modal.selectedImportSet()).toBe('new-set-qualified');
	});

	it('an explicit "keep both as a new set" click is not re-derived into something weaker', async () => {
		// The user pressed a control that promised set-qualified identities. Passing
		// that answer back through the rule could downgrade it to `new` on a vault
		// where nothing collides, which is not what the screen said.
		const { app } = makeVault();
		const plugin = { settings: {}, debug: debugStub, runProjection: null, precomputeClosure: null } as unknown as CrosswalkerPlugin;
		const modal = new SssomImportModal(app, plugin) as unknown as {
			detectedSource: string | null;
			detectedTarget: string | null;
			importSetChoice: unknown;
			importSetChoiceBasePath: string | null;
			selectedImportSet(): Promise<unknown>;
		};
		modal.detectedSource = 'csf';
		modal.detectedTarget = 'iso27001';
		modal.importSetChoice = 'new-set-qualified';
		// A choice belongs to the destination it was made about: the modal drops it
		// when the destination changes under it, which is why the click has to be
		// recorded against this pair's folder, exactly as the render does.
		modal.importSetChoiceBasePath = PAIR_FOLDER;
		expect(await modal.selectedImportSet()).toBe('new-set-qualified');
	});
});

// ---------------------------------------------------------------------------
// 4. The one caller that cannot be driven from a unit test.
// ---------------------------------------------------------------------------

describe('the developer fixture command', () => {
	// It runs behind a fixture-picker modal and a dynamic import chain, so there
	// is nothing to call. What can be pinned is that it no longer carries an
	// answer of its own -- which is exactly the defect (E-2): a bare literal that
	// always minted endpoint-v1, so loading a bundled fixture into a vault that
	// already held that ontology pair produced a set whose curie space was
	// occupied, and every row was then refused.
	const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');

	it('asks the shared rule instead of naming a scheme itself', () => {
		expect(source).toContain('newSetSchemeFor(this.app, SSSOM_CURIE_PREFIX)');
	});

	it('carries no import-set literal of its own', () => {
		// Matched with a terminator so the pattern names a VALUE handed to the
		// importer (`importSet: 'new',`) rather than a type annotation on the
		// variable that carries the shared rule's answer
		// (`let importSet: 'new' | 'new-set-qualified';`, added by AM-24 when the
		// rule gained a throw that has to be caught before the import starts).
		// Without the terminator this assertion fails on a declaration that is the
		// fix rather than the defect.
		expect(source).not.toMatch(/importSet:\s*'new'\s*[,;)]/);
		expect(source).not.toMatch(/importSet:\s*'new-set-qualified'\s*[,;)]/);
		// And the assignment form, which the property-shorthand refactor makes the
		// other way to smuggle a literal in.
		expect(source).not.toMatch(/importSet\s*=\s*'new'/);
		expect(source).not.toMatch(/importSet\s*=\s*'new-set-qualified'/);
	});
});
