/** UI adapter against synthetic notes and saved settings, never renderer internals. */
import { colorGraphByFramework, previewFrameworkGraph, applyFrameworkGraph, NO_FRAMEWORKS_MESSAGE } from '../src/graph/graph-color-command';
import { GRAPH_COLOR_OWNERSHIP_KEY, graphColorGroups, configureFrameworkGraph } from '../src/graph/graph-colors';

const stamp = (curie: string) => ({ curie, _crosswalker: { producer: { kind: 'cli' } } });
const notes: Record<string, Record<string, unknown> | null> = { 'A.md': stamp('nist-csf-2:GV'), 'B.md': stamp('mitre-attack:T1') };
const DATA = '.obsidian/plugins/crosswalker/data.json';
const GRAPH = '.obsidian/graph.json';
function setup(options: { graph?: unknown; graphRaw?: string; data?: unknown; dataRaw?: string; failGraph?: boolean; failData?: boolean; open?: boolean; notes?: typeof notes } = {}) {
	const files = new Map<string, string>();
	if (options.graph !== undefined) files.set(GRAPH, JSON.stringify(options.graph));
	if (options.graphRaw !== undefined) files.set(GRAPH, options.graphRaw);
	if (options.data !== undefined) files.set(DATA, JSON.stringify(options.data));
	if (options.dataRaw !== undefined) files.set(DATA, options.dataRaw);
	const content = options.notes ?? notes;
	const globalEngine = { setOptions: jest.fn() };
	const localEngine = { setOptions: jest.fn() };
	const globalOptions = { search: 'different view', repelStrength: 777 };
	const instanceOptions = { search: 'instance only', repelStrength: 9, centerStrength: 0.01, staleCacheOnly: true };
	const instance = { options: instanceOptions as Record<string, unknown>, saveOptions: jest.fn() };
	const app = {
		vault: {
			configDir: '.obsidian', getMarkdownFiles: () => Object.keys(content).map((path) => ({ path, name: path })),
			adapter: {
				exists: jest.fn(async (p: string) => files.has(p)),
				read: jest.fn(async (p: string) => files.get(p)!),
				write: jest.fn(async (p: string, text: string) => { if (p === GRAPH && options.failGraph) throw new Error('read-only'); files.set(p, text); }),
			},
		},
		metadataCache: { getFileCache: (f: { path: string }) => content[f.path] === null ? null : { frontmatter: content[f.path] } },
		workspace: { getLeavesOfType: jest.fn((type: string) => type === 'graph' ? (options.open ? [{ view: { options: globalOptions, dataEngine: globalEngine } }] : []) : [{ view: { dataEngine: localEngine } }]) },
		internalPlugins: { getPluginById: () => ({ instance }) },
	};
	const host = {
		settings: { ...(options.data && typeof options.data === 'object' ? options.data : {}) } as Record<string, unknown>,
		saveSettings: jest.fn(async () => { if (options.failData) throw new Error('write failed'); files.set(DATA, JSON.stringify(host.settings)); }),
	};
	return { app: app as never, rawApp: app, host, files, options, globalEngine, localEngine, globalOptions, instanceOptions, instance };
}

