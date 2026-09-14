/**
 * visual-report-and-graph.spec.ts — visual proof of the "furnished vault"
 * enrichment landings (2026-07-11 third batch, see CHANGELOG.md "Frameworks
 * arrive furnished"): the review screen's numeric plan line, the per-import
 * root home note, a folder-note parent, and the connectedness "money shot"
 * graph — attempt three at the graph screenshot (see visual-graph.spec.ts's
 * header for the first two attempts' history; this run adds a longer indexing
 * budget plus a node-count settle-poll instead of a fixed layout-settle sleep).
 *
 * Fixture: a 10-row ATT&CK-shaped CSV with a genuinely ragged hierarchy
 * (T1078 has 4 sub-techniques, T1548 has 1, T1055/T1059/T1071 have none) AND
 * multi-value tactic cells (semicolon-joined, real ATT&CK-style technique→
 * tactic spreads) so facet hub notes materialize with several members each.
 * `parent_note: 'folder-note'` is explicitly selected in the placement
 * chooser (rather than relied on as a default) so `T1078/T1078.md` is
 * deterministic regardless of what the vault's ambient folder-notes-plugin
 * detection resolves to (see `preferredParentNote` in mapping/view-model.ts).
 *
 *   DISPLAY=:0 bun run e2e -- --spec tests/e2e/visual-report-and-graph.spec.ts
 *
 * Screenshots land in test-screenshots/: view-12-plan.png (Step 3 "What will
 * be created" plan line), view-13-home-note.png (root home note, reading
 * view), view-14-parent-note.png (T1078/T1078.md folder-note parent, reading
 * view), graph-01-connected.png (graph view filtered to this run's output
 * folder).
 *
 * The destination folder name deliberately avoids the substring "GraphTest"
 * (visual-graph.spec.ts's own output folder) so the two specs' `path:`
 * filters can never cross-match if both folders happen to coexist in a
 * shared-tree run.
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { wipeGeneratedOutput } from './helpers/vault-hygiene';

const OUT = path.resolve('test-screenshots');
const DEST = 'FurnishedVaultTest-e2e';

/** 10-row ATT&CK-shaped CSV. T1078 (4 children) and T1548 (1 child) are
 *  ragged parents; T1055/T1059/T1071 are childless leaves. Semicolon-joined
 *  tactic cells give several facet values >=2 members each (Persistence,
 *  Privilege Escalation, Defense Evasion, Initial Access all qualify;
 *  Execution and Command and Control stay singleton, no hub — real shape, not
 *  synthetic filler). */
const ATTACK_RAGGED_CSV = [
	'technique_id,name,tactic,description',
	'T1078,Valid Accounts,Persistence; Privilege Escalation; Defense Evasion; Initial Access,"Adversaries may obtain and abuse credentials of existing accounts as a means of gaining initial access, persistence, privilege escalation, or defense evasion."',
	'T1078.001,Default Accounts,Persistence; Privilege Escalation; Defense Evasion; Initial Access,"Adversaries may obtain and abuse credentials of a default account as a means of gaining initial access or persistence."',
	'T1078.002,Domain Accounts,Persistence; Privilege Escalation; Defense Evasion; Initial Access,"Adversaries may obtain and abuse credentials of a domain account as a means of gaining initial access or persistence."',
	'T1078.003,Local Accounts,Persistence; Privilege Escalation; Defense Evasion; Initial Access,"Adversaries may obtain and abuse credentials of a local account as a means of gaining initial access, persistence, privilege escalation, or defense evasion."',
	'T1078.004,Cloud Accounts,Persistence; Privilege Escalation; Defense Evasion; Initial Access,"Adversaries may obtain and abuse credentials of a cloud account as a means of gaining initial access or persistence."',
	'T1548,Abuse Elevation Control Mechanism,Privilege Escalation; Defense Evasion,"Adversaries may circumvent mechanisms designed to control elevated privileges to gain higher-level permissions."',
	'T1548.002,Bypass User Account Control,Privilege Escalation; Defense Evasion,"Adversaries may bypass UAC mechanisms to elevate process privileges on a system."',
	'T1055,Process Injection,Defense Evasion; Privilege Escalation,"Adversaries may inject code into processes in order to evade process-based defenses as well as possibly elevate privileges."',
	'T1059,Command and Scripting Interpreter,Execution,"Adversaries may abuse command and script interpreters to execute commands, scripts, or binaries."',
	'T1071,Application Layer Protocol,Command and Control,"Adversaries may communicate using OSI application layer protocols to avoid detection and network filtering."',
].join('\n');

