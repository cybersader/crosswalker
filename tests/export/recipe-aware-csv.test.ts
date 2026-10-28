/**
 * recipe-aware-csv.test.ts — units behind the recipe-aware CSV export.
 *
 * Covers: the per-note recipe resolver (hit, miss, digest mismatch, legacy,
 * no recipe, caching); column planning and the inverse per destination,
 * including templates that cannot be reversed; the folder hub fallback; row
 * and header ordering; mixed recipes; and the notice text.
 */

import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';
import {
	NoteRecipeResolver,
	OMIT_REASONS,
	csvExportNotice,
	hubValuesFor,
	inverseCell,
	parseManagedBody,
	planRecipeColumns,
	recipeAwareRowsToCsv,
	unwrapBodyFormat,
	type ColumnPlan,
	type ConceptRow,
	type HubRow,
	type RecipeAwareRow,
} from '../../src/export';
import { loadRecipeDocument } from '../../src/import/recipe-document';
import { saveToLibrary, type RecipeLibraryFiles } from '../../src/import/recipe-library';
import { recipeRunDigest } from '../../src/import/recipe-runs';
import type { CrosswalkerImportRecipe } from '../../src/types/generated/recipe';

const g = globalThis as unknown as Record<string, unknown>;
if (!g.TextDecoder) g.TextDecoder = NodeTextDecoder;
if (!g.TextEncoder) g.TextEncoder = NodeTextEncoder;

function memoryLibrary(): RecipeLibraryFiles & { reads: number } {
	const store = new Map<string, string>();
	const folders = new Set<string>();
	const lib = {
		reads: 0,
		exists: async (p: string) => folders.has(p) || store.has(p),
		listFiles: async (folder: string) =>
			[...store.keys()].filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes('/')),
		read: async (p: string) => {
			lib.reads++;
			const text = store.get(p);
			if (text === undefined) throw new Error('missing');
			return text;
		},
		write: async (p: string, text: string) => {
			store.set(p, text);
		},
		mkdir: async (p: string) => {
			folders.add(p);
		},
		trash: async (p: string) => {
			store.delete(p);
		},
		rename: async (from: string, to: string) => {
			const text = store.get(from);
			if (text === undefined) throw new Error('missing');
			store.delete(from);
			store.set(to, text);
		},
	};
	return lib;
}

const RECIPE = {
	recipe: 'unit-recipe',
	source: { ontology: 'unit', levels: ['family', 'control'] },
	target: {
		auto_heading: '{name}',
		layout: [
			{ level: 'family', mechanism: 'folder', template: '{family}' },
			{ level: 'control', mechanism: 'file', template: '{name|fs-safe}.md' },
		],
		also_emit: {
			frontmatter: { managed: { id: '{id}', label: 'Control {id}' } },
			body: [
				{ template: '{summary}', position: 'section', heading: 'Summary', heading_depth: 2, format: 'quote' },
				{ template: '{steps}', position: 'section', heading: 'Steps', heading_depth: 2, format: 'list' },
			],
		},
	},
} as unknown as CrosswalkerImportRecipe;

async function savedRecipe(lib: RecipeLibraryFiles, raw: unknown = RECIPE, name = 'Unit recipe') {
	const loaded = loadRecipeDocument(raw, { origin: 'bundled' });
	if (!loaded.ok) throw new Error('recipe did not load');
	const saved = await saveToLibrary(lib, loaded.document, { name, mode: 'new' });
	if (!saved.ok) throw new Error('save failed');
	return saved;
}

