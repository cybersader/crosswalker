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
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
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

    const next = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent?.includes('Next'));
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
      .find((candidate) => candidate.textContent?.includes(a.label));
    if (!button) return { ok: false, detail: `${a.label} button is not present.` };
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
    await closeImportWizard();
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

  it('JSON unknown filter field: results name the field and create no notes', async () => {
    const target = 'E2E-Wizard-Test/Unknown-Filter-Field';
    const unknownField = 'unknown_filter_field';
    await requireAbsentFolder(target);
    try {
      const r = await driveWizard({
        text: STIX_JSON,
        fileName: 'stix.json',
        iterator: '$.objects[*]',
        where: `${unknownField}=value`,
      });
      if (!r.startsWith('STEP')) throw new Error('Unknown-field JSON drive failed: ' + r);
      const g = await finishWizard(target, 0);
      console.log('[wizard] json unknown-field evidence → ' + JSON.stringify(g));
      await browser.saveScreenshot(path.join(OUT, 'wizard-json-unknown-filter-field.png'));
      await closeModal();

      const errorText = g.last.errors.join('\n');
      if (g.kind !== 'error' || !errorText.includes('unknown field') || !errorText.includes(unknownField)) {
        throw new Error('Unknown-field filter did not surface an actionable results error: ' + JSON.stringify(g));
      }
      if (g.last.createdFiles.length !== 0) {
        throw new Error('Unknown-field filter created notes: ' + JSON.stringify(g.last.createdFiles));
      }
    } finally {
      await cleanupFolder(target);
    }
  });
});
