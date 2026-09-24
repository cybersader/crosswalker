/// <reference types="mocha" />

/**
 * Visual contract for the vault source scan, XLSX binding suggestion,
 * detected crosswalk card, and workspace launchpad.
 *
 * The harness rejects window resizing. Narrow captures therefore apply a
 * temporary 640px inline width to the owned modal or launchpad root.
 *
 * Screenshots: test-screenshots/rs-<surface>-<theme>-<width>.png
 * Geometry: test-screenshots/reification-surfaces-geometry.json
 */

import 'webdriverio';
import 'wdio-obsidian-service';
import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { RECIPE_REGISTRY } from '../../src/import/recipe-registry';
import {
	clearAllDrafts,
	closeCrosswalkerLeaves,
	closeImportWizard,
	openImportWizard,
} from './helpers/wizard-modal';
import { waitForVaultIndexed } from './helpers/vault-readiness';

const OUT = path.resolve('test-screenshots');
const GEOMETRY_PATH = path.join(OUT, 'reification-surfaces-geometry.json');
const FIXTURE_ROOT = 'Crosswalker Test Data/reification-visual';
const CSF_PATH = `${FIXTURE_ROOT}/csf-shaped.csv`;
const CRI_PATH = `${FIXTURE_ROOT}/cri-shaped.xlsx`;
const NOTES_PATH = `${FIXTURE_ROOT}/notes.md`;
const WIZARD = '.crosswalker-wizard-modal';
const SCAN = '.crosswalker-scan-modal';
const LAUNCHPAD = '.crosswalker-workspace-view .crosswalker-settings-launchpad';

type Theme = 'light' | 'dark';
type Width = 'normal' | '640px';
type JsonRecord = Record<string, unknown>;

interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

const nistEntry = RECIPE_REGISTRY.find((entry) => entry.id === 'nist-csf-2-flat');
const criEntry = RECIPE_REGISTRY.find((entry) => entry.id === 'cri-profile-v2-2-flat');
if (!nistEntry || !criEntry) throw new Error('Required visual fixture recipes are missing from RECIPE_REGISTRY.');

const CSF_COLUMNS = [...nistEntry.signatureColumns];
const CRI_COLUMNS = [...criEntry.signatureColumns];
const CRI_REQUIRED_COLUMNS = [...criEntry.requiredColumns];
const NIST_MAPPING_COLUMN = 'NIST CSF v2 Mapping';
const CRI_FIXTURE_COLUMNS = CRI_COLUMNS.includes(NIST_MAPPING_COLUMN)
	? CRI_COLUMNS
	: [...CRI_COLUMNS, NIST_MAPPING_COLUMN];

const geometry: {
	createdUtc: string;
	runtime?: JsonRecord;
	observations: JsonRecord[];
	screenshots: string[];
} = {
	createdUtc: new Date().toISOString(),
	observations: [],
	screenshots: [],
};

function flushGeometry(): void {
	writeFileSync(GEOMETRY_PATH, JSON.stringify(geometry, null, 2) + '\n', 'utf8');
	console.log(`[reification-surfaces:geometry] ${JSON.stringify(geometry)}`);
}

function assertNoEmDash(value: unknown): void {
	expect(JSON.stringify(value)).not.toContain('—');
}

