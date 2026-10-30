import * as XLSX from 'xlsx';
import { referencedFramework, referencedFrameworkRecipe, referencedOntologyKey } from '../src/import/stack/referenced-frameworks';
import { injectiveDeclaredIdLocalPart } from '../src/generation/curie';
import { workbookTable } from '../src/import/stack/licensed-workbook-readers';

const binding = { column: 'Invented target list', label: 'Invented standard', ontology: 'invented-target' };
const source = { idColumn: 'Invented source id', ontology: 'invented-source' };

describe('referenced frameworks (synthetic columns and ids only)', () => {
	it('splits newlines, emits unique pairs and id-only rows, and counts exclusions', () => {
		const result = referencedFramework([
			{ 'Invented source id': 'XX-999', 'Invented target list': ' ZZ-901\r\nZZ-902\nZZ-901\n ' },
			{ 'Invented source id': 'XX-998', 'Invented target list': 'ZZ-901' },
			{ 'Invented source id': '', 'Invented target list': 'ZZ-903' },
		], binding, source);
		expect(result).toMatchObject({ assertions: 5, duplicates: 1, missingSubjects: 1 });
		expect(result.notes.map((note) => note.id)).toEqual(['ZZ-901', 'ZZ-902']);
		expect(result.notes.every((note) => note.framework === 'Invented standard')).toBe(true);
		expect(result.mappings).toHaveLength(3);
		expect(result.mappings[0]).toEqual({ subject_id: 'invented-source:XX-999', object_id: 'invented-target:ZZ-901', predicate_id: 'skos:relatedMatch', mapping_justification: 'semapv:ManualMappingCuration' });
	});
	it('keeps punctuation-bearing identifiers injective and filename-safe', () => {
		const ids = ['ZZ 999', 'ZZ-999', 'ZZ/999', 'ZZ_999', 'ZZ:999', 'ZZ..999'];
		const result = referencedFramework([{ 'Invented source id': 'XX-999', 'Invented target list': ids.join('\n') }], binding, source);
		expect(new Set(result.mappings.map((row) => row.object_id)).size).toBe(ids.length);
		expect(new Set(result.notes.map((note) => note.file_id)).size).toBe(ids.length);
		expect(result.notes.every((note) => /^[A-Za-z0-9_-]+$/.test(note.file_id))).toBe(true);
		expect(result.mappings.map((row) => row.object_id)).toEqual(ids.map((id) => `invented-target:${injectiveDeclaredIdLocalPart(id)}`));
	});
	it('works unchanged for a long-form mappings catalog', () => {
		const result = referencedFramework([{ 'Invented diagnostic id': 'XX.YY-99', 'Invented catalog id': 'ZZ-999' }],
			{ column: 'Invented catalog id', label: 'Invented catalog', ontology: 'invented-catalog' },
			{ idColumn: 'Invented diagnostic id', ontology: 'invented-profile' });
		expect(result.notes).toHaveLength(1);
		expect(result.mappings[0]).toMatchObject({ subject_id: 'invented-profile:XX.YY-99', object_id: 'invented-catalog:ZZ-999' });
	});
	it('has a fixed slug rule and no framework-specific recipe fields', () => {
		expect(referencedOntologyKey('Invented / Stándard 2099.9')).toBe('invented-standard-2099-9');
		expect(referencedOntologyKey('2099 invented')).toBe('cw-2099-invented');
		const recipe = referencedFrameworkRecipe('invented-target', 'Invented source');
		expect(recipe.source.ontology).toBe('invented-target');
		expect(JSON.stringify(recipe)).toContain("It comes from Invented source's crosswalk");
		expect(recipe.target.also_emit?.frontmatter?.managed).not.toHaveProperty('referenced_only');
	});
	it('preserves cell newlines only when the caller requests crosswalk lists', () => {
		const book = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
			['Invented\nsource id', 'Invented target list'], ['XX-999', 'ZZ-901\r\nZZ-902'],
		]), 'Invented sheet');
		expect(workbookTable(book, 'Invented sheet', ['Invented source id'], true)[0]['Invented target list']).toBe('ZZ-901\nZZ-902');
		expect(workbookTable(book, 'Invented sheet', ['Invented source id'])[0]['Invented target list']).toBe('ZZ-901 ZZ-902');
	});
});
