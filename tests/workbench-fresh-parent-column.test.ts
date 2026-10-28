/**
 * workbench-fresh-parent-column.test.ts — a FRESH source (no library recipe)
 * whose hierarchy is carried by a parent-id column.
 *
 * Path pinned: parsed CSV -> MappingWorkbench (createFreshRecipeDocument) ->
 * parent column assigned (by detection defaults, or by hand the way a user does
 * in the workbench) -> buildRecipe() -> recipe guards -> generateNotes().
 *
 * Bug fixed 2026-10-28: a fresh document minted its ontology id with a plain
 * slug, so a digit-led file name ("2024 controls.csv") minted "2024-controls".
 * That is not a valid CURIE prefix, the automatic parent identity guard refused
 * it, and the workbench constructor threw before the user ever saw it.
 *
 * Synthetic ids only (A, A.1, A.1.a); no real framework content.
 */

import { TFile, TFolder } from 'obsidian';
import { MappingWorkbench } from '../src/import/workbench';
import { analyzeColumns, parseCSV } from '../src/import/parsers/csv-parser';
import type { ParsedData, ImportRecipe } from '../src/types/config';
import type { Destination, StructureMapping, LevelRule, DestinationPrimitive } from '../src/import/mapping/types';
import { addDestination } from '../src/import/mapping/view-model';
import { explainRecipeError, PARENT_IDENTITY_PREFIX_MESSAGE } from '../src/import/mapping/diagnostics';
import { validateRecipe } from '../src/validation/validator';
import { diagnoseEditableMapping } from '../src/import/recipe-document';
import { generateNotes, type GenerationOptions } from '../src/generation/generation-engine';
import { deriveFacetMemberships } from '../src/import/mapping/facets';
import type { Recipe } from '../src/render';
import type { DebugLog } from '../src/utils/debug';

const debug = { info() {}, trace() {}, warn() {}, error() {} } as unknown as DebugLog;

const CSV = [
	'id,parent,title',
	'A,,Alpha',
	'A.1,A,Alpha one',
	'A.1.a,A.1,Alpha one a',
	'A.2,A,Alpha two',
	'B,,Beta',
	'B.1,B,Beta one',
	'B.1.a,B.1,Beta one a',
	'B.2,B,Beta two',
	'',
].join('\n');

async function parsed(): Promise<ParsedData> {
	return parseCSV(CSV, {});
}

function workbenchFor(parsedData: ParsedData, sourceName: string): MappingWorkbench {
	return new MappingWorkbench({
		parsedData,
		columnInfos: analyzeColumns(parsedData),
		outputPath: 'Frameworks',
		debug,
		defaultPresetId: 'browsable-framework',
		sourceOntology: sourceName,
		onChange: () => {},
	});
}

interface WorkbenchInternals {
	removeMapping(mi: number): void;
	addManualMapping(column: string): void;
	updateMapping(mi: number, next: StructureMapping): void;
	defaultParams(primitive: DestinationPrimitive, rule: LevelRule): Record<string, string>;
	buildDestination(primitive: DestinationPrimitive, params: Record<string, string>): Destination;
}
const priv = (wb: MappingWorkbench) => wb as unknown as WorkbenchInternals;

function makeStatefulVault() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const app = {
		vault: {
			getMarkdownFiles: () => [],
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			create: async (path: string, content: string) => { files.set(path, content); return new TFile(path); },
			modify: async (file: { path: string }, content: string) => { files.set(file.path, content); },
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
			rename: async (file: { path: string }, newPath: string) => {
				const content = files.get(file.path);
				if (content !== undefined) { files.delete(file.path); files.set(newPath, content); }
			},
			delete: async (file: { path: string }) => { files.delete(file.path); },
		},
		metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
	};
	return { app: app as unknown as import('obsidian').App, files };
}

/** Drive generateNotes the way the wizard's workbench path does. */
async function generate(wb: MappingWorkbench, parsedData: ParsedData, recipe: Recipe) {
	const { app, files } = makeStatefulVault();
	const config: Partial<ImportRecipe> = {
		name: 'shape-workbench',
		mapping: { hierarchy: [], frontmatter: [], links: [], body: wb.getLegacyBodyMappings() },
	};
	const options: GenerationOptions = {
		basePath: 'Frameworks/Fresh',
		overwriteMode: 'replace',
		createFolders: true,
		recipeOverride: recipe,
		facetsForRow: (row: Record<string, unknown>) => deriveFacetMemberships(wb.getMapping(), row),
	};
	const result = await generateNotes(app, parsedData, config, options, debug);
	return { files, result };
}

