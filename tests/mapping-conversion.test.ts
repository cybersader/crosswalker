/**
 * Slice 4 Part A of the mapping table form (2026-09-30): converting a mapping
 * set between notes and a table, resumably, behind an on-disk marker.
 *
 * Synthetic data only: `demo-a:` / `demo-b:` ids.
 */
import type { App } from 'obsidian';
import { TFile, TFolder, parseYaml } from 'obsidian';
import { importSssom, sssomRecipeDigest } from '../src/import/sssom-importer';
import { parseMappingTable, serializeMappingTable } from '../src/mappings/mapping-table';
import { discoverImportSets } from '../src/generation/import-set';
import {
	CONVERSION_MARKER_FORMAT, conversionReadRule, formToReadFor, parseConversionMarker,
	readConversionMarkers, serializeConversionMarker, type ConversionMarker,
} from '../src/mappings/conversion-marker';
import { cancelConversion, resumeConversion, startConversion, type ConversionProgress } from '../src/mappings/mapping-conversion';
import { readVaultTree } from '../src/export/vault-reader';
import { projectFromTier1 } from '../src/tier2/projector';
import { applyMigrations } from '../src/tier2/migrations';

const { DatabaseSync } = require('node:sqlite');

const FOLDER = '_crosswalker/mappings/demo-a-to-demo-b';
const TABLE = `${FOLDER}/demo-a-to-demo-b.mapping-table.tsv`;

function sssom(rows: string[]): string {
	return [
		'# mapping_set_id: "https://example.test/demo-map"',
		'# subject_source: "demo-a"',
		'# object_source: "demo-b"',
		'# mapping_provider: "Demo provider"',
		'subject_id\tsubject_label\tpredicate_id\tobject_id\tobject_label\tmapping_justification\tconfidence',
		...rows,
	].join('\n');
}

const ROWS = [
	'demo-a:X-1\tDemo one\tskos:exactMatch\tdemo-b:Y-1\tTarget one\tsemapv:ManualMappingCuration\t0.9',
	'demo-a:X-2\tDemo two\tskos:relatedMatch\tdemo-b:Y-2\tTarget two\tsemapv:ManualMappingCuration\t0.5',
	'demo-a:X-3\tDemo three\tskos:broadMatch\tdemo-b:Y-3\tTarget three\tsemapv:ManualMappingCuration\t0.7',
];

interface Faults {
	/** Throw from `vault.modify`/`create` when this returns true for (path, content). */
	failWrite?: (path: string, content: string) => boolean;
	/** Throw from `vault.trash` when this returns true for the path. */
	failTrash?: (path: string) => boolean;
	/** Make `adapter.rename` throw, as some synced folders do. */
	renameThrows?: boolean;
}

