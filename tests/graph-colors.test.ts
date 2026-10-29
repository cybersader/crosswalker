/** The shared graph color builder and the merge into a user's graph settings. */

import {
	FALLBACK_PALETTE,
	KNOWN_FRAMEWORK_GROUPS,
	LINK_GROUPS,
	PLUGIN_GRAPH_SEARCH,
	graphColorGroups,
	graphOptions,
	hexToRgb,
	mergeGraphOptions,
	prefixQuery,
} from '../src/graph/graph-colors';

const csf = { name: 'NIST CSF 2.0', prefix: 'nist-csf-2' };
const attack = { name: 'MITRE ATT&CK', prefix: 'mitre-attack' };

describe('graphColorGroups', () => {
	it('puts mapping then evidence first, then known frameworks in table order', () => {
		const groups = graphColorGroups([attack, csf]);
		expect(groups.map((g) => g.key)).toEqual(['mapping', 'evidence', 'csf', 'attack']);
		expect(groups[2].hex).toBe('#3b82f6');
		expect(groups[3].hex).toBe('#e5484d');
	});

	it('always includes the mapping and evidence groups, even with no frameworks', () => {
		expect(graphColorGroups([]).map((g) => g.key)).toEqual(LINK_GROUPS.map((g) => g.key));
	});

	it('colors unknown frameworks from the fixed palette in prefix order, after the known ones', () => {
		const groups = graphColorGroups([
			{ name: 'Zeta set', prefix: 'zeta' },
			csf,
			{ name: 'Alpha set', prefix: 'alpha' },
		]);
		expect(groups.map((g) => g.key)).toEqual(['mapping', 'evidence', 'csf', 'prefix:alpha', 'prefix:zeta']);
		expect(groups[3]).toMatchObject({ label: 'Alpha set', query: prefixQuery('alpha'), hex: FALLBACK_PALETTE[0].hex });
		expect(groups[4]).toMatchObject({ label: 'Zeta set', hex: FALLBACK_PALETTE[1].hex });
	});

	it('is independent of input order', () => {
		const a = graphColorGroups([{ name: 'B', prefix: 'b' }, { name: 'A', prefix: 'a' }, csf]);
		const b = graphColorGroups([csf, { name: 'A', prefix: 'a' }, { name: 'B', prefix: 'b' }]);
		expect(a).toEqual(b);
	});

	it('wraps the palette when there are more unknown frameworks than colors', () => {
		const many = Array.from({ length: FALLBACK_PALETTE.length + 2 }, (_, i) => ({ name: `F${i}`, prefix: `f${String(i).padStart(2, '0')}` }));
		const groups = graphColorGroups(many).slice(2);
		expect(groups[FALLBACK_PALETTE.length].hex).toBe(FALLBACK_PALETTE[0].hex);
		expect(groups[FALLBACK_PALETTE.length + 1].hex).toBe(FALLBACK_PALETTE[1].hex);
	});

	it('skips duplicate prefixes and prefixes that cannot be quoted safely', () => {
		const groups = graphColorGroups([csf, { name: 'Again', prefix: 'nist-csf-2' }, { name: 'Bad', prefix: 'x"y' }, { name: 'Space', prefix: 'a b' }]);
		expect(groups.map((g) => g.key)).toEqual(['mapping', 'evidence', 'csf']);
	});

	it('selects by tag or property only, never by folder path', () => {
		const all = graphColorGroups([...KNOWN_FRAMEWORK_GROUPS.map((g) => ({ name: g.label, prefix: g.prefix })), { name: 'Other', prefix: 'other' }]);
		for (const g of all) expect(g.query).not.toMatch(/(?<![\w-])(path|file|folder):/);
	});
});

describe('hexToRgb', () => {
	it('converts #rrggbb to the integer Obsidian stores and rejects anything else', () => {
		expect(hexToRgb('#f28c28')).toBe(0xf28c28);
		expect(() => hexToRgb('f28c28')).toThrow();
		expect(() => hexToRgb('#FFF')).toThrow();
	});
});

describe('mergeGraphOptions', () => {
	const groups = graphColorGroups([csf, attack]);
	const userGroup = { query: 'tag:#mine', color: { a: 1, rgb: 123 } };

	it('fills a missing settings file with defaults plus the generated groups, without view state', () => {
		const { options, managedQueries, keptUserGroups, searchApplied } = mergeGraphOptions(null, groups);
		expect(options).toEqual(graphOptions(groups, PLUGIN_GRAPH_SEARCH));
		expect(options).not.toHaveProperty('scale');
		expect(options).not.toHaveProperty('close');
		expect(managedQueries).toEqual(groups.map((g) => g.query));
		expect(keptUserGroups).toBe(0);
		expect(searchApplied).toBe(true);
	});

	it('keeps the user\'s own color groups, ahead of the generated ones', () => {
		const { options, keptUserGroups } = mergeGraphOptions({ colorGroups: [userGroup] }, groups);
		const cg = options.colorGroups as { query: string }[];
		expect(cg[0]).toEqual(userGroup);
		expect(cg.slice(1).map((g) => g.query)).toEqual(groups.map((g) => g.query));
		expect(keptUserGroups).toBe(1);
	});

	it('replaces groups it wrote before instead of duplicating them', () => {
		const first = mergeGraphOptions({ colorGroups: [userGroup] }, groups);
		const second = mergeGraphOptions(first.options, groups, first.managedQueries);
		expect(second.options.colorGroups).toEqual(first.options.colorGroups);
	});

	it('drops a group from the stored marker when its framework is gone', () => {
		const withOther = graphColorGroups([csf, { name: 'Other', prefix: 'other' }]);
		const first = mergeGraphOptions({}, withOther);
		const second = mergeGraphOptions(first.options, graphColorGroups([csf]), first.managedQueries);
		const queries = (second.options.colorGroups as { query: string }[]).map((g) => g.query);
		expect(queries).not.toContain(prefixQuery('other'));
		expect(queries).toEqual(graphColorGroups([csf]).map((g) => g.query));
	});

	it('recognizes the demo vault\'s groups as its own with no stored marker', () => {
		const demo = graphOptions(graphColorGroups([csf]), 'x', { viewState: true });
		const { options, keptUserGroups } = mergeGraphOptions(demo, groups);
		expect(keptUserGroups).toBe(0);
		expect((options.colorGroups as unknown[]).length).toBe(groups.length);
	});

	it('keeps a non-empty search and applies the filter to an empty one', () => {
		expect(mergeGraphOptions({ search: 'tag:#x' }, groups)).toMatchObject({ searchApplied: false, options: { search: 'tag:#x' } });
		expect(mergeGraphOptions({ search: '   ' }, groups)).toMatchObject({ searchApplied: true, options: { search: PLUGIN_GRAPH_SEARCH } });
	});

	it('turns on tags and hides unresolved links, leaving forces and other keys as the user set them', () => {
		const existing = { showTags: false, hideUnresolved: false, repelStrength: 3, linkDistance: 250, scale: 2, custom: 'kept' };
		const { options } = mergeGraphOptions(existing, groups);
		expect(options).toMatchObject({ showTags: true, hideUnresolved: true, repelStrength: 3, linkDistance: 250, scale: 2, custom: 'kept' });
		expect(options.centerStrength).toBe(0.3); // absent, so filled
	});

	it('ignores malformed color group entries without crashing and keeps them', () => {
		const { options } = mergeGraphOptions({ colorGroups: [null, 'x', { color: 1 }] }, groups);
		expect((options.colorGroups as unknown[]).slice(0, 3)).toEqual([null, 'x', { color: 1 }]);
	});
});
