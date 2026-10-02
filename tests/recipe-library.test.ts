/**
 * recipe-library.test.ts — the saved import recipe library (slice 1).
 *
 * Runs the pure library over an in-memory file API. Covers acceptance cases
 * 1, 2 and 4 to 9 of the slice 1 spec; case 3 (reopen and regenerate) and 10
 * (offer, never preselect) are covered by the registry block below and the
 * e2e flow spec. Every id, title and column here is invented.
 */

import richFixture from './fixtures/portable-import-recipe-rich.json';
import {
	RECIPE_LIBRARY_FOLDER,
	builtInRecipes,
	deleteFromLibrary,
	destinationSteps,
	duplicate,
	exportRecipe,
	importRecipeFile,
	libraryRecognitionEntries,
	lineageLine,
	listLibrary,
	loadForImport,
	recipeSlug,
	rename,
	saveLineageLine,
	saveToLibrary,
	summarizeRecipeColumns,
	uniqueDisplayName,
	type RecipeLibraryFiles,
} from '../src/import/recipe-library';
import {
	loadRecipeDocument,
	serializeCanonicalRecipe,
	type RecipeDocument,
} from '../src/import/recipe-document';
import {
	RECIPE_REGISTRY,
	bestRecognizedRecipe,
	findRecognizedRecipes,
	libraryRegistryEntry,
} from '../src/import/recipe-registry';
import { MappingWorkbench } from '../src/import/workbench';
import { analyzeColumns } from '../src/import/parsers/csv-parser';
import { validateRecipe } from '../src/validation/validator';
import type { CrosswalkerImportRecipe } from '../src/types/generated/recipe';
import type { ImportMapping } from '../src/import/mapping/types';
import type { ParsedData } from '../src/types/config';
import type { DebugLog } from '../src/utils/debug';

const rich = richFixture as unknown as CrosswalkerImportRecipe;
const debug = { info() {}, trace() {}, warn() {}, error() {} } as unknown as DebugLog;

// ----------------------------------------------------------------------------
// In-memory file API
// ----------------------------------------------------------------------------

interface MemoryFiles extends RecipeLibraryFiles {
	store: Map<string, string>;
	folders: Set<string>;
	trashed: { path: string; text: string }[];
}

function memoryFiles(): MemoryFiles {
	const store = new Map<string, string>();
	const folders = new Set<string>();
	const trashed: { path: string; text: string }[] = [];
	const times = new Map<string, number>();
	let clock = 1_000;
	return {
		store,
		folders,
		trashed,
		exists: async (p) => folders.has(p) || store.has(p),
		listFiles: async (folder) => [...store.keys()].filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes('/')),
		read: async (p) => {
			const text = store.get(p);
			if (text === undefined) throw new Error('missing');
			return text;
		},
		write: async (p, text) => {
			store.set(p, text);
			times.set(p, ++clock);
		},
		mkdir: async (p) => { folders.add(p); },
		trash: async (p) => {
			const text = store.get(p);
			if (text === undefined) throw new Error('missing');
			trashed.push({ path: p, text });
			store.delete(p);
		},
		rename: async (from, to) => {
			const text = store.get(from);
			if (text === undefined) throw new Error('missing');
			store.delete(from);
			store.set(to, text);
			times.set(to, times.get(from) ?? ++clock);
		},
		mtime: async (p) => times.get(p) ?? null,
	};
}

function loadDoc(recipe: CrosswalkerImportRecipe, origin: 'bundled' | 'user' | 'fresh'): RecipeDocument {
	const loaded = loadRecipeDocument(recipe, { origin });
	if (!loaded.ok) throw new Error(loaded.diagnostics.map((d) => d.message).join('; '));
	return loaded.document;
}

/** Rename one managed property key: a workbench-owned edit. */
function editTitleKey(document: RecipeDocument): ImportMapping {
	const mapping = JSON.parse(JSON.stringify(document.mapping)) as ImportMapping;
	const level = mapping.mappings
		.flatMap((structure) => structure.levels)
		.find((l) => l.destinations.some((d) => d.primitive === 'property' && d.key === 'title'))!;
	const dest = level.destinations.find(
		(d): d is Extract<typeof d, { primitive: 'property' }> => d.primitive === 'property' && d.key === 'title',
	)!;
	dest.key = 'display_title';
	return mapping;
}

