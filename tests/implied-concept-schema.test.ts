import { isValidRecipe, validateRecipe } from '../src/validation/validator';
import { render, type Recipe, type LayoutValue } from '../src/render';

const recipe = (): Recipe => ({
	recipe: 'synthetic-implied-schema',
	source: { ontology: 'synthetic', levels: ['group', 'entry'] },
	target: { layout: [
		{ level: 'group', mechanism: 'folder', template: '{name}', implied_concept: { identity: '{id}' } },
		{ level: 'entry', mechanism: 'file', template: '{entry}.md' },
	] },
});

describe('implied concept declaration and identity', () => {
	it('accepts true and object forms without adding defaults', () => {
		const value = recipe();
		expect(validateRecipe(value).valid).toBe(true);
		value.target.layout[0].implied_concept = true;
		expect(validateRecipe(value).valid).toBe(true);
	});
	it('renders the declared identifier instead of guessing from the folder label', () => {
		const values: LayoutValue[] = [];
		const value = recipe();
		render(value, { curie: 'synthetic:AA-1', scope: { name: 'Invented group', id: 'AA', entry: 'AA-1' } }, undefined, values);
		expect(values[0]).toEqual({ level: 'group', value: 'Invented group', identity: 'AA' });
	});
	it('refuses invalid identity-template filters before row rendering', () => {
		const value = recipe();
		value.target.layout[0].implied_concept = { identity: '{id|not-a-filter}' };
		expect(validateRecipe(value).errors.join('\n')).toContain('target.layout.0.implied_concept.identity: Unknown filter');
		expect(isValidRecipe(value)).toBe(false);
		value.target.layout[0].implied_concept = { identity: '{id|lower|optional}' };
		expect(validateRecipe(value).errors.join('\n')).toContain('optional filter must be first');
	});
	it('refuses a leaf, a non-folder, and a variadic declaration by name', () => {
		const leaf = recipe();
		leaf.target.layout[1].implied_concept = true;
		expect(validateRecipe(leaf).errors.join('\n')).toContain('the leaf level produces rows');
		const nonFolder = recipe();
		nonFolder.target.layout[0].mechanism = 'file';
		expect(validateRecipe(nonFolder).errors.join('\n')).toContain('only a folder level can carry implied concepts');
		const variadic = recipe();
		variadic.target.layout[0].variadic = { delimiter: '.' };
		expect(validateRecipe(variadic).errors.join('\n')).toContain('implied concepts and variadic expansion cannot be combined');
	});
});