/** A vault double with real TFile/TFolder handles, both listings, a trash and an adapter. */
function makeVault() {
	const written = new Map<string, string>();
	const folders = new Set<string>();
	const trashed = new Map<string, string>();
	const faults: Faults = {};
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
			adapter: {
				exists: async (path: string) => written.has(path) || folders.has(path),
				mkdir: async (path: string) => { folders.add(path); },
				write: async (path: string, content: string) => { written.set(path, content); },
				read: async (path: string) => {
					if (!written.has(path)) throw new Error('missing');
					return written.get(path)!;
				},
				rename: async (from: string, to: string) => {
					if (faults.renameThrows) throw new Error('rename refused');
					if (!written.has(from)) throw new Error('missing');
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
				if (faults.failWrite?.(path, content)) throw new Error('write interrupted');
				if (written.has(path)) throw new Error('File already exists.');
				written.set(path, content);
				return fileOf(path);
			},
			modify: async (file: { path: string }, content: string) => {
				if (faults.failWrite?.(file.path, content)) throw new Error('write interrupted');
				written.set(file.path, content);
			},
			delete: async (file: { path: string }) => { written.delete(file.path); },
			trash: async (file: { path: string }, system: boolean) => {
				expect(system).toBe(false);
				if (faults.failTrash?.(file.path)) throw new Error('trash interrupted');
				trashed.set(file.path, written.get(file.path)!);
				written.delete(file.path);
			},
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
	// Mapping notes only: the set's release record note (kind: mapping-set, added
	// 2026-10-03) is asserted in mapping-set.test.ts, not counted here.
	const notes = () => [...written.keys()].filter((path) => path.endsWith('.md') && frontmatterOf(path)?.kind !== 'mapping-set').sort();
	return { app, written, folders, trashed, faults, notes, frontmatterOf };
}

type Vault = ReturnType<typeof makeVault>;

async function importNotes(vault: Vault): Promise<string> {
	const result = await importSssom(vault.app, sssom(ROWS), null, null, { runTier2Projection: false, importSet: 'new-set-qualified' });
	expect(result.generation?.success).toBe(true);
	return result.generation!.importSetId!;
}

async function importTable(vault: Vault): Promise<string> {
	const result = await importSssom(vault.app, sssom(ROWS), null, null, { runTier2Projection: false, importSet: 'new-set-qualified', mappingForm: 'table' });
	expect(result.generation?.success).toBe(true);
	return result.generation!.importSetId!;
}

/** Record a review on the note for `subject`, the way a person would in the editor. */
function reviewNote(vault: Vault, subject: string, review: string): void {
	const path = vault.notes().find((candidate) => vault.frontmatterOf(candidate)?.subject_id === subject)!;
	vault.written.set(path, vault.written.get(path)!.replace(/^---\n/, `---\n${review}\n`));
}

/** Record a review on the table row for `subject`, the way a person would in the file. */
function reviewTable(vault: Vault, path: string, subject: string, review: Record<string, unknown>): void {
	const parsed = parseMappingTable(vault.written.get(path)!);
	vault.written.set(path, serializeMappingTable(parsed.header, parsed.rows.map((row) => row.subject_id === subject ? { ...row, ...review } : row)));
}

function markerPath(setId: string): string {
	return `${FOLDER}/${setId}.converting.json`;
}

function markerOn(vault: Vault, setId: string): ConversionMarker | undefined {
	const text = vault.written.get(markerPath(setId));
	return text === undefined ? undefined : parseConversionMarker(text, markerPath(setId)).marker;
}

function setPhase(vault: Vault, setId: string, phase: ConversionMarker['phase']): void {
	const marker = markerOn(vault, setId)!;
	vault.written.set(marker.path, serializeConversionMarker({ ...marker, phase }));
}

/** Review values per subject, read from whichever notes the vault holds. */
function noteReviews(vault: Vault): Record<string, unknown> {
	return Object.fromEntries(vault.notes().map((path) => {
		const fm = vault.frontmatterOf(path) as Record<string, unknown>;
		return [fm.subject_id, { review_status: fm.review_status, reviewer: fm.reviewer, my_notes: fm.my_notes }];
	}));
}

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
			if (input.returnValue === 'resultRows') return Object.keys(bind).length > 0 ? statement.all(bind) : statement.all();
			if (Object.keys(bind).length > 0) statement.run(bind);
			else statement.run();
		},
		close() { sqlite.close(); },
	};
}

function projectedPaths(db: TestDb): string[] {
	return (db.exec({ sql: 'SELECT source_path FROM mappings ORDER BY source_path', rowMode: 'array', returnValue: 'resultRows' }) as unknown[][])
		.map((row) => String(row[0]));
}

describe('conversion marker', () => {
	const good = {
		format: CONVERSION_MARKER_FORMAT, import_set: 'iset-demo12', from: 'notes', to: 'table', phase: 'writing',
		target_path: 'Maps/demo.mapping-table.tsv', source_count: 3, started_at: '2026-09-30T00:00:00.000Z', plugin_version: '0.0.0-test',
	};

	it('round-trips through its file form without writing its own path', () => {
		const parsed = parseConversionMarker(JSON.stringify(good), 'Maps/iset-demo12.converting.json');
		expect(parsed.error).toBeUndefined();
		expect(parsed.marker).toMatchObject({ ...good, path: 'Maps/iset-demo12.converting.json' });
		const text = serializeConversionMarker(parsed.marker!);
		expect(JSON.parse(text)).toEqual(good);
	});

	it('refuses an unknown format, an unknown phase, and a conversion to the same form, naming the fix', () => {
		expect(parseConversionMarker(JSON.stringify({ ...good, format: 'other-v9' }), 'm.converting.json').error)
			.toMatch(/unknown format .* Update the plugin, then finish the conversion\./);
		expect(parseConversionMarker(JSON.stringify({ ...good, phase: 'pondering' }), 'm.converting.json').error)
			.toMatch(/unknown phase .* Update the plugin, then finish the conversion\./);
		expect(parseConversionMarker(JSON.stringify({ ...good, to: 'notes' }), 'm.converting.json').error)
			.toMatch(/converts notes to notes, which is not a conversion\. Delete the marker, then start the conversion again\./);
		expect(parseConversionMarker('{not json', 'm.converting.json').error).toMatch(/is not readable JSON/);
	});

	it('names the form readers use in each phase, through one rule', () => {
		const marker = parseConversionMarker(JSON.stringify(good), 'm.converting.json').marker!;
		expect(formToReadFor({ ...marker, phase: 'writing' })).toBe('notes');
		expect(formToReadFor({ ...marker, phase: 'verifying' })).toBe('notes');
		expect(formToReadFor({ ...marker, phase: 'retiring' })).toBe('table');
		const reads = conversionReadRule([marker]);
		expect(reads('iset-demo12', 'notes')).toBe(true);
		expect(reads('iset-demo12', 'table')).toBe(false);
		expect(reads('iset-other1', 'table')).toBe(true);
		expect(reads(null, 'table')).toBe(true);
	});
});

