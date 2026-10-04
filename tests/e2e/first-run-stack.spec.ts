import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { RECIPE_REGISTRY } from '../../src/import/recipe-registry';

const OUT = path.resolve('test-screenshots');
const nistHeaders = ['Control Identifier', 'Control (or Enhancement) Name', 'Control Text', 'Discussion', 'Related Controls'];
const source = (id: string) => RECIPE_REGISTRY.find((entry) => entry.id === id)!;
function workbook(sheet: string, columns: string[], values: Record<string, string>, headerRow = 0): number[] {
	const rows = Array.from({ length: headerRow }, () => ['Synthetic banner']);
	rows.push(columns, columns.map((column) => values[column] ?? ''));
	const book = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheet);
	return Array.from(new Uint8Array(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })));
}
async function button(label: string): Promise<void> {
	const clicked = await browser.executeObsidian((_obs, target) => {
		// The newest stack modal is the one under test. A previous test's modal that
		// is still closing must not capture the click (it once cascaded one red into two).
		const modals = document.querySelectorAll('.crosswalker-stack-modal');
		const root = modals.length > 0 ? modals[modals.length - 1] : null;
		const found = Array.from(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])
			// The import button carries its planned file count ("Import stack (~13 files)")
			// since the 2026-09-28 count work, so it is matched by its label prefix.
			.find((candidate) => candidate.textContent?.trim() === target
				|| (target === 'Import stack' && candidate.textContent?.trim().startsWith('Import stack (')));
		found?.click(); return !!found;
	}, label);
	expect(clicked).toBe(true);
	if (label !== 'Import stack') return;
	// Above the confirmation threshold the run waits on a separate dialog.
	await browser.pause(200);
	await browser.executeObsidian(() => Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-stack-confirm button'))
		.find((candidate) => candidate.textContent?.trim() === 'Import')?.click());
}
async function openStack(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		// @ts-expect-error -- Obsidian internal command registry
		app.commands.executeCommandById('crosswalker:set-up-framework-stack');
	});
	await $('.crosswalker-stack-modal').waitForDisplayed();
	await browser.executeObsidian(() => {
		const connector = document.querySelector<HTMLInputElement>('.crosswalker-stack-choice.is-connector input');
		connector?.click();
	});
	await browser.executeObsidian(() => {
		const direct = document.querySelector<HTMLInputElement>('.crosswalker-stack-choice input[data-mapping="cri-80053"]');
		direct?.click();
	});
	await button('Next: download checklist');
	await button('Next: add the files');
}
async function themeCapture(theme: 'light' | 'dark', fileName: string): Promise<void> {
	await browser.executeObsidian((_obs, value) => {
		document.querySelectorAll('.notice-container .notice').forEach((notice) => notice.remove());
		document.body.classList.toggle('theme-light', value === 'light');
		document.body.classList.toggle('theme-dark', value === 'dark');
	}, theme);
	await browser.saveScreenshot(path.join(OUT, fileName));
}

