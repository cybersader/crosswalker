/**
 * import-flow.spec.ts — End-to-end import flow E2E test
 *
 * Closes a v0.1.1 testing gap: smoke + validation tests verified the harness
 * + validator handles, but did NOT exercise the actual import wizard flow
 * end-to-end.
 *
 * Strategy: trigger the `crosswalker:import-structured-data` command via
 * `executeObsidianCommand`, assert the modal opens, then close it. This
 * proves the wizard surface still works after the v0.1.1 type rename
 * (CrosswalkerConfig → ImportRecipe).
 *
 * For deeper integration (driving wizard to generation), wait until v0.1.2
 * lands render() — at that point we can programmatically supply a recipe
 * + parsed data and assert generated notes appear in the vault.
 *
 * Run: `bun run e2e`
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';

describe('Crosswalker plugin — import flow (v0.1.1)', function () {
  // Each test should leave the vault clean — close any open modals afterwards.
  afterEach(async () => {
    await browser.executeObsidian(({ app }) => {
      // Close any open modals
      const openModals = document.querySelectorAll('.modal-container');
      openModals.forEach((m) => {
        const closeBtn = m.querySelector('.modal-close-button, .modal-header-button') as HTMLElement | null;
        if (closeBtn) closeBtn.click();
      });
    });
    // Brief pause for Obsidian's modal-close animation
    await browser.pause(150);
  });

  it('triggering the import command opens the wizard modal', async () => {
    await browser.executeObsidianCommand('crosswalker:import-structured-data');
    await browser.pause(250);

    const modal = browser.$('.modal-container');
    await expect(modal).toExist();
  });

  it('the wizard modal renders without crashing after the v0.1.1 rename', async () => {
    await browser.executeObsidianCommand('crosswalker:import-structured-data');
    await browser.pause(250);

    // Sanity check: the wizard's container is a Modal, and it should contain
    // SOME content rather than a blank/error frame. We don't assert the exact
    // text (it'll change over milestones); we just verify the container has
    // non-trivial content.
    const modalContent = await browser.executeObsidian(({ app }) => {
      const el = document.querySelector('.modal-container .modal-content') as HTMLElement | null;
      return {
        exists: !!el,
        textLength: el?.innerText.length ?? 0,
        hasError: !!document.querySelector('.modal-container .error'),
      };
    });

    expect(modalContent.exists).toBe(true);
    expect(modalContent.textLength).toBeGreaterThan(20); // some real content rendered
    expect(modalContent.hasError).toBe(false); // no caught error displayed
  });

  it('the browse-saved-configs command opens its modal', async () => {
    await browser.executeObsidianCommand('crosswalker:browse-saved-configs');
    await browser.pause(250);

    const modal = browser.$('.modal-container');
    await expect(modal).toExist();
  });

  it('the plugin can be queried for its config-manager state without errors', async () => {
    // Sanity check the renamed types still flow through the plugin's runtime
    // without any latent reference errors.
    const info = await browser.executeObsidian(({ app }) => {
      // @ts-expect-error — internal API
      const plugin = app.plugins.plugins['crosswalker'];
      return {
        hasSettings: !!plugin?.settings,
        hasDebug: !!plugin?.debug,
        hasValidateRecipe: typeof plugin?.validateRecipe === 'function',
        hasValidateTier1: typeof plugin?.validateTier1Frontmatter === 'function',
      };
    });

    expect(info.hasSettings).toBe(true);
    expect(info.hasDebug).toBe(true);
    expect(info.hasValidateRecipe).toBe(true);
    expect(info.hasValidateTier1).toBe(true);
  });
});