describe('startConversion notes to table', () => {
	it('writes and verifies the table, trashes the notes, flips the pin, and re-keys the query index', async () => {
		const vault = makeVault();
		const setId = await importNotes(vault);
		reviewNote(vault, 'demo-a:X-1', 'review_status: approved\nreviewer: reviewer-1\nmy_notes: Checked by hand.');
		const notesBefore = vault.notes();
		expect(notesBefore).toHaveLength(3);

		const db = createTestDb();
		applyMigrations(db);
		await projectFromTier1(vault.app, db, { projectionMode: 'full' });
		expect(projectedPaths(db)).toEqual(notesBefore);

		const progress: ConversionProgress[] = [];
		const projection = jest.fn(async () => projectFromTier1(vault.app, db, { projectionMode: 'full' }));
		const closure = jest.fn(async () => 0);
		const result = await startConversion(vault.app, { runProjection: projection, precomputeClosure: closure }, setId, 'table', (p) => progress.push(p));
		expect(result.reason).toBeUndefined();
		expect(result).toMatchObject({
			ok: true, setId, from: 'notes', to: 'table', rows: 3, reviewsCarried: 1,
			targetPath: TABLE, trashed: 4, phaseReached: 'done', warnings: [],
		});
		expect(new Set(progress.map((p) => p.phase))).toEqual(new Set(['writing', 'verifying', 'retiring']));

		// Marker gone, notes in the vault trash (never hard-deleted), one table left.
		expect([...vault.written.keys()]).toEqual([TABLE]);
		expect([...vault.trashed.keys()].sort()).toEqual([...notesBefore, `${FOLDER}/demo-map.md`].sort());
		const table = parseMappingTable(vault.written.get(TABLE)!);
		expect(table.errors).toEqual([]);
		expect(table.rows).toHaveLength(3);
		expect((table.header.crosswalker_provenance!.import_set as Record<string, unknown>)).toMatchObject({ id: setId, mapping_form: 'table', scheme: 'set-qualified-v1' });
		expect((table.header.crosswalker_provenance!.recipe as Record<string, unknown>).hash).toBe(sssomRecipeDigest('demo-a', 'demo-b'));
		expect(table.rows.find((row) => row.subject_id === 'demo-a:X-1')).toMatchObject({
			review_status: 'approved', reviewer: 'reviewer-1', notes: { my_notes: 'Checked by hand.' }, confidence: '0.9',
		});
		// Engine-regenerated fields are not carried as user fields.
		expect(table.rows.every((row) => row.extra === undefined)).toBe(true);

		const [set] = await discoverImportSets(vault.app);
		expect(set).toMatchObject({ id: setId, mapping_form: 'table', rowCount: 3, noteCount: 0, paths: [TABLE] });
		expect(set.converting).toBeUndefined();
		expect(projection).toHaveBeenCalledTimes(1);
		expect(closure).toHaveBeenCalledWith('demo-a', 'demo-b');
		expect(projectedPaths(db)).toEqual(table.rows.map((row) => `${TABLE}#${row.row_id}`).sort());
		db.close();
	});

	it('falls back to an in-place write when the folder refuses a rename', async () => {
		const vault = makeVault();
		const setId = await importNotes(vault);
		vault.faults.renameThrows = true;
		const result = await startConversion(vault.app, {}, setId, 'table');
		expect(result.ok).toBe(true);
		expect([...vault.written.keys()]).toEqual([TABLE]);
	});
});