function freshWorkbench(): MappingWorkbench {
	const rows = Array.from({ length: 6 }, (_, i) => ({
		ref_code: `QC-${i + 1}`,
		family: i < 3 ? 'Alpha family' : 'Beta family',
		label: `Sample control ${i + 1}`,
		notes: `Invented body text ${i + 1}.`,
	}));
	const parsedData: ParsedData = { columns: Object.keys(rows[0]), rows, rowCount: rows.length };
	return new MappingWorkbench({
		parsedData,
		columnInfos: analyzeColumns(parsedData),
		outputPath: 'Frameworks',
		debug,
		defaultPresetId: 'browsable-framework',
		sourceOntology: 'Quarterly controls.csv',
		onChange: () => {},
	});
}

async function seedUserRecipe(files: MemoryFiles, id: string, title: string): Promise<CrosswalkerImportRecipe> {
	const recipe = JSON.parse(JSON.stringify(rich)) as CrosswalkerImportRecipe;
	recipe.recipe = id;
	recipe.metadata = { ...(recipe.metadata ?? {}), title };
	await files.mkdir('_crosswalker');
	await files.mkdir(RECIPE_LIBRARY_FOLDER);
	await files.write(`${RECIPE_LIBRARY_FOLDER}/${recipeSlug(title)}.json`, serializeCanonicalRecipe(recipe));
	return recipe;
}

// ----------------------------------------------------------------------------
// Acceptance cases
// ----------------------------------------------------------------------------

