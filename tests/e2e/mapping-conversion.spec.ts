/**
 * Slice 4 of the mapping table form: convert a mapping set between notes and a
 * table from the installed stacks panel, and finish or cancel an interrupted
 * job. Framework sources are synthetic; the mapping is the bundled
 * public-domain CSF-to-800-53 file shipped in the plugin, not a copied fixture.
 */
import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';

const OUT = path.resolve('test-screenshots');
const FOLDER = '_crosswalker/mappings/nist-csf-2-to-nist-800-53';
const nistHeaders = ['Control Identifier', 'Control (or Enhancement) Name', 'Control Text', 'Discussion', 'Related Controls'];

function workbook(sheet: string, columns: string[], values: Record<string, string>): number[] {
	const book = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([columns, columns.map((column) => values[column] ?? '')]), sheet);
	return Array.from(new Uint8Array(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })));
}

async function stackButton(label: string): Promise<void> {
	const clicked = await browser.executeObsidian((_obs, target) => {
		const root = document.querySelector('.crosswalker-stack-modal');
		const found = Array.from(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])
			.find((candidate) => candidate.textContent?.trim() === target
				|| (target === 'Import stack' && candidate.textContent?.trim().startsWith('Import stack (')));
		found?.click(); return !!found;
	}, label);
	expect(clicked).toBe(true);
	if (label !== 'Import stack') return;
	await browser.pause(200);
	await browser.executeObsidian(() => Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-stack-confirm button'))
		.find((candidate) => candidate.textContent?.trim() === 'Import')?.click());
}

async function modalButton(label: string): Promise<void> {
	const clicked = await browser.executeObsidian((_obs, target) => {
		const found = Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-conversion-modal button'))
			.find((candidate) => candidate.textContent?.trim() === target);
		found?.click(); return !!found;
	}, label);
	expect(clicked).toBe(true);
}

/** Open the workspace home until the mapping row matches, reopening while the vault indexes. */
async function homeUntilRow(match: { form?: 'notes' | 'table'; converting?: string | null; button?: string }, timeout = 90_000): Promise<string> {
	let text = '';
	await browser.waitUntil(async () => {
		const found = await browser.executeObsidian(async ({ app }, want) => {
			const find = () => {
				const row = document.querySelector<HTMLElement>('.crosswalker-workspace-view .crosswalker-mapping-set-row');
				if (!row) return null;
				if (want.form && row.dataset.setForm !== want.form) return null;
				if (want.converting === null && row.dataset.converting) return null;
				if (want.converting && row.dataset.converting !== want.converting) return null;
				const buttons = Array.from(row.querySelectorAll('button')).map((item) => item.textContent?.trim());
				if (want.button && !buttons.includes(want.button)) return null;
				return row.textContent ?? '';
			};
			const now = find();
			if (now !== null) return now;
			for (const leaf of app.workspace.getLeavesOfType('crosswalker-workspace')) leaf.detach();
			const leaf = app.workspace.getLeaf(true);
			await leaf.setViewState({ type: 'crosswalker-workspace', active: true });
			await app.workspace.revealLeaf(leaf);
			await new Promise((resolve) => setTimeout(resolve, 2500));
			return find();
		}, match);
		if (found === null) return false;
		text = found;
		return true;
	}, { timeout, interval: 500, timeoutMsg: `Mapping set row did not reach ${JSON.stringify(match)}` });
	return text;
}

