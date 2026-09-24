/**
 * visual-layout-widths.spec.ts — the no-horizontal-overflow invariant, at
 * EVERY pane width.
 *
 * Why this exists: the harness window is fixed (~1024px, `setWindowSize`
 * rejected), so for weeks every screenshot rendered ONE width and the wide
 * layout branch never rendered in any automated run — the owner's split-screen
 * test then found overflow twice (viewport-vs-pane breakpoints, then a wide
 * breakpoint below the grid's own minimum). Container queries make width
 * testable WITHOUT window resizing: we set the flow container's width directly
 * and assert the pane never overflows horizontally.
 *
 *   DISPLAY=:0 bun run e2e -- --spec tests/e2e/visual-layout-widths.spec.ts
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('test-screenshots');

const CPRT_CSV = [
	'element_identifier,title,element_type,text',
	'GV,Govern,function,"Strategy expectations and policy are established."',
	'GV.OC,Organizational Context,category,"Circumstances are understood."',
	'GV.OC-01,,subcategory,"The organizational mission is understood."',
	'ID,Identify,function,"Current cybersecurity risks are understood."',
	'ID.AM,Asset Management,category,"Assets are identified and managed."',
	'ID.AM-01,,subcategory,"Inventories of hardware are maintained."',
].join('\n');

/** Pane widths spanning every layout branch, including the exact stacked
 *  boundary and the first pixel above it. */
const WIDTHS = [520, 700, 759, 760, 761, 762, 800, 1000, 1200, 1300, 1450];