describe('recipe library: save', () => {
	it('case 1: a fresh setup saves as quarterly-controls.json with no lineage', async () => {
		const files = memoryFiles();
		const wb = freshWorkbench();
		const { document, options, result } = wb.patchForSave();
		expect(result.ok).toBe(true);
		expect(document.origin).toBe('fresh');
		expect(saveLineageLine(document)).toBeNull();

		const saved = await saveToLibrary(files, document, { name: 'Quarterly controls', mode: 'new', patch: options });
		expect(saved.ok).toBe(true);
		if (!saved.ok) return;
		expect(saved.path).toBe(`${RECIPE_LIBRARY_FOLDER}/quarterly-controls.json`);
		expect(saved.id).toBe('quarterly-controls');

		const text = files.store.get(saved.path)!;
		const onDisk = JSON.parse(text) as CrosswalkerImportRecipe;
		expect(validateRecipe(onDisk).valid).toBe(true);
		expect(onDisk.recipe).toBe('quarterly-controls');
		expect(onDisk.metadata?.title).toBe('Quarterly controls');
		expect(onDisk.metadata?.based_on).toBeUndefined();
		// The file is exactly the canonical serialization, not a wrapper.
		expect(text).toBe(serializeCanonicalRecipe(onDisk));
		// Identity, display and lineage aside, it is the patch output.
		const patched = result.ok ? result.recipe : null;
		expect(onDisk.target).toEqual(patched?.target);
		expect(onDisk.source).toEqual(patched?.source);
	});

	it('case 2: an edited built-in recipe gets a new id, lineage to the original, and byte-equal untouched regions', async () => {
		const files = memoryFiles();
		const document = loadDoc(rich, 'bundled');
		const mapping = editTitleKey(document);
		const saved = await saveToLibrary(files, document, { name: 'My edited setup', mode: 'new', patch: { mapping } });
		expect(saved.ok).toBe(true);
		if (!saved.ok) return;
		const onDisk = JSON.parse(files.store.get(saved.path)!) as CrosswalkerImportRecipe;

		expect(onDisk.recipe).toBe('my-edited-setup');
		expect(onDisk.recipe).not.toBe(rich.recipe);
		expect(onDisk.metadata?.based_on?.recipe).toBe(rich.recipe);
		expect(onDisk.target.also_emit?.frontmatter?.managed?.display_title).toBe('{title}');

		// Compare against the canonical serialization of the original (sorted keys).
		const canon = JSON.parse(serializeCanonicalRecipe(rich)) as CrosswalkerImportRecipe;
		const bytes = (v: unknown) => JSON.stringify(v);
		expect(bytes(onDisk.source)).toBe(bytes(canon.source));
		expect(bytes(onDisk.query)).toBe(bytes(canon.query));
		expect(bytes(onDisk.target.layout)).toBe(bytes(canon.target.layout));
		expect(bytes(onDisk.target.graph_edges)).toBe(bytes(canon.target.graph_edges));
		expect(bytes(onDisk.target.also_emit?.body)).toBe(bytes(canon.target.also_emit?.body));
		expect(bytes(onDisk.target.also_emit?.frontmatter?.managed_links)).toBe(
			bytes(canon.target.also_emit?.frontmatter?.managed_links),
		);
		expect(onDisk.target.linkStyle).toBe(canon.target.linkStyle);
		expect(onDisk.spec_version).toBe(canon.spec_version);
		// The in-memory original is never mutated.
		expect(document.original.recipe).toBe(rich.recipe);
	});

	it('an unedited built-in recipe still records where it came from', async () => {
		const files = memoryFiles();
		const document = loadDoc(rich, 'bundled');
		const saved = await saveToLibrary(files, document, { name: 'Straight copy', mode: 'new' });
		expect(saved.ok).toBe(true);
		if (!saved.ok) return;
		expect(saved.recipe.metadata?.based_on?.recipe).toBe(rich.recipe);
		expect(saved.recipe.target).toEqual(JSON.parse(serializeCanonicalRecipe(rich)).target);
	});

	it('case 4: the same name saved twice gets -2 and leaves the first untouched', async () => {
		const files = memoryFiles();
		const wb = freshWorkbench();
		const first = await saveToLibrary(files, wb.patchForSave().document, { name: 'Quarterly controls', mode: 'new' });
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const firstText = files.store.get(first.path);
		const second = await saveToLibrary(files, wb.patchForSave().document, { name: 'Quarterly controls', mode: 'new' });
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.id).toBe('quarterly-controls-2');
		expect(second.name).toBe('Quarterly controls 2');
		expect(second.path).toBe(`${RECIPE_LIBRARY_FOLDER}/quarterly-controls-2.json`);
		expect(files.store.get(first.path)).toBe(firstText);
	});

	it('case 5: replace keeps the id, trashes the old file, and writes the new content', async () => {
		const files = memoryFiles();
		const seeded = await seedUserRecipe(files, 'team-setup', 'Team setup');
		const oldText = files.store.get(`${RECIPE_LIBRARY_FOLDER}/team-setup.json`);
		const document = loadDoc(seeded, 'user');
		expect(saveLineageLine(document, (await listLibrary(files)).entries)).toBe('Based on your recipe "Team setup"');

		const mapping = editTitleKey(document);
		const saved = await saveToLibrary(files, document, { name: 'Team setup', mode: 'replace', patch: { mapping } });
		expect(saved.ok).toBe(true);
		if (!saved.ok) return;
		expect(saved.id).toBe('team-setup');
		expect(files.trashed).toEqual([{ path: `${RECIPE_LIBRARY_FOLDER}/team-setup.json`, text: oldText }]);
		const onDisk = JSON.parse(files.store.get(saved.path)!) as CrosswalkerImportRecipe;
		expect(onDisk.recipe).toBe('team-setup');
		expect(onDisk.target.also_emit?.frontmatter?.managed?.display_title).toBe('{title}');
		// Replace keeps the saved recipe's own lineage, never a self-reference.
		expect(onDisk.metadata?.based_on).toEqual(seeded.metadata?.based_on);
		expect(onDisk.metadata?.based_on?.recipe).not.toBe('team-setup');
		const listing = await listLibrary(files);
		expect(listing.entries.map((e) => e.id)).toEqual(['team-setup']);
	});

	it('replace is refused for a recipe that did not come from the library', async () => {
		const files = memoryFiles();
		const saved = await saveToLibrary(files, loadDoc(rich, 'bundled'), { name: 'Nope', mode: 'replace' });
		expect(saved.ok).toBe(false);
		if (saved.ok) return;
		expect(saved.cause).toMatch(/Only a recipe you saved/);
		expect(saved.action).toBeTruthy();
	});

	it('blocking problems in the setup stop the save with a cause and an action', async () => {
		const files = memoryFiles();
		const document = loadDoc(rich, 'bundled');
		const blocked: RecipeDocument = {
			...document,
			diagnostics: [{ code: 'lossy', severity: 'blocking', path: 'target', message: 'A part of this setup cannot be kept.' }],
		};
		const saved = await saveToLibrary(files, blocked, { name: 'Blocked', mode: 'new' });
		expect(saved.ok).toBe(false);
		if (saved.ok) return;
		expect(saved.cause).toBe('A part of this setup cannot be kept.');
		expect(saved.action).toMatch(/review step/);
		expect(files.store.size).toBe(0);
	});
});

