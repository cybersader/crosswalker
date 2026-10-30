import { TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import type { Recipe } from '../src/render';
import type { ParsedData } from '../src/types/config';
import { candidateCrosswalkCuries, candidateRunIdentities, candidateSourceRows, releaseIdentityPlanningSource, generateFromRecipe, generateNotes, runIdentityCuries } from '../src/generation/generation-engine';
import { discoverImportSets, newSetSchemeFor, newSetSchemeFrom } from '../src/generation/import-set';
import { buildIdentityIndex } from '../src/generation/identity-index';
import { legacyConfigToRecipe } from '../src/generation/legacy-recipe-shim';
import { buildSyntheticRecipe } from '../src/import/sssom-importer';
import { parseCSVFileStream } from '../src/import/parsers/csv-parser';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };
function makeApp() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const rename = async (file: { path: string }, to: string) => {
		const text = files.get(file.path);
		files.delete(file.path);
		if (text !== undefined) files.set(to, text);
		file.path = to;
	};
	const fileObj = (p: string) => {
		const f = new TFile(p) as unknown as Record<string, unknown>;
		const base = p.split('/').pop() ?? p;
		const dot = base.lastIndexOf('.');
		f.basename = dot > 0 ? base.slice(0, dot) : base;
		f.extension = dot > 0 ? base.slice(dot + 1) : '';
		return f as unknown as TFile;
	};
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map(fileObj),
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return fileObj(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			create: async (path: string, content: string) => { files.set(path, content); return fileObj(path); },
			modify: async (file: { path: string }, content: string) => { files.set(file.path, content); },
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
				try {
					return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> };
				} catch {
					return { frontmatter: undefined };
				}
			},
		},
		fileManager: { renameFile: rename },
	};
	return { app: app as unknown as App, files };
}


function parsed(rows: Record<string, unknown>[]): ParsedData {
	return { rows, rowCount: rows.length, columns: [...new Set(rows.flatMap(Object.keys))] };
}
const recipe: Recipe = {
	recipe: 'identity-plan', source: { ontology: 'mitre-attack', levels: ['leaf'] },
	target: { layout: [{ level: 'leaf', mechanism: 'file', template: '{title|fs-safe}.md' }] },
};
const row = (id: string) => ({ id, title: id });
const sorted = (values: Iterable<string>) => [...values].sort();
async function planned(data: ParsedData, recipeInput = recipe, extra = {}) {
	const shaped = await candidateSourceRows(data, recipeInput);
	return candidateRunIdentities(shaped.rows, recipeInput, { basePath: 'Next', streamed: !Array.isArray(data.rows), rowNumbers: shaped.rowNumbers, ...extra });
}
async function run(app: App, data: ParsedData, recipeInput = recipe, importSet: 'new' | 'new-set-qualified' = 'new', extra = {}) {
	return generateFromRecipe(app, data, recipeInput, {
		basePath: 'Next', overwriteMode: 'replace', createFolders: true, importSet, ...extra,
	});
}

