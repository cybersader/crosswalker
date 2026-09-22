import { TextDecoder, TextEncoder } from 'node:util';
import { TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import { load } from 'js-yaml';
import fixture from './fixtures/oscal-mini.json';
import { parseJSONFile } from '../src/import/parsers/json-parser';
import { generateFromRecipe } from '../src/generation/generation-engine';
import type { Recipe } from '../src/render';

Object.assign(globalThis, { TextDecoder, TextEncoder });

function frontmatter(text: string): Record<string, any> {
	const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	if (!match) return {};
	return (load(match[1]) as Record<string, any>) ?? {};
}

function makeApp() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['', 'Out', 'Flat']);
	const renameFile = jest.fn(async (file: { path: string }, path: string) => {
		const content = files.get(file.path);
		if (content === undefined) throw new Error(`Missing source file: ${file.path}`);
		files.delete(file.path);
		files.set(path, content);
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
			create: async (path: string, content: string) => {
				files.set(path, content);
				return new TFile(path);
			},
			modify: async (file: { path: string }, content: string) => { files.set(file.path, content); },
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
			rename: renameFile,
		},
		fileManager: { renameFile },
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const text = files.get(file.path);
				return text === undefined ? null : { frontmatter: frontmatter(text) };
			},
			on: () => ({}),
			offref: () => {},
		},
	};
	return { app: app as unknown as App, files, folders, renameFile };
}

function jsonFile(): File {
	const text = JSON.stringify(fixture);
	const file = new File([text], 'oscal-mini.json');
	if (typeof file.arrayBuffer !== 'function') {
		const bytes = new TextEncoder().encode(text).buffer;
		(file as File & { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer = async () => bytes;
	}
	return file;
}

async function parsed() {
	return parseJSONFile(jsonFile(), { iterator: '$.catalog.groups[*]' });
}

function nestedRecipe(where?: string): Recipe {
	return {
		recipe: 'test:oscal-mini-nested',
		source: {
			ontology: 'oscal-mini',
			levels: ['group', 'control', 'part'],
			nest: [
				{ level: 'group', id: '{id}', children: 'controls', carry: ['title'], leaf: 'folder-note' },
				{ level: 'control', id: '{id}', children: 'parts', carry: ['title'], leaf: 'folder-note' },
				{ level: 'part', id: '{id}' },
			],
			...(where ? { where } : {}),
		},
		target: {
			layout: [
				{ level: 'group', mechanism: 'folder', template: '{_cw.ancestors.group.id|optional}' },
				{ level: 'control', mechanism: 'folder', template: '{_cw.ancestors.control.id|optional}' },
				{ level: 'part', mechanism: 'file', template: '{id}.md' },
			],
			also_emit: {
				frontmatter: {
					managed: {
						title: '{title|optional}',
						parent: '[[{_cw.parent}]]',
						level: '{_cw.level}',
					},
				},
			},
		},
	};
}

const OPTIONS = {
	basePath: 'Out',
	importSet: { id: 'iset-oscm01' },
	overwriteMode: 'replace' as const,
	createFolders: true,
	curiePrefix: 'oscal-mini',
	curieLocalPart: (row: Record<string, unknown>) => String(row.id),
	sourceFileName: 'oscal-mini.json',
};

describe('nested generation', () => {
	it('N1/D4 emits 21 nested notes with parent links and document provenance', async () => {
		const vault = makeApp();
		const result = await generateFromRecipe(vault.app, await parsed(), nestedRecipe(), OPTIONS);
		expect(result.errors).toEqual([]);
		expect(result.success).toBe(true);
		expect(result.created).toHaveLength(21);
		expect(result.orphansChecked).toBe(true);
		expect(vault.files.has('Out/ac/ac.md')).toBe(true);
		expect(vault.files.has('Out/ac/ac-1/ac-1.md')).toBe(true);
		expect(vault.files.has('Out/ac/ac-1/ac-1_smt.md')).toBe(true);

		const control = frontmatter(vault.files.get('Out/ac/ac-1/ac-1.md')!);
		const part = frontmatter(vault.files.get('Out/ac/ac-1/ac-1_smt.md')!);
		expect(control.parent).toBe('[[ac]]');
		expect(part.parent).toBe('[[ac-1]]');
		const group = frontmatter(vault.files.get('Out/ac/ac.md')!);
		expect(part._crosswalker.source_ref).toEqual(group._crosswalker.source_ref);
		expect(part._crosswalker.import_set).toEqual(group._crosswalker.import_set);
		expect(part._crosswalker.source_ref.file).toBe('oscal-mini.json');
		expect(part._crosswalker.source_ref.source_hash).toMatch(/^sha256-/);
	});

	it('N9 re-imports without orphans or moves', async () => {
		const vault = makeApp();
		const data = await parsed();
		const first = await generateFromRecipe(vault.app, data, nestedRecipe(), OPTIONS);
		expect(first.errors).toEqual([]);
		expect(first.success).toBe(true);
		const second = await generateFromRecipe(vault.app, await parsed(), nestedRecipe(), OPTIONS);
		expect(second.success).toBe(true);
		expect(second.orphansChecked).toBe(true);
		expect(second.orphans).toBeUndefined();
		expect(second.moved ?? []).toEqual([]);
		expect(vault.renameFile).not.toHaveBeenCalled();
	});

	it('N4 keeps descendants of an excluded group and places them one level up with warnings', async () => {
		const vault = makeApp();
		const result = await generateFromRecipe(
			vault.app,
			await parsed(),
			nestedRecipe("_cw.level != 'group' or id != 'au'"),
			OPTIONS,
		);
		expect(result.errors).toEqual([]);
		expect(result.success).toBe(true);
		expect(result.created).toHaveLength(20);
		expect(vault.files.has('Out/au/au.md')).toBe(false);
		expect([...vault.files.keys()]).toEqual(expect.arrayContaining([
			'Out/au-1/au-1.md',
			'Out/au-2/au-2.md',
		]));
		const skipped = result.warnings?.filter((warning) => warning.message.includes('Level "group" rendered empty')) ?? [];
		expect(skipped).toHaveLength(6);
		expect(skipped.some((warning) => warning.row === 9)).toBe(true);
		expect(skipped.some((warning) => warning.row === 12)).toBe(true);
	});

	it('N7 preserves flat one-row-per-level-zero behavior when nest is absent', async () => {
		const vault = makeApp();
		const flatRecipe: Recipe = {
			recipe: 'test:oscal-mini-flat',
			source: { ontology: 'oscal-mini', levels: ['group'] },
			target: {
				layout: [{ level: 'group', mechanism: 'file', template: '{id}.md' }],
				also_emit: { frontmatter: { managed: { title: '{title}' } } },
			},
		};
		const result = await generateFromRecipe(vault.app, await parsed(), flatRecipe, { ...OPTIONS, basePath: 'Flat' });
		expect(result.success).toBe(true);
		expect(result.created.sort()).toEqual(['Flat/ac.md', 'Flat/au.md', 'Flat/cm.md']);
		for (const text of vault.files.values()) {
			expect(frontmatter(text)).not.toHaveProperty('_cw');
		}
	});
});
