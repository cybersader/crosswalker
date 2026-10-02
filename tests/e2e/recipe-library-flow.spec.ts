/**
 * recipe-library-flow.spec.ts — slice 1 acceptance case 3, end to end.
 *
 * Import a synthetic CSV through the real wizard, save the setup as a recipe
 * from the review step, generate, then reset (output removed, wizard closed)
 * and reopen through Step 1 "Use a saved recipe". The reopened run must show
 * the same review mapping and generate the same managed content.
 *
 *   bun run e2e:xvfb -- --spec tests/e2e/recipe-library-flow.spec.ts
 *
 * Every column, id and value here is invented. The E2E vault is a fresh copy
 * of the seed vault per run, so the derived destination starts empty.
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { closeImportWizard, requireImportWizard, clearAllDrafts } from './helpers/wizard-modal';
import { waitForVaultIndexed } from './helpers/vault-readiness';

const OUT = path.resolve('test-screenshots');
const WIZARD = '.crosswalker-wizard-modal';
const RECIPE_NAME = 'Flow test recipe';
const RECIPE_ID = 'flow-test-recipe';
const RECIPE_PATH = `_crosswalker/import-recipes/${RECIPE_ID}.json`;
const SOURCE_NAME = 'rl-flow-controls.csv';

const CSV = [
	'ref_code,family,label,notes',
	'QF-1,Alpha family,Invented control one,Invented body text for the first row.',
	'QF-2,Alpha family,Invented control two,Invented body text for the second row.',
	'QF-3,Beta family,Invented control three,Invented body text for the third row.',
	'QF-4,Beta family,Invented control four,Invented body text for the fourth row.',
	'QF-5,Gamma family,Invented control five,Invented body text for the fifth row.',
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

async function step(): Promise<number> {
	return browser.executeObsidian((_o, wizard) => {
		const text = document.querySelector(wizard)?.querySelector('.crosswalker-step-indicator')?.textContent ?? '';
		return Number(/Step (\d+)/.exec(text)?.[1] ?? -1);
	}, WIZARD);
}

async function clickButton(label: string, exact = false): Promise<boolean> {
	return browser.executeObsidian((_o, a) => {
		const modal = document.querySelector(a.wizard);
		const button = Array.from(modal?.querySelectorAll('button') ?? []).find((b) =>
			a.exact ? b.textContent?.trim() === a.label : b.textContent?.includes(a.label),
		) as HTMLButtonElement | undefined;
		if (!button || button.disabled) return false;
		button.click();
		return true;
	}, { label, exact, wizard: WIZARD });
}

async function injectSource(): Promise<boolean> {
	return browser.executeObsidian((_o, a) => {
		const input = document.querySelector(a.wizard)?.querySelector('input[type=file]') as HTMLInputElement | null;
		if (!input) return false;
		const transfer = new DataTransfer();
		transfer.items.add(new File([a.csv], a.name));
		input.files = transfer.files;
		input.dispatchEvent(new Event('change'));
		return true;
	}, { csv: CSV, name: SOURCE_NAME, wizard: WIZARD });
}

/** The review step's shape map rows: column -> what it becomes. */
async function reviewMapping(): Promise<Record<string, string>> {
	return browser.executeObsidian((_o, wizard) => {
		const rows: Record<string, string> = {};
		const modal = document.querySelector(wizard);
		for (const tr of Array.from(modal?.querySelectorAll('.crosswalker-shape-map tbody tr') ?? [])) {
			const cells = Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent ?? '').trim());
			if (cells[0]) rows[cells[0]] = cells[1] ?? '';
		}
		return rows;
	}, WIZARD);
}

/**
 * Advance from review to generate and run it. In workbench mode the
 * destination is chosen on the review step and Step 4 only confirms it, so the
 * confirmed folder is read back and returned.
 */
async function generate(): Promise<{ summary: string; root: string }> {
	await until(async () => (await step()) >= 3, 15_000, 'review step');
	expect(await clickButton('Next')).toBe(true);
	await until(async () => (await step()) >= 4, 15_000, 'generate step');
	const root = await browser.executeObsidian((_o, wizard) => {
		const confirmed = document.querySelector(wizard)?.querySelector('.crosswalker-gen-confirm .mono')?.textContent ?? '';
		return confirmed.trim();
	}, WIZARD);
	expect(root).not.toBe('');
	expect(root).not.toBe('(vault root)');
	expect(await clickButton('Generate', true)).toBe(true);
	const summary = await until(async () => browser.executeObsidian((_o, wizard) => {
		const modal = document.querySelector(wizard);
		if (!modal) return 'closed';
		const text = modal.querySelector('.crosswalker-results-summary')?.textContent ?? '';
		return text.trim() ? text.replace(/\s+/g, ' ').trim() : null;
	}, WIZARD), 30_000, 'generation');
	return { summary, root };
}

