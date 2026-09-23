import { fromRegions, toRecipeRegions } from '../src/import/mapping/serialize';
import type { ImportMapping } from '../src/import/mapping/types';

function sectionMapping(): ImportMapping {
	return {
		mappings: [
			{
				levels: [
					{ level: 'group', source: { column: 'id' }, destinations: [{ primitive: 'folder' }], naming: 'part', missing: 'skip', materialize: false },
					{ level: 'control', source: { column: 'id' }, destinations: [{ primitive: 'name' }], naming: 'part', missing: 'skip', materialize: false },
					{ level: 'part', source: { column: 'name' }, destinations: [{ primitive: 'heading', hostRule: 'control', depth: 2 }], naming: 'part', missing: 'skip', materialize: false },
				],
			},
			{
				levels: [{
					level: 'prose',
					source: { column: 'prose' },
					destinations: [{ primitive: 'body', position: 'append', level: 'part' }],
					naming: 'part',
					missing: 'skip',
					materialize: false,
				}],
			},
		],
		nest: [
			{ level: 'group', id: '{id}', children: 'controls', leaf: 'folder-note' },
			{ level: 'control', id: '{id}', children: 'parts' },
			{ level: 'part', id: '{id}', leaf: 'section' },
		],
	};
}

describe('section-level mapping serialization (B13)', () => {
	it('round-trips heading host, depth, and level-scoped body destination', () => {
		const mapping = sectionMapping();
		const regions = toRecipeRegions(mapping);
		expect(regions.layout).toContainEqual({
			level: 'part',
			mechanism: 'heading',
			level_depth: 2,
			template: '{name}',
		});
		expect(regions.also_emit?.body).toEqual([
			{ template: '{prose}', position: 'append', level: 'part' },
		]);
		expect(fromRegions(regions)).toEqual(mapping);
	});

	it('keeps recipes without section levels byte-stable', () => {
		const mapping = sectionMapping();
		mapping.mappings = [mapping.mappings[0]];
		mapping.mappings[0].levels = mapping.mappings[0].levels.slice(0, 2);
		mapping.nest = mapping.nest?.slice(0, 2);
		const regions = toRecipeRegions(mapping);
		expect(JSON.stringify(toRecipeRegions(fromRegions(regions)))).toBe(JSON.stringify(regions));
	});
});
