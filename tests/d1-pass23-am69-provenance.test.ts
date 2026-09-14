/**
 * d1-pass23-am69-provenance.test.ts — AM-69 (2026-09-04): provenance belongs to
 * the run that WROTE the content it describes.
 *
 * A `_crosswalker` block is a statement about the note's rendered content. When
 * a run regenerates that content, the block is this run's and every field of it
 * is fresh. When a run does NOT regenerate it — a held facet hub whose members
 * merely shrank because a row left the source — the recorded block is preserved
 * and only `produced_at` moves, because `produced_at` is the one field that is
 * about the write rather than about the content. And a refresh that changes
 * nothing writes nothing at all, so a quoted YAML scalar and a list survive
 * byte-for-byte rather than being re-serialised into a different but equivalent
 * spelling.
 *
 * The facet value below is `Region: EU` deliberately: a colon forces
 * `formatYamlValue` down its quoting branch, so the note carries a quoted string
 * AND a `tags:` list — the two shapes a re-serialisation is most likely to
 * change while leaving the parsed value equal.
 */

import { TFile, TFolder } from 'obsidian';
import { generateFromRecipe } from '../src/generation/generation-engine';
import type { Recipe } from '../src/render';
import type { ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

function makeApp() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const modifyCalls: string[] = [];
	const createCalls: string[] = [];
	const rename = async (file: { path: string }, to: string) => {
		const text = files.get(file.path);
		files.delete(file.path);
		if (text !== undefined) files.set(to, text);
		file.path = to;
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
			create: async (path: string, content: string) => { createCalls.push(path); files.set(path, content); return new TFile(path); },
			modify: async (file: { path: string }, content: string) => { modifyCalls.push(file.path); files.set(file.path, content); },
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
			rename,
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
		},
		fileManager: { renameFile: rename },
	};
	return { app: app as any, files, modifyCalls, createCalls };
}

const BASE = 'Frameworks';
const ONT = 'p23am69';
const FACET_EU = `${BASE}/Region_ EU.md`;
const FACET_US = `${BASE}/US.md`;

/**
 * `children_lists` is flipped for the v2 recipe on purpose: `computeRecipeHash`
 * hashes `recipe.target` + `recipe.source`, so changing only the recipe id or
 * the source file name would NOT change the hash and the test would prove
 * nothing about a fresh hash reaching the note.
 */
function recipe(recipeId: string): Recipe {
	return {
		recipe: recipeId,
		source: { ontology: ONT, levels: ['tactic', 'leaf'] },
		target: {
			layout: [
				{ level: 'tactic', mechanism: 'folder', template: '{tactic}' },
				{ level: 'leaf', mechanism: 'file', template: '{id}.md' },
			],
			enrichment: { children_lists: recipeId !== 'v2', facet_notes: 'notes', parent_note: 'sibling', level_hubs: 'none' },
		},
	};
}

function run(app: any, parsed: ParsedData, overwriteMode: 'skip' | 'replace', importSet: any, recipeId: string, sourceFileName: string) {
	return generateFromRecipe(app, parsed, recipe(recipeId), {
		basePath: BASE,
		overwriteMode,
		createFolders: true,
		sourceFileName,
		importSet,
		curieLocalPart: (row: Record<string, unknown>) => String(row.id),
		facetsForRow: (row: Record<string, unknown>) => [{ namespace: 'domain', value: String(row.domain) }],
	});
}

function frontmatterOf(text: string): any {
	const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	return match ? (yaml.load(match[1]) as any) : {};
}

const COLUMNS = ['id', 'name', 'tactic', 'domain'];
const ROWS_ALL = [
	{ id: 'P1', name: 'P one', tactic: 'Persistence', domain: 'Region: EU' },
	{ id: 'P2', name: 'P two', tactic: 'Persistence', domain: 'Region: EU' },
	{ id: 'R1', name: 'R one', tactic: 'Recon', domain: 'US' },
	{ id: 'R2', name: 'R two', tactic: 'Recon', domain: 'US' },
	{ id: 'R3', name: 'R three', tactic: 'Recon', domain: 'US' },
];
const parsedOf = (rows: Record<string, unknown>[]): ParsedData => ({ columns: COLUMNS, rows, rowCount: rows.length });

async function seed() {
	const { app, files, modifyCalls, createCalls } = makeApp();
	const first = await run(app, parsedOf(ROWS_ALL), 'replace', 'new', 'v1', 'source-v1.csv');
	expect(first.errors).toEqual([]);
	const setId = frontmatterOf(files.get(`${BASE}/Persistence/P1.md`)!)?._crosswalker?.import_set?.id;
	expect(typeof setId).toBe('string');
	const euBefore = files.get(FACET_EU)!;
	const usBefore = files.get(FACET_US)!;
	// The two shapes a re-serialisation would most plausibly change.
	expect(euBefore).toContain('curie: "p23am69:facet/domain/region-eu"');
	expect(euBefore).toContain('tags:\n  - domain/region-eu');
	modifyCalls.length = 0;
	createCalls.length = 0;
	return { app, files, modifyCalls, createCalls, setId, euBefore, usBefore };
}

