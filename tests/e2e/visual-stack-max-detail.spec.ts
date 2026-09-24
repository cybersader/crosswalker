import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { RECIPE_REGISTRY } from '../../src/import/recipe-registry';

const OUT = path.resolve('test-screenshots');
const cri = RECIPE_REGISTRY.find((item) => item.id === 'cri-profile-v2-2-nested')!;
function workbook(sheet: string, columns: string[], records: Record<string, string>[], headerRow = 0): number[] {
	const book = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
		...Array.from({ length: headerRow }, () => ['Synthetic banner']),
		columns,
		...records.map((record) => columns.map((column) => record[column] ?? '')),
	]), sheet);
	return Array.from(new Uint8Array(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })));
}
async function press(label: string): Promise<void> {
	const found = await browser.executeObsidian((_obs, text) => {
		const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-stack-modal button'))
			.find((candidate) => candidate.textContent?.trim() === text);
		button?.click(); return !!button;
	}, label);
	expect(found).toBe(true);
}
async function importOne(ontology: string): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		// @ts-expect-error -- Obsidian internal command registry
		app.commands.executeCommandById('crosswalker:set-up-framework-stack');
	});
	await $('.crosswalker-stack-modal').waitForDisplayed();
	await browser.executeObsidian((_obs, keep) => {
		let unwanted = document.querySelector<HTMLInputElement>(`.crosswalker-stack-choice input[data-ontology]:checked:not([data-ontology="${keep}"])`);
		while (unwanted) {
			unwanted.click(); // picker re-renders after every change; reacquire the live control
			unwanted = document.querySelector<HTMLInputElement>(`.crosswalker-stack-choice input[data-ontology]:checked:not([data-ontology="${keep}"])`);
		}
	}, ontology);
	await press('Next: download checklist');
	await press('Next: add the files');
	await browser.executeObsidian(() => {
		const input = document.querySelector<HTMLInputElement>('.crosswalker-stack-modal input[placeholder="Sources"]');
		if (input) { input.value = 'Sources'; input.dispatchEvent(new Event('input', { bubbles: true })); }
	});
	await press('Choose folder');
	await browser.waitUntil(async () => await browser.executeObsidian(() =>
		Array.from(document.querySelectorAll('.crosswalker-stack-result[data-slot]')).some((row) => row.textContent?.includes('Recognized'))),
	{ timeout: 20_000, timeoutMsg: 'Synthetic stack source was not recognized' });
	await press('Next: review');
	await press('Import stack');
	await browser.waitUntil(async () => await browser.executeObsidian(() =>
		(document.querySelector('.crosswalker-stack-modal h2')?.textContent ?? '') === 'Framework stack imported'),
	{ timeout: 60_000, timeoutMsg: 'Synthetic stack import did not finish' });
	const summary = await browser.executeObsidian(() => document.querySelector('.crosswalker-stack-modal')?.textContent ?? '');
	expect(summary).not.toContain('prefix-index-missing');
	expect(summary).not.toContain('folder-level-skipped');
	expect(summary).not.toContain('could not be imported');
	await press('Done');
}
async function showExplorer(folders: string[]): Promise<void> {
	for (const folder of ['Frameworks', ...folders]) {
		const selector = `.nav-folder.is-collapsed > .nav-folder-title[data-path="${folder}"] .collapse-icon`;
		const control = await $(selector);
		if (await control.isExisting()) await control.click();
		await browser.waitUntil(async () => await $(`.nav-folder > .nav-folder-title[data-path="${folder}"]`).isExisting(),
			{ timeout: 5000, timeoutMsg: `Explorer folder missing: ${folder}` });
	}
	await browser.pause(300);
}