function csvCell(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function buildCsfCsv(): string {
	const columns = [...CSF_COLUMNS, 'Synthetic filler'];
	const idColumn = nistEntry.requiredColumns[0] ?? CSF_COLUMNS[0];
	const rows = Array.from({ length: 6 }, (_, index) => {
		const id = `GV.OC-${String(index + 1).padStart(2, '0')}`;
		return columns.map((column) => {
			if (column === idColumn) return id;
			if (column === 'Synthetic filler') return `Filler ${index + 1}`;
			return `Synthetic ${column} ${index + 1}`;
		});
	});
	return [columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

function criCell(column: string, index: number): string {
	const number = String(index + 1).padStart(2, '0');
	if (column === NIST_MAPPING_COLUMN) {
		return index === 5 ? 'None' : `GV.OC-01 (Synthetic Note)\nGV.OC-${number}`;
	}
	if (column === 'Profile Id') return `GV.OC-${number}.01`;
	if (column === 'Level') return 'DS';
	if (column === 'CRI Profile Function / Category / Subcategory') {
		return `Synthetic function / Synthetic category / Synthetic subcategory ${index + 1}`;
	}
	if (/^Tier-\d$/.test(column)) return index % 2 === 0 ? 'Yes' : 'No';
	return `Synthetic ${column} ${index + 1}`;
}

function buildCriWorkbookB64(): string {
	const workbook = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(
		workbook,
		XLSX.utils.aoa_to_sheet([['Synthetic workbook introduction']]),
		'Intro',
	);
	const rows = Array.from(
		{ length: 6 },
		(_, index) => CRI_FIXTURE_COLUMNS.map((column) => criCell(column, index)),
	);
	XLSX.utils.book_append_sheet(
		workbook,
		XLSX.utils.aoa_to_sheet([
			['Synthetic banner row'],
			CRI_FIXTURE_COLUMNS,
			...rows,
		]),
		'Structure',
	);
	return XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' }) as string;
}

async function createFixtures(): Promise<void> {
	const workbookB64 = buildCriWorkbookB64();
	await browser.executeObsidian(async ({ app }, args) => {
		const existing = app.vault.getAbstractFileByPath(args.root);
		if (existing) await app.vault.delete(existing, true);
		await app.vault.createFolder(args.root);
		await app.vault.create(args.csfPath, args.csf);
		const binary = atob(args.workbookB64);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		await app.vault.createBinary(args.criPath, bytes.buffer);
		await app.vault.create(args.notesPath, 'Synthetic prose note for the visual source scan.\n');
	}, {
		root: FIXTURE_ROOT,
		csfPath: CSF_PATH,
		criPath: CRI_PATH,
		notesPath: NOTES_PATH,
		csf: buildCsfCsv(),
		workbookB64,
	});
}

async function removeFixtures(): Promise<void> {
	await browser.executeObsidian(async ({ app }, root) => {
		const existing = app.vault.getAbstractFileByPath(root);
		if (existing) await app.vault.delete(existing, true);
	}, FIXTURE_ROOT);
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
	const target = path.join(OUT, `rs-${surface}-${theme}-${width}.png`);
	await browser.saveScreenshot(target);
	geometry.screenshots.push(target);
	expect(existsSync(target)).toBe(true);
	flushGeometry();
	return target;
}

async function closeScanModal(): Promise<void> {
	await browser.executeObsidian((_obs, selector) => {
		const root = document.querySelector<HTMLElement>(selector);
		const close = root?.querySelector<HTMLButtonElement>('.crosswalker-scan-footer button:last-child')
			?? root?.querySelector<HTMLButtonElement>('.modal-close-button, .modal-header-button');
		close?.click();
	}, SCAN);
	await browser.waitUntil(
		async () => browser.executeObsidian((_obs, selector) => !document.querySelector(selector), SCAN),
		{ timeout: 5_000, interval: 100, timeoutMsg: 'vault source scan modal did not close' },
	);
}

async function openScanResults(): Promise<void> {
	const ready = await browser.executeObsidian(async ({ app }, selector) => {
		(app as unknown as { commands: { executeCommandById(id: string): unknown } })
			.commands.executeCommandById('crosswalker:find-vault-sources');
		const started = Date.now();
		while (Date.now() - started < 20_000) {
			if (document.querySelector(`${selector} .crosswalker-scan-table`)) return true;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return false;
	}, SCAN);
	expect(ready).toBe(true);
}

async function captureScanResults(theme: Theme, width: Width): Promise<JsonRecord> {
	await setTheme(theme);
	await setInlineWidth(SCAN, width);
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
		const root = document.querySelector<HTMLElement>(args.selector);
		const body = root?.querySelector<HTMLElement>('.crosswalker-scan-body') ?? null;
		const content = root?.querySelector<HTMLElement>('.modal-content') ?? root;
		const table = root?.querySelector<HTMLTableElement>('.crosswalker-scan-table') ?? null;
		const rows = Array.from(table?.querySelectorAll('tr') ?? []).map((row, rowIndex) => {
			const cellElements = Array.from(row.querySelectorAll('td'));
			const cells = cellElements.map((cell, cellIndex) => ({
				cellIndex,
				text: cell.textContent?.trim() ?? '',
				rect: rect(cell),
			}));
			const pairIntersections: Array<{ left: number; right: number; intersects: boolean }> = [];
			for (let left = 0; left < cells.length; left += 1) {
				for (let right = left + 1; right < cells.length; right += 1) {
					pairIntersections.push({
						left,
						right,
						intersects: intersects(cells[left].rect, cells[right].rect),
					});
				}
			}
			return {
				rowIndex,
				path: row.querySelector('.crosswalker-scan-file code')?.textContent?.trim() ?? '',
				state: row.querySelector('.crosswalker-scan-state')?.textContent?.trim() ?? '',
				resultCellIndex: cellElements.findIndex((cell) => Boolean(cell.querySelector('.crosswalker-scan-result'))),
				actionCellIndex: cellElements.findIndex((cell) => Boolean(cell.querySelector('button'))),
				cells,
				pairIntersections,
			};
		});
		const footerButtons = Array.from(root?.querySelectorAll<HTMLButtonElement>('.crosswalker-scan-footer button') ?? [])
			.map((button) => ({ label: button.textContent?.trim() ?? '', rect: rect(button) }));
		const fixtureStates = Object.fromEntries(
			rows
				.filter((row) => args.fixturePaths.includes(row.path))
				.map((row) => [row.path, row.state]),
		);
		return {
			kind: 'scan-results',
			theme: args.theme,
			width: args.width,
			root: rect(root),
			body: rect(body),
			table: rect(table),
			rows,
			footerButtons,
			fixtureStates,
			notesListed: (table?.textContent ?? '').includes('notes.md'),
			overflow: {
				body: body ? body.scrollWidth > body.clientWidth : null,
				content: content ? content.scrollWidth > content.clientWidth : null,
				horizontal: Boolean(
					(body && body.scrollWidth > body.clientWidth)
					|| (content && content.scrollWidth > content.clientWidth),
				),
			},
		};
	}, {
		selector: SCAN,
		theme,
		width,
		fixturePaths: [CSF_PATH, CRI_PATH],
	});
	await saveCapture('scan-results', theme, width, observation);
	await clearInlineWidth(SCAN);
	return observation;
}

/**
 * Layout findings (cell overlap, horizontal overflow) are RECORDED for the UX
 * reviewer, never asserted: a capture run that aborts on the first layout defect
 * leaves the reviewer with one screenshot and four missing surfaces. The first
 * real run (2026-09-21) hit exactly that: the scan modal overflowed
 * horizontally at normal width and the run stopped before S2 through S5.
 * Only spec-correctness checks (fixtures listed with the right state, prose
 * not listed) stay as assertions.
 */
function assertScanResults(observation: JsonRecord): void {
	const rows = observation.rows as Array<{
		path: string;
		resultCellIndex: number;
		actionCellIndex: number;
		cells: Array<{ cellIndex: number; text: string }>;
		pairIntersections: Array<{ intersects: boolean }>;
	}>;
	const cellOverlap = rows.some((row) => row.pairIntersections.some((pair) => pair.intersects));
	const horizontalOverflow = (observation.overflow as JsonRecord | undefined)?.horizontal === true;
	const findings: string[] = [];
	if (cellOverlap) findings.push('scan-table-cell-overlap');
	if (horizontalOverflow) findings.push('scan-modal-horizontal-overflow');
	observation.layoutFindings = findings;
	if (findings.length > 0) {
		console.log(`[reification-surfaces:layout-finding] ${JSON.stringify({ theme: observation.theme, width: observation.width, findings })}`);
	}
	const fixtureRows = rows.filter((row) => row.path === CSF_PATH || row.path === CRI_PATH);
	expect(fixtureRows).toHaveLength(2);
	expect(fixtureRows.every((row) => row.cells.length === 6)).toBe(true);
	expect(fixtureRows.every((row) => row.resultCellIndex === 4)).toBe(true);
	expect(fixtureRows.every((row) => row.actionCellIndex === 5)).toBe(true);
	expect(observation.notesListed).toBe(false);
	const states = observation.fixtureStates as Record<string, string>;
	expect(states[CSF_PATH]).toBe('Not imported');
	expect(states[CRI_PATH]).toBe('Not imported');
}

async function captureScanProgress(theme: Theme): Promise<JsonRecord> {
	await setTheme(theme);
	const openedAt = Date.now();
	const initial = await browser.executeObsidian(({ app }, selector) => {
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
		(app as unknown as { commands: { executeCommandById(id: string): unknown } })
			.commands.executeCommandById('crosswalker:find-vault-sources');
		const root = document.querySelector<HTMLElement>(selector);
		const progress = root?.querySelector<HTMLElement>('.crosswalker-scan-progress') ?? null;
		const table = root?.querySelector<HTMLTableElement>('.crosswalker-scan-table') ?? null;
		return {
			progressCaptured: Boolean(progress),
			progress: rect(progress),
			progressText: progress?.textContent?.trim() ?? '',
			resultsFallback: rect(table),
			resultsText: table?.textContent?.trim() ?? '',
		};
	}, SCAN);
	const observation: JsonRecord = {
		kind: 'scan-progress',
		theme,
		width: 'normal',
		captureDelayMs: Date.now() - openedAt,
		...initial,
	};
	await saveCapture('scan-progress', theme, 'normal', observation);
	await closeScanModal();
	return observation;
}

async function injectWorkbookAndWaitForSuggestion(workbookB64: string): Promise<void> {
	const opened = await openImportWizard();
	expect(opened.opened).toBe(true);
	const result = await browser.executeObsidian(async (_obs, args) => {
		const root = document.querySelector(args.wizard);
		const input = root?.querySelector<HTMLInputElement>('input[type=file]');
		if (!root || !input) return 'NO_FILE_INPUT';
		const binary = atob(args.workbookB64);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		const transfer = new DataTransfer();
		transfer.items.add(new File(
			[bytes],
			'cri-shaped.xlsx',
			{ type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
		));
		input.files = transfer.files;
		input.dispatchEvent(new Event('change'));
		const started = Date.now();
		while (Date.now() - started < 10_000) {
			if (root.querySelector('.crosswalker-sheet-suggestion')) return 'READY';
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return 'NO_SUGGESTION';
	}, { wizard: WIZARD, workbookB64 });
	expect(result).toBe('READY');
}

async function captureSheetSuggestion(
	surface: 'sheet-suggestion' | 'sheet-suggestion-overridden',
	theme: Theme,
	width: Width,
): Promise<JsonRecord> {
	await setTheme(theme);
	await setInlineWidth(WIZARD, width);
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
		const root = document.querySelector<HTMLElement>(args.wizard);
		const setting = (name: string) => Array.from(root?.querySelectorAll<HTMLElement>('.setting-item') ?? [])
			.find((item) => item.querySelector('.setting-item-name')?.textContent?.trim() === name) ?? null;
		const sheet = setting('Sheet')?.querySelector<HTMLSelectElement>('select') ?? null;
		const header = setting('Header row')?.querySelector<HTMLInputElement>('input') ?? null;
		const line = root?.querySelector<HTMLElement>('.crosswalker-sheet-suggestion') ?? null;
		const lineRect = rect(line);
		const sheetRect = rect(sheet);
		const headerRect = rect(header);
		return {
			kind: args.surface,
			theme: args.theme,
			width: args.width,
			line: { rect: lineRect, text: line?.textContent?.trim() ?? '' },
			sheet: { rect: sheetRect, value: sheet?.value ?? null },
			headerRow: { rect: headerRect, value: header?.value ?? null },
			lineIntersectsSheet: intersects(lineRect, sheetRect),
			lineIntersectsHeaderRow: intersects(lineRect, headerRect),
			useSuggestionPresent: Array.from(line?.querySelectorAll('button') ?? [])
				.some((button) => button.textContent?.trim() === 'Use suggestion'),
		};
	}, { wizard: WIZARD, surface, theme, width });
	await saveCapture(surface, theme, width, observation);
	await clearInlineWidth(WIZARD);
	return observation;
}

function assertSheetSuggestion(observation: JsonRecord, overridden: boolean): void {
	expect((observation.line as JsonRecord).rect).not.toBeNull();
	// Layout overlap is recorded for the reviewer, not asserted (see assertScanResults).
	const findings: string[] = [];
	if (observation.lineIntersectsSheet === true) findings.push('suggestion-line-overlaps-sheet-control');
	if (observation.lineIntersectsHeaderRow === true) findings.push('suggestion-line-overlaps-header-row-control');
	observation.layoutFindings = findings;
	if (findings.length > 0) {
		console.log(`[reification-surfaces:layout-finding] ${JSON.stringify({ theme: observation.theme, width: observation.width, findings })}`);
	}
	if (overridden) {
		expect(String((observation.line as JsonRecord).text)).toMatch(/^Using your choice/);
		expect(observation.useSuggestionPresent).toBe(true);
	} else {
		expect((observation.sheet as JsonRecord).value).toBe('Structure');
		expect((observation.headerRow as JsonRecord).value).toBe('2');
	}
}

async function overrideHeaderRow(): Promise<void> {
	const changed = await browser.executeObsidian((_obs, wizard) => {
		const root = document.querySelector(wizard);
		const setting = Array.from(root?.querySelectorAll<HTMLElement>('.setting-item') ?? [])
			.find((item) => item.querySelector('.setting-item-name')?.textContent?.trim() === 'Header row');
		const input = setting?.querySelector<HTMLInputElement>('input');
		if (!input) return false;
		input.value = '1';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new Event('change', { bubbles: true }));
		return true;
	}, WIZARD);
	expect(changed).toBe(true);
	await browser.pause(300);
}

async function reachCrosswalkShapes(): Promise<{ cardPresent: boolean; titles: string[]; clearedForUnnamed: boolean }> {
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
		const crosswalkMapping = cards.find((card) =>
			Array.from(card.querySelectorAll<HTMLElement>('.crosswalker-wb-chip'))
				.some((chip) => chip.textContent?.trim().toLocaleLowerCase().startsWith('crosswalk')),
		);
		const target = crosswalkMapping ?? cards[0] ?? null;
		if (!target?.querySelector('.crosswalker-wb-shapes')) {
			target?.querySelector<HTMLButtonElement>('.crosswalker-wb-mapcard-toggle')?.click();
		}
	}, WIZARD);
	await browser.pause(300);

	const setup = await browser.executeObsidian((_obs, wizard) => {
		const root = document.querySelector(wizard);
		const cards = Array.from(root?.querySelectorAll<HTMLElement>('.crosswalker-wb-shape') ?? []);
		const crosswalk = cards.find((card) =>
			card.querySelector('.crosswalker-wb-shape-title')?.textContent?.trim() === 'Crosswalks',
		) ?? null;
		const titles = cards.map((card) => card.querySelector('.crosswalker-wb-shape-title')?.textContent?.trim() ?? '');
		const frameworkLabel = Array.from(crosswalk?.querySelectorAll<HTMLLabelElement>('.crosswalker-wb-crosswalk-controls label') ?? [])
			.find((label) => label.querySelector('span')?.textContent?.trim() === 'These ids point to');
		const framework = frameworkLabel?.querySelector<HTMLSelectElement>('select') ?? null;
		let clearedForUnnamed = false;
		if (framework && framework.value !== '') {
			framework.value = '';
			framework.dispatchEvent(new Event('change', { bubbles: true }));
			clearedForUnnamed = true;
		}
		return { cardPresent: Boolean(crosswalk), titles, clearedForUnnamed };
	}, WIZARD);
	if (setup.clearedForUnnamed) await browser.pause(300);
	return setup;
}

