/**
 * Mapping set slice 2, Worker A (v0.1.7 Track 3, 2026-10-03): the typed
 * mapping table round trip and the partial-export guard.
 *
 *   S1  the typed table export writes a release file beside the table when the
 *       set has a record, and none when it has not
 *   S2  the typed table importer is an adapter onto the crosswalk mapping file
 *       importer: export, import, export is identity on the seven columns
 *   S3  without a release file the set declares nothing, its id is minted, and
 *       a refresh keeps it
 *   S4  a release file's fingerprints are checked, never trusted
 *   S6  a partial export says so, in both exporters
 *
 * Synthetic data only: `demo-a:` / `demo-b:` ids.
 */
import type { App, TFolder } from 'obsidian';
import { TFile, TFolder as TFolderClass, parseYaml } from 'obsidian';
import { importSssom } from '../src/import/sssom-importer';
import { runImportStrm, strmToSssomDocument, IMPORTABLE_RELATIONSHIPS } from '../src/import/strm-importer';
import { discoverImportSets, type DiscoveredImportSet } from '../src/generation/import-set';
import { readMappingSet, type MappingSetRecord } from '../src/mappings/mapping-set';
import { exportFolderAsSssomTsv, releaseRecordLine } from '../src/export/sssom-exporter';
import { exportFolderAsStrmTsv, releaseFilePathFor, strmReleaseFileContent } from '../src/export/strm-tsv-exporter';
import { runFolderTypedTableExport } from '../src/export/run-folder-typed-table-export';
import { partialExportLine } from '../src/export/exported-set-record';
import { typedTableWording } from '../src/import/sssom-import-modal';

const FOLDER = '_crosswalker/mappings/demo-a-to-demo-b';
const TABLE_PATH = '_crosswalker/mappings/demo-a-to-demo-b.export.typed-mappings.tsv';
const RELEASE_PATH = '_crosswalker/mappings/demo-a-to-demo-b.export.typed-mappings.mapping-set.json';
const SET_ID = 'https://example.test/mappings/demo-a-to-demo-b';

const FULL_HEADER = [
	`# mapping_set_id: "${SET_ID}"`,
	'# mapping_set_version: "2026.1"',
	'# mapping_set_title: "Demo A to Demo B"',
	'# mapping_set_description: "A synthetic release for tests."',
	'# subject_source: "demo-a"',
	'# subject_source_version: "1.0"',
	'# object_source: "demo-b"',
	'# object_source_version: "2.0"',
	'# mapping_provider: "Demo provider"',
	'# mapping_date: "2026-10-03"',
	'# creator_id:',
	'#   - "demo:creator-1"',
	'#   - "demo:creator-2"',
	'# license: "https://example.test/license"',
];

// No modifiers, no closeMatch, confidences on the 0.1 grid: what a typed
// table can carry exactly (the module doc of strm-importer.ts lists the rest).
const COLUMNS = 'subject_id\tsubject_label\tpredicate_id\tobject_id\tobject_label\tmapping_justification\tconfidence';
const ROWS = [
	'demo-a:X-1\tDemo one\tskos:exactMatch\tdemo-b:Y-1\tTarget one\tsemapv:ManualMappingCuration\t0.9',
	'demo-a:X-2\tDemo two\tskos:relatedMatch\tdemo-b:Y-2\tTarget two\tsemapv:LexicalMatching\t0.5',
	'demo-a:X-3\tDemo three\tskos:broadMatch\tdemo-b:Y-3\tTarget three\tsemapv:ManualMappingCuration\t0.7',
	'demo-a:X-4\tDemo four\tskos:narrowMatch\tdemo-b:Y-4\tTarget four\tsemapv:ManualMappingCuration\t',
];

function sssom(header: string[], rows: string[] = ROWS): string {
	return [...header, COLUMNS, ...rows].join('\n');
}

