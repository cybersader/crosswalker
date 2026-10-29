/** The "Color the graph by framework" command against a mocked Obsidian app. */

import { colorGraphByFramework, GRAPH_COLOR_MARKER_KEY, NO_FRAMEWORKS_MESSAGE } from '../src/graph/graph-color-command';
import { PLUGIN_GRAPH_SEARCH } from '../src/graph/graph-colors';

type Fm = Record<string, unknown>;

function makeApp(opts: {
	notes: Record<string, Fm | null>;
	graph?: { enabled: boolean; options?: Record<string, unknown>; saveOptions?: jest.Mock } | null;
	graphJson?: string | null;
	leaves?: { view: { dataEngine?: { setOptions: jest.Mock } } }[];
	writeFails?: boolean;
}) {
	const files = Object.keys(opts.notes).map((path) => ({ path, name: path.slice(path.lastIndexOf('/') + 1) }));
	const fs = new Map<string, string>();
	if (opts.graphJson != null) fs.set('.obsidian/graph.json', opts.graphJson);
	const app = {
		vault: {
			configDir: '.obsidian',
			getMarkdownFiles: () => files,
			adapter: {
				exists: jest.fn(async (p: string) => fs.has(p)),
				read: jest.fn(async (p: string) => fs.get(p) ?? ''),
				write: jest.fn(async (p: string, data: string) => {
					if (opts.writeFails) throw new Error('read-only');
					fs.set(p, data);
				}),
			},
		},
		metadataCache: {
			getFileCache: (f: { path: string }) => {
				const fm = opts.notes[f.path];
				return fm === null ? null : { frontmatter: fm };
			},
		},
		workspace: { getLeavesOfType: jest.fn(() => opts.leaves ?? []) },
		internalPlugins: {
			getPluginById: (id: string) => (id === 'graph' && opts.graph
				? { enabled: opts.graph.enabled, instance: { options: opts.graph.options, saveOptions: opts.graph.saveOptions } }
				: null),
		},
	};
	return { app: app as never, fs };
}

function host(settings: Record<string, unknown> = {}) {
	return { settings, saveSettings: jest.fn(async () => {}) };
}

const stamp = (curie: string): Fm => ({ curie, _crosswalker: { producer: { kind: 'cli' } } });
const notes = {
	'Frameworks/CSF/GV.md': stamp('nist-csf-2:GV'),
	'Frameworks/ATTACK/T1.md': stamp('mitre-attack:T1'),
	'Frameworks/Other/X.md': stamp('acme-policy:X'),
};

describe('colorGraphByFramework', () => {
	it('tells the user to import a framework first when the vault has none', async () => {
		const { app } = makeApp({ notes: { 'a.md': { title: 'x' } } });
		const out = await colorGraphByFramework(app, host());
		expect(out).toEqual({ status: 'no-frameworks', message: NO_FRAMEWORKS_MESSAGE });
	});

	it('says the vault is still indexing instead of reporting no frameworks', async () => {
		const { app } = makeApp({ notes: { ...notes, 'Frameworks/late.md': null }, graph: null });
		const out = await colorGraphByFramework(app, host());
		expect(out.status).toBe('indexing');
	});

	it('applies live through the graph plugin, saves, refreshes open graphs and records its marker', async () => {
		const saveOptions = jest.fn(async () => {});
		const options: Record<string, unknown> = { search: '', colorGroups: [{ query: 'tag:#mine', color: { a: 1, rgb: 1 } }], repelStrength: 4 };
		const setOptions = jest.fn();
		const { app } = makeApp({ notes, graph: { enabled: true, options, saveOptions }, leaves: [{ view: { dataEngine: { setOptions } } }] });
		const h = host();
		const out = await colorGraphByFramework(app, h);

		expect(out.status).toBe('applied');
		if (out.status !== 'applied') return;
		expect(out.via).toBe('live');
		expect(out.frameworks).toBe(3);
		expect(out.message).toBe('Graph colored: 3 frameworks, mappings, evidence. Kept 1 of your own color group.');
		expect(saveOptions).toHaveBeenCalledTimes(1);
		expect(setOptions).toHaveBeenCalledWith(out.merge.options);
		expect(options.search).toBe(PLUGIN_GRAPH_SEARCH);
		expect(options.repelStrength).toBe(4);
		expect((options.colorGroups as unknown[]).length).toBe(1 + 2 + 3);
		expect(h.settings[GRAPH_COLOR_MARKER_KEY]).toEqual(out.merge.managedQueries);
		expect(h.saveSettings).toHaveBeenCalled();
	});

	it('running twice replaces its own groups instead of adding more', async () => {
		const options: Record<string, unknown> = {};
		const { app } = makeApp({ notes, graph: { enabled: true, options, saveOptions: jest.fn() } });
		const h = host();
		await colorGraphByFramework(app, h);
		const first = (options.colorGroups as unknown[]).length;
		await colorGraphByFramework(app, h);
		expect((options.colorGroups as unknown[]).length).toBe(first);
	});

	it('falls back to the settings file when the graph plugin cannot be reached', async () => {
		const { app, fs } = makeApp({ notes, graph: null, graphJson: JSON.stringify({ search: 'tag:#x', scale: 3 }) });
		const out = await colorGraphByFramework(app, host());
		expect(out.status).toBe('applied');
		if (out.status !== 'applied') return;
		expect(out.via).toBe('file');
		expect(out.message).toBe('Graph colors saved: 3 frameworks, mappings, evidence. Close and reopen the graph view to see them.');
		const written = JSON.parse(fs.get('.obsidian/graph.json') ?? '{}');
		expect(written).toMatchObject({ search: 'tag:#x', scale: 3, showTags: true, hideUnresolved: true });
	});

	it('falls back to the file when the live path throws', async () => {
		const saveOptions = jest.fn(async () => { throw new Error('boom'); });
		const { app, fs } = makeApp({ notes, graph: { enabled: true, options: {}, saveOptions } });
		const out = await colorGraphByFramework(app, host());
		expect(out.status === 'applied' && out.via).toBe('file');
		expect(fs.has('.obsidian/graph.json')).toBe(true);
	});

	it('tells the user to turn Graph view on when the core plugin is disabled', async () => {
		const { app } = makeApp({ notes, graph: { enabled: false, options: {}, saveOptions: jest.fn() } });
		const out = await colorGraphByFramework(app, host());
		expect(out.message).toContain('Turn on Graph view in Settings, Core plugins, then open the graph.');
	});

	it('leaves an unreadable settings file unchanged and says how to recover', async () => {
		const { app, fs } = makeApp({ notes, graph: null, graphJson: '{not json' });
		const out = await colorGraphByFramework(app, host());
		expect(out.status).toBe('unreadable-settings');
		expect(fs.get('.obsidian/graph.json')).toBe('{not json');
	});

	it('reports a save failure with an action', async () => {
		const { app } = makeApp({ notes, graph: null, writeFails: true });
		const out = await colorGraphByFramework(app, host());
		expect(out.status).toBe('failed');
		expect(out.message).toContain('Check that the vault folder is writable');
	});

	it('never uses an em dash in what it tells the user', async () => {
		const { app } = makeApp({ notes, graph: null });
		const out = await colorGraphByFramework(app, host());
		expect(out.message).not.toContain('—');
		expect(NO_FRAMEWORKS_MESSAGE).not.toContain('—');
	});
});
