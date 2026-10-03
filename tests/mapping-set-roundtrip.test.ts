/**
 * Mapping set release record, slice 1 Worker B (v0.1.7 Track 3, 2026-10-03):
 * the SSSOM round trip. Import a synthetic file with a full header, export it,
 * import the export into a new set: every standard header field, both digests
 * and the assertion count come back equal, and the re-import's id is declared.
 * Also the exporter's recorded/derived flag, and the pure Release section and
 * listing line the UI shows.
 *
 * Synthetic data only: `demo-a:` / `demo-b:` ids.
 */
import type { App } from 'obsidian';
import { TFile, TFolder, parseYaml } from 'obsidian';
import { importSssom } from '../src/import/sssom-importer';
import { parseSssomTsv } from '../src/import/sssom-parser';
import { parseMappingTable, serializeMappingTable } from '../src/mappings/mapping-table';
import { discoverImportSets, type DiscoveredImportSet } from '../src/generation/import-set';
import { readMappingSet, type MappingSetRecord } from '../src/mappings/mapping-set';
import { crosswalkEdgesToSssomTsv, exportFolderAsSssomTsv, releaseRecordLine } from '../src/export/sssom-exporter';
import { NO_RELEASE_RECORD_TEXT, releaseSectionOf } from '../src/views/mapping-review-helpers';
import { releaseListingLine } from '../src/import/stack/installed-stacks';