const STRM_HEADER = 'Focal Document\tFocal Document Element\tReference Document\tReference Document Element\tRelationship\tStrength of Relationship (Optional)\tRationale';
const STRM_ROWS = [
	'demo-a\tX-1\tdemo-b\tY-1\tequal\t9\tSame wording.',
	'demo-a\tX-2\tdemo-b\tY-2\tsubset of\t\tNarrower scope.',
	'demo-a\tX-3\tdemo-b\tY-3\tintersects with\t4\t',
];
function strm(rows: string[] = STRM_ROWS): string {
	return `${[STRM_HEADER, ...rows].join('\n')}\n`;
}

/**
 * Header line plus sorted rows. Export order follows note paths or table row
 * ids, and a table row id includes a set id minted per run, so a first import
 * of a hand-written table need not export in the table's own order. Export,
 * import with the release file, export again is still compared byte for byte.
 */
function sameRows(tsv: string): string[] {
	const [header, ...rows] = tsv.replace(/\n$/, '').split('\n');
	return [header, ...rows.sort()];
}

const M3_AND_FACTS = [
	'mapping_set_id', 'mapping_set_version', 'mapping_set_title', 'mapping_set_description', 'license',
	'mapping_provider', 'mapping_date', 'creator_id', 'subject_source', 'subject_source_version',
	'object_source', 'object_source_version', 'assertion_count', 'membership_digest', 'content_digest',
] as const;
function m3(record: MappingSetRecord): Record<string, unknown> {
	return Object.fromEntries(M3_AND_FACTS.map((key) => [key, record[key]]));
}

