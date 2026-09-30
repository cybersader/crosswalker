/**
 * Slice 2 Part B of the mapping table form (2026-09-30): every consumer reads a
 * table-form set through `tableRowsAsEdgeRecords`, never through a rebuilt copy.
 *
 * Synthetic data only: `demo-a:` / `demo-b:` ids, `iset-demo12`.
 */
import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import { applyMigrations } from '../src/tier2/migrations';
import { projectFromTier1 } from '../src/tier2/projector';
import {
	MAPPING_TABLE_FORMAT, assignMappingRowIds, parseMappingTable, serializeMappingTable,
	type MappingTableHeader, type MappingTableRowFacts,
} from '../src/mappings/mapping-table';
import { readMappingTables, tableRowsAsEdgeRecords } from '../src/mappings/mapping-table-reader';
import { readVaultTree } from '../src/export/vault-reader';
import { crosswalkEdgesToSssomTsv, exportFolderAsSssomTsv } from '../src/export/sssom-exporter';
import { crosswalkEdgesToStrmTsv, exportFolderAsStrmTsv } from '../src/export/strm-tsv-exporter';
import { LINEAGE_NOT_REPRESENTABLE_REASON } from '../src/tier2/predicate-characteristics';
import { discoverImportSets, resolveImportSet, ImportSetProvenanceError } from '../src/generation/import-set';
import { buildProvenance } from '../src/generation/provenance';
import { sssomEdgeCurie } from '../src/generation/crosswalk-identity';
import { initValidator, validateTier1Frontmatter } from '../src/validation/validator';
import { buildIdentityIndex } from '../src/generation/identity-index';
import { resolveEdgeEndpoints } from '../src/generation/edge-endpoints';
import { generateFromRecipe } from '../src/generation/generation-engine';
import type { Recipe } from '../src/render';
import { TFolder } from 'obsidian';

const { DatabaseSync } = require('node:sqlite');

const TABLE_PATH = 'Maps/mappings.mapping-table.tsv';

const provenance = {
	spec_version: 'https://crosswalker.dev/spec/tier1.schema.json',
	source_ref: { file: 'demo-a-to-demo-b.sssom.tsv' },
	produced_at: '2026-09-30T00:00:00.000Z',
	producer: { kind: 'plugin-engine', name: 'crosswalker-plugin', version: '0.0.0-test' },
	import_set: {
		id: 'iset-demo12', scheme: 'endpoint-v1', parent_set: 'iset-demo34',
		derivation: 'declared-facts-v1', destination: 'Maps', mapping_form: 'table',
	},
};

const header: MappingTableHeader = {
	crosswalker_format: MAPPING_TABLE_FORMAT,
	import_set: 'iset-demo12',
	mapping_set_id: 'demo-map',
	mapping_provider: 'Demo provider',
	source_framework: 'demo-a',
	target_framework: 'demo-b',
	tags: ['crosswalk/demo-a-to-demo-b'],
	crosswalker_provenance: provenance,
};

const facts: MappingTableRowFacts[] = [
	{
		subject_id: 'demo-a:X-1', predicate_id: 'is_equivalent_to', object_id: 'demo-b:Y-1',
		sssom_predicate: 'skos:exactMatch', mapping_justification: 'semapv:ManualMappingCuration',
		confidence: '0.9', subject_label: 'Demo one', object_label: 'Demo target one',
		mapping_provider: 'Demo provider', mapping_set_id: 'demo-map',
	},
	{
		subject_id: 'demo-a:X-2', predicate_id: 'intersects_with', object_id: 'demo-b:Y-2',
		sssom_predicate: 'skos:relatedMatch', mapping_provider: 'Demo provider', mapping_set_id: 'demo-map',
	},
	{
		subject_id: 'demo-a:X-3', predicate_id: 'is_equivalent_to', object_id: 'demo-b:Y-3',
		predicate_modifier: 'NOT', sssom_predicate: 'skos:exactMatch',
		mapping_provider: 'Demo provider', mapping_set_id: 'demo-map',
	},
];

function tableText(rows: MappingTableRowFacts[] = facts, head: MappingTableHeader = header): string {
	return serializeMappingTable(head, assignMappingRowIds(rows, head.mapping_set_id));
}

