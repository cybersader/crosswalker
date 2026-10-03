/**
 * replay-proof-nist.spec.ts — full-source replay proof through the real UI.
 *
 * For each NIST source: import with the wizard (recognized built-in recipe),
 * save it as a library recipe, close and reopen Browse import recipes, click
 * Run again on the card, pick the same file, Generate. Then read every note
 * from disk and assert:
 *   1. the note path set is unchanged;
 *   2. managed content is equivalent for every note (managedContentEquivalent);
 *   3. every note stamps the saved recipe's document digest;
 *   4. the import set id is unchanged.
 *
 * Opt-in (full sources, minutes of work):
 *   CW_SCALE=1 bun run e2e:xvfb -- --spec tests/e2e/replay-proof-nist.spec.ts
 *
 * The NIST files are read at runtime only. This spec asserts aggregate counts
 * and computed equality; it never embeds rows, ids or prose from them.
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { closeImportWizard, requireImportWizard, clearAllDrafts } from './helpers/wizard-modal';
import { waitForVaultIndexed } from './helpers/vault-readiness';
import { managedContentEquivalent } from '../../src/generation/managed-equivalence';
import { splitNoteText } from '../../src/generation/note-text';
import { recipeRunDigest } from '../../src/import/recipe-runs';
import type { CrosswalkerImportRecipe } from '../../src/types/generated/recipe';

const RUN_SCALE = process.env.CW_SCALE === '1';
const describeScale = RUN_SCALE ? describe : describe.skip;

const OUT = path.resolve('test-screenshots');
const WIZARD = '.crosswalker-wizard-modal';
const LIBRARY = '.crosswalker-recipe-library-modal';
const LIBRARY_FOLDER = '_crosswalker/import-recipes';
const NAME_PREFIX = 'Replay proof';
const GENERATE_TIMEOUT_MS = 300_000;

interface Source {
	label: string;
	file: string;
	sheet: string | null;
	recipeName: string;
	/** Notes the full source produces (leg A counts the same sources). */
	expectedNotes: number;
}

const SOURCES: Source[] = [
	{ label: 'NIST CSF 2.0', file: 'Frameworks/csf2.xlsx', sheet: 'CSF 2.0', recipeName: `${NAME_PREFIX} CSF 2`, expectedNotes: 185 },
	{ label: 'NIST SP 800-53 Rev 5', file: 'Frameworks/NIST_SP-800-53_rev5_catalog_load.csv', sheet: null, recipeName: `${NAME_PREFIX} 800-53`, expectedNotes: 1189 },
];

function metric(name: string, value: string | number): void {
	console.log(`CW_SCALE_METRIC ${name}=${value}`);
}

