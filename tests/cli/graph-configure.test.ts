import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCli } from '../../cli/crosswalker';
import { configureFrameworkGraph, graphColorGroups, GRAPH_COLOR_OWNERSHIP_KEY } from '../../src/graph/graph-colors';
import { captureIo, tempDir, installByteFile } from './helpers';

installByteFile();
const roots: string[] = [];
const makeRoot = () => { const root = tempDir('graph-config'); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function setup(configDir = '.obsidian') {
	const root = makeRoot();
	fs.writeFileSync(path.join(root, 'Example.md'), '---\ncurie: synthetic-policy:A\n_crosswalker:\n  producer:\n    kind: cli\n---\nSynthetic note.\n');
	const dir = path.join(root, configDir);
	fs.mkdirSync(path.join(dir, 'plugins/crosswalker'), { recursive: true });
	const graph = { search: '', showTags: true, hideUnresolved: false, scale: 4, future: { kept: ['x'] }, colorGroups: [{ query: '[curie:"synthetic-policy:"]', color: { a: 0.4, rgb: 12 } }] };
	const data = { secret: 'synthetic-private-value', custom: { retained: true }, graphColorManagedQueries: ['[curie:"synthetic-policy:"]'] };
	const graphPath = path.join(dir, 'graph.json'), dataPath = path.join(dir, 'plugins/crosswalker/data.json');
	fs.writeFileSync(graphPath, JSON.stringify(graph));
	fs.writeFileSync(dataPath, JSON.stringify(data));
	return { root, dir, graph, data, graphPath, dataPath };
}
function snapshot(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const name = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(name);
			else if (entry.isFile()) out[path.relative(root, name)] = fs.readFileSync(name, 'utf8');
		}
	};
	walk(root); return out;
}
async function call(root: string, ...args: string[]) {
	const io = captureIo();
	const code = await runCli(['graph', 'configure', '--vault', root, ...args], io.io);
	return { code, ...io };
}

describe('cw graph configure', () => {
	it('defaults to colors, prints a structured redacted preview and writes nothing', async () => {
		const s = setup(), before = snapshot(s.root);
		const result = await call(s.root);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.out.join('\n'))).toMatchObject({ mode: 'colors', status: 'preview', applied: false, changes: [], searchPreserved: true, localGraphsChanged: false });
		expect(result.out.join('\n')).not.toContain(s.data.secret);
		expect(result.out.join('\n')).not.toContain('synthetic-policy');
		expect(snapshot(s.root)).toEqual(before);
	});
	it.each(['colors', 'overview'] as const)('apply mode %s equals the UI core, preserves unknown settings and is idempotent', async (mode) => {
		const s = setup();
		const noteBefore = fs.readFileSync(path.join(s.root, 'Example.md'), 'utf8');
		const expected = configureFrameworkGraph(s.graph, graphColorGroups([{ name: 'Synthetic policy', prefix: 'synthetic-policy' }]), undefined, mode);
		const result = await call(s.root, '--mode', mode, '--apply');
		expect(result.code).toBe(0);
		expect(JSON.parse(fs.readFileSync(s.graphPath, 'utf8'))).toEqual(expected.options);
		expect(JSON.parse(fs.readFileSync(s.dataPath, 'utf8'))).toEqual({ ...s.data, [GRAPH_COLOR_OWNERSHIP_KEY]: expected.ownership });
		expect(result.out.join('\n')).not.toContain(s.data.secret);
		expect(fs.readFileSync(path.join(s.root, 'Example.md'), 'utf8')).toBe(noteBefore);
		const first = snapshot(s.root);
		expect((await call(s.root, '--mode', mode, '--apply')).code).toBe(0);
		expect(snapshot(s.root)).toEqual(first);
	});
	it.each([
		['--mode', 'all'], ['--mode'], ['--apply', 'yes'], ['--unknown'], ['--config-dir'],
	])('rejects invalid or unsupported options without writes: %j', async (...args) => {
		const s = setup(), before = snapshot(s.root);
		expect((await call(s.root, ...args)).code).toBe(1);
		expect(snapshot(s.root)).toEqual(before);
	});
	it.each(['graph', 'data'] as const)('rejects malformed %s before writes or secret output', async (document) => {
		for (const text of ['{bad', '[]', 'null', '"synthetic-private-value"']) {
			const s = setup(); fs.writeFileSync(document === 'graph' ? s.graphPath : s.dataPath, text);
			const before = snapshot(s.root);
			const result = await call(s.root, '--apply');
			expect(result.code).toBe(1);
			expect(snapshot(s.root)).toEqual(before);
			expect([...result.err, ...result.out].join('\n')).not.toContain('synthetic-private-value');
		}
	});
	it('respects another config directory without creating the default', async () => {
		const s = setup('.custom');
		expect((await call(s.root, '--config-dir', '.custom', '--mode', 'overview', '--apply')).code).toBe(0);
		expect(fs.existsSync(path.join(s.root, '.obsidian'))).toBe(false);
		expect(JSON.parse(fs.readFileSync(s.graphPath, 'utf8'))).toMatchObject({ showTags: false, search: '', scale: 4, future: { kept: ['x'] } });
	});
	it('genuinely missing settings initialize only colors; missing vault is never created for a preview', async () => {
		const s = setup(); fs.rmSync(s.dir, { recursive: true });
		const preview = await call(s.root);
		expect(preview.code).toBe(0);
		expect(fs.existsSync(s.dir)).toBe(false);
		expect((await call(s.root, '--apply')).code).toBe(0);
		expect(Object.keys(JSON.parse(fs.readFileSync(s.graphPath, 'utf8')))).toEqual(['colorGroups']);
		const missing = path.join(makeRoot(), 'missing');
		expect((await call(missing)).code).toBe(1);
		expect(fs.existsSync(missing)).toBe(false);
	});
	it('rejects absolute, traversal and symlink-escape config paths without writes', async () => {
		const s = setup(), outside = makeRoot();
		for (const config of [outside, '../escape', '.obsidian/../../escape']) {
			const before = snapshot(s.root);
			expect((await call(s.root, '--config-dir', config, '--apply')).code).toBe(1);
			expect(snapshot(s.root)).toEqual(before);
		}
		fs.symlinkSync(outside, path.join(s.root, '.escape'));
		expect((await call(s.root, '--config-dir', '.escape', '--apply')).code).toBe(1);
		expect(fs.readdirSync(outside)).toEqual([]);
		fs.symlinkSync(path.join(outside, 'missing'), path.join(s.root, '.dangling'));
		expect((await call(s.root, '--config-dir', '.dangling', '--apply')).code).toBe(1);
	});
	it('rejects a symlink escape in the graph or plugin data file too', async () => {
		for (const document of ['graph', 'data']) {
			const s = setup(), outside = makeRoot();
			const target = path.join(outside, 'settings.json'); fs.writeFileSync(target, '{}');
			const file = document === 'graph' ? s.graphPath : s.dataPath;
			fs.unlinkSync(file); fs.symlinkSync(target, file);
			expect((await call(s.root, '--apply')).code).toBe(1);
			expect(fs.readFileSync(target, 'utf8')).toBe('{}');
		}
	});
});