describe('AM-69: provenance belongs to the run that wrote the content', () => {
	it('Replace with a changed recipe hash: the facet hub carries THIS run\'s recipe, source, producer and import set', async () => {
		const { app, files, setId, euBefore } = await seed();
		const beforeProv = frontmatterOf(euBefore)._crosswalker;
		const second = await run(app, parsedOf(ROWS_ALL), 'replace', { id: setId }, 'v2', 'source-v2.csv');
		expect(second.errors).toEqual([]);
		const prov = frontmatterOf(files.get(FACET_EU)!)._crosswalker;

		expect(prov.recipe.id).toBe('v2');
		expect(prov.recipe.hash).not.toBe(beforeProv.recipe.hash);
		expect(prov.source_ref.file).toBe('source-v2.csv');
		expect(prov.producer.kind).toBe('plugin-engine');
		expect(prov.producer.name).toBe('crosswalker-plugin');
		// The set is the one the run was told to write into, not a fresh mint.
		expect(prov.import_set.id).toBe(setId);
		expect(prov.import_set.ontology).toBe(ONT);
		expect(prov.produced_at).not.toBe(beforeProv.produced_at);
	});

	it('an all-skip refresh writes nothing, so the quoted scalar and the list survive byte-for-byte', async () => {
		const { app, files, modifyCalls, createCalls, setId, euBefore, usBefore } = await seed();
		const second = await run(app, parsedOf(ROWS_ALL), 'skip', { id: setId }, 'v1', 'source-v1.csv');
		expect(second.errors).toEqual([]);
		expect(modifyCalls).toEqual([]);
		expect(createCalls).toEqual([]);
		expect(files.get(FACET_EU)).toBe(euBefore);
		expect(files.get(FACET_US)).toBe(usBefore);
	});

	it('a held facet whose managed member list shrank: recorded provenance preserved, only produced_at moves', async () => {
		const { app, files, modifyCalls, setId, usBefore } = await seed();
		// R3 leaves the source entirely. US still has two members, so the hub is not
		// retracted — its managed list simply changed, and nothing else did.
		const rows = ROWS_ALL.filter((r) => r.id !== 'R3');
		const second = await run(app, parsedOf(rows), 'skip', { id: setId }, 'v1', 'source-v1.csv');
		expect(second.errors).toEqual([]);
		expect(modifyCalls).toContain(FACET_US);

		const before = frontmatterOf(usBefore)._crosswalker;
		const after = frontmatterOf(files.get(FACET_US)!)._crosswalker;
		// Everything about the CONTENT is the recorded run's, not this one's.
		expect(after.recipe).toEqual(before.recipe);
		expect(after.source_ref).toEqual(before.source_ref);
		expect(after.producer).toEqual(before.producer);
		expect(after.import_set).toEqual(before.import_set);
		expect(after.spec_version).toBe(before.spec_version);
		// `produced_at` is about the write, so it — and only it — moves.
		expect(after.produced_at).not.toBe(before.produced_at);
		expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
		// The managed list really did change; this is not a vacuous pass.
		expect(frontmatterOf(files.get(FACET_US)!).members).toEqual(['[[R1]]', '[[R2]]']);
		expect(frontmatterOf(usBefore).members).toEqual(['[[R1]]', '[[R2]]', '[[R3]]']);
	});

	/**
	 * THE SAME SHRINK UNDER A RECIPE THIS RUN CHANGED.
	 *
	 * The test above re-runs the SAME recipe, so the fresh block and the recorded
	 * block agree on every field but `produced_at` — which means it cannot tell a
	 * preserved block from a freshly built one. Here the second run carries `v2`,
	 * whose hash genuinely differs, so a run that rebuilt the block instead of
	 * preserving it would stamp `v2` onto a note whose content `v1` wrote. This is
	 * the assertion that actually distinguishes the two.
	 */
	it('the same shrink under a CHANGED recipe: the note keeps the recipe that wrote its content, not this run\'s', async () => {
		const { app, files, modifyCalls, setId, usBefore } = await seed();
		const rows = ROWS_ALL.filter((r) => r.id !== 'R3');
		const second = await run(app, parsedOf(rows), 'skip', { id: setId }, 'v2', 'source-v2.csv');
		expect(second.errors).toEqual([]);
		expect(modifyCalls).toContain(FACET_US);

		const before = frontmatterOf(usBefore)._crosswalker;
		const after = frontmatterOf(files.get(FACET_US)!)._crosswalker;
		// This run really is carrying a different recipe and a different source.
		expect(before.recipe.id).toBe('v1');
		expect(before.source_ref.file).toBe('source-v1.csv');
		// And the note still records the run that wrote what is in it.
		expect(after.recipe).toEqual(before.recipe);
		expect(after.source_ref).toEqual(before.source_ref);
		expect(after.produced_at).not.toBe(before.produced_at);
	});
});