describe('recipe library: listing', () => {
	it('case 6: one valid, one broken JSON, one invalid recipe and a duplicate id give 2 entries and 3 problems', async () => {
		const files = memoryFiles();
		await seedUserRecipe(files, 'alpha-setup', 'Alpha setup');
		await seedUserRecipe(files, 'beta-setup', 'Beta setup');
		const dup = JSON.parse(files.store.get(`${RECIPE_LIBRARY_FOLDER}/beta-setup.json`)!) as CrosswalkerImportRecipe;
		dup.metadata = { ...(dup.metadata ?? {}), title: 'Beta setup again' };
		await files.write(`${RECIPE_LIBRARY_FOLDER}/zz-beta-copy.json`, serializeCanonicalRecipe(dup));
		await files.write(`${RECIPE_LIBRARY_FOLDER}/broken.json`, '{ not json');
		await files.write(`${RECIPE_LIBRARY_FOLDER}/not-a-recipe.json`, JSON.stringify({ hello: 'world' }));
		await files.write(`${RECIPE_LIBRARY_FOLDER}/readme.txt`, 'ignored');

		const listing = await listLibrary(files);
		expect(listing.entries.map((e) => e.id)).toEqual(['alpha-setup', 'beta-setup']);
		expect(listing.entries.find((e) => e.id === 'beta-setup')?.name).toBe('Beta setup');
		expect(listing.problems).toHaveLength(3);
		const byFile = Object.fromEntries(listing.problems.map((p) => [p.file.split('/').pop(), p]));
		expect(byFile['broken.json'].cause).toMatch(/not valid JSON/);
		expect(byFile['not-a-recipe.json'].cause).toMatch(/not a valid import recipe/);
		expect(byFile['zz-beta-copy.json'].cause).toMatch(/Two recipe files use the id beta-setup/);
		for (const p of listing.problems) expect(p.action.length).toBeGreaterThan(0);
	});

	it('case 9: no folder is an empty library with no problems', async () => {
		const files = memoryFiles();
		expect(await listLibrary(files)).toEqual({ entries: [], problems: [] });
	});

	it('a saved recipe reusing a built-in id is reported, not loaded', async () => {
		const files = memoryFiles();
		const builtInId = RECIPE_REGISTRY[0].id;
		await seedUserRecipe(files, builtInId, 'Shadow');
		const listing = await listLibrary(files);
		expect(listing.entries).toHaveLength(0);
		expect(listing.problems[0].cause).toMatch(/belongs to a built-in recipe/);
	});
});

