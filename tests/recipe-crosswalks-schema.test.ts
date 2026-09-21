import {
	computeRecipeHash,
	recipeHashCanonicalInput,
	type EffectiveRecipeSource,
} from '../src/generation/hash';
import { validateRecipe } from '../src/validation/validator';

interface MutableRecipe {
	recipe: string;
	source: Record<string, unknown> & { ontology: string; levels: string[] };
	target: Record<string, unknown> & { layout: Array<Record<string, unknown>> };
}

function minimalRecipe(): MutableRecipe {
	return {
		recipe: 'synthetic-crosswalk-schema',
		source: {
			ontology: 'synthetic-source',
			levels: ['concept'],
		},
		target: {
			layout: [
				{ level: 'concept', mechanism: 'file', template: '{id}.md' },
			],
		},
	};
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

describe('SchemaVer 1.12.0 target.crosswalks', () => {
	it('accepts a minimal entry without injecting defaults', () => {
		const recipe = minimalRecipe();
		recipe.target.crosswalks = [
			{ column: 'Maps to', to_ontology: 'nist-csf-2' },
		];
		const before = clone(recipe);

		expect(validateRecipe(recipe).valid).toBe(true);
		expect(recipe).toEqual(before);
		expect((recipe.target.crosswalks as Array<Record<string, unknown>>)[0]).toEqual({
			column: 'Maps to',
			to_ontology: 'nist-csf-2',
		});
	});

	it('accepts every optional crosswalk key', () => {
		const recipe = minimalRecipe();
		recipe.target.crosswalks = [{
			column: 'Maps to',
			to_ontology: 'nist-csf-2',
			predicate: 'is_equivalent_to',
			split: [',', '\n', ';'],
			drop: ['None', 'N/A', '-'],
			qualifier: 'strip',
			mapping_set_id: 'synthetic-to-nist-csf-2',
		}];

		expect(validateRecipe(recipe).valid).toBe(true);
	});

	it.each([
		['an unknown entry key', { column: 'Maps to', to_ontology: 'nist-csf-2', unknown: true }],
		['a missing column', { to_ontology: 'nist-csf-2' }],
		['a missing target ontology', { column: 'Maps to' }],
		['a lineage predicate', { column: 'Maps to', to_ontology: 'nist-csf-2', predicate: 'supersedes' }],
		['an empty target ontology', { column: 'Maps to', to_ontology: '' }],
	] as Array<[string, Record<string, unknown>]>)('rejects %s', (_label, entry) => {
		const recipe = minimalRecipe();
		recipe.target.crosswalks = [entry];
		expect(validateRecipe(recipe).valid).toBe(false);
	});

	it('rejects an empty declaration array', () => {
		const recipe = minimalRecipe();
		recipe.target.crosswalks = [];
		expect(validateRecipe(recipe).valid).toBe(false);
	});
});

describe('SchemaVer 1.12.0 source.detect', () => {
	it('accepts the full hint block', () => {
		const recipe = minimalRecipe();
		recipe.source.detect = {
			sheet: 'Framework',
			sheet_aliases: ['Framework v2', 'Controls'],
			header_row: 2,
			filename: ['framework', 'controls'],
			notes: 'Choose the structured-data download.',
		};
		expect(validateRecipe(recipe).valid).toBe(true);
	});

	it('rejects an unknown detect key', () => {
		const recipe = minimalRecipe();
		recipe.source.detect = { sheet: 'Framework', unknown: true };
		expect(validateRecipe(recipe).valid).toBe(false);
	});

	it('rejects a negative header row', () => {
		const recipe = minimalRecipe();
		recipe.source.detect = { header_row: -1 };
		expect(validateRecipe(recipe).valid).toBe(false);
	});
});

describe('SchemaVer 1.12.0 recipe hash', () => {
	const target = {
		layout: [{ level: 'concept', mechanism: 'file', template: '{id}.md' }],
	};

	it('changes when crosswalks are declared', () => {
		const withCrosswalks = {
			...target,
			crosswalks: [{ column: 'Maps to', to_ontology: 'nist-csf-2' }],
		};
		expect(computeRecipeHash(withCrosswalks)).not.toBe(computeRecipeHash(target));
	});

	it('keeps the exact pre-1.12.0 canonical string when both new keys are absent', () => {
		const canonical = recipeHashCanonicalInput(target);
		expect(canonical).toBe(
			'{"also_emit":null,"enrichment":null,"layout":[{"level":"concept","mechanism":"file","template":"{id}.md"}]}',
		);
		expect(canonical).not.toContain('crosswalks');
	});

	it('does not hash source.detect', () => {
		const withoutDetect: EffectiveRecipeSource = {};
		const withDetect = {
			detect: { sheet: 'Framework', header_row: 2 },
		} as unknown as EffectiveRecipeSource;
		expect(computeRecipeHash(target, withDetect)).toBe(computeRecipeHash(target, withoutDetect));
		expect(recipeHashCanonicalInput(target, withDetect)).toBe(
			recipeHashCanonicalInput(target, withoutDetect),
		);
	});
});
