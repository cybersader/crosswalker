/**
 * Slice 4 Part A of the mapping table form (2026-09-30): converting a mapping
 * set between notes and a table, resumably, behind an on-disk marker.
 *
 * Synthetic data only: `demo-a:` / `demo-b:` ids.
 */
import type { App } from 'obsidian';
import { TFile, TFolder, parseYaml } from 'obsidian';
import { importSssom, sssomRecipeDigest, buildSyntheticRecipe, LEGACY_SSSOM_FILE_TEMPLATE, READABLE_SSSOM_FILE_TEMPLATE } from '../src/import/sssom-importer';
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

import * as engine from '../src/generation/generation-engine';
import * as hashes from '../src/generation/hash';
import { renderTemplate } from '../src/render';

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
 beforeProcess?: (path: string) => void;
	/** Throw from `vault.modify`/`create` when this returns true for (path, content). */
	failWrite?: (path: string, content: string) => boolean;
	/** Throw from `vault.trash` when this returns true for the path. */
	failTrash?: (path: string) => boolean;
	/** Make `adapter.rename` throw, as some synced folders do. */
	renameThrows?: boolean;
}

/**
 * Every written path except the recipe copy each import keeps under
 * `_crosswalker/import-sets/`, whose originals conversion verifies but never retires.
 */
function writtenExceptRecipeCopies(vault: { written: Map<string, unknown> }): string[] {
	return [...vault.written.keys()].filter((path) => !path.startsWith('_crosswalker/import-sets/'));
}

/** A vault double with real TFile/TFolder handles, both listings, a trash and an adapter. */
function makeVault() {
	const written = new Map<string, string>();
	const folders = new Set<string>();
	const trashed = new Map<string, string>();
	const faults: Faults = {};
	const fileOf = (path: string) => Object.assign(new TFile(path), { stat: { mtime: 0, size: Buffer.byteLength(written.get(path) ?? '', 'utf8') }, extension: path.split('.').pop() });
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
			process: async (file: { path: string }, transform: (text: string) => string) => {
				faults.beforeProcess?.(file.path);
				const current = written.get(file.path); if (current === undefined) throw new Error('missing');
				const content = transform(current); if (faults.failWrite?.(file.path, content)) throw new Error('write interrupted');
				written.set(file.path, content); return content;
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
		await applyMigrations(db);
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
		expect(writtenExceptRecipeCopies(vault)).toEqual([TABLE]);
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

	it('creates a new table without using a replacement rename', async () => {
		const vault = makeVault();
		const setId = await importNotes(vault);
		vault.faults.renameThrows = true;
		const rename = jest.spyOn(vault.app.vault.adapter, 'rename');
		const result = await startConversion(vault.app, {}, setId, 'table');
		expect(rename).not.toHaveBeenCalled();
		expect(result.ok).toBe(true);
		expect(writtenExceptRecipeCopies(vault)).toEqual([TABLE]);
	});
});