describe('startConversion table to notes', () => {
	it('regenerates the notes through the engine, keeps every review, trashes the table, and records notes by absence', async () => {
		const vault = makeVault();
		const setId = await importTable(vault);
		reviewTable(vault, TABLE, 'demo-a:X-2', { review_status: 'in_review', reviewer: 'reviewer-2', notes: { my_notes: 'Needs a second look.' } });

		const result = await startConversion(vault.app, {}, setId, 'notes');
		expect(result).toMatchObject({ ok: true, from: 'table', to: 'notes', rows: 3, reviewsCarried: 1, targetPath: FOLDER, trashed: 1, phaseReached: 'done' });
		expect(vault.trashed.has(TABLE)).toBe(true);
		expect(vault.written.has(TABLE)).toBe(false);
		expect(vault.notes()).toHaveLength(3);
		expect([...vault.written.keys()].filter((path) => !path.endsWith('.md'))).toEqual([]);

		const reviewed = vault.notes().map((path) => vault.frontmatterOf(path) as Record<string, any>).find((fm) => fm.subject_id === 'demo-a:X-2')!;
		expect(reviewed).toMatchObject({ review_status: 'in_review', reviewer: 'reviewer-2', my_notes: 'Needs a second look.', kind: 'crosswalk-edge' });
		expect(reviewed._crosswalker.import_set).toMatchObject({ id: setId, scheme: 'set-qualified-v1' });
		expect(reviewed._crosswalker.import_set.mapping_form).toBeUndefined();
		// The set's own import recipe is recorded, so a later refresh is not refused as "recipe changed".
		expect(reviewed._crosswalker.recipe).toEqual({ id: 'sssom-demo-a-to-demo-b', hash: sssomRecipeDigest('demo-a', 'demo-b') });

		const [set] = await discoverImportSets(vault.app);
		expect(set).toMatchObject({ id: setId, mapping_form: 'notes', noteCount: 4 });
		expect(set.converting).toBeUndefined();

		// The converted set refreshes as notes and keeps its reviews.
		const refreshed = await importSssom(vault.app, sssom(ROWS), null, null, { runTier2Projection: false, importSet: { id: setId }, outputFolder: FOLDER });
		expect(refreshed.generation?.errors).toEqual([]);
		expect(vault.notes()).toHaveLength(3);
		expect(noteReviews(vault)['demo-a:X-2']).toEqual({ review_status: 'in_review', reviewer: 'reviewer-2', my_notes: 'Needs a second look.' });
	});

	it('round trip notes to table to notes leaves every review value equal', async () => {
		const vault = makeVault();
		const setId = await importNotes(vault);
		reviewNote(vault, 'demo-a:X-1', 'review_status: approved\nreviewer: reviewer-1\nmy_notes: Checked by hand.');
		reviewNote(vault, 'demo-a:X-3', 'review_status: deprecated\nreviewer_notes: Superseded upstream.');
		const before = noteReviews(vault);

		expect((await startConversion(vault.app, {}, setId, 'table')).reason).toBeUndefined();
		const back = await startConversion(vault.app, {}, setId, 'notes');
		expect(back.reason).toBeUndefined();
		expect(back.reviewsCarried).toBe(2);
		expect(noteReviews(vault)).toEqual(before);
		const deprecated = vault.notes().map((path) => vault.frontmatterOf(path) as Record<string, unknown>).find((fm) => fm.subject_id === 'demo-a:X-3')!;
		expect(deprecated.reviewer_notes).toBe('Superseded upstream.');
	});
});

