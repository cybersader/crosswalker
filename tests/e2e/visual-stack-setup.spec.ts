import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('test-screenshots');

describe('Visual — framework stack setup', function () {
	this.timeout(120_000);
	before(() => { mkdirSync(OUT, { recursive: true }); });
	afterEach(async () => {
		for (let i = 0; i < 4; i++) {
			const open = await browser.executeObsidian(() => document.querySelectorAll('.crosswalker-stack-modal, .crosswalker-stack-confirm').length);
			if (!open) break;
			await browser.keys('Escape');
		}
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error -- Obsidian internal plugin registry
			app.plugins.plugins.crosswalker.settings.stackConfirmFileThreshold = 1000;
			const file = app.vault.getAbstractFileByPath('Sources/Synthetic preview/preview.csv');
			if (file) await app.vault.delete(file);
		});
		expect(await browser.executeObsidian(() => document.querySelectorAll('.crosswalker-stack-modal, .crosswalker-stack-confirm').length)).toBe(0);
	});
	for (const theme of ['light', 'dark'] as const) {
		it(`captures picker and checklist in ${theme} theme`, async () => {
			await browser.executeObsidian(({ app }, mode) => {
				document.body.classList.toggle('theme-light', mode === 'light');
				document.body.classList.toggle('theme-dark', mode === 'dark');
				// @ts-expect-error -- Obsidian internal plugin command API
				app.commands.executeCommandById('crosswalker:set-up-framework-stack');
			}, theme);
			const modal = await $('.crosswalker-stack-modal');
			await modal.waitForDisplayed();
			const picker = await browser.executeObsidian(() => ({
				frameworks: document.querySelectorAll('.crosswalker-stack-choice input[data-ontology]:checked').length,
				connections: document.querySelectorAll('.crosswalker-stack-connection').length,
				connector: document.querySelector('.crosswalker-stack-choice.is-connector')?.textContent ?? '',
			}));
			expect(picker.frameworks).toBe(4);
			expect(picker.connections).toBe(3);
			expect(picker.connector).toContain('connect CRI Profile');
			await browser.executeObsidian(() => document.querySelectorAll('.notice-container .notice').forEach((notice) => notice.remove()));
			await browser.saveScreenshot(path.join(OUT, `visual-stack-01-picker-${theme}.png`));
			await browser.executeObsidian(() => { const modal = document.querySelector<HTMLElement>('.crosswalker-stack-modal'); if (modal) modal.style.width = '640px'; });
			await browser.saveScreenshot(path.join(OUT, `visual-stack-01-picker-${theme}-640.png`));
			await browser.executeObsidian(() => { const modal = document.querySelector<HTMLElement>('.crosswalker-stack-modal'); if (modal) modal.style.removeProperty('width'); });
			await modal.$('button=Next: download checklist').click();
			const checklist = await browser.executeObsidian(() => ({
				rows: document.querySelectorAll('.crosswalker-stack-checklist-row').length,
				links: document.querySelectorAll('.crosswalker-stack-checklist-row a').length,
				disabled: (Array.from(document.querySelectorAll('.crosswalker-stack-footer button'))
					.find((button) => button.textContent?.includes('Next: add the files')) as HTMLButtonElement | undefined)?.disabled,
			}));
			expect(checklist).toEqual({ rows: 7, links: 5, disabled: false });
			await browser.saveScreenshot(path.join(OUT, `visual-stack-02-checklist-${theme}.png`));
			await browser.executeObsidian(() => { const modal = document.querySelector<HTMLElement>('.crosswalker-stack-modal'); if (modal) modal.style.width = '640px'; });
			await browser.saveScreenshot(path.join(OUT, `visual-stack-02-checklist-${theme}-640.png`));
			await browser.executeObsidian(() => document.querySelector<HTMLButtonElement>('.crosswalker-stack-modal .modal-close-button, .crosswalker-stack-modal .modal-header-button')?.click());
		});
	}
	for (const theme of ['light', 'dark'] as const) {
		it(`captures review counts and confirmation in ${theme} theme`, async () => {
			await browser.executeObsidian(async ({ app }, mode) => {
				document.body.classList.toggle('theme-light', mode === 'light');
				document.body.classList.toggle('theme-dark', mode === 'dark');
				if (!app.vault.getAbstractFileByPath('Sources')) await app.vault.createFolder('Sources');
				if (!app.vault.getAbstractFileByPath('Sources/Synthetic preview')) await app.vault.createFolder('Sources/Synthetic preview');
				const old = app.vault.getAbstractFileByPath('Sources/Synthetic preview/preview.csv');
				if (old) await app.vault.delete(old);
				await app.vault.create('Sources/Synthetic preview/preview.csv',
					'element_identifier,element_type,title,text\nGV,Function,Synthetic govern,Synthetic description\nGV.AA,Category,Synthetic category,Synthetic description\nGV.AA-01,Subcategory,Synthetic outcome,Synthetic description\n');
				// @ts-expect-error -- Obsidian internal plugin registry
				app.plugins.plugins.crosswalker.settings.stackConfirmFileThreshold = 0;
				// @ts-expect-error -- Obsidian internal command registry
				app.commands.executeCommandById('crosswalker:set-up-framework-stack');
			}, theme);
			await $('.crosswalker-stack-modal').waitForDisplayed();
			await browser.executeObsidian(() => {
				for (const ontology of ['cri-profile', 'mitre-attack', 'nist-800-53', 'nist-csf-2']) {
					const box = document.querySelector<HTMLInputElement>(`.crosswalker-stack-choice input[data-ontology="${ontology}"]`);
					if (box && box.checked !== (ontology === 'nist-csf-2')) box.click();
				}
			});
			await browser.executeObsidian(() => Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-stack-modal button')).find((b) => b.textContent === 'Next: download checklist')?.click());
			await browser.waitUntil(async () => browser.executeObsidian(() => !!document.querySelector('.crosswalker-stack-checklist-row')));
			await browser.executeObsidian(() => Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-stack-modal button')).find((b) => b.textContent === 'Next: add the files')?.click());
			await browser.waitUntil(async () => browser.executeObsidian(() => !!document.querySelector('.crosswalker-stack-modal input[placeholder="Sources"]')));
			await browser.executeObsidian(() => {
				const input = document.querySelector<HTMLInputElement>('.crosswalker-stack-modal input[placeholder="Sources"]');
				if (input) { input.value = 'Sources/Synthetic preview'; input.dispatchEvent(new Event('input', { bubbles: true })); }
			});
			await browser.waitUntil(async () => browser.executeObsidian(() =>
				(document.querySelector<HTMLInputElement>('.crosswalker-stack-modal input[placeholder="Sources"]')?.value ?? '') === 'Sources/Synthetic preview'));
			await browser.executeObsidian(() => Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-stack-modal button')).find((b) => b.textContent === 'Choose folder')?.click());
			expect(await browser.executeObsidian(() => document.querySelectorAll('.crosswalker-stack-modal').length)).toBe(1);
			await browser.waitUntil(async () => browser.executeObsidian(() => {
				const row = document.querySelector('.crosswalker-stack-modal [data-slot="nist-csf-2"]');
				return !!row?.textContent?.includes('Recognized') || !!row?.textContent?.includes('Might match');
			}), { timeout: 30_000, timeoutMsg: 'Synthetic CSF source was not recognized' });
			await browser.executeObsidian(() => document.querySelector<HTMLButtonElement>('.crosswalker-stack-modal [data-slot="nist-csf-2"] button')?.click());
			await browser.executeObsidian(() => Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-stack-modal button')).find((b) => b.textContent === 'Next: review')?.click());
			await browser.waitUntil(async () => browser.executeObsidian(() =>
				!!document.querySelector('.crosswalker-stack-total')?.textContent?.includes('files')),
			{ timeout: 30_000 });
			const planned = await browser.executeObsidian(() => ({
				rows: document.querySelectorAll('.crosswalker-stack-modal [data-planned-notes]').length,
				total: document.querySelector('.crosswalker-stack-total')?.textContent ?? '',
			}));
			expect(planned.rows).toBe(1);
			expect(planned.total).toContain('new files');
			await browser.saveScreenshot(path.join(OUT, `visual-stack-03-review-${theme}.png`));
			await browser.executeObsidian(() => {
				Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-stack-footer button'))
					.find((button) => button.textContent?.startsWith('Import stack ('))?.click();
			});
			await $('.crosswalker-stack-confirm').waitForDisplayed();
			await browser.saveScreenshot(path.join(OUT, `visual-stack-04-confirm-${theme}.png`));
			const before = await browser.executeObsidian(({ app }) => app.vault.getFiles()
				.map((file) => [file.path, file.stat.mtime, file.stat.size]));
			await browser.executeObsidian(({ app }) => {
				const state = window as unknown as { __stackWriteEvents: string[]; __stackStopWrites: () => void };
				state.__stackWriteEvents = [];
				const refs = (['create', 'modify', 'delete'] as const).map((event) =>
					app.vault.on(event, () => state.__stackWriteEvents.push(event)));
				state.__stackStopWrites = () => refs.forEach((ref) => app.vault.offref(ref));
			});
			await browser.executeObsidian(() => Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-stack-confirm button')).find((b) => b.textContent === 'Back to review')?.click());
			const writes = await browser.executeObsidian(() => {
				const state = window as unknown as { __stackWriteEvents: string[]; __stackStopWrites: () => void };
				state.__stackStopWrites(); return state.__stackWriteEvents;
			});
			expect(writes).toEqual([]);
			expect(await browser.executeObsidian(({ app }) => app.vault.getFiles()
				.map((file) => [file.path, file.stat.mtime, file.stat.size]))).toEqual(before);
			await browser.executeObsidian(async ({ app }) => {
				// @ts-expect-error -- Obsidian internal plugin registry
				app.plugins.plugins.crosswalker.settings.stackConfirmFileThreshold = 1000;
				const file = app.vault.getAbstractFileByPath('Sources/Synthetic preview/preview.csv');
				if (file) await app.vault.delete(file);
			});
		});
	}

});
