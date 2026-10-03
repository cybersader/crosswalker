/**
 * Mapping set release record, slice 1 Worker A (v0.1.7 Track 3, 2026-10-03):
 * the record's digests, the SSSOM importer writing it in both storage forms,
 * the refresh rule, conversion carrying it both ways, the one reader, and the
 * Tier 1 schema branch.
 *
 * Synthetic data only: `demo-a:` / `demo-b:` ids.
 */
import type { App } from 'obsidian';
import { TFile, TFolder, parseYaml } from 'obsidian';
import { importSssom } from '../src/import/sssom-importer';
import { assignMappingRowIds, parseMappingTable, serializeMappingTable } from '../src/mappings/mapping-table';
import { discoverImportSets, type DiscoveredImportSet } from '../src/generation/import-set';
import { startConversion } from '../src/mappings/mapping-conversion';
import {
	computeMappingSetDigests,
	isMintedMappingSetId,
	mintMappingSetId,
	observedParticipants,
	readMappingSet,
	storedMappingSet,
	type MappingSetAssertionFacts,
	type MappingSetRecord,
} from '../src/mappings/mapping-set';
import { validateTier1Frontmatter } from '../src/validation/validator';

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

const COLUMNS = 'subject_id\tsubject_label\tpredicate_id\tobject_id\tobject_label\tmapping_justification\tconfidence';
const ROWS = [
	'demo-a:X-1\tDemo one\tskos:exactMatch\tdemo-b:Y-1\tTarget one\tsemapv:ManualMappingCuration\t0.9',
	'demo-a:X-2\tDemo two\tskos:relatedMatch\tdemo-b:Y-2\tTarget two\tsemapv:ManualMappingCuration\t0.5',
	'demo-a:X-3\tDemo three\tskos:broadMatch\tdemo-b:Y-3\tTarget three\tsemapv:ManualMappingCuration\t0.7',
];

function sssom(header: string[], rows: string[] = ROWS): string {
	return [...header, COLUMNS, ...rows].join('\n');
}

const withVersion = (version: string) => FULL_HEADER.map((line) => line.startsWith('# mapping_set_version:') ? `# mapping_set_version: "${version}"` : line);
const UNDECLARED_HEADER = FULL_HEADER.filter((line) => !line.startsWith('# mapping_set_id:'));

/** A vault double with real TFile/TFolder handles, both listings, a trash, an adapter and a cold-cache switch. */
function makeVault() {
	const written = new Map<string, string>();
	const folders = new Set<string>();
	const trashed = new Map<string, string>();
	const cold = new Set<string>();
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
				trashLocal: async (path: string) => {
					trashed.set(path, written.get(path)!);
					written.delete(path);
				},
			},
			create: async (path: string, content: string) => {
				if (written.has(path)) throw new Error('File already exists.');
				written.set(path, content);
				return fileOf(path);
			},
			modify: async (file: { path: string }, content: string) => { written.set(file.path, content); },
			delete: async (file: { path: string }) => { written.delete(file.path); },
			trash: async (file: { path: string }) => {
				trashed.set(file.path, written.get(file.path)!);
				written.delete(file.path);
			},
			read,
			cachedRead: read,
			createFolder: async (path: string) => { folders.add(path); },
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => (cold.has(file.path) ? null : { frontmatter: frontmatterOf(file.path) }),
		},
		fileManager: {
			processFrontMatter: async () => { throw new Error('not used'); },
		},
	} as unknown as App;
	const setNotes = () => [...written.keys()].filter((path) => path.endsWith('.md') && frontmatterOf(path)?.kind === 'mapping-set').sort();
	return { app, written, trashed, cold, frontmatterOf, setNotes };
}

type Vault = ReturnType<typeof makeVault>;

async function importInto(vault: Vault, text: string, options: Record<string, unknown>) {
	return importSssom(vault.app, text, null, null, { runTier2Projection: false, ...options });
}

async function setOf(vault: Vault, id: string): Promise<DiscoveredImportSet> {
	const set = (await discoverImportSets(vault.app)).find((entry) => entry.id === id);
	if (!set) throw new Error(`set ${id} not discovered`);
	return set;
}

