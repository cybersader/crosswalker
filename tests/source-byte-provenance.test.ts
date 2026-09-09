/**
 * XLSX source-byte provenance wiring through both generation entrances and all
 * existing provenance writers. Synthetic ParsedData digests stand in for the
 * parser boundary; wizard-parsers.test.ts proves the XLSX parser computes them
 * from the exact captured bytes.
 */

import { TFile, TFolder } from 'obsidian';
import { generateFromRecipe, generateNotes } from '../src/generation/generation-engine';
import type { GenerationOptions, RecipeImportOptions } from '../src/generation/generation-engine';
import type { Recipe } from '../src/render';
import type { ImportRecipe, ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (source: string) => unknown };

const DIGEST_A = `sha256-${'a'.repeat(64)}`;
const DIGEST_B = `sha256-${'b'.repeat(64)}`;

function makeApp() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const createCalls: string[] = [];
	const modifyCalls: string[] = [];
	const rename = async (file: { path: string }, to: string) => {
		const content = files.get(file.path);
		files.delete(file.path);
		if (content !== undefined) files.set(to, content);
		file.path = to;
	};
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((path) => new TFile(path)),
			getFiles: () => [...files.keys()].map((path) => new TFile(path)),
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			create: async (path: string, content: string) => {
				createCalls.push(path);
				files.set(path, content);
				return new TFile(path);
			},
			modify: async (file: { path: string }, content: string) => {
				modifyCalls.push(file.path);
				files.set(file.path, content);
			},
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
			rename,
		},
		fileManager: { renameFile: rename },
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
	};
	return { app: app as any, files, createCalls, modifyCalls };
}

function frontmatterOf(text: string): Record<string, any> {
	const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	return match ? ((yaml.load(match[1]) ?? {}) as Record<string, any>) : {};
}

function sourceHashOf(text: string): unknown {
	return frontmatterOf(text)._crosswalker?.source_ref?.source_hash;
}

function importSetOf(text: string): { id: string } {
	return { id: frontmatterOf(text)._crosswalker.import_set.id as string };
}

function parsed(rows: Record<string, unknown>[], digest?: string): ParsedData {
	return {
		columns: [...new Set(rows.flatMap((row) => Object.keys(row)))],
		rows,
		rowCount: rows.length,
		...(digest !== undefined ? { sourceByteDigest: digest } : {}),
	};
}

const ENRICHED_RECIPE: Recipe = {
	recipe: 'source-byte-provenance',
	source: { ontology: 'source-bytes', levels: ['group', 'leaf'] },
	target: {
		layout: [
			{ level: 'group', mechanism: 'folder', template: '{group}' },
			{ level: 'leaf', mechanism: 'file', template: '{id}.md' },
		],
		enrichment: {
			children_lists: true,
			facet_notes: 'notes',
			parent_note: 'sibling',
			level_hubs: 'notes',
		},
	},
};

const FLAT_RECIPE: Recipe = {
	recipe: 'source-byte-flat',
	source: { ontology: 'source-bytes', levels: ['leaf'] },
	target: {
		layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }],
		also_emit: { frontmatter: { managed: { title: '{title}' } } },
	},
};

const LEGACY_CONFIG: Partial<ImportRecipe> = {
	name: 'source-bytes',
	mapping: {
		hierarchy: [],
		frontmatter: [],
		links: [],
		body: [],
		filename: { template: '{id}.md', sanitize: true },
	},
};

const ENRICHED_ROWS = [
	{ id: 'A-1', title: 'Alpha', group: 'Persistence', facet: 'US' },
	{ id: 'A-2', title: 'Beta', group: 'Persistence', facet: 'US' },
];

function nativeOptions(overwriteMode: 'skip' | 'replace' | 'error', importSet?: { id: string }): RecipeImportOptions {
	return {
		basePath: 'Out',
		overwriteMode,
		createFolders: true,
		strictValidation: false,
		...(importSet ? { importSet } : {}),
		curieLocalPart: (row) => String(row.id),
		facetsForRow: (row) => [{ namespace: 'facet', value: String(row.facet) }],
	};
}

function legacyOptions(recipeOverride: Recipe, overwriteMode: 'skip' | 'replace' | 'error', importSet?: { id: string }): GenerationOptions {
	return {
		basePath: 'Out',
		overwriteMode,
		createFolders: true,
		strictValidation: false,
		recipeOverride,
		...(importSet ? { importSet } : {}),
		facetsForRow: (row) => [{ namespace: 'facet', value: String(row.facet) }],
	};
}

async function runEntry(
	entry: 'generateNotes' | 'generateFromRecipe',
	app: any,
	data: ParsedData,
	recipe: Recipe,
	overwriteMode: 'skip' | 'replace' | 'error',
	importSet?: { id: string },
) {
	return entry === 'generateNotes'
		? generateNotes(app, data, LEGACY_CONFIG, legacyOptions(recipe, overwriteMode, importSet))
		: generateFromRecipe(app, data, recipe, nativeOptions(overwriteMode, importSet));
}