/** A vault double with real TFile/TFolder handles (same shape as tests/mapping-set-roundtrip.test.ts). */
function makeVault() {
	const written = new Map<string, string>();
	const folders = new Set<string>();
	const fileOf = (path: string) => Object.assign(new TFile(path), {
		stat: { mtime: 0 }, extension: path.split('.').pop(), name: path.split('/').pop(),
	});
	const frontmatterOf = (path: string) => {
		const match = (written.get(path) ?? '').match(/^---\n([\s\S]*?)\n---/);
		return match ? parseYaml(match[1]) as Record<string, unknown> : undefined;
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
				if (folders.has(path)) return new TFolderClass(path);
				return null;
			},
			adapter: {
				exists: async (path: string) => written.has(path) || folders.has(path),
				mkdir: async (path: string) => { folders.add(path); },
				write: async (path: string, content: string) => { written.set(path, content); },
				read: async (path: string) => {
					if (!written.has(path)) throw new Error('missing');
					return written.get(path)!;
				},
				rename: async (from: string, to: string) => {
					written.set(to, written.get(from)!);
					written.delete(from);
				},
				remove: async (path: string) => { written.delete(path); },
				trashLocal: async (path: string) => { written.delete(path); },
			},
			create: async (path: string, content: string) => {
				if (written.has(path)) throw new Error('File already exists.');
				written.set(path, content);
				return fileOf(path);
			},
			modify: async (file: { path: string }, content: string) => { written.set(file.path, content); },
			delete: async (file: { path: string }) => { written.delete(file.path); },
			trash: async (file: { path: string }) => { written.delete(file.path); },
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
type Vault = ReturnType<typeof makeVault>;

function folder(path: string): TFolder {
	const parts = path.split('/');
	return {
		path,
		name: parts[parts.length - 1],
		parent: { path: parts.slice(0, -1).join('/') },
		children: [],
		isRoot: () => false,
	} as unknown as TFolder;
}

async function importSssomNew(vault: Vault, text: string, form: 'notes' | 'table'): Promise<string> {
	const result = await importSssom(vault.app, text, null, null, { runTier2Projection: false, importSet: 'new-set-qualified', mappingForm: form });
	expect(result.generation?.errors ?? []).toEqual([]);
	expect(result.generation?.success).toBe(true);
	return result.generation!.importSetId!;
}

async function setOf(vault: Vault, id: string): Promise<DiscoveredImportSet> {
	const set = (await discoverImportSets(vault.app)).find((entry) => entry.id === id);
	if (!set) throw new Error(`set ${id} not discovered`);
	return set;
}

async function recordOf(vault: Vault, id: string): Promise<MappingSetRecord> {
	const record = await readMappingSet(vault.app, await setOf(vault, id));
	if (!record) throw new Error(`set ${id} has no release record`);
	return record;
}

async function exportTyped(vault: Vault, path = FOLDER) {
	const outcome = await runFolderTypedTableExport({ app: vault.app, folder: folder(path), confirmReplace: async () => true });
	expect(outcome.status).toBe('written');
	return outcome;
}

describe.each(['notes', 'table'] as const)('typed mapping table round trip, %s form', (form) => {
	it('export writes the table and its release file; import into a new set restores the record; export again is byte identical', async () => {
		const first = makeVault();
		const original = await recordOf(first, await importSssomNew(first, sssom(FULL_HEADER), form));

		const outcome = await exportTyped(first);
		expect(outcome).toMatchObject({ rowCount: 4, release_record: 'recorded', release_file: RELEASE_PATH });
		expect(outcome.releaseMessage).toBe(`Release record written to ${RELEASE_PATH}.`);
		const table = first.written.get(TABLE_PATH)!;
		const release = first.written.get(RELEASE_PATH)!;
		// The table is the seven template columns and nothing else (S1).
		expect(table.split('\n')[0]).toBe(STRM_HEADER);
		expect(table).not.toMatch(/digest|mapping_set|crosswalker/);
		const releaseJson = JSON.parse(release);
		expect(releaseJson).toMatchObject({
			format: 'crosswalker-mapping-set-v1',
			typed_table: 'demo-a-to-demo-b.export.typed-mappings.tsv',
			kind: 'mapping-set',
			mapping_set_id: SET_ID,
			membership_digest: original.membership_digest,
		});
		expect(release).toBe(strmReleaseFileContent(original, 'demo-a-to-demo-b.export.typed-mappings.tsv'));

		const second = makeVault();
		const imported = await runImportStrm(second.app, table, release, null, null, {
			runTier2Projection: false, importSet: 'new-set-qualified', mappingForm: form, releaseFileName: 'demo.mapping-set.json',
		});
		expect(imported.generation?.errors ?? []).toEqual([]);
		expect(imported.generation?.success).toBe(true);
		expect(imported.release_file).toBe('read');
		expect(imported.release_warning).toBeUndefined();
		const reimported = await recordOf(second, imported.generation!.importSetId!);
		expect(m3(reimported)).toEqual(m3(original));
		expect(reimported.id_origin).toBe('declared');

		await exportTyped(second);
		expect(second.written.get(TABLE_PATH)).toBe(table);
	});

	it('without a release file: minted id, no declared sources, rows keep the document columns; a refresh keeps the id', async () => {
		const vault = makeVault();
		const first = await runImportStrm(vault.app, strm(), undefined, null, null, {
			runTier2Projection: false, importSet: 'new-set-qualified', mappingForm: form,
		});
		expect(first.generation?.errors ?? []).toEqual([]);
		expect(first.release_file).toBe('missing');
		const setId = first.generation!.importSetId!;
		const record = await recordOf(vault, setId);
		expect(record.id_origin).toBe('minted');
		expect(record.mapping_set_id).toMatch(/^urn:crosswalker:mapping-set:[a-z2-7]{10}$/);
		expect(record.subject_source).toBeUndefined();
		expect(record.object_source).toBeUndefined();
		expect(record.mapping_set_version).toBeUndefined();
		expect(record.assertion_count).toBe(3);

		// The document columns stay on the rows as observed values, never on the record.
		const exported = await exportFolderAsStrmTsv(vault.app, FOLDER);
		expect(sameRows(exported.tsv)).toEqual(sameRows(strm()));
		if (form === 'notes') {
			const edgeNote = [...vault.written.values()].find((text) => /kind: crosswalk-edge/.test(text))!;
			expect(edgeNote).toMatch(/source_framework: demo-a/);
			expect(edgeNote).toMatch(/target_framework: demo-b/);
		}

		const again = await runImportStrm(vault.app, strm(), undefined, null, null, {
			runTier2Projection: false, importSet: { id: setId }, overwriteMode: 'replace', mappingForm: form,
		});
		expect(again.generation?.errors ?? []).toEqual([]);
		expect(again.generation?.success).toBe(true);
		expect((await recordOf(vault, setId)).mapping_set_id).toBe(record.mapping_set_id);
	});
});

describe('release file checks', () => {
	async function exportedPair() {
		const vault = makeVault();
		await importSssomNew(vault, sssom(FULL_HEADER), 'notes');
		await exportTyped(vault);
		return { table: vault.written.get(TABLE_PATH)!, release: vault.written.get(RELEASE_PATH)! };
	}

	it('stale fingerprints: the import proceeds, warns, and stores the recomputed values', async () => {
		const { table, release } = await exportedPair();
		const lines = table.trimEnd().split('\n');
		const shorter = `${lines.slice(0, -1).join('\n')}\n`; // one mapping fewer than the release file says
		const vault = makeVault();
		const result = await runImportStrm(vault.app, shorter, release, null, null, {
			runTier2Projection: false, importSet: 'new-set-qualified',
		});
		expect(result.generation?.success).toBe(true);
		expect(result.release_warning).toBe('The file holds 3 mappings; its release file says 4. The record now matches the file.');
		expect(result.summary).toContain(result.release_warning);
		const record = await recordOf(vault, result.generation!.importSetId!);
		expect(record.mapping_set_id).toBe(SET_ID);
		expect(record.mapping_set_version).toBe('2026.1');
		expect(record.assertion_count).toBe(3);
		expect(record.membership_digest).not.toBe(JSON.parse(release).membership_digest);
	});

	it('a malformed release file is refused with the existing actionable error, and nothing is written', async () => {
		const { table, release } = await exportedPair();
		const broken = JSON.stringify({ ...JSON.parse(release), membership_digest: 'nope' });
		const vault = makeVault();
		const result = await runImportStrm(vault.app, table, broken, null, null, {
			runTier2Projection: false, importSet: 'new-set-qualified', releaseFileName: 'demo.mapping-set.json',
		});
		expect(result.generation?.success).toBe(false);
		expect(result.generation?.errors[0].message).toBe(
			'The release record in demo.mapping-set.json has no valid membership fingerprint (property membership_digest). Import the set again to rewrite the record, or delete the record, then try again.',
		);
		expect(vault.written.size).toBe(0);
	});

	it('a file that is not a release file, or not JSON, is refused by name', () => {
		const wrongFormat = strmToSssomDocument(strm(), { name: 'x.mapping-set.json', text: '{"format":"something-else"}' });
		expect(wrongFormat).toMatchObject({ ok: false });
		expect(!wrongFormat.ok && wrongFormat.message).toMatch(/^The release file x\.mapping-set\.json is not a Crosswalker release file/);
		const notJson = strmToSssomDocument(strm(), { name: 'x.mapping-set.json', text: '{' });
		expect(!notJson.ok && notJson.message).toMatch(/^The release file x\.mapping-set\.json could not be read\./);
	});
});

describe('table refusals', () => {
	it('an unknown relationship is refused, rows named, allowed values listed, nothing written', async () => {
		const rows = [
			...STRM_ROWS,
			'demo-a\tX-4\tdemo-b\tY-4\tunrelated-ish\t\t',
			'demo-a\tX-5\tdemo-b\tY-5\tsimilar\t\t',
			'demo-a\tX-6\tdemo-b\tY-6\t\t\t',
			'demo-a\tX-7\tdemo-b\tY-7\tclose\t\t',
		];
		const vault = makeVault();
		const result = await runImportStrm(vault.app, strm(rows), undefined, null, null, { runTier2Projection: false, importSet: 'new-set-qualified' });
		expect(result.generation?.success).toBe(false);
		expect(result.generation?.errors[0].message).toBe(
			'4 mapping rows have a relationship Crosswalker cannot import (rows 4, 5, 6 and 1 more). '
			+ 'Allowed values: equal, subset of, superset of, intersects with, not related. Fix the table, then import again.',
		);
		expect(IMPORTABLE_RELATIONSHIPS).toEqual(['equal', 'subset of', 'superset of', 'intersects with', 'not related']);
		expect(vault.written.size).toBe(0);
	});

	it.each(['notes', 'table'] as const)('S7, %s form: not related round-trips as no_relationship, with no warning and no SKOS predicate', async (form) => {
		const rows = [...STRM_ROWS, 'demo-a\tX-4\tdemo-b\tY-4\tnot related\t2\tNo overlap.'];
		const first = makeVault();
		const imported = await runImportStrm(first.app, strm(rows), undefined, null, null, {
			runTier2Projection: false, importSet: 'new-set-qualified', mappingForm: form,
		});
		expect(imported.generation?.errors ?? []).toEqual([]);
		expect(imported.parse.warnings).toEqual([]);
		const original = await recordOf(first, imported.generation!.importSetId!);
		expect(original.assertion_count).toBe(4);
		if (form === 'notes') {
			const note = [...first.written.values()].find((text) => /predicate_id: no_relationship/.test(text));
			expect(note).toBeDefined();
			expect(note).not.toMatch(/sssom_predicate: skos/);
		}

		const exported = await exportTyped(first);
		expect(exported.release_record).toBe('recorded');
		const table = first.written.get(TABLE_PATH)!;
		expect(sameRows(table)).toEqual(sameRows(strm(rows)));

		const second = makeVault();
		const again = await runImportStrm(second.app, table, first.written.get(RELEASE_PATH)!, null, null, {
			runTier2Projection: false, importSet: 'new-set-qualified', mappingForm: form,
		});
		expect(again.generation?.errors ?? []).toEqual([]);
		expect(again.release_warning).toBeUndefined();
		expect(m3(await recordOf(second, again.generation!.importSetId!))).toEqual(m3(original));
		await exportTyped(second);
		expect(second.written.get(TABLE_PATH)).toBe(table);
	});

	it('typed table wording replaces the internal format names in shared importer messages', () => {
		expect(typedTableWording('SSSOM file is empty')).toBe('table is empty');
		expect(typedTableWording('Could not detect SSSOM ontology pair.')).toBe('Could not detect crosswalk mapping file ontology pair.');
		expect(typedTableWording('normalized to STRM "x". Add a SKOS→STRM mapping')).toBe('normalized to Crosswalker "x". Add a relationship mapping');
		expect(typedTableWording('Release record written.')).toBe('Release record written.');
	});

	it('relationships invert the export direction: subset of is broadMatch is is_narrower_than', () => {
		const conversion = strmToSssomDocument(strm());
		expect(conversion.ok).toBe(true);
		const body = conversion.ok ? conversion.sssomTsv : '';
		expect(body).toContain('demo-a:X-1\tskos:exactMatch\tdemo-b:Y-1\tSame wording.\t0.9');
		expect(body).toContain('demo-a:X-2\tskos:broadMatch\tdemo-b:Y-2\tNarrower scope.\t');
		expect(body).toContain('demo-a:X-3\tskos:relatedMatch\tdemo-b:Y-3\t\t0.4');
	});

	it('a strength off the 0 to 10 scale, or a document that cannot prefix an id, is refused with the row', () => {
		const strength = strmToSssomDocument(strm(['demo-a\tX-1\tdemo-b\tY-1\tequal\t11\t']));
		expect(!strength.ok && strength.message).toBe('1 mapping row has a strength that is not a whole number from 0 to 10 (row 1). Fix the table, then import again.');
		const titled = strmToSssomDocument(strm(['Demo Framework A\tX-1\tdemo-b\tY-1\tequal\t\t']));
		expect(!titled.ok && titled.message).toMatch(/^1 mapping row cannot be given an id \(row 1\): in row 1, "Demo Framework A" and "X-1" do not form an id\./);
		const missing = strmToSssomDocument('Focal Document Element\tRelationship\nX-1\tequal\n');
		expect(!missing.ok && missing.message).toMatch(/^This typed mapping table has no Reference Document Element column\./);
	});
});

describe('partial export guard (S6)', () => {
	/** A notes-form set with half its mapping notes moved into a subfolder. */
	async function splitSet() {
		const vault = makeVault();
		const setId = await importSssomNew(vault, sssom(FULL_HEADER), 'notes');
		const record = await recordOf(vault, setId);
		const edges = [...vault.written.keys()]
			.filter((path) => path.startsWith(`${FOLDER}/`) && path.endsWith('.md') && /kind: crosswalk-edge/.test(vault.written.get(path)!))
			.sort();
		expect(edges).toHaveLength(4);
		vault.folders.add(`${FOLDER}/part`);
		for (const path of edges.slice(0, 2)) {
			const moved = `${FOLDER}/part/${path.split('/').pop()}`;
			vault.written.set(moved, vault.written.get(path)!);
			vault.written.delete(path);
		}
		return { vault, record };
	}

	it('crosswalk mapping file: half a set is recorded-partial with both counts; the whole set is recorded', async () => {
		const { vault, record } = await splitSet();
		const part = await exportFolderAsSssomTsv(vault.app, `${FOLDER}/part`);
		expect(part).toMatchObject({ rowCount: 2, release_record: 'recorded-partial', recordedCount: 4 });
		expect(part.tsv).toContain(`# mapping_set_id: "${SET_ID}"`);
		expect(releaseRecordLine(part.release_record, { exported: part.rowCount, recorded: part.recordedCount! }))
			.toBe('Exported 2 of 4 recorded mappings. The release record describes the whole set.');
		const whole = await exportFolderAsSssomTsv(vault.app, FOLDER);
		expect(whole).toMatchObject({ rowCount: 4, release_record: 'recorded' });
		expect(record.assertion_count).toBe(4);
	});

	it('typed mapping table: half a set writes the release file and says it is partial; the whole set is recorded', async () => {
		const { vault } = await splitSet();
		const part = await exportTyped(vault, `${FOLDER}/part`);
		expect(part.release_record).toBe('recorded-partial');
		expect(part.release_file).toBe(`${FOLDER}/part.export.typed-mappings.mapping-set.json`);
		expect(part.releaseMessage).toBe(`${partialExportLine(2, 4)} Release file: ${FOLDER}/part.export.typed-mappings.mapping-set.json.`);
		expect(JSON.parse(vault.written.get(part.release_file!)!).mapping_set_id).toBe(SET_ID);
		const whole = await exportTyped(vault);
		expect(whole.release_record).toBe('recorded');
	});

	it('typed mapping table: an explicit negation cannot be carried, so the export is partial', async () => {
		const vault = makeVault();
		const negated = [...ROWS.slice(0, 3), 'demo-a:X-4\tDemo four\tskos:narrowMatch\tdemo-b:Y-4\tTarget four\tsemapv:ManualMappingCuration\t\tNOT'];
		await importSssomNew(vault, sssom(FULL_HEADER, negated).replace(COLUMNS, `${COLUMNS}\tpredicate_modifier`), 'notes');
		const outcome = await exportTyped(vault);
		expect(outcome).toMatchObject({ rowCount: 3, skippedCount: 1, release_record: 'recorded-partial' });
	});

	it('a set without a record writes no release file, says so, and trashes a stale one', async () => {
		const vault = makeVault();
		await runImportStrm(vault.app, strm(), undefined, null, null, { runTier2Projection: false, importSet: 'new-set-qualified' });
		// Remove the set note: a set imported before records existed.
		for (const [path, text] of [...vault.written]) if (/kind: mapping-set/.test(text)) vault.written.delete(path);
		vault.written.set(RELEASE_PATH, '{}');
		const outcome = await exportTyped(vault);
		expect(outcome.release_record).toBe('derived');
		expect(outcome.release_file).toBeUndefined();
		expect(outcome.releaseMessage).toBe(`No release record for this set, so no release file was written. The old release file ${RELEASE_PATH} was moved to the trash because it no longer matches this table.`);
		expect(vault.written.has(RELEASE_PATH)).toBe(false);
	});

	it('release file path sits beside the table', () => {
		expect(releaseFilePathFor('a/b.export.typed-mappings.tsv')).toBe('a/b.export.typed-mappings.mapping-set.json');
	});
});