async function recordOf(vault: Vault, id: string): Promise<MappingSetRecord | undefined> {
	return readMappingSet(vault.app, await setOf(vault, id));
}

const EXPECTED_DECLARED = {
	mapping_set_id: SET_ID,
	id_origin: 'declared',
	mapping_set_version: '2026.1',
	mapping_set_title: 'Demo A to Demo B',
	mapping_set_description: 'A synthetic release for tests.',
	subject_source: 'demo-a',
	subject_source_version: '1.0',
	object_source: 'demo-b',
	object_source_version: '2.0',
	mapping_provider: 'Demo provider',
	mapping_date: '2026-10-03',
	creator_id: ['demo:creator-1', 'demo:creator-2'],
	license: 'https://example.test/license',
	assertion_count: 3,
};

// ---------------------------------------------------------------------------

describe('computeMappingSetDigests', () => {
	const rows: MappingSetAssertionFacts[] = [
		{ subject_id: 'demo-a:X-1', predicate_id: 'is_equivalent_to', object_id: 'demo-b:Y-1', mapping_justification: 'semapv:ManualMappingCuration', confidence: '0.9', mapping_provider: 'P' },
		{ subject_id: 'demo-a:X-2', predicate_id: 'intersects_with', object_id: 'demo-b:Y-2', mapping_justification: 'semapv:LexicalMatching', confidence: 0.5 },
		{ subject_id: 'demo-a:X-3', predicate_id: 'is_narrower_than', object_id: 'demo-b:Y-3', predicate_modifier: 'NOT' },
	];

	it('is independent of row order', () => {
		expect(computeMappingSetDigests([...rows].reverse())).toEqual(computeMappingSetDigests(rows));
		expect(computeMappingSetDigests(rows).assertion_count).toBe(3);
		expect(computeMappingSetDigests(rows).membership_digest).toMatch(/^sha256-[0-9a-f]{64}$/);
	});

	it('ignores review columns, labels, notes and extra fields', () => {
		const reviewed = rows.map((row) => ({ ...row, review_status: 'approved', reviewer: 'demo', subject_label: 'x', notes: { my_notes: 'y' }, row_id: 'm-1' }));
		expect(computeMappingSetDigests(reviewed)).toEqual(computeMappingSetDigests(rows));
	});

	it('treats an empty modifier as no modifier and NOT as a different claim', () => {
		const plain = [{ ...rows[0], predicate_modifier: '' }];
		expect(computeMappingSetDigests(plain)).toEqual(computeMappingSetDigests([{ ...rows[0], predicate_modifier: undefined }]));
		expect(computeMappingSetDigests([{ ...rows[0], predicate_modifier: 'NOT' }]).membership_digest)
			.not.toBe(computeMappingSetDigests(plain).membership_digest);
	});

	it('keeps membership but changes content when only the justification changes', () => {
		const changed = rows.map((row, index) => index === 0 ? { ...row, mapping_justification: 'semapv:LexicalMatching' } : row);
		const before = computeMappingSetDigests(rows);
		const after = computeMappingSetDigests(changed);
		expect(after.membership_digest).toBe(before.membership_digest);
		expect(after.content_digest).not.toBe(before.content_digest);
	});

	it('reads a confidence the same whichever form stored it', () => {
		const asText = [{ ...rows[0], confidence: '0.90' }];
		const asNumber = [{ ...rows[0], confidence: 0.9 }];
		expect(computeMappingSetDigests(asText)).toEqual(computeMappingSetDigests(asNumber));
	});
});

describe('mintMappingSetId and observedParticipants', () => {
	it('mints a meaningless base32 urn, different each time', () => {
		const a = mintMappingSetId();
		const b = mintMappingSetId();
		expect(a).toMatch(/^urn:crosswalker:mapping-set:[a-z2-7]{10}$/);
		expect(isMintedMappingSetId(a)).toBe(true);
		expect(a).not.toBe(b);
	});

	it('reports the endpoint prefixes rows use, sorted and distinct', () => {
		expect(observedParticipants([
			{ subject_id: 'demo-b:Z', object_id: 'demo-a:Y' },
			{ subject_id: 'demo-a:X', object_id: 'demo-a:Y' },
		])).toEqual({ subjectPrefixes: ['demo-a', 'demo-b'], objectPrefixes: ['demo-a'] });
	});
});