async function until<T>(read: () => Promise<T | null | false>, ms: number, label: string): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = await read();
		if (value) return value as T;
		if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${label}`);
		await browser.pause(250);
	}
}

async function step(): Promise<number> {
	return browser.executeObsidian((_o, wizard) => {
		const text = document.querySelector(wizard)?.querySelector('.crosswalker-step-indicator')?.textContent ?? '';
		return Number(/Step (\d+)/.exec(text)?.[1] ?? -1);
	}, WIZARD);
}

async function clickButton(label: string, exact = false, scope = WIZARD): Promise<boolean> {
	return browser.executeObsidian((_o, a) => {
		const modal = document.querySelector(a.scope);
		const button = Array.from(modal?.querySelectorAll('button') ?? []).find((b) => {
			const text = b.textContent?.trim() ?? '';
			return a.exact ? text === a.label : text.includes(a.label);
		}) as HTMLButtonElement | undefined;
		if (!button || button.disabled) return false;
		button.click();
		return true;
	}, { label, exact, scope });
}

/** Hand the wizard the real source bytes, as a file picker would. */
async function injectSource(source: Source): Promise<void> {
	const base64 = readFileSync(path.resolve(source.file)).toString('base64');
	const ok = await browser.executeObsidian((_o, a) => {
		const input = document.querySelector(a.wizard)?.querySelector('input[type=file]') as HTMLInputElement | null;
		if (!input) return false;
		const binary = atob(a.base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		const transfer = new DataTransfer();
		transfer.items.add(new File([bytes], a.name));
		input.files = transfer.files;
		input.dispatchEvent(new Event('change'));
		return true;
	}, { base64, name: path.basename(source.file), wizard: WIZARD });
	expect(ok).toBe(true);
}

/** For a workbook, wait for the sheet picker and return its chosen sheet. */
async function chosenSheet(): Promise<string> {
	return until(async () => browser.executeObsidian((_o, wizard) => {
		const select = document.querySelector(wizard)?.querySelector('select') as HTMLSelectElement | null;
		return select?.value || null;
	}, WIZARD), 20_000, 'sheet picker');
}

async function runAgainClasses(): Promise<string[]> {
	return browser.executeObsidian((_o, wizard) => Array.from(
		document.querySelector(wizard)?.querySelectorAll('.crosswalker-run-again-status p') ?? [],
	).map((p) => p.className), WIZARD);
}

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
	}, WIZARD), GENERATE_TIMEOUT_MS, 'generation');
}

/** Read every note under `root` straight from disk (adapter, not the cache). */
async function readNotes(root: string): Promise<Record<string, string>> {
	return browser.executeObsidian(async ({ app }, prefix) => {
		const out: Record<string, string> = {};
		for (const file of app.vault.getMarkdownFiles()) {
			if (file.path.startsWith(`${prefix}/`)) out[file.path] = await app.vault.adapter.read(file.path);
		}
		return out;
	}, root);
}

async function yamlParser(notes: Array<Record<string, string>>): Promise<(text: string) => unknown> {
	const blocks = [...new Set(notes.flatMap((n) => Object.values(n).map((t) => splitNoteText(t).frontmatterText)))];
	const parsed = await browser.executeObsidian(({ obsidian }, list) => list.map((b) => JSON.stringify(obsidian.parseYaml(b) ?? null)), blocks);
	const table = new Map(blocks.map((b, i) => [b, JSON.parse(parsed[i]) as unknown]));
	return (text: string) => {
		if (!table.has(text)) throw new Error('frontmatter block was not pre-parsed');
		return table.get(text);
	};
}

function crosswalker(text: string, parseYaml: (t: string) => unknown): Record<string, any> {
	const fm = parseYaml(splitNoteText(text).frontmatterText) as Record<string, any> | null;
	return (fm?._crosswalker ?? {}) as Record<string, any>;
}

async function settingsRuns(recipeId: string): Promise<Array<Record<string, unknown>>> {
	return browser.executeObsidian(({ app }, id) => {
		// @ts-expect-error — internal plugins API
		const plugin = app.plugins.plugins['crosswalker'];
		return JSON.parse(JSON.stringify((plugin.settings.recipeRuns ?? []).filter((r: { recipeId: string }) => r.recipeId === id)));
	}, recipeId);
}

async function libraryFiles(): Promise<string[]> {
	return browser.executeObsidian(async ({ app }, folder) => {
		if (!(await app.vault.adapter.exists(folder))) return [];
		return (await app.vault.adapter.list(folder)).files;
	}, LIBRARY_FOLDER);
}

async function openLibraryCard(recipeId: string): Promise<string[]> {
	await browser.executeObsidianCommand('crosswalker:browse-import-recipes');
	return until(async () => browser.executeObsidian((_o, a) => {
		const card = document.querySelector(a.library)?.querySelector(`[data-recipe-id="${a.id}"]`);
		if (!card) return null;
		const line = card.querySelector('.crosswalker-recipe-last-run')?.textContent?.trim() ?? '';
		if (line === 'Checking your vault...') return null;
		return Array.from(card.querySelectorAll('.crosswalker-card-actions button')).map((b) => b.textContent?.trim() ?? '');
	}, { library: LIBRARY, id: recipeId }), 30_000, 'library card resolved');
}

async function closeLibrary(): Promise<void> {
	await browser.executeObsidian((_o, library) => {
		document.querySelectorAll(`${library} .modal-close-button, ${library} .modal-header-button`).forEach((b) => (b as HTMLElement).click());
	}, LIBRARY);
	await until(async () => browser.executeObsidian((_o, library) => !document.querySelector(library), LIBRARY), 5_000, 'library closed');
}

async function runAgainFromLibrary(recipeId: string): Promise<void> {
	const clicked = await browser.executeObsidian((_o, a) => {
		const card = document.querySelector(a.library)?.querySelector(`[data-recipe-id="${a.id}"]`);
		const button = card?.querySelector('button.crosswalker-recipe-run-again') as HTMLButtonElement | null;
		if (!button) return false;
		button.click();
		return true;
	}, { library: LIBRARY, id: recipeId });
	expect(clicked).toBe(true);
	await until(async () => browser.executeObsidian((_o, a) => !document.querySelector(a.library) && !!document.querySelector(a.wizard), { library: LIBRARY, wizard: WIZARD }), 10_000, 'run again wizard');
}

async function removePath(target: string | null): Promise<void> {
	await browser.executeObsidian(async ({ app }, p) => {
		if (!p) return;
		const file = app.vault.getAbstractFileByPath(p);
		if (file) await app.vault.delete(file, true);
		else if (await app.vault.adapter.exists(p)) await app.vault.adapter.remove(p);
	}, target);
}

/** Remove recipes this spec saved earlier (by name) and their run records. */
async function clearProofRecipes(): Promise<void> {
	await browser.executeObsidian(async ({ app }, a) => {
		const ids: string[] = [];
		if (await app.vault.adapter.exists(a.folder)) {
			for (const file of (await app.vault.adapter.list(a.folder)).files) {
				try {
					const recipe = JSON.parse(await app.vault.adapter.read(file));
					const name = String(recipe?.metadata?.title ?? '');
					if (name.startsWith(a.prefix)) {
						ids.push(String(recipe.recipe));
						await app.vault.adapter.remove(file);
					}
				} catch { /* not ours */ }
			}
		}
		// @ts-expect-error — internal plugins API
		const plugin = app.plugins.plugins['crosswalker'];
		if (!plugin) return;
		plugin.settings.recipeRuns = (plugin.settings.recipeRuns ?? []).filter((r: { recipeId: string }) => !ids.includes(r.recipeId));
		await plugin.saveSettings();
	}, { folder: LIBRARY_FOLDER, prefix: NAME_PREFIX });
}

async function trashFolder(folder: string): Promise<boolean> {
	return browser.executeObsidian(async ({ app }, target) => {
		const root = app.vault.getAbstractFileByPath(target);
		// @ts-expect-error - internal trash API, isolated E2E vault only
		if (root) await app.vault.trash(root, false);
		const deadline = Date.now() + 30_000;
		while (app.vault.getAbstractFileByPath(target) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return !app.vault.getAbstractFileByPath(target);
	}, folder);
}

const roots: string[] = [];

describeScale('Replay proof: full NIST sources through the UI', function () {
	this.timeout(1_200_000);

	before(async () => {
		mkdirSync(OUT, { recursive: true });
		await closeImportWizard();
		await clearAllDrafts();
		await waitForVaultIndexed();
		// The e2e vault is a throwaway copy of the seed vault; clear seeded framework
		// notes so the recognized destination starts empty.
		expect(await trashFolder('Frameworks')).toBe(true);
		await clearProofRecipes();
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
		for (const root of roots) await removePath(root);
		await clearProofRecipes();
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

	for (const source of SOURCES) {
		it(`replays ${source.label}: save, reopen, Run again, same file`, async () => {
			const key = source.label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
			const started = Date.now();

			// --- Run 1: wizard, recognized built-in recipe, Save as recipe, Generate.
			await requireImportWizard();
			await injectSource(source);
			if (source.sheet) expect(await chosenSheet()).toBe(source.sheet);
			await browser.pause(500);
			expect(await clickButton('Next')).toBe(true);
			const recognized = await until(async () => browser.executeObsidian((_o, wizard) => {
				const modal = document.querySelector(wizard);
				const title = modal?.querySelector('.crosswalker-recognized-title')?.textContent?.trim() ?? '';
				return modal?.querySelector('.crosswalker-recognized-actions') ? title || 'untitled' : null;
			}, WIZARD), 60_000, 'recognized recipe card');
			console.log(`[replay-proof] ${source.label} recognized as: ${recognized}`);
			expect(await clickButton('Import with this configuration', false, '.crosswalker-recognized-actions')).toBe(true);
			await until(async () => (await step()) >= 3, 30_000, 'review step');

			const libraryBefore = new Set(await libraryFiles());
			expect(await clickButton('Save as recipe', true)).toBe(true);
			const saved = await browser.executeObsidian(async () => {
				const started = Date.now();
				while (Date.now() - started < 5000 && !document.querySelector('.crosswalker-save-recipe-modal')) await new Promise((r) => setTimeout(r, 100));
				return !!document.querySelector('.crosswalker-save-recipe-modal .crosswalker-save-recipe-name');
			});
			expect(saved).toBe(true);
			await browser.executeObsidian((_o, name) => {
				const modal = document.querySelector('.crosswalker-save-recipe-modal')!;
				const input = modal.querySelector('.crosswalker-save-recipe-name') as HTMLInputElement;
				input.value = name;
				input.dispatchEvent(new Event('input'));
				(Array.from(modal.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Save') as HTMLButtonElement).click();
			}, source.recipeName);
			const recipePath = await until(async () => {
				const added = (await libraryFiles()).filter((f) => !libraryBefore.has(f) && f.endsWith('.json'));
				return added.length === 1 ? added[0] : null;
			}, 15_000, 'saved recipe file');
			await until(async () => browser.executeObsidian(() => !document.querySelector('.crosswalker-save-recipe-modal')), 5_000, 'save dialog closed');
			const savedRecipe = JSON.parse(await browser.executeObsidian(({ app }, p) => app.vault.adapter.read(p), recipePath)) as CrosswalkerImportRecipe;
			const recipeId = savedRecipe.recipe;
			const savedDigest = recipeRunDigest(savedRecipe);
			expect(savedDigest).toMatch(/^sha256-[a-f0-9]{64}$/);
			console.log(`[replay-proof] ${source.label} saved recipe id=${recipeId} digest=${savedDigest}`);

			expect(await clickButton('Next')).toBe(true);
			await until(async () => (await step()) >= 4, 30_000, 'generate step');
			expect(await overwriteSelect('replace')).toBe('replace');
			const root = await browser.executeObsidian((_o, wizard) => (
				document.querySelector(wizard)?.querySelector('.crosswalker-gen-confirm .mono')?.textContent ?? ''
			).trim(), WIZARD);
			expect(root).not.toBe('');
			roots.push(root);
			const t1 = Date.now();
			const summary1 = await generateFromStep4();
			metric(`${key}_ui_run1_seconds`, ((Date.now() - t1) / 1000).toFixed(1));
			console.log(`[replay-proof] ${source.label} run 1 → ${summary1}`);
			await closeImportWizard();
			await waitForVaultIndexed({ timeoutMs: 180_000 });

			const runs1 = await settingsRuns(recipeId);
			expect(runs1).toHaveLength(1);
			const record = runs1[0];
			expect(record.overwriteMode).toBe('replace');
			expect(record.recipeDocumentDigest).toBe(savedDigest);
			const setId = String(record.importSetId);
			expect(setId).toMatch(/\S/);
			const before = await readNotes(root);
			const notes = Object.keys(before).length;
			metric(`${key}_ui_note_count`, notes);
			expect(notes).toBe(source.expectedNotes);

			// --- Close and reopen Browse import recipes, then Run again on the card.
			const firstActions = await openLibraryCard(recipeId);
			expect(firstActions).toContain('Run again');
			await closeLibrary();
			await openLibraryCard(recipeId);
			await runAgainFromLibrary(recipeId);
			await injectSource(source);
			await until(async () => (await runAgainClasses()).some((c) => c.includes('crosswalker-run-again-same')), 60_000, 'same-file status');
			if (source.sheet) expect(await chosenSheet()).toBe(source.sheet);
			expect(await clickButton('Next')).toBe(true);
			await until(async () => (await step()) >= 3, 60_000, 'review step (run again)');
			expect(await chosenSet()).toBe(setId);
			expect(await clickButton('Next')).toBe(true);
			await until(async () => (await step()) >= 4, 30_000, 'generate step (run again)');
			expect(await overwriteSelect()).toBe('replace');
			const t2 = Date.now();
			const summary2 = await generateFromStep4();
			metric(`${key}_ui_run2_seconds`, ((Date.now() - t2) / 1000).toFixed(1));
			console.log(`[replay-proof] ${source.label} run 2 → ${summary2}`);
			await closeImportWizard();
			await waitForVaultIndexed({ timeoutMs: 180_000 });

			// --- The four replay properties, read from disk.
			const after = await readNotes(root);
			expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
			const parseYaml = await yamlParser([before, after]);
			const userPreserve = savedRecipe.target.also_emit?.frontmatter?.user_preserve ?? [];
			const nonEquivalent: Array<{ file: string; differences: unknown }> = [];
			const wrongDigest: string[] = [];
			const setIds = new Set<string>();
			for (const file of Object.keys(before)) {
				const result = managedContentEquivalent(before[file], after[file], { parseYaml, userPreserve });
				if (!result.equal) nonEquivalent.push({ file, differences: result.differences });
				const cw = crosswalker(after[file], parseYaml);
				if (cw.recipe?.recipe_document_digest !== savedDigest) wrongDigest.push(file);
				setIds.add(String(cw.import_set?.id ?? 'MISSING'));
			}
			metric(`${key}_ui_non_equivalent`, nonEquivalent.length);
			metric(`${key}_ui_wrong_digest`, wrongDigest.length);
			expect(nonEquivalent.slice(0, 3)).toEqual([]);
			expect(wrongDigest.length).toBe(0);
			expect([...setIds]).toEqual([setId]);

			const runs2 = await settingsRuns(recipeId);
			expect(runs2).toHaveLength(1);
			expect(runs2[0].importSetId).toBe(setId);
			expect(runs2[0].recipeDocumentDigest).toBe(savedDigest);
			metric(`${key}_ui_total_seconds`, ((Date.now() - started) / 1000).toFixed(1));
		});
	}
});
