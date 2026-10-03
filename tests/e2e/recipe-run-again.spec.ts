/**
 * recipe-run-again.spec.ts — recipe library slice 2 ("Run again"), end to end.
 *
 * Acceptance cases 1, 2, 3 and 6 on a synthetic CSV:
 *   1. A library recipe run is remembered (closed record, card line).
 *   2. Run again with the same file: set chosen, write policy prefilled, the
 *      "matches the last run" line, and managed content unchanged.
 *   3. Run again with a changed file: the "changed" line, and the same set is
 *      refreshed (no new set minted).
 *   Exit. "Start a new import instead" leaves Run again completely: no set
 *      choice, write policy or recipe from the old run survives it.
 *   6. The set's notes are deleted: Next is disabled with a visible reason,
 *      the card stops offering the run, and the record is pruned.
 *
 *   bun run e2e:xvfb -- --spec tests/e2e/recipe-run-again.spec.ts
 *
 * Every column, id and value here is invented.
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { closeImportWizard, requireImportWizard, clearAllDrafts } from './helpers/wizard-modal';
import { waitForVaultIndexed } from './helpers/vault-readiness';
import { managedContentEquivalent } from '../../src/generation/managed-equivalence';
import { splitNoteText } from '../../src/generation/note-text';

const OUT = path.resolve('test-screenshots');
const WIZARD = '.crosswalker-wizard-modal';
const LIBRARY = '.crosswalker-recipe-library-modal';
const RECIPE_NAME = 'Run again test recipe';
const RECIPE_ID = 'run-again-test-recipe';
const RECIPE_PATH = `_crosswalker/import-recipes/${RECIPE_ID}.json`;
const SOURCE_NAME = 'ra-widgets.csv';
const STALE = 'The set this recipe last ran into is no longer in your vault. Choose "Import as a new set" to run it again.';
const STALE_HINT = 'Choose "Import as a new set" first';
const UPDATED = 'Notes it already owns are updated to match the file. New rows become new notes.';

const ROWS = [
	['WG-1', 'Alpha shelf', 'Invented widget one', 'Invented text for widget one.'],
	['WG-2', 'Alpha shelf', 'Invented widget two', 'Invented text for widget two.'],
	['WG-3', 'Beta shelf', 'Invented widget three', 'Invented text for widget three.'],
	['WG-4', 'Beta shelf', 'Invented widget four', 'Invented text for widget four.'],
];
const csv = (rows: string[][]) => ['widget_ref,shelf,widget_label,widget_text', ...rows.map((r) => r.join(','))].join('\n');
const CSV_V1 = csv(ROWS);
const CSV_V2 = csv(ROWS.map((r) => (r[0] === 'WG-2' ? [r[0], r[1], 'Invented widget two renamed', r[3]] : r)));

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
		const button = Array.from(modal?.querySelectorAll('button') ?? []).find((b) => {
			const text = b.textContent?.trim() ?? '';
			return a.exact ? text === a.label : text.includes(a.label);
		}) as HTMLButtonElement | undefined;
		if (!button || button.disabled) return false;
		button.click();
		return true;
	}, { label, exact, wizard: WIZARD });
}

async function injectSource(content: string): Promise<void> {
	const ok = await browser.executeObsidian((_o, a) => {
		const input = document.querySelector(a.wizard)?.querySelector('input[type=file]') as HTMLInputElement | null;
		if (!input) return false;
		const transfer = new DataTransfer();
		transfer.items.add(new File([a.csv], a.name));
		input.files = transfer.files;
		input.dispatchEvent(new Event('change'));
		return true;
	}, { csv: content, name: SOURCE_NAME, wizard: WIZARD });
	expect(ok).toBe(true);
}

/** Text of the run-again status block in the wizard, or '' when absent. */
async function runAgainStatus(): Promise<{ text: string; classes: string[] }> {
	return browser.executeObsidian((_o, wizard) => {
		const wrap = document.querySelector(wizard)?.querySelector('.crosswalker-run-again-status');
		return {
			text: (wrap?.textContent ?? '').replace(/\s+/g, ' ').trim(),
			classes: Array.from(wrap?.querySelectorAll('p') ?? []).map((p) => p.className),
		};
	}, WIZARD);
}