describe('interruption and resume', () => {
	it('notes to table: an interruption after the table is written resumes without a second table', async () => {
		const vault = makeVault();
		const setId = await importNotes(vault);
		let once = true;
		vault.faults.failWrite = (path, content) => {
			if (once && path.endsWith('.converting.json') && content.includes('"phase": "verifying"')) { once = false; return true; }
			return false;
		};
		const first = await startConversion(vault.app, {}, setId, 'table');
		expect(first.ok).toBe(false);
		expect(first.phaseReached).toBe('writing');
		expect(first.reason).toMatch(new RegExp(`Converting import set ${setId} to a table was interrupted while writing: write interrupted\\. Fix the cause, then finish the conversion\\.`));
		expect(markerOn(vault, setId)?.phase).toBe('writing');
		expect(vault.written.has(TABLE)).toBe(true);
		expect(vault.notes()).toHaveLength(3);

		// Mid-job, discovery reads the source form and never refuses the set as both forms.
		const [mid] = await discoverImportSets(vault.app);
		expect(mid).toMatchObject({ id: setId, mapping_form: 'notes', noteCount: 4, converting: { to: 'table', phase: 'writing' } });

		const [marker] = await readConversionMarkers(vault.app);
		const resumed = await resumeConversion(vault.app, {}, marker);
		expect(resumed).toMatchObject({ ok: true, phaseReached: 'done', rows: 3, trashed: 4 });
		expect([...vault.written.keys()]).toEqual([TABLE]);
	});

	it('table to notes: an interruption after the notes are written resumes without duplicating a note', async () => {
		const vault = makeVault();
		const setId = await importTable(vault);
		let once = true;
		vault.faults.failWrite = (path, content) => {
			if (once && path.endsWith('.converting.json') && content.includes('"phase": "verifying"')) { once = false; return true; }
			return false;
		};
		const first = await startConversion(vault.app, {}, setId, 'notes');
		expect(first.ok).toBe(false);
		expect(vault.notes()).toHaveLength(3);
		const [mid] = await discoverImportSets(vault.app);
		expect(mid).toMatchObject({ mapping_form: 'table', noteCount: 0, rowCount: 3, converting: { to: 'notes', phase: 'writing' } });

		const resumed = await resumeConversion(vault.app, {}, markerOn(vault, setId)!);
		expect(resumed.ok).toBe(true);
		expect(vault.notes()).toHaveLength(3);
		expect(vault.written.has(TABLE)).toBe(false);
	});

	it('an interruption while retiring resumes by trashing the rest; cancel is refused there', async () => {
		const vault = makeVault();
		const setId = await importNotes(vault);
		let trashCalls = 0;
		vault.faults.failTrash = () => ++trashCalls === 2;
		const first = await startConversion(vault.app, {}, setId, 'table');
		expect(first).toMatchObject({ ok: false, phaseReached: 'retiring', trashed: 1 });
		expect(markerOn(vault, setId)?.phase).toBe('retiring');
		expect(vault.notes()).toHaveLength(2);

		// While retiring, readers use the verified table and ignore the leftover notes.
		const [mid] = await discoverImportSets(vault.app);
		expect(mid).toMatchObject({ mapping_form: 'table', rowCount: 3, noteCount: 0, converting: { to: 'table', phase: 'retiring' } });

		await expect(cancelConversion(vault.app, markerOn(vault, setId)!)).rejects.toThrow(/past the point where it can be cancelled.*Finish the conversion instead\./);
		expect(markerOn(vault, setId)).toBeDefined();

		vault.faults.failTrash = undefined;
		const resumed = await resumeConversion(vault.app, {}, markerOn(vault, setId)!);
		expect(resumed).toMatchObject({ ok: true, trashed: 3, rows: 3 });
		expect(vault.notes()).toEqual([]);
		expect(vault.trashed.size).toBe(4);
		expect(markerOn(vault, setId)).toBeUndefined();
	});

	it('a second start on a converting set refuses and says to finish it', async () => {
		const vault = makeVault();
		const setId = await importNotes(vault);
		vault.faults.failWrite = (path, content) => path.endsWith('.converting.json') && content.includes('"phase": "verifying"');
		await startConversion(vault.app, {}, setId, 'table');
		vault.faults.failWrite = undefined;
		const again = await startConversion(vault.app, {}, setId, 'table');
		expect(again).toMatchObject({ ok: false, phaseReached: 'not-started' });
		expect(again.reason).toBe(`Import set ${setId} is already being converted to a table. Finish that conversion instead of starting a new one.`);
	});

	it('refuses a missing set and a set already in the requested form', async () => {
		const vault = makeVault();
		expect((await startConversion(vault.app, {}, 'iset-none00', 'table')).reason)
			.toBe('Import set iset-none00 was not found in the vault. Import the mapping file first, then convert it.');
		const setId = await importTable(vault);
		expect((await startConversion(vault.app, {}, setId, 'table')).reason)
			.toBe(`Import set ${setId} already stores its mappings as a table. Nothing needs converting.`);
	});
});

describe('parity check', () => {
	it('notes to table: a table changed before verification stops at writing with the source untouched', async () => {
		const vault = makeVault();
		const setId = await importNotes(vault);
		const notes = new Map(vault.notes().map((path) => [path, vault.written.get(path)]));
		let mutated = false;
		const result = await startConversion(vault.app, {}, setId, 'table', (progress) => {
			if (progress.phase === 'verifying' && !mutated) {
				mutated = true;
				reviewTable(vault, TABLE, 'demo-a:X-2', { review_status: 'approved' });
			}
		});
		expect(result.ok).toBe(false);
		expect(result.phaseReached).toBe('writing');
		expect(result.reason).toBe(`Converting import set ${setId} to a table stopped because the written table does not match the notes: mapping demo-a:X-2 -> demo-b:Y-2 has a different review_status in the table. Nothing was moved to the trash. Finish the conversion to write them again, or cancel it.`);
		expect(markerOn(vault, setId)?.phase).toBe('writing');
		for (const [path, content] of notes) expect(vault.written.get(path)).toBe(content);
		expect(vault.trashed.size).toBe(0);

		// Finishing rewrites the table from the notes and completes.
		expect((await resumeConversion(vault.app, {}, markerOn(vault, setId)!)).ok).toBe(true);
		expect(parseMappingTable(vault.written.get(TABLE)!).rows.find((row) => row.subject_id === 'demo-a:X-2')!.review_status).toBeUndefined();
	});

	it('table to notes: a note changed before verification stops at writing with the table untouched', async () => {
		const vault = makeVault();
		const setId = await importTable(vault);
		const tableBefore = vault.written.get(TABLE);
		let mutated = false;
		const result = await startConversion(vault.app, {}, setId, 'notes', (progress) => {
			if (progress.phase === 'verifying' && !mutated) {
				mutated = true;
				reviewNote(vault, 'demo-a:X-1', 'reviewer: someone-else');
			}
		});
		expect(result.ok).toBe(false);
		expect(result.phaseReached).toBe('writing');
		expect(result.reason).toMatch(new RegExp(`^Converting import set ${setId} to notes stopped because the written notes do not match the table: mapping demo-a:X-1 -> demo-b:Y-1 has a different reviewer in the notes\\. Nothing was moved to the trash\\.`));
		expect(vault.written.get(TABLE)).toBe(tableBefore);
		expect(markerOn(vault, setId)?.phase).toBe('writing');
	});
});

