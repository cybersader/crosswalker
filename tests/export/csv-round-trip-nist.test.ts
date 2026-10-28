/**
 * csv-round-trip-nist.test.ts — recipe-aware CSV export round trip.
 *
 * Import the synthetic NIST mini source with a saved recipe, export the import
 * folder as CSV, then import that CSV into a new set with the same recipe. The
 * second import must produce the same managed content (managed frontmatter,
 * managed body regions, layout paths), provenance ids aside.
 *
 * Run twice: once on notes carrying the layout value stamp, once with the stamp
 * stripped, so the folder hub and heading fallbacks carry the folder level.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';
import { TFile, TFolder } from 'obsidian';
import { generateNotes, type GenerationOptions } from '../../src/generation/generation-engine';
import { managedContentEquivalent } from '../../src/generation/managed-equivalence';
import { parseCSV, parseCSVFile } from '../../src/import/parsers/csv-parser';
import { loadRecipeDocument } from '../../src/import/recipe-document';
import { saveToLibrary, type RecipeLibraryFiles } from '../../src/import/recipe-library';
import { exportFolderAsCsv } from '../../src/export/csv-exporter';
import type { CrosswalkerImportRecipe } from '../../src/types/generated/recipe';
import type { ImportRecipe, ParsedData } from '../../src/types/config';
import type { DebugLog } from '../../src/utils/debug';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('js-yaml');

const g = globalThis as unknown as Record<string, unknown>;
if (!g.TextDecoder) g.TextDecoder = NodeTextDecoder;
if (!g.TextEncoder) g.TextEncoder = NodeTextEncoder;

const debug = { info() {}, trace() {}, warn() {}, error() {}, log() {} } as unknown as DebugLog;
const parseYaml = (text: string) => yaml.load(text);

const SOURCE_COLUMNS = ['id', 'name', 'family', 'family_name', 'parent', 'description'];

/** The NIST mini shape: family folders, one file per control, a description section. */
const RECIPE = {
	recipe: 'nist-mini-round-trip',
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

function memoryVault() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const rename = async (f: { path: string }, to: string) => {
		const text = files.get(f.path)!;
		files.delete(f.path);
		files.set(to, text);
		f.path = to;
	};
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].filter((p) => p.endsWith('.md')).map((p) => new TFile(p)),
			getFiles: () => [...files.keys()].map((p) => new TFile(p)),
			getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p) : folders.has(p) ? new TFolder(p) : null),
			create: async (p: string, t: string) => {
				files.set(p, t);
				return new TFile(p);
			},
			modify: async (f: { path: string }, t: string) => {
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
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return { app: app as any, files };
}

function memoryLibrary(): RecipeLibraryFiles {
	const store = new Map<string, string>();
	const folders = new Set<string>();
	return {
		exists: async (p) => folders.has(p) || store.has(p),
		listFiles: async (folder) =>
			[...store.keys()].filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes('/')),
		read: async (p) => {
			const text = store.get(p);
			if (text === undefined) throw new Error('missing');
			return text;
		},
		write: async (p, text) => {
			store.set(p, text);
		},
		mkdir: async (p) => {
			folders.add(p);
		},
		trash: async (p) => {
			store.delete(p);
		},
		rename: async (from, to) => {
			const text = store.get(from);
			if (text === undefined) throw new Error('missing');
			store.delete(from);
			store.set(to, text);
		},
	};
}

const CONFIG = { name: 'round-trip', mapping: { hierarchy: [], frontmatter: [], links: [], body: [] } } as unknown as Partial<ImportRecipe>;

async function importInto(app: unknown, parsed: ParsedData, recipe: CrosswalkerImportRecipe, basePath: string, sourceFileName: string) {
	const options: GenerationOptions = {
		basePath,
		importSet: undefined,
		overwriteMode: 'replace',
		createFolders: true,
		sourceFileName,
		recipeOverride: recipe,
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const result = await generateNotes(app as any, parsed, CONFIG, options, debug);
	expect(result.errors).toEqual([]);
	return result;
}

/** Notes under a root, keyed by path relative to the root. */
function notesUnder(files: Map<string, string>, root: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const [path, text] of files) if (path.startsWith(`${root}/`) && path.endsWith('.md')) out.set(path.slice(root.length + 1), text);
	return out;
}

/** Drop `_crosswalker.layout_values` from a note, as a note written before the stamp existed. */
function stripLayoutStamp(text: string): string {
	const m = /^---\n([\s\S]*?)\n---/.exec(text);
	if (!m) return text;
	const fm = yaml.load(m[1]) as Record<string, any>;
	if (!fm._crosswalker?.layout_values) return text;
	delete fm._crosswalker.layout_values;
	return `---\n${yaml.dump(fm, { lineWidth: -1 })}---${text.slice(m[0].length)}`;
}

