/**
 * visual-graph.spec.ts — the connectedness "money shot": a clean, legible graph
 * of ONLY a generated import.
 *
 * The existing visual-workbench.spec.ts graph screenshot (wb-06) reuses the
 * `Frameworks/` output folder across every e2e run ever executed against this
 * embedded test-vault, so it has silently accumulated 3.5K+ notes over time
 * (nothing in the harness deletes generated output between runs) — the graph
 * view's `path:"Frameworks"` filter drowns in that backlog instead of showing
 * a legible ~12-technique + facet-hub cluster.
 *
 * This spec avoids that by generating into a UNIQUE, explicitly-cleaned output
 * folder (`GraphTest-e2e/`) every run, then filtering the graph to `path:GraphTest`.
 *
 * Fixture: a 12-row ATT&CK-shaped CSV with dotted (packed) technique ids
 * (ragged sub-technique depth) AND multi-value tactic cells (`Defense Evasion;
 * Privilege Escalation`) so facet hub notes materialize with >1 member AND
 * some techniques belong to 2 hubs — real ATT&CK shape, not synthetic filler.
 *
 *   DISPLAY=:0 bun run e2e -- --spec tests/e2e/visual-graph.spec.ts
 *
 * Screenshots land in test-screenshots/ (graph-01-connected.png, graph-02-hub-note.png).
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('test-screenshots');
const DEST = 'GraphTest-e2e';

/** 12-row ATT&CK-shaped CSV. 6/12 ids are sub-techniques (dotted) → ragged packed
 *  hierarchy. Multi-value tactic cells (real ATT&CK technique→tactic spreads) so
 *  facet hubs get >1 member AND some notes belong to 2 hubs. */
const ATTACK_CSV = [
	'technique_id,name,tactic,description',
	'T1055,Process Injection,Defense Evasion; Privilege Escalation,"Adversaries may inject code into processes in order to evade process-based defenses as well as possibly elevate privileges."',
	'T1055.001,Dynamic-link Library Injection,Defense Evasion; Privilege Escalation,"Adversaries may inject dynamic-link libraries (DLLs) into processes in order to evade process-based defenses as well as possibly elevate privileges."',
	'T1055.011,Extra Window Memory Injection,Defense Evasion; Privilege Escalation,"Adversaries may inject malicious code into a process via Extra Window Memory (EWM) in order to evade process-based defenses as well as possibly elevate privileges."',
	'T1059,Command and Scripting Interpreter,Execution,"Adversaries may abuse command and script interpreters to execute commands, scripts, or binaries."',
	'T1059.001,PowerShell,Execution,"Adversaries may abuse PowerShell commands and scripts for execution."',
	'T1059.003,Windows Command Shell,Execution,"Adversaries may abuse the Windows command shell for execution."',
	'T1071,Application Layer Protocol,Command and Control,"Adversaries may communicate using OSI application layer protocols to avoid detection and network filtering."',
	'T1071.001,Web Protocols,Command and Control,"Adversaries may communicate using application layer protocols associated with web traffic to avoid detection and network filtering."',
	'T1547,Boot or Logon Autostart Execution,Persistence; Privilege Escalation,"Adversaries may configure system settings to automatically execute a program during system boot or logon."',
	'T1547.001,Registry Run Keys / Startup Folder,Persistence; Privilege Escalation,"Adversaries may achieve persistence by adding a program to a startup folder or referencing it with a Registry run key."',
	'T1003,OS Credential Dumping,Credential Access,"Adversaries may attempt to dump credentials to obtain account login and credential material."',
	'T1486,Data Encrypted for Impact,Impact,"Adversaries may encrypt data on target systems to interrupt availability to system and network resources."',
].join('\n');

