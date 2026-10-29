/**
 * import-set-recipe-copy.test.ts — each import keeps the recipe it ran, and
 * the recipe-aware CSV export falls back to that copy.
 *
 * A never-saved workbench recipe (`custom-<ontology>`) and a saved recipe that
 * was edited after the run both resolve nowhere in the library. The copy under
 * `_crosswalker/import-sets/<set id>/recipe-<digest>.json` keeps export lossless.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';
import { TFile, TFolder } from 'obsidian';
import { generateFromRecipe, generateNotes, type GenerationOptions } from '../../src/generation/generation-engine';
import type { Recipe } from '../../src/render';
import { parseCSV, parseCSVFile } from '../../src/import/parsers/csv-parser';
import { loadRecipeDocument } from '../../src/import/recipe-document';
import { saveToLibrary, type RecipeLibraryFiles } from '../../src/import/recipe-library';
import { recipeRunDigest } from '../../src/import/recipe-runs';
import {
	IMPORT_SET_RECIPES_FOLDER,
	importSetRecipePath,
	importSetSourceColumnsPath,
	keepImportSetRecipe,
	keepImportSetSourceColumns,
	readImportSetRecipe,
	readImportSetSourceColumns,
	type ImportSetRecipeFiles,
} from '../../src/import/import-set-recipes';
import { exportFolderAsCsv } from '../../src/export/csv-exporter';
import { NoteRecipeResolver } from '../../src/export/recipe-for-note';
import type { CrosswalkerImportRecipe } from '../../src/types/generated/recipe';
import type { ImportRecipe, ParsedData } from '../../src/types/config';
import type { ImportSetOption } from '../../src/generation/import-set';
import type { DebugLog } from '../../src/utils/debug';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('js-yaml');

const g = globalThis as unknown as Record<string, unknown>;
if (!g.TextDecoder) g.TextDecoder = NodeTextDecoder;
if (!g.TextEncoder) g.TextEncoder = NodeTextEncoder;

const debug = { info() {}, trace() {}, warn() {}, error() {}, log() {} } as unknown as DebugLog;

const SOURCE_COLUMNS = ['id', 'name', 'family', 'family_name', 'parent', 'description'];

function recipeWithId(id: string) {
	return {
		recipe: id,
		source: { ontology: 'nist-mini', levels: ['family', 'control'] },
		target: {
			auto_heading: '{name}',
			layout: [
				{ level: 'family', mechanism: 'folder', template: '{family}' },
				{ level: 'control', mechanism: 'file', template: '{name|fs-safe}.md' },
			],
			enrichment: { level_hubs: 'notes' },
			also_emit: {
				frontmatter: { managed: { id: '{id}', family_name: '{family_name}', parent: '{parent|optional}' } },
				body: [{ template: '{description}', position: 'section', heading: 'description', heading_depth: 2, format: 'text' }],
			},
		},
	};
}

function canonical(raw: unknown): CrosswalkerImportRecipe {
	const loaded = loadRecipeDocument(raw, { origin: 'bundled', sourceColumns: SOURCE_COLUMNS });
	if (!loaded.ok) throw new Error('recipe did not load');
	return loaded.document.original;
}

function memoryVault(opts: { failJson?: boolean; noAdapter?: boolean } = {}) {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const writes: string[] = [];
	const rename = async (f: { path: string }, to: string) => {
		const text = files.get(f.path)!;
		files.delete(f.path);
		files.set(to, text);
		f.path = to;
	};
	const guard = (p: string) => {
		if (opts.failJson && p.endsWith('.json')) throw new Error('disk is read-only');
		writes.push(p);
	};
	const app = {
		vault: {
			// The raw adapter, as Obsidian has: the recipe copy goes through it.
			adapter: {
				exists: async (p: string) => files.has(p) || folders.has(p),
				read: async (p: string) => {
					const t = files.get(p);
					if (t === undefined) throw new Error('missing');
					return t;
				},
				write: async (p: string, t: string) => {
					guard(p);
					files.set(p, t);
				},
				mkdir: async (p: string) => {
					folders.add(p);
				},
			},
			getMarkdownFiles: () => [...files.keys()].filter((p) => p.endsWith('.md')).map((p) => new TFile(p)),
			getFiles: () => [...files.keys()].map((p) => new TFile(p)),
			getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p) : folders.has(p) ? new TFolder(p) : null),
			create: async (p: string, t: string) => {
				guard(p);
				files.set(p, t);
				return new TFile(p);
			},
			modify: async (f: { path: string }, t: string) => {
				guard(f.path);
				files.set(f.path, t);
			},
			read: async (f: { path: string }) => files.get(f.path) ?? '',
			cachedRead: async (f: { path: string }) => files.get(f.path) ?? '',
			createFolder: async (p: string) => {
				folders.add(p);
			},
			rename,
		},
		metadataCache: {
			getFileCache: (f: { path: string }) => {
				const t = files.get(f.path);
				if (t === undefined) return null;
				const m = /^---\n([\s\S]*?)\n---/.exec(t);
				return { frontmatter: m ? yaml.load(m[1]) : undefined };
			},
		},
		fileManager: { renameFile: rename },
	};
	if (opts.noAdapter) delete (app.vault as { adapter?: unknown }).adapter;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return { app: app as any, files, folders, writes };
}

/**
 * The library file API over the same vault, as the plugin's adapter-backed
 * one is: the saved library and the import-set copies live in one vault.
 */