function stamped(id: string, digest?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { _crosswalker: { recipe: { id, ...(digest ? { recipe_document_digest: digest } : {}) }, ...extra } };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

describe('NoteRecipeResolver', () => {
	it('resolves a saved recipe by id when the digest matches', async () => {
		const lib = memoryLibrary();
		const saved = await savedRecipe(lib);
		const resolver = new NoteRecipeResolver(lib);
		const result = await resolver.resolve(stamped(saved.id, recipeRunDigest(saved.recipe)));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.id).toBe(saved.id);
		expect(resolver.fallbacks).toEqual({ 'no-recipe': 0, legacy: 0, missing: 0, 'digest-mismatch': 0 });
	});

	it('resolves without a digest stamp, as notes written before the stamp', async () => {
		const lib = memoryLibrary();
		const saved = await savedRecipe(lib);
		const result = await new NoteRecipeResolver(lib).resolve(stamped(saved.id));
		expect(result.ok).toBe(true);
	});

	it('falls back on an id that is in neither the library nor the built-ins', async () => {
		const resolver = new NoteRecipeResolver(memoryLibrary());
		const result = await resolver.resolve(stamped('no-such-recipe-anywhere'));
		expect(result).toEqual({ ok: false, reason: 'missing' });
		expect(resolver.fallbacks.missing).toBe(1);
	});

	it('falls back when the saved recipe is not the revision that wrote the note', async () => {
		const lib = memoryLibrary();
		const saved = await savedRecipe(lib);
		const resolver = new NoteRecipeResolver(lib);
		const result = await resolver.resolve(stamped(saved.id, 'sha256:0000'));
		expect(result).toEqual({ ok: false, reason: 'digest-mismatch' });
		expect(resolver.fallbacks['digest-mismatch']).toBe(1);
	});

	it('falls back on the legacy column-mapping import and on notes with no recipe', async () => {
		const resolver = new NoteRecipeResolver(memoryLibrary());
		expect(await resolver.resolve(stamped('legacy-config'))).toEqual({ ok: false, reason: 'legacy' });
		expect(await resolver.resolve({ title: 'Plain note' })).toEqual({ ok: false, reason: 'no-recipe' });
		expect(resolver.fallbacks).toEqual({ 'no-recipe': 1, legacy: 1, missing: 0, 'digest-mismatch': 0 });
	});

	it('reads the library once per recipe revision, however many notes it wrote', async () => {
		const lib = memoryLibrary();
		const saved = await savedRecipe(lib);
		const digest = recipeRunDigest(saved.recipe);
		const resolver = new NoteRecipeResolver(lib);
		const before = lib.reads;
		await resolver.resolve(stamped(saved.id, digest));
		const once = lib.reads;
		for (let i = 0; i < 5; i++) await resolver.resolve(stamped(saved.id, digest));
		expect(lib.reads).toBe(once);
		expect(once).toBeGreaterThan(before);
	});

	it('uses the recipe id, never the folder or the file name', async () => {
		const lib = memoryLibrary();
		await savedRecipe(lib);
		// A note sitting in a folder named after the recipe, with no stamp.
		const result = await new NoteRecipeResolver(lib).resolve({ title: 'unit-recipe' });
		expect(result).toEqual({ ok: false, reason: 'no-recipe' });
	});
});

// ---------------------------------------------------------------------------
// Planning and the inverse per destination
// ---------------------------------------------------------------------------