describe.each(['generateNotes', 'generateFromRecipe'] as const)(
	'XLSX source-byte provenance through %s',
	(entry) => {
		it('stamps row, facet-hub and level-hub writers with one source digest', async () => {
			const { app, files } = makeApp();
			const result = await runEntry(entry, app, parsed(ENRICHED_ROWS, DIGEST_A), ENRICHED_RECIPE, 'replace');
			expect(result.errors).toEqual([]);

			const expectedPaths = [
				'Out/Persistence/A-1.md',
				'Out/US.md',
				'Out/Persistence/Persistence.md',
				'Out/Out.md',
			];
			for (const path of expectedPaths) {
				expect(files.has(path)).toBe(true);
				expect(sourceHashOf(files.get(path)!)).toBe(DIGEST_A);
			}
		});

		it.each([undefined, ''])('omits source_hash from every writer when the parsed digest is %p', async (digest) => {
			const { app, files } = makeApp();
			const result = await runEntry(entry, app, parsed(ENRICHED_ROWS, digest), ENRICHED_RECIPE, 'replace');
			expect(result.errors).toEqual([]);
			for (const path of [
				'Out/Persistence/A-1.md',
				'Out/US.md',
				'Out/Persistence/Persistence.md',
				'Out/Out.md',
			]) {
				const sourceRef = frontmatterOf(files.get(path)!)._crosswalker.source_ref;
				expect('source_hash' in sourceRef).toBe(false);
				expect(Object.keys(sourceRef)).not.toContain('source_hash');
			}
		});
	},
);

describe('source-byte provenance re-import preservation', () => {
	it('skip and error keep old bytes, while replace refreshes the digest and preserves user frontmatter', async () => {
		const { app, files, modifyCalls } = makeApp();
		const first = await generateFromRecipe(
			app,
			parsed([{ id: 'A-1', title: 'Alpha' }], DIGEST_A),
			FLAT_RECIPE,
			nativeOptions('replace'),
		);
		expect(first.errors).toEqual([]);
		const notePath = 'Out/A-1.md';
		const importSet = importSetOf(files.get(notePath)!);
		files.set(notePath, files.get(notePath)!.replace('title: Alpha', 'title: Alpha\nreviewer: human'));
		const userEdited = files.get(notePath)!;

		modifyCalls.length = 0;
		const skipped = await generateFromRecipe(
			app,
			parsed([{ id: 'A-1', title: 'Changed' }], DIGEST_B),
			FLAT_RECIPE,
			nativeOptions('skip', importSet),
		);
		expect(skipped.skipped).toEqual([notePath]);
		expect(files.get(notePath)).toBe(userEdited);
		expect(modifyCalls).toEqual([]);
		expect(sourceHashOf(files.get(notePath)!)).toBe(DIGEST_A);

		const errored = await generateFromRecipe(
			app,
			parsed([{ id: 'A-1', title: 'Changed' }], DIGEST_B),
			FLAT_RECIPE,
			nativeOptions('error', importSet),
		);
		expect(errored.errors[0]?.message).toContain('File already exists');
		expect(files.get(notePath)).toBe(userEdited);
		expect(modifyCalls).toEqual([]);

		const replaced = await generateFromRecipe(
			app,
			parsed([{ id: 'A-1', title: 'Changed' }], DIGEST_B),
			FLAT_RECIPE,
			nativeOptions('replace', importSet),
		);
		expect(replaced.errors).toEqual([]);
		const after = frontmatterOf(files.get(notePath)!);
		expect(after.title).toBe('Changed');
		expect(after.reviewer).toBe('human');
		expect(after._crosswalker.source_ref.source_hash).toBe(DIGEST_B);
	});

	it('does not backfill a previously unrecorded digest on a skip', async () => {
		const { app, files, modifyCalls } = makeApp();
		await generateFromRecipe(
			app,
			parsed([{ id: 'A-1', title: 'Alpha' }]),
			FLAT_RECIPE,
			nativeOptions('replace'),
		);
		const notePath = 'Out/A-1.md';
		const importSet = importSetOf(files.get(notePath)!);
		const before = files.get(notePath)!;
		modifyCalls.length = 0;
		await generateFromRecipe(
			app,
			parsed([{ id: 'A-1', title: 'Alpha' }], DIGEST_A),
			FLAT_RECIPE,
			nativeOptions('skip', importSet),
		);
		expect(files.get(notePath)).toBe(before);
		expect(sourceHashOf(before)).toBeUndefined();
		expect(modifyCalls).toEqual([]);
	});
});

const HOSTED_RECIPE: Recipe = {
	recipe: 'source-byte-hosted',
	source: { ontology: 'source-hosted', levels: ['tail', 'leaf'] },
	target: {
		layout: [
			{ level: 'tail', mechanism: 'folder', template: '{id}', variadic: { delimiter: '.' } },
			{ level: 'leaf', mechanism: 'file', template: '{id}.md' },
		],
		enrichment: {
			children_lists: true,
			facet_notes: 'none',
			parent_note: 'sibling',
			level_hubs: 'notes',
		},
	},
};

describe('kept-host enrichment provenance', () => {
	it('updates only managed host regions and keeps the digest of the workbook bytes that wrote the row', async () => {
		const { app, files } = makeApp();
		const rowsA = [
			{ id: 'T1078', title: 'Parent' },
			{ id: 'T1078.001', title: 'Child one' },
		];
		await generateFromRecipe(app, parsed(rowsA, DIGEST_A), HOSTED_RECIPE, nativeOptions('replace'));
		const hostPath = 'Out/T1078.md';
		const importSet = importSetOf(files.get(hostPath)!);
		files.set(hostPath, files.get(hostPath)!.replace('_crosswalker:', 'reviewer: human\n_crosswalker:'));

		const rowsB = [...rowsA, { id: 'T1078.002', title: 'Child two' }];
		const result = await generateFromRecipe(app, parsed(rowsB, DIGEST_B), HOSTED_RECIPE, nativeOptions('skip', importSet));
		expect(result.errors).toEqual([]);
		const host = files.get(hostPath)!;
		expect(host).toContain('[[T1078.001]]');
		expect(host).toContain('[[T1078.002]]');
		expect(frontmatterOf(host).reviewer).toBe('human');
		expect(sourceHashOf(host)).toBe(DIGEST_A);
		expect(sourceHashOf(files.get('Out/T1078/T1078.002.md')!)).toBe(DIGEST_B);
	});
});
