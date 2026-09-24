/**
 * visual-workspace-flow.spec.ts — the import flow hosted INSIDE the Crosswalker
 * workspace view (spec `.workspace/2026-07-05-shape-first-wizard-spec.md` §7n).
 *
 * Drives the same `ImportFlow` the modal uses, but mounted in the workspace
 * ItemView tab instead: home screen (launchpad + installed frameworks) →
 * "Import structured data" → recognized-source card → workbench (source rail,
 * canvas, preview rail, collapsible source rail) → review → generate → back to
 * the home screen with live note/link counts and an "Import again" affordance.
 *
 *   DISPLAY=:0 bun run e2e -- --spec tests/e2e/visual-workspace-flow.spec.ts
 *
 * Screenshots land in test-screenshots/ (view-01 … view-09, incl. one dark
 * capture). Sidebars are collapsed for the run so the view's content area gets
 * as much of the harness's fixed ~1024px window as possible — this harness's
 * Electron/CDP surface rejects `setWindowSize` (see visual-control-lens.spec.ts),
 * so the wide-canvas (>=1100px) proportion breakpoint cannot be screenshotted
 * triggering here; it's verified structurally instead (see Stage D).
 *
 * One test drives the whole flow (view state is shared across stages —
 * splitting into separate `it`s would re-mount the view mid-flow). Rich
 * diagnostics are returned from each executeObsidian block and logged.
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { clearAllDrafts, closeCrosswalkerLeaves, closeImportWizard } from './helpers/wizard-modal';
import { waitForVaultIndexed } from './helpers/vault-readiness';

const OUT = path.resolve('test-screenshots');

/** The destination this spec generates into, and must NOT start out owning. */
const GENERATED_DEST = 'Frameworks/NIST-CSF-2.0';

/** A NIST CSF 2.0 CPRT-shaped CSV — matches the bundled
 *  nist-csf-2-cprt-hierarchical recipe (same fixture as visual-workbench.spec.ts),
 *  reused here so the recognized-source fast path is exercised through the view. */
const CPRT_CSV = [
	'element_identifier,title,element_type,text',
	'GV,Govern,function,"The organizations cybersecurity risk management strategy, expectations, and policy are established, communicated, and monitored."',
	'GV.OC,Organizational Context,category,"The circumstances that surround the organizations cybersecurity risk management decisions are understood."',
	'GV.OC-01,,subcategory,"The organizational mission is understood and informs cybersecurity risk management."',
	'ID,Identify,function,"The organizations current cybersecurity risks are understood."',
	'ID.AM,Asset Management,category,"Assets are identified and managed consistent with their relative importance."',
	'ID.AM-01,,subcategory,"Inventories of hardware managed by the organization are maintained."',
	'PR,Protect,function,"Safeguards to manage the organizations cybersecurity risks are used."',
	'PR.AA,Identity Management,category,"Access to physical and logical assets is limited to authorized users."',
].join('\n');