describe('First run: synthetic framework stack', function () {
	this.timeout(300_000);
	before(() => { mkdirSync(OUT, { recursive: true }); });
	it('recognizes three synthetic sources, imports three separate sets, and offers but never selects refresh', async () => {
		const cri = source('cri-profile-v2-2-flat');
		const attack = source('mitre-attack-technique-flat');
		const criValues = Object.fromEntries(cri.signatureColumns.map((column) => [column, '']));
		Object.assign(criValues, { 'Profile Id': 'ZZ.ZZ-01.01', Level: 'DS', 'Outline Id': 'Z.1',
			'CRI Profile Function / Category / Subcategory': 'Invented / Category / Subcategory',
			'CRI Profile v2.2 Diagnostic Statement': 'Invented statement.' });
		const attackValues = Object.fromEntries(attack.signatureColumns.map((column) => [column, '']));
		Object.assign(attackValues, { ID: 'T9999', name: 'Invented technique', description: 'Invented description.' });
		const payloads = [
			{ name: 'synthetic-cri.xlsx', bytes: workbook('CRI Profile v2.2 Structure', cri.signatureColumns, criValues, 2) },
			{ name: 'synthetic-attack.xlsx', bytes: workbook('techniques', attack.signatureColumns, attackValues) },
			{ name: 'synthetic-nist.xlsx', bytes: workbook('Controls', nistHeaders, {
				'Control Identifier': 'ZZ-1', 'Control (or Enhancement) Name': 'Invented control',
				'Control Text': 'Invented control text.', Discussion: 'Invented discussion.', 'Related Controls': '',
			}) },
			{ name: 'synthetic-CRI-Profile-to-SP-800-53.xlsx', bytes: workbook('Mappings',
				['Focal Document Element', 'Reference Document Element', 'Relationship'], {
				'Focal Document Element': 'ZZ-01', 'Reference Document Element': 'ZZ.ZZ-01.01', Relationship: 'intersects with',
			}) },
			{ name: 'synthetic-80053-attack.json', text: JSON.stringify({ metadata: { attack_version: '16.1' }, mapping_objects: [
				{ capability_id: 'ZZ-01', attack_object_id: 'T9999', mapping_type: 'mitigates' },
				{ capability_id: 'ZZ-01', attack_object_id: 'T9998', mapping_type: 'mitigates' },
			] }) },
		];
		await browser.executeObsidian(async ({ app }, sources) => {
			if (!app.vault.getAbstractFileByPath('Sources')) await app.vault.createFolder('Sources');
			for (const item of sources) {
				const bytes = 'bytes' in item ? new Uint8Array(item.bytes!) : new TextEncoder().encode(item.text ?? '');
				await app.vault.createBinary(`Sources/${item.name}`, bytes.buffer);
			}
		}, payloads);
		await openStack();
		await browser.executeObsidian(() => {
			const input = document.querySelector<HTMLInputElement>('.crosswalker-stack-modal input[placeholder="Sources"]');
			if (input) { input.value = 'Sources'; input.dispatchEvent(new Event('input', { bubbles: true })); }
		});
		await button('Choose folder');
		await browser.waitUntil(async () => (await browser.executeObsidian(() =>
			document.querySelectorAll('.crosswalker-stack-result[data-slot]').length === 3 &&
			Array.from(document.querySelectorAll('.crosswalker-stack-result[data-slot]')).every((row) => row.textContent?.includes('Recognized')))),
		{ timeout: 20_000, timeoutMsg: 'Three synthetic sources did not recognize' });
		for (const mode of ['light', 'dark'] as const) await themeCapture(mode, `visual-stack-03-recognize-${mode}.png`);
		await button('Next: review');
		const review = await browser.executeObsidian(() => ({
			newSet: document.querySelectorAll('.crosswalker-stack-result[data-slot]').length,
			text: document.querySelector('.crosswalker-stack-modal')?.textContent ?? '',
		}));
		expect(review.newSet).toBe(3);
		expect(review.text.match(/Import set: New set/g)).toHaveLength(3);
		for (const mode of ['light', 'dark'] as const) await themeCapture(mode, `visual-stack-04-review-${mode}.png`);
		await button('Import stack');
		try {
			await browser.waitUntil(async () => (await browser.executeObsidian(() =>
				(document.querySelector('.crosswalker-stack-modal h2')?.textContent ?? '') === 'Framework stack imported')),
			{ timeout: 45_000, timeoutMsg: 'Stack import did not finish' });
		} catch (error) {
			const state = await browser.executeObsidian(({ app }) => ({
				text: document.querySelector('.crosswalker-stack-modal')?.textContent ?? '',
				notes: app.vault.getMarkdownFiles().map((file) => file.path),
				// @ts-expect-error -- internal plugin registry used only in E2E
				events: app.plugins.plugins.crosswalker?.debug?.getRingBuffer()?.slice(-8),
			}));
			console.log(`[stack-import-state] ${JSON.stringify(state)}`);
			throw error;
		}
		const result = await browser.executeObsidian(({ app }) => {
			const notes = app.vault.getMarkdownFiles().filter((file) => ['Ontologies/NIST 800-53', 'Ontologies/MITRE ATT&CK', 'Ontologies/CRI Profile'].some((root) => file.path.startsWith(root)));
			return { text: document.querySelector('.crosswalker-stack-modal')?.textContent ?? '',
				paths: notes.map((file) => file.path) };
		});
		expect(result.text).toContain('5 sets confirmed in the vault');
		expect(result.text).toContain('2 mapping sets');
		await themeCapture('light', 'visual-stack-06-complete.png');
		await themeCapture('dark', 'visual-stack-06-complete-dark.png');
		// Mapping notes only: each mapping set folder also holds the set's release record
		// note (kind: mapping-set). A cold metadata cache is read from the file, never
		// treated as "not a release record".
		const mappingLinks = await browser.executeObsidian(async ({ app }) => {
			const edges: Array<{ path: string; links: string[] }> = [];
			for (const file of app.vault.getMarkdownFiles().filter((note) => note.path.startsWith('_crosswalker/mappings/'))) {
				const cache = app.metadataCache.getFileCache(file);
				const releaseRecord = cache ? cache.frontmatter?.kind === 'mapping-set'
					: /^kind:\s*["']?mapping-set["']?\s*$/m.test(await app.vault.read(file));
				if (!releaseRecord) edges.push({ path: file.path, links: Object.keys(app.metadataCache.resolvedLinks[file.path] ?? {}) });
			}
			return edges;
		});
		expect(mappingLinks).toHaveLength(3);
		expect(mappingLinks.filter((edge) => edge.links.length >= 2)).toHaveLength(2);
		expect(mappingLinks.filter((edge) => edge.links.length === 1)).toHaveLength(1);
		expect(result.text).toContain('mapping endpoint could not link');
		await browser.executeObsidian(async ({ app }) => {
			// Metadata can lag newly written notes. Read the file when its cache is cold;
			// neither absence nor identity may be inferred from the path alone.
			let technique;
			for (const file of app.vault.getMarkdownFiles().filter((note) => ['Ontologies/NIST 800-53', 'Ontologies/MITRE ATT&CK', 'Ontologies/CRI Profile'].some((root) => note.path.startsWith(root)))) {
				const cached = app.metadataCache.getFileCache(file)?.frontmatter?.curie;
				if (cached === 'mitre-attack:T9999' || (!cached &&
					/^curie:\s*["']?mitre-attack:T9999/m.test(await app.vault.read(file)))) {
					technique = file; break;
				}
			}
			if (!technique) throw new Error('Synthetic technique missing');
			const folder = technique.path.slice(0, technique.path.lastIndexOf('/'));
			await app.vault.create(`${folder}/Invented missing technique.md`,
				(await app.vault.read(technique)).replaceAll('T9999', 'T9998'));
		});
		await button('Reconnect mappings');
		await browser.waitUntil(async () => (await browser.executeObsidian(({ app }) => {
			// Release record notes (kind: mapping-set) are not mapping notes. Wait for every
			// file to be indexed rather than guess what an unindexed note is.
			const files = app.vault.getMarkdownFiles().filter((file) => file.path.startsWith('_crosswalker/mappings/'));
			if (files.some((file) => !app.metadataCache.getFileCache(file))) return false;
			const edges = files.filter((file) => app.metadataCache.getFileCache(file)?.frontmatter?.kind !== 'mapping-set');
			return edges.length === 3 && edges.every((file) => Object.keys(app.metadataCache.resolvedLinks[file.path] ?? {}).length >= 2)
				&& !(document.querySelector('.crosswalker-stack-modal')?.textContent ?? '').includes('mapping endpoint could not link');
		})), { timeout: 30_000, timeoutMsg: 'Explicit reconnect did not resolve the new technique identity' });
		await button('Done');
		await browser.executeObsidian(({ app }) => {
			// @ts-expect-error -- internal graph command for visual verification
			app.commands.executeCommandById('graph:open');
		});
		await $('.workspace-leaf-content[data-type="graph"]').waitForDisplayed();
		await browser.pause(3000);
		await browser.saveScreenshot(path.join(OUT, 'visual-stack-06-graph-connected.png'));
		expect(result.paths).toHaveLength(4);
		expect(result.paths).toContain('Ontologies/NIST 800-53/ZZ/ZZ.md');
		expect(new Set(result.paths.map((file) => file.split('/').slice(0, 2).join('/'))).size).toBe(3);
		await openStack();
		await browser.executeObsidian(() => {
			const input = document.querySelector<HTMLInputElement>('.crosswalker-stack-modal input[placeholder="Sources"]');
			if (input) { input.value = 'Sources'; input.dispatchEvent(new Event('input', { bubbles: true })); }
		});
		await button('Choose folder');
		await browser.waitUntil(async () => (await browser.executeObsidian(() =>
			Array.from(document.querySelectorAll('.crosswalker-stack-result[data-slot]')).every((row) => row.textContent?.includes('Recognized')))),
		{ timeout: 20_000 });
		await button('Next: review');
		const again = await browser.executeObsidian(() => document.querySelector('.crosswalker-stack-modal')?.textContent ?? '');
		expect(again.match(/Import set: New set/g)).toHaveLength(3);
		for (let index = 0; index < 3; index++) {
			await browser.executeObsidian((_obs, offset) => {
				const rows = document.querySelectorAll('.crosswalker-stack-result[data-slot]');
				Array.from(rows[offset].querySelectorAll('button'))
					.find((candidate) => candidate.textContent?.trim() === 'Check for refresh')?.click();
			}, index);
			await browser.waitUntil(async () => (await browser.executeObsidian((_obs, offset) => {
				const rows = document.querySelectorAll('.crosswalker-stack-result[data-slot]');
				return (rows[offset].querySelector('.crosswalker-stack-refresh-offer')?.textContent ?? '').includes('Looks like set');
			}, index)), { timeout: 15_000, timeoutMsg: 'Refresh offer was not shown for unchanged source' });
		}
		const offers = await browser.executeObsidian(() => Array.from(
			document.querySelectorAll('.crosswalker-stack-result[data-slot]')).map((row) => row.textContent ?? ''));
		expect(offers.every((offer) => offer.includes('New set remains selected')
			&& offer.includes('Open import wizard to refresh'))).toBe(true);
		await button('Import stack');
		await browser.waitUntil(async () => (await browser.executeObsidian(() =>
			(document.querySelector('.crosswalker-stack-modal h2')?.textContent ?? '') === 'Framework stack imported')),
		{ timeout: 60_000, timeoutMsg: 'Second new-set import did not finish' });
		const second = await browser.executeObsidian(({ app }) => ({
			text: document.querySelector('.crosswalker-stack-modal')?.textContent ?? '',
			paths: app.vault.getMarkdownFiles().filter((file) => ['Ontologies/NIST 800-53', 'Ontologies/MITRE ATT&CK', 'Ontologies/CRI Profile'].some((root) => file.path.startsWith(root))).map((file) => file.path),
		}));
		expect(second.text).toContain('5 sets confirmed in the vault');
		expect(second.paths).toHaveLength(9);
		expect(new Set(second.paths.map((file) => file.split('/').slice(0, 2).join('/'))).size).toBe(6);
		await button('Done');
	});

	it('imports the bundled CSF-to-800-53 mapping without a mapping download', async () => {
		await browser.executeObsidian(async ({ app }, bytes) => {
			await app.vault.createBinary('Sources/synthetic-csf.xlsx', new Uint8Array(bytes).buffer);
		}, workbook('CSF', ['element_identifier', 'element_type', 'text'], {
			element_identifier: 'GV.XX-01', element_type: 'subcategory', text: 'Invented CSF concept.',
		}));
		await browser.executeObsidian(({ app }) => {
			// @ts-expect-error -- Obsidian internal command registry
			app.commands.executeCommandById('crosswalker:set-up-framework-stack');
		});
		await $('.crosswalker-stack-modal').waitForDisplayed();
		await browser.executeObsidian(() => {
			for (const id of ['cri-profile', 'mitre-attack']) {
				document.querySelector<HTMLInputElement>(`.crosswalker-stack-choice input[data-ontology="${id}"]`)?.click();
			}
			document.querySelector<HTMLInputElement>('.crosswalker-stack-choice input[data-ontology="nist-csf-2"]')?.click();
		});
		await button('Next: download checklist');
		await button('Next: add the files');
		await browser.executeObsidian(() => {
			const input = document.querySelector<HTMLInputElement>('.crosswalker-stack-modal input[placeholder="Sources"]');
			if (input) { input.value = 'Sources'; input.dispatchEvent(new Event('input', { bubbles: true })); }
		});
		await button('Choose folder');
		await browser.waitUntil(async () => (await browser.executeObsidian(() =>
			document.querySelectorAll('.crosswalker-stack-result[data-slot]').length === 2 &&
			Array.from(document.querySelectorAll('.crosswalker-stack-result[data-slot]')).every((row) => row.textContent?.includes('Recognized')))),
		{ timeout: 20_000, timeoutMsg: 'Synthetic CSF and NIST framework files did not recognize' });
		await button('Next: review');
		expect(await browser.executeObsidian(() => document.querySelector('.crosswalker-stack-modal')?.textContent ?? ''))
			.toContain('NIST CSF 2.0 to NIST 800-53');
		await button('Import stack');
		await browser.waitUntil(async () => (await browser.executeObsidian(() => {
			const modal = document.querySelector('.crosswalker-stack-modal');
			return (modal?.querySelector('h2')?.textContent ?? '') === 'Framework stack imported' ||
				!!modal?.querySelector('.crosswalker-stack-warning');
		})), { timeout: 180_000, timeoutMsg: 'Bundled mapping import did not finish' });
		const importState = await browser.executeObsidian(({ app }) => ({
			modal: document.querySelector('.crosswalker-stack-modal')?.textContent ?? '',
			unindexedFrameworks: app.vault.getMarkdownFiles().filter((file) => file.path.startsWith('Ontologies/') && !app.metadataCache.getFileCache(file)).map((file) => file.path),
		}));
		expect(importState.unindexedFrameworks).toEqual([]);
		expect(importState.modal).toContain('Framework stack imported');
		const result = await browser.executeObsidian(({ app }) => ({
			text: document.querySelector('.crosswalker-stack-modal')?.textContent ?? '',
			edges: app.vault.getMarkdownFiles().filter((file) => file.path.startsWith('_crosswalker/mappings/nist-csf-2-to-nist-800-53/')).length,
		}));
		expect(result.text).toContain('1 mapping set');
		expect(result.edges).toBeGreaterThan(100);
	});

	// Slice 3 of the mapping table form. Reuses the synthetic CSF and NIST files the
	// tests above added; the bundled mapping is public-domain NIST content shipped in
	// the plugin, not a copied fixture.
	it('imports the bundled mapping as one table file when Store as is Table', async () => {
		const folder = '_crosswalker/mappings/nist-csf-2-to-nist-800-53';
		const before = await browser.executeObsidian(({ app }, root) => ({
			notes: app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${root}/`)).length,
			tables: app.vault.getFiles().filter((file) => file.path.endsWith('.mapping-table.tsv')).map((file) => file.path),
		}), folder);
		expect(before.tables).toEqual([]);
		// The previous test ends on its completion screen; close it so the helpers
		// address this run's modal, not that one.
		await browser.executeObsidian(() => Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-stack-modal button'))
			.find((candidate) => candidate.textContent?.trim() === 'Done')?.click());
		await browser.waitUntil(async () => (await browser.executeObsidian(() => document.querySelectorAll('.crosswalker-stack-modal').length)) === 0,
			{ timeout: 10_000, timeoutMsg: 'Previous stack modal did not close' });
		await browser.executeObsidian(({ app }) => {
			// @ts-expect-error -- Obsidian internal command registry
			app.commands.executeCommandById('crosswalker:set-up-framework-stack');
		});
		await $('.crosswalker-stack-modal').waitForDisplayed();
		await browser.executeObsidian(() => {
			for (const id of ['cri-profile', 'mitre-attack']) {
				document.querySelector<HTMLInputElement>(`.crosswalker-stack-choice input[data-ontology="${id}"]`)?.click();
			}
			document.querySelector<HTMLInputElement>('.crosswalker-stack-choice input[data-ontology="nist-csf-2"]')?.click();
		});
		await button('Next: download checklist');
		await button('Next: add the files');
		await browser.executeObsidian(() => {
			const input = document.querySelector<HTMLInputElement>('.crosswalker-stack-modal input[placeholder="Sources"]');
			if (input) { input.value = 'Sources'; input.dispatchEvent(new Event('input', { bubbles: true })); }
		});
		await button('Choose folder');
		await browser.waitUntil(async () => (await browser.executeObsidian(() =>
			document.querySelectorAll('.crosswalker-stack-result[data-slot]').length === 2 &&
			Array.from(document.querySelectorAll('.crosswalker-stack-result[data-slot]')).every((row) => row.textContent?.includes('Recognized')))),
		{ timeout: 20_000, timeoutMsg: 'Synthetic CSF and NIST framework files did not recognize' });
		await button('Next: review');
		await browser.waitUntil(async () => (await browser.executeObsidian(() =>
			!!document.querySelector('.crosswalker-stack-result[data-mapping] .crosswalker-mapping-form-select')
			&& !(document.querySelector('.crosswalker-stack-total')?.textContent ?? '').includes('Counting'))),
		{ timeout: 30_000, timeoutMsg: 'Store as control did not render on the mapping row' });
		await browser.executeObsidian(() => {
			const select = document.querySelector<HTMLSelectElement>('.crosswalker-stack-result[data-mapping] .crosswalker-mapping-form-select');
			if (select) { select.value = 'table'; select.dispatchEvent(new Event('change', { bubbles: true })); }
		});
		await browser.waitUntil(async () => (await browser.executeObsidian(() =>
			(document.querySelector('.crosswalker-stack-result[data-mapping] .crosswalker-stack-count')?.textContent ?? '').startsWith('Writes 1 mapping table'))),
		{ timeout: 10_000, timeoutMsg: 'Review count did not switch to one mapping table' });
		const review = await browser.executeObsidian(() => ({
			tradeOff: document.querySelector('.crosswalker-stack-result[data-mapping] .crosswalker-mapping-form-trade-off')?.textContent ?? '',
			value: document.querySelector<HTMLSelectElement>('.crosswalker-stack-result[data-mapping] .crosswalker-mapping-form-select')?.value,
		}));
		expect(review.value).toBe('table');
		expect(review.tradeOff).toContain('will not appear in Bases views, graph view or backlinks');
		await browser.executeObsidian(() => document.querySelector('.crosswalker-stack-result[data-mapping] .crosswalker-mapping-form')?.scrollIntoView({ block: 'center' }));
		for (const mode of ['light', 'dark'] as const) await themeCapture(mode, `visual-stack-07-store-as-table-${mode}.png`);
		await button('Import stack');
		await browser.waitUntil(async () => (await browser.executeObsidian(() => {
			const modal = document.querySelector('.crosswalker-stack-modal');
			return (modal?.querySelector('h2')?.textContent ?? '') === 'Framework stack imported' ||
				!!modal?.querySelector('.crosswalker-stack-warning');
		})), { timeout: 180_000, timeoutMsg: 'Bundled mapping table import did not finish' });
		const after = await browser.executeObsidian(({ app }, root) => ({
			text: document.querySelector('.crosswalker-stack-modal')?.textContent ?? '',
			notes: app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${root}/`)).length,
			tables: app.vault.getFiles().filter((file) => file.path.endsWith('.mapping-table.tsv')).map((file) => file.path),
			tableRow: document.querySelector('.crosswalker-stack-result[data-mapping-form="table"]')?.textContent ?? '',
		}), folder);
		expect(after.text).toContain('Framework stack imported');
		expect(after.text).toContain('1 mapping table written');
		expect(after.tables).toHaveLength(1);
		expect(after.tables[0].startsWith(`${folder}/`)).toBe(true);
		// No mapping notes: the folder holds exactly the notes the earlier notes-form import wrote.
		expect(after.notes).toBe(before.notes);
		const rows = Number(/1 mapping table, ([\d,]+) rows/.exec(after.tableRow)?.[1]?.replace(/,/g, '') ?? '0');
		expect(rows).toBeGreaterThan(100);
		await themeCapture('light', 'visual-stack-07-complete-table.png');
		await themeCapture('dark', 'visual-stack-07-complete-table-dark.png');
		await button('Done');
		await browser.executeObsidian(async ({ app }) => {
			for (const leaf of app.workspace.getLeavesOfType('crosswalker-workspace')) leaf.detach();
			const leaf = app.workspace.getLeaf(true);
			await leaf.setViewState({ type: 'crosswalker-workspace', active: true });
			await app.workspace.revealLeaf(leaf);
		});
		await browser.waitUntil(async () => (await browser.executeObsidian(() =>
			Array.from(document.querySelectorAll('.crosswalker-workspace-view .crosswalker-installed-stacks .crosswalker-stack-result'))
				.some((row) => (row.textContent ?? '').includes('1 mapping table')))),
		{ timeout: 30_000, timeoutMsg: 'Installed stacks view did not report the table set' });
		const installed = await browser.executeObsidian(() => Array.from(
			document.querySelectorAll('.crosswalker-workspace-view .crosswalker-installed-stacks .crosswalker-stack-result'))
			.map((row) => row.textContent ?? '').find((text) => text.includes('1 mapping table')) ?? '');
		expect(installed).toContain(`1 mapping table, ${rows.toLocaleString()} rows`);
		expect(after.tableRow).toContain('Their rows were kept in the mapping table.');
		await browser.executeObsidian(() => Array.from(
			document.querySelectorAll('.crosswalker-workspace-view .crosswalker-installed-stacks .crosswalker-stack-result'))
			.find((row) => (row.textContent ?? '').includes('1 mapping table'))?.scrollIntoView({ block: 'center' }));
		await themeCapture('light', 'visual-stack-07-installed-table.png');
	});
});
