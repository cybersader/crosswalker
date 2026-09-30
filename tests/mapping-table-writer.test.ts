/**
 * Slice 3 Part A of the mapping table form (2026-09-30): the table writer.
 *
 * Synthetic data only: `demo-a:` / `demo-b:` ids, `iset-demo12`.
 */
import type { App } from 'obsidian';
import { TFile, TFolder } from 'obsidian';
import {
	MAPPING_TABLE_FORMAT, assignMappingRowIds, serializeMappingTable,
	type MappingTableHeader, type MappingTableRow,
} from '../src/mappings/mapping-table';
import { mappingTablePath, mergeReviewColumns, writeMappingTable } from '../src/mappings/mapping-table-writer';

const header: MappingTableHeader = {
	crosswalker_format: MAPPING_TABLE_FORMAT,
	import_set: 'iset-demo12',
	mapping_set_id: 'demo-map',
	crosswalker_provenance: {
		spec_version: 'https://crosswalker.dev/spec/tier1.schema.json',
		source_ref: { file: 'demo-map' },
		produced_at: '2026-09-30T00:00:00.000Z',
		producer: { kind: 'plugin-engine', name: 'crosswalker-plugin', version: '0.0.0-test' },
		import_set: { id: 'iset-demo12', scheme: 'endpoint-v1', mapping_form: 'table' },
	},
};

function rows(): MappingTableRow[] {
	return assignMappingRowIds([
		{ subject_id: 'demo-a:X-1', predicate_id: 'is_equivalent_to', object_id: 'demo-b:Y-1', subject_label: 'New label', mapping_set_id: 'demo-map' },
		{ subject_id: 'demo-a:X-2', predicate_id: 'intersects_with', object_id: 'demo-b:Y-2', mapping_set_id: 'demo-map' },
	], 'demo-map');
}

describe('mappingTablePath', () => {
	it('slugs the framework pair into the stem', () => {
		expect(mappingTablePath('Maps/pair', 'Demo A', 'demo.b')).toBe('Maps/pair/demo-a-to-demo-b.mapping-table.tsv');
	});

	it('falls back to mappings when either framework is unknown', () => {
		expect(mappingTablePath('Maps', 'demo-a')).toBe('Maps/mappings.mapping-table.tsv');
		expect(mappingTablePath('Maps', undefined, 'demo-b')).toBe('Maps/mappings.mapping-table.tsv');
		expect(mappingTablePath('Maps', '  ', '  ')).toBe('Maps/mappings.mapping-table.tsv');
	});

	it('writes at the vault root when the folder is empty', () => {
		expect(mappingTablePath('', 'demo-a', 'demo-b')).toBe('demo-a-to-demo-b.mapping-table.tsv');
	});

	it('qualifies the stem with the import set id when asked', () => {
		expect(mappingTablePath('Maps/pair', 'demo-a', 'demo-b', 'iset-demo12')).toBe('Maps/pair/demo-a-to-demo-b.iset-demo12.mapping-table.tsv');
		expect(mappingTablePath('Maps', undefined, undefined, 'iset-demo12')).toBe('Maps/mappings.iset-demo12.mapping-table.tsv');
	});
});

describe('mergeReviewColumns', () => {
	it('carries review columns by row id, drops absent rows, and keeps managed columns from the new rows', () => {
		const next = rows();
		const existing: MappingTableRow[] = [
			{ ...next[0], subject_label: 'Old label', review_status: 'approved', reviewer: 'reviewer-1', notes: { notes: 'Checked.' } },
			{ row_id: 'm-0000000000000000', subject_id: 'demo-a:X-9', predicate_id: 'intersects_with', object_id: 'demo-b:Y-9', review_status: 'rejected' },
		];
		const merged = mergeReviewColumns(next, existing);
		expect(merged.carried).toBe(1);
		expect(merged.dropped).toBe(1);
		expect(merged.rows).toHaveLength(2);
		const first = merged.rows.find((row) => row.row_id === next[0].row_id)!;
		expect(first.subject_label).toBe('New label');
		expect(first.review_status).toBe('approved');
		expect(first.reviewer).toBe('reviewer-1');
		expect(first.notes).toEqual({ notes: 'Checked.' });
		const second = merged.rows.find((row) => row.row_id === next[1].row_id)!;
		expect(second.review_status).toBeUndefined();
	});

	it('lets an existing row with no review clear a value the new row carried', () => {
		const next = rows().map((row) => ({ ...row, review_status: 'unreviewed' }));
		const merged = mergeReviewColumns(next, [{ ...next[0], review_status: undefined }]);
		expect(merged.rows[0].review_status).toBeUndefined();
		// A matched row with no review recorded carried nothing.
		expect(merged.carried).toBe(0);
		expect(merged.rows[1].review_status).toBe('unreviewed');
	});
});

interface MockVault {
	app: App;
	files: Map<string, string>;
	folders: Set<string>;
	calls: string[];
}

function mockVault(options: { corruptRead?: boolean; seed?: Record<string, string>; folderAt?: string } = {}): MockVault {
	const files = new Map(Object.entries(options.seed ?? {}));
	const folders = new Set<string>(options.folderAt ? [options.folderAt] : []);
	const calls: string[] = [];
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			createFolder: async (path: string) => { calls.push(`mkdir ${path}`); folders.add(path); },
			create: async (path: string, content: string) => { calls.push(`create ${path}`); files.set(path, content); return new TFile(path); },
			modify: async (file: TFile, content: string) => { calls.push(`modify ${file.path}`); files.set(file.path, content); },
			read: async (file: TFile) => {
				const content = files.get(file.path) ?? '';
				return options.corruptRead ? content.slice(0, Math.floor(content.length / 2)) : content;
			},
		},
	} as unknown as App;
	return { app, files, folders, calls };
}

describe('writeMappingTable', () => {
	const path = 'Maps/pair/demo-a-to-demo-b.mapping-table.tsv';

	it('creates the folder and the file when none exists', async () => {
		const vault = mockVault();
		const outcome = await writeMappingTable(vault.app, { path, header, rows: rows() });
		expect(outcome.created).toBe(true);
		expect(vault.calls).toEqual(['mkdir Maps', 'mkdir Maps/pair', `create ${path}`]);
		const expected = serializeMappingTable(header, rows());
		expect(vault.files.get(path)).toBe(expected);
		expect(outcome.bytes).toBe(Buffer.byteLength(expected, 'utf8'));
	});

	it('modifies an existing file in place', async () => {
		const vault = mockVault({ seed: { [path]: 'old' } });
		vault.folders.add('Maps').add('Maps/pair');
		const outcome = await writeMappingTable(vault.app, { path, header, rows: rows() });
		expect(outcome.created).toBe(false);
		expect(vault.calls).toEqual([`modify ${path}`]);
		expect(vault.files.get(path)).toBe(serializeMappingTable(header, rows()));
	});

	it('throws an actionable error when the read-back does not match', async () => {
		const vault = mockVault({ corruptRead: true });
		await expect(writeMappingTable(vault.app, { path, header, rows: rows() }))
			.rejects.toThrow(`Could not verify the mapping table after writing ${path}. Check the folder is writable and not synced by another tool, then run the import again.`);
	});

	it('refuses when a folder sits at the table path', async () => {
		const vault = mockVault({ folderAt: path });
		await expect(writeMappingTable(vault.app, { path, header, rows: rows() })).rejects.toThrow(/a folder already exists/);
		expect(vault.calls.some((call) => call.startsWith('create') || call.startsWith('modify'))).toBe(false);
	});
});
