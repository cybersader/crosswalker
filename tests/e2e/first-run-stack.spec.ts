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
		const root = document.querySelector('.crosswalker-stack-modal');
		const found = Array.from(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])
			.find((candidate) => candidate.textContent?.trim() === target);
		found?.click(); return !!found;
	}, label);
	expect(clicked).toBe(true);
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
			const notes = app.vault.getMarkdownFiles().filter((file) => ['Frameworks/NIST 800-53', 'Frameworks/MITRE ATT&CK', 'Frameworks/CRI Profile'].some((root) => file.path.startsWith(root)));
			return { text: document.querySelector('.crosswalker-stack-modal')?.textContent ?? '',
				paths: notes.map((file) => file.path) };
		});
		expect(result.text).toContain('5 sets confirmed in the vault');
		expect(result.text).toContain('2 mapping sets');
		await themeCapture('light', 'visual-stack-06-complete.png');
		await themeCapture('dark', 'visual-stack-06-complete-dark.png');
		const mappingLinks = await browser.executeObsidian(({ app }) => app.vault.getMarkdownFiles()
			.filter((file) => file.path.startsWith('_crosswalker/mappings/')).map((file) => ({
				path: file.path, links: Object.keys(app.metadataCache.resolvedLinks[file.path] ?? {}),
			})));
		expect(mappingLinks).toHaveLength(3);
		expect(mappingLinks.filter((edge) => edge.links.length >= 2)).toHaveLength(2);
		expect(mappingLinks.filter((edge) => edge.links.length === 1)).toHaveLength(1);
		expect(result.text).toContain('mapping endpoint could not link');
		await browser.executeObsidian(async ({ app }) => {
			// Metadata can lag newly written notes. Read the file when its cache is cold;
			// neither absence nor identity may be inferred from the path alone.
			let technique;
			for (const file of app.vault.getMarkdownFiles().filter((note) => ['Frameworks/NIST 800-53', 'Frameworks/MITRE ATT&CK', 'Frameworks/CRI Profile'].some((root) => note.path.startsWith(root)))) {
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
			const edges = app.vault.getMarkdownFiles().filter((file) => file.path.startsWith('_crosswalker/mappings/'));
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
		expect(result.paths).toContain('Frameworks/NIST 800-53/ZZ/ZZ.md');
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
			paths: app.vault.getMarkdownFiles().filter((file) => ['Frameworks/NIST 800-53', 'Frameworks/MITRE ATT&CK', 'Frameworks/CRI Profile'].some((root) => file.path.startsWith(root))).map((file) => file.path),
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
			unindexedFrameworks: app.vault.getMarkdownFiles().filter((file) => file.path.startsWith('Frameworks/') && !app.metadataCache.getFileCache(file)).map((file) => file.path),
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
});
