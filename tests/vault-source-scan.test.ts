import * as XLSX from 'xlsx';
import { peekXLSXBytes } from '../src/import/parsers/xlsx-parser';
import { RECIPE_REGISTRY, type RecipeRegistryEntry } from '../src/import/recipe-registry';
import {
	MAX_FILES_PER_SCAN,
	peekCSV,
	peekJSON,
	planScan,
	reconcileCandidate,
	scoreFilePeeks,
} from '../src/import/vault-source-scan';

function registryEntry(id: string): RecipeRegistryEntry {
	const entry = RECIPE_REGISTRY.find((candidate) => candidate.id === id);
	if (!entry) throw new Error(`Missing registry entry ${id}`);
	return entry;
}

function workbookBytes(sheets: Record<string, unknown[][]>): Uint8Array {
	const workbook = XLSX.utils.book_new();
	for (const [name, data] of Object.entries(sheets)) {
		XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(data), name);
	}
	return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

describe('peekCSV', () => {
	it('keeps banner and quoted cells uninterpreted, trims cells, and respects the row limit', () => {
		const text = [
			'  Synthetic source banner  ',
			' id , title , note ',
			' 1," Alpha, beta ", value ',
		].join('\n');

		expect(peekCSV(text, 3)).toEqual([
			{
				table: '',
				rows: [
					['Synthetic source banner'],
					['id', 'title', 'note'],
					['1', 'Alpha, beta', 'value'],
				],
			},
		]);
		expect(peekCSV(text, 2)[0].rows).toHaveLength(2);
	});
});

describe('peekXLSXBytes', () => {
	it('returns aligned, trimmed rows for every sheet', () => {
		const bytes = workbookBytes({
			Profile: [
				['  Synthetic profile banner  '],
				[' id ', ' title ', ' description '],
				[],
				[' X-1 ', ' Example ', ' Synthetic text '],
			],
			Lookup: [
				[' key ', ' value '],
				[' A ', ' One '],
			],
		});

		const peeks = peekXLSXBytes(bytes, 4);
		expect(peeks.map((peek) => peek.table)).toEqual(['Profile', 'Lookup']);
		expect(peeks[0].rows).toHaveLength(4);
		expect(peeks[0].rows[0]).toEqual(['Synthetic profile banner', '', '']);
		expect(peeks[0].rows[1]).toEqual(['id', 'title', 'description']);
		expect(peeks[0].rows[2]).toEqual(['', '', '']);
		expect(peeks[0].rows[3]).toEqual(['X-1', 'Example', 'Synthetic text']);
		expect(peeks[1]).toEqual({
			table: 'Lookup',
			rows: [
				['key', 'value'],
				['A', 'One'],
			],
		});
	});
});

describe('peekJSON', () => {
	it('peeks a top-level array and unions sparse record keys in first-appearance order', () => {
		const peeks = peekJSON(
			JSON.stringify([
				{ id: 'A-1', title: 'First' },
				'ignored scalar',
				{ id: 'A-2', description: 'Second' },
				{ later: 'outside limit' },
			]),
			2,
		);
		expect(peeks).toEqual([{ table: '$[*]', rows: [['id', 'title', 'description']] }]);
	});

	it('finds a record list under a top-level key', () => {
		const text = JSON.stringify({
			metadata: 'synthetic',
			objects: [{ technique: 'T-1' }, null, { name: 'Example' }],
		});
		expect(peekJSON(text)).toEqual([
			{ table: '$.objects[*]', rows: [['technique', 'name']] },
		]);
	});

	it('finds record lists one object level below the root', () => {
		const text = JSON.stringify({
			catalog: {
				label: 'Synthetic catalog',
				groups: [{ groupId: 'G-1' }, false, { heading: 'Group two' }],
			},
		});
		expect(peekJSON(text)).toEqual([
			{ table: '$.catalog.groups[*]', rows: [['groupId', 'heading']] },
		]);
	});
});