/** Generated notes under the output, with the provenance block removed. */
async function managedContent(outputPath: string): Promise<Record<string, string>> {
	return browser.executeObsidian(async ({ app }, root) => {
		const out: Record<string, string> = {};
		for (const file of app.vault.getMarkdownFiles()) {
			if (!file.path.startsWith(`${root}/`)) continue;
			const text = await app.vault.read(file);
			const lines = text.split('\n');
			const kept: string[] = [];
			let inProvenance = false;
			for (const line of lines) {
				if (/^_crosswalker:/.test(line)) { inProvenance = true; continue; }
				if (inProvenance && (/^\S/.test(line) || line === '---')) inProvenance = false;
				if (!inProvenance) kept.push(line);
			}
			out[file.path.slice(root.length + 1)] = kept.join('\n');
		}
		return out;
	}, outputPath);
}

async function removeOutput(root: string | null): Promise<void> {
	await browser.executeObsidian(async ({ app }, output) => {
		if (!output) return;
		const folder = app.vault.getAbstractFileByPath(output);
		if (folder) await app.vault.delete(folder, true);
	}, root);
}

async function removeRecipe(): Promise<void> {
	await browser.executeObsidian(async ({ app }, recipe) => {
		if (await app.vault.adapter.exists(recipe)) await app.vault.adapter.remove(recipe);
	}, RECIPE_PATH);
}

let generatedRoot: string | null = null;

