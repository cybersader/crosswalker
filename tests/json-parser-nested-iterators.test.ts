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

	it('follows OSCAL controls through groups and later controls with enhancements', () => {
		const groups = [
			{
				id: 'ac', title: 'Access control',
				controls: [
					{
						id: 'ac-1', title: 'Policy',
						params: [{ id: 'ac-1_prm', label: 'Frequency' }],
						props: [{ name: 'label', value: 'AC-1' }],
						parts: [{ id: 'ac-1_smt', name: 'statement' }],
					},
					{
						id: 'ac-2', title: 'Account management',
						params: [{ id: 'ac-2_prm', label: 'Period' }],
						controls: [
							{ id: 'ac-2.1', title: 'Automated management', params: [{ id: 'ac-2.1_prm', label: 'Time' }], parts: [{ id: 'ac-2.1_smt', name: 'statement' }] },
							{ id: 'ac-2.2', title: 'Removal', params: [{ id: 'ac-2.2_prm', label: 'Days' }], parts: [{ id: 'ac-2.2_smt', name: 'statement' }] },
						],
					},
				],
			},
			{ id: 'at', title: 'Awareness', controls: [{ id: 'at-1', title: 'Training' }] },
		];
		const result = suggestIterators(JSON.stringify({ catalog: { groups } }));
		const candidate = result.candidates.find((entry) => entry.iterator === '$.catalog.groups[*]');

		expect(candidate?.count).toBe(2);
		expect(candidate?.nested?.slice(0, 2)).toEqual([
			{ field: 'controls', count: 3, sampleKeys: ['id', 'title', 'params', 'props', 'parts'], idKey: 'id' },
			{ field: 'controls', count: 2, sampleKeys: ['id', 'title', 'params', 'parts'], idKey: 'id' },
		]);
		// Enhancement arrays remain walkable after the two control levels.
		expect(candidate?.nested?.[2].count).toBe(2);
	});

	it('keeps the sole nested record array as the child level', () => {
		const result = suggestIterators(JSON.stringify([{ id: 'parent', parts: [{ id: 'part-1' }] }]));

		expect(result.candidates[0].nested).toEqual([
			{ field: 'parts', count: 1, sampleKeys: ['id'], idKey: 'id' },
		]);
	});

	it('prefers self-similar children over an earlier record array', () => {
		const result = suggestIterators(JSON.stringify([
			{ id: 'c-1', title: 'First', params: [{ id: 'p-1', label: 'Parameter' }], controls: [{ id: 'c-1.1', title: 'Enhancement' }] },
		]));

		expect(result.candidates[0].nested?.[0]).toEqual({
			field: 'controls', count: 1, sampleKeys: ['id', 'title'], idKey: 'id',
		});
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