function frontmatterOf(text: string): Record<string, any> {
	const m = /^---\n([\s\S]*?)\n---/.exec(text);
	return m ? (yaml.load(m[1]) as Record<string, any>) : {};
}

async function sourceRows(): Promise<{ parsed: ParsedData; text: string }> {
	const bytes = readFileSync(join(__dirname, '../../tools/fixtures/synthetic/nist-mini.csv'));
	const file = {
		name: 'nist-mini.csv',
		size: bytes.byteLength,
		arrayBuffer: async () => Uint8Array.from(bytes).buffer,
	} as unknown as File;
	return { parsed: await parseCSVFile(file), text: bytes.toString('utf8') };
}

describe.each([
	{ label: 'with the layout value stamp', strip: false },
	{ label: 'with the layout value stamp stripped', strip: true },
])('CSV export round trip on nist-mini, $label', ({ strip }) => {
	it('gives back the source columns and reimports to the same managed content', async () => {
		const { parsed } = await sourceRows();
		const library = memoryLibrary();
		const loaded = loadRecipeDocument(RECIPE, { origin: 'bundled', sourceColumns: SOURCE_COLUMNS });
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) throw new Error('recipe did not load');
		const saved = await saveToLibrary(library, loaded.document, { name: 'NIST mini round trip', mode: 'new' });
		expect(saved.ok).toBe(true);
		if (!saved.ok) throw new Error('save failed');

		const { app, files } = memoryVault();
		await importInto(app, parsed, saved.recipe, 'Frameworks/nist-mini', 'nist-mini.csv');
		const first = notesUnder(files, 'Frameworks/nist-mini');
		expect(first.size).toBeGreaterThan(0);

		if (strip) {
			for (const [path, text] of files) if (path.startsWith('Frameworks/nist-mini/')) files.set(path, stripLayoutStamp(text));
			for (const text of notesUnder(files, 'Frameworks/nist-mini').values()) {
				expect(frontmatterOf(text)._crosswalker?.layout_values).toBeUndefined();
			}
		} else {
			const concept = [...first.values()].find((t) => frontmatterOf(t).id === 'AC-1')!;
			expect(frontmatterOf(concept)._crosswalker.layout_values).toEqual([{ level: 'family', value: 'AC' }]);
		}

		const exported = await exportFolderAsCsv(app, 'Frameworks/nist-mini', { library });
		expect(exported.fallbacks).toEqual({ 'no-recipe': 0, legacy: 0, missing: 0, 'digest-mismatch': 0 });
		expect(exported.omittedColumns).toEqual([]);
		expect(exported.recoveredFromNames).toEqual([]);
		expect(exported.mixedRecipes).toBe(false);
		expect(exported.rowCount).toBe(parsed.rowCount);

		// Every source column comes back, in rows in source order, with exact values.
		const back = await parseCSV(exported.csv);
		// Recipe columns first (layout, then properties, then body), extras after.
		expect(back.columns.slice(0, 6)).toEqual(['family', 'name', 'family_name', 'id', 'parent', 'description']);
		for (const col of SOURCE_COLUMNS) expect(back.columns).toContain(col);
		const project = (rows: Record<string, unknown>[]) =>
			rows.map((r) => SOURCE_COLUMNS.map((c) => (r[c] === undefined || r[c] === null ? '' : String(r[c]))));
		expect(project(back.rows)).toEqual(project(parsed.rows));

		// Reimport the export into a new set with the same recipe. A fresh vault:
		// in the same vault the identities are already owned by the first set,
		// which refuses a second claim by design.
		const other = memoryVault();
		await importInto(other.app, back, saved.recipe, 'Frameworks/nist-mini', 'nist-mini-export.csv');
		const second = notesUnder(other.files, 'Frameworks/nist-mini');
		const firstNow = notesUnder(files, 'Frameworks/nist-mini');
		expect([...second.keys()].sort()).toEqual([...firstNow.keys()].sort());

		for (const [path, text] of firstNow) {
			const twin = second.get(path)!;
			const res = managedContentEquivalent(text, twin, { parseYaml, userPreserve: ['_crosswalker'] });
			expect({ path, differences: res.differences }).toEqual({ path, differences: [] });
			const a = frontmatterOf(text)._crosswalker ?? {};
			const b = frontmatterOf(twin)._crosswalker ?? {};
			expect(b.recipe?.id).toBe(a.recipe?.id);
			expect(b.recipe?.recipe_document_digest).toBe(a.recipe?.recipe_document_digest);
			if (!strip) expect(b.layout_values).toEqual(a.layout_values);
		}
	});
});
