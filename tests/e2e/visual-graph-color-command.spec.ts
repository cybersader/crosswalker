/**
 * visual-graph-color-command.spec.ts: "Color the graph by framework" in a vault
 * that has frameworks but no graph settings yet, light and dark.
 *
 * Builds the demo vault, deletes its `.obsidian/graph.json` so the graph starts
 * uncolored, opens it in real Obsidian, and checks the status bar counts the
 * frameworks (the demo writes them under `Frameworks/`, outside the output
 * folder setting, which is the layout the status bar used to miss). Then it
 * runs the command, opens the global graph and screenshots both themes.
 *
 *   bun run e2e:xvfb -- --spec tests/e2e/visual-graph-color-command.spec.ts
 *
 * Screenshots: test-screenshots/graph-color-command-<theme>.png (gitignored).
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = path.resolve('test-screenshots');

type Theme = 'light' | 'dark';

function buildDemoWithoutGraphSettings(): string {
	const vault = path.join(mkdtempSync(path.join(os.tmpdir(), 'cw-graph-color-e2e-')), 'vault');
	const result = spawnSync('bun', ['scripts/demo-build.mjs', '--out', vault], { encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`demo:build failed (exit ${result.status}): ${result.stderr}`);
	rmSync(path.join(vault, '.obsidian', 'graph.json'), { force: true });
	return vault;
}

async function setTheme(theme: Theme): Promise<void> {
	await browser.executeObsidian(({ app }, requested) => {
		const a = app as unknown as { changeTheme?: (t: string) => void };
		if (a.changeTheme) a.changeTheme(requested === 'dark' ? 'obsidian' : 'moonstone');
		document.body.classList.toggle('theme-dark', requested === 'dark');
		document.body.classList.toggle('theme-light', requested === 'light');
		app.workspace.trigger('css-change');
	}, theme);
	await browser.pause(800);
}

describe('Visual: color the graph by framework', function () {
	this.timeout(600_000);

	before(async () => {
		mkdirSync(OUT, { recursive: true });
		const vault = buildDemoWithoutGraphSettings();
		await browser.reloadObsidian({ vault });
		await browser.waitUntil(
			async () => browser.executeObsidian(({ app }) => (app.workspace as unknown as { layoutReady: boolean }).layoutReady === true),
			{ timeout: 60_000, interval: 500, timeoutMsg: 'workspace.layoutReady never became true' },
		);
		await browser.waitUntil(
			async () => browser.executeObsidian(({ app }) => {
				const files = app.vault.getMarkdownFiles();
				return files.length > 0 && files.every((f) => app.metadataCache.getFileCache(f) !== null);
			}),
			{ timeout: 180_000, interval: 1000, timeoutMsg: 'metadata cache never finished indexing the demo vault' },
		);
	});

	it('starts without graph settings', async () => {
		const exists = await browser.executeObsidian(async ({ app }) => app.vault.adapter.exists(`${app.vault.configDir}/graph.json`));
		expect(exists).toBe(false);
	});

	it('counts the frameworks in the status bar, not "no frameworks yet"', async () => {
		let label = '';
		await browser.waitUntil(
			async () => {
				label = await browser.execute(() => document.querySelector('.crosswalker-status-bar-item')?.textContent?.trim() ?? '');
				return /^Crosswalker: \d+ frameworks?$/.test(label);
			},
			{ timeout: 30_000, interval: 500, timeoutMsg: 'status bar never showed a framework count' },
		);
		console.log(`[graph-color] status bar: ${label}`);
		expect(label).not.toContain('no frameworks');
	});

	it('colors the graph, keeps settings merged, and screenshots light and dark', async () => {
		// Turn the core graph plugin on in this throwaway e2e vault only.
		await browser.executeObsidian(async ({ app }) => {
			const internal = (app as unknown as { internalPlugins: { getPluginById(id: string): { enabled: boolean; enable(save: boolean): Promise<void> } | null } }).internalPlugins;
			const graph = internal.getPluginById('graph');
			if (graph && !graph.enabled) await graph.enable(false);
		});
		await browser.executeObsidian(({ app }) => {
			// @ts-expect-error commands API is untyped
			app.commands.executeCommandById('crosswalker:color-graph-by-framework');
		});
		await browser.waitUntil(
			async () => browser.executeObsidian(async ({ app }) => app.vault.adapter.exists(`${app.vault.configDir}/graph.json`)),
			{ timeout: 30_000, interval: 500, timeoutMsg: 'graph.json was never written by the command' },
		);
		const written = await browser.executeObsidian(async ({ app }) =>
			JSON.parse(await app.vault.adapter.read(`${app.vault.configDir}/graph.json`)) as Record<string, unknown>);
		expect(written).toMatchObject({ showTags: true, hideUnresolved: true });
		const groups = written.colorGroups as { query: string }[];
		console.log(`[graph-color] color groups written: ${groups.length}`);
		expect(groups.length).toBeGreaterThanOrEqual(3);
		expect(groups.some((g) => g.query.includes('crosswalk'))).toBe(true);
		const notice = await browser.execute(() => Array.from(document.querySelectorAll('.notice')).map((n) => n.textContent ?? '').join(' | '));
		console.log(`[graph-color] notice: ${notice}`);
		expect(notice).toContain('Graph colored');

		await browser.executeObsidian(({ app }) => {
			// @ts-expect-error commands API is untyped
			app.commands.executeCommandById('graph:open');
		});
		await $('.workspace-leaf-content[data-type="graph"]').waitForDisplayed({ timeout: 30_000 });
		await browser.executeObsidian(({ app }) => {
			const ws = app.workspace as unknown as { leftSplit?: { collapse(): void }; rightSplit?: { collapse(): void } };
			ws.leftSplit?.collapse();
			ws.rightSplit?.collapse();
		});
		await browser.pause(30_000);
		const fit = await browser.executeObsidian(({ app }) => {
			type Node = { x: number; y: number };
			type Renderer = { nodes: Node[]; width: number; height: number; setScale(s: number): void; setPan(x: number, y: number): void; targetScale: number; changed(): void };
			const leaf = app.workspace.getLeavesOfType('graph')[0];
			const r = (leaf?.view as unknown as { renderer?: Renderer })?.renderer;
			if (!r || r.nodes.length === 0) return 'no nodes';
			const xs = r.nodes.map((n) => n.x).sort((p, q) => p - q);
			const ys = r.nodes.map((n) => n.y).sort((p, q) => p - q);
			const lo = Math.floor(xs.length * 0.01);
			const hi = xs.length - 1 - lo;
			const [x0, x1, y0, y1] = [xs[lo], xs[hi], ys[lo], ys[hi]];
			const scale = 0.92 * Math.min(r.width / (x1 - x0 || 1), r.height / (y1 - y0 || 1));
			r.targetScale = scale;
			r.setScale(scale);
			r.setPan(r.width / 2 - ((x0 + x1) / 2) * scale, r.height / 2 - ((y0 + y1) / 2) * scale);
			r.changed();
			return `nodes=${r.nodes.length}`;
		});
		console.log(`[graph-color] fit ${fit}`);
		const loaded = await browser.executeObsidian(({ app }) => {
			const leaf = app.workspace.getLeavesOfType('graph')[0];
			const view = leaf?.view as unknown as { dataEngine?: { colorGroupOptions?: { groups?: unknown[] } } };
			return view?.dataEngine?.colorGroupOptions?.groups?.length ?? -1;
		});
		console.log(`[graph-color] color groups loaded by the graph view: ${loaded}`);
		for (const theme of ['light', 'dark'] as const) {
			await setTheme(theme);
			await browser.pause(3_000);
			await browser.saveScreenshot(path.join(OUT, `graph-color-command-${theme}.png`));
		}
	});
});
