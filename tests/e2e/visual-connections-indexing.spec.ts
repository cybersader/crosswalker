/**
 * Connections while Obsidian is still indexing: the window says so with a
 * count, then loads on its own once indexing finishes. Pending indexing is
 * simulated by hiding one synthetic note from the metadata cache, then
 * restoring it and emitting `resolved`. Synthetic data only.
 */
import { browser, $ } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fixture, assertion } from '../helpers/connections-fixture';

const OUT = path.resolve('test-screenshots');
const HIDDEN = 'Mappings/1.md';

describe('Connections while indexing', function () {
	this.timeout(180000);
	before(async () => {
		mkdirSync(OUT, { recursive: true });
		const root = fixture();
		for (let n = 0; n < 3; n++) assertion(root, `Mappings/${n}.md`, `edge:${n}`, { subject_note: '[[Renamed/Access]]', object_note: '[[Moved/Backups]]' });
		mkdirSync(path.join(root, '.obsidian/plugins/crosswalker'), { recursive: true });
		writeFileSync(path.join(root, '.obsidian/plugins/crosswalker/data.json'), '{"enableTier2Projection":false}');
		await browser.reloadObsidian({ vault: root });
		await browser.waitUntil(async () => browser.executeObsidian(({ app }) => app.vault.getMarkdownFiles().length >= 5 && app.vault.getMarkdownFiles().every((f) => app.metadataCache.getFileCache(f) !== null)), { timeout: 60000 });
	});

	it('shows the indexing state in both themes, then loads by itself when indexing finishes', async () => {
		// Hide one note from the cache, as Obsidian does before it reaches it.
		await browser.executeObsidian(({ app }, hidden) => {
			const cache = app.metadataCache as unknown as { getFileCache(f: { path: string }): unknown };
			const original = cache.getFileCache.bind(cache);
			cache.getFileCache = (f: { path: string }) => f.path === hidden ? null : original(f);
		}, HIDDEN);
		try {
			await browser.executeObsidian(({ app }) => {
				// @ts-expect-error internal command API
				app.commands.executeCommandById('crosswalker:explore-framework-connections');
			});
			await browser.waitUntil(async () => (await $('.crosswalker-connections-modal').getText()).includes('still indexing'), { timeout: 30000 });
			await browser.waitUntil(async () => (await $('.cw-connections-indexing-progress').getText()) === '1 note left to index.', { timeout: 10000 });
			for (const theme of ['light', 'dark'] as const) {
				await browser.executeObsidian(({ app }, t) => { (app as unknown as { changeTheme(t: string): void }).changeTheme(t === 'dark' ? 'obsidian' : 'moonstone'); }, theme);
				await browser.pause(300);
				await browser.saveScreenshot(path.join(OUT, `connections-indexing-${theme}.png`));
			}
		} finally {
			// Indexing finishes: restore the cache and announce it.
			await browser.executeObsidian(({ app }) => {
				delete (app.metadataCache as unknown as Record<string, unknown>).getFileCache;
				app.metadataCache.trigger('resolved');
			});
		}
		await $('[aria-label="Source set"]').waitForExist({ timeout: 20000 });
		expect(await $('.cw-connections-indexing').isExisting()).toBe(false);
		await browser.keys('Escape');
	});
});
