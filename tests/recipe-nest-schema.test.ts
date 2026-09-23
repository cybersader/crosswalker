import { readFileSync } from 'node:fs';
import {
	canonicalStringify,
	computeRecipeHash,
	recipeHashCanonicalInput,
	type EffectiveRecipeSource,
} from '../src/generation/hash';
import {
	diagnoseCanonicalRecipe,
	type RecipeDocumentDiagnostic,
} from '../src/import/recipe-document';
import { assertNoReservedSourceColumn } from '../src/source/joins';
import type { CrosswalkerImportRecipe } from '../src/types/generated/recipe';
import { validateRecipe } from '../src/validation/validator';

interface MutableRecipe {
	recipe: string;
	source: Record<string, unknown> & { ontology: string; levels: string[] };
	target: Record<string, unknown> & { layout: Array<Record<string, unknown>> };
}

function nestedRecipe(): MutableRecipe {
	return {
		recipe: 'synthetic-nested-records',
		source: {
			ontology: 'synthetic-catalog',
			levels: ['group', 'control', 'part'],
			nest: [
				{
					level: 'group',
					id: '{id}',
					children: 'controls',
					carry: ['title'],
					leaf: 'folder-note',
				},
				{
					level: 'control',
					id: '{id}',
					children: 'parts',
					leaf: 'folder-note',
					identity: 'global',
				},
				{
					level: 'part',
					id: '{id}',
					identity: 'path',
				},
			],
		},
		target: {
			layout: [
				{ level: 'group', mechanism: 'folder', template: '{id}' },
				{ level: 'control', mechanism: 'folder', template: '{id}' },
				{ level: 'part', mechanism: 'file', template: '{id}.md' },
			],
		},
	};
}

