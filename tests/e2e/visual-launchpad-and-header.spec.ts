/// <reference types="mocha" />

/**
 * Visual contract for launchpad spacing, wizard header clearance, and preset discovery.
 *
 * The harness window is fixed near 1024px and rejects setWindowSize(). "Narrow"
 * captures therefore apply a temporary inline width of 640px to the launchpad,
 * modal, or tab-hosted flow and remove it immediately after capture.
 *
 * Preset-guide selector contract for the product implementation:
 * - container: `details.crosswalker-preset-guide`
 * - summary: `summary.crosswalker-preset-guide-summary`
 * - count: `data-preset-count` on the details element
 * - list: `.crosswalker-preset-guide-list`
 * - entries: `li.crosswalker-preset-guide-item[data-recipe-id]`, one per registry entry
 *
 * Screenshots: test-screenshots/lh-<mode>-<surface>-<theme>-<width>.png
 * Geometry: test-screenshots/launchpad-header-geometry-<mode>.json
 */

import 'webdriverio';
import 'wdio-obsidian-service';
import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	clearAllDrafts,
	closeCrosswalkerLeaves,
	closeImportWizard,
	openImportWizard,
} from './helpers/wizard-modal';
import { waitForVaultIndexed } from './helpers/vault-readiness';

const OUT = path.resolve('test-screenshots');
const MODE = process.env.CW_VISUAL_MODE === 'before' ? 'before' : 'after';
const GEOMETRY_PATH = path.join(OUT, `launchpad-header-geometry-${MODE}.json`);
const SYNTHETIC_CSV = [
	'id,name,parent',
	'ROOT,Root concept,',
	'CHILD,Child concept,ROOT',
].join('\n');

type Theme = 'light' | 'dark';
type Width = 'normal' | 'narrow';
type JsonRecord = Record<string, unknown>;

const geometry: {
	mode: string;
	createdUtc: string;
	runtime?: JsonRecord;
	observations: JsonRecord[];
	screenshots: string[];
} = {
	mode: MODE,
	createdUtc: new Date().toISOString(),
	observations: [],
	screenshots: [],
};

function flushGeometry(): void {
	writeFileSync(GEOMETRY_PATH, JSON.stringify(geometry, null, 2) + '\n', 'utf8');
	console.log(`[launchpad-header:geometry] ${JSON.stringify(geometry)}`);
}

async function setTheme(theme: Theme): Promise<void> {
	await browser.executeObsidian((_obs, requested) => {
		document.body.classList.toggle('theme-dark', requested === 'dark');
		document.body.classList.toggle('theme-light', requested === 'light');
	}, theme);
	await browser.pause(150);
}

async function saveShot(surface: string, theme: Theme, width: Width): Promise<string> {
	const target = path.join(OUT, `lh-${MODE}-${surface}-${theme}-${width}.png`);
	await browser.saveScreenshot(target);
	geometry.screenshots.push(target);
	expect(existsSync(target)).toBe(true);
	return target;
}

async function setInlineWidth(selector: string, width: Width): Promise<void> {
	await browser.executeObsidian((_obs, args) => {
		const root = document.querySelector<HTMLElement>(args.selector);
		if (root) root.style.width = args.width === 'narrow' ? '640px' : '';
	}, { selector, width });
	await browser.pause(100);
}

async function clearInlineWidth(selector: string): Promise<void> {
	await browser.executeObsidian((_obs, target) => {
		const root = document.querySelector<HTMLElement>(target);
		if (root) root.style.removeProperty('width');
	}, selector);
}

