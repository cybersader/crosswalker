import { TFile, TFolder } from 'obsidian';
import { computeRecipeHash } from '../src/generation/hash';
import { generateNotes, type GenerationOptions } from '../src/generation/generation-engine';
import type { Recipe } from '../src/render';
import { shorthandToSourceExpression } from '../src/source';
import type { ImportRecipe, ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (text: string) => unknown };

type RunOptions = GenerationOptions & { sourceWhere?: string };

function makeApp() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const create = jest.fn(async (path: string, content: string) => {
		files.set(path, content);
		return new TFile(path);
	});
	const modify = jest.fn(async (file: TFile, content: string) => {
		files.set(file.path, content);
	});
	const remove = jest.fn(async (file: TFile) => {
		files.delete(file.path);
	});
	const rename = jest.fn(async (file: TFile, path: string) => {
		const content = files.get(file.path);
		if (content !== undefined) {
			files.delete(file.path);
			files.set(path, content);
		}
		file.path = path;
	});
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((path) => new TFile(path)),
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			create,
			modify,
			delete: remove,
			read: async (file: TFile) => files.get(file.path) ?? '',
			cachedRead: async (file: TFile) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
			rename,
		},
		fileManager: { renameFile: rename },
		metadataCache: { getFileCache: () => null },
	};
	return { app: app as any, files, create, modify, remove, rename };
}

const CONFIG: Partial<ImportRecipe> = {
	name: 'classic-config-name',
	mapping: {
		hierarchy: [],
		frontmatter: [{ column: 'kind', key: 'kind' }],
		links: [],
		body: [],
		filename: { template: '{id}.md', sanitize: true },
	},
};

const SPARSE_CLASSIC_CONFIG: Partial<ImportRecipe> = {
	name: 'sparse-classic-config',
	mapping: {
		hierarchy: [],
		frontmatter: [
			{ column: 'revoked', key: 'revoked' },
			{ column: 'source_ref', key: 'source_ref' },
			{ column: 'target_ref', key: 'target_ref' },
		],
		links: [],
		body: [],
		filename: { template: '{id}.md', sanitize: true },
	},
};

const ROWS = [
	{ id: 'keep', kind: 'target' },
	{ id: 'drop', kind: 'other' },
];

function parsed(rows: Record<string, unknown>[] = ROWS): ParsedData {
	return { columns: ['id', 'kind'], rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
}

function options(extra: Partial<RunOptions> = {}): RunOptions {
	return {
		basePath: 'Out',
		importSet: 'new',
		overwriteMode: 'replace',
		createFolders: true,
		strictValidation: false,
		...extra,
	};
}

function canonical(where: string): Recipe {
	return {
		recipe: 'workbench-recipe-id',
		metadata: { title: 'Workbench recipe' },
		source: {
			ontology: 'workbench-ontology',
			version: '2026',
			levels: ['leaf'],
			where,
			joins: {},
		},
		target: {
			layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }],
			also_emit: { frontmatter: { managed: { kind: '{kind}' } } },
		},
	};
}

function frontmatterFor(files: Map<string, string>, path: string): Record<string, any> {
	const text = files.get(path);
	if (!text) throw new Error(`missing generated note ${path}`);
	const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	if (!match) throw new Error(`missing frontmatter in ${path}`);
	return (yaml.load(match[1]) ?? {}) as Record<string, any>;
}

