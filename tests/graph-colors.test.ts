/** Synthetic graph policy regressions. No native runtime or source corpus. */
import {
	FALLBACK_PALETTE, KNOWN_FRAMEWORK_GROUPS, LINK_GROUPS,
	graphColorGroups, graphOptions, toColorGroupOption, hexToRgb, mergeGraphOptions,
	prefixQuery, frameworkOverviewPatch, configureFrameworkGraph, graphConfigurationPreview,
} from '../src/graph/graph-colors';

const csf = { name: 'NIST CSF 2.0', prefix: 'nist-csf-2' };
const attack = { name: 'MITRE ATT&CK', prefix: 'mitre-attack' };

describe('graphColorGroups', () => {
	it('keeps fixed framework and link identities, queries and colors distinct', () => {
		const fixed = [...LINK_GROUPS, ...KNOWN_FRAMEWORK_GROUPS];
		for (const field of ['key', 'query', 'hex', 'name'] as const) expect(new Set(fixed.map((g) => g[field])).size).toBe(fixed.length);
		expect(KNOWN_FRAMEWORK_GROUPS.find((g) => g.key === 'cis')?.hex).toBe('#0f9d8f');
		expect(KNOWN_FRAMEWORK_GROUPS.find((g) => g.key === 'd3fend')?.hex).toBe('#009b70');
	});
	it('puts mapping then evidence before known frameworks in table order', () => {
		expect(graphColorGroups([attack, csf]).map((g) => g.key)).toEqual(['mapping', 'evidence', 'csf', 'attack']);
		expect(graphColorGroups([]).map((g) => g.key)).toEqual(LINK_GROUPS.map((g) => g.key));
	});
	it('assigns unknown frameworks a deterministic wrapping palette in prefix order', () => {
		const a = graphColorGroups([{ name: 'Zeta', prefix: 'zeta' }, csf, { name: 'Alpha', prefix: 'alpha' }]);
		expect(a.map((g) => g.key)).toEqual(['mapping', 'evidence', 'csf', 'prefix:alpha', 'prefix:zeta']);
		expect(a[3]).toMatchObject({ query: prefixQuery('alpha'), hex: FALLBACK_PALETTE[0].hex });
		expect(a).toEqual(graphColorGroups([csf, { name: 'Alpha', prefix: 'alpha' }, { name: 'Zeta', prefix: 'zeta' }]));
		const many = Array.from({ length: FALLBACK_PALETTE.length + 2 }, (_, i) => ({ name: `F${i}`, prefix: `f${String(i).padStart(2, '0')}` }));
		expect(graphColorGroups(many).slice(2)[FALLBACK_PALETTE.length].hex).toBe(FALLBACK_PALETTE[0].hex);
	});
	it('skips duplicate and unsafe prefixes; never selects by path', () => {
		expect(graphColorGroups([csf, csf, { name: 'Bad', prefix: 'x"y' }, { name: 'Space', prefix: 'a b' }]).map((g) => g.key)).toEqual(['mapping', 'evidence', 'csf']);
		for (const g of graphColorGroups([...KNOWN_FRAMEWORK_GROUPS.map((g) => ({ name: g.label, prefix: g.prefix })), { name: 'Other', prefix: 'other' }])) expect(g.query).not.toMatch(/(?<![\w-])(path|file|folder):/);
	});
});

it('converts valid #rrggbb colors only', () => {
	expect(hexToRgb('#f28c28')).toBe(0xf28c28);
	expect(() => hexToRgb('f28c28')).toThrow();
	expect(() => hexToRgb('#FFF')).toThrow();
});

