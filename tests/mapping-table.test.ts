import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import {
	MAPPING_TABLE_FORMAT, edgeFrontmatterToTableRow, mappingRowId,
	parseMappingTable, serializeMappingTable, tableRowToEdgeFrontmatter,
	type MappingTableHeader, type MappingTableRow,
} from '../src/mappings/mapping-table';
import { discoverImportSets, mappingFormOf, resolveImportSet } from '../src/generation/import-set';

const header: MappingTableHeader = {
	crosswalker_format: MAPPING_TABLE_FORMAT,
	import_set: 'iset-demo12', mapping_set_id: 'demo-map',
	source_framework: 'demo-a', target_framework: 'demo-b',
	tags: ['crosswalk/demo-a-to-demo-b'],
	mapping_provider: 'Demo "provider"',
};
const first: MappingTableRow = {
	row_id: mappingRowId('demo-a:X-1', 'is_equivalent_to', 'demo-b:Y-1', 'NOT'),
	subject_id: 'demo-a:X-1', predicate_id: 'is_equivalent_to', object_id: 'demo-b:Y-1',
	predicate_modifier: 'NOT', sssom_predicate: 'skos:exactMatch',
	confidence: '0.72', subject_label: 'A\tlabel\r\nwith "quote"\r',
	notes: { my_notes: 'Personal \t note\n"quoted"' },
	extra: { other_value: ['one', { data: true }] },
};
const second: MappingTableRow = {
	row_id: mappingRowId('demo-a:X-2', 'intersects_with', 'demo-b:Y-2'),
	subject_id: 'demo-a:X-2', predicate_id: 'intersects_with', object_id: 'demo-b:Y-2',
};

function formApp(forms: Array<string | undefined>): App {
	const files = forms.map((_, index) => new TFile(`Demo/Edge-${index}.md`));
	return {
		vault: { getMarkdownFiles: () => files },
		metadataCache: {
			getFileCache: (file: TFile) => {
				const index = files.findIndex((candidate) => candidate.path === file.path);
				return { frontmatter: { _crosswalker: { import_set: {
					id: 'iset-demo12', scheme: 'endpoint-v1',
					...(forms[index] === undefined ? {} : { mapping_form: forms[index] }),
				} } } };
			},
		},
	} as unknown as App;
}

