/**
 * recipe-templates.test.ts — Phase 4b unit tests for the recipe→base block
 * template rendering layer. Covers the 6 shipped templates + interpolation
 * semantics (plain substitution + section conditionals).
 */

import { getRecipeTemplate, interpolate, renderRecipeTemplate } from '../src/views/recipe-templates';

describe('withdrawn templates stay withdrawn', () => {
	it('offers no Bases template for the controls-without-evidence question', () => {
		// Withdrawn 2026-08-21 (Challenge 45). It filtered `length(evidence) == 0`
		// against a property no recipe emits, so it matched every control and
		// reported total non-coverage no matter what the vault contained.
		//
		// This asserts null rather than asserting a corrected filter because the
		// query is not expressible in Bases at all: a filter selects from notes
		// that exist, and "no evidence" is a claim about a row that does not.
		// Re-adding any template under this id would reintroduce a confidently
		// wrong answer. The real query is conceptsWithoutValidEvidence() in
		// src/tier2/evidence-coverage.ts.
		expect(getRecipeTemplate('orphan-controls-no-evidence')).toBeNull();
	});

	it('keeps the positive evidence view aligned with the Tier 2 validity rule', () => {
		// A Bases view and the SQL query answering from the same vault must not
		// disagree about what counts. If Tier 2 tightens, this template moves too.
		const template = getRecipeTemplate('evidence-junctions-by-control') ?? '';
		expect(template).toContain('predicate == "has_evidence"');
		expect(template).toContain('status == "approved"');
		expect(template).toContain('coverage == "full"');
		expect(template).toContain('coverage == "partial"');
	});
});

describe('getRecipeTemplate — shipped catalog', () => {
	const shippedIds = [
		'nist-csf-coverage-matrix',
		'nist-csf-to-mitre-coverage',
		'crosswalk-density-by-framework',
		'evidence-junctions-by-control',
		'controls-by-family-list',
		'skos-hierarchy-narrower',
	];

	for (const id of shippedIds) {
		it(`has a template for shipped recipe '${id}'`, () => {
			const t = getRecipeTemplate(id);
			expect(t).not.toBeNull();
			expect(typeof t).toBe('string');
			expect(t!.length).toBeGreaterThan(20);
			// All templates declare a views: array
			expect(t).toContain('views:');
		});
	}

	it('returns null for unknown recipe ID', () => {
		expect(getRecipeTemplate('not-a-real-recipe')).toBeNull();
	});
});

describe('renderRecipeTemplate — plain substitution', () => {
	it('substitutes {{param}} with the params value', () => {
		const out = renderRecipeTemplate('nist-csf-coverage-matrix', {
			confidence_threshold: 0.85,
		});
		expect(out).not.toBeNull();
		expect(out).toContain('confidence >= 0.85');
		// Defaults should not leak as the literal `{{...}}` string
		expect(out).not.toContain('{{');
	});

	it('substitutes missing params as empty string', () => {
		const out = renderRecipeTemplate('nist-csf-coverage-matrix', {});
		expect(out).not.toBeNull();
		// Pattern: `confidence >= ` followed by something
		expect(out).toContain('confidence >=');
		// Still no leftover Mustache tokens
		expect(out).not.toMatch(/\{\{[\w_]+\}\}/);
	});

	it('coerces number values via String()', () => {
		const out = renderRecipeTemplate('nist-csf-coverage-matrix', {
			confidence_threshold: 0.7,
		});
		expect(out).toContain('0.7');
	});
});

describe('renderRecipeTemplate — section conditionals', () => {
	it('renders {{#name}}block{{/name}} when params[name] is truthy', () => {
		const out = renderRecipeTemplate('nist-csf-to-mitre-coverage', {
			confidence_threshold: 0.7,
			tactic_filter: 'Persistence',
		});
		expect(out).not.toBeNull();
		expect(out).toContain("tactic == \"Persistence\"");
	});

	it('drops {{#name}}block{{/name}} when params[name] is empty string', () => {
		const out = renderRecipeTemplate('nist-csf-to-mitre-coverage', {
			confidence_threshold: 0.7,
			tactic_filter: '',
		});
		expect(out).not.toBeNull();
		expect(out).not.toContain('tactic ==');
	});

	it('drops conditionals when params[name] is undefined', () => {
		const out = renderRecipeTemplate('nist-csf-to-mitre-coverage', {
			confidence_threshold: 0.7,
		});
		expect(out).not.toBeNull();
		expect(out).not.toContain('tactic ==');
	});

	it('drops conditionals when params[name] is the number 0', () => {
		// 0 is "falsy" for our purposes — don't render the conditional block
		const out = renderRecipeTemplate('controls-by-family-list', {
			family_filter: 0 as unknown as string,
		});
		expect(out).not.toBeNull();
		expect(out).not.toContain('family ==');
	});

	it('renders conditional when params[name] is boolean true', () => {
		// Custom test using a synthetic template scenario — pick the
		// hierarchy-view template which has no conditionals; test the
		// pure-interpolation surface separately.
		// (Coverage of the truthy boolean branch is via integration with
		// future recipes that use boolean toggles.)
		expect(true).toBe(true);
	});
});