describe('Visual — no pane-level horizontal overflow at any width', function () {
	this.timeout(180_000);

	before(async () => {
		mkdirSync(OUT, { recursive: true });
		await browser.pause(6000);
	});

	it('workbench fits its pane at every width branch', async () => {
		// Mount the workspace view and jump straight to step 2 via the prefill
		// path (same journey as the file context menu).
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error internal plugins API
			const plugin = app.plugins.plugins['crosswalker'];
			plugin.settings.enableConfigSuggestions = false;
			plugin.settings.enableDraftSessions = false;
			// The shape-first workbench is opt-in; defaults otherwise show classic mapping.
			plugin.settings.enableShapeWorkbench = true;
			const PATH = 'GraphTest-widths.csv';
			const existing = app.vault.getAbstractFileByPath(PATH);
			if (existing) await app.vault.delete(existing);
			await app.vault.create(PATH, (window as unknown as { __CW_CSV__: string }).__CW_CSV__ ?? '');
		});
		await browser.execute((csv: string) => {
			(window as unknown as { __CW_CSV__: string }).__CW_CSV__ = csv;
		}, CPRT_CSV);
		await browser.executeObsidian(async ({ app }) => {
			const PATH = 'GraphTest-widths.csv';
			const existing = app.vault.getAbstractFileByPath(PATH);
			if (existing) await app.vault.delete(existing);
			await app.vault.create(PATH, (window as unknown as { __CW_CSV__: string }).__CW_CSV__);
			const leaves = app.workspace.getLeavesOfType('crosswalker-workspace');
			const leaf = leaves[0] ?? app.workspace.getLeaf('tab');
			await leaf.setViewState({ type: 'crosswalker-workspace', active: true });
			app.workspace.revealLeaf(leaf);
			// @ts-expect-error view API
			const view = leaf.view;
			const file = app.vault.getAbstractFileByPath(PATH);
			await view.startImportWithFile(file);
		});
		await browser.waitUntil(
			async () => (await browser.$$('.crosswalker-workbench')).length > 0,
			{ timeout: 30_000, timeoutMsg: 'workbench did not mount' },
		);

		const failures: string[] = [];
		for (const width of WIDTHS) {
			const result = await browser.execute((w: number) => {
				const flow = document.querySelector('.crosswalker-workspace-flow') as HTMLElement | null;
				if (!flow) return { error: 'no flow element' };
				// The nearest cw-flow container is the nested wizard-content. Container
				// queries use its layout content box before the vertical scrollbar is
				// subtracted, so derive the query width from the border box and CSS insets.
				const content = flow.querySelector('.crosswalker-wizard-content') as HTMLElement | null;
				if (!content) return { error: 'no wizard content' };
				const style = getComputedStyle(content);
				const horizontalInsets = parseFloat(style.paddingLeft)
					+ parseFloat(style.paddingRight)
					+ parseFloat(style.borderLeftWidth)
					+ parseFloat(style.borderRightWidth);
				const queryWidth = content.getBoundingClientRect().width - horizontalInsets;
				const hostToQueryDelta = flow.getBoundingClientRect().width - queryWidth;
				const borderBoxWidth = w + hostToQueryDelta;
				flow.style.flex = 'none';
				flow.style.width = `${borderBoxWidth}px`;
				flow.style.maxWidth = `${borderBoxWidth}px`;
				return { ok: true };
			}, width);
			expect(result).toEqual({ ok: true });
			await browser.pause(250);

			const expanded = await browser.execute(() => {
				const flow = document.querySelector('.crosswalker-workspace-flow') as HTMLElement;
				const grid = document.querySelector('.crosswalker-workbench') as HTMLElement;
				const source = grid.querySelector('.crosswalker-wb-source') as HTMLElement | null;
				const content = flow.querySelector('.crosswalker-wizard-content') as HTMLElement;
				const style = getComputedStyle(content);
				const horizontalInsets = parseFloat(style.paddingLeft)
					+ parseFloat(style.paddingRight)
					+ parseFloat(style.borderLeftWidth)
					+ parseFloat(style.borderRightWidth);
				return {
					flowScroll: flow.scrollWidth,
					flowClient: flow.clientWidth,
					containerWidth: content.getBoundingClientRect().width - horizontalInsets,
					gridScroll: grid.scrollWidth,
					gridClient: grid.clientWidth,
					cols: getComputedStyle(grid).gridTemplateColumns,
					sourceDisplay: source ? getComputedStyle(source).display : '',
				};
			});
			const expandedTracks = expanded.cols.trim().split(/\s+/).filter(Boolean).length;
			if (Math.abs(expanded.containerWidth - width) > 1) {
				failures.push(`width ${width}: query container measured ${expanded.containerWidth}px`);
			}
			if (expanded.flowScroll > expanded.flowClient + 2) {
				failures.push(
					`width ${width} expanded: flow overflows (scroll ${expanded.flowScroll} > client ${expanded.flowClient}); columns [${expanded.cols}]`,
				);
			}
			const expectedExpandedTracks = width <= 760 ? 1 : 3;
			if (expandedTracks !== expectedExpandedTracks) {
				failures.push(`width ${width} expanded: expected ${expectedExpandedTracks} track(s), got ${expandedTracks} [${expanded.cols}]`);
			}
			if (expanded.sourceDisplay === 'none') failures.push(`width ${width} expanded: Source is hidden`);
			if ([760, 761, 800, 1450].includes(width)) {
				await browser.saveScreenshot(path.join(OUT, `layout-${width}-expanded.png`));
			}

			const collapsed = await browser.execute(async () => {
				const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
				const collapse = document.querySelector('[data-source-control="collapse"]') as HTMLButtonElement | null;
				collapse?.click();
				await sleep(250);
				const flow = document.querySelector('.crosswalker-workspace-flow') as HTMLElement;
				const grid = document.querySelector('.crosswalker-workbench') as HTMLElement;
				const source = grid.querySelector('.crosswalker-wb-source') as HTMLElement | null;
				const visibleRestores = Array.from(grid.querySelectorAll<HTMLElement>('[data-source-control="restore"]'))
					.filter((el) => getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0);
				return {
					flowScroll: flow.scrollWidth,
					flowClient: flow.clientWidth,
					gridScroll: grid.scrollWidth,
					gridClient: grid.clientWidth,
					cols: getComputedStyle(grid).gridTemplateColumns,
					sourceDisplay: source ? getComputedStyle(source).display : '',
					sourceWidth: source?.getBoundingClientRect().width ?? 0,
					summary: source?.querySelector('.crosswalker-wb-source-disclosure-summary')?.textContent?.trim() ?? '',
					visibleRestoreCount: visibleRestores.length,
					restoreFocused: document.activeElement === visibleRestores[0],
				};
			});
			const collapsedTracks = collapsed.cols.trim().split(/\s+/).filter(Boolean).length;
			if (collapsed.flowScroll > collapsed.flowClient + 2) {
				failures.push(
					`width ${width} collapsed: flow overflows (scroll ${collapsed.flowScroll} > client ${collapsed.flowClient}); columns [${collapsed.cols}]`,
				);
			}
			if (collapsed.visibleRestoreCount !== 1) {
				failures.push(`width ${width} collapsed: expected one visible restore, got ${collapsed.visibleRestoreCount}`);
			}
			if (!collapsed.restoreFocused) failures.push(`width ${width} collapsed: visible restore did not receive focus`);
			if (width <= 760) {
				if (collapsedTracks !== 1) failures.push(`width ${width} collapsed: expected one stacked track, got ${collapsedTracks}`);
				if (collapsed.sourceDisplay === 'none') failures.push(`width ${width} collapsed: compact Source disclosure is hidden`);
				if (collapsed.summary !== '6 rows · 4 columns') {
					failures.push(`width ${width} collapsed: unexpected Source summary [${collapsed.summary}]`);
				}
			} else {
				if (collapsedTracks !== 2) failures.push(`width ${width} collapsed: expected two tracks, got ${collapsedTracks} [${collapsed.cols}]`);
				if (collapsed.sourceDisplay !== 'none' || collapsed.sourceWidth !== 0) {
					failures.push(`width ${width} collapsed: Source box remains visible (${collapsed.sourceDisplay}, ${collapsed.sourceWidth}px)`);
				}
				if (collapsed.cols.includes('56px')) failures.push(`width ${width} collapsed: legacy 56px strip remains [${collapsed.cols}]`);
			}
			if ([760, 761, 800, 1450].includes(width)) {
				await browser.saveScreenshot(path.join(OUT, `layout-${width}-collapsed.png`));
			}
			console.log(
				`[layout-widths] ${width}px expanded [${expanded.cols}] collapsed [${collapsed.cols}] ` +
				`scroll ${collapsed.flowScroll}/${collapsed.flowClient}`,
			);

			await browser.execute(async () => {
				const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
				const restores = Array.from(document.querySelectorAll<HTMLElement>('[data-source-control="restore"]'));
				const restore = restores.find((el) => getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0);
				(restore as HTMLButtonElement | undefined)?.click();
				await sleep(200);
			});
		}

		// Reset the forced width.
		await browser.execute(() => {
			const flow = document.querySelector('.crosswalker-workspace-flow') as HTMLElement | null;
			if (flow) {
				flow.style.flex = '';
				flow.style.width = '';
				flow.style.maxWidth = '';
			}
		});

		expect(failures).toEqual([]);
	});
});