describe('graph commands and explicit preview', () => {
	it('reports no frameworks and indexing without writing', async () => {
		const empty = setup({ notes: { 'a.md': { title: 'x' } } });
		expect(await colorGraphByFramework(empty.app, empty.host)).toEqual({ status: 'no-frameworks', message: NO_FRAMEWORKS_MESSAGE });
		const indexing = setup({ notes: { ...notes, 'late.md': null } });
		expect((await colorGraphByFramework(indexing.app, indexing.host)).status).toBe('indexing');
		expect(empty.rawApp.vault.adapter.write).not.toHaveBeenCalled();
	});
	it('saves only colors and ownership, leaving display and both kinds of views untouched', async () => {
		const graph = { search: '', showTags: false, hideUnresolved: false, repelStrength: 4, future: { keep: true }, colorGroups: [{ query: 'tag:#mine', color: { a: 1, rgb: 11 } }] };
		const s = setup({ graph, data: { unknownSetting: { keep: true }, graphColorManagedQueries: ['tag:#mine'] } });
		const result = await colorGraphByFramework(s.app, s.host);
		expect(result.status).toBe('applied');
		expect(JSON.parse(s.files.get(GRAPH)!)).toMatchObject({ ...graph, colorGroups: expect.any(Array) });
		expect(JSON.parse(s.files.get(GRAPH)!).colorGroups[0]).toEqual(graph.colorGroups[0]);
		expect(JSON.parse(s.files.get(DATA)!)).toMatchObject({ unknownSetting: { keep: true }, graphColorManagedQueries: ['tag:#mine'], [GRAPH_COLOR_OWNERSHIP_KEY]: { version: 1 } });
		expect(s.instance.options).toEqual(JSON.parse(s.files.get(GRAPH)!));
		expect(s.instance.options).not.toHaveProperty('centerStrength');
		expect(s.instance.options).not.toHaveProperty('staleCacheOnly');
		expect(s.instance.saveOptions).not.toHaveBeenCalled();
		expect(s.globalEngine.setOptions).not.toHaveBeenCalled();
		expect(s.localEngine.setOptions).not.toHaveBeenCalled();
		expect(result.message).toContain('Reopen the global graph');
	});
	it('is idempotent with persisted exact snapshots', async () => {
		const s = setup();
		await colorGraphByFramework(s.app, s.host);
		const before = s.files.get(GRAPH);
		await colorGraphByFramework(s.app, s.host);
		expect(s.files.get(GRAPH)).toBe(before);
	});
	it('preview/cancel writes nothing and explicit overview equals the shared CLI policy', async () => {
		const graph = { search: '', showTags: true, hideUnresolved: false, scale: 3, future: 'keep' };
		const s = setup({ graph });
		const preview = await previewFrameworkGraph(s.app, 'overview');
		expect(preview.status).toBe('preview');
		expect(s.rawApp.vault.adapter.write).not.toHaveBeenCalled();
		expect(s.host.saveSettings).not.toHaveBeenCalled();
		if (preview.status !== 'preview') return;
		expect(preview.plan.preview.changes.map((c) => c.key)).toEqual(['showTags', 'showAttachments', 'showArrow', 'lineSizeMultiplier']);
		const applied = await applyFrameworkGraph(s.app, s.host, preview);
		expect(applied.status).toBe('applied');
		const expected = configureFrameworkGraph(graph, graphColorGroups([{ name: 'NIST CSF 2.0', prefix: 'nist-csf-2' }, { name: 'MITRE ATT&CK', prefix: 'mitre-attack' }]), undefined, 'overview');
		expect(JSON.parse(s.files.get(GRAPH)!)).toEqual(expected.options);
		expect(s.host.settings[GRAPH_COLOR_OWNERSHIP_KEY]).toEqual(expected.ownership);
	});
	it('requires closing global views before applying; never changes or closes them or local views', async () => {
		const s = setup({ open: true, graph: { search: 'global saved' } });
		const result = await colorGraphByFramework(s.app, s.host);
		expect(result.status).toBe('open-graphs');
		expect(result.message).toContain('Close all global graph views');
		expect(s.globalOptions).toEqual({ search: 'different view', repelStrength: 777 });
		expect(s.rawApp.vault.adapter.write).not.toHaveBeenCalled();
		expect(s.host.saveSettings).not.toHaveBeenCalled();
		expect(s.localEngine.setOptions).not.toHaveBeenCalled();
	});
	it.each([{ graphRaw: '{bad' }, { graph: [] }, { graph: null }, { dataRaw: '{bad' }, { data: [] }, { data: null }, { graph: { colorGroups: {} } }])('rejects unreadable settings before any write: %j', async (opts) => {
		const s = setup(opts);
		expect((await colorGraphByFramework(s.app, s.host)).status).toBe('unreadable-settings');
		expect(s.rawApp.vault.adapter.write).not.toHaveBeenCalled();
		expect(s.host.saveSettings).not.toHaveBeenCalled();
	});
	it('rejects a stale preview without writing', async () => {
		const s = setup();
		const preview = await previewFrameworkGraph(s.app);
		if (preview.status !== 'preview') throw new Error('expected preview');
		s.files.set(DATA, '{"changed":true}');
		expect((await applyFrameworkGraph(s.app, s.host, preview)).status).toBe('stale');
		expect(s.rawApp.vault.adapter.write).not.toHaveBeenCalled();
	});
	it('writes graph first and reports partial ownership failure without destructive rollback', async () => {
		const s = setup({ failData: true });
		const result = await colorGraphByFramework(s.app, s.host);
		expect(result.status).toBe('partial');
		expect(s.files.has(GRAPH)).toBe(true);
		expect(s.host.settings[GRAPH_COLOR_OWNERSHIP_KEY]).toBeUndefined();
		expect(s.files.has(DATA)).toBe(false);
		expect(s.instance.options).toEqual(JSON.parse(s.files.get(GRAPH)!));
		expect(result.message).toContain('color history could not be saved');
	});
	it('reports partial application instead of stale success when the native cache cannot reload', async () => {
		const s = setup({ graph: { search: 'saved choice', repelStrength: 4 } });
		Object.defineProperty(s.instance, 'options', { writable: false, value: s.instanceOptions });
		const result = await colorGraphByFramework(s.app, s.host);
		expect(result.status).toBe('partial');
		expect(result.message).toContain('Close and reopen Obsidian before opening Graph view');
		expect(JSON.parse(s.files.get(GRAPH)!)).toMatchObject({ search: 'saved choice', repelStrength: 4 });
		expect(s.host.settings[GRAPH_COLOR_OWNERSHIP_KEY]).toMatchObject({ version: 1 });
		expect(s.instance.options.search).toBe('instance only');
	});
	it('reports both partial failures without rolling back saved settings', async () => {
		const s = setup({ failData: true });
		Object.defineProperty(s.instance, 'options', { writable: false, value: s.instanceOptions });
		const result = await colorGraphByFramework(s.app, s.host);
		expect(result.status).toBe('partial');
		expect(result.message).toContain('Graph view could not reload');
		expect(result.message).toContain('Color history also could not be saved');
		expect(s.files.has(GRAPH)).toBe(true);
		expect(s.host.settings[GRAPH_COLOR_OWNERSHIP_KEY]).toBeUndefined();
	});
	it('does not replace the global cache if a graph opens during persistence', async () => {
		const s = setup();
		const originalSave = s.host.saveSettings.getMockImplementation()!;
		s.host.saveSettings.mockImplementation(async () => { await originalSave(); s.options.open = true; });
		const result = await colorGraphByFramework(s.app, s.host);
		expect(result.status).toBe('partial');
		expect(s.instance.options).toEqual(s.instanceOptions);
		expect(s.globalEngine.setOptions).not.toHaveBeenCalled();
		expect(s.localEngine.setOptions).not.toHaveBeenCalled();
	});
	it('reports graph write failures with an action and no marker write', async () => {
		const s = setup({ failGraph: true });
		const result = await colorGraphByFramework(s.app, s.host);
		expect(result.status).toBe('failed');
		expect(result.message).toContain('Check that the vault folder is writable');
		expect(result.message).not.toContain('—');
		expect(s.host.saveSettings).not.toHaveBeenCalled();
	});
});