describe('planRecipeColumns', () => {
	it('gives back bare templates and names the ones that cannot be reversed', () => {
		const plan = planRecipeColumns(RECIPE);
		expect(plan.columns.map((c) => c.column)).toEqual(['family', 'name', 'id', 'summary', 'steps']);
		// `label` writes `Control {id}`; `id` is still exact through its own property.
		expect(plan.omitted).toEqual([]);
		expect(plan.folderCount).toBe(1);
	});

	it('omits a column that only appears inside a composite template', () => {
		const recipe = {
			recipe: 'composite',
			source: { ontology: 'unit' },
			target: {
				layout: [{ level: 'control', mechanism: 'file', template: '{id} {name}.md' }],
				also_emit: { frontmatter: { managed: { label: 'Control {code}' } } },
			},
		} as unknown as CrosswalkerImportRecipe;
		const plan = planRecipeColumns(recipe);
		expect(plan.columns).toEqual([]);
		expect(plan.omitted.map((o) => o.column).sort()).toEqual(['code', 'id', 'name']);
		for (const o of plan.omitted) expect(o.reason).toBe(OMIT_REASONS.template);
	});

	it('omits columns only stored as tags or links', () => {
		const recipe = {
			recipe: 'tags-links',
			source: { ontology: 'unit' },
			target: {
				layout: [
					{ level: 'control', mechanism: 'file', template: '{id}.md' },
					{ level: 'theme', mechanism: 'tag', template: '{theme}' },
				],
				also_emit: { frontmatter: { managed_links: { related: { template: '{related}' } } } },
			},
		} as unknown as CrosswalkerImportRecipe;
		const plan = planRecipeColumns(recipe);
		expect(plan.columns.map((c) => c.column)).toEqual(['id', 'related']);
		const reasons = Object.fromEntries(plan.omitted.map((o) => [o.column, o.reason]));
		expect(reasons.theme).toBe(OMIT_REASONS.tags);
		expect(reasons.related).toBeUndefined();
	});

	it('still omits a column inside a built-up link template', () => {
		const recipe = {
			recipe: 'composite-link',
			source: { ontology: 'unit' },
			target: {
				layout: [{ level: 'control', mechanism: 'file', template: '{id}.md' }],
				also_emit: { frontmatter: { managed_links: { related: { template: 'Controls/{related}' }, pair: { template: '{a} and {b}' } } } },
			},
		} as unknown as CrosswalkerImportRecipe;
		const plan = planRecipeColumns(recipe);
		expect(plan.columns.map((c) => c.column)).toEqual(['id']);
		const reasons = Object.fromEntries(plan.omitted.map((o) => [o.column, o.reason]));
		expect(reasons).toEqual({ related: OMIT_REASONS.links, a: OMIT_REASONS.links, b: OMIT_REASONS.links });
	});

	it('takes the brackets off a bare link on the way back, alias included', () => {
		const recipe = {
			recipe: 'bare-link',
			source: { ontology: 'unit' },
			target: {
				layout: [{ level: 'control', mechanism: 'file', template: '{id}.md' }],
				also_emit: { frontmatter: { managed: { parent: '[[{parent}]]' }, managed_links: { related: { template: '{related}', split: [';'] } } } },
			},
		} as unknown as CrosswalkerImportRecipe;
		const plan = planRecipeColumns(recipe);
		const parent = plan.columns.find((c) => c.column === 'parent') as ColumnPlan;
		const cell = (value: unknown) =>
			inverseCell(parent, { path: 'X/AC-2.md', frontmatter: { parent: value }, text: '' }, null, plan).value;
		expect(cell('[[AC-1]]')).toBe('AC-1');
		expect(cell('[[AC-1|Access policy]]')).toBe('AC-1');
		expect(cell(['[[AC-1]]', '[[AC-3]]'])).toBe('AC-1|AC-3');
		// A value the user edited into plain text comes back as written.
		expect(cell('AC-1')).toBe('AC-1');
		expect(cell(undefined)).toBe('');
		// A link array joins on its first split delimiter, so it re-imports to the same links.
		const related = plan.columns.find((c) => c.column === 'related') as ColumnPlan;
		const list = inverseCell(related, { path: 'X/AC-2.md', frontmatter: { related: ['[[AC-1]]', '[[PM-9]]'] }, text: '' }, null, plan);
		expect(list.value).toBe('AC-1;PM-9');
	});
});

describe('inverseCell per destination', () => {
	const plan = planRecipeColumns(RECIPE);
	const byColumn = (c: string) => plan.columns.find((p) => p.column === c) as ColumnPlan;
	const text = [
		'---',
		'id: AC-1',
		'---',
		'<!-- crosswalker:body:start v=1 -->',
		'# Policy and Procedures',
		'',
		'## Summary',
		'',
		'> First line',
		'>',
		'> Third line',
		'',
		'## Steps',
		'',
		'- one',
		'- two',
		'<!-- crosswalker:body:end -->',
		'',
	].join('\n');

	it('reads properties from frontmatter and sections from the managed region', () => {
		const note = { path: 'Sets/unit/AC/Policy and Procedures.md', frontmatter: { id: 'AC-1' }, text };
		const body = parseManagedBody(text, plan, RECIPE);
		expect(body).not.toBeNull();
		expect(inverseCell(byColumn('id'), note, body, plan)).toEqual({ value: 'AC-1', fromName: false });
		expect(inverseCell(byColumn('summary'), note, body, plan).value).toBe('First line\n\nThird line');
		expect(inverseCell(byColumn('steps'), note, body, plan).value).toBe('one\ntwo');
		expect(inverseCell(byColumn('name'), note, body, plan)).toEqual({ value: 'Policy and Procedures', fromName: false });
	});

	it('reads a folder level from the stamp first, then the hub, then the path', () => {
		const base = { path: 'Sets/unit/AC-folder/X.md', text };
		const destination = { import_set: { id: 'iset-1', destination: 'Sets/unit' } };
		const body = parseManagedBody(text, plan, RECIPE);
		const withStamp = {
			...base,
			frontmatter: { _crosswalker: { ...destination, layout_values: [{ level: 'family', value: 'AC' }] } },
			hubValues: new Map([['family', 'HUB']]),
		};
		expect(inverseCell(byColumn('family'), withStamp, body, plan)).toEqual({ value: 'AC', fromName: false });
		const withHub = { ...base, frontmatter: { _crosswalker: destination }, hubValues: new Map([['family', 'AC']]) };
		expect(inverseCell(byColumn('family'), withHub, body, plan)).toEqual({ value: 'AC', fromName: false });
		const pathOnly = { ...base, frontmatter: { _crosswalker: destination } };
		expect(inverseCell(byColumn('family'), pathOnly, body, plan)).toEqual({ value: 'AC-folder', fromName: true });
	});

	it('uses the file name for the file level only when there is no heading', () => {
		const noHeading = text.replace('# Policy and Procedures\n\n', '');
		const body = parseManagedBody(noHeading, plan, RECIPE);
		const note = { path: 'Sets/unit/AC/Policy and Procedures.md', frontmatter: {}, text: noHeading };
		expect(inverseCell(byColumn('name'), note, body, plan)).toEqual({ value: 'Policy and Procedures', fromName: true });
	});

	it('unwraps every body format', () => {
		expect(unwrapBodyFormat('plain\ntext', 'text')).toBe('plain\ntext');
		expect(unwrapBodyFormat('> a\n>\n> b', 'quote')).toBe('a\n\nb');
		expect(unwrapBodyFormat('- a\n- b', 'list')).toBe('a\nb');
		expect(unwrapBodyFormat('```\ncode here\n```', 'code')).toBe('code here');
	});
});

