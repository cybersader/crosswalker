import { suggestIterators } from '../src/import/parsers/json-parser';

describe('nested JSON iterator suggestions', () => {
	it('reports a bounded child-array chain without removing flat candidates', () => {
		const groups = Array.from({ length: 2 }, (_, groupIndex) => ({
			id: `g-${groupIndex + 1}`,
			controls: Array.from({ length: 2 }, (_, controlIndex) => ({
				id: `c-${groupIndex + 1}-${controlIndex + 1}`,
				parts: Array.from({ length: 2 }, (_, partIndex) => ({
					id: `p-${groupIndex + 1}-${controlIndex + 1}-${partIndex + 1}`,
					title: 'Part',
				})),
			})),
		}));

		const result = suggestIterators(JSON.stringify({ catalog: { groups } }));
		const candidate = result.candidates.find(
			(entry) => entry.iterator === '$.catalog.groups[*]',
		);

		expect(candidate?.nested).toEqual([
			{ field: 'controls', count: 4, sampleKeys: ['id', 'parts'], idKey: 'id' },
			{ field: 'parts', count: 8, sampleKeys: ['id', 'title'], idKey: 'id' },
		]);
		expect(result.candidates.some(
			(entry) => entry.iterator === '$.catalog.groups[*].controls[*]',
		)).toBe(true);
	});

	it('returns null when child ids repeat within a walked parent', () => {
		const result = suggestIterators(JSON.stringify({
			groups: [{
				id: 'g-1',
				controls: [{ id: 'same' }, { id: 'same' }],
			}],
		}));
		const candidate = result.candidates.find((entry) => entry.iterator === '$.groups[*]');

		expect(candidate?.nested?.[0].idKey).toBeNull();
	});
});
