/**
 * Slice 3 Part A of the mapping table form (2026-09-30): the SSSOM importer's
 * table branch. A set minted with `mappingForm: 'table'` is written as one
 * `*.mapping-table.tsv`, a refresh keeps its review columns by row id, and a
 * refresh that would change a set's form is refused.
 *
 * Synthetic data only: `demo-a:` / `demo-b:` ids.
 */
import type { App } from 'obsidian';
import { TFile, TFolder, parseYaml } from 'obsidian';
import { importSssom, nonCurieEndpointRefusal } from '../src/import/sssom-importer';
import { parseMappingTable, serializeMappingTable } from '../src/mappings/mapping-table';
import { readMappingTables } from '../src/mappings/mapping-table-reader';
import { discoverImportSets, resolveImportSet } from '../src/generation/import-set';

const FOLDER = '_crosswalker/mappings/demo-a-to-demo-b';
const TABLE = `${FOLDER}/demo-a-to-demo-b.mapping-table.tsv`;

function sssom(rows: string[]): string {
	return [
		'# mapping_set_id: "https://example.test/demo-map"',
		'# subject_source: "demo-a"',
		'# object_source: "demo-b"',
		'# mapping_provider: "Demo provider"',
		'# mapping_date: "2026-09-30"',
		'# license: "https://example.test/license"',
		'subject_id\tsubject_label\tpredicate_id\tobject_id\tobject_label\tmapping_justification\tconfidence',
		...rows,
	].join('\n');
}

const ROW_1 = 'demo-a:X-1\tDemo one\tskos:exactMatch\tdemo-b:Y-1\tTarget one\tsemapv:ManualMappingCuration\t0.9';
const ROW_2 = 'demo-a:X-2\tDemo two\tskos:relatedMatch\tdemo-b:Y-2\tTarget two\tsemapv:ManualMappingCuration\t0.5';
const ROW_3 = 'demo-a:X-3\tDemo three\tskos:broadMatch\tdemo-b:Y-3\tTarget three\tsemapv:ManualMappingCuration\t0.7';
const ROW_4 = 'demo-a:X-4\tDemo four\tskos:narrowMatch\tdemo-b:Y-4\tTarget four\tsemapv:ManualMappingCuration\t0.8';