describe('exact candidate identities and whole-set release isolation', () => {
	it('keeps two disjoint publisher catalogs unqualified and resolves both by identity', async () => {
		const { app } = makeApp();
		expect((await run(app, parsed([row('T1001')]), recipe, 'new', { basePath: 'Techniques' })).errors).toEqual([]);
		const data = parsed([row('M1001')]);
		const proposal = await planned(data);
		const mode = await newSetSchemeFor(app, 'mitre-attack', proposal.claims);
		expect(mode).toBe('new');
		expect((await run(app, data, recipe, mode)).errors).toEqual([]);
		const index = await buildIdentityIndex(app);
		expect(index.get('mitre-attack:T1001')).not.toBeNull();
		expect(index.get('mitre-attack:M1001')).not.toBeNull();
		expect((await discoverImportSets(app)).map((set) => set.scheme)).toEqual(['endpoint-v1', 'endpoint-v1']);
	});

	it.each([['T1001'], ['T1001', 'T9999']])('one overlap qualifies every identity in the new release: %j', async (...ids) => {
		const { app } = makeApp();
		await run(app, parsed([row('T1001')]), recipe, 'new', { basePath: 'First' });
		const data = parsed(ids.map(row));
		const proposal = await planned(data);
		const mode = await newSetSchemeFor(app, 'mitre-attack', proposal.claims);
		expect(mode).toBe('new-set-qualified');
		const result = await run(app, data, recipe, mode);
		expect(result.errors).toEqual([]);
		const latest = (await discoverImportSets(app)).find((set) => set.root === 'Next')!;
		expect(latest.scheme).toBe('set-qualified-v1');
		expect([...latest.curies].every((curie) => curie.startsWith(`mitre-attack-${latest.id}:`))).toBe(true);
	});

	it('refuses a later chosen refresh that crosses into the other disjoint set', async () => {
		const { app, files } = makeApp();
		await run(app, parsed([row('T1001')]), recipe, 'new', { basePath: 'Techniques' });
		await run(app, parsed([row('M1001')]), recipe, 'new', { basePath: 'Mitigations' });
		const sets = await discoverImportSets(app);
		const techniques = sets.find((set) => set.root === 'Techniques')!;
		const mitigations = sets.find((set) => set.root === 'Mitigations')!;
		const held = files.get('Mitigations/M1001.md');
		const result = await generateFromRecipe(app, parsed([row('T1001'), row('M1001')]), recipe, {
			basePath: 'Techniques', overwriteMode: 'replace', createFolders: true, importSet: { id: techniques.id },
		});
		expect(result.errors.some((error) => error.message.includes(mitigations.id) && error.message.includes('Refresh into a new set'))).toBe(true);
		expect(files.get('Mitigations/M1001.md')).toBe(held);
		expect((await discoverImportSets(app)).find((set) => set.id === techniques.id)?.scheme).toBe('endpoint-v1');
	});

	it('includes legacy hub aliases as claims but not as freshly written identities', () => {
		const result = runIdentityCuries({ hubs: [
			{ curie: 'a:new', legacyCuries: ['a:old'] },
			{ curie: null, legacyCuries: ['a:alias-only'] },
		] });
		expect(sorted(result.written)).toEqual(['a:new']);
		expect(sorted(result.claims)).toEqual(['a:alias-only', 'a:new', 'a:old']);
		expect(newSetSchemeFrom(new Set(['a:old']), 'a', result.claims)).toBe('new-set-qualified');
	});
});

const fixtures: Array<{ name: string; rows: Record<string, unknown>[]; recipe: Recipe; extra?: Record<string, unknown> }> = [
	{ name: 'declared and injectively sanitized ids', rows: [{ curie: 'mitre-attack:AC-2(1)/a', title: 'Declared' }, row('AC 2')], recipe },
	{ name: 'row-number fallback independent of address', rows: [{ title: 'Not an identity' }], recipe },
	{ name: 'custom row callback', rows: [row('A')], recipe, extra: { curieLocalPart: (_row: unknown, number: number) => `custom-${number}` } },
	{ name: 'filtered original row numbers', rows: [{ title: 'Drop', keep: false }, { title: 'Keep', keep: true }], recipe: { ...recipe, source: { ...recipe.source, where: 'keep = true' } } },
	{ name: 'hierarchy and facet hubs', rows: [{ ...row('A'), group: 'Common' }, { ...row('B'), group: 'Common' }], recipe: {
		...recipe, source: { ...recipe.source, levels: ['group', 'leaf'] }, target: {
			layout: [{ level: 'group', mechanism: 'folder', template: '{group}' }, ...recipe.target.layout],
			also_emit: { tags: ['group/{group|tagsafe}'] },
			enrichment: { children_lists: true, facet_notes: 'notes', level_hubs: 'notes', parent_note: 'sibling' },
		},
	} },
	{ name: 'implied concept without enrichment block', rows: [{ ...row('child'), parent: 'Parent' }], recipe: {
		...recipe, source: { ...recipe.source, levels: ['parent', 'leaf'] }, target: {
			layout: [{ level: 'parent', mechanism: 'folder', template: '{parent}', implied_concept: { identity: '{parent}' } }, ...recipe.target.layout],
		},
	} },
	{ name: 'nested path identity', rows: [{ id: 'g1', title: 'Group', controls: [{ id: 'c1', title: 'Child' }] }], recipe: {
		...recipe, source: { ...recipe.source, levels: ['group', 'control'], nest: [
			{ level: 'group', id: '{id}', children: 'controls', leaf: 'folder-note' },
			{ level: 'control', id: '{id}', identity: 'path' },
		] }, target: { layout: [
			{ level: 'group', mechanism: 'folder', template: '{_cw.ancestors.group.id}' },
			{ level: 'control', mechanism: 'file', template: '{id}.md' },
		] },
	} },
	{ name: 'implied identity with old hub aliases', rows: [{ ...row('child'), parent: 'Parent' }], recipe: {
		...recipe, source: { ...recipe.source, levels: ['parent', 'leaf'] }, target: {
			layout: [{ level: 'parent', mechanism: 'folder', template: '{parent}', implied_concept: { identity: '{parent}' } }, ...recipe.target.layout],
			enrichment: { level_hubs: 'notes', facet_notes: 'none', children_lists: true },
		},
	} },
];

