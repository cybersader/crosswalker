/**
 * first-run.spec.ts — regression walkthrough from a genuinely empty vault.
 *
 * The paired wdio.first-run.conf.mts points this spec at first-run-vault, which
 * contains only minimal Obsidian core/community-plugin enablement. It has no
 * seed notes, saved Crosswalker configuration, or plugin data.json.
 *
 * Run:
 *   DISPLAY=:0 bun x wdio run wdio.first-run.conf.mts
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';

const OUT = path.resolve('test-screenshots');
const CORPUS = path.resolve('Frameworks/NIST_SP-800-53_rev5_catalog_load.csv');
const SOURCE_FILE_NAME = 'NIST_SP-800-53_rev5_catalog_load.csv';
const WANTED = [
	'AC-1', 'AC-2', 'AC-2(1)', 'AC-3', 'AC-5', 'AC-6',
	'AU-1', 'AU-2', 'AU-3', 'IA-2', 'SC-7', 'SI-4',
];

interface CorpusRow { identifier: string; [key: string]: string }

async function waitForDom(selector: string, timeoutMs = 12_000): Promise<boolean> {
	return browser.executeObsidian(async (_obs, args) => {
		const started = Date.now();
		while (Date.now() - started < args.timeoutMs) {
			const el = document.querySelector(args.selector);
			if (el && (el as HTMLElement).isConnected) return true;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return false;
	}, { selector, timeoutMs });
}

async function capture(fileName: string, selector?: string): Promise<void> {
	const state = await browser.executeObsidian((_obs, target) => {
		const root = target ? document.querySelector(target) : document.body;
		const notices = Array.from(document.querySelectorAll<HTMLElement>('.notice')).map((el) => el.innerText.trim());
		return {
			selector: target ?? 'body',
			text: (root as HTMLElement | null)?.innerText?.trim().slice(0, 8000) ?? '',
			notices,
			activeElement: (document.activeElement as HTMLElement | null)?.outerHTML?.slice(0, 500) ?? '',
		};
	}, selector ?? '');
	console.log(`[first-run:${fileName}] ${JSON.stringify(state)}`);
	await browser.saveScreenshot(path.join(OUT, fileName));
}

async function openCommandPalette(query: string): Promise<string[]> {
	// Use the same keyboard entry point a person uses, then type the visible query.
	await browser.keys(['Control', 'p']);
	const opened = await waitForDom('.prompt-input', 8_000);
	if (!opened) {
		// Keep the observation moving if Electron consumed the shortcut. This still
		// opens Obsidian's real command palette, rather than invoking Crosswalker.
		await browser.executeObsidian(({ app }) => {
			// @ts-expect-error — Obsidian's internal command registry is not typed.
			app.commands.executeCommandById('command-palette:open');
		});
		expect(await waitForDom('.prompt-input', 8_000)).toBe(true);
	}
	await browser.keys(query.split(''));
	await browser.pause(350);
	return browser.executeObsidian(() => Array.from(document.querySelectorAll<HTMLElement>('.suggestion-item'))
		.filter((el) => el.getClientRects().length > 0)
		.map((el) => el.innerText.trim()));
}

async function clickPaletteItem(containing: string): Promise<boolean> {
	return browser.executeObsidian((_obs, label) => {
		const item = Array.from(document.querySelectorAll<HTMLElement>('.suggestion-item'))
			.find((el) => el.getClientRects().length > 0 && el.innerText.includes(label));
		item?.click();
		return Boolean(item);
	}, containing);
}

async function clickVisibleButton(rootSelector: string, label: string): Promise<boolean> {
	return browser.executeObsidian((_obs, args) => {
		const root = document.querySelector(args.rootSelector);
		const button = Array.from(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])
			.find((el) => el.getClientRects().length > 0 && el.textContent?.trim() === args.label);
		button?.click();
		return Boolean(button);
	}, { rootSelector, label });
}

async function clickPrimaryNav(): Promise<boolean> {
	return browser.executeObsidian(() => {
		const root = document.querySelector('.crosswalker-workspace-flow');
		const button = root?.querySelector<HTMLButtonElement>('.crosswalker-nav-right button');
		button?.click();
		return Boolean(button);
	});
}

async function observeAutomaticStartupProjection(): Promise<any> {
	return browser.executeObsidian(async ({ app }) => {
		// @ts-expect-error — internal plugin registry used only by E2E.
		const plugin = app.plugins.plugins.crosswalker;
		const deadline = Date.now() + 30_000;
		let terminal: any = null;
		while (Date.now() < deadline) {
			terminal = plugin.debug.getRingBuffer().find((event: any) =>
				event.category === 'tier2'
				&& (event.op === 'auto-projection-complete' || event.op === 'auto-projection-failed'));
			if (terminal) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const pluginPath = `${app.vault.configDir}/plugins/${plugin.manifest.id}`;
		const listed = await app.vault.adapter.list(pluginPath);
		const fileNames = listed.files.map((value: string) => value.split('/').pop() ?? value).sort();
		const handle = plugin.tier2Handle;
		const diagnostics = terminal ? {
			trace_id: terminal.trace_id,
			readiness: terminal.readiness,
			errorTotal: terminal.errorTotal,
			errorSamples: terminal.errorSamples,
			errorSamplesTruncated: terminal.errorSamplesTruncated,
		} : null;
		if (!terminal || terminal.op !== 'auto-projection-complete' || !handle) {
			return { terminal, diagnostics, handlePresent: Boolean(handle), fileNames, counts: {}, status: {} };
		}
		const countRows = handle.db.exec({
			sql: `
				SELECT 'concepts', COUNT(*) FROM concepts
				UNION ALL SELECT 'mappings', COUNT(*) FROM mappings
				UNION ALL SELECT 'junction_notes', COUNT(*) FROM junction_notes
				UNION ALL SELECT 'ontologies', COUNT(*) FROM ontologies
			`,
			rowMode: 'array',
			returnValue: 'resultRows',
		}) as unknown[][];
		const statusRows = handle.db.exec({
			sql: "SELECT key, value FROM schema_meta WHERE key IN ('last_projected_at','last_projection_mode','last_projection_success') ORDER BY key",
			rowMode: 'array',
			returnValue: 'resultRows',
		}) as unknown[][];
		return {
			terminal,
			diagnostics,
			handlePresent: true,
			fileNames,
			counts: Object.fromEntries(countRows.map((row) => [String(row[0]), Number(row[1])])),
			status: Object.fromEntries(statusRows.map((row) => [String(row[0]), String(row[1])])),
		};
	});
}

function makeNistSlice(): { csv: string; columns: string[]; rows: CorpusRow[] } {
	const parsed = Papa.parse<CorpusRow>(readFileSync(CORPUS, 'utf8'), {
		header: true,
		skipEmptyLines: true,
	});
	if (parsed.errors.length > 0) throw new Error(`NIST CSV parse failed: ${parsed.errors[0].message}`);
	const columns = parsed.meta.fields ?? [];
	const byId = new Map(parsed.data.map((row) => [row.identifier, row]));
	const rows = WANTED.map((id) => byId.get(id)).filter((row): row is CorpusRow => Boolean(row));
	if (rows.length !== WANTED.length) throw new Error(`Expected ${WANTED.length} real NIST rows; found ${rows.length}`);
	return {
		columns,
		rows,
		csv: Papa.unparse({ fields: columns, data: rows.map((row) => columns.map((column) => row[column] ?? '')) }, { newline: '\n' }),
	};
}

describe('First run — empty vault walkthrough', function () {
	this.timeout(300_000);

	const nist = makeNistSlice();

	before(() => {
		mkdirSync(OUT, { recursive: true });
	});

	it('walks from first load through import, evidence linking, and coverage', async () => {
		// 01 — genuine first frame. No pre-test cleanup or settings mutation: this is
		// exactly what the installed plugin and Obsidian chose to show by themselves.
		await capture('first-run-01-plugin-loaded.png');

		const startup = await browser.executeObsidian(({ app }) => {
			// @ts-expect-error — internal plugin registry.
			const loaded = Boolean(app.plugins.plugins.crosswalker);
			return {
				loaded,
				vaultFiles: app.vault.getFiles().map((file) => file.path).sort(),
				markdownFiles: app.vault.getMarkdownFiles().map((file) => file.path).sort(),
				rootChildren: app.vault.getRoot().children.map((file) => file.path).sort(),
				statusBar: document.querySelector('.crosswalker-status-bar-item')?.textContent?.trim() ?? '',
				notices: Array.from(document.querySelectorAll<HTMLElement>('.notice')).map((el) => el.innerText.trim()),
				ribbonLabel: document.querySelector('[aria-label="Open Crosswalker workspace"]')?.getAttribute('aria-label') ?? '',
			};
		});
		console.log('[first-run:startup] ' + JSON.stringify(startup));
		expect(startup.loaded).toBe(true);

		// Automatic-startup witness. Do not call runProjection() or openTier2() here:
		// either could make a broken startup path look green. The in-memory debug ring
		// proves the layout-ready pass completed, and the already-open handle proves
		// its exact empty-vault result and durable full/succeeded stamp.
		const startupProjection = await observeAutomaticStartupProjection();
		console.log('[first-run:auto-projection] ' + JSON.stringify(startupProjection));
		expect(startupProjection.terminal?.op).toBe('auto-projection-complete');
		expect(startupProjection.terminal?.success).toBe(true);
		expect(startupProjection.terminal?.aborted).toBe(false);
		expect(startupProjection.terminal?.readiness?.pending).toBe(0);
		expect(startupProjection.terminal?.readiness?.timedOut).toBe(false);
		expect(startupProjection.handlePresent).toBe(true);
		expect(startupProjection.counts).toEqual({
			concepts: 0,
			mappings: 0,
			junction_notes: 0,
			ontologies: 0,
		});
		expect(startupProjection.status.last_projection_mode).toBe('full');
		expect(startupProjection.status.last_projection_success).toBe('true');
		expect(startupProjection.status.last_projected_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(startupProjection.fileNames).not.toContain('sqlite3.wasm');
		expect(startupProjection.fileNames).not.toContain('sqlite3.mjs');

		// 02 — inspect the only new vault folder a curious person can see. This does
		// not reveal an active file; it only expands the folder already in Explorer.
		const expandedHelper = await browser.executeObsidian(() => {
			const title = Array.from(document.querySelectorAll<HTMLElement>('.nav-folder-title'))
				.find((el) => el.querySelector('.nav-folder-title-content')?.textContent?.trim() === '_crosswalker');
			title?.click();
			return Boolean(title);
		});
		console.log('[first-run:helper-folder-expanded] ' + expandedHelper);
		await browser.pause(250);
		await capture('first-run-02-generated-helper-folder.png');

		// 03 — what "crosswalker" offers in the command palette.
		const initialCommands = await openCommandPalette('crosswalker');
		console.log('[first-run:palette-all] ' + JSON.stringify(initialCommands));
		expect(initialCommands).toEqual(expect.arrayContaining([
			expect.stringContaining('Start here: open workspace'),
			expect.stringContaining('Start here: import structured data'),
		]));
		expect(initialCommands.join('\n')).not.toMatch(/Tier 2|projection|sidecar|ontology|debug|\bperf\b|migration|query index/i);
		await capture('first-run-03-command-palette.png', '.prompt');

		// Enter the workspace through the palette, not an internal view API.
		expect(await clickPaletteItem('Start here: open workspace')).toBe(true);
		expect(await waitForDom('.crosswalker-workspace-view', 12_000)).toBe(true);
		await browser.pause(350);
		await capture('first-run-04-workspace-empty.png', '.crosswalker-workspace-view');

		// 05 — Step 1 before a file is selected. This is where the new framework
		// sources link must be visible and understandable.
		expect(await clickVisibleButton('.crosswalker-workspace-view', 'Import structured data')).toBe(true);
		expect(await waitForDom('.crosswalker-workspace-flow input[type=file]', 12_000)).toBe(true);
		const sourceHelp = await browser.executeObsidian(() => {
			const link = document.querySelector<HTMLAnchorElement>('.crosswalker-workspace-flow a[href*="framework-data-sources"]');
			if (!link) return null;
			const style = getComputedStyle(link);
			const rect = link.getBoundingClientRect();
			return {
				text: link.textContent?.trim() ?? '',
				href: link.href,
				visible: rect.width > 0 && rect.height > 0,
				color: style.color,
				decoration: style.textDecorationLine,
				top: rect.top,
			};
		});
		console.log('[first-run:framework-source-link] ' + JSON.stringify(sourceHelp));
		await capture('first-run-05-import-step-1.png', '.crosswalker-workspace-flow');

		// 06 — select a real NIST 800-53 source, reduced to 12 real corpus rows only
		// so the renderer stays responsive enough to photograph the journey.
		const selected = await browser.executeObsidian(async (_obs, args) => {
			const root = document.querySelector('.crosswalker-workspace-flow');
			const input = root?.querySelector<HTMLInputElement>('input[type=file]');
			if (!input) return false;
			const dt = new DataTransfer();
			dt.items.add(new File([args.csv], args.fileName, { type: 'text/csv' }));
			input.files = dt.files;
			input.dispatchEvent(new Event('change'));
			const started = Date.now();
			while (Date.now() - started < 8_000) {
				if (document.querySelector('.crosswalker-workspace-flow .crosswalker-file-card')) return true;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			return false;
		}, { csv: nist.csv, fileName: SOURCE_FILE_NAME });
		expect(selected).toBe(true);
		await capture('first-run-06-import-step-1-file-selected.png', '.crosswalker-workspace-flow');

		// First Next parses, then deliberately holds on the recognized-source card.
		expect(await clickPrimaryNav()).toBe(true);
		expect(await waitForDom('.crosswalker-recognized-card', 20_000)).toBe(true);
		await browser.pause(250);
		await capture('first-run-07-recognized-source.png', '.crosswalker-workspace-flow');

		// 08 — take the visible escape hatch so the complete Step 2 is observed.
		expect(await clickVisibleButton('.crosswalker-workspace-flow', 'Customize')).toBe(true);
		expect(await waitForDom('.crosswalker-workbench', 12_000)).toBe(true);
		await browser.pause(250);
		await capture('first-run-08-import-step-2-workbench.png', '.crosswalker-workspace-flow');

		// 09 — review. This is where destination, note count, configuration source,
		// and import-set semantics have to make sense before anything is written.
		expect(await clickPrimaryNav()).toBe(true);
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			document.querySelector('.crosswalker-step-indicator')?.textContent?.trim() === 'Step 3 of 4'), {
			timeout: 15_000,
			interval: 200,
			timeoutMsg: 'wizard did not reach review step',
		});
		await capture('first-run-09-import-step-3-review.png', '.crosswalker-workspace-flow');

		// 10 — final generate screen before committing the write.
		expect(await clickPrimaryNav()).toBe(true);
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			document.querySelector('.crosswalker-step-indicator')?.textContent?.trim() === 'Step 4 of 4'), {
			timeout: 15_000,
			interval: 200,
			timeoutMsg: 'wizard did not reach generate step',
		});
		await capture('first-run-10-import-step-4-generate.png', '.crosswalker-workspace-flow');

		// 11 — generate using the same button the person sees. Success returns the
		// in-view flow to the workspace home rather than opening any hidden leaf.
		expect(await clickVisibleButton('.crosswalker-nav-right', 'Generate')).toBe(true);
		await browser.waitUntil(async () => browser.executeObsidian(() => {
			const view = document.querySelector('.crosswalker-workspace-view');
			return Boolean(view && !view.classList.contains('is-flow-active'));
		}), {
			timeout: 90_000,
			interval: 500,
			timeoutMsg: 'import did not return to workspace home',
		});
		await browser.waitUntil(async () => browser.executeObsidian(() => {
			const workspaceText = document.querySelector<HTMLElement>('.crosswalker-workspace-view')?.innerText ?? '';
			const statusBar = document.querySelector('.crosswalker-status-bar-item')?.textContent?.trim() ?? '';
			return workspaceText.includes('NIST 800-53 Rev 5') && statusBar === 'Crosswalker: 1 framework';
		}), {
			timeout: 15_000,
			interval: 200,
			timeoutMsg: 'workspace and status bar did not recognize the completed flat import',
		});
		const postImport = await browser.executeObsidian(({ app }) => ({
			markdownFiles: app.vault.getMarkdownFiles().map((file) => file.path).sort(),
			rootChildren: app.vault.getRoot().children.map((file) => file.path).sort(),
			workspaceText: document.querySelector<HTMLElement>('.crosswalker-workspace-view')?.innerText.trim() ?? '',
			statusBar: document.querySelector('.crosswalker-status-bar-item')?.textContent?.trim() ?? '',
			notices: Array.from(document.querySelectorAll<HTMLElement>('.notice')).map((el) => el.innerText.trim()),
		}));
		console.log('[first-run:post-import] ' + JSON.stringify(postImport));
		expect(postImport.workspaceText).toContain('NIST 800-53 Rev 5');
		expect(postImport.workspaceText).toContain('12 notes');
		expect(postImport.workspaceText).not.toContain('Nothing imported yet');
		expect(postImport.statusBar).toBe('Crosswalker: 1 framework');
		await capture('first-run-11-vault-after-import.png');

		// 12/13 — evidence linking, reached through the command palette. Capture the
		// command label first, then the form a newcomer is expected to complete.
		const evidenceCommands = await openCommandPalette('crosswalker link evidence');
		console.log('[first-run:palette-evidence] ' + JSON.stringify(evidenceCommands));
		await capture('first-run-12-evidence-command.png', '.prompt');
		expect(await clickPaletteItem('Evidence: link evidence to a control')).toBe(true);
		expect(await waitForDom('.modal', 10_000)).toBe(true);
		await browser.pause(250);
		await capture('first-run-13-evidence-link.png', '.modal');
		await browser.keys('Escape');
		await browser.pause(250);

		// 14/15 — coverage, again through the palette. The command must refresh its
		// own report data and open a report; a successful import can never be
		// translated back into "import a framework first" by a stale derived store.
		const coverageCommands = await openCommandPalette('crosswalker evidence coverage report');
		console.log('[first-run:palette-coverage] ' + JSON.stringify(coverageCommands));
		await capture('first-run-14-coverage-command.png', '.prompt');
		expect(await clickPaletteItem('Evidence: create coverage report')).toBe(true);
		await browser.waitUntil(async () => browser.executeObsidian(({ app }) =>
			(app.workspace.getActiveFile()?.path ?? '').startsWith('Reports/Evidence coverage - ')), {
			timeout: 45_000,
			interval: 300,
			timeoutMsg: 'coverage command did not open a report after the import',
		});
		await browser.pause(500);
		const reportState = await browser.executeObsidian(({ app }) => ({
			activeFile: app.workspace.getActiveFile()?.path ?? '',
			notices: Array.from(document.querySelectorAll<HTMLElement>('.notice')).map((el) => el.innerText.trim()),
			modalText: Array.from(document.querySelectorAll<HTMLElement>('.modal')).filter((el) => el.getClientRects().length > 0).map((el) => el.innerText.trim()),
			markdownText: document.querySelector<HTMLElement>('.markdown-preview-view, .cm-editor')?.innerText?.trim().slice(0, 6000) ?? '',
		}));
		console.log('[first-run:coverage-result] ' + JSON.stringify(reportState));
		expect(reportState.activeFile).toBe('Reports/Evidence coverage - nist-800-53.md');
		expect(reportState.notices.join('\n')).not.toContain('Import a framework first');
		expect(reportState.markdownText).toContain('Evidence coverage');
		await capture('first-run-15-coverage-result.png');

		// Hard proof that this was not the shared seed masquerading as first run.
		expect(startup.markdownFiles).toEqual(expect.arrayContaining(['_crosswalker/SKILL.md']));
		expect(startup.markdownFiles.some((file) => file.startsWith('Frameworks/'))).toBe(false);
		expect(postImport.markdownFiles.filter((file) => file.startsWith('Ontologies/') || file.startsWith('Frameworks/')).length).toBeGreaterThanOrEqual(WANTED.length);
	});
});
