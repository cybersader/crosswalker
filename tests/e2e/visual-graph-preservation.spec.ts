/** Synthetic-only native saved-default, preview/cancel/apply and both-theme proof. */
import { browser, $ } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LINK_GROUPS, graphColorGroups, toColorGroupOption, configureFrameworkGraph } from '../../src/graph/graph-colors';

const OUT = path.resolve('test-screenshots');
const custom = { ...toColorGroupOption(LINK_GROUPS[0]), color: { a: 0.45, rgb: 0x437761 }, future: 'synthetic-custom' };
const settings = {
	search: '', showTags: true, showAttachments: true, showArrow: true, hideUnresolved: false, showOrphans: true,
	lineSizeMultiplier: 0.8, centerStrength: 0.2, repelStrength: 8, linkDistance: 120, scale: 0.7,
	'collapse-filter': true, futureGraphSetting: { keep: true }, colorGroups: [custom, custom],
};
async function graph() {
	return browser.executeObsidian(async ({ app }) => JSON.parse(await app.vault.adapter.read(`${app.vault.configDir}/graph.json`)) as typeof settings);
}
async function files() {
	return browser.executeObsidian(async ({ app }) => {
		const out: Record<string, string> = {};
		for (const file of app.vault.getFiles()) out[file.path] = await app.vault.read(file);
		return out;
	});
}
async function command(id: string) {
	await browser.executeObsidian(({ app }, name) => {
		// @ts-expect-error internal command API
		app.commands.executeCommandById(`crosswalker:${name}`);
	}, id);
}
async function openPreview() {
	await command('configure-framework-graph');
	await $('.crosswalker-graph-config').waitForDisplayed({ timeout: 15000 });
	await browser.waitUntil(async () => (await $('.crosswalker-graph-config').getText()).includes('Tag nodes'), { timeout: 15000 });
}
async function savedBytes() {
	return browser.executeObsidian(async ({ app }) => ({
		graph: await app.vault.adapter.read(`${app.vault.configDir}/graph.json`),
		data: await app.vault.adapter.read(`${app.vault.configDir}/plugins/crosswalker/data.json`),
	}));
}