function vaultLibrary(files: Map<string, string>, folders: Set<string>): RecipeLibraryFiles {
	return {
		exists: async (p) => folders.has(p) || files.has(p),
		listFiles: async (folder) =>
			[...files.keys()].filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes('/')),
		read: async (p) => {
			const text = files.get(p);
			if (text === undefined) throw new Error('missing');
			return text;
		},
		write: async (p, text) => {
			files.set(p, text);
		},
		mkdir: async (p) => {
			folders.add(p);
		},
		trash: async (p) => {
			files.delete(p);
		},
		rename: async (from, to) => {
			const text = files.get(from);
			if (text === undefined) throw new Error('missing');
			files.delete(from);
			files.set(to, text);
		},
	};
}

const CONFIG = { name: 'copy', mapping: { hierarchy: [], frontmatter: [], links: [], body: [] } } as unknown as Partial<ImportRecipe>;

async function importInto(app: unknown, parsed: ParsedData, recipe: CrosswalkerImportRecipe, importSet?: ImportSetOption) {
	const options: GenerationOptions = {
		basePath: 'Frameworks/nist-mini',
		importSet,
		overwriteMode: 'replace',
		createFolders: true,
		sourceFileName: 'nist-mini.csv',
		recipeOverride: recipe,
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const result = await generateNotes(app as any, parsed, CONFIG, options, debug);
	expect(result.errors).toEqual([]);
	return result;
}

async function sourceRows(): Promise<ParsedData> {
	const bytes = readFileSync(join(__dirname, '../../tools/fixtures/synthetic/nist-mini.csv'));
	const file = {
		name: 'nist-mini.csv',
		size: bytes.byteLength,
		arrayBuffer: async () => Uint8Array.from(bytes).buffer,
	} as unknown as File;
	return parseCSVFile(file);
}

const project = (rows: Record<string, unknown>[]) =>
	rows.map((r) => SOURCE_COLUMNS.map((c) => (r[c] === undefined || r[c] === null ? '' : String(r[c]))));

async function expectLosslessExport(app: unknown, library: RecipeLibraryFiles, parsed: ParsedData) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const exported = await exportFolderAsCsv(app as any, 'Frameworks/nist-mini', { library });
	expect(exported.fallbacks).toEqual({ 'no-recipe': 0, legacy: 0, missing: 0, 'digest-mismatch': 0 });
	expect(exported.rowCount).toBe(parsed.rowCount);
	const back = await parseCSV(exported.csv);
	for (const col of SOURCE_COLUMNS) expect(back.columns).toContain(col);
	expect(project(back.rows)).toEqual(project(parsed.rows));
}

function frontmatterOf(text: string): Record<string, any> {
	const m = /^---\n([\s\S]*?)\n---/.exec(text);
	return m ? (yaml.load(m[1]) as Record<string, any>) : {};
}

