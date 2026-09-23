import { TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import { load } from 'js-yaml';
import {
	deriveCrosswalkEdgeRows,
	runCrosswalkEdgePass,
	type CrosswalkEdgeInput,
} from '../src/generation/crosswalk-edge-pass';
import { generateNotes } from '../src/generation/generation-engine';
import { validateTier1Frontmatter } from '../src/validation/validator';
import type { DebugLog } from '../src/utils/debug';
import type { Recipe } from '../src/render';

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
		const result = deriveCrosswalkEdgeRows(ENTRY, 'cri-profile', 'cri-profile-v2-2-flat', INPUTS);
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
	it('writes separately owned valid edge notes, preserves source provenance, and mints another set on the second pass', async () => {
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
		const edgeNotes = [...harness.files.entries()].filter(([path]) =>
			path.startsWith('_crosswalker/mappings/cri-profile-to-nist-csf-2/'),
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
			expect(fm._crosswalker.source_ref.file).toBe('synthetic-cri.csv');
			firstEdgeSetIds.add(fm._crosswalker.import_set.id);
		}
		expect(firstEdgeSetIds.size).toBe(1);
		expect(firstEdgeSetIds).not.toEqual(conceptSetIds);
		const firstPathsAndBytes = new Map(edgeNotes);

		const inputs: CrosswalkEdgeInput[] = ROWS.map((row) => ({
			curie: `cri-profile:${row.id}`,
			row,
			title: row.title,
		}));
		const second = await runCrosswalkEdgePass(harness.app, {
			entries: [ENTRY],
			sourceOntology: 'cri-profile',
			recipeId: 'synthetic-cri-crosswalk',
			sourceFileName: 'synthetic-cri.csv',
			inputs,
			overwriteMode: 'replace',
		}, debug);
		expect(second.errors).toEqual([]);
		expect(second.totalCreated).toBe(5);
		expect(second.perEntry[0].importSetId).not.toBe([...firstEdgeSetIds][0]);
		for (const [path, text] of firstPathsAndBytes) expect(harness.files.get(path)).toBe(text);

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
		expect(skipRefresh.crosswalkEdges?.created).toBe(5);
		expect(skipRefresh.crosswalkEdges?.sets).toHaveLength(1);
		expect(skipRefresh.crosswalkEdges?.sets[0]).not.toBe([...firstEdgeSetIds][0]);
		for (const [path, text] of firstPathsAndBytes) expect(harness.files.get(path)).toBe(text);
	});

	it('runs closure even when Tier 2 projection reports an error', async () => {
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
		expect(pass.errors).toContainEqual({ row: -1, message: 'Tier 2 projection failed: Synthetic projection failure' });
		expect(closure).toHaveBeenCalledWith('cri-profile', 'nist-csf-2');
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
		expect(result.crosswalkEdges).toEqual({ created: 0, sets: [] });
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
		const firstEdge = [...files.entries()].find(([path]) => path.startsWith('_crosswalker/mappings/'))!;
		expect(frontmatter(firstEdge[1]).subject_note).toBe('[[Frameworks/cri/Statement|Statement]]');
		expect(frontmatter(firstEdge[1]).object_note).toBeUndefined();
		expect(firstEdge[1]).toContain('[[Frameworks/cri/Statement|Statement]] is_approximate_to `nist-csf-2:GV.OC-01`');
		seed('Frameworks/csf/Govern/Outcome.md', object);
		const refreshed = await runCrosswalkEdgePass(app, args, debug);
		expect(refreshed.summary).toEqual([]);
		const newEdge = [...files.entries()].filter(([path]) => path.startsWith('_crosswalker/mappings/')).at(-1)![1];
		expect(frontmatter(newEdge).object_note).toBe('[[Frameworks/csf/Govern/Outcome|Outcome]]');
		expect(newEdge).toContain('[[Frameworks/cri/Statement|Statement]] is_approximate_to [[Frameworks/csf/Govern/Outcome|Outcome]]');
		expect([...files.keys()].filter((path) => path.startsWith('Frameworks/csf/'))).toEqual(['Frameworks/csf/Govern/Outcome.md']);
	});
});