describe('SSSOM import writes the release record', () => {
	it('notes form: one set note, bound by import set id, whose fields equal the header', async () => {
		const vault = makeVault();
		const result = await importInto(vault, sssom(FULL_HEADER), { importSet: 'new-set-qualified' });
		expect(result.generation?.success).toBe(true);
		expect(result.summary.filter((line) => line.includes('release record'))).toEqual([]);
		const setId = result.generation!.importSetId!;
		expect(vault.setNotes()).toEqual([`${FOLDER}/Demo A to Demo B.md`]);
		const fm = vault.frontmatterOf(vault.setNotes()[0])!;
		expect(fm.kind).toBe('mapping-set');
		expect(validateTier1Frontmatter(fm)).toEqual({ valid: true, errors: [] });
		expect(((fm._crosswalker as Record<string, unknown>).import_set as Record<string, unknown>).id).toBe(setId);

		const record = (await recordOf(vault, setId))!;
		expect(record).toMatchObject({ ...EXPECTED_DECLARED, importSetId: setId });
		expect(record.membership_digest).toMatch(/^sha256-[0-9a-f]{64}$/);
		// Discovery still reads one consistent set with the record among its notes.
		const set = await setOf(vault, setId);
		expect(set.mapping_form).toBe('notes');
		expect(set.noteCount).toBe(4);
	});

	it('table form: the header carries the identical record, and both forms digest the same rows equally', async () => {
		const vault = makeVault();
		const result = await importInto(vault, sssom(FULL_HEADER), { importSet: 'new-set-qualified', mappingForm: 'table' });
		expect(result.generation?.success).toBe(true);
		expect(vault.setNotes()).toEqual([]);
		const header = parseMappingTable(vault.written.get(TABLE)!).header;
		expect(header.mapping_set).toMatchObject({ kind: 'mapping-set', ...EXPECTED_DECLARED });
		const tableRecord = (await recordOf(vault, result.generation!.importSetId!))!;
		expect(tableRecord).toMatchObject(EXPECTED_DECLARED);

		const notesVault = makeVault();
		const notes = await importInto(notesVault, sssom(FULL_HEADER), { importSet: 'new-set-qualified' });
		const notesRecord = (await recordOf(notesVault, notes.generation!.importSetId!))!;
		expect(storedMappingSet(notesRecord)).toEqual(storedMappingSet(tableRecord));
	});

	it('a file that declares no id gets a minted id, and a second new set mints another', async () => {
		const vault = makeVault();
		const first = await importInto(vault, sssom(UNDECLARED_HEADER), { importSet: 'new-set-qualified', mappingForm: 'table' });
		const firstRecord = (await recordOf(vault, first.generation!.importSetId!))!;
		expect(firstRecord.id_origin).toBe('minted');
		expect(firstRecord.mapping_set_id).toMatch(/^urn:crosswalker:mapping-set:[a-z2-7]{10}$/);
		// Every row carries the set's id as its provenance.
		const rows = parseMappingTable(vault.written.get(TABLE)!).rows;
		expect(new Set(rows.map((row) => row.mapping_set_id))).toEqual(new Set([firstRecord.mapping_set_id]));

		const second = await importInto(vault, sssom(UNDECLARED_HEADER), { importSet: 'new-set-qualified', mappingForm: 'table' });
		expect(second.generation?.success).toBe(true);
		const secondRecord = (await recordOf(vault, second.generation!.importSetId!))!;
		expect(secondRecord.id_origin).toBe('minted');
		expect(secondRecord.mapping_set_id).not.toBe(firstRecord.mapping_set_id);
	});
});

