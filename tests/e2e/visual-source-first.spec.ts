/** Synthetic-only source-first presentation and navigation proof. */
import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { closeImportWizard, requireImportWizard } from './helpers/wizard-modal';
import { RECIPE_REGISTRY } from '../../src/import/recipe-registry';

const WIZARD = '.crosswalker-wizard-modal';
const OUT = path.resolve('test-screenshots');
async function labels() {
	return browser.executeObsidian((_o, selector) => Array.from(document.querySelectorAll(`${selector} .crosswalker-step-continue`), b => b.textContent), WIZARD);
}
async function press(label: string, selector = '.crosswalker-step-continue') {
	const clicked = await browser.executeObsidian((_o, args) => {
		const button = Array.from(document.querySelectorAll<HTMLButtonElement>(`${args.root} ${args.selector}`)).find(b => b.textContent === args.label);
		if (!button || button.disabled) return false;
		button.click(); return true;
	}, { root: WIZARD, selector, label });
	expect(clicked).toBe(true);
}
async function capture(state: string) {
	// Dismiss through the notice's normal click behavior, never by hiding/removing
	// product DOM or changing startup policy. Keep the synthetic text as evidence.
	const notices = await browser.executeObsidian(() => {
		return Array.from(document.querySelectorAll<HTMLElement>('.notice'), (notice) => {
			const text = notice.textContent ?? '';
			notice.click();
			return text;
		});
	});
	console.log('[source-first] notices dismissed before capture', JSON.stringify({ state, notices }));
	await browser.waitUntil(async () => browser.executeObsidian(() =>
		Array.from(document.querySelectorAll<HTMLElement>('.notice')).every((notice) => {
			const rect = notice.getBoundingClientRect();
			return rect.width === 0 || rect.height === 0 || getComputedStyle(notice).visibility === 'hidden';
		})), { timeout: 5_000, timeoutMsg: 'Notices still obscure source-first capture' });
	for (const width of [1100, 520]) for (const theme of ['light', 'dark']) {
		await browser.executeObsidian(({ app }, args) => {
			const host = app as unknown as { changeTheme(name: string): void };
			host.changeTheme(args.theme === 'dark' ? 'obsidian' : 'moonstone');
			document.body.classList.toggle('theme-light', args.theme === 'light');
			document.body.classList.toggle('theme-dark', args.theme === 'dark');
			const root = document.querySelector<HTMLElement>(args.root)!;
			root.style.width = `${args.width}px`; root.style.maxWidth = `${args.width}px`;
			const content = root.querySelector<HTMLElement>('.crosswalker-wizard-content');
			if (content) content.scrollTop = 0;
			if (args.state === 'guidance') root.querySelector('[data-recipe-id="cis-controls-v8-flat"]')?.scrollIntoView({ block: 'center' });
			if (args.state === 'recognized') root.querySelector('.crosswalker-recognized-card')?.scrollIntoView({ block: 'center' });
			app.workspace.trigger('css-change');
		}, { theme, width, root: WIZARD, state });
		await browser.pause(350);
		await browser.saveScreenshot(path.join(OUT, `source-first-${state}-${width}-${theme}.png`));
	}
}
async function managedNotes() {
	return browser.executeObsidian(async ({ app }) => {
		const notes: Array<[string, string]> = [];
		for (const file of app.vault.getMarkdownFiles()) {
			const content = await app.vault.read(file);
			if (content.includes('_crosswalker:')) notes.push([file.path, content]);
		}
		return notes.sort((a, b) => a[0].localeCompare(b[0]));
	});
}

describe('Source-first import presentation', function () {
	this.timeout(120_000);
	before(async () => {
		mkdirSync(OUT, { recursive: true });
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error -- internal plugin registry, isolated E2E sandbox only
			const plugin = app.plugins.plugins.crosswalker;
			Object.assign(plugin.settings, { enableShapeWorkbench: true, enableConfigSuggestions: false, autoApplyExactMatch: false });
			await plugin.saveSettings();
		});
	});
	after(async () => { await closeImportWizard(); });

	it('keeps both pickers and guidance discoverable, then reads and reviews without generating notes', async () => {
		const before = await managedNotes();
		await requireImportWizard();
		expect(await labels()).toEqual(['Read source', 'Read source']);
		const order = await browser.executeObsidian((_o, selector) => {
			const root = document.querySelector(selector)!;
			const elements = ['.crosswalker-vault-pick-row button', 'input[type=file]', '.crosswalker-saved-recipe-row', '.crosswalker-preset-guide'].map(s => root.querySelector(s)!);
			return { ordered: elements.slice(1).every((el, i) => !!(elements[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)), closed: !(elements[3] as HTMLDetailsElement).open, name: elements[1].getAttribute('aria-label') };
		}, WIZARD);
		expect(order).toEqual({ ordered: true, closed: true, name: 'Pick a file from your computer' });
		await capture('empty');
		// Inspect the existing disclosure's cautions before any file is selected.
		await browser.$(`${WIZARD} .crosswalker-preset-guide summary`).click();
		const warning = browser.$(`${WIZARD} [data-recipe-id="cis-controls-v8-flat"]`);
		await warning.scrollIntoView();
		expect(await warning.getText()).toMatch(/registration/i);
		await capture('guidance');
		await browser.$(`${WIZARD} .crosswalker-preset-guide summary`).click();

		const entry = RECIPE_REGISTRY.find(e => e.id === 'nist-csf-2-linked')!;
		const csv = [entry.signatureColumns.join(','), entry.signatureColumns.map(c => c === 'Subcategory' ? 'GV.OC-01: Synthetic outcome.' : 'Synthetic example.').join(',')].join('\n');
		await browser.executeObsidian((_o, args) => {
			const input = document.querySelector<HTMLInputElement>(`${args.root} input[type=file]`)!;
			const transfer = new DataTransfer(); transfer.items.add(new File([args.csv], 'synthetic-source.csv'));
			input.files = transfer.files; input.dispatchEvent(new Event('change'));
		}, { root: WIZARD, csv });
		await browser.$(`${WIZARD} .crosswalker-file-card`).waitForExist();
		expect(await labels()).toEqual(['Read source', 'Read source']);
		await capture('selected');
		await press('Read source');
		await browser.$(`${WIZARD} .crosswalker-recognized-card`).waitForExist({ timeout: 20_000 });
		expect(await labels()).toEqual(['Choose layout', 'Choose layout']);
		await capture('recognized');
		await press('Adjust layout', '.crosswalker-recognized-actions button');
		await browser.waitUntil(async () => (await labels())[0] === 'Review import');
		await press('Back', '.crosswalker-back-btn');
		await browser.$(`${WIZARD} .crosswalker-recognized-card`).waitForExist();
		await press('Review with this recipe', '.crosswalker-recognized-actions button');
		await browser.waitUntil(async () => (await labels())[0] === 'Continue to generation');
		expect(await labels()).toEqual(['Continue to generation', 'Continue to generation']);
		expect(await managedNotes()).toEqual(before);
	});
});
