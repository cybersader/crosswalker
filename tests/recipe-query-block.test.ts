/**
 * recipe-query-block.test.ts — Phase 1 v0.1.6 tests for the additive `query:` block
 *
 * Per Ch 29 (8-verb Layer A vocabulary) + Ch 30 (5 v0.1 view shapes) + Ch 31 (recipe schema design).
 *
 * Covers:
 *   - Existing recipes WITHOUT `query:` still validate (additive bump = backward-compatible)
 *   - Each of the 5 v0.1 reference recipes validates against BOTH style A + style B
 *   - Recipe with shape='pivot' missing rows/cols/cell → fails
 *   - Recipe with unknown shape (e.g. 'sankey') → fails
 *   - Recipe with extra primitive key (e.g. typo 'clos' instead of 'cols') → fails (additionalProperties: false)
 *   - Style A and Style B produce identical validity verdicts (just different error wording)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	initValidator,
	validateRecipe,
	type RecipeSchemaStyle,
} from '../src/validation/validator';

beforeAll(() => {
	initValidator();
});

const RECIPE_DIR = join(__dirname, '..', 'recipes', 'v0-1');
const STARTER_DIR = join(__dirname, '..', 'recipes', 'starter');

function loadRecipe(path: string): unknown {
	return JSON.parse(readFileSync(path, 'utf-8'));
}

const REFERENCE_RECIPES = [
	'coverage-matrix.json',
	'crosswalk-density.json',
	'orphan-controls.json',
	'hierarchy-view.json',
	'list-view.json',
];

const STYLES: RecipeSchemaStyle[] = ['A', 'B'];

describe('Recipe query: block — backward-compatibility (additive bump)', () => {
	it('accepts existing starter recipes that have no query: block (style A)', () => {
		const recipe = loadRecipe(join(STARTER_DIR, 'nist-csf-to-800-53-crosswalk.json'));
		const result = validateRecipe(recipe, 'A');
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it('accepts existing starter recipes that have no query: block (style B)', () => {
		const recipe = loadRecipe(join(STARTER_DIR, 'nist-csf-to-800-53-crosswalk.json'));
		const result = validateRecipe(recipe, 'B');
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});
});

describe('Recipe query: block — 5 reference recipes validate', () => {
	for (const fname of REFERENCE_RECIPES) {
		for (const style of STYLES) {
			it(`accepts ${fname} (style ${style})`, () => {
				const recipe = loadRecipe(join(RECIPE_DIR, fname));
				const result = validateRecipe(recipe, style);
				if (!result.valid) {
					console.error(`Recipe ${fname} failed style ${style}:`, result.errors);
				}
				expect(result.valid).toBe(true);
				expect(result.errors).toEqual([]);
			});
		}
	}
});

describe('Recipe query: block — schema enforcement', () => {
	const baseRecipe = {
		recipe: 'test-recipe',
		source: { ontology: 'test', levels: ['concept'] },
		target: {
			layout: [
				{ level: 'concept', mechanism: 'file', template: '{concept.id}.md' },
			],
		},
	};

	it('rejects shape="pivot" missing required rows/cols/cell (style A)', () => {
		const bad = {
			...baseRecipe,
			query: {
				shape: 'pivot',
				primitives: { from: 'test' },
			},
		};
		const result = validateRecipe(bad, 'A');
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it('rejects shape="pivot" missing required rows/cols/cell (style B)', () => {
		const bad = {
			...baseRecipe,
			query: {
				shape: 'pivot',
				primitives: { from: 'test' },
			},
		};
		const result = validateRecipe(bad, 'B');
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it('rejects unknown shape="sankey" (style A)', () => {
		const bad = {
			...baseRecipe,
			query: {
				shape: 'sankey',
				primitives: {},
			},
		};
		const result = validateRecipe(bad, 'A');
		expect(result.valid).toBe(false);
	});

	it('rejects unknown shape="sankey" (style B)', () => {
		const bad = {
			...baseRecipe,
			query: {
				shape: 'sankey',
				primitives: {},
			},
		};
		const result = validateRecipe(bad, 'B');
		expect(result.valid).toBe(false);
	});

	it('rejects pivot with typo'
		+ ' "clos" instead of "cols" (additionalProperties: false)', () => {
		const bad = {
			...baseRecipe,
			query: {
				shape: 'pivot',
				primitives: {
					rows: { of: 'a', by: 'x' },
					clos: { of: 'b', by: 'y' },
					cell: { op: 'count' },
				},
			},
		};
		const result = validateRecipe(bad, 'A');
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it('rejects aggregate op outside enum + x_-prefix namespace', () => {
		const bad = {
			...baseRecipe,
			query: {
				shape: 'table',
				primitives: {
					from: 'test',
					select: [{ field: 'concept.id' }],
					agg: [{ op: 'INVALID_OP' }],
				},
			},
		};
		const result = validateRecipe(bad, 'A');
		expect(result.valid).toBe(false);
	});

	it('accepts custom aggregate op with x_ prefix', () => {
		const ok = {
			...baseRecipe,
			query: {
				shape: 'table',
				primitives: {
					from: 'test',
					select: [{ field: 'concept.id' }],
					agg: [{ op: 'x_custom_density', as: 'density' }],
				},
			},
		};
		const result = validateRecipe(ok, 'A');
		expect(result.valid).toBe(true);
	});

	it('accepts hierarchy with required root + predicate', () => {
		const ok = {
			...baseRecipe,
			query: {
				shape: 'hierarchy',
				primitives: {
					root: 'skos:Top',
					predicate: 'skos:narrower',
					depth: 5,
				},
			},
		};
		const result = validateRecipe(ok, 'A');
		expect(result.valid).toBe(true);
	});

	it('rejects hierarchy missing required root', () => {
		const bad = {
			...baseRecipe,
			query: {
				shape: 'hierarchy',
				primitives: {
					predicate: 'skos:narrower',
				},
			},
		};
		const result = validateRecipe(bad, 'A');
		expect(result.valid).toBe(false);
	});
});

describe('Recipe query: block — style A and B produce identical verdicts', () => {
	const cases = [
		{
			name: 'valid pivot recipe',
			recipe: {
				recipe: 'test', source: { ontology: 'a', levels: ['c'] },
				target: { layout: [{ level: 'c', mechanism: 'file', template: '{c.id}.md' }] },
				query: {
					shape: 'pivot',
					primitives: {
						rows: { of: 'a', by: 'subject_id' },
						cols: { of: 'b', by: 'object_id' },
						cell: { op: 'count' },
					},
				},
			},
			expectedValid: true,
		},
		{
			name: 'invalid pivot missing cell',
			recipe: {
				recipe: 'test', source: { ontology: 'a', levels: ['c'] },
				target: { layout: [{ level: 'c', mechanism: 'file', template: '{c.id}.md' }] },
				query: {
					shape: 'pivot',
					primitives: {
						rows: { of: 'a', by: 'x' },
						cols: { of: 'b', by: 'y' },
					},
				},
			},
			expectedValid: false,
		},
	];

	for (const { name, recipe, expectedValid } of cases) {
		it(`A and B agree: ${name}`, () => {
			const a = validateRecipe(recipe, 'A');
			const b = validateRecipe(recipe, 'B');
			expect(a.valid).toBe(expectedValid);
			expect(b.valid).toBe(expectedValid);
			expect(a.valid).toBe(b.valid);
		});
	}
});

// ---------------------------------------------------------------------------
// Edge cases worth checking (per tests/manual/TEST_PHASE1_QUERY_SCHEMA.md)
// ---------------------------------------------------------------------------

describe('Recipe schema — Phase 1 edge cases', () => {
	const baseValid = {
		recipe: 'edge-case-test',
		source: { ontology: 'a', levels: ['c'] },
		target: { layout: [{ level: 'c', mechanism: 'file', template: '{c.id}.md' }] },
	};

	it('accepts a recipe with $schema + $comment top-level meta-keys', () => {
		const recipe = {
			$schema: 'https://crosswalker.dev/spec/recipe.schema.json',
			$comment: 'A test recipe demonstrating meta-keys are allowed.',
			...baseValid,
		};
		const a = validateRecipe(recipe, 'A');
		const b = validateRecipe(recipe, 'B');
		expect(a.valid).toBe(true);
		expect(b.valid).toBe(true);
	});

	it('rejects a recipe with a random unknown top-level key (additionalProperties: false)', () => {
		const recipe = {
			...baseValid,
			notes: 'free-form notes not in schema',
		};
		const a = validateRecipe(recipe, 'A');
		const b = validateRecipe(recipe, 'B');
		expect(a.valid).toBe(false);
		expect(b.valid).toBe(false);
		// Error mentions the unknown property
		const aErr = JSON.stringify(a.errors);
		expect(aErr).toMatch(/notes|additionalProperties|must NOT have additional/);
	});

	it('accepts recipe.query.params with a typed default (confidence_threshold)', () => {
		const recipe = {
			...baseValid,
			query: {
				shape: 'pivot',
				primitives: {
					from: 'a',
					rows: { of: 'control', by: 'family' },
					cols: { of: 'control', by: 'baseline' },
					cell: { op: 'count', as: 'mapping_count', empty: 'gap' },
				},
				params: {
					confidence_threshold: { type: 'number', default: 0.7 },
				},
			},
		};
		const a = validateRecipe(recipe, 'A');
		const b = validateRecipe(recipe, 'B');
		expect(a.valid).toBe(true);
		expect(b.valid).toBe(true);
	});

	it('accepts a recipe with BOTH query AND target.layout populated', () => {
		const recipe = {
			...baseValid,
			target: {
				layout: [
					{ level: 'family', mechanism: 'folder', template: '{Control Family}' },
					{ level: 'leaf', mechanism: 'file', template: '{Control ID}.md' },
				],
			},
			query: {
				shape: 'pivot',
				primitives: {
					from: 'a',
					rows: { of: 'control', by: 'family' },
					cols: { of: 'control', by: 'baseline' },
					cell: { op: 'count', as: 'mapping_count', empty: 'gap' },
				},
			},
		};
		const a = validateRecipe(recipe, 'A');
		const b = validateRecipe(recipe, 'B');
		expect(a.valid).toBe(true);
		expect(b.valid).toBe(true);
	});
});
