import { TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import { dump, load } from 'js-yaml';
import {
	deriveCrosswalkEdgeRows,
	buildCrosswalkColumnRecipe,
	runCrosswalkEdgePass,
	type CrosswalkEdgeInput,
} from '../src/generation/crosswalk-edge-pass';
import { generateFromRecipe, generateNotes } from '../src/generation/generation-engine';
import { sssomEdgeCurie } from '../src/generation/crosswalk-identity';
import { discoverImportSets } from '../src/generation/import-set';
import { validateTier1Frontmatter } from '../src/validation/validator';
import type { DebugLog } from '../src/utils/debug';
import type { Recipe } from '../src/render';
import { computeMappingSetDigests, readMappingSet } from '../src/mappings/mapping-set';
import { managedContentEquivalent } from '../src/generation/managed-equivalence';

const debug = {
	info() {}, trace() {}, warn() {}, error() {},
} as unknown as DebugLog;

function frontmatter(text: string): Record<string, any> {
	const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	if (!match) return {};
	return (load(match[1]) as Record<string, any>) ?? {};
}

function makeApp() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const create = jest.fn(async (path: string, content: string) => {
		files.set(path, content);
		return new TFile(path);
	});
	const modify = jest.fn(async (file: { path: string }, content: string) => {
		files.set(file.path, content);
	});
	const rename = jest.fn(async (file: { path: string }, path: string) => {
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
			create,
			modify,
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
		},
		fileManager: { renameFile: rename },
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const text = files.get(file.path);
				return text === undefined ? null : { frontmatter: frontmatter(text) };
			},
			on: () => ({}),
			offref: () => {},
		},
	};
	return { app: app as unknown as App, files, create, modify };
}

const ENTRY = {
	column: 'NIST CSF v2 Mapping',
	to_ontology: 'nist-csf-2',
	predicate: 'is_approximate_to' as const,
	qualifier: 'keep-as-justification' as const,
};

const INPUTS: CrosswalkEdgeInput[] = [
	{
		curie: 'cri-profile:GV.OC-01.01',
		row: { 'NIST CSF v2 Mapping': 'GV.OC-01 (CRI Modified)\nGV.OC-02' },
		title: 'Synthetic statement',
	},
];

describe('deriveCrosswalkEdgeRows', () => {
	it('atomizes X1-shaped cells with verbatim qualifiers and the shared predicate mapping', () => {
		// The release id is resolved by the pass (S5) and passed through verbatim.
		const result = deriveCrosswalkEdgeRows(ENTRY, 'cri-profile', 'cri-profile-to-nist-csf-2-cri-profile-v2-2-flat', INPUTS);
		expect(result.rows).toEqual([
			expect.objectContaining({
				subject_id: 'cri-profile:GV.OC-01.01',
				object_id: 'nist-csf-2:GV.OC-01',
				mapping_justification: '(CRI Modified)',
				predicate_id: 'is_approximate_to',
				sssom_predicate: 'skos:closeMatch',
				mapping_set_id: 'cri-profile-to-nist-csf-2-cri-profile-v2-2-flat',
			}),
			expect.objectContaining({
				object_id: 'nist-csf-2:GV.OC-02',
				mapping_justification: '',
			}),
		]);
	});

	it('strips qualifiers when requested', () => {
		const result = deriveCrosswalkEdgeRows({ ...ENTRY, qualifier: 'strip' }, 'cri-profile', 'recipe', INPUTS);
		expect(result.rows.map((row) => row.mapping_justification)).toEqual(['', '']);
	});

	it('drops None and empty cells', () => {
		const result = deriveCrosswalkEdgeRows(ENTRY, 'cri-profile', 'recipe', [
			{ curie: 'cri-profile:SYN-01', row: { 'NIST CSF v2 Mapping': 'None' } },
			{ curie: 'cri-profile:SYN-02', row: { 'NIST CSF v2 Mapping': '' } },
		]);
		expect(result.rows).toEqual([]);
		expect(result.skippedCells).toBe(2);
	});

	it('collapses duplicate subject/object/predicate assertions', () => {
		const result = deriveCrosswalkEdgeRows(ENTRY, 'cri-profile', 'recipe', [
			...INPUTS,
			...INPUTS,
		]);
		expect(result.rows).toHaveLength(2);
	});

	it('honors an additional recipe delimiter without changing default atomization', () => {
		const result = deriveCrosswalkEdgeRows(
			{ ...ENTRY, split: [',', '\n', ';', '|'] },
			'cri-profile',
			'recipe',
			[{
				curie: 'cri-profile:SYN-01',
				row: { 'NIST CSF v2 Mapping': 'GV.OC-01|GV.OC-02 (Synthetic qualifier)' },
			}],
		);
		expect(result.rows.map((row) => [row.object_id, row.mapping_justification])).toEqual([
			['nist-csf-2:GV.OC-01', ''],
			['nist-csf-2:GV.OC-02', '(Synthetic qualifier)'],
		]);
	});

	it('does not double-prefix an object CURIE that already has the target prefix', () => {
		const result = deriveCrosswalkEdgeRows(ENTRY, 'cri-profile', 'recipe', [{
			curie: 'cri-profile:SYN-01',
			row: { 'NIST CSF v2 Mapping': 'nist-csf-2:GV.OC-01' },
		}]);
		expect(result.rows[0].object_id).toBe('nist-csf-2:GV.OC-01');
	});
});

