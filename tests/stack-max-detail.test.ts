import nistNested from '../recipes/import/nist-800-53-nested.json';
import criNested from '../recipes/import/cri-profile-v2-2-nested.json';
import { findRecognizedRecipes } from '../src/import/recipe-registry';
import { DEFAULT_STACK_SELECTION, frameworkChoices, frameworkSlots, stackSourceWhere, slotDetailSummary, stackRecipeHash, refreshRecipeProblem } from '../src/import/stack/stack-model';
import { render, type Recipe, type RenderReport } from '../src/render';
import { compileSourceExpression } from '../src/source';
import { validateRecipe } from '../src/validation/validator';

const selection = DEFAULT_STACK_SELECTION;
const nist = nistNested as Recipe;
const cri = criNested as Recipe;

describe('stack-only max-detail recipes', () => {
	it('validates both complete canonical bundled recipes', () => {
		expect(validateRecipe(nistNested, 'A').valid).toBe(true);
		expect(validateRecipe(criNested, 'A').valid).toBe(true);
	});

	it('retains flat choices for generic imports and chooses nested recipes only in the stack', () => {
		expect(frameworkChoices().find((entry) => entry.ontology === 'nist-800-53')?.id).toBe('nist-800-53-r5-flat');
		expect(frameworkChoices().find((entry) => entry.ontology === 'cri-profile')?.id).toBe('cri-profile-v2-2-flat');
		expect(frameworkSlots(selection).find((slot) => slot.ontology === 'nist-800-53')?.entry.id).toBe(nistNested.recipe);
		expect(frameworkSlots(selection).find((slot) => slot.ontology === 'cri-profile')?.entry.id).toBe(criNested.recipe);
		const found = findRecognizedRecipes(['identifier', 'name', 'control_text', 'discussion', 'related']);
		expect(found.some((match) => match.entry.id === 'nist-800-53-r5-flat')).toBe(true);
		expect(found.some((match) => match.entry.id.endsWith('-nested'))).toBe(false);
	});

	it.each([
		['ZZ-1', 'ZZ/ZZ-1/ZZ-1.md'],
		['ZZ-1(1)', 'ZZ/ZZ-1/ZZ-1(1).md'],
		['YY-2', 'YY/YY-2/YY-2.md'],
		['XX-3(2)', 'XX/XX-3/XX-3(2).md'],
	])('places synthetic NIST %s at %s', (identifier, expected) => {
		const address = render(nist, { curie: `nist-800-53:${identifier}`, scope: { identifier, name: 'Invented control', control_text: 'Invented text', discussion: '', related: '' } });
		expect(address.primary.path).toBe(expected);
		expect(address.frontmatter.family).toBe(identifier.slice(0, 2));
	});

	it.each([
		['GV', 'F', 'GV/GV.md', 4],
		['GV.OC', 'C', 'GV/GV.OC/GV.OC.md', 2],
		['GV.OC-01', 'S', 'GV/GV.OC/GV.OC-01/GV.OC-01.md', 0],
		['GV.OC-01.01', 'DS', 'GV/GV.OC/GV.OC-01/GV.OC-01.01.md', 0],
	])('places synthetic CRI %s at %s', (id, level, expected, missingNotes) => {
		const report: RenderReport = { notes: [] };
		const scope = { 'Profile Id': id, Level: level, 'Outline Id': id,
			'CRI Profile Function / Category / Subcategory': 'Invented / Category / Subcategory',
			'CRI Profile v2.2 Diagnostic Statement': 'Invented statement',
			'Tier-1': '', 'Tier-2': '', 'Tier-3': '', 'Tier-4': '' };
		expect(render(cri, { curie: `cri-profile:${id}`, scope }, report).primary.path).toBe(expected);
		expect(report.notes.filter((note) => ['prefix-index-missing', 'folder-level-skipped'].includes(note.code))).toHaveLength(missingNotes);
	});

	it('renders 7 F, 28 C, 119 S and 318 DS invented rows without collisions; top levels keep 154', async () => {
		const ids: Array<[string, string]> = [];
		const functions = Array.from({ length: 7 }, (_, i) => `Z${i}`);
		const categories = Array.from({ length: 28 }, (_, i) => `${functions[Math.floor(i / 4)]}.C${i % 4}`);
		const subcategories = Array.from({ length: 119 }, (_, i) => `${categories[i % 28]}-${String(Math.floor(i / 28)).padStart(2, '0')}`);
		ids.push(...functions.map((id): [string, string] => [id, 'F']));
		ids.push(...categories.map((id): [string, string] => [id, 'C']));
		ids.push(...subcategories.map((id): [string, string] => [id, 'S']));
		ids.push(...Array.from({ length: 318 }, (_, i): [string, string] => [
			`${subcategories[i % 119]}.${String(Math.floor(i / 119)).padStart(2, '0')}`, 'DS',
		]));
		const paths = new Set(ids.map(([id]) => render(cri, { curie: `cri-profile:${id}`, scope: {
			'Profile Id': id, Level: 'synthetic', 'Outline Id': id,
			'CRI Profile Function / Category / Subcategory': 'Invented / Category / Subcategory',
			'CRI Profile v2.2 Diagnostic Statement': 'Invented statement',
			'Tier-1': '', 'Tier-2': '', 'Tier-3': '', 'Tier-4': '',
		} }).primary.path));
		expect(ids).toHaveLength(472);
		expect(paths.size).toBe(472);
		const where = compileSourceExpression(stackSourceWhere('cri-profile', 'top-levels')!, { declaration: 'source.where' });
		const kept = await Promise.all(ids.map(async ([, Level], index) => where.evaluate({ Level }, index + 1)));
		expect(kept.filter(Boolean)).toHaveLength(154);
	});

	it('blocks a nested-set refresh with a flat recipe and uses the slot description for other frameworks', () => {
		expect(refreshRecipeProblem('nist-800-53-r5-flat', ['nist-800-53-r5-nested'])).toContain('different recipe');
		expect(refreshRecipeProblem('nist-800-53-r5-nested', ['nist-800-53-r5-nested'])).toBeNull();
		for (const ontology of ['nist-800-53', 'cri-profile']) {
			const slot = frameworkSlots(selection).find((item) => item.ontology === ontology)!;
			const maximal = stackRecipeHash(slot, 'max');
			const shorter = stackRecipeHash(slot, 'top-levels');
			expect(maximal).not.toBe(shorter);
			expect(refreshRecipeProblem(slot.entry.id, [slot.entry.id], maximal, [maximal])).toBeNull();
			expect(refreshRecipeProblem(slot.entry.id, [slot.entry.id], maximal, [shorter])).toContain('different or unrecorded detail');
			expect(refreshRecipeProblem(slot.entry.id, [slot.entry.id], maximal, [])).toContain('different or unrecorded detail');
		}
		const other = frameworkSlots({ ...selection, chosen: ['cis-v8'] }).find((slot) => slot.ontology === 'cis-v8')!;
		expect(slotDetailSummary(other, 'max')).toBe(other.entry.description);
	});

	it('filters only the selected slot and preserves the canonical recipe', async () => {
		expect(stackSourceWhere('nist-800-53', 'max')).toBeUndefined();
		expect(stackSourceWhere('cri-profile', 'max')).toBeUndefined();
		expect(stackSourceWhere('mitre-attack', 'top-levels')).toBeUndefined();
		const nistPredicate = compileSourceExpression(stackSourceWhere('nist-800-53', 'top-levels')!, { declaration: 'source.where' });
		expect(await nistPredicate.evaluate({ identifier: 'ZZ-1' }, 1)).toBe(true);
		expect(await nistPredicate.evaluate({ identifier: 'ZZ-1(1)' }, 2)).toBe(false);
		const criPredicate = compileSourceExpression(stackSourceWhere('cri-profile', 'top-levels')!, { declaration: 'source.where' });
		for (const level of ['F', 'C', 'S']) expect(await criPredicate.evaluate({ Level: level }, 1)).toBe(true);
		expect(await criPredicate.evaluate({ Level: 'DS' }, 1)).toBe(false);
		expect(nistNested.source).not.toHaveProperty('where');
		expect(criNested.source).not.toHaveProperty('where');
		expect(slotDetailSummary(frameworkSlots(selection).find((slot) => slot.ontology === 'nist-800-53')!, 'max')).toContain('family becomes a folder;');
	});
});
