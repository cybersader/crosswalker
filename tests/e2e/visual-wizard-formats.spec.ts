/**
 * visual-wizard-formats.spec.ts — the import wizard's XLSX + JSON paths,
 * driven through the REAL UI (2026-06-12, UI-parity gap #1).
 *
 * Each test opens the wizard command, injects a File into the actual
 * <input type=file> via DataTransfer, exercises the new Step-1 controls
 * (sheet picker / iterator + filter inputs), clicks "Next →" so the real
 * parseFile() runs, and screenshots Step 2 showing detected columns.
 *
 *   DISPLAY=:0 bun run e2e -- --spec tests/e2e/visual-wizard-formats.spec.ts
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { installWizardObservation, readWizardObservation, stopWizardObservation } from './helpers/wizard-observation';
import * as XLSX from 'xlsx';
import { closeImportWizard, requireImportWizard, clearAllDrafts } from './helpers/wizard-modal';
import { readFrontmatterMatching, waitForVaultIndexed } from './helpers/vault-readiness';
import {
  finishWizardWithDriver,
  type WizardFinishOutcome,
  type WizardGenerationSnapshot,
} from './helpers/wizard-generation-outcome';

/**
 * Selector for the live wizard. Every query below is scoped to this element
 * rather than to the first generic `.modal` in the document — three of this
 * spec's declarations failed because that first modal was a stale leftover from
 * an earlier open/close cycle (triage 2026-08-24 §4 B3–B5). `requireImportWizard()`
 * guarantees at most one connected wizard before each declaration, so a bare
 * `querySelector` on this class is unambiguous.
 */
const WIZARD = '.crosswalker-wizard-modal';

const OUT = path.resolve('test-screenshots');

/** Small two-sheet workbook (banner sheet first → exercises the picker). */
function makeWorkbookB64(): string {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['About this workbook']]), 'Intro');
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['id', 'title', 'family'],
      ['AC-1', 'Policy and procedures', 'AC'],
      ['AC-2', 'Account management', 'AC'],
      ['AU-1', 'Audit policy', 'AU'],
    ]),
    'Controls',
  );
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }) as string;
}

const STIX_JSON = JSON.stringify({
  objects: [
    { type: 'attack-pattern', name: 'Process Injection', x_mitre_is_subtechnique: false },
    { type: 'attack-pattern', name: 'Old Technique', revoked: true },
    { type: 'relationship', source_ref: 'x', target_ref: 'y' },
  ],
});

/** Open a FRESH wizard, inject a file, tweak Step-1 controls, advance to Step 2.
 *
 *  Every wait here is on a condition rather than a fixed sleep:
 *    - the wizard modal + its file input (handled by `requireImportWizard`);
 *    - the sheet `<select>` / the two JSON text inputs, which only exist after
 *      the change handler has re-rendered Step 1;
 *    - the step indicator reading "Step 2", which is how the wizard reports
 *      that parse + Step-2 render finished. The old code slept 1500ms and then
 *      read whatever heading happened to be there.
 */
async function driveWizard(args: {
  b64?: string;
  text?: string;
  fileName: string;
  sheet?: string;
  iterator?: string;
  where?: string;
}): Promise<string> {
  await requireImportWizard();
  return browser.executeObsidian(async (_obs, a) => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const modal = document.querySelector(a.wizard);
    if (!modal) return 'NO_MODAL';
    const until = async <T>(probe: () => T | null | undefined, ms: number): Promise<T | null> => {
      const t0 = Date.now();
      for (;;) {
        const value = probe();
        if (value) return value;
        if (Date.now() - t0 >= ms) return null;
        await sleep(100);
      }
    };
    const stepNumber = (): number => {
      const text = modal.querySelector('.crosswalker-step-indicator')?.textContent ?? '';
      return Number(/^Step (\d+)/.exec(text.trim())?.[1] ?? -1);
    };

    const input = modal.querySelector('input[type=file]') as HTMLInputElement | null;
    if (!input) return 'NO_FILE_INPUT';

    let file: File;
    if (a.b64) {
      const bin = atob(a.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      file = new File([bytes], a.fileName);
    } else {
      file = new File([a.text ?? ''], a.fileName);
    }
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));

    if (a.sheet) {
      // CONDITION: the sheet list has loaded and Step 1 re-rendered its picker.
      const dd = await until(() => modal.querySelector('select') as HTMLSelectElement | null, 8000);
      if (!dd) return 'NO_SHEET_DROPDOWN';
      dd.value = a.sheet;
      dd.dispatchEvent(new Event('change'));
    }
    if (a.iterator !== undefined || a.where !== undefined) {
      // CONDITION: the specific filter and advanced iterator controls both exist.
      const filterSelector = 'input.crosswalker-field-input[placeholder="e.g. status=active"]';
      const iteratorSelector = 'details.crosswalker-advanced input.crosswalker-field-input[placeholder="$.objects[*]"]';
      const ready = await until(() => {
        const filterCount = modal.querySelectorAll(filterSelector).length;
        const iteratorCount = modal.querySelectorAll(iteratorSelector).length;
        return filterCount > 0 && iteratorCount > 0 ? true : null;
      }, 8000);
      const filters = Array.from(modal.querySelectorAll(filterSelector)) as HTMLInputElement[];
      const iterators = Array.from(modal.querySelectorAll(iteratorSelector)) as HTMLInputElement[];
      if (!ready) {
        return `MISSING_JSON_CONTROLS(filter=${filters.length},iterator=${iterators.length})`;
      }
      if (filters.length !== 1 || iterators.length !== 1) {
        return `AMBIGUOUS_JSON_CONTROLS(filter=${filters.length},iterator=${iterators.length})`;
      }
      if (a.iterator !== undefined) {
        iterators[0].value = a.iterator;
        iterators[0].dispatchEvent(new Event('input'));
      }
      if (a.where !== undefined) {
        filters[0].value = a.where;
        filters[0].dispatchEvent(new Event('input'));
      }
    }

    const next = Array.from(modal.querySelectorAll('button')).find((b) => (b.classList.contains('crosswalker-step-continue') || b.textContent?.trim() === 'Next →'));
    if (!next) return 'NO_NEXT_BUTTON';
    (next as HTMLButtonElement).click();

    // CONDITION: the wizard reports Step 2 (parse finished, columns rendered).
    const reached = await until(() => (stepNumber() >= 2 ? stepNumber() : null), 15_000);
    if (!reached) {
      return 'STUCK_ON_STEP_' + stepNumber() + ': ' + (modal.querySelector('h3')?.textContent ?? '').trim();
    }
    return 'STEP ' + reached + ': ' + (modal.querySelector('h3')?.textContent ?? '').trim();
  }, { ...args, wizard: WIZARD });
}

