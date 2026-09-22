import { TextDecoder, TextEncoder } from 'node:util';
import * as XLSX from 'xlsx';
import fixture from './fixtures/oscal-mini.json';
import {
	expandNestedRows,
	prepareSourceStage,
	resolveSecondaryRows,
	SourceStageError,
} from '../src/source';
import { renderTemplate } from '../src/render';
import { parseCSV } from '../src/import/parsers/csv-parser';
import { parseJSONFile } from '../src/import/parsers/json-parser';
import { parseXLSXFile } from '../src/import/parsers/xlsx-parser';
import type { NestedRecordLevel } from '../src/types/generated/recipe';
import type { ParsedData, SourceContainer } from '../src/types/config';

Object.assign(globalThis, { TextDecoder, TextEncoder });

type Row = Record<string, unknown>;

const NEST: NestedRecordLevel[] = [
	{ level: 'group', id: '{id}', children: 'controls', carry: ['title'], leaf: 'folder-note' },
	{ level: 'control', id: '{id}', children: 'parts', carry: ['title'], leaf: 'folder-note' },
	{ level: 'part', id: '{id}' },
];

const groups = (): Row[] => JSON.parse(JSON.stringify(fixture.catalog.groups)) as Row[];
const unavailableSecondary = {
	resolve: async () => { throw new Error('No secondary collection expected in this test.'); },
};
const expand = (rows = groups(), nest = NEST) => expandNestedRows(rows, nest, renderTemplate, unavailableSecondary);

function parsed(rows = groups()): ParsedData {
	return {
		columns: ['id', 'title', 'controls'],
		rows,
		rowCount: rows.length,
		container: { kind: 'json', readDocument: async () => fixture },
	};
}

async function drain(data: ParsedData, source: { nest: NestedRecordLevel[]; where?: string }) {
	const stage = await prepareSourceStage(data, source);
	const out: Row[] = [];
	for await (const row of stage.rows as AsyncIterable<Row>) out.push(row);
	stage.finalize();
	return { stage, out };
}