const ROWS = [
	{ id: 'SYN-01', title: 'Synthetic one', 'NIST CSF v2 Mapping': 'GV.OC-01 (CRI Modified)\nGV.OC-02' },
	{ id: 'SYN-02', title: 'Synthetic two', 'NIST CSF v2 Mapping': 'None' },
	{ id: 'SYN-03', title: 'Synthetic three', 'NIST CSF v2 Mapping': 'ID.AM-01' },
	{ id: 'SYN-04', title: 'Synthetic four', 'NIST CSF v2 Mapping': '' },
	{ id: 'SYN-05', title: 'Synthetic five', 'NIST CSF v2 Mapping': 'PR.AA-01' },
	{ id: 'SYN-06', title: 'Synthetic six', 'NIST CSF v2 Mapping': 'DE.CM-01' },
];

function conceptRecipe(withCrosswalks = true): Recipe {
	return {
		recipe: 'synthetic-cri-crosswalk',
		source: { ontology: 'cri-profile', levels: ['statement'] },
		target: {
			layout: [{ level: 'statement', mechanism: 'file', template: '{id}.md' }],
			also_emit: { frontmatter: { managed: { title: '{title}', synthetic_id: '{id}' } } },
			...(withCrosswalks ? { crosswalks: [ENTRY] } : {}),
		},
	};
}

const CONFIG = {
	name: 'synthetic-cri',
	mapping: {
		hierarchy: [], frontmatter: [], links: [], body: [],
		filename: { template: '{id}.md', sanitize: true },
	},
};

function conceptOptions(recipe: Recipe) {
	return {
		basePath: 'Frameworks/synthetic-cri',
		importSet: 'new' as const,
		overwriteMode: 'replace' as const,
		createFolders: true,
		sourceFileName: 'synthetic-cri.csv',
		recipeOverride: recipe,
		strictValidation: true,
	};
}

