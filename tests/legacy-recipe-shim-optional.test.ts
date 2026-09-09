import { legacyConfigToRecipe } from '../src/generation/legacy-recipe-shim';
import { render, type Recipe } from '../src/render';
import type { FrontmatterMapping, ImportRecipe } from '../src/types/config';

function classicConfig(
	frontmatter: FrontmatterMapping[],
	overrides: Partial<ImportRecipe['mapping']> = {},
): ImportRecipe {
	return {
		name: 'ordinary-import',
		version: '1',
		source: { type: 'json' },
		transforms: {},
		mapping: {
			hierarchy: [],
			frontmatter,
			links: [],
			body: [],
			filename: { template: '{id}.md', sanitize: true },
			...overrides,
		},
		output: { basePath: 'Out', overwriteMode: 'replace', createFolders: true },
	};
}

function renderClassic(frontmatter: FrontmatterMapping[], scope: Record<string, unknown>) {
	return render(legacyConfigToRecipe(classicConfig(frontmatter)), {
		curie: 'ordinary:row',
		scope,
	});
}

describe('ordinary-import managed metadata omission policy', () => {
	it('synthesizes optional templates by default and strict templates only for explicit false', () => {
		const recipe = legacyConfigToRecipe(classicConfig([
			{ column: 'defaulted', key: 'defaulted' },
			{ column: 'enabled', key: 'enabled', omitIfEmpty: true },
			{ column: 'strict', key: 'strict', omitIfEmpty: false },
		]));

		expect(recipe.target.also_emit?.frontmatter?.managed).toEqual({
			defaulted: '{defaulted|optional}',
			enabled: '{enabled|optional}',
			strict: '{strict}',
		});
	});

	it.each([
		['absent', {}],
		['undefined', { value: undefined }],
		['null', { value: null }],
		['empty string', { value: '' }],
	])('omits a default managed key for %s', (_label, extra) => {
		const address = renderClassic([{ column: 'value', key: 'value' }], { id: 'row', ...extra });
		expect(address.frontmatter).not.toHaveProperty('value');
	});

	it('omits an actual empty-list result on the shim render path', () => {
		const address = renderClassic([{ column: 'values', key: 'values' }], { id: 'row', values: [] });
		expect(address.frontmatter).not.toHaveProperty('values');
	});

	it('preserves false and zero instead of treating them as empty', () => {
		const address = renderClassic([
			{ column: 'flag', key: 'flag' },
			{ column: 'count', key: 'count' },
		], { id: 'row', flag: false, count: 0 });
		expect(address.frontmatter).toHaveProperty('flag');
		expect(address.frontmatter).toHaveProperty('count');
		expect(String(address.frontmatter.flag)).toBe('false');
		expect(String(address.frontmatter.count)).toBe('0');
	});

	it('keeps an explicit omitIfEmpty false mapping strict', () => {
		expect(() => renderClassic(
			[{ column: 'required', key: 'required', omitIfEmpty: false }],
			{ id: 'row' },
		)).toThrow('resolved to undefined/null');
	});

	it('does not weaken canonical managed templates', () => {
		const canonical: Recipe = {
			recipe: 'canonical',
			source: { ontology: 'canonical', levels: ['leaf'] },
			target: {
				layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }],
				also_emit: { frontmatter: { managed: { required: '{required}' } } },
			},
		};
		expect(() => render(canonical, { curie: 'canonical:row', scope: { id: 'row' } }))
			.toThrow('resolved to undefined/null');
	});

	it('keeps filename inputs strict', () => {
		const recipe = legacyConfigToRecipe(classicConfig([{ column: 'value', key: 'value' }]));
		expect(() => render(recipe, { curie: 'ordinary:row', scope: { value: 'present' } }))
			.toThrow('resolved to undefined/null');
	});

	it('keeps hierarchy inputs strict', () => {
		const recipe = legacyConfigToRecipe(classicConfig(
			[{ column: 'value', key: 'value' }],
			{ hierarchy: [{ column: 'family', level: 1 }] },
		));
		expect(() => render(recipe, { curie: 'ordinary:row', scope: { id: 'row', value: 'present' } }))
			.toThrow('resolved to undefined/null');
	});
});
