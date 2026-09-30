/**
 * Slice 5 of the mapping table form: review a table-form mapping set in the
 * mapping review view. Imports the bundled mapping as a table through the
 * framework stack flow, opens Review mappings from the installed stacks panel,
 * edits one row, bulk-edits a filtered selection, and proves each edit reached
 * the file and survives a plugin reload. Framework sources are synthetic; the
 * mapping is the bundled public-domain CSF-to-800-53 file shipped in the
 * plugin, not a copied fixture. Every review value written here is invented.
 */
import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';

const OUT = path.resolve('test-screenshots');
const nistHeaders = ['Control Identifier', 'Control (or Enhancement) Name', 'Control Text', 'Discussion', 'Related Controls'];
/** Column positions in the table codec (src/mappings/mapping-table.ts COLUMNS). */
const COL = { row_id: 0, subject_id: 1, review_status: 14, reviewer: 15 } as const;

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

/** Open the workspace home until the table set's row offers Review mappings, reopening while the vault indexes. */
async function homeUntilReviewRow(timeout = 90_000): Promise<string> {
	let text = '';
	await browser.waitUntil(async () => {
		const found = await browser.executeObsidian(async ({ app }) => {
			const find = () => {
				const row = document.querySelector<HTMLElement>('.crosswalker-workspace-view .crosswalker-mapping-set-row[data-set-form="table"]');
				if (!row || row.dataset.converting) return null;
				const buttons = Array.from(row.querySelectorAll('button')).map((item) => item.textContent?.trim());
				return buttons.includes('Review mappings') ? row.textContent ?? '' : null;
			};
			const now = find();
			if (now !== null) return now;
			for (const leaf of app.workspace.getLeavesOfType('crosswalker-workspace')) leaf.detach();
			const leaf = app.workspace.getLeaf(true);
			await leaf.setViewState({ type: 'crosswalker-workspace', active: true });
			await app.workspace.revealLeaf(leaf);
			await new Promise((resolve) => setTimeout(resolve, 2500));
			return find();
		});
		if (found === null) return false;
		text = found;
		return true;
	}, { timeout, interval: 500, timeoutMsg: 'The table set row never offered Review mappings' });
	return text;
}

async function capture(theme: 'light' | 'dark', fileName: string): Promise<void> {
	await browser.executeObsidian(({ app }, value) => {
		// The grid is wide; with the file explorer collapsed the review columns are in the shot.
		app.workspace.leftSplit.collapse();
		document.querySelectorAll('.notice-container .notice').forEach((notice) => notice.remove());
		document.body.classList.toggle('theme-light', value === 'light');
		document.body.classList.toggle('theme-dark', value === 'dark');
	}, theme);
	await browser.pause(250);
	await browser.saveScreenshot(path.join(OUT, fileName));
}

/** Wait until the view's status line reads Saved with no edit pending. */
async function waitSaved(timeout = 20_000): Promise<void> {
	await browser.waitUntil(async () => browser.executeObsidian(() => {
		const status = document.querySelector<HTMLElement>('.crosswalker-mapping-review .crosswalker-mr-status');
		return status?.dataset.state === 'saved' && (status.textContent ?? '').startsWith('Saved');
	}), { timeout, interval: 250, timeoutMsg: 'The review view did not report Saved' });
}

/** The file's rows as raw TSV cells, keyed by row id. */
async function fileRows(tablePath: string): Promise<Map<string, string[]>> {
	const text = await browser.executeObsidian(async ({ app }, file) => app.vault.adapter.read(file), tablePath);
	const lines = text.split('\n').filter((line) => line && !line.startsWith('#'));
	const rows = new Map<string, string[]>();
	for (const line of lines.slice(1)) {
		const cells = line.split('\t');
		rows.set(cells[COL.row_id], cells);
	}
	return rows;
}

async function setSearch(text: string): Promise<void> {
	await browser.executeObsidian((_obs, value) => {
		const input = document.querySelector<HTMLInputElement>('.crosswalker-mapping-review .crosswalker-mr-search');
		if (input) { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }
	}, text);
	await browser.pause(400);
}