interface VaultSpec {
	/** Markdown notes: path to frontmatter. */
	notes?: Record<string, Record<string, unknown>>;
	/** Non-markdown files: path to content, or an Error to throw on read. */
	files?: Record<string, string | Error>;
}

/** A vault double with both listings: markdown via the cache, other files via read. */
function vaultApp(spec: VaultSpec): App {
	const notes = spec.notes ?? {};
	const files = spec.files ?? {};
	const mdFiles = Object.keys(notes).map((path) => Object.assign(new TFile(path), { stat: { mtime: 0 } }));
	const otherFiles = Object.keys(files).map((path) => new TFile(path));
	const read = async (file: { path: string }) => {
		const value = files[file.path];
		if (value instanceof Error) throw value;
		if (value === undefined) throw new Error('missing');
		return value;
	};
	return {
		vault: {
			getMarkdownFiles: () => mdFiles,
			getFiles: () => [...mdFiles, ...otherFiles],
			read,
			cachedRead: read,
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => (notes[file.path] ? { frontmatter: notes[file.path] } : null),
		},
	} as unknown as App;
}

// ---------------------------------------------------------------------------
// B1. Tier 2 projector
// ---------------------------------------------------------------------------

interface TestDb {
	exec(input: string | { sql: string; bind?: Record<string, unknown>; rowMode?: 'array'; returnValue?: 'resultRows' }): unknown[][] | void;
	close(): void;
}

function createTestDb(): TestDb {
	const sqlite = new DatabaseSync(':memory:');
	return {
		exec(input) {
			if (typeof input === 'string') {
				sqlite.exec(input);
				return;
			}
			const statement = sqlite.prepare(input.sql);
			if (input.rowMode === 'array') statement.setReturnArrays(true);
			const bind = input.bind ?? {};
			if (input.returnValue === 'resultRows') {
				return Object.keys(bind).length > 0 ? statement.all(bind) : statement.all();
			}
			if (Object.keys(bind).length > 0) statement.run(bind);
			else statement.run();
		},
		close() {
			sqlite.close();
		},
	};
}

function mappingRows(db: TestDb): unknown[][] {
	return db.exec({
		sql: 'SELECT source_path, import_set_id, subject_id, predicate_modifier FROM mappings ORDER BY source_path',
		rowMode: 'array',
		returnValue: 'resultRows',
	}) as unknown[][];
}