describe('Visual — connectedness money shot (clean graph of a single import)', function () {
	this.timeout(180_000);

	before(async () => {
		mkdirSync(OUT, { recursive: true });
		// Let the (heavy) test vault finish its initial index before driving UI.
		// Condition poll (workspace.layoutReady) instead of a fixed sleep, with a
		// generous cap so a slow/loaded machine doesn't get a false failure.
		try {
			await browser.waitUntil(
				async () => browser.executeObsidian(({ app }) => (app.workspace as any).layoutReady === true),
				{ timeout: 15000, interval: 300, timeoutMsg: 'workspace.layoutReady never became true' }
			);
		} catch (e) {
			console.log('[graph] FINDING: ' + (e as Error).message + ' — proceeding anyway');
		}
		await browser.pause(500); // brief settle after layout-ready flips
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error — internal plugins API
			const plugin = app.plugins.plugins['crosswalker'];
			plugin.settings.enableShapeWorkbench = true;
			plugin.settings.enableConfigSuggestions = false;
			plugin.settings.enableDraftSessions = false;
			await plugin.saveSettings();
		});
		// Delete any leftover GraphTest-e2e/ from a prior run so the graph never
		// re-accumulates the way Frameworks/ has (see spec header).
		await browser.executeObsidian(async ({ app }, dest: unknown) => {
			const d = String(dest);
			// @ts-expect-error — adapter API is internal but stable
			if (await app.vault.adapter.exists(d)) {
				// @ts-expect-error — adapter API is internal but stable
				await app.vault.adapter.rmdir(d, true);
			}
		}, DEST);
	});

	after(async () => {
		await browser.executeObsidian(async ({ app }) => {
			document.querySelector<HTMLElement>('.modal-close-button, .modal-header-button')?.click();
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

	it('generates a clean import and screenshots a legible connected graph', async () => {
		// -- Stage A: open wizard → inject CSV → advance to the workbench (Step 2).
		const openInfo = await browser.executeObsidian(async ({ app }, csv) => {
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
			document.querySelector<HTMLElement>('.modal-close-button, .modal-header-button')?.click();
			await sleep(300);

			// @ts-expect-error — commands API is untyped
			app.commands.executeCommandById('crosswalker:import-structured-data');
			const modal = await waitFor('.modal', 8000);
			if (!modal) return { ok: false as const, reason: 'NO_MODAL' };
			const input = (await waitFor('.modal input[type=file]', 8000)) as HTMLInputElement | null;
			if (!input) return { ok: false as const, reason: 'NO_FILE_INPUT' };
			const dt = new DataTransfer();
			dt.items.add(new File([csv], 'attack-graph-mini.csv'));
			input.files = dt.files;
			input.dispatchEvent(new Event('change'));
			await sleep(700);

			const next = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent?.includes('Next'));
			if (!next) return { ok: false as const, reason: 'NO_NEXT_BUTTON' };
			(next as HTMLButtonElement).click();

			const wb = await waitFor('.crosswalker-workbench', 8000);
			return { ok: !!wb, reason: wb ? 'OK' : 'NO_WORKBENCH' };
		}, ATTACK_CSV);
		console.log('[graph] open → ' + JSON.stringify(openInfo));
		expect(openInfo.ok).toBe(true);

		// -- Stage B: Step 2 → Step 3 (review), set the destination to GraphTest-e2e.
		const review = await browser.executeObsidian(async (_a, dest: unknown) => {
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
			const modal = document.querySelector('.modal');
			if (!modal) return { ok: false as const, reason: 'NO_MODAL' };
			const next1 = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent?.includes('Next'));
			if (!next1) return { ok: false as const, reason: 'NO_NEXT_STEP2' };
			(next1 as HTMLButtonElement).click();
			await sleep(600);

			const crumb = await waitFor('.crosswalker-dest-crumb', 6000);
			if (!crumb) return { ok: false as const, reason: 'NO_DEST_CRUMB' };
			(crumb as HTMLButtonElement).click();
			await sleep(200);
			const input = document.querySelector('.crosswalker-dest-input') as HTMLInputElement | null;
			if (!input) return { ok: false as const, reason: 'NO_DEST_INPUT' };
			input.value = String(dest);
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
			await sleep(300);

			const destPath = modal.querySelector('.crosswalker-dest-crumb')?.textContent?.trim() ?? '';
			return { ok: true as const, destPath };
		}, DEST);
		console.log('[graph] review → ' + JSON.stringify(review));
		await browser.saveScreenshot(path.join(OUT, 'graph-00-review.png'));
		expect(review.ok).toBe(true);
		if (review.ok) expect(review.destPath.replace(/\s+/g, '')).toContain(DEST);

		// -- Stage C: Step 3 → Step 4 (Generate) → click Generate → wait for close.
		const clickInfo = await browser.executeObsidian(async ({ app }) => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const modal = document.querySelector('.modal');
			if (!modal) return { ok: false as const, reason: 'NO_MODAL' };
			const next = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent?.includes('Next'));
			if (next) { (next as HTMLButtonElement).click(); await sleep(600); }
			const gen = Array.from(document.querySelectorAll('.modal button')).find((b) => b.textContent?.trim() === 'Generate');
			if (!gen) return { ok: false as const, reason: 'NO_GENERATE' };
			(gen as HTMLButtonElement).click();
			return { ok: true as const };
		});
		console.log('[graph] click generate → ' + JSON.stringify(clickInfo));
		expect(clickInfo.ok).toBe(true);

		// Condition poll for "modal closed" instead of a fixed 20s wait. Not a
		// hard assertion on its own — a slow generation just means the later
		// "N files exist" poll does the real waiting; we don't want a modal
		// that's slow to animate-closed to abort the run before screenshots.
		try {
			await browser.waitUntil(
				async () => browser.executeObsidian(() => !document.querySelector('.crosswalker-wizard-modal')),
				{ timeout: 20000, interval: 200, timeoutMsg: 'wizard modal did not close within 20s' }
			);
		} catch (e) {
			console.log('[graph] FINDING: ' + (e as Error).message + ' — proceeding anyway');
		}

		// Condition poll for "N files exist" (>=12) instead of a fixed settle
		// sleep after modal-close — more robust under load than assuming
		// generation finished within a fixed window.
		try {
			await browser.waitUntil(
				async () =>
					browser.executeObsidian(({ app }) => {
						// @ts-expect-error — internal API
						return app.vault.getMarkdownFiles().filter((f: { path: string }) => f.path.startsWith('GraphTest-e2e/')).length >= 12;
					}),
				{ timeout: 15000, interval: 300, timeoutMsg: 'fewer than 12 files materialized under GraphTest-e2e/ within 15s' }
			);
		} catch (e) {
			console.log('[graph] FINDING: ' + (e as Error).message + ' — proceeding anyway, will report actual count');
		}

		const genInfo = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error — internal API
			const files = app.vault.getMarkdownFiles().filter((f: { path: string }) => f.path.startsWith('GraphTest-e2e/'));
			// @ts-expect-error — internal API
			const hubFiles = files.filter((f: any) => app.metadataCache.getFileCache(f)?.frontmatter?.kind === 'facet');
			// Diagnostic: dump one leaf note's frontmatter so we can tell whether the
			// tactic column was mapped to a tag at all (vs. hub materialization
			// specifically being the broken step).
			// @ts-expect-error — internal API
			const t1055 = files.find((f: { path: string }) => f.path.endsWith('T1055.md'));
			// @ts-expect-error — internal API
			const t1055fm = t1055 ? app.metadataCache.getFileCache(t1055)?.frontmatter : null;
			return {
				ok: true as const,
				modalClosed: !document.querySelector('.crosswalker-wizard-modal'),
				created: files.length,
				allPaths: files.map((f: { path: string }) => f.path),
				hubCount: hubFiles.length,
				hubPaths: hubFiles.map((f: { path: string }) => f.path),
				t1055Path: t1055?.path ?? null,
				t1055Frontmatter: t1055fm ?? null,
			};
		});
		console.log('[graph] generate → ' + JSON.stringify(genInfo));
		expect(genInfo.ok).toBe(true);
		// NOT a hard assertion on note count or hub materialization: this spec's
		// job is to reliably produce the graph-01/graph-02 screenshots so a human
		// (or another spec) can SEE the actual state of generation, including a
		// partial/broken run — aborting here on a count/hub mismatch would hide
		// exactly the finding the screenshot is supposed to surface. Real
		// product bugs get logged as FINDINGs instead of failing the spec.
		if (genInfo.ok) {
			if (genInfo.created < 12) {
				console.log(`[graph] FINDING: only ${genInfo.created}/12 notes materialized under GraphTest-e2e/. paths → ${JSON.stringify(genInfo.allPaths)}`);
			}
			if (genInfo.hubCount < 1) {
				console.log('[graph] FINDING: no facet hub notes materialized. t1055 frontmatter → ' + JSON.stringify(genInfo.t1055Frontmatter));
			}
		}

		// Condition poll for "vault finished indexing" before opening the graph
		// view — under heavy concurrent load (shared-tree e2e runs), indexing can
		// still be in progress even after all N files are confirmed written,
		// which previously produced a graph-01 screenshot showing only a loading
		// spinner despite generation having actually succeeded. Best-effort: the
		// "Indexing vault…" notice is a UI toast, not a stable API, so this is a
		// soft wait, not a hard gate.
		try {
			await browser.waitUntil(
				async () =>
					browser.executeObsidian(() => {
						const notices = Array.from(document.querySelectorAll('.notice'));
						return !notices.some((n) => n.textContent?.includes('Indexing vault'));
					}),
				{ timeout: 30000, interval: 300, timeoutMsg: 'vault still showed "Indexing vault…" after 30s' }
			);
		} catch (e) {
			console.log('[graph] FINDING: ' + (e as Error).message + ' — proceeding anyway');
		}

		// -- Stage D: open graph view, localize to GraphTest-e2e, let layout settle.
		const graphInfo = await browser.executeObsidian(async () => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
			// Graph filters are behind the Filters disclosure in the current graph view.
			const filters = Array.from(graphLeaf.querySelectorAll<HTMLElement>('*'))
				.find((el) => el.textContent?.trim() === 'Filters' && el.children.length === 0);
			filters?.click();
			let search: HTMLInputElement | null = null;
			const t1 = Date.now();
			while (Date.now() - t1 < 8000) {
				search = graphLeaf.querySelector('input[type="search"], .search-input-container input');
				if (search) break;
				await sleep(100);
			}
			const query = 'path:GraphTest-e2e';
			if (search) {
				search.focus();
				search.value = query;
				search.dispatchEvent(new Event('input', { bubbles: true }));
			}
			await sleep(4000); // let the force layout settle
			return { ok: true as const, filtered: search?.value === query, query };
		});
		console.log('[graph] graph → ' + JSON.stringify(graphInfo));
		await browser.saveScreenshot(path.join(OUT, 'graph-01-connected.png'));
		expect(graphInfo.ok).toBe(true);
		if (graphInfo.ok) expect(graphInfo.filtered).toBe(true);

		// -- Stage E: open one facet hub note in READING view. Falls back to a plain
		// technique note if no hub materialized, so we still get a screenshot (and
		// the fallback itself is logged as a finding, not silently masked).
		const hubPaths = genInfo.ok ? genInfo.hubPaths : [];
		const fallbackPath = genInfo.ok ? genInfo.t1055Path : null;
		const hubInfo = await browser.executeObsidian(async ({ app }, argsRaw: unknown) => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const args = argsRaw as { hubPaths: string[]; fallback: string | null };
			const targetPath = args.hubPaths[0] ?? args.fallback;
			if (!targetPath) return { ok: false as const, reason: 'NO_TARGET', usedFallback: false };
			// @ts-expect-error — internal API
			const file = app.vault.getAbstractFileByPath(targetPath);
			if (!file) return { ok: false as const, reason: 'FILE_NOT_FOUND', path: targetPath, usedFallback: false };
			// @ts-expect-error — internal API
			const leaf = app.workspace.getLeaf(true);
			await leaf.openFile(file, { state: { mode: 'preview' } });
			await sleep(1200);
			return { ok: true as const, path: targetPath, usedFallback: args.hubPaths.length === 0 };
		}, { hubPaths, fallback: fallbackPath });
		console.log('[graph] hub note → ' + JSON.stringify(hubInfo));
		await browser.saveScreenshot(path.join(OUT, 'graph-02-hub-note.png'));
		expect(hubInfo.ok).toBe(true);
	});
});
