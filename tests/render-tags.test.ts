import { render, renderTemplate, type ConceptIdentity, type Recipe, type SourceScope } from '../src/render';
import previousD3fend from '../recipes/import/mitre-d3fend.json';
import listView from '../recipes/v0-1/list-view.json';
import { validateRecipe } from '../src/validation/validator';

const listError = 'A tag template may hold one list-valued field. Split it into two tags.';
const tagTemplate = 'mitre-attack/tactic/{tactics|optional|split(,)|tagsafe}';

function recipeWithTags(tags: string[]): Recipe {
	return {
		recipe: 'tag-fan-out',
		target: {
			layout: [{ level: 'technique', mechanism: 'file', template: 'T1001.md' }],
			also_emit: { tags },
		},
	};
}

function renderTags(scope: SourceScope, tags = [tagTemplate]): string[] {
	const identity: ConceptIdentity = { curie: 'mitre-attack:T1001', scope };
	return render(recipeWithTags(tags), identity).tags;
}

function validateTags(tags: string[], style: 'A' | 'B' = 'A') {
	return validateRecipe({ ...recipeWithTags(tags), source: { ontology: 'mitre-attack', levels: ['technique'] } }, style);
}

describe('also_emit.tags list fan-out', () => {
	it('emits one tag for a single value', () => {
		expect(renderTags({ tactics: 'Execution' })).toEqual(['mitre-attack/tactic/execution']);
	});

	it('emits one tag per value, with scalar interpolations on either side', () => {
		expect(renderTags({ namespace: 'attack', tactics: 'Execution, Discovery', suffix: 'member' }, [
			'{namespace}/{tactics|split(,)|tagsafe}/{suffix}',
		])).toEqual(['attack/execution/member', 'attack/discovery/member']);
	});

	it.each(['', ' ', ', ,'])('skips an empty list-valued cell (%p)', tactics => {
		expect(renderTags({ tactics })).toEqual([]);
	});

	it.each([undefined, null])('skips an optional-absent cell (%p)', tactics => {
		expect(renderTags({ tactics })).toEqual([]);
	});

	it('skips an absent final field but preserves an empty middle interpolation byte-for-byte', () => {
		expect(renderTags({}, ['mitre-attack/tactic/{tactics|optional|tagsafe}'])).toEqual([]);
		expect(renderTags({}, ['mitre-attack/{nested.tactic|optional|tagsafe}/member'])).toEqual(['mitre-attack//member']);
		expect(renderTags({ middle: '' }, ['namespace/{middle}/member'])).toEqual(['namespace//member']);
	});

	it('drops a scalar empty value and any tag whose last path segment is empty', () => {
		expect(renderTags({ tactics: '' }, ['mitre-attack/tactic/{tactics}'])).toEqual([]);
		expect(renderTags({}, ['mitre-attack/tactic/', 'mitre-attack/tactic/   ', ''])).toEqual([]);
	});

	it('applies remaining filters per value and drops values blanked by tagsafe', () => {
		expect(renderTags({ tactics: 'Command and Control, !!!, Defense / Evasion, , Execution' })).toEqual([
			'mitre-attack/tactic/command-and-control',
			'mitre-attack/tactic/defense-evasion',
			'mitre-attack/tactic/execution',
		]);
	});

	it('keeps source and template order, deduplicating after filters', () => {
		const tags = [tagTemplate, 'mitre-attack/tactic/execution', 'other'];
		const scope = { tactics: 'Discovery, Execution, DISCOVERY, Persistence' };
		const expected = [
			'mitre-attack/tactic/discovery',
			'mitre-attack/tactic/execution',
			'mitre-attack/tactic/persistence',
			'other',
		];
		for (let i = 0; i < 10; i++) expect(renderTags(scope, tags)).toEqual(expected);
	});

	it('preserves scalar tags and explicit joins', () => {
		const tags = ['fixed', '{tactics|split(,)|join(-)|tagsafe}', '{other|split(:,0)}'];
		expect(renderTags({ tactics: 'Execution, Discovery', other: 'Family: description' }, tags)).toEqual([
			'fixed', 'execution-discovery', 'Family',
		]);
		expect(validateTags(tags).valid).toBe(true);
	});

	it('supports native list values through the same per-value path', () => {
		expect(renderTags({ tactics: ['Execution', '', 'Discovery'] }, ['tactic/{tactics|tagsafe}'])).toEqual([
			'tactic/execution', 'tactic/discovery',
		]);
	});

	it.each(['A', 'B'] as const)('rejects two list-valued interpolations at recipe validation (%s)', style => {
		const result = validateTags(['{tactics|split(,)}/{other|split(;)}'], style);
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([`target.also_emit.tags.0: ${listError}`]);
	});

	it('counts list-valued outputs, not split filters consumed by join', () => {
		const tags = ['{tactics|split(,)|join(-)}/{other|part(;)|tagsafe}'];
		expect(validateTags(tags).valid).toBe(true);
		expect(renderTags({ tactics: 'A,B', other: 'C;D' }, tags)).toEqual(['A-B/c', 'A-B/d']);
	});

	it('refuses multiple lists at render time too, including native arrays and empty lists', () => {
		expect(() => renderTags({ tactics: '', other: '' }, ['{tactics|split(,)}/{other|split(;)}'])).toThrow(listError);
		expect(() => renderTags({ tactics: ['A'], other: ['B'] }, ['{tactics}/{other}'])).toThrow(listError);
	});

	it('keeps missing required values loud', () => {
		expect(() => renderTags({}, ['tactic/{missing|tagsafe}'])).toThrow(/resolved to undefined\/null/);
	});

	it('keeps rule L3 for aliases and ordinary text templates', () => {
		const recipe = recipeWithTags([]);
		recipe.target.also_emit!.aliases = ['Tactic {tactics|split(,)|tagsafe}'];
		expect(() => render(recipe, { curie: 'mitre-attack:T1001', scope: { tactics: 'A,B' } })).toThrow(/produced a list.*add \|join/);
		expect(() => renderTemplate('{tactics|split(,)}', { tactics: 'A,B' })).toThrow(/produced a list.*add \|join/);
	});
});

it('keeps existing shipped scalar tag templates byte-identical', () => {
	for (const [recipe, scope] of [
		[previousD3fend, { ID: 'D3-SYN', 'D3FEND Tactic': 'Harden' }],
		[listView, { catalog: { name: 'Synthetic' }, family: { id: 'AC' }, control: { id: 'AC-1' } }],
	] as const) {
		const templates = recipe.target.also_emit.tags;
		expect(renderTags(scope, templates)).toEqual(templates.map((template) => renderTemplate(template, scope)));
	}
});
