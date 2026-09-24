/**
 * visual-settings.spec.ts — the redesigned settings tab (spec §7l).
 *
 * The tab is a navigable hub, not one long scroll: an overview page (launchpad
 * + section cards) that navigates into per-section pages (back affordance +
 * that section's settings and live previews). Screenshots:
 *   - overview hub (launchpad + cards)           → settings-01-overview.png
 *   - a section page (Output, with folder tree)  → settings-02-section.png
 *   - a section page with a code preview (Naming) → settings-03-naming.png
 *   - dark theme, overview hub                    → settings-04-dark.png
 *
 *   DISPLAY=:0 bun run e2e -- --spec tests/e2e/visual-settings.spec.ts
 *
 * Screenshots land in test-screenshots/ (settings-01 … settings-04).
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('test-screenshots');

describe('Visual — redesigned settings tab', function () {
	this.timeout(120_000);

	before(async () => {
		mkdirSync(OUT, { recursive: true });
		// Let the (heavy) test vault finish its initial index before driving UI.
		await browser.pause(6000);
	});

	after(async () => {
		await browser.executeObsidian(({ app }) => {
			// @ts-expect-error — internal setting API
			app.setting?.close?.();
			document.body.classList.remove('theme-dark');
			document.body.classList.add('theme-light');
		});
	});

	it('opens the hub, navigates into sections, and screenshots each', async () => {
		// -- Stage A: open settings → Crosswalker tab → the overview hub.
		const hub = await browser.executeObsidian(async ({ app }) => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			// A settings surface already on screen would be refocused, not reopened.
			// @ts-expect-error -- internal setting API
			app.setting?.close?.();
			await sleep(150);
			// @ts-expect-error — internal setting API
			app.setting.open();
			await sleep(300);
			// @ts-expect-error — internal setting API
			app.setting.openTabById('crosswalker');
			const t0 = Date.now();
			while (Date.now() - t0 < 8000) {
				if (document.querySelector('.crosswalker-settings-cardgrid')) break;
				await sleep(100);
			}
			const root = document.querySelector('.crosswalker-settings');
			const cards = Array.from(root?.querySelectorAll('.crosswalker-settings-card') ?? []);
			return {
				ok: !!root,
				hasLaunchpad: !!root?.querySelector('.crosswalker-settings-launchpad'),
				launchButtons: root?.querySelectorAll('.crosswalker-launch-btn').length ?? 0,
				cardCount: cards.length,
				cardTitles: cards.map((c) => c.querySelector('.crosswalker-settings-card-title')?.textContent),
				cardSummaries: cards.map((c) => c.querySelector('.crosswalker-settings-card-summary')?.textContent),
				// The hub must NOT show raw setting rows — those live on the pages.
				settingItems: root?.querySelectorAll('.setting-item').length ?? 0,
			};
		});
		console.log('[settings] hub → ' + JSON.stringify(hub));
		await browser.saveScreenshot(path.join(OUT, 'settings-01-overview.png'));

		expect(hub.ok).toBe(true);
		expect(hub.hasLaunchpad).toBe(true);
		expect(hub.launchButtons).toBeGreaterThanOrEqual(2);
		// Mirror the eleven sections() cards, including Saved configurations.
		expect(hub.cardCount).toBe(11);
		expect(hub.cardTitles).toEqual([
			'Output', 'Naming', 'Cell values', 'Links between notes', 'Connections',
			'Import behavior', 'Suggestions', 'Drafts', 'Advanced', 'Diagnostics',
			'Saved configurations',
		]);
		expect(hub.settingItems).toBe(0);

		// -- Stage B: click the Output card → its page (folder tree preview).
		const output = await browser.executeObsidian(async () => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const cards = Array.from(document.querySelectorAll('.crosswalker-settings-card'));
			const outputCard = cards.find(
				(c) => c.querySelector('.crosswalker-settings-card-title')?.textContent === 'Output',
			) as HTMLButtonElement | undefined;
			if (!outputCard) return { ok: false as const };
			outputCard.click();
			await sleep(400);
			const root = document.querySelector('.crosswalker-settings');
			return {
				ok: true as const,
				hasBack: !!root?.querySelector('.crosswalker-settings-back'),
				hasTree: !!root?.querySelector('.crosswalker-setting-preview .crosswalker-wb-tree'),
				cardsGone: (root?.querySelectorAll('.crosswalker-settings-card').length ?? 0) === 0,
			};
		});
		console.log('[settings] output page → ' + JSON.stringify(output));
		await browser.saveScreenshot(path.join(OUT, 'settings-02-section.png'));
		expect(output.ok).toBe(true);
		if (output.ok) {
			expect(output.hasBack).toBe(true);
			expect(output.hasTree).toBe(true);
			expect(output.cardsGone).toBe(true);
		}

		// -- Stage C: back to hub, then open Naming (code sample preview).
		const naming = await browser.executeObsidian(async () => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			(document.querySelector('.crosswalker-settings-back') as HTMLButtonElement | null)?.click();
			await sleep(300);
			const cards = Array.from(document.querySelectorAll('.crosswalker-settings-card'));
			const namingCard = cards.find(
				(c) => c.querySelector('.crosswalker-settings-card-title')?.textContent === 'Naming',
			) as HTMLButtonElement | undefined;
			if (!namingCard) return { ok: false as const };
			namingCard.click();
			await sleep(400);
			const root = document.querySelector('.crosswalker-settings');
			return {
				ok: true as const,
				hasCode: !!root?.querySelector('.crosswalker-setting-preview .crosswalker-wb-mini'),
			};
		});
		console.log('[settings] naming page → ' + JSON.stringify(naming));
		await browser.saveScreenshot(path.join(OUT, 'settings-03-naming.png'));
		expect(naming.ok).toBe(true);
		if (naming.ok) expect(naming.hasCode).toBe(true);

		// -- Stage D: back to hub, force dark theme, screenshot the hub. Confirms
		//    the surface reads deliberately in BOTH color schemes.
		await browser.executeObsidian(async () => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			(document.querySelector('.crosswalker-settings-back') as HTMLButtonElement | null)?.click();
			await sleep(300);
			document.body.classList.remove('theme-light');
			document.body.classList.add('theme-dark');
			const sc = document.querySelector('.vertical-tab-content-container') as HTMLElement | null;
			if (sc) sc.scrollTop = 0;
			await sleep(400);
		});
		await browser.saveScreenshot(path.join(OUT, 'settings-04-dark.png'));
	});
});
