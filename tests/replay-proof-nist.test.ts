/**
 * replay-proof-nist.test.ts — full-source replay proofs (v0.1.7 Track 2, slice 3).
 *
 * The replay promise: the same recipe, the same source bytes and the same
 * import set leave every note's managed content unchanged, as defined by
 * `managedContentEquivalent` (src/generation/managed-equivalence.ts).
 *
 * This leg mirrors the wizard path without any production seam:
 *   bundled recipe -> workbench (as the recognized fast path builds it)
 *   -> Save as recipe (saveToLibrary, mode new, the save modal's call)
 *   -> reopen (loadForImport) and share (exportRecipe -> importRecipeFile)
 *   -> workbench seeded from the saved recipe (as Run again builds it)
 *   -> generateNotes with the same config + options doGenerate passes
 *   -> run 1 into a new set, run 2 into that set with Replace.
 *
 * Sources are the tracked public-domain NIST files under Frameworks/. They are
 * read at runtime only; this file asserts aggregate counts and computed
 * equality and never embeds a row, identifier or line of prose from them.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';
import { TFile, TFolder } from 'obsidian';
import csfRecipeJson from '../recipes/import/nist-csf-2.json';
import sp80053FlatJson from '../recipes/import/nist-800-53-flat.json';
import { generateNotes, type GenerationOptions } from '../src/generation/generation-engine';
import { managedContentEquivalent } from '../src/generation/managed-equivalence';
import { MappingWorkbench } from '../src/import/workbench';
import { analyzeColumns, parseCSVFile } from '../src/import/parsers/csv-parser';
import { parseXLSXFile } from '../src/import/parsers/xlsx-parser';
import { deriveFacetMemberships } from '../src/import/mapping/facets';
import {
	exportRecipe,
	importRecipeFile,
	loadForImport,
	saveToLibrary,
	type RecipeLibraryFiles,
} from '../src/import/recipe-library';
import { recipeRunDigest } from '../src/import/recipe-runs';
import type { CrosswalkerImportRecipe } from '../src/types/generated/recipe';
import type { ImportRecipe, ParsedData } from '../src/types/config';
import type { DebugLog } from '../src/utils/debug';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (value: string) => unknown };

jest.setTimeout(600_000);

// The Jest environment lacks the WHATWG text codecs that Obsidian's renderer
// provides; parseCSVFile decodes with TextDecoder.
const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.TextDecoder === 'undefined') g.TextDecoder = NodeTextDecoder;
if (typeof g.TextEncoder === 'undefined') g.TextEncoder = NodeTextEncoder;

const ROOT = join(__dirname, '..');
const debug = { info() {}, trace() {}, warn() {}, error() {} } as unknown as DebugLog;
const parseYaml = (text: string): unknown => yaml.load(text);

// ----------------------------------------------------------------------------
// In-memory vault + recipe library
// ----------------------------------------------------------------------------

function vault() {
	const files = new Map<string, string>();
	const folders = new Set(['']);
	const rename = async (file: { path: string }, to: string) => {
		const text = files.get(file.path)!;
		files.delete(file.path);
		files.set(to, text);
		file.path = to;
	};
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].filter((p) => p.endsWith('.md')).map((p) => new TFile(p)),
			getFiles: () => [...files.keys()].map((p) => new TFile(p)),
			getAbstractFileByPath: (path: string) => files.has(path) ? new TFile(path) : folders.has(path) ? new TFolder(path) : null,
			create: async (path: string, text: string) => { files.set(path, text); return new TFile(path); },
			modify: async (file: { path: string }, text: string) => { files.set(file.path, text); },
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
			rename,
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const text = files.get(file.path);
				if (!text) return null;
				const match = /^---\n([\s\S]*?)\n---/.exec(text);
				return { frontmatter: match ? yaml.load(match[1]) : undefined };
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
	const times = new Map<string, number>();
	let clock = 1_000;
	return {
		exists: async (p) => folders.has(p) || store.has(p),
		listFiles: async (folder) => [...store.keys()].filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes('/')),
		read: async (p) => {
			const text = store.get(p);
			if (text === undefined) throw new Error('missing');
			return text;
		},
		write: async (p, text) => { store.set(p, text); times.set(p, ++clock); },
		mkdir: async (p) => { folders.add(p); },
		trash: async (p) => { store.delete(p); },
		rename: async (from, to) => {
			const text = store.get(from);
			if (text === undefined) throw new Error('missing');
			store.delete(from);
			store.set(to, text);
		},
		mtime: async (p) => times.get(p) ?? null,
	};
}

function fileOf(bytes: Uint8Array, name: string): File {
	const copy = Uint8Array.from(bytes);
	return {
		name,
		size: copy.byteLength,
		arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
	} as unknown as File;
}

function frontmatter(text: string): Record<string, unknown> {
	const match = /^---\n([\s\S]*?)\n---/.exec(text);
	return match ? (yaml.load(match[1]) as Record<string, unknown>) : {};
}

function crosswalker(text: string): Record<string, any> {
	return (frontmatter(text)._crosswalker ?? {}) as Record<string, any>;
}

/** Notes under one import root, path -> text. */
function notesUnder(files: Map<string, string>, root: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const [path, text] of files) if (path.startsWith(`${root}/`) && path.endsWith('.md')) out.set(path, text);
	return out;
}