// ---------------------------------------------------------------------------
// Folder hub fallback
// ---------------------------------------------------------------------------

function concept(path: string, frontmatter: Record<string, unknown>): ConceptRow {
	return { kind: 'concept', path, curie: String(frontmatter.curie ?? path), aliases: [], tags: [], children: [], frontmatter };
}
function hub(path: string, set: string, levels: string[], values: string[]): HubRow {
	return {
		kind: 'hub',
		path,
		curie: path,
		tags: [],
		children: [],
		frontmatter: { kind: 'hub', hub_levels: levels, hub_values: values, _crosswalker: { import_set: { id: set } } },
	};
}

describe('hubValuesFor', () => {
	it('takes level values from hubs of the same set above the note, deeper hubs winning', () => {
		const row = concept('Sets/unit/AC/sub/X.md', { _crosswalker: { import_set: { id: 'iset-1' } } });
		const hubs = [
			hub('Sets/unit/AC/AC.md', 'iset-1', ['family'], ['AC']),
			hub('Sets/unit/AC/sub/sub.md', 'iset-1', ['family', 'group'], ['AC-deeper', 'G1']),
			hub('Sets/unit/AU/AU.md', 'iset-1', ['family'], ['AU']),
		];
		expect(hubValuesFor(row, hubs)).toEqual(new Map([['family', 'AC-deeper'], ['group', 'G1']]));
	});

	it('ignores hubs of another set, whatever their folder', () => {
		const row = concept('Sets/unit/AC/X.md', { _crosswalker: { import_set: { id: 'iset-1' } } });
		expect(hubValuesFor(row, [hub('Sets/unit/AC/AC.md', 'iset-2', ['family'], ['AC'])])).toBeUndefined();
	});

	it('returns nothing for a note with no set', () => {
		expect(hubValuesFor(concept('Sets/X.md', {}), [hub('Sets/S.md', 'iset-1', ['family'], ['AC'])])).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Ordering, mixed recipes
// ---------------------------------------------------------------------------

describe('recipeAwareRowsToCsv', () => {
	const recipe = { key: 'k1', recipe: RECIPE };
	const row = (path: string, order: number | undefined, fm: Record<string, unknown>): RecipeAwareRow => ({
		row: concept(path, { ...fm, _crosswalker: { ...(order !== undefined ? { source_order: order } : {}) } }),
		recipe,
		text: `---\n---\n<!-- crosswalker:body:start v=1 -->\n# ${String(fm.title)}\n<!-- crosswalker:body:end -->\n`,
	});

	it('sorts rows by source order, then path, and leads with the recipe columns', () => {
		const result = recipeAwareRowsToCsv([
			row('b.md', 2, { id: 'B', title: 'B title', note_extra: 'x' }),
			row('z.md', undefined, { id: 'Z', title: 'Z title' }),
			row('a.md', 1, { id: 'A', title: 'A title' }),
			row('c.md', undefined, { id: 'C', title: 'C title' }),
		]);
		expect(result.columns.slice(0, 5)).toEqual(['family', 'name', 'id', 'summary', 'steps']);
		expect(result.columns).toContain('note_extra');
		// The managed `label` key is accounted for by the recipe, not repeated as an extra.
		expect(result.columns).not.toContain('label');
		const ids = result.csv.split('\n').slice(1).map((line) => line.split(',')[2]);
		expect(ids).toEqual(['A', 'B', 'C', 'Z']);
		expect(result.mixedRecipes).toBe(false);
	});

	it('lays recipe columns out in the recorded source order, keeping unlisted ones after', () => {
		const result = recipeAwareRowsToCsv([row('a.md', 1, { id: 'A', title: 'A title' })], {
			sourceOrder: ['id', 'steps', 'unused', 'name', 'family'],
		});
		expect(result.columns.slice(0, 5)).toEqual(['id', 'steps', 'name', 'family', 'summary']);
		expect(result.csv.split('\n')[1].split(',')[0]).toBe('A');
	});

	it('gives the union of columns and flags mixed recipes', () => {
		const other = {
			key: 'k2',
			recipe: {
				recipe: 'other',
				source: { ontology: 'other' },
				target: {
					layout: [{ level: 'item', mechanism: 'file', template: '{code}.md' }],
					also_emit: { frontmatter: { managed: { code: '{code}' } } },
				},
			} as unknown as CrosswalkerImportRecipe,
		};
		const result = recipeAwareRowsToCsv([
			row('a.md', 1, { id: 'A', title: 'A' }),
			{ row: concept('o.md', { code: 'O-1', _crosswalker: { source_order: 2 } }), recipe: other },
		]);
		expect(result.columns.slice(0, 6)).toEqual(['family', 'name', 'id', 'summary', 'steps', 'code']);
		expect(result.mixedRecipes).toBe(true);
		const lines = result.csv.split('\n');
		// The second recipe's row leaves the first recipe's columns empty.
		expect(lines[2].startsWith(',,,,,O-1')).toBe(true);
	});

	it('flags a folder mixing recipe rows with properties-only rows', () => {
		const result = recipeAwareRowsToCsv([
			row('a.md', 1, { id: 'A', title: 'A' }),
			{ row: concept('p.md', { id: 'P', _crosswalker: { source_order: 2 } }) },
		]);
		expect(result.mixedRecipes).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Notice
// ---------------------------------------------------------------------------

describe('csvExportNotice', () => {
	const none = { 'no-recipe': 0, legacy: 0, missing: 0, 'digest-mismatch': 0 };
	const base = { rowCount: 8, omittedColumns: [], recoveredFromNames: [], fallbacks: none, mixedRecipes: false, skippedCount: 0 };

	it('is one line when everything came back', () => {
		expect(csvExportNotice(base, 'Exports/set.csv')).toBe('Exported 8 rows to Exports/set.csv.');
		expect(csvExportNotice({ ...base, rowCount: 1 }, 'x.csv')).toBe('Exported 1 row to x.csv.');
	});

	it('names each column that cannot come back, and says why', () => {
		const text = csvExportNotice(
			{ ...base, omittedColumns: [{ column: 'theme', reason: OMIT_REASONS.tags }], recoveredFromNames: ['name'] },
			'x.csv',
		);
		expect(text.split('\n')).toEqual([
			'Exported 8 rows to x.csv.',
			'Not included: theme is only stored as tags, which cannot be turned back into the original value.',
			'name recovered from the folder or file name; characters a file name cannot hold may differ.',
		]);
	});

	it('tells the user how to fix a missing or changed recipe', () => {
		const text = csvExportNotice(
			{ ...base, fallbacks: { 'no-recipe': 1, legacy: 1, missing: 2, 'digest-mismatch': 1 }, mixedRecipes: true, skippedCount: 1 },
			'x.csv',
		);
		expect(text.split('\n')).toEqual([
			'Exported 8 rows to x.csv.',
			'2 notes exported properties only, recipe no longer in the library: restore it from Recipes, then export again.',
			'1 note exported properties only, recipe changed since these notes were written: run the import again, then export again.',
			'2 notes exported properties only, written without a saved recipe.',
			'This folder holds notes from more than one recipe, so some cells are empty.',
			'1 note skipped.',
		]);
	});

	it('uses no em dashes and no internal vocabulary', () => {
		const text = csvExportNotice(
			{
				...base,
				omittedColumns: Object.values(OMIT_REASONS).map((reason, i) => ({ column: `c${i}`, reason })),
				recoveredFromNames: ['a'],
				fallbacks: { 'no-recipe': 1, legacy: 1, missing: 1, 'digest-mismatch': 1 },
				mixedRecipes: true,
				skippedCount: 1,
			},
			'x.csv',
		);
		expect(text).not.toMatch(/—/);
		expect(text).not.toMatch(/digest|provenance|frontmatter|managed|layout|curie|sentinel|legacy|tier/i);
	});
});
