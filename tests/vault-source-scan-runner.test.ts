jest.mock('../src/generation/import-set', () => {
	const actual = jest.requireActual('../src/generation/import-set');
	return {
		...actual,
		discoverImportSets: jest.fn(),
		settleVaultIndex: jest.fn(),
	};
});

import * as Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { TextDecoder as NodeTextDecoder } from 'util';
import type { TFile } from 'obsidian';
import { computeSourceByteDigest } from '../src/generation/hash';
import {
	discoverImportSets,
	settleVaultIndex,
	type DiscoveredImportSet,
} from '../src/generation/import-set';
import { RECIPE_REGISTRY } from '../src/import/recipe-registry';
import {
	LARGE_FILE_BYTES,
	draftFromScanRow,
	scanVaultForSources,
	type ScanRow,
} from '../src/import/vault-source-scan-runner';

const mockedDiscover = discoverImportSets as jest.MockedFunction<typeof discoverImportSets>;
const mockedSettle = settleVaultIndex as jest.MockedFunction<typeof settleVaultIndex>;

interface MockFile extends TFile {
	name: string;
}

function file(path: string): MockFile {
	const name = path.split('/').pop() ?? path;
	return {
		path,
		name,
		basename: name.replace(/\.[^.]+$/, ''),
		extension: name.split('.').pop()?.toLowerCase() ?? '',
	} as MockFile;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function appFor(contents: Record<string, Uint8Array>) {
	const files = Object.keys(contents).map(file);
	const byPath = new Map(files.map((entry) => [entry.path, entry]));
	return {
		vault: {
			getFiles: () => files,
			readBinary: jest.fn(async (entry: MockFile) => arrayBuffer(contents[entry.path])),
			getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
		},
	} as any;
}

function entry(id: string) {
	const found = RECIPE_REGISTRY.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`Missing registry entry ${id}`);
	return found;
}

function csvFor(id: string): Uint8Array {
	const headers = entry(id).signatureColumns;
	const text = Papa.unparse([headers, headers.map((_, index) => `value-${index}`)]);
	return new Uint8Array(Buffer.from(text, 'utf8'));
}