describe('refresh rule', () => {
	it.each(['notes', 'table'] as const)('%s form: the same file refreshes and leaves the record equal', async (form) => {
		const vault = makeVault();
		const first = await importInto(vault, sssom(FULL_HEADER), { importSet: 'new-set-qualified', mappingForm: form });
		const setId = first.generation!.importSetId!;
		const before = await recordOf(vault, setId);
		const again = await importInto(vault, sssom(FULL_HEADER), { importSet: { id: setId }, mappingForm: form });
		expect(again.generation?.errors).toEqual([]);
		expect(again.generation?.success).toBe(true);
		expect(await recordOf(vault, setId)).toEqual(before);
		expect(vault.setNotes()).toHaveLength(form === 'notes' ? 1 : 0);
	});

	it.each(['notes', 'table'] as const)('%s form: a refresh keeps a minted id when the file still declares none', async (form) => {
		const vault = makeVault();
		const first = await importInto(vault, sssom(UNDECLARED_HEADER), { importSet: 'new-set-qualified', mappingForm: form });
		const setId = first.generation!.importSetId!;
		const before = (await recordOf(vault, setId))!;
		const again = await importInto(vault, sssom(UNDECLARED_HEADER), { importSet: { id: setId }, mappingForm: form });
		expect(again.generation?.success).toBe(true);
		expect(await recordOf(vault, setId)).toEqual(before);
		expect(before.id_origin).toBe('minted');
	});

	it.each(['notes', 'table'] as const)('%s form: a file declaring a different version is refused and nothing is written', async (form) => {
		const vault = makeVault();
		const first = await importInto(vault, sssom(FULL_HEADER), { importSet: 'new-set-qualified', mappingForm: form });
		const setId = first.generation!.importSetId!;
		const snapshot = new Map(vault.written);
		const refused = await importInto(vault, sssom(withVersion('2026.2'), [...ROWS.slice(0, 2)]), { importSet: { id: setId }, mappingForm: form });
		expect(refused.generation?.success).toBe(false);
		expect(refused.generation?.errors.map((error) => error.message)).toEqual([
			`This file declares release ${SET_ID} version 2026.2. This set holds release ${SET_ID} version 2026.1. Import it as a new set.`,
		]);
		expect(vault.written).toEqual(snapshot);
	});

	it('a file declaring a different id is refused against a minted set', async () => {
		const vault = makeVault();
		const first = await importInto(vault, sssom(UNDECLARED_HEADER), { importSet: 'new-set-qualified', mappingForm: 'table' });
		const setId = first.generation!.importSetId!;
		const minted = (await recordOf(vault, setId))!.mapping_set_id;
		const refused = await importInto(vault, sssom(FULL_HEADER), { importSet: { id: setId }, mappingForm: 'table' });
		expect(refused.generation?.errors[0]?.message).toBe(
			`This file declares release ${SET_ID} version 2026.1. This set holds release ${minted} version 2026.1. Import it as a new set.`,
		);
	});
});

describe('conversion carries the record both ways', () => {
	it('notes to table to notes keeps the record deep-equal at each step', async () => {
		const vault = makeVault();
		const imported = await importInto(vault, sssom(FULL_HEADER), { importSet: 'new-set-qualified' });
		const setId = imported.generation!.importSetId!;
		const original = (await recordOf(vault, setId))!;

		const toTable = await startConversion(vault.app, {}, setId, 'table');
		expect(toTable.reason).toBeUndefined();
		expect(toTable.ok).toBe(true);
		expect(vault.setNotes()).toEqual([]);
		const tablePath = toTable.targetPath!;
		const header = parseMappingTable(vault.written.get(tablePath)!).header;
		expect(header.mapping_set_id).toBe(SET_ID);
		expect(header.license).toBe('https://example.test/license');
		expect(await recordOf(vault, setId)).toEqual(original);

		const toNotes = await startConversion(vault.app, {}, setId, 'notes');
		expect(toNotes.reason).toBeUndefined();
		expect(toNotes.ok).toBe(true);
		expect(vault.setNotes()).toHaveLength(1);
		expect(validateTier1Frontmatter(vault.frontmatterOf(vault.setNotes()[0]))).toEqual({ valid: true, errors: [] });
		expect(await recordOf(vault, setId)).toEqual(original);
	});
});

