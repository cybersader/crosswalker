import { TextDecoder, TextEncoder } from 'node:util';
import { TFile, TFolder } from 'obsidian';
import { generateNotes } from '../src/generation/generation-engine';
import { computeSourceByteDigest } from '../src/generation/hash';
import { recognizedDestination } from '../src/import/import-wizard';
import { MappingWorkbench } from '../src/import/workbench';
import { analyzeColumns, parseCSVFile } from '../src/import/parsers/csv-parser';
import { RECIPE_REGISTRY } from '../src/import/recipe-registry';
import {
	buildRecognizedImportConfig,
	runRecognizedImport,
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
			getFileCache: () => null,
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
				recipeOverride: workbench.buildRecipe(),
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