describe('scoreFilePeeks', () => {
	it('recognizes a complete CSF-shaped header confidently', () => {
		const csf = registryEntry('nist-csf-2-flat');
		const result = scoreFilePeeks(
			'Imports/csf.csv',
			'csf.csv',
			[{ table: '', rows: [[...csf.signatureColumns, 'Synthetic extra column']] }],
			[csf],
		);
		expect(result).toMatchObject({
			path: 'Imports/csf.csv',
			entryId: csf.id,
			headerRow: 0,
			score: 100,
			confident: true,
		});
	});

	it('selects a CRI-shaped header on sheet 2 below a banner row', () => {
		const cri = registryEntry('cri-profile-v2-2-flat');
		const result = scoreFilePeeks(
			'Imports/profile.xlsx',
			'profile.xlsx',
			[
				{ table: 'Instructions', rows: [['read', 'this', 'first']] },
				{
					table: 'Synthetic profile',
					rows: [['Synthetic export'], cri.signatureColumns],
				},
			],
			[cri],
		);
		expect(result).toMatchObject({
			entryId: cri.id,
			table: 'Synthetic profile',
			headerRow: 1,
			score: 100,
			confident: true,
		});
	});

	it('applies the candidate floor and required-column cap to partial CRI signatures', () => {
		const cri = registryEntry('cri-profile-v2-2-flat');
		expect(cri.signatureColumns).toHaveLength(9);
		expect(cri.requiredColumns).toHaveLength(1);
		const required = cri.requiredColumns[0];
		const otherColumns = cri.signatureColumns.filter((column) => column !== required);

		const three = scoreFilePeeks(
			'Imports/partial.csv',
			'partial.csv',
			[{ table: '', rows: [[required, ...otherColumns.slice(0, 2)]] }],
			[cri],
		);
		expect(three).toBeNull();

		const four = scoreFilePeeks(
			'Imports/partial.csv',
			'partial.csv',
			[{ table: '', rows: [[required, ...otherColumns.slice(0, 3)]] }],
			[cri],
		);
		expect(four).toMatchObject({ entryId: cri.id, score: 44, confident: false });

		const missingRequired = scoreFilePeeks(
			'Imports/partial.csv',
			'partial.csv',
			[{ table: '', rows: [otherColumns] }],
			[cri],
		);
		expect(otherColumns).toHaveLength(8);
		expect(missingRequired).toBeNull();
	});

	it('breaks equal-score ties by structural depth before registry order', () => {
		const base = registryEntry('nist-csf-2-flat');
		const shallow: RecipeRegistryEntry = {
			...base,
			id: 'synthetic-shallow',
			label: 'Synthetic shallow',
			signatureColumns: ['id', 'name', 'description'],
			requiredColumns: ['id'],
			structuralDepth: 1,
		};
		const deep: RecipeRegistryEntry = {
			...shallow,
			id: 'synthetic-deep',
			label: 'Synthetic deep',
			structuralDepth: 3,
		};
		const result = scoreFilePeeks(
			'Synthetic/source.csv',
			'source.csv',
			[{ table: '', rows: [['id', 'name', 'description']] }],
			[shallow, deep],
		);
		expect(result?.entryId).toBe('synthetic-deep');
	});
});

describe('reconcileCandidate', () => {
	const known = [
		{
			setId: 'set-a',
			file: 'Archive/source.csv',
			sourceHash: 'sha256-old',
			producedAt: '2026-09-01T00:00:00.000Z',
		},
	];

	it('returns not-imported when neither hash nor basename matches', () => {
		expect(reconcileCandidate('new.csv', 'sha256-new', known, true)).toEqual({ kind: 'not-imported' });
	});

	it('returns imported-unchanged for a matching digest', () => {
		expect(reconcileCandidate('renamed.csv', 'sha256-old', known, true)).toEqual({
			kind: 'imported-unchanged',
			setId: 'set-a',
			producedAt: '2026-09-01T00:00:00.000Z',
		});
	});

	it('returns imported-changed for a matching basename with a different digest', () => {
		expect(reconcileCandidate('Incoming/source.csv', 'sha256-new', known, true)).toEqual({
			kind: 'imported-changed',
			setId: 'set-a',
			producedAt: '2026-09-01T00:00:00.000Z',
		});
	});

	it('lets a hash match beat a name match on another set', () => {
		const sources = [
			...known,
			{ setId: 'set-b', file: 'other.csv', sourceHash: 'sha256-match', producedAt: null },
		];
		expect(reconcileCandidate('source.csv', 'sha256-match', sources, true)).toEqual({
			kind: 'imported-unchanged',
			setId: 'set-b',
			producedAt: null,
		});
	});

	it('lets a cold index beat every known source match', () => {
		expect(reconcileCandidate('source.csv', 'sha256-old', known, false)).toEqual({ kind: 'index-cold' });
	});
});

describe('planScan', () => {
	it('excludes import-set roots and the managed folder while preserving source order', () => {
		const result = planScan(
			[
				'Imports/first.csv',
				'Frameworks/Existing/source.xlsx',
				'_crosswalker/cache.json',
				'Imports/second.json',
				'Frameworks/Existing',
			],
			['Frameworks/Existing'],
		);
		expect(result.files).toEqual(['Imports/first.csv', 'Imports/second.json']);
		expect(result.skipped).toEqual([
			{ path: 'Frameworks/Existing/source.xlsx', reason: 'inside-import-set' },
			{ path: '_crosswalker/cache.json', reason: 'managed-folder' },
			{ path: 'Frameworks/Existing', reason: 'inside-import-set' },
		]);
	});

	it('keeps the first 500 eligible files and marks the rest over-cap in order', () => {
		const paths = Array.from({ length: MAX_FILES_PER_SCAN + 3 }, (_, index) =>
			`Imports/source-${String(index).padStart(3, '0')}.csv`,
		);
		const result = planScan(paths, []);
		expect(result.files).toEqual(paths.slice(0, MAX_FILES_PER_SCAN));
		expect(result.skipped).toEqual(
			paths.slice(MAX_FILES_PER_SCAN).map((path) => ({ path, reason: 'over-cap' })),
		);
	});
});
