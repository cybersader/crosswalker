/**
 * The byte-identical guarantee (Ch 46 source contract §8 and acceptance cases
 * A1-A4).
 *
 * THIS IS THE MOST IMPORTANT TEST IN THE MILESTONE. `recipe.hash` is written
 * into every generated note's `_crosswalker` block, and the vault compares it
 * on re-import to distinguish recipe drift from source drift. If adding
 * `source.where` to the hashed field set changes the hash of a recipe that does
 * NOT declare one, then every already-generated note in every user's vault
 * looks recipe-drifted the next time it is imported.
 *
 * The trap is specific and has been hit before: `?? null` injects a key into
 * the canonical string even when the field is absent. `canonicalStringify`
 * drops undefined-valued keys, so the field must be passed through undefined,
 * never coerced. The same comment already guards `auto_heading` (SchemaVer
 * 1.8.0) for exactly this reason.
 *
 * tests/fixtures/recipe-hash-golden.json was generated from the PRE-change
 * code. Do not regenerate it to make this test pass. The sole documented
 * exception is `cri-profile-v2-2.json`: Wave 2d deliberately moved its target
 * hash from sha256-3f44049e... to sha256-84e795b6... by declaring
 * `target.crosswalks`; every other pin remains the original baseline.
 *
 * Six shipped recipes have since adopted `source.where` to select their own
 * rows (SchemaVer 1.9.0), so their LIVE hash legitimately differs from the
 * golden — that movement is F2 doing its job, not drift. The golden stays the
 * baseline for the question A1 actually asks: with shaping stripped, does every
 * shipped recipe still hash exactly as it did before src/source existed? That
 * is asserted for all 14, which is strictly more than asserting the live hash
 * of the eight that happen to declare nothing.
 *
 * A recipe added AFTER src/source existed (nist-csf-2-withdrawal-lineage) has
 * no pre-change value to preserve, so its golden entry is its stripped hash as
 * first computed. That entry is what stops it from being edited unnoticed
 * later; it is not evidence about the source-stage change itself.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
	computeRecipeHash,
	recipeHashCanonicalInput,
	type EffectiveRecipeSource,
} from '../src/generation/hash';
import {
	getSourceExpressionCompileCount,
	prepareSourceStage,
	resetSourceExpressionCompileCount,
} from '../src/source';
import type { ParsedData } from '../src/types/config';

const REPO = join(__dirname, '..');
const GOLDEN = JSON.parse(
	readFileSync(join(__dirname, 'fixtures', 'recipe-hash-golden.json'), 'utf8'),
) as Record<string, string>;

interface ShippedRecipe {
	relPath: string;
	recipe: { target: Record<string, unknown>; source?: EffectiveRecipeSource };
}

function shippedRecipes(): ShippedRecipe[] {
	const out: ShippedRecipe[] = [];
	for (const dir of ['recipes/import', 'recipes/starter']) {
		for (const file of readdirSync(join(REPO, dir)).filter((n) => n.endsWith('.json')).sort()) {
			const relPath = `${dir}/${file}`;
			out.push({ relPath, recipe: JSON.parse(readFileSync(join(REPO, relPath), 'utf8')) });
		}
	}
	return out;
}

/**
 * The five shipped recipes that adopted `source.where` to select their own rows,
 * with the exact predicate each declares.
 *
 * Pinned here on purpose. A shipped predicate decides which notes exist in a
 * user's vault and its text is inside `recipe.hash`, so editing one is a
 * deliberate two-file change, never a drive-by. Adding or removing a row here
 * without the matching recipe edit fails immediately.
 */
const DECLARED_WHERE: Record<string, string> = {
	'recipes/import/cis-controls-v8-controls.json': "$trim(`CIS Safeguard`) = ''",
	'recipes/import/cis-controls-v8.json': "$trim(`CIS Safeguard`) != ''",
	'recipes/import/nist-csf-2-cprt-hierarchical.json': "$not(element_type in ['sort', 'party'])",
	'recipes/import/nist-csf-2-cprt.json': "$not(element_type in ['sort', 'party'])",
	'recipes/import/nist-csf-2.json': "Subcategory != ''",
	'recipes/import/nist-csf-2-withdrawal-lineage.json': "successor_id != ''",
};