describe('cancel', () => {
	it('in writing, trashes the target and deletes the marker, leaving a clean source-only set', async () => {
		const vault = makeVault();
		const setId = await importNotes(vault);
		vault.faults.failWrite = (path, content) => path.endsWith('.converting.json') && content.includes('"phase": "verifying"');
		await startConversion(vault.app, {}, setId, 'table');
		vault.faults.failWrite = undefined;
		expect(vault.written.has(TABLE)).toBe(true);

		await cancelConversion(vault.app, markerOn(vault, setId)!);
		expect(vault.written.has(TABLE)).toBe(false);
		expect(vault.trashed.has(TABLE)).toBe(true);
		expect(markerOn(vault, setId)).toBeUndefined();
		expect(vault.notes()).toHaveLength(3);
		const [set] = await discoverImportSets(vault.app);
		expect(set).toMatchObject({ mapping_form: 'notes', noteCount: 4 });
		expect(set.converting).toBeUndefined();
	});

	it('table to notes in writing: trashes the written notes and keeps the table', async () => {
		const vault = makeVault();
		const setId = await importTable(vault);
		vault.faults.failWrite = (path, content) => path.endsWith('.converting.json') && content.includes('"phase": "verifying"');
		await startConversion(vault.app, {}, setId, 'notes');
		vault.faults.failWrite = undefined;
		expect(vault.notes()).toHaveLength(3);
		await cancelConversion(vault.app, markerOn(vault, setId)!);
		expect(vault.notes()).toEqual([]);
		expect(vault.written.has(TABLE)).toBe(true);
		const [set] = await discoverImportSets(vault.app);
		expect(set).toMatchObject({ mapping_form: 'table', rowCount: 3 });
	});
});

describe('readers honour the marker in each phase', () => {
	it('discovery, export and projection read the source until retiring, then the target', async () => {
		const vault = makeVault();
		const setId = await importNotes(vault);
		const notePaths = vault.notes();
		vault.faults.failWrite = (path, content) => path.endsWith('.converting.json') && content.includes('"phase": "verifying"');
		await startConversion(vault.app, {}, setId, 'table');
		vault.faults.failWrite = undefined;
		const rowIds = parseMappingTable(vault.written.get(TABLE)!).rows.map((row) => `${TABLE}#${row.row_id}`).sort();
		const db = createTestDb();
		applyMigrations(db);

		for (const phase of ['writing', 'verifying'] as const) {
			setPhase(vault, setId, phase);
			const [set] = await discoverImportSets(vault.app);
			expect(set).toMatchObject({ mapping_form: 'notes', noteCount: 4, converting: { to: 'table', phase } });
			const tree = await readVaultTree(vault.app, FOLDER);
			expect(tree.crosswalkEdges.map((edge) => edge.path)).toEqual(notePaths);
			expect(tree.skipped.map((entry) => entry.path)).toContain(TABLE);
			const projection = await projectFromTier1(vault.app, db, { projectionMode: 'full' });
			expect(projection.success).toBe(true);
			expect(projectedPaths(db)).toEqual(notePaths);
		}

		setPhase(vault, setId, 'retiring');
		const [set] = await discoverImportSets(vault.app);
		expect(set).toMatchObject({ mapping_form: 'table', noteCount: 0, rowCount: 3, converting: { to: 'table', phase: 'retiring' } });
		const tree = await readVaultTree(vault.app, FOLDER);
		expect(tree.crosswalkEdges.map((edge) => edge.path)).toEqual(rowIds);
		await projectFromTier1(vault.app, db, { projectionMode: 'full' });
		expect(projectedPaths(db)).toEqual(rowIds);
		db.close();
	});
});

