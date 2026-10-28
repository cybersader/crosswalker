/**
 * import-set-options.test.ts — the choices behind a query parameter of type
 * `import-set` (2026-10-27): framework vs mapping classification by identity,
 * which sets are offered, how they are labelled, and when one is preselected.
 * Editor wiring is covered at the bottom: Apply stays disabled (isComplete
 * false) until a set is chosen.
 */

import {
	buildImportSetOptions,
	classifyImportSet,
	noImportSetMessage,
	type ClassifiedImportSet,
	type ImportSetChoices,
	type ImportSetFacts,
} from '../src/views/import-set-options';
import { renderParameterEditor } from '../src/views/recipe-parameter-editor';
import { buildLoadedRecipe, getRecipeParams } from '../src/views/recipe-loader';

function facts(over: Partial<ImportSetFacts> & { id: string }): ImportSetFacts {
	return { noteCount: 8, root: '', ...over } as ImportSetFacts;
}

function fw(over: Partial<ImportSetFacts> & { id: string }): ClassifiedImportSet {
	return { set: facts(over), kind: 'framework' };
}

function map(over: Partial<ImportSetFacts> & { id: string }): ClassifiedImportSet {
	return { set: facts(over), kind: 'mapping' };
}

describe('classifyImportSet', () => {
	it('calls a set of concept notes a framework', () => {
		expect(classifyImportSet(facts({ id: 'iset-1' }), [])).toBe('framework');
		expect(classifyImportSet(facts({ id: 'iset-1' }), ['something-else'])).toBe('framework');
	});

	it.each(['crosswalk-edge', 'junction-note', 'mapping-set'])('calls a set holding %s notes a mapping set', (kind) => {
		expect(classifyImportSet(facts({ id: 'iset-1' }), [kind])).toBe('mapping');
	});

	it('calls a set with a producing parent set a mapping set', () => {
		expect(classifyImportSet(facts({ id: 'iset-1', parent_set: 'iset-0' }), [])).toBe('mapping');
		expect(classifyImportSet(facts({ id: 'iset-1', parentSets: ['iset-0'] }), [])).toBe('mapping');
	});

	it('never reads the folder path', () => {
		expect(classifyImportSet(facts({ id: 'iset-1', root: '_crosswalker/mappings/x' }), [])).toBe('framework');
		expect(classifyImportSet(facts({ id: 'iset-1', root: 'Frameworks/NIST' }), ['crosswalk-edge'])).toBe('mapping');
	});
});

describe('buildImportSetOptions', () => {
	it('offers only sets of the requested kind', () => {
		const sets = [fw({ id: 'iset-f', root: 'Frameworks/nist-mini' }), map({ id: 'iset-m', root: 'Mappings/csf-to-800-53' })];
		expect(buildImportSetOptions(sets, 'framework').options.map((o) => o.id)).toEqual(['iset-f']);
		expect(buildImportSetOptions(sets, 'mapping').options.map((o) => o.id)).toEqual(['iset-m']);
	});

	it('drops table-form mapping sets and sets that own no notes', () => {
		const sets = [
			map({ id: 'iset-table', root: 'Mappings/t', mapping_form: 'table' }),
			map({ id: 'iset-empty', root: 'Mappings/e', noteCount: 0 }),
			map({ id: 'iset-ok', root: 'Mappings/ok', mapping_form: 'notes' }),
		];
		expect(buildImportSetOptions(sets, 'mapping').options.map((o) => o.id)).toEqual(['iset-ok']);
	});

	it('labels in plain words with a note count, never the minted id', () => {
		const { options } = buildImportSetOptions(
			[fw({ id: 'iset-a', root: 'Frameworks/nist-mini', noteCount: 8 }), fw({ id: 'iset-b', root: 'Frameworks/one', noteCount: 1 })],
			'framework',
		);
		expect(options).toEqual([
			{ id: 'iset-a', label: 'nist-mini (8 notes)' },
			{ id: 'iset-b', label: 'one (1 note)' },
		]);
		for (const o of options) expect(o.label).not.toContain('iset-');
	});

	it('falls back to the ontology prefix, then to a plain unnamed label', () => {
		const f = buildImportSetOptions([fw({ id: 'iset-a', ontology: 'csf' }), fw({ id: 'iset-b' })], 'framework').options;
		expect(f.map((o) => o.label)).toEqual(['csf (8 notes)', 'Unnamed framework (8 notes)']);
		const m = buildImportSetOptions([map({ id: 'iset-c' })], 'mapping').options;
		expect(m[0].label).toBe('Unnamed mapping set (8 notes)');
	});

	it('tells same-named sets apart by their folder, then by id', () => {
		const byRoot = buildImportSetOptions(
			[fw({ id: 'iset-a', root: 'A/nist' }), fw({ id: 'iset-b', root: 'B/nist' })],
			'framework',
		).options;
		expect(byRoot.map((o) => o.label)).toEqual(['A/nist (8 notes)', 'B/nist (8 notes)']);

		const byId = buildImportSetOptions(
			[fw({ id: 'iset-a', root: 'A/nist' }), fw({ id: 'iset-b', root: 'A/nist' })],
			'framework',
		).options;
		expect(new Set(byId.map((o) => o.label)).size).toBe(2);
		expect(byId[0].label).toBe('A/nist (8 notes, iset-a)');
	});

	it('preselects the only candidate', () => {
		expect(buildImportSetOptions([fw({ id: 'iset-a', root: 'F/x' }), map({ id: 'iset-m' })], 'framework').preselect).toBe('iset-a');
	});

	it('preselects nothing when there are several candidates or none', () => {
		expect(buildImportSetOptions([fw({ id: 'iset-a', root: 'F/x' }), fw({ id: 'iset-b', root: 'F/y' })], 'framework').preselect).toBeNull();
		expect(buildImportSetOptions([], 'framework')).toEqual({ options: [], preselect: null });
	});

	it('words the empty state plainly', () => {
		expect(noImportSetMessage('framework')).toBe('No imported frameworks yet. Import one first, then create this query.');
		expect(noImportSetMessage('mapping')).toBe('No imported mapping sets yet. Import a crosswalk first, then create this query.');
	});
});

