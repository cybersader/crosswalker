import { TextDecoder, TextEncoder } from 'node:util';
import { TFile, TFolder } from 'obsidian';
import { load } from 'js-yaml';
import { generateNotes } from '../src/generation/generation-engine';
import { computeSourceByteDigest } from '../src/generation/hash';
import { recognizedDestination } from '../src/import/import-wizard';
import { MappingWorkbench } from '../src/import/workbench';
import { analyzeColumns, parseCSVFile } from '../src/import/parsers/csv-parser';
import { RECIPE_REGISTRY } from '../src/import/recipe-registry';
import {
	buildRecognizedImportConfig,
	runRecognizedImport,
	visibleGenerationWarnings,
} from '../src/import/run-recognized-import';
import type { DebugLog } from '../src/utils/debug';

class ByteFile {
	readonly name: string;
	readonly size: number;
	private readonly bytes: Uint8Array;

	constructor(parts: Array<string | ArrayBuffer | Uint8Array>, name: string) {
		this.name = name;
		const part = parts[0] ?? '';
		this.bytes = typeof part === 'string'
			? new TextEncoder().encode(part)
			: part instanceof Uint8Array
				? Uint8Array.from(part)
				: new Uint8Array(part.slice(0));
		this.size = this.bytes.byteLength;
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		return this.bytes.buffer.slice(
			this.bytes.byteOffset,
			this.bytes.byteOffset + this.bytes.byteLength,
		) as ArrayBuffer;
	}
}

Object.assign(globalThis, { TextDecoder, TextEncoder, File: ByteFile });

const ENTRY = RECIPE_REGISTRY.find((entry) => entry.id === 'nist-csf-2-flat')!;
const CRI_ENTRY = RECIPE_REGISTRY.find((entry) => entry.id === 'cri-profile-v2-2-flat')!;
const NIST_NESTED = RECIPE_REGISTRY.find((entry) => entry.id === 'nist-800-53-r5-nested')!;
const CRI_NESTED = RECIPE_REGISTRY.find((entry) => entry.id === 'cri-profile-v2-2-nested')!;
const CSV = [
	'Subcategory,Implementation Examples',
	'GV.AA-01: Synthetic outcome one,Synthetic example one',
	'GV.AA-02: Synthetic outcome two,Synthetic example two',
	'ID.BB-01: Synthetic outcome three,Synthetic example three',
	'ID.BB-02: Synthetic outcome four,Synthetic example four',
	'PR.CC-01: Synthetic outcome five,Synthetic example five',
	'PR.CC-02: Synthetic outcome six,Synthetic example six',
].join('\n');

const debug = {
	info() {},
	trace() {},
	warn() {},
	error() {},
} as unknown as DebugLog;

function parsedFrontmatter(text: string): Record<string, unknown> {
	const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	return match ? ((load(match[1]) as Record<string, unknown>) ?? {}) : {};
}

function sourceFile(path: string): TFile {
	const file = new TFile(path);
	const name = path.split('/').pop()!;
	Object.assign(file, {
		name,
		basename: name.replace(/\.[^.]+$/, ''),
		extension: name.split('.').pop()!,
	});
	return file;
}

function makeApp(sourcePath: string, sourcePayload: string | Uint8Array, initialMarkdown: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initialMarkdown));
	const initiallyUnindexed = new Set(Object.keys(initialMarkdown));
	const folders = new Set<string>(['']);
	const source = sourceFile(sourcePath);
	const sourceBytes = typeof sourcePayload === 'string'
		? new TextEncoder().encode(sourcePayload)
		: sourcePayload;
	const create = jest.fn(async (path: string, content: string) => {
		files.set(path, content);
		return new TFile(path);
	});

	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((path) => new TFile(path)),
			getAbstractFileByPath: (path: string) => {
				if (path === sourcePath) return source;
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			readBinary: async (file: { path: string }) => {
				if (file.path !== sourcePath) throw new Error(`No binary source at ${file.path}`);
				return sourceBytes.buffer.slice(
					sourceBytes.byteOffset,
					sourceBytes.byteOffset + sourceBytes.byteLength,
				);
			},
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			create,
			modify: async (file: { path: string }, content: string) => {
				files.set(file.path, content);
			},
			createFolder: async (path: string) => {
				folders.add(path);
			},
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				if (initiallyUnindexed.has(file.path)) return null;
				const text = files.get(file.path);
				return text === undefined ? null : { frontmatter: parsedFrontmatter(text) };
			},
			on: () => ({}),
			offref: () => {},
		},
	};
	return { app: app as any, source, sourceBytes, files, create };
}

function plugin(root = 'Ontologies') {
	return {
		settings: { defaultOutputPath: root },
		debug,
	} as any;
}

function expectedConfig() {
	return {
		name: 'shape-workbench',
		mapping: {
			hierarchy: [],
			frontmatter: [],
			links: [],
			body: [],
			filename: { template: '{Subcategory|split(:,0)|fs-safe}.md', sanitize: true },
		},
	};
}

