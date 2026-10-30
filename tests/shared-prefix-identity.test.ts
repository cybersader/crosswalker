import { TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import type { Recipe } from '../src/render';
import type { ParsedData } from '../src/types/config';
import { candidateCrosswalkCuries, candidateRunIdentities, candidateSourceRows, generateFromRecipe, generateNotes, runIdentityCuries } from '../src/generation/generation-engine';
import { discoverImportSets, newSetSchemeFor, newSetSchemeFrom } from '../src/generation/import-set';
import { buildIdentityIndex } from '../src/generation/identity-index';
import { legacyConfigToRecipe } from '../src/generation/legacy-recipe-shim';
import { buildSyntheticRecipe } from '../src/import/sssom-importer';
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
	return candidateRunIdentities(shaped.rows, recipeInput, { basePath: 'Next', rowNumbers: shaped.rowNumbers, ...extra });
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