async function captureCrosswalkCard(
	surface: 'crosswalks-card' | 'crosswalks-card-named' | 'crosswalks-missing',
	theme: Theme,
	width: Width,
): Promise<JsonRecord> {
	await setTheme(theme);
	await setInlineWidth(WIZARD, width);
	await browser.executeObsidian((_obs, wizard) => {
		const cards = Array.from(document.querySelector(wizard)?.querySelectorAll<HTMLElement>('.crosswalker-wb-shape') ?? []);
		const crosswalk = cards.find((card) =>
			card.querySelector('.crosswalker-wb-shape-title')?.textContent?.trim() === 'Crosswalks',
		);
		(crosswalk ?? document.querySelector(`${wizard} .crosswalker-wb-shapes`))?.scrollIntoView({ block: 'center' });
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
		const root = document.querySelector(args.wizard);
		const cards = Array.from(root?.querySelectorAll<HTMLElement>('.crosswalker-wb-shape') ?? []);
		const titles = cards.map((card) => card.querySelector('.crosswalker-wb-shape-title')?.textContent?.trim() ?? '');
		const card = cards.find((candidate) =>
			candidate.querySelector('.crosswalker-wb-shape-title')?.textContent?.trim() === 'Crosswalks',
		) ?? null;
		const controls = card?.querySelector<HTMLElement>('.crosswalker-wb-crosswalk-controls') ?? null;
		const labels = Array.from(controls?.querySelectorAll<HTMLLabelElement>('label') ?? []);
		const labelledSelect = (labelText: string) => labels
			.find((label) => label.querySelector('span')?.textContent?.trim() === labelText)
			?.querySelector<HTMLSelectElement>('select') ?? null;
		const framework = labelledSelect('These ids point to');
		const predicate = labelledSelect('How they relate');
		const cardRect = rect(card);
		const controlsRect = rect(controls);
		const mapCard = card?.closest<HTMLElement>('.crosswalker-wb-mapcard') ?? null;
		const chipTexts = Array.from(mapCard?.querySelectorAll<HTMLElement>('.crosswalker-wb-chip') ?? [])
			.map((chip) => chip.textContent?.trim() ?? '')
			.filter((text) => text.toLocaleLowerCase().startsWith('crosswalk'));
		return {
			kind: args.surface,
			theme: args.theme,
			width: args.width,
			crosswalkCardPresent: Boolean(card),
			cardTitles: titles,
			shapesGrid: rect(root?.querySelector('.crosswalker-wb-shapes') ?? null),
			card: cardRect,
			isNeedsOntology: card?.classList.contains('is-needs-ontology') ?? null,
			framework: {
				value: framework?.value ?? null,
				options: Array.from(framework?.options ?? []).map((option) => ({
					text: option.text.trim(),
					value: option.value,
				})),
			},
			predicate: { value: predicate?.value ?? null },
			hintText: card?.querySelector('.crosswalker-wb-shape-hint')?.textContent?.trim() ?? '',
			controls: controlsRect,
			controlsOverflowCard: Boolean(
				controls && cardRect && controlsRect
				&& (controls.scrollWidth > controls.clientWidth
					|| controlsRect.left < cardRect.left || controlsRect.right > cardRect.right),
			),
			chipTexts,
		};
	}, { wizard: WIZARD, surface, theme, width });
	await saveCapture(surface, theme, width, observation);
	await clearInlineWidth(WIZARD);
	return observation;
}

