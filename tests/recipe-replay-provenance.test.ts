import { mergeFrontmatter } from '../src/generation/frontmatter-merge';
import { computeRecipeHash, recipeHashCanonicalInput } from '../src/generation/hash';
import { normalizeRecipe } from '../src/import/recipe-document';
import { recipeChangedSinceRun, recipeRunDigest } from '../src/import/recipe-runs';
import type { CrosswalkerImportRecipe } from '../src/types/generated/recipe';
import { validateRecipe } from '../src/validation/validator';

const original = (): CrosswalkerImportRecipe => ({
	recipe: 'synthetic-replay',
	source: { ontology: 'synthetic', levels: ['entry'] },
	target: { layout: [{ level: 'entry', mechanism: 'file', template: '{id}.md' }],
		also_emit: { body: [{ template: '{description}' }] } },
});
const stamp = (recipe: CrosswalkerImportRecipe, owner = 'iset-a0f1e2') => ({
	curie: 'synthetic:A',
	_crosswalker: { import_set: { id: owner }, recipe: { id: recipe.recipe,
		hash: computeRecipeHash(recipe.target, recipe.source), recipe_document_digest: recipeRunDigest(recipe) } },
});
const mergedHash = (old: ReturnType<typeof stamp>, fresh: ReturnType<typeof stamp>): unknown =>
	(mergeFrontmatter(old, fresh, new Set()) as typeof fresh)._crosswalker.recipe.hash;

// Old copies normalized defaults before storage. The document, not that
// representation-only target-hash difference, decides whether a revision changed.
describe('historical normalized-copy provenance compatibility', () => {
	it('preserves each note\'s own historical hash only for an equivalent document', () => {
		const recipe = original();
		const normalized = normalizeRecipe(recipe);
		const old = stamp(recipe);
		const fresh = stamp(normalized);
		expect(old._crosswalker.recipe.hash).not.toBe(fresh._crosswalker.recipe.hash);
		expect(old._crosswalker.recipe.recipe_document_digest).toBe(fresh._crosswalker.recipe.recipe_document_digest);
		expect(mergedHash(old, fresh)).toBe(old._crosswalker.recipe.hash);
		expect(fresh).toEqual(stamp(normalized)); // merge never mutates the input
	});

	it('same recipe id with a semantically different document stamps the new hash and shows changed', () => {
		const recipe = original();
		const changed = original();
		changed.target.auto_heading = false;
		const old = stamp(recipe);
		const fresh = stamp(changed);
		expect(recipeChangedSinceRun({ recipeDocumentDigest: recipeRunDigest(recipe)! }, recipeRunDigest(changed))).toBe(true);
		expect(fresh._crosswalker.recipe.hash).not.toBe(old._crosswalker.recipe.hash);
		expect(mergedHash(old, fresh)).toBe(fresh._crosswalker.recipe.hash);
	});

	it.each([undefined, null, '', 'invalid', 'sha256-short', `sha256-${'g'.repeat(64)}`])('fails closed for missing or invalid recorded digest %s', (digest) => {
		const recipe = original();
		const old = stamp(recipe);
		(old._crosswalker.recipe as Record<string, unknown>).recipe_document_digest = digest;
		const fresh = stamp(normalizeRecipe(recipe));
		expect(mergedHash(old, fresh)).toBe(fresh._crosswalker.recipe.hash);
	});

	it('never borrows a hash from another owner, identity or recipe id', () => {
		const recipe = original();
		const old = stamp(recipe);
		const variants = [stamp(normalizeRecipe(recipe), 'iset-b0f1e2'),
			{ ...stamp(normalizeRecipe(recipe)), curie: 'synthetic:B' },
			stamp({ ...normalizeRecipe(recipe), recipe: 'another-recipe' })];
		for (const fresh of variants) expect(mergedHash(old, fresh)).toBe(fresh._crosswalker.recipe.hash);
	});
});

const mutations: Array<[string, (recipe: CrosswalkerImportRecipe) => void]> = [
	['layout', (recipe) => { recipe.target.layout[0].template = '{id}-different.md'; }],
	['also_emit', (recipe) => { recipe.target.also_emit!.body![0].template = '{other}'; }],
	['enrichment', (recipe) => { recipe.target.enrichment = { children_lists: true }; }],
	['auto_heading', (recipe) => { recipe.target.auto_heading = false; }],
	['crosswalks', (recipe) => { recipe.target.crosswalks = [{ column: 'mapping', to_ontology: 'other' }]; }],
	['source_where', (recipe) => { recipe.source.where = "id != ''"; }],
	['source_joins', (recipe) => { recipe.source.joins = { lookup: {
		from: { sheet: 'secondary' }, on: { primary: 'id', secondary: 'id' }, cardinality: 'one',
	} }; }],
	['source_nest', (recipe) => { recipe.source.nest = [{ level: 'entry', id: '{id}' }]; }],
];

describe('document digest covers the entire historical target-hash field set', () => {
	it('pins all selected fields, including where, joins and nest, to coverage cases', () => {
		const recipe = original();
		for (const [, mutate] of mutations) mutate(recipe);
		expect(Object.keys(JSON.parse(recipeHashCanonicalInput(recipe.target, recipe.source))).sort())
			.toEqual(mutations.map(([field]) => field).sort());
	});

	it.each(mutations)('changes both hashes for a semantic change in %s', (_field, mutate) => {
		const recipe = original();
		const changed = original();
		mutate(changed);
		expect(validateRecipe(changed).valid).toBe(true);
		expect(computeRecipeHash(changed.target, changed.source)).not.toBe(computeRecipeHash(recipe.target, recipe.source));
		expect(recipeRunDigest(changed)).not.toBe(recipeRunDigest(recipe));
	});
});