describe('review findings 2026-09-30', () => {
	/** Interrupt a notes-to-table job after the table is written, leaving both forms and a marker in writing. */
	async function interruptedToTable(vault: Vault): Promise<string> {
		const setId = await importNotes(vault);
		vault.faults.failWrite = (path, content) => path.endsWith('.converting.json') && content.includes('"phase": "verifying"');
		await startConversion(vault.app, {}, setId, 'table');
		vault.faults.failWrite = undefined;
		expect(vault.written.has(TABLE)).toBe(true);
		expect(vault.notes()).toHaveLength(3);
		return setId;
	}

	function notePathFor(vault: Vault, subject: string): string {
		return vault.notes().find((candidate) => vault.frontmatterOf(candidate)?.subject_id === subject)!;
	}

	it('an unusable marker blocks both forms in the read rule', () => {
		const reads = conversionReadRule([], [{ setIds: ['iset-demo12'] }]);
		expect(reads('iset-demo12', 'notes')).toBe(false);
		expect(reads('iset-demo12', 'table')).toBe(false);
		expect(reads('iset-other1', 'notes')).toBe(true);
	});

	it('projection fails closed on a marker it cannot read: neither form projected, last good rows kept', async () => {
		const vault = makeVault();
		const setId = await interruptedToTable(vault);
		const db = createTestDb();
		applyMigrations(db);
		expect((await projectFromTier1(vault.app, db, { projectionMode: 'full' })).success).toBe(true);
		const before = projectedPaths(db);
		expect(before).toEqual(vault.notes());

		vault.written.set(markerPath(setId), JSON.stringify({ format: 'crosswalker-conversion-v2' }));
		const result = await projectFromTier1(vault.app, db, { projectionMode: 'full' });
		expect(result.success).toBe(false);
		expect(result.counts.mappings).toBe(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].vault_path).toBe(markerPath(setId));
		expect(result.errors[0].message).toMatch(new RegExp(`unknown format .*Update the plugin, then finish the conversion\\. Until then, the mappings of import set ${setId} are left out of the query database\\.`));
		// No prune ran, so the set's last good projection is intact, not doubled.
		expect(projectedPaths(db)).toEqual(before);
		db.close();
	});

	it('a fresh projection with an unreadable marker projects no row of the set', async () => {
		const vault = makeVault();
		const setId = await interruptedToTable(vault);
		vault.written.set(markerPath(setId), '{not json');
		const db = createTestDb();
		applyMigrations(db);
		const result = await projectFromTier1(vault.app, db, { projectionMode: 'full' });
		expect(result.success).toBe(false);
		expect(projectedPaths(db)).toEqual([]);
		db.close();
	});

	it('export fails closed on a marker it cannot read, naming the marker and the action', async () => {
		const vault = makeVault();
		const setId = await interruptedToTable(vault);
		vault.written.set(markerPath(setId), JSON.stringify({ format: 'crosswalker-conversion-v2' }));
		const tree = await readVaultTree(vault.app, FOLDER);
		expect(tree.crosswalkEdges).toEqual([]);
		const marker = tree.skipped.find((entry) => entry.path === markerPath(setId))!;
		expect(marker.reason).toMatch(new RegExp(`Update the plugin, then finish the conversion\\. Until then, neither form of import set ${setId} is exported\\.`));
		const skippedPaths = tree.skipped.map((entry) => entry.path);
		for (const path of [...vault.notes(), TABLE]) expect(skippedPaths).toContain(path);
	});

	it('notes to table refuses a note with its own tag, before any write', async () => {
		const vault = makeVault();
		const setId = await importNotes(vault);
		const path = vault.notes()[0];
		const tagsBefore = (vault.frontmatterOf(path) as Record<string, unknown>).tags as string[];
		const tagged = vault.written.get(path)!.replace(/^tags:\n((?:\s+- .*\n)+)/m, (all) => `${all}  - my-review-tag\n`);
		expect(tagged).not.toBe(vault.written.get(path));
		vault.written.set(path, tagged);
		expect((vault.frontmatterOf(path) as Record<string, unknown>).tags).toEqual([...tagsBefore, 'my-review-tag']);

		const result = await startConversion(vault.app, {}, setId, 'table');
		expect(result).toMatchObject({ ok: false, phaseReached: 'not-started' });
		expect(result.reason).toBe(`Note ${path} in import set ${setId} has different tags from the other mappings, and a table stores one tag list for the whole set. Remove the extra tag or tag change from ${path}, then convert again.`);
		expect(markerOn(vault, setId)).toBeUndefined();
		expect(vault.written.has(TABLE)).toBe(false);
		expect(vault.trashed.size).toBe(0);
	});

	it('notes to table refuses a renamed title, before any write', async () => {
		const vault = makeVault();
		const setId = await importNotes(vault);
		const path = notePathFor(vault, 'demo-a:X-2');
		vault.written.set(path, vault.written.get(path)!.replace(/^title: .*$/m, 'title: My renamed mapping'));
		expect((vault.frontmatterOf(path) as Record<string, unknown>).title).toBe('My renamed mapping');
		const result = await startConversion(vault.app, {}, setId, 'table');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(`Note ${path} in import set ${setId} has its own title, which a table cannot store. Change the title back to "demo-a:X-2 -> demo-b:Y-2", then convert again.`);
		expect(markerOn(vault, setId)).toBeUndefined();
		expect(vault.trashed.size).toBe(0);
	});

	it('notes to table refuses a list property the reverse direction could not carry, so a conversion is always reversible', async () => {
		const vault = makeVault();
		const setId = await importNotes(vault);
		reviewNote(vault, 'demo-a:X-2', 'aliases:\n  - Alt name');
		const path = notePathFor(vault, 'demo-a:X-2');
		const result = await startConversion(vault.app, {}, setId, 'table');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(`Note ${path} in import set ${setId} has a field aliases that is not text, which the notes form cannot carry yet. Make it text or remove it from the note, then convert again.`);
		expect(markerOn(vault, setId)).toBeUndefined();
		expect(vault.notes()).toHaveLength(3);
		expect(vault.trashed.size).toBe(0);
	});

	it('table to notes refuses an empty user field and carries a filled one through a round trip', async () => {
		const vault = makeVault();
		const setId = await importTable(vault);
		reviewTable(vault, TABLE, 'demo-a:X-1', { extra: { custom_flag: '', 'my field': 'kept?' } });
		const refused = await startConversion(vault.app, {}, setId, 'notes');
		expect(refused.ok).toBe(false);
		expect(refused.reason).toBe(`Mapping demo-a:X-1 -> demo-b:Y-1 in import set ${setId} has an empty field custom_flag, which the notes form cannot carry. Fill it in or remove it from the row, then convert again.`);
		expect(markerOn(vault, setId)).toBeUndefined();
		expect(vault.notes()).toEqual([]);

		reviewTable(vault, TABLE, 'demo-a:X-1', { extra: { 'my field': 'kept?' } });
		expect((await startConversion(vault.app, {}, setId, 'notes')).reason).toBeUndefined();
		const note = vault.frontmatterOf(notePathFor(vault, 'demo-a:X-1')) as Record<string, unknown>;
		expect(note['my field']).toBe('kept?');
		expect((await startConversion(vault.app, {}, setId, 'table')).reason).toBeUndefined();
		const back = parseMappingTable(vault.written.get(TABLE)!);
		expect(back.rows.find((row) => row.subject_id === 'demo-a:X-1')!.extra).toEqual({ 'my field': 'kept?' });
	});

	it('parity fails when a user field differs between the forms', async () => {
		const vault = makeVault();
		const setId = await importTable(vault);
		reviewTable(vault, TABLE, 'demo-a:X-1', { extra: { custom_flag: 'kept' } });
		const tableBefore = vault.written.get(TABLE);
		let mutated = false;
		const result = await startConversion(vault.app, {}, setId, 'notes', (progress) => {
			if (progress.phase === 'verifying' && !mutated) {
				mutated = true;
				const path = notePathFor(vault, 'demo-a:X-1');
				const text = vault.written.get(path)!;
				expect(text).toMatch(/^custom_flag: /m);
				vault.written.set(path, text.replace(/^custom_flag: .*\n/m, ''));
			}
		});
		expect(result.ok).toBe(false);
		expect(result.phaseReached).toBe('writing');
		expect(result.reason).toContain('mapping demo-a:X-1 -> demo-b:Y-1 has different other fields in the notes');
		expect(vault.written.get(TABLE)).toBe(tableBefore);
		expect(vault.trashed.size).toBe(0);
	});

	it('table to notes refuses two rows for the same subject and object before any write', async () => {
		const vault = makeVault();
		const duplicate = ['demo-a:X-1', 'Demo one', 'skos:exactMatch', 'demo-b:Y-1', 'Target one', 'semapv:LexicalMatching', '0.4'].join('\t');
		const imported = await importSssom(vault.app, sssom([...ROWS, duplicate]), null, null,
			{ runTier2Projection: false, importSet: 'new-set-qualified', mappingForm: 'table' });
		expect(imported.generation?.success).toBe(true);
		const setId = imported.generation!.importSetId!;
		const rows = parseMappingTable(vault.written.get(TABLE)!).rows.filter((row) => row.subject_id === 'demo-a:X-1');
		expect(rows).toHaveLength(2);
		const converted = await startConversion(vault.app, {}, setId, 'notes');
		expect(converted).toMatchObject({ ok: false, phaseReached: 'not-started' });
		expect(converted.reason).toBe(`Rows row ${rows[0].row_id} and row ${rows[1].row_id} of import set ${setId} both map demo-a:X-1 to demo-b:Y-1, and the notes form keeps one note for each subject and object pair. Keep this set as a table, or remove one of the two rows, then convert again.`);
		expect(markerOn(vault, setId)).toBeUndefined();
		expect(vault.notes()).toEqual([]);
	});

	it('a failed notes write reports its cause without a doubled period', async () => {
		const vault = makeVault();
		const setId = await importTable(vault);
		const generate = jest.fn(async () => ({ success: false, errors: [{ message: 'The disk is full.' }] }));
		const result = await startConversion(vault.app, { generateFromRecipe: generate as never }, setId, 'notes');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(`Converting import set ${setId} to notes stopped while writing notes: The disk is full. Nothing was moved to the trash. Fix the cause, then finish the conversion, or cancel it.`);
	});
});