function noteFor(files: Map<string, string>, id: string): string {
	const entry = [...files.entries()].find(([path]) => path.endsWith(`/${id}.md`));
	expect(entry).toBeDefined();
	return entry![1];
}

function expectUsableRecipe(wb: MappingWorkbench): Recipe {
	expect(diagnoseEditableMapping(wb.getMapping()).filter((d) => d.severity === 'blocking')).toEqual([]);
	const recipe = wb.buildRecipe();
	const validation = validateRecipe(recipe as never);
	expect(validation.errors).toEqual([]);
	expect(validation.valid).toBe(true);
	return recipe;
}

describe('fresh source with a parent column: detection defaults', () => {
	it.each([
		['controls.csv', 'controls'],
		// The regression: a digit-led name used to throw in the constructor.
		['2024 controls.csv', 'cw-2024-controls'],
		['800-53 sample.csv', 'cw-800-53-sample'],
		// Nothing slug-able left: falls back to a valid generic prefix.
		['表.csv', 'source'],
	])('%s opens, builds a valid recipe, and links each child to its parent', async (name, prefix) => {
		const data = await parsed();
		const wb = workbenchFor(data, name);

		const recipe = expectUsableRecipe(wb);
		expect(recipe.source?.ontology).toBe(prefix);
		const managed = recipe.target.also_emit?.frontmatter?.managed;
		expect(managed?.parent).toBe('[[{parent}]]');
		expect(managed?.parent_curie).toBe(`{parent|optional|curie-prefix(${prefix})}`);

		const { files, result } = await generate(wb, data, recipe);
		expect(result.errors ?? []).toEqual([]);

		const child = noteFor(files, 'A.1.a');
		expect(child).toMatch(/^parent: "?\[\[A\.1\]\]"?$/m);
		// parent_curie lands in the same identity space as the concept curies.
		expect(child).toContain(`parent_curie: "${prefix}:A.1"`);
		expect(noteFor(files, 'A.1')).toContain(`curie: "${prefix}:A.1"`);
		const root = noteFor(files, 'A');
		expect(root).not.toMatch(/^parent:/m);
		expect(root).not.toMatch(/^parent_curie:/m);
	});
});

describe('fresh source with a parent column: assigned by hand', () => {
	it('a user who removes the proposed link and re-adds the column as a parent link gets a valid recipe', async () => {
		const data = await parsed();
		const wb = workbenchFor(data, '2024 controls.csv');

		const linkIndex = wb.getMapping().mappings.findIndex((m) =>
			m.levels.some((l) => l.destinations.some((d) => d.primitive === 'link' && d.key === 'parent')));
		expect(linkIndex).toBeGreaterThanOrEqual(0);
		priv(wb).removeMapping(linkIndex);
		expect(wb.buildRecipe().target.also_emit?.frontmatter?.managed?.parent_curie).toBeUndefined();

		// The same calls the "Add mapping" button and the level add menu make.
		priv(wb).addManualMapping('parent');
		const mi = wb.getMapping().mappings.length - 1;
		const added = wb.getMapping().mappings[mi];
		const params = priv(wb).defaultParams('link', added.levels[0]);
		priv(wb).updateMapping(mi, addDestination(added, 0, priv(wb).buildDestination('link', params)));

		const recipe = expectUsableRecipe(wb);
		expect(recipe.target.also_emit?.frontmatter?.managed?.parent).toBe('[[{parent}]]');

		const { files, result } = await generate(wb, data, recipe);
		expect(result.errors ?? []).toEqual([]);
		expect(noteFor(files, 'A.1.a')).toMatch(/^parent: "?\[\[A\.1\]\]"?$/m);
		expect(noteFor(files, 'A')).not.toMatch(/^parent:/m);
	});
});

describe('loaded recipe whose ontology is not a CURIE prefix', () => {
	it('keeps the deliberate refusal but explains it in plain language', () => {
		const raw = 'Cannot derive parent_curie: recipe source.ontology must be a lowercase CURIE prefix (letters, digits, _ or -; first character must be a letter).';
		expect(explainRecipeError(raw)).toBe(PARENT_IDENTITY_PREFIX_MESSAGE);
		expect(PARENT_IDENTITY_PREFIX_MESSAGE).not.toContain('—');
		expect(PARENT_IDENTITY_PREFIX_MESSAGE).not.toMatch(/curie/i);
	});
});