describe('startConversion table to notes', () => {
	it('regenerates the notes through the engine, keeps every review, trashes the table, and records notes by absence', async () => {
		const vault = makeVault();
		const setId = await importTable(vault);
		const originalRecipe = parseMappingTable(vault.written.get(TABLE)!).header.crosswalker_provenance!.recipe;
		const originalCopies = new Map([...vault.written].filter(([path]) => path.includes('/recipe-')));
		reviewTable(vault, TABLE, 'demo-a:X-2', { review_status: 'in_review', reviewer: 'reviewer-2', notes: { my_notes: 'Needs a second look.' } });

		const result = await startConversion(vault.app, {}, setId, 'notes');
		expect(result).toMatchObject({ ok: true, from: 'table', to: 'notes', rows: 3, reviewsCarried: 1, targetPath: FOLDER, trashed: 1, phaseReached: 'done' });
		expect(vault.trashed.has(TABLE)).toBe(true);
		expect(vault.written.has(TABLE)).toBe(false);
		expect(vault.notes()).toHaveLength(3);
		expect(writtenExceptRecipeCopies(vault).filter((path) => !path.endsWith('.md'))).toEqual([]);

		const reviewed = vault.notes().map((path) => vault.frontmatterOf(path) as Record<string, any>).find((fm) => fm.subject_id === 'demo-a:X-2')!;
		expect(reviewed).toMatchObject({ review_status: 'in_review', reviewer: 'reviewer-2', my_notes: 'Needs a second look.', kind: 'crosswalk-edge' });
		expect(reviewed._crosswalker.import_set).toMatchObject({ id: setId, scheme: 'set-qualified-v1' });
		expect(reviewed._crosswalker.import_set.mapping_form).toBeUndefined();
		// The set's own import recipe is recorded, so a later refresh is not refused as "recipe changed".
		expect(reviewed._crosswalker.recipe).toEqual(originalRecipe);
		expect(new Map([...vault.written].filter(([path]) => path.includes('/recipe-')))).toEqual(originalCopies);
		const { readImportSetRecipe, vaultImportSetRecipeFiles } = await import('../src/import/import-set-recipes');
		expect(await readImportSetRecipe(vaultImportSetRecipeFiles(vault.app)!, setId, String((originalRecipe as Record<string, unknown>).recipe_document_digest))).not.toBeNull();

		const [set] = await discoverImportSets(vault.app);
		expect(set).toMatchObject({ id: setId, mapping_form: 'notes', noteCount: 4 });
		expect(set.converting).toBeUndefined();

		// The converted set refreshes as notes and keeps its reviews.
		const refreshed = await importSssom(vault.app, sssom(ROWS), null, null, { runTier2Projection: false, importSet: { id: setId }, outputFolder: FOLDER });
		expect(refreshed.generation?.errors).toEqual([]);
		expect(vault.notes()).toHaveLength(3);
		expect(noteReviews(vault)['demo-a:X-2']).toEqual({ review_status: 'in_review', reviewer: 'reviewer-2', my_notes: 'Needs a second look.' });
		for (const path of vault.notes()) expect(vault.frontmatterOf(path)._crosswalker.recipe).toEqual(originalRecipe);
		expect(new Map([...vault.written].filter(([path]) => path.includes('/recipe-')))).toEqual(originalCopies);
	});

	// Prevents: the conversion filing its transport recipe as a second copy, or rewriting the set's kept original.
	it('leaves a kept recipe copy byte-identical and adds no new recipe copy', async () => {
		const vault = makeVault();
		const setId = await importTable(vault);
		const setFolder = `_crosswalker/import-sets/${setId}`;
		const recipeCopies = () => [...vault.written.keys()].filter((path) => path.startsWith(`${setFolder}/recipe-`) && path.endsWith('.json')).sort();
		const kept = `${setFolder}/recipe-sha256-${'d'.repeat(64)}.json`;
		const keptBytes = '{"recipe":"sssom-demo-a-to-demo-b","note":"synthetic kept copy"}\n';
		vault.written.set(kept, keptBytes);
		const beforeCopies = new Map(recipeCopies().map(path => [path, vault.written.get(path)]));

		const result = await startConversion(vault.app, {}, setId, 'notes');
		expect(result).toMatchObject({ ok: true, from: 'table', to: 'notes', phaseReached: 'done' });
		expect(vault.notes()).toHaveLength(3);
		expect(vault.written.get(kept)).toBe(keptBytes);
		expect(new Map(recipeCopies().map(path => [path, vault.written.get(path)]))).toEqual(beforeCopies);
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

describe('stamped original continuity and recovery', () => {
	it.each(['source-shaping', 'body-input', 'managed-input', 'enrichment'] as const)('rejects unsupported %s before creating a marker', async dependency => {
		const vault = makeVault(); const setId = await importTable(vault);
		const { normalizeRecipe, serializeCanonicalRecipe } = await import('../src/import/recipe-document');
		const { computeRecipeDocumentDigest, computeRecipeHash } = await import('../src/generation/hash');
		const { buildSyntheticRecipe } = await import('../src/import/sssom-importer');
		const { importSetRecipePath } = await import('../src/import/import-set-recipes');
		const original = normalizeRecipe(buildSyntheticRecipe('demo-a', 'demo-b'));
		if (dependency === 'source-shaping') original.source.where = 'true';
		if (dependency === 'body-input') original.target.also_emit!.body![0].template = '{unavailable_column|optional}';
		if (dependency === 'managed-input') original.target.also_emit!.frontmatter!.managed!.title = '{unavailable_column|optional}';
		if (dependency === 'enrichment') original.target.enrichment = { parent_links: true };
		const digest = computeRecipeDocumentDigest(original);
		vault.written.set(importSetRecipePath(setId, digest)!, serializeCanonicalRecipe(original));
		const parsed = parseMappingTable(vault.written.get(TABLE)!);
		parsed.header.crosswalker_provenance!.recipe = { id: original.recipe, hash: computeRecipeHash(original.target, original.source), recipe_document_digest: digest };
		vault.written.set(TABLE, serializeMappingTable(parsed.header, parsed.rows));
		const before = new Map(vault.written);
		const result = await startConversion(vault.app, {}, setId, 'notes');
		expect(result.ok).toBe(false); expect(result.phaseReached).toBe('not-started'); expect(result.reason).toMatch(/original mapping recipe cannot be converted/);
		expect(vault.written).toEqual(before); expect(vault.trashed.size).toBe(0); expect(markerOn(vault, setId)).toBeUndefined();
	});
	it.each(['notes', 'table'] as const)('does not retire corrupt non-authoritative %s source artifacts', async from => {
		const vault = makeVault(); const setId = from === 'notes' ? await importNotes(vault) : await importTable(vault);
		const to = from === 'notes' ? 'table' : 'notes';
		await startConversion(vault.app, {}, setId, to, progress => { if (progress.phase === 'retiring') throw new Error('Synthetic stop'); });
		if (from === 'notes') {
			const path = vault.notes()[0]; vault.written.set(path, vault.written.get(path)!.replace(/hash: sha256-[a-f0-9]{64}/, 'hash: corrupt'));
		} else {
			const parsed = parseMappingTable(vault.written.get(TABLE)!); vault.written.set(TABLE, serializeMappingTable(parsed.header, [...parsed.rows, parsed.rows[0]]));
		}
		const before = new Map(vault.written);
		const resumed = await resumeConversion(vault.app, {}, markerOn(vault, setId)!);
		expect(resumed.ok).toBe(false); expect(resumed.phaseReached).toBe('retiring'); expect(vault.written).toEqual(before); expect(vault.trashed.size).toBe(0);
	});
	it.each(['notes', 'table'] as const)('blocks a changed %s conversion marker without mutation', async from => {
		const vault = makeVault(); const setId = from === 'notes' ? await importNotes(vault) : await importTable(vault);
		const to = from === 'notes' ? 'table' : 'notes';
		await startConversion(vault.app, {}, setId, to, progress => { if (progress.phase === 'writing') throw new Error('Synthetic stop'); });
		const marker = markerOn(vault, setId)!;
		const changed = { ...marker, target_path: 'different-destination', source_count: 999 };
		vault.written.set(marker.path, JSON.stringify(changed));
		const before = new Map(vault.written);
		expect((await resumeConversion(vault.app, {}, marker)).ok).toBe(false); expect(vault.written).toEqual(before); expect(vault.trashed.size).toBe(0);
	});
	it('checks an orphan assertion revision before standalone refresh writes', async () => {
		const vault = makeVault(); const setId = await importNotes(vault);
		const orphan = vault.notes().find(path => vault.frontmatterOf(path).subject_id === 'demo-a:X-3')!;
		vault.written.set(orphan, vault.written.get(orphan)!.replace(/hash: sha256-[a-f0-9]{64}/, 'hash: corrupt'));
		const before = new Map(vault.written);
		const result = await importSssom(vault.app, sssom(ROWS.slice(0, 2)), null, null, { importSet: { id: setId }, outputFolder: FOLDER, runTier2Projection: false });
		expect(result.generation?.success).toBe(false); expect(result.generation?.errors[0].message).toMatch(/corrupt/); expect(vault.written).toEqual(before);
	});
	it.each((['notes', 'table'] as const).flatMap(from => (['writing', 'verifying', 'retiring'] as const).map(phase => ({ from, phase }))))('resumes $from source in $phase with exact original lineage', async ({ from, phase }) => {
		const vault = makeVault();
		const setId = from === 'notes' ? await importNotes(vault) : await importTable(vault);
		const stamp = from === 'notes' ? vault.frontmatterOf(vault.notes()[0])._crosswalker.recipe : parseMappingTable(vault.written.get(TABLE)!).header.crosswalker_provenance!.recipe;
		const copies = new Map([...vault.written].filter(([path]) => path.includes('/recipe-')));
		const to = from === 'notes' ? 'table' : 'notes';
		let interrupted = false;
		const first = await startConversion(vault.app, {}, setId, to, progress => {
			if (!interrupted && progress.phase === phase) { interrupted = true; throw new Error('Synthetic phase boundary interruption'); }
		});
		expect(first.ok).toBe(false); expect(first.phaseReached).toBe(phase);
		const beforeRefresh = new Map(vault.written);
		const refresh = await importSssom(vault.app, sssom(ROWS), null, null, { importSet: { id: setId }, mappingForm: phase === 'retiring' ? to : from, outputFolder: FOLDER, runTier2Projection: false });
		expect(refresh.generation?.success).toBe(false); expect(vault.written).toEqual(beforeRefresh);
		if (phase === 'retiring') {
			// A prior retirement may have removed some or all source artifacts.
			if (from === 'table') vault.written.delete(TABLE);
			else vault.written.delete(vault.notes()[0]);
		}
		const resumed = await resumeConversion(vault.app, {}, markerOn(vault, setId)!);
		expect(resumed.reason).toBeUndefined(); expect(resumed.ok).toBe(true);
		if (to === 'table') expect(parseMappingTable(vault.written.get(TABLE)!).header.crosswalker_provenance!.recipe).toEqual(stamp);
		else for (const path of vault.notes()) expect(vault.frontmatterOf(path)._crosswalker.recipe).toEqual(stamp);
		expect(new Map([...vault.written].filter(([path]) => path.includes('/recipe-')))).toEqual(copies);
	});
	it.each(['missing-original', 'unstamped', 'corrupt-target'] as const)('refuses %s without repair writes', async issue => {
		const vault = makeVault(); const setId = await importTable(vault);
		if (issue === 'corrupt-target') {
			await startConversion(vault.app, {}, setId, 'notes', progress => { if (progress.phase === 'verifying') throw new Error('Synthetic stop'); });
			const path = vault.notes()[0];
			vault.written.set(path, vault.written.get(path)!.replace(/recipe_document_digest: .+/, 'recipe_document_digest: corrupt'));
		} else if (issue === 'missing-original') {
			for (const path of [...vault.written.keys()]) if (path.includes('/recipe-')) vault.written.delete(path);
		} else {
			const parsed = parseMappingTable(vault.written.get(TABLE)!);
			delete (parsed.header.crosswalker_provenance!.recipe as Record<string, unknown>).recipe_document_digest;
			vault.written.set(TABLE, serializeMappingTable(parsed.header, parsed.rows));
		}
		const before = new Map(vault.written);
		const result = issue === 'corrupt-target' ? await resumeConversion(vault.app, {}, markerOn(vault, setId)!) : await startConversion(vault.app, {}, setId, 'notes');
		expect(result.ok).toBe(false); expect(vault.written).toEqual(before); expect(vault.trashed.size).toBe(0);
	});
	it('renders a custom retained title, file layout and body, and preserves the original through both forms and refresh', async () => {
		const vault = makeVault(); const setId = await importTable(vault);
		const { normalizeRecipe, serializeCanonicalRecipe } = await import('../src/import/recipe-document');
		const { computeRecipeDocumentDigest, computeRecipeHash } = await import('../src/generation/hash');
		const { buildSyntheticRecipe } = await import('../src/import/sssom-importer');
		const { importSetRecipePath } = await import('../src/import/import-set-recipes');
		const original = normalizeRecipe(buildSyntheticRecipe('demo-a', 'demo-b'));
		original.target.layout[0].template = 'evidence-{_crosswalker_curie_local_part|slug}.md';
		original.target.also_emit!.frontmatter!.managed!.title = 'Evidence for {subject_id}';
		original.target.also_emit!.body![0].template = '{subject_label} / {object_label}';
		original.target.auto_heading = false;
		const digest = computeRecipeDocumentDigest(original);
		const stamp = { id: original.recipe, hash: computeRecipeHash(original.target, original.source), recipe_document_digest: digest };
		const kept = importSetRecipePath(setId, digest)!;
		vault.written.set(kept, serializeCanonicalRecipe(original));
		const parsed = parseMappingTable(vault.written.get(TABLE)!); parsed.header.crosswalker_provenance!.recipe = stamp;
		vault.written.set(TABLE, serializeMappingTable(parsed.header, parsed.rows));
		const copies = new Map([...vault.written].filter(([path]) => path.includes('/recipe-')));
		expect((await startConversion(vault.app, {}, setId, 'notes')).reason).toBeUndefined();
		const paths = vault.notes(); expect(paths.every(path => path.split('/').pop()!.startsWith('evidence-'))).toBe(true);
		for (const path of paths) { expect(vault.frontmatterOf(path).title).toMatch(/^Evidence for /); expect(vault.written.get(path)).toContain(' / '); }
		const refreshed = await importSssom(vault.app, sssom(ROWS), null, null, { importSet: { id: setId }, outputFolder: FOLDER, runTier2Projection: false });
		expect(refreshed.generation?.errors).toEqual([]); expect(vault.notes()).toEqual(paths);
		expect((await startConversion(vault.app, {}, setId, 'table')).reason).toBeUndefined();
		expect(parseMappingTable(vault.written.get(TABLE)!).header.crosswalker_provenance!.recipe).toEqual(stamp);
		expect((await startConversion(vault.app, {}, setId, 'notes')).reason).toBeUndefined();
		expect(vault.notes()).toEqual(paths);
		for (const path of vault.notes()) expect(vault.frontmatterOf(path)._crosswalker.recipe).toEqual(stamp);
		expect(new Map([...vault.written].filter(([path]) => path.includes('/recipe-')))).toEqual(copies);
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
		expect(writtenExceptRecipeCopies(vault)).toEqual([TABLE]);
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
	it('notes to table: a table changed before verification stays in verifying with the source untouched', async () => {
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
		expect(result.phaseReached).toBe('verifying');
		expect(result.reason).toContain('existing target table assertion differs from the source-prepared output');
		expect(markerOn(vault, setId)?.phase).toBe('verifying');
		for (const [path, content] of notes) expect(vault.written.get(path)).toBe(content);
		expect(vault.trashed.size).toBe(0);

		// Resume never authorizes replacing the edited target.
		const beforeResume = new Map(vault.written);
		expect((await resumeConversion(vault.app, {}, markerOn(vault, setId)!)).ok).toBe(false);
		expect(vault.written).toEqual(beforeResume);
		expect(parseMappingTable(vault.written.get(TABLE)!).rows.find((row) => row.subject_id === 'demo-a:X-2')!.review_status).toBe('approved');
	});

	it('table to notes: a note changed before verification stays in verifying with the table untouched', async () => {
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
		expect(result.phaseReached).toBe('verifying');
		expect(result.reason).toContain('differs from the source-prepared output');
		const beforeResume = new Map(vault.written);
		expect((await resumeConversion(vault.app, {}, markerOn(vault, setId)!)).ok).toBe(false);
		expect(vault.written).toEqual(beforeResume);
		expect(vault.written.get(TABLE)).toBe(tableBefore);
		expect(markerOn(vault, setId)?.phase).toBe('verifying');
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
		await applyMigrations(db);

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
		await applyMigrations(db);
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
		await applyMigrations(db);
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
		expect(result.phaseReached).toBe('verifying');
		expect(result.reason).toContain('differs from the source-prepared output');
		const beforeResume = new Map(vault.written);
		expect((await resumeConversion(vault.app, {}, markerOn(vault, setId)!)).ok).toBe(false);
		expect(vault.written).toEqual(beforeResume);
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


describe('conversion target preservation and complete preparation', () => {
 async function interrupted(vault: Vault, from: 'notes' | 'table', phase: 'writing' | 'verifying') {
  const id = from === 'notes' ? await importNotes(vault) : await importTable(vault);
  let failed = false;
  vault.faults.failWrite = (path, content) => {
   const next = phase === 'writing' ? 'verifying' : 'retiring';
   if (!failed && path.endsWith('.converting.json') && content.includes(`"phase": "${next}"`)) { failed = true; return true; }
   return false;
  };
  const result = await startConversion(vault.app, {}, id, from === 'notes' ? 'table' : 'notes');
  expect(result.ok).toBe(false); expect(result.phaseReached).toBe(phase); expect(failed).toBe(true);
  vault.faults.failWrite = undefined;
  return id;
 }
 const cases = (['notes', 'table'] as const).flatMap(from => (['writing', 'verifying'] as const).flatMap(phase => (['review_status', 'reviewer', 'extra', 'release', 'body', 'tags'] as const).map(edit => ({ from, phase, edit }))));
 function editTarget(vault: Vault, from: 'notes' | 'table', edit: typeof cases[number]['edit']) {
  if (from === 'notes') {
   const parsed = parseMappingTable(vault.written.get(TABLE)!);
   if (edit === 'release') parsed.header.mapping_set = { ...parsed.header.mapping_set, license: 'Late license' };
   else if (edit === 'tags') parsed.header.tags = [...parsed.header.tags ?? [], 'late-tag'];
   else if (edit === 'body') parsed.rows[0].subject_label = 'Late managed body input';
   else if (edit === 'extra') parsed.rows[0].extra = { ...parsed.rows[0].extra, late_field: 'late value' };
   else parsed.rows[0][edit] = edit === 'review_status' ? 'approved' : 'late-reviewer';
   vault.written.set(TABLE, serializeMappingTable(parsed.header, parsed.rows));
  } else {
   const path = edit === 'release' ? [...vault.written.keys()].find(path => path.endsWith('.md') && vault.frontmatterOf(path)?.kind === 'mapping-set')! : vault.notes()[0];
   const old = vault.written.get(path)!;
   if (edit === 'body') vault.written.set(path, old + '\nLate user body\n');
   else if (edit === 'tags') vault.written.set(path, old.replace(/^tags:\n/m, 'tags:\n  - late-tag\n'));
   else vault.written.set(path, old.replace(/^---\n/, `---\n${edit === 'release' ? 'license' : edit === 'extra' ? 'late_field' : edit}: ${edit === 'review_status' ? 'approved' : edit === 'reviewer' ? 'late-reviewer' : 'late value'}\n`));
  }
 }
 it.each(cases)('preserves changed $from target $edit in $phase without any mutation', async ({ from, phase, edit }) => {
  const vault = makeVault(); const id = await interrupted(vault, from, phase);
  editTarget(vault, from, edit);
  const before = new Map(vault.written); const folders = new Set(vault.folders);
  const result = await resumeConversion(vault.app, {}, markerOn(vault, id)!);
  expect(result.ok).toBe(false); expect(result.phaseReached).toBe(phase);
  expect(vault.written).toEqual(before); expect(vault.folders).toEqual(folders); expect(vault.trashed.size).toBe(0);
 });
 it.each((['notes', 'table'] as const).flatMap(from => (['writing', 'verifying'] as const).map(phase => ({ from, phase }))))('resumes exact $from outputs in $phase without replacing their bytes', async ({ from, phase }) => {
  const vault = makeVault(); const id = await interrupted(vault, from, phase);
  const targets = new Map([...vault.written].filter(([path]) => from === 'notes' ? path === TABLE : path.endsWith('.md')));
  expect((await resumeConversion(vault.app, {}, markerOn(vault, id)!)).ok).toBe(true);
  for (const [path, text] of targets) expect(vault.written.get(path)).toBe(text);
 });
 it.each(['notes', 'table'] as const)('protects a late %s target edit at the write boundary', async from => {
  const vault = makeVault(); const id = await interrupted(vault, from, 'writing');
  let expected: Map<string, string> | undefined;
  const result = await resumeConversion(vault.app, {}, markerOn(vault, id)!, progress => {
   if (progress.phase === 'writing' && !expected) { editTarget(vault, from, 'reviewer'); expected = new Map(vault.written); }
  });
  expect(expected).toBeDefined(); expect(result.ok).toBe(false); expect(vault.written).toEqual(expected); expect(vault.trashed.size).toBe(0);
 });
 it('uses actual custom recipe preparation to reject all colliding addresses before any mutation', async () => {
  const vault = makeVault();
  const { generateFromRecipe } = await import('../src/generation/generation-engine');
  const { buildSyntheticRecipe } = await import('../src/import/sssom-importer');
  const { normalizeRecipe } = await import('../src/import/recipe-document');
  const { edgeBodyOf } = await import('../src/generation/edge-endpoints');
  const { assignMappingRowIds } = await import('../src/mappings/mapping-table');
  const recipe = normalizeRecipe(buildSyntheticRecipe('demo-a', 'demo-b'));
  recipe.target.layout[0].template = '{subject_id|slug}.md';
  const row = { subject_id: 'demo-a:X-1', object_id: 'demo-b:Y-1', predicate_id: 'is_equivalent_to', subject_label: 'Demo one', object_label: 'Target one', sssom_predicate: 'skos:exactMatch', mapping_justification: 'semapv:ManualMappingCuration', confidence: '0.9', mapping_provider: 'Demo provider', mapping_set_id: 'https://example.test/demo-map', subject_note: '', object_note: '', edge_body: edgeBodyOf('demo-a:X-1', 'is_equivalent_to', 'demo-b:Y-1', '', '') };
  const gen = await generateFromRecipe(vault.app, { columns: Object.keys(row), rows: [row], rowCount: 1 }, recipe as never, { basePath: FOLDER, importSet: 'new', overwriteMode: 'replace', createFolders: true });
  expect(gen.errors).toEqual([]); expect(gen.success).toBe(true); const id = gen.importSetId!;
  const originalNotes = vault.notes();
  expect((await startConversion(vault.app, {}, id, 'table')).ok).toBe(true);
  expect((await startConversion(vault.app, {}, id, 'notes')).ok).toBe(true); expect(vault.notes()).toEqual(originalNotes);
  expect((await startConversion(vault.app, {}, id, 'table')).ok).toBe(true);
  const parsed = parseMappingTable(vault.written.get(TABLE)!);
  parsed.rows = assignMappingRowIds([...parsed.rows, { ...parsed.rows[0], object_id: 'demo-b:Y-99', object_label: 'Another object' }], parsed.header.mapping_set_id);
  vault.written.set(TABLE, serializeMappingTable(parsed.header, parsed.rows));
  const before = new Map(vault.written); const beforeTrash = new Map(vault.trashed); const folders = new Set(vault.folders);
  const result = await startConversion(vault.app, {}, id, 'notes');
  expect(result.ok).toBe(false); expect(result.phaseReached).toBe('not-started'); expect(result.reason).toMatch(/collision/i);
  expect(vault.written).toEqual(before); expect(vault.folders).toEqual(folders); expect(vault.trashed).toEqual(beforeTrash); expect(markerOn(vault, id)).toBeUndefined();
 });
 it.each((['notes', 'table'] as const).flatMap(from => (['writing', 'verifying'] as const).map(phase => ({ from, phase }))))('fills only missing unchanged $from targets in $phase', async ({ from, phase }) => {
  const vault = makeVault(); const id = await interrupted(vault, from, phase);
  if (from === 'notes') {
   const parsed = parseMappingTable(vault.written.get(TABLE)!); vault.written.set(TABLE, serializeMappingTable(parsed.header, parsed.rows.slice(1)));
  } else vault.written.delete(vault.notes()[0]);
  const existing = new Map([...vault.written].filter(([path]) => from === 'table' && path.endsWith('.md')));
  expect((await resumeConversion(vault.app, {}, markerOn(vault, id)!)).ok).toBe(true);
  for (const [path, text] of existing) expect(vault.written.get(path)).toBe(text);
 });
 it('refuses duplicate release targets rather than trashing them', async () => {
  const vault = makeVault(); const id = await interrupted(vault, 'table', 'writing');
  const release = [...vault.written.keys()].find(path => path.endsWith('.md') && vault.frontmatterOf(path)?.kind === 'mapping-set')!;
  vault.written.set(`${FOLDER}/duplicate-release.md`, vault.written.get(release)!);
  const before = new Map(vault.written);
  expect((await resumeConversion(vault.app, {}, markerOn(vault, id)!)).ok).toBe(false); expect(vault.written).toEqual(before); expect(vault.trashed.size).toBe(0);
 });
 it('allocates around an independent release destination and resumes on the same owned path', async () => {
  const vault = makeVault(); const id = await importTable(vault);
  const userPath = `${FOLDER}/demo-map.md`; const releasePath = `${FOLDER}/demo-map 2.md`;
  vault.written.set(userPath, 'Independent user note');
  vault.faults.failWrite = (path, content) => path.endsWith('.converting.json') && content.includes('"phase": "verifying"');
  const result = await startConversion(vault.app, {}, id, 'notes');
  expect(result.ok).toBe(false); expect(result.phaseReached).toBe('writing');
  expect(vault.frontmatterOf(releasePath)?.kind).toBe('mapping-set');
  const releaseText = vault.written.get(releasePath);
  vault.faults.failWrite = undefined;
  expect((await resumeConversion(vault.app, {}, markerOn(vault, id)!)).ok).toBe(true);
  expect(vault.written.get(userPath)).toBe('Independent user note'); expect(vault.trashed.has(userPath)).toBe(false);
  expect(vault.written.get(releasePath)).toBe(releaseText); expect(vault.written.has(`${FOLDER}/demo-map 3.md`)).toBe(false);
 });
 it('refuses changed contents claiming the chosen release identity before creating a marker', async () => {
  const vault = makeVault(); const id = await importTable(vault);
  const { buildNoteContent } = await import('../src/generation/generation-engine');
  const { mappingSetFromTableHeader, storedMappingSet } = await import('../src/mappings/mapping-set');
  const header = parseMappingTable(vault.written.get(TABLE)!).header;
  const record = mappingSetFromTableHeader(header, id, TABLE)!;
  vault.written.set(`${FOLDER}/demo-map.md`, buildNoteContent({ ...storedMappingSet(record), license: 'Changed license', _crosswalker: header.crosswalker_provenance }, ''));
  const before = new Map(vault.written);
  const result = await startConversion(vault.app, {}, id, 'notes');
  expect(result.ok).toBe(false); expect(result.phaseReached).toBe('not-started');
  expect(vault.written).toEqual(before); expect(vault.trashed.size).toBe(0); expect(markerOn(vault, id)).toBeUndefined();
 });

 it('rechecks targets inside the actual engine before creating a missing note', async () => {
  const vault = makeVault(); const id = await interrupted(vault, 'table', 'writing');
  const removed = vault.notes()[1]; vault.written.delete(removed);
  const { generateFromRecipe } = await import('../src/generation/generation-engine');
  let expected: Map<string, string> | undefined;
  const result = await resumeConversion(vault.app, { generateFromRecipe: async (...args) => {
   editTarget(vault, 'table', 'reviewer'); expected = new Map(vault.written);
   return generateFromRecipe(...args);
  } }, markerOn(vault, id)!);
  expect(expected).toBeDefined(); expect(result.ok).toBe(false); expect(vault.written).toEqual(expected); expect(vault.trashed.size).toBe(0);
 });
 it('checks current table text inside the guarded update rather than trusting the preflight read', async () => {
  const vault = makeVault(); const id = await interrupted(vault, 'notes', 'writing');
  const parsed = parseMappingTable(vault.written.get(TABLE)!); vault.written.set(TABLE, serializeMappingTable(parsed.header, parsed.rows.slice(1)));
  let expected: Map<string, string> | undefined;
  vault.faults.beforeProcess = path => { if (path === TABLE && !expected) { editTarget(vault, 'notes', 'reviewer'); expected = new Map(vault.written); } };
  const result = await resumeConversion(vault.app, {}, markerOn(vault, id)!);
  expect(expected).toBeDefined(); expect(result.ok).toBe(false); expect(vault.written).toEqual(expected); expect(vault.trashed.size).toBe(0);
 });
 it.each(['notes', 'table'] as const)('rechecks a late %s source change before target writes', async from => {
  const vault = makeVault(); const id = await interrupted(vault, from, 'writing');
  let expected: Map<string, string> | undefined;
  const result = await resumeConversion(vault.app, {}, markerOn(vault, id)!, progress => {
   if (progress.phase === 'writing' && !expected) {
    if (from === 'notes') reviewNote(vault, 'demo-a:X-1', 'reviewer: late-source-reviewer');
    else reviewTable(vault, TABLE, 'demo-a:X-1', { reviewer: 'late-source-reviewer' });
    expected = new Map(vault.written);
   }
  });
  expect(expected).toBeDefined(); expect(result.ok).toBe(false); expect(vault.written).toEqual(expected); expect(vault.trashed.size).toBe(0);
 });
 it('checks a release target that appears immediately after assertion generation', async () => {
  const vault = makeVault(); const id = await importTable(vault);
  const { generateFromRecipe, buildNoteContent } = await import('../src/generation/generation-engine');
  const { mappingSetFromTableHeader, storedMappingSet } = await import('../src/mappings/mapping-set');
  const header = parseMappingTable(vault.written.get(TABLE)!).header;
  const record = mappingSetFromTableHeader(header, id, TABLE)!;
  let expected: Map<string, string> | undefined;
  const result = await startConversion(vault.app, { generateFromRecipe: async (...args) => {
   const generated = await generateFromRecipe(...args);
   vault.written.set(`${FOLDER}/demo-map.md`, buildNoteContent({ ...storedMappingSet(record), license: 'Late license', _crosswalker: header.crosswalker_provenance }, ''));
   expected = new Map(vault.written); return generated;
  } }, id, 'notes');
  expect(expected).toBeDefined(); expect(result.ok).toBe(false); expect(vault.written).toEqual(expected); expect(vault.trashed.size).toBe(0);
 });

});

describe('conversion scale and scoped conflicts', () => {
 async function importRows(vault: Vault, form: 'notes' | 'table', count: number): Promise<string> {
  const rows = Array.from({ length: count }, (_, index) => `demo-a:X-${index + 1}\tDemo ${index + 1}\tskos:exactMatch\tdemo-b:Y-${index + 1}\tTarget ${index + 1}\tsemapv:ManualMappingCuration\t0.9`);
  const imported = await importSssom(vault.app, sssom(rows), null, null, { runTier2Projection: false, importSet: 'new-set-qualified', mappingForm: form });
  expect(imported.generation?.success).toBe(true); return imported.generation!.importSetId!;
 }
 it('bounds actual engine write-boundary reads linearly for 200 rows', async () => {
  const vault = makeVault(); const count = 200; const id = await importRows(vault, 'table', count);
  const { generateFromRecipe } = await import('../src/generation/generation-engine');
  let reads = 0; let tableReads = 0; let sourceTableBytes = 0;
  const tableSize = Buffer.byteLength(vault.written.get(TABLE)!, 'utf8');
  const result = await startConversion(vault.app, { generateFromRecipe: async (...args) => {
   expect(args[3].concurrency).toBe(1);
   const record = (path: string) => { reads++; if (path.endsWith('.mapping-table.tsv')) { tableReads++; sourceTableBytes += Buffer.byteLength(vault.written.get(path) ?? '', 'utf8'); } };
   const read = jest.spyOn(vault.app.vault, 'read').mockImplementation(async file => { record(file.path); return vault.written.get(file.path)!; });
   const adapterRead = jest.spyOn(vault.app.vault.adapter, 'read').mockImplementation(async path => { record(path); if (!vault.written.has(path)) throw new Error('missing'); return vault.written.get(path)!; });
   try { return await generateFromRecipe(...args); } finally { read.mockRestore(); adapterRead.mockRestore(); }
  } }, id, 'notes');
  expect(result.ok).toBe(true); expect(result.rows).toBe(count);
  expect(reads).toBeLessThan(12 * count); expect(tableReads).toBeLessThanOrEqual(3);
  expect(sourceTableBytes).toBeLessThanOrEqual(3 * tableSize);
 });
 it.each(['changed-stat', 'unchanged-stat', 'unavailable-stat'] as const)('never retires a table edited mid-run with %s', async mode => {
  const vault = makeVault(); const count = 12; const id = await importRows(vault, 'table', count);
  const lookup = vault.app.vault.getAbstractFileByPath.bind(vault.app.vault);
  const statLookup = mode === 'unavailable-stat' ? jest.spyOn(vault.app.vault, 'getAbstractFileByPath').mockImplementation(path => {
   const file = lookup(path); if (path === TABLE && file instanceof TFile) Object.assign(file, { stat: { mtime: 0 } }); return file;
  }) : undefined;
  let edited: string | undefined;
  const result = await startConversion(vault.app, {}, id, 'notes', progress => {
   if (progress.phase === 'writing' && progress.done === 10 && !edited) {
    edited = vault.written.get(TABLE)!.replace('Demo 1', mode === 'unchanged-stat' ? 'Late 1' : 'Late source label');
    vault.written.set(TABLE, edited);
   }
  });
  statLookup?.mockRestore();
  expect(edited).toBeDefined(); expect(result.ok).toBe(false); expect(result.phaseReached).toBe('writing');
  expect(result.reason).toContain(`Source ${TABLE} changed after preparation`);
  expect(vault.notes()).toHaveLength(mode === 'unchanged-stat' ? count : 10);
  expect(vault.written.get(TABLE)).toBe(edited); expect(vault.trashed.size).toBe(0);
 });
 it('retires 200 notes with only one source read per file after pre-loop validation', async () => {
  const vault = makeVault(); const count = 200; const id = await importRows(vault, 'notes', count);
  let retiring = false; let reads = 0;
  const read = jest.spyOn(vault.app.vault, 'read'); const adapterRead = jest.spyOn(vault.app.vault.adapter, 'read');
  const result = await startConversion(vault.app, {}, id, 'table', progress => {
   if (progress.phase === 'retiring' && !retiring) { retiring = true; read.mockClear(); adapterRead.mockClear(); }
  });
  reads = read.mock.calls.length + adapterRead.mock.calls.length; read.mockRestore(); adapterRead.mockRestore();
  expect(result.ok).toBe(true); expect(retiring).toBe(true); expect(result.trashed).toBe(count + 1);
  expect(reads).toBeLessThan(2 * count + 10);
 });
 it('refuses a remaining source edited between individual retirements', async () => {
  const vault = makeVault(); const id = await importNotes(vault); const changed = vault.notes()[1]; let edited: string | undefined;
  const result = await startConversion(vault.app, {}, id, 'table', progress => {
   if (progress.phase === 'retiring' && progress.done === 1) { edited = `${vault.written.get(changed)!}\nLate source edit\n`; vault.written.set(changed, edited); }
  });
  expect(result.ok).toBe(false); expect(result.phaseReached).toBe('retiring'); expect(result.trashed).toBe(1);
  expect(vault.written.get(changed)).toBe(edited); expect(vault.trashed.has(changed)).toBe(false);
 });
 it.each([false, true])('scopes duplicate identity refusal to prepared curies (prepared: %s)', async prepared => {
  const vault = makeVault(); const id = await importTable(vault);
  const { derivedEdgeCurie } = await import('../src/mappings/mapping-table');
  const table = parseMappingTable(vault.written.get(TABLE)!);
  const curie = prepared ? derivedEdgeCurie(table.rows[0], table.header)! : 'demo-unrelated:duplicate';
  const text = `---\ncurie: ${curie}\n_crosswalker:\n  import_set:\n    id: iset-abcdef\n    scheme: set-qualified-v1\n---\nIndependent imported note\n`;
  vault.written.set('Unrelated/one.md', text); vault.written.set('Unrelated/two.md', text);
  const before = new Map(vault.written);
  const result = await startConversion(vault.app, {}, id, 'notes');
  if (!prepared) expect(result.reason).toBeUndefined();
  expect(result.ok).toBe(!prepared);
  expect(vault.written.get('Unrelated/one.md')).toBe(text); expect(vault.written.get('Unrelated/two.md')).toBe(text);
  if (prepared) { expect(result.phaseReached).toBe('not-started'); expect(vault.written).toEqual(before); expect(vault.trashed.size).toBe(0); }
 });
 it.each(['notes', 'table'] as const)('resumes %s output from an earlier plugin version without replacing its bytes', async from => {
  const vault = makeVault(); const id = from === 'notes' ? await importNotes(vault) : await importTable(vault);
  vault.faults.failWrite = (path, content) => path.endsWith('.converting.json') && content.includes('"phase": "verifying"');
  expect((await startConversion(vault.app, {}, id, from === 'notes' ? 'table' : 'notes')).ok).toBe(false);
  const targets = new Map<string, string>();
  if (from === 'notes') {
   const parsed = parseMappingTable(vault.written.get(TABLE)!);
   const provenance = parsed.header.crosswalker_provenance!;
   provenance.producer.version = '0.0.0';
   const text = serializeMappingTable(parsed.header, parsed.rows); vault.written.set(TABLE, text); targets.set(TABLE, text);
  } else for (const [path, text] of vault.written) if (path.endsWith('.md')) {
   const changed = text.replace(/(    version: ).*/g, '$10.0.0'); expect(changed).not.toBe(text); vault.written.set(path, changed); targets.set(path, changed);
  }
  vault.faults.failWrite = undefined;
  expect((await resumeConversion(vault.app, {}, markerOn(vault, id)!)).ok).toBe(true);
  for (const [path, text] of targets) expect(vault.written.get(path)).toBe(text);
 });
 it('names the original source row when only a later missing subset fails in the engine', async () => {
  const vault = makeVault(); const id = await importTable(vault);
  vault.faults.failWrite = (path, content) => path.endsWith('.converting.json') && content.includes('"phase": "verifying"');
  expect((await startConversion(vault.app, {}, id, 'notes')).ok).toBe(false); vault.faults.failWrite = undefined;
  const missing = vault.notes().find(path => vault.frontmatterOf(path)?.subject_id === 'demo-a:X-3')!;
  vault.written.delete(missing); vault.faults.failWrite = path => path === missing;
  const result = await resumeConversion(vault.app, {}, markerOn(vault, id)!);
  expect(result.ok).toBe(false); expect(result.reason).toContain('Source row 3 (demo-a:X-3 -> demo-b:Y-3)');
  expect(vault.trashed.size).toBe(0);
 });
});


describe('readable standalone mapping filenames', () => {
	async function withTemplate(vault: Vault, template: string, text = sssom(ROWS)) {
		const actual = engine.generateFromRecipe;
		const spy = jest.spyOn(engine, 'generateFromRecipe').mockImplementation((app, data, _recipe, options, debug) =>
			actual(app, data, buildSyntheticRecipe('demo-a', 'demo-b', template), options, debug));
		try { return await importSssom(vault.app, text, null, null, { runTier2Projection: false, importSet: 'new-set-qualified' }); }
		finally { spy.mockRestore(); }
	}
	it('changes addresses only: the readable and legacy imports preserve identical assertion data and curies', async () => {
		jest.useFakeTimers().setSystemTime(new Date('2026-10-31T12:00:00Z'));
		const random = jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array: any) => { array.fill(1); return array; });
		try {
			const readable = makeVault(), legacy = makeVault();
			const fresh = await importSssom(readable.app, sssom(ROWS), null, null, { runTier2Projection: false, importSet: 'new-set-qualified' });
			const old = await withTemplate(legacy, LEGACY_SSSOM_FILE_TEMPLATE);
			expect(fresh.generation?.errors).toEqual([]); expect(old.generation?.errors).toEqual([]);
			const facts = (vault: Vault) => vault.notes().map(path => {
				const fm = vault.frontmatterOf(path);
				delete fm._crosswalker.recipe.hash;
				delete fm._crosswalker.recipe.recipe_document_digest;
				const text = vault.written.get(path)!;
				return { fm, body: text.slice(text.indexOf('\n---', 4) + 4) };
			}).sort((a, b) => a.fm.curie.localeCompare(b.fm.curie));
			expect(facts(readable)).toEqual(facts(legacy));
			for (const path of readable.notes()) {
				const fm = readable.frontmatterOf(path);
				const local = fm.curie.slice(fm.curie.indexOf(':') + 1);
				expect(path).toBe(`${FOLDER}/${renderTemplate(READABLE_SSSOM_FILE_TEMPLATE, { ...fm, _crosswalker_curie_local_part: local })}`);
			}
			expect(legacy.notes().every(path => path.includes('/cwset-'))).toBe(true);
		} finally { random.mockRestore(); jest.useRealTimers(); }
	});
	it.each([LEGACY_SSSOM_FILE_TEMPLATE, READABLE_SSSOM_FILE_TEMPLATE])('refreshes exact paths/bytes then round-trips the retained template %s', async template => {
		const vault = makeVault();
		const first = await withTemplate(vault, template);
		expect(first.generation?.errors).toEqual([]);
		const setId = first.generation!.importSetId!;
		const before = new Map(vault.written);
		const paths = vault.notes();
		const refreshed = await importSssom(vault.app, sssom(ROWS), null, null, { importSet: { id: setId }, outputFolder: FOLDER, runTier2Projection: false });
		expect(refreshed.generation?.errors).toEqual([]);
		expect(vault.written).toEqual(before);
		expect((await startConversion(vault.app, {}, setId, 'table')).reason).toBeUndefined();
		expect((await startConversion(vault.app, {}, setId, 'notes')).reason).toBeUndefined();
		expect(vault.notes()).toEqual(paths);
		const after = await importSssom(vault.app, sssom(ROWS), null, null, { importSet: { id: setId }, outputFolder: FOLDER, runTier2Projection: false });
		expect(after.generation?.errors).toEqual([]);
		expect(vault.notes()).toEqual(paths);
	});
	it('keeps repeated subject ids distinct and distinguishes equal local ids from other prefixes', async () => {
		const vault = makeVault();
		const rows = ['demo-a:X', 'other:X', 'demo-a:x'].flatMap(subject => ['demo-b:Y', 'demo-b:Z'].map(object =>
			`${subject}\tSubject\tskos:exactMatch\t${object}\tObject\tsemapv:ManualMappingCuration\t1`));
		const result = await importSssom(vault.app, sssom(rows), null, null, { runTier2Projection: false });
		expect(result.generation?.errors).toEqual([]);
		expect(vault.notes()).toHaveLength(6);
		expect(new Set(vault.notes().map(path => path.toLowerCase())).size).toBe(6);
	});
	it('refuses a forced display hash collision without overwriting the first assertion', async () => {
		const vault = makeVault();
		const spy = jest.spyOn(hashes, 'sha256Hex').mockReturnValue('a'.repeat(64));
		try {
			const result = await importSssom(vault.app, sssom([
				'demo-a:X\tFirst\tskos:exactMatch\tdemo-b:Y\tObject\tsemapv:ManualMappingCuration\t1',
				'other:X\tSecond\tskos:exactMatch\tdemo-b:Y\tObject\tsemapv:ManualMappingCuration\t1',
			]), null, null, { runTier2Projection: false });
			expect(result.generation?.success).toBe(false);
			expect(result.generation?.errors.some(error => error.message.includes('Path collision'))).toBe(true);
			expect(vault.notes()).toHaveLength(1);
			expect(vault.frontmatterOf(vault.notes()[0]).subject_id).toBe('demo-a:X');
			expect(vault.written.get(vault.notes()[0])).not.toContain('Second');
		} finally { spy.mockRestore(); }
	});
});
