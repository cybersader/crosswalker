import * as XLSX from 'xlsx';
import { peekXLSXBytes } from '../src/import/parsers/xlsx-parser';
import { RECIPE_REGISTRY } from '../src/import/recipe-registry';
import { suggestWorkbookBinding } from '../src/import/workbook-suggestion';

function entry(id: string) {
	const found = RECIPE_REGISTRY.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`Missing registry entry ${id}`);
	return found;
}

function workbookBytes(sheets: Array<{ name: string; rows: string[][] }>): Uint8Array {
	const workbook = XLSX.utils.book_new();
	for (const sheet of sheets) {
		XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
	}
	return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

describe('suggestWorkbookBinding', () => {
	it('suggests the recognized second sheet and its banner-adjusted header row', () => {
		const cri = entry('cri-profile-v2-2-flat');
		const bytes = workbookBytes([
			{ name: 'Read me', rows: [['Topic', 'Value', 'Notes'], ['Synthetic', 'Example', 'Only']] },
			{
				name: 'Profile',
				rows: [
					['Synthetic profile export'],
					cri.signatureColumns,
					cri.signatureColumns.map((_, index) => `value-${index}`),
				],
			},
		]);

		const suggestion = suggestWorkbookBinding(peekXLSXBytes(bytes), 'synthetic-profile.xlsx', RECIPE_REGISTRY);

		expect(suggestion).toMatchObject({
			sheetName: 'Profile',
			headerRow: 1,
			recipeId: cri.id,
			label: cri.label,
			score: 100,
			confident: true,
		});
	});

	it('returns null when no workbook sheet is recognizable', () => {
		const bytes = workbookBytes([
			{ name: 'Data', rows: [['Alpha', 'Beta', 'Gamma'], ['One', 'Two', 'Three']] },
		]);

		expect(suggestWorkbookBinding(peekXLSXBytes(bytes), 'unrelated.xlsx', RECIPE_REGISTRY)).toBeNull();
	});

	it('returns null for a CSV peek even when its headers are recognizable', () => {
		const cri = entry('cri-profile-v2-2-flat');
		expect(suggestWorkbookBinding(
			[{ table: '', rows: [cri.signatureColumns] }],
			'synthetic-profile.csv',
			RECIPE_REGISTRY,
		)).toBeNull();
	});
});
