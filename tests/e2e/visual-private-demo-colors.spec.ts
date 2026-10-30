/** Synthetic graph only: no licensed workbook values in fixtures or screenshots. */
import { browser, $ } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { demoGraphJson } from '../../tools/lib/demo-graph';

const OUT = path.resolve('test-screenshots');

describe('Visual: private demo framework colors', function () {
	this.timeout(180_000);
	let root: string;
	before(async () => {
		root = mkdtempSync(path.join(os.tmpdir(), 'cw-private-colors-'));
		const vault = path.join(root, 'vault');
		mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
		mkdirSync(OUT, { recursive: true });
		writeFileSync(path.join(vault, '.obsidian/graph.json'), demoGraphJson(['cis', 'cri', 'csf', 'sp80053', 'attack', 'f3', 'scf', 'referenced']));
		const prefixes = ['cis-v8', 'cri-profile', 'nist-csf-2', 'nist-800-53', 'mitre-attack', 'mitre-f3', 'scf', 'invented-reference'];
		for (const [index, prefix] of prefixes.entries()) {
			for (const suffix of ['a', 'b']) {
				const next = suffix === 'a' ? `${index}-b` : `${(index + 1) % prefixes.length}-a`;
				writeFileSync(path.join(vault, `${index}-${suffix}.md`), `---\ncurie: ${prefix}:synthetic-${suffix}\n${prefix === 'invented-reference' ? '_crosswalker:\n  recipe:\n    id: cw-referenced-framework\n' : ''}---\n# Synthetic ${prefix} ${suffix}\n\n[[${next}]]\n`);
			}
		}
		await browser.reloadObsidian({ vault });
		await browser.waitUntil(async () => browser.executeObsidian(({ app }) => {
			const files = app.vault.getMarkdownFiles().filter((file) => /^[0-7]-[ab]\.md$/.test(file.path));
			return files.length === 16 && files.every((f) => app.metadataCache.getFileCache(f) !== null);
		}), { timeout: 60_000, interval: 500 });
	});
	after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

	it('loads SCF and identifier-only groups and screenshots both themes', async () => {
		await browser.executeObsidian(async ({ app }) => {
			const internal = (app as unknown as { internalPlugins: { getPluginById(id: string): { enabled: boolean; enable(save: boolean): Promise<void> } | null } }).internalPlugins;
			const graph = internal.getPluginById('graph');
			if (graph && !graph.enabled) await graph.enable(false);
			// @ts-expect-error internal commands API
			app.commands.executeCommandById('graph:open');
		});
		await $('.workspace-leaf-content[data-type="graph"]').waitForDisplayed({ timeout: 30_000 });
		const groups = await browser.executeObsidian(async ({ app }) => JSON.parse(await app.vault.adapter.read(`${app.vault.configDir}/graph.json`)).colorGroups as { query: string; color: { rgb: number } }[]);
		expect(groups.find((group) => group.query.includes('cis-v8:'))?.color.rgb).toBe(0x0f9d8f);
		expect(groups.find((group) => group.query.includes('scf:'))?.color.rgb).toBe(0xa66a25);
		expect(groups.find((group) => group.query === '"cw-referenced-framework"')?.color.rgb).toBe(0x7c8aa0);
		await browser.pause(8_000);
		for (const theme of ['light', 'dark']) {
			await browser.executeObsidian(({ app }, requested) => {
				(app as unknown as { changeTheme?: (t: string) => void }).changeTheme?.(requested === 'dark' ? 'obsidian' : 'moonstone');
				document.body.classList.toggle('theme-dark', requested === 'dark');
				document.body.classList.toggle('theme-light', requested === 'light');
				app.workspace.trigger('css-change');
				const ws = app.workspace as unknown as { leftSplit?: { collapse(): void }; rightSplit?: { collapse(): void } };
				ws.leftSplit?.collapse(); ws.rightSplit?.collapse();
			}, theme);
			await browser.pause(2_000);
			await browser.saveScreenshot(path.join(OUT, `private-demo-colors-${theme}.png`));
		}
	});
});