describe('each import keeps the recipe it ran', () => {
	it('round-trips a never-saved workbench recipe through the kept copy', async () => {
		const parsed = await sourceRows();
		const recipe = canonical(recipeWithId('custom-nist-mini'));
		const { app, files, folders } = memoryVault();
		const result = await importInto(app, parsed, recipe);
		expect(result.importSetId).toMatch(/^iset-[a-z0-9]{6}$/);

		const path = importSetRecipePath(result.importSetId!, recipeRunDigest(recipe)!)!;
		expect(path.startsWith(`${IMPORT_SET_RECIPES_FOLDER}/${result.importSetId}/recipe-sha256-`)).toBe(true);
		expect(files.has(path)).toBe(true);
		expect(result.runRecipeKeepFailed).toBeFalsy();

		// Nothing was saved to the library: the copy alone makes export lossless.
		expect([...files.keys()].some((p) => p.startsWith('_crosswalker/import-recipes/'))).toBe(false);
		await expectLosslessExport(app, vaultLibrary(files, folders), parsed);
	});

	it('still inverts after the saved recipe was edited', async () => {
		const parsed = await sourceRows();
		const { app, files, folders } = memoryVault();
		const library = vaultLibrary(files, folders);
		const loaded = loadRecipeDocument(recipeWithId('nist-mini-edited'), { origin: 'bundled', sourceColumns: SOURCE_COLUMNS });
		if (!loaded.ok) throw new Error('recipe did not load');
		const saved = await saveToLibrary(library, loaded.document, { name: 'NIST mini edited', mode: 'new' });
		if (!saved.ok) throw new Error('save failed');
		const digestA = recipeRunDigest(saved.recipe);
		await importInto(app, parsed, saved.recipe);

		// Revision B: same id, different body heading, saved over A in the library.
		const revised = JSON.parse(files.get(saved.path)!) as Record<string, any>;
		revised.target.also_emit.body[0].heading = 'details';
		files.set(saved.path, JSON.stringify(revised, null, 2));

		const note = [...files.entries()].find(([p, t]) => p.endsWith('.md') && t.includes('recipe_document_digest'))!;
		const fm = frontmatterOf(note[1]);
		expect(fm._crosswalker.recipe.recipe_document_digest).toBe(digestA);
		const resolver = new NoteRecipeResolver(library);
		const found = await resolver.resolve(fm);
		expect(found.ok).toBe(true);
		if (found.ok) expect(recipeRunDigest(found.recipe)).toBe(digestA);

		await expectLosslessExport(app, library, parsed);
	});

	it('does not rewrite an identical copy on a re-run, and adds a file for a new revision', async () => {
		const parsed = await sourceRows();
		const recipeA = canonical(recipeWithId('custom-nist-mini'));
		const { app, files, writes } = memoryVault();
		const first = await importInto(app, parsed, recipeA);
		const setId = first.importSetId!;
		const pathA = importSetRecipePath(setId, recipeRunDigest(recipeA)!)!;
		const bytesA = files.get(pathA);
		expect(writes.filter((p) => p === pathA)).toHaveLength(1);

		await importInto(app, parsed, recipeA, { id: setId });
		expect(writes.filter((p) => p === pathA)).toHaveLength(1);
		expect(files.get(pathA)).toBe(bytesA);

		const rawB = recipeWithId('custom-nist-mini');
		rawB.target.auto_heading = '{id} {name}';
		const recipeB = canonical(rawB);
		expect(recipeRunDigest(recipeB)).not.toBe(recipeRunDigest(recipeA));
		await importInto(app, parsed, recipeB, { id: setId });
		const pathB = importSetRecipePath(setId, recipeRunDigest(recipeB)!)!;
		expect(files.has(pathB)).toBe(true);
		expect(files.get(pathA)).toBe(bytesA);
		expect(writes.filter((p) => p === pathA)).toHaveLength(1);
		const copies = [...files.keys()].filter((p) => p.startsWith(`${IMPORT_SET_RECIPES_FOLDER}/${setId}/recipe-`));
		expect(copies.sort()).toEqual([pathA, pathB].sort());
	});

	it('does not fail the import when the copy cannot be written', async () => {
		const parsed = await sourceRows();
		const recipe = canonical(recipeWithId('custom-nist-mini'));
		const { app, files } = memoryVault({ failJson: true });
		const result = await importInto(app, parsed, recipe);
		expect(result.success).toBe(true);
		expect(result.runRecipeKeepFailed).toBe(true);
		expect([...files.keys()].filter((p) => p.endsWith('.md')).length).toBeGreaterThan(0);
		const warning = (result.warnings ?? []).find((w) => w.message.includes(IMPORT_SET_RECIPES_FOLDER));
		expect(warning).toBeDefined();
		expect(warning!.message).not.toMatch(/\u2014/);
	});

	it('keeps no copy and reports nothing when the vault has no adapter', async () => {
		const parsed = await sourceRows();
		const recipe = canonical(recipeWithId('custom-nist-mini'));
		const { app, files } = memoryVault({ noAdapter: true });
		const result = await importInto(app, parsed, recipe);
		expect(result.success).toBe(true);
		expect(result.runRecipeKeepFailed).toBeFalsy();
		expect([...files.keys()].some((p) => p.startsWith(`${IMPORT_SET_RECIPES_FOLDER}/`))).toBe(false);
	});
});

