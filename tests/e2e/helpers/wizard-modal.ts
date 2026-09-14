/**
 * wizard-modal.ts — resolve, open, and close the Crosswalker import wizard
 * deterministically.
 *
 * WHY THIS EXISTS (triage 2026-08-24 §4 B3–B6)
 * ---------------------------------------------
 * Six declarations failed because specs reached for `document.querySelector('.modal')`
 * and `document.querySelector('.modal-close-button')` — the *first generic modal
 * in the document*. After two or three wizard open/close cycles that can be a
 * stale or hidden container, so the spec reported `NO_FILE_INPUT` /
 * `NO_NEXT_BUTTON` about a modal the product had already finished with.
 *
 * `src/import/import-wizard.ts:3429` marks the wizard's own `modalEl` with
 * `crosswalker-wizard-modal` in `onOpen()`. That class is the identity to key
 * on, and only a *visible, connected* element with it is the live wizard.
 *
 * Contract for specs:
 *   1. call `openImportWizard()` (it closes any predecessor and proves it is
 *      gone before opening a new one);
 *   2. inside `executeObsidian`, scope every query to
 *      `document.querySelector('.crosswalker-wizard-modal')` — safe because
 *      step 1 guarantees at most one;
 *   3. call `closeImportWizard()` at the end of the declaration.
 */

import { browser } from '@wdio/globals';

/** Vault-visible class the wizard modal element carries (see import-wizard.ts). */
export const WIZARD_MODAL_SELECTOR = '.crosswalker-wizard-modal';

export interface WizardOpenResult {
	opened: boolean;
	/** Why the wizard is not usable, when `opened` is false. */
	reason: 'OK' | 'PRIOR_MODAL_STILL_OPEN' | 'NO_WIZARD_MODAL' | 'NO_FILE_INPUT';
	/** Visible `.crosswalker-wizard-modal` elements at the end of the wait. */
	visibleWizards: number;
	/** Every `.modal` in the document, wizard or not — diagnostic only. */
	genericModals: number;
	waitedMs: number;
}

/**
 * Close every connected Crosswalker wizard modal and wait until none remain in
 * the DOM.
 *
 * **The condition:** no element matching `.crosswalker-wizard-modal` is still
 * `isConnected`. Obsidian detaches the container on close, so "still in the
 * document" is exactly the leakage state that produced the stale-modal
 * failures — a fixed 300 ms sleep neither observed nor guaranteed it.
 */