describe('crosswalk edge pass and generation hook', () => {
	it('writes separately owned edge notes, mints for a new framework set, and reuses on refresh', async () => {
		const harness = makeApp();
		const projection = jest.fn(async () => undefined);
		const closure = jest.fn(async () => 4);
		const result = await generateNotes(
			harness.app,
			{ columns: Object.keys(ROWS[0]), rows: ROWS, rowCount: ROWS.length },
			CONFIG,
			{
				...conceptOptions(conceptRecipe()),
				tier2: { runProjection: projection, precomputeClosure: closure },
			},
			debug,
		);

		expect(result.errors).toEqual([]);
		expect(result.crosswalkEdges).toEqual(expect.objectContaining({ created: 5, sets: [expect.stringMatching(/^iset-/)] }));
		expect(projection).toHaveBeenCalledTimes(1);
		expect(closure).toHaveBeenCalledWith('cri-profile', 'nist-csf-2');

		const conceptNotes = [...harness.files.entries()].filter(([path]) => path.startsWith('Frameworks/synthetic-cri/'));
		const edgeNotes = [...harness.files.entries()].filter(([path, text]) =>
			path.startsWith('_crosswalker/mappings/cri-profile-to-nist-csf-2/') && frontmatter(text).kind === 'crosswalk-edge',
		);
		expect(conceptNotes).toHaveLength(6);
		expect(edgeNotes).toHaveLength(5);

		const conceptSetIds = new Set<string>();
		let conceptSet: { id: string; scheme: 'endpoint-v1' | 'set-qualified-v1' } | null = null;
		for (const [, text] of conceptNotes) {
			const fm = frontmatter(text);
			conceptSetIds.add(fm._crosswalker.import_set.id);
			conceptSet ??= {
				id: fm._crosswalker.import_set.id,
				scheme: fm._crosswalker.import_set.scheme,
			};
			expect(fm).not.toHaveProperty('subject_id');
			expect(fm).not.toHaveProperty('predicate_id');
			expect(fm).not.toHaveProperty('object_id');
			expect(fm).not.toHaveProperty('mapping_justification');
		}
		expect(conceptSetIds.size).toBe(1);

		const firstEdgeSetIds = new Set<string>();
		for (const [, text] of edgeNotes) {
			const fm = frontmatter(text);
			expect(validateTier1Frontmatter(fm)).toEqual(expect.objectContaining({ valid: true }));
			expect(fm._crosswalker.import_set.ontology).toBe('sssom');
			expect(fm._crosswalker.import_set.parent_set).toBe(conceptSet!.id);
			expect(fm._crosswalker.source_ref.file).toBe('synthetic-cri.csv');
			firstEdgeSetIds.add(fm._crosswalker.import_set.id);
		}
		expect(firstEdgeSetIds.size).toBe(1);
		expect(firstEdgeSetIds).not.toEqual(conceptSetIds);
		const firstPathsAndBytes = new Map(edgeNotes);

		const second = await runCrosswalkEdgePass(harness.app, {
			entries: [ENTRY], sourceOntology: 'cri-profile', recipeId: 'synthetic-cri-crosswalk',
			producerSetId: 'iset-fedcba', sourceFileName: 'synthetic-cri.csv',
			inputs: ROWS.map((row) => ({ curie: `cri-profile:${row.id}`, row, title: row.title })),
			overwriteMode: 'replace',
		}, debug);
		expect(second.errors).toEqual([]);
		expect(second.totalCreated).toBe(5);
		expect(second.perEntry[0].importSetId).not.toBe([...firstEdgeSetIds][0]);
		for (const [path, text] of firstPathsAndBytes) expect(harness.files.get(path)).toBe(text);

		const replaceRefresh = await generateNotes(
			harness.app,
			{ columns: Object.keys(ROWS[0]), rows: ROWS, rowCount: ROWS.length },
			CONFIG,
			{ ...conceptOptions(conceptRecipe()), importSet: conceptSet!, overwriteMode: 'replace' },
			debug,
		);
		expect(replaceRefresh.errors).toEqual([]);
		expect(replaceRefresh.crosswalkEdges?.sets).toEqual([[...firstEdgeSetIds][0]]);
		const afterReplace = new Map([...harness.files.entries()].filter(([path]) => path.startsWith('_crosswalker/mappings/')));
		expect(afterReplace).toHaveProperty('size', 12);

		const skipRefresh = await generateNotes(
			harness.app,
			{ columns: Object.keys(ROWS[0]), rows: ROWS, rowCount: ROWS.length },
			CONFIG,
			{
				...conceptOptions(conceptRecipe()),
				importSet: conceptSet!,
				overwriteMode: 'skip',
			},
			debug,
		);
		expect(skipRefresh.errors).toEqual([]);
		expect(skipRefresh.created).toEqual([]);
		expect(skipRefresh.skipped).toHaveLength(6);
		expect(skipRefresh.crosswalkEdges?.created).toBe(0);
		expect(skipRefresh.crosswalkEdges?.sets).toEqual([[...firstEdgeSetIds][0]]);
		expect([...harness.files.keys()].filter((path) => path.startsWith('_crosswalker/mappings/'))).toHaveLength(12);
		for (const [path, text] of afterReplace) expect(harness.files.get(path)).toBe(text);
	});

	it('keeps one from-slot link set when a stack framework is refreshed', async () => {
		const { app, files } = makeApp();
		const recipe = { ...conceptRecipe(), recipe: 'cri-profile-v2-2-nested' };
		const data = { columns: Object.keys(ROWS[0]), rows: [ROWS[0]], rowCount: 1 };
		const first = await generateNotes(app, data, CONFIG, conceptOptions(recipe), debug);
		expect(first.errors).toEqual([]);
		const frameworkSet = frontmatter([...files.entries()].find(([path]) => path.startsWith('Frameworks/'))![1])._crosswalker.import_set;
		const initial = first.crosswalkEdges!.sets[0];
		const refreshed = await generateNotes(app, data, CONFIG,
			{ ...conceptOptions(recipe), importSet: { id: frameworkSet.id }, overwriteMode: 'replace' }, debug);
		expect(refreshed.errors).toEqual([]);
		expect(refreshed.crosswalkEdges?.sets).toEqual([initial]);
		const owned = (await discoverImportSets(app)).filter((set) =>
			set.parentSets?.length === 1 && set.parentSets[0] === frameworkSet.id
			&& set.recipeIds.includes('cri-profile-v2-2-nested::crosswalk::nist-csf-v2-mapping'));
		expect(owned.map((set) => set.id)).toEqual([initial]);
		expect([...files.keys()].filter((path) => path.startsWith('_crosswalker/mappings/'))).toHaveLength(3);
	});

	it('marks projection stale and skips closure when Tier 2 projection throws', async () => {
		const harness = makeApp();
		const closure = jest.fn(async () => 3);
		const pass = await runCrosswalkEdgePass(harness.app, {
			entries: [ENTRY],
			sourceOntology: 'cri-profile',
			recipeId: 'synthetic-cri-crosswalk',
			sourceFileName: 'synthetic-cri.csv',
			inputs: INPUTS,
			overwriteMode: 'replace',
			runProjection: async () => { throw new Error('Synthetic projection failure'); },
			precomputeClosure: closure,
		}, debug);
		expect(pass.errors).toEqual([]);
		expect(pass.summary.join(' ')).toMatch(/Query database projection failed.*Refresh the query database/);
		expect(closure).not.toHaveBeenCalled();
	});

	it('refuses to precompute closure on a partial projection result', async () => {
		const harness = makeApp();
		const closure = jest.fn(async () => 3);
		const pass = await runCrosswalkEdgePass(harness.app, {
			entries: [ENTRY], sourceOntology: 'cri-profile', recipeId: 'synthetic-cri-crosswalk',
			inputs: INPUTS, overwriteMode: 'replace',
			runProjection: async () => ({ success: false, counts: { errors: 2 } }),
			precomputeClosure: closure,
		}, debug);
		expect(pass.summary.join(' ')).toMatch(/projection was incomplete/);
		expect(closure).not.toHaveBeenCalled();
	});

	it('does not run the edge pass after a concept row error and explains the action', async () => {
		const harness = makeApp();
		const rows = [ROWS[0], { ...ROWS[1], id: ROWS[0].id }];
		const result = await generateNotes(
			harness.app,
			{ columns: Object.keys(rows[0]), rows, rowCount: rows.length },
			CONFIG,
			conceptOptions(conceptRecipe()),
			debug,
		);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.crosswalkEdges).toEqual({ created: 0, upToDate: 0, sets: [] });
		expect(result.warnings).toContainEqual({
			row: -1,
			message: 'Crosswalk edges were not written because 1 rows failed. Fix the rows and run the import again.',
		});
		expect([...harness.files.keys()].some((path) => path.startsWith('_crosswalker/mappings/'))).toBe(false);
	});

	it('leaves the optional result field absent when no crosswalk is declared', async () => {
		const harness = makeApp();
		const result = await generateNotes(
			harness.app,
			{ columns: Object.keys(ROWS[0]), rows: [ROWS[0]], rowCount: 1 },
			CONFIG,
			conceptOptions(conceptRecipe(false)),
			debug,
		);
		expect(result.errors).toEqual([]);
		expect(result.crosswalkEdges).toBeUndefined();
		expect([...harness.files.keys()]).toEqual(['Frameworks/synthetic-cri/SYN-01.md']);
	});
});