function xlsxFor(id: string): Uint8Array {
	const headers = entry(id).signatureColumns;
	const workbook = XLSX.utils.book_new();
	const sheet = XLSX.utils.aoa_to_sheet([
		['Synthetic profile export'],
		headers,
		headers.map((_, index) => `value-${index}`),
	]);
	XLSX.utils.book_append_sheet(workbook, sheet, 'Profile');
	return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

function jsonFor(id: string): Uint8Array {
	const record = Object.fromEntries(entry(id).signatureColumns.map((column, index) => [column, `value-${index}`]));
	return new Uint8Array(Buffer.from(JSON.stringify({ objects: [record] }), 'utf8'));
}

function set(overrides: Partial<DiscoveredImportSet> = {}): DiscoveredImportSet {
	return {
		id: 'iset-synthetic',
		scheme: 'endpoint-v1',
		noteCount: 2,
		paths: ['Frameworks/Synthetic/One.md', 'Frameworks/Synthetic/Two.md'],
		root: 'Frameworks/Synthetic',
		recipeIds: [],
		ontologyPrefixes: [],
		sources: [],
		...overrides,
	};
}

const plugin = {} as any;

beforeAll(() => {
	global.TextDecoder = NodeTextDecoder as unknown as typeof TextDecoder;
});

beforeEach(() => {
	jest.clearAllMocks();
	mockedSettle.mockResolvedValue(0);
	mockedDiscover.mockResolvedValue([]);
});

describe('vault source scan runner', () => {
	it('V1 scans three recognizable source shapes and ignores a markdown note', async () => {
		const app = appFor({
			'a.csv': csvFor('nist-csf-2-cprt'),
			'b.xlsx': xlsxFor('cri-profile-v2-2-flat'),
			'c.json': jsonFor('mitre-attack-technique-flat'),
			'notes.md': new Uint8Array(Buffer.from('# Note', 'utf8')),
		});

		const report = await scanVaultForSources(app, plugin, {});

		expect(report.rows).toHaveLength(3);
		expect(report.rows.map((row) => row.candidate.label)).toEqual(expect.arrayContaining([
			expect.stringContaining('NIST CSF 2.0'),
			'CRI Profile v2.2',
			'MITRE ATT&CK techniques',
		]));
		expect(report.rows.every((row) => row.candidate.confident && row.state.kind === 'not-imported')).toBe(true);
		expect(report.rows.find((row) => row.path === 'b.xlsx')?.candidate).toMatchObject({
			table: 'Profile',
			headerRow: 1,
		});
		expect(report.rows.find((row) => row.path === 'c.json')?.candidate.table).toBe('$.objects[*]');
	});

	it('V3 reconciles the same source digest as imported and unchanged', async () => {
		const bytes = csvFor('nist-csf-2-cprt');
		mockedDiscover.mockResolvedValue([
			set({
				sources: [{
					file: 'a.csv',
					sourceHash: computeSourceByteDigest(bytes),
					producedAt: '2026-09-20T00:00:00.000Z',
				}],
			}),
		]);

		const report = await scanVaultForSources(appFor({ 'a.csv': bytes }), plugin, {});
		expect(report.rows[0].state).toMatchObject({ kind: 'imported-unchanged', setId: 'iset-synthetic' });
	});

	it('V4 reconciles the same basename with a new digest as source changed', async () => {
		mockedDiscover.mockResolvedValue([
			set({
				sources: [{
					file: 'a.csv',
					sourceHash: 'sha256-old',
					producedAt: '2026-09-20T00:00:00.000Z',
				}],
			}),
		]);

		const report = await scanVaultForSources(appFor({ 'Exports/a.csv': csvFor('nist-csf-2-cprt') }), plugin, {});
		expect(report.rows[0].state).toMatchObject({ kind: 'imported-changed', setId: 'iset-synthetic' });
	});

	it('V5 skips source files under an existing import-set root', async () => {
		mockedDiscover.mockResolvedValue([set({ root: 'Frameworks/Synthetic' })]);
		const report = await scanVaultForSources(
			appFor({ 'Frameworks/Synthetic/source.csv': csvFor('nist-csf-2-cprt') }),
			plugin,
			{},
		);
		expect(report.rows).toEqual([]);
		expect(report.skipped).toEqual([
			{ path: 'Frameworks/Synthetic/source.csv', reason: 'inside-import-set' },
		]);
	});

	it('V6 caps the scan at 500 importable files and records the overflow', async () => {
		const bytes = csvFor('nist-csf-2-cprt');
		const contents = Object.fromEntries(
			Array.from({ length: 501 }, (_, index) => [`Sources/${String(index).padStart(3, '0')}.csv`, bytes]),
		);
		const report = await scanVaultForSources(appFor(contents), plugin, {});
		expect(report.rows).toHaveLength(500);
		expect(report.skipped.filter((item) => item.reason === 'over-cap')).toHaveLength(1);
		expect(report.total).toBe(500);
	});

	it('returns partial rows when cancelled between files', async () => {
		const controller = new AbortController();
		const bytes = csvFor('nist-csf-2-cprt');
		const report = await scanVaultForSources(
			appFor({ 'a.csv': bytes, 'b.csv': bytes, 'c.csv': bytes }),
			plugin,
			{
				signal: controller.signal,
				onProgress: ({ scanned }) => {
					if (scanned === 1) controller.abort();
				},
			},
		);
		expect(report.cancelled).toBe(true);
		expect(report.scanned).toBe(1);
		expect(report.rows).toHaveLength(1);
	});

	it('records a large-file note without parsing or emitting a row', async () => {
		const large = new Uint8Array(LARGE_FILE_BYTES + 1);
		const report = await scanVaultForSources(appFor({ 'large.csv': large }), plugin, {});
		expect(report.rows).toEqual([]);
		expect(report.notes['large.csv']).toBe(
			'Skipped: larger than the header scan limit. Open it in the wizard instead.',
		);
	});

	it('lists a source-free set from an unknown recipe as managed by another producer', async () => {
		mockedDiscover.mockResolvedValue([
			set({ id: 'external-set', root: 'External/Set', noteCount: 3, recipeIds: ['external-recipe'] }),
		]);
		const report = await scanVaultForSources(appFor({}), plugin, {});
		expect(report.foreignSets).toEqual([{ setId: 'external-set', root: 'External/Set', noteCount: 3 }]);
	});

	it('carries the recognized workbook header row into a scan-created draft', () => {
		const registryEntry = entry('cri-profile-v2-2-flat');
		const row: ScanRow = {
			path: 'Sources/synthetic.xlsx',
			name: 'synthetic.xlsx',
			candidate: {
				path: 'Sources/synthetic.xlsx',
				entryId: registryEntry.id,
				label: registryEntry.label,
				table: 'Profile',
				headerRow: 2,
				score: 100,
				confident: true,
			},
			state: { kind: 'not-imported' },
			digest: 'sha256-synthetic',
			note: null,
		};

		const draft = draftFromScanRow(row, registryEntry, { defaultOutputPath: 'Ontologies' });

		expect(draft.selectedSheet).toBe('Profile');
		expect(draft.xlsxHeaderRow).toBe(2);
	});

	it('builds the neutral snapshot key set the wizard hydrates without a preset or workbench mapping', () => {
		const registryEntry = entry('nist-csf-2-cprt');
		const row: ScanRow = {
			path: 'Sources/a.csv',
			name: 'a.csv',
			candidate: {
				path: 'Sources/a.csv',
				entryId: registryEntry.id,
				label: registryEntry.label,
				table: '',
				headerRow: 0,
				score: 100,
				confident: true,
			},
			state: { kind: 'not-imported' },
			digest: 'sha256-synthetic',
			note: null,
		};
		const draft = draftFromScanRow(row, registryEntry, { defaultOutputPath: 'Ontologies' });
		expect(Object.keys(draft).sort()).toEqual([
			'appliedConfigId', 'columnConfigsDict', 'columnInfos', 'config', 'createdAt',
			'curatedDestination', 'destinationEdited', 'frameworkId', 'id', 'name',
			'outputPath', 'overwriteMode', 'recognizedFastPath', 'schemaVersion',
			'selectedSheet', 'sourceFile', 'sourceType', 'updatedAt', 'currentStep', 'xlsxHeaderRow',
		].sort());
		expect(draft).not.toHaveProperty('presetRecipeId');
		expect(draft).not.toHaveProperty('workbenchMapping');
		expect(draft).not.toHaveProperty('workbenchRecipe');
		expect(draft.sourceFile).toEqual({ name: 'a.csv', vaultPath: 'Sources/a.csv' });
		expect(draft.currentStep).toBe(1);
	});
});