describe('kept recipe copies at module level', () => {
	function memoryFiles(): ImportSetRecipeFiles & { store: Map<string, string>; writes: number } {
		const store = new Map<string, string>();
		const folders = new Set<string>();
		const files = {
			store,
			writes: 0,
			exists: async (p: string) => store.has(p) || folders.has(p),
			read: async (p: string) => {
				const t = store.get(p);
				if (t === undefined) throw new Error('missing');
				return t;
			},
			write: async (p: string, t: string) => {
				files.writes++;
				store.set(p, t);
			},
			mkdir: async (p: string) => {
				folders.add(p);
			},
		};
		return files;
	}

	it('skips keys that are not an import set id and a digest', async () => {
		const files = memoryFiles();
		const recipe = canonical(recipeWithId('custom-nist-mini'));
		const digest = recipeRunDigest(recipe)!;
		expect(await keepImportSetRecipe(files, '../escape', recipe, digest)).toEqual({ ok: true, outcome: 'skipped', reason: 'bad-key' });
		expect(await keepImportSetRecipe(files, 'iset-abc123', recipe, 'sha256-nope')).toEqual({ ok: true, outcome: 'skipped', reason: 'bad-key' });
		expect(files.writes).toBe(0);
	});

	it('refuses to file a recipe under a digest it does not hash to', async () => {
		const files = memoryFiles();
		const recipe = canonical(recipeWithId('custom-nist-mini'));
		const res = await keepImportSetRecipe(files, 'iset-abc123', recipe, `sha256-${'0'.repeat(64)}`);
		expect(res).toEqual({ ok: true, outcome: 'skipped', reason: 'digest-differs' });
		expect(files.writes).toBe(0);
	});

	it('reports a failed write instead of throwing', async () => {
		const files = memoryFiles();
		files.write = async () => {
			throw new Error('denied');
		};
		const recipe = canonical(recipeWithId('custom-nist-mini'));
		const res = await keepImportSetRecipe(files, 'iset-abc123', recipe, recipeRunDigest(recipe)!);
		expect(res.ok).toBe(false);
	});

	it('records source column order once, and again only when it changes', async () => {
		const files = memoryFiles();
		expect(await keepImportSetSourceColumns(files, 'iset-abc123', ['b', 'a', '', 'b', 'c'])).toMatchObject({ outcome: 'written' });
		expect(await readImportSetSourceColumns(files, 'iset-abc123')).toEqual(['b', 'a', 'c']);
		expect(await keepImportSetSourceColumns(files, 'iset-abc123', ['b', 'a', 'c'])).toMatchObject({ outcome: 'unchanged' });
		expect(files.writes).toBe(1);
		expect(await keepImportSetSourceColumns(files, 'iset-abc123', ['a', 'b', 'c'])).toMatchObject({ outcome: 'written' });
		expect(await readImportSetSourceColumns(files, 'iset-abc123')).toEqual(['a', 'b', 'c']);
	});

	it('skips a bad set id or an empty header, and reads damaged records as null', async () => {
		const files = memoryFiles();
		expect(await keepImportSetSourceColumns(files, '../escape', ['a'])).toEqual({ ok: true, outcome: 'skipped', reason: 'bad-key' });
		expect(await keepImportSetSourceColumns(files, 'iset-abc123', ['', ''])).toEqual({ ok: true, outcome: 'skipped', reason: 'no-columns' });
		expect(files.writes).toBe(0);
		files.store.set(importSetSourceColumnsPath('iset-abc123')!, '{"kind":"source-columns","columns":["a","a"]}');
		expect(await readImportSetSourceColumns(files, 'iset-abc123')).toBeNull();
		expect(await readImportSetSourceColumns(files, 'iset-zzz999')).toBeNull();
	});

	it('reads back null for a damaged copy', async () => {
		const files = memoryFiles();
		const recipe = canonical(recipeWithId('custom-nist-mini'));
		const digest = recipeRunDigest(recipe)!;
		files.store.set(importSetRecipePath('iset-abc123', digest)!, '{"not":"a recipe"}');
		expect(await readImportSetRecipe(files, 'iset-abc123', digest)).toBeNull();
	});
});

