import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('test-screenshots');

describe('Visual — framework stack setup', function () {
	this.timeout(120_000);
	before(() => { mkdirSync(OUT, { recursive: true }); });
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
			expect(checklist).toEqual({ rows: 7, links: 5, disabled: true });
			await browser.saveScreenshot(path.join(OUT, `visual-stack-02-checklist-${theme}.png`));
			await browser.executeObsidian(() => { const modal = document.querySelector<HTMLElement>('.crosswalker-stack-modal'); if (modal) modal.style.width = '640px'; });
			await browser.saveScreenshot(path.join(OUT, `visual-stack-02-checklist-${theme}-640.png`));
			await browser.executeObsidian(() => document.querySelector<HTMLButtonElement>('.crosswalker-stack-modal .modal-close-button, .crosswalker-stack-modal .modal-header-button')?.click());
		});
	}
});