describe('A1 — the source-stage code change moved no shipped recipe hash', () => {
	const recipes = shippedRecipes();

	it('covers every shipped recipe, so a new one cannot slip past unpinned', () => {
		expect(recipes.map((r) => r.relPath).sort()).toEqual(Object.keys(GOLDEN).sort());
		expect(recipes).toHaveLength(14);
	});

	/**
	 * The load-bearing assertion, and it holds for all 13 regardless of what any
	 * recipe declares: with source shaping stripped, every shipped recipe must
	 * still hash to its PRE-change value. That is the property A1 exists to
	 * protect — that widening the hashed field set introduced no drift of its own.
	 * Asserting the LIVE hash instead would conflate two different facts, and
	 * would have to be relaxed the moment any recipe declared a predicate.
	 */
	it.each(recipes.map((r) => [r.relPath, r] as const))(
		'%s hashes as it did before, with shaping stripped',
		(relPath, entry) => {
			expect(computeRecipeHash(entry.recipe.target)).toBe(GOLDEN[relPath]);
		},
	);

	const undeclared = recipes.filter((r) => !(r.relPath in DECLARED_WHERE));

	it.each(undeclared.map((r) => [r.relPath, r] as const))(
		'%s declares no shaping, so its LIVE hash is unchanged too',
		(relPath, entry) => {
			expect(computeRecipeHash(entry.recipe.target, entry.recipe.source)).toBe(GOLDEN[relPath]);
		},
	);

	it('the set of recipes declaring source shaping is pinned', () => {
		const declaring = recipes
			.filter((r) => r.recipe.source?.where !== undefined || r.recipe.source?.joins !== undefined)
			.map((r) => r.relPath)
			.sort();
		expect(declaring).toEqual(Object.keys(DECLARED_WHERE).sort());
	});

	it('pins the sole Wave 2d target-hash move to the CRI crosswalk declaration', () => {
		const entry = recipes.find((r) => r.relPath === 'recipes/import/cri-profile-v2-2.json');
		expect(entry?.recipe.target.crosswalks).toEqual([
			{
				column: 'NIST CSF v2 Mapping',
				to_ontology: 'nist-csf-2',
				predicate: 'is_approximate_to',
				qualifier: 'keep-as-justification',
			},
		]);
		expect(GOLDEN['recipes/import/cri-profile-v2-2.json']).toBe(
			'sha256-84e795b6529a60615e9183f9e63aac43a991bc8f5a0f4b430ed80413bf7deaf7',
		);
	});

	it('no shipped recipe declares joins', () => {
		for (const entry of recipes) expect(entry.recipe.source?.joins).toBeUndefined();
	});

	it.each(Object.entries(DECLARED_WHERE))('%s declares exactly the pinned predicate', (relPath, where) => {
		const entry = recipes.find((r) => r.relPath === relPath);
		expect(entry?.recipe.source?.where).toBe(where);
	});

	/** The other half of F2: a declaration is the ONLY thing that moved a hash. */
	it.each(Object.keys(DECLARED_WHERE))('%s moved its hash, and only because of the declaration', (relPath) => {
		const entry = recipes.find((r) => r.relPath === relPath);
		const live = computeRecipeHash(entry?.recipe.target ?? {}, entry?.recipe.source);
		expect(live).not.toBe(GOLDEN[relPath]);
		expect(recipeHashCanonicalInput(entry?.recipe.target ?? {}, entry?.recipe.source)).toContain(
			'source_where',
		);
	});
});

describe('A2 — assert on the canonical STRING, not just the digest', () => {
	const target = { layout: [{ level: 'control', mechanism: 'file', template: '{id}.md' }] };

	it('omits both source keys entirely when no shaping is declared', () => {
		const canonical = recipeHashCanonicalInput(target);
		expect(canonical).not.toContain('source_where');
		expect(canonical).not.toContain('source_joins');
	});

	it('omits them for a source block that carries only informational fields', () => {
		const canonical = recipeHashCanonicalInput(target, {} as EffectiveRecipeSource);
		expect(canonical).not.toContain('source_where');
		expect(canonical).not.toContain('source_joins');
	});

	it('produces the identical string whether source is absent, empty, or all-undefined', () => {
		const a = recipeHashCanonicalInput(target);
		const b = recipeHashCanonicalInput(target, {});
		const c = recipeHashCanonicalInput(target, { where: undefined, joins: undefined });
		expect(b).toBe(a);
		expect(c).toBe(a);
	});

	it('would have caught the `?? null` trap', () => {
		// The failure mode in one line: coercing absent to null injects the key.
		const withNull = recipeHashCanonicalInput(target, { where: null as unknown as string });
		expect(withNull).toContain('source_where');
		expect(withNull).not.toBe(recipeHashCanonicalInput(target));
	});
});

describe('F2/F3 — declaring source shaping DOES move the hash', () => {
	const target = { layout: [{ level: 'control', mechanism: 'file', template: '{id}.md' }] };

	it('a where changes it', () => {
		expect(computeRecipeHash(target, { where: "Subcategory != ''" })).not.toBe(computeRecipeHash(target));
	});

	it('a different where changes it again', () => {
		expect(computeRecipeHash(target, { where: "Subcategory != ''" })).not.toBe(
			computeRecipeHash(target, { where: "Subcategory = ''" }),
		);
	});

	it('joins is reserved in the hash ahead of its implementation', () => {
		// Not yet in the schema, so always undefined in practice; pinned so the
		// agent that ships joins does not have to reopen this function.
		expect(computeRecipeHash(target, { joins: { m: { on: 'x' } } })).not.toBe(computeRecipeHash(target));
	});

	it('is insensitive to key order inside the declaration', () => {
		expect(computeRecipeHash(target, { where: 'a', joins: { b: 1, a: 2 } })).toBe(
			computeRecipeHash(target, { joins: { a: 2, b: 1 }, where: 'a' }),
		);
	});
});

describe('A4 — no declaration means the expression engine is never entered', () => {
	const parsed: ParsedData = { columns: ['id'], rows: [{ id: '1' }], rowCount: 1 };

	beforeEach(() => resetSourceExpressionCompileCount());

	it('compiles nothing when the recipe declares no source shaping', async () => {
		await prepareSourceStage(parsed, undefined);
		await prepareSourceStage(parsed, {});
		expect(getSourceExpressionCompileCount()).toBe(0);
	});

	it('compiles exactly once when it does', async () => {
		await prepareSourceStage(parsed, { where: "id != ''" });
		expect(getSourceExpressionCompileCount()).toBe(1);
	});

	it('compiles once per run, not once per row', async () => {
		const many: ParsedData = {
			columns: ['id'],
			rows: Array.from({ length: 500 }, (_, i) => ({ id: String(i) })),
			rowCount: 500,
		};
		const stage = await prepareSourceStage(many, { where: "id != ''" });
		for await (const _row of stage.rows as AsyncIterable<Record<string, unknown>>) { /* consume */ }
		expect(getSourceExpressionCompileCount()).toBe(1);
	});
});