describe('P2 endpoint links by concept identity', () => {
	it('writes folder-qualified links, keeps missing ends, and explicitly refreshes after a framework arrives', async () => {
		const { app, files } = makeApp();
		const subject = 'cri-profile:SYN-01';
		const object = 'nist-csf-2:GV.OC-01';
		const seed = (path: string, curie: string) => files.set(path,
			`---\ncurie: ${curie}\n_crosswalker:\n  import_set:\n    id: ${curie.startsWith('cri-profile:') ? 'iset-abcdef' : 'iset-fedcba'}\n    scheme: endpoint-v1\n    ontology: ${curie.split(':')[0]}\n---\n`);
		seed('Frameworks/cri/Statement.md', subject);
		const args = {
			entries: [ENTRY], sourceOntology: 'cri-profile', recipeId: 'synthetic',
			inputs: [{ curie: subject, row: { 'NIST CSF v2 Mapping': 'GV.OC-01' } }],
			overwriteMode: 'replace' as const,
		};
		const first = await runCrosswalkEdgePass(app, args, debug);
		expect(first.totalCreated).toBe(1);
		expect(first.summary.join(' ')).toMatch(/Import nist-csf-2 concepts/);
		const firstEdge = [...files.entries()].find(([path, text]) => path.startsWith('_crosswalker/mappings/') && frontmatter(text).kind === 'crosswalk-edge')!;
		expect(frontmatter(firstEdge[1]).subject_note).toBe('[[Frameworks/cri/Statement|Statement]]');
		expect(frontmatter(firstEdge[1]).object_note).toBeUndefined();
		expect(firstEdge[1]).toContain('[[Frameworks/cri/Statement|Statement]] is_approximate_to `nist-csf-2:GV.OC-01`');
		seed('Frameworks/csf/Govern/Outcome.md', object);
		const refreshed = await runCrosswalkEdgePass(app, args, debug);
		expect(refreshed.summary).toEqual([]);
		const newEdge = [...files.entries()].filter(([path, text]) => path.startsWith('_crosswalker/mappings/') && frontmatter(text).kind === 'crosswalk-edge').at(-1)![1];
		expect(frontmatter(newEdge).object_note).toBe('[[Frameworks/csf/Govern/Outcome|Outcome]]');
		expect(newEdge).toContain('[[Frameworks/cri/Statement|Statement]] is_approximate_to [[Frameworks/csf/Govern/Outcome|Outcome]]');
		expect([...files.keys()].filter((path) => path.startsWith('Frameworks/csf/'))).toEqual(['Frameworks/csf/Govern/Outcome.md']);
	});
});


