/**
 * visual-recipe-library.spec.ts — saved import recipes, in light and dark.
 *
 * Screenshots: the save dialog, the save dialog offering Replace after a
 * second save in one session, the library browser with both groups plus an
 * unreadable file, an expanded recipe card with its "Where notes go" tree,
 * the Step 1 "Your recipe" offer card (offered, never preselected), the save
 * dialog with its lineage line, and the select-mode picker plus the Step 1
 * pending line with its "Don't use it" button. After one generation with the
 * recipe: the card's "Last run" line, the expanded Runs section, and Run again
 * Step 1 with a file that matches the last run and with one that changed.
 *
 *   bun run e2e:xvfb -- --spec tests/e2e/visual-recipe-library.spec.ts
 *
 * PNGs land in test-screenshots/ (rl-01 … rl-12, -light and -dark).
 * Every column, id and value here is invented.
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { closeImportWizard, requireImportWizard, clearAllDrafts } from './helpers/wizard-modal';
import { waitForVaultIndexed } from './helpers/vault-readiness';

const OUT = path.resolve('test-screenshots');
const WIZARD = '.crosswalker-wizard-modal';
const FOLDER = '_crosswalker/import-recipes';
const RECIPE_NAME = 'Visual sample recipe';
const RECIPE_ID = 'visual-sample-recipe';
const BROKEN = `${FOLDER}/broken-sample.json`;

const CSV = [
	'sample_key,sample_group,sample_title,sample_text',
	'VS-1,North group,Invented item one,Invented descriptive text for item one.',
	'VS-2,North group,Invented item two,Invented descriptive text for item two.',
	'VS-3,South group,Invented item three,Invented descriptive text for item three.',
	'VS-4,South group,Invented item four,Invented descriptive text for item four.',
].join('\n');

async function until<T>(read: () => Promise<T | null | false>, ms: number, label: string): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = await read();
		if (value) return value as T;
		if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${label}`);
		await browser.pause(150);
	}
}

async function bothThemes(base: string): Promise<void> {
	const previous = await browser.executeObsidian(() => ({
		dark: document.body.classList.contains('theme-dark'),
		light: document.body.classList.contains('theme-light'),
	}));
	// Notices float over the toolbar and dialogs; clear them before capture.
	await browser.executeObsidian(() => {
		document.querySelectorAll('.notice').forEach((n) => n.remove());
	});
	try {
		for (const theme of ['light', 'dark'] as const) {
			await browser.executeObsidian((_o, t) => {
				document.body.classList.toggle('theme-light', t === 'light');
				document.body.classList.toggle('theme-dark', t === 'dark');
			}, theme);
			await browser.pause(250);
			await browser.saveScreenshot(path.join(OUT, `${base}-${theme}.png`));
		}
	} finally {
		await browser.executeObsidian((_o, value: unknown) => {
			const state = value as { dark: boolean; light: boolean };
			document.body.classList.toggle('theme-dark', state.dark);
			document.body.classList.toggle('theme-light', state.light);
		}, previous);
	}
}

async function step(): Promise<number> {
	return browser.executeObsidian((_o, wizard) => {
		const text = document.querySelector(wizard)?.querySelector('.crosswalker-step-indicator')?.textContent ?? '';
		return Number(/Step (\d+)/.exec(text)?.[1] ?? -1);
	}, WIZARD);
}

async function clickButton(label: string, exact = false): Promise<boolean> {
	return browser.executeObsidian((_o, a) => {
		const modal = document.querySelector(a.wizard);
		const button = Array.from(modal?.querySelectorAll('button') ?? []).find((b) => {
			const text = b.textContent?.trim() ?? '';
			return a.exact ? text === a.label : text.includes(a.label);
		}) as HTMLButtonElement | undefined;
		if (!button || button.disabled) return false;
		button.click();
		return true;
	}, { label, exact, wizard: WIZARD });
}

async function saveDialog(): Promise<{ name: string; lineage: string; collision: string; buttons: string[]; text: string }> {
	return until(async () => browser.executeObsidian(() => {
		const modal = document.querySelector('.crosswalker-save-recipe-modal');
		if (!modal) return null;
		return {
			name: (modal.querySelector('.crosswalker-save-recipe-name') as HTMLInputElement | null)?.value ?? '',
			lineage: modal.querySelector('.crosswalker-save-recipe-lineage')?.textContent ?? '',
			collision: modal.querySelector('.crosswalker-save-recipe-collision')?.textContent ?? '',
			buttons: Array.from(modal.querySelectorAll('button')).map((b) => b.textContent?.trim() ?? ''),
			text: modal.textContent ?? '',
		};
	}), 5_000, 'save dialog');
}

async function closeSaveDialog(): Promise<void> {
	await browser.executeObsidian(() => {
		(document.querySelector('.crosswalker-save-recipe-modal .crosswalker-save-recipe-cancel') as HTMLElement | null)?.click();
	});
	await until(async () => browser.executeObsidian(() => !document.querySelector('.crosswalker-save-recipe-modal')), 3_000, 'save dialog closed');
}

async function footerSaveLabel(): Promise<string> {
	return browser.executeObsidian((_o, wizard) => (
		document.querySelector(wizard)?.querySelector('button.crosswalker-save-as-recipe')?.textContent?.trim() ?? ''
	), WIZARD);
}

async function injectSourceAndNext(): Promise<void> {
	const ok = await browser.executeObsidian((_o, a) => {
		const input = document.querySelector(a.wizard)?.querySelector('input[type=file]') as HTMLInputElement | null;
		if (!input) return false;
		const transfer = new DataTransfer();
		transfer.items.add(new File([a.csv], 'visual-sample.csv'));
		input.files = transfer.files;
		input.dispatchEvent(new Event('change'));
		return true;
	}, { csv: CSV, wizard: WIZARD });
	expect(ok).toBe(true);
	await browser.pause(500);
	expect(await clickButton('Next')).toBe(true);
}

const CSV_CHANGED = CSV.replace('Invented item two,', 'Invented item two renamed,');
const LIBRARY = '.crosswalker-recipe-library-modal';
let generatedRoot: string | null = null;

async function injectSource(csv: string): Promise<void> {
	const ok = await browser.executeObsidian((_o, a) => {
		const input = document.querySelector(a.wizard)?.querySelector('input[type=file]') as HTMLInputElement | null;
		if (!input) return false;
		const transfer = new DataTransfer();
		transfer.items.add(new File([a.csv], 'visual-sample.csv'));
		input.files = transfer.files;
		input.dispatchEvent(new Event('change'));
		return true;
	}, { csv, wizard: WIZARD });
	expect(ok).toBe(true);
}

async function closeLibrary(): Promise<void> {
	await browser.executeObsidian((_o, library) => {
		document.querySelectorAll(`${library} .modal-close-button, ${library} .modal-header-button`).forEach((b) => (b as HTMLElement).click());
	}, LIBRARY);
	await until(async () => browser.executeObsidian((_o, library) => !document.querySelector(library), LIBRARY), 3_000, 'library closed');
}

/** Open the library and wait until the recipe's card has a settled "Last run" line. */
async function openLibraryWithRun(): Promise<string> {
	await browser.executeObsidianCommand('crosswalker:browse-import-recipes');
	return until(async () => browser.executeObsidian((_o, a) => {
		const card = document.querySelector(a.library)?.querySelector(`[data-recipe-id="${a.id}"]`);
		const line = card?.querySelector('.crosswalker-recipe-last-run')?.textContent?.trim() ?? '';
		return line.startsWith('Last run') ? line : null;
	}, { library: LIBRARY, id: RECIPE_ID }), 15_000, 'last run line');
}