describe('Native graph preservation and explicit overview', function () {
	this.timeout(180000);
	before(async () => {
		mkdirSync(OUT, { recursive: true });
		const vault = mkdtempSync(path.join(os.tmpdir(), 'cw-graph-preservation-'));
		mkdirSync(path.join(vault, '.obsidian/plugins/crosswalker'), { recursive: true });
		writeFileSync(path.join(vault, '.obsidian/graph.json'), JSON.stringify(settings));
		writeFileSync(path.join(vault, '.obsidian/core-plugins.json'), JSON.stringify(['graph']));
		writeFileSync(path.join(vault, '.obsidian/plugins/crosswalker/data.json'), JSON.stringify({ enableTier2Projection: false, syntheticUnknownSetting: { keep: true } }));
		for (const [id, label, link] of [['A', 'Access policy', 'B'], ['B', 'Backup policy', 'A']]) {
			writeFileSync(path.join(vault, `${id}.md`), `---\ncurie: synthetic-policy:${id}\nkind: concept\ntitle: ${label}\ntags: [synthetic-policy]\n_crosswalker:\n  producer:\n    kind: cli\n---\n# ${label}\n\n[[${link}]]\n`);
		}
		await browser.reloadObsidian({ vault });
		await browser.waitUntil(async () => browser.executeObsidian(({ app }) => ['A.md', 'B.md'].every((name) => app.vault.getMarkdownFiles().some((f) => f.path === name)) && app.vault.getMarkdownFiles().every((f) => app.metadataCache.getFileCache(f) !== null)), { timeout: 60000 });
	});

	it('preserves colors and native choices; cancel is no-write; applies exact overview and survives reopen', async () => {
		const beforeFiles = await files();
		await command('color-graph-by-framework');
		await browser.waitUntil(async () => (await graph()).colorGroups.length > 2, { timeout: 15000 });
		const colored = await graph();
		expect(colored).toEqual({ ...settings, colorGroups: [custom, custom, ...graphColorGroups([{ name: 'Synthetic policy', prefix: 'synthetic-policy' }]).slice(1).map(toColorGroupOption)] });
		const first = await savedBytes();
		await command('color-graph-by-framework');
		await browser.pause(700);
		expect(await savedBytes()).toEqual(first);
		await browser.waitUntil(async () => browser.execute(() => document.querySelectorAll('.notice').length === 0), { timeout: 20000 });

		for (const theme of ['light', 'dark'] as const) {
			await browser.executeObsidian(({ app }, requested) => {
				(app as unknown as { changeTheme(t: string): void }).changeTheme(requested === 'dark' ? 'obsidian' : 'moonstone');
			}, theme);
			await openPreview();
			const text = await $('.crosswalker-graph-config').getText();
			expect(text).toContain('These changes update its saved defaults, not your notes');
			expect(text).toContain('Tags stay in your notes');
			expect(text).toContain('not what a mapping means');
			expect(text).toContain('Update 2 automatic color rules. Keep 2 existing color rules in their current order.');
			expect(text).toContain('Line thickness: 0.8 → 1.3');
			await browser.saveScreenshot(path.join(OUT, `graph-overview-preview-${theme}.png`));
			await $('.crosswalker-graph-config').$('button=Cancel').click();
			await $('.crosswalker-graph-config').waitForExist({ reverse: true });
			expect(await savedBytes()).toEqual(first);
		}

		// A changed saved file invalidates an explicit preview rather than applying stale state.
		await openPreview();
		const changed = await browser.executeObsidian(async ({ app }) => {
			const p = `${app.vault.configDir}/graph.json`;
			const options = JSON.parse(await app.vault.adapter.read(p));
			options.search = 'synthetic chosen change';
			const text = JSON.stringify(options);
			await app.vault.adapter.write(p, text);
			return text;
		});
		await $('.crosswalker-graph-config').$('button=Apply overview and colors').click();
		await browser.waitUntil(async () => (await $('.crosswalker-graph-config').getText()).includes('changed after the preview'), { timeout: 10000 });
		expect((await savedBytes()).graph).toBe(changed);
		expect((await savedBytes()).data).toBe(first.data);
		await $('.crosswalker-graph-config').$('button=Cancel').click();
		// Simulate a user-customized generated evidence color before native Graph opens.
		// Native opacity normalization must not make Crosswalker overwrite that custom RGB.
		const ownershipBefore = JSON.parse(first.data).graphColorOwnership;
		await browser.executeObsidian(async ({ app }) => {
			const p = `${app.vault.configDir}/graph.json`;
			const options = JSON.parse(await app.vault.adapter.read(p));
			options.search = '';
			options.colorGroups[2].color = { a: 0.35, rgb: 0x995522 };
			options.colorGroups[2].future = 'synthetic-user-edit';
			await app.vault.adapter.write(p, JSON.stringify(options));
			const native = (app as unknown as { internalPlugins: { getPluginById(id: string): { instance: { options: Record<string, unknown> } } } }).internalPlugins.getPluginById('graph');
			Object.assign(native.instance.options, options);
		});
		const beforeNativeOpen = await graph();
		writeFileSync(path.join(OUT, 'graph-preservation-state.json'), JSON.stringify({ beforeNativeOpen, ownershipBefore }, null, 2));
		expect(beforeNativeOpen.colorGroups[2].color).toEqual({ a: 0.35, rgb: 0x995522 });
		// Native views can overwrite global defaults. Applying is blocked, never closes them.
		await browser.executeObsidian(async ({ app }) => {
			await app.workspace.getLeaf('tab').setViewState({ type: 'graph' });
			await app.workspace.getLeaf('tab').setViewState({ type: 'graph' });
			app.workspace.getLeavesOfType('graph').forEach((leaf, i) => {
				const engine = (leaf.view as unknown as { dataEngine: { getOptions(): Record<string, unknown>; setOptions(options: Record<string, unknown>): void } }).dataEngine;
				engine.setOptions({ ...engine.getOptions(), search: i === 0 ? 'tag:#synthetic-policy' : '', repelStrength: i === 0 ? 11 : 17 });
			});
		});
		await browser.pause(2000); // Native Graph saves/normalizes on open and option changes.
		const viewsBefore = await browser.executeObsidian(({ app }) => app.workspace.getLeavesOfType('graph').map((leaf) => (leaf.view as unknown as { dataEngine: { getOptions(): Record<string, unknown> } }).dataEngine.getOptions()));
		expect(viewsBefore.map((v) => v.repelStrength)).toEqual([11, 17]);
		expect(viewsBefore.map((v) => v.search)).toEqual(['tag:#synthetic-policy', '']);
		const openBefore = await savedBytes();
		await command('color-graph-by-framework');
		await browser.pause(500);
		expect(await savedBytes()).toEqual(openBefore);
		expect(await browser.executeObsidian(({ app }) => app.workspace.getLeavesOfType('graph').map((leaf) => (leaf.view as unknown as { dataEngine: { getOptions(): Record<string, unknown> } }).dataEngine.getOptions()))).toEqual(viewsBefore);
		await openPreview();
		expect(await $('.crosswalker-graph-config').$('button=Apply overview and colors').isEnabled()).toBe(false);
		expect(await $('.crosswalker-graph-config').getText()).toContain('Close all global graph views');
		await $('.crosswalker-graph-config').$('button=Cancel').click();
		await browser.executeObsidian(({ app }) => app.workspace.getLeavesOfType('graph').forEach((leaf) => leaf.detach()));
		await browser.pause(1000);

		// Local graphs can remain open: they do not own the saved global defaults.
		await browser.executeObsidian(async ({ app }) => { await app.workspace.getLeaf('tab').setViewState({ type: 'localgraph', state: { file: 'A.md' } }); });
		const localBefore = await browser.executeObsidian(({ app }) => app.workspace.getLeavesOfType('localgraph').map((leaf) => leaf.getViewState()));
		expect(localBefore).toHaveLength(1);
		// Native views may have saved their private defaults on close. Preview the actual saved values.
		const beforeApply = await graph();
		writeFileSync(path.join(OUT, 'graph-preservation-state.json'), JSON.stringify({ beforeNativeOpen, afterNativeClose: beforeApply, ownershipBefore }, null, 2));
		await openPreview();
		expect(await $('.crosswalker-graph-config').getText()).toContain('Update 1 automatic color rule. Keep 3 existing color rules in their current order.');
		await $('.crosswalker-graph-config').$('button=Apply overview and colors').click();
		await $('.crosswalker-graph-config').waitForExist({ reverse: true });
		const applied = await graph();
		expect(applied).toEqual({ ...beforeApply, showTags: false, showAttachments: false, showArrow: false, lineSizeMultiplier: 1.3 });
		// Native Graph normalizes opacity/unknown group fields when a view saves.
		// The operation preserves the actual saved snapshot at its decision point.
		expect(applied.colorGroups.slice(0, 2)).toEqual(beforeApply.colorGroups.slice(0, 2));
		expect(applied.colorGroups.slice(0, 2).map((g) => g.color.rgb)).toEqual([custom.color.rgb, custom.color.rgb]);
		expect(applied.colorGroups[2].color.rgb).toBe(0x995522);
		const ownershipAfter = JSON.parse((await savedBytes()).data).graphColorOwnership;
		expect(ownershipAfter.entries.some((e: { group: { query: string } }) => e.group.query === LINK_GROUPS[1].query)).toBe(false);
		expect(applied.colorGroups.filter((g) => g.query === LINK_GROUPS[1].query)).toHaveLength(1);
		writeFileSync(path.join(OUT, 'graph-preservation-state.json'), JSON.stringify({ beforeNativeOpen, afterNativeClose: beforeApply, afterApply: applied, ownershipBefore, ownershipAfter }, null, 2));
		expect(await browser.executeObsidian(({ app }) => app.workspace.getLeavesOfType('localgraph').map((leaf) => leaf.getViewState()))).toEqual(localBefore);
		expect(await files()).toEqual(beforeFiles);
		await browser.executeObsidian(async ({ app }) => { await app.workspace.getLeaf('tab').setViewState({ type: 'graph' }); });
		await $('.workspace-leaf-content[data-type="graph"]').waitForDisplayed({ timeout: 15000 });
		await browser.pause(1500);
		const native = await browser.executeObsidian(({ app }) => {
			const leaf = app.workspace.getLeavesOfType('graph')[0];
			return (leaf.view as unknown as { dataEngine: { getOptions(): Record<string, unknown> } }).dataEngine.getOptions();
		});
		expect(native).toMatchObject({ showTags: false, showAttachments: false, showArrow: false, lineSizeMultiplier: 1.3 });
		expect(native).toMatchObject({ search: applied.search, repelStrength: applied.repelStrength, linkDistance: applied.linkDistance });
		await browser.waitUntil(async () => browser.execute(() => document.querySelectorAll('.notice').length === 0), { timeout: 20000 });
		for (const theme of ['light', 'dark'] as const) {
			await browser.executeObsidian(({ app }, requested) => { (app as unknown as { changeTheme(t: string): void }).changeTheme(requested === 'dark' ? 'obsidian' : 'moonstone'); }, theme);
			await browser.pause(700);
			await browser.saveScreenshot(path.join(OUT, `graph-overview-applied-${theme}.png`));
		}
		await browser.executeObsidian(({ app }) => app.workspace.getLeavesOfType('graph').forEach((leaf) => leaf.detach()));
		await browser.pause(1000);
		expect(await graph()).toEqual(applied);
		expect(await files()).toEqual(beforeFiles);
	});

	it('uses saved global defaults rather than stale native cache after an external edit', async () => {
		const localBefore = await browser.executeObsidian(({ app }) => app.workspace.getLeavesOfType('localgraph').map((leaf) => leaf.getViewState()));
		const notesBefore = await files();
		const before = await browser.executeObsidian(async ({ app }) => {
			if (app.workspace.getLeavesOfType('graph').length) throw new Error('Regression requires closed global views.');
			const p = `${app.vault.configDir}/graph.json`;
			const disk = JSON.parse(await app.vault.adapter.read(p));
			disk.search = 'tag:#synthetic-policy';
			disk.repelStrength = 11;
			disk.linkDistance = 90;
			delete disk.centerStrength;
			disk.futureGraphSetting = { keep: 'synthetic-disk-authority' };
			disk.colorGroups[0].color.a = 0.47;
			disk.colorGroups[0].future = 'synthetic-disk-custom';
			await app.vault.adapter.write(p, JSON.stringify(disk));
			const native = (app as unknown as { internalPlugins: { getPluginById(id: string): { instance: { options: Record<string, unknown> } } } }).internalPlugins.getPluginById('graph');
			// Deliberately stale cache. Do not synchronize it after the external edit.
			Object.assign(native.instance.options, { search: 'tag:#synthetic-missing', repelStrength: 3, linkDistance: 180, centerStrength: 0.01, staleCacheOnly: true });
			const data = JSON.parse(await app.vault.adapter.read(`${app.vault.configDir}/plugins/crosswalker/data.json`));
			return { disk, cache: JSON.parse(JSON.stringify(native.instance.options)), ownership: data.graphColorOwnership };
		});
		await command('color-graph-by-framework');
		await browser.waitUntil(async () => browser.executeObsidian(async ({ app }) => (await app.vault.adapter.read(`${app.vault.configDir}/graph.json`)).includes('\n')), { timeout: 15000 });
		const afterAction = await browser.executeObsidian(async ({ app }) => {
			const native = (app as unknown as { internalPlugins: { getPluginById(id: string): { instance: { options: Record<string, unknown> } } } }).internalPlugins.getPluginById('graph');
			return { disk: JSON.parse(await app.vault.adapter.read(`${app.vault.configDir}/graph.json`)), cache: JSON.parse(JSON.stringify(native.instance.options)) };
		});
		await browser.executeObsidian(async ({ app }) => { await app.workspace.getLeaf('tab').setViewState({ type: 'graph' }); });
		await browser.pause(1500);
		const reopened = await browser.executeObsidian(({ app }) => (app.workspace.getLeavesOfType('graph')[0].view as unknown as { dataEngine: { getOptions(): Record<string, unknown> } }).dataEngine.getOptions());
		await browser.executeObsidian(({ app }) => app.workspace.getLeavesOfType('graph').forEach((leaf) => leaf.detach()));
		await browser.pause(1000);
		const afterReopenSave = await graph();
		const evidence = { before, afterAction, reopened, afterReopenSave };
		writeFileSync(path.join(OUT, 'graph-cache-authority-regression.json'), JSON.stringify(evidence, null, 2));
		const expected = configureFrameworkGraph(before.disk, graphColorGroups([{ name: 'Synthetic policy', prefix: 'synthetic-policy' }]), before.ownership, 'colors');
		expect(afterAction.disk).toEqual(expected.options); // strict opacity and unknown-field preservation at our write boundary
		expect(reopened).toMatchObject({ search: before.disk.search, repelStrength: 11, linkDistance: 90 });
		expect(afterReopenSave).toMatchObject({ search: before.disk.search, repelStrength: 11, linkDistance: 90 });
		expect(afterAction.cache).toEqual(afterAction.disk);
		expect(afterAction.cache).not.toHaveProperty('centerStrength');
		expect(afterAction.cache).not.toHaveProperty('staleCacheOnly');
		expect(await browser.executeObsidian(({ app }) => app.workspace.getLeavesOfType('localgraph').map((leaf) => leaf.getViewState()))).toEqual(localBefore);
		expect(await files()).toEqual(notesBefore);
	});
});