/** Replace one top-level frontmatter line `key: ...` with `key: value`. */
function setFrontmatterLine(text: string, key: string, value: string): string {
	const end = text.indexOf('\n---', 4);
	const head = text.slice(0, end);
	const pattern = new RegExp(`^${key}:.*$`, 'm');
	if (!pattern.test(head)) throw new Error(`Property ${key} not found in note`);
	return head.replace(pattern, `${key}: ${JSON.stringify(value)}`) + text.slice(end);
}

/** Add a top-level frontmatter line right after the opening fence. */
function addFrontmatterLine(text: string, key: string, value: string): string {
	if (!text.startsWith('---\n')) throw new Error('Note has no frontmatter');
	return `---\n${key}: ${JSON.stringify(value)}\n${text.slice(4)}`;
}

// ----------------------------------------------------------------------------
// The wizard path, reproduced from its public pieces
// ----------------------------------------------------------------------------

function workbenchFor(parsed: ParsedData, recipe: CrosswalkerImportRecipe, origin: 'bundled' | 'user', outputPath: string): MappingWorkbench {
	// makeWorkbench(undefined, false, undefined, undefined, recipe, origin), as the
	// recognized fast path and the library preset both call it.
	return new MappingWorkbench({
		parsedData: parsed,
		columnInfos: analyzeColumns(parsed),
		outputPath,
		debug,
		defaultPresetId: 'browsable-framework',
		initialRecipe: recipe,
		recipeOrigin: origin,
		sourceOntology: recipe.source.ontology,
		seedColumnDefaults: false,
		onChange: () => {},
	});
}

/** buildWorkbenchConfig() in import-wizard.ts. */
function workbenchConfig(wb: MappingWorkbench): Partial<ImportRecipe> {
	const leaf = wb.leafFileTemplate();
	return {
		name: 'shape-workbench',
		mapping: {
			hierarchy: [],
			frontmatter: [],
			links: [],
			body: wb.getLegacyBodyMappings(),
			...(leaf ? { filename: { template: leaf, sanitize: true } } : {}),
		},
	} as Partial<ImportRecipe>;
}

/** doGenerate() in import-wizard.ts, minus the Tier 2 projection and progress UI. */
async function generate(
	app: any,
	parsed: ParsedData,
	wb: MappingWorkbench,
	basePath: string,
	sourceFileName: string,
	importSet: GenerationOptions['importSet'],
) {
	const options: GenerationOptions = {
		basePath,
		importSet,
		overwriteMode: 'replace',
		createFolders: true,
		sourceFileName,
		facetsForRow: (row: Record<string, unknown>) => deriveFacetMemberships(wb.getMapping(), row),
	};
	options.recipeOverride = wb.buildRecipe();
	return generateNotes(app, parsed, workbenchConfig(wb), options, debug);
}