async function captureLaunchpad(
	surface: string,
	rootSelector: string,
	theme: Theme,
	width: Width,
): Promise<JsonRecord> {
	await setTheme(theme);
	await setInlineWidth(rootSelector, width);
	const observation = await browser.executeObsidian((_obs, args) => {
		type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
		const rect = (el: Element | null): Rect | null => {
			if (!el) return null;
			const value = el.getBoundingClientRect();
			return {
				left: value.left,
				top: value.top,
				right: value.right,
				bottom: value.bottom,
				width: value.width,
				height: value.height,
			};
		};
		const intersects = (a: Rect | null, b: Rect | null) => Boolean(a && b
			&& a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
		const root = document.querySelector<HTMLElement>(args.rootSelector);
		const eyebrow = root?.querySelector('.crosswalker-settings-launchpad-eyebrow') ?? null;
		const row = root?.querySelector('.crosswalker-settings-launchpad-row') ?? null;
		const buttons = Array.from(root?.querySelectorAll<HTMLButtonElement>('.crosswalker-launch-btn') ?? []);
		const buttonData = buttons.map((button, index) => {
			const icon = button.querySelector('.crosswalker-launch-ico');
			const text = Array.from(button.children).find((child) => !child.classList.contains('crosswalker-launch-ico')) ?? null;
			const style = getComputedStyle(button);
			const buttonRect = rect(button);
			const iconRect = rect(icon);
			const textRect = rect(text);
			return {
				index,
				label: button.textContent?.trim() ?? '',
				button: buttonRect,
				icon: iconRect,
				text: textRect,
				gap: style.gap,
				padding: {
					top: style.paddingTop,
					right: style.paddingRight,
					bottom: style.paddingBottom,
					left: style.paddingLeft,
				},
				iconTextIntersects: intersects(iconRect, textRect),
			};
		});
		const pairIntersections: Array<{ left: number; right: number; intersects: boolean }> = [];
		for (let left = 0; left < buttonData.length; left += 1) {
			for (let right = left + 1; right < buttonData.length; right += 1) {
				pairIntersections.push({
					left,
					right,
					intersects: intersects(buttonData[left].button, buttonData[right].button),
				});
			}
		}
		return {
			kind: 'launchpad',
			surface: args.surface,
			theme: args.theme,
			width: args.width,
			root: rect(root),
			eyebrow: rect(eyebrow),
			row: rect(row),
			buttons: buttonData,
			pairIntersections,
		};
	}, { surface, rootSelector, theme, width });
	geometry.observations.push(observation);
	await saveShot(surface, theme, width);
	await clearInlineWidth(rootSelector);
	return observation;
}

async function captureWizard(
	surface: string,
	rootSelector: string,
	theme: Theme,
	width: Width,
	stage: 'pre-file' | 'file-selected',
): Promise<JsonRecord> {
	await setTheme(theme);
	await setInlineWidth(rootSelector, width);
	const observation = await browser.executeObsidian((_obs, args) => {
		type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
		const rect = (el: Element | null): Rect | null => {
			if (!el) return null;
			const value = el.getBoundingClientRect();
			return {
				left: value.left,
				top: value.top,
				right: value.right,
				bottom: value.bottom,
				width: value.width,
				height: value.height,
			};
		};
		const intersects = (a: Rect | null, b: Rect | null) => Boolean(a && b
			&& a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
		const root = document.querySelector<HTMLElement>(args.rootSelector);
		const close = root?.querySelector('.modal-close-button, .modal-header-button') ?? root?.closest('.modal')?.querySelector('.modal-close-button, .modal-header-button') ?? null;
		const next = root?.querySelector('.crosswalker-nav-right button.mod-cta')
			?? root?.querySelector('.crosswalker-nav-right button') ?? null;
		const header = root?.querySelector('.crosswalker-wizard-header') ?? null;
		const nav = root?.querySelector('.crosswalker-nav-row') ?? null;
		const indicator = root?.querySelector('.crosswalker-step-indicator') ?? null;
		const title = root?.querySelector('.crosswalker-wizard-header h2') ?? root?.querySelector('h2') ?? null;
		const stepHeading = root?.querySelector('.crosswalker-wizard-content h3') ?? root?.querySelector('h3') ?? null;
		const sourceLink = root?.querySelector<HTMLAnchorElement>('a[href*="framework-data-sources"]') ?? null;
		const guide = root?.querySelector<HTMLDetailsElement>('.crosswalker-preset-guide') ?? null;
		const linkRect = rect(sourceLink);
		const closeRect = rect(close);
		const nextRect = rect(next);
		const namedRects: Record<string, Rect | null> = {
			close: closeRect,
			next: nextRect,
			navRow: rect(nav),
			stepIndicator: rect(indicator),
			title: rect(title),
			stepHeading: rect(stepHeading),
		};
		const names = Object.keys(namedRects);
		const pairIntersections: Array<{ left: string; right: string; intersects: boolean }> = [];
		for (let left = 0; left < names.length; left += 1) {
			for (let right = left + 1; right < names.length; right += 1) {
				pairIntersections.push({
					left: names[left],
					right: names[right],
					intersects: intersects(namedRects[names[left]], namedRects[names[right]]),
				});
			}
		}
		const headerStyle = header ? getComputedStyle(header) : null;
		const navStyle = nav ? getComputedStyle(nav) : null;
		return {
			kind: 'wizard',
			surface: args.surface,
			theme: args.theme,
			width: args.width,
			stage: args.stage,
			root: rect(root),
			close: closeRect,
			next: nextRect,
			navRow: namedRects.navRow,
			stepIndicator: namedRects.stepIndicator,
			title: namedRects.title,
			stepHeading: namedRects.stepHeading,
			pairIntersections,
			clearance: {
				headerPaddingLeft: headerStyle?.paddingLeft ?? null,
				headerPaddingRight: headerStyle?.paddingRight ?? null,
				navPaddingLeft: navStyle?.paddingLeft ?? null,
				navPaddingRight: navStyle?.paddingRight ?? null,
			},
			stepText: indicator?.textContent?.trim() ?? '',
			nextDisabled: next instanceof HTMLButtonElement ? next.disabled : null,
			closeNextIntersects: intersects(closeRect, nextRect),
			sourceLink: {
				rect: linkRect,
				visible: Boolean(sourceLink && linkRect && linkRect.width > 0 && linkRect.height > 0
					&& getComputedStyle(sourceLink).visibility !== 'hidden'),
				href: sourceLink?.href ?? '',
			},
			presetGuide: {
				present: Boolean(guide),
				open: guide?.open ?? false,
				countAttribute: guide?.dataset.presetCount ?? null,
			},
		};
	}, { surface, rootSelector, theme, width, stage });
	geometry.observations.push(observation);
	await saveShot(`${surface}-${stage}`, theme, width);
	await clearInlineWidth(rootSelector);
	return observation;
}

async function injectSyntheticCsv(rootSelector: string): Promise<boolean> {
	return browser.executeObsidian(async (_obs, args) => {
		const root = document.querySelector(args.rootSelector);
		const input = root?.querySelector<HTMLInputElement>('input[type=file]');
		if (!input) return false;
		const dt = new DataTransfer();
		dt.items.add(new File([args.csv], 'safe-launchpad-header.csv', { type: 'text/csv' }));
		input.files = dt.files;
		input.dispatchEvent(new Event('change'));
		const started = Date.now();
		while (Date.now() - started < 8_000) {
			const next = root.querySelector<HTMLButtonElement>('.crosswalker-nav-right button');
			if (root.querySelector('.crosswalker-file-card') && next && !next.disabled) return true;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return false;
	}, { rootSelector, csv: SYNTHETIC_CSV });
}

async function exactStepOne(rootSelector: string): Promise<string> {
	return browser.executeObsidian((_obs, selector) =>
		document.querySelector(selector)?.querySelector('.crosswalker-step-indicator')?.textContent?.trim() ?? '', rootSelector);
}

async function inspectAndToggleGuide(rootSelector: string): Promise<JsonRecord> {
	const before = await browser.executeObsidian(({ app }, selector) => {
		const root = document.querySelector(selector);
		const guide = root?.querySelector<HTMLDetailsElement>('.crosswalker-preset-guide') ?? null;
		const summary = guide?.querySelector<HTMLElement>('summary.crosswalker-preset-guide-summary') ?? null;
		const items = Array.from(guide?.querySelectorAll<HTMLElement>(
			'.crosswalker-preset-guide-list li.crosswalker-preset-guide-item[data-recipe-id]',
		) ?? []);
		// The product may expose the registry for diagnostics. Check only explicit,
		// stable-looking properties; do not infer a count from unrelated arrays.
		const plugin = (app as unknown as { plugins?: { plugins?: Record<string, unknown> } })
			.plugins?.plugins?.crosswalker as Record<string, unknown> | undefined;
		const candidates = [
			plugin?.recipeRegistry,
			plugin?.RECIPE_REGISTRY,
			(plugin?.registry as Record<string, unknown> | undefined)?.recipes,
			plugin?.recipes,
		];
		const exposed = candidates.find((candidate) => Array.isArray(candidate)) as unknown[] | undefined;
		summary?.focus();
		return {
			present: Boolean(guide),
			summaryPresent: Boolean(summary),
			open: guide?.open ?? false,
			countAttribute: guide?.dataset.presetCount ?? null,
			itemCount: items.length,
			recipeIds: items.map((item) => item.dataset.recipeId ?? ''),
			exposedRegistryCount: exposed?.length ?? null,
			stepText: root?.querySelector('.crosswalker-step-indicator')?.textContent?.trim() ?? '',
			fileCardPresent: Boolean(root?.querySelector('.crosswalker-file-card')),
			recognizedCardPresent: Boolean(root?.querySelector('.crosswalker-recognized-card')),
		};
	}, rootSelector);
	await browser.keys(['Enter']);
	await browser.pause(150);
	const after = await browser.executeObsidian((_obs, selector) => {
		const root = document.querySelector(selector);
		const guide = root?.querySelector<HTMLDetailsElement>('.crosswalker-preset-guide') ?? null;
		return {
			open: guide?.open ?? false,
			stepText: root?.querySelector('.crosswalker-step-indicator')?.textContent?.trim() ?? '',
			fileCardPresent: Boolean(root?.querySelector('.crosswalker-file-card')),
			recognizedCardPresent: Boolean(root?.querySelector('.crosswalker-recognized-card')),
		};
	}, rootSelector);
	const observation = { kind: 'preset-guide', rootSelector, before, after };
	geometry.observations.push(observation);
	return observation;
}

function assertLaunchpadGeometry(observation: JsonRecord): void {
	const buttons = observation.buttons as Array<JsonRecord>;
	const pairs = observation.pairIntersections as Array<{ intersects: boolean }>;
	expect(buttons.length).toBeGreaterThanOrEqual(2);
	expect(pairs.every((pair) => !pair.intersects)).toBe(true);
	for (const button of buttons) {
		expect(button.iconTextIntersects).toBe(false);
		expect(Number.parseFloat(button.gap as string)).toBeGreaterThan(0);
		const padding = button.padding as Record<string, string>;
		expect(Object.values(padding).every((value) => Number.parseFloat(value) > 0)).toBe(true);
	}
}

function assertWizardClearance(observation: JsonRecord, modalHosted: boolean): void {
	expect(observation.stepText).toBe('Step 1 of 4');
	expect((observation.sourceLink as JsonRecord).visible).toBe(true);
	const clearance = observation.clearance as Record<string, string>;
	const headerDelta = Number.parseFloat(clearance.headerPaddingRight) - Number.parseFloat(clearance.headerPaddingLeft);
	const navDelta = Number.parseFloat(clearance.navPaddingRight) - Number.parseFloat(clearance.navPaddingLeft);
	if (modalHosted) {
		expect(observation.close).not.toBeNull();
		expect(observation.next).not.toBeNull();
		expect(observation.closeNextIntersects).toBe(false);
		// The modal reserves space for native close chrome. The product may put
		// that reservation on either the header shell or the navigation row.
		expect(Math.max(headerDelta, navDelta)).toBeGreaterThan(0);
	} else {
		expect(observation.close).toBeNull();
		expect(observation.closeNextIntersects).toBe(false);
		// The same flow hosted in a tab has no native close chrome and therefore
		// must not inherit the modal-only right-side reservation.
		expect(Math.abs(headerDelta)).toBeLessThan(0.5);
		expect(Math.abs(navDelta)).toBeLessThan(0.5);
	}
}

function assertGuide(observation: JsonRecord): void {
	const before = observation.before as JsonRecord;
	const after = observation.after as JsonRecord;
	const count = Number.parseInt(String(before.countAttribute), 10);
	expect(before.present).toBe(true);
	expect(before.summaryPresent).toBe(true);
	expect(before.open).toBe(false);
	expect(after.open).toBe(true);
	expect(after.stepText).toBe(before.stepText);
	expect(after.fileCardPresent).toBe(before.fileCardPresent);
	expect(after.recognizedCardPresent).toBe(before.recognizedCardPresent);
	const recipeIds = before.recipeIds as string[];
	expect(recipeIds.every((id) => id.length > 0)).toBe(true);
	expect(new Set(recipeIds).size).toBe(recipeIds.length);
	expect(count).toBe(before.itemCount);
	if (typeof before.exposedRegistryCount === 'number') {
		expect(count).toBe(before.exposedRegistryCount);
	} else {
		expect(count).toBeGreaterThanOrEqual(12);
	}
}

async function openWorkspaceHome(): Promise<boolean> {
	return browser.executeObsidian(async ({ app }) => {
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		// @ts-expect-error -- internal commands API
		app.commands.executeCommandById('crosswalker:open-crosswalker-workspace');
		const started = Date.now();
		while (Date.now() - started < 8_000) {
			if (document.querySelector('.crosswalker-workspace-view .crosswalker-settings-launchpad')) return true;
			await sleep(100);
		}
		return false;
	});
}

describe('Visual — launchpad spacing, wizard header clearance, and preset discovery', function () {
	this.timeout(180_000);

	before(async () => {
		mkdirSync(OUT, { recursive: true });
		const indexed = await waitForVaultIndexed();
		console.log(`[launchpad-header:index] ${JSON.stringify(indexed)}`);
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
	});

	beforeEach(async () => {
		await closeImportWizard();
		await clearAllDrafts();
		await closeCrosswalkerLeaves();
		await browser.executeObsidian(({ app }) => {
			// @ts-expect-error -- internal setting API
			app.setting?.close?.();
		});
	});

	afterEach(async () => {
		await clearInlineWidth('.crosswalker-settings-launchpad');
		await clearInlineWidth('.crosswalker-wizard-modal');
		await clearInlineWidth('.crosswalker-workspace-flow');
		await closeImportWizard();
		await closeCrosswalkerLeaves();
		await browser.executeObsidian(({ app }) => {
			// @ts-expect-error -- internal setting API
			app.setting?.close?.();
			document.body.classList.remove('theme-dark');
			document.body.classList.add('theme-light');
		});
		flushGeometry();
	});

	after(() => {
		flushGeometry();
	});

	it('captures settings-tab and workspace-view launchpads in both themes and widths', async () => {
		await browser.pause(6000);
		const settingsDiagnostics = await browser.executeObsidian(async ({ app }) => {
			const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
			// `settingsPopoutWindow` is forced off by the harness `beforeSuite` hook
			// in wdio.conf.mts, because Obsidian 1.13 defaults it on and the popout
			// window is invisible to the driver. These two fields report what the
			// hook found and left, so a regression shows up in the diagnostics line.
			const vault = app.vault as unknown as {
				getConfig?: (key: string) => unknown;
				setConfig?: (key: string, value: unknown) => void;
			};
			const popoutDefault = vault.getConfig?.('settingsPopoutWindow') ?? null;
			// A settings surface already on screen would be refocused, not reopened.
			// @ts-expect-error -- internal setting API
			app.setting?.close?.();
			await sleep(150);
			// @ts-expect-error -- internal setting API
			app.setting.open();
			await sleep(300);
			// @ts-expect-error -- internal setting API
			const tab = app.setting.openTabById('crosswalker');
			return {
				popoutDefault,
				popoutNow: vault.getConfig?.('settingsPopoutWindow') ?? null,
				settingsModalPresent: Boolean(document.querySelector('.modal.mod-settings')),
				tabReturned: Boolean(tab),
				// @ts-expect-error -- internal setting API
				pluginTabIds: app.setting.pluginTabs.map((candidate) => candidate.id),
				// @ts-expect-error -- internal setting API
				activeTab: app.setting.activeTab?.id ?? null,
			};
		});
		console.log(`[launchpad-header:settings] ${JSON.stringify(settingsDiagnostics)}`);
		const settingsRoot = await browser.executeObsidian(async () => {
			const started = Date.now();
			while (Date.now() - started < 8_000) {
				if (document.querySelector('.crosswalker-settings .crosswalker-settings-launchpad')) return true;
				if (document.querySelector('.crosswalker-settings-cardgrid')) return true;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			return null;
		});
		if (MODE === 'after') expect(settingsRoot).not.toBeNull();
		for (const theme of ['light', 'dark'] as const) {
			for (const width of ['normal', 'narrow'] as const) {
				const result = await captureLaunchpad(
					'settings-launchpad',
					'.crosswalker-settings .crosswalker-settings-launchpad',
					theme,
					width,
				);
				if (MODE === 'after') assertLaunchpadGeometry(result);
			}
		}
		await browser.executeObsidian(({ app }) => {
			// @ts-expect-error -- internal setting API
			app.setting?.close?.();
		});

		const workspaceOpened = await openWorkspaceHome();
		if (MODE === 'after') expect(workspaceOpened).toBe(true);
		for (const theme of ['light', 'dark'] as const) {
			for (const width of ['normal', 'narrow'] as const) {
				const result = await captureLaunchpad(
					'workspace-launchpad',
					'.crosswalker-workspace-view .crosswalker-settings-launchpad',
					theme,
					width,
				);
				if (MODE === 'after') assertLaunchpadGeometry(result);
			}
		}
	});

	it('captures modal Step 1 before and after file selection and verifies native dismissal', async () => {
		const opened = await openImportWizard();
		console.log(`[launchpad-header:modal-open] ${JSON.stringify(opened)}`);
		expect(await exactStepOne('.crosswalker-wizard-modal')).toBe('Step 1 of 4');

		if (MODE === 'after') {
			const guide = await inspectAndToggleGuide('.crosswalker-wizard-modal');
			assertGuide(guide);
		}
		for (const theme of ['light', 'dark'] as const) {
			for (const width of ['normal', 'narrow'] as const) {
				const result = await captureWizard('modal-step1', '.crosswalker-wizard-modal', theme, width, 'pre-file');
				if (MODE === 'after') assertWizardClearance(result, true);
			}
		}

		const selected = await injectSyntheticCsv('.crosswalker-wizard-modal');
		if (MODE === 'after') expect(selected).toBe(true);
		for (const theme of ['light', 'dark'] as const) {
			for (const width of ['normal', 'narrow'] as const) {
				const result = await captureWizard('modal-step1', '.crosswalker-wizard-modal', theme, width, 'file-selected');
				if (MODE === 'after') {
					assertWizardClearance(result, true);
					expect(result.nextDisabled).toBe(false);
				}
			}
		}

		if (MODE === 'after') {
			const clickedClose = await browser.executeObsidian(() => {
				const modal = document.querySelector('.crosswalker-wizard-modal');
				const close = modal?.querySelector<HTMLElement>('.modal-close-button, .modal-header-button')
					?? modal?.closest('.modal')?.querySelector<HTMLElement>('.modal-close-button, .modal-header-button');
				close?.click();
				return Boolean(close);
			});
			expect(clickedClose).toBe(true);
			await browser.waitUntil(async () => browser.executeObsidian(() =>
				!document.querySelector('.crosswalker-wizard-modal')), { timeout: 5_000 });

			const reopened = await openImportWizard();
			expect(reopened.opened).toBe(true);
			await browser.keys(['Escape']);
			await browser.waitUntil(async () => browser.executeObsidian(() =>
				!document.querySelector('.crosswalker-wizard-modal')), { timeout: 5_000 });
		}
	});

	it('captures tab-hosted Step 1 and proves modal-close clearance is not applied there', async () => {
		const workspaceOpened = await openWorkspaceHome();
		if (MODE === 'after') expect(workspaceOpened).toBe(true);
		const flowOpened = await browser.executeObsidian(async () => {
			const root = document.querySelector('.crosswalker-workspace-view');
			const launch = Array.from(root?.querySelectorAll<HTMLButtonElement>('.crosswalker-launch-btn') ?? [])
				.find((button) => button.textContent?.includes('Import structured data'));
			launch?.click();
			const started = Date.now();
			while (Date.now() - started < 8_000) {
				if (document.querySelector('.crosswalker-workspace-flow input[type=file]')) return true;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			return false;
		});
		if (MODE === 'after') expect(flowOpened).toBe(true);
		expect(await exactStepOne('.crosswalker-workspace-flow')).toBe('Step 1 of 4');

		if (MODE === 'after') {
			const guide = await inspectAndToggleGuide('.crosswalker-workspace-flow');
			assertGuide(guide);
		}
		for (const theme of ['light', 'dark'] as const) {
			for (const width of ['normal', 'narrow'] as const) {
				const result = await captureWizard('tab-step1', '.crosswalker-workspace-flow', theme, width, 'pre-file');
				if (MODE === 'after') assertWizardClearance(result, false);
			}
		}

		const selected = await injectSyntheticCsv('.crosswalker-workspace-flow');
		if (MODE === 'after') expect(selected).toBe(true);
		for (const theme of ['light', 'dark'] as const) {
			for (const width of ['normal', 'narrow'] as const) {
				const result = await captureWizard('tab-step1', '.crosswalker-workspace-flow', theme, width, 'file-selected');
				if (MODE === 'after') {
					assertWizardClearance(result, false);
					expect(result.nextDisabled).toBe(false);
				}
			}
		}
	});
});