describe.each(fixtures)('planner/engine equality: $name', (fixture) => {
	it('plans precisely the identities the fresh engine writes', async () => {
		const { app } = makeApp();
		const data = parsed(fixture.rows);
		const proposal = await planned(data, fixture.recipe, fixture.extra);
		const result = await run(app, data, fixture.recipe, 'new', fixture.extra);
		expect(result.errors).toEqual([]);
		expect(sorted((await buildIdentityIndex(app)).curies())).toEqual(sorted(proposal.written));
	});

	it.each(['empty', 'disjoint-owned', 'overlap-owned', 'overlap-null-owner', 'overlap-last-claim'])(
		'never accepts an unqualified run that AM-12 refuses (%s)', async (state) => {
			const { app, files } = makeApp();
			const data = parsed(fixture.rows);
			const proposal = await planned(data, fixture.recipe, fixture.extra);
			if (state !== 'empty') {
				const curie = state === 'disjoint-owned' ? 'mitre-attack:unrelated' : state === 'overlap-last-claim' ? [...proposal.claims].at(-1)! : [...proposal.claims][0];
				files.set('Held.md', `---\ncurie: "${curie}"\n_crosswalker:\n${state === 'overlap-null-owner' ? '  recipe: { id: legacy }' : '  import_set: { id: iset-aaaaaa, scheme: endpoint-v1, ontology: mitre-attack }'}\n---\nHeld user text.\n`);
			}
			const before = new Map(files);
			const mode = await newSetSchemeFor(app, 'mitre-attack', proposal.claims);
			expect(mode).toBe(state.startsWith('overlap') ? 'new-set-qualified' : 'new');
			const result = await run(app, data, fixture.recipe, mode, fixture.extra);
			if (mode === 'new') expect(result.errors.filter((error) => /Cross-set identity collision/.test(error.message))).toEqual([]);
			expect(result.errors).toEqual([]);
			for (const [path, text] of before) expect(files.get(path)).toBe(text);
		},
	);
});

it('uses the legacy filename fallback rather than the rendered address', async () => {
	const { app } = makeApp();
	const config = { name: 'mitre-attack', mapping: { hierarchy: [], filename: { template: '{raw}.md', sanitize: true }, frontmatter: [], body: [] } };
	const legacy = legacyConfigToRecipe(config as never);
	const data = parsed([{ raw: 'AC/2', title: 'Display title' }]);
	const proposal = await planned(data, legacy, { mapping: config.mapping });
	const result = await generateNotes(app, data, config as never, { basePath: 'Next', createFolders: true, overwriteMode: 'replace', importSet: 'new' });
	expect(result.errors).toEqual([]);
	expect(sorted((await buildIdentityIndex(app)).curies())).toEqual(sorted(proposal.written));
});

it('replays a one-shot source after planning, without consuming its only rows', async () => {
	const { app } = makeApp();
	const data = { columns: ['id', 'title'], rowCount: 2, rows: (async function* () { yield row('A'); yield row('B'); })() };
	const proposal = await planned(data);
	const result = await run(app, data);
	expect(result.errors).toEqual([]);
	expect(sorted((await buildIdentityIndex(app)).curies())).toEqual(sorted(proposal.written));
});

it('plans joined and filtered identities through the same source stage', async () => {
	const { app } = makeApp();
	const rows = [{ ...row('A'), key: 'one' }, { ...row('B'), key: 'two' }];
	const data: ParsedData = { ...parsed(rows), container: {
		kind: 'workbook', sheetNames: ['lookup'],
		readSheet: async () => [{ key: 'one', enabled: true }, { key: 'two', enabled: false }],
	} };
	const joined: Recipe = { ...recipe, source: { ...recipe.source,
		joins: { lookup: { from: { sheet: 'lookup' }, on: { primary: 'key', secondary: 'key' }, cardinality: 'one' } },
		// Source filters run before joins, so they name primary fields.
		where: "key = 'one'",
	} };
	const proposal = await planned(data, joined);
	const result = await run(app, data, joined);
	expect(result.errors).toEqual([]);
	expect(sorted((await buildIdentityIndex(app)).curies())).toEqual(sorted(proposal.written));
	expect(sorted(proposal.written)).toEqual(['mitre-attack:A']);
});

