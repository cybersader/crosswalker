/**
 * SchemaVer 1.18.0: the optional `mapping_set` block on a crosswalk column
 * (slice 2 ruling S5). Schema acceptance, and the portable-recipe fidelity
 * rule: the workbench carries the block through untouched, a no-op patch
 * returns the canonical document byte for byte, and an unrelated edit keeps it.
 * Synthetic ids only.
 */
import {
	loadRecipeDocument,
	patchRecipeDocument,
	serializeCanonicalRecipe,
} from '../src/import/recipe-document';
import { setCrosswalkTarget } from '../src/import/mapping/view-model';
import { computeRecipeHash } from '../src/generation/hash';
import { validateRecipe } from '../src/validation/validator';
import type { CrosswalkerImportRecipe } from '../src/types/generated/recipe';
import type { ImportMapping } from '../src/import/mapping/types';

const BLOCK = {
	id: 'https://example.org/mappings/demo-a-to-demo-b',
	version: '2026.1',
	title: 'Demo A to demo B',
	description: 'Synthetic release for tests.',
	license: 'https://creativecommons.org/publicdomain/zero/1.0/',
	provider: 'https://example.org/provider',
	date: '2026-10-03',
	creator_id: ['orcid:0000-0000-0000-0000'],
	subject_source: 'demo-a',
	subject_source_version: '1.0',
	object_source: 'demo-b',
	object_source_version: '2.0',
};

function recipe(entry: Record<string, unknown> = {}): CrosswalkerImportRecipe {
	return {
		recipe: 'synthetic-demo-a-crosswalk',
		source: { ontology: 'demo-a', levels: ['concept'] },
		target: {
			layout: [{ level: 'concept', mechanism: 'file', template: '{id}.md' }],
			crosswalks: [{
				column: 'Maps to',
				to_ontology: 'demo-b',
				predicate: 'is_equivalent_to',
				drop: ['None', 'TBD'],
				mapping_set: BLOCK,
				...entry,
			}],
		},
	} as unknown as CrosswalkerImportRecipe;
}

function crosswalkLevel(mapping: ImportMapping): { mi: number; li: number } {
	for (const [mi, structure] of mapping.mappings.entries()) {
		for (const [li, level] of structure.levels.entries()) {
			if (level.destinations.some((destination) => destination.primitive === 'crosswalk')) return { mi, li };
		}
	}
	throw new Error('No crosswalk destination in the mapping');
}

describe('SchemaVer 1.18.0 crosswalk_entry.mapping_set', () => {
	it('accepts the full block and the legacy alias beside it', () => {
		expect(validateRecipe(recipe()).valid).toBe(true);
		expect(validateRecipe(recipe({ mapping_set_id: BLOCK.id })).valid).toBe(true);
		expect(validateRecipe(recipe({ mapping_set: {} })).valid).toBe(true);
	});

	it.each([
		['an unknown key', { ...BLOCK, unknown: 'x' }],
		['an empty id', { ...BLOCK, id: '' }],
		['a creator_id that is not a list', { ...BLOCK, creator_id: 'orcid:0000' }],
		['an empty creator_id list', { ...BLOCK, creator_id: [] }],
	] as Array<[string, Record<string, unknown>]>)('rejects %s', (_label, block) => {
		expect(validateRecipe(recipe({ mapping_set: block })).valid).toBe(false);
	});

	it('changes the recipe hash when a column declares the block', () => {
		const without = recipe();
		delete (without.target.crosswalks![0] as { mapping_set?: unknown }).mapping_set;
		const withBlock = recipe();
		expect(computeRecipeHash(withBlock.target)).not.toBe(computeRecipeHash(without.target));
	});
});

describe('workbench fidelity for the mapping_set block', () => {
	it('a no-op workbench round trip returns the canonical document byte for byte', () => {
		const original = recipe();
		const loaded = loadRecipeDocument(original, { origin: 'user' });
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		const crosswalk = loaded.document.mapping.mappings
			.flatMap((structure) => structure.levels)
			.flatMap((level) => level.destinations)
			.find((destination) => destination.primitive === 'crosswalk');
		expect(crosswalk).toEqual(expect.objectContaining({ mappingSet: BLOCK, drop: ['None', 'TBD'] }));

		const patched = patchRecipeDocument(loaded.document);
		expect(patched.ok).toBe(true);
		if (!patched.ok) return;
		expect(patched.dirty).toBe(false);
		expect(serializeCanonicalRecipe(patched.recipe)).toBe(serializeCanonicalRecipe(original));
	});

	it('an unrelated crosswalk edit keeps the block and the drop list untouched', () => {
		const loaded = loadRecipeDocument(recipe(), { origin: 'user' });
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		const { mi, li } = crosswalkLevel(loaded.document.mapping);
		const mapping: ImportMapping = {
			...loaded.document.mapping,
			mappings: loaded.document.mapping.mappings.map((structure, index) =>
				index === mi ? setCrosswalkTarget(structure, li, { predicate: 'is_broader_than' }) : structure),
		};
		const patched = patchRecipeDocument(loaded.document, { mapping });
		expect(patched.ok).toBe(true);
		if (!patched.ok) return;
		expect(patched.dirty).toBe(true);
		const entry = patched.recipe.target.crosswalks![0];
		expect(entry.predicate).toBe('is_broader_than');
		expect(entry.mapping_set).toEqual(BLOCK);
		expect(entry.drop).toEqual(['None', 'TBD']);
	});
});
