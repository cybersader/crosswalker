/**
 * The demo vault's graph view settings (tools/lib/demo-graph.ts): which color
 * groups are written, in which order, and that the bytes never vary.
 */
import { FRAMEWORK_GROUPS, GRAPH_SEARCH, LINK_GROUPS, demoGraphConfig, demoGraphGroups, demoGraphJson } from '../../tools/lib/demo-graph';

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

	it('shows tags and arrows, hides unresolved links, orphans, attachments and bookkeeping notes', () => {
		const config = demoGraphConfig(DEMO);
		expect(config).toMatchObject({
			showTags: true,
			showArrow: true,
			hideUnresolved: true,
			showOrphans: false,
			showAttachments: false,
			close: true,
			search: GRAPH_SEARCH,
		});
		expect(GRAPH_SEARCH).toBe('-path:"_crosswalker/import-sets" -path:"Queries" -file:"Start here"');
	});

	it('writes the same bytes for the same frameworks, in any input order', () => {
		const a = demoGraphJson(DEMO);
		expect(demoGraphJson([...DEMO])).toBe(a);
		expect(demoGraphJson([...DEMO].reverse())).toBe(a);
		expect(a.endsWith('}\n')).toBe(true);
		expect(JSON.parse(a)).toEqual(demoGraphConfig(DEMO));
	});
});
