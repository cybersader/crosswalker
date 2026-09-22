/// <reference types="mocha" />

/**
 * Visual contract for nested JSON selection, nested Arrange levels rows, the
 * Depth dial, and the equivalent flat JSON path.
 *
 * The harness rejects window resizing. Narrow captures therefore apply a
 * temporary 640px inline width to the owned wizard modal.
 *
 * Screenshots: test-screenshots/ns-<surface>-<theme>-<width>.png
 * Geometry: test-screenshots/nested-surfaces-geometry.json
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
const GEOMETRY_PATH = path.join(OUT, 'nested-surfaces-geometry.json');
const FIXTURE_PATH = path.resolve('tests/fixtures/oscal-mini.json');
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, 'utf8');
const WIZARD = '.crosswalker-wizard-modal';

type Theme = 'light' | 'dark';
type Width = 'normal' | '640px';
type JsonRecord = Record<string, unknown>;

const geometry: {
	createdUtc: string;
	runtime?: JsonRecord;
	customCaptured?: boolean;
	observations: JsonRecord[];
	screenshots: string[];
} = {
	createdUtc: new Date().toISOString(),
	observations: [],
	screenshots: [],
};

function flushGeometry(): void {
	writeFileSync(GEOMETRY_PATH, JSON.stringify(geometry, null, 2) + '\n', 'utf8');
	console.log(`[nested-surfaces:geometry] ${JSON.stringify(geometry)}`);
}

function assertNoEmDash(value: unknown): void {
	expect(JSON.stringify(value)).not.toContain('—');
}

async function setTheme(theme: Theme): Promise<void> {
	await browser.executeObsidian((_obs, requested) => {
		document.body.classList.toggle('theme-dark', requested === 'dark');
		document.body.classList.toggle('theme-light', requested === 'light');
	}, theme);
	await browser.pause(150);
}

async function setInlineWidth(selector: string, width: Width): Promise<void> {
	await browser.executeObsidian((_obs, args) => {
		const root = document.querySelector<HTMLElement>(args.selector);
		if (!root) return;
		if (args.width === '640px') root.style.width = '640px';
		else root.style.removeProperty('width');
	}, { selector, width });
	await browser.pause(100);
}

async function clearInlineWidth(selector: string): Promise<void> {
	await browser.executeObsidian((_obs, target) => {
		document.querySelector<HTMLElement>(target)?.style.removeProperty('width');
	}, selector);
}

async function saveCapture(
	surface: string,
	theme: Theme,
	width: Width,
	observation: JsonRecord,
): Promise<string> {
	assertNoEmDash(observation);
	geometry.observations.push(observation);
	const target = path.join(OUT, `ns-${surface}-${theme}-${width}.png`);
	await browser.saveScreenshot(target);
	geometry.screenshots.push(target);
	expect(existsSync(target)).toBe(true);
	flushGeometry();
	return target;
}

function recordLayoutFindings(observation: JsonRecord, findings: string[]): void {
	observation.layoutFindings = findings;
	if (findings.length > 0) {
		console.log(`[nested-surfaces:layout-finding] ${JSON.stringify({
			theme: observation.theme,
			width: observation.width,
			kind: observation.kind,
			findings,
		})}`);
	}
}

async function injectOscalJson(): Promise<void> {
	const opened = await openImportWizard();
	expect(opened.opened).toBe(true);
	const result = await browser.executeObsidian(async (_obs, args) => {
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
			if (groups?.querySelector('.crosswalker-json-nest-summary')
				&& groups.querySelectorAll('.crosswalker-json-nest-choices input[type=radio]').length === 2) {
				return 'READY';
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return 'NO_GROUPS_NEST_CHOICE';
	}, { wizard: WIZARD, text: FIXTURE_TEXT });
	expect(result).toBe('READY');
}

async function capturePicker(
	surface: 'picker-nested-choice' | 'picker-nested-chosen',
	theme: Theme,
	width: Width,
): Promise<JsonRecord> {
	await setTheme(theme);
	await setInlineWidth(WIZARD, width);
	await browser.executeObsidian((_obs, wizard) => {
		const root = document.querySelector(wizard);
		const card = Array.from(root?.querySelectorAll<HTMLElement>('.crosswalker-json-pick') ?? [])
			.find((candidate) => candidate.querySelector('.crosswalker-json-pick-label')?.textContent?.trim() === 'groups');
		card?.scrollIntoView({ block: 'center' });
	}, WIZARD);
	await browser.pause(100);
	const observation = await browser.executeObsidian((_obs, args) => {
		type BrowserRect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
		const rect = (element: Element | null): BrowserRect | null => {
			if (!element) return null;
			const value = element.getBoundingClientRect();
			return {
				left: value.left,
				top: value.top,
				right: value.right,
				bottom: value.bottom,
				width: value.width,
				height: value.height,
			};
		};
		const intersects = (left: BrowserRect | null, right: BrowserRect | null) => Boolean(
			left && right
				&& left.left < right.right && left.right > right.left
				&& left.top < right.bottom && left.bottom > right.top,
		);
		const outsideHorizontally = (child: BrowserRect | null, parent: BrowserRect | null) => Boolean(
			child && parent && (child.left < parent.left || child.right > parent.right),
		);
		const root = document.querySelector(args.wizard);
		const card = Array.from(root?.querySelectorAll<HTMLElement>('.crosswalker-json-pick') ?? [])
			.find((candidate) => candidate.querySelector('.crosswalker-json-pick-label')?.textContent?.trim() === 'groups') ?? null;
		const summary = card?.querySelector<HTMLElement>('.crosswalker-json-nest-summary') ?? null;
		const choices = card?.querySelector<HTMLElement>('.crosswalker-json-nest-choices') ?? null;
		const labels = Array.from(choices?.querySelectorAll<HTMLLabelElement>('label') ?? []).map((label) => {
			const radio = label.querySelector<HTMLInputElement>('input[type=radio]');
			return {
				text: label.textContent?.trim() ?? '',
				value: radio?.value ?? null,
				checked: radio?.checked ?? false,
				rect: rect(label),
			};
		});
		const cardRect = rect(card);
		const summaryRect = rect(summary);
		const choicesRect = rect(choices);
		return {
			kind: args.surface,
			theme: args.theme,
			width: args.width,
			summaryText: summary?.textContent?.trim() ?? '',
			radioLabels: labels,
			checkedRadio: labels.find((label) => label.checked)?.value ?? null,
			card: cardRect,
			summary: summaryRect,
			choices: choicesRect,
			summaryOverflowsCard: outsideHorizontally(summaryRect, cardRect)
				|| Boolean(summary && summary.scrollWidth > summary.clientWidth),
			choicesOverflowCard: outsideHorizontally(choicesRect, cardRect)
				|| Boolean(choices && choices.scrollWidth > choices.clientWidth),
			radioLabelsOverlap: intersects(labels[0]?.rect ?? null, labels[1]?.rect ?? null),
		};
	}, { wizard: WIZARD, surface, theme, width });
	const findings: string[] = [];
	if (observation.summaryOverflowsCard === true) findings.push('nest-summary-overflows-candidate-card');
	if (observation.choicesOverflowCard === true) findings.push('nest-choices-overflow-candidate-card');
	if (observation.radioLabelsOverlap === true) findings.push('nest-radio-labels-overlap');
	recordLayoutFindings(observation, findings);
	await saveCapture(surface, theme, width, observation);
	await clearInlineWidth(WIZARD);
	return observation;
}

async function chooseNested(): Promise<boolean> {
	const changed = await browser.executeObsidian((_obs, wizard) => {
		const root = document.querySelector(wizard);
		const card = Array.from(root?.querySelectorAll<HTMLElement>('.crosswalker-json-pick') ?? [])
			.find((candidate) => candidate.querySelector('.crosswalker-json-pick-label')?.textContent?.trim() === 'groups');
		const radio = card?.querySelector<HTMLInputElement>('.crosswalker-json-nest-choices input[type=radio][value="nested"]');
		if (!radio) return false;
		radio.click();
		radio.dispatchEvent(new Event('change', { bubbles: true }));
		return true;
	}, WIZARD);
	await browser.pause(300);
	return changed;
}

async function reachWorkbench(): Promise<void> {
	const nextClicked = await browser.executeObsidian((_obs, wizard) => {
		const root = document.querySelector(wizard);
		const next = Array.from(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])
			.find((button) => button.textContent?.includes('Next'));
		next?.click();
		return Boolean(next);
	}, WIZARD);
	expect(nextClicked).toBe(true);

	const firstState = await browser.executeObsidian(async (_obs, wizard) => {
		const root = document.querySelector(wizard);
		const started = Date.now();
		while (Date.now() - started < 15_000) {
			if (root?.querySelector('.crosswalker-recognized-card')) return 'recognized';
			if (root?.querySelector('.crosswalker-wb-mapcard, .crosswalker-wb-shapes')) return 'workbench';
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return 'timeout';
	}, WIZARD);
	expect(firstState).not.toBe('timeout');

	if (firstState === 'recognized') {
		const customized = await browser.executeObsidian((_obs, wizard) => {
			const root = document.querySelector(wizard);
			const button = Array.from(root?.querySelectorAll<HTMLButtonElement>('.crosswalker-recognized-actions button') ?? [])
				.find((candidate) => candidate.textContent?.trim() === 'Customize');
			button?.click();
			return Boolean(button);
		}, WIZARD);
		expect(customized).toBe(true);
	}

	const workbenchReady = await browser.executeObsidian(async (_obs, wizard) => {
		const root = document.querySelector(wizard);
		const started = Date.now();
		while (Date.now() - started < 10_000) {
			if (root?.querySelector('.crosswalker-wb-mapcard')) return true;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return false;
	}, WIZARD);
	expect(workbenchReady).toBe(true);

	await browser.executeObsidian((_obs, wizard) => {
		const root = document.querySelector(wizard);
		const cards = Array.from(root?.querySelectorAll<HTMLElement>('.crosswalker-wb-mapcard') ?? []);
		const target = cards[0] ?? null;
		if (!target?.querySelector('.crosswalker-wb-shapes')) {
			target?.querySelector<HTMLButtonElement>('.crosswalker-wb-mapcard-toggle')?.click();
		}
	}, WIZARD);
	await browser.pause(300);
}

async function openArrangeLevels(): Promise<void> {
	const opened = await browser.executeObsidian(async (_obs, wizard) => {
		const root = document.querySelector(wizard);
		let card = root?.querySelector<HTMLElement>('.crosswalker-wb-mapcard') ?? null;
		if (!card) return false;
		if (!card.querySelector('.crosswalker-wb-shapes')) {
			card.querySelector<HTMLButtonElement>('.crosswalker-wb-mapcard-toggle')?.click();
			const expandStarted = Date.now();
			while (Date.now() - expandStarted < 5_000) {
				card = root?.querySelector<HTMLElement>('.crosswalker-wb-mapcard') ?? null;
				if (card?.querySelector('.crosswalker-wb-shapes')) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		if (!card?.querySelector('.crosswalker-wb-matrix')) {
			card?.querySelector<HTMLButtonElement>('.crosswalker-wb-arrange')?.click();
		}
		const started = Date.now();
		while (Date.now() - started < 5_000) {
			card = root?.querySelector<HTMLElement>('.crosswalker-wb-mapcard') ?? null;
			if (card?.querySelector('.crosswalker-wb-matrix')) return true;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return false;
	}, WIZARD);
	expect(opened).toBe(true);
}

async function captureRows(
	surface: 'nested-rows' | 'nested-rows-folders-only' | 'flat-rows',
	theme: Theme,
	width: Width,
): Promise<JsonRecord> {
	await setTheme(theme);
	await setInlineWidth(WIZARD, width);
	await browser.executeObsidian((_obs, wizard) => {
		document.querySelector(`${wizard} .crosswalker-wb-matrix`)?.scrollIntoView({ block: 'center' });
	}, WIZARD);
	await browser.pause(100);
	const observation = await browser.executeObsidian((_obs, args) => {
		type BrowserRect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
		const rect = (element: Element | null): BrowserRect | null => {
			if (!element) return null;
			const value = element.getBoundingClientRect();
			return {
				left: value.left,
				top: value.top,
				right: value.right,
				bottom: value.bottom,
				width: value.width,
				height: value.height,
			};
		};
		const intersects = (left: BrowserRect | null, right: BrowserRect | null) => Boolean(
			left && right
				&& left.left < right.right && left.right > right.left
				&& left.top < right.bottom && left.bottom > right.top,
		);
		const root = document.querySelector(args.wizard);
		const card = root?.querySelector<HTMLElement>('.crosswalker-wb-mapcard') ?? null;
		const table = card?.querySelector<HTMLTableElement>('.crosswalker-wb-matrix') ?? null;
		const rows = Array.from(table?.querySelectorAll<HTMLTableRowElement>('tbody > tr') ?? []).map((row, rowIndex) => {
			const cells = Array.from(row.querySelectorAll<HTMLTableCellElement>(':scope > td'));
			const nested = cells[0]?.querySelector<HTMLElement>('.crosswalker-wb-nest-controls') ?? null;
			const leaf = nested?.querySelector<HTMLSelectElement>('select[data-nest-control="leaf"]') ?? null;
			const identity = nested?.querySelector<HTMLSelectElement>('select[data-nest-control="identity"]') ?? null;
			const namedCell = cells[3] ?? null;
			const buttons = Array.from(cells[0]?.querySelectorAll<HTMLButtonElement>('button') ?? [])
				.map((button) => button.textContent?.trim() ?? '');
			const destinations = Array.from(cells[2]?.querySelectorAll<HTMLElement>('.crosswalker-wb-chip-dest') ?? [])
				.map((chip) => chip.textContent?.trim() ?? '');
			return {
				rowIndex,
				levelId: cells[0]?.querySelector('b')?.textContent?.trim() ?? '',
				sampleText: cells[1]?.textContent?.trim() ?? '',
				destinations,
				nestControlsPresent: Boolean(nested),
				leaf: leaf ? {
					value: leaf.value,
					options: Array.from(leaf.options).map((option) => ({ text: option.text.trim(), value: option.value })),
					rect: rect(leaf),
				} : null,
				identity: identity ? {
					value: identity.value,
					options: Array.from(identity.options).map((option) => ({ text: option.text.trim(), value: option.value })),
					rect: rect(identity),
				} : null,
				mergePresent: buttons.some((text) => text.startsWith('Merge')),
				splitPresent: buttons.some((text) => text.startsWith('Split')),
				row: rect(row),
				namedCell: rect(namedCell),
				selectsOverlap: intersects(rect(leaf), rect(identity)),
				leafOverlapsNamed: intersects(rect(leaf), rect(namedCell)),
				identityOverlapsNamed: intersects(rect(identity), rect(namedCell)),
			};
		});
		const tableRect = rect(table);
		const cardRect = rect(card);
		const depthHint = card?.querySelector<HTMLElement>('.crosswalker-wb-depth-hint')?.textContent?.trim() ?? '';
		return {
			kind: args.surface,
			theme: args.theme,
			width: args.width,
			rows,
			rowCount: rows.length,
			levelIds: rows.map((row) => row.levelId),
			depthHintText: depthHint,
			table: tableRect,
			card: cardRect,
			tableOverflowsCard: Boolean(
				table && cardRect && tableRect
				&& (table.scrollWidth > table.clientWidth || tableRect.left < cardRect.left || tableRect.right > cardRect.right),
			),
		};
	}, { wizard: WIZARD, surface, theme, width });
	const rows = observation.rows as Array<{
		levelId: string;
		selectsOverlap: boolean;
		leafOverlapsNamed: boolean;
		identityOverlapsNamed: boolean;
	}>;
	const findings: string[] = [];
	if (rows.some((row) => row.selectsOverlap)) findings.push('nested-selects-overlap');
	if (rows.some((row) => row.leafOverlapsNamed || row.identityOverlapsNamed)) {
		findings.push('nested-select-overlaps-named-cell');
	}
	if (observation.tableOverflowsCard === true) findings.push('matrix-table-overflows-mapping-card');
	recordLayoutFindings(observation, findings);
	await saveCapture(surface, theme, width, observation);
	await clearInlineWidth(WIZARD);
	return observation;
}

function assertNestedRows(observation: JsonRecord): void {
	const rows = observation.rows as Array<{
		levelId: string;
		nestControlsPresent: boolean;
		leaf: JsonRecord | null;
		mergePresent: boolean;
		splitPresent: boolean;
	}>;
	const nestedRows = rows.filter((row) => row.nestControlsPresent);
	expect(nestedRows.map((row) => row.levelId)).toEqual(['group', 'control', 'part']);
	expect(nestedRows).toHaveLength(3);
	expect(nestedRows.every((row) => !row.mergePresent && !row.splitPresent)).toBe(true);
	expect(nestedRows.find((row) => row.levelId === 'part')?.leaf).toBeNull();
}

async function setFirstNonLeafOwnNote(value: 'folder-note' | 'none'): Promise<boolean> {
	const changed = await browser.executeObsidian((_obs, args) => {
		const root = document.querySelector(args.wizard);
		const select = root?.querySelector<HTMLSelectElement>(
			'.crosswalker-wb-mapcard .crosswalker-wb-matrix select[data-nest-control="leaf"]',
		);
		if (!select) return false;
		select.value = args.value;
		select.dispatchEvent(new Event('change', { bubbles: true }));
		return true;
	}, { wizard: WIZARD, value });
	await browser.pause(300);
	return changed;
}

async function captureDepth(
	surface: 'depth-dial' | 'depth-dial-one' | 'depth-dial-zero' | 'depth-dial-custom',
	theme: Theme,
	width: Width,
	extra: JsonRecord = {},
): Promise<JsonRecord> {
	await setTheme(theme);
	await setInlineWidth(WIZARD, width);
	await browser.executeObsidian((_obs, wizard) => {
		document.querySelector(`${wizard} .crosswalker-wb-depth`)?.scrollIntoView({ block: 'center' });
	}, WIZARD);
	await browser.pause(100);
	const observation = await browser.executeObsidian((_obs, args) => {
		type BrowserRect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
		const rect = (element: Element | null): BrowserRect | null => {
			if (!element) return null;
			const value = element.getBoundingClientRect();
			return {
				left: value.left,
				top: value.top,
				right: value.right,
				bottom: value.bottom,
				width: value.width,
				height: value.height,
			};
		};
		const intersects = (left: BrowserRect | null, right: BrowserRect | null) => Boolean(
			left && right
				&& left.left < right.right && left.right > right.left
				&& left.top < right.bottom && left.bottom > right.top,
		);
		const root = document.querySelector(args.wizard);
		const card = root?.querySelector<HTMLElement>('.crosswalker-wb-mapcard') ?? null;
		const dial = card?.querySelector<HTMLElement>('.crosswalker-wb-depth') ?? null;
		const label = dial?.querySelector<HTMLLabelElement>('label') ?? null;
		const select = dial?.querySelector<HTMLSelectElement>('select.dropdown[aria-label="Depth"]') ?? null;
		const hint = dial?.querySelector<HTMLElement>('.crosswalker-wb-depth-hint') ?? null;
		const labelRect = rect(label);
		const selectRect = rect(select);
		const hintRect = rect(hint);
		const componentTops = [labelRect, selectRect, hintRect]
			.filter((value): value is BrowserRect => value !== null)
			.map((value) => Math.round(value.top));
		const hintLineTops = (() => {
			if (!hint) return [];
			const range = document.createRange();
			range.selectNodeContents(hint);
			return Array.from(range.getClientRects()).map((value) => Math.round(value.top));
		})();
		const rows = Array.from(card?.querySelectorAll<HTMLTableRowElement>('.crosswalker-wb-matrix tbody > tr') ?? [])
			.map((row) => {
				const cells = Array.from(row.querySelectorAll<HTMLTableCellElement>(':scope > td'));
				return {
					levelId: cells[0]?.querySelector('b')?.textContent?.trim() ?? '',
					destinations: Array.from(cells[2]?.querySelectorAll<HTMLElement>('.crosswalker-wb-chip-dest') ?? [])
						.map((chip) => chip.textContent?.trim() ?? ''),
					leafValue: cells[0]?.querySelector<HTMLSelectElement>('select[data-nest-control="leaf"]')?.value ?? null,
				};
			});
		return {
			kind: args.surface,
			theme: args.theme,
			width: args.width,
			dial: rect(dial),
			label: { text: label?.textContent?.trim() ?? '', rect: labelRect },
			select: {
				value: select?.value ?? null,
				options: Array.from(select?.options ?? []).map((option) => ({ text: option.text.trim(), value: option.value })),
				rect: selectRect,
			},
			hint: { text: hint?.textContent?.trim() ?? '', rect: hintRect },
			componentsWrap: new Set(componentTops).size > 1,
			labelSelectOverlap: intersects(labelRect, selectRect),
			labelHintOverlap: intersects(labelRect, hintRect),
			selectHintOverlap: intersects(selectRect, hintRect),
			hintTextWraps: new Set(hintLineTops).size > 1,
			hintClipped: Boolean(hint && (hint.scrollWidth > hint.clientWidth || hint.scrollHeight > hint.clientHeight)),
			matrixRows: rows,
		};
	}, { wizard: WIZARD, surface, theme, width });
	Object.assign(observation, extra);
	const findings: string[] = [];
	if (observation.labelSelectOverlap === true) findings.push('depth-label-overlaps-select');
	if (observation.labelHintOverlap === true) findings.push('depth-label-overlaps-hint');
	if (observation.selectHintOverlap === true) findings.push('depth-select-overlaps-hint');
	if (observation.hintClipped === true) findings.push('depth-hint-clipped');
	recordLayoutFindings(observation, findings);
	await saveCapture(surface, theme, width, observation);
	await clearInlineWidth(WIZARD);
	return observation;
}

async function setDepth(value: '0' | '1'): Promise<boolean> {
	const changed = await browser.executeObsidian((_obs, args) => {
		const select = document.querySelector<HTMLSelectElement>(
			`${args.wizard} .crosswalker-wb-mapcard .crosswalker-wb-depth select.dropdown[aria-label="Depth"]`,
		);
		if (!select || !Array.from(select.options).some((option) => option.value === args.value)) return false;
		select.value = args.value;
		select.dispatchEvent(new Event('change', { bubbles: true }));
		return true;
	}, { wizard: WIZARD, value });
	await browser.pause(300);
	return changed;
}

async function makeDepthCustom(): Promise<boolean> {
	const menuOpened = await browser.executeObsidian((_obs, wizard) => {
		const root = document.querySelector(wizard);
		const rows = Array.from(root?.querySelectorAll<HTMLTableRowElement>(
			'.crosswalker-wb-mapcard .crosswalker-wb-matrix tbody > tr',
		) ?? []);
		const part = rows.find((row) => row.querySelector('td:first-child b')?.textContent?.trim() === 'part');
		const add = part?.querySelector<HTMLButtonElement>('.crosswalker-wb-chip-add');
		add?.click();
		return Boolean(add);
	}, WIZARD);
	if (!menuOpened) return false;
	await browser.pause(150);

	const folderChosen = await browser.executeObsidian((_obs, wizard) => {
		const root = document.querySelector(wizard);
		const item = Array.from(root?.querySelectorAll<HTMLButtonElement>('.crosswalker-wb-addmenu-item') ?? [])
			.find((button) => button.textContent?.trim() === 'Folder');
		item?.click();
		return Boolean(item);
	}, WIZARD);
	if (!folderChosen) return false;
	await browser.pause(150);

	const added = await browser.executeObsidian((_obs, wizard) => {
		const root = document.querySelector(wizard);
		const add = Array.from(root?.querySelectorAll<HTMLButtonElement>('.crosswalker-wb-addmenu-btns button') ?? [])
			.find((button) => button.textContent?.trim() === 'Add');
		add?.click();
		return Boolean(add);
	}, WIZARD);
	if (!added) return false;
	await browser.pause(300);
	return browser.executeObsidian((_obs, wizard) =>
		document.querySelector<HTMLSelectElement>(
			`${wizard} .crosswalker-wb-depth select.dropdown[aria-label="Depth"]`,
		)?.value === 'custom', WIZARD);
}

describe('Visual nested-record surfaces', function () {
	this.timeout(240_000);

	before(async () => {
		mkdirSync(OUT, { recursive: true });
		await closeImportWizard();
		await closeCrosswalkerLeaves();
		await clearAllDrafts();
		// The nested rows and the Depth dial live in the shape workbench, which the
		// seed vault ships switched off. Turn it on for this spec the way every
		// other workbench spec does, and switch it back in `after`.
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error internal plugins API
			const plugin = app.plugins.plugins['crosswalker'];
			plugin.settings.enableShapeWorkbench = true;
			plugin.settings.enableConfigSuggestions = false;
			await plugin.saveSettings();
		});
		geometry.runtime = await browser.executeObsidian(({ app }) => ({
			appVersion: (app as unknown as { appVersion?: string }).appVersion ?? null,
			userAgent: navigator.userAgent,
		}));
		flushGeometry();
	});

	after(async () => {
		await clearInlineWidth(WIZARD);
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
		});
		await browser.executeObsidian(() => {
			document.body.classList.remove('theme-dark');
			document.body.classList.add('theme-light');
		});
		flushGeometry();
	});

	it('captures P1 through P4 in both themes and required widths', async () => {
		await injectOscalJson();
		for (const theme of ['light', 'dark'] as const) {
			for (const width of ['normal', '640px'] as const) {
				const observation = await capturePicker('picker-nested-choice', theme, width);
				expect(String(observation.summaryText)).toMatch(
					/^Records inside records: groups \(3\) hold controls \(6\) hold parts \(12\)/,
				);
				expect(observation.checkedRadio).toBe('flat');
			}
		}

		expect(await chooseNested()).toBe(true);
		for (const theme of ['light', 'dark'] as const) {
			await capturePicker('picker-nested-chosen', theme, 'normal');
		}

		await reachWorkbench();
		await openArrangeLevels();
		for (const theme of ['light', 'dark'] as const) {
			for (const width of ['normal', '640px'] as const) {
				const observation = await captureRows('nested-rows', theme, width);
				assertNestedRows(observation);
			}
		}

		expect(await setFirstNonLeafOwnNote('none')).toBe(true);
		for (const theme of ['light', 'dark'] as const) {
			await captureRows('nested-rows-folders-only', theme, 'normal');
		}

		let initialHint = '';
		for (const theme of ['light', 'dark'] as const) {
			for (const width of ['normal', '640px'] as const) {
				const observation = await captureDepth('depth-dial', theme, width);
				expect((observation.select as JsonRecord).value).toBe('2');
				if (!initialHint) initialHint = String((observation.hint as JsonRecord).text);
			}
		}

		expect(await setDepth('1')).toBe(true);
		for (const theme of ['light', 'dark'] as const) {
			const observation = await captureDepth('depth-dial-one', theme, 'normal');
			expect(String((observation.hint as JsonRecord).text)).not.toBe(initialHint);
		}

		expect(await setDepth('0')).toBe(true);
		const zero = await captureDepth('depth-dial-zero', 'light', 'normal');
		const zeroHint = String((zero.hint as JsonRecord).text);
		expect(zeroHint.startsWith('No folders') || zeroHint.startsWith('0 folders')).toBe(true);

		const customCaptured = await makeDepthCustom();
		geometry.customCaptured = customCaptured;
		await captureDepth('depth-dial-custom', 'light', 'normal', { customCaptured });

		await closeImportWizard();
		await clearAllDrafts();
		await injectOscalJson();
		await reachWorkbench();
		await openArrangeLevels();
		const flat = await captureRows('flat-rows', 'light', 'normal');
		expect((flat.rows as Array<{ nestControlsPresent: boolean }>)
			.some((row) => row.nestControlsPresent)).toBe(false);

		for (const screenshot of geometry.screenshots) expect(existsSync(screenshot)).toBe(true);
	});
});