/** Text of the first element matching `selector` inside the wizard, or ''. */
async function wizardText(selector: string): Promise<string> {
	return browser.executeObsidian((_o, a) => (
		document.querySelector(a.wizard)?.querySelector(a.selector)?.textContent ?? ''
	).replace(/\s+/g, ' ').trim(), { wizard: WIZARD, selector });
}

/** Every Next button in the wizard (top nav and footer), with its state. */
async function nextButtons(): Promise<Array<{ disabled: boolean; title: string }>> {
	return browser.executeObsidian((_o, wizard) => Array.from(document.querySelector(wizard)?.querySelectorAll('button') ?? [])
		.filter((b) => (b.textContent ?? '').includes('Next'))
		.map((b) => ({ disabled: (b as HTMLButtonElement).disabled, title: b.getAttribute('title') ?? '' })), WIZARD);
}

/** The "If files exist" dropdown on the generate step. */
async function overwriteSelect(value?: string): Promise<string> {
	return browser.executeObsidian((_o, a) => {
		const items = Array.from(document.querySelector(a.wizard)?.querySelectorAll('.setting-item') ?? []);
		const item = items.find((i) => i.querySelector('.setting-item-name')?.textContent?.trim() === 'If files exist');
		const select = item?.querySelector('select') as HTMLSelectElement | null;
		if (!select) return 'NO_SELECT';
		if (a.value) {
			select.value = a.value;
			select.dispatchEvent(new Event('change'));
		}
		return select.value;
	}, { wizard: WIZARD, value: value ?? '' });
}

/** The review step's "Import set" dropdown value. */
async function chosenSet(): Promise<string> {
	return browser.executeObsidian((_o, wizard) => {
		const select = document.querySelector(wizard)?.querySelector('.crosswalker-import-set-review select') as HTMLSelectElement | null;
		return select?.value ?? 'NO_SELECT';
	}, WIZARD);
}

async function generateFromStep4(): Promise<string> {
	expect(await clickButton('Generate', true)).toBe(true);
	return until(async () => browser.executeObsidian((_o, wizard) => {
		const modal = document.querySelector(wizard);
		if (!modal) return 'closed';
		const text = modal.querySelector('.crosswalker-results-summary')?.textContent ?? '';
		return text.trim() ? text.replace(/\s+/g, ' ').trim() : null;
	}, WIZARD), 30_000, 'generation');
}

async function readNotes(root: string): Promise<Record<string, string>> {
	return browser.executeObsidian(async ({ app }, prefix) => {
		const out: Record<string, string> = {};
		for (const file of app.vault.getMarkdownFiles()) {
			if (file.path.startsWith(`${prefix}/`)) out[file.path] = await app.vault.read(file);
		}
		return out;
	}, root);
}

/** Parse frontmatter blocks with Obsidian's own YAML parser, once per block. */
async function yamlParser(notes: Array<Record<string, string>>): Promise<(text: string) => unknown> {
	const blocks = [...new Set(notes.flatMap((n) => Object.values(n).map((t) => splitNoteText(t).frontmatterText)))];
	const parsed = await browser.executeObsidian(({ obsidian }, list) => list.map((b) => JSON.stringify(obsidian.parseYaml(b) ?? null)), blocks);
	const table = new Map(blocks.map((b, i) => [b, JSON.parse(parsed[i]) as unknown]));
	return (text: string) => {
		if (!table.has(text)) throw new Error('frontmatter block was not pre-parsed');
		return table.get(text);
	};
}