describe('recorded producer resolution', () => {
	const args = (producerSetId?: string, overwriteMode: 'replace' | 'skip' = 'replace') => ({
		entries: [ENTRY], sourceOntology: 'cri-profile', recipeId: 'synthetic-producer',
		inputs: INPUTS, overwriteMode, producerSetId,
	});
	const notes = (files: Map<string, string>) => [...files.entries()].filter(([path, text]) =>
		path.startsWith('_crosswalker/mappings/') && frontmatter(text).kind === 'crosswalk-edge');

	it('mints a producer-backed edge set with declared-facts identity', async () => {
		const { app, files } = makeApp();
		const result = await runCrosswalkEdgePass(app, args('iset-abcdef'), debug);
		expect(result.errors).toEqual([]);
		const edge = notes(files).map(([, text]) => frontmatter(text)).find((fm) => fm.object_id === 'nist-csf-2:GV.OC-01')!;
		expect(edge._crosswalker.import_set.derivation).toBe('declared-facts-v1');
		expect(edge._crosswalker.import_set.parent_set).toBe('iset-abcdef');
		expect(edge.curie).toBe('sssom:cw-cri-profile-GV-OC-01-01--9bd6f57447-nist-csf-2-GV-OC-01--6acf6fb373');
	});

	it('mints a legacy direct-call edge set with declared-facts identity', async () => {
		const { app, files } = makeApp();
		const result = await runCrosswalkEdgePass(app, args(), debug);
		expect(result.errors).toEqual([]);
		const edge = notes(files).map(([, text]) => frontmatter(text)).find((fm) => fm.object_id === 'nist-csf-2:GV.OC-01')!;
		expect(edge._crosswalker.import_set.derivation).toBe('declared-facts-v1');
		expect(edge._crosswalker.import_set.parent_set).toBeUndefined();
		expect(edge.curie).toBe('sssom:cw-cri-profile-GV-OC-01-01--9bd6f57447-nist-csf-2-GV-OC-01--6acf6fb373');
	});

	it('preserves the producer stamp on standalone SSSOM Replace', async () => {
		const { app, files } = makeApp();
		const first = await runCrosswalkEdgePass(app, args('iset-abcdef'), debug);
		const id = first.perEntry[0].importSetId!;
		const rows = deriveCrosswalkEdgeRows(ENTRY, 'cri-profile', 'synthetic-producer', INPUTS).rows
			.map((row) => ({ ...row, edge_body: 'Synthetic edge' }));
		const refreshed = await generateFromRecipe(app, {
			columns: Object.keys(rows[0]), rows, rowCount: rows.length,
		}, buildCrosswalkColumnRecipe(ENTRY, 'cri-profile', 'synthetic-producer'), {
			basePath: first.perEntry[0].folder, importSet: { id }, overwriteMode: 'replace', createFolders: true,
			curieLocalPart: (row, _index, set) => sssomEdgeCurie(row, set), curiePrefix: 'sssom',
		}, debug);
		expect(refreshed.errors).toEqual([]);
		expect(refreshed.importSetId).toBe(id);
		// Replace writes are included in created, even when the path already existed.
		expect(refreshed.created).toHaveLength(2);
		expect(notes(files)).toHaveLength(2);
		for (const [, text] of notes(files)) expect(frontmatter(text)._crosswalker.import_set.parent_set).toBe('iset-abcdef');
	});

	it('reuses the root recovered after moving the edge set', async () => {
		const { app, files } = makeApp();
		const first = await runCrosswalkEdgePass(app, args('iset-abcdef'), debug);
		const previousFolder = first.perEntry[0].folder;
		const movedFolder = '_crosswalker/relocated/cri-to-csf';
		// The user moves the whole folder: links and the release record note.
		for (const [path, text] of [...files.entries()].filter(([path]) => path.startsWith(`${previousFolder}/`))) {
			files.delete(path);
			files.set(`${movedFolder}/${path.slice(previousFolder.length + 1)}`, text);
		}
		const second = await runCrosswalkEdgePass(app, args('iset-abcdef'), debug);
		expect(second.errors).toEqual([]);
		expect(second.perEntry[0].importSetId).toBe(first.perEntry[0].importSetId);
		expect(second.perEntry[0].folder).toBe(movedFolder);
		const relocated = [...files.entries()].filter(([path, text]) => path.startsWith(`${movedFolder}/`) && frontmatter(text).kind === 'crosswalk-edge');
		expect(relocated).toHaveLength(2);
		expect(notes(files)).toHaveLength(0);
		expect(relocated.every(([path, text]) => path.startsWith(`${movedFolder}/`)
			&& frontmatter(text)._crosswalker.import_set.destination === movedFolder)).toBe(true);
	});

	it('preserves the legacy direct-call behavior when the producer is absent', async () => {
		const { app, files } = makeApp();
		const first = await runCrosswalkEdgePass(app, args(), debug);
		const second = await runCrosswalkEdgePass(app, args(), debug);
		expect(second.errors).toEqual([]);
		expect(second.perEntry[0].importSetId).not.toBe(first.perEntry[0].importSetId);
		expect(notes(files)).toHaveLength(4);
		for (const [, value] of notes(files)) expect(frontmatter(value)._crosswalker.import_set.parent_set).toBeUndefined();
	});

	it('never adopts a legacy unstamped set and then reuses its own stamped set', async () => {
		const { app, files } = makeApp();
		const legacy = await runCrosswalkEdgePass(app, args(), debug);
		expect((await discoverImportSets(app)).find((set) => set.id === legacy.perEntry[0].importSetId)).not.toHaveProperty('parentSets');
		const first = await runCrosswalkEdgePass(app, args('iset-abcdef'), debug);
		expect(first.perEntry[0].importSetId).not.toBe(legacy.perEntry[0].importSetId);
		const repeat = await runCrosswalkEdgePass(app, args('iset-abcdef', 'skip'), debug);
		expect(repeat.perEntry[0].importSetId).toBe(first.perEntry[0].importSetId);
		expect(repeat.totalCreated).toBe(0);
		expect(notes(files)).toHaveLength(4);
		for (const [, value] of notes(files).filter(([, text]) => frontmatter(text)._crosswalker.import_set.id === first.perEntry[0].importSetId)) {
			expect(frontmatter(value)._crosswalker.import_set.parent_set).toBe('iset-abcdef');
		}
	});

	it('refuses multiple exact candidates without writing any edges for the column', async () => {
		const { app, files, create, modify } = makeApp();
		await runCrosswalkEdgePass(app, args('iset-abcdef'), debug);
		await runCrosswalkEdgePass(app, args('iset-fedcba'), debug);
		// Every note of the second set, its release record note included, now names the first producer.
		const secondSet = [...files.entries()].filter(([, value]) => frontmatter(value)._crosswalker?.import_set?.parent_set === 'iset-fedcba');
		for (const [path, value] of secondSet) {
			const fm = frontmatter(value);
			fm._crosswalker.import_set.parent_set = 'iset-abcdef';
			const yaml = value.match(/^---\n[\s\S]*?\n---/)![0];
			files.set(path, value.replace(yaml, `---\n${dump(fm).trimEnd()}\n---`));
		}
		const before = new Map(files);
		create.mockClear(); modify.mockClear();
		const blocked = await runCrosswalkEdgePass(app, args('iset-abcdef'), debug);
		expect(blocked.perEntry[0].importSetId).toBeNull();
		expect(blocked.perEntry[0].errors[0].message).toMatch(/More than one link set records this framework as its source: iset-/);
		expect(create).not.toHaveBeenCalled();
		expect(modify).not.toHaveBeenCalled();
		expect(files).toEqual(before);
	});

	it('does not adopt a set with two recorded parent values', async () => {
		const { app, files } = makeApp();
		const first = await runCrosswalkEdgePass(app, args('iset-abcdef'), debug);
		const setId = first.perEntry[0].importSetId;
		const entry = notes(files).find(([, value]) => frontmatter(value).object_id === 'nist-csf-2:GV.OC-02')!;
		const fm = frontmatter(entry[1]);
		fm._crosswalker.import_set.parent_set = 'iset-fedcba';
		const yaml = entry[1].match(/^---\n[\s\S]*?\n---/)![0];
		files.set(entry[0], entry[1].replace(yaml, `---\n${dump(fm).trimEnd()}\n---`));
		expect((await discoverImportSets(app)).find((set) => set.id === setId)?.parentSets).toEqual(['iset-abcdef', 'iset-fedcba']);
		const second = await runCrosswalkEdgePass(app, args('iset-abcdef'), debug);
		expect(second.perEntry[0].importSetId).not.toBe(setId);
		expect(second.errors).toEqual([]);
	});

	it('reports a dropped edge as an orphan on a reused Replace refresh', async () => {
		const { app, files } = makeApp();
		const initial = {
			entries: [ENTRY], sourceOntology: 'cri-profile', recipeId: 'synthetic-orphans',
			producerSetId: 'iset-abcdef', inputs: INPUTS, overwriteMode: 'replace' as const,
		};
		const first = await runCrosswalkEdgePass(app, initial, debug);
		const old = [...files.entries()].find(([, value]) => frontmatter(value).object_id === 'nist-csf-2:GV.OC-02')!;
		const refreshed = await runCrosswalkEdgePass(app, {
			...initial, inputs: [{ ...INPUTS[0], row: { [ENTRY.column]: 'GV.OC-01' } }],
		}, debug);
		expect(refreshed.errors).toEqual([]);
		expect(refreshed.perEntry[0].importSetId).toBe(first.perEntry[0].importSetId);
		expect(refreshed.perEntry[0].orphans).toContainEqual({ curie: frontmatter(old[1]).curie, path: old[0] });
		expect(files.get(old[0])).toBe(old[1]);
	});

	it('reports byte-identical link refreshes as up to date, not written', async () => {
		const { app, files, modify } = makeApp();
		const input = {
			entries: [ENTRY], sourceOntology: 'synthetic-source', recipeId: 'synthetic-stable-links',
			producerSetId: 'iset-abcdef', inputs: [{ curie: 'synthetic-source:A', row: { [ENTRY.column]: 'B; C' } }],
			overwriteMode: 'replace' as const,
		};
		const first = await runCrosswalkEdgePass(app, input, debug);
		const before = new Map(files);
		modify.mockClear();
		const second = await runCrosswalkEdgePass(app, input, debug);
		expect(second.errors).toEqual([]);
		expect(second.perEntry[0].importSetId).toBe(first.perEntry[0].importSetId);
		expect(second.totalCreated).toBe(0);
		expect(second.perEntry[0].upToDate).toBe(2);
		expect(modify).not.toHaveBeenCalled();
		expect(files).toEqual(before);
	});

	it('reports every owned link when the refreshed column derives no rows', async () => {
		const { app, files, create, modify } = makeApp();
		const initial = {
			entries: [ENTRY], sourceOntology: 'synthetic-source', recipeId: 'synthetic-empty-column',
			producerSetId: 'iset-abcdef', inputs: [{ curie: 'synthetic-source:A', row: { [ENTRY.column]: 'B; C' } }],
			overwriteMode: 'replace' as const,
		};
		const first = await runCrosswalkEdgePass(app, initial, debug);
		const before = new Map(files);
		create.mockClear(); modify.mockClear();
		const indexed = app.metadataCache.getFileCache.bind(app.metadataCache);
		const abstract = app.vault.getAbstractFileByPath.bind(app.vault);
		const orphanPaths = new Set<string>();
		app.vault.getAbstractFileByPath = (path: string) => {
			if (path.startsWith('_crosswalker/mappings/')) orphanPaths.add(path);
			return abstract(path);
		};
		app.metadataCache.getFileCache = (file: TFile) => orphanPaths.has(file.path) ? { frontmatter: {} } : indexed(file);
		const refreshed = await runCrosswalkEdgePass(app, {
			...initial, inputs: [{ curie: 'synthetic-source:A', row: { [ENTRY.column]: '' } }],
		}, debug);
		expect(refreshed.errors).toEqual([]);
		expect(refreshed.perEntry[0].importSetId).toBe(first.perEntry[0].importSetId);
		expect(refreshed.perEntry[0].orphans).toEqual([...before]
			.filter(([, text]) => frontmatter(text).kind === 'crosswalk-edge')
			.map(([path, text]) => ({ curie: frontmatter(text).curie, path })));
		expect(create).not.toHaveBeenCalled(); expect(modify).not.toHaveBeenCalled();
		expect(files).toEqual(before);
	});

	it('keeps set-qualified curies stable on replace refresh', async () => {
		const { app, files } = makeApp();
		await runCrosswalkEdgePass(app, args(), debug); // Occupy endpoint-v1; next minted set is set-qualified-v1.
		const first = await runCrosswalkEdgePass(app, args('iset-abcdef'), debug);
		const edgeSetId = first.perEntry[0].importSetId;
		const curies = notes(files).map(([, value]) => frontmatter(value))
			.filter((fm) => fm._crosswalker.import_set.id === edgeSetId).map((fm) => fm.curie).sort();
		expect(curies).toHaveLength(2);
		expect(curies.every((curie) => curie.startsWith(`sssom:cwset-${edgeSetId}-`))).toBe(true);
		const refreshed = await runCrosswalkEdgePass(app, args('iset-abcdef'), debug);
		expect(refreshed.perEntry[0].importSetId).toBe(edgeSetId);
		const after = notes(files).map(([, value]) => frontmatter(value))
			.filter((fm) => fm._crosswalker.import_set.id === edgeSetId).map((fm) => fm.curie).sort();
		expect(after).toEqual(curies);
		expect(notes(files)).toHaveLength(4);
	});
});

