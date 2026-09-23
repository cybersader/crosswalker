/// <reference types="mocha" />

/**
 * Visual contract for body projection (nest `leaf: section`) in the shape
 * workbench: the `Below the note` select beside Depth, the per-level
 * Placement and Section text selects, and the sample note preview showing
 * section headings.
 *
 * Screenshots: test-screenshots/bp-<surface>-<theme>-<width>.png
 * Observations: test-screenshots/body-projection-geometry.json
 */

import 'webdriverio';
import 'wdio-obsidian-service';
import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	clearAllDrafts,
	closeCrosswalkerLeaves,
	closeImportWizard,
	openImportWizard,
} from './helpers/wizard-modal';

const OUT = path.resolve('test-screenshots');
const GEOMETRY_PATH = path.join(OUT, 'body-projection-geometry.json');
const FIXTURE_TEXT = readFileSync(path.resolve('tests/fixtures/oscal-mini.json'), 'utf8');
const WIZARD = '.crosswalker-wizard-modal';
// BP_DOM_ONLY=1 records observations without screenshots, for hosts where the
// compositor is not producing frames and every capture times out.
const DOM_ONLY = process.env.BP_DOM_ONLY === '1';

type Theme = 'light' | 'dark';
type Width = 'normal' | '640px';
type JsonRecord = Record<string, unknown>;

const geometry: { createdUtc: string; observations: JsonRecord[]; screenshots: string[] } = {
	createdUtc: new Date().toISOString(),
	observations: [],
	screenshots: [],
};

function flush(): void {
	writeFileSync(GEOMETRY_PATH, JSON.stringify(geometry, null, 2) + '\n', 'utf8');
}

async function setTheme(theme: Theme): Promise<void> {
	await browser.executeObsidian((_obs, requested) => {
		document.body.classList.toggle('theme-dark', requested === 'dark');
		document.body.classList.toggle('theme-light', requested === 'light');
	}, theme);
	await browser.pause(150);
}

async function setWidth(width: Width): Promise<void> {
	await browser.executeObsidian((_obs, args) => {
		const root = document.querySelector<HTMLElement>(args.wizard);
		if (!root) return;
		if (args.width === '640px') root.style.width = '640px';
		else root.style.removeProperty('width');
	}, { wizard: WIZARD, width });
	await browser.pause(100);
}

