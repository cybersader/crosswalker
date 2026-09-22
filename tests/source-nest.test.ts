import { TextDecoder, TextEncoder } from 'node:util';
import * as XLSX from 'xlsx';
import fixture from './fixtures/oscal-mini.json';
import { expandNestedRows, prepareSourceStage, SourceStageError } from '../src/source';
import { renderTemplate } from '../src/render';
import { parseCSV } from '../src/import/parsers/csv-parser';
import { parseJSONFile } from '../src/import/parsers/json-parser';
import { parseXLSXFile } from '../src/import/parsers/xlsx-parser';
import type { NestedRecordLevel } from '../src/types/generated/recipe';
import type { ParsedData } from '../src/types/config';

Object.assign(globalThis, { TextDecoder, TextEncoder });

type Row = Record<string, unknown>;

const NEST: NestedRecordLevel[] = [
	{ level: 'group', id: '{id}', children: 'controls', carry: ['title'], leaf: 'folder-note' },
	{ level: 'control', id: '{id}', children: 'parts', carry: ['title'], leaf: 'folder-note' },
	{ level: 'part', id: '{id}' },
];

const groups = (): Row[] => JSON.parse(JSON.stringify(fixture.catalog.groups)) as Row[];
const expand = (rows = groups(), nest = NEST) => expandNestedRows(rows, nest, renderTemplate);

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

describe('expandNestedRows', () => {
	it('emits 21 rows depth first with exact control and part lineage', () => {
		const result = expand();
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

	it('does not emit a leaf:none level but keeps it in descendant lineage', () => {
		const nest = NEST.map((entry, index) => index === 0 ? { ...entry, leaf: 'none' as const } : entry);
		const result = expand(groups(), nest);
		expect(result.rows).toHaveLength(18);
		expect(result.countsByLevel).toEqual({ group: 3, control: 6, part: 12 });
		expect((result.rows[0]._cw as any).ancestors.group.id).toBe('ac');
	});

	it('emits a control with missing parts and no descendants under it', () => {
		const rows = groups();
		delete ((rows[0].controls as Row[])[0] as Row).parts;
		const result = expand(rows);
		expect(result.rows).toHaveLength(19);
		expect(result.rows.map((row) => row.id)).toContain('ac-1');
		expect(result.rows.map((row) => row.id)).not.toContain('ac-1_smt');
	});

	it('refuses an object where a child list is declared', () => {
		const rows = groups();
		((rows[0].controls as Row[])[0] as Row).parts = { id: 'wrong-shape' };
		expect(() => expand(rows)).toThrow(
			'Nest level "control" expects "parts" to be a list of records; found an object at path ac/ac-1.',
		);
	});

	it('refuses an empty id with the exact cause and action', () => {
		const rows = groups();
		((rows[0].controls as Row[])[0] as Row).id = '';
		expect(() => expand(rows)).toThrow(
			'Nest level "control" has a record with an empty id at path ac. Every record needs an id; check the id template.',
		);
	});

	it('refuses join-sourced children in this wave', () => {
		const nest = NEST.map((entry, index) => index === 0
			? { ...entry, children: { sheet: 'Controls' } }
			: entry);
		expect(() => expand(groups(), nest)).toThrow(
			'Nest level "group" is joined from another collection. That arrives in a later build; declare JSON field children for now.',
		);
	});

	it('refuses identity:path in this wave', () => {
		const nest = NEST.map((entry, index) => index === 2 ? { ...entry, identity: 'path' as const } : entry);
		expect(() => expand(groups(), nest)).toThrow(
			'identity: path is not available in this build yet. Use identity: global, or wait for the next build.',
		);
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
