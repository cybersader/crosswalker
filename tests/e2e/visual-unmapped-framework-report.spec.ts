import { browser } from '@wdio/globals';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Run on the hosted desktop harness; the vault is its disposable seed copy.
describe('Built-in unmapped framework entries report', () => {
	it('opens from Browse without saving a query, lists an entry, and opens its note', async () => {
		const name = 'Unmapped report fixture.md';
		const themes = await browser.executeObsidian(async ({ app }, filename: unknown) => {
			await app.vault.create(String(filename), '---\ncurie: report-fixture:one\n_crosswalker:\n  producer:\n    kind: fixture\n---\n');
			// @ts-expect-error Internal command dispatch used by the desktop harness.
			app.commands.executeCommandById('crosswalker:browse-queries');
			return { dark: document.body.classList.contains('theme-dark'), light: document.body.classList.contains('theme-light') };
		}, name);
		try {
			const launch = browser.$('button=Unmapped framework entries'); await launch.waitForDisplayed(); await launch.click();
			const select = browser.$('.modal select'); await select.waitForDisplayed({ timeout: 30000 });
			await select.selectByAttribute('value', 'report-fixture');
			const entry = browser.$('button=report-fixture:one'); await entry.waitForDisplayed();
			mkdirSync('test-screenshots', { recursive: true });
			for (const theme of ['light', 'dark']) {
				await browser.execute((value: string) => {
					document.body.classList.toggle('theme-dark', value === 'dark');
					document.body.classList.toggle('theme-light', value === 'light');
				}, theme);
				await browser.saveScreenshot(path.resolve('test-screenshots', `unmapped-entries-${theme}.png`));
			}
			await entry.click();
			await browser.waitUntil(async () => (await browser.executeObsidian(({ app }) => app.workspace.getActiveFile()?.path)) === name);
		} finally {
			await browser.execute((saved: { dark: boolean; light: boolean }) => {
				document.body.classList.toggle('theme-dark', saved.dark);
				document.body.classList.toggle('theme-light', saved.light);
			}, themes);
		}
	});
});
