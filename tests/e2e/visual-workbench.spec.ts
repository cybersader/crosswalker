/**
 * visual-workbench.spec.ts — the Shape workbench (beta) in wizard Step 2.
 *
 * Enables the `enableShapeWorkbench` setting via the plugin handle, drives the
 * import wizard through the REAL UI with an ATT&CK-shaped CSV (packed
 * technique ids + a repeated tactic facet + long descriptions), advances to
 * Step 2, and asserts + screenshots the three workbench zones:
 *   - source rail  (crosswalker-wb-source)   — columns + detection badges
 *   - mapping canvas (crosswalker-wb-canvas)  — preset dropdown + mapping cards + matrix
 *   - vault preview rail (crosswalker-wb-preview) — live folder tree + note
 *
 *   DISPLAY=:0 bun run e2e -- --spec tests/e2e/visual-workbench.spec.ts
 *
 * Screenshots land in test-screenshots/ (wb-01 … wb-04).
 *
 * One test drives the whole flow (the wizard modal is shared state; splitting
 * across `it`s would leak an open modal between tests). Rich diagnostics are
 * returned from the single executeObsidian block and logged for triage.
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { closeImportWizard, requireImportWizard, clearAllDrafts } from './helpers/wizard-modal';
import { waitForVaultIndexed } from './helpers/vault-readiness';

const OUT = path.resolve('test-screenshots');

/**
 * The live wizard modal. `src/import/import-wizard.ts` stamps this class on the
 * modal element in `onOpen()`, so it identifies the Crosswalker wizard
 * specifically — unlike the bare `.modal` this spec used to reach for, which is
 * the first modal in the document and after two open/close cycles can be a
 * stale leftover (triage 2026-08-24 §4 B6: the third declaration reported
 * `NO_NEXT_BUTTON` before touching any workbench behavior).
 *
 * Safe as a bare `querySelector` because `requireImportWizard()` proves the
 * previous wizard is gone before opening the next one.
 */
const WIZARD = '.crosswalker-wizard-modal';
// Callbacks that already take a params object receive it as `a.wizard`; ones
// that take no params inline the same literal (a serialized renderer callback
// cannot close over an outer const).

/** Capture the current focused state in one theme, then restore the prior theme. */
async function saveThemeScreenshot(fileName: string, theme: 'dark' | 'light' = 'dark'): Promise<void> {
	const previous = await browser.executeObsidian(() => ({
		dark: document.body.classList.contains('theme-dark'),
		light: document.body.classList.contains('theme-light'),
	}));
	await browser.executeObsidian((_obs, value: unknown) => {
		document.body.classList.remove('theme-light', 'theme-dark');
		document.body.classList.add(`theme-${value as string}`);
	}, theme);
	await browser.pause(200);
	await browser.saveScreenshot(path.join(OUT, fileName));
	await browser.executeObsidian((_a, value: unknown) => {
		const state = value as { dark: boolean; light: boolean };
		document.body.classList.toggle('theme-dark', state.dark);
		document.body.classList.toggle('theme-light', state.light);
	}, previous);
	await browser.pause(200);
}

/** ~12-row ATT&CK-shaped CSV. 6/12 ids are sub-techniques (dotted) → ~50%
 *  coverage → a RAGGED packed hierarchy (variadic tail). 4 repeated tactics
 *  → facet candidate. Long descriptions → body candidate. */
const ATTACK_CSV = [
	'technique_id,name,tactic,description',
	'T1055,Process Injection,Defense Evasion,"Adversaries may inject code into processes in order to evade process-based defenses as well as possibly elevate privileges. Process injection is a method of executing arbitrary code in the address space of a separate live process."',
	'T1055.001,Dynamic-link Library Injection,Defense Evasion,"Adversaries may inject dynamic-link libraries (DLLs) into processes in order to evade process-based defenses as well as possibly elevate privileges. DLL injection is a method of executing arbitrary code in the address space of a separate live process."',
	'T1055.011,Extra Window Memory Injection,Defense Evasion,"Adversaries may inject malicious code into process via Extra Window Memory (EWM) in order to evade process-based defenses as well as possibly elevate privileges. EWM injection is a method of executing arbitrary code in the address space of a separate live process."',
	'T1059,Command and Scripting Interpreter,Execution,"Adversaries may abuse command and script interpreters to execute commands, scripts, or binaries. These interfaces and languages provide ways of interacting with computer systems and are a common feature across many different platforms."',
	'T1059.001,PowerShell,Execution,"Adversaries may abuse PowerShell commands and scripts for execution. PowerShell is a powerful interactive command-line interface and scripting environment included in the Windows operating system."',
	'T1059.003,Windows Command Shell,Execution,"Adversaries may abuse the Windows command shell for execution. The Windows command shell (cmd) is the primary command prompt on Windows systems and can be used to control almost any aspect of a system."',
	'T1071,Application Layer Protocol,Command and Control,"Adversaries may communicate using OSI application layer protocols to avoid detection and network filtering by blending in with existing traffic. Commands to the remote system, and often the results of those commands, will be embedded within the protocol traffic."',
	'T1071.001,Web Protocols,Command and Control,"Adversaries may communicate using application layer protocols associated with web traffic to avoid detection and network filtering by blending in with existing traffic. Commands to the remote system, and often the results of those commands, will be embedded within the protocol traffic."',
	'T1547,Boot or Logon Autostart Execution,Persistence,"Adversaries may configure system settings to automatically execute a program during system boot or logon to maintain persistence or gain higher-level privileges on compromised systems."',
	'T1547.001,Registry Run Keys / Startup Folder,Persistence,"Adversaries may achieve persistence by adding a program to a startup folder or referencing it with a Registry run key. Adding an entry to the run keys in the Registry will cause the program referenced to be executed when a user logs in."',
	'T1003,OS Credential Dumping,Defense Evasion,"Adversaries may attempt to dump credentials to obtain account login and credential material, normally in the form of a hash or a clear text password, from the operating system and software."',
	'T1486,Data Encrypted for Impact,Execution,"Adversaries may encrypt data on target systems or on large numbers of systems in a network to interrupt availability to system and network resources. They can attempt to render stored data inaccessible by encrypting files or data on local and remote drives."',
].map((row, index) => {
	if (index === 0) return row + ',domain,unused';
	const domain = row.includes('Defense Evasion') || row.includes('Persistence')
		? 'Protect'
		: 'Operate';
	return `${row},${domain},`;
}).join('\n');