async function waitFor(predicateSelector: string, timeoutMs = 10_000): Promise<boolean> {
	return browser.executeObsidian(async (_obs, args) => {
		const started = Date.now();
		while (Date.now() - started < args.timeoutMs) {
			if (document.querySelector(args.selector)) return true;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return false;
	}, { selector: predicateSelector, timeoutMs });
}

async function reachNestedWorkbench(): Promise<void> {
	expect((await openImportWizard()).opened).toBe(true);
	const injected = await browser.executeObsidian(async (_obs, args) => {
		const root = document.querySelector(args.wizard);
		const input = root?.querySelector<HTMLInputElement>('input[type=file]');
		if (!root || !input) return 'NO_FILE_INPUT';
		const transfer = new DataTransfer();
		transfer.items.add(new File([args.text], 'oscal-mini.json', { type: 'application/json' }));
		input.files = transfer.files;
		input.dispatchEvent(new Event('change'));
		const started = Date.now();
		while (Date.now() - started < 10_000) {
			const groups = Array.from(root.querySelectorAll<HTMLElement>('.crosswalker-json-pick'))
				.find((card) => card.querySelector('.crosswalker-json-pick-label')?.textContent?.trim() === 'groups');
			const radio = groups?.querySelector<HTMLInputElement>('.crosswalker-json-nest-choices input[type=radio][value="nested"]');
			if (radio) {
				radio.click();
				radio.dispatchEvent(new Event('change', { bubbles: true }));
				return 'READY';
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return 'NO_NESTED_CHOICE';
	}, { wizard: WIZARD, text: FIXTURE_TEXT });
	expect(injected).toBe('READY');
	await browser.pause(300);

	await browser.executeObsidian((_obs, wizard) => {
		const next = Array.from(document.querySelector(wizard)?.querySelectorAll<HTMLButtonElement>('button') ?? [])
			.find((button) => button.textContent?.includes('Next'));
		next?.click();
	}, WIZARD);
	expect(await waitFor(`${WIZARD} .crosswalker-recognized-card, ${WIZARD} .crosswalker-wb-mapcard`, 15_000)).toBe(true);
	await browser.executeObsidian((_obs, wizard) => {
		const button = Array.from(document.querySelector(wizard)?.querySelectorAll<HTMLButtonElement>('.crosswalker-recognized-actions button') ?? [])
			.find((candidate) => candidate.textContent?.trim() === 'Customize');
		button?.click();
	}, WIZARD);
	expect(await waitFor(`${WIZARD} .crosswalker-wb-mapcard`)).toBe(true);

	await browser.executeObsidian(async (_obs, wizard) => {
		const root = document.querySelector(wizard);
		let card = root?.querySelector<HTMLElement>('.crosswalker-wb-mapcard') ?? null;
		if (!card?.querySelector('.crosswalker-wb-shapes')) card?.querySelector<HTMLButtonElement>('.crosswalker-wb-mapcard-toggle')?.click();
		await new Promise((resolve) => setTimeout(resolve, 300));
		card = root?.querySelector<HTMLElement>('.crosswalker-wb-mapcard') ?? null;
		if (!card?.querySelector('.crosswalker-wb-matrix')) card?.querySelector<HTMLButtonElement>('.crosswalker-wb-arrange')?.click();
	}, WIZARD);
	expect(await waitFor(`${WIZARD} .crosswalker-wb-mapcard .crosswalker-wb-matrix`)).toBe(true);
}

async function setSelect(selector: string, value: string): Promise<boolean> {
	const ok = await browser.executeObsidian((_obs, args) => {
		const select = document.querySelector<HTMLSelectElement>(args.selector);
		if (!select || !Array.from(select.options).some((option) => option.value === args.value)) return false;
		select.value = args.value;
		select.dispatchEvent(new Event('change', { bubbles: true }));
		return true;
	}, { selector, value });
	await browser.pause(400);
	return ok;
}

const DEPTH = `${WIZARD} .crosswalker-wb-mapcard .crosswalker-wb-depth select.dropdown[aria-label="Depth"]`;
const BELOW = `${WIZARD} .crosswalker-wb-mapcard [data-nest-control="below-note"]`;

async function observe(surface: string, theme: Theme, width: Width, scrollTo: string): Promise<JsonRecord> {
	await setTheme(theme);
	await setWidth(width);
	await browser.executeObsidian((_obs, selector) => {
		document.querySelector(selector)?.scrollIntoView({ block: 'center' });
	}, scrollTo);
	await browser.pause(150);
	const observation = await browser.executeObsidian((_obs, args) => {
		const root = document.querySelector(args.wizard);
		const card = root?.querySelector<HTMLElement>('.crosswalker-wb-mapcard') ?? null;
		const text = (selector: string) => Array.from(card?.querySelectorAll<HTMLElement>(selector) ?? [])
			.map((element) => element.textContent?.trim() ?? '');
		const selectState = (selector: string) => Array.from(card?.querySelectorAll<HTMLSelectElement>(selector) ?? [])
			.map((select) => ({
				label: select.getAttribute('aria-label'),
				value: select.value,
				disabled: select.disabled,
				options: Array.from(select.options).map((option) => option.text),
				overflows: (() => {
					const r = select.getBoundingClientRect();
					const c = card?.getBoundingClientRect();
					return Boolean(c && (r.left < c.left || r.right > c.right));
				})(),
			}));
		return {
			surface: args.surface,
			theme: args.theme,
			width: args.width,
			depth: (card?.querySelector<HTMLSelectElement>('.crosswalker-wb-depth select.dropdown[aria-label="Depth"]'))?.value ?? null,
			below: selectState('[data-nest-control="below-note"]'),
			placement: selectState('[data-nest-control="placement"]'),
			sectionText: selectState('[data-nest-control="section-text"]'),
			hints: text('.crosswalker-wb-depth-hint'),
			counts: text('[data-depth-counts]'),
			warnings: text('[data-nest-warning]'),
			preview: root?.querySelector<HTMLElement>('[data-preview-content="sample-note"]')?.textContent ?? null,
			// Matrix geometry: the level matrix sits in a horizontal scroll
			// container, so a table wider than the card is what pushes nest
			// controls outside the card rect.
			matrix: (() => {
				const wrap = card?.querySelector<HTMLElement>('.crosswalker-wb-matrix-wrap');
				const table = card?.querySelector<HTMLElement>('.crosswalker-wb-matrix');
				return {
					card: Math.round(card?.getBoundingClientRect().width ?? 0),
					wrapClient: wrap?.clientWidth ?? null,
					wrapScroll: wrap?.scrollWidth ?? null,
					wrapScrollLeft: wrap?.scrollLeft ?? null,
					table: Math.round(table?.getBoundingClientRect().width ?? 0),
					columns: Array.from(table?.querySelectorAll<HTMLElement>('thead th') ?? [])
						.map((th) => Math.round(th.getBoundingClientRect().width)),
				};
			})(),
		};
	}, { wizard: WIZARD, surface, theme, width });
	expect(JSON.stringify(observation)).not.toContain('—');
	geometry.observations.push(observation);
	if (!DOM_ONLY) {
		const target = path.join(OUT, `bp-${surface}-${theme}-${width}.png`);
		await browser.saveScreenshot(target);
		geometry.screenshots.push(target);
	}
	flush();
	return observation;
}

describe('Visual body projection surfaces', function () {
	this.timeout(240_000);

	before(async () => {
		mkdirSync(OUT, { recursive: true });
		await closeImportWizard();
		await closeCrosswalkerLeaves();
		await clearAllDrafts();
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error internal plugins API
			const plugin = app.plugins.plugins['crosswalker'];
			plugin.settings.enableShapeWorkbench = true;
			plugin.settings.enableConfigSuggestions = false;
			await plugin.saveSettings();
		});
	});

	after(async () => {
		await setWidth('normal');
		await closeImportWizard();
		await clearAllDrafts();
		await closeCrosswalkerLeaves();
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error internal plugins API
			const plugin = app.plugins.plugins['crosswalker'];
			if (plugin) {
				plugin.settings.enableShapeWorkbench = false;
				plugin.settings.enableConfigSuggestions = true;
				await plugin.saveSettings();
			}
			document.body.classList.remove('theme-dark');
			document.body.classList.add('theme-light');
		});
		flush();
	});

	it('captures section mode on the Depth dial, level rows, and preview', async () => {
		await reachNestedWorkbench();
		expect(await setSelect(DEPTH, '1')).toBe(true);

		const before = await observe('depth-left-out', 'light', 'normal', `${WIZARD} .crosswalker-wb-depth`);
		expect((before.below as JsonRecord[])[0]?.value).toBe('none');
		const leftOutHint = (before.hints as string[])[0];

		expect(await setSelect(BELOW, 'section')).toBe(true);
		for (const theme of ['light', 'dark'] as const) {
			for (const width of ['normal', '640px'] as const) {
				const obs = await observe('depth-sections', theme, width, `${WIZARD} .crosswalker-wb-depth`);
				expect((obs.below as JsonRecord[])[0]?.value).toBe('section');
			}
			await observe('rows-sections', theme, 'normal', `${WIZARD} [data-nest-control="placement"]`);
			await observe('preview-sections', theme, 'normal', `${WIZARD} [data-preview-note="sample"]`);
		}

		expect(await setSelect(BELOW, 'none')).toBe(true);
		const after = await observe('depth-left-out-again', 'light', 'normal', `${WIZARD} .crosswalker-wb-depth`);
		expect((after.hints as string[])[0]).toBe(leftOutHint);

		for (const screenshot of geometry.screenshots) expect(existsSync(screenshot)).toBe(true);

		// Asserted after every surface is recorded so one failure still leaves
		// the full geometry file for diagnosis.
		for (const obs of geometry.observations) {
			expect(typeof obs.preview === 'string' && obs.preview.trim().length > 0).toBe(true);
			if (String(obs.surface).includes('sections')) expect(String(obs.preview)).toMatch(/^## \S/m);
			for (const select of [...(obs.placement as JsonRecord[]), ...(obs.sectionText as JsonRecord[])]) {
				expect({ surface: obs.surface, width: obs.width, label: select.label, overflows: select.overflows })
					.toEqual({ surface: obs.surface, width: obs.width, label: select.label, overflows: false });
			}
		}
	});
});