describe('generateNotes sourceWhere run override', () => {
	it('keeps omitted shim-managed fields absent through the supplemental legacy merge', async () => {
		const vault = makeApp();
		const result = await generateNotes(
			vault.app,
			{ columns: ['id', 'revoked', 'source_ref', 'target_ref'], rows: [{ id: 'kept' }], rowCount: 1 },
			SPARSE_CLASSIC_CONFIG,
			options(),
		);

		expect(result.errors).toEqual([]);
		const fm = frontmatterFor(vault.files, 'Out/kept.md');
		expect(fm._crosswalker?.source_ref).toBeDefined();
		expect(fm).not.toHaveProperty('revoked');
		expect(fm).not.toHaveProperty('source_ref');
		expect(fm).not.toHaveProperty('target_ref');
	});

	it('filters an ordinary import at the existing source stage', async () => {
		const vault = makeApp();
		const result = await generateNotes(
			vault.app,
			parsed(),
			CONFIG,
			options({ sourceWhere: shorthandToSourceExpression('kind=target') }),
		);

		expect(result.errors).toEqual([]);
		expect(result.created).toEqual(['Out/keep.md']);
		expect(result.filteredOut).toBe(1);
		expect([...vault.files.keys()]).toEqual(['Out/keep.md']);
	});

	it.each([
		['unknown field', "missing = 'value'", 'unknown field'],
		['all filtered', "kind = 'not-present'", 'excluded every row'],
	])('%s fails closed without note writes or deletes', async (_label, sourceWhere, message) => {
		const vault = makeApp();
		const result = await generateNotes(vault.app, parsed(), CONFIG, options({ sourceWhere }));

		expect(result.success).toBe(false);
		expect(result.created).toEqual([]);
		expect(result.errors.map((error) => error.message).join('\n')).toContain(message);
		expect(vault.create).not.toHaveBeenCalled();
		expect(vault.modify).not.toHaveBeenCalled();
		expect(vault.remove).not.toHaveBeenCalled();
		expect(vault.rename).not.toHaveBeenCalled();
	});

	it('a blank run override preserves the canonical source.where', async () => {
		const vault = makeApp();
		const recipe = canonical("kind = 'other'");
		const result = await generateNotes(
			vault.app,
			parsed(),
			CONFIG,
			options({ recipeOverride: recipe, sourceWhere: '   ' }),
		);

		expect(result.errors).toEqual([]);
		expect(result.created).toEqual(['Out/drop.md']);
		expect(result.filteredOut).toBe(1);
	});

	it('a nonblank run override replaces canonical where without mutating or narrowing the caller recipe', async () => {
		const vault = makeApp();
		let opaqueReads = 0;
		const recipe = canonical("kind = 'other'") as Recipe & { source: NonNullable<Recipe['source']> & { future_source_field?: unknown } };
		Object.defineProperty(recipe.source, 'future_source_field', {
			enumerable: true,
			configurable: true,
			get: () => {
				opaqueReads += 1;
				return { retained: true };
			},
		});
		const before = JSON.parse(JSON.stringify(recipe));
		opaqueReads = 0;
		const replacement = shorthandToSourceExpression('kind=target')!;

		const result = await generateNotes(
			vault.app,
			parsed(),
			CONFIG,
			options({ recipeOverride: recipe, sourceWhere: replacement, configId: 'saved-config-id' }),
		);

		expect(result.errors).toEqual([]);
		expect(result.created).toEqual(['Out/keep.md']);
		expect(opaqueReads).toBeGreaterThan(0);
		expect(JSON.parse(JSON.stringify(recipe))).toEqual(before);
		const fm = frontmatterFor(vault.files, 'Out/keep.md');
		expect(fm._crosswalker.recipe.id).toBe('workbench-recipe-id');
		expect(fm._crosswalker.recipe.hash).toBe(computeRecipeHash(
			recipe.target,
			{ ...recipe.source, where: replacement },
		));
		expect(fm._crosswalker.source_ref.version).toBe('2026');
	});

	it('keeps classic ownership on configId even when config name differs', async () => {
		const vault = makeApp();
		const result = await generateNotes(
			vault.app,
			parsed([{ id: 'one', kind: 'target' }]),
			CONFIG,
			options({
				configId: 'saved-config-id',
				sourceWhere: shorthandToSourceExpression('kind=target'),
			}),
		);

		expect(result.errors).toEqual([]);
		const fm = frontmatterFor(vault.files, 'Out/one.md');
		expect(CONFIG.name).not.toBe('saved-config-id');
		expect(fm._crosswalker.recipe.id).toBe('saved-config-id');
	});
});