// ----------------------------------------------------------------------------
// Sources
// ----------------------------------------------------------------------------

interface ReplaySource {
	label: string;
	file: string;
	recipe: CrosswalkerImportRecipe;
	parse: (bytes: Uint8Array) => Promise<ParsedData>;
	basePath: string;
	/** Expected note count, an aggregate only. */
	expectedNotes: number;
	/** A source column that feeds managed output, for negative control (a). */
	changeColumn: string;
	/** A managed property, for negative control (b). */
	managedKey: string;
	/** Only a CSV can be byte-edited with plain text tools. */
	byteEditable: boolean;
}

const SOURCES: ReplaySource[] = [
	{
		label: 'NIST CSF 2.0',
		file: 'Frameworks/csf2.xlsx',
		recipe: csfRecipeJson as unknown as CrosswalkerImportRecipe,
		parse: (bytes) => parseXLSXFile(fileOf(bytes, 'csf2.xlsx'), { sheet: 'CSF 2.0', headerRow: 1 }),
		basePath: 'Frameworks/replay-proof-csf-2',
		expectedNotes: 185,
		changeColumn: 'Implementation Examples',
		managedKey: 'category',
		byteEditable: false,
	},
	{
		label: 'NIST SP 800-53 Rev 5',
		file: 'Frameworks/NIST_SP-800-53_rev5_catalog_load.csv',
		recipe: sp80053FlatJson as unknown as CrosswalkerImportRecipe,
		parse: (bytes) => parseCSVFile(fileOf(bytes, 'NIST_SP-800-53_rev5_catalog_load.csv')),
		basePath: 'Frameworks/replay-proof-800-53',
		expectedNotes: 1189,
		changeColumn: 'name',
		managedKey: 'title',
		byteEditable: true,
	},
];

interface Prepared {
	bytes: Uint8Array;
	parsed: ParsedData;
	savedId: string;
	savedRecipe: CrosswalkerImportRecipe;
	savedDigest: string;
	workbench: MappingWorkbench;
}

/** Save as recipe -> reopen -> share, then the workbench Run again opens. */
async function prepare(src: ReplaySource): Promise<Prepared> {
	const bytes = new Uint8Array(readFileSync(join(ROOT, src.file)));
	const parsed = await src.parse(bytes);

	const library = memoryLibrary();
	const fastPath = workbenchFor(parsed, src.recipe, 'bundled', src.basePath);
	const input = fastPath.patchForSave();
	expect(input.result.ok).toBe(true);
	const saved = await saveToLibrary(library, input.document, {
		name: `${src.label} replay`,
		mode: 'new',
		patch: input.options,
	});
	expect(saved.ok).toBe(true);
	if (!saved.ok) throw new Error('save failed');

	const reopened = await loadForImport(library, saved.id);
	expect(reopened.ok).toBe(true);
	if (!reopened.ok) throw new Error('reopen failed');
	expect(reopened.origin).toBe('user');
	expect(reopened.recipe).toEqual(saved.recipe);
	const savedDigest = recipeRunDigest(saved.recipe);
	expect(savedDigest).toBeTruthy();
	expect(recipeRunDigest(reopened.recipe)).toBe(savedDigest);

	// Share leg: export, then import the file into another person's library.
	const exported = await exportRecipe(library, saved.id);
	expect(exported.ok).toBe(true);
	if (!exported.ok) throw new Error('export failed');
	const otherLibrary = memoryLibrary();
	const imported = await importRecipeFile(otherLibrary, exported.text);
	expect(imported.ok).toBe(true);
	if (!imported.ok) throw new Error('import failed');
	expect(imported.id).toBe(saved.id);
	const shared = await loadForImport(otherLibrary, imported.id);
	expect(shared.ok).toBe(true);
	if (!shared.ok) throw new Error('shared reopen failed');
	expect(shared.recipe).toEqual(reopened.recipe);
	expect(recipeRunDigest(shared.recipe)).toBe(savedDigest);

	const workbench = workbenchFor(parsed, reopened.recipe, 'user', src.basePath);
	// The run record digest (recordRecipeRun) comes from document.original.
	expect(recipeRunDigest(workbench.patchForSave().document.original)).toBe(savedDigest);

	return { bytes, parsed, savedId: saved.id, savedRecipe: reopened.recipe, savedDigest: savedDigest!, workbench };
}