async function importSetIds(root: string): Promise<string[]> {
	return browser.executeObsidian(({ app }, prefix) => {
		const ids = new Set<string>();
		for (const file of app.vault.getMarkdownFiles()) {
			if (!file.path.startsWith(`${prefix}/`)) continue;
			const id = app.metadataCache.getFileCache(file)?.frontmatter?._crosswalker?.import_set?.id;
			ids.add(typeof id === 'string' ? id : 'MISSING');
		}
		return [...ids];
	}, root);
}

async function settingsRuns(): Promise<Array<Record<string, unknown>>> {
	return browser.executeObsidian(({ app }, id) => {
		// @ts-expect-error — internal plugins API
		const plugin = app.plugins.plugins['crosswalker'];
		return JSON.parse(JSON.stringify((plugin.settings.recipeRuns ?? []).filter((r: { recipeId: string }) => r.recipeId === id)));
	}, RECIPE_ID);
}

async function openLibraryCard(): Promise<{ lastRun: string; actions: string[]; runAgainLabel: string; useLabel: string }> {
	await browser.executeObsidianCommand('crosswalker:browse-import-recipes');
	return until(async () => browser.executeObsidian((_o, a) => {
		const card = document.querySelector(a.library)?.querySelector(`[data-recipe-id="${a.id}"]`);
		if (!card) return null;
		const line = card.querySelector('.crosswalker-recipe-last-run')?.textContent?.trim() ?? '';
		if (line === 'Checking your vault...') return null;
			const buttons = Array.from(card.querySelectorAll('.crosswalker-card-actions button'));
		return {
			lastRun: line,
			actions: buttons.map((b) => b.textContent?.trim() ?? ''),
			runAgainLabel: card.querySelector('button.crosswalker-recipe-run-again')?.getAttribute('aria-label') ?? '',
			useLabel: buttons.find((b) => b.textContent?.trim() === 'Import as a new set')?.getAttribute('aria-label') ?? '',
		};
	}, { library: LIBRARY, id: RECIPE_ID }), 15_000, 'library card resolved');
}

async function closeLibrary(): Promise<void> {
	await browser.executeObsidian((_o, library) => {
		document.querySelectorAll(`${library} .modal-close-button, ${library} .modal-header-button`).forEach((b) => (b as HTMLElement).click());
	}, LIBRARY);
	await until(async () => browser.executeObsidian((_o, library) => !document.querySelector(library), LIBRARY), 3_000, 'library closed');
}

/** Click the card's primary Run again and wait for the wizard it opens. */
async function runAgainFromLibrary(): Promise<string> {
	const clicked = await browser.executeObsidian((_o, a) => {
		const card = document.querySelector(a.library)?.querySelector(`[data-recipe-id="${a.id}"]`);
		const button = card?.querySelector('button.crosswalker-recipe-run-again') as HTMLButtonElement | null;
		if (!button) return false;
		button.click();
		return true;
	}, { library: LIBRARY, id: RECIPE_ID });
	expect(clicked).toBe(true);
	return until(async () => browser.executeObsidian((_o, a) => {
		if (document.querySelector(a.library)) return null;
		const modal = document.querySelector(a.wizard);
		return modal ? (modal.textContent ?? '').replace(/\s+/g, ' ') : null;
	}, { library: LIBRARY, wizard: WIZARD }), 8_000, 'run again wizard');
}

async function removePath(target: string | null): Promise<void> {
	await browser.executeObsidian(async ({ app }, p) => {
		if (!p) return;
		const file = app.vault.getAbstractFileByPath(p);
		if (file) await app.vault.delete(file, true);
		else if (await app.vault.adapter.exists(p)) await app.vault.adapter.remove(p);
	}, target);
}