describe('S5 recipe-declared crosswalk release records', () => {
	const DEMO_ENTRY = { column: 'Maps to', to_ontology: 'demo-b', predicate: 'is_equivalent_to' as const };
	const DEMO_INPUTS: CrosswalkEdgeInput[] = [
		{ curie: 'demo-a:A1', row: { 'Maps to': 'B1; B2 (partial)' }, title: 'Synthetic A1' },
		{ curie: 'demo-a:A2', row: { 'Maps to': 'None' }, title: 'Synthetic A2' },
	];
	const BLOCK = {
		id: 'https://example.org/mappings/demo-a-to-demo-b',
		version: '2026.1',
		title: 'Demo A to demo B',
		description: 'Synthetic release for tests.',
		license: 'https://creativecommons.org/publicdomain/zero/1.0/',
		provider: 'https://example.org/provider',
		date: '2026-10-03',
		creator_id: ['orcid:0000-0000-0000-0000'],
		subject_source: 'demo-a',
		subject_source_version: '1.0',
		object_source: 'demo-b',
		object_source_version: '2.0',
	};
	const demoArgs = (entry: Record<string, unknown> = {}, recipeId = 'synthetic-demo-a') => ({
		entries: [{ ...DEMO_ENTRY, ...entry }], sourceOntology: 'demo-a', recipeId,
		producerSetId: 'iset-abcdef', inputs: DEMO_INPUTS, overwriteMode: 'replace' as const,
	});
	const edges = (files: Map<string, string>) => [...files.entries()]
		.filter(([, text]) => frontmatter(text).kind === 'crosswalk-edge');
	const setNotes = (files: Map<string, string>) => [...files.entries()]
		.filter(([, text]) => frontmatter(text).kind === 'mapping-set');
	async function recordOf(app: App, setId: string) {
		const set = (await discoverImportSets(app)).find((candidate) => candidate.id === setId);
		expect(set).toBeDefined();
		return readMappingSet(app, set!);
	}

	it('writes a release record with every declared field and recomputed digests', async () => {
		const { app, files } = makeApp();
		const pass = await runCrosswalkEdgePass(app, demoArgs({ mapping_set: BLOCK }), debug);
		expect(pass.errors).toEqual([]);
		const setId = pass.perEntry[0].importSetId!;
		const record = await recordOf(app, setId);
		const facts = deriveCrosswalkEdgeRows({ ...DEMO_ENTRY, mapping_set: BLOCK }, 'demo-a', BLOCK.id, DEMO_INPUTS).rows
			.map((row) => ({ ...row, predicate_modifier: '' }));
		expect(record).toEqual({
			mapping_set_id: BLOCK.id,
			id_origin: 'declared',
			mapping_set_version: '2026.1',
			mapping_set_title: 'Demo A to demo B',
			mapping_set_description: 'Synthetic release for tests.',
			subject_source: 'demo-a',
			subject_source_version: '1.0',
			object_source: 'demo-b',
			object_source_version: '2.0',
			mapping_provider: 'https://example.org/provider',
			mapping_date: '2026-10-03',
			creator_id: ['orcid:0000-0000-0000-0000'],
			license: 'https://creativecommons.org/publicdomain/zero/1.0/',
			...computeMappingSetDigests(facts),
			importSetId: setId,
		});
		expect(record!.assertion_count).toBe(2);
		for (const [, text] of edges(files)) expect(frontmatter(text).mapping_set_id).toBe(BLOCK.id);
		const [[, noteText]] = setNotes(files);
		const note = frontmatter(noteText);
		expect(validateTier1Frontmatter(note)).toEqual(expect.objectContaining({ valid: true }));
		// The record's provenance is the child link set's own block.
		expect(note._crosswalker.import_set.id).toBe(setId);
		expect(note._crosswalker.import_set.parent_set).toBe('iset-abcdef');
	});

	it('takes the legacy mapping_set_id as the declared id', async () => {
		const { app } = makeApp();
		const pass = await runCrosswalkEdgePass(app, demoArgs({ mapping_set_id: 'demo-release-legacy' }), debug);
		const record = await recordOf(app, pass.perEntry[0].importSetId!);
		expect(record).toEqual(expect.objectContaining({ mapping_set_id: 'demo-release-legacy', id_origin: 'declared' }));
	});

	it('refuses two different ids in one column and writes nothing', async () => {
		const { app, files } = makeApp();
		const pass = await runCrosswalkEdgePass(app, demoArgs({ mapping_set: BLOCK, mapping_set_id: 'demo-other' }), debug);
		expect(pass.errors[0].message).toBe(`The recipe gives crosswalk column Maps to two release ids: mapping_set.id is ${BLOCK.id} and mapping_set_id is demo-other. Keep one of them, then run the import again.`);
		expect(files.size).toBe(0);
	});

	it('mints the id once without a declaration, keeps it on refresh, and never derives it from the recipe id', async () => {
		const { app, files, modify } = makeApp();
		const first = await runCrosswalkEdgePass(app, demoArgs(), debug);
		expect(first.errors).toEqual([]);
		const setId = first.perEntry[0].importSetId!;
		const minted = (await recordOf(app, setId))!;
		expect(minted.id_origin).toBe('minted');
		expect(minted.mapping_set_id).toMatch(/^urn:crosswalker:mapping-set:[a-z2-7]{10}$/);
		expect(minted.mapping_set_id).not.toContain('synthetic-demo-a');
		expect(minted).not.toHaveProperty('subject_source');
		expect(minted).not.toHaveProperty('mapping_set_version');

		const before = new Map(files);
		modify.mockClear();
		const second = await runCrosswalkEdgePass(app, demoArgs(), debug);
		expect(second.errors).toEqual([]);
		expect(second.perEntry[0].importSetId).toBe(setId);
		expect((await recordOf(app, setId))!.mapping_set_id).toBe(minted.mapping_set_id);
		// Nothing changed, so nothing was written: not the links, not the record.
		expect(modify).not.toHaveBeenCalled();
		expect(files).toEqual(before);

		// A declared id is the same release whatever the recipe is called.
		const a = makeApp();
		const b = makeApp();
		const underA = await runCrosswalkEdgePass(a.app, demoArgs({ mapping_set: { id: 'demo-release' } }, 'synthetic-recipe-one'), debug);
		const underB = await runCrosswalkEdgePass(b.app, demoArgs({ mapping_set: { id: 'demo-release' } }, 'synthetic-recipe-two'), debug);
		expect((await recordOf(a.app, underA.perEntry[0].importSetId!))!.mapping_set_id).toBe('demo-release');
		expect((await recordOf(b.app, underB.perEntry[0].importSetId!))!.mapping_set_id).toBe('demo-release');
	});

	it('refuses a refresh that declares a different version and writes nothing', async () => {
		const { app, files, create, modify } = makeApp();
		const first = await runCrosswalkEdgePass(app, demoArgs({ mapping_set: BLOCK }), debug);
		const setId = first.perEntry[0].importSetId!;
		const before = new Map(files);
		create.mockClear(); modify.mockClear();
		const refused = await runCrosswalkEdgePass(app, demoArgs({ mapping_set: { ...BLOCK, version: '2026.2' } }), debug);
		expect(refused.errors.map((error) => error.message)).toEqual([
			`Crosswalk links for Maps to were not updated. The recipe declares release ${BLOCK.id} version 2026.2, but link set ${setId} holds release ${BLOCK.id} version 2026.1. Restore the release id and version in the recipe, or remove the old link set in ownership review so the new release gets its own set, then run the import again.`,
		]);
		expect(create).not.toHaveBeenCalled();
		expect(modify).not.toHaveBeenCalled();
		expect(files).toEqual(before);
	});

	it('keeps the old id of a link set written before records existed and only adds the record', async () => {
		const { app, files } = makeApp();
		// The old pass stamped `<source>-to-<target>-<recipe id>` on every link and
		// wrote no record. Reproduce that state: same id on every link, no set note.
		const oldId = 'demo-a-to-demo-b-synthetic-demo-a';
		const first = await runCrosswalkEdgePass(app, demoArgs({ mapping_set_id: oldId }), debug);
		const setId = first.perEntry[0].importSetId!;
		for (const [path] of setNotes(files)) files.delete(path);
		expect(await recordOf(app, setId)).toBeUndefined();
		const oldEdges = new Map(edges(files));
		expect(oldEdges.size).toBe(2);

		const refreshed = await runCrosswalkEdgePass(app, demoArgs(), debug);
		expect(refreshed.errors).toEqual([]);
		expect(refreshed.perEntry[0].importSetId).toBe(setId);
		expect(refreshed.perEntry[0].upToDate).toBe(2);
		for (const [path, text] of oldEdges) {
			const after = files.get(path)!;
			expect(frontmatter(after).mapping_set_id).toBe(oldId);
			expect(managedContentEquivalent(text, after, { parseYaml: load, userPreserve: ['review_status', 'reviewer'] }))
				.toEqual({ equal: true, differences: [] });
		}
		const record = await recordOf(app, setId);
		// The recipe declares nothing, so the id the set holds was assigned by Crosswalker.
		expect(record).toEqual(expect.objectContaining({ mapping_set_id: oldId, id_origin: 'minted', assertion_count: 2 }));
		expect(setNotes(files)).toHaveLength(1);
	});
});
