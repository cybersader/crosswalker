/**
 * visual-demo-graph.spec.ts: the demo vault's global graph, light and dark.
 *
 * Builds the public demo vault with `bun run demo:build` (or opens the one named
 * by CW_DEMO_VAULT, already built), opens it in real Obsidian, opens the global
 * graph with the settings the builder wrote to `.obsidian/graph.json`, and
 * screenshots it in both themes. The point is to look: each framework a tree in
 * its own color, mapping notes bridging the trees, evidence in its own color.
 *
 *   bun run e2e:xvfb -- --spec tests/e2e/visual-demo-graph.spec.ts
 *
 * Screenshots: test-screenshots/demo-graph-<theme>.png, or
 * demo-graph-<CW_DEMO_SHOT>-<theme>.png when CW_DEMO_SHOT names the run.
 * test-screenshots/ is gitignored.
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = path.resolve('test-screenshots');
const SHOT = process.env.CW_DEMO_SHOT ? `demo-graph-${process.env.CW_DEMO_SHOT}` : 'demo-graph';

type Theme = 'light' | 'dark';

function buildDemo(): string {
	if (process.env.CW_DEMO_VAULT) return path.resolve(process.env.CW_DEMO_VAULT);
	const vault = path.join(mkdtempSync(path.join(os.tmpdir(), 'cw-demo-graph-e2e-')), 'vault');
	const result = spawnSync('bun', ['scripts/demo-build.mjs', '--out', vault], { encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`demo:build failed (exit ${result.status}): ${result.stderr}`);
	return vault;
}

async function setTheme(theme: Theme): Promise<void> {
	await browser.executeObsidian(({ app }, requested) => {
		const a = app as unknown as { changeTheme?: (t: string) => void };
		// Obsidian's own switch, so the graph re-reads its colors from the theme.
		if (a.changeTheme) a.changeTheme(requested === 'dark' ? 'obsidian' : 'moonstone');
		document.body.classList.toggle('theme-dark', requested === 'dark');
		document.body.classList.toggle('theme-light', requested === 'light');
		app.workspace.trigger('css-change');
	}, theme);
	await browser.pause(800);
}

describe('Visual: demo vault global graph', function () {
	this.timeout(600_000);
	let vault = '';

	before(async () => {
		mkdirSync(OUT, { recursive: true });
		mkdirSync(path.resolve('test-results'), { recursive: true });
		vault = buildDemo();
		await browser.reloadObsidian({ vault });
		await browser.waitUntil(
			async () => browser.executeObsidian(({ app }) => (app.workspace as unknown as { layoutReady: boolean }).layoutReady === true),
			{ timeout: 60_000, interval: 500, timeoutMsg: 'workspace.layoutReady never became true' },
		);
		// Wait for the metadata cache to index the vault: colors select by tag and property.
		await browser.waitUntil(
			async () => browser.executeObsidian(({ app }) => {
				const files = app.vault.getMarkdownFiles();
				return files.length > 0 && files.every((f) => app.metadataCache.getFileCache(f) !== null);
			}),
			{ timeout: 180_000, interval: 1000, timeoutMsg: 'metadata cache never finished indexing the demo vault' },
		);
	});

	it('ships the graph settings the builder wrote', () => {
		const graph = JSON.parse(readFileSync(path.join(vault, '.obsidian/graph.json'), 'utf8'));
		expect(graph).toMatchObject({ showTags: true, showArrow: true, hideUnresolved: true, showOrphans: false, showAttachments: false });
		expect(graph.colorGroups.length).toBeGreaterThanOrEqual(5);
	});

	it('screenshots the global graph in light and dark', async () => {
		const enabled = await browser.executeObsidian(async ({ app }) => {
			const internal = (app as unknown as { internalPlugins: { getPluginById(id: string): { enabled: boolean; enable(save: boolean): Promise<void> } | null } }).internalPlugins;
			const graph = internal.getPluginById('graph');
			if (graph && !graph.enabled) await graph.enable(false);
			// @ts-expect-error commands API is untyped
			app.commands.executeCommandById('graph:open');
			return graph?.enabled ?? null;
		});
		console.log(`[demo-graph] graph core plugin enabled: ${enabled}`);
		await $('.workspace-leaf-content[data-type="graph"]').waitForDisplayed({ timeout: 30_000 });
		// Collapse the side docks so the graph has the whole window.
		await browser.executeObsidian(({ app }) => {
			const ws = app.workspace as unknown as { leftSplit?: { collapse(): void }; rightSplit?: { collapse(): void } };
			ws.leftSplit?.collapse();
			ws.rightSplit?.collapse();
		});
		// Let the force layout settle.
		await browser.pause(30_000);
		// Zoom to fit every node so the screenshot shows the whole graph.
		const fit = await browser.executeObsidian(({ app }) => {
			type Node = { x: number; y: number };
			type Renderer = { nodes: Node[]; width: number; height: number; setScale(s: number): void; setPan(x: number, y: number): void; targetScale: number; scale: number; changed(): void };
			const leaf = app.workspace.getLeavesOfType('graph')[0];
			const r = (leaf?.view as unknown as { renderer?: Renderer })?.renderer;
			if (!r || r.nodes.length === 0) return 'no nodes';
			const xs = r.nodes.map((n) => n.x).sort((p, q) => p - q);
			const ys = r.nodes.map((n) => n.y).sort((p, q) => p - q);
			// Trim the outermost 1% so a few flung-out nodes do not shrink the picture.
			const lo = Math.floor(xs.length * 0.01);
			const hi = xs.length - 1 - lo;
			const [x0, x1, y0, y1] = [xs[lo], xs[hi], ys[lo], ys[hi]];
			const scale = 0.92 * Math.min(r.width / (x1 - x0 || 1), r.height / (y1 - y0 || 1));
			r.targetScale = scale;
			r.setScale(scale);
			r.setPan(r.width / 2 - ((x0 + x1) / 2) * scale, r.height / 2 - ((y0 + y1) / 2) * scale);
			r.changed();
			return `nodes=${r.nodes.length} box=${Math.round(x1 - x0)}x${Math.round(y1 - y0)} scale=${scale.toFixed(4)}`;
		});
		console.log(`[demo-graph] fit ${fit}`);
		for (const theme of ['light', 'dark'] as const) {
			await setTheme(theme);
			await browser.pause(3_000);
			await browser.saveScreenshot(path.join(OUT, `${SHOT}-${theme}.png`));
		}
		const groups = await browser.executeObsidian(({ app }) => {
			const leaf = app.workspace.getLeavesOfType('graph')[0];
			const view = leaf?.view as unknown as { dataEngine?: { colorGroupOptions?: { groups?: unknown[] } } };
			return view?.dataEngine?.colorGroupOptions?.groups?.length ?? -1;
		});
		console.log(`[demo-graph] color groups loaded by the graph view: ${groups}`);
	});
});