describe('export resolver without a recipe anywhere', () => {
	it('still reports missing when neither the library nor a kept copy has it', async () => {
		const { files, folders } = memoryVault();
		const resolver = new NoteRecipeResolver(vaultLibrary(files, folders));
		const res = await resolver.resolve({
			_crosswalker: {
				import_set: { id: 'iset-abc123' },
				recipe: { id: 'custom-nowhere', recipe_document_digest: `sha256-${'a'.repeat(64)}` },
			},
		});
		expect(res).toEqual({ ok: false, reason: 'missing' });
		expect(resolver.fallbacks.missing).toBe(1);
	});
});

describe('classic column-mapping imports keep their recipe too', () => {
	// The classic wizard's config, as it saves one: hierarchy to folders, the
	// note title from a column, mapped source columns to frontmatter keys. One
	// key differs from its column, so the export must map it back by recipe.
	const classicConfig = (name?: string) => ({
		...(name ? { name } : {}),
		mapping: {
			hierarchy: [{ column: 'family', level: 1 }],
			frontmatter: [
				{ column: 'id', key: 'id' },
				{ column: 'name', key: 'name' },
				{ column: 'family_name', key: 'family_label' },
				{ column: 'parent', key: 'parent' },
				{ column: 'description', key: 'description' },
			],
			links: [],
			body: [],
			filename: { template: '{id|fs-safe}', sanitize: true },
		},
	}) as unknown as Partial<ImportRecipe>;

	async function classicImport(app: unknown, parsed: ParsedData, config: Partial<ImportRecipe>) {
		const options: GenerationOptions = {
			basePath: 'Frameworks/nist-mini',
			overwriteMode: 'replace',
			createFolders: true,
			sourceFileName: 'nist-mini.csv',
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = await generateNotes(app as any, parsed, config, options, debug);
		expect(result.errors).toEqual([]);
		return result;
	}

	for (const name of [undefined, 'NIST mini classic']) {
		it(`keeps the copy and exports the source columns (${name ? 'named' : 'nameless'} config)`, async () => {
			const parsed = await sourceRows();
			const { app, files, folders } = memoryVault();
			const result = await classicImport(app, parsed, classicConfig(name));
			expect(result.runRecipeKeepFailed).toBeFalsy();

			const note = [...files.entries()].find(([p]) => p.endsWith('/AC-1.md'))!;
			const stamp = frontmatterOf(note[1])._crosswalker;
			expect(stamp.recipe.id).toBe(name ?? 'legacy-config');
			expect(stamp.import_set.id).toBe(result.importSetId);
			const digest = stamp.recipe.recipe_document_digest as string;
			expect(digest).toMatch(/^sha256-[a-f0-9]{64}$/);

			// Keyed by the minted set id and the digest the notes carry.
			const path = importSetRecipePath(result.importSetId!, digest)!;
			expect(path).toBe(`${IMPORT_SET_RECIPES_FOLDER}/${result.importSetId}/recipe-${digest}.json`);
			expect(files.has(path)).toBe(true);
			const kept = await readImportSetRecipe(vaultLibrary(files, folders), result.importSetId!, digest);
			expect(kept).not.toBeNull();
			expect(recipeRunDigest(kept!)).toBe(digest);

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const exported = await exportFolderAsCsv(app as any, 'Frameworks/nist-mini', { library: vaultLibrary(files, folders) });
			expect(exported.fallbacks).toEqual({ 'no-recipe': 0, legacy: 0, missing: 0, 'digest-mismatch': 0 });
			expect(exported.rowCount).toBe(parsed.rowCount);
			const back = await parseCSV(exported.csv);
			// Source column names, not the frontmatter keys they were mapped to.
			for (const col of ['id', 'family_name', 'parent', 'description']) expect(back.columns).toContain(col);
			expect(back.columns).not.toContain('family_label');
			const byId = new Map(back.rows.map((r) => [String(r.id), r]));
			for (const row of parsed.rows) {
				const out = byId.get(String(row.id));
				expect(out).toBeDefined();
				expect(String(out!.description ?? '')).toBe(String(row.description ?? ''));
				expect(String(out!.family_name ?? '')).toBe(String(row.family_name ?? ''));
			}
		});
	}
});

describe('classic body columns round trip through the recipe copy', () => {
	// The classic wizard's "body" role: the column becomes a `## <key>` section.
	// Before the shim translated mapping.body, the copy had no body projection
	// and this column was the one source column the export could not restore.
	const bodyConfig = {
		mapping: {
			hierarchy: [{ column: 'family', level: 1 }],
			frontmatter: [
				{ column: 'id', key: 'id' },
				{ column: 'name', key: 'name' },
				{ column: 'family_name', key: 'family_name' },
				{ column: 'parent', key: 'parent' },
			],
			links: [],
			body: [{ column: 'description', heading: 'description' }],
			filename: { template: '{id|fs-safe}', sanitize: true },
		},
	} as unknown as Partial<ImportRecipe>;

	it('writes the column as a managed section and exports it back as a source column', async () => {
		const parsed = await sourceRows();
		const { app, files, folders } = memoryVault();
		const options: GenerationOptions = {
			basePath: 'Frameworks/nist-mini',
			overwriteMode: 'replace',
			createFolders: true,
			sourceFileName: 'nist-mini.csv',
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = await generateNotes(app as any, parsed, bodyConfig, options, debug);
		expect(result.errors).toEqual([]);

		const note = [...files.entries()].find(([p]) => p.endsWith('/AC-1.md'))!;
		const ac1 = parsed.rows.find((r) => String(r.id) === 'AC-1')!;
		expect(note[1]).toContain(`## description\n\n${String(ac1.description)}`);
		expect(frontmatterOf(note[1])).not.toHaveProperty('description');

		const digest = frontmatterOf(note[1])._crosswalker.recipe.recipe_document_digest as string;
		const kept = await readImportSetRecipe(vaultLibrary(files, folders), result.importSetId!, digest);
		// The kept copy is the normalized canonical document, defaults filled in.
		expect(kept?.target.also_emit?.body).toEqual([{
			template: '{description|optional}', position: 'section', heading: 'description',
			heading_depth: 2, format: 'text', omit_if_empty: true,
		}]);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const exported = await exportFolderAsCsv(app as any, 'Frameworks/nist-mini', { library: vaultLibrary(files, folders) });
		expect(exported.fallbacks).toEqual({ 'no-recipe': 0, legacy: 0, missing: 0, 'digest-mismatch': 0 });
		expect(exported.rowCount).toBe(parsed.rowCount);
		const back = await parseCSV(exported.csv);
		expect(back.columns).toContain('description');
		const byId = new Map(back.rows.map((r) => [String(r.id), r]));
		for (const row of parsed.rows) {
			const out = byId.get(String(row.id));
			expect(out).toBeDefined();
			expect(String(out!.description ?? '')).toBe(String(row.description ?? ''));
		}
	});
});

describe('export resolver for classic notes', () => {
	const legacyStamp = (setId: string, digest: string) => ({
		_crosswalker: {
			import_set: { id: setId },
			recipe: { id: 'legacy-config', recipe_document_digest: digest },
		},
	});

	it('resolves a legacy-id note through its set copy, by set id and digest', async () => {
		const { files, folders } = memoryVault();
		const library = vaultLibrary(files, folders);
		const recipe = canonical(recipeWithId('legacy-config'));
		const digest = recipeRunDigest(recipe)!;
		const kept = await keepImportSetRecipe(library, 'iset-abc123', recipe, digest);
		expect(kept.ok).toBe(true);

		const resolver = new NoteRecipeResolver(library);
		const found = await resolver.resolve(legacyStamp('iset-abc123', digest));
		expect(found.ok).toBe(true);
		if (found.ok) expect(recipeRunDigest(found.recipe)).toBe(digest);
		expect(resolver.fallbacks.legacy).toBe(0);

		// Identity, not proximity: another set's note with the same digest has no copy.
		const other = await resolver.resolve(legacyStamp('iset-zzz999', digest));
		expect(other).toEqual({ ok: false, reason: 'legacy' });
	});

	it('still reports legacy when no copy was kept', async () => {
		const { files, folders } = memoryVault();
		const resolver = new NoteRecipeResolver(vaultLibrary(files, folders));
		expect(await resolver.resolve(legacyStamp('iset-abc123', `sha256-${'b'.repeat(64)}`))).toEqual({ ok: false, reason: 'legacy' });
		expect(await resolver.resolve({ _crosswalker: { recipe: { id: 'legacy-config' } } })).toEqual({ ok: false, reason: 'legacy' });
		expect(resolver.fallbacks.legacy).toBe(2);
	});
});

describe('native recipe runs keep a copy only of the recipe they stamp', () => {
	const recipeCopies = (files: Map<string, string>, setId: string) =>
		[...files.keys()].filter((p) => p.startsWith(`${IMPORT_SET_RECIPES_FOLDER}/${setId}/recipe-`) && p.endsWith('.json'));

	async function nativeRun(app: unknown, parsed: ParsedData, recipe: CrosswalkerImportRecipe, provenanceRecipe?: { id: string; hash?: string }) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = await generateFromRecipe(app as any, parsed, recipe as unknown as Recipe, {
			basePath: 'Frameworks/nist-mini',
			importSet: 'new-set-qualified',
			overwriteMode: 'replace',
			createFolders: true,
			sourceFileName: 'nist-mini.csv',
			...(provenanceRecipe ? { provenanceRecipe } : {}),
		}, debug);
		expect(result.errors).toEqual([]);
		expect(result.importSetId).toMatch(/^iset-[a-z0-9]{6}$/);
		return result;
	}

	// Prevents: a native run into a set losing its recipe copy, so its notes export as properties only.
	it('writes exactly one recipe copy under the set folder without provenanceRecipe', async () => {
		const parsed = await sourceRows();
		const recipe = canonical(recipeWithId('custom-nist-mini'));
		const { app, files } = memoryVault();
		const result = await nativeRun(app, parsed, recipe);
		const copies = recipeCopies(files, result.importSetId!);
		expect(copies).toHaveLength(1);
		expect(copies[0]).toMatch(new RegExp(`^${IMPORT_SET_RECIPES_FOLDER}/${result.importSetId}/recipe-sha256-[a-f0-9]{64}\\.json$`));
		expect(copies[0]).toBe(importSetRecipePath(result.importSetId!, recipeRunDigest(recipe)!));
	});

	// Prevents: the conversion job's transient transport recipe being filed as a copy beside the set's original.
	it('writes no recipe copy when the run stamps another recipe via provenanceRecipe', async () => {
		const parsed = await sourceRows();
		const recipe = canonical(recipeWithId('custom-nist-mini'));
		const { app, files } = memoryVault();
		const result = await nativeRun(app, parsed, recipe, { id: 'original-recipe', hash: `sha256-${'c'.repeat(64)}` });
		expect([...files.keys()].filter((p) => p.endsWith('.md')).length).toBeGreaterThan(0);
		expect(recipeCopies(files, result.importSetId!)).toEqual([]);
		// Observed: source-columns.json is not written either; keepRunRecipe is skipped as a whole.
		expect(files.has(importSetSourceColumnsPath(result.importSetId!)!)).toBe(false);
		const note = [...files.entries()].find(([p, t]) => p.endsWith('.md') && t.includes('original-recipe'));
		expect(note).toBeDefined();
	});
});