describe('recipe library: export, import, delete, duplicate, rename', () => {
	it('case 7: export then import into another vault is byte-identical; a colliding id gets -2', async () => {
		const files = memoryFiles();
		await seedUserRecipe(files, 'gamma-setup', 'Gamma setup');
		const exported = await exportRecipe(files, 'gamma-setup');
		expect(exported.ok).toBe(true);
		if (!exported.ok) return;
		expect(exported.fileName).toBe('gamma-setup.json');

		const other = memoryFiles();
		const imported = await importRecipeFile(other, exported.text);
		expect(imported.ok).toBe(true);
		if (!imported.ok) return;
		expect(imported.id).toBe('gamma-setup');
		expect(other.store.get(imported.path)).toBe(exported.text);

		const again = await importRecipeFile(files, exported.text);
		expect(again.ok).toBe(true);
		if (!again.ok) return;
		expect(again.id).toBe('gamma-setup-2');
		expect(again.name).toBe('Gamma setup 2');
		const againRecipe = JSON.parse(files.store.get(again.path)!) as CrosswalkerImportRecipe;
		expect(againRecipe.metadata?.title).toBe('Gamma setup 2');
		expect((await listLibrary(files)).entries.map((e) => e.id).sort()).toEqual(['gamma-setup', 'gamma-setup-2']);
	});

	it('importing a file that is not a recipe names the cause and the action', async () => {
		const files = memoryFiles();
		for (const text of ['nope', JSON.stringify({ recipe: 'x' })]) {
			const result = await importRecipeFile(files, text);
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(`${result.cause} ${result.action}`).toBe(
				'This file is not a Crosswalker import recipe. Choose a .json file exported from Crosswalker.',
			);
		}
		expect(files.store.size).toBe(0);
	});

	it('case 8: delete sends a saved recipe to the trash; built-in recipes cannot be deleted', async () => {
		const files = memoryFiles();
		await seedUserRecipe(files, 'delta-setup', 'Delta setup');
		const deleted = await deleteFromLibrary(files, 'delta-setup');
		expect(deleted.ok).toBe(true);
		expect(files.trashed.map((t) => t.path)).toEqual([`${RECIPE_LIBRARY_FOLDER}/delta-setup.json`]);
		expect((await listLibrary(files)).entries).toHaveLength(0);

		const builtIn = await deleteFromLibrary(files, builtInRecipes()[0].id);
		expect(builtIn.ok).toBe(false);
		if (builtIn.ok) return;
		expect(builtIn.cause).toMatch(/Built-in recipes cannot be deleted/);
	});

	it('duplicate makes an editable copy with lineage; rename changes name and file, never the id', async () => {
		const files = memoryFiles();
		await seedUserRecipe(files, 'epsilon-setup', 'Epsilon setup');
		const copy = await duplicate(files, 'epsilon-setup');
		expect(copy.ok).toBe(true);
		if (!copy.ok) return;
		expect(copy.name).toBe('Epsilon setup copy');
		const copy2 = await duplicate(files, 'epsilon-setup');
		expect(copy2.ok && copy2.name).toBe('Epsilon setup copy 2');
		const listing = await listLibrary(files);
		const copyEntry = listing.entries.find((e) => e.id === copy.id)!;
		expect(copyEntry.recipe.metadata?.based_on?.recipe).toBe('epsilon-setup');
		expect(lineageLine(copyEntry.recipe, listing.entries)).toBe('Based on your recipe "Epsilon setup"');

		const builtIn = builtInRecipes()[0];
		const builtInCopy = await duplicate(files, builtIn.id);
		expect(builtInCopy.ok).toBe(true);
		if (!builtInCopy.ok) return;
		const loaded = await loadForImport(files, builtInCopy.id);
		expect(loaded.ok && loaded.origin).toBe('user');
		if (!loaded.ok) return;
		expect(lineageLine(loaded.recipe)).toBe(`Based on ${builtIn.label} (built in)`);

		const renamed = await rename(files, 'epsilon-setup', 'Renamed setup');
		expect(renamed.ok).toBe(true);
		if (!renamed.ok) return;
		expect(renamed.path).toBe(`${RECIPE_LIBRARY_FOLDER}/renamed-setup.json`);
		const after = (await listLibrary(files)).entries.find((e) => e.id === 'epsilon-setup');
		expect(after?.name).toBe('Renamed setup');
		expect(files.store.has(`${RECIPE_LIBRARY_FOLDER}/epsilon-setup.json`)).toBe(false);
	});

	it('the inspect panel lists columns with roles', () => {
		const rows = summarizeRecipeColumns(rich);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(row.column.startsWith('_cw')).toBe(false);
	});

	it('a recipe whose ancestor is gone says so in plain words', () => {
		const orphan = JSON.parse(JSON.stringify(rich)) as CrosswalkerImportRecipe;
		orphan.metadata = { ...(orphan.metadata ?? {}), based_on: { recipe: 'gone-setup', hash: 'h', spec_version: orphan.spec_version ?? 'https://crosswalker.dev/spec/recipe.schema.json' } };
		expect(lineageLine(orphan, [])).toBe('Based on a recipe that is no longer in your library');
	});
});