async function rowButton(label: string): Promise<void> {
	const clicked = await browser.executeObsidian((_obs, target) => {
		const row = document.querySelector('.crosswalker-workspace-view .crosswalker-mapping-set-row');
		const found = Array.from(row?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((item) => item.textContent?.trim() === target);
		found?.click(); return !!found;
	}, label);
	expect(clicked).toBe(true);
}

async function capture(theme: 'light' | 'dark', fileName: string): Promise<void> {
	await browser.executeObsidian((_obs, value) => {
		document.querySelectorAll('.notice-container .notice').forEach((notice) => notice.remove());
		document.body.classList.toggle('theme-light', value === 'light');
		document.body.classList.toggle('theme-dark', value === 'dark');
	}, theme);
	await browser.pause(150);
	await browser.saveScreenshot(path.join(OUT, fileName));
}

async function waitForResult(timeout = 240_000): Promise<string> {
	await browser.waitUntil(async () => browser.executeObsidian(() => {
		const title = document.querySelector('.crosswalker-conversion-modal .modal-title')?.textContent ?? '';
		return title === 'Conversion finished' || title === 'Conversion stopped';
	}), { timeout, interval: 1000, timeoutMsg: 'Conversion did not finish' });
	return browser.executeObsidian(() => document.querySelector('.crosswalker-conversion-modal')?.textContent ?? '');
}

async function vaultState(): Promise<{ notes: number; tables: string[]; markers: string[] }> {
	return browser.executeObsidian(({ app }, folder) => ({
		notes: app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${folder}/`)).length,
		tables: app.vault.getFiles().filter((file) => file.path.endsWith('.mapping-table.tsv')).map((file) => file.path),
		markers: app.vault.getFiles().filter((file) => file.path.endsWith('.converting.json')).map((file) => file.path),
	}), FOLDER);
}

describe('Mapping set conversion between notes and a table', function () {
	this.timeout(900_000);
	before(() => { mkdirSync(OUT, { recursive: true }); });

	let setId = '';
	let noteCount = 0;
	let tablePath = '';
	let sampledPath = '';

	it('imports the bundled mapping as notes and marks one review on it', async () => {
		await browser.executeObsidian(async ({ app }, payloads) => {
			if (!app.vault.getAbstractFileByPath('Sources')) await app.vault.createFolder('Sources');
			for (const item of payloads) await app.vault.createBinary(`Sources/${item.name}`, new Uint8Array(item.bytes).buffer);
			// @ts-expect-error -- Obsidian internal command registry
			app.commands.executeCommandById('crosswalker:set-up-framework-stack');
		}, [
			{ name: 'synthetic-conv-csf.xlsx', bytes: workbook('CSF', ['element_identifier', 'element_type', 'text'], {
				element_identifier: 'GV.XX-01', element_type: 'subcategory', text: 'Invented CSF concept.' }) },
			{ name: 'synthetic-conv-nist.xlsx', bytes: workbook('Controls', nistHeaders, {
				'Control Identifier': 'ZZ-1', 'Control (or Enhancement) Name': 'Invented control',
				'Control Text': 'Invented control text.', Discussion: 'Invented discussion.', 'Related Controls': '' }) },
		]);
		await $('.crosswalker-stack-modal').waitForDisplayed();
		await browser.executeObsidian(() => {
			// Each change re-renders the picker, so the list is read again after every click.
			const want = new Set(['nist-csf-2', 'nist-800-53']);
			for (let guard = 0; guard < 20; guard++) {
				const wrong = Array.from(document.querySelectorAll<HTMLInputElement>('.crosswalker-stack-choice input[data-ontology]'))
					.find((input) => input.checked !== want.has(input.dataset.ontology ?? ''));
				if (!wrong) break;
				wrong.click();
			}
		});
		await stackButton('Next: download checklist');
		await stackButton('Next: add the files');
		await browser.executeObsidian(() => {
			const input = document.querySelector<HTMLInputElement>('.crosswalker-stack-modal input[placeholder="Sources"]');
			if (input) { input.value = 'Sources'; input.dispatchEvent(new Event('input', { bubbles: true })); }
		});
		await stackButton('Choose folder');
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			document.querySelectorAll('.crosswalker-stack-result[data-slot]').length === 2 &&
			Array.from(document.querySelectorAll('.crosswalker-stack-result[data-slot]')).every((row) => row.textContent?.includes('Recognized'))),
		{ timeout: 20_000, timeoutMsg: 'Synthetic CSF and NIST framework files did not recognize' }).catch(async (error) => {
			throw new Error(`${(error as Error).message}: ${await browser.executeObsidian(() => document.querySelector('.crosswalker-stack-modal')?.textContent ?? '')}`);
		});
		await stackButton('Next: review');
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			!(document.querySelector('.crosswalker-stack-total')?.textContent ?? '').includes('Counting')),
		{ timeout: 30_000, timeoutMsg: 'Review counts did not finish' });
		await stackButton('Import stack');
		await browser.waitUntil(async () => browser.executeObsidian(() => {
			const modal = document.querySelector('.crosswalker-stack-modal');
			return (modal?.querySelector('h2')?.textContent ?? '') === 'Framework stack imported';
		}), { timeout: 240_000, timeoutMsg: 'Bundled mapping import did not finish' });
		await stackButton('Done');

		const text = await homeUntilRow({ form: 'notes', converting: null, button: 'Convert to table' });
		setId = /set (iset-[a-z0-9-]+)/.exec(text)?.[1] ?? '';
		expect(setId).not.toBe('');
		const state = await vaultState();
		noteCount = state.notes;
		expect(noteCount).toBeGreaterThan(100);
		expect(state.tables).toEqual([]);

		// One review on one mapping note, set the way a reviewer would.
		sampledPath = await browser.executeObsidian(async ({ app }, folder) => {
			const file = app.vault.getMarkdownFiles().filter((item) => item.path.startsWith(`${folder}/`)).sort((a, b) => a.path.localeCompare(b.path))[0];
			await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				frontmatter.review_status = 'approved';
				frontmatter.reviewer = 'Invented reviewer';
			});
			return file.path;
		}, FOLDER);
		await browser.waitUntil(async () => browser.executeObsidian(({ app }, file) => {
			const note = app.vault.getAbstractFileByPath(file);
			// @ts-expect-error -- TFile check is structural in the page
			return app.metadataCache.getFileCache(note)?.frontmatter?.reviewer === 'Invented reviewer';
		}, sampledPath), { timeout: 10_000, timeoutMsg: 'Review value did not index' });
	});

	it('converts to a table after a confirmation that names the trade-off', async () => {
		expect(setId).not.toBe('');
		await rowButton('Convert to table');
		await $('.crosswalker-conversion-modal').waitForDisplayed();
		const confirm = await browser.executeObsidian(() => document.querySelector('.crosswalker-conversion-modal')?.textContent ?? '');
		expect(confirm).toContain('will not appear in Bases views, graph view or backlinks');
		expect(confirm).toContain(`Moves ${noteCount.toLocaleString()} notes to the trash after the table is verified.`);
		await capture('light', 'visual-conversion-01-confirm-table.png');
		await capture('dark', 'visual-conversion-01-confirm-table-dark.png');
		await modalButton('Convert to table');
		const result = await waitForResult();
		expect(result).toContain(`${noteCount.toLocaleString()} mappings`);
		expect(result).toContain('1 review carried over');
		await modalButton('Done');

		const state = await vaultState();
		expect(state.notes).toBe(0);
		expect(state.tables).toHaveLength(1);
		expect(state.markers).toEqual([]);
		tablePath = state.tables[0];
		expect(tablePath.startsWith(`${FOLDER}/`)).toBe(true);
		const table = await browser.executeObsidian(async ({ app }, file) => app.vault.adapter.read(file), tablePath);
		expect(table).toContain('Invented reviewer');

		const row = await homeUntilRow({ form: 'table', converting: null, button: 'Convert to notes' });
		expect(row).toContain(`1 mapping table, ${noteCount.toLocaleString()} rows`);
		await browser.executeObsidian(() => document.querySelector('.crosswalker-workspace-view .crosswalker-mapping-set-row')?.scrollIntoView({ block: 'center' }));
		await capture('light', 'visual-conversion-02-finished-table-row.png');
		await capture('dark', 'visual-conversion-02-finished-table-row-dark.png');
	});

	it('converts back to notes and keeps every note and the review', async () => {
		expect(tablePath).not.toBe('');
		await rowButton('Convert to notes');
		await $('.crosswalker-conversion-modal').waitForDisplayed();
		// Below the stack file threshold the job starts without a second question.
		const result = await waitForResult();
		expect(result).toContain('Conversion finished');
		expect(result).toContain(`${noteCount.toLocaleString()} mappings`);
		await modalButton('Done');
		const state = await vaultState();
		expect(state.notes).toBe(noteCount);
		expect(state.tables).toEqual([]);
		expect(state.markers).toEqual([]);
		await browser.waitUntil(async () => browser.executeObsidian(({ app }, folder) => {
			const reviewed = app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${folder}/`))
				.map((file) => app.metadataCache.getFileCache(file)?.frontmatter)
				.filter((frontmatter) => frontmatter?.reviewer === 'Invented reviewer');
			return reviewed.length === 1 && reviewed[0]?.review_status === 'approved';
		}, FOLDER), { timeout: 60_000, timeoutMsg: 'Sampled review did not survive the round trip' });
		await homeUntilRow({ form: 'notes', converting: null, button: 'Convert to table' });
		await browser.executeObsidian(() => document.querySelector('.crosswalker-workspace-view .crosswalker-mapping-set-row')?.scrollIntoView({ block: 'center' }));
		await capture('light', 'visual-conversion-03-finished-notes-row.png');
	});

	it('finishes a conversion interrupted in writing from the row', async () => {
		expect(setId && tablePath).toBeTruthy();
		const marker = `${FOLDER}/${setId}.converting.json`;
		await browser.executeObsidian(async ({ app }, input) => {
			await app.vault.create(input.marker, `${JSON.stringify({
				format: 'crosswalker-conversion-v1', import_set: input.setId, from: 'notes', to: 'table', phase: 'writing',
				target_path: input.tablePath, source_count: input.noteCount, started_at: '2026-09-30T00:00:00.000Z', plugin_version: 'e2e',
			}, null, 2)}\n`);
		}, { marker, setId, tablePath, noteCount });
		const row = await homeUntilRow({ converting: 'writing', button: 'Finish' });
		expect(row).toContain('Converting to table (writing)');
		expect(row).toContain('Cancel');
		await browser.executeObsidian(() => document.querySelector('.crosswalker-workspace-view .crosswalker-mapping-set-row')?.scrollIntoView({ block: 'center' }));
		await capture('light', 'visual-conversion-04-interrupted-row.png');
		await capture('dark', 'visual-conversion-04-interrupted-row-dark.png');
		await rowButton('Finish');
		await $('.crosswalker-conversion-modal').waitForDisplayed();
		const result = await waitForResult();
		expect(result).toContain('Conversion finished');
		await modalButton('Done');
		const state = await vaultState();
		expect(state.notes).toBe(0);
		expect(state.tables).toEqual([tablePath]);
		expect(state.markers).toEqual([]);
		await homeUntilRow({ form: 'table', converting: null, button: 'Convert to notes' });
	});

	it('announces an interrupted job on load and cancels it without touching the source', async () => {
		expect(setId && tablePath).toBeTruthy();
		const marker = `${FOLDER}/${setId}.converting.json`;
		const tableBefore = await browser.executeObsidian(async ({ app }, file) => app.vault.adapter.read(file), tablePath);
		await browser.executeObsidian(async ({ app }, input) => {
			await app.vault.create(input.marker, `${JSON.stringify({
				format: 'crosswalker-conversion-v1', import_set: input.setId, from: 'table', to: 'notes', phase: 'writing',
				target_path: input.folder, source_count: input.noteCount, started_at: '2026-09-30T00:00:00.000Z', plugin_version: 'e2e',
			}, null, 2)}\n`);
			document.querySelectorAll('.notice-container .notice').forEach((notice) => notice.remove());
			// @ts-expect-error -- Obsidian plugin manager internal
			await app.plugins.disablePlugin('crosswalker');
			// @ts-expect-error -- Obsidian plugin manager internal
			await app.plugins.enablePlugin('crosswalker');
		}, { marker, setId, folder: FOLDER, noteCount });
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			Array.from(document.querySelectorAll('.notice')).some((notice) =>
				(notice.textContent ?? '').includes('A mapping set conversion was interrupted. Finish converting')
				&& !!notice.querySelector('button.crosswalker-conversion-finish'))),
		{ timeout: 60_000, timeoutMsg: 'Startup notice for the interrupted conversion did not appear' });
		await browser.saveScreenshot(path.join(OUT, 'visual-conversion-05-startup-notice.png'));
		const commands = await browser.executeObsidian(({ app }) =>
			// @ts-expect-error -- Obsidian internal command registry
			Object.keys(app.commands.commands).filter((id: string) => id === 'crosswalker:finish-mapping-conversions'));
		expect(commands).toEqual(['crosswalker:finish-mapping-conversions']);
		await browser.executeObsidian(() => document.querySelectorAll('.notice-container .notice').forEach((notice) => notice.remove()));
		await homeUntilRow({ converting: 'writing', button: 'Cancel' });
		await rowButton('Cancel');
		await browser.waitUntil(async () => (await vaultState()).markers.length === 0,
			{ timeout: 20_000, timeoutMsg: 'Cancel did not remove the marker' });
		const state = await vaultState();
		expect(state.tables).toEqual([tablePath]);
		expect(state.notes).toBe(0);
		expect(await browser.executeObsidian(async ({ app }, file) => app.vault.adapter.read(file), tablePath)).toBe(tableBefore);
		await homeUntilRow({ form: 'table', converting: null, button: 'Convert to notes' });
	});

	it('redraws the open stacks panel after the command finishes an interrupted job', async () => {
		expect(setId && tablePath).toBeTruthy();
		const marker = `${FOLDER}/${setId}.converting.json`;
		await browser.executeObsidian(async ({ app }, input) => {
			await app.vault.create(input.marker, `${JSON.stringify({
				format: 'crosswalker-conversion-v1', import_set: input.setId, from: 'table', to: 'notes', phase: 'writing',
				target_path: input.folder, source_count: input.noteCount, started_at: '2026-09-30T00:00:00.000Z', plugin_version: 'e2e',
			}, null, 2)}\n`);
		}, { marker, setId, folder: FOLDER, noteCount });
		await homeUntilRow({ converting: 'writing', button: 'Finish' });
		// Tag the open view: the panel must redraw in place, not by reopening the tab.
		await browser.executeObsidian(({ app }) => {
			// @ts-expect-error -- Obsidian internal command registry
			app.commands.executeCommandById('crosswalker:finish-mapping-conversions');
			const view = document.querySelector<HTMLElement>('.crosswalker-workspace-view');
			if (view) view.dataset.e2eSameLeaf = 'yes';
		});
		await browser.waitUntil(async () => browser.executeObsidian(() => {
			const view = document.querySelector<HTMLElement>('.crosswalker-workspace-view');
			const row = view?.querySelector<HTMLElement>('.crosswalker-mapping-set-row');
			return view?.dataset.e2eSameLeaf === 'yes' && row?.dataset.setForm === 'notes' && !row.dataset.converting;
		}), { timeout: 240_000, interval: 1000, timeoutMsg: 'The open stacks panel did not redraw after the command finished the conversion' });
		const state = await vaultState();
		expect(state.notes).toBe(noteCount);
		expect(state.tables).toEqual([]);
		expect(state.markers).toEqual([]);
	});
});
