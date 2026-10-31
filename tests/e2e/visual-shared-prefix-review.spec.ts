import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { captureScreenshot, setupVisualSpec } from '../helpers/visual-spec-runner';

/** Real modal/wizard copy, both themes. Synthetic source; no private corpus. */
describe('Visual: collision-based new-set review', function () {
	setupVisualSpec(this, { timeoutMs: 180_000 });

	async function theme(value: 'light' | 'dark') {
		await browser.executeObsidian(({ app }, requested) => {
			(app as unknown as { changeTheme(t: string): void }).changeTheme(requested === 'dark' ? 'obsidian' : 'moonstone');
			document.body.classList.toggle('theme-dark', requested === 'dark');
			document.body.classList.toggle('theme-light', requested === 'light');
		}, value);
	}

	it('shows the new-set mapping explanation without choosing a refresh', async () => {
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error internal plugin API
			const plugin = app.plugins.plugins.crosswalker;
			const prior = await plugin.runSssomImportForE2E('subject_id\tpredicate_id\tobject_id\nvisual:Earlier\tskos:relatedMatch\tother:Earlier\n', { basePath: '_crosswalker/mappings/visual-to-other', importSet: 'new', runTier2Projection: false });
			if (!prior.generation?.success) throw new Error(JSON.stringify(prior.generation?.errors));
			// @ts-expect-error internal command API
			app.commands.executeCommandById('crosswalker:import-sssom');
		});
		const paste = await browser.$('button=Paste TSV');
		await paste.waitForDisplayed();
		await paste.click();
		// WebDriver types tabs as focus navigation; paste literal TSV instead.
		await browser.execute((tsv) => {
			const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!;
			textarea.value = tsv;
			textarea.dispatchEvent(new Event('input', { bubbles: true }));
		}, 'subject_id\tpredicate_id\tobject_id\nvisual:A\tskos:relatedMatch\tother:B\n');
		await browser.$('button=Use this TSV').click();
		await browser.waitUntil(async () => (await browser.$('#crosswalker-sssom-preview').getText()).includes('Plain identifiers: none overlap an existing set.'), {
			timeout: 15_000,
			timeoutMsg: 'Expected existing-set review: ' + await browser.$('#crosswalker-sssom-preview').getText(),
		});
		const text = await browser.$('#crosswalker-sssom-preview').getText();
		expect(text).toContain('Plain identifiers: none overlap an existing set.');
		for (const value of ['light', 'dark'] as const) {
			await theme(value);
			await captureScreenshot(`shared-prefix-mapping-${value}`);
		}
		await browser.$('button=Cancel').click();
	});

	it('shows the wizard new-set explanation without a refresh preselection', async () => {
		await browser.executeObsidian(({ app }) => {
			// @ts-expect-error internal plugin API
			const plugin = app.plugins.plugins.crosswalker;
			plugin.settings.enableConfigSuggestions = false;
			plugin.settings.enableShapeWorkbench = true;
			// @ts-expect-error internal command API
			app.commands.executeCommandById('crosswalker:import-structured-data');
		});
		await browser.$('.crosswalker-wizard-modal input[type=file]').waitForExist();
		await browser.execute(() => {
			const input = document.querySelector<HTMLInputElement>('.crosswalker-wizard-modal input[type=file]')!;
			const transfer = new DataTransfer();
			transfer.items.add(new File(['id,title\nM1001,Shared namespace sample\n'], 'shared-prefix.csv'));
			input.files = transfer.files;
			input.dispatchEvent(new Event('change'));
		});
		await browser.waitUntil(async () => browser.execute(() => {
			const next = [...document.querySelectorAll<HTMLButtonElement>('.crosswalker-wizard-modal button')].find((b) => b.textContent?.includes('Next'));
			return !!next && !next.disabled;
		}));
		await browser.execute(() => [...document.querySelectorAll<HTMLButtonElement>('.crosswalker-wizard-modal button')].find((b) => b.textContent?.includes('Next'))!.click());
		await browser.$('.crosswalker-workbench').waitForExist();
		await browser.execute(() => [...document.querySelectorAll<HTMLButtonElement>('.crosswalker-wizard-modal button')].find((b) => b.textContent?.includes('Next'))!.click());
		await browser.waitUntil(async () => (await browser.$('.crosswalker-wizard-modal').getText()).includes('Plain identifiers: none overlap an existing set.'));
		expect(await browser.$('.crosswalker-wizard-modal').getText()).toContain('Plain identifiers: none overlap an existing set.');
		for (const value of ['light', 'dark'] as const) {
			await theme(value);
			await captureScreenshot(`shared-prefix-wizard-${value}`);
		}
		await browser.keys(['Escape']);
	});
});