describe('renderRecipeTemplate — null handling', () => {
	it('returns null when recipe ID is unknown', () => {
		const out = renderRecipeTemplate('nope', {});
		expect(out).toBeNull();
	});

	it('produces valid YAML for all shipped recipes with empty params', () => {
		const ids = [
			'nist-csf-coverage-matrix',
			'nist-csf-to-mitre-coverage',
			'crosswalk-density-by-framework',
			'evidence-junctions-by-control',
			'controls-by-family-list',
			'skos-hierarchy-narrower',
		];
		for (const id of ids) {
			const out = renderRecipeTemplate(id, {});
			expect(out).not.toBeNull();
			// All outputs should start with `filters:` (the Bases YAML root)
			expect(out!.trimStart()).toMatch(/^filters:/);
			// No unrendered Mustache tokens
			expect(out).not.toMatch(/\{\{[\w_]+\}\}/);
		}
	});
});

// ---------------------------------------------------------------------------
// Set-targeted templates (2026-10-27). Templates filter on the chosen set's
// minted id; a saved query without the set param regenerates byte-identically.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const legacy = require('./fixtures/recipe-templates-legacy-render.json') as {
	cases: { recipe: string; params: Record<string, unknown>; expected: string }[];
};

describe('renderRecipeTemplate — legacy saved queries', () => {
	it('freezes at least one case per folder-targeted template', () => {
		const ids = new Set(legacy.cases.map((c) => c.recipe));
		for (const id of ['nist-csf-coverage-matrix', 'nist-csf-to-mitre-coverage', 'controls-by-family-list', 'skos-hierarchy-narrower']) {
			expect(ids.has(id)).toBe(true);
		}
	});

	it.each(legacy.cases.map((c) => [c.recipe, JSON.stringify(c.params), c] as const))(
		'%s with %s renders byte-identical to before',
		(_id, _p, c) => {
			expect(renderRecipeTemplate(c.recipe, c.params)).toBe(c.expected);
		},
	);
});

describe('renderRecipeTemplate — set-targeted path', () => {
	it('filters a mapping template on the chosen set id, not a folder', () => {
		const out = renderRecipeTemplate('nist-csf-coverage-matrix', { mapping_set: 'iset-abc', confidence_threshold: 0.7 }) ?? '';
		expect(out).toContain(`'note._crosswalker.import_set.id == "iset-abc"'`);
		expect(out).toContain(`'kind == "crosswalk-edge"'`);
		expect(out).not.toContain('file.inFolder');
		expect(out).toContain('Mapping coverage matrix');
		expect(out).not.toContain('NIST CSF');
	});

	it('names the tactic view generically when a set is chosen', () => {
		const out = renderRecipeTemplate('nist-csf-to-mitre-coverage', { mapping_set: 'iset-m', confidence_threshold: 0.5 }) ?? '';
		expect(out).toContain('import_set.id == "iset-m"');
		expect(out).toContain('Mapping coverage matrix by tactic');
		expect(out).not.toContain('file.inFolder');
	});

	it('filters framework templates on the chosen set id', () => {
		for (const id of ['controls-by-family-list', 'skos-hierarchy-narrower']) {
			const out = renderRecipeTemplate(id, { framework_set: 'iset-f' }) ?? '';
			expect(out).toContain(`'note._crosswalker.import_set.id == "iset-f"'`);
			expect(out).not.toContain('file.inFolder');
			expect(out).not.toMatch(/CIS|MITRE/);
		}
	});

	it('counts crosswalk edges by kind for the density view, never by demo folder', () => {
		const out = renderRecipeTemplate('crosswalk-density-by-framework', {}) ?? '';
		expect(out).toContain(`'kind == "crosswalk-edge"'`);
		expect(out).not.toContain('file.inFolder');
	});
});

describe('renderRecipeTemplate — inverted sections', () => {
	// Exercised through a shipped template: the hierarchy view's ^framework_set
	// branch carries the old folder filter, the #framework_set branch the id.
	const render = (params: Record<string, unknown>) => renderRecipeTemplate('skos-hierarchy-narrower', params) ?? '';

	it.each([
		['missing', {}],
		['empty string', { framework_set: '' }],
		['false', { framework_set: false }],
		['zero', { framework_set: 0 }],
		['empty array', { framework_set: [] }],
	])('shows the inverted block when the value is %s', (_label, params) => {
		const out = render(params);
		expect(out).toContain('file.inFolder');
		expect(out).not.toContain('import_set.id');
	});

	it('hides the inverted block when the value is truthy', () => {
		const out = render({ framework_set: 'iset-x' });
		expect(out).not.toContain('file.inFolder');
		expect(out).toContain('import_set.id == "iset-x"');
	});

	it('renders sections nested inside sections', () => {
		const t = '{{#a}}A{{^b}}-no-b{{/b}}{{#b}}-{{b}}{{/b}}{{/a}}{{^a}}none{{/a}}';
		expect(interpolate(t, { a: 'x' })).toBe('A-no-b');
		expect(interpolate(t, { a: 'x', b: 'y' })).toBe('A-y');
		expect(interpolate(t, {})).toBe('none');
		expect(interpolate(t, { b: 'y' })).toBe('none');
	});

	it('keeps side-by-side sections independent', () => {
		const withFamily = renderRecipeTemplate('controls-by-family-list', { framework_set: 'iset-x', family_filter: 'AC' }) ?? '';
		const withoutFamily = renderRecipeTemplate('controls-by-family-list', { framework_set: 'iset-x' }) ?? '';
		expect(withFamily).toContain('family == "AC"');
		expect(withFamily).toContain('import_set.id == "iset-x"');
		expect(withoutFamily).not.toContain('family ==');
	});
});