describe('Visual — nested stack imports on invented source rows', function () {
	this.timeout(120_000);
	before(() => { mkdirSync(OUT, { recursive: true }); });
	it('shows NIST family folders, control folder notes and enhancement notes', async () => {
		const records = ['ZZ-1', 'ZZ-1(1)', 'ZZ-2', 'YY-1', 'YY-1(2)', 'XX-3'].map((id) => ({
			'Control Identifier': id, 'Control (or Enhancement) Name': `Invented ${id}`,
			'Control Text': 'Invented control text.', Discussion: 'Invented discussion.', 'Related Controls': '',
		}));
		await browser.executeObsidian(async ({ app }, bytes) => {
			if (!app.vault.getAbstractFileByPath('Sources')) await app.vault.createFolder('Sources');
			await app.vault.createBinary('Sources/invented-nist.xlsx', new Uint8Array(bytes).buffer);
		}, workbook('Controls', ['Control Identifier', 'Control (or Enhancement) Name', 'Control Text', 'Discussion', 'Related Controls'], records));
		await importOne('nist-800-53');
		const paths = await browser.executeObsidian(({ app }) => app.vault.getMarkdownFiles()
			.filter((file) => file.path.startsWith('Frameworks/NIST 800-53/')).map((file) => file.path).sort());
		expect(paths).toHaveLength(9);
		for (const family of ['ZZ', 'YY', 'XX']) {
			const file = `Frameworks/NIST 800-53/${family}/${family}.md`;
			expect(paths).toContain(file);
			const frontmatter = await browser.executeObsidian(async ({ app }, notePath) => {
				const note = app.vault.getAbstractFileByPath(notePath);
				return note && 'extension' in note ? await app.vault.read(note) : '';
			}, file);
			expect(frontmatter).toMatch(new RegExp(`^curie: ["']?nist-800-53:${family}["']?$`, 'm'));
			expect(frontmatter).toContain('implied_level: family');
		}
		expect(paths).toContain('Frameworks/NIST 800-53/ZZ/ZZ-1/ZZ-1.md');
		expect(paths).toContain('Frameworks/NIST 800-53/ZZ/ZZ-1/ZZ-1(1).md');
		expect(paths).toContain('Frameworks/NIST 800-53/YY/YY-1/YY-1(2).md');
		await showExplorer(['Frameworks/NIST 800-53', 'Frameworks/NIST 800-53/ZZ', 'Frameworks/NIST 800-53/ZZ/ZZ-1', 'Frameworks/NIST 800-53/YY', 'Frameworks/NIST 800-53/YY/YY-1', 'Frameworks/NIST 800-53/XX', 'Frameworks/NIST 800-53/XX/XX-3']);
		await browser.saveScreenshot(path.join(OUT, 'visual-stack-07-nested-800-53.png'));
		await browser.executeObsidian(async ({ app }) => {
			const note = app.vault.getAbstractFileByPath('Frameworks/NIST 800-53/ZZ/ZZ.md');
			if (!note || !('extension' in note)) throw new Error('Synthetic family concept note missing');
			await app.workspace.getLeaf(false).openFile(note);
		});
		await browser.pause(400);
		await browser.saveScreenshot(path.join(OUT, 'visual-stack-07-implied-family.png'));
	});
	it('shows only synthetic CRI function, category, subcategory and diagnostic statement', async () => {
		const ids = [['GV', 'F'], ['GV.OC', 'C'], ['GV.OC-01', 'S'], ['GV.OC-01.01', 'DS'], ['GV.OC-01.02', 'DS']];
		const records = ids.map(([id, level]) => Object.fromEntries(cri.signatureColumns.map((key) => [key,
			key === 'Profile Id' ? id : key === 'Level' ? level : key === 'CRI Profile Function / Category / Subcategory'
				? 'Invented / Category / Subcategory' : key === 'CRI Profile v2.2 Diagnostic Statement' ? 'Invented statement.' : ''])));
		await browser.executeObsidian(async ({ app }, bytes) => {
			await app.vault.createBinary('Sources/invented-cri.xlsx', new Uint8Array(bytes).buffer);
		}, workbook('CRI Profile v2.2 Structure', cri.signatureColumns, records, 2));
		await importOne('cri-profile');
		const paths = await browser.executeObsidian(({ app }) => app.vault.getMarkdownFiles()
			.filter((file) => file.path.startsWith('Frameworks/CRI Profile/')).map((file) => file.path).sort());
		expect(paths).toHaveLength(5);
		expect(paths).toContain('Frameworks/CRI Profile/GV/GV.md');
		expect(paths).toContain('Frameworks/CRI Profile/GV/GV.OC/GV.OC-01/GV.OC-01.01.md');
		await browser.executeObsidian(async ({ app }) => {
			const nistFolder = app.vault.getAbstractFileByPath('Frameworks/NIST 800-53');
			if (nistFolder) await app.vault.delete(nistFolder, true);
		});
		await showExplorer(['Frameworks/CRI Profile', 'Frameworks/CRI Profile/GV', 'Frameworks/CRI Profile/GV/GV.OC', 'Frameworks/CRI Profile/GV/GV.OC/GV.OC-01']);
		await browser.saveScreenshot(path.join(OUT, 'visual-stack-08-nested-cri.png'));
	});
});
