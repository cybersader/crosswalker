/**
 * `cw import --sheet --header-row`: a workbook whose columns sit on a later
 * sheet, below a banner row, imports the same way the wizard reads it. Without
 * the flags the import reads the first sheet from row 1 and, when that fails,
 * names the sheets and the flags to pass.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as XLSX from 'xlsx';
import { runCli, tableFlags } from '../../cli/crosswalker';
import { captureIo, installByteFile, tempDir } from './helpers';

installByteFile();

function workbook(dir: string): string {
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['About this file'], ['Synthetic sample, CC0']]), 'Introduction');
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
		['Sample catalog, banner row'],
		['id', 'title', 'family'],
		['AB-1', 'First control', 'AB'],
		['AB-2', 'Second control', 'AB'],
		['CD-1', 'Third control', 'CD'],
	]), 'Controls');
	const file = path.join(dir, 'catalog.xlsx');
	fs.writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
	return file;
}

function recipe(dir: string): string {
	const file = path.join(dir, 'catalog.recipe.json');
	fs.writeFileSync(file, JSON.stringify({
		recipe: 'sample-catalog-flat',
		version: '1.0.0',
		source: { ontology: 'sample-catalog', levels: ['control'], where: "id != ''", detect: { sheet: 'Controls', header_row: 1 } },
		target: { layout: [{ level: 'control', mechanism: 'file', template: '{id}' }] },
		identity: { scheme: 'curie', prefix: 'sample', template: '{id}' },
	}));
	return file;
}

describe('cw import --sheet and --header-row', () => {
	it('reads the named sheet with column names on the given row', async () => {
		const dir = tempDir('wb');
		const vault = path.join(dir, 'vault');
		fs.mkdirSync(vault);
		const { io, out, err } = captureIo();
		const code = await runCli(['import', '--vault', vault, '--source', workbook(dir), '--sheet', 'Controls',
			'--header-row', '2', '--ontology', 'sample-catalog', '--destination', 'Catalog', '--deterministic'], io);
		expect(err.filter((line) => !line.startsWith('warning:'))).toEqual([]);
		expect(code).toBe(0);
		expect(out.join('\n')).toMatch(/Imported 3 rows/);
		const notes = fs.readdirSync(path.join(vault, 'Catalog'), { recursive: true }).map(String).filter((p) => p.endsWith('.md'));
		expect(notes.length).toBeGreaterThanOrEqual(3);
	});

	it('names the sheets and the flags when the first sheet is the wrong one', async () => {
		const dir = tempDir('wb');
		const vault = path.join(dir, 'vault');
		fs.mkdirSync(vault);
		const { io, err } = captureIo();
		const code = await runCli(['import', '--vault', vault, '--source', workbook(dir), '--recipe', recipe(dir),
			'--destination', 'Catalog', '--deterministic'], io);
		expect(code).toBe(1);
		const text = err.join('\n');
		expect(text).toContain('Sheets in this workbook: "Introduction", "Controls".');
		expect(text).toContain('This recipe was written for --sheet "Controls" --header-row 2.');
	});

	it('takes spreadsheet row numbers and refuses options that do not fit the source', () => {
		expect(tableFlags({}, 'xlsx')).toEqual({ table: '', headerRow: 0 });
		expect(tableFlags({ sheet: 'CSF 2.0', 'header-row': '2' }, 'xlsx')).toEqual({ table: 'CSF 2.0', headerRow: 1 });
		expect(() => tableFlags({ 'header-row': '0' }, 'xlsx')).toThrow(/starting at 1/);
		expect(() => tableFlags({ 'header-row': 'two' }, 'xlsx')).toThrow(/starting at 1/);
		expect(() => tableFlags({ sheet: 'x' }, 'csv')).toThrow(/A CSV has one table/);
		expect(() => tableFlags({ 'header-row': '2' }, 'csv')).toThrow(/for workbooks/);
		expect(() => tableFlags({ 'header-row': '2' }, 'json')).toThrow(/no header row/);
		expect(tableFlags({ sheet: 'items' }, 'json')).toEqual({ table: 'items', headerRow: 0 });
	});
});