export async function closeImportWizard(options: { timeoutMs?: number } = {}): Promise<{
	closed: boolean;
	clicked: number;
	remaining: number;
	waitedMs: number;
}> {
	return browser.executeObsidian(
		async (_obs, args) => {
			const started = Date.now();
			const live = () =>
				Array.from(document.querySelectorAll<HTMLElement>(args.selector)).filter((el) => el.isConnected);
			let clicked = 0;
			while (live().length > 0) {
				const target = live()[live().length - 1];
				const button = target.querySelector<HTMLElement>('.modal-close-button, .modal-header-button');
				if (button) {
					button.click();
					clicked += 1;
				} else {
					// No chrome to click (a partially torn-down modal): detach the
					// container so the next open starts from a clean document.
					(target.closest('.modal-container') ?? target).remove();
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
				if (Date.now() - started >= args.timeoutMs) break;
			}
			return {
				closed: live().length === 0,
				clicked,
				remaining: live().length,
				waitedMs: Date.now() - started,
			};
		},
		{ selector: WIZARD_MODAL_SELECTOR, timeoutMs: options.timeoutMs ?? 5_000 },
	);
}

/**
 * Open the import wizard and wait until exactly one *visible* wizard modal with
 * a usable file input is present.
 *
 * **The conditions waited on, in order:**
 *   1. no predecessor `.crosswalker-wizard-modal` remains connected;
 *   2. a `.crosswalker-wizard-modal` exists that is connected *and* rendered
 *      (`getClientRects().length > 0`) — a hidden leftover does not qualify;
 *   3. `input[type=file]` exists inside that element. Step 1 content renders
 *      after `loadAvailableDrafts()` resolves, so the input appears a beat
 *      after the modal shell; polling for it replaces the old fixed 400 ms
 *      sleep that sometimes sampled the shell too early.
 *
 * `requireFileInput: false` skips condition 3 for flows that open the wizard on
 * a non-Step-1 surface.
 */
export async function openImportWizard(options: {
	commandId?: string;
	timeoutMs?: number;
	requireFileInput?: boolean;
} = {}): Promise<WizardOpenResult> {
	const closed = await closeImportWizard();
	if (!closed.closed) {
		return {
			opened: false,
			reason: 'PRIOR_MODAL_STILL_OPEN',
			visibleWizards: closed.remaining,
			genericModals: -1,
			waitedMs: closed.waitedMs,
		};
	}

	return browser.executeObsidian(
		async ({ app }, args) => {
			const started = Date.now();
			const visible = () =>
				Array.from(document.querySelectorAll<HTMLElement>(args.selector))
					.filter((el) => el.isConnected && el.getClientRects().length > 0);

			(app as unknown as { commands: { executeCommandById(id: string): unknown } })
				.commands.executeCommandById(args.commandId);

			let wizard: HTMLElement | null = null;
			for (;;) {
				const found = visible();
				if (found.length > 0) {
					wizard = found[found.length - 1];
					if (!args.requireFileInput || wizard.querySelector('input[type=file]')) break;
				}
				if (Date.now() - started >= args.timeoutMs) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const genericModals = document.querySelectorAll('.modal').length;
			const visibleWizards = visible().length;
			if (!wizard) {
				return {
					opened: false,
					reason: 'NO_WIZARD_MODAL' as const,
					visibleWizards,
					genericModals,
					waitedMs: Date.now() - started,
				};
			}
			if (args.requireFileInput && !wizard.querySelector('input[type=file]')) {
				return {
					opened: false,
					reason: 'NO_FILE_INPUT' as const,
					visibleWizards,
					genericModals,
					waitedMs: Date.now() - started,
				};
			}
			return {
				opened: true,
				reason: 'OK' as const,
				visibleWizards,
				genericModals,
				waitedMs: Date.now() - started,
			};
		},
		{
			selector: WIZARD_MODAL_SELECTOR,
			commandId: options.commandId ?? 'crosswalker:import-structured-data',
			timeoutMs: options.timeoutMs ?? 10_000,
			requireFileInput: options.requireFileInput ?? true,
		},
	);
}

/** Throwing form of {@link openImportWizard} — the diagnostics go in the message. */
export async function requireImportWizard(
	options: Parameters<typeof openImportWizard>[0] = {},
): Promise<WizardOpenResult> {
	const result = await openImportWizard(options);
	if (!result.opened) {
		throw new Error(
			`import wizard did not reach a usable state: ${result.reason} `
			+ `(visible wizards=${result.visibleWizards}, generic .modal elements=${result.genericModals}, `
			+ `waited ${result.waitedMs}ms)`,
		);
	}
	return result;
}

/**
 * Drop every saved draft session so a spec's draft assertions describe only
 * what that spec seeded. Waits until `draftStore.list()` reports zero, rather
 * than sleeping after firing the command.
 */
export async function clearAllDrafts(options: { timeoutMs?: number } = {}): Promise<{ cleared: boolean; remaining: number }> {
	return browser.executeObsidian(
		async ({ app }, args) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, {
					draftStore?: { list(): Promise<unknown[]>; clearAll(): Promise<number> };
				}> };
			}).plugins.plugins['crosswalker'];

			// Call the store directly rather than firing the command: the command
			// is only registered while draft sessions are enabled, and it returns
			// no promise, so a spec could not tell clearing from not-clearing.
			if (plugin?.draftStore) {
				await plugin.draftStore.clearAll();
			} else {
				(app as unknown as { commands: { executeCommandById(id: string): unknown } })
					.commands.executeCommandById('crosswalker:clear-all-drafts');
			}

			const started = Date.now();
			let remaining = -1;
			for (;;) {
				try {
					remaining = plugin?.draftStore ? (await plugin.draftStore.list()).length : 0;
				} catch {
					remaining = -1;
				}
				if (remaining === 0) return { cleared: true, remaining: 0 };
				if (Date.now() - started >= args.timeoutMs) return { cleared: false, remaining };
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		},
		{ timeoutMs: options.timeoutMs ?? 5_000 },
	);
}

/**
 * Detach any Crosswalker workspace-view leaves so a spec that expects to mount
 * a fresh view is not looking at one an earlier spec left open.
 */
export async function closeCrosswalkerLeaves(): Promise<number> {
	return browser.executeObsidian(({ app }) => {
		const leaves = app.workspace.getLeavesOfType('crosswalker-workspace');
		for (const leaf of leaves) leaf.detach();
		return leaves.length;
	});
}