describe('Visual — the furnished vault: review-screen plan line, home note, folder-note parent, connected graph', function () {
	this.timeout(240_000);

	before(async () => {
		mkdirSync(OUT, { recursive: true });
		try {
			await browser.waitUntil(
				async () => browser.executeObsidian(({ app }) => (app.workspace as any).layoutReady === true),
				{ timeout: 15000, interval: 300, timeoutMsg: 'workspace.layoutReady never became true' }
			);
		} catch (e) {
			console.log('[report-graph] FINDING: ' + (e as Error).message + ' — proceeding anyway');
		}
		await browser.pause(500);
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error — internal plugins API
			const plugin = app.plugins.plugins['crosswalker'];
			plugin.settings.enableShapeWorkbench = true;
			plugin.settings.enableConfigSuggestions = false;
			plugin.settings.enableDraftSessions = false;
			// Debug log on for this run only — lets Stage D read back any
			// `parent_note` relocation deviation the engine recorded, for an exact
			// repro if the folder-note placement doesn't materialize.
			plugin.settings.enableDebugLog = true;
			await plugin.saveSettings();
		});
		// Best-effort pre-clean of a leftover DEST/ from a previously-interrupted
		// run of THIS spec (this folder name is unique to this spec; nothing
		// else in the suite ever writes it).
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
				plugin.settings.enableDebugLog = false;
				await plugin.saveSettings();
			}
			// Remove the debug log this run turned on — keep the vault clean.
			// @ts-expect-error — internal API
			const logFile = app.vault.getAbstractFileByPath('crosswalker-debug.log');
			// @ts-expect-error — internal API
			if (logFile) await app.vault.delete(logFile);
		});

		// Vault hygiene: wipe this run's generated output from the LIVE
		// (sandboxed) vault via the safety-checked helper — only deletes files
		// carrying the `_crosswalker.producer` marker, so a false match never
		// eats hand-authored content. Mirrors the `app.vault.adapter.basePath`
		// pattern wdio.conf.mts already uses to reach the sandboxed vault's real
		// filesystem path from inside a spec.
		try {
			const basePath = await browser.executeObsidian(({ app }) => {
				// @ts-expect-error — adapter.basePath is internal but stable
				return app.vault.adapter.basePath as string;
			});
			const result = wipeGeneratedOutput([DEST], basePath);
			console.log(
				`[report-graph] vault hygiene: matched [${result.matchedFolders.join(', ')}], ` +
					`deleted ${result.deletedFiles.length} generated note(s), skipped ${result.skippedNonGenerated.length} non-generated file(s)`
			);
		} catch (e) {
			console.log('[report-graph] FINDING: vault hygiene wipe failed — ' + (e as Error).message);
		}
	});

	it('shows the plan line, the home + parent notes, and the connected graph', async () => {
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
			dt.items.add(new File([csv], 'attack-report-graph-mini.csv'));
			input.files = dt.files;
			input.dispatchEvent(new Event('change'));
			await sleep(700);

			const next = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent?.includes('Next'));
			if (!next) return { ok: false as const, reason: 'NO_NEXT_BUTTON' };
			(next as HTMLButtonElement).click();

			const wb = await waitFor('.crosswalker-workbench', 8000);
			return { ok: !!wb, reason: wb ? 'OK' : 'NO_WORKBENCH' };
		}, ATTACK_RAGGED_CSV);
		console.log('[report-graph] open → ' + JSON.stringify(openInfo));
		expect(openInfo.ok).toBe(true);

		// -- Stage B: explicitly select "Inside its folder" placement in Connections
		//    card's placement chooser (only rendered because T1078/T1548 give the
		//    mapping a ragged tail) — deterministic, not relying on the ambient
		//    default so this run always produces T1078/T1078.md.
		const placement = await browser.executeObsidian(async () => {
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
			const wrap = await waitFor('.crosswalker-wb-placement', 6000);
			if (!wrap) return { ok: false as const, reason: 'NO_PLACEMENT_CHOOSER' };
			const folderCol = wrap.querySelector('[data-parent-note-value="folder-note"]');
			const radio = folderCol?.querySelector('input[type=radio]') as HTMLInputElement | null;
			if (!radio) return { ok: false as const, reason: 'NO_FOLDER_RADIO' };
			radio.click();
			radio.dispatchEvent(new Event('change', { bubbles: true }));
			await sleep(400);
			return { ok: true as const, checked: radio.checked };
		});
		console.log('[report-graph] placement → ' + JSON.stringify(placement));
		expect(placement.ok).toBe(true);
		if (placement.ok) expect(placement.checked).toBe(true);

		// -- Stage C: Step 2 → Step 3 (review). Set the destination, then
		//    screenshot the "What will be created" plan line.
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
			const planLine = await waitFor('.crosswalker-plan-line', 4000);
			return {
				ok: true as const,
				destPath,
				planText: planLine?.textContent ?? '',
				hasPlanLine: !!planLine,
			};
		}, DEST);
		console.log('[report-graph] review → ' + JSON.stringify(review));
		await browser.saveScreenshot(path.join(OUT, 'view-12-plan.png'));
		expect(review.ok).toBe(true);
		if (review.ok) {
			expect(review.destPath.replace(/\s+/g, '')).toContain(DEST);
			expect(review.hasPlanLine).toBe(true);
			expect(review.planText).toContain('What will be created:');
		}

		// -- Stage D: Step 3 → Step 4 (Generate) → click Generate → wait for close.
		const clickInfo = await browser.executeObsidian(async () => {
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
		console.log('[report-graph] click generate → ' + JSON.stringify(clickInfo));
		expect(clickInfo.ok).toBe(true);

		try {
			await browser.waitUntil(
				async () => browser.executeObsidian(() => !document.querySelector('.crosswalker-wizard-modal')),
				{ timeout: 20000, interval: 200, timeoutMsg: 'wizard modal did not close within 20s' }
			);
		} catch (e) {
			console.log('[report-graph] FINDING: ' + (e as Error).message + ' — proceeding anyway');
		}

		try {
			await browser.waitUntil(
				async () =>
					browser.executeObsidian(({ app }, dest: unknown) => {
						// @ts-expect-error — internal API
						return app.vault.getMarkdownFiles().filter((f: { path: string }) => f.path.startsWith(dest + '/')).length >= 10;
					}, DEST),
				{ timeout: 15000, interval: 300, timeoutMsg: 'fewer than 10 files materialized within 15s' }
			);
		} catch (e) {
			console.log('[report-graph] FINDING: ' + (e as Error).message + ' — proceeding anyway, will report actual count');
		}

		const genInfo = await browser.executeObsidian(async ({ app }, dest: unknown) => {
			const d = String(dest);
			// @ts-expect-error — internal API
			const files = app.vault.getMarkdownFiles().filter((f: { path: string }) => f.path.startsWith(d + '/'));
			// @ts-expect-error — internal API
			const rootHome = app.vault.getAbstractFileByPath(`${d}/${d}.md`);
			// @ts-expect-error — internal API
			const parent = app.vault.getAbstractFileByPath(`${d}/T1078/T1078.md`);
			const hubFiles = files.filter((f: any) => {
				// @ts-expect-error — internal API
				const fm = app.metadataCache.getFileCache(f)?.frontmatter;
				return fm?.kind === 'facet' || fm?.kind === 'hub';
			});
			return {
				ok: true as const,
				created: files.length,
				allPaths: files.map((f: { path: string }) => f.path).sort(),
				rootHomePath: rootHome?.path ?? null,
				parentNotePath: parent?.path ?? null,
				hubPaths: hubFiles.map((f: { path: string }) => f.path).sort(),
			};
		}, DEST);
		console.log('[report-graph] generate → ' + JSON.stringify(genInfo));
		expect(genInfo.ok).toBe(true);
		if (genInfo.ok && genInfo.created < 10) {
			console.log(`[report-graph] FINDING: only ${genInfo.created}/10 notes materialized under ${DEST}/. paths → ${JSON.stringify(genInfo.allPaths)}`);
		}
		if (genInfo.ok && !genInfo.rootHomePath) {
			console.log(`[report-graph] FINDING: no root home note at ${DEST}/${DEST}.md. paths → ${JSON.stringify(genInfo.allPaths)}`);
		}
		if (genInfo.ok && !genInfo.parentNotePath) {
			console.log(`[report-graph] FINDING: no folder-note parent at ${DEST}/T1078/T1078.md. paths → ${JSON.stringify(genInfo.allPaths)}`);
			// Exact repro capture: placement was set to "Inside its folder"
			// (Stage B confirmed `checked: true`) but the relocation didn't happen.
			// Dump the sibling T1078.md's own frontmatter (does it carry a
			// `children` list at all — i.e. did enrichment run for this parent —
			// or is relocation specifically the piece that didn't fire?) plus any
			// `parent_note` deviation the engine recorded to the debug log.
			const reloRepro = await browser.executeObsidian(async ({ app }, dest: unknown) => {
				const d = String(dest);
				// @ts-expect-error — internal API
				const sibling = app.vault.getAbstractFileByPath(`${d}/T1078.md`);
				// @ts-expect-error — internal API
				const siblingFm = sibling ? app.metadataCache.getFileCache(sibling)?.frontmatter : null;
				let debugLines: string[] = [];
				try {
					// @ts-expect-error — internal API
					const logFile = app.vault.getAbstractFileByPath('crosswalker-debug.log');
					if (logFile) {
						// @ts-expect-error — internal API
						const raw: string = await app.vault.read(logFile);
						debugLines = raw.split('\n').filter((l) => /parent_note|relocat|folder-note/i.test(l));
					}
				} catch { /* best-effort diagnostic only */ }
				return { siblingPath: sibling?.path ?? null, siblingFrontmatter: siblingFm ?? null, debugLines };
			}, DEST);
			console.log('[report-graph] relocation repro → ' + JSON.stringify(reloRepro));
		}

		// -- Stage E: root HOME NOTE, reading view — hub links + Contents section.
		const homeNoteInfo = await browser.executeObsidian(async ({ app }, argsRaw: unknown) => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const args = argsRaw as { rootHomePath: string | null; dest: string };
			const targetPath = args.rootHomePath ?? `${args.dest}/${args.dest}.md`;
			// @ts-expect-error — internal API
			const file = app.vault.getAbstractFileByPath(targetPath);
			if (!file) return { ok: false as const, reason: 'FILE_NOT_FOUND', path: targetPath };
			// @ts-expect-error — internal API
			const leaf = app.workspace.getLeaf(true);
			await leaf.openFile(file, { state: { mode: 'preview' } });
			await sleep(1200);
			const headings = Array.from(document.querySelectorAll('.workspace-leaf.mod-active :is(h1,h2,h3)')).map((h) => h.textContent?.trim());
			const linkCount = document.querySelectorAll('.workspace-leaf.mod-active a.internal-link').length;
			return { ok: true as const, path: targetPath, headings, linkCount };
		}, { rootHomePath: genInfo.ok ? genInfo.rootHomePath : null, dest: DEST });
		console.log('[report-graph] home note → ' + JSON.stringify(homeNoteInfo));
		await browser.saveScreenshot(path.join(OUT, 'view-13-home-note.png'));
		if (!homeNoteInfo.ok) {
			console.log('[report-graph] FINDING: could not open the root home note — ' + JSON.stringify(homeNoteInfo));
		} else {
			if (!homeNoteInfo.headings.some((h) => h?.includes('Contents'))) {
				console.log('[report-graph] FINDING: root home note has no "Contents" heading — ' + JSON.stringify(homeNoteInfo.headings));
			}
			if (homeNoteInfo.linkCount < 1) {
				console.log('[report-graph] FINDING: root home note rendered zero internal links');
			}
		}

		// -- Stage F: T1078/T1078.md folder-note parent, reading view — frontmatter
		//    children + the managed Contents body section.
		const parentNoteInfo = await browser.executeObsidian(async ({ app }, argsRaw: unknown) => {
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			const args = argsRaw as { parentNotePath: string | null; dest: string };
			const targetPath = args.parentNotePath ?? `${args.dest}/T1078/T1078.md`;
			// @ts-expect-error — internal API
			const file = app.vault.getAbstractFileByPath(targetPath);
			if (!file) return { ok: false as const, reason: 'FILE_NOT_FOUND', path: targetPath };
			// @ts-expect-error — internal API
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			// @ts-expect-error — internal API
			const leaf = app.workspace.getLeaf(true);
			await leaf.openFile(file, { state: { mode: 'preview' } });
			await sleep(1200);
			const headings = Array.from(document.querySelectorAll('.workspace-leaf.mod-active :is(h1,h2,h3)')).map((h) => h.textContent?.trim());
			const linkCount = document.querySelectorAll('.workspace-leaf.mod-active a.internal-link').length;
			return {
				ok: true as const,
				path: targetPath,
				children: Array.isArray(fm?.children) ? fm.children : null,
				headings,
				linkCount,
			};
		}, { parentNotePath: genInfo.ok ? genInfo.parentNotePath : null, dest: DEST });
		console.log('[report-graph] parent note → ' + JSON.stringify(parentNoteInfo));
		await browser.saveScreenshot(path.join(OUT, 'view-14-parent-note.png'));
		if (!parentNoteInfo.ok) {
			console.log('[report-graph] FINDING: could not open T1078/T1078.md — ' + JSON.stringify(parentNoteInfo));
		} else {
			if (!parentNoteInfo.children || parentNoteInfo.children.length !== 4) {
				console.log('[report-graph] FINDING: T1078/T1078.md frontmatter.children unexpected — ' + JSON.stringify(parentNoteInfo.children));
			}
			if (!parentNoteInfo.headings.some((h) => h?.includes('Contents'))) {
				console.log('[report-graph] FINDING: T1078/T1078.md has no "Contents" heading — ' + JSON.stringify(parentNoteInfo.headings));
			}
		}

		// -- Stage G: the connectedness money shot, attempt three. Give indexing
		//    up to 60s (heavy shared-tree load in prior attempts) THEN settle-poll
		//    the graph's own node count instead of a fixed layout-settle sleep —
		//    stable across 3 consecutive 500ms reads before screenshotting.
		try {
			await browser.waitUntil(
				async () =>
					browser.executeObsidian(() => {
						const notices = Array.from(document.querySelectorAll('.notice'));
						return !notices.some((n) => n.textContent?.includes('Indexing vault'));
					}),
				{ timeout: 60000, interval: 500, timeoutMsg: 'vault still showed "Indexing vault…" after 60s' }
			);
		} catch (e) {
			console.log('[report-graph] FINDING: ' + (e as Error).message + ' — proceeding anyway');
		}

		const graphOpen = await browser.executeObsidian(async (_a, dest: unknown) => {
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
			// The search box can render a beat after the leaf container itself —
			// retry-poll for it instead of a single snapshot check (this is exactly
			// the class of race that sank attempt two).
			let search: HTMLInputElement | null = null;
			const t1 = Date.now();
			while (Date.now() - t1 < 5000) {
				search = graphLeaf.querySelector('input[type="search"], .search-input-container input') as HTMLInputElement | null;
				if (search) break;
				await sleep(150);
			}
			let filtered = false;
			if (search) {
				search.focus();
				search.value = `path:${String(dest)}`;
				search.dispatchEvent(new Event('input', { bubbles: true }));
				filtered = true;
			}
			return {
				ok: true as const,
				filtered,
				query: `path:${String(dest)}`,
				// Diagnostic when the search box truly isn't found — what inputs DID
				// render in the leaf, so a follow-up attempt knows the real selector.
				availableInputs: search ? [] : Array.from(graphLeaf.querySelectorAll('input')).map((i) => i.outerHTML.slice(0, 120)),
			};
		}, DEST);
		console.log('[report-graph] graph open → ' + JSON.stringify(graphOpen));
		// Non-fatal by design (spec §"attempt three" doctrine): the screenshot
		// must be captured regardless of whether the UI-automation of the filter
		// succeeded, so a partial/broken state is still visible rather than
		// aborting the test before the money shot.
		if (!graphOpen.ok) {
			console.log('[report-graph] FINDING: graph leaf never opened — ' + JSON.stringify(graphOpen));
		} else if (!graphOpen.filtered) {
			console.log('[report-graph] FINDING: graph search box not found/filtered — screenshot will show the UNFILTERED whole-vault graph, not just ' + DEST + ' — ' + JSON.stringify(graphOpen));
		}

		// Settle-poll: read the graph engine's own node/link counts (best-effort —
		// internal API, several possible shapes across Obsidian versions) until 3
		// consecutive 500ms reads agree, or a 20s budget runs out.
		const readGraphCounts = async () =>
			browser.executeObsidian(() => {
				// @ts-expect-error — internal API, workspace leaves
				const leaf = app.workspace.getLeavesOfType('graph')[0];
				// @ts-expect-error — internal API
				const renderer = leaf?.view?.renderer;
				if (!renderer) return { nodes: null, links: null };
				const nodes = Array.isArray(renderer.nodes) ? renderer.nodes.length : renderer.nodes ? Object.keys(renderer.nodes).length : null;
				const links = Array.isArray(renderer.links) ? renderer.links.length : renderer.links ? Object.keys(renderer.links).length : null;
				return { nodes, links };
			});
		let lastNodes: number | null = null;
		let stableStreak = 0;
		let settled: { nodes: number | null; links: number | null } = { nodes: null, links: null };
		const settleStart = Date.now();
		while (Date.now() - settleStart < 20000) {
			const counts = await readGraphCounts();
			settled = counts;
			if (counts.nodes !== null && counts.nodes === lastNodes) {
				stableStreak++;
				if (stableStreak >= 3) break;
			} else {
				stableStreak = counts.nodes !== null ? 1 : 0;
			}
			lastNodes = counts.nodes;
			await browser.pause(500);
		}
		console.log(
			`[report-graph] graph settle → nodes=${settled.nodes} links=${settled.links} stableStreak=${stableStreak} elapsedMs=${Date.now() - settleStart}`
		);
		await browser.saveScreenshot(path.join(OUT, 'graph-01-connected.png'));

		if (settled.nodes === null) {
			console.log('[report-graph] FINDING: could not read graph renderer node count via internal API (leaf.view.renderer) — screenshot captured regardless for manual inspection.');
		} else if (settled.nodes === 0) {
			console.log('[report-graph] FINDING: graph rendered ZERO nodes for the path filter — likely a point cloud / empty state, not a connected graph.');
		} else if (settled.nodes === 1 && (settled.links ?? 0) === 0) {
			console.log('[report-graph] FINDING: graph rendered a single isolated node — a point cloud, not a connected graph.');
		}
	});
});