function fileOf(content: ArrayBuffer | string, name: string): File {
	const file = new File([content], name);
	if (typeof file.arrayBuffer !== 'function') {
		const bytes = typeof content === 'string' ? new TextEncoder().encode(content).buffer : content;
		(file as File & { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer = async () => bytes;
	}
	return file;
}

function workbook(sheets: Record<string, Row[]>): SourceContainer {
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

function jsonDocument(root: unknown): SourceContainer {
	return { kind: 'json', readDocument: async () => root };
}

function secondary(container: SourceContainer) {
	return {
		resolve: (from: any, declaration: string) => resolveSecondaryRows(from, container, declaration),
	};
}

describe('expandNestedRows', () => {
	it('emits 21 rows depth first with exact control and part lineage', async () => {
		const result = await expand();
		expect(result.rows).toHaveLength(21);
		expect(result.countsByLevel).toEqual({ group: 3, control: 6, part: 12 });
		expect(result.rows.map((row) => row.id).slice(0, 7)).toEqual([
			'ac', 'ac-1', 'ac-1_smt', 'ac-1_gdn', 'ac-2', 'ac-2_smt', 'ac-2_gdn',
		]);
		expect(result.rows[1]._cw).toEqual({
			level: 'control',
			path: ['ac', 'ac-1'],
			parent: 'ac',
			ancestors: {
				group: { id: 'ac', title: 'Access coordination' },
				control: { id: 'ac-1', title: 'Account setup' },
			},
		});
		expect(result.rows[2]._cw).toEqual({
			level: 'part',
			path: ['ac', 'ac-1', 'ac-1_smt'],
			parent: 'ac-1',
			ancestors: {
				group: { id: 'ac', title: 'Access coordination' },
				control: { id: 'ac-1', title: 'Account setup' },
				part: { id: 'ac-1_smt' },
			},
		});
		expect(result.rows[0]).not.toHaveProperty('controls');
		expect(result.rows[1]).not.toHaveProperty('parts');
	});

	it('does not emit a leaf:none level but keeps it in descendant lineage', async () => {
		const nest = NEST.map((entry, index) => index === 0 ? { ...entry, leaf: 'none' as const } : entry);
		const result = await expand(groups(), nest);
		expect(result.rows).toHaveLength(18);
		expect(result.countsByLevel).toEqual({ group: 3, control: 6, part: 12 });
		expect((result.rows[0]._cw as any).ancestors.group.id).toBe('ac');
	});

	it('emits a control with missing parts and no descendants under it', async () => {
		const rows = groups();
		delete ((rows[0].controls as Row[])[0] as Row).parts;
		const result = await expand(rows);
		expect(result.rows).toHaveLength(19);
		expect(result.rows.map((row) => row.id)).toContain('ac-1');
		expect(result.rows.map((row) => row.id)).not.toContain('ac-1_smt');
	});

	it('refuses an object where a child list is declared', async () => {
		const rows = groups();
		((rows[0].controls as Row[])[0] as Row).parts = { id: 'wrong-shape' };
		await expect(expand(rows)).rejects.toThrow(
			'Nest level "control" expects "parts" to be a list of records; found an object at path ac/ac-1.',
		);
	});

	it('refuses an empty id with the exact cause and action', async () => {
		const rows = groups();
		((rows[0].controls as Row[])[0] as Row).id = '';
		await expect(expand(rows)).rejects.toThrow(
			'Nest level "control" has a record with an empty id at path ac. Every record needs an id; check the id template.',
		);
	});

	it('accepts identity:path as a generation-time identity declaration', async () => {
		const nest = NEST.map((entry, index) => index === 2 ? { ...entry, identity: 'path' as const } : entry);
		const result = await expand(groups(), nest);
		expect(result.rows).toHaveLength(21);
	});
});

describe('join-sourced nested children', () => {
	const controls: Row[] = [
		{ 'Control ID': '1', title: 'Inventory' },
		{ 'Control ID': '2', title: 'Protection' },
		{ 'Control ID': '3', title: 'Recovery' },
	];
	const safeguards: Row[] = [
		{ 'Control ID': '1', 'Safeguard ID': '1.1' },
		{ 'Control ID': '1', 'Safeguard ID': '1.2' },
		{ 'Control ID': '2', 'Safeguard ID': '2.1' },
		{ 'Control ID': '2', 'Safeguard ID': '2.2' },
		{ 'Control ID': '3', 'Safeguard ID': '3.1' },
		{ 'Control ID': '3', 'Safeguard ID': '3.2' },
		{ 'Control ID': '99', 'Safeguard ID': '99.1' },
	];
	const workbookNest: NestedRecordLevel[] = [
		{ level: 'control', id: '{Control ID}', children: { sheet: 'Safeguards' }, leaf: 'folder-note' },
		{ level: 'safeguard', id: '{Safeguard ID}', parent_key: 'Control ID' },
	];

	it('groups a second worksheet once by normalized parent key and counts unparented rows', async () => {
		const container = workbook({ Controls: controls, Safeguards: safeguards });
		const result = await expandNestedRows(controls, workbookNest, renderTemplate, secondary(container));
		expect(result.rows).toHaveLength(9);
		expect(result.rows.map((row) => row['Safeguard ID'] ?? row['Control ID'])).toEqual([
			'1', '1.1', '1.2', '2', '2.1', '2.2', '3', '3.1', '3.2',
		]);
		for (const row of result.rows.filter((candidate) => candidate['Safeguard ID'])) {
			expect((row._cw as any).parent).toBe(String(row['Control ID']));
		}
		expect(result.unparented).toEqual({ safeguard: 1 });
	});

	it('resolves a sibling JSON array through the same secondary resolver', async () => {
		const root = { controls, safeguards };
		const nest: NestedRecordLevel[] = [
			{ level: 'control', id: '{Control ID}', children: { iterator: '$.safeguards[*]' }, leaf: 'folder-note' },
			{ level: 'safeguard', id: '{Safeguard ID}', parent_key: 'Control ID' },
		];
		const result = await expandNestedRows(controls, nest, renderTemplate, secondary(jsonDocument(root)));
		expect(result.rows).toHaveLength(9);
		expect(result.unparented.safeguard).toBe(1);
	});

	it('applies a secondary where predicate before grouping joined children', async () => {
		const filtered = safeguards.map((row) => ({ ...row, active: row['Safeguard ID'] === '2.2' ? 'no' : 'yes' }));
		const data: ParsedData = {
			columns: ['Control ID', 'title'],
			rows: controls,
			rowCount: controls.length,
			container: jsonDocument({ controls, safeguards: filtered }),
		};
		const stage = await prepareSourceStage(data, {
			nest: [
				{
					level: 'control',
					id: '{Control ID}',
					children: { iterator: '$.safeguards[*]', where: "active = 'yes'" },
					leaf: 'folder-note',
				},
				{ level: 'safeguard', id: '{Safeguard ID}', parent_key: 'Control ID' },
			],
		});
		const rows: Row[] = [];
		for await (const row of stage.rows as AsyncIterable<Row>) rows.push(row);
		stage.finalize();
		expect(rows.map((row) => row['Safeguard ID'])).not.toContain('2.2');
		expect(rows).toHaveLength(8);
		expect(stage.unparented).toEqual({ safeguard: 1 });
	});

	it('refuses a join-sourced nested level for CSV with the joins wording', async () => {
		await expect(expandNestedRows(
			controls,
			workbookNest,
			renderTemplate,
			secondary({ kind: 'flat' }),
		)).rejects.toThrow('joins are not available for a single-collection source such as CSV');
	});
});

describe('nested source-stage order', () => {
	it('expands before where, admits _cw in G2, and preserves children of an excluded parent', async () => {
		const { stage, out } = await drain(parsed(), {
			nest: NEST,
			where: "_cw.level != 'group' or id != 'au'",
		});
		expect(out).toHaveLength(20);
		expect(stage.expectedRowCount).toBe(21);
		expect(stage.countsByLevel).toEqual({ group: 3, control: 6, part: 12 });
		const auControls = out.filter((row) => row.id === 'au-1' || row.id === 'au-2');
		expect(auControls).toHaveLength(2);
		for (const row of auControls) {
			const lineage = row._cw as any;
			expect(lineage.parent).toBe('au');
			expect(lineage.ancestors.group).toEqual({});
		}
	});

	it('numbers emitted rows strictly in depth-first order', async () => {
		const { stage, out } = await drain(parsed(), { nest: NEST });
		expect(out.map((row, index) => stage.sourceRowNumber(row, index))).toEqual(
			Array.from({ length: 21 }, (_, index) => index + 1),
		);
	});
});

describe('reserved _cw parser column', () => {
	it('is refused by CSV, JSON, and XLSX parsers', async () => {
		await expect(parseCSV('_cw,name\nsource,value')).rejects.toThrow(
			'Column "_cw" is reserved for nested-record lineage. Rename it in the source and import again.',
		);
		await expect(parseJSONFile(fileOf(JSON.stringify([{ _cw: 'source', name: 'value' }]), 'source.json'))).rejects.toThrow(
			'Column "_cw" is reserved for nested-record lineage. Rename it in the source and import again.',
		);
		const workbook = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['_cw', 'name'], ['source', 'value']]), 'Data');
		const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
		await expect(parseXLSXFile(fileOf(bytes, 'source.xlsx'))).rejects.toThrow(
			'Column "_cw" is reserved for nested-record lineage. Rename it in the source and import again.',
		);
	});
});