describe('slice 2 B1: Tier 2 projector reads mapping tables', () => {
	let db: TestDb;
	beforeEach(() => {
		db = createTestDb();
		applyMigrations(db);
	});
	afterEach(() => db.close());

	it('upserts every table row at <table path>#<row_id>, counts it, and prunes it once the file is gone', async () => {
		const ids = assignMappingRowIds(facts, header.mapping_set_id).map((row) => row.row_id);
		const first = await projectFromTier1(vaultApp({ files: { [TABLE_PATH]: tableText() } }), db, { projectionMode: 'full' });
		expect(first.success).toBe(true);
		expect(first.counts.mappings).toBe(3);
		expect(first.counts.mapping_tables).toBe(1);
		const rows = mappingRows(db);
		expect(rows.map((row) => row[0])).toEqual(ids.map((id) => `${TABLE_PATH}#${id}`).sort());
		expect(rows.every((row) => row[1] === 'iset-demo12')).toBe(true);
		expect(rows.find((row) => row[2] === 'demo-a:X-3')![3]).toBe('NOT');

		// Rerun on the same file: rows are kept (seen), not duplicated.
		const again = await projectFromTier1(vaultApp({ files: { [TABLE_PATH]: tableText() } }), db, { projectionMode: 'full' });
		expect(again.success).toBe(true);
		expect(mappingRows(db)).toHaveLength(3);

		// A row dropped from the file is pruned; so is every row of a deleted table.
		await projectFromTier1(vaultApp({ files: { [TABLE_PATH]: tableText(facts.slice(0, 2)) } }), db, { projectionMode: 'full' });
		expect(mappingRows(db)).toHaveLength(2);
		const gone = await projectFromTier1(vaultApp({}), db, { projectionMode: 'full' });
		expect(gone.success).toBe(true);
		expect(mappingRows(db)).toEqual([]);
	});

	it('an unreadable table reports its errors under its path and refuses the prune', async () => {
		await projectFromTier1(vaultApp({ files: { [TABLE_PATH]: tableText() } }), db, { projectionMode: 'full' });
		expect(mappingRows(db)).toHaveLength(3);

		const broken = await projectFromTier1(vaultApp({ files: { [TABLE_PATH]: new Error('locked') } }), db, { projectionMode: 'full' });
		expect(broken.success).toBe(false);
		expect(broken.counts.mapping_tables).toBe(1);
		expect(broken.errors.length).toBeGreaterThan(0);
		expect(broken.errors.every((error) => error.vault_path === TABLE_PATH)).toBe(true);
		// Nothing was deleted on a run that could not read the table.
		expect(mappingRows(db)).toHaveLength(3);

		const malformed = await projectFromTier1(
			vaultApp({ files: { [TABLE_PATH]: tableText().replace(MAPPING_TABLE_FORMAT, 'other-format') } }),
			db,
			{ projectionMode: 'full' },
		);
		expect(malformed.success).toBe(false);
		expect(malformed.errors.map((error) => error.vault_path)).toContain(TABLE_PATH);
		expect(mappingRows(db)).toHaveLength(3);
	});

	it('honours pathFilter for tables', async () => {
		const result = await projectFromTier1(
			vaultApp({ files: { [TABLE_PATH]: tableText() } }),
			db,
			{ pathFilter: (path) => path.startsWith('Elsewhere/') },
		);
		expect(result.counts.mapping_tables).toBe(0);
		expect(mappingRows(db)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// B2. Round-trip vault reader + exporters
// ---------------------------------------------------------------------------

/**
 * The same rows as a notes-form set: each note's frontmatter is exactly what
 * the adapter gives a table row, plus the edge `kind` a note carries. Named by
 * row id so the path sort matches the table's `#row_id` sort.
 */
function asNotes(text: string, naming: 'row-id' | 'curie' = 'row-id'): Record<string, Record<string, unknown>> {
	const parsed = parseMappingTable(text);
	expect(parsed.errors).toEqual([]);
	expect(parsed.rowErrors).toEqual([]);
	const notes: Record<string, Record<string, unknown>> = {};
	for (const record of tableRowsAsEdgeRecords({ path: TABLE_PATH, ...parsed, readable: true })) {
		const rowId = record.source_path.slice(record.source_path.indexOf('#') + 1);
		// The name a real notes-form import gives the edge note: the curie local
		// part `sssomEdgeCurie` mints from the set's pinned identity rules.
		const name = naming === 'row-id' ? rowId : sssomEdgeCurie(record.frontmatter, provenance.import_set);
		notes[`Maps/${name}.md`] = { kind: 'crosswalk-edge', ...record.frontmatter };
	}
	return notes;
}

/**
 * An exported TSV split into its metadata header (the `#` lines plus the column
 * row) and its data rows sorted by the given key columns, then by the whole row
 * text as the row identity. Order-independent comparison across storage forms.
 */
function sortedExport(tsv: string, keyColumns: string[]): { head: string[]; rows: string[] } {
	const lines = tsv.split('\n').filter((line) => line !== '');
	const metadata = lines.filter((line) => line.startsWith('#'));
	const [columnLine, ...data] = lines.filter((line) => !line.startsWith('#'));
	const columns = columnLine.split('\t');
	const keys = keyColumns.map((column) => columns.indexOf(column));
	expect(keys.every((index) => index >= 0)).toBe(true);
	const keyOf = (line: string): string[] => {
		const cells = line.split('\t');
		return [...keys.map((index) => cells[index]), line];
	};
	const rows = [...data].sort((a, b) => {
		const ka = keyOf(a);
		const kb = keyOf(b);
		for (let i = 0; i < ka.length; i++) {
			const order = ka[i].localeCompare(kb[i]);
			if (order !== 0) return order;
		}
		return 0;
	});
	return { head: [...metadata, columnLine], rows };
}

describe('slice 2 B2: vault reader and exporters read a table-form set', () => {
	it('a table-only set exports byte-identically to the same rows as notes (SSSOM and STRM)', async () => {
		const text = tableText();
		const tableApp = vaultApp({ files: { [TABLE_PATH]: text } });
		const notesApp = vaultApp({ notes: asNotes(text) });

		const tree = await readVaultTree(tableApp, 'Maps');
		expect(tree.skipped).toEqual([]);
		expect(tree.crosswalkEdges).toHaveLength(3);
		expect(tree.crosswalkEdges.every((edge) => edge.path.startsWith(`${TABLE_PATH}#`))).toBe(true);

		const tableSssom = await exportFolderAsSssomTsv(tableApp, 'Maps');
		const notesSssom = await exportFolderAsSssomTsv(notesApp, 'Maps');
		expect(tableSssom.rowCount).toBe(3);
		expect(tableSssom.tsv).toBe(notesSssom.tsv);

		const tableStrm = await exportFolderAsStrmTsv(tableApp, 'Maps');
		const notesStrm = await exportFolderAsStrmTsv(notesApp, 'Maps');
		// The negated row is refused by STRM in both forms.
		expect(tableStrm.rowCount).toBe(2);
		expect(tableStrm.tsv).toBe(notesStrm.tsv);
	});

	// Byte-equality across the two storage forms holds only when the note paths
	// sort in the same order as the table's `#row_id` addresses (the test above
	// names notes by row id to arrange that). Real notes are named by curie, so
	// row order can differ; what must match is the metadata header and the set of
	// data rows. Slice 4's conversion proof compares sorted rows the same way.
	it('with curie-named notes, the metadata header and sorted data rows match (SSSOM and STRM)', async () => {
		const text = tableText();
		const tableApp = vaultApp({ files: { [TABLE_PATH]: text } });
		const notes = asNotes(text, 'curie');
		expect(Object.keys(notes)).toHaveLength(3);
		const notesApp = vaultApp({ notes });

		const sssomKeys = ['subject_id', 'predicate_id', 'object_id'];
		const tableSssom = await exportFolderAsSssomTsv(tableApp, 'Maps');
		const notesSssom = await exportFolderAsSssomTsv(notesApp, 'Maps');
		expect(notesSssom.rowCount).toBe(3);
		expect(sortedExport(tableSssom.tsv, sssomKeys)).toEqual(sortedExport(notesSssom.tsv, sssomKeys));

		const strmKeys = ['Focal Document Element', 'Relationship', 'Reference Document Element'];
		const tableStrm = await exportFolderAsStrmTsv(tableApp, 'Maps');
		const notesStrm = await exportFolderAsStrmTsv(notesApp, 'Maps');
		expect(notesStrm.rowCount).toBe(2);
		expect(sortedExport(tableStrm.tsv, strmKeys)).toEqual(sortedExport(notesStrm.tsv, strmKeys));
	});

	it('skips a table with one bad row whole, naming the row error', async () => {
		const [, second, third] = assignMappingRowIds(facts, header.mapping_set_id);
		const bad = tableText().replace(third.row_id, second.row_id);
		const tree = await readVaultTree(vaultApp({ files: { [TABLE_PATH]: bad } }), 'Maps');
		expect(tree.crosswalkEdges).toEqual([]);
		expect(tree.skipped).toHaveLength(1);
		expect(tree.skipped[0].reason).toMatch(/Duplicate mapping table row_id/);
	});

	it('passes lineage rows through so the exporters refuse them as before', async () => {
		const lineage: MappingTableRowFacts = {
			subject_id: 'demo-a:X-9', predicate_id: 'superseded_by', object_id: 'demo-a:X-10',
			mapping_set_id: 'demo-map',
		};
		const tree = await readVaultTree(vaultApp({ files: { [TABLE_PATH]: tableText([...facts, lineage]) } }), '');
		const lineageEdge = tree.crosswalkEdges.find((edge) => edge.predicate_id === 'superseded_by');
		expect(lineageEdge).toBeDefined();
		const sssom = crosswalkEdgesToSssomTsv(tree.crosswalkEdges);
		expect(sssom.skipped).toEqual([{ path: lineageEdge!.path, reason: LINEAGE_NOT_REPRESENTABLE_REASON }]);
		expect(sssom.tsv).not.toContain('demo-a:X-9');
		const strm = crosswalkEdgesToStrmTsv(tree.crosswalkEdges);
		expect(strm.skipped).toContainEqual({ path: lineageEdge!.path, reason: LINEAGE_NOT_REPRESENTABLE_REASON });
	});

	it('skips an unreadable table whole, naming its errors', async () => {
		const tree = await readVaultTree(vaultApp({ files: { [TABLE_PATH]: new Error('locked') } }), 'Maps');
		expect(tree.crosswalkEdges).toEqual([]);
		expect(tree.skipped).toHaveLength(1);
		expect(tree.skipped[0].path).toBe(TABLE_PATH);
		expect(tree.skipped[0].reason).toContain('Could not read mapping table');
	});

	it('scopes tables to the export root', async () => {
		const tree = await readVaultTree(vaultApp({ files: { [TABLE_PATH]: tableText() } }), 'Elsewhere');
		expect(tree.crosswalkEdges).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// B3. Import-set discovery
// ---------------------------------------------------------------------------

describe('slice 2 B3: import-set discovery sees table-form sets', () => {
	it('discovers a table set with mapping_form table, its row count, and no notes', async () => {
		const sets = await discoverImportSets(vaultApp({ files: { [TABLE_PATH]: tableText() } }), 'Maps');
		expect(sets).toHaveLength(1);
		expect(sets[0]).toMatchObject({
			id: 'iset-demo12',
			scheme: 'endpoint-v1',
			mapping_form: 'table',
			rowCount: 3,
			noteCount: 0,
			paths: [TABLE_PATH],
			root: 'Maps',
			parentSets: ['iset-demo34'],
			derivation: 'declared-facts-v1',
		});
	});

	it('a known owner with one bad row is still discovered, counting the surviving rows', async () => {
		const [first, second, third] = assignMappingRowIds(facts, header.mapping_set_id);
		// A duplicate row_id and a malformed JSON cell are row errors, not structural ones.
		const text = serializeMappingTable(header, [first, second, third])
			.replace(third.row_id, second.row_id);
		const [table] = await readMappingTables(vaultApp({ files: { [TABLE_PATH]: text } }), 'Maps');
		expect(table.errors).toEqual([]);
		expect(table.rowErrors.join(' ')).toMatch(/Duplicate mapping table row_id/);
		expect(table.provenance).toBe('valid');
		expect(table.readable).toBe(true);
		const sets = await discoverImportSets(vaultApp({ files: { [TABLE_PATH]: text } }), 'Maps');
		expect(sets).toHaveLength(1);
		expect(sets[0]).toMatchObject({ id: 'iset-demo12', mapping_form: 'table', rowCount: 2, paths: [TABLE_PATH] });
	});

	it('a notes set reports mapping_form notes and zero table rows', async () => {
		const sets = await discoverImportSets(vaultApp({ notes: {
			'Notes/Edge.md': { kind: 'crosswalk-edge', curie: 'demo:e', _crosswalker: { import_set: { id: 'iset-notes1', scheme: 'endpoint-v1' } } },
		} }), 'Notes');
		expect(sets[0]).toMatchObject({ id: 'iset-notes1', mapping_form: 'notes', rowCount: 0, noteCount: 1 });
	});

	it('refuses a set recorded both as notes and as a table', async () => {
		const app = vaultApp({
			files: { [TABLE_PATH]: tableText() },
			notes: { 'Maps/Edge.md': { kind: 'crosswalk-edge', curie: 'demo:e', _crosswalker: { import_set: { id: 'iset-demo12', scheme: 'endpoint-v1', mapping_form: 'table' } } } },
		});
		const attempt = discoverImportSets(app, 'Maps');
		await expect(attempt).rejects.toBeInstanceOf(ImportSetProvenanceError);
		await expect(discoverImportSets(app, 'Maps')).rejects.toThrow(
			'Import set iset-demo12 is recorded as both notes and a table. Finish or roll back its conversion before refreshing.',
		);
	});

	it('refuses two tables for one set', async () => {
		const app = vaultApp({ files: { [TABLE_PATH]: tableText(), 'Maps/copy.mapping-table.tsv': tableText() } });
		await expect(discoverImportSets(app, 'Maps')).rejects.toThrow('recorded in 2 mapping tables');
	});

	it('a refresh keeps the table pin', async () => {
		const reference = await resolveImportSet(vaultApp({ files: { [TABLE_PATH]: tableText() } }), 'Maps', { id: 'iset-demo12', scheme: 'endpoint-v1' });
		expect(reference).toMatchObject({ id: 'iset-demo12', scheme: 'endpoint-v1', mapping_form: 'table', parent_set: 'iset-demo34' });
	});

	it('a notes-set refresh does not newly stamp mapping_form', async () => {
		const app = vaultApp({ notes: {
			'Notes/Edge.md': { kind: 'crosswalk-edge', curie: 'demo:e', _crosswalker: { import_set: { id: 'iset-notes1', scheme: 'endpoint-v1' } } },
		} });
		const reference = await resolveImportSet(app, 'Notes', { id: 'iset-notes1' });
		expect(reference.mapping_form).toBeUndefined();
	});

	it('fails closed on a table that claims an owner but will not read, and skips an unowned one', async () => {
		const broken = tableText().replace(MAPPING_TABLE_FORMAT, 'other-format');
		await expect(discoverImportSets(vaultApp({ files: { [TABLE_PATH]: broken } }), 'Maps')).rejects.toThrow(`Mapping table ${TABLE_PATH} has no readable rows`);
		const locked = discoverImportSets(vaultApp({ files: { [TABLE_PATH]: new Error('locked') } }), 'Maps');
		await expect(locked).rejects.toBeInstanceOf(ImportSetProvenanceError);
		await expect(discoverImportSets(vaultApp({ files: { [TABLE_PATH]: new Error('locked') } }), 'Maps')).rejects.toThrow(`Mapping table ${TABLE_PATH} could not be read`);

		// An unparseable provenance line and a provenance block that fails
		// validation both refuse by name.
		const unparseable = tableText().replace(/^# crosswalker_provenance: .*$/m, '# crosswalker_provenance: "{not json"');
		await expect(discoverImportSets(vaultApp({ files: { [TABLE_PATH]: unparseable } }), 'Maps')).rejects.toThrow(`Mapping table ${TABLE_PATH} has an unusable provenance header`);
		const notesPinned = tableText(facts, { ...header, crosswalker_provenance: { ...provenance, import_set: { ...provenance.import_set, mapping_form: 'notes' } } });
		await expect(discoverImportSets(vaultApp({ files: { [TABLE_PATH]: notesPinned } }), 'Maps')).rejects.toThrow(`Mapping table ${TABLE_PATH} has an unusable provenance header`);

		const { crosswalker_provenance: _omit, ...unowned } = header;
		const sets = await discoverImportSets(vaultApp({ files: { [TABLE_PATH]: tableText(facts, unowned) } }), 'Maps');
		expect(sets).toEqual([]);

		// An explicit refresh of a different set is not blocked by a broken table of this one.
		const other = await resolveImportSet(vaultApp({ files: { [TABLE_PATH]: broken } }), 'Maps', { id: 'iset-other1' });
		expect(other.id).toBe('iset-other1');
	});
});

// ---------------------------------------------------------------------------
// B4. Provenance writer + schema
// ---------------------------------------------------------------------------

describe('slice 2 B4: provenance stamps mapping_form and the schema accepts it', () => {
	beforeAll(() => initValidator());

	it('stamps mapping_form only when the reference carries it', () => {
		const table = buildProvenance({ sourceFile: 'demo.tsv', importSet: { id: 'iset-demo12', scheme: 'endpoint-v1', mapping_form: 'table' } }, '0.0.0-test');
		expect((table.import_set as Record<string, unknown>).mapping_form).toBe('table');
		const notes = buildProvenance({ sourceFile: 'demo.tsv', importSet: { id: 'iset-demo12', scheme: 'endpoint-v1' } }, '0.0.0-test');
		expect(notes.import_set).not.toHaveProperty('mapping_form');
	});

	it('the schema accepts notes and table and refuses any other form', () => {
		const edge = (form?: unknown) => ({
			curie: 'demo:e', kind: 'crosswalk-edge', subject_id: 'demo-a:X-1', predicate_id: 'is_equivalent_to', object_id: 'demo-b:Y-1',
			_crosswalker: { ...provenance, import_set: { id: 'iset-demo12', scheme: 'endpoint-v1', ...(form === undefined ? {} : { mapping_form: form }) } },
		});
		expect(validateTier1Frontmatter(edge()).valid).toBe(true);
		expect(validateTier1Frontmatter(edge('notes')).valid).toBe(true);
		expect(validateTier1Frontmatter(edge('table')).valid).toBe(true);
		expect(validateTier1Frontmatter(edge('sheet')).valid).toBe(false);
	});

	it('a table reference survives stamp, table read, and refresh', async () => {
		const stamped = buildProvenance(
			{ sourceFile: 'demo-a-to-demo-b.sssom.tsv', importSet: { id: 'iset-demo12', scheme: 'endpoint-v1', derivation: 'declared-facts-v1', destination: 'Maps', mapping_form: 'table' } },
			'0.0.0-test',
		);
		const text = tableText(facts, { ...header, crosswalker_provenance: stamped });
		const app = vaultApp({ files: { [TABLE_PATH]: text } });
		const [table] = await readMappingTables(app, 'Maps');
		expect(table.errors).toEqual([]);
		// The stamped block a table row carries validates as Tier 1 provenance,
		// including the derived edge curie: the sanitizers only emit characters
		// the Tier 1 curie pattern admits, so no substitution is needed.
		for (const record of tableRowsAsEdgeRecords(table)) {
			expect(record.frontmatter._crosswalker).toEqual(stamped);
			const result = validateTier1Frontmatter({ kind: 'crosswalk-edge', ...record.frontmatter });
			expect(result.errors ?? []).toEqual([]);
			expect(result.valid).toBe(true);
		}
		const reference = await resolveImportSet(app, 'Maps', { id: 'iset-demo12', scheme: 'endpoint-v1' });
		expect(reference).toMatchObject({ id: 'iset-demo12', mapping_form: 'table', derivation: 'declared-facts-v1', destination: 'Maps' });
		const restamped = buildProvenance({ sourceFile: 'demo.tsv', importSet: reference }, '0.0.0-test');
		expect((restamped.import_set as Record<string, unknown>).mapping_form).toBe('table');
	});
});

// ---------------------------------------------------------------------------
// Identity index and table sets (ruling 2026-09-30)
// ---------------------------------------------------------------------------

/**
 * Ruling: table rows are reconciled inside their file by `row_id`; the identity
 * index stays markdown-only; `discoverImportSets` is the existence authority for
 * both forms. These tests guard that the two populations never meet: a `#row_id`
 * claim in the index would reach `renameFile` during a notes refresh.
 */
describe('Identity index and table sets', () => {
	const FRAMEWORK_SET = 'iset-demo56';
	const FRAMEWORK_RECIPE: Recipe = {
		recipe: 'demo-a-import',
		source: { ontology: 'demo-a', levels: ['leaf'] },
		target: { layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }] },
	};

	/** A concept note of the notes-form framework set the table rows point at. */
	const concept = (id: string): Record<string, unknown> => ({
		curie: `demo-a:${id}`,
		_crosswalker: { recipe: { id: 'demo-a-import' }, import_set: { id: FRAMEWORK_SET, scheme: 'endpoint-v1' } },
	});
	const conceptNotes = (): Record<string, Record<string, unknown>> => ({
		'Frameworks/X-1.md': concept('X-1'),
		'Frameworks/X-2.md': concept('X-2'),
		'Frameworks/X-3.md': concept('X-3'),
	});

	it('buildIdentityIndex over a notes set and a table set claims only the notes', async () => {
		const app = vaultApp({ notes: conceptNotes(), files: { [TABLE_PATH]: tableText() } });
		const index = await buildIdentityIndex(app);
		expect(index.curies().sort()).toEqual(['demo-a:X-1', 'demo-a:X-2', 'demo-a:X-3']);
		expect(index.collisions).toEqual([]);
		for (const curie of index.curies()) {
			const path = index.get(curie)!.path;
			expect(path).not.toContain('#');
			expect(path.endsWith('.md')).toBe(true);
		}
		expect(index.provenanceAt(TABLE_PATH)).toBeNull();
		// No row of the table is claimable by its edge curie or its address.
		const parsed = parseMappingTable(tableText());
		for (const record of tableRowsAsEdgeRecords({ path: TABLE_PATH, ...parsed, readable: true })) {
			expect(typeof record.frontmatter.curie).toBe('string');
			expect(index.get(String(record.frontmatter.curie))).toBeNull();
			expect(index.provenanceAt(record.source_path)).toBeNull();
		}
	});

	it('a refresh of the notes-form framework set with the table set present reports zero orphans and leaves the table byte-identical', async () => {
		const table = tableText();
		const notes: Record<string, string> = {};
		const frontmatter = new Map<string, Record<string, unknown>>();
		for (const [path, fm] of Object.entries(conceptNotes())) {
			notes[path] = '---\n---\n';
			frontmatter.set(path, fm);
		}
		const files = new Map<string, string>([...Object.entries(notes), [TABLE_PATH, table]]);
		const folders = new Set<string>(['', 'Frameworks', 'Maps']);
		const renamed: string[] = [];
		const read = async (file: { path: string }) => {
			if (!files.has(file.path)) throw new Error('missing');
			return files.get(file.path)!;
		};
		const app = {
			vault: {
				getMarkdownFiles: () => [...files.keys()].filter((path) => path.endsWith('.md')).map((path) => new TFile(path)),
				getFiles: () => [...files.keys()].map((path) => new TFile(path)),
				getAbstractFileByPath: (path: string) => (files.has(path) ? new TFile(path) : folders.has(path) ? new TFolder(path) : null),
				create: async (path: string, content: string) => { files.set(path, content); return new TFile(path); },
				modify: async (file: { path: string }, content: string) => { files.set(file.path, content); },
				read,
				cachedRead: read,
				createFolder: async (path: string) => { folders.add(path); },
			},
			fileManager: {
				renameFile: async (file: TFile, newPath: string) => { renamed.push(`${file.path} -> ${newPath}`); },
			},
			metadataCache: {
				getFileCache: (file: { path: string }) => ({ frontmatter: frontmatter.get(file.path) ?? {} }),
			},
		} as unknown as App;

		// The table set is discoverable beside the framework set, each in its own form.
		const sets = await discoverImportSets(app);
		expect(sets.map((set) => [set.id, set.mapping_form]).sort()).toEqual([['iset-demo12', 'table'], [FRAMEWORK_SET, 'notes']]);

		const rows = ['X-1', 'X-2', 'X-3'].map((id) => ({ id }));
		const result = await generateFromRecipe(app, { columns: ['id'], rows, rowCount: rows.length }, FRAMEWORK_RECIPE, {
			basePath: 'Frameworks', importSet: { id: FRAMEWORK_SET }, overwriteMode: 'replace', createFolders: true,
		});
		expect(result.errors).toEqual([]);
		expect(result.success).toBe(true);
		expect(result.orphansChecked).toBe(true);
		expect(result.orphans ?? []).toEqual([]);
		expect(result.moved ?? []).toEqual([]);
		expect(renamed).toEqual([]);
		expect(files.get(TABLE_PATH)).toBe(table);
	});

	it('resolveEdgeEndpoints never resolves an endpoint to a table row', async () => {
		const table = tableText();
		const parsed = parseMappingTable(table);
		const records = tableRowsAsEdgeRecords({ path: TABLE_PATH, ...parsed, readable: true });

		// Table only: every endpoint is unresolved, even the ids the rows carry.
		const tableOnly = (await buildIdentityIndex(vaultApp({ files: { [TABLE_PATH]: table } })));
		for (const record of records) {
			const resolved = resolveEdgeEndpoints(tableOnly, record.frontmatter);
			expect(resolved.subject_note).toBe('');
			expect(resolved.object_note).toBe('');
			expect(resolved.unresolved.map((entry) => entry.cause)).toEqual(['not in vault', 'not in vault']);
			// A row's own edge curie is not an endpoint either.
			const edgeCurie = String(record.frontmatter.curie);
			expect(edgeCurie).toMatch(/^[a-z][a-z0-9_-]*:/);
			expect(resolveEdgeEndpoints(tableOnly, { subject_id: edgeCurie, object_id: edgeCurie }).subject_note).toBe('');
		}

		// With the concept notes present, subjects resolve to those notes, never to the table.
		const both = await buildIdentityIndex(vaultApp({ notes: conceptNotes(), files: { [TABLE_PATH]: table } }));
		for (const record of records) {
			const resolved = resolveEdgeEndpoints(both, record.frontmatter);
			expect(resolved.subject_note).toMatch(/^\[\[Frameworks\/X-\d\|X-\d\]\]$/);
			expect(resolved.subject_note).not.toContain('mapping-table');
			expect(resolved.subject_note).not.toContain('#');
			expect(resolved.object_note).toBe('');
		}
	});
});