async function nameCrosswalkFramework(): Promise<boolean> {
	const selected = await browser.executeObsidian((_obs, wizard) => {
		const root = document.querySelector(wizard);
		const cards = Array.from(root?.querySelectorAll<HTMLElement>('.crosswalker-wb-shape') ?? []);
		const card = cards.find((candidate) =>
			candidate.querySelector('.crosswalker-wb-shape-title')?.textContent?.trim() === 'Crosswalks',
		);
		const frameworkLabel = Array.from(card?.querySelectorAll<HTMLLabelElement>('.crosswalker-wb-crosswalk-controls label') ?? [])
			.find((label) => label.querySelector('span')?.textContent?.trim() === 'These ids point to');
		const select = frameworkLabel?.querySelector<HTMLSelectElement>('select');
		if (!select || !Array.from(select.options).some((option) => option.value === 'nist-csf-2')) return false;
		select.value = 'nist-csf-2';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		return true;
	}, WIZARD);
	if (selected) await browser.pause(300);
	return selected;
}

async function openWorkspaceHome(): Promise<void> {
	const opened = await browser.executeObsidian(async ({ app }) => {
		(app as unknown as { commands: { executeCommandById(id: string): unknown } })
			.commands.executeCommandById('crosswalker:open-crosswalker-workspace');
		const started = Date.now();
		while (Date.now() - started < 8_000) {
			if (document.querySelector('.crosswalker-workspace-view .crosswalker-settings-launchpad')) return true;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return false;
	});
	expect(opened).toBe(true);
}

async function captureLaunchpad(theme: Theme, width: Width): Promise<JsonRecord> {
	await setTheme(theme);
	await setInlineWidth(LAUNCHPAD, width);
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
		const root = document.querySelector<HTMLElement>(args.selector);
		const buttons = Array.from(root?.querySelectorAll<HTMLButtonElement>('.crosswalker-launch-btn') ?? [])
			.map((button, index) => ({ index, label: button.textContent?.trim() ?? '', rect: rect(button) }));
		const pairIntersections: Array<{ left: number; right: number; intersects: boolean }> = [];
		for (let left = 0; left < buttons.length; left += 1) {
			for (let right = left + 1; right < buttons.length; right += 1) {
				pairIntersections.push({
					left,
					right,
					intersects: intersects(buttons[left].rect, buttons[right].rect),
				});
			}
		}
		return {
			kind: 'launchpad',
			theme: args.theme,
			width: args.width,
			root: rect(root),
			buttons,
			pairIntersections,
			findSourcesPresent: buttons.some((button) => button.label === 'Find sources in this vault'),
		};
	}, { selector: LAUNCHPAD, theme, width });
	await saveCapture('launchpad', theme, width, observation);
	await clearInlineWidth(LAUNCHPAD);
	return observation;
}