it('mapping proposals name assertions, not endpoints, and equal engine writes', async () => {
	const { app } = makeApp();
	const rows = [{
		subject_id: 'vendor:AC/2', object_id: 'other:X(1)', predicate_id: 'intersects_with',
		subject_label: 'Subject', object_label: 'Object', mapping_justification: 'semapv:ManualMappingCuration',
		mapping_provider: 'Synthetic', mapping_set_id: '', predicate_modifier: '',
		sssom_predicate: 'skos:relatedMatch', edge_body: 'Synthetic assertion.',
	}];
	const edgeRecipe = buildSyntheticRecipe('vendor', 'other');
	const proposal = candidateCrosswalkCuries(rows);
	const plan = await planned(parsed(rows), edgeRecipe);
	expect(sorted(plan.written)).toEqual(sorted(proposal));
	expect(proposal.has(rows[0].subject_id)).toBe(false);
	expect(proposal.has(rows[0].object_id)).toBe(false);
	const result = await run(app, parsed(rows), edgeRecipe);
	expect(result.errors).toEqual([]);
	expect(sorted((await buildIdentityIndex(app)).curies())).toEqual(sorted(proposal));
});


it('qualifies overlap with an implied hub even without an enrichment block', async () => {
	const { app, files } = makeApp();
	const implied = fixtures.find((fixture) => fixture.name === 'implied concept without enrichment block')!;
	const data = parsed(implied.rows);
	const proposal = await planned(data, implied.recipe);
	const hub = [...proposal.written].find((curie) => curie !== 'mitre-attack:child')!;
	expect(hub).toBeDefined();
	files.set('Existing hub.md', `---\ncurie: "${hub}"\n_crosswalker:\n  import_set: { id: iset-aaaaaa, scheme: endpoint-v1, ontology: mitre-attack }\n---\n`);
	const mode = await newSetSchemeFor(app, 'mitre-attack', proposal.claims);
	expect(mode).toBe('new-set-qualified');
	expect((await run(app, data, implied.recipe, mode)).errors).toEqual([]);
});

it.each(['native', 'config'])('keeps a streamed folder-note refresh byte-identical after planning (%s)', async (entry) => {
	const clock = jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-10-30T12:00:00.000Z');
	try {
	const { app, files } = makeApp();
	const folderRecipe: Recipe = { ...recipe, source: { ...recipe.source, levels: ['group', 'leaf'] }, target: {
		layout: [{ level: 'group', mechanism: 'folder', template: '{group}' }, ...recipe.target.layout],
		enrichment: { children_lists: true, level_hubs: 'notes', parent_note: 'folder-note' },
	} };
	const config = { name: 'mitre-attack', mapping: { hierarchy: [], frontmatter: [], links: [], body: [] } };
	const source = () => Object.freeze({ ...parsed([]), rowCount: 1,
		rows: (async function* () { yield { ...row('child'), group: 'Parent' }; })() });
	const execute = (data: ParsedData, importSet: unknown) => entry === 'native'
		? generateFromRecipe(app, data, folderRecipe, { basePath: 'Next', overwriteMode: 'replace', createFolders: true, importSet } as never)
		: generateNotes(app, data, config, { basePath: 'Next', overwriteMode: 'replace', createFolders: true, importSet, recipeOverride: folderRecipe } as never);
	expect((await execute(source(), 'new')).errors).toEqual([]);
	const [set] = await discoverImportSets(app);
	expect((await execute(source(), { id: set.id })).errors).toEqual([]);
	const baseline = new Map(files);
	const data = source();
	const originalRows = data.rows;
	await planned(data, folderRecipe, { importSet: set, ...(entry === 'config' ? { config } : {}) });
	expect(data.rows).toBe(originalRows);
	expect(Array.isArray(data.rows)).toBe(false);
	expect((await execute(data, { id: set.id })).errors).toEqual([]);
	expect(files).toEqual(baseline);
	} finally { clock.mockRestore(); }
});

it('reads a reopenable stream independently without consuming generation rows', async () => {
	let generationReads = 0;
	const originalRows = { async *[Symbol.asyncIterator]() { generationReads++; yield row('A'); } };
	const data: ParsedData = { columns: ['id', 'title'], rowCount: 1, rows: originalRows,
		reopenRows: () => (async function* () { yield row('A'); })(),
	};
	const { app } = makeApp();
	await planned(data);
	releaseIdentityPlanningSource(data);
	expect(generationReads).toBe(0);
	expect(data.rows).toBe(originalRows);
	expect((await run(app, data)).errors).toEqual([]);
	expect(generationReads).toBe(1);
});