function joinNestedRecipe(): MutableRecipe {
	return {
		recipe: 'synthetic-joined-nested-records',
		source: {
			ontology: 'synthetic-controls',
			levels: ['control', 'safeguard'],
			nest: [
				{
					level: 'control',
					id: '{Control ID}',
					children: { sheet: 'Safeguards', header_row: 0 },
					leaf: 'folder-note',
				},
				{
					level: 'safeguard',
					id: '{Safeguard ID}',
					parent_key: 'Control ID',
				},
			],
		},
		target: {
			layout: [
				{ level: 'control', mechanism: 'folder', template: '{Control ID}' },
				{ level: 'safeguard', mechanism: 'file', template: '{Safeguard ID}.md' },
			],
		},
	};
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function nestEntries(recipe: MutableRecipe): Array<Record<string, unknown>> {
	return recipe.source.nest as Array<Record<string, unknown>>;
}

function blockingDiagnostics(recipe: MutableRecipe): RecipeDocumentDiagnostic[] {
	const validation = validateRecipe(recipe);
	expect(validation.errors).toEqual([]);
	expect(validation.valid).toBe(true);
	return diagnoseCanonicalRecipe(recipe as unknown as CrosswalkerImportRecipe)
		.filter((diagnostic) => diagnostic.severity === 'blocking');
}

function expectBlockingMessage(recipe: MutableRecipe, message: string): void {
	expect(blockingDiagnostics(recipe).map((diagnostic) => diagnostic.message)).toContain(message);
}

describe('SchemaVer 1.13.0 source.nest schema', () => {
	it('accepts a three-level nested source without injecting defaults', () => {
		const recipe = nestedRecipe();
		const before = clone(recipe);

		expect(validateRecipe(recipe).valid).toBe(true);
		expect(blockingDiagnostics(recipe)).toEqual([]);
		expect(recipe).toEqual(before);
		expect(nestEntries(recipe)[0].identity).toBeUndefined();
	});

	it('accepts a two-level join-sourced nested source', () => {
		const recipe = joinNestedRecipe();
		expect(validateRecipe(recipe).valid).toBe(true);
		expect(blockingDiagnostics(recipe)).toEqual([]);
	});

	it.each([
		['an unknown entry key', { level: 'part', id: '{id}', unknown: true }],
		['a missing id', { level: 'part' }],
		['an unknown identity', { level: 'part', id: '{id}', identity: 'run' }],
		['an unknown leaf mode', { level: 'part', id: '{id}', leaf: 'implicit' }],
		['a numeric children declaration', { level: 'part', id: '{id}', children: 3 }],
	] as Array<[string, Record<string, unknown>]>)('rejects %s', (_label, entry) => {
		const recipe = nestedRecipe();
		recipe.source.nest = [entry];
		expect(validateRecipe(recipe).valid).toBe(false);
	});

	it('rejects an empty nest', () => {
		const recipe = nestedRecipe();
		recipe.source.nest = [];
		expect(validateRecipe(recipe).valid).toBe(false);
	});

	it('rejects a secondary collection that declares both sheet and iterator', () => {
		const recipe = joinNestedRecipe();
		nestEntries(recipe)[0].children = {
			sheet: 'Safeguards',
			iterator: '$.safeguards[*]',
		};
		expect(validateRecipe(recipe).valid).toBe(false);
	});
});

describe('SchemaVer 1.14.0 body projection schema', () => {
	it('accepts leaf section and level on append body projections', () => {
		const recipe = nestedRecipe();
		nestEntries(recipe)[2].leaf = 'section';
		recipe.target.layout[2] = {
			level: 'part', mechanism: 'heading', level_depth: 2, template: '{id}',
		};
		recipe.target.also_emit = {
			body: [{ template: '{prose}', position: 'append', level: 'part' }],
		};
		expect(validateRecipe(recipe).valid).toBe(true);
	});

	it('refuses level on section body projections', () => {
		const recipe = nestedRecipe();
		recipe.target.also_emit = {
			body: [{
				template: '{prose}',
				position: 'section',
				heading: 'Details',
				level: 'part',
			}],
		};
		expect(validateRecipe(recipe).valid).toBe(false);
	});

	it('records the additive 1.14.0 schema history', () => {
		const schema = JSON.parse(readFileSync('spec/recipe.schema.json', 'utf8')) as { $comment: string };
		expect(schema.$comment).toContain('SchemaVer 1.15.0');
		expect(schema.$comment).toContain('1.14.0 (2026-09-22)');
		expect(schema.$comment).toContain("nest_level.leaf gains 'section'");
		expect(schema.$comment).toContain('body_entry (append) gains optional level');
	});
});

describe('SchemaVer 1.13.0 source.nest semantic diagnostics', () => {
	it('requires every nested level to appear in source.levels', () => {
		const recipe = nestedRecipe();
		nestEntries(recipe)[2].level = 'detail';
		expectBlockingMessage(recipe, 'Nest level "detail" is not declared in source.levels.');
	});

	it('requires children on every non-last level and forbids them on the last level', () => {
		const recipe = nestedRecipe();
		delete nestEntries(recipe)[0].children;
		nestEntries(recipe)[2].children = 'fragments';
		const messages = blockingDiagnostics(recipe).map((diagnostic) => diagnostic.message);
		expect(messages).toContain(
			'Nest level "group" has no children but is not the last level. Remove it or give it children.',
		);
		expect(messages).toContain('The last nest level "part" must not declare children.');
	});

	it('requires parent_key on the next level for join-sourced children', () => {
		const recipe = joinNestedRecipe();
		delete nestEntries(recipe)[1].parent_key;
		expectBlockingMessage(
			recipe,
			'Nest level "safeguard" is joined from another collection and needs parent_key: the child field that names its parent\'s id.',
		);
	});

	it('requires parent_key to be a string in semantic diagnostics', () => {
		const recipe = joinNestedRecipe();
		nestEntries(recipe)[1].parent_key = 3;
		const diagnostics = diagnoseCanonicalRecipe(recipe as unknown as CrosswalkerImportRecipe);
		expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
			'parent_key on level "safeguard" must be a string naming the child field that holds its parent\'s id.',
		);
	});

	it('warns when parent_key is ignored for JSON-field children', () => {
		const recipe = nestedRecipe();
		nestEntries(recipe)[1].parent_key = 'group_id';
		const diagnostics = diagnoseCanonicalRecipe(recipe as unknown as CrosswalkerImportRecipe);
		expect(diagnostics).toContainEqual(expect.objectContaining({
			severity: 'warning',
			message: 'parent_key on level "control" is ignored because its children come from a JSON field.',
		}));
	});

	it('requires a non-last level to declare its own note output', () => {
		const recipe = nestedRecipe();
		delete nestEntries(recipe)[0].leaf;
		expectBlockingMessage(
			recipe,
			'Level "group" has children but no note of its own. Add a file entry for it, or set leaf to folder-note or none.',
		);
	});

	it('allows leaf none on the last level and forbids folder-note there', () => {
		const suppressed = nestedRecipe();
		nestEntries(suppressed)[2].leaf = 'none';
		expect(diagnoseCanonicalRecipe(suppressed).filter((diagnostic) => diagnostic.severity === 'blocking')).toEqual([]);

		const folderNote = nestedRecipe();
		nestEntries(folderNote)[2].leaf = 'folder-note';
		expectBlockingMessage(
			folderNote,
			'The last nest level "part" is the note itself; folder-note applies only to levels that have children.',
		);
	});

	it('requires layout levels to follow nested parent order', () => {
		const recipe = nestedRecipe();
		recipe.target.layout = [
			{ level: 'control', mechanism: 'folder', template: '{id}' },
			{ level: 'group', mechanism: 'folder', template: '{id}' },
			{ level: 'part', mechanism: 'file', template: '{id}.md' },
		];
		expectBlockingMessage(
			recipe,
			'Layout places level "control" above "group", but source.nest declares "group" as the parent. Reorder the layout to match the nesting.',
		);
	});
});

