/**
 * visual-two-structural-banner.spec.ts — the B2 preview-error banner, visually.
 *
 * Reproduces the 2026-07-12 hands-on finding: ticking "Folders" on a second
 * mapping card creates a two-structural state; the preview rail must show a
 * READABLE error banner (message text visible, bounded height), not an
 * unreadable solid-orange slab (the pre-fix rendering under themes where
 * --background-modifier-warning resolves to solid orange).
 *
 *   DISPLAY=:0 bun run e2e -- --spec tests/e2e/visual-two-structural-banner.spec.ts
 *
 * Screenshot: test-screenshots/wb-10-two-structural-banner.png
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('test-screenshots');

const ATTACK_CSV = [
	'technique_id,name,tactic,description',
	'T1055,Process Injection,Defense Evasion,"Adversaries may inject code into processes in order to evade process-based defenses as well as possibly elevate privileges."',
	'T1055.001,Dynamic-link Library Injection,Defense Evasion,"Adversaries may inject dynamic-link libraries into processes in order to evade process-based defenses."',
	'T1059,Command and Scripting Interpreter,Execution,"Adversaries may abuse command and script interpreters to execute commands, scripts, or binaries."',
	'T1059.001,PowerShell,Execution,"Adversaries may abuse PowerShell commands and scripts for execution."',
	'T1547,Boot or Logon Autostart Execution,Persistence,"Adversaries may configure system settings to automatically execute a program during system boot or logon."',
	'T1547.001,Registry Run Keys / Startup Folder,Persistence,"Adversaries may achieve persistence by adding a program to a startup folder."',
].join('\n');

describe('Visual — two-structural preview-error banner (B2)', function () {
	this.timeout(180_000);

	before(async () => {
		mkdirSync(OUT, { recursive: true });
		await browser.pause(6000);
		await browser.executeObsidian(async ({ app }) => {
			// Reproduce the reported environment: the original invisible orange slab
			// occurred in dark mode.
			document.body.classList.remove('theme-light');
			document.body.classList.add('theme-dark');
			// @ts-expect-error — internal plugins API
			const plugin = app.plugins.plugins['crosswalker'];
			plugin.settings.enableShapeWorkbench = true;
			plugin.settings.enableConfigSuggestions = false;
			plugin.settings.enableDraftSessions = false;
			await plugin.saveSettings();
		});
	});

	after(async () => {
		await browser.executeObsidian(async ({ app }) => {
			document.querySelector<HTMLElement>('.modal-close-button, .modal-header-button')?.click();
			// @ts-expect-error — internal plugins API
			const plugin = app.plugins.plugins['crosswalker'];
			if (plugin) {
				plugin.settings.enableShapeWorkbench = false;
				plugin.settings.enableConfigSuggestions = true;
				plugin.settings.enableDraftSessions = true;
				await plugin.saveSettings();
			}
		});
	});

	it('shows a readable, bounded error banner when a second structural mapping is ticked', async () => {
		const info = await browser.executeObsidian(async ({ app }, csv) => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const waitFor = async (sel: string, ms: number) => {
				const t0 = Date.now();
				while (Date.now() - t0 < ms) {
					const el = document.querySelector(sel);
					if (el) return el;
					await sleep(100);
				}
				return null;
			};
			document.querySelector<HTMLElement>('.modal-close-button, .modal-header-button')?.click();
			await sleep(300);

			// @ts-expect-error — commands API is untyped
			app.commands.executeCommandById('crosswalker:import-structured-data');
			const modal = await waitFor('.modal', 8000);
			if (!modal) return { ok: false as const, reason: 'NO_MODAL' };
			const input = (await waitFor('.modal input[type=file]', 8000)) as HTMLInputElement | null;
			if (!input) return { ok: false as const, reason: 'NO_FILE_INPUT' };
			const dt = new DataTransfer();
			dt.items.add(new File([csv], 'attack-banner-repro.csv'));
			input.files = dt.files;
			input.dispatchEvent(new Event('change'));
			await sleep(700);
			const next = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent?.includes('Next'));
			if (!next) return { ok: false as const, reason: 'NO_NEXT' };
			(next as HTMLButtonElement).click();
			const bench = await waitFor('.crosswalker-workbench', 8000);
			if (!bench) return { ok: false as const, reason: 'NO_WORKBENCH' };

			// Find the tactic mapping card and tick its "Folders" shape checkbox —
			// the exact hands-on repro. Expand the card first (shape cards render
			// inside the expanded body).
			const findTacticCard = () =>
				Array.from(document.querySelectorAll('.crosswalker-wb-mapcard')).find((c) =>
					c.textContent?.includes('tactic'),
				);
			let tacticCard = findTacticCard();
			if (!tacticCard) return { ok: false as const, reason: 'NO_TACTIC_CARD', cards: document.querySelectorAll('.crosswalker-wb-mapcard').length };
			// Expand via the ▸ toggle (the head itself is not a click target), then
			// re-find the card: scheduleRerender() rebuilds the whole canvas DOM.
			(tacticCard.querySelector('.crosswalker-wb-mapcard-toggle') as HTMLElement | null)?.click();
			await sleep(600);
			tacticCard = findTacticCard();
			if (!tacticCard) return { ok: false as const, reason: 'NO_TACTIC_CARD_POST_EXPAND' };
			const shapes = Array.from(tacticCard.querySelectorAll('.crosswalker-wb-shape'));
			const foldersShape = shapes.find((s) => s.textContent?.includes('Folders'));
			if (!foldersShape) return { ok: false as const, reason: 'NO_FOLDERS_SHAPE', shapes: shapes.length };
			const cb = foldersShape.querySelector('input[type=checkbox]') as HTMLInputElement | null;
			if (!cb) return { ok: false as const, reason: 'NO_CHECKBOX' };
			cb.checked = true;
			cb.dispatchEvent(new Event('change'));
			await sleep(500);

			const banner = document.querySelector('.crosswalker-render-banner.is-warning') as HTMLElement | null;
			if (!banner) return { ok: false as const, reason: 'NO_BANNER' };
			const text = banner.querySelector('.crosswalker-render-banner-text') as HTMLElement | null;
			const bannerRect = banner.getBoundingClientRect();
			const cs = getComputedStyle(banner);
			const textCs = text ? getComputedStyle(text) : null;
			return {
				ok: true as const,
				message: text?.textContent ?? '',
				bannerHeight: Math.round(bannerRect.height),
				bannerWidth: Math.round(bannerRect.width),
				background: cs.backgroundColor,
				textColor: textCs?.color ?? '',
			};
		}, ATTACK_CSV);

		console.log('[banner] → ' + JSON.stringify(info));
		await browser.saveScreenshot(path.join(OUT, 'wb-10-two-structural-banner.png'));
		expect(info.ok).toBe(true);
		if (info.ok) {
			// Plain language: names both conflicting mappings + the way out.
			expect(info.message).toContain('technique_id and tactic');
			expect(info.message).toContain('On one mapping, untick Folders and File names');
			// No engineer-facing internals in user copy.
			expect(info.message).not.toContain('instantiate()');
			expect(info.message).not.toContain('spec section');
			// Compact: a warning, not a rail-filling slab.
			expect(info.bannerHeight).toBeLessThan(170);
			// Not orange-on-orange: text color must differ from the background.
			expect(info.textColor).not.toBe(info.background);
		}
	});
});