function compare(run1: Map<string, string>, run2: Map<string, string>, userPreserve: readonly string[]) {
	const diffs = new Map<string, string[]>();
	for (const [path, text] of run1) {
		const other = run2.get(path);
		if (other === undefined) { diffs.set(path, ['missing in run 2']); continue; }
		const res = managedContentEquivalent(text, other, { parseYaml, userPreserve });
		if (!res.equal) diffs.set(path, res.differences);
	}
	for (const path of run2.keys()) if (!run1.has(path)) diffs.set(path, ['missing in run 1']);
	return diffs;
}

function clonedParsed(parsed: ParsedData): ParsedData {
	return { ...parsed, rows: parsed.rows.map((r) => ({ ...r })) };
}

const metrics: string[] = [];
afterAll(() => {
	// Aggregate runtime metrics only; read by the slice report.
	// eslint-disable-next-line no-console
	if (metrics.length) console.log(metrics.join('\n'));
});

for (const src of SOURCES) {
	const present = existsSync(join(ROOT, src.file));
	const describeSource = present ? describe : describe.skip;

	describeSource(`replay proof: ${src.label}`, () => {
		const userPreserve = src.recipe.target.also_emit?.frontmatter?.user_preserve ?? [];

		it('same recipe, same bytes, same set: every note keeps its managed content', async () => {
			const t0 = Date.now();
			const p = await prepare(src);
			const { app, files } = vault();

			const run1 = await generate(app, p.parsed, p.workbench, src.basePath, src.file.split('/').pop()!, 'new');
			expect(run1.errors).toEqual([]);
			const snap1 = notesUnder(files, src.basePath);
			expect(snap1.size).toBe(src.expectedNotes);
			const setIds = new Set([...snap1.values()].map((t) => crosswalker(t).import_set?.id));
			expect(setIds.size).toBe(1);
			const setId = [...setIds][0] as string;
			expect(typeof setId).toBe('string');
			const t1 = Date.now();

			const run2 = await generate(app, p.parsed, p.workbench, src.basePath, src.file.split('/').pop()!, { id: setId });
			expect(run2.errors).toEqual([]);
			const snap2 = notesUnder(files, src.basePath);
			const t2 = Date.now();

			expect([...snap2.keys()].sort()).toEqual([...snap1.keys()].sort());
			const diffs = compare(snap1, snap2, userPreserve);
			expect([...diffs.entries()].slice(0, 5)).toEqual([]);
			for (const text of snap2.values()) {
				const cw = crosswalker(text);
				expect(cw.recipe?.recipe_document_digest).toBe(p.savedDigest);
				expect(cw.import_set?.id).toBe(setId);
			}
			for (const text of snap1.values()) expect(crosswalker(text).recipe?.recipe_document_digest).toBe(p.savedDigest);

			metrics.push(`CW_REPLAY_METRIC ${JSON.stringify({ source: src.label, notes: snap1.size, run1Seconds: (t1 - t0) / 1000, run2Seconds: (t2 - t1) / 1000 })}`);
		});

		it('negative controls: a changed cell, a hand-edited managed field, an edited user field', async () => {
			const p = await prepare(src);
			const sourceName = src.file.split('/').pop()!;

			// (a) One source cell changes: only that note stops being equivalent.
			{
				const { app, files } = vault();
				await generate(app, p.parsed, p.workbench, src.basePath, sourceName, 'new');
				const snap1 = notesUnder(files, src.basePath);
				const setId = crosswalker([...snap1.values()][0]).import_set.id as string;

				const changed = clonedParsed(p.parsed);
				const idx = changed.rows.findIndex((r) => String(r[src.changeColumn] ?? '').trim() !== '' &&
					(src.label !== 'NIST CSF 2.0' || String(r.Subcategory ?? '').trim() !== ''));
				expect(idx).toBeGreaterThanOrEqual(0);
				changed.rows[idx][src.changeColumn] = `${String(changed.rows[idx][src.changeColumn])} changed`;
				await generate(app, changed, p.workbench, src.basePath, sourceName, { id: setId });
				const snap2 = notesUnder(files, src.basePath);
				const diffs = compare(snap1, snap2, userPreserve);
				expect(diffs.size).toBe(1);
				metrics.push(`CW_REPLAY_METRIC ${JSON.stringify({ source: src.label, control: 'a-cell', nonEquivalent: diffs.size, differences: [...diffs.values()][0] })}`);
			}

			// (a') The same change made in the source BYTES: the edited note differs
			// in content, and every other note differs only in the source digest
			// provenance, which records that the bytes changed.
			if (src.byteEditable) {
				const { app, files } = vault();
				await generate(app, p.parsed, p.workbench, src.basePath, sourceName, 'new');
				const snap1 = notesUnder(files, src.basePath);
				const setId = crosswalker([...snap1.values()][0]).import_set.id as string;

				const text = new TextDecoder().decode(p.bytes);
				const counts = new Map<string, number>();
				for (const r of p.parsed.rows) {
					const v = String(r[src.changeColumn] ?? '');
					if (v.length >= 12) counts.set(v, 0);
				}
				const unique = [...counts.keys()].find((v) => text.split(v).length === 2);
				expect(unique).toBeDefined();
				const edited = new TextEncoder().encode(text.replace(unique!, `${unique} changed`));
				const reparsed = await src.parse(edited);
				expect(reparsed.rowCount).toBe(p.parsed.rowCount);
				expect(reparsed.sourceByteDigest).not.toBe(p.parsed.sourceByteDigest);
				await generate(app, reparsed, p.workbench, src.basePath, sourceName, { id: setId });
				const snap2 = notesUnder(files, src.basePath);
				const diffs = compare(snap1, snap2, userPreserve);
				const contentChanged = [...diffs.entries()].filter(([, d]) => d.some((x) => !/_crosswalker\.source/.test(x)));
				expect(contentChanged).toHaveLength(1);
				const provenanceOnly = [...diffs.values()].filter((d) => d.every((x) => /_crosswalker\.source/.test(x)));
				expect(provenanceOnly).toHaveLength(src.expectedNotes - 1);
				metrics.push(`CW_REPLAY_METRIC ${JSON.stringify({ source: src.label, control: 'a-bytes', contentChanged: contentChanged.length, provenanceOnly: provenanceOnly.length, sample: [...diffs.values()][0] })}`);
			}

			// (b) A hand-edited managed field is restored by Replace.
			// (c) An edited user_preserve field survives, and the note stays equivalent.
			{
				const { app, files } = vault();
				await generate(app, p.parsed, p.workbench, src.basePath, sourceName, 'new');
				const snap1 = notesUnder(files, src.basePath);
				const setId = crosswalker([...snap1.values()][0]).import_set.id as string;
				const [managedPath, preservePath] = [...snap1.keys()].sort().slice(0, 2);
				expect(userPreserve.length).toBeGreaterThan(0);
				const preserveKey = userPreserve[0];

				files.set(managedPath, setFrontmatterLine(files.get(managedPath)!, src.managedKey, 'hand edited'));
				expect(managedContentEquivalent(snap1.get(managedPath)!, files.get(managedPath)!, { parseYaml, userPreserve }).equal).toBe(false);
				files.set(preservePath, addFrontmatterLine(files.get(preservePath)!, preserveKey, 'replay reviewer'));

				await generate(app, p.parsed, p.workbench, src.basePath, sourceName, { id: setId });
				const snap2 = notesUnder(files, src.basePath);
				const diffs = compare(snap1, snap2, userPreserve);
				expect([...diffs.entries()]).toEqual([]);
				expect(frontmatter(snap2.get(managedPath)!)[src.managedKey]).toEqual(frontmatter(snap1.get(managedPath)!)[src.managedKey]);
				expect(frontmatter(snap2.get(preservePath)!)[preserveKey]).toBe('replay reviewer');
			}
		});
	});
}