// ---------------------------------------------------------------------------
// Parameter editor: Apply stays disabled until a set is chosen.
// ---------------------------------------------------------------------------

function makeContainer(): HTMLElement {
	const el: any = {
		createEl: jest.fn().mockImplementation(() => makeContainer()),
		createDiv: jest.fn().mockImplementation(() => makeContainer()),
		addClass: jest.fn(),
	};
	return el as HTMLElement;
}

function setRecipe() {
	return buildLoadedRecipe(
		{
			recipe: 'test-recipe',
			query: {
				shape: 'pivot',
				params: {
					framework_set: { type: 'import-set', kind: 'framework', description: 'The framework to show.' },
					confidence_threshold: { type: 'number', default: 0.7 },
				},
			},
		},
		'shipped',
		'shipped:test-recipe',
	);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const ready = (ids: string[]): ImportSetChoices => ({
	state: 'ready',
	options: ids.map((id) => ({ id, label: `${id} (8 notes)` })),
	preselect: ids.length === 1 ? ids[0] : null,
});

describe('renderParameterEditor with an import-set parameter', () => {
	it('is incomplete while the set list is loading', () => {
		const editor = renderParameterEditor(makeContainer(), setRecipe(), undefined, {
			loadChoices: () => new Promise(() => {}),
		});
		expect(editor.isComplete()).toBe(false);
		expect(editor.getValues()).toEqual({ confidence_threshold: 0.7 });
	});

	it('preselects a single candidate and becomes complete', async () => {
		const seen: boolean[] = [];
		const editor = renderParameterEditor(makeContainer(), setRecipe(), undefined, {
			loadChoices: async (kind) => {
				expect(kind).toBe('framework');
				return ready(['iset-a']);
			},
			onValidityChange: (c) => seen.push(c),
		});
		await flush();
		expect(editor.isComplete()).toBe(true);
		expect(editor.getValues()).toEqual({ framework_set: 'iset-a', confidence_threshold: 0.7 });
		expect(seen[seen.length - 1]).toBe(true);
	});

	it.each([
		['several candidates', ready(['iset-a', 'iset-b'])],
		['no candidates', ready([])],
		['a vault still indexing', { state: 'indexing', message: 'Obsidian is still indexing.' } as ImportSetChoices],
	])('stays incomplete with %s', async (_label, choices) => {
		const editor = renderParameterEditor(makeContainer(), setRecipe(), undefined, { loadChoices: async () => choices });
		await flush();
		expect(editor.isComplete()).toBe(false);
		expect(editor.getValues().framework_set).toBeUndefined();
	});

	it('stays incomplete when listing the sets fails', async () => {
		const editor = renderParameterEditor(makeContainer(), setRecipe(), undefined, {
			loadChoices: async () => {
				throw new Error('boom');
			},
		});
		await flush();
		expect(editor.isComplete()).toBe(false);
	});

	it('keeps a saved choice that still exists, and drops one that does not', async () => {
		const kept = renderParameterEditor(makeContainer(), setRecipe(), { framework_set: 'iset-b' }, {
			loadChoices: async () => ready(['iset-a', 'iset-b']),
		});
		await flush();
		expect(kept.isComplete()).toBe(true);
		expect(kept.getValues().framework_set).toBe('iset-b');

		const gone = renderParameterEditor(makeContainer(), setRecipe(), { framework_set: 'iset-gone' }, {
			loadChoices: async () => ready(['iset-a', 'iset-b']),
		});
		await flush();
		expect(gone.isComplete()).toBe(false);
		expect(gone.getValues().framework_set).toBeUndefined();
	});

	it('is incomplete without an app or a loader to list sets', async () => {
		const editor = renderParameterEditor(makeContainer(), setRecipe());
		await flush();
		expect(editor.isComplete()).toBe(false);
	});

	it('a recipe with no set parameter is complete at once', () => {
		const recipe = buildLoadedRecipe(
			{ recipe: 'r', query: { shape: 'pivot', params: { t: { type: 'number', default: 1 } } } },
			'shipped',
			'shipped:r',
		);
		expect(renderParameterEditor(makeContainer(), recipe).isComplete()).toBe(true);
	});
});

describe('getRecipeParams for import-set', () => {
	it('carries the kind, defaulting to framework', () => {
		const recipe = buildLoadedRecipe(
			{
				recipe: 'r',
				query: {
					shape: 'pivot',
					params: { m: { type: 'import-set', kind: 'mapping' }, f: { type: 'import-set' } },
				},
			},
			'shipped',
			'shipped:r',
		);
		const params = getRecipeParams(recipe);
		expect(params.find((p) => p.name === 'm')).toMatchObject({ type: 'import-set', kind: 'mapping' });
		expect(params.find((p) => p.name === 'f')).toMatchObject({ type: 'import-set', kind: 'framework' });
	});
});