async function runAgainStatus(): Promise<string[]> {
	return browser.executeObsidian((_o, wizard) => (
		Array.from(document.querySelector(wizard)?.querySelectorAll('.crosswalker-run-again-status p') ?? []).map((p) => p.className)
	), WIZARD);
}

async function startRunAgain(): Promise<void> {
	expect(await browser.executeObsidian((_o, a) => {
		const button = document.querySelector(a.library)?.querySelector(`[data-recipe-id="${a.id}"] button.crosswalker-recipe-run-again`) as HTMLButtonElement | null;
		button?.click();
		return !!button;
	}, { library: LIBRARY, id: RECIPE_ID })).toBe(true);
	await until(async () => browser.executeObsidian((_o, a) => !document.querySelector(a.library) && !!document.querySelector(a.wizard), { library: LIBRARY, wizard: WIZARD }), 8_000, 'run again wizard');
}

async function cleanup(): Promise<void> {
	await browser.executeObsidian(async ({ app }, a) => {
		for (const file of [`${a.folder}/${a.id}.json`, a.broken]) {
			if (await app.vault.adapter.exists(file)) await app.vault.adapter.remove(file);
		}
	}, { folder: FOLDER, id: RECIPE_ID, broken: BROKEN });
}

describe('Visual: saved import recipes', function () {
	this.timeout(240_000);

	before(async () => {
		mkdirSync(OUT, { recursive: true });
		await closeImportWizard();
		await clearAllDrafts();
		await waitForVaultIndexed();
		await cleanup();
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error — internal plugins API
			const plugin = app.plugins.plugins['crosswalker'];
			plugin.settings.enableShapeWorkbench = true;
			plugin.settings.enableConfigSuggestions = false;
			plugin.settings.enableDraftSessions = false;
			await plugin.saveSettings();
		});
	});

	after(async () => {
		await browser.executeObsidian(() => {
			document.querySelectorAll('.crosswalker-recipe-library-modal .modal-close-button, .crosswalker-recipe-library-modal .modal-header-button, .crosswalker-save-recipe-modal .modal-close-button, .crosswalker-save-recipe-modal .modal-header-button')
				.forEach((b) => (b as HTMLElement).click());
		});
		await closeImportWizard();
		await cleanup();
		await browser.executeObsidian(async ({ app }, a) => {
			if (a.root) {
				const folder = app.vault.getAbstractFileByPath(a.root);
				if (folder) await app.vault.delete(folder, true);
			}
			// @ts-expect-error — internal plugins API
			const plugin = app.plugins.plugins['crosswalker'];
			if (!plugin) return;
			plugin.settings.recipeRuns = (plugin.settings.recipeRuns ?? []).filter((r: { recipeId: string }) => r.recipeId !== a.id);
			plugin.settings.enableShapeWorkbench = false;
			plugin.settings.enableConfigSuggestions = true;
			plugin.settings.enableDraftSessions = true;
			await plugin.saveSettings();
		}, { root: generatedRoot, id: RECIPE_ID });
	});

	it('save dialog on the review step', async () => {
		await requireImportWizard();
		await injectSourceAndNext();
		await until(async () => (await step()) >= 2, 15_000, 'workbench step');
		expect(await clickButton('Next')).toBe(true);
		await until(async () => (await step()) >= 3, 15_000, 'review step');
		expect(await clickButton('Save as recipe', true)).toBe(true);
		const dialog = await until(async () => browser.executeObsidian(() => {
			const modal = document.querySelector('.crosswalker-save-recipe-modal');
			if (!modal) return null;
			return {
				title: modal.querySelector('.modal-title')?.textContent ?? '',
				name: (modal.querySelector('.crosswalker-save-recipe-name') as HTMLInputElement | null)?.value ?? '',
				note: modal.querySelector('.crosswalker-save-recipe-note')?.textContent ?? '',
				buttons: Array.from(modal.querySelectorAll('button')).map((b) => b.textContent?.trim() ?? ''),
				text: modal.textContent ?? '',
			};
		}), 5_000, 'save dialog');
		console.log('[visual-recipe-library] dialog → ' + JSON.stringify(dialog));
		expect(dialog.name).toBe('visual-sample');
		expect(dialog.note).toBe('Saves how columns become folders, notes, properties and links. Your source file is not saved.');
		expect(dialog.buttons).toContain('Save');
		expect(dialog.text).not.toContain('—');
		await browser.executeObsidian((_o, name) => {
			const input = document.querySelector('.crosswalker-save-recipe-modal .crosswalker-save-recipe-name') as HTMLInputElement;
			input.value = name;
			input.dispatchEvent(new Event('input'));
			const desc = document.querySelector('.crosswalker-save-recipe-modal .crosswalker-save-recipe-desc') as HTMLInputElement | HTMLTextAreaElement | null;
			if (desc) {
				desc.value = 'Invented sample setup for screenshots.';
				desc.dispatchEvent(new Event('input'));
			}
		}, RECIPE_NAME);
		await bothThemes('rl-01-save-dialog');
		const saved = await browser.executeObsidian(async ({ app }, path) => {
			const save = Array.from(document.querySelectorAll('.crosswalker-save-recipe-modal button')).find((b) => b.textContent?.trim() === 'Save') as HTMLButtonElement;
			save.click();
			const started = Date.now();
			while (Date.now() - started < 5000 && !(await app.vault.adapter.exists(path))) await new Promise((r) => setTimeout(r, 100));
			return app.vault.adapter.exists(path);
		}, `${FOLDER}/${RECIPE_ID}.json`);
		expect(saved).toBe(true);
		// The footer confirms the save until the next edit.
		await until(async () => (await footerSaveLabel()) === `Saved as "${RECIPE_NAME}"`, 5_000, 'saved-as footer label');

		// An edit in the same session: the next save offers Replace.
		expect(await clickButton('Back', true)).toBe(true);
		await until(async () => (await step()) === 2, 10_000, 'back to workbench');
		const flipped = await browser.executeObsidian((_o, wizard) => {
			const details = document.querySelector(wizard)?.querySelector('details.crosswalker-wb-allcols') as HTMLDetailsElement | null;
			if (!details) return 'NO_TABLE';
			details.open = true;
			const row = Array.from(details.querySelectorAll('.crosswalker-wb-allcol-row'))
				.find((r) => r.querySelector('.crosswalker-wb-colname')?.textContent === 'sample_text');
			const select = row?.querySelector('select') as HTMLSelectElement | null;
			if (!select) return 'NO_SELECT';
			select.value = select.value === 'body' ? 'property' : 'body';
			select.dispatchEvent(new Event('change'));
			return select.value;
		}, WIZARD);
		expect(['body', 'property']).toContain(flipped);
		expect(await clickButton('Next')).toBe(true);
		await until(async () => (await step()) >= 3, 15_000, 'review step after edit');
		expect(await footerSaveLabel()).toBe('Save as recipe');
		expect(await clickButton('Save as recipe', true)).toBe(true);
		const replace = await saveDialog();
		console.log('[visual-recipe-library] replace dialog → ' + JSON.stringify({ ...replace, text: undefined }));
		expect(replace.name).toBe(RECIPE_NAME);
		expect(replace.buttons).toEqual(['Cancel', `Replace "${RECIPE_NAME}"`, 'Save']);
		expect(replace.collision).toBe(`You already have a recipe named "${RECIPE_NAME}". This one will be saved as "${RECIPE_NAME} 2".`);
		expect(replace.text).not.toContain('—');
		await bothThemes('rl-05-save-dialog-replace');
		await closeSaveDialog();
		await closeImportWizard();
	});

	it('library browser with your recipes, built in, and an unreadable file', async () => {
		await browser.executeObsidian(async ({ app }, a) => {
			for (const dir of ['_crosswalker', a.folder]) {
				if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
			}
			await app.vault.adapter.write(a.broken, '{ this is not json');
		}, { folder: FOLDER, broken: BROKEN });
		await browser.executeObsidianCommand('crosswalker:browse-import-recipes');
		const listing = await until(async () => browser.executeObsidian(() => {
			const modal = document.querySelector('.crosswalker-recipe-library-modal');
			if (!modal || !modal.querySelector('.crosswalker-library-card')) return null;
			return {
				groups: Array.from(modal.querySelectorAll('.crosswalker-recipe-group-title')).map((g) => g.textContent?.trim() ?? ''),
				problems: modal.querySelectorAll('.crosswalker-recipe-problem').length,
				text: modal.textContent ?? '',
			};
		}), 8_000, 'library browser');
		console.log('[visual-recipe-library] listing → ' + JSON.stringify({ groups: listing.groups, problems: listing.problems }));
		expect(listing.groups).toEqual(['Your recipes', 'Built in', "Couldn't read"]);
		expect(listing.problems).toBe(1);
		expect(listing.text).not.toContain('—');
		await bothThemes('rl-02-library-browser');
		await browser.executeObsidian(() => {
			const titles = Array.from(document.querySelectorAll('.crosswalker-recipe-library-modal .crosswalker-recipe-group-title'));
			titles.find((t) => t.textContent?.trim() === "Couldn't read")?.scrollIntoView({ block: 'start' });
		});
		await bothThemes('rl-02b-library-unreadable');

		const expanded = await browser.executeObsidian((_o, id) => {
			const card = document.querySelector(`.crosswalker-recipe-library-modal [data-recipe-id="${id}"]`);
			const header = card?.querySelector('.crosswalker-card-header') as HTMLElement | null;
			header?.click();
			return true;
		}, RECIPE_ID);
		expect(expanded).toBe(true);
		const details = await until(async () => browser.executeObsidian((_o, id) => {
			const card = document.querySelector(`.crosswalker-recipe-library-modal [data-recipe-id="${id}"]`);
			if (!card?.querySelector('.crosswalker-recipe-columns')) return null;
			card.scrollIntoView({ block: 'start' });
			const tree = card.querySelector('.crosswalker-recipe-dest');
			const table = card.querySelector('.crosswalker-recipe-columns');
			return {
				rows: card.querySelectorAll('.crosswalker-recipe-columns tbody tr, .crosswalker-recipe-columns tr').length,
				actions: Array.from(card.querySelectorAll('.crosswalker-card-actions button')).map((b) => b.textContent?.trim() ?? ''),
				treeRows: Array.from(card.querySelectorAll('.crosswalker-recipe-dest-row')).map((r) => r.textContent?.trim() ?? ''),
				treeFirst: !!tree && !!table && !!(tree.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING),
				cardText: card.textContent ?? '',
			};
		}, RECIPE_ID), 5_000, 'expanded card');
		console.log('[visual-recipe-library] expanded → ' + JSON.stringify({ ...details, cardText: undefined }));
		expect(details.rows).toBeGreaterThan(1);
		expect(details.actions).toEqual(['Use for import', 'Export', 'Duplicate', 'Rename', 'Delete']);
		expect(details.treeFirst).toBe(true);
		expect(details.treeRows.length).toBeGreaterThan(0);
		expect(details.treeRows.some((r) => r.startsWith('One note for each row'))).toBe(true);
		expect(details.cardText).toContain('Where notes go');
		expect(details.cardText).not.toMatch(/[{}]/);
		expect(details.cardText).not.toContain('Notes land at');
		// Collapsed cards keep only the everyday actions.
		const collapsed = await browser.executeObsidian(() => {
			const cards = Array.from(document.querySelectorAll('.crosswalker-recipe-library-modal .crosswalker-library-card'));
			return cards
				.filter((c) => !c.querySelector('.crosswalker-recipe-columns'))
				.map((c) => Array.from(c.querySelectorAll('.crosswalker-card-actions button')).map((b) => b.textContent?.trim() ?? ''))
				.find((buttons) => buttons.includes('Export') && buttons.includes('Use for import')) ?? null;
		});
		if (collapsed) expect(collapsed).not.toContain('Delete');
		await bothThemes('rl-03-expanded-card');

		const lingering = await browser.executeObsidian(() => {
			document.querySelectorAll('.crosswalker-recipe-library-modal .modal-close-button, .crosswalker-recipe-library-modal .modal-header-button').forEach((b) => (b as HTMLElement).click());
			return document.querySelectorAll('.crosswalker-recipe-library-modal').length;
		});
		console.log('[visual-recipe-library] library modals before close → ' + lingering);
		await until(async () => browser.executeObsidian(() => document.querySelectorAll('.crosswalker-recipe-library-modal').length === 0), 3_000, 'library browser closed');
	});

	it('Step 1 offers your recipe without preselecting it', async () => {
		await requireImportWizard();
		await injectSourceAndNext();
		const card = await until(async () => browser.executeObsidian((_o, wizard) => {
			const modal = document.querySelector(wizard);
			const found = modal?.querySelector('.crosswalker-recognized-card');
			if (!found) return null;
			return {
				yours: found.classList.contains('is-yours'),
				title: found.querySelector('.crosswalker-recognized-title')?.textContent?.trim() ?? '',
				text: found.textContent ?? '',
				buttons: Array.from(found.querySelectorAll('button')).map((b) => b.textContent?.trim() ?? ''),
			};
		}, WIZARD), 10_000, 'recognized card');
		console.log('[visual-recipe-library] offer → ' + JSON.stringify(card));
		expect(card.yours).toBe(true);
		expect(card.text).toContain('Your recipe');
		expect(card.title).toBe(`Looks like your recipe "${RECIPE_NAME}". Use it?`);
		expect(card.buttons).toContain('Use this recipe');
		expect(card.text).not.toContain('—');
		// Offered, not applied: the wizard is still on Step 1.
		expect(await step()).toBe(1);
		await browser.executeObsidian((_o, wizard) => {
			document.querySelector(wizard)?.querySelector('.crosswalker-recognized-card')?.scrollIntoView({ block: 'center' });
		}, WIZARD);
		await bothThemes('rl-04-step1-offer');

		// Accept the offer, then open the save dialog: it names where the setup came from.
		expect(await clickButton('Use this recipe', true)).toBe(true);
		await until(async () => (await step()) >= 2, 15_000, 'workbench from recipe');
		if ((await step()) === 2) expect(await clickButton('Next')).toBe(true);
		await until(async () => (await step()) >= 3, 15_000, 'review step from recipe');
		expect(await clickButton('Save as recipe', true)).toBe(true);
		const lineage = await saveDialog();
		console.log('[visual-recipe-library] lineage dialog → ' + JSON.stringify({ ...lineage, text: undefined }));
		expect(lineage.lineage).toBe(`Based on your recipe "${RECIPE_NAME}"`);
		expect(lineage.buttons).toEqual(['Cancel', 'Save']);
		expect(lineage.text).not.toContain('—');
		await bothThemes('rl-06-save-dialog-lineage');
		await closeSaveDialog();
		await closeImportWizard();
	});

	it('Step 1 picker in select mode, then the pending line with an undo', async () => {
		await requireImportWizard();
		expect(await browser.executeObsidian(() => document.querySelectorAll('.crosswalker-recipe-library-modal').length)).toBe(0);
		const hint = await browser.executeObsidian((_o, wizard) => (
			document.querySelector(wizard)?.querySelector('.crosswalker-saved-recipe-hint')?.textContent ?? ''
		), WIZARD);
		expect(hint).toBe('Start from the shape of a recipe you saved before.');
		expect(await clickButton('Use a saved recipe', true)).toBe(true);
		const picker = await until(async () => browser.executeObsidian((_o, id) => {
			const modal = document.querySelector('.crosswalker-recipe-library-modal');
			const card = modal?.querySelector(`[data-recipe-id="${id}"]`);
			if (!card) return null;
			return {
				buttons: Array.from(card.querySelectorAll('.crosswalker-card-actions button')).map((b) => b.textContent?.trim() ?? ''),
				text: modal?.textContent ?? '',
			};
		}, RECIPE_ID), 8_000, 'select-mode picker');
		console.log('[visual-recipe-library] picker → ' + JSON.stringify({ buttons: picker.buttons }));
		expect(picker.buttons).toEqual(['Use this recipe']);
		expect(picker.text).not.toContain('—');
		await bothThemes('rl-07-select-picker');

		await browser.executeObsidian((_o, id) => {
			const card = document.querySelector(`.crosswalker-recipe-library-modal [data-recipe-id="${id}"]`);
			(Array.from(card?.querySelectorAll('button') ?? []).find((b) => b.textContent?.trim() === 'Use this recipe') as HTMLButtonElement | undefined)?.click();
		}, RECIPE_ID);
		const pending = await until(async () => browser.executeObsidian((_o, wizard) => {
			const row = document.querySelector(wizard)?.querySelector('.crosswalker-saved-recipe-row');
			const line = row?.querySelector('.crosswalker-saved-recipe-pending')?.textContent ?? '';
			if (!line) return null;
			return { line, undo: row?.querySelector('.crosswalker-saved-recipe-clear')?.textContent?.trim() ?? '' };
		}, WIZARD), 5_000, 'pending line');
		expect(pending.line).toBe(`Using your recipe "${RECIPE_NAME}". Choose the source file.`);
		expect(pending.undo).toBe("Don't use it");
		await bothThemes('rl-08-step1-pending');

		expect(await clickButton("Don't use it", true)).toBe(true);
		const cleared = await until(async () => browser.executeObsidian((_o, wizard) => {
			const row = document.querySelector(wizard)?.querySelector('.crosswalker-saved-recipe-row');
			if (!row || row.querySelector('.crosswalker-saved-recipe-pending')) return null;
			return row.querySelector('.crosswalker-saved-recipe-hint')?.textContent ?? 'NO_HINT';
		}, WIZARD), 5_000, 'pending cleared');
		expect(cleared).toBe('Start from the shape of a recipe you saved before.');
		await closeImportWizard();
	});
	it('Run again: last run on the card, the Runs section, and Step 1 status', async () => {
		// One generation with the saved recipe, picked in Step 1.
		await requireImportWizard();
		expect(await clickButton('Use a saved recipe', true)).toBe(true);
		await until(async () => browser.executeObsidian((_o, id) => {
			const button = Array.from(document.querySelector(`.crosswalker-recipe-library-modal [data-recipe-id="${id}"]`)?.querySelectorAll('button') ?? [])
				.find((b) => b.textContent?.trim() === 'Use this recipe') as HTMLButtonElement | undefined;
			button?.click();
			return !!button;
		}, RECIPE_ID), 8_000, 'picker');
		await injectSource(CSV);
		await browser.pause(500);
		expect(await clickButton('Next')).toBe(true);
		await until(async () => (await step()) >= 2, 15_000, 'workbench step');
		if ((await step()) === 2) expect(await clickButton('Next')).toBe(true);
		await until(async () => (await step()) >= 3, 15_000, 'review step');
		expect(await clickButton('Next')).toBe(true);
		await until(async () => (await step()) >= 4, 15_000, 'generate step');
		generatedRoot = await browser.executeObsidian((_o, wizard) => {
			const items = Array.from(document.querySelector(wizard)?.querySelectorAll('.setting-item') ?? []);
			const select = items.find((i) => i.querySelector('.setting-item-name')?.textContent?.trim() === 'If files exist')?.querySelector('select') as HTMLSelectElement | null;
			if (select) {
				select.value = 'replace';
				select.dispatchEvent(new Event('change'));
			}
			return (document.querySelector(wizard)?.querySelector('.crosswalker-gen-confirm .mono')?.textContent ?? '').trim();
		}, WIZARD);
		expect(generatedRoot).not.toBe('');
		expect(await clickButton('Generate', true)).toBe(true);
		await until(async () => browser.executeObsidian((_o, wizard) => {
			const modal = document.querySelector(wizard);
			return !modal || !!modal.querySelector('.crosswalker-results-summary')?.textContent?.trim();
		}, WIZARD), 30_000, 'generation');
		await closeImportWizard();
		await waitForVaultIndexed();

		const line = await openLibraryWithRun();
		console.log('[visual-recipe-library] last run → ' + line);
		expect(line).not.toContain('iset-');
		expect(line).not.toContain(generatedRoot!);
		await browser.executeObsidian((_o, a) => {
			document.querySelector(a.library)?.querySelector(`[data-recipe-id="${a.id}"]`)?.scrollIntoView({ block: 'start' });
		}, { library: LIBRARY, id: RECIPE_ID });
		await bothThemes('rl-09-card-last-run');

		await browser.executeObsidian((_o, a) => {
			(document.querySelector(a.library)?.querySelector(`[data-recipe-id="${a.id}"] .crosswalker-card-header`) as HTMLElement | null)?.click();
		}, { library: LIBRARY, id: RECIPE_ID });
		// One run is already the card's meta line and its Run again button, so
		// the expanded card shows no Runs list; the actions say which button
		// leaves existing notes alone.
		const expanded = await until(async () => browser.executeObsidian((_o, a) => {
			const card = document.querySelector(a.library)?.querySelector(`[data-recipe-id="${a.id}"]`);
			if (!card?.querySelector('.crosswalker-recipe-columns')) return null;
			card.scrollIntoView({ block: 'start' });
			return {
				runsSection: !!card.querySelector('.crosswalker-recipe-runs'),
				actions: Array.from(card.querySelectorAll('.crosswalker-card-actions button')).map((b) => b.textContent?.trim() ?? ''),
				text: (card.textContent ?? '').replace(/\s+/g, ' ').trim(),
			};
		}, { library: LIBRARY, id: RECIPE_ID }), 5_000, 'expanded card with a run');
		console.log('[visual-recipe-library] expanded with run → ' + JSON.stringify({ ...expanded, text: undefined }));
		expect(expanded.runsSection).toBe(false);
		expect(expanded.actions.slice(0, 2)).toEqual(['Run again', 'Import as a new set']);
		expect(expanded.text).not.toContain('iset-');
		expect(expanded.text).not.toContain('—');
		await bothThemes('rl-10-expanded-runs');

		await startRunAgain();
		await injectSource(CSV);
		await until(async () => (await runAgainStatus()).some((c) => c.includes('crosswalker-run-again-same')), 10_000, 'matches line');
		const lead = await browser.executeObsidian((_o, wizard) => (document.querySelector(wizard)?.querySelector('.crosswalker-run-again-lead-line')?.textContent ?? '').trim(), WIZARD);
		console.log('[visual-recipe-library] run again lead → ' + lead);
		expect(lead).toMatch(/^Running ".+" again into .+\. /);
		expect(lead).not.toContain('iset-');
		await bothThemes('rl-11-step1-matches');
		await closeImportWizard();

		await openLibraryWithRun();
		await startRunAgain();
		await injectSource(CSV_CHANGED);
		await until(async () => (await runAgainStatus()).some((c) => c.includes('crosswalker-run-again-changed')), 10_000, 'changed line');
		await bothThemes('rl-12-step1-changed');
		await closeImportWizard();
		if (await browser.executeObsidian((_o, library) => !!document.querySelector(library), LIBRARY)) await closeLibrary();
	});
});