describe('Recipe library: save, reset, reopen, regenerate', function () {
	this.timeout(240_000);

	before(async () => {
		mkdirSync(OUT, { recursive: true });
		await closeImportWizard();
		await clearAllDrafts();
		await waitForVaultIndexed();
		await removeRecipe();
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
		await closeImportWizard();
		await removeOutput(generatedRoot);
		await removeRecipe();
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error — internal plugins API
			const plugin = app.plugins.plugins['crosswalker'];
			if (!plugin) return;
			plugin.settings.enableShapeWorkbench = false;
			plugin.settings.enableConfigSuggestions = true;
			plugin.settings.enableDraftSessions = true;
			await plugin.saveSettings();
		});
	});

	it('a saved recipe reopens with the same mapping and generates the same managed content', async () => {
		// -- Run 1: fresh import, save as recipe on the review step, generate.
		await requireImportWizard();
		expect(await injectSource()).toBe(true);
		await browser.pause(500);
		expect(await clickButton('Next')).toBe(true);
		await until(async () => (await step()) >= 2, 15_000, 'workbench step');
		expect(await clickButton('Next')).toBe(true);
		await until(async () => (await step()) >= 3, 15_000, 'review step');
		const firstMapping = await reviewMapping();
		expect(Object.keys(firstMapping).length).toBeGreaterThan(0);

		expect(await clickButton('Save as recipe', true)).toBe(true);
		await until(async () => browser.executeObsidian(() => !!document.querySelector('.crosswalker-save-recipe-modal')), 5_000, 'save dialog');
		const saved = await browser.executeObsidian(async ({ app }, a) => {
			const modal = document.querySelector('.crosswalker-save-recipe-modal');
			const name = modal?.querySelector('.crosswalker-save-recipe-name') as HTMLInputElement | null;
			if (!modal || !name) return { ok: false, reason: 'NO_DIALOG' };
			const prefill = name.value;
			name.value = a.name;
			name.dispatchEvent(new Event('input'));
			const save = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Save') as HTMLButtonElement | undefined;
			if (!save || save.disabled) return { ok: false, reason: 'SAVE_DISABLED', prefill };
			save.click();
			const started = Date.now();
			while (Date.now() - started < 5000 && !(await app.vault.adapter.exists(a.path))) {
				await new Promise((r) => setTimeout(r, 100));
			}
			const exists = await app.vault.adapter.exists(a.path);
			const text = exists ? await app.vault.adapter.read(a.path) : '';
			const notices = Array.from(document.querySelectorAll('.notice')).map((n) => n.textContent?.trim() ?? '');
			return { ok: exists, prefill, recipe: text ? JSON.parse(text).recipe : '', title: text ? JSON.parse(text).metadata?.title : '', notices };
		}, { name: RECIPE_NAME, path: RECIPE_PATH });
		console.log('[recipe-library] saved → ' + JSON.stringify(saved));
		expect(saved.ok).toBe(true);
		expect(saved.prefill).toBe('rl-flow-controls');
		expect(saved.recipe).toBe(RECIPE_ID);
		expect(saved.title).toBe(RECIPE_NAME);
		expect(saved.notices).toContain(`Saved recipe "${RECIPE_NAME}".`);
		// The workbench is now bound to the saved recipe: the footer says so,
		// and an untouched second save offers no Replace (nothing changed).
		await until(async () => browser.executeObsidian((_o, a) => (
			document.querySelector(a.wizard)?.querySelector('button.crosswalker-save-as-recipe')?.textContent?.trim() === `Saved as "${a.name}"`
		), { wizard: WIZARD, name: RECIPE_NAME }), 5_000, 'saved-as footer label');
		expect(await clickButton(`Saved as "${RECIPE_NAME}"`, true)).toBe(true);
		const again = await until(async () => browser.executeObsidian(() => {
			const modal = document.querySelector('.crosswalker-save-recipe-modal');
			if (!modal) return null;
			const result = {
				name: (modal.querySelector('.crosswalker-save-recipe-name') as HTMLInputElement | null)?.value ?? '',
				lineage: modal.querySelector('.crosswalker-save-recipe-lineage')?.textContent ?? '',
				buttons: Array.from(modal.querySelectorAll('button')).map((b) => b.textContent?.trim() ?? ''),
			};
			(modal.querySelector('.crosswalker-save-recipe-cancel') as HTMLElement | null)?.click();
			return result;
		}), 5_000, 'second save dialog');
		console.log('[recipe-library] second save → ' + JSON.stringify(again));
		expect(again.name).toBe(RECIPE_NAME);
		expect(again.lineage).toBe(`Based on your recipe "${RECIPE_NAME}"`);
		expect(again.buttons).toEqual(['Cancel', 'Save']);
		await until(async () => browser.executeObsidian(() => !document.querySelector('.crosswalker-save-recipe-modal')), 3_000, 'second save dialog closed');

		const firstRun = await generate();
		generatedRoot = firstRun.root;
		console.log('[recipe-library] run 1 → ' + JSON.stringify(firstRun));
		await waitForVaultIndexed();
		const first = await managedContent(firstRun.root);
		expect(Object.keys(first).length).toBeGreaterThan(0);

		// -- Reset: close the wizard, remove the generated output, keep the recipe.
		await closeImportWizard();
		await clearAllDrafts();
		await removeOutput(firstRun.root);

		// -- Run 2: Step 1 "Use a saved recipe", pick it, choose the source file.
		await requireImportWizard();
		expect(await clickButton('Use a saved recipe', true)).toBe(true);
		const picked = await until(async () => browser.executeObsidian((_o, id) => {
			const modal = document.querySelector('.crosswalker-recipe-library-modal');
			const card = modal?.querySelector(`[data-recipe-id="${id}"]`);
			if (!card) return null;
			const buttons = Array.from(card.querySelectorAll('.crosswalker-card-actions button')).map((b) => b.textContent?.trim() ?? '');
			const use = Array.from(card.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Use this recipe') as HTMLButtonElement | undefined;
			use?.click();
			return { buttons };
		}, RECIPE_ID), 8_000, 'library picker card');
		expect(picked.buttons).toEqual(['Use this recipe']);
		await until(async () => browser.executeObsidian((_o, wizard) => {
			const text = document.querySelector(wizard)?.textContent ?? '';
			return text.includes('Using your recipe "Flow test recipe". Choose the source file.');
		}, WIZARD), 5_000, 'Step 1 hint line');
		await browser.saveScreenshot(path.join(OUT, 'rl-flow-01-step1-using-recipe.png'));

		expect(await injectSource()).toBe(true);
		await browser.pause(500);
		expect(await clickButton('Next')).toBe(true);
		await until(async () => (await step()) >= 3, 15_000, 'review step from saved recipe');
		const secondMapping = await reviewMapping();
		await browser.saveScreenshot(path.join(OUT, 'rl-flow-02-review-from-recipe.png'));
		console.log('[recipe-library] mapping → ' + JSON.stringify({ first: firstMapping, second: secondMapping }));
		// Every role chosen in run 1 comes back unchanged.
		for (const [column, becomes] of Object.entries(firstMapping)) expect(secondMapping[column]).toBe(becomes);
		// Columns run 1 left to the default (kept as properties) are listed
		// explicitly once the saved recipe is loaded; nothing else may appear.
		for (const [column, becomes] of Object.entries(secondMapping)) {
			if (!(column in firstMapping)) expect(becomes).toBe('properties');
		}
		const provenance = await browser.executeObsidian((_o, wizard) => {
			const prov = document.querySelector(wizard)?.querySelector('.crosswalker-provenance') as HTMLElement | null;
			return { id: prov?.dataset.recipeId ?? '', badge: prov?.querySelector('.crosswalker-prov-badge')?.textContent ?? '' };
		}, WIZARD);
		expect(provenance.id).toBe(RECIPE_ID);
		expect(provenance.badge).toContain('Your recipe');

		const secondRun = await generate();
		console.log('[recipe-library] run 2 → ' + JSON.stringify(secondRun));
		expect(secondRun.root).toBe(firstRun.root);
		await waitForVaultIndexed();
		const second = await managedContent(secondRun.root);
		expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort());
		for (const key of Object.keys(first)) expect(second[key]).toBe(first[key]);
	});
});
