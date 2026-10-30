/**
 * The demo vault's graph view settings (tools/lib/demo-graph.ts): which color
 * groups are written, in which order, and that the bytes never vary.
 */
import { FRAMEWORK_GROUPS, GRAPH_SEARCH, LINK_GROUPS, demoGraphConfig, demoGraphGroups, demoGraphJson, augmentDemoGraph } from '../../tools/lib/demo-graph';

const DEMO = ['csf', 'sp80053', 'attack', 'f3'];

describe('demo graph settings', () => {
	it('puts the mapping and evidence groups first, then the frameworks in a fixed order', () => {
		// Obsidian colors a note with the first group that matches it.
		expect(demoGraphGroups(DEMO).map((g) => g.key)).toEqual(['mapping', 'evidence', 'csf', 'sp80053', 'attack', 'f3']);
		expect(demoGraphGroups(['attack', 'csf']).map((g) => g.key)).toEqual(['mapping', 'evidence', 'csf', 'attack']);
	});

	it('adds the locally added licensed framework only when it is present', () => {
		expect(demoGraphGroups(DEMO).some((g) => g.key === 'cri')).toBe(false);
		expect(demoGraphJson(DEMO)).not.toMatch(/cri/i);
		expect(demoGraphGroups([...DEMO, 'cri']).map((g) => g.key).at(-1)).toBe('cri');
	});

	it('ignores keys it has no group for', () => {
		expect(demoGraphGroups(['csf', 'unknown']).map((g) => g.key)).toEqual(['mapping', 'evidence', 'csf']);
	});

	it('selects every group by tag or property, never by folder path', () => {
		for (const g of [...LINK_GROUPS, ...FRAMEWORK_GROUPS]) {
			expect({ key: g.key, path: /\b(path|file|folder):/.test(g.query) }).toEqual({ key: g.key, path: false });
			expect({ key: g.key, selects: /tag:#|\[[a-z_]+:/.test(g.query) }).toEqual({ key: g.key, selects: true });
		}
	});

	it('uses distinct, valid colors', () => {
		const all = [...LINK_GROUPS, ...FRAMEWORK_GROUPS];
		for (const g of all) expect({ key: g.key, hex: g.hex }).toEqual({ key: g.key, hex: expect.stringMatching(/^#[0-9a-f]{6}$/) });
		expect(new Set(all.map((g) => g.hex)).size).toBe(all.length);
		expect(new Set(all.map((g) => g.name)).size).toBe(all.length);
		const config = demoGraphConfig(DEMO) as { colorGroups: { query: string; color: { a: number; rgb: number } }[] };
		expect(config.colorGroups[0]).toEqual({ query: LINK_GROUPS[0].query, color: { a: 1, rgb: 0xf28c28 } });
	});

	it('explicitly initializes the shared overview, retaining demo search and camera defaults', () => {
		const config = demoGraphConfig(DEMO);
		expect(config).toMatchObject({
			showTags: false,
			showArrow: false,
			lineSizeMultiplier: 1.3,
			hideUnresolved: true,
			showOrphans: false,
			showAttachments: false,
			close: true,
			search: GRAPH_SEARCH,
		});
		expect(GRAPH_SEARCH).toBe('-path:"_crosswalker/import-sets" -path:"Queries" -file:"Start here"');
	});

	it('augments synthetic existing demos without replacing display, unknown settings or custom same-query colors', () => {
		const custom = { query: FRAMEWORK_GROUPS[0].query, color: { a: 0.3, rgb: 123 }, extra: true };
		const existing = { search: '', showTags: true, showArrow: true, hideUnresolved: false, repelStrength: 99, scale: 8, close: false, future: { keep: true }, colorGroups: [custom, custom] };
		const before = JSON.stringify(existing);
		const first = augmentDemoGraph(existing, ['csf', 'attack']);
		expect(first.options).toMatchObject({ ...existing, colorGroups: expect.any(Array) });
		expect((first.options.colorGroups as unknown[]).slice(0, 2)).toEqual(existing.colorGroups);
		expect((first.options.colorGroups as { query: string }[]).filter((g) => g.query === custom.query)).toHaveLength(2);
		expect(augmentDemoGraph(first.options, ['csf', 'attack'], first.ownership)).toEqual(first);
		expect(JSON.stringify(existing)).toBe(before);
	});

	it('initializes only genuinely absent settings and refuses malformed existing documents', () => {
		expect(augmentDemoGraph(undefined, DEMO).options).toEqual(demoGraphConfig(DEMO));
		for (const invalid of [null, [], false, 'bad', { colorGroups: {} }]) expect(() => augmentDemoGraph(invalid, DEMO)).toThrow();
		expect(augmentDemoGraph({}, DEMO).options).not.toHaveProperty('showTags');
	});

	it('writes the same bytes for the same frameworks, in any input order', () => {
		const a = demoGraphJson(DEMO);
		expect(demoGraphJson([...DEMO])).toBe(a);
		expect(demoGraphJson([...DEMO].reverse())).toBe(a);
		expect(a.endsWith('}\n')).toBe(true);
		expect(JSON.parse(a)).toEqual(demoGraphConfig(DEMO));
	});
});