describe('SchemaVer 1.13.0 source.nest recipe hash', () => {
	const target = {
		layout: [{ level: 'part', mechanism: 'file', template: '{id}.md' }],
	};

	it('B15 keeps an existing recipe without section or body level byte-identical through validation', () => {
		const recipe = nestedRecipe();
		const before = clone(recipe);
		const hash = computeRecipeHash(recipe.target, recipe.source);
		expect(validateRecipe(recipe).valid).toBe(true);
		expect(recipe).toEqual(before);
		expect(computeRecipeHash(recipe.target, recipe.source)).toBe(hash);
	});

	it('changes when nest is declared', () => {
		const nest = [{ level: 'part', id: '{id}', identity: 'path' }];
		expect(computeRecipeHash(target, { nest })).not.toBe(computeRecipeHash(target));
	});

	it('keeps nest absent from the canonical input when undeclared', () => {
		const canonical = recipeHashCanonicalInput(target);
		expect(canonical).not.toContain('nest');
		expect(canonical).not.toContain('source_nest');
	});

	it('keeps a join declaration byte-identical across the source_join_from hoist', () => {
		const joins = {
			labels: {
				from: { sheet: 'Labels', header_row: 0 },
				on: { primary: 'id', secondary: 'parent_id' },
				cardinality: 'one',
			},
		};
		const preHoist: EffectiveRecipeSource = { joins: clone(joins) };
		const postHoist: EffectiveRecipeSource = { joins: clone(joins) };
		expect(recipeHashCanonicalInput(target, postHoist)).toBe(
			recipeHashCanonicalInput(target, preHoist),
		);
		expect(recipeHashCanonicalInput(target, postHoist)).toBe(canonicalStringify({
			layout: target.layout,
			also_emit: null,
			enrichment: null,
			source_joins: joins,
		}));
	});
});

describe('nested-record lineage source-column reservation', () => {
	it('refuses the reserved _cw source column', () => {
		expect(() => assertNoReservedSourceColumn(['id', '_cw'])).toThrow(
			'Column "_cw" is reserved for nested-record lineage. Rename it in the source and import again.',
		);
	});

	it.each(['_cw2', 'cw'])('allows %s', (column) => {
		expect(() => assertNoReservedSourceColumn(['id', column])).not.toThrow();
	});
});