describe('readMappingSet', () => {
	it('returns undefined for a legacy notes set and a legacy table set, and never derives one', async () => {
		const notes = makeVault();
		const imported = await importInto(notes, sssom(FULL_HEADER), { importSet: 'new-set-qualified' });
		for (const path of notes.setNotes()) notes.written.delete(path);
		expect(await recordOf(notes, imported.generation!.importSetId!)).toBeUndefined();

		const table = makeVault();
		const tableImport = await importInto(table, sssom(FULL_HEADER), { importSet: 'new-set-qualified', mappingForm: 'table' });
		const parsed = parseMappingTable(table.written.get(TABLE)!);
		const { mapping_set: _dropped, ...legacyHeader } = parsed.header;
		table.written.set(TABLE, serializeMappingTable(legacyHeader, parsed.rows));
		expect(await recordOf(table, tableImport.generation!.importSetId!)).toBeUndefined();
	});

	it('finds the set note when the metadata cache has not indexed it yet', async () => {
		const vault = makeVault();
		const imported = await importInto(vault, sssom(FULL_HEADER), { importSet: 'new-set-qualified' });
		const setId = imported.generation!.importSetId!;
		const set = await setOf(vault, setId);
		const expected = await readMappingSet(vault.app, set);
		const [setNote] = vault.setNotes();
		vault.cold.add(setNote);
		expect(await readMappingSet(vault.app, set)).toEqual(expected);
		expect(expected).toBeDefined();
	});

	it('finds the set note by kind and import set id after the user renames it', async () => {
		const vault = makeVault();
		const imported = await importInto(vault, sssom(FULL_HEADER), { importSet: 'new-set-qualified' });
		const setId = imported.generation!.importSetId!;
		const [setNote] = vault.setNotes();
		const renamed = `${FOLDER}/Anything at all.md`;
		vault.written.set(renamed, vault.written.get(setNote)!);
		vault.written.delete(setNote);
		expect((await recordOf(vault, setId))?.mapping_set_id).toBe(SET_ID);
		// A refresh rewrites the renamed note in place rather than creating a second one.
		const again = await importInto(vault, sssom(FULL_HEADER), { importSet: { id: setId } });
		expect(again.generation?.success).toBe(true);
		expect(vault.setNotes()).toEqual([renamed]);
	});
});

describe('Tier 1 schema: mapping-set record', () => {
	const sample = {
		kind: 'mapping-set',
		mapping_set_id: SET_ID,
		id_origin: 'declared',
		mapping_set_version: '2026.1',
		creator_id: ['demo:creator-1'],
		assertion_count: 2,
		membership_digest: `sha256-${'a'.repeat(64)}`,
		content_digest: `sha256-${'b'.repeat(64)}`,
		_crosswalker: {
			spec_version: 'https://crosswalker.dev/spec/tier1.schema.json',
			source_ref: { file: 'demo.sssom.tsv' },
			produced_at: '2026-10-03T00:00:00Z',
			import_set: { id: 'iset-abc123', scheme: 'set-qualified-v1' },
		},
	};

	it('validates a sample record', () => {
		expect(validateTier1Frontmatter(sample)).toEqual({ valid: true, errors: [] });
	});

	it('refuses a record without membership_digest, with a bad id_origin, or with a negative count', () => {
		const { membership_digest: _missing, ...noDigest } = sample;
		expect(validateTier1Frontmatter(noDigest).valid).toBe(false);
		expect(validateTier1Frontmatter({ ...sample, id_origin: 'guessed' }).valid).toBe(false);
		expect(validateTier1Frontmatter({ ...sample, assertion_count: -1 }).valid).toBe(false);
	});

	it('does not let a mapping-set record pass as a concept note', () => {
		expect(validateTier1Frontmatter({ kind: 'mapping-set', curie: 'demo-a:X-1', _crosswalker: sample._crosswalker }).valid).toBe(false);
	});
});