describe('preserving graph merge', () => {
	const groups = graphColorGroups([csf, attack]);
	const userGroup = { query: 'tag:#mine', color: { a: 1, rgb: 123 }, future: { kept: true } };
	it('missing settings stay missing; color-only never initializes presentation', () => {
		const result = mergeGraphOptions(null, groups);
		expect(result.options).toEqual({ colorGroups: groups.map(toColorGroupOption) });
		expect(result.searchApplied).toBe(false);
		expect(result.ownership.version).toBe(1);
	});
	it('preserves every non-color setting, including unknown nested values and intentionally empty searches', () => {
		for (const search of ['', '   ', 'tag:#mine']) {
			const existing = {
				search, showTags: false, hideUnresolved: false, showOrphans: true, showAttachments: true,
				showArrow: true, repelStrength: 3, linkDistance: 250, scale: 2, close: false,
				'collapse-filter': true, custom: { future: [1, { v: true }] }, colorGroups: [userGroup],
			};
			const before = JSON.stringify(existing);
			const result = mergeGraphOptions(existing, groups);
			expect(result.options).toEqual({ ...existing, colorGroups: [userGroup, ...groups.map(toColorGroupOption)] });
			expect(JSON.stringify(existing)).toBe(before);
		}
	});
	it('preserves custom same-query rules, duplicates and overlapping precedence, without shadowed generated copies', () => {
		const custom = { ...toColorGroupOption(groups[0]), color: { a: 0.3, rgb: 11 }, extra: 'keep' };
		const customEvidence = { ...toColorGroupOption(groups[1]), color: { a: 0.7, rgb: 99 } };
		const existing = { colorGroups: [userGroup, custom, custom, customEvidence] };
		const result = mergeGraphOptions(existing, groups, groups.map((g) => g.query)); // legacy marker
		expect(result.options.colorGroups).toEqual([...existing.colorGroups, ...groups.slice(2).map(toColorGroupOption)]);
		expect(result.keptUserGroups).toBe(4);
		expect(result.managedQueries).toEqual(groups.slice(2).map((g) => g.query));
	});
	it('legacy and unversioned demo groups are retained, not adopted', () => {
		const demo = graphOptions(groups, '', { viewState: true });
		const result = mergeGraphOptions(demo, groups, groups.map((g) => g.query));
		expect(result.options).toEqual(demo);
		expect(result.ownership.entries).toEqual([]);
		expect(result.keptUserGroups).toBe(groups.length);
	});
	it('replaces only matching owned occurrences and is idempotent', () => {
		const first = mergeGraphOptions({ colorGroups: [userGroup] }, groups);
		const second = mergeGraphOptions(first.options, groups, first.ownership);
		expect(second).toEqual(first);
		const withoutAttack = mergeGraphOptions(first.options, graphColorGroups([csf]), first.ownership);
		expect(withoutAttack.options.colorGroups).toEqual([userGroup, ...graphColorGroups([csf]).map(toColorGroupOption)]);
	});
	it('does not delete additional identical user copies when removing an owned framework', () => {
		const first = mergeGraphOptions({}, groups);
		const duplicate = JSON.parse(JSON.stringify(toColorGroupOption(groups.at(-1)!)));
		const existing = { colorGroups: [...first.options.colorGroups as unknown[], duplicate, duplicate] };
		const second = mergeGraphOptions(existing, graphColorGroups([csf]), first.ownership);
		expect((second.options.colorGroups as unknown[]).filter((g) => JSON.stringify(g) === JSON.stringify(duplicate))).toHaveLength(2);
		expect((second.options.colorGroups as unknown[]).slice(0, 2)).toEqual([duplicate, duplicate]);
	});
	it.each(['color', 'opacity', 'unknown'])('edited generated %s becomes user-owned', (field) => {
		const first = mergeGraphOptions({}, groups);
		const current = JSON.parse(JSON.stringify(first.options));
		const changed = current.colorGroups[0];
		if (field === 'color') changed.color.rgb = 10;
		else if (field === 'opacity') changed.color.a = 0.4;
		else changed.future = 'custom';
		const second = mergeGraphOptions(current, groups, first.ownership);
		expect((second.options.colorGroups as unknown[])[0]).toEqual(changed);
		expect(second.keptUserGroups).toBe(1);
		expect(second.ownership.entries.some((e) => e.group.query === groups[0].query)).toBe(false);
	});
	it('snapshots are independent from returned options; malformed/future ownership cannot delete groups', () => {
		const first = mergeGraphOptions({}, groups);
		(first.options.colorGroups as { color: { a: number } }[])[0].color.a = 0.5;
		expect(first.ownership.entries[0].group.color.a).toBe(1);
		for (const state of [{ version: 99, entries: first.ownership.entries }, { version: 1, entries: [null, {}, { index: -1 }] }]) {
			expect(mergeGraphOptions(first.options, groups, state).keptUserGroups).toBe(groups.length);
		}
	});
	it('keeps malformed group entries but refuses a malformed collection', () => {
		expect((mergeGraphOptions({ colorGroups: [null, 'x', { color: 1 }] }, groups).options.colorGroups as unknown[]).slice(0, 3)).toEqual([null, 'x', { color: 1 }]);
		expect(() => mergeGraphOptions({ colorGroups: {} }, groups)).toThrow();
	});
	it('overview changes exactly its four display keys plus explicitly requested colors', () => {
		expect(frameworkOverviewPatch()).toEqual({ showTags: false, showAttachments: false, showArrow: false, lineSizeMultiplier: 1.3 });
		const existing = { search: '', hideUnresolved: false, showOrphans: true, scale: 7, linkStrength: 4, future: 1, colorGroups: [userGroup] };
		const result = configureFrameworkGraph(existing, groups, undefined, 'overview');
		expect(result.options).toEqual({ ...mergeGraphOptions(existing, groups).options, ...frameworkOverviewPatch() });
		expect(graphConfigurationPreview(existing, result, 'overview').changes.map((c) => c.key)).toEqual(Object.keys(frameworkOverviewPatch()));
		expect(configureFrameworkGraph(existing, groups, undefined, 'colors')).toEqual(mergeGraphOptions(existing, groups));
	});
});