/** A vault double with real TFile/TFolder handles and both file listings. */
function makeVault(): { app: App; written: Map<string, string>; folders: Set<string> } {
	const written = new Map<string, string>();
	const folders = new Set<string>();
	const fileOf = (path: string) => Object.assign(new TFile(path), { stat: { mtime: 0 }, extension: path.split('.').pop() });
	const frontmatterOf = (path: string) => {
		const match = (written.get(path) ?? '').match(/^---\n([\s\S]*?)\n---/);
		return match ? parseYaml(match[1]) : undefined;
	};
	const read = async (file: { path: string }) => {
		if (!written.has(file.path)) throw new Error('missing');
		return written.get(file.path)!;
	};
	const app = {
		vault: {
			getMarkdownFiles: () => [...written.keys()].filter((path) => path.endsWith('.md')).map(fileOf),
			getFiles: () => [...written.keys()].map(fileOf),
			getAbstractFileByPath: (path: string) => {
				if (written.has(path)) return fileOf(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			adapter: { exists: async (path: string) => written.has(path) || folders.has(path), mkdir: async (path: string) => { folders.add(path); } },
			create: async (path: string, content: string) => {
				if (written.has(path)) throw new Error('File already exists.');
				written.set(path, content);
				return fileOf(path);
			},
			modify: async (file: { path: string }, content: string) => { written.set(file.path, content); },
			read,
			cachedRead: read,
			createFolder: async (path: string) => { folders.add(path); },
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => ({ frontmatter: frontmatterOf(file.path) }),
		},
		fileManager: {
			processFrontMatter: async () => { throw new Error('not used'); },
		},
	} as unknown as App;
	return { app, written, folders };
}

describe('importSssom with mappingForm table', () => {
	it('writes one mapping table, no notes, and a set discovery reports with its row count', async () => {
		const { app, written } = makeVault();
		const result = await importSssom(app, sssom([ROW_1, ROW_2, ROW_3]), null, null, {
			runTier2Projection: false, importSet: 'new-set-qualified', mappingForm: 'table',
		});
		expect(result.generation?.errors).toEqual([]);
		expect(result.generation?.success).toBe(true);
		expect(result.generation?.created).toEqual([]);
		expect(result.generation?.upToDate).toEqual([]);
		expect(result.mappingForm).toBe('table');
		expect(result.tablePath).toBe(TABLE);
		expect(result.rowsWritten).toBe(3);
		expect([...written.keys()]).toEqual([TABLE]);
		expect([...written.keys()].some((path) => path.endsWith('.md'))).toBe(false);

		const parsed = parseMappingTable(written.get(TABLE)!);
		expect(parsed.errors).toEqual([]);
		expect(parsed.rowErrors).toEqual([]);
		expect(parsed.provenance).toBe('valid');
		expect(parsed.rows).toHaveLength(3);
		// Parsing back and re-serializing reproduces the file byte for byte.
		expect(serializeMappingTable(parsed.header, parsed.rows)).toBe(written.get(TABLE));
		const exact = parsed.rows.find((row) => row.subject_id === 'demo-a:X-1')!;
		expect(exact).toMatchObject({
			predicate_id: 'is_equivalent_to', sssom_predicate: 'skos:exactMatch', object_id: 'demo-b:Y-1',
			confidence: '0.9', subject_label: 'Demo one', object_label: 'Target one',
			mapping_justification: 'semapv:ManualMappingCuration', mapping_provider: 'Demo provider',
			mapping_set_id: 'https://example.test/demo-map',
		});
		expect(exact.review_status).toBeUndefined();
		expect(parsed.rows.find((row) => row.subject_id === 'demo-a:X-3')!.predicate_id).toBe('is_narrower_than');

		const head = parsed.header;
		expect(head).toMatchObject({
			mapping_set_id: 'https://example.test/demo-map', mapping_provider: 'Demo provider', mapping_date: '2026-09-30',
			subject_source: 'demo-a', object_source: 'demo-b', license: 'https://example.test/license',
			source_framework: 'demo-a', target_framework: 'demo-b', tags: ['crosswalk/demo-a-to-demo-b'],
		});
		const block = head.crosswalker_provenance!;
		const importSet = block.import_set as Record<string, unknown>;
		expect(importSet.mapping_form).toBe('table');
		expect(importSet.id).toBe(result.generation?.importSetId);
		expect(head.import_set).toBe(importSet.id);
		expect(importSet.destination).toBe(FOLDER);
		expect(block.recipe).toMatchObject({ id: 'sssom-demo-a-to-demo-b' });
		expect(block.concept_cid).toBeUndefined();
		expect(block.review_cid).toBeUndefined();
		expect(block.review_groups).toBeUndefined();

		const tables = await readMappingTables(app);
		expect(tables).toHaveLength(1);
		expect(tables[0].rows).toEqual(parsed.rows);
		const sets = await discoverImportSets(app);
		expect(sets).toHaveLength(1);
		expect(sets[0]).toMatchObject({ id: importSet.id, mapping_form: 'table', rowCount: 3, noteCount: 0, paths: [TABLE], root: FOLDER });
	});

	it('refreshes the table in place, carrying reviews by row id and dropping rows the source no longer has', async () => {
		const { app, written } = makeVault();
		const first = await importSssom(app, sssom([ROW_1, ROW_2, ROW_3]), null, null, {
			runTier2Projection: false, importSet: 'new-set-qualified', mappingForm: 'table',
		});
		const setId = first.generation!.importSetId!;

		// A reviewer edits one row in the file.
		const before = parseMappingTable(written.get(TABLE)!);
		const reviewed = before.rows.find((row) => row.subject_id === 'demo-a:X-1')!;
		const removed = before.rows.find((row) => row.subject_id === 'demo-a:X-3')!;
		written.set(TABLE, serializeMappingTable(before.header, before.rows.map((row) => row.row_id === reviewed.row_id
			? { ...row, review_status: 'approved', reviewer: 'reviewer-1', notes: { notes: 'Checked by hand.' } }
			: row)));

		const second = await importSssom(app, sssom([ROW_1, ROW_2, ROW_4]), null, null, {
			runTier2Projection: false, importSet: { id: setId }, outputFolder: FOLDER, overwriteMode: 'replace', mappingForm: 'table',
		});
		expect(second.generation?.success).toBe(true);
		expect(second.generation?.importSetId).toBe(setId);
		expect(second.tablePath).toBe(TABLE);
		expect(second.rowsWritten).toBe(3);
		// One row carried a review; the other matched row had none to carry.
		expect(second.reviewCarried).toBe(1);
		expect(second.rowsDropped).toBe(1);
		expect([...written.keys()]).toEqual([TABLE]);

		const after = parseMappingTable(written.get(TABLE)!);
		expect(after.errors).toEqual([]);
		expect(after.rows.map((row) => row.subject_id).sort()).toEqual(['demo-a:X-1', 'demo-a:X-2', 'demo-a:X-4']);
		expect(after.rows.find((row) => row.row_id === removed.row_id)).toBeUndefined();
		const kept = after.rows.find((row) => row.row_id === reviewed.row_id)!;
		expect(kept).toMatchObject({ review_status: 'approved', reviewer: 'reviewer-1', notes: { notes: 'Checked by hand.' } });
		expect(after.rows.find((row) => row.subject_id === 'demo-a:X-4')!.review_status).toBeUndefined();
		expect((after.header.crosswalker_provenance!.import_set as Record<string, unknown>)).toMatchObject({ id: setId, mapping_form: 'table' });
	});

	it('gives a second new set for the same pair a set-qualified table name, and discovery keeps them separate', async () => {
		const { app, written } = makeVault();
		const first = await importSssom(app, sssom([ROW_1]), null, null, { runTier2Projection: false, importSet: 'new-set-qualified', mappingForm: 'table' });
		const original = written.get(TABLE);
		const second = await importSssom(app, sssom([ROW_2, ROW_3]), null, null, { runTier2Projection: false, importSet: 'new-set-qualified', mappingForm: 'table' });
		expect(second.generation?.errors).toEqual([]);
		expect(second.generation?.success).toBe(true);
		const secondId = second.generation!.importSetId!;
		expect(secondId).not.toBe(first.generation!.importSetId);
		const qualified = `${FOLDER}/demo-a-to-demo-b.${secondId}.mapping-table.tsv`;
		expect(second.tablePath).toBe(qualified);
		expect(written.get(TABLE)).toBe(original);
		expect([...written.keys()].sort()).toEqual([TABLE, qualified].sort());

		const sets = await discoverImportSets(app);
		expect(sets).toHaveLength(2);
		const byId = new Map(sets.map((set) => [set.id, set]));
		expect(byId.get(first.generation!.importSetId!)).toMatchObject({ mapping_form: 'table', rowCount: 1, paths: [TABLE] });
		expect(byId.get(secondId)).toMatchObject({ mapping_form: 'table', rowCount: 2, paths: [qualified] });

		// A refresh of the second set rewrites its own qualified table, not the first.
		const refreshed = await importSssom(app, sssom([ROW_2]), null, null, {
			runTier2Projection: false, importSet: { id: secondId }, outputFolder: FOLDER, mappingForm: 'table',
		});
		expect(refreshed.generation?.success).toBe(true);
		expect(refreshed.tablePath).toBe(qualified);
		expect(written.get(TABLE)).toBe(original);
	});

	it('refuses a new table set only when even the set-qualified path is taken', async () => {
		const { app, written } = makeVault();
		await importSssom(app, sssom([ROW_1]), null, null, { runTier2Projection: false, importSet: 'new-set-qualified', mappingForm: 'table' });
		// Every qualified path the next mint could pick is already a stray file.
		const blocker = 'Unrelated content.';
		// Pin the mint so the next set's id, and so its qualified path, is known.
		const pinned = jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
			if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0);
			return array;
		});
		let refused: Awaited<ReturnType<typeof importSssom>> | undefined;
		try {
			const probe = await resolveImportSet(app, FOLDER, 'new-set-qualified');
			written.set(`${FOLDER}/demo-a-to-demo-b.${probe.id}.mapping-table.tsv`, blocker);
			refused = await importSssom(app, sssom([ROW_2]), null, null, { runTier2Projection: false, importSet: 'new-set-qualified', mappingForm: 'table' });
			expect(refused.generation?.importSetId).toBe(probe.id);
		} finally {
			pinned.mockRestore();
		}
		expect(refused!.generation?.success).toBe(false);
		expect(refused!.generation?.errors[0].message).toMatch(/A file already exists at .*\.mapping-table\.tsv, so a new mapping table cannot be written there\. Rename or move that file, or choose a different folder, then run the import again\./);
		expect([...written.values()].filter((content) => content === blocker)).toHaveLength(1);
	});

	it('names the missing table when a table set is refreshed after its file was deleted', async () => {
		const { app, written } = makeVault();
		const table = await importSssom(app, sssom([ROW_1, ROW_2]), null, null, { runTier2Projection: false, importSet: 'new-set-qualified', mappingForm: 'table' });
		const setId = table.generation!.importSetId!;
		written.delete(TABLE);

		const refused = await importSssom(app, sssom([ROW_1, ROW_2]), null, null, {
			runTier2Projection: false, importSet: { id: setId }, outputFolder: FOLDER, mappingForm: 'table',
		});
		expect(refused.generation?.success).toBe(false);
		expect(refused.generation?.errors[0].message).toBe(`Import set ${setId} has no mapping table in the vault. Import the source as a new set instead.`);
		expect(written.size).toBe(0);
	});

	it('refuses to refresh a table with unreadable rows and says how to fix it', async () => {
		const { app, written } = makeVault();
		const table = await importSssom(app, sssom([ROW_1, ROW_2]), null, null, { runTier2Projection: false, importSet: 'new-set-qualified', mappingForm: 'table' });
		const setId = table.generation!.importSetId!;
		const parsed = parseMappingTable(written.get(TABLE)!);
		// A duplicated row id is a row Crosswalker cannot read.
		written.set(TABLE, serializeMappingTable(parsed.header, [...parsed.rows, parsed.rows[0]]));
		const snapshot = new Map(written);

		const refused = await importSssom(app, sssom([ROW_1, ROW_2]), null, null, {
			runTier2Projection: false, importSet: { id: setId }, outputFolder: FOLDER, mappingForm: 'table',
		});
		expect(refused.generation?.success).toBe(false);
		const message = refused.generation!.errors[0].message;
		expect(message).toMatch(/^Mapping table .* has rows Crosswalker could not read, so refreshing it would lose their reviews\. Fix or remove those rows in the file, then run the import again\. Detail: Duplicate mapping table row_id/);
		expect(written).toEqual(snapshot);
	});

	it('refuses to refresh a notes-form set as a table', async () => {
		const { app, written } = makeVault();
		const notes = await importSssom(app, sssom([ROW_1, ROW_2]), null, null, { runTier2Projection: false, importSet: 'new-set-qualified' });
		expect(notes.generation?.success).toBe(true);
		const setId = notes.generation!.importSetId!;
		const snapshot = new Map(written);

		const refused = await importSssom(app, sssom([ROW_1, ROW_2]), null, null, {
			runTier2Projection: false, importSet: { id: setId }, outputFolder: FOLDER, mappingForm: 'table',
		});
		expect(refused.generation?.success).toBe(false);
		expect(refused.generation?.errors[0].message).toBe(`Import set ${setId} stores its mappings as notes. Convert the set instead of refreshing it as a table.`);
		expect(written).toEqual(snapshot);
	});

	it('refuses to refresh a table-form set as notes', async () => {
		const { app, written } = makeVault();
		const table = await importSssom(app, sssom([ROW_1, ROW_2]), null, null, { runTier2Projection: false, importSet: 'new-set-qualified', mappingForm: 'table' });
		const setId = table.generation!.importSetId!;
		const snapshot = new Map(written);

		const refused = await importSssom(app, sssom([ROW_1, ROW_2]), null, null, {
			runTier2Projection: false, importSet: { id: setId }, outputFolder: FOLDER,
		});
		expect(refused.mappingForm).toBe('notes');
		expect(refused.generation?.success).toBe(false);
		expect(refused.generation?.errors[0].message).toBe(`Import set ${setId} stores its mappings as a table. Convert the set instead of refreshing it as notes.`);
		expect(written).toEqual(snapshot);
	});

	it('runs the projection hook after a table write', async () => {
		const { app } = makeVault();
		(app as unknown as { metadataCache: Record<string, unknown> }).metadataCache.resolvedLinks = {};
		const projection = jest.fn(async () => ({ success: true }));
		const closure = jest.fn(async () => 0);
		const result = await importSssom(app, sssom([ROW_1]), projection, closure, { importSet: 'new-set-qualified', mappingForm: 'table' });
		expect(result.generation?.success).toBe(true);
		expect(projection).toHaveBeenCalledTimes(1);
		expect(closure).toHaveBeenCalledWith('demo-a', 'demo-b');
	});
});