async function clearRuns(): Promise<void> {
	await browser.executeObsidian(async ({ app }, id) => {
		// @ts-expect-error — internal plugins API
		const plugin = app.plugins.plugins['crosswalker'];
		if (!plugin) return;
		plugin.settings.recipeRuns = (plugin.settings.recipeRuns ?? []).filter((r: { recipeId: string }) => r.recipeId !== id);
		await plugin.saveSettings();
	}, RECIPE_ID);
}

let root: string | null = null;
let setId = '';
/** The set's readable name, as the library card shows it. */
let setName = '';

describe('Recipe library: Run again', function () {
	this.timeout(300_000);

	before(async () => {
		mkdirSync(OUT, { recursive: true });
		await closeImportWizard();
		await clearAllDrafts();
		await waitForVaultIndexed();
		await removePath(RECIPE_PATH);
		await clearRuns();
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
		await browser.executeObsidian((_o, library) => {
			document.querySelectorAll(`${library} .modal-close-button, ${library} .modal-header-button`).forEach((b) => (b as HTMLElement).click());
		}, LIBRARY);
		await closeImportWizard();
		await removePath(root);
		await removePath(RECIPE_PATH);
		await clearRuns();
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

	it('remembers a library recipe run (case 1)', async () => {
		await requireImportWizard();
		await injectSource(CSV_V1);
		await browser.pause(500);
		expect(await clickButton('Next')).toBe(true);
		await until(async () => (await step()) >= 2, 15_000, 'workbench step');
		expect(await clickButton('Next')).toBe(true);
		await until(async () => (await step()) >= 3, 15_000, 'review step');

		expect(await clickButton('Save as recipe', true)).toBe(true);
		const saved = await browser.executeObsidian(async ({ app }, a) => {
			const started = Date.now();
			while (Date.now() - started < 5000 && !document.querySelector('.crosswalker-save-recipe-modal')) await new Promise((r) => setTimeout(r, 100));
			const modal = document.querySelector('.crosswalker-save-recipe-modal');
			const name = modal?.querySelector('.crosswalker-save-recipe-name') as HTMLInputElement | null;
			if (!modal || !name) return false;
			name.value = a.name;
			name.dispatchEvent(new Event('input'));
			(Array.from(modal.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Save') as HTMLButtonElement).click();
			while (Date.now() - started < 10000 && !(await app.vault.adapter.exists(a.path))) await new Promise((r) => setTimeout(r, 100));
			return app.vault.adapter.exists(a.path);
		}, { name: RECIPE_NAME, path: RECIPE_PATH });
		expect(saved).toBe(true);
		await until(async () => browser.executeObsidian(() => !document.querySelector('.crosswalker-save-recipe-modal')), 5_000, 'save dialog closed');

		expect(await clickButton('Next')).toBe(true);
		await until(async () => (await step()) >= 4, 15_000, 'generate step');
		expect(await overwriteSelect('replace')).toBe('replace');
		root = await browser.executeObsidian((_o, wizard) => (
			document.querySelector(wizard)?.querySelector('.crosswalker-gen-confirm .mono')?.textContent ?? ''
		).trim(), WIZARD);
		expect(root).not.toBe('');
		const summary = await generateFromStep4();
		console.log('[run-again] run 1 → ' + JSON.stringify({ summary, root }));
		await waitForVaultIndexed();

		const runs = await settingsRuns();
		console.log('[run-again] record → ' + JSON.stringify(runs));
		expect(runs).toHaveLength(1);
		const record = runs[0];
		expect(Object.keys(record).sort()).toEqual(['finishedAt', 'importSetId', 'overwriteMode', 'recipeDocumentDigest', 'recipeId', 'source', 'sourceCopy']);
		expect(record.overwriteMode).toBe('replace');
		expect(record.sourceCopy).toBe('none');
		expect(record.recipeDocumentDigest).toMatch(/^sha256-[a-f0-9]{64}$/);
		expect((record.source as { name: string }).name).toBe(SOURCE_NAME);
		expect((record.source as { digest?: string }).digest).toMatch(/^sha256-/);
		const ids = await importSetIds(root!);
		expect(ids).toHaveLength(1);
		setId = ids[0];
		expect(record.importSetId).toBe(setId);
		await closeImportWizard();

		const card = await openLibraryCard();
		const leaf = root!.split('/').filter(Boolean).pop()!;
		const prefix = `Last run ${new Date(record.finishedAt as string).toLocaleDateString()} into `;
		expect(card.lastRun.startsWith(prefix)).toBe(true);
		setName = card.lastRun.slice(prefix.length);
		expect(setName.endsWith(leaf)).toBe(true);
		expect(card.lastRun).not.toContain('iset-');
		expect(card.lastRun).not.toContain(root!);
		// The button beside Run again says it leaves existing notes alone.
		expect(card.actions.slice(0, 2)).toEqual(['Run again', 'Import as a new set']);
		expect(card.runAgainLabel).toBe(`Refresh ${setName} with a new copy of the source file`);
		expect(card.useLabel).toBe('Start a new import set with this recipe. Your existing notes are not touched.');
		await closeLibrary();
	});

	it('runs again with the same file and leaves managed content unchanged (case 2)', async () => {
		const before = await readNotes(root!);
		const firstRecord = (await settingsRuns())[0];
		await openLibraryCard();
		const opened = await runAgainFromLibrary();
		// Before any file is picked, Step 1 names the recipe, the set and the effect.
		const lead = await wizardText('.crosswalker-run-again-lead-line');
		expect(lead).toMatch(new RegExp(`^Running "${RECIPE_NAME}" again into ${setName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+ notes?\\)\\. `));
		expect(lead.endsWith(UPDATED)).toBe(true);
		expect(opened).toContain(`Choose the source file for this run. Last time it was ${SOURCE_NAME}. Crosswalker does not keep a copy of your source.`);
		// First-import help and presets are gone; the only way out is a real exit.
		expect(opened).not.toContain('Need a source file');
		expect(opened).not.toContain('Use a saved recipe');
		expect(opened).toContain('Start a new import instead');
		expect(await wizardText('h3')).toBe('Run again');

		await injectSource(CSV_V1);
		const status = await until(async () => {
			const s = await runAgainStatus();
			return s.classes.some((c) => c.includes('crosswalker-run-again-same')) ? s : null;
		}, 10_000, 'matches line on Step 1');
		const date = new Date(firstRecord.finishedAt as string).toLocaleDateString();
		expect(status.text).toContain(`This file matches the last run on ${date}. Running again adds nothing new; it only puts back fields this recipe fills if someone edited them.`);
		// The file card says which recipe reads the file, not the generic "how".
		expect(await wizardText('.crosswalker-file-card-how')).toBe(`Read with your recipe "${RECIPE_NAME}".`);
		expect(await step()).toBe(1);
		await browser.saveScreenshot(path.join(OUT, 'rra-01-step1-matches.png'));

		expect(await clickButton('Next')).toBe(true);
		await until(async () => (await step()) >= 3, 15_000, 'review step');
		expect((await runAgainStatus()).text).toContain('This file matches the last run');
		expect(await chosenSet()).toBe(setId);
		const refreshing = await wizardText('.crosswalker-import-set-refreshing');
		expect(refreshing).toMatch(/^Refreshing .+ \(\d+ notes? it already owns\)\. You chose this set with Run again\.$/);
		expect(refreshing).toContain(`Refreshing ${setName} (`);
		expect(refreshing).not.toContain('iset-');
		// The set list names the saved recipe that made the set, not "an unsaved recipe".
		expect(await wizardText('.crosswalker-import-set-review ul')).toMatch(new RegExp(`${setName}: \\d+ notes?, made by "${RECIPE_NAME}"`));
		expect(await clickButton('Next')).toBe(true);
		await until(async () => (await step()) >= 4, 15_000, 'generate step');
		expect(await overwriteSelect()).toBe('replace');
		// Step 4 says refreshing, by name, and where.
		expect(await wizardText('.crosswalker-ready-to-refresh')).toBe(`Ready to refresh ${setName}. ${UPDATED}`);
		expect(await wizardText('.crosswalker-gen-confirm-lead')).toBe('Refreshing into:');
		await browser.saveScreenshot(path.join(OUT, 'rra-04-step4-refresh.png'));
		console.log('[run-again] run 2 → ' + await generateFromStep4());
		await waitForVaultIndexed();

		const after = await readNotes(root!);
		expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
		const parseYaml = await yamlParser([before, after]);
		for (const file of Object.keys(before)) {
			const result = managedContentEquivalent(before[file], after[file], { parseYaml });
			expect({ file, ...result }).toEqual({ file, equal: true, differences: [] });
		}
		expect(await importSetIds(root!)).toEqual([setId]);
		const runs = await settingsRuns();
		expect(runs).toHaveLength(1);
		expect(Date.parse(runs[0].finishedAt as string)).toBeGreaterThanOrEqual(Date.parse(firstRecord.finishedAt as string));
		await closeImportWizard();
	});

	it('runs again with a changed file and refreshes the same set (case 3)', async () => {
		const before = await readNotes(root!);
		await openLibraryCard();
		await runAgainFromLibrary();
		await injectSource(CSV_V2);
		const status = await until(async () => {
			const s = await runAgainStatus();
			return s.classes.some((c) => c.includes('crosswalker-run-again-changed')) ? s : null;
		}, 10_000, 'changed line on Step 1');
		expect(status.text).toMatch(/^This file changed since the last run on .+\. Notes in .+ will be updated to match it\.$/);
		expect(status.text).toContain(`Notes in ${setName} will be updated`);
		expect(status.text).not.toContain('Any sheet counts');
		await browser.saveScreenshot(path.join(OUT, 'rra-02-step1-changed.png'));

		expect(await clickButton('Next')).toBe(true);
		await until(async () => (await step()) >= 3, 15_000, 'review step');
		expect(await chosenSet()).toBe(setId);
		expect(await clickButton('Next')).toBe(true);
		await until(async () => (await step()) >= 4, 15_000, 'generate step');
		console.log('[run-again] run 3 → ' + await generateFromStep4());
		await waitForVaultIndexed();

		const after = await readNotes(root!);
		expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
		expect(await importSetIds(root!)).toEqual([setId]);
		const parseYaml = await yamlParser([before, after]);
		const changed = Object.keys(before).filter((f) => !managedContentEquivalent(before[f], after[f], { parseYaml }).equal);
		expect(changed.length).toBeGreaterThan(0);
		expect(Object.values(after).some((t) => t.includes('Invented widget two renamed'))).toBe(true);
		await closeImportWizard();
	});

	it('leaves Run again completely when the user starts a new import instead', async () => {
		await openLibraryCard();
		await runAgainFromLibrary();
		await injectSource(CSV_V1);
		await until(async () => (await runAgainStatus()).classes.length > 0, 10_000, 'status after parse');
		expect(await clickButton('Start a new import instead', true)).toBe(true);
		await until(async () => (await wizardText('h3')) === 'Select source file', 5_000, 'plain Step 1');
		expect(await wizardText('.crosswalker-run-again-lead')).toBe('');
		expect((await runAgainStatus()).text).toBe('');
		expect(await wizardText('.crosswalker-file-card-how')).not.toContain(RECIPE_NAME);
		expect(await wizardText('.crosswalker-saved-recipe-row')).toContain('Use a saved recipe');

		// The file is recognised as matching the saved recipe, which is offered,
		// not applied. Taking it is a new choice, so no set choice from the old
		// run survives: the review defaults to a new set, and the old run's write
		// policy is gone.
		expect(await clickButton('Next')).toBe(true);
		await until(async () => (await wizardText('.crosswalker-recognized-actions')).includes('Use this recipe'), 15_000, 'recipe offered');
		expect(await step()).toBe(1);
		expect(await clickButton('Use this recipe', true)).toBe(true);
		await until(async () => (await step()) >= 3, 15_000, 'review step');
		await until(async () => (await chosenSet()) !== 'NO_SELECT', 10_000, 'set dropdown');
		expect(await chosenSet()).toBe('__new__');
		expect(await wizardText('.crosswalker-import-set-refreshing')).toBe('');
		// A new set cannot land on the folder the old set owns; the refusal
		// names that set the way the library card does, never by its id.
		const reviewText = await wizardText('.crosswalker-import-set-review');
		expect(reviewText).toContain(`already holds notes from the import set ${setName}.`);
		expect(reviewText).not.toContain(setId);
		await closeImportWizard();
		expect(await importSetIds(root!)).toEqual([setId]);
	});

	it('blocks a stale Run again, then drops the run from the card (case 6)', async () => {
		await openLibraryCard();
		await runAgainFromLibrary();
		await injectSource(CSV_V1);
		await until(async () => (await runAgainStatus()).classes.length > 0, 10_000, 'status after parse');

		// The set is deleted between the click and generation.
		await removePath(root);
		await waitForVaultIndexed();
		expect(await clickButton('Next')).toBe(true);
		await until(async () => (await step()) >= 3, 15_000, 'review step');
		const review = await until(async () => browser.executeObsidian((_o, wizard) => {
			const wrap = document.querySelector(wizard)?.querySelector('.crosswalker-import-set-review');
			if (!wrap) return null;
			return {
				warning: wrap.querySelector('.crosswalker-warning')?.textContent ?? '',
				buttons: Array.from(wrap.querySelectorAll('button')).map((b) => b.textContent?.trim() ?? ''),
			};
		}, WIZARD), 10_000, 'stale review');
		console.log('[run-again] stale review → ' + JSON.stringify(review));
		expect(review.warning).toBe(STALE);
		expect(review.buttons).toContain('Import as a new set');
		// The warning leads: no "file changed" line describes a refresh that cannot happen.
		expect((await runAgainStatus()).text).toBe('');
		// The dropdown agrees with the warning: it does not read "new set".
		expect(await chosenSet()).toBe('__missing__');
		// Next is disabled, and says why, in the button and in the footer.
		const blockedNext = await nextButtons();
		expect(blockedNext.length).toBeGreaterThan(0);
		expect(blockedNext.every((b) => b.disabled && b.title === STALE_HINT)).toBe(true);
		expect(await wizardText('.crosswalker-footer-hint')).toBe(STALE_HINT);
		await browser.executeObsidian((_o, wizard) => {
			document.querySelector(wizard)?.querySelector('.crosswalker-import-set-review')?.scrollIntoView({ block: 'center' });
		}, WIZARD);
		await browser.saveScreenshot(path.join(OUT, 'rra-03-review-stale.png'));

		// Generation must not write anything into a set that is gone.
		expect(await clickButton('Next')).toBe(false);
		expect(await step()).toBe(3);
		expect(Object.keys(await readNotes(root!))).toEqual([]);

		// Choosing a new set is the way forward, and it unblocks Next.
		expect(await clickButton('Import as a new set', true)).toBe(true);
		await until(async () => (await chosenSet()) === '__new__', 5_000, 'new set chosen');
		expect((await nextButtons()).every((b) => !b.disabled)).toBe(true);
		expect(await wizardText('.crosswalker-footer-hint')).toBe('');
		await closeImportWizard();

		const card = await openLibraryCard();
		expect(card.lastRun).toBe('');
		expect(card.actions).not.toContain('Run again');
		await until(async () => (await settingsRuns()).length === 0, 10_000, 'record pruned');
		await closeLibrary();
	});
});