describe('recipe library: destination steps', () => {
	function withLayout(layout: unknown[]): CrosswalkerImportRecipe {
		const recipe = JSON.parse(JSON.stringify(rich)) as CrosswalkerImportRecipe;
		(recipe.target as { layout: unknown[] }).layout = layout;
		return recipe;
	}

	it('turns folder and file entries into plain steps, skipping headings', () => {
		const recipe = withLayout([
			{ level: 'root', mechanism: 'folder', template: 'Controls' },
			{ level: 'family', mechanism: 'folder', template: '{family}' },
			{ level: 'control', mechanism: 'heading', template: '{title}' },
			{ level: 'control', mechanism: 'file', template: '{ref} {title|slug}.md' },
		]);
		expect(destinationSteps(recipe)).toEqual([
			{ kind: 'folder', columns: [], literal: 'Controls' },
			{ kind: 'folder', columns: ['family'], literal: null },
			{ kind: 'note', columns: ['ref', 'title'], literal: null },
		]);
	});

	it('lists a column once even when the template repeats it', () => {
		const recipe = withLayout([{ level: 'control', mechanism: 'file', template: '{ref}-{ref|slug}.md' }]);
		expect(destinationSteps(recipe)).toEqual([{ kind: 'note', columns: ['ref'], literal: null }]);
	});

	it('works on the rich fixture without template braces leaking out', () => {
		for (const step of destinationSteps(rich)) {
			for (const column of step.columns) expect(column).not.toMatch(/[{}|]/);
			if (step.literal) expect(step.literal).not.toMatch(/[{}]/);
		}
	});
});

describe('recipe library: unique display names', () => {
	const entries = [
		{ id: 'alpha', name: 'Alpha setup' },
		{ id: 'alpha-2', name: 'alpha setup 2' },
		{ id: 'beta', name: 'Beta setup' },
	];

	it('keeps a name nobody uses', () => {
		expect(uniqueDisplayName('Gamma setup', entries)).toBe('Gamma setup');
	});

	it('appends the next free number, ignoring case', () => {
		expect(uniqueDisplayName('ALPHA SETUP', entries)).toBe('ALPHA SETUP 3');
		expect(uniqueDisplayName('Beta setup', entries)).toBe('Beta setup 2');
	});

	it('trims the typed name', () => {
		expect(uniqueDisplayName('  Gamma setup  ', entries)).toBe('Gamma setup');
	});

	it('ignores the recipe being replaced', () => {
		expect(uniqueDisplayName('Beta setup', entries, 'beta')).toBe('Beta setup');
	});
});

// ----------------------------------------------------------------------------
// Recognition merge (case 10) and origin user through the workbench
// ----------------------------------------------------------------------------