describe('runRecognizedImport', () => {
	it('hides only expected trailing CRI folder skips, while keeping skipped middle levels and other warnings', () => {
		const layout = CRI_NESTED.recipe.target.layout;
		const category = layout[1];
		const subcategory = layout[2];
		const pair = (row: number, folder: typeof category) => [
			{ row, code: 'prefix-index-missing', template: folder.template, message: 'Missing prefix piece' },
			{ row, code: 'folder-level-skipped', template: folder.template, level: folder.level, message: 'Folder skipped' },
		];
		const warnings = [
			...pair(1, category), ...pair(1, subcategory),
			...pair(2, category), // middle skipped while later level exists: do not hide
			{ row: 2, code: 'other', message: 'Unexpected source shape' },
		];
		expect(visibleGenerationWarnings(warnings, CRI_NESTED, [{ Level: 'F' }, { Level: 'F' }]))
			.toEqual(['Row 2: Missing prefix piece', 'Row 2: Folder skipped', 'Row 2: Unexpected source shape']);
		expect(visibleGenerationWarnings(warnings, NIST_NESTED, [{ Level: 'F' }, { Level: 'F' }])).toHaveLength(7);
	});
	it('filters nested NIST enhancements per run, preserving the bundled recipe', async () => {
		const rows = [
			'identifier,name,control_text,discussion,related',
			'ZZ-1,Invented control,Invented body,,',
			'ZZ-1(1),Invented enhancement,Invented body,,',
		].join('\n');
		const harness = makeApp('Incoming/invented-nist.csv', rows);
		const result = await runRecognizedImport(harness.app, plugin(), {
			file: harness.source, entry: NIST_NESTED, table: '', headerRow: 0,
			sourceWhere: "$not($contains(identifier, '('))",
		});
		expect(result.ok).toBe(true);
		expect(result.created).toBe(2);
		expect([...harness.files.keys()].sort()).toEqual([
			expect.stringMatching(/ZZ\/ZZ-1\/ZZ-1\.md$/),
			expect.stringMatching(/ZZ\/ZZ\.md$/),
		]);
		expect(parsedFrontmatter([...harness.files.values()][0])._crosswalker).toMatchObject({ recipe: { id: NIST_NESTED.id } });
		expect(NIST_NESTED.recipe.source).not.toHaveProperty('where');
	});

	it('filters nested CRI diagnostic statements per run and keeps upper-level notes', async () => {
		const columns = CRI_NESTED.signatureColumns;
		const records = [['GV', 'F'], ['GV.OC', 'C'], ['GV.OC-01', 'S'], ['GV.OC-01.01', 'DS']];
		const values = records.map(([id, level]) => Object.fromEntries(columns.map((key) => [key,
			key === 'Profile Id' ? id : key === 'Level' ? level : key === 'CRI Profile Function / Category / Subcategory'
				? 'Invented / Category / Subcategory' : key === 'CRI Profile v2.2 Diagnostic Statement' ? 'Invented statement' : ''])));
		const csv = [columns.join(','), ...values.map((row) => columns.map((key) => `"${String(row[key]).replaceAll('"', '""')}"`).join(','))].join('\n');
		const harness = makeApp('Incoming/invented-cri.csv', csv);
		const result = await runRecognizedImport(harness.app, plugin(), {
			file: harness.source, entry: CRI_NESTED, table: '', headerRow: 0,
			sourceWhere: "Level != 'DS'",
		});
		expect(result.ok).toBe(true);
		expect(result.created).toBe(3);
		expect(result.warnings).toEqual([]);
		expect([...harness.files.keys()].some((file) => file.endsWith('GV.OC-01.01.md'))).toBe(false);
		expect([...harness.files.values()].map((text) => (parsedFrontmatter(text)._crosswalker as { recipe: { id: string } }).recipe.id))
			.toEqual([CRI_NESTED.id, CRI_NESTED.id, CRI_NESTED.id]);
		expect(CRI_NESTED.recipe.source).not.toHaveProperty('where');
	});

	it('matches direct generation, mints a fresh set, and uses the recognized destination', async () => {
		const encoded = new TextEncoder().encode(CSV);
		const sourceBytes = new Uint8Array(encoded.byteLength + 3);
		sourceBytes.set([0xef, 0xbb, 0xbf]);
		sourceBytes.set(encoded, 3);
		const runnerHarness = makeApp('Incoming/csf.csv', sourceBytes);
		const directHarness = makeApp('Incoming/csf.csv', CSV);
		const destination = recognizedDestination(ENTRY, 'Ontologies')!;

		const parsed = await parseCSVFile(new File([CSV], 'csf.csv'));
		const workbench = new MappingWorkbench({
			parsedData: parsed,
			columnInfos: analyzeColumns(parsed),
			outputPath: destination,
			debug,
			defaultPresetId: 'browsable-framework',
			initialRecipe: ENTRY.recipe,
			recipeOrigin: 'bundled',
			sourceOntology: ENTRY.recipe.source.ontology,
			seedColumnDefaults: false,
			onChange: () => {},
		});
		expect(buildRecognizedImportConfig(workbench)).toEqual(expectedConfig());

		const direct = await generateNotes(
			directHarness.app,
			parsed,
			expectedConfig(),
			{
				basePath: destination,
				importSet: 'new',
				overwriteMode: 'error',
				createFolders: true,
				sourceFileName: 'csf.csv',
				recipeOverride: ENTRY.recipe,
				strictValidation: true,
			},
			debug,
		);

		const outcome = await runRecognizedImport(runnerHarness.app, plugin(), {
			file: runnerHarness.source,
			entry: ENTRY,
			table: '',
			headerRow: 0,
		});
		const readBinaryBytes = new Uint8Array(
			await runnerHarness.app.vault.readBinary(runnerHarness.source),
		);
		const expectedSourceDigest = computeSourceByteDigest(readBinaryBytes);

		expect(outcome).toMatchObject({
			ok: true,
			destination,
			created: direct.created.length,
			skipped: direct.skipped.length,
			errors: [],
			parsedRowCount: 6,
		});
		expect(outcome.importSetId).toMatch(/^iset-[a-z0-9]{6}$/);
		expect(runnerHarness.files.size).toBe(directHarness.files.size);
		for (const content of runnerHarness.files.values()) {
			expect(content).toContain(`id: ${outcome.importSetId}`);
			expect(content).toContain(`source_hash: ${expectedSourceDigest}`);
		}
	});

	it('reports CRI crosswalk edges and runs Tier 2 handles through the recognized path', async () => {
		const criCsv = [
			'Profile Id,Level,Outline Id,CRI Profile Function / Category / Subcategory,Tier-1,Tier-2,Tier-3,Tier-4,CRI Profile v2.2 Diagnostic Statement,NIST CSF v2 Mapping',
			'SYN-01,DS,1,Function / Category / Synthetic one,Yes,No,No,No,Synthetic diagnostic one,"GV.OC-01; GV.OC-02 (CRI Modified)"',
			'SYN-02,DS,2,Function / Category / Synthetic two,Yes,No,No,No,Synthetic diagnostic two,None',
			'SYN-03,DS,3,Function / Category / Synthetic three,Yes,No,No,No,Synthetic diagnostic three,ID.AM-01',
			'SYN-04,DS,4,Function / Category / Synthetic four,Yes,No,No,No,Synthetic diagnostic four,',
			'SYN-05,DS,5,Function / Category / Synthetic five,Yes,No,No,No,Synthetic diagnostic five,PR.AA-01',
			'SYN-06,DS,6,Function / Category / Synthetic six,Yes,No,No,No,Synthetic diagnostic six,DE.CM-01',
		].join('\n');
		const harness = makeApp('Incoming/cri.csv', criCsv);
		const tier2Plugin = {
			settings: { defaultOutputPath: 'Ontologies' },
			debug,
			runProjection: jest.fn(async () => undefined),
			precomputeClosure: jest.fn(async () => 5),
		} as any;

		const outcome = await runRecognizedImport(harness.app, tier2Plugin, {
			file: harness.source,
			entry: CRI_ENTRY,
			table: '',
			headerRow: 0,
		});

		expect(outcome).toMatchObject({
			ok: true,
			created: 6,
			crosswalkEdges: 5,
			errors: [],
			parsedRowCount: 6,
		});
		expect(tier2Plugin.runProjection).toHaveBeenCalledTimes(1);
		expect(tier2Plugin.precomputeClosure).toHaveBeenCalledWith('cri-profile', 'nist-csf-2');
		expect([...harness.files.keys()].filter((path) =>
			path.startsWith('_crosswalker/mappings/cri-profile-to-nist-csf-2/'),
		)).toHaveLength(5);
	});

	it('returns the indexing error and writes nothing while markdown remains unindexed', async () => {
		const harness = makeApp('Incoming/csf.csv', CSV, {
			'Existing/unindexed.md': '# Existing\n',
		});
		const before = new Map(harness.files);

		const outcome = await runRecognizedImport(harness.app, plugin(), {
			file: harness.source,
			entry: ENTRY,
			table: '',
			headerRow: 0,
		});

		expect(outcome).toEqual({
			ok: false,
			destination: recognizedDestination(ENTRY, 'Ontologies'),
			importSetId: null,
			created: 0,
			skipped: 0,
			errors: ['Vault is still indexing. Wait a moment and run the import again.'],
			warnings: [],
			parsedRowCount: 0,
		});
		expect(harness.files).toEqual(before);
		expect(harness.create).not.toHaveBeenCalled();
	});

	it('returns an actionable parse failure and writes nothing', async () => {
		const harness = makeApp('Incoming/broken.json', '{not valid json');

		const outcome = await runRecognizedImport(harness.app, plugin(), {
			file: harness.source,
			entry: ENTRY,
			table: '',
			headerRow: 0,
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.created).toBe(0);
		expect(outcome.parsedRowCount).toBe(0);
		expect(outcome.errors).toHaveLength(1);
		expect(outcome.errors[0]).toMatch(/^Could not parse broken\.json: .+ Check the selected table and header row, then run the import again\.$/);
		expect(harness.files.size).toBe(0);
		expect(harness.create).not.toHaveBeenCalled();
	});
});