it('honors the set ontology pin after the recipe is renamed, including enrichment', async () => {
	const { app } = makeApp();
	const data = parsed([{ ...row('A'), group: 'Group' }]);
	const enriched = fixtures.find((fixture) => fixture.name === 'hierarchy and facet hubs')!.recipe;
	expect((await run(app, data, enriched)).errors).toEqual([]);
	const [set] = await discoverImportSets(app);
	const renamed: Recipe = { ...enriched, recipe: 'renamed-recipe', source: { ...enriched.source, ontology: 'different-proposal' } };
	const proposal = await planned(data, renamed, { importSet: set });
	expect(sorted(proposal.written)).toEqual(sorted(set.curies));
	expect((await generateFromRecipe(app, data, renamed, { basePath: 'Next', overwriteMode: 'replace', importSet: { id: set.id } })).errors).toEqual([]);
	expect(sorted((await buildIdentityIndex(app)).curies())).toEqual(sorted(proposal.written));
});

it('uses the config name, not the recipe id, for an override without source ontology', async () => {
	const { app } = makeApp();
	const override: Recipe = { ...recipe, recipe: 'renamed-display-recipe', source: { levels: ['leaf'] } };
	const config = { name: 'Publisher catalog', mapping: { hierarchy: [], frontmatter: [], links: [], body: [] } };
	const data = parsed([row('A')]);
	const proposal = await planned(data, override, { config });
	expect(sorted(proposal.written)).toEqual(['publisher-catalog:A']);
	expect((await generateNotes(app, data, config, { basePath: 'Next', overwriteMode: 'replace', importSet: 'new', recipeOverride: override })).errors).toEqual([]);
	expect(sorted((await buildIdentityIndex(app)).curies())).toEqual(sorted(proposal.written));
});

it('shares the engine filename-stem fallback when no mapping option was supplied', async () => {
	const { app, files } = makeApp();
	files.set('Next/A.md', '---\ncurie: mitre-attack:row-1\n_crosswalker:\n  import_set: { id: iset-aaaaaa, scheme: endpoint-v1, ontology: mitre-attack, derivation: filename-stem-v1, destination: Next }\n---\n');
	const [set] = await discoverImportSets(app);
	const config = { name: 'mitre-attack', mapping: { hierarchy: [], frontmatter: [], links: [], body: [] } };
	const data = parsed([row('A')]);
	const proposal = await planned(data, recipe, { config, importSet: set });
	expect(sorted(proposal.written)).toEqual(['mitre-attack:row-1']);
	expect((await generateNotes(app, data, config, { basePath: 'Next', overwriteMode: 'replace', importSet: { id: set.id }, recipeOverride: recipe })).errors).toEqual([]);
	expect(sorted((await buildIdentityIndex(app)).curies())).toEqual(sorted(proposal.written));
});


it('reopens a real CSV parser stream for planning and leaves the original iterator intact', async () => {
	const { app } = makeApp();
	const data = parseCSVFileStream(new File(['id,title\nA,First\nB,Second\n'], 'synthetic.csv'));
	const original = data.rows;
	const proposal = await planned(data);
	expect(data.rows).toBe(original);
	expect(Array.isArray(data.rows)).toBe(false);
	expect((await run(app, data)).errors).toEqual([]);
	expect(sorted((await buildIdentityIndex(app)).curies())).toEqual(sorted(proposal.written));
	expect(sorted(proposal.written)).toEqual(['mitre-attack:A', 'mitre-attack:B']);
});


