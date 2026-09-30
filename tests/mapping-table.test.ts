import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import {
	MAPPING_TABLE_FORMAT, assignMappingRowIds, edgeFrontmatterToTableRow, mappingRowId,
	parseMappingTable, serializeMappingTable, tableRowToEdgeFrontmatter,
	type MappingTableHeader, type MappingTableRow, type MappingTableRowFacts,
} from '../src/mappings/mapping-table';
import { readMappingTables, tableRowsAsEdgeRecords } from '../src/mappings/mapping-table-reader';
import { discoverImportSets, mappingFormOf, resolveImportSet } from '../src/generation/import-set';
import { SSSOM_CURIE_PREFIX, sssomEdgeCurie } from '../src/generation/crosswalk-identity';

const header: MappingTableHeader = {
	crosswalker_format: MAPPING_TABLE_FORMAT,
	import_set: 'iset-demo12', mapping_set_id: 'demo-map',
	source_framework: 'demo-a', target_framework: 'demo-b',
	tags: ['crosswalk/demo-a-to-demo-b'],
	mapping_provider: 'Demo "provider"',
};
const first: MappingTableRow = {
	row_id: mappingRowId({ subject_id: 'demo-a:X-1', predicate_id: 'is_equivalent_to', object_id: 'demo-b:Y-1', predicate_modifier: 'NOT' }, 0),
	subject_id: 'demo-a:X-1', predicate_id: 'is_equivalent_to', object_id: 'demo-b:Y-1',
	predicate_modifier: 'NOT', sssom_predicate: 'skos:exactMatch',
	confidence: '0.72', subject_label: 'A\tlabel\r\nwith "quote"\r',
	notes: { my_notes: 'Personal \t note\n"quoted"' },
	extra: { other_value: ['one', { data: true }] },
};
const second: MappingTableRow = {
	row_id: mappingRowId({ subject_id: 'demo-a:X-2', predicate_id: 'intersects_with', object_id: 'demo-b:Y-2' }, 0),
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
			errors: [], rowErrors: [], warnings: [], provenance: 'absent',
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
			expect(tableRowToEdgeFrontmatter(assignMappingRowIds([converted.row!])[0], header)).toEqual(
				Object.fromEntries(Object.entries(fm).filter(([key]) => key !== '_crosswalker')),
			);
		}
		expect(edgeFrontmatterToTableRow({}).error).toMatch(/subject_id/);
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
		const parsed = parseMappingTable(serializeMappingTable(header, assignMappingRowIds([converted.row!])));
		expect(parsed.errors).toEqual([]);
		expect(tableRowToEdgeFrontmatter(parsed.rows[0], header)).toEqual(fm);
	});
	it('derives stable identity from the edge facts, not the note path', () => {
		const base = { subject_id: 'demo-a:X-1', predicate_id: 'intersects_with', object_id: 'demo-b:Y-1' };
		expect(mappingRowId(base, 0)).toMatch(/^m-[0-9a-f]{16}$/);
		expect(mappingRowId(base, 0)).toBe(mappingRowId({ ...base }, 0));
		expect(mappingRowId(base, 0)).not.toBe(mappingRowId({ ...base, predicate_modifier: 'NOT' }, 0));
		expect(mappingRowId(base, 0)).not.toBe(mappingRowId({ ...base, mapping_set_id: 'demo-map' }, 0));
		expect(mappingRowId(base, 3)).toBe(`${mappingRowId(base, 0)}-03`);
		expect(mappingRowId(base, 120)).toBe(`${mappingRowId(base, 0)}-120`);
	});
	it('rejects missing or unknown format, missing required column and duplicate ids', () => {
		const encoded = serializeMappingTable(header, [first, second]);
		expect(parseMappingTable(encoded.replace(/^# crosswalker_format: .*\n/m, '')).errors.join(' '))
			.toContain('not a Crosswalker mapping table');
		expect(parseMappingTable(encoded.replace(MAPPING_TABLE_FORMAT, 'other-format')).errors.join(' '))
			.toContain('not a Crosswalker mapping table');
		expect(parseMappingTable(encoded.replace('row_id\t', 'other_id\t')).errors.join(' '))
			.toContain('Missing required mapping table column: row_id');
		const duplicate = `${encoded}${encoded.slice(encoded.indexOf(`${first.row_id}\t`))}`;
		// A duplicate is a row error: the first occurrence survives.
		const parsedDuplicate = parseMappingTable(duplicate);
		expect(parsedDuplicate.errors).toEqual([]);
		expect(parsedDuplicate.rowErrors.join(' '))
			.toContain(`Duplicate mapping table row_id: ${first.row_id}`);
		expect(parsedDuplicate.rows.map((row) => row.row_id).sort()).toEqual([first.row_id, second.row_id].sort());
	});
	it('skips rows with empty required cells and reports the affected row', () => {
		const encoded = serializeMappingTable(header, [second]);
		const missingId = encoded.replace(`${second.row_id}\t`, '\t');
		const missingSubject = encoded.replace(`${second.subject_id}\t`, '\t');
		for (const invalid of [missingId, missingSubject]) {
			const parsed = parseMappingTable(`${encoded}${invalid.slice(invalid.indexOf('\nrow_id\t') + 1).split('\n').slice(1).join('\n')}`);
			expect(parsed.errors).toEqual([]);
			expect(parsed.rowErrors.join(' ')).toMatch(/Missing required mapping table value .* on row 2/);
			expect(parsed.warnings.join(' ')).toMatch(/Skipped 1/);
			expect(parsed.rows).toEqual([second]);
		}
	});
	it('skips a bad JSON cell but retains the other rows', () => {
		const encoded = serializeMappingTable(header, [first, second]);
		const bad = encoded.replace('"{""my_notes""', '"x{""my_notes""');
		expect(bad).not.toBe(encoded);
		const parsed = parseMappingTable(bad);
		// Row order follows row_id, so the bad row's number depends on the id hash.
		expect(parsed.errors).toEqual([]);
		expect(parsed.rowErrors.join(' ')).toMatch(/Invalid JSON in crosswalker_notes on row [12]\./);
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

describe('Mapping table slice 2: provenance header, occurrence ids, curie, reader', () => {
	const provenance = {
		spec_version: 'https://crosswalker.dev/spec/tier1.schema.json',
		source_ref: { file: 'demo-a-to-demo-b.sssom.tsv' },
		produced_at: '2026-09-30T00:00:00.000Z',
		producer: { kind: 'plugin-engine', name: 'crosswalker-plugin', version: '0.0.0-test' },
		import_set: {
			id: 'iset-demo12', scheme: 'endpoint-v1', parent_set: 'iset-demo34',
			derivation: 'declared-facts-v1', mapping_form: 'table',
		},
	};
	const tableHeader: MappingTableHeader = { ...header, crosswalker_provenance: provenance };
	const withBlock = (importSet: Record<string, unknown> | undefined, extra: Partial<MappingTableHeader> = {}): MappingTableHeader => ({
		...header, ...extra,
		crosswalker_provenance: importSet === undefined
			? { spec_version: provenance.spec_version }
			: { ...provenance, import_set: importSet },
	});

	it('round-trips the provenance block as one JSON-in-string header line after tags', () => {
		const encoded = serializeMappingTable(tableHeader, [first, second]);
		const lines = encoded.split('\n');
		const tagsLine = lines.findIndex((line) => line.startsWith('# tags: '));
		expect(lines[tagsLine + 1]).toBe(`# crosswalker_provenance: ${JSON.stringify(JSON.stringify(provenance))}`);
		const parsed = parseMappingTable(encoded);
		expect(parsed.errors).toEqual([]);
		expect(parsed.header).toEqual(tableHeader);
		expect(parsed.rows).toHaveLength(2);
	});

	it('refuses a provenance block that disagrees, is not pinned to table form, or breaks a note rule', () => {
		const errorsFor = (value: MappingTableHeader) => {
			const parsed = parseMappingTable(serializeMappingTable(value, [first]));
			expect(parsed.rows).toEqual([]);
			return parsed.errors.join(' ');
		};
		expect(errorsFor(withBlock({ ...provenance.import_set, id: 'iset-other1' })))
			.toContain('Mapping table header import_set does not match its provenance block. Fix one of them before importing.');
		const notPinned = "This mapping table's import set is not pinned to table form. Convert the set instead of editing the file.";
		expect(errorsFor(withBlock({ ...provenance.import_set, mapping_form: 'notes' }))).toContain(notPinned);
		expect(errorsFor(withBlock({ id: 'iset-demo12', scheme: 'endpoint-v1' }))).toContain(notPinned);
		expect(errorsFor(withBlock(undefined))).toContain(notPinned);
		// The same shared validator a note's block goes through.
		expect(errorsFor(withBlock({ ...provenance.import_set, id: 'not-an-id' }))).toMatch(/Invalid import set id at mapping table header/);
		expect(errorsFor(withBlock({ ...provenance.import_set, scheme: 'future-v1' }))).toMatch(/Invalid import set scheme at mapping table header: future-v1/);
		expect(errorsFor(withBlock({ ...provenance.import_set, scheme: undefined }))).toMatch(/Invalid import set scheme at mapping table header: missing/);
		expect(errorsFor(withBlock({ ...provenance.import_set, derivation: 'future-v1' }))).toMatch(/Invalid identity derivation at mapping table header/);
		expect(errorsFor(withBlock({ ...provenance.import_set, mapping_form: 'sheet' }))).toMatch(/Invalid mapping form at mapping table header: sheet/);
		const encoded = serializeMappingTable(tableHeader, [first]);
		const notObject = encoded.replace(/^# crosswalker_provenance: .*$/m, `# crosswalker_provenance: ${JSON.stringify('[1]')}`);
		expect(parseMappingTable(notObject).errors.join(' ')).toMatch(/Invalid mapping table header crosswalker_provenance on line/);
	});

	it('accepts a header with no import_set line when the provenance block is pinned to table form', () => {
		const { import_set: _unused, ...noLine } = tableHeader;
		const parsed = parseMappingTable(serializeMappingTable(noLine, [first]));
		expect(parsed.errors).toEqual([]);
		expect(parsed.header.import_set).toBeUndefined();
	});

	it('gives occurrence duplicates distinct ids that survive reordering', () => {
		const base = { subject_id: 'demo-a:X-5', predicate_id: 'is_equivalent_to', object_id: 'demo-b:Y-5' };
		const facts: MappingTableRowFacts[] = [
			{ ...base, mapping_set_id: 'demo-one' },
			{ ...base, mapping_set_id: 'demo-two' },
			{ ...base, mapping_set_id: 'demo-map', mapping_justification: 'Manual A' },
			{ ...base, mapping_set_id: 'demo-map', mapping_justification: 'Manual B' },
			{ ...base, mapping_set_id: 'demo-same' },
			{ ...base, mapping_set_id: 'demo-same' },
			{ subject_id: 'demo-a:X-6', predicate_id: 'intersects_with', object_id: 'demo-b:Y-6' },
		];
		const assigned = assignMappingRowIds(facts);
		const ids = assigned.map((row) => row.row_id);
		expect(new Set(ids).size).toBe(facts.length);
		// Distinct base facts need no suffix; shared bases are numbered 01..N.
		expect(ids[0]).toBe(mappingRowId(facts[0] as typeof base, 0));
		expect(ids[1]).toBe(mappingRowId(facts[1] as typeof base, 0));
		expect(ids[6]).toMatch(/^m-[0-9a-f]{16}$/);
		const shared = mappingRowId({ ...base, mapping_set_id: 'demo-map' }, 0);
		expect([ids[2], ids[3]].sort()).toEqual([`${shared}-01`, `${shared}-02`]);
		const identical = mappingRowId({ ...base, mapping_set_id: 'demo-same' }, 0);
		expect([ids[4], ids[5]].sort()).toEqual([`${identical}-01`, `${identical}-02`]);

		const byContent = (rows: MappingTableRow[]) => rows
			.map((row) => `${JSON.stringify({ ...row, row_id: undefined })}=>${row.row_id}`).sort();
		for (const order of [[...facts].reverse(), [facts[3], facts[5], facts[0], facts[6], facts[2], facts[4], facts[1]]]) {
			expect(byContent(assignMappingRowIds(order))).toEqual(byContent(assigned));
		}

		// The serializer no longer refuses them, and the parser keeps every row.
		const parsed = parseMappingTable(serializeMappingTable(tableHeader, assigned));
		expect(parsed.errors).toEqual([]);
		expect(parsed.rows).toHaveLength(facts.length);
	});

	it('keeps every occurrence id when review, note, wikilink or extra fields change on one occurrence', () => {
		const base = { subject_id: 'demo-a:X-8', predicate_id: 'is_equivalent_to', object_id: 'demo-b:Y-8', mapping_set_id: 'demo-map' };
		const j1: MappingTableRowFacts = { ...base, mapping_justification: 'J1' };
		const j2: MappingTableRowFacts = { ...base, mapping_justification: 'J2' };
		const before = assignMappingRowIds([j1, j2]).map((row) => row.row_id);
		for (const edit of [
			{ reviewer: 'demo-reviewer' }, { review_status: 'approved' },
			{ notes: { my_notes: 'Demo note' } }, { extra: { owner_field: 'demo' } },
			{ subject_note: '[[Moved/X-8]]', object_note: '[[Moved/Y-8]]' },
		]) {
			expect(assignMappingRowIds([{ ...j1, ...edit }, j2]).map((row) => row.row_id)).toEqual(before);
			expect(assignMappingRowIds([j1, { ...j2, ...edit }]).map((row) => row.row_id)).toEqual(before);
		}
	});

	it('recomputes ids and ignores a row_id already on an input row', () => {
		const stale = { ...second, row_id: 'm-stale' } as MappingTableRowFacts;
		expect(assignMappingRowIds([stale])[0].row_id).toBe(second.row_id);
	});

	it('normalizes mapping_set_id like the importer: trimmed, with the header set id as fallback', () => {
		const base = { subject_id: 'demo-a:X-9', predicate_id: 'intersects_with', object_id: 'demo-b:Y-9' };
		const spelled = assignMappingRowIds([{ ...base, mapping_set_id: 'demo-map', mapping_justification: 'J1' }, { ...base, mapping_justification: 'J2' }], 'demo-map');
		const shared = mappingRowId({ ...base, mapping_set_id: 'demo-map' }, 0);
		expect(spelled.map((row) => row.row_id).sort()).toEqual([`${shared}-01`, `${shared}-02`]);
		expect(assignMappingRowIds([{ ...base, mapping_set_id: ' demo-map ' }])[0].row_id).toBe(shared);
	});

	it('trims the provenance id before comparing it and before deriving the curie', () => {
		const padded = withBlock({ ...provenance.import_set, id: ' iset-demo12 ', scheme: 'set-qualified-v1' }, { import_set: ' iset-demo12 ' });
		const parsed = parseMappingTable(serializeMappingTable(padded, [second]));
		expect(parsed.errors).toEqual([]);
		expect(tableRowToEdgeFrontmatter(parsed.rows[0], parsed.header).curie)
			.toBe(`${SSSOM_CURIE_PREFIX}:${sssomEdgeCurie(second, { id: 'iset-demo12', scheme: 'set-qualified-v1', derivation: 'declared-facts-v1' })}`);
	});

	it('refuses to read a vault table that carries no provenance header', async () => {
		const app = {
			vault: {
				getFiles: () => [{ path: 'Maps/bare.mapping-table.tsv' }],
				read: async () => serializeMappingTable(header, [first, second]),
			},
		} as unknown as App;
		const [bare] = await readMappingTables(app);
		expect(bare.rows).toEqual([]);
		expect(bare.provenance).toBe('absent');
		expect(bare.errors.join(' ')).toMatch(/Mapping table Maps\/bare\.mapping-table\.tsv has no Crosswalker provenance header/);
		expect(tableRowsAsEdgeRecords(bare)).toEqual([]);
	});

	it('derives the edge curie from the pinned import set and keeps a curie that differs', () => {
		const base = {
			title: 'demo-a:X-7 -> demo-b:Y-7', tags: header.tags,
			subject_id: 'demo-a:X-7', predicate_id: 'intersects_with', object_id: 'demo-b:Y-7',
			mapping_set_id: 'demo-map', source_framework: 'demo-a', target_framework: 'demo-b',
		};
		const derived = `${SSSOM_CURIE_PREFIX}:${sssomEdgeCurie(base, { id: 'iset-demo12', scheme: 'endpoint-v1', derivation: 'declared-facts-v1' })}`;
		const kept = { ...base, curie: derived };
		const keptRow = edgeFrontmatterToTableRow(kept, tableHeader).row!;
		expect(keptRow.extra).not.toHaveProperty('curie');
		const custom = { ...base, curie: 'sssom:demo-custom-1' };
		const customRow = edgeFrontmatterToTableRow(custom, tableHeader).row!;
		expect(customRow.extra).toMatchObject({ curie: 'sssom:demo-custom-1' });

		const parsed = parseMappingTable(serializeMappingTable(tableHeader, assignMappingRowIds([keptRow])));
		expect(tableRowToEdgeFrontmatter(parsed.rows[0], parsed.header)).toEqual(kept);
		const parsedCustom = parseMappingTable(serializeMappingTable(tableHeader, assignMappingRowIds([customRow])));
		expect(tableRowToEdgeFrontmatter(parsedCustom.rows[0], parsedCustom.header)).toEqual(custom);

		// A set-qualified set derives a set-qualified curie.
		const qualified = withBlock({ ...provenance.import_set, scheme: 'set-qualified-v1' });
		expect(tableRowToEdgeFrontmatter({ ...keptRow, row_id: 'm-demo' }, qualified).curie)
			.toBe(`${SSSOM_CURIE_PREFIX}:${sssomEdgeCurie(base, { id: 'iset-demo12', scheme: 'set-qualified-v1', derivation: 'declared-facts-v1' })}`);
		// Without a header pin nothing is derived, so a curie is kept rather than dropped.
		expect(edgeFrontmatterToTableRow(kept).row!.extra).toMatchObject({ curie: derived });
	});

	it('recognises the prefixed curie a real edge note stores as derived, and re-emits exactly it', () => {
		// The shape the notes path stamps: the set's edge prefix, a colon, then the
		// `sssomEdgeCurie` local part. Before the codec composed the prefix, this
		// curie was kept in `extra` and a table row re-emitted it unprefixed.
		const note = {
			title: 'demo-a:X-7 -> demo-b:Y-7', tags: header.tags,
			subject_id: 'demo-a:X-7', predicate_id: 'intersects_with', object_id: 'demo-b:Y-7',
			mapping_set_id: 'demo-map', source_framework: 'demo-a', target_framework: 'demo-b',
			curie: 'sssom:cw-demo-a-X-7--2e36104844-demo-b-Y-7--22e146e34d',
		};
		const row = edgeFrontmatterToTableRow(note, tableHeader).row!;
		expect(row.extra).not.toHaveProperty('curie');
		const [parsedRow] = parseMappingTable(serializeMappingTable(tableHeader, assignMappingRowIds([row]))).rows;
		expect(tableRowToEdgeFrontmatter(parsedRow, tableHeader).curie).toBe(note.curie);

		// A set pinned to another ontology space composes its own prefix the same way.
		const legacy = withBlock({ ...provenance.import_set, ontology: 'xwalk' });
		const legacyNote = { ...note, curie: 'xwalk:cw-demo-a-X-7--2e36104844-demo-b-Y-7--22e146e34d' };
		expect(edgeFrontmatterToTableRow(legacyNote, legacy).row!.extra).not.toHaveProperty('curie');
		expect(tableRowToEdgeFrontmatter(parsedRow, legacy).curie).toBe(legacyNote.curie);
		// The bare local part is no longer the derived value, so it is kept as a user field.
		const bare = { ...note, curie: 'cw-demo-a-X-7--2e36104844-demo-b-Y-7--22e146e34d' };
		expect(edgeFrontmatterToTableRow(bare, tableHeader).row!.extra).toMatchObject({ curie: bare.curie });
	});

	it('reads tables by suffix, reports a malformed one without throwing, and adapts rows to edge records', async () => {
		const good = serializeMappingTable(tableHeader, [first, second]);
		const contents: Record<string, string | Error> = {
			'Maps/mappings.mapping-table.tsv': good,
			'Maps/broken.mapping-table.tsv': good.replace(MAPPING_TABLE_FORMAT, 'other-format'),
			'Maps/other.tsv': 'subject_id\tpredicate_id\tobject_id\ndemo-a:X-1\tskos:exactMatch\tdemo-b:Y-1\n',
			'Maps/unreadable.mapping-table.tsv': new Error('locked'),
			'Elsewhere/mappings.mapping-table.tsv': good,
			'Maps/note.md': '# not a table',
		};
		const files = Object.keys(contents).map((path) => ({ path }));
		const app = {
			vault: {
				getFiles: () => files,
				read: async (file: { path: string }) => {
					const value = contents[file.path];
					if (value instanceof Error) throw value;
					return value;
				},
			},
		} as unknown as App;

		const tables = await readMappingTables(app, 'Maps');
		expect(tables.map((table) => table.path)).toEqual([
			'Maps/broken.mapping-table.tsv', 'Maps/mappings.mapping-table.tsv', 'Maps/unreadable.mapping-table.tsv',
		]);
		const [broken, ok, unreadable] = tables;
		expect(broken.rows).toEqual([]);
		expect(broken.errors.join(' ')).toContain('not a Crosswalker mapping table');
		expect(unreadable.rows).toEqual([]);
		expect(unreadable.errors.join(' ')).toMatch(/Could not read mapping table Maps\/unreadable\.mapping-table\.tsv\. Check/);
		expect(unreadable.errors.join(' ')).not.toContain('locked');
		expect(unreadable).toMatchObject({ readable: false, provenance: 'invalid' });
		expect(ok).toMatchObject({ readable: true, provenance: 'valid', rowErrors: [] });
		expect(ok.errors).toEqual([]);
		expect(ok.header).toEqual(tableHeader);
		expect((await readMappingTables(app)).map((table) => table.path)).toContain('Elsewhere/mappings.mapping-table.tsv');

		const records = tableRowsAsEdgeRecords(ok);
		expect(records.map((record) => record.source_path).sort())
			.toEqual([first, second].map((row) => `Maps/mappings.mapping-table.tsv#${row.row_id}`).sort());
		const record = records.find((entry) => entry.source_path.endsWith(`#${second.row_id}`))!;
		expect(record.frontmatter).toEqual({
			...tableRowToEdgeFrontmatter(second, tableHeader),
			_crosswalker: provenance,
		});
		expect(record.frontmatter.curie).toBe(`${SSSOM_CURIE_PREFIX}:${sssomEdgeCurie(second, { id: 'iset-demo12', scheme: 'endpoint-v1', derivation: 'declared-facts-v1' })}`);
		expect(tableRowsAsEdgeRecords(broken)).toEqual([]);
	});
});