/** Close the wizard and prove it left the DOM before the next declaration opens one. */
async function closeModal(): Promise<void> {
  const result = await closeImportWizard();
  if (!result.closed) {
    throw new Error(`wizard modal did not close: ${result.remaining} still connected after ${result.waitedMs}ms`);
  }
}

/** One short DOM/vault read. All waiting stays in the host process. */
async function readWizardGeneration(outputPath: string): Promise<WizardGenerationSnapshot> {
  return browser.executeObsidian(({ app }, a) => {
    const modal = document.querySelector(a.wizard);
    const stepText = modal?.querySelector('.crosswalker-step-indicator')?.textContent ?? '';
    const step = Number(/^Step (\d+)/.exec(stepText.trim())?.[1] ?? -1);
    const summary = (modal?.querySelector('.crosswalker-results-summary')?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const errorCount = Number(/Errors:\s*(\d+)/i.exec(summary)?.[1] ?? 0);
    const conflictCount = Number(/(\d+)\s+notes?\s+(?:was|were)\s+left unchanged/i.exec(summary)?.[1] ?? 0);
    const sectionItems = (headingText: string): string[] => {
      if (!modal) return [];
      const heading = Array.from(modal.querySelectorAll('h4'))
        .find((el) => el.textContent?.trim() === headingText);
      const list = heading?.nextElementSibling;
      if (!list?.matches('.crosswalker-error-list')) return [];
      return Array.from(list.querySelectorAll('.crosswalker-error-item'))
        .map((el) => (el.textContent ?? '').trim())
        .filter(Boolean);
    };
    const allOwnedItems = modal
      ? Array.from(modal.querySelectorAll('.crosswalker-error-list .crosswalker-error-item'))
          .map((el) => (el.textContent ?? '').trim())
          .filter(Boolean)
      : [];
    const errors = sectionItems('Errors');
    const conflicts = sectionItems('Notes left unchanged');
    if (errorCount > 0 && errors.length === 0) errors.push(...allOwnedItems.slice(0, errorCount));
    if (conflictCount > 0 && conflicts.length === 0) {
      conflicts.push(...allOwnedItems.slice(errors.length, errors.length + conflictCount));
    }

    const createdFiles: string[] = [];
    const walk = (folder: unknown) => {
      // @ts-expect-error - TFolder/TFile shape probing
      for (const child of folder?.children ?? []) {
        if (child.children) walk(child);
        else if (child.name?.endsWith('.md')) createdFiles.push(child.path.slice(a.outputPath.length + 1));
      }
    };
    walk(app.vault.getAbstractFileByPath(a.outputPath));

    const notices = Array.from(document.querySelectorAll('.notice'))
      .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    return {
      modalPresent: !!modal,
      step,
      summary,
      errors,
      conflicts,
      errorCount,
      conflictCount,
      createdFiles: createdFiles.sort(),
      notices,
    };
  }, { outputPath, wizard: WIZARD });
}

async function clickWizardButton(label: 'Next' | 'Generate'): Promise<{ ok: boolean; detail?: string }> {
  return browser.executeObsidian((_obs, a) => {
    const modal = document.querySelector(a.wizard);
    if (!modal) return { ok: false, detail: 'Owned wizard modal is not present.' };
    const button = Array.from(modal.querySelectorAll('button'))
      .find((candidate) => a.label === 'Next' ? (candidate.classList.contains('crosswalker-step-continue') || candidate.textContent?.trim() === 'Next →') : candidate.textContent?.includes(a.label));
    if (!button) return { ok: false, detail: `${a.label} button is not present.` };
    const state = { text: button.textContent, disabled: (button as HTMLButtonElement).disabled };
    (window as any).__cwObservation?.record('button-click', state);
    if (state.disabled) return { ok: false, detail: `Button disabled: ${state.text}` };
    (button as HTMLButtonElement).click();
    return { ok: true };
  }, { label, wizard: WIZARD });
}

async function setWizardOutputPath(outputPath: string): Promise<{ ok: boolean; detail?: string }> {
  return browser.executeObsidian((_obs, a) => {
    const modal = document.querySelector(a.wizard);
    if (!modal) return { ok: false, detail: 'Owned wizard modal is not present.' };
    const input = modal.querySelector('input[type=text]') as HTMLInputElement | null;
    if (!input) return { ok: false, detail: 'Output path input is not present.' };
    input.value = a.outputPath;
    input.dispatchEvent(new Event('input'));
    return { ok: true };
  }, { outputPath, wizard: WIZARD });
}

async function captureFilteredPreviewThemes(lightFile: string, darkFile: string): Promise<void> {
  const copyPresent = await browser.executeObsidian((_obs, wizard) => {
    const modal = document.querySelector(wizard);
    return Array.from(modal?.querySelectorAll('p') ?? []).some(
      (el) => el.textContent?.trim() === 'Preview uses unfiltered source samples. Your filter is applied during generation.',
    );
  }, WIZARD);
  if (!copyPresent) throw new Error('Filtered-preview explanation was not present on Step 3.');

  const previous = await browser.executeObsidian(() => ({
    dark: document.body.classList.contains('theme-dark'),
    light: document.body.classList.contains('theme-light'),
  }));
  try {
    await browser.executeObsidian(() => {
      document.body.classList.remove('theme-dark');
      document.body.classList.add('theme-light');
    });
    await browser.pause(200);
    await browser.saveScreenshot(lightFile);
    await browser.executeObsidian(() => {
      document.body.classList.remove('theme-light');
      document.body.classList.add('theme-dark');
    });
    await browser.pause(200);
    await browser.saveScreenshot(darkFile);
  } finally {
    await browser.executeObsidian((_obs, value: unknown) => {
      const state = value as { dark: boolean; light: boolean };
      document.body.classList.toggle('theme-dark', state.dark);
      document.body.classList.toggle('theme-light', state.light);
    }, previous);
    await browser.pause(200);
  }
}

/** After driveWizard() lands on Step 2, click each action once and let the host
 * poll bounded, short reads for navigation, terminal state and output visibility. */
async function finishWizard(
  outputPath: string,
  expectedFileCount: number,
  previewScreenshots?: { light: string; dark: string },
): Promise<WizardFinishOutcome> {
  return finishWizardWithDriver({
    read: () => readWizardGeneration(outputPath),
    clickNext: () => clickWizardButton('Next'),
    setOutputPath: setWizardOutputPath,
    clickGenerate: () => clickWizardButton('Generate'),
    sleep: (ms) => browser.pause(ms),
    now: () => Date.now(),
    ...(previewScreenshots
      ? { onPreview: () => captureFilteredPreviewThemes(previewScreenshots.light, previewScreenshots.dark) }
      : {}),
  }, outputPath, expectedFileCount);
}

async function requireAbsentFolder(outputPath: string): Promise<void> {
  const existing = await browser.executeObsidian(({ app }, pathToCheck) => {
    const found = app.vault.getAbstractFileByPath(pathToCheck);
    return found ? found.path : null;
  }, outputPath);
  if (existing !== null) {
    throw new Error(`refusing to reuse pre-existing E2E output: ${existing}`);
  }
}

/** Delete only the uniquely named folder this declaration proved absent first. */
async function cleanupFolder(outputPath: string): Promise<void> {
  await browser.executeObsidian(async ({ app }, a) => {
    const folder = app.vault.getAbstractFileByPath(a.outputPath);
    if (folder) {
      // @ts-expect-error - delete accepts TAbstractFile
      await app.vault.delete(folder, true);
    }
  }, { outputPath });
}

describe('Visual — import wizard XLSX + JSON paths', function () {
  this.timeout(180_000);

  before(async () => {
    mkdirSync(OUT, { recursive: true });
    // Deterministic starting state instead of a 3s "let it settle" sleep:
    // no leftover wizard, no drafts from another spec, and Obsidian's metadata
    // cache actually resolved for every note in the seed vault.
    await closeImportWizard();
    await clearAllDrafts();
    const indexed = await waitForVaultIndexed();
    if (!indexed.ready) {
      console.warn(`[wizard-formats] vault index incomplete: ${indexed.pending}/${indexed.total} pending after ${indexed.waitedMs}ms`);
    }
  });

  afterEach(async () => {
    // Never hand the next declaration an open modal — that is exactly how the
    // first-generic-`.modal` failures compounded down the file.
    await stopWizardObservation();
    await closeImportWizard();
  });

  for (const control of ['json-list', 'json-path', 'json-root', 'xlsx-sheet', 'xlsx-header']) {
    it(`mounted continuation transition: ${control} after parse and Back`, async () => {
      const recipeName = `Transition ${control}`;
      const recipePath = `_crosswalker/import-recipes/transition-${control}.json`;
      const json = control.startsWith('json');
      const rows = [{ sample_key: 'A', caption: 'Invented alpha', zone: 'North' }, { sample_key: 'B', caption: 'Invented beta', zone: 'South' }];
      const wb = XLSX.utils.book_new();
      for (const sheet of ['First', 'Second']) {
        const sheetRows = sheet === 'First' ? rows : rows.map(r => ({ ...r, sample_key: `S2-${r.sample_key}`, caption: `Second ${r.caption}`, zone: 'East' }));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
          ['sample_key', 'caption', 'zone'], ['sample_key', 'caption', 'zone'], ...sheetRows.map(r => Object.values(r)),
        ]), sheet);
      }
      const settings = await browser.executeObsidian(async ({ app }) => {
        const plugin = (app as any).plugins.plugins.crosswalker;
        const prior = { enableShapeWorkbench: plugin.settings.enableShapeWorkbench, enableConfigSuggestions: plugin.settings.enableConfigSuggestions };
        plugin.settings.enableShapeWorkbench = true; plugin.settings.enableConfigSuggestions = false;
        await plugin.saveSettings();
        return prior;
      });
      const managed = () => browser.executeObsidian(async ({ app }) => {
        const notes: Record<string, string> = {};
        for (const file of app.vault.getMarkdownFiles()) {
          const text = await app.vault.read(file);
          if (text.includes('_crosswalker:')) notes[file.path] = text;
        }
        return notes;
      });
      const readStep = () => browser.executeObsidian(() => (window as any).__cwObservation.flow.currentStep);
      const click = async (text: string) => {
        const clicked = await browser.executeObsidian((_o, a) => {
          const button = Array.from(document.querySelector(a.wizard)!.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent?.trim() === a.text);
          if (!button || button.disabled) return false;
          button.click(); return true;
        }, { wizard: WIZARD, text });
        expect(clicked).toBe(true);
      };
      const ownerPath = 'E2E-Transition-Owner.md';
      await browser.executeObsidian(async ({ app }, p) => {
        if (await app.vault.adapter.exists(p)) throw new Error('Synthetic owner fixture already exists');
        await app.vault.create(p, '---\ncurie: transition:owned\n_crosswalker:\n  import_set:\n    id: iset-tran01\n    scheme: endpoint-v1\n    ontology: transition\n    destination: E2E-Transition\n---\nSynthetic ownership sentinel.\n');
      }, ownerPath);
      await waitForVaultIndexed();
      const notesBefore = await managed();
      try {
        expect(await browser.executeObsidian(async ({ app }, p) => app.vault.adapter.exists(p), recipePath)).toBe(false);
        await installWizardObservation();
        const result = await driveWizard(json
          ? { text: JSON.stringify(control === 'json-root' ? rows : { first: rows, second: rows.slice(0, 1) }), fileName: `${control}.json`, iterator: control === 'json-root' ? '' : '$.first[*]' }
          : { b64: XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }) as string, fileName: `${control}.xlsx`, sheet: 'First' });
        expect(result).toMatch(/^STEP 2/);
        await click('Review import');
        await browser.waitUntil(async () => (await readStep()) === 3, { timeout: 15_000 });
        await click('Save as recipe');
        await browser.waitUntil(async () => browser.executeObsidian(() => !!document.querySelector('.crosswalker-save-recipe-name')), { timeout: 5_000 });
        await browser.executeObsidian((_o, name) => {
          const dialog = document.querySelector('.crosswalker-save-recipe-modal')!;
          const input = dialog.querySelector<HTMLInputElement>('.crosswalker-save-recipe-name')!;
          input.value = name; input.dispatchEvent(new Event('input'));
          Array.from(dialog.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Save')!.click();
        }, recipeName);
        await browser.waitUntil(async () => browser.executeObsidian(() => !document.querySelector('.crosswalker-save-recipe-modal') && !!(window as any).__cwObservation.flow.savedRecipeName), { timeout: 5_000 });
        const storedRecipe = await browser.executeObsidian(async ({ app }, p) => app.vault.adapter.read(p), recipePath);
        // Saving changed the recipe digest. Finish that review recomputation first.
        await click('Back');
        await browser.waitUntil(async () => (await readStep()) === 2, { timeout: 5_000 });
        await click('Review import');
        await browser.waitUntil(async () => browser.executeObsidian(() => {
          const flow = (window as any).__cwObservation.flow;
          return flow.currentStep === 3 && !flow.step3InFlight;
        }), { timeout: 15_000 });
        // A same-value select event is intentionally ignored by Obsidian. Make a
        // real alternate choice before explicitly choosing a new set.
        for (const value of ['iset-tran01', '__new__']) {
          await browser.executeObsidian((_o, a) => {
            const select = document.querySelector<HTMLSelectElement>(`${a.wizard} .crosswalker-import-set-review select`);
            if (!select) throw new Error('Expected ownership selector beside synthetic existing set');
            select.value = a.value; select.dispatchEvent(new Event('change'));
          }, { wizard: WIZARD, value });
          await browser.waitUntil(async () => browser.executeObsidian((_o, value) => {
            const flow = (window as any).__cwObservation.flow;
            return !flow.step3InFlight && (value === '__new__' ? flow.importSetChoice === 'new' : flow.importSetChoice?.id === value);
          }, value), { timeout: 5_000 });
        }
        for (const n of [2, 1]) {
          await click('Back');
          await browser.waitUntil(async () => (await readStep()) === n, { timeout: 5_000 });
        }
        const changed = await browser.executeObsidian((_o, a) => {
          const root = document.querySelector(a.wizard)!;
          const flow = (window as any).__cwObservation.flow;
          const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.crosswalker-step-continue'));
          const selector = a.control === 'json-root' ? '.crosswalker-json-pick' : a.control === 'json-list' ? '.crosswalker-json-pick:not(.crosswalker-json-pick-selected)'
            : a.control === 'json-path' ? '.crosswalker-advanced input' : a.control === 'xlsx-sheet' ? 'select' : 'input[type=number]';
          const input = root.querySelector<HTMLElement>(selector)!;
          if (!input) throw new Error(`Missing ${a.control} control`);
          // Cards, sibling inputs and the step shell all stay mounted during synchronization.
          const cards = Array.from(root.querySelectorAll('.crosswalker-json-pick'));
          const stableInput = ['json-list', 'json-root'].includes(a.control) ? root.querySelector<HTMLInputElement>('.crosswalker-advanced input')! : input;
          const advanced = stableInput.closest('details'); if (advanced) advanced.open = true;
          const content = root.querySelector('.crosswalker-wizard-content');
          input.scrollIntoView({ block: 'center' });
          const binding = () => JSON.stringify({ choice: flow.importSetChoice, preset: flow.presetLibraryRecipeId, saved: flow.savedRecipeName, file: flow.sourceFile.name, type: flow.sourceType });
          const beforeBinding = binding();
          const beforeLabels = buttons.map(b => b.textContent);
          const oldParsed = flow.parsedData;
          if (!oldParsed) throw new Error('Back lost the valid parse');
          const oldDisabled = buttons.map(b => b.disabled);
          // Re-entering the same value must not discard a valid parse.
          input.dispatchEvent(new Event(a.control === 'xlsx-sheet' ? 'change' : ['json-list', 'json-root'].includes(a.control) ? 'focus' : 'input'));
          const sameValuePreserved = flow.parsedData === oldParsed;
          stableInput.focus();
          let unmatched: { selected: number; value: string; caret: number | null; iterator: string } | null = null;
          if (a.control === 'json-path' || a.control === 'json-root') {
            const path = stableInput as HTMLInputElement;
            path.value = '  $.unmatched[*]  '; path.setSelectionRange(4, 4);
            path.dispatchEvent(new Event('input'));
            unmatched = { selected: root.querySelectorAll('.crosswalker-json-pick-selected').length,
              value: path.value, caret: path.selectionStart, iterator: flow.jsonIterator };
          }
          if (a.control === 'json-list' || a.control === 'json-root') input.click();
          else {
            (input as HTMLInputElement).value = a.control === 'json-path' ? '$.second[*]' : a.control === 'xlsx-sheet' ? 'Second' : '2';
            if (a.control === 'json-path') (input as HTMLInputElement).setSelectionRange(4, 4);
            input.dispatchEvent(new Event(a.control === 'xlsx-sheet' ? 'change' : 'input'));
          }
          const afterButtons = Array.from(root.querySelectorAll('.crosswalker-step-continue'));
          return { beforeLabels, afterLabels: buttons.map(b => b.textContent), sameValuePreserved,
            invalidated: flow.parsedData === null, sameButtons: buttons.every((b, i) => b === afterButtons[i]),
            inputConnected: stableInput.isConnected, focused: document.activeElement === stableInput,
            sameContent: content === root.querySelector('.crosswalker-wizard-content'),
            sameCards: cards.every((card, i) => card === root.querySelectorAll('.crosswalker-json-pick')[i]),
            selectedList: root.querySelector('.crosswalker-json-pick-selected .crosswalker-json-pick-label')?.textContent,
            indicators: cards.map(card => card.querySelector('.crosswalker-json-radio')?.textContent),
            displayedPath: root.querySelector<HTMLInputElement>('.crosswalker-advanced input')?.value,
            advancedOpen: advanced?.open, caret: (stableInput as HTMLInputElement).selectionStart, unmatched,
            choice: flow.importSetChoice,
            value: ['json-list', 'json-root'].includes(a.control) ? flow.jsonIterator : (input as HTMLInputElement).value,
            beforeBinding, afterBinding: binding(), oldDisabled, disabled: buttons.map(b => b.disabled),
            saved: flow.savedRecipeName };
        }, { control, wizard: WIZARD });
        console.log('[transition] ' + JSON.stringify({ control, ...changed }));
        expect(changed.beforeLabels).toEqual(['Choose layout', 'Choose layout']);
        expect(changed.afterLabels).toEqual(['Read source', 'Read source']);
        expect(changed.sameValuePreserved).toBe(true);
        expect(changed.invalidated).toBe(true);
        expect(changed.sameButtons).toBe(true);
        expect(changed.inputConnected).toBe(true);
        expect(changed.focused).toBe(true);
        expect(changed.sameContent).toBe(true);
        expect(changed.sameCards).toBe(true);
        expect(changed.choice).toBe('new');
        if (json) {
          expect(changed.selectedList).toBe(control === 'json-root' ? 'This whole file is your list of records' : 'second');
          expect(changed.displayedPath).toBe(control === 'json-root' ? '' : '$.second[*]');
          if (control === 'json-root') expect(changed.indicators).toEqual(['●']);
          expect(changed.advancedOpen).toBe(true);
        }
        if (control === 'json-path') {
          expect(changed.caret).toBe(4);
          expect(changed.unmatched).toEqual({ selected: 0, value: '  $.unmatched[*]  ', caret: 4, iterator: '$.unmatched[*]' });
        }
        if (control === 'json-root') expect(changed.unmatched).toEqual({ selected: 0, value: '  $.unmatched[*]  ', caret: 4, iterator: '$.unmatched[*]' });
        expect(changed.value).toBe(control === 'json-root' ? '' : json ? '$.second[*]' : control === 'xlsx-sheet' ? 'Second' : '2');
        expect(changed.afterBinding).toBe(changed.beforeBinding);
        expect(changed.saved).toBe(recipeName);
        expect(changed.disabled).toEqual(changed.oldDisabled);
        expect(changed.disabled).toEqual([false, false]);
        await browser.executeObsidian(() => document.querySelectorAll<HTMLElement>('.notice').forEach(n => n.click()));
        await browser.waitUntil(async () => browser.executeObsidian(() => Array.from(document.querySelectorAll<HTMLElement>('.notice')).every(n => n.getClientRects().length === 0 || getComputedStyle(n).visibility === 'hidden')), { timeout: 5_000 });
        for (const captureState of control === 'json-path' ? ['unmatched', 'selected'] : ['selected']) {
          if (json) {
            const visibleSelection = await browser.executeObsidian((_o, a) => {
              const root = document.querySelector(a.wizard)!;
              const input = root.querySelector<HTMLInputElement>('.crosswalker-advanced input')!;
              if (a.control === 'json-path') {
                input.value = a.captureState === 'unmatched' ? '  $.unmatched[*]  ' : '$.second[*]';
                input.setSelectionRange(4, 4);
                input.dispatchEvent(new Event('input'));
              }
              (root.querySelector('.crosswalker-json-picklist') ?? root.querySelector('.crosswalker-json-pick'))?.scrollIntoView({ block: 'start' });
              return { selected: root.querySelectorAll('.crosswalker-json-pick-selected').length,
                value: input.value, caret: input.selectionStart, open: input.closest('details')?.open };
            }, { wizard: WIZARD, control, captureState });
            expect(visibleSelection.selected).toBe(captureState === 'unmatched' ? 0 : 1);
            expect(visibleSelection.value).toBe(captureState === 'unmatched' ? '  $.unmatched[*]  ' : control === 'json-root' ? '' : '$.second[*]');
            expect(visibleSelection.open).toBe(true);
            if (control === 'json-path') expect(visibleSelection.caret).toBe(4);
          }
          for (const theme of ['light', 'dark']) {
            await browser.executeObsidian(({ app }, theme) => {
              (app as any).changeTheme(theme === 'dark' ? 'obsidian' : 'moonstone');
              document.body.classList.toggle('theme-light', theme === 'light'); document.body.classList.toggle('theme-dark', theme === 'dark');
              app.workspace.trigger('css-change');
            }, theme);
            await browser.pause(200);
            const prefix = captureState === 'unmatched' ? 'transition-json-unmatched' : `transition-${control}`;
            await browser.saveScreenshot(path.join(OUT, `${prefix}-${theme}.png`));
          }
        }
        await click('Read source');
        await browser.waitUntil(async () => browser.executeObsidian(() => {
          const flow = (window as any).__cwObservation.flow;
          return !!flow.parsedData && !flow.isParsing;
        }), { timeout: 15_000 });
        const parsed = await browser.executeObsidian(() => {
          const flow = (window as any).__cwObservation.flow;
          return { step: flow.currentStep, rows: flow.parsedData.rowCount, columns: flow.parsedData.columns,
            sheetName: flow.parsedData.sheetName, lastRow: flow.parsedData.rows.at(-1), recognized: !!flow.recognizedMatch };
        });
        console.log('[transition-parse] ' + JSON.stringify({ control, ...parsed }));
        expect(parsed.rows).toBe(control === 'json-root' ? 2 : json ? 1 : control === 'xlsx-header' ? 2 : 3);
        if (control === 'json-root') expect(parsed.lastRow).toEqual(rows[1]);
        expect(parsed.columns).toEqual(['sample_key', 'caption', 'zone']);
        if (!json) {
          expect(parsed.sheetName).toBe(control === 'xlsx-sheet' ? 'Second' : 'First');
          expect(parsed.lastRow).toEqual(control === 'xlsx-sheet'
            ? { sample_key: 'S2-B', caption: 'Second Invented beta', zone: 'East' }
            : rows[1]);
        }
        expect(parsed.step === 2 || (parsed.step === 1 && parsed.recognized)).toBe(true);
        expect(await browser.executeObsidian(async ({ app }, p) => app.vault.adapter.read(p), recipePath)).toBe(storedRecipe);
        expect(await managed()).toEqual(notesBefore);
        const observed = await readWizardObservation();
        expect(observed.events.some((e: { kind: string }) => e.kind === 'generate-entry' || e.kind === 'generation-write-phase-entry')).toBe(false);
      } finally {
        await closeImportWizard();
        await browser.executeObsidian(async ({ app }, a) => {
          const file = app.vault.getAbstractFileByPath(a.recipePath); if (file) await app.vault.delete(file, true);
          const owner = app.vault.getAbstractFileByPath(a.ownerPath); if (owner) await app.vault.delete(owner, true);
          const plugin = (app as any).plugins.plugins.crosswalker; Object.assign(plugin.settings, a.settings); await plugin.saveSettings();
        }, { recipePath, ownerPath, settings });
      }
    });
  }

  it('JSON nested radio propagates selection to the existing card and path', async () => {
    await installWizardObservation();
    const snapshot = () => browser.executeObsidian(async ({ app }) => {
      const result: Record<string, string> = {};
      for (const file of app.vault.getMarkdownFiles()) {
        const text = await app.vault.read(file);
        if (text.includes('_crosswalker:')) result[file.path] = text;
      }
      return result;
    });
    const before = await snapshot();
    const result = await driveWizard({ fileName: 'nested-propagation.json', iterator: '$.groups[*]', text: JSON.stringify({
      groups: [{ id: 'G1', title: 'Invented group', children: [{ id: 'C1', title: 'Invented child' }] }],
      other: [{ id: 'O1', title: 'Invented other' }],
    }) });
    expect(result).toMatch(/^STEP 2/);
    const observed = await browser.executeObsidian((_o, wizard) => {
      const root = document.querySelector(wizard)!;
      const flow = (window as any).__cwObservation.flow;
      Array.from(root.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Back')!.click();
      if (flow.currentStep !== 1 || !flow.parsedData) throw new Error('Expected valid parse after Back');
      const content = root.querySelector('.crosswalker-wizard-content');
      const cards = Array.from(root.querySelectorAll<HTMLElement>('.crosswalker-json-pick'));
      const card = cards.find(c => c.querySelector('.crosswalker-json-pick-label')?.textContent === 'groups')!;
      const nested = card.querySelector<HTMLInputElement>('input[value=nested]')!;
      const flat = card.querySelector<HTMLInputElement>('input[value=flat]')!;
      if (!nested || !flat) throw new Error('Expected native nested/flat radio fixture');
      const input = root.querySelector<HTMLInputElement>('.crosswalker-advanced input')!;
      const disclosure = input.closest('details')!; disclosure.open = true;
      const binding = () => JSON.stringify({ source: flow.sourceFile.name, choice: flow.importSetChoice, preset: flow.presetLibraryRecipeId, config: flow.appliedConfig });
      const beforeBinding = binding();
      input.focus(); input.value = '$.other[*]'; input.dispatchEvent(new Event('input'));
      const other = { iterator: flow.jsonIterator, nest: flow.jsonNest, flat: flat.checked, nested: nested.checked,
        selected: root.querySelector('.crosswalker-json-pick-selected .crosswalker-json-pick-label')?.textContent };
      nested.click();
      const nestedResult = { iterator: flow.jsonIterator, nest: flow.jsonNest, path: input.value,
        flat: flat.checked, nested: nested.checked,
        selected: root.querySelector('.crosswalker-json-pick-selected .crosswalker-json-pick-label')?.textContent };
      flat.click();
      const flatResult = { iterator: flow.jsonIterator, nest: flow.jsonNest, path: input.value, flat: flat.checked, nested: nested.checked };
      nested.click();
      card.scrollIntoView({ block: 'start' });
      return { other, nestedResult, flatResult, beforeBinding, afterBinding: binding(), open: disclosure.open,
        sameInput: input === root.querySelector('.crosswalker-advanced input'),
        sameContent: content === root.querySelector('.crosswalker-wizard-content'),
        sameCards: cards.every((c, i) => c === root.querySelectorAll('.crosswalker-json-pick')[i]),
        sameRadios: nested === card.querySelector('input[value=nested]') && flat === card.querySelector('input[value=flat]'),
        labels: Array.from(root.querySelectorAll('.crosswalker-step-continue')).map(b => b.textContent) };
    }, WIZARD);
    console.log('[nested-propagation] ' + JSON.stringify(observed));
    expect(observed.other).toEqual({ iterator: '$.other[*]', nest: null, flat: true, nested: false, selected: 'other' });
    expect(observed.nestedResult).toEqual({ iterator: '$.groups[*]', nest: '$.groups[*]', path: '$.groups[*]', flat: false, nested: true, selected: 'groups' });
    expect(observed.flatResult).toEqual({ iterator: '$.groups[*]', nest: null, path: '$.groups[*]', flat: true, nested: false });
    expect(observed.afterBinding).toBe(observed.beforeBinding);
    for (const same of [observed.sameInput, observed.sameContent, observed.sameCards, observed.sameRadios, observed.open]) expect(same).toBe(true);
    expect(observed.labels).toEqual(['Read source', 'Read source']);
    await browser.executeObsidian(() => document.querySelectorAll<HTMLElement>('.notice').forEach(n => n.click()));
    await browser.waitUntil(async () => browser.executeObsidian(() => Array.from(document.querySelectorAll<HTMLElement>('.notice')).every(n => n.getClientRects().length === 0 || getComputedStyle(n).visibility === 'hidden')), { timeout: 5_000 });
    for (const theme of ['light', 'dark']) {
      await browser.executeObsidian(({ app }, theme) => {
        (app as any).changeTheme(theme === 'dark' ? 'obsidian' : 'moonstone');
        document.body.classList.toggle('theme-light', theme === 'light'); document.body.classList.toggle('theme-dark', theme === 'dark');
        app.workspace.trigger('css-change');
      }, theme);
      await browser.pause(200);
      await browser.saveScreenshot(path.join(OUT, `json-nested-propagation-${theme}.png`));
    }
    expect(await snapshot()).toEqual(before);
    expect((await readWizardObservation()).events.some((e: { kind: string }) => e.kind === 'generate-entry' || e.kind === 'generation-write-phase-entry')).toBe(false);
  });

  it('JSON record picker — nested lists render as cards, primary list ranked first', async () => {
    // CPRT-shaped: `relationships` is LARGER but reads like edges; `elements`
    // (the concept records) must rank first + be pre-selected.
    const cprt = JSON.stringify({
      response: { elements: {
        elements: Array.from({ length: 12 }, (_, i) => ({ element_type: 'subcategory', element_identifier: `GV.OC-0${i}`, title: '', text: 'Some descriptive text here', doc_identifier: 'CSF' })),
        relationships: Array.from({ length: 40 }, (_, i) => ({ source_element_identifier: `s${i}`, dest_element_identifier: `d${i}`, relationship_identifier: 'maps_to' })),
        documents: [{ doc_identifier: 'CSF', name: 'CSF 2.0', version: '2.0', website: 'x' }],
      } },
    });
    await requireImportWizard();
    const r = await browser.executeObsidian(async (_obs, a) => {
      const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
      const modal = document.querySelector(a.wizard);
      if (!modal) return 'NO_MODAL';
      const input = modal.querySelector('input[type=file]') as HTMLInputElement | null;
      if (!input) return 'NO_FILE_INPUT';
      const dt = new DataTransfer();
      dt.items.add(new File([a.json], 'cprt.json'));
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
      // CONDITION: structure detection ran and Step 1 re-rendered its picker
      // cards. Replaces a fixed 700ms sleep.
      const deadline = Date.now() + 10_000;
      while (modal.querySelectorAll('.crosswalker-json-pick').length === 0 && Date.now() < deadline) {
        await sleep(100);
      }
      const selected = modal.querySelector('.crosswalker-json-pick-selected .crosswalker-json-pick-label')?.textContent ?? '';
      const cards = modal.querySelectorAll('.crosswalker-json-pick').length;
      return `cards=${cards} selected=${selected.trim()}`;
    }, { json: cprt, wizard: WIZARD });
    console.log('[wizard] json-picker → ' + r);
    await browser.saveScreenshot(path.join(OUT, 'wizard-json-picker.png'));
    await closeModal();
    if (!/cards=[34]/.test(r) || !/selected=elements/.test(r)) {
      throw new Error('Picker did not render/rank as expected: ' + r);
    }
  });

  it('XLSX: sheet picker + parse → Step 2 columns', async () => {
    const r = await driveWizard({ b64: makeWorkbookB64(), fileName: 'controls.xlsx', sheet: 'Controls' });
    console.log('[wizard] xlsx → ' + r);
    await browser.saveScreenshot(path.join(OUT, 'wizard-xlsx-step2.png'));
    await closeModal();
    if (!r.startsWith('STEP')) throw new Error('XLSX drive failed: ' + r);
  });

  it('JSON: iterator + filter + parse → Step 2 columns', async () => {
    const r = await driveWizard({
      text: STIX_JSON,
      fileName: 'stix.json',
      iterator: '$.objects[*]',
      where: 'type=attack-pattern,revoked!=true',
    });
    console.log('[wizard] json → ' + r);
    await browser.saveScreenshot(path.join(OUT, 'wizard-json-step2.png'));
    await closeModal();
    if (!r.startsWith('STEP')) throw new Error('JSON drive failed: ' + r);
  });

  it('XLSX full loop: parse → configure → preview → GENERATE notes', async () => {
    const target = 'E2E-Wizard-Test/From-XLSX';
    await requireAbsentFolder(target);
    const workbookB64 = makeWorkbookB64();
    const expectedSourceHash = `sha256-${createHash('sha256').update(Buffer.from(workbookB64, 'base64')).digest('hex')}`;
    try {
      const r = await driveWizard({ b64: workbookB64, fileName: 'controls.xlsx', sheet: 'Controls' });
      if (!r.startsWith('STEP')) throw new Error('XLSX drive failed: ' + r);
      const g = await finishWizard(target, 3);
      console.log('[wizard] xlsx generate → ' + JSON.stringify(g));
      await browser.saveScreenshot(path.join(OUT, 'wizard-xlsx-generated.png'));
      await closeModal();
      if (g.kind !== 'success' || g.last.createdFiles.length !== 3) {
        throw new Error('XLSX generation failed: ' + JSON.stringify(g));
      }

      const generated = await readFrontmatterMatching(target, '');
      if (!generated.path || !generated.frontmatter) {
        throw new Error(`XLSX provenance note not found under ${target}`);
      }
      const sourceRef = (generated.frontmatter._crosswalker as Record<string, unknown> | undefined)?.source_ref as Record<string, unknown> | undefined;
      console.log('[wizard] xlsx evidence → ' + JSON.stringify({
        terminal: g,
        samplePath: generated.path,
        frontmatter: generated.frontmatter,
        expectedSourceHash,
        actualSourceHash: sourceRef?.source_hash,
      }));
      if (sourceRef?.source_hash !== expectedSourceHash) {
        throw new Error(`XLSX source hash mismatch for ${generated.path}: expected ${expectedSourceHash}, got ${String(sourceRef?.source_hash)}`);
      }
    } finally {
      await cleanupFolder(target);
    }
  });

  it('JSON full loop: parse → configure → preview → GENERATE notes', async () => {
    const target = 'E2E-Wizard-Test/From-JSON';
    await requireAbsentFolder(target);
    try {
      const r = await driveWizard({
        text: STIX_JSON,
        fileName: 'stix.json',
        iterator: '$.objects[*]',
        where: 'type=attack-pattern,revoked!=true',
      });
      if (!r.startsWith('STEP')) throw new Error('JSON drive failed: ' + r);
      const g = await finishWizard(target, 1, {
        light: path.join(OUT, 'wizard-json-filter-preview-light.png'),
        dark: path.join(OUT, 'wizard-json-filter-preview-dark.png'),
      });
      console.log('[wizard] json generate → ' + JSON.stringify(g));
      await browser.saveScreenshot(path.join(OUT, 'wizard-json-generated.png'));
      await closeModal();
      if (g.kind !== 'success' || g.last.createdFiles.length !== 1) {
        throw new Error('JSON generation failed: ' + JSON.stringify(g));
      }

      const generated = await readFrontmatterMatching(target, '');
      if (!generated.path || !generated.frontmatter) {
        throw new Error(`JSON provenance note not found under ${target}`);
      }
      const frontmatter = generated.frontmatter;
      const unexpectedTopLevel = ['revoked', 'source_ref', 'target_ref'].filter((key) =>
        Object.prototype.hasOwnProperty.call(frontmatter, key));
      if (unexpectedTopLevel.length > 0) {
        throw new Error(`JSON unexpectedly emitted omitted top-level source fields for ${generated.path}: ${unexpectedTopLevel.join(', ')}`);
      }
      const sourceRef = (frontmatter._crosswalker as Record<string, unknown> | undefined)?.source_ref as Record<string, unknown> | undefined;
      if (!sourceRef) {
        throw new Error(`JSON missing nested _crosswalker.source_ref provenance for ${generated.path}`);
      }
      const expectedSourceHash = `sha256-${createHash('sha256').update(Buffer.from(STIX_JSON, 'utf8')).digest('hex')}`;
      console.log('[wizard] json evidence → ' + JSON.stringify({
        terminal: g,
        samplePath: generated.path,
        frontmatter: generated.frontmatter,
        expectedSourceHash,
      }));
      if (sourceRef.source_hash !== expectedSourceHash) {
        throw new Error(`JSON source hash mismatch for ${generated.path}: expected ${expectedSourceHash}, got ${String(sourceRef.source_hash)}`);
      }
    } finally {
      await cleanupFolder(target);
    }
  });

  it('JSON unknown filter field: preflight refusal names the field and creates no notes', async () => {
    const target = 'E2E-Wizard-Test/Unknown-Filter-Field';
    const unknownField = 'unknown_filter_field';
    await requireAbsentFolder(target);
    await installWizardObservation();
    try {
      const r = await driveWizard({
        text: STIX_JSON,
        fileName: 'stix.json',
        iterator: '$.objects[*]',
        where: `${unknownField}=value`,
      });
      if (!r.startsWith('STEP')) throw new Error('Unknown-field JSON drive failed: ' + r);
      // This refusal happens before the write phase, so do not wait for a
      // results screen that neither the baseline nor candidate produces.
      for (const expectedStep of [3, 4]) {
        const action = await clickWizardButton('Next');
        if (!action.ok) throw new Error(action.detail);
        await browser.waitUntil(async () => (await readWizardGeneration(target)).step === expectedStep, { timeout: 15_000 });
      }
      const setOutput = await setWizardOutputPath(target);
      if (!setOutput.ok) throw new Error(setOutput.detail);
      const click = await clickWizardButton('Generate');
      if (!click.ok) throw new Error(click.detail);
      await browser.waitUntil(async () => (await readWizardObservation()).events.some((event: any) => event.kind === 'generate-return'),
        { timeout: 5_000, timeoutMsg: 'Generate did not return from bounded preflight' });
      const observation = await readWizardObservation();
      const output = await readWizardGeneration(target);
      console.log('[wizard] json unknown-field timeline → ' + JSON.stringify(observation));
      console.log('[wizard] json unknown-field output → ' + JSON.stringify(output));
      await browser.saveScreenshot(path.join(OUT, 'wizard-json-unknown-filter-field.png'));
      const errors = observation.events.filter((event: any) => ['generate-exception', 'window-error', 'unhandled-rejection'].includes(event.kind));
      if (errors.length) throw new Error('Unexpected exception: ' + JSON.stringify(errors));
      if (observation.events.filter((event: any) => event.kind === 'generate-entry').length !== 1
          || observation.events.some((event: any) => event.kind === 'generation-write-phase-entry')) {
        throw new Error('Expected exactly one real Generate entry and no write-phase entry: ' + JSON.stringify(observation));
      }
      const refusal = observation.state.discoveryError;
      if (typeof refusal !== 'string' || !refusal.includes(`unknown field "${unknownField}"`)
          || !refusal.includes('The source has no such column') || !refusal.includes('Available: type, name')
          || !observation.warnings.includes(refusal)
          || !observation.events.some((event: any) => event.kind === 'notice' && event.value === refusal)) {
        throw new Error('Missing persistent, field-naming actionable refusal plus notice: ' + JSON.stringify(observation));
      }
      if (observation.state.generating || observation.state.step !== 4 || observation.result !== '' || output.createdFiles.length !== 0) {
        throw new Error('Preflight refusal entered generation or created notes: ' + JSON.stringify({ observation, output }));
      }
      await requireAbsentFolder(target);
      await closeModal();
    } finally {
      await cleanupFolder(target);
    }
  });
});