describe('recipe library: recognition and reopen', () => {
	const builtIn = builtInRecipes()[0];

	function libraryCopyOf(id: string, title: string): CrosswalkerImportRecipe {
		const recipe = JSON.parse(JSON.stringify(builtIn.recipe)) as CrosswalkerImportRecipe;
		recipe.recipe = id;
		recipe.metadata = { ...(recipe.metadata ?? {}), title, based_on: { recipe: builtIn.id, hash: 'h', spec_version: recipe.spec_version ?? 'https://crosswalker.dev/spec/recipe.schema.json' } };
		return recipe;
	}

	it('case 10: a saved recipe joins recognition, outranks a built-in at equal score, and is labeled as yours', () => {
		const mine = libraryRegistryEntry(libraryCopyOf('my-team-copy', 'My team copy'));
		expect(mine.origin).toBe('user');
		expect(mine.label).toBe('My team copy');
		const columns = builtIn.signatureColumns;

		const without = bestRecognizedRecipe(columns);
		expect(without?.entry.origin ?? 'built-in').not.toBe('user');

		const ranked = findRecognizedRecipes(columns, undefined, [mine]);
		const mineMatch = ranked.find((m) => m.entry.id === 'my-team-copy');
		const builtInMatch = ranked.find((m) => m.entry.id === builtIn.id);
		expect(mineMatch).toBeDefined();
		expect(builtInMatch).toBeDefined();
		expect(mineMatch!.score).toBe(builtInMatch!.score);
		expect(ranked.indexOf(mineMatch!)).toBeLessThan(ranked.indexOf(builtInMatch!));
		const best = bestRecognizedRecipe(columns, undefined, [mine]);
		expect(best?.entry.id).toBe('my-team-copy');
		expect(best?.entry.origin).toBe('user');
	});

	it('libraryRecognitionEntries turns a listing into user-origin candidates', async () => {
		const files = memoryFiles();
		await seedUserRecipe(files, 'zeta-setup', 'Zeta setup');
		const entries = libraryRecognitionEntries(await listLibrary(files));
		expect(entries.map((e) => [e.id, e.origin, e.label])).toEqual([['zeta-setup', 'user', 'Zeta setup']]);
	});

	it('a saved recipe opens in the workbench as origin user, and an untouched save is not dirty', async () => {
		const files = memoryFiles();
		await seedUserRecipe(files, 'eta-setup', 'Eta setup');
		const loaded = await loadForImport(files, 'eta-setup');
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		const row: Record<string, unknown> = {
			edge_id: 'E.1', title: 'Invented', subject_id: 'a:1', predicate_id: 'p', object_id: 'b:1',
			subject_group: 'G', mapping_justification: 'j', mapping_provider: 'p', related: '', description: 'd',
			discussion: '', example: '', items: '',
		};
		const parsedData: ParsedData = { columns: Object.keys(row), rows: [row], rowCount: 1 };
		const wb = new MappingWorkbench({
			parsedData,
			columnInfos: analyzeColumns(parsedData),
			outputPath: 'Mappings',
			debug,
			defaultPresetId: 'browsable-framework',
			initialRecipe: loaded.recipe,
			recipeOrigin: 'user',
			seedColumnDefaults: false,
			onChange: () => {},
		});
		const { document, result } = wb.patchForSave();
		expect(document.origin).toBe('user');
		expect(result.ok && result.dirty).toBe(false);
		if (result.ok) expect(result.recipe.recipe).toBe('eta-setup');
	});
});

describe('recipe library: saving twice in one session', () => {
	it('after a save the workbench is bound to the saved recipe, so the next save can replace it', async () => {
		const files = memoryFiles();
		const wb = freshWorkbench();
		const initial = wb.patchForSave();
		const first = await saveToLibrary(files, initial.document, { name: 'Quarterly controls', mode: 'new', patch: initial.options });
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const loaded = await loadForImport(files, first.id);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(wb.rebindToSavedRecipe(loaded.recipe)).toBe(true);

		const untouched = wb.patchForSave();
		expect(untouched.document.origin).toBe('user');
		expect(untouched.document.original.recipe).toBe(first.id);
		expect(untouched.result.ok && untouched.result.dirty).toBe(false);
		expect(saveLineageLine(untouched.document, (await listLibrary(files)).entries)).toBe('Based on your recipe "Quarterly controls"');

		// A workbench-owned edit: the first level also lands in a new property.
		const firstLevel = wb.getMapping().mappings.flatMap((structure) => structure.levels)[0];
		expect(firstLevel).toBeDefined();
		firstLevel.destinations.push({ primitive: 'property', key: 'invented_extra' });
		const edited = wb.patchForSave();
		expect(edited.result.ok && edited.result.dirty).toBe(true);

		const replaced = await saveToLibrary(files, edited.document, { name: 'Quarterly controls', mode: 'replace', patch: edited.options });
		expect(replaced.ok).toBe(true);
		if (!replaced.ok) return;
		expect(replaced.id).toBe(first.id);
		expect((await listLibrary(files)).entries.map((e) => e.id)).toEqual([first.id]);
	});
});