describe('Visual reification surfaces', function () {
	this.timeout(240_000);

	before(async () => {
		mkdirSync(OUT, { recursive: true });
		expect(CSF_COLUMNS).toHaveLength(2);
		expect(CRI_COLUMNS).toHaveLength(9);
		expect(CRI_REQUIRED_COLUMNS).toHaveLength(1);
		expect(criEntry.ontologyAliases).toContain('CRI');
		expect(RECIPE_REGISTRY.find((entry) => entry.ontology === 'nist-csf-2')?.ontologyAliases)
			.toContain('NIST CSF');
		await closeImportWizard();
		await closeCrosswalkerLeaves();
		await clearAllDrafts();
		await createFixtures();
		const indexed = await waitForVaultIndexed();
		console.log(`[reification-surfaces:index] ${JSON.stringify(indexed)}`);
		geometry.runtime = await browser.executeObsidian(({ app }) => {
			const runtimeRequire = (window as unknown as { require?: (id: string) => unknown }).require;
			let electronVersion: string | null = null;
			try {
				const electron = runtimeRequire?.('electron') as { process?: { versions?: { electron?: string } } } | undefined;
				electronVersion = electron?.process?.versions?.electron ?? null;
			} catch {
				electronVersion = null;
			}
			return {
				appVersion: (app as unknown as { appVersion?: string }).appVersion ?? null,
				electronVersion,
				userAgent: navigator.userAgent,
			};
		});
		geometry.runtime = {
			...geometry.runtime,
			fixtureContract: {
				nistSignatureColumns: CSF_COLUMNS,
				criSignatureColumns: CRI_COLUMNS,
				criFixtureColumns: CRI_FIXTURE_COLUMNS,
				criRequiredColumns: CRI_REQUIRED_COLUMNS,
				nistMappingColumn: NIST_MAPPING_COLUMN,
			},
		};
		flushGeometry();
	});

	after(async () => {
		await clearInlineWidth(SCAN);
		await clearInlineWidth(WIZARD);
		await clearInlineWidth(LAUNCHPAD);
		if (await browser.executeObsidian((_obs, selector) => Boolean(document.querySelector(selector)), SCAN)) {
			await closeScanModal();
		}
		await closeImportWizard();
		await clearAllDrafts();
		await closeCrosswalkerLeaves();
		await removeFixtures();
		await browser.executeObsidian(() => {
			document.body.classList.remove('theme-dark');
			document.body.classList.add('theme-light');
		});
		flushGeometry();
	});

	it('captures S1 through S5 in both themes and required widths', async () => {
		await openScanResults();
		for (const theme of ['light', 'dark'] as const) {
			for (const width of ['normal', '640px'] as const) {
				assertScanResults(await captureScanResults(theme, width));
			}
		}
		await closeScanModal();

		for (const theme of ['light', 'dark'] as const) {
			const progress = await captureScanProgress(theme);
			expect(typeof progress.progressCaptured).toBe('boolean');
		}

		const workbookB64 = buildCriWorkbookB64();
		await injectWorkbookAndWaitForSuggestion(workbookB64);
		for (const theme of ['light', 'dark'] as const) {
			for (const width of ['normal', '640px'] as const) {
				assertSheetSuggestion(await captureSheetSuggestion('sheet-suggestion', theme, width), false);
			}
		}
		await overrideHeaderRow();
		for (const theme of ['light', 'dark'] as const) {
			assertSheetSuggestion(await captureSheetSuggestion('sheet-suggestion-overridden', theme, 'normal'), true);
		}
		await closeImportWizard();

		await injectWorkbookAndWaitForSuggestion(workbookB64);
		const crosswalkSetup = await reachCrosswalkShapes();
		const crosswalkSetupObservation = { kind: 'crosswalk-setup', ...crosswalkSetup };
		assertNoEmDash(crosswalkSetupObservation);
		geometry.observations.push(crosswalkSetupObservation);
		flushGeometry();
		if (crosswalkSetup.cardPresent) {
			for (const theme of ['light', 'dark'] as const) {
				for (const width of ['normal', '640px'] as const) {
					const observation = await captureCrosswalkCard('crosswalks-card', theme, width);
					expect(observation.crosswalkCardPresent).toBe(true);
					expect(observation.isNeedsOntology).toBe(true);
				}
			}
			const named = await nameCrosswalkFramework();
			for (const theme of ['light', 'dark'] as const) {
				const observation = await captureCrosswalkCard('crosswalks-card-named', theme, 'normal');
				expect(observation.crosswalkCardPresent).toBe(true);
				if (named) {
					expect(observation.isNeedsOntology).toBe(false);
					expect((observation.chipTexts as string[])
					.some((text) => text.toLocaleLowerCase().startsWith('crosswalk'))).toBe(true);
				}
			}
		} else {
			for (const theme of ['light', 'dark'] as const) {
				for (const width of ['normal', '640px'] as const) {
					const observation = await captureCrosswalkCard('crosswalks-missing', theme, width);
					expect(observation.crosswalkCardPresent).toBe(false);
				}
			}
		}
		await closeImportWizard();
		await clearAllDrafts();

		await openWorkspaceHome();
		for (const theme of ['light', 'dark'] as const) {
			for (const width of ['normal', '640px'] as const) {
				const observation = await captureLaunchpad(theme, width);
				// Exact actions catch both missing and unexpectedly added controls by name.
				// Stack setup/import and draft resume are documented in CHANGELOG.md.
				expect((observation.buttons as Array<{ label: string }>).map((button) => button.label)).toEqual([
					'Import structured data',
					'Set up a framework stack',
					'Import a stack',
					'Find sources in this vault',
					'Manage saved configs',
					'Resume a draft',
				]);
				// Button overlap is recorded for the reviewer, not asserted (see assertScanResults).
				const overlap = (observation.pairIntersections as Array<{ intersects: boolean }>)
					.some((pair) => pair.intersects);
				observation.layoutFindings = overlap ? ['launchpad-button-overlap'] : [];
				if (overlap) {
					console.log(`[reification-surfaces:layout-finding] ${JSON.stringify({ theme, width, findings: observation.layoutFindings })}`);
				}
				expect(observation.findSourcesPresent).toBe(true);
			}
		}

		for (const screenshot of geometry.screenshots) expect(existsSync(screenshot)).toBe(true);
	});
});