describe('Visual — Shape workbench (beta) in wizard Step 2', function () {
	this.timeout(180_000);

	before(async () => {
		mkdirSync(OUT, { recursive: true });
		// Deterministic starting state. The old `browser.pause(6000)` was sized
		// for the 11k-note development vault and still asserted nothing; wait on
		// the real condition (every note has a metadata-cache entry) and clear
		// the UI state an earlier spec may have left behind.
		await closeImportWizard();
		await clearAllDrafts();
		const indexed = await waitForVaultIndexed();
		if (!indexed.ready) {
			console.warn(`[workbench] vault index incomplete: ${indexed.pending}/${indexed.total} pending after ${indexed.waitedMs}ms`);
		}
		// Enable the beta workbench on the live plugin. Also disable the config
		// suggestion + draft features so the step-1 → step-2 advance is deterministic:
		// a vault with saved configs would otherwise show a suggestion banner after
		// parse and hold the wizard on step 1 (unrelated to what this spec verifies).
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error — internal plugins API
			const plugin = app.plugins.plugins['crosswalker'];
			plugin.settings.enableShapeWorkbench = true;
			plugin.settings.enableConfigSuggestions = false;
			plugin.settings.enableDraftSessions = false;
			await plugin.saveSettings();
		});
	});

	afterEach(async () => {
		// Never leave a wizard open for the next declaration — the compounding
		// stale-modal state is what made declarations 2 and 3 unreadable.
		await closeImportWizard();
	});

	after(async () => {
		// Close modal + restore the changed settings to their defaults.
		await closeImportWizard();
		await browser.executeObsidian(async ({ app }) => {
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

	it('recognizes a bundled-recipe source and leads with the trust card (spec §7m)', async () => {
		// A NIST CSF 2.0 CPRT-shaped CSV — its columns match the bundled
		// nist-csf-2-cprt-linked recipe, so the wizard should hold on Step 1
		// and lead with the recognized-source card.
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

		// Opens a FRESH wizard: closes any predecessor, proves it left the DOM,
		// then waits for a visible `.crosswalker-wizard-modal` with a file input.
		await requireImportWizard();
		const info = await browser.executeObsidian(async (_obs, a) => {
			const csv = a.csv;
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
			const modal = document.querySelector(a.wizard);
			if (!modal) return { ok: false as const, reason: 'NO_MODAL' };
			const input = modal.querySelector('input[type=file]') as HTMLInputElement | null;
			if (!input) return { ok: false as const, reason: 'NO_FILE_INPUT' };
			const dt = new DataTransfer();
			dt.items.add(new File([csv], 'nist-csf-2-cprt.csv'));
			input.files = dt.files;
			input.dispatchEvent(new Event('change'));
			await sleep(700);

			// Click Next → parse → the wizard should HOLD on Step 1 with the card.
			const next = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent?.includes('Next'));
			if (!next) return { ok: false as const, reason: 'NO_NEXT' };
			(next as HTMLButtonElement).click();

			const card = await waitFor('.crosswalker-recognized-card', 8000);
			const primary = Array.from(modal.querySelectorAll('.crosswalker-recognized-actions button')).find(
				(b) => b.textContent?.includes('Import with this configuration'),
			);
			return {
				ok: !!card,
				reason: card ? 'OK' : 'NO_CARD',
				title: modal.querySelector('.crosswalker-recognized-title')?.textContent ?? '',
				badge: modal.querySelector('.crosswalker-recognized-card .crosswalker-prov-badge')?.textContent ?? '',
				hasPrimary: !!primary,
				hasCustomize: Array.from(modal.querySelectorAll('.crosswalker-recognized-actions button')).some(
					(b) => b.textContent?.trim() === 'Customize',
				),
				hasScratch: Array.from(modal.querySelectorAll('.crosswalker-recognized-actions button')).some(
					(b) => b.textContent?.includes('Start from scratch'),
				),
				summary: modal.querySelector('.crosswalker-recognized-summary')?.textContent ?? '',
			};
		}, { csv: CPRT_CSV, wizard: WIZARD });
		console.log('[recognized] card → ' + JSON.stringify(info));
		await browser.executeObsidian(() => {
			document.querySelector('.crosswalker-recognized-card')?.scrollIntoView({ block: 'start' });
		});
		await saveThemeScreenshot('wb-08-recognized.png', 'light');
		await saveThemeScreenshot('wb-08-recognized-dark.png');
		expect(info.ok).toBe(true);
		if (info.ok) {
			expect(info.title).toContain('NIST CSF');
			expect(info.badge).toContain('Built-in');
			expect(info.hasPrimary).toBe(true);
			expect(info.hasCustomize).toBe(true);
			expect(info.hasScratch).toBe(true);
		}

		// "Import with this configuration" jumps STRAIGHT to the review screen (spec §7m),
		// loaded via fromRecipe (round-trip law). The review provenance must read as
		// VETTED "Built-in" — NOT the workbench's preset-drift "Custom".
		const review = await browser.executeObsidian(async () => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const modal = document.querySelector('.crosswalker-wizard-modal');
			if (!modal) return { ok: false as const };
			const primary = Array.from(modal.querySelectorAll('.crosswalker-recognized-actions button')).find(
				(b) => b.textContent?.includes('Import with this configuration'),
			) as HTMLButtonElement | undefined;
			if (!primary) return { ok: false as const, reason: 'NO_PRIMARY' };
			primary.click();
			const dest = await (async () => {
				const t0 = Date.now();
				while (Date.now() - t0 < 8000) {
					const el = document.querySelector('.crosswalker-dest-block');
					if (el) return el;
					await sleep(100);
				}
				return null;
			})();
			const prov = modal.querySelector('.crosswalker-provenance');
			return {
				ok: !!dest,
				h3: modal.querySelector('h3')?.textContent ?? '',
				provText: prov?.textContent ?? '',
				badge: prov?.querySelector('.crosswalker-prov-badge')?.textContent ?? '',
				recipeId: (prov as HTMLElement | null)?.dataset.recipeId ?? '',
				recipeBasedOn: (prov as HTMLElement | null)?.dataset.recipeBasedOn ?? '',
				hasRecap: !!modal.querySelector('.crosswalker-shape-map'),
				// The review screen must NOT re-render the live workbench (spec §7j #1).
				workbenchPresent: !!modal.querySelector('.crosswalker-workbench'),
			};
		});
		console.log('[recognized] review → ' + JSON.stringify(review));
		await browser.saveScreenshot(path.join(OUT, 'wb-09-recognized-review.png'));
		expect(review.ok).toBe(true);
		if (review.ok) {
			expect(review.h3).toContain('Review');
			expect(review.hasRecap).toBe(true);
			expect(review.badge).toContain('Built-in');
			expect(review.provText.toLowerCase()).toContain('built-in configuration');
			expect(review.recipeId).toBe('nist-csf-2-cprt-linked');
			expect(review.recipeBasedOn).toBe('');
			expect(review.workbenchPresent).toBe(false);
		}

		// Return to the workbench, make one owned edit, then prove the effective
		// portable identity becomes a deterministic custom recipe with ancestry.
		const customized = await browser.executeObsidian(async () => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const modal = document.querySelector('.crosswalker-wizard-modal');
			if (!modal) return { ok: false as const, reason: 'NO_MODAL' };
			const back = Array.from(modal.querySelectorAll('button')).find(
				(button) => button.textContent?.trim() === 'Back',
			) as HTMLButtonElement | undefined;
			if (!back) return { ok: false as const, reason: 'NO_BACK' };
			back.click();
			await sleep(600);
			const children = modal.querySelector(
				'input[data-enrichment-key="children_lists"]',
			) as HTMLInputElement | null;
			if (!children) return { ok: false as const, reason: 'NO_CHILDREN_CONTROL' };
			children.checked = !children.checked;
			children.dispatchEvent(new Event('change', { bubbles: true }));
			await sleep(500);
			const next = Array.from(modal.querySelectorAll('button')).find(
				(button) => button.textContent?.includes('Next'),
			) as HTMLButtonElement | undefined;
			if (!next) return { ok: false as const, reason: 'NO_NEXT' };
			next.click();
			await sleep(700);
			const prov = modal.querySelector('.crosswalker-provenance') as HTMLElement | null;
			return {
				ok: !!prov,
				recipeId: prov?.dataset.recipeId ?? '',
				recipeBasedOn: prov?.dataset.recipeBasedOn ?? '',
				badge: prov?.querySelector('.crosswalker-prov-badge')?.textContent ?? '',
			};
		});
		console.log('[recognized] customized → ' + JSON.stringify(customized));
		await browser.saveScreenshot(path.join(OUT, 'wb-10-recognized-custom.png'));
		expect(customized.ok).toBe(true);
		if (customized.ok) {
			expect(customized.recipeId).toBe('nist-csf-2-cprt-linked-custom');
			expect(customized.recipeBasedOn).toBe('nist-csf-2-cprt-linked');
			expect(customized.badge).toContain('Custom');
		}

		// Close the wizard and PROVE it left the DOM before the next declaration
		// opens one — a click plus a 400ms sleep guaranteed neither.
		const closed = await closeImportWizard();
		expect(closed.closed).toBe(true);
	});

	it('preserves recognized crosswalk-edge kind through review and generation', async () => {
		const csv = [
			'subject_id,strm_predicate,object_id,subject_group,object_group,source_framework,target_framework,match_confidence,mapping_justification,mapping_provider,sssom_predicate',
			'e2e:RECIPE-FIDELITY-001,is_equivalent_to,e2e:TARGET-001,Portable source,Portable target,E2E source,E2E target,0.95,Manual review,Portable E2E,skos:exactMatch',
		].join('\n');
		await requireImportWizard();
		const result = await browser.executeObsidian(async ({ app }, a) => {
			const source = a.source;
			const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
			const waitFor = async (selector: string, timeout: number) => {
				const started = Date.now();
				while (Date.now() - started < timeout) {
					const found = document.querySelector(selector);
					if (found) return found;
					await sleep(100);
				}
				return null;
			};
			const modal = document.querySelector(a.wizard);
			const input = modal?.querySelector('input[type=file]') as HTMLInputElement | null;
			if (!modal || !input) return { ok: false as const, reason: 'NO_WIZARD' };
			const transfer = new DataTransfer();
			transfer.items.add(new File([source], 'portable-crosswalk.csv'));
			input.files = transfer.files;
			input.dispatchEvent(new Event('change'));
			await sleep(700);
			const next = Array.from(modal.querySelectorAll('button')).find(
				(button) => button.textContent?.includes('Next'),
			) as HTMLButtonElement | undefined;
			if (!next) return { ok: false as const, reason: 'NO_NEXT' };
			next.click();
			await waitFor('.crosswalker-recognized-card', 8000);
			const recognizedTitle = modal.querySelector('.crosswalker-recognized-title')?.textContent?.trim() ?? '';
			const primary = Array.from(modal.querySelectorAll('.crosswalker-recognized-actions button')).find(
				(button) => button.textContent?.includes('Import with this configuration'),
			) as HTMLButtonElement | undefined;
			if (!primary) return { ok: false as const, reason: 'NOT_RECOGNIZED' };
			primary.click();
			await waitFor('.crosswalker-dest-block', 8000);
			const reviewProvenance = modal.querySelector('.crosswalker-provenance') as HTMLElement | null;
			const reviewRecipeId = reviewProvenance?.dataset.recipeId ?? '';
			const destination = modal.querySelector('.crosswalker-dest-crumb')?.textContent?.trim() ?? '';
			for (let step = 0; step < 2; step += 1) {
				const advance = Array.from(modal.querySelectorAll('button')).find(
					(button) => button.textContent?.includes('Next'),
				) as HTMLButtonElement | undefined;
				if (advance) {
					advance.click();
					await sleep(600);
				}
			}
			const generate = Array.from(modal.querySelectorAll('button')).find(
				(button) => button.textContent?.trim() === 'Generate',
			) as HTMLButtonElement | undefined;
			if (!generate) return { ok: false as const, reason: 'NO_GENERATE' };
			const beforePaths = new Set(app.vault.getMarkdownFiles().map((file: { path: string }) => file.path));
			generate.click();
			const started = Date.now();
			while (Date.now() - started < 20000 && document.querySelector('.crosswalker-wizard-modal')) {
				await sleep(200);
			}
			const modalClosed = !document.querySelector('.crosswalker-wizard-modal');
			const notices = Array.from(document.querySelectorAll('.notice')).map(
				(notice) => notice.textContent?.trim() ?? '',
			);
			const allFiles = app.vault.getMarkdownFiles();
			const createdPaths = allFiles
				.filter((file: { path: string }) => !beforePaths.has(file.path))
				.map((file: { path: string }) => file.path);
			const candidates = allFiles
				.filter((file: { path: string }) => createdPaths.includes(file.path))
				.sort((left: { stat: { mtime: number } }, right: { stat: { mtime: number } }) => right.stat.mtime - left.stat.mtime);
			for (const file of candidates) {
				const content = await app.vault.read(file);
				if (!content.includes('Portable E2E')) continue;
				if (!/recipe:\s*\n\s+id:\s*olir-crosswalk-edge/.test(content)) continue;
				return {
					ok: true as const,
					modalClosed,
					recognizedTitle,
					reviewRecipeId,
					destination,
					path: file.path,
					kind: /\nkind:\s*([^\n]+)/.exec(content)?.[1]?.trim() ?? '',
					recipeId: 'olir-crosswalk-edge',
				};
			}
			return {
				ok: false as const,
				reason: 'NO_EDGE_FILE',
				modalClosed,
				recognizedTitle,
				reviewRecipeId,
				destination,
				notices,
				createdPaths,
				candidates: candidates.slice(0, 20).map((file: { path: string }) => file.path),
			};
		}, { source: csv, wizard: WIZARD });
		console.log('[recipe-fidelity] edge → ' + JSON.stringify(result));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.modalClosed).toBe(true);
			expect(result.kind).toBe('crosswalk-edge');
			expect(result.recipeId).toBe('olir-crosswalk-edge');
		}
	});

	it('drives the CSV to the workbench Step 2 and screenshots the three zones', async () => {
		// -- Stage A: open wizard → inject CSV → advance to the workbench.
		await requireImportWizard();
		const openInfo = await browser.executeObsidian(async ({ app }, a) => {
			const csv = a.csv;
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
			const cmdExists = !!app.commands.commands['crosswalker:import-structured-data'];

			// requireImportWizard() already opened it and waited for the file
			// input (Step 1 content renders after loadAvailableDrafts() resolves).
			const modal = document.querySelector(a.wizard);
			if (!modal) return { stage: 'open', ok: false, cmdExists, reason: 'NO_MODAL' };
			const input = modal.querySelector('input[type=file]') as HTMLInputElement | null;
			if (!input) return { stage: 'open', ok: false, cmdExists, reason: 'NO_FILE_INPUT' };
			const dt = new DataTransfer();
			dt.items.add(new File([csv], 'attack-mini.csv'));
			input.files = dt.files;
			input.dispatchEvent(new Event('change'));
			await sleep(700);

			const next = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent?.includes('Next'));
			if (!next) return { stage: 'open', ok: false, cmdExists, reason: 'NO_NEXT_BUTTON' };
			(next as HTMLButtonElement).click();

			const wb = await waitFor('.crosswalker-workbench', 8000);
			return {
				stage: 'open',
				ok: !!wb,
				cmdExists,
				reason: wb ? 'OK' : 'NO_WORKBENCH',
				h3: modal.querySelector('h3')?.textContent ?? '',
			};
		}, { csv: ATTACK_CSV, wizard: WIZARD });
		console.log('[workbench] open → ' + JSON.stringify(openInfo));
		await browser.saveScreenshot(path.join(OUT, 'wb-01-step2-overview.png'));
		expect(openInfo.ok).toBe(true);

		// -- Stage B: overview assertions (three zones + technique_id badge).
		const overview = await browser.executeObsidian(() => {
			const modal = document.querySelector('.crosswalker-wizard-modal');
			if (!modal) return { ok: false as const };
			const source = modal.querySelector('.crosswalker-wb-source');
			const details = source?.querySelector(
				'.crosswalker-wb-allcols',
			) as HTMLDetailsElement | null;
			if (details) details.open = true;
			const detectedNames = Array.from(
				source?.querySelectorAll(
					'.crosswalker-wb-colrow > .crosswalker-wb-colname',
				) ?? [],
			).map((el) => el.textContent?.trim() ?? '');
			const destinationNames = Array.from(
				source?.querySelectorAll(
					'.crosswalker-wb-allcol-row > .crosswalker-wb-colname',
				) ?? [],
			).map((el) => el.textContent?.trim() ?? '');
			return {
				ok: true as const,
				hasSource: !!source,
				hasCanvas: !!modal.querySelector('.crosswalker-wb-canvas'),
				hasPreview: !!modal.querySelector('.crosswalker-wb-preview'),
				heading: source?.querySelector('.crosswalker-wb-detected-heading')?.textContent?.trim() ?? '',
				detectedNames,
				destinationNames,
				destinationSummary: details?.querySelector('summary')?.textContent?.trim() ?? '',
				destinationExplanation: details?.querySelector('.crosswalker-wb-allcols-explainer')?.textContent?.trim() ?? '',
				techIdHasBadge: !!source?.querySelector(
					'.crosswalker-wb-badge[data-column="technique_id"]',
				),
				presetSelects: modal.querySelectorAll('.crosswalker-wb-presetbar select').length,
				mapCards: modal.querySelectorAll('.crosswalker-wb-mapcard').length,
				totalBadges: modal.querySelectorAll('.crosswalker-wb-badge').length,
			};
		});
		console.log('[workbench] overview → ' + JSON.stringify(overview));
		expect(overview.ok).toBe(true);
		if (overview.ok) {
			expect(overview.hasSource).toBe(true);
			expect(overview.hasCanvas).toBe(true);
			expect(overview.hasPreview).toBe(true);
			expect(overview.heading).toBe('Detected structure');
			expect(overview.detectedNames).toContain('technique_id');
			expect(overview.detectedNames).not.toContain('unused');
			expect(overview.destinationNames).toContain('unused');
			expect(overview.destinationSummary).toBe('Column destinations (6)');
			expect(overview.destinationExplanation).toContain('including columns without detected structure');
			expect(overview.techIdHasBadge).toBe(true);
			expect(overview.presetSelects).toBeGreaterThanOrEqual(1);
			expect(overview.mapCards).toBeGreaterThanOrEqual(1);
		}

		// -- Stage B2: force dark theme + screenshot the same overview, then
		//    restore. Confirms the design reads deliberately in BOTH color schemes
		//    (all workbench colors resolve to Obsidian theme vars).
		const prevTheme = await browser.executeObsidian(() => {
			const b = document.body;
			const wasDark = b.classList.contains('theme-dark');
			b.classList.remove('theme-light');
			b.classList.add('theme-dark');
			return wasDark ? 'dark' : 'light';
		});
		await browser.pause(300);
		await browser.saveScreenshot(path.join(OUT, 'wb-01-dark.png'));
		await browser.executeObsidian((_a, wasDark: unknown) => {
			const b = document.body;
			if (wasDark === 'light') { b.classList.remove('theme-dark'); b.classList.add('theme-light'); }
		}, prevTheme);
		await browser.pause(200);

		// -- Stage B3: modal Source collapse/restore keeps disclosure semantics and
		//    restores focus across the workbench's full DOM rebuild.
		const sourceDisclosure = await browser.executeObsidian(async () => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const modal = document.querySelector('.crosswalker-wizard-modal');
			const content = modal?.querySelector('.crosswalker-wizard-content') as HTMLElement | null;
			const collapse = modal?.querySelector('[data-source-control="collapse"]') as HTMLButtonElement | null;
			const source = modal?.querySelector('.crosswalker-wb-source') as HTMLElement | null;
			if (!content || !collapse || !source) return { ok: false as const };
			const sourceId = source.id;
			const collapseControls = collapse.getAttribute('aria-controls') ?? '';
			collapse.click();
			await sleep(350);
			const collapsedSource = modal.querySelector('.crosswalker-wb-source') as HTMLElement | null;
			const restores = Array.from(modal.querySelectorAll<HTMLElement>('[data-source-control="restore"]'))
				.filter((el) => getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0);
			const restore = restores[0] as HTMLButtonElement | undefined;
			const collapsedInfo = {
				stacked: content.getBoundingClientRect().width <= 760,
				sourceDisplay: collapsedSource ? getComputedStyle(collapsedSource).display : '',
				summary: collapsedSource?.querySelector('.crosswalker-wb-source-disclosure-summary')?.textContent?.trim() ?? '',
				visibleRestoreCount: restores.length,
				restoreText: restore?.textContent?.trim() ?? '',
				restoreControls: restore?.getAttribute('aria-controls') ?? '',
				restoreExpanded: restore?.getAttribute('aria-expanded') ?? '',
				restoreFocused: document.activeElement === restore,
			};
			restore?.click();
			await sleep(350);
			const restoredCollapse = modal.querySelector('[data-source-control="collapse"]') as HTMLButtonElement | null;
			return {
				ok: true as const,
				sourceId,
				collapseControls,
				collapsedInfo,
				restoredFocused: document.activeElement === restoredCollapse,
				restoredExpanded: restoredCollapse?.getAttribute('aria-expanded') ?? '',
			};
		});
		expect(sourceDisclosure.ok).toBe(true);
		if (sourceDisclosure.ok) {
			expect(sourceDisclosure.sourceId).toMatch(/^crosswalker-source-\d+$/);
			expect(sourceDisclosure.collapseControls).toBe(sourceDisclosure.sourceId);
			expect(sourceDisclosure.collapsedInfo.visibleRestoreCount).toBe(1);
			expect(sourceDisclosure.collapsedInfo.restoreText).toBe('Show source');
			expect(sourceDisclosure.collapsedInfo.restoreControls).toBe(sourceDisclosure.sourceId);
			expect(sourceDisclosure.collapsedInfo.restoreExpanded).toBe('false');
			expect(sourceDisclosure.collapsedInfo.restoreFocused).toBe(true);
			if (sourceDisclosure.collapsedInfo.stacked) {
				expect(sourceDisclosure.collapsedInfo.sourceDisplay).not.toBe('none');
				expect(sourceDisclosure.collapsedInfo.summary).toMatch(/12 rows · 6 columns/);
			} else {
				expect(sourceDisclosure.collapsedInfo.sourceDisplay).toBe('none');
			}
			expect(sourceDisclosure.restoredFocused).toBe(true);
			expect(sourceDisclosure.restoredExpanded).toBe('true');
		}

		// -- Stage B4: Connections uses outcome-first native controls with stable
		//    enrichment selectors and collapsed explanatory details.
		const connections = await browser.executeObsidian(async () => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const modal = document.querySelector('.crosswalker-wizard-modal');
			if (!modal) return { ok: false as const };
			const child = modal.querySelector('[data-connection-option="children-lists"]');
			const facet = modal.querySelector('[data-connection-option="shared-value-hubs"]');
			const folders = modal.querySelector('[data-connection-option="folder-indexes"]');
			const facetSelect = facet?.querySelector('select[data-enrichment-key="facet_notes"]') as HTMLSelectElement | null;
			if (!child || !facet || !folders || !facetSelect) return { ok: false as const };
			const selectOptions = Array.from(facetSelect.options).map((option) => ({
				value: option.value,
				text: option.text,
				disabled: option.disabled,
			}));
			const initialDetails = Array.from(modal.querySelectorAll<HTMLDetailsElement>(
				'.crosswalker-wb-connection-details',
			));
			facetSelect.value = 'tags-only';
			facetSelect.dispatchEvent(new Event('change', { bubbles: true }));
			await sleep(350);
			const rerenderedFacet = modal.querySelector('[data-connection-option="shared-value-hubs"]');
			const placementCards = Array.from(modal.querySelectorAll<HTMLElement>('[data-parent-note-value]'))
				.filter((el) => el.classList.contains('crosswalker-wb-placement-col'));
			return {
				ok: true as const,
				keys: [child, facet, folders].map((el) => el.getAttribute('data-enrichment-key')),
				childOutcome: child.querySelector('.crosswalker-wb-connection-outcome')?.textContent?.trim() ?? '',
				folderOutcome: folders.querySelector('.crosswalker-wb-connection-outcome')?.textContent?.trim() ?? '',
				selectOptions,
				facetContext: facet.querySelector('.crosswalker-wb-connection-context')?.textContent?.trim() ?? '',
				detailsClosed: initialDetails.every((details) => !details.open),
				detailsSummaries: initialDetails.map((details) => details.querySelector('summary')?.textContent?.trim() ?? ''),
				selectedFacetValue: (rerenderedFacet?.querySelector('select') as HTMLSelectElement | null)?.value ?? '',
				facetOn: rerenderedFacet?.classList.contains('is-on') ?? false,
				placementValues: placementCards.map((el) => el.dataset.parentNoteValue),
				placementLabels: placementCards.map((el) => el.querySelector('.crosswalker-wb-placement-radio')?.textContent?.trim() ?? ''),
				selectedPlacements: placementCards.filter((el) => el.classList.contains('is-selected')).length,
				selectedState: modal.querySelector('.crosswalker-wb-placement-state.is-selected')?.textContent?.trim() ?? '',
				defaultState: Array.from(modal.querySelectorAll('.crosswalker-wb-placement-state'))
					.some((el) => el.textContent?.trim() === 'Default'),
				placementPrompt: modal.querySelector('.crosswalker-wb-connection-row-label')?.textContent?.trim() ?? '',
			};
		});
		console.log('[workbench] connections → ' + JSON.stringify(connections));
		await browser.executeObsidian(() => {
			document.querySelector('.crosswalker-wb-connections')?.scrollIntoView({ block: 'start' });
		});
		await browser.pause(250);
		await browser.saveScreenshot(path.join(OUT, 'wb-02c-connections.png'));
		await saveThemeScreenshot('wb-02c-connections-dark.png');
		expect(connections.ok).toBe(true);
		if (connections.ok) {
			expect(connections.keys).toEqual(['children_lists', 'facet_notes', 'level_hubs']);
			expect(connections.childOutcome).toBe('Parents list their direct children.');
			expect(connections.folderOutcome).toBe('Each generated folder gets a Contents list.');
			expect(connections.selectOptions.map((option) => option.value)).toEqual(['none', 'tags-only', 'notes']);
			expect(connections.selectOptions.map((option) => option.text)).toEqual(['Off', 'Tags only', 'Create hub notes']);
			expect(connections.facetContext).toMatch(/^(Using tags:|Enable the Tags shape)/);
			const notesOption = connections.selectOptions.find((option) => option.value === 'notes');
			expect(notesOption?.disabled).toBe(connections.facetContext.startsWith('Enable the Tags shape'));
			expect(connections.detailsClosed).toBe(true);
			expect(connections.detailsSummaries.every((summary) => summary === 'What this does')).toBe(true);
			expect(connections.selectedFacetValue).toBe('tags-only');
			expect(connections.facetOn).toBe(true);
			expect(connections.placementValues).toEqual(['sibling', 'folder-note']);
			expect(connections.placementLabels).toEqual(['Beside its folder', 'Inside its folder']);
			expect(connections.selectedPlacements).toBe(1);
			expect(connections.selectedState).toBe('Selected');
			expect(connections.defaultState).toBe(true);
			expect(connections.placementPrompt).toBe('When X/ contains child notes, where should X.md live?');
		}

		// -- Stage C: multi-column evidence anchors to the exact clicked source.
		//    Exercise every close path, then ignore → restore → ignore so the
		//    packed-id mapping remains the sole structural mapping for later stages.
		// Native WebdriverIO input is required here: Obsidian Scope does not treat a
		// synthetic KeyboardEvent as equivalent to a user pressing Escape.
		const evidenceEscapeSetup = await browser.executeObsidian(() => {
			const modal = document.querySelector('.crosswalker-wizard-modal');
			const badge = modal?.querySelector(
				'.crosswalker-wb-badge[data-column="tactic"][data-detection-key^="level-column-chain:"]',
			) as HTMLButtonElement | null;
			badge?.click();
			return !!badge;
		});
		expect(evidenceEscapeSetup).toBe(true);
		await browser.pause(350);
		await browser.keys('Escape');
		await browser.pause(350);
		const evidenceEscape = await browser.executeObsidian(() => {
			const modal = document.querySelector('.crosswalker-wizard-modal');
			const active = document.activeElement as HTMLElement | null;
			return {
				modalOpen: !!modal,
				panelClosed: !modal?.querySelector('.crosswalker-wb-evidence'),
				focusRestored: active?.matches(
					'.crosswalker-wb-badge[data-column="tactic"][data-detection-key^="level-column-chain:"]',
				) ?? false,
			};
		});
		expect(evidenceEscape.modalOpen).toBe(true);
		expect(evidenceEscape.panelClosed).toBe(true);
		expect(evidenceEscape.focusRestored).toBe(true);

		const evidence = await browser.executeObsidian(async () => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const modal = document.querySelector('.crosswalker-wizard-modal');
			if (!modal) return { ok: false as const, reason: 'NO_MODAL' };
			const findChainBadge = () => modal.querySelector(
				'.crosswalker-wb-badge[data-column="tactic"][data-detection-key^="level-column-chain:"]',
			) as HTMLButtonElement | null;
			const readCard = () => {
				const card = modal.querySelector('.crosswalker-wb-evidence') as HTMLElement | null;
				return {
					card,
					column: card?.dataset.column ?? '',
					key: card?.dataset.detectionKey ?? '',
					context: card?.querySelector('.crosswalker-wb-evidence-context code')?.textContent?.trim() ?? '',
					title: card?.querySelector('.crosswalker-wb-evidence-title')?.textContent?.trim() ?? '',
					labels: Array.from(card?.querySelectorAll('.crosswalker-wb-evidence-label') ?? [])
						.map((el) => el.textContent?.trim() ?? ''),
					samples: card?.querySelector('.crosswalker-wb-samples')?.textContent ?? '',
					status: card?.querySelector('.crosswalker-wb-evidence-status')?.textContent?.trim() ?? '',
					action: card?.querySelector('.crosswalker-wb-evidence-action')?.textContent?.trim() ?? '',
					actionCount: card?.querySelectorAll('.crosswalker-wb-evidence-action').length ?? 0,
					hasClose: !!card?.querySelector('.crosswalker-wb-evidence-close'),
				};
			};
			const isFocusedChainBadge = () => {
				const active = document.activeElement as HTMLElement | null;
				return active?.matches(
					'.crosswalker-wb-badge[data-column="tactic"][data-detection-key^="level-column-chain:"]',
				) ?? false;
			};

			const initialBadge = findChainBadge();
			if (!initialBadge) return { ok: false as const, reason: 'NO_CHAIN_BADGE' };
			const key = initialBadge.dataset.detectionKey ?? '';
			initialBadge.click();
			await sleep(350);
			const opened = readCard();

			(opened.card?.querySelector('.crosswalker-wb-evidence-close') as HTMLButtonElement | null)?.click();
			await sleep(350);
			const closeWorked = !modal.querySelector('.crosswalker-wb-evidence');
			const closeRestoredFocus = isFocusedChainBadge();

			findChainBadge()?.click();
			await sleep(350);
			(modal.querySelector('.crosswalker-wb-canvas .crosswalker-wb-eyebrow') as HTMLElement | null)?.click();
			await sleep(350);
			const clickAwayWorked = !modal.querySelector('.crosswalker-wb-evidence');

			findChainBadge()?.click();
			await sleep(350);
			const actionCardReopened = !!modal.querySelector('.crosswalker-wb-evidence');
			const mappingCount = () => modal.querySelectorAll('.crosswalker-wb-mapcard-toggle').length;
			const mappingsBeforeIgnore = mappingCount();
			const evidenceAction = modal.querySelector(
				'.crosswalker-wb-evidence-action',
			) as HTMLButtonElement | null;
			const actionAvailable = !!evidenceAction;
			evidenceAction?.click();
			await sleep(450);
			const ignored = readCard();
			const mappingsAfterIgnore = mappingCount();
			const ignoreFocusedAction = document.activeElement?.classList.contains(
				'crosswalker-wb-evidence-action',
			) ?? false;
			const ignoredBadgeVisible = findChainBadge()?.classList.contains('is-dismissed') ?? false;

			(modal.querySelector('.crosswalker-wb-evidence-action') as HTMLButtonElement | null)?.click();
			await sleep(450);
			const restored = readCard();
			const mappingsAfterRestore = mappingCount();
			const restoreFocusedAction = document.activeElement?.classList.contains(
				'crosswalker-wb-evidence-action',
			) ?? false;

			// Leave the chain ignored so later preview/generation stages retain one
			// structural mapping, while the dismissed badge remains inspectable.
			(modal.querySelector('.crosswalker-wb-evidence-action') as HTMLButtonElement | null)?.click();
			await sleep(450);
			const finalIgnored = readCard();

			return {
				ok: true as const,
				key,
				opened: {
					column: opened.column,
					key: opened.key,
					context: opened.context,
					title: opened.title,
					labels: opened.labels,
					samples: opened.samples,
					status: opened.status,
					action: opened.action,
					actionCount: opened.actionCount,
					hasClose: opened.hasClose,
				},
				closeWorked,
				closeRestoredFocus,
				clickAwayWorked,
				actionCardReopened,
				actionAvailable,
				ignored: { status: ignored.status, action: ignored.action },
				restored: { status: restored.status, action: restored.action },
				finalIgnored: { status: finalIgnored.status, action: finalIgnored.action },
				ignoredBadgeVisible,
				ignoreFocusedAction,
				restoreFocusedAction,
				mappingsBeforeIgnore,
				mappingsAfterIgnore,
				mappingsAfterRestore,
			};
		});
		console.log('[workbench] evidence → ' + JSON.stringify(evidence));
		await browser.executeObsidian(() => {
			document.querySelector('.crosswalker-wb-evidence')?.scrollIntoView({ block: 'start' });
		});
		await browser.pause(250);
		await browser.saveScreenshot(path.join(OUT, 'wb-02-evidence-card.png'));
		await saveThemeScreenshot('wb-02-evidence-card-dark.png');
		expect(evidence.ok).toBe(true);
		if (evidence.ok) {
			expect(evidence.key).toContain('level-column-chain:');
			expect(evidence.opened.column).toBe('tactic');
			expect(evidence.opened.key).toBe(evidence.key);
			expect(evidence.opened.context).toBe('tactic');
			expect(evidence.opened.title).toBe('Hierarchy across columns');
			expect(evidence.opened.labels).toContain('What Crosswalker noticed');
			expect(evidence.opened.labels).toContain('Coverage');
			expect(evidence.opened.labels).toContain('Examples from tactic');
			expect(evidence.opened.labels).toContain('Effect on automatic mapping');
			expect(evidence.opened.samples).toContain('Defense Evasion');
			expect(evidence.opened.status).toBe('Included in automatic mapping');
			expect(evidence.opened.action).toBe('Ignore this detection');
			expect(evidence.opened.actionCount).toBe(1);
			expect(evidence.opened.hasClose).toBe(true);
			expect(evidence.closeWorked).toBe(true);
			expect(evidence.closeRestoredFocus).toBe(true);
			expect(evidence.clickAwayWorked).toBe(true);
			expect(evidence.actionCardReopened).toBe(true);
			expect(evidence.actionAvailable).toBe(true);
			expect(evidence.ignored.status).toBe('Ignored by automatic mapping');
			expect(evidence.ignored.action).toBe('Use this detection');
			expect(evidence.restored.status).toBe('Included in automatic mapping');
			expect(evidence.restored.action).toBe('Ignore this detection');
			expect(evidence.finalIgnored.status).toBe('Ignored by automatic mapping');
			expect(evidence.ignoredBadgeVisible).toBe(true);
			expect(evidence.ignoreFocusedAction).toBe(true);
			expect(evidence.restoreFocusedAction).toBe(true);
			// Some evidence changes an existing automatic mapping rather than adding
				// its own card, so ignoring it may keep the visible card count stable.
				expect(evidence.mappingsAfterIgnore).toBeLessThanOrEqual(evidence.mappingsBeforeIgnore);
			expect(evidence.mappingsAfterRestore).toBe(evidence.mappingsBeforeIgnore);
		}

		// -- Stage D: inline mapping chooser search, metadata, close paths, selection,
		//    and focus restoration across the workbench's full DOM rebuilds.
		const chooserEscapeSetup = await browser.executeObsidian(() => {
			const trigger = document.querySelector(
				'.crosswalker-wizard-modal .crosswalker-wb-addmapping-trigger',
			) as HTMLButtonElement | null;
			trigger?.click();
			return !!trigger;
		});
		expect(chooserEscapeSetup).toBe(true);
		await browser.pause(350);
		await browser.keys('Escape');
		await browser.pause(350);
		const chooserEscape = await browser.executeObsidian(() => {
			const modal = document.querySelector('.crosswalker-wizard-modal');
			return {
				modalOpen: !!modal,
				panelClosed: !modal?.querySelector('.crosswalker-wb-mapping-chooser'),
				focusRestored: document.activeElement?.classList.contains(
					'crosswalker-wb-addmapping-trigger',
				) ?? false,
			};
		});
		expect(chooserEscape.modalOpen).toBe(true);
		expect(chooserEscape.panelClosed).toBe(true);
		expect(chooserEscape.focusRestored).toBe(true);

		const chooser = await browser.executeObsidian(async () => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const modal = document.querySelector('.crosswalker-wizard-modal');
			if (!modal) return { ok: false as const, reason: 'NO_MODAL' };
			const trigger = () => modal.querySelector(
				'.crosswalker-wb-addmapping-trigger',
			) as HTMLButtonElement | null;
			const search = () => modal.querySelector(
				'.crosswalker-wb-chooser-search',
			) as HTMLInputElement | null;
			const setSearch = (value: string) => {
				const input = search();
				if (!input) return false;
				input.value = value;
				input.dispatchEvent(new Event('input', { bubbles: true }));
				return true;
			};
			const resultNames = () => Array.from(
				modal.querySelectorAll('.crosswalker-wb-chooser-option'),
			).map((el) => el.getAttribute('data-column') ?? '');
			const triggerFocused = () => document.activeElement?.classList.contains(
				'crosswalker-wb-addmapping-trigger',
			) ?? false;

			const preset = modal.querySelector('.crosswalker-wb-presetbar');
			const chooserImmediatelyBelowPreset = preset?.nextElementSibling?.classList.contains(
				'crosswalker-wb-addmapping',
			) ?? false;
			const triggerText = trigger()?.textContent?.trim() ?? '';

			trigger()?.click();
			await sleep(350);
			const opened = !!modal.querySelector('.crosswalker-wb-mapping-chooser');
			const searchFocusedOnOpen = document.activeElement?.classList.contains(
				'crosswalker-wb-chooser-search',
			) ?? false;
			const sourceOrder = resultNames();

			setSearch('description');
			const nameSearchResults = resultNames();

			setSearch('PowerShell');
			const sampleSearchResults = resultNames();
			const nameOption = modal.querySelector(
				'.crosswalker-wb-chooser-option[data-column="name"]',
			) as HTMLButtonElement | null;
			const nameMetadata = nameOption?.querySelector('.crosswalker-wb-column-meta')?.textContent ?? '';
			const nameSamples = nameOption?.querySelector('.crosswalker-wb-column-samples')?.textContent ?? '';

			setSearch('unused');
			const unusedOption = modal.querySelector(
				'.crosswalker-wb-chooser-option[data-column="unused"]',
			) as HTMLButtonElement | null;
			const unusedMetadata = unusedOption?.querySelector('.crosswalker-wb-column-meta')?.textContent ?? '';
			const unusedSamples = unusedOption?.querySelector('.crosswalker-wb-column-samples')?.textContent ?? '';

			setSearch('definitely-not-a-column-or-sample');
			const emptyText = modal.querySelector('.crosswalker-wb-chooser-empty')?.textContent?.trim() ?? '';

			(modal.querySelector('.crosswalker-wb-chooser-close') as HTMLButtonElement | null)?.click();
			await sleep(350);
			const closeWorked = !modal.querySelector('.crosswalker-wb-mapping-chooser');
			const closeFocusedTrigger = triggerFocused();

			trigger()?.click();
			await sleep(350);
			trigger()?.click();
			await sleep(350);
			const toggleCloseWorked = !modal.querySelector('.crosswalker-wb-mapping-chooser');
			const toggleFocusedTrigger = triggerFocused();

			trigger()?.click();
			await sleep(350);
			(modal.querySelector('.crosswalker-wb-preview .crosswalker-wb-eyebrow') as HTMLElement | null)?.click();
			await sleep(350);
			const clickAwayWorked = !modal.querySelector('.crosswalker-wb-mapping-chooser');
			const clickAwayFocusedTrigger = triggerFocused();

			trigger()?.click();
			await sleep(350);
			setSearch('PowerShell');
			const beforeSelection = modal.querySelectorAll('.crosswalker-wb-mapcard-toggle').length;
			const selected = modal.querySelector(
				'.crosswalker-wb-chooser-option[data-column="name"]',
			) as HTMLButtonElement | null;
			selected?.click();
			await sleep(450);
			const afterSelection = modal.querySelectorAll('.crosswalker-wb-mapcard-toggle').length;
			const focusedCard = document.activeElement as HTMLElement | null;

			return {
				ok: true as const,
				chooserImmediatelyBelowPreset,
				triggerText,
				opened,
				searchFocusedOnOpen,
				sourceOrder,
				nameSearchResults,
				sampleSearchResults,
				nameMetadata,
				nameSamples,
				unusedMetadata,
				unusedSamples,
				emptyText,
				closeWorked,
				closeFocusedTrigger,
				toggleCloseWorked,
				toggleFocusedTrigger,
				clickAwayWorked,
				clickAwayFocusedTrigger,
				beforeSelection,
				afterSelection,
				selectedCardIndex: focusedCard?.dataset.mappingIndex ?? '',
				selectedCardFocused: focusedCard?.classList.contains('crosswalker-wb-mapcard') ?? false,
				selectedCardText: focusedCard?.textContent ?? '',
			};
		});
		console.log('[workbench] chooser → ' + JSON.stringify(chooser));
		expect(chooser.ok).toBe(true);
		if (chooser.ok) {
			expect(chooser.chooserImmediatelyBelowPreset).toBe(true);
			expect(chooser.triggerText).toBe('Add mapping from a column');
			expect(chooser.opened).toBe(true);
			expect(chooser.searchFocusedOnOpen).toBe(true);
			expect(chooser.sourceOrder[0]).toBe('technique_id');
			expect(chooser.sourceOrder.length).toBeLessThanOrEqual(50);
			expect(chooser.nameSearchResults).toEqual(['description']);
			expect(chooser.sampleSearchResults).toContain('name');
			expect(chooser.sampleSearchResults[0]).toBe('name');
			expect(chooser.nameMetadata).toContain('Type: string');
			expect(chooser.nameMetadata).toContain('unique');
			expect(chooser.nameMetadata).toContain('No empty values');
			expect(chooser.nameSamples).toContain('PowerShell');
			expect(chooser.unusedMetadata).toContain('0 unique');
			expect(chooser.unusedMetadata).toContain('Contains empty values');
			expect(chooser.unusedSamples).toBe('Examples: none available');
			expect(chooser.emptyText).toBe('No columns match this search.');
			expect(chooser.closeWorked).toBe(true);
			expect(chooser.closeFocusedTrigger).toBe(true);
			expect(chooser.toggleCloseWorked).toBe(true);
			expect(chooser.toggleFocusedTrigger).toBe(true);
			expect(chooser.clickAwayWorked).toBe(true);
			expect(chooser.clickAwayFocusedTrigger).toBe(true);
			expect(chooser.afterSelection).toBe(chooser.beforeSelection + 1);
			expect(chooser.selectedCardIndex).toBe(String(chooser.beforeSelection));
			expect(chooser.selectedCardFocused).toBe(true);
			expect(chooser.selectedCardText).toContain('name');
		}

		// Capture the chooser with a sample-value search so the visible receipt
		// explains why each result matched.
		await browser.executeObsidian(async () => {
			const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
			(document.querySelector('.crosswalker-wb-addmapping-trigger') as HTMLButtonElement | null)?.click();
			await sleep(250);
			const search = document.querySelector('.crosswalker-wb-chooser-search') as HTMLInputElement | null;
			if (search) {
				search.value = 'PowerShell';
				search.dispatchEvent(new Event('input', { bubbles: true }));
			}
			document.querySelector('.crosswalker-wb-mapping-chooser')?.scrollIntoView({ block: 'start' });
		});
		await browser.pause(250);
		await browser.saveScreenshot(path.join(OUT, 'wb-02b-column-chooser.png'));
		await saveThemeScreenshot('wb-02b-column-chooser-dark.png');
		await browser.executeObsidian(() => {
			(document.querySelector('.crosswalker-wb-chooser-close') as HTMLButtonElement | null)?.click();
		});
		await browser.pause(250);

		// Capture the visual shape language before opening the detailed level matrix.
		await browser.executeObsidian(async () => {
			const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
			(document.querySelector('.crosswalker-wb-mapcard-toggle') as HTMLButtonElement | null)?.click();
			await sleep(300);
			document.querySelector('.crosswalker-wb-shapes')?.scrollIntoView({ block: 'start' });
		});
		await browser.pause(250);
		await browser.saveScreenshot(path.join(OUT, 'wb-03-shape-cards.png'));
		await saveThemeScreenshot('wb-03-shape-cards-dark.png');
		await browser.executeObsidian(() => {
			(document.querySelector('.crosswalker-wb-mapcard-toggle') as HTMLButtonElement | null)?.click();
		});
		await browser.pause(250);

		// -- Stage E: expand a mapping + "Arrange levels" → matrix w/ tail row.
		const matrix = await browser.executeObsidian(async () => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const modal = document.querySelector('.crosswalker-wizard-modal');
			if (!modal) return { ok: false as const };
			const toggle = modal.querySelector('.crosswalker-wb-mapcard-toggle') as HTMLButtonElement | null;
			if (!toggle) return { ok: false as const, reason: 'NO_TOGGLE' };
			toggle.click();
			await sleep(500);
			const firstCard = modal.querySelector(
				'.crosswalker-wb-mapcard[data-mapping-index="0"]',
			) as HTMLElement | null;
			const shapes = Array.from(firstCard?.querySelectorAll('.crosswalker-wb-shape') ?? []);
			const illustrations = Array.from(
				firstCard?.querySelectorAll('.crosswalker-wb-shape-illustration') ?? [],
			);
			const checkboxes = Array.from(
				firstCard?.querySelectorAll('.crosswalker-wb-shape input[type="checkbox"]') ?? [],
			);
			const stateLabels = Array.from(
				firstCard?.querySelectorAll('.crosswalker-wb-shape-state') ?? [],
			).map((el) => el.textContent?.trim() ?? '');
			const shapeDetails = Array.from(
				firstCard?.querySelectorAll('.crosswalker-wb-shape-details') ?? [],
			) as HTMLDetailsElement[];
			if (shapeDetails[0]) shapeDetails[0].open = true;
			const detailsSummaries = shapeDetails.map(
				(el) => el.querySelector('summary')?.textContent?.trim() ?? '',
			);
			const arrange = Array.from(modal.querySelectorAll('.crosswalker-wb-arrange')).find(
				(b) => b.textContent?.includes('Arrange levels'),
			) as HTMLButtonElement | undefined;
			if (!arrange) return { ok: false as const, reason: 'NO_ARRANGE' };
			arrange.click();
			await sleep(500);
			const tailRow = modal.querySelector('.crosswalker-wb-tailrow');
			// Bring the matrix into the modal viewport so the screenshot shows it.
			(modal.querySelector('.crosswalker-wb-matrix') ?? tailRow)?.scrollIntoView({ block: 'center' });
			await sleep(300);
			return {
				ok: true as const,
				shapeCount: shapes.length,
				illustrationCount: illustrations.length,
				illustrationsHidden: illustrations.every(
					(el) => el.getAttribute('aria-hidden') === 'true',
				),
				checkboxCount: checkboxes.length,
				checkboxesInsideLabels: checkboxes.every(
					(el) => !!el.closest('label.crosswalker-wb-shape-control'),
				),
				stateLabels,
				detailsCount: shapeDetails.length,
				detailsSummaries,
				firstDetailsOpen: shapeDetails[0]?.open ?? false,
				hasMatrix: !!modal.querySelector('.crosswalker-wb-matrix'),
				hasTailRow: !!tailRow,
				tailText: tailRow?.textContent ?? '',
			};
		});
		console.log('[workbench] matrix → ' + JSON.stringify(matrix));
		await browser.saveScreenshot(path.join(OUT, 'wb-03-matrix-expanded.png'));
		expect(matrix.ok).toBe(true);
		if (matrix.ok) {
			expect(matrix.shapeCount).toBe(6);
			expect(matrix.illustrationCount).toBe(6);
			expect(matrix.illustrationsHidden).toBe(true);
			expect(matrix.checkboxCount).toBe(6);
			expect(matrix.checkboxesInsideLabels).toBe(true);
			expect(matrix.stateLabels).toHaveLength(6);
			expect(matrix.stateLabels.every((label) => ['On', 'Off', 'Some levels'].includes(label))).toBe(true);
			expect(matrix.detailsCount).toBe(6);
			expect(matrix.detailsSummaries).toEqual(new Array(6).fill('What this does'));
			expect(matrix.firstDetailsOpen).toBe(true);
			expect(matrix.hasMatrix).toBe(true);
			expect(matrix.hasTailRow).toBe(true);
			expect(matrix.tailText).toContain('Any deeper');
		}

		// -- Stage E: live preview rail → folder tree containing T1055.
		const preview = await browser.executeObsidian(async () => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const modal = document.querySelector('.crosswalker-wizard-modal');
			if (!modal) return { ok: false as const };
			const rail = modal.querySelector('.crosswalker-wb-preview');
			rail?.scrollIntoView({ block: 'start' });
			await sleep(300);
			const tree = rail?.querySelector('.crosswalker-wb-tree');
			return {
				ok: true as const,
				hasTree: !!tree,
				treeText: tree?.textContent ?? '',
				hasNote: !!rail?.querySelector('.crosswalker-wb-note'),
			};
		});
		console.log('[workbench] preview → ' + JSON.stringify(preview).slice(0, 500));
		await browser.saveScreenshot(path.join(OUT, 'wb-04-preview-rail.png'));
		expect(preview.ok).toBe(true);
		if (preview.ok) {
			expect(preview.hasTree).toBe(true);
			expect(preview.treeText).toContain('T1055');
		}

		// -- Stage F: advance to Step 3 → the new review screen (spec §7j #1).
		//    Destination block + shape-map recap + stat chips + provenance line;
		//    NO workbench re-render.
		const review = await browser.executeObsidian(async () => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const modal = document.querySelector('.crosswalker-wizard-modal');
			if (!modal) return { ok: false as const };
			const next = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent?.includes('Next'));
			if (!next) return { ok: false as const, reason: 'NO_NEXT' };
			(next as HTMLButtonElement).click();
			await sleep(800);
			const prov = modal.querySelector('.crosswalker-provenance');
			return {
				ok: true as const,
				h3: modal.querySelector('h3')?.textContent ?? '',
				hasDest: !!modal.querySelector('.crosswalker-dest-block'),
				hasReveal: !!modal.querySelector('.crosswalker-dest-reveal'),
				destPath: modal.querySelector('.crosswalker-dest-crumb')?.textContent ?? '',
				hasRecap: !!modal.querySelector('.crosswalker-shape-map'),
				hasProvenance: !!prov,
				provText: prov?.textContent ?? '',
				hasBadge: !!modal.querySelector('.crosswalker-prov-badge'),
				// The review screen must NOT re-render the live workbench (spec §7j #1).
				workbenchPresent: !!modal.querySelector('.crosswalker-workbench'),
			};
		});
		console.log('[workbench] review → ' + JSON.stringify(review));
		await browser.saveScreenshot(path.join(OUT, 'wb-05-review.png'));
		expect(review.ok).toBe(true);
		if (review.ok) {
			expect(review.hasDest).toBe(true);
			expect(review.hasReveal).toBe(true);
			expect(review.hasRecap).toBe(true);
			expect(review.hasProvenance).toBe(true);
			expect(review.hasBadge).toBe(true);
			expect(review.workbenchPresent).toBe(false);
		}

		// -- Stage G (L4): generate, then screenshot the localized GRAPH VIEW and
		//    one generated note in READING VIEW. The wizard closes on success.
		const destPath = review.ok ? (review.destPath || '').trim() : '';

		const genInfo = await browser.executeObsidian(async ({ app }) => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const modal = document.querySelector('.crosswalker-wizard-modal');
			if (!modal) return { ok: false as const, reason: 'NO_MODAL' };
			// Step 3 → Step 4 (Generate screen).
			const next = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent?.includes('Next'));
			if (next) { (next as HTMLButtonElement).click(); await sleep(600); }
			// Click Generate.
			const gen = Array.from(document.querySelectorAll('.crosswalker-wizard-modal button')).find((b) => b.textContent?.trim() === 'Generate');
			if (!gen) return { ok: false as const, reason: 'NO_GENERATE' };
			(gen as HTMLButtonElement).click();
			// Wait for generation to finish (modal closes on success).
			const t0 = Date.now();
			while (Date.now() - t0 < 20000) {
				if (!document.querySelector('.crosswalker-wizard-modal')) break;
				await sleep(200);
			}
			await sleep(800);
			// @ts-expect-error — internal API
			const created = app.vault.getMarkdownFiles().filter((f: { path: string }) => f.path.startsWith('Frameworks/')).length;
			return { ok: true as const, modalClosed: !document.querySelector('.crosswalker-wizard-modal'), created };
		});
		console.log('[workbench] generate → ' + JSON.stringify(genInfo));
		expect(genInfo.ok).toBe(true);

		// -- Stage H: open one generated note in READING (preview) view.
		const noteInfo = await browser.executeObsidian(async ({ app }, dest: unknown) => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const prefix = (typeof dest === 'string' && dest.length ? dest : 'Frameworks').split('/')[0];
			// @ts-expect-error — internal API
			const files = app.vault.getMarkdownFiles().filter((f: { path: string }) => f.path.startsWith(prefix + '/'));
			if (!files.length) return { ok: false as const, reason: 'NO_FILES', prefix };
			files.sort((a: { stat: { mtime: number } }, b: { stat: { mtime: number } }) => b.stat.mtime - a.stat.mtime);
			// Prefer a leaf technique note (has body + frontmatter) over a folder note.
			const file = files.find((f: { path: string }) => /T\d{4}(\.\d{3})?\.md$/.test(f.path)) ?? files[0];
			const content = await app.vault.read(file);
			// @ts-expect-error — internal API
			const leaf = app.workspace.getLeaf(true);
			await leaf.openFile(file, { state: { mode: 'preview' } });
			await sleep(1200);
			return {
				ok: true as const,
				path: file.path,
				hasCanonicalBody: content.includes('Adversaries may'),
				recipeId: /recipe:\s*\n\s+id:\s*([^\n]+)/.exec(content)?.[1]?.trim() ?? '',
			};
		}, destPath);
		console.log('[workbench] note → ' + JSON.stringify(noteInfo));
		expect(noteInfo.ok).toBe(true);
		if (noteInfo.ok) {
			expect(noteInfo.hasCanonicalBody).toBe(true);
			expect(noteInfo.recipeId).toBe('custom-attack-mini');
		}
		await browser.saveScreenshot(path.join(OUT, 'wb-07-note.png'));

		// -- Stage I: open GRAPH VIEW and localize it to the output folder. Graph
		//    automation is best-effort; the screenshot is captured regardless so a
		//    partial result is still inspectable.
		const graphInfo = await browser.executeObsidian(async ({ app }, dest: unknown) => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const prefix = (typeof dest === 'string' && dest.length ? dest : 'Frameworks').split('/')[0];
			// @ts-expect-error — commands API is untyped
			app.commands.executeCommandById('graph:open');
			let graphLeaf: HTMLElement | null = null;
			const t0 = Date.now();
			while (Date.now() - t0 < 8000) {
				graphLeaf = document.querySelector('.workspace-leaf-content[data-type="graph"]');
				if (graphLeaf) break;
				await sleep(150);
			}
			if (!graphLeaf) return { ok: false as const, reason: 'NO_GRAPH_LEAF' };
			// Type a path filter into the graph search box so only the import shows.
			const search = graphLeaf.querySelector('input[type="search"], .search-input-container input') as HTMLInputElement | null;
			let filtered = false;
			if (search) {
				search.focus();
				search.value = `path:"${prefix}"`;
				search.dispatchEvent(new Event('input', { bubbles: true }));
				filtered = true;
				await sleep(2500); // let the force layout settle
			} else {
				await sleep(2000);
			}
			return { ok: true as const, filtered, query: `path:"${prefix}"` };
		}, destPath);
		console.log('[workbench] graph → ' + JSON.stringify(graphInfo));
		await browser.saveScreenshot(path.join(OUT, 'wb-06-graph.png'));
	});
});