describe('second-round source planning safety', () => {
	it('replays only the original one-shot wrapper and refuses exhausted spread copies', async () => {
		const data: ParsedData = { columns: ['id', 'title'], rowCount: 2,
			rows: (async function* () { yield row('A'); yield row('B'); })(),
		};
		const config = { name: 'mitre-attack', mapping: { hierarchy: [], frontmatter: [], links: [], body: [] } };
		const proposal = await planned(data, recipe, { config });
		releaseIdentityPlanningSource(data);
		const { app, files } = makeApp();
		const options = { basePath: 'Next', createFolders: true, importSet: 'new' as const, recipeOverride: recipe };
		const consumed = /already been consumed.*Reopen the source file/s;
		await expect(candidateSourceRows({ ...data }, recipe)).rejects.toThrow(consumed);
		await expect(generateNotes(app, { ...data }, config, options)).rejects.toThrow(consumed);
		expect(files.size).toBe(0);
		const result = await generateNotes(app, data, config, options);
		expect(result.errors).toEqual([]);
		expect(sorted((await buildIdentityIndex(app)).curies())).toEqual(sorted(proposal.written));
		expect(result.created).toHaveLength(2);
		// Taking the replay also releases its retained snapshot. Another read is
		// now an explicit refusal, not a successful import of zero rows.
		await expect(generateNotes(app, data, config, options)).rejects.toThrow(consumed);
		await expect(generateNotes(app, { ...data }, config, options)).rejects.toThrow(consumed);
	});

	it('refuses reuse of a one-shot source consumed directly by generation', async () => {
		const { app } = makeApp();
		const data: ParsedData = { columns: ['id', 'title'], rowCount: 1,
			rows: (async function* () { yield row('A'); })(),
		};
		expect((await run(app, data)).errors).toEqual([]);
		await expect(run(app, { ...data })).rejects.toThrow('already been consumed');
	});

	it.each(['', '/', ' /Next//Nested/ ', '\\Next\\Nested\\'])('shares normalized enrichment roots with both engines: %j', async (basePath) => {
		const fixture = fixtures.find((item) => item.name === 'hierarchy and facet hubs')!;
		const config = { name: 'mitre-attack', mapping: { hierarchy: [], frontmatter: [], links: [], body: [] } };
		for (const entry of ['native', 'config']) {
			const { app } = makeApp();
			const data = parsed(fixture.rows);
			const proposal = await planned(data, fixture.recipe, { basePath, ...(entry === 'config' ? { config } : {}) });
			const options = { basePath, createFolders: true, importSet: 'new' as const };
			const result = entry === 'native'
				? await generateFromRecipe(app, data, fixture.recipe, options)
				: await generateNotes(app, data, config, { ...options, recipeOverride: fixture.recipe });
			expect(result.errors).toEqual([]);
			expect(sorted((await buildIdentityIndex(app)).curies())).toEqual(sorted(proposal.written));
		}
	});
});


describe.each(['native', 'config'] as const)('third-round source retry: %s', (entry) => {
	const config = { name: 'mitre-attack', mapping: { hierarchy: [], frontmatter: [], links: [], body: [] } };
	const execute = (app: App, data: ParsedData, recipeInput: Recipe, importSet: unknown = 'new') => {
		const options = { basePath: 'Next', createFolders: true, overwriteMode: 'replace' as const, importSet: importSet as 'new' };
		return entry === 'native' ? generateFromRecipe(app, data, recipeInput, options)
			: generateNotes(app, data, config, { ...options, recipeOverride: recipeInput });
	};

	it('reopens a CSV after a partial failed run and imports all retry rows', async () => {
		const { app } = makeApp();
		const data = parseCSVFileStream(new File(['id,title\nA,First\nB,Second\n'], 'synthetic.csv'));
		const create = app.vault.create.bind(app.vault);
		let refused = false;
		const write = jest.spyOn(app.vault, 'create').mockImplementation(async (...args) => {
			if (!refused && args[0].endsWith('/Second.md')) { refused = true; throw new Error('Synthetic write failure'); }
			return create(...args);
		});
		try {
			const first = await execute(app, data, recipe);
			expect(refused).toBe(true);
			expect(first.errors.length).toBeGreaterThan(0);
			const [set] = await discoverImportSets(app);
			expect(set).toBeDefined();
			const retry = await execute(app, data, recipe, { id: set.id });
			expect(retry.errors).toEqual([]);
			expect(sorted((await buildIdentityIndex(app)).curies())).toEqual(['mitre-attack:A', 'mitre-attack:B']);
			expect(retry.created).toContain('Next/Second.md');
		} finally { write.mockRestore(); }
	});

	it('retains a planned one-shot replay when preflight fails before reading it', async () => {
		const { app } = makeApp();
		const data: ParsedData = { columns: ['id', 'title'], rowCount: 2,
			rows: (async function* () { yield row('A'); yield row('B'); })(),
		};
		await planned(data);
		const invalid: Recipe = { ...recipe, source: { ...recipe.source, where: '$notPermitted(id)' } };
		const failed = await execute(app, data, invalid);
		expect(failed.errors.length).toBeGreaterThan(0);
		const retry = await execute(app, data, recipe);
		expect(retry.errors).toEqual([]);
		expect(retry.created).toHaveLength(2);
		await expect(execute(app, { ...data }, recipe)).rejects.toThrow('already been consumed');
	});
});