const FOLDER = '_crosswalker/mappings/demo-a-to-demo-b';
const TABLE = `${FOLDER}/demo-a-to-demo-b.mapping-table.tsv`;
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
const UNDECLARED_HEADER = FULL_HEADER.filter((line) => !line.startsWith('# mapping_set_id:'));
const NO_SOURCES_HEADER = FULL_HEADER.filter((line) => !/^# (subject|object)_source/.test(line));

const COLUMNS = 'subject_id\tsubject_label\tpredicate_id\tobject_id\tobject_label\tmapping_justification\tconfidence\tpredicate_modifier';
const ROWS = [
	'demo-a:X-1\tDemo one\tskos:exactMatch\tdemo-b:Y-1\tTarget one\tsemapv:ManualMappingCuration\t0.9\t',
	'demo-a:X-2\tDemo two\tskos:relatedMatch\tdemo-b:Y-2\tTarget two\tsemapv:LexicalMatching\t0.5\t',
	'demo-a:X-3\tDemo three\tskos:broadMatch\tdemo-b:Y-3\tTarget three\tsemapv:ManualMappingCuration\t0.7\tNOT',
];

function sssom(header: string[], rows: string[] = ROWS): string {
	return [...header, COLUMNS, ...rows].join('\n');
}

/** The standard SSSOM header keys a release record carries (M3). */
const M3_KEYS = [
	'mapping_set_id', 'mapping_set_version', 'mapping_set_title', 'mapping_set_description', 'license',
	'mapping_provider', 'mapping_date', 'creator_id', 'subject_source', 'subject_source_version',
	'object_source', 'object_source_version',
] as const;
/** M3 plus the facts a re-import recomputes. */
const M3_AND_FACTS = [...M3_KEYS, 'assertion_count', 'membership_digest', 'content_digest'] as const;

function m3(record: MappingSetRecord): Record<string, unknown> {
	return Object.fromEntries(M3_AND_FACTS.map((key) => [key, record[key]]));
}

/** A vault double with real TFile/TFolder handles, both listings, a trash and an adapter (same shape as tests/mapping-set.test.ts). */
function makeVault() {
	const written = new Map<string, string>();
	const folders = new Set<string>();
	const fileOf = (path: string) => Object.assign(new TFile(path), { stat: { mtime: 0 }, extension: path.split('.').pop() });
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
				if (folders.has(path)) return new TFolder(path);
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
	return { app, written };
}

type Vault = ReturnType<typeof makeVault>;

async function importNew(vault: Vault, text: string, form: 'notes' | 'table'): Promise<string> {
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

describe.each(['notes', 'table'] as const)('SSSOM round trip, %s form', (form) => {
	it('import, export, import the export into a new set: every header field, both digests and the count are equal', async () => {
		const first = makeVault();
		const firstSet = await importNew(first, sssom(FULL_HEADER), form);
		const original = await recordOf(first, firstSet);
		expect(original.id_origin).toBe('declared');
		expect(original.creator_id).toEqual(['demo:creator-1', 'demo:creator-2']);

		const exported = await exportFolderAsSssomTsv(first.app, FOLDER);
		expect(exported.release_record).toBe('recorded');
		expect(exported.rowCount).toBe(3);
		// Standard header keys only: no digests, no origin, no Crosswalker keys.
		expect(Object.keys(parseSssomTsv(exported.tsv).header).sort()).toEqual([...M3_KEYS].sort());
		expect(exported.tsv).not.toMatch(/digest|id_origin|assertion_count|crosswalker/);

		const second = makeVault();
		const secondSet = await importNew(second, exported.tsv, form);
		const reimported = await recordOf(second, secondSet);
		expect(m3(reimported)).toEqual(m3(original));
		expect(reimported.id_origin).toBe('declared');
	});

	it('a minted id exports as the release id, and the re-import declares it', async () => {
		const first = makeVault();
		const original = await recordOf(first, await importNew(first, sssom(UNDECLARED_HEADER), form));
		expect(original.id_origin).toBe('minted');

		const exported = await exportFolderAsSssomTsv(first.app, FOLDER);
		expect(parseSssomTsv(exported.tsv).header.mapping_set_id).toBe(original.mapping_set_id);

		const second = makeVault();
		const reimported = await recordOf(second, await importNew(second, exported.tsv, form));
		expect(reimported.mapping_set_id).toBe(original.mapping_set_id);
		expect(reimported.id_origin).toBe('declared');
		expect(m3(reimported)).toEqual(m3(original));
	});

	it('undeclared sources stay undeclared through the round trip; nothing is inferred from rows', async () => {
		const first = makeVault();
		const original = await recordOf(first, await importNew(first, sssom(NO_SOURCES_HEADER), form));
		expect(original.subject_source).toBeUndefined();
		const exported = await exportFolderAsSssomTsv(first.app, FOLDER);
		expect(exported.release_record).toBe('recorded');
		expect(exported.tsv).not.toMatch(/subject_source|object_source/);
		const second = makeVault();
		const reimported = await recordOf(second, await importNew(second, exported.tsv, form));
		expect(m3(reimported)).toEqual(m3(original));
	});
});

describe('exporter: recorded or derived', () => {
	it('a set without a release record falls back to the rows and says so', async () => {
		const vault = makeVault();
		await importNew(vault, sssom(FULL_HEADER), 'table');
		// Strip the record from the table header: a set imported before records existed.
		const table = parseMappingTable(vault.written.get(TABLE)!);
		const { mapping_set: _dropped, ...legacyHeader } = table.header;
		vault.written.set(TABLE, serializeMappingTable(legacyHeader, table.rows));
		const exported = await exportFolderAsSssomTsv(vault.app, FOLDER);
		expect(exported.release_record).toBe('derived');
		const header = parseSssomTsv(exported.tsv).header;
		expect(header.mapping_set_id).toBe(SET_ID);
		expect(header.mapping_set_version).toBeUndefined();
	});

	it('rows with no set export derived; a passed record wins over row values', () => {
		const edge = {
			kind: 'crosswalk-edge' as const, path: 'a.md', curie: 'x:1', subject_id: 'demo-a:X-1', predicate_id: 'is_equivalent_to',
			object_id: 'demo-b:Y-1', mapping_set_id: 'row-level-id', mapping_provider: 'Row provider', tags: [], frontmatter: {},
		};
		expect(crosswalkEdgesToSssomTsv([edge]).release_record).toBe('derived');
		const record: MappingSetRecord = {
			mapping_set_id: SET_ID, id_origin: 'declared', mapping_set_version: '2026.1', assertion_count: 1,
			membership_digest: `sha256-${'0'.repeat(64)}`, content_digest: `sha256-${'0'.repeat(64)}`, importSetId: 'iset',
		};
		const recorded = crosswalkEdgesToSssomTsv([edge], { record });
		expect(recorded.release_record).toBe('recorded');
		expect(parseSssomTsv(recorded.tsv).header).toEqual({ mapping_set_id: SET_ID, mapping_set_version: '2026.1' });
	});

	it('names the source in plain words', () => {
		expect(releaseRecordLine('recorded')).toBe('Release record: recorded.');
		expect(releaseRecordLine('derived')).toBe('Release record: derived from rows (no release record). Import the set again to record one.');
	});
});

describe('Release section and listing line', () => {
	async function tableAfterImport(header: string[]) {
		const vault = makeVault();
		await importNew(vault, sssom(header), 'table');
		return { path: TABLE, ...parseMappingTable(vault.written.get(TABLE)!) };
	}

	it('shows the recorded release with membership intact, and stays intact after a review edit', async () => {
		const table = await tableAfterImport(FULL_HEADER);
		const section = releaseSectionOf(table);
		expect(section).toEqual({
			state: 'recorded',
			heading: 'Demo A to Demo B, version 2026.1',
			facts: [
				{ label: 'Release id', value: SET_ID },
				{ label: 'Sources', value: 'from demo-a 1.0 to demo-b 2.0' },
				{ label: 'Provider', value: 'Demo provider' },
				{ label: 'Date', value: '2026-10-03' },
				{ label: 'License', value: 'https://example.test/license' },
				{ label: 'Recorded', value: '3 mappings' },
			],
			membership: { intact: true, text: 'Membership intact.' },
		});
		const reviewed = { ...table, rows: table.rows.map((row) => ({ ...row, review_status: 'approved', reviewer: 'Demo reviewer' })) };
		expect(releaseSectionOf(reviewed)).toEqual(section);
	});

	it('reports a membership change with both counts, and an evidence-only change as intact', async () => {
		const table = await tableAfterImport(FULL_HEADER);
		const dropped = releaseSectionOf({ ...table, rows: table.rows.slice(1) });
		expect(dropped.state === 'recorded' ? dropped.membership : null).toEqual({
			intact: false, text: 'Membership differs from the recorded release: 2 mappings now, 3 recorded.',
		});
		const edited = releaseSectionOf({ ...table, rows: table.rows.map((row, index) => index === 0 ? { ...row, confidence: '0.1' } : row) });
		expect(edited.state === 'recorded' ? edited.membership.intact : null).toBe(true);
		expect(edited.state === 'recorded' ? edited.membership.text : '').toMatch(/^Membership intact\. Some justification/);
	});

	it('labels sources observed from rows when the record declares none', async () => {
		const section = releaseSectionOf(await tableAfterImport(NO_SOURCES_HEADER));
		expect(section.state === 'recorded' ? section.facts.find((fact) => fact.label === 'Sources')?.value : null)
			.toBe('from demo-a to demo-b (observed from rows)');
	});

	it('legacy and malformed records', async () => {
		const table = await tableAfterImport(FULL_HEADER);
		const { mapping_set: _record, ...legacyHeader } = table.header;
		expect(releaseSectionOf({ ...table, header: legacyHeader })).toEqual({ state: 'none', text: NO_RELEASE_RECORD_TEXT });
		const broken = releaseSectionOf({ ...table, header: { ...table.header, mapping_set: { kind: 'mapping-set', mapping_set_id: SET_ID } } });
		expect(broken.state).toBe('unreadable');
		expect(broken.state === 'unreadable' ? broken.text : '').toMatch(/^The release record in .* Import the set again to rewrite the record, or delete the record, then try again\.$/);
	});

	it('listing line: title or id, then version', () => {
		expect(releaseListingLine({ mapping_set_id: SET_ID, mapping_set_title: 'Demo A to Demo B', mapping_set_version: '2026.1' }))
			.toBe('Release: Demo A to Demo B 2026.1');
		expect(releaseListingLine({ mapping_set_id: 'urn:crosswalker:mapping-set:abcdefghij' }))
			.toBe('Release: urn:crosswalker:mapping-set:abcdefghij');
	});
});
