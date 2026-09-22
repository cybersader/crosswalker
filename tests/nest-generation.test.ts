import { TextDecoder, TextEncoder } from 'node:util';
import { TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import { load } from 'js-yaml';
import fixture from './fixtures/oscal-mini.json';
import { parseJSONFile } from '../src/import/parsers/json-parser';
import { generateFromRecipe } from '../src/generation/generation-engine';
import { computeRecipeHash } from '../src/generation/hash';
import type { Recipe } from '../src/render';
import type { ParsedData, SourceContainer } from '../src/types/config';
import type { StructureMapping } from '../src/import/mapping/types';
import { setFolderDepth } from '../src/import/mapping/view-model';
import { toRecipeRegions } from '../src/import/mapping/serialize';

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

function nestedData(groups: Record<string, unknown>[]): ParsedData {
	return {
		columns: ['id', 'title', 'controls'],
		rows: groups,
		rowCount: groups.length,
		container: { kind: 'json', readDocument: async () => ({ groups }) },
	};
}

function workbook(sheets: Record<string, Record<string, unknown>[]>): SourceContainer {
	return {
		kind: 'workbook',
		sheetNames: Object.keys(sheets),
		readSheet: async (sheet: string, headerRow: number) => {
			const rows = sheets[sheet];
			if (!rows) throw new Error(`no such sheet: ${sheet}`);
			return rows.slice(headerRow);
		},
	};
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
				{ level: 'group', mechanism: 'folder', template: '{_cw.ancestors.group.id}' },
				{ level: 'control', mechanism: 'folder', template: '{_cw.ancestors.control.id}' },
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
	importSet: 'new' as const,
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

	it('N2 uses path identity only for the repeated part level and keeps existing identities on refresh', async () => {
		const groups = [
			{
				id: 'ac',
				title: 'Access coordination',
				controls: [
					{ id: 'ac-1', title: 'Account setup', parts: [{ id: 'statement' }, { id: 'guidance' }] },
					{ id: 'ac-2', title: 'Account review', parts: [{ id: 'statement' }, { id: 'guidance' }] },
				],
			},
		] as Record<string, unknown>[];
		const recipe = nestedRecipe();
		recipe.source!.nest![2].identity = 'path';
		const vault = makeApp();
		const first = await generateFromRecipe(vault.app, nestedData(groups), recipe, OPTIONS);
		expect(first.errors).toEqual([]);
		const original = new Map(
			[...vault.files.entries()].map(([path, text]) => [path, frontmatter(text).curie]),
		);
		expect(frontmatter(vault.files.get('Out/ac/ac.md')!).curie).toBe('oscal-mini:ac');
		expect(frontmatter(vault.files.get('Out/ac/ac-1/ac-1.md')!).curie).toBe('oscal-mini:ac-1');
		expect(frontmatter(vault.files.get('Out/ac/ac-1/statement.md')!).curie).toBe('oscal-mini:ac/ac-1/statement');

		const set = frontmatter(vault.files.get('Out/ac/ac.md')!)._crosswalker.import_set;
		expect(set.nest_identity).toEqual({
			group: 'global',
			control: 'global',
			part: 'path',
		});
		const expandedGroups = JSON.parse(JSON.stringify(groups)) as Record<string, unknown>[];
		(expandedGroups[0].controls as Record<string, unknown>[]).push({
			id: 'ac-3',
			title: 'Account closure',
			parts: [{ id: 'statement' }],
		});
		const second = await generateFromRecipe(vault.app, nestedData(expandedGroups), recipe, {
			...OPTIONS,
			importSet: { id: set.id, scheme: set.scheme },
		});
		expect(second.errors).toEqual([]);
		for (const [path, curie] of original) {
			expect(frontmatter(vault.files.get(path)!).curie).toBe(curie);
		}
		expect(frontmatter(vault.files.get('Out/ac/ac-3/statement.md')!).curie).toBe('oscal-mini:ac/ac-3/statement');

		const beforeFlip = new Map(vault.files);
		const flipped = nestedRecipe();
		flipped.source!.nest![2].identity = 'global';
		const refused = await generateFromRecipe(vault.app, nestedData(expandedGroups), flipped, {
			...OPTIONS,
			importSet: { id: set.id, scheme: set.scheme },
		});
		expect(refused.success).toBe(false);
		expect(refused.created).toEqual([]);
		expect(refused.errors).toContainEqual(expect.objectContaining({
			message: 'source.nest.2.identity: Level "part" is named by its place in this set; import into a new set to change it.',
		}));
		expect(vault.files).toEqual(beforeFlip);
	});

	it('treats a legacy set with no nested identity pin as global and refuses a path recipe', async () => {
		const vault = makeApp();
		vault.files.set('Out/legacy.md', [
			'---',
			'curie: oscal-mini:legacy',
			'_crosswalker:',
			'  import_set:',
			'    id: iset-old002',
			'    scheme: endpoint-v1',
			'    derivation: declared-facts-v1',
			'    ontology: oscal-mini',
			'---',
			'# Legacy',
		].join('\n'));
		const recipe = nestedRecipe();
		recipe.source!.nest![2].identity = 'path';
		const before = new Map(vault.files);
		const result = await generateFromRecipe(vault.app, await parsed(), recipe, {
			...OPTIONS,
			importSet: { id: 'iset-old002', scheme: 'endpoint-v1' },
		});
		expect(result.success).toBe(false);
		expect(result.created).toEqual([]);
		expect(result.errors[0].message).toBe(
			'source.nest.2.identity: Level "part" is named by its place in this set; import into a new set to change it.',
		);
		expect(vault.files).toEqual(before);
	});

	it('N2b keeps slash-bearing path pieces distinct from hierarchy boundaries and raw tokens', async () => {
		const groups = [
			{ id: 'a/b', controls: [{ id: 'c' }] },
			{ id: 'a', controls: [{ id: 'b/c' }, { id: 'a--2f--b' }] },
		] as Record<string, unknown>[];
		const recipe: Recipe = {
			recipe: 'test:path-piece-injectivity',
			source: {
				ontology: 'oscal-mini',
				levels: ['group', 'control'],
				nest: [
					{ level: 'group', id: '{id}', children: 'controls', leaf: 'folder-note' },
					{ level: 'control', id: '{id}', identity: 'path' },
				],
			},
			target: {
				layout: [
					{ level: 'group', mechanism: 'folder', template: '{_cw.ancestors.group.id|fs-safe}' },
					{ level: 'control', mechanism: 'file', template: '{id|fs-safe}.md' },
				],
			},
		};
		const vault = makeApp();
		const result = await generateFromRecipe(vault.app, nestedData(groups), recipe, OPTIONS);
		expect(result.errors).toEqual([]);
		const curies = [...vault.files.values()].map((text) => frontmatter(text).curie);
		expect(new Set(curies).size).toBe(curies.length);
	});

	it('N3 refuses duplicate global nested identity before writing with the nested action', async () => {
		const groups = [
			{ id: 'ac', controls: [{ id: 'ac-1' }] },
			{ id: 'au', controls: [{ id: 'ac-1' }] },
		] as Record<string, unknown>[];
		const recipe: Recipe = {
			recipe: 'test:duplicate-global-nested',
			source: {
				ontology: 'oscal-mini',
				levels: ['group', 'control'],
				nest: [
					{ level: 'group', id: '{id}', children: 'controls', leaf: 'folder-note' },
					{ level: 'control', id: '{id}', identity: 'global' },
				],
			},
			target: {
				layout: [
					{ level: 'group', mechanism: 'folder', template: '{id}' },
					{ level: 'control', mechanism: 'file', template: '{id}.md' },
				],
			},
		};
		const vault = makeApp();
		const result = await generateFromRecipe(vault.app, nestedData(groups), recipe, OPTIONS);
		expect(result.success).toBe(false);
		expect(result.created).toEqual([]);
		expect(result.errors[0].message).toBe(
			'Ambiguous identity oscal-mini:ac-1 claimed by rows at ac/ac-1 and au/ac-1. '
			+ 'Set identity: path on level "control" so each row is named by its place in the hierarchy.',
		);
	});

	it('refuses a nested import into a legacy-derivation set before source expansion', async () => {
		const vault = makeApp();
		const result = await generateFromRecipe(vault.app, await parsed(), nestedRecipe(), {
			...OPTIONS,
			importSet: { id: 'iset-old001', scheme: 'endpoint-v1' },
		});
		expect(result.created).toEqual([]);
		expect(result.errors[0].message).toBe(
			'Nested records need the declared-facts identity rule. This import set was minted under filename-stem-v1; import into a new set.',
		);
	});

	it('N9 re-imports without orphans or moves', async () => {
		const vault = makeApp();
		const data = await parsed();
		const first = await generateFromRecipe(vault.app, data, nestedRecipe(), OPTIONS);
		expect(first.errors).toEqual([]);
		expect(first.success).toBe(true);
		const firstFrontmatter = frontmatter(vault.files.get('Out/ac/ac.md')!);
		const set = firstFrontmatter._crosswalker.import_set;
		const second = await generateFromRecipe(vault.app, await parsed(), nestedRecipe(), {
			...OPTIONS,
			importSet: { id: set.id, scheme: set.scheme },
		});
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

	it('D9 depth one emits group and control notes while recording parts as control properties', async () => {
		const nest = [
			{ level: 'group', id: '{id}', children: 'controls', carry: ['title'], leaf: 'folder-note' as const },
			{ level: 'control', id: '{id}', children: 'parts', carry: ['title', 'parts'], leaf: 'folder-note' as const },
			{ level: 'part', id: '{id}', leaf: 'none' as const },
		];
		const mapping: StructureMapping = {
			levels: [
				{ level: 'group', source: { column: '_cw.ancestors.group.id' }, destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
				{ level: 'control', source: { column: '_cw.ancestors.control.id' }, destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
				{ level: 'part', source: { column: '_cw.ancestors.control.parts' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
			],
		};
		const reshaped = setFolderDepth(mapping, 1, nest);
		const regions = toRecipeRegions({ mappings: [reshaped.mapping], nest: reshaped.nest });
		if (regions.also_emit?.frontmatter?.managed) {
			regions.also_emit.frontmatter.managed.part = '{_cw.ancestors.control.parts|optional}';
		}
		const recipe: Recipe = {
			recipe: 'test:oscal-mini-depth-one',
			source: {
				ontology: 'oscal-mini',
				levels: ['group', 'control', 'part'],
				nest: regions.nest,
			},
			target: {
				layout: regions.layout,
				also_emit: regions.also_emit,
			},
		};
		const vault = makeApp();
		const result = await generateFromRecipe(vault.app, await parsed(), recipe, OPTIONS);
		expect(result.errors).toEqual([]);
		expect(result.created).toHaveLength(9);
		const notes = [...vault.files.values()].map(frontmatter);
		expect(notes.filter((note) => note.level === 'part')).toHaveLength(0);
		const controlNotes = notes.filter((note) => Array.isArray(note.part));
		expect(controlNotes).toHaveLength(6);
		expect(controlNotes.reduce(
			(total, note) => total + (Array.isArray(note.part) ? note.part.length : 0),
			0,
		)).toBe(12);
		const claimed = new Set(notes.map((note) => String(note.curie)));
		const partIds = fixture.catalog.groups.flatMap((group) =>
			group.controls.flatMap((control) => control.parts.map((part) => part.id)),
		);
		expect(partIds.filter((id) => claimed.has(`oscal-mini:${id}`))).toEqual([]);
	});

	it('N10 imports workbook children under controls, warns once for the unparented row, and hashes nest', async () => {
		const controls = [
			{ 'Control ID': '1', title: 'Inventory' },
			{ 'Control ID': '2', title: 'Protection' },
			{ 'Control ID': '3', title: 'Recovery' },
		];
		const safeguards = [
			{ 'Control ID': '1', 'Safeguard ID': '1.1' },
			{ 'Control ID': '1', 'Safeguard ID': '1.2' },
			{ 'Control ID': '2', 'Safeguard ID': '2.1' },
			{ 'Control ID': '2', 'Safeguard ID': '2.2' },
			{ 'Control ID': '3', 'Safeguard ID': '3.1' },
			{ 'Control ID': '3', 'Safeguard ID': '3.2' },
			{ 'Control ID': '99', 'Safeguard ID': '99.1' },
		];
		const data: ParsedData = {
			columns: ['Control ID', 'title'],
			rows: controls,
			rowCount: controls.length,
			container: workbook({ Controls: controls, Safeguards: safeguards }),
		};
		const recipe: Recipe = {
			recipe: 'test:cis-nested-workbook',
			source: {
				ontology: 'cis-mini',
				levels: ['control', 'safeguard'],
				nest: [
					{
						level: 'control',
						id: '{Control ID}',
						children: { sheet: 'Safeguards' },
						leaf: 'folder-note',
					},
					{ level: 'safeguard', id: '{Safeguard ID}', parent_key: 'Control ID' },
				],
			},
			target: {
				layout: [
					{ level: 'control', mechanism: 'folder', template: '{_cw.ancestors.control.[\'Control ID\']}' },
					{ level: 'safeguard', mechanism: 'file', template: '{Safeguard ID}.md' },
				],
				also_emit: { frontmatter: { managed: { parent: '[[{_cw.parent}]]', level: '{_cw.level}' } } },
			},
		};
		const vault = makeApp();
		const result = await generateFromRecipe(vault.app, data, recipe, {
			...OPTIONS,
			curiePrefix: 'cis-mini',
			sourceFileName: 'cis-mini.xlsx',
		});
		expect(result.errors).toEqual([]);
		expect(result.created).toHaveLength(9);
		expect(vault.files.has('Out/1/1.md')).toBe(true);
		expect(vault.files.has('Out/1/1.1.md')).toBe(true);
		expect(frontmatter(vault.files.get('Out/1/1.md')!).curie).toBe('cis-mini:1');
		expect(frontmatter(vault.files.get('Out/1/1.1.md')!).curie).toBe('cis-mini:1.1');
		expect(frontmatter(vault.files.get('Out/1/1.1.md')!).parent).toBe('[[1]]');
		expect(result.warnings?.filter((warning) => warning.message.includes('records name a parent'))).toEqual([
			{ row: 0, message: '1 safeguard records name a parent that is not in the source and were not imported.' },
		]);
		expect(frontmatter(vault.files.get('Out/1/1.md')!)._crosswalker.recipe.hash).toBe(
			computeRecipeHash(recipe.target, recipe.source),
		);
		const set = frontmatter(vault.files.get('Out/1/1.md')!)._crosswalker.import_set;
		const refresh = await generateFromRecipe(vault.app, data, recipe, {
			...OPTIONS,
			curiePrefix: 'cis-mini',
			sourceFileName: 'cis-mini.xlsx',
			importSet: { id: set.id, scheme: set.scheme },
		});
		expect(refresh.errors).toEqual([]);
		expect(refresh.orphans).toBeUndefined();
		expect(vault.renameFile).not.toHaveBeenCalled();
	});

	it('N6 uses folders only for controls while parts keep their control parent', async () => {
		const recipe = nestedRecipe();
		recipe.source!.nest![1].leaf = 'none';
		const vault = makeApp();
		const result = await generateFromRecipe(vault.app, await parsed(), recipe, OPTIONS);
		expect(result.errors).toEqual([]);
		expect(result.created).toHaveLength(15);
		expect(vault.folders.has('Out/ac/ac-1')).toBe(true);
		expect(vault.folders.has('Out/au/au-2')).toBe(true);
		expect(vault.folders.has('Out/cm/cm-2')).toBe(true);
		expect(frontmatter(vault.files.get('Out/ac/ac-1/ac-1_smt.md')!).parent).toBe('[[ac-1]]');
		const curies = [...vault.files.values()].map((text) => frontmatter(text).curie);
		expect(curies).not.toContain('oscal-mini:ac-1');
		expect(curies).not.toContain('oscal-mini:au-2');
		expect(curies).not.toContain('oscal-mini:cm-2');
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