describe('Crosswalker mapping-table ledger', () => {
	it('round-trips all cells, including TSV-hostile characters and JSON columns', () => {
		const parsed = parseMappingTable(serializeMappingTable(header, [second, first]));
		expect(parsed).toEqual({
			header, rows: [first, second].sort((a, b) => a.row_id.localeCompare(b.row_id)),
			errors: [], warnings: [],
		});
	});
	it('sorts records for byte-deterministic output', () => {
		expect(serializeMappingTable(header, [first, second])).toBe(serializeMappingTable(header, [second, first]));
	});
	it('converts both builder frontmatter shapes without losing user or unknown fields', () => {
		const shared = {
			title: 'demo-a:X-1 -> demo-b:Y-1', tags: header.tags,
			subject_id: 'demo-a:X-1', predicate_id: 'is_equivalent_to', object_id: 'demo-b:Y-1',
			subject_note: '[[demo-a/X-1]]', object_note: '[[demo-b/Y-1]]',
			subject_label: 'A\tlabel\nwith "quote"',
			mapping_justification: 'Manual demo', mapping_set_id: 'demo-map',
			source_framework: 'demo-a', target_framework: 'demo-b',
			sssom_predicate: 'skos:exactMatch', review_status: 'pending',
			reviewer: 'Demo reviewer', my_notes: 'Keep this note', unknown_field: { nested: 1 },
			_crosswalker: { import_set: { id: 'iset-demo12' } },
		};
		const synthetic = {
			...shared, object_label: 'Target', mapping_provider: 'Demo',
			predicate_modifier: 'NOT', sssom_confidence: '0.72',
		};
		const column = { ...shared };
		for (const fm of [synthetic, column]) {
			const converted = edgeFrontmatterToTableRow(fm);
			expect(converted.error).toBeUndefined();
			expect(converted.row?.extra).toMatchObject({ unknown_field: { nested: 1 } });
			expect(tableRowToEdgeFrontmatter(converted.row!, header)).toEqual(
				Object.fromEntries(Object.entries(fm).filter(([key]) => key !== '_crosswalker')),
			);
		}
		expect(edgeFrontmatterToTableRow({}).error).toMatch(/subject_id/);
	});
	it('refuses occurrence-distinct notes with the same four-fact id before writing a lossy table', () => {
		const base = {
			subject_id: 'demo-a:X-3', predicate_id: 'is_equivalent_to', object_id: 'demo-b:Y-3',
		};
		const a = edgeFrontmatterToTableRow({ ...base, mapping_set_id: 'demo-one', mapping_justification: 'Manual A' }).row!;
		const b = edgeFrontmatterToTableRow({ ...base, mapping_set_id: 'demo-two', mapping_justification: 'Manual B' }).row!;
		expect(a.row_id).toBe(b.row_id);
		expect(() => serializeMappingTable(header, [a, b])).toThrow(/Keep these mappings as notes until each occurrence has a distinct row identity/);
	});
	it('preserves blank and typed user fields through the actual TSV codec', () => {
		const fm = {
			title: 'demo-a:X-4 -> demo-b:Y-4', tags: header.tags,
			subject_id: 'demo-a:X-4', predicate_id: 'intersects_with', object_id: 'demo-b:Y-4',
			source_framework: 'demo-a', target_framework: 'demo-b',
			reviewer: null, review_status: '', my_notes: null, other_notes: '',
			sssom_confidence: 0.5, mapping_provider: false, sample_count: 12,
		};
		const converted = edgeFrontmatterToTableRow(fm);
		expect(converted.row?.extra).toMatchObject({ reviewer: null, review_status: '', my_notes: null, other_notes: '', sssom_confidence: 0.5 });
		const parsed = parseMappingTable(serializeMappingTable(header, [converted.row!]));
		expect(parsed.errors).toEqual([]);
		expect(tableRowToEdgeFrontmatter(parsed.rows[0], header)).toEqual(fm);
	});
	it('derives stable identity from all four facts, not the note path', () => {
		expect(mappingRowId('demo-a:X-1', 'intersects_with', 'demo-b:Y-1'))
			.toMatch(/^m-[0-9a-f]{16}$/);
		expect(mappingRowId('demo-a:X-1', 'intersects_with', 'demo-b:Y-1'))
			.toBe(mappingRowId('demo-a:X-1', 'intersects_with', 'demo-b:Y-1'));
		expect(mappingRowId('demo-a:X-1', 'intersects_with', 'demo-b:Y-1'))
			.not.toBe(mappingRowId('demo-a:X-1', 'intersects_with', 'demo-b:Y-1', 'NOT'));
	});
	it('rejects missing or unknown format, missing required column and duplicate ids', () => {
		const encoded = serializeMappingTable(header, [first, second]);
		expect(parseMappingTable(encoded.replace(/^# crosswalker_format: .*\n/m, '')).errors.join(' '))
			.toContain('not a Crosswalker mapping table');
		expect(parseMappingTable(encoded.replace(MAPPING_TABLE_FORMAT, 'other-format')).errors.join(' '))
			.toContain('not a Crosswalker mapping table');
		expect(parseMappingTable(encoded.replace('row_id\t', 'other_id\t')).errors.join(' '))
			.toContain('Missing required mapping table column: row_id');
		expect(() => serializeMappingTable(header, [first, first])).toThrow(`Duplicate mapping table row_id: ${first.row_id}`);
		const duplicate = `${encoded}${encoded.slice(encoded.indexOf(`${first.row_id}\t`))}`;
		expect(parseMappingTable(duplicate).errors.join(' '))
			.toContain(`Duplicate mapping table row_id: ${first.row_id}`);
	});
	it('skips rows with empty required cells and reports the affected row', () => {
		const encoded = serializeMappingTable(header, [second]);
		const missingId = encoded.replace(`${second.row_id}\t`, '\t');
		const missingSubject = encoded.replace(`${second.subject_id}\t`, '\t');
		for (const invalid of [missingId, missingSubject]) {
			const parsed = parseMappingTable(`${encoded}${invalid.slice(invalid.indexOf('\nrow_id\t') + 1).split('\n').slice(1).join('\n')}`);
			expect(parsed.errors.join(' ')).toMatch(/Missing required mapping table value .* on row 2/);
			expect(parsed.warnings.join(' ')).toMatch(/Skipped 1/);
			expect(parsed.rows).toEqual([second]);
		}
	});
	it('skips a bad JSON cell but retains the other rows', () => {
		const encoded = serializeMappingTable(header, [first, second]);
		const bad = encoded.replace('"{""my_notes""', '"x{""my_notes""');
		expect(bad).not.toBe(encoded);
		const parsed = parseMappingTable(bad);
		expect(parsed.errors.join(' ')).toMatch(/Invalid JSON.*row 1/);
		expect(parsed.warnings.join(' ')).toMatch(/Skipped 1/);
		expect(parsed.rows).toHaveLength(1);
	});
});

describe('Mapping form pin', () => {
	it('defaults legacy sets to notes', () => {
		expect(mappingFormOf()).toBe('notes');
		expect(mappingFormOf({})).toBe('notes');
		expect(mappingFormOf({ mapping_form: 'table' })).toBe('table');
	});
	it('refuses unknown and inconsistent forms through discovery and refresh', async () => {
		await expect(discoverImportSets(formApp(['other']))).rejects.toThrow(/Invalid mapping form/);
		await expect(resolveImportSet(formApp(['other']), 'Demo', { id: 'iset-demo12' })).rejects.toThrow(/Invalid mapping form/);
		await expect(discoverImportSets(formApp(['table', undefined]))).rejects.toThrow(/different mapping forms/);
	});
	it('preserves a pinned form through refresh and leaves new mint unset', async () => {
		const app = formApp(['table']);
		expect((await discoverImportSets(app))[0].mapping_form).toBe('table');
		expect((await resolveImportSet(app, 'Demo', { id: 'iset-demo12' })).mapping_form).toBe('table');
		expect((await resolveImportSet(app, 'Demo', 'new')).mapping_form).toBeUndefined();
	});
});
