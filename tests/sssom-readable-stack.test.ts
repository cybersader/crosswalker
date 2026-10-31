import { buildSyntheticRecipe, sssomRecipeDigest, knownSssomRecipeDigests, effectiveSssomDigest, LEGACY_SSSOM_FILE_TEMPLATE } from '../src/import/sssom-importer';
import { normalizeRecipe } from '../src/import/recipe-document';
import { computeRecipeHash } from '../src/generation/hash';
import { refreshRecipeProblem } from '../src/import/stack/stack-model';
import { mappingSlotRunChoices, slotRunChoices } from '../src/import/stack/stack-persistence';

const source = 'demo-a';
const target = 'demo-b';
const recipeId = 'sssom-demo-a-to-demo-b';
const fact = (recipeDigest: string) => ({ importSetId: 'iset-abc123', sourceDigest: 'source', recipeDigest, sourceName: 'synthetic.tsv' });

it('probe: the pre-change guard refuses the normalized digest stamped by legacy table imports', () => {
 const raw = buildSyntheticRecipe(source, target, LEGACY_SSSOM_FILE_TEMPLATE);
 const recipe = normalizeRecipe(raw);
 const tableHash = computeRecipeHash(recipe.target, recipe.source);
 const rawHash = computeRecipeHash(raw.target, raw.source);
 expect(tableHash).not.toBe(rawHash);
 expect(refreshRecipeProblem(recipe.recipe, [recipe.recipe], rawHash, [tableHash])).toMatch(/different or unrecorded detail/);
 expect(slotRunChoices(fact(rawHash), true, 'source', tableHash).choices).toEqual(['new']);
});

it('recognizes only four exact raw/normalized historical stamps', () => {
 const known = knownSssomRecipeDigests(source, target);
 expect(new Set(known).size).toBe(4);
 expect(sssomRecipeDigest(source, target)).toBe(known[2]);
 for (const hash of known) {
  const effective = effectiveSssomDigest(source, target, [hash]);
  expect(effective).toBe(hash);
  expect(refreshRecipeProblem(recipeId, [recipeId], effective, [hash])).toBeNull();
 }
 for (const recorded of [undefined, [], ['unknown'], [known[0], known[1]]]) {
  const effective = effectiveSssomDigest(source, target, recorded);
  expect(effective).toBe(known[2]);
  expect(refreshRecipeProblem(recipeId, [recipeId], effective, recorded)).not.toBeNull();
 }
});

it.each([0, 2])('offers Run again for raw run facts and normalized table headers of template pair %i', pairIndex => {
 const known = knownSssomRecipeDigests(source, target);
 const raw = known[pairIndex], normalized = known[pairIndex + 1];
 const effective = effectiveSssomDigest(source, target, [normalized]);
 const guard = refreshRecipeProblem(recipeId, [recipeId], effective, [normalized]);
 expect(mappingSlotRunChoices(source, target, fact(raw), true, 'source', effective, guard).choices).toContain('refresh');
 // One refresh records the authoritative set stamp. The next Run again agrees too.
 expect(mappingSlotRunChoices(source, target, fact(effective), true, 'source', effective, guard).choices).toContain('refresh');
 expect(mappingSlotRunChoices(source, target, fact(normalized), true, 'source', raw).choices).toContain('refresh');
});

it('refuses legacy/readable cross-pairs and every unknown hash, even equal unknown values', () => {
 const known = knownSssomRecipeDigests(source, target);
 for (const left of known.slice(0, 2)) for (const right of known.slice(2)) {
  expect(mappingSlotRunChoices(source, target, fact(left), true, 'source', right).choices).toEqual(['new']);
  expect(mappingSlotRunChoices(source, target, fact(right), true, 'source', left).choices).toEqual(['new']);
 }
 for (const [left, right] of [['unknown', known[0]], [known[0], 'unknown'], ['unknown', 'unknown']]) {
  expect(mappingSlotRunChoices(source, target, fact(left), true, 'source', right).choices).toEqual(['new']);
 }
 // Frameworks still compare exact hashes, with no mapping equivalence.
 expect(slotRunChoices(fact(known[0]), true, 'source', known[1]).choices).toEqual(['new']);
});