describe('Visual — Crosswalker workspace view hosts the full import flow (spec §7n)', function () {
	this.timeout(180_000);

	before(async () => {
		mkdirSync(OUT, { recursive: true });

		// -- Per-spec isolation (triage 2026-08-24, rank 2). The load-bearing
		// assertion here is that the home screen REDISCOVERS `Frameworks/NIST-CSF-2.0`
		// after generation. If a previous run left that folder behind, the
		// assertion passes without the refresh path ever working; if a previous
		// spec left a wizard modal or a workspace leaf open, `noModal` and the
		// view mount are reading someone else's state.
		await closeImportWizard();
		await clearAllDrafts();
		await closeCrosswalkerLeaves();

		// CONDITION: the destination is absent from the vault index before we start.
		const removed = await browser.executeObsidian(async ({ app }, dest) => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const folder = app.vault.getAbstractFileByPath(dest);
			if (folder) {
				// @ts-expect-error — internal trash API
				await app.vault.trash(folder, false);
			}
			const deadline = Date.now() + 8000;
			while (app.vault.getAbstractFileByPath(dest) && Date.now() < deadline) await sleep(50);
			return !app.vault.getAbstractFileByPath(dest);
		}, GENERATED_DEST);
		expect(removed).toBe(true);

		// CONDITION: Obsidian has indexed every note. Replaces `pause(6000)`,
		// which was sized for the retired 11k-note development vault.
		const indexed = await waitForVaultIndexed();
		if (!indexed.ready) {
			console.warn(`[view] vault index incomplete: ${indexed.pending}/${indexed.total} pending after ${indexed.waitedMs}ms`);
		}

		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error — internal plugins API
			const plugin = app.plugins.plugins['crosswalker'];
			// Deterministic step-1 → recognized-card advance (same reasoning as
			// visual-workbench.spec.ts): a vault with saved configs would otherwise
			// show a suggestion banner and hold the wizard on step 1.
			plugin.settings.enableConfigSuggestions = false;
			plugin.settings.enableDraftSessions = false;
			await plugin.saveSettings();
			// Collapse both sidebars — the harness can't resize the window (CDP
			// rejects Browser.getWindowForTarget here), so this is the only lever
			// to maximize the view's content width for the screenshots.
			// @ts-expect-error — internal workspace API
			app.workspace.leftSplit?.collapse?.();
			// @ts-expect-error — internal workspace API
			app.workspace.rightSplit?.collapse?.();
		});
	});

	after(async () => {
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error — internal plugins API
			const plugin = app.plugins.plugins['crosswalker'];
			if (plugin) {
				plugin.settings.enableConfigSuggestions = true;
				plugin.settings.enableDraftSessions = true;
				await plugin.saveSettings();
			}
			// @ts-expect-error — internal workspace API
			app.workspace.leftSplit?.expand?.();
			// @ts-expect-error — internal workspace API
			app.workspace.rightSplit?.expand?.();
			// Close any workspace-view leaves so later specs start clean.
			// @ts-expect-error — internal API
			for (const leaf of app.workspace.getLeavesOfType('crosswalker-workspace')) leaf.detach();
		});
	});

	it('runs the full home → import → workbench → review → generate → home loop in-view', async () => {
		// -- Stage A: open the workspace tab (command palette entry point).
		const openInfo = await browser.executeObsidian(async ({ app }) => {
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
			// @ts-expect-error — commands API is untyped
			app.commands.executeCommandById('crosswalker:open-crosswalker-workspace');
			const view = await waitFor('.crosswalker-workspace-view', 8000);
			// The test vault can persist a second center split from an interrupted run.
			// Remove only sibling leaves in the main workspace so this view actually
			// receives the full width promised by the visual scenario.
			const target = app.workspace.getLeavesOfType('crosswalker-workspace')[0];
			const siblings: typeof target[] = [];
			if (target) {
				app.workspace.iterateAllLeaves((leaf) => {
					if (
						leaf !== target
						&& leaf.containerEl.closest('.workspace-split.mod-root')
					) siblings.push(leaf);
				});
				for (const leaf of siblings) leaf.detach();
				app.workspace.revealLeaf(target);
				await sleep(300);
			}
			return {
				ok: !!view,
				noModal: !document.querySelector('.modal'),
				hasLaunchpad: !!document.querySelector('.crosswalker-settings-launchpad'),
				hasInstalledHeading: document.querySelector('.crosswalker-workspace-installed-heading')?.textContent ?? '',
			};
		});
		console.log('[view] open → ' + JSON.stringify(openInfo));
		await browser.saveScreenshot(path.join(OUT, 'view-01-home.png'));
		expect(openInfo.ok).toBe(true);
		expect(openInfo.noModal).toBe(true);
		expect(openInfo.hasLaunchpad).toBe(true);
		expect(openInfo.hasInstalledHeading).toBe('Installed frameworks');

		// -- Stage B: "Import structured data" mounts the flow IN the view — no modal.
		const flowOpen = await browser.executeObsidian(async () => {
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
			const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-launch-btn')).find(
				(b) => b.textContent?.includes('Import structured data'),
			);
			if (!btn) return { ok: false as const, reason: 'NO_BTN' };
			btn.click();
			const flow = await waitFor('.crosswalker-workspace-flow', 8000);
			await sleep(300);
			return {
				ok: !!flow,
				noModal: !document.querySelector('.modal'),
				isFlowActive: document.querySelector('.crosswalker-workspace-view')?.classList.contains('is-flow-active') ?? false,
				hasHeader: !!document.querySelector('.crosswalker-workspace-flow .crosswalker-wizard-header'),
				hasFileInput: !!document.querySelector('.crosswalker-workspace-flow input[type=file]'),
			};
		});
		console.log('[view] flow-open → ' + JSON.stringify(flowOpen));
		await browser.saveScreenshot(path.join(OUT, 'view-02-flow-step1.png'));
		expect(flowOpen.ok).toBe(true);
		expect(flowOpen.noModal).toBe(true);
		expect(flowOpen.isFlowActive).toBe(true);
		expect(flowOpen.hasHeader).toBe(true);
		expect(flowOpen.hasFileInput).toBe(true);

		// -- Stage C: inject the CPRT CSV → Next → recognized-source card, in-view.
		const recognized = await browser.executeObsidian(async (_a, csv) => {
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
			const root = document.querySelector('.crosswalker-workspace-flow');
			if (!root) return { ok: false as const, reason: 'NO_ROOT' };
			const input = root.querySelector('input[type=file]') as HTMLInputElement | null;
			if (!input) return { ok: false as const, reason: 'NO_FILE_INPUT' };
			const dt = new DataTransfer();
			dt.items.add(new File([csv as string], 'nist-csf-2-cprt.csv'));
			input.files = dt.files;
			input.dispatchEvent(new Event('change'));
			await sleep(700);
			const next = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.includes('Next'));
			if (!next) return { ok: false as const, reason: 'NO_NEXT' };
			(next as HTMLButtonElement).click();
			const card = await waitFor('.crosswalker-recognized-card', 8000);
			return {
				ok: !!card,
				title: root.querySelector('.crosswalker-recognized-title')?.textContent ?? '',
				badge: root.querySelector('.crosswalker-prov-badge')?.textContent ?? '',
				hasCustomize: Array.from(root.querySelectorAll('.crosswalker-recognized-actions button')).some(
					(b) => b.textContent?.trim() === 'Customize',
				),
			};
		}, CPRT_CSV);
		console.log('[view] recognized → ' + JSON.stringify(recognized));
		await browser.saveScreenshot(path.join(OUT, 'view-03-recognized.png'));
		expect(recognized.ok).toBe(true);
		if (recognized.ok) {
			expect(recognized.title).toContain('NIST CSF');
			expect(recognized.badge).toContain('Built-in');
			expect(recognized.hasCustomize).toBe(true);
		}

		// -- Stage D: "Customize" → the live workbench, in-view, at whatever width
		//    the harness's window gives us. Confirms the three zones render and
		//    reports the actual grid column widths (structural proof the wide-canvas
		//    CSS is wired correctly even where the harness's fixed ~1024px window
		//    can't trigger the >=1100px "generous" breakpoint — see file header).
		const workbench = await browser.executeObsidian(async () => {
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
			const root = document.querySelector('.crosswalker-workspace-flow');
			if (!root) return { ok: false as const, reason: 'NO_ROOT' };
			const customize = Array.from(root.querySelectorAll('.crosswalker-recognized-actions button')).find(
				(b) => b.textContent?.trim() === 'Customize',
			) as HTMLButtonElement | undefined;
			if (!customize) return { ok: false as const, reason: 'NO_CUSTOMIZE' };
			customize.click();
			const wb = await waitFor('.crosswalker-workbench', 8000);
			if (!wb) return { ok: false as const, reason: 'NO_WORKBENCH' };
			const grid = getComputedStyle(wb as HTMLElement).gridTemplateColumns;
			const source = root.querySelector('.crosswalker-wb-source') as HTMLElement | null;
			const collapse = root.querySelector('[data-source-control="collapse"]') as HTMLButtonElement | null;
			return {
				ok: true as const,
				hasSource: !!source,
				hasCanvas: !!root.querySelector('.crosswalker-wb-canvas'),
				hasPreview: !!root.querySelector('.crosswalker-wb-preview'),
				gridTemplateColumns: grid,
				flowWidth: root.getBoundingClientRect().width,
				sourceId: source?.id ?? '',
				collapseControls: collapse?.getAttribute('aria-controls') ?? '',
				collapseExpanded: collapse?.getAttribute('aria-expanded') ?? '',
				connectionOptions: Array.from(root.querySelectorAll('[data-connection-option]'))
					.map((el) => el.getAttribute('data-connection-option')),
				viewportWidth: window.innerWidth,
				matchesWideBreakpoint: window.matchMedia('(min-width: 1100px)').matches,
			};
		});
		console.log('[view] workbench → ' + JSON.stringify(workbench));
		await browser.saveScreenshot(path.join(OUT, 'view-04-workbench-wide.png'));
		expect(workbench.ok).toBe(true);
		if (workbench.ok) {
			expect(workbench.hasSource).toBe(true);
			expect(workbench.hasCanvas).toBe(true);
			expect(workbench.hasPreview).toBe(true);
			// The full-width workspace begins as three real zones.
			expect(workbench.flowWidth).toBeGreaterThan(760);
			expect(workbench.gridTemplateColumns.split(' ').length).toBe(3);
			expect(workbench.sourceId).toMatch(/^crosswalker-source-\d+$/);
			expect(workbench.collapseControls).toBe(workbench.sourceId);
			expect(workbench.collapseExpanded).toBe('true');
			expect(workbench.connectionOptions).toEqual(expect.arrayContaining([
				'children-lists', 'shared-value-hubs', 'folder-indexes',
			]));
		}

		// -- Stage E: collapse Source. Above 760px it leaves no visible box or
		//    placeholder track: Mappings + Preview become exactly two columns, and
		//    the visible Show source action receives focus.
		const collapsed = await browser.executeObsidian(async () => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const root = document.querySelector('.crosswalker-workspace-flow');
			if (!root) return { ok: false as const };
			const btn = root.querySelector('[data-source-control="collapse"]') as HTMLButtonElement | null;
			if (!btn) return { ok: false as const, reason: 'NO_COLLAPSE_BTN' };
			const source = root.querySelector('.crosswalker-wb-source') as HTMLElement | null;
			const before = source?.getBoundingClientRect().width ?? 0;
			const controls = btn.getAttribute('aria-controls') ?? '';
			btn.click();
			await sleep(400);
			const wb = root.querySelector('.crosswalker-workbench') as HTMLElement | null;
			const collapsedSource = root.querySelector('.crosswalker-wb-source') as HTMLElement | null;
			const visibleRestores = Array.from(root.querySelectorAll<HTMLElement>('[data-source-control="restore"]'))
				.filter((el) => getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0);
			const restore = visibleRestores[0];
			return {
				ok: true as const,
				isCollapsed: wb?.classList.contains('is-source-collapsed') ?? false,
				widthBefore: before,
				widthAfter: collapsedSource?.getBoundingClientRect().width ?? 0,
				sourceDisplay: collapsedSource ? getComputedStyle(collapsedSource).display : '',
				gridTemplateColumns: wb ? getComputedStyle(wb).gridTemplateColumns : '',
				visibleRestoreCount: visibleRestores.length,
				restoreText: restore?.textContent?.trim() ?? '',
				restoreControls: restore?.getAttribute('aria-controls') ?? '',
				restoreExpanded: restore?.getAttribute('aria-expanded') ?? '',
				restoreFocused: document.activeElement === restore,
				controls,
				connectionsOutcome: root.querySelector('[data-connection-option="children-lists"] .crosswalker-wb-connection-outcome')?.textContent?.trim() ?? '',
			};
		});
		console.log('[view] collapse → ' + JSON.stringify(collapsed));
		await browser.saveScreenshot(path.join(OUT, 'view-05-source-collapsed.png'));
		const previousTheme = await browser.executeObsidian(() => ({
			dark: document.body.classList.contains('theme-dark'),
			light: document.body.classList.contains('theme-light'),
		}));
		await browser.executeObsidian(() => {
			document.body.classList.remove('theme-light');
			document.body.classList.add('theme-dark');
		});
		await browser.pause(200);
		await browser.saveScreenshot(path.join(OUT, 'view-05-source-collapsed-dark.png'));
		await browser.executeObsidian((_a, state: unknown) => {
			const theme = state as { dark: boolean; light: boolean };
			document.body.classList.toggle('theme-dark', theme.dark);
			document.body.classList.toggle('theme-light', theme.light);
		}, previousTheme);
		await browser.pause(200);
		expect(collapsed.ok).toBe(true);
		if (collapsed.ok) {
			expect(collapsed.isCollapsed).toBe(true);
			expect(collapsed.widthBefore).toBeGreaterThan(0);
			expect(collapsed.widthAfter).toBe(0);
			expect(collapsed.sourceDisplay).toBe('none');
			expect(collapsed.gridTemplateColumns.split(' ').length).toBe(2);
			expect(collapsed.gridTemplateColumns).not.toContain('56px');
			expect(collapsed.visibleRestoreCount).toBe(1);
			expect(collapsed.restoreText).toBe('Show source');
			expect(collapsed.restoreControls).toBe(collapsed.controls);
			expect(collapsed.restoreExpanded).toBe('false');
			expect(collapsed.restoreFocused).toBe(true);
			expect(collapsed.connectionsOutcome).toBe('Parents list their direct children.');
		}

		// Restore Source and verify focus returns to the newly rendered collapse
		// control, not the CSS-hidden compact disclosure action.
		const restored = await browser.executeObsidian(async () => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const restores = Array.from(document.querySelectorAll<HTMLElement>('[data-source-control="restore"]'));
			const restore = restores.find((el) => getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0);
			(restore as HTMLButtonElement | undefined)?.click();
			await sleep(350);
			const collapse = document.querySelector('[data-source-control="collapse"]') as HTMLButtonElement | null;
			const source = document.querySelector('.crosswalker-wb-source') as HTMLElement | null;
			return {
				focused: document.activeElement === collapse,
				expanded: collapse?.getAttribute('aria-expanded') ?? '',
				controls: collapse?.getAttribute('aria-controls') ?? '',
				sourceId: source?.id ?? '',
				sourceVisible: source ? getComputedStyle(source).display !== 'none' : false,
			};
		});
		expect(restored.focused).toBe(true);
		expect(restored.expanded).toBe('true');
		expect(restored.controls).toBe(restored.sourceId);
		expect(restored.sourceVisible).toBe(true);

		// -- Stage F: Next → the review screen, in-view. Set an explicit,
		//    recognizable destination so the post-generate "Import again" affordance
		//    has a folder name it can match back to the recipe.
		const review = await browser.executeObsidian(async () => {
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
			const root = document.querySelector('.crosswalker-workspace-flow');
			if (!root) return { ok: false as const, reason: 'NO_ROOT' };
			const next = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.includes('Next'));
			if (!next) return { ok: false as const, reason: 'NO_NEXT' };
			(next as HTMLButtonElement).click();
			const dest = await waitFor('.crosswalker-dest-block', 8000);
			if (!dest) return { ok: false as const, reason: 'NO_DEST' };
			const crumb = root.querySelector('.crosswalker-dest-crumb') as HTMLButtonElement | null;
			crumb?.click();
			await sleep(200);
			const input = root.querySelector('.crosswalker-dest-input') as HTMLInputElement | null;
			if (input) {
				input.value = 'Frameworks/NIST-CSF-2.0';
				input.dispatchEvent(new Event('blur'));
				await sleep(300);
			}
			return {
				ok: true as const,
				hasRecap: !!root.querySelector('.crosswalker-shape-map'),
				workbenchPresent: !!root.querySelector('.crosswalker-workbench'),
				destPath: root.querySelector('.crosswalker-dest-crumb')?.textContent ?? '',
			};
		});
		console.log('[view] review → ' + JSON.stringify(review));
		await browser.saveScreenshot(path.join(OUT, 'view-06-review.png'));
		expect(review.ok).toBe(true);
		if (review.ok) {
			expect(review.hasRecap).toBe(true);
			// Step 3 is a true review screen — no workbench re-render (spec §7j #1).
			expect(review.workbenchPresent).toBe(false);
			expect(review.destPath).toContain('NIST-CSF-2.0');
		}

		// -- Stage G: Generate. On success the flow calls host.close(), which for
		//    the view means "return to the home screen" — NOT literally closing
		//    the tab. The home screen's installed-frameworks list must show fresh
		//    counts and an "Import again" affordance for the just-imported folder.
		const genInfo = await browser.executeObsidian(async () => {
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
			const root = document.querySelector('.crosswalker-workspace-flow');
			if (!root) return { ok: false as const, reason: 'NO_ROOT' };
			const next = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.includes('Next'));
			if (next) { (next as HTMLButtonElement).click(); await sleep(500); }
			const gen = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Generate');
			if (!gen) return { ok: false as const, reason: 'NO_GENERATE' };
			(gen as HTMLButtonElement).click();
			// Wait for the flow to return to the home screen (host.close fired).
			const home = await waitFor('.crosswalker-settings-launchpad', 15000);
			// The installed-frameworks list renders asynchronously (spec §7m
			// home-screen polish: producerKind is read via metadataCache, falling
			// back to a direct frontmatter read when the cache hasn't resolved yet
			// for the just-created notes) — poll for the text instead of a blind
			// sleep so this isn't racy against that resolution.
			const t0 = Date.now();
			let installedText = document.querySelector('.crosswalker-workspace-ontology-list')?.textContent ?? '';
			while (!installedText.includes('NIST CSF 2.0') && Date.now() - t0 < 8000) {
				await sleep(200);
				installedText = document.querySelector('.crosswalker-workspace-ontology-list')?.textContent ?? '';
			}
			return {
				ok: !!home,
				backOnHome: !document.querySelector('.crosswalker-workspace-flow'),
				installedText,
				hasReimportBtn: !!document.querySelector('.crosswalker-workspace-ontology-reimport'),
			};
		});
		console.log('[view] generate → ' + JSON.stringify(genInfo));
		await browser.saveScreenshot(path.join(OUT, 'view-07-home-after-generate.png'));
		expect(genInfo.ok).toBe(true);
		if (genInfo.ok) {
			expect(genInfo.backOnHome).toBe(true);
			expect(genInfo.installedText).toContain('NIST CSF 2.0');
			expect(genInfo.installedText).toMatch(/note/);
			expect(genInfo.hasReimportBtn).toBe(true);
		}

		// -- Stage H: dark theme capture of the home screen (both-theme check).
		const prevTheme = await browser.executeObsidian(() => {
			const b = document.body;
			const wasDark = b.classList.contains('theme-dark');
			b.classList.remove('theme-light');
			b.classList.add('theme-dark');
			return wasDark ? 'dark' : 'light';
		});
		await browser.pause(300);
		await browser.saveScreenshot(path.join(OUT, 'view-08-dark.png'));
		await browser.executeObsidian((_a, wasDark: unknown) => {
			const b = document.body;
			if (wasDark === 'light') { b.classList.remove('theme-dark'); b.classList.add('theme-light'); }
		}, prevTheme);
		await browser.pause(200);

		// -- Stage I: "Import again" re-mounts the flow in-view (not a modal),
		//    pre-armed with the matched recipe (spec §7n item 3).
		const reimport = await browser.executeObsidian(async () => {
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
			const btn = document.querySelector('.crosswalker-workspace-ontology-reimport') as HTMLButtonElement | null;
			if (!btn) return { ok: false as const, reason: 'NO_BTN' };
			btn.click();
			const flow = await waitFor('.crosswalker-workspace-flow', 8000);
			return { ok: !!flow, noModal: !document.querySelector('.modal') };
		});
		console.log('[view] reimport → ' + JSON.stringify(reimport));
		await browser.saveScreenshot(path.join(OUT, 'view-09-import-again.png'));
		expect(reimport.ok).toBe(true);
		if (reimport.ok) expect(reimport.noModal).toBe(true);

		// -- Stage J: the "Import again" flow re-parses the same CPRT CSV → the
		//    recognized-source card, this time asserting the curated defaults it
		//    now leads with (spec §7m consumption round): the destination reads
		//    the registry's suggestedFolder ("Frameworks/NIST CSF 2.0"), not the
		//    old generic Frameworks/<file name> fallback. Temporarily clears the
		//    plugin-wide default output path — an explicit setting always wins
		//    over the curated suggestedFolder, so this test-vault's own default
		//    ("Frameworks") would otherwise mask the behavior under test.
		const savedDefaultOutputPath = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error — internal plugins API
			const plugin = app.plugins.plugins['crosswalker'];
			const prev = plugin.settings.defaultOutputPath;
			plugin.settings.defaultOutputPath = '';
			await plugin.saveSettings();
			return prev;
		});
		const recognizedDefaults = await browser.executeObsidian(async (_a, csv) => {
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
			const root = document.querySelector('.crosswalker-workspace-flow');
			if (!root) return { ok: false as const, reason: 'NO_ROOT' };
			const input = root.querySelector('input[type=file]') as HTMLInputElement | null;
			if (!input) return { ok: false as const, reason: 'NO_FILE_INPUT' };
			const dt = new DataTransfer();
			dt.items.add(new File([csv as string], 'nist-csf-2-cprt-reimport.csv'));
			input.files = dt.files;
			input.dispatchEvent(new Event('change'));
			await sleep(700);
			const next = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.includes('Next'));
			if (!next) return { ok: false as const, reason: 'NO_NEXT' };
			(next as HTMLButtonElement).click();
			const card = await waitFor('.crosswalker-recognized-card', 8000);
			if (!card) return { ok: false as const, reason: 'NO_CARD' };
			return {
				ok: true as const,
				summaryText: root.querySelector('.crosswalker-recognized-summary')?.textContent ?? '',
			};
		}, CPRT_CSV);
		console.log('[view] recognized-defaults → ' + JSON.stringify(recognizedDefaults));
		await browser.saveScreenshot(path.join(OUT, 'view-10-recognized-defaults.png'));
		expect(recognizedDefaults.ok).toBe(true);
		if (recognizedDefaults.ok) {
			// The curated suggestedFolder default (spec §7m), not the old generic
			// Frameworks/<file name> fallback `deriveDestinationDefault` would emit.
			expect(recognizedDefaults.summaryText).toContain('lands in Frameworks/NIST CSF 2.0');
		}
		// Restore the plugin-wide default before Stage K (Customize commits
		// this.outputPath from whatever the setting is at click time).
		await browser.executeObsidian(async ({ app }, prev) => {
			// @ts-expect-error — internal plugins API
			const plugin = app.plugins.plugins['crosswalker'];
			plugin.settings.defaultOutputPath = prev as string;
			await plugin.saveSettings();
		}, savedDefaultOutputPath);

		// -- Stage K: "Customize" → the workbench, in-view, screenshotting the
		//    outcome-first Connections cards. Exercises the child-list checkbox
		//    write round-trip through its stable enrichment selector.
		const connections = await browser.executeObsidian(async () => {
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
			const root = document.querySelector('.crosswalker-workspace-flow');
			if (!root) return { ok: false as const, reason: 'NO_ROOT' };
			const customize = Array.from(root.querySelectorAll('.crosswalker-recognized-actions button')).find(
				(b) => b.textContent?.trim() === 'Customize',
			) as HTMLButtonElement | undefined;
			if (!customize) return { ok: false as const, reason: 'NO_CUSTOMIZE' };
			customize.click();
			const conn = await waitFor('.crosswalker-wb-connections', 8000);
			if (!conn) return { ok: false as const, reason: 'NO_CONNECTIONS' };

			const childrenCard = conn.querySelector('[data-connection-option="children-lists"]');
			const facetCard = conn.querySelector('[data-connection-option="shared-value-hubs"]');
			const foldersCard = conn.querySelector('[data-connection-option="folder-indexes"]');
			const childrenCb = childrenCard?.querySelector('input[data-enrichment-key="children_lists"]') as HTMLInputElement | null;
			const facetSel = facetCard?.querySelector('select[data-enrichment-key="facet_notes"]') as HTMLSelectElement | null;
			const before = { childrenChecked: childrenCb?.checked ?? null, facetValue: facetSel?.value ?? null };

			// Exercise the write round-trip: toggle children-lists on and re-read
			// after the workbench's debounced re-render.
			childrenCb?.click();
			await sleep(400);
			const rootAfter = document.querySelector('.crosswalker-workspace-flow');
			const childrenCbAfter = rootAfter?.querySelector(
				'[data-connection-option="children-lists"] input[data-enrichment-key="children_lists"]',
			) as HTMLInputElement | null;

			// Scroll the Connections card into view so the screenshot below
			// actually shows it (the mapping cards above push it past the fold).
			rootAfter?.querySelector('.crosswalker-wb-connections')?.scrollIntoView({ block: 'center' });
			await sleep(200);

			return {
				ok: true as const,
				hasChildrenToggle: !!childrenCb,
				hasFacetSelect: !!facetSel,
				hasFolderIndexes: !!foldersCard,
				childOutcome: childrenCard?.querySelector('.crosswalker-wb-connection-outcome')?.textContent?.trim() ?? '',
				folderOutcome: foldersCard?.querySelector('.crosswalker-wb-connection-outcome')?.textContent?.trim() ?? '',
				detailsClosed: Array.from(conn.querySelectorAll<HTMLDetailsElement>('.crosswalker-wb-connection-details'))
					.every((details) => !details.open),
				hasPlacementChooser: !!rootAfter?.querySelector('.crosswalker-wb-placement'),
				before,
				childrenCheckedAfterToggle: childrenCbAfter?.checked ?? null,
			};
		});
		console.log('[view] connections → ' + JSON.stringify(connections));
		await browser.saveScreenshot(path.join(OUT, 'view-11-connections.png'));
		expect(connections.ok).toBe(true);
		if (connections.ok) {
			expect(connections.hasChildrenToggle).toBe(true);
			expect(connections.hasFacetSelect).toBe(true);
			expect(connections.hasFolderIndexes).toBe(true);
			expect(connections.childOutcome).toBe('Parents list their direct children.');
			expect(connections.folderOutcome).toBe('Each generated folder gets a Contents list.');
			expect(connections.detailsClosed).toBe(true);
			// The toggle click flipped the model and the re-render reflects it.
			expect(connections.childrenCheckedAfterToggle).toBe(!connections.before.childrenChecked);
		}
	});
});