describe('Mapping review view for a table-form set', function () {
	this.timeout(900_000);
	before(() => { mkdirSync(OUT, { recursive: true }); });

	let tablePath = '';
	let totalRows = 0;
	let editedRowId = '';

	it('imports the bundled mapping as a table and opens Review mappings from the installed stacks row', async () => {
		await browser.executeObsidian(async ({ app }, payloads) => {
			if (!app.vault.getAbstractFileByPath('Sources')) await app.vault.createFolder('Sources');
			for (const item of payloads) await app.vault.createBinary(`Sources/${item.name}`, new Uint8Array(item.bytes).buffer);
			// @ts-expect-error -- Obsidian internal command registry
			app.commands.executeCommandById('crosswalker:set-up-framework-stack');
		}, [
			{ name: 'synthetic-review-csf.xlsx', bytes: workbook('CSF', ['element_identifier', 'element_type', 'text'], {
				element_identifier: 'GV.XX-01', element_type: 'subcategory', text: 'Invented CSF concept.' }) },
			{ name: 'synthetic-review-nist.xlsx', bytes: workbook('Controls', nistHeaders, {
				'Control Identifier': 'ZZ-1', 'Control (or Enhancement) Name': 'Invented control',
				'Control Text': 'Invented control text.', Discussion: 'Invented discussion.', 'Related Controls': '' }) },
		]);
		await $('.crosswalker-stack-modal').waitForDisplayed();
		await browser.executeObsidian(() => {
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
		{ timeout: 20_000, timeoutMsg: 'Synthetic CSF and NIST framework files did not recognize' });
		await stackButton('Next: review');
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			!!document.querySelector('.crosswalker-stack-result[data-mapping] .crosswalker-mapping-form-select')
			&& !(document.querySelector('.crosswalker-stack-total')?.textContent ?? '').includes('Counting')),
		{ timeout: 30_000, timeoutMsg: 'Store as control did not render on the mapping row' });
		await browser.executeObsidian(() => {
			const select = document.querySelector<HTMLSelectElement>('.crosswalker-stack-result[data-mapping] .crosswalker-mapping-form-select');
			if (select) { select.value = 'table'; select.dispatchEvent(new Event('change', { bubbles: true })); }
		});
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			(document.querySelector('.crosswalker-stack-result[data-mapping] .crosswalker-stack-count')?.textContent ?? '').startsWith('Writes 1 mapping table')),
		{ timeout: 10_000, timeoutMsg: 'Review count did not switch to one mapping table' });
		await stackButton('Import stack');
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			(document.querySelector('.crosswalker-stack-modal h2')?.textContent ?? '') === 'Framework stack imported'),
		{ timeout: 240_000, timeoutMsg: 'Bundled mapping table import did not finish' });
		await stackButton('Done');

		const tables = await browser.executeObsidian(({ app }) =>
			app.vault.getFiles().filter((file) => file.path.endsWith('.mapping-table.tsv')).map((file) => file.path));
		expect(tables).toHaveLength(1);
		tablePath = tables[0];
		totalRows = (await fileRows(tablePath)).size;
		expect(totalRows).toBeGreaterThan(100);

		// The three entry points exist: the command, the .tsv extension, and the row button.
		const wiring = await browser.executeObsidian(({ app }) => ({
			// @ts-expect-error -- Obsidian internal command registry
			command: !!app.commands.commands['crosswalker:review-mapping-table'],
			// @ts-expect-error -- Obsidian internal view registry
			tsv: app.viewRegistry.getTypeByExtension('tsv'),
		}));
		expect(wiring).toEqual({ command: true, tsv: 'crosswalker-mapping-review' });

		await homeUntilReviewRow();
		await browser.executeObsidian(() => {
			const row = document.querySelector('.crosswalker-workspace-view .crosswalker-mapping-set-row[data-set-form="table"]');
			Array.from(row?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((item) => item.textContent?.trim() === 'Review mappings')?.click();
		});
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			document.querySelectorAll('.crosswalker-mapping-review .crosswalker-mr-row').length > 0), { timeout: 30_000, timeoutMsg: 'The review grid did not render rows' });
		const opened = await browser.executeObsidian(() => {
			const view = document.querySelector<HTMLElement>('.crosswalker-mapping-review');
			return {
				path: view?.dataset.path,
				readOnly: view?.dataset.readOnly,
				rendered: view?.querySelectorAll('.crosswalker-mr-row').length ?? 0,
				count: view?.querySelector('.crosswalker-mr-count')?.textContent ?? '',
				pills: Array.from(view?.querySelectorAll<HTMLElement>('.crosswalker-mr-pill') ?? []).map((pill) => pill.dataset.status),
				headers: Array.from(view?.querySelectorAll('.crosswalker-mr-head .crosswalker-mr-sortable') ?? []).map((cell) => cell.textContent?.trim()),
			};
		});
		expect(opened.path).toBe(tablePath);
		expect(opened.readOnly).toBe('no');
		// Windowed: far fewer DOM rows than mappings.
		expect(opened.rendered).toBeGreaterThan(5);
		expect(opened.rendered).toBeLessThan(80);
		expect(opened.rendered).toBeLessThan(totalRows);
		expect(opened.count).toBe(`Showing all ${totalRows.toLocaleString()} mappings`);
		expect(opened.pills).toEqual(['unset', 'proposed', 'in_review', 'approved', 'deprecated']);
		expect(opened.headers).toEqual(['Subject', 'Predicate', 'Object', 'Justification', 'Confidence', 'Review status', 'Reviewer', 'Review notes', 'Set id']);

		// Scrolling to the end renders the last rows, still windowed.
		const scrolled = await browser.executeObsidian(async () => {
			const scroller = document.querySelector<HTMLElement>('.crosswalker-mapping-review .crosswalker-mr-scroller');
			if (scroller) { scroller.scrollTop = scroller.scrollHeight; scroller.dispatchEvent(new Event('scroll')); }
			await new Promise((resolve) => setTimeout(resolve, 300));
			const rows = Array.from(document.querySelectorAll<HTMLElement>('.crosswalker-mapping-review .crosswalker-mr-row'));
			return { rendered: rows.length, last: Number(rows[rows.length - 1]?.dataset.index ?? -1) };
		});
		expect(scrolled.rendered).toBeLessThan(80);
		expect(scrolled.last).toBe(totalRows - 1);
		await browser.executeObsidian(() => {
			const scroller = document.querySelector<HTMLElement>('.crosswalker-mapping-review .crosswalker-mr-scroller');
			if (scroller) { scroller.scrollTop = 0; scroller.dispatchEvent(new Event('scroll')); }
		});
		await browser.pause(200);
		await capture('light', 'visual-mapping-review-01-grid.png');
		await capture('dark', 'visual-mapping-review-01-grid-dark.png');
	});

	it('searches, sets one status and reviewer, saves them to the file, and keeps them across a reload', async () => {
		expect(tablePath).not.toBe('');
		const first = await browser.executeObsidian(() => {
			const row = document.querySelector<HTMLElement>('.crosswalker-mapping-review .crosswalker-mr-row');
			return { id: row?.dataset.rowId ?? '', subject: row?.querySelector('.crosswalker-mr-endpoint')?.getAttribute('title')?.split(' ')[0] ?? '' };
		});
		expect(first.id).not.toBe('');
		expect(first.subject).not.toBe('');
		await setSearch(first.subject);
		const searched = await browser.executeObsidian((_obs, rowId) => ({
			count: document.querySelector('.crosswalker-mapping-review .crosswalker-mr-count')?.textContent ?? '',
			present: !!document.querySelector(`.crosswalker-mapping-review .crosswalker-mr-row[data-row-id="${rowId}"]`),
		}), first.id);
		expect(searched.count).toMatch(/^Showing [\d,]+ of /);
		expect(searched.present).toBe(true);
		editedRowId = first.id;

		await browser.executeObsidian((_obs, rowId) => {
			const row = document.querySelector<HTMLElement>(`.crosswalker-mapping-review .crosswalker-mr-row[data-row-id="${rowId}"]`);
			const status = row?.querySelector<HTMLSelectElement>('.crosswalker-mr-status-select');
			if (status) { status.value = 'approved'; status.dispatchEvent(new Event('change', { bubbles: true })); }
			const reviewer = row?.querySelector<HTMLInputElement>('.crosswalker-mr-reviewer');
			if (reviewer) { reviewer.value = 'Invented reviewer'; reviewer.dispatchEvent(new Event('input', { bubbles: true })); }
		}, editedRowId);
		await waitSaved();
		const saved = (await fileRows(tablePath)).get(editedRowId);
		expect(saved?.[COL.review_status]).toBe('approved');
		expect(saved?.[COL.reviewer]).toBe('Invented reviewer');
		expect((await fileRows(tablePath)).size).toBe(totalRows);
		const approvedPill = await browser.executeObsidian(() =>
			document.querySelector('.crosswalker-mapping-review .crosswalker-mr-pill[data-status="approved"] .crosswalker-mr-pill-count')?.textContent ?? '');
		expect(Number(approvedPill.replace(/,/g, ''))).toBeGreaterThanOrEqual(1);

		// Reload the plugin, reopen the review, and read the row back from the grid.
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error -- Obsidian plugin manager internal
			await app.plugins.disablePlugin('crosswalker');
			// @ts-expect-error -- Obsidian plugin manager internal
			await app.plugins.enablePlugin('crosswalker');
		});
		await browser.waitUntil(async () => browser.executeObsidian(({ app }) =>
			// @ts-expect-error -- Obsidian plugin manager internal
			typeof app.plugins.plugins.crosswalker?.openMappingReview === 'function'), { timeout: 30_000, timeoutMsg: 'Plugin did not come back after the reload' });
		await browser.executeObsidian(async ({ app }, file) => {
			for (const leaf of app.workspace.getLeavesOfType('crosswalker-mapping-review')) leaf.detach();
			// @ts-expect-error -- plugin instance from the plugin manager
			await app.plugins.plugins.crosswalker.openMappingReview(file);
		}, tablePath);
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			document.querySelectorAll('.crosswalker-mapping-review .crosswalker-mr-row').length > 0), { timeout: 30_000, timeoutMsg: 'The review grid did not render after the reload' });
		await setSearch(first.subject);
		const after = await browser.executeObsidian((_obs, rowId) => {
			const row = document.querySelector<HTMLElement>(`.crosswalker-mapping-review .crosswalker-mr-row[data-row-id="${rowId}"]`);
			return {
				status: row?.querySelector<HTMLSelectElement>('.crosswalker-mr-status-select')?.value,
				reviewer: row?.querySelector<HTMLInputElement>('.crosswalker-mr-reviewer')?.value,
			};
		}, editedRowId);
		expect(after).toEqual({ status: 'approved', reviewer: 'Invented reviewer' });

		// Keyboard: focus the grid, move down to the first row, open the details drawer.
		await browser.executeObsidian(() => {
			const scroller = document.querySelector<HTMLElement>('.crosswalker-mapping-review .crosswalker-mr-scroller');
			scroller?.focus();
			scroller?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
			scroller?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		});
		const drawer = await browser.executeObsidian(() => {
			const el = document.querySelector('.crosswalker-mapping-review .crosswalker-mr-drawer.is-open');
			return { open: !!el, text: el?.textContent ?? '', active: !!document.querySelector('.crosswalker-mapping-review .crosswalker-mr-row.is-active') };
		});
		expect(drawer.open).toBe(true);
		expect(drawer.active).toBe(true);
		expect(drawer.text).toContain('Mapping details');
		expect(drawer.text).toContain('Row id');
		await capture('light', 'visual-mapping-review-02-details.png');
		await capture('dark', 'visual-mapping-review-02-details-dark.png');
		await browser.executeObsidian(() => {
			document.querySelector<HTMLButtonElement>('.crosswalker-mapping-review .crosswalker-mr-drawer-close')?.click();
		});
	});

	it('bulk-sets a status for every mapping matching a filter and saves it', async () => {
		expect(editedRowId).not.toBe('');
		await setSearch('');
		await browser.executeObsidian(() => {
			const filter = document.querySelector<HTMLSelectElement>('.crosswalker-mapping-review .crosswalker-mr-filter');
			if (filter) { filter.value = 'unset'; filter.dispatchEvent(new Event('change', { bubbles: true })); }
		});
		await browser.pause(200);
		const unset = await browser.executeObsidian(() => {
			const text = document.querySelector('.crosswalker-mapping-review .crosswalker-mr-count')?.textContent ?? '';
			return Number(/Showing ([\d,]+) of/.exec(text)?.[1]?.replace(/,/g, '') ?? '0');
		});
		const before = await fileRows(tablePath);
		const unsetIds = [...before.values()].filter((cells) => !cells[COL.review_status]).map((cells) => cells[COL.row_id]);
		expect(unset).toBe(unsetIds.length);
		expect(unset).toBeGreaterThan(0);
		await browser.executeObsidian(() => {
			document.querySelector<HTMLButtonElement>('.crosswalker-mapping-review .crosswalker-mr-select-all')?.click();
			const bulk = document.querySelector<HTMLSelectElement>('.crosswalker-mapping-review .crosswalker-mr-bulk-status');
			if (bulk) { bulk.value = 'in_review'; bulk.dispatchEvent(new Event('change', { bubbles: true })); }
		});
		const selection = await browser.executeObsidian(() => document.querySelector('.crosswalker-mapping-review .crosswalker-mr-selection')?.textContent ?? '');
		expect(selection).toBe(`${unset.toLocaleString()} selected`);
		await waitSaved(60_000);
		const afterBulk = await fileRows(tablePath);
		expect(afterBulk.size).toBe(totalRows);
		// Every row that was unset is now in review; every other row kept its status.
		for (const [rowId, cells] of before) {
			const expected = unsetIds.includes(rowId) ? 'in_review' : cells[COL.review_status];
			expect([rowId, afterBulk.get(rowId)?.[COL.review_status]]).toEqual([rowId, expected]);
		}
		expect(afterBulk.get(editedRowId)?.[COL.review_status]).toBe('approved');
		const inReviewBefore = [...before.values()].filter((cells) => cells[COL.review_status] === 'in_review').length;
		const pill = await browser.executeObsidian(() =>
			document.querySelector('.crosswalker-mapping-review .crosswalker-mr-pill[data-status="in_review"] .crosswalker-mr-pill-count')?.textContent ?? '');
		expect(Number(pill.replace(/,/g, ''))).toBe(inReviewBefore + unset);
		await browser.executeObsidian(() => {
			const filter = document.querySelector<HTMLSelectElement>('.crosswalker-mapping-review .crosswalker-mr-filter');
			if (filter) { filter.value = 'any'; filter.dispatchEvent(new Event('change', { bubbles: true })); }
		});
		await browser.pause(200);
		await capture('light', 'visual-mapping-review-03-after-bulk.png');
		await capture('dark', 'visual-mapping-review-03-after-bulk-dark.png');

		// Selection follows the filter: narrowing the search drops hidden rows
		// from the selection, and a following Set reviewer touches only the rows
		// still shown.
		const widened = await browser.executeObsidian(() => document.querySelector('.crosswalker-mapping-review .crosswalker-mr-selection')?.textContent ?? '');
		expect(widened).toBe(`${unset.toLocaleString()} selected`);
		const narrowTo = before.get(unsetIds[0])?.[COL.subject_id] ?? '';
		expect(narrowTo).not.toBe('');
		await setSearch(narrowTo);
		const narrowed = await browser.executeObsidian(() => {
			const text = document.querySelector('.crosswalker-mapping-review .crosswalker-mr-selection')?.textContent ?? '';
			return Number(/^([\d,]+) selected$/.exec(text)?.[1]?.replace(/,/g, '') ?? '0');
		});
		expect(narrowed).toBeGreaterThan(0);
		expect(narrowed).toBeLessThan(unset);
		await browser.executeObsidian(() => {
			const input = document.querySelector<HTMLInputElement>('.crosswalker-mapping-review .crosswalker-mr-bulk-reviewer');
			if (input) input.value = 'Filtered reviewer';
			document.querySelector<HTMLButtonElement>('.crosswalker-mapping-review .crosswalker-mr-set-reviewer')?.click();
		});
		let reviewed: string[] = [];
		await browser.waitUntil(async () => {
			reviewed = [...(await fileRows(tablePath)).values()].filter((cells) => cells[COL.reviewer] === 'Filtered reviewer').map((cells) => cells[COL.row_id]);
			return reviewed.length === narrowed;
		}, { timeout: 30_000, interval: 500, timeoutMsg: 'Set reviewer did not reach exactly the visible selected rows' });
		await waitSaved();
		const afterReviewer = await fileRows(tablePath);
		expect(afterReviewer.size).toBe(totalRows);
		const needle = narrowTo.toLowerCase();
		for (const rowId of reviewed) {
			// Each edited row was selected (unset before the bulk step) and matches the search.
			expect(unsetIds.includes(rowId)).toBe(true);
			expect(afterReviewer.get(rowId)?.join('\t').toLowerCase()).toContain(needle);
		}
		await setSearch('');
	});

	it('opens a .tsv that is not a mapping table as a read-only preview', async () => {
		await browser.executeObsidian(async ({ app }) => {
			await app.vault.create('Sources/synthetic-notes.tsv', 'name\tvalue\nalpha\t1\nbeta\t2\n');
			const file = app.vault.getAbstractFileByPath('Sources/synthetic-notes.tsv');
			// @ts-expect-error -- TFile check is structural in the page
			await app.workspace.getLeaf('tab').openFile(file);
		});
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			Array.from(document.querySelectorAll<HTMLElement>('.crosswalker-mapping-review'))
				.some((view) => view.dataset.readOnly === 'not-a-table')), { timeout: 15_000, timeoutMsg: 'The .tsv did not open in the review view' });
		const preview = await browser.executeObsidian(() => {
			const view = Array.from(document.querySelectorAll<HTMLElement>('.crosswalker-mapping-review')).find((el) => el.dataset.readOnly === 'not-a-table');
			return { banner: view?.querySelector('.crosswalker-mr-banner')?.textContent ?? '', text: view?.querySelector('.crosswalker-mr-preview')?.textContent ?? '', inputs: view?.querySelectorAll('input, select').length ?? -1 };
		});
		expect(preview.banner).toContain('This is not a Crosswalker mapping table.');
		expect(preview.text).toContain('alpha\t1');
		expect(preview.inputs).toBe(0);
	});
});