describe('M6b: a refresh keeps the id a legacy set already stamped', () => {
	/** The id form the importer minted before release records existed (a byte hash). */
	const OLD_ID = `urn:crosswalker:mapping-set:sha256:${'c'.repeat(64)}`;
	const OTHER_ID = 'https://example.test/mappings/some-other-release';

	it('legacy table set, undeclared file: id and row ids unchanged, reviews carried, record now present', async () => {
		const vault = makeVault();
		const first = await importInto(vault, sssom(UNDECLARED_HEADER), { importSet: 'new-set-qualified', mappingForm: 'table' });
		const setId = first.generation!.importSetId!;
		// Rewrite the table as a legacy one: old byte-hash id, no record, two reviewed rows.
		const parsed = parseMappingTable(vault.written.get(TABLE)!);
		const { mapping_set: _dropped, ...header } = parsed.header;
		const facts = parsed.rows.map(({ row_id: _id, ...row }) => ({
			...row,
			mapping_set_id: OLD_ID,
			...(row.subject_id !== 'demo-a:X-3' ? { review_status: 'approved', reviewer: 'reviewer-1' } : {}),
		}));
		const legacyRows = assignMappingRowIds(facts, OLD_ID);
		vault.written.set(TABLE, serializeMappingTable({ ...header, mapping_set_id: OLD_ID }, legacyRows));
		expect(await recordOf(vault, setId)).toBeUndefined();

		const refreshed = await importInto(vault, sssom(UNDECLARED_HEADER), { importSet: { id: setId }, mappingForm: 'table' });
		expect(refreshed.generation?.errors).toEqual([]);
		expect(refreshed.reviewCarried).toBe(2);
		expect(refreshed.rowsDropped).toBe(0);
		const after = parseMappingTable(vault.written.get(TABLE)!);
		expect(after.header.mapping_set_id).toBe(OLD_ID);
		expect(after.rows.map((row) => row.row_id).sort()).toEqual(legacyRows.map((row) => row.row_id).sort());
		expect(after.rows.filter((row) => row.review_status === 'approved' && row.reviewer === 'reviewer-1')).toHaveLength(2);
		expect(await recordOf(vault, setId)).toMatchObject({ mapping_set_id: OLD_ID, id_origin: 'minted', assertion_count: 3 });
	});

	it('legacy notes set declared under one id refuses a file declaring another, writing nothing', async () => {
		const vault = makeVault();
		const first = await importInto(vault, sssom(FULL_HEADER), { importSet: 'new-set-qualified' });
		const setId = first.generation!.importSetId!;
		for (const path of vault.setNotes()) vault.written.delete(path);
		expect(await recordOf(vault, setId)).toBeUndefined();
		const snapshot = new Map(vault.written);
		const other = FULL_HEADER.map((line) => line.startsWith('# mapping_set_id:') ? `# mapping_set_id: "${OTHER_ID}"` : line);
		const refused = await importInto(vault, sssom(other), { importSet: { id: setId } });
		expect(refused.generation?.success).toBe(false);
		expect(refused.generation?.errors.map((error) => error.message)).toEqual([
			`This file declares release ${OTHER_ID} version 2026.1. This set holds release ${SET_ID}. Import it as a new set.`,
		]);
		expect(vault.written).toEqual(snapshot);
	});

	it('legacy notes set, undeclared file: the stamped id is kept and a record is written', async () => {
		const vault = makeVault();
		const first = await importInto(vault, sssom(UNDECLARED_HEADER), { importSet: 'new-set-qualified' });
		const setId = first.generation!.importSetId!;
		for (const path of vault.setNotes()) vault.written.delete(path);
		// Stamp the old byte-hash id on every mapping note, as an older import did.
		for (const [path, text] of vault.written) {
			if (path.endsWith('.md')) vault.written.set(path, text.replace(/^mapping_set_id: .*$/m, `mapping_set_id: "${OLD_ID}"`));
		}
		expect(await recordOf(vault, setId)).toBeUndefined();

		const refreshed = await importInto(vault, sssom(UNDECLARED_HEADER), { importSet: { id: setId } });
		expect(refreshed.generation?.errors).toEqual([]);
		expect(refreshed.generation?.success).toBe(true);
		expect(await recordOf(vault, setId)).toMatchObject({ mapping_set_id: OLD_ID, id_origin: 'minted', assertion_count: 3 });
		const edgeIds = [...vault.written.keys()]
			.filter((path) => path.endsWith('.md') && vault.frontmatterOf(path)?.kind === 'crosswalk-edge')
			.map((path) => vault.frontmatterOf(path)!.mapping_set_id);
		expect(edgeIds).toEqual([OLD_ID, OLD_ID, OLD_ID]);
	});
});