describe('resolveImportSet mapping form proposal', () => {
	it('pins table on a mint, stamps nothing for notes, and never changes an existing set', async () => {
		const { app } = makeVault();
		expect((await resolveImportSet(app, 'Maps', 'new', undefined, undefined, 'table')).mapping_form).toBe('table');
		expect((await resolveImportSet(app, 'Maps', 'new-set-qualified', undefined, undefined, 'table')).mapping_form).toBe('table');
		expect('mapping_form' in await resolveImportSet(app, 'Maps', 'new', undefined, undefined, 'notes')).toBe(false);
		expect('mapping_form' in await resolveImportSet(app, 'Maps', 'new')).toBe(false);

		const notes = await importSssom(app, sssom([ROW_1]), null, null, { runTier2Projection: false, importSet: 'new-set-qualified' });
		const setId = notes.generation!.importSetId!;
		const refreshed = await resolveImportSet(app, FOLDER, { id: setId }, undefined, undefined, 'table');
		expect(refreshed.id).toBe(setId);
		expect('mapping_form' in refreshed).toBe(false);
	});
});

describe('importSssom refuses endpoint ids that are not curies, early and by row', () => {
	const SHAPE = 'lowercase prefix:local part, letters, digits, . _ - ( ) /';
	// One bad row among good ones: a subject id with a space in it.
	const BAD_ROW = 'demo-a:X 2\tDemo two\tskos:relatedMatch\tdemo-b:Y-2\tTarget two\tsemapv:ManualMappingCuration\t0.5';
	const expected = `1 mapping row cannot be imported. Row 2: subject id "demo-a:X 2" is not a curie (${SHAPE}). `
		+ 'Fix the source, or map the column to an id that follows that shape, then import again.';

	it.each(['notes', 'table'] as const)('writes nothing and names the row, in the %s form', async (mappingForm) => {
		const { app, written, folders } = makeVault();
		const result = await importSssom(app, sssom([ROW_1, BAD_ROW, ROW_3]), null, null, {
			runTier2Projection: false, importSet: 'new-set-qualified', mappingForm,
		});
		expect(result.generation?.success).toBe(false);
		expect(result.generation?.errors).toEqual([{ row: -1, message: expected }]);
		expect(result.skipped).toBeUndefined();
		expect(result.unresolved).toEqual([]);
		expect(written.size).toBe(0);
		expect(folders.size).toBe(0);
	});

	it('refuses a refresh the same way, leaving the existing set byte-identical', async () => {
		const { app, written } = makeVault();
		const first = await importSssom(app, sssom([ROW_1, ROW_2]), null, null, { runTier2Projection: false, importSet: 'new-set-qualified', mappingForm: 'table' });
		expect(first.generation?.success).toBe(true);
		const snapshot = new Map(written);
		const refused = await importSssom(app, sssom([ROW_1, BAD_ROW]), null, null, {
			runTier2Projection: false, importSet: { id: first.generation!.importSetId! }, outputFolder: FOLDER, mappingForm: 'table',
		});
		expect(refused.generation?.errors[0].message).toBe(expected);
		expect(written).toEqual(snapshot);
	});

	it('names the row count and the first three offending values, both endpoints checked', () => {
		const message = nonCurieEndpointRefusal([
			{ subject_id: 'demo-a:X-1', object_id: 'demo-b:Y-1' },
			{ subject_id: 'Demo-A:X-2', object_id: 'demo-b:Y-2' },
			{ subject_id: 'demo-a:X-3', object_id: 'no colon' },
			{ subject_id: 'demo-a X-4', object_id: 'demo-b:Y 4' },
		]);
		expect(message).toBe(
			`3 mapping rows cannot be imported. Row 2: subject id "Demo-A:X-2" is not a curie (${SHAPE}). `
			+ `Row 3: object id "no colon" is not a curie (${SHAPE}). `
			+ `Row 4: subject id "demo-a X-4" is not a curie (${SHAPE}). And 1 more. `
			+ 'Fix the source, or map the column to an id that follows that shape, then import again.',
		);
		expect(message).not.toContain('\u2014');
	});

	it('accepts every shape the Tier 1 curie pattern admits', () => {
		expect(nonCurieEndpointRefusal([
			{ subject_id: 'demo-a:X-1', object_id: 'demo_b:Y.1(a)/2' },
			{ subject_id: 'd:x', object_id: 'demo-b:Y_1' },
		])).toBeNull();
	});
});
