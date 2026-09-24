import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { toDefinition } from '../../src/import/stack/stack-persistence';
import { RECIPE_REGISTRY } from '../../src/import/recipe-registry';

const OUT = path.resolve('test-screenshots');
const HEADERS = ['Control Identifier', 'Control (or Enhancement) Name', 'Control Text', 'Discussion', 'Related Controls'];
const select = { chosen: ['nist-800-53', 'cis-v8', 'scf'], optionalMappings: [], connectorExcluded: false, detail: 'max' as const };
async function click(text: string): Promise<void> {
	const found = await browser.executeObsidian((_obs, label) => {
		const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-stack-modal button'))
			.find((item) => item.textContent?.trim() === label);
		button?.click(); return !!button;
	}, text);
	expect(found).toBe(true);
}
async function home(): Promise<void> {
	await browser.executeObsidian(async ({ app }) => {
		for (const leaf of app.workspace.getLeavesOfType('crosswalker-workspace')) leaf.detach();
		const leaf = app.workspace.getLeaf(true);
		await leaf.setViewState({ type: 'crosswalker-workspace', active: true });
		await app.workspace.revealLeaf(leaf);
	});
	await browser.waitUntil(async () => browser.executeObsidian(({ app }) => {
		// @ts-expect-error Obsidian plugin manager internal
		const count = app.plugins.plugins['crosswalker']?.settings?.stacks?.length ?? -1;
		return count > 0 && !!document.querySelector('.crosswalker-workspace-view .crosswalker-installed-stacks');
	}), { timeout: 15_000, timeoutMsg: 'Installed stacks panel not visible after opening workspace' });
}

describe('Installed stacks and revisit on synthetic data', function () {
	this.timeout(240_000);
	before(() => { mkdirSync(OUT, { recursive: true }); });
	it('persists a completed framework, shows three states, defaults to skip, and deletes no vault files', async () => {
		const book = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([HEADERS,
			['ZZ-1', 'Invented control', 'Invented text', 'Invented discussion', '']]), 'Controls');
		const bytes = Array.from(new Uint8Array(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })));
		await browser.executeObsidian(async ({ app }, payload) => {
			if (!app.vault.getAbstractFileByPath('Sources')) await app.vault.createFolder('Sources');
			await app.vault.createBinary('Sources/synthetic-installed-nist.xlsx', new Uint8Array(payload).buffer);
			// @ts-expect-error Obsidian internal command registry
			app.commands.executeCommandById('crosswalker:set-up-framework-stack');
		}, bytes);
		await $('.crosswalker-stack-modal').waitForDisplayed();
		await browser.executeObsidian(() => {
			let unwanted = document.querySelector<HTMLInputElement>('.crosswalker-stack-choice input[data-ontology]:checked:not([data-ontology="nist-800-53"])');
			while (unwanted) { unwanted.click(); unwanted = document.querySelector<HTMLInputElement>('.crosswalker-stack-choice input[data-ontology]:checked:not([data-ontology="nist-800-53"])'); }
		});
		await click('Next: download checklist'); await click('Next: add the files');
		await browser.executeObsidian(() => {
			const input = document.querySelector<HTMLInputElement>('.crosswalker-stack-modal input[placeholder="Sources"]');
			if (input) { input.value = 'Sources'; input.dispatchEvent(new Event('input', { bubbles: true })); }
		});
		await click('Choose folder');
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			Array.from(document.querySelectorAll('.crosswalker-stack-result[data-slot]')).some((item) => item.textContent?.includes('Recognized'))),
		{ timeout: 20_000, timeoutMsg: 'Synthetic source did not recognize' });
		await click('Next: review');
		await click('Import stack');
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			document.querySelector('.crosswalker-stack-modal h2')?.textContent === 'Framework stack imported'),
		{ timeout: 60_000, timeoutMsg: 'Synthetic framework did not import' });
		await click('Done');
		const saved = await browser.executeObsidian(async ({ app }, definition) => {
			// @ts-expect-error Obsidian plugin manager internal
			const plugin = app.plugins.plugins['crosswalker'];
			const old = plugin.settings.stacks[plugin.settings.stacks.length - 1];
			const next = { ...definition, id: old.id, createdAt: old.createdAt };
			const run = plugin.settings.stackRuns.find((item: { stackId: string }) => item.stackId === old.id);
			const cis = next.slots.find((item: { presetId: string }) => item.presetId.includes('cis-controls'));
			if (!run || !cis) throw new Error('Imported set or synthetic missing-slot fixture absent');
			run.slotSets[cis.presetId] = { importSetId: 'iset-missing-synthetic', sourceDigest: 'synthetic',
				recipeDigest: 'synthetic', sourceName: 'invented-missing.xlsx' };
			plugin.settings.stacks = [next];
			await plugin.saveSettings();
			return { stackId: next.id, factId: Object.values(run.slotSets)[0].importSetId };
		}, toDefinition(select, 'stack-xxxxxx', 'Invented installed stack'));
		await home();
		await browser.waitUntil(async () => browser.executeObsidian(() => {
			const text = document.querySelector('.crosswalker-installed-stacks')?.textContent ?? '';
			return text.includes('iset-missing-synthetic') && text.includes('Not imported yet') && text.includes('notes');
		}), { timeout: 20_000, timeoutMsg: 'Installed states did not render' });
		const panel = await browser.executeObsidian(() => document.querySelector('.crosswalker-installed-stacks')?.textContent ?? '');
		expect(panel).toContain(`set ${saved.factId}`);
		expect(panel).toContain('Set iset-missing-synthetic is no longer in this vault. Import as a new set.');
		expect(panel).toContain('Not imported yet');
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error Obsidian plugin manager internal
			await app.plugins.disablePlugin('crosswalker');
			// @ts-expect-error Obsidian plugin manager internal
			await app.plugins.enablePlugin('crosswalker');
		});
		await home();
		expect(await browser.executeObsidian(() => document.querySelector('.crosswalker-installed-stacks')?.textContent ?? '')).toContain('Invented installed stack');
		for (const theme of ['light', 'dark'] as const) {
			await browser.executeObsidian((_obs, value) => {
				document.querySelectorAll('.notice-container .notice, .notice-container, .mod-toast').forEach((item) => item.remove());
				document.body.classList.toggle('theme-light', value === 'light');
				document.body.classList.toggle('theme-dark', value === 'dark');
			}, theme);
			await browser.saveScreenshot(path.join(OUT, theme === 'light' ? 'visual-stack-09-installed.png' : 'visual-stack-09-installed-dark.png'));
		}
		const bytesBefore = await browser.executeObsidian(async ({ app }) => {
			const file = app.vault.getMarkdownFiles().find((item) => item.path.includes('ZZ-1.md') && item.path.startsWith('Frameworks/'));
			return file ? { path: file.path, text: await app.vault.read(file) } : null;
		});
		expect(bytesBefore).not.toBeNull();
		await browser.executeObsidian(() => {
			const panel = document.querySelector('.crosswalker-installed-stacks');
			Array.from(panel?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((item) => item.textContent === 'Run again')?.click();
		});
		await $('.crosswalker-stack-modal').waitForDisplayed();
		await browser.executeObsidian(() => {
			const input = document.querySelector<HTMLInputElement>('.crosswalker-stack-modal input[placeholder="Sources"]');
			if (input) { input.value = 'Sources'; input.dispatchEvent(new Event('input', { bubbles: true })); }
		});
		await click('Choose folder'); await click('Next: review');
		const options = await browser.executeObsidian(() => {
			const row = document.querySelector('.crosswalker-stack-modal .crosswalker-stack-result[data-slot="nist-800-53"]');
			return { selected: row?.querySelector('select')?.selectedOptions[0]?.textContent,
				text: document.querySelector('.crosswalker-stack-modal')?.textContent ?? '' };
		});
		expect(options.selected).toBe('Skip (already imported, unchanged)');
		expect(options.text).toContain('Set iset-missing-synthetic is no longer in this vault. Import as a new set.');
		await click('Import stack');
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			document.querySelector('.crosswalker-stack-modal h2')?.textContent === 'Framework stack imported'),
		{ timeout: 40_000, timeoutMsg: 'Write-free revisit did not finish' });
		expect(await browser.executeObsidian(() => document.querySelector('.crosswalker-stack-modal')?.textContent ?? '')).toContain('0 framework notes created or updated');
		await click('Done');
		const bytesAfterSkip = await browser.executeObsidian(async ({ app }) => {
			const file = app.vault.getMarkdownFiles().find((item) => item.path.includes('ZZ-1.md') && item.path.startsWith('Frameworks/'));
			return file ? { path: file.path, text: await app.vault.read(file) } : null;
		});
		expect(bytesAfterSkip).toEqual(bytesBefore);
		const changedBook = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(changedBook, XLSX.utils.aoa_to_sheet([HEADERS,
			['ZZ-1', 'Invented control', 'Changed invented text', 'Invented discussion', '']]), 'Controls');
		const changedBytes = Array.from(new Uint8Array(XLSX.write(changedBook, { type: 'buffer', bookType: 'xlsx' })));
		await browser.executeObsidian(async ({ app }, payload) => {
			const file = app.vault.getAbstractFileByPath('Sources/synthetic-installed-nist.xlsx');
			if (!file || !('extension' in file)) throw new Error('Synthetic source missing');
			await app.vault.modifyBinary(file, new Uint8Array(payload).buffer);
		}, changedBytes);
		await browser.executeObsidian(() => {
			Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-installed-stacks button'))
				.find((item) => item.textContent === 'Run again')?.click();
		});
		await browser.executeObsidian(() => {
			const input = document.querySelector<HTMLInputElement>('.crosswalker-stack-modal input[placeholder="Sources"]');
			if (input) { input.value = 'Sources'; input.dispatchEvent(new Event('input', { bubbles: true })); }
		});
		await click('Choose folder'); await click('Next: review');
		const changedChoice = await browser.executeObsidian(() => {
			const dropdown = document.querySelector<HTMLSelectElement>('.crosswalker-stack-modal [data-slot="nist-800-53"] select');
			return { selected: dropdown?.value, options: Array.from(dropdown?.options ?? []).map((item) => item.textContent) };
		});
		expect(changedChoice.selected).toBe('new');
		expect(changedChoice.options).toContain(`Refresh set ${saved.factId}`);
		await browser.executeObsidian(() => {
			const dropdown = document.querySelector<HTMLSelectElement>('.crosswalker-stack-modal [data-slot="nist-800-53"] select');
			if (dropdown) { dropdown.value = 'refresh'; dropdown.dispatchEvent(new Event('change', { bubbles: true })); }
		});
		await click('Import stack');
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			document.querySelector('.crosswalker-stack-modal h2')?.textContent === 'Framework stack imported'),
		{ timeout: 40_000, timeoutMsg: 'Explicit framework refresh did not finish' });
		await click('Done');
		const refreshed = await browser.executeObsidian(async ({ app }, id) => {
			// @ts-expect-error Obsidian plugin manager internal
			const plugin = app.plugins.plugins['crosswalker'];
			const fact = Object.values(plugin.settings.stackRuns[0].slotSets).find((item: { importSetId: string }) => item.importSetId === id);
			const file = app.vault.getMarkdownFiles().find((item) => item.path.includes('ZZ-1.md') && item.path.startsWith('Frameworks/'));
			return { sameId: !!fact, changed: file ? (await app.vault.read(file)).includes('Changed invented text') : false };
		}, saved.factId);
		expect(refreshed).toEqual({ sameId: true, changed: true });
		const bytesAfterRefresh = await browser.executeObsidian(async ({ app }) => {
			const file = app.vault.getMarkdownFiles().find((item) => item.path.includes('ZZ-1.md') && item.path.startsWith('Frameworks/'));
			return file ? { path: file.path, text: await app.vault.read(file) } : null;
		});
		await browser.executeObsidian(() => {
			Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-settings-launchpad button'))
				.find((item) => item.textContent?.trim() === 'Import a stack')?.click();
		});
		await browser.executeObsidian(() => {
			const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Stack JSON"]');
			if (input) { input.value = '{broken'; input.dispatchEvent(new Event('input', { bubbles: true })); }
			Array.from(document.querySelectorAll<HTMLButtonElement>('.modal-container button')).find((item) => item.textContent === 'Import')?.click();
		});
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			(document.querySelector('.modal-container textarea[aria-label="Stack JSON"]')?.parentElement?.textContent ?? '').includes('Stack JSON is not valid')),
		{ timeout: 5000, timeoutMsg: 'Malformed import did not explain JSON failure' });
		await browser.executeObsidian(({ app }) => {
			// @ts-expect-error Obsidian plugin manager internal
			const json = JSON.stringify(app.plugins.plugins['crosswalker'].settings.stacks[0]);
			const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Stack JSON"]');
			if (input) { input.value = json; input.dispatchEvent(new Event('input', { bubbles: true })); }
			Array.from(document.querySelectorAll<HTMLButtonElement>('.modal-container button')).find((item) => item.textContent === 'Import')?.click();
		});
		await browser.waitUntil(async () => browser.executeObsidian(({ app }) => {
			// @ts-expect-error Obsidian plugin manager internal
			return app.plugins.plugins['crosswalker']?.settings?.stacks?.length === 2;
		}), { timeout: 10_000, timeoutMsg: 'Exported stack did not import' });
		const cloned = await browser.executeObsidian(({ app }) => {
			// @ts-expect-error Obsidian plugin manager internal
			const plugin = app.plugins.plugins['crosswalker'];
			return { ids: plugin.settings.stacks.map((item: { id: string }) => item.id), runs: plugin.settings.stackRuns.map((item: { stackId: string }) => item.stackId) };
		});
		expect(new Set(cloned.ids).size).toBe(2);
		expect(cloned.runs).not.toContain(cloned.ids[1]);
		await browser.executeObsidian(() => {
			const cards = document.querySelectorAll('.crosswalker-installed-stacks [data-stack-id]');
			for (const card of cards) {
				Array.from(card.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent === 'Delete')?.click();
				break;
			}
		});
		const warning = await browser.executeObsidian(() => document.querySelector('.modal-container:last-child')?.textContent ?? '');
		expect(warning).toContain('notes and import sets stay in the vault');
		await browser.executeObsidian(() => {
			Array.from(document.querySelectorAll<HTMLButtonElement>('.modal-container button')).find((item) => item.textContent === 'Delete stack')?.click();
		});
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			document.querySelectorAll('.crosswalker-installed-stacks [data-stack-id]').length === 1),
		{ timeout: 10_000, timeoutMsg: 'First stack deletion did not update the launchpad' });
		await browser.executeObsidian(() => {
			const card = document.querySelector('.crosswalker-installed-stacks [data-stack-id]');
			Array.from(card?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((item) => item.textContent === 'Delete')?.click();
			Array.from(document.querySelectorAll<HTMLButtonElement>('.modal-container button')).find((item) => item.textContent === 'Delete stack')?.click();
		});
		await browser.waitUntil(async () => browser.executeObsidian(() => !document.querySelector('.crosswalker-installed-stacks')),
			{ timeout: 10_000, timeoutMsg: 'Saved stack still displayed after deletion' });
		const bytesAfter = await browser.executeObsidian(async ({ app }) => {
			const file = app.vault.getMarkdownFiles().find((item) => item.path.includes('ZZ-1.md') && item.path.startsWith('Frameworks/'));
			return file ? { path: file.path, text: await app.vault.read(file) } : null;
		});
		expect(bytesAfter).toEqual(bytesAfterRefresh);
		const persisted = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error Obsidian plugin manager internal
			await app.plugins.disablePlugin('crosswalker');
			// @ts-expect-error Obsidian plugin manager internal
			await app.plugins.enablePlugin('crosswalker');
			// @ts-expect-error Obsidian plugin manager internal
			return app.plugins.plugins['crosswalker'].settings.stacks.length;
		});
		expect(persisted).toBe(0);
	});

	it('refreshes one populated from-slot link set without tracking it as a separate mapping', async () => {
		const cri = RECIPE_REGISTRY.find((entry) => entry.id === 'cri-profile-v2-2-flat')!;
		const criColumns = Array.from(new Set([...cri.signatureColumns, 'NIST CSF v2 Mapping']));
		const workbook = (sheet: string, headers: string[], row: Record<string, string>, banner = false): number[] => {
			const book = XLSX.utils.book_new();
			const prefix = banner ? [['Synthetic banner'], []] : [];
			XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([...prefix, headers, headers.map((name) => row[name] ?? '')]), sheet);
			return Array.from(new Uint8Array(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })));
		};
		const criSource = (text: string) => workbook('CRI Profile v2.2 Structure', criColumns, {
			'Profile Id': 'ZZ.ZZ-01.01', Level: 'DS', 'Outline Id': 'Z.1',
			'CRI Profile Function / Category / Subcategory': 'Invented / Category / Subcategory',
			'CRI Profile v2.2 Diagnostic Statement': text,
			'NIST CSF v2 Mapping': 'GV.XX-01',
		}, true);
		const sources = [
			{ name: 'synthetic-from-slot-cri.xlsx', bytes: criSource('Invented statement.') },
			{ name: 'synthetic-from-slot-csf.xlsx', bytes: workbook('CSF', ['element_identifier', 'element_type', 'text'], {
				element_identifier: 'GV.XX-01', element_type: 'subcategory', text: 'Invented CSF outcome.',
			}) },
		];
		await browser.executeObsidian(async ({ app }, payload) => {
			if (!app.vault.getAbstractFileByPath('Sources')) await app.vault.createFolder('Sources');
			for (const item of payload) await app.vault.createBinary(`Sources/${item.name}`, new Uint8Array(item.bytes).buffer);
			// @ts-expect-error Obsidian internal command registry
			app.commands.executeCommandById('crosswalker:set-up-framework-stack');
		}, sources);
		await $('.crosswalker-stack-modal').waitForDisplayed();
		await browser.executeObsidian(() => {
			for (const id of ['nist-800-53', 'mitre-attack', 'cis-v8', 'scf']) {
				const choice = document.querySelector<HTMLInputElement>(`.crosswalker-stack-choice input[data-ontology="${id}"]`);
				if (choice?.checked) choice.click();
			}
			for (const id of ['cri-profile', 'nist-csf-2']) {
				const choice = document.querySelector<HTMLInputElement>(`.crosswalker-stack-choice input[data-ontology="${id}"]`);
				if (choice && !choice.checked) choice.click();
			}
		});
		await click('Next: download checklist'); await click('Next: add the files');
		await browser.executeObsidian(() => {
			const input = document.querySelector<HTMLInputElement>('.crosswalker-stack-modal input[placeholder="Sources"]');
			if (input) { input.value = 'Sources'; input.dispatchEvent(new Event('input', { bubbles: true })); }
		});
		await click('Choose folder');
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			Array.from(document.querySelectorAll('.crosswalker-stack-result[data-slot]')).filter((row) =>
				row.textContent?.includes('Recognized')).length === 2),
		{ timeout: 20_000, timeoutMsg: 'Synthetic CRI and CSF files did not recognize' });
		await click('Next: review');
		await click('Import stack');
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			document.querySelector('.crosswalker-stack-modal h2')?.textContent === 'Framework stack imported'),
		{ timeout: 60_000, timeoutMsg: 'Populated from-slot stack did not import' });
		const before = await browser.executeObsidian(async ({ app }) => {
			const files = app.vault.getMarkdownFiles().filter((file) => file.path.startsWith('_crosswalker/mappings/cri-profile-to-nist-csf-2/'));
			return Promise.all(files.map(async (file) => ({ path: file.path, text: await app.vault.read(file) })));
		});
		expect(before).toHaveLength(1);
		expect(before[0].text).toContain('import_set:');
		await click('Done'); await home();
		const fromSlot = 'Comes with CRI Profile v2.2. Not tracked separately.';
		expect(await browser.executeObsidian(() => document.querySelector('.crosswalker-installed-stacks')?.textContent ?? '')).toContain(fromSlot);
		await browser.executeObsidian(async ({ app }, bytes) => {
			const file = app.vault.getAbstractFileByPath('Sources/synthetic-from-slot-cri.xlsx');
			if (!file || !('extension' in file)) throw new Error('Synthetic CRI source missing');
			await app.vault.modifyBinary(file, new Uint8Array(bytes).buffer);
		}, criSource('Changed invented statement.'));
		await browser.executeObsidian(() => {
			Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-installed-stacks button'))
				.find((button) => button.textContent === 'Run again')?.click();
		});
		await $('.crosswalker-stack-modal').waitForDisplayed();
		await browser.executeObsidian(() => {
			const input = document.querySelector<HTMLInputElement>('.crosswalker-stack-modal input[placeholder="Sources"]');
			if (input) { input.value = 'Sources'; input.dispatchEvent(new Event('input', { bubbles: true })); }
		});
		await click('Choose folder'); await click('Next: review');
		const choices = await browser.executeObsidian(() => {
			const row = document.querySelector('.crosswalker-stack-result[data-slot="cri-profile"]');
			return Array.from(row?.querySelectorAll('select option') ?? []).map((option) => option.textContent);
		});
		expect(choices.some((choice) => choice?.startsWith('Refresh set '))).toBe(true);
		await browser.executeObsidian(() => {
			const dropdown = document.querySelector<HTMLSelectElement>('.crosswalker-stack-result[data-slot="cri-profile"] select');
			if (dropdown) { dropdown.value = 'refresh'; dropdown.dispatchEvent(new Event('change', { bubbles: true })); }
		});
		await click('Import stack');
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			document.querySelector('.crosswalker-stack-modal h2')?.textContent === 'Framework stack imported'),
		{ timeout: 60_000, timeoutMsg: 'Synthetic from-slot refresh did not finish' });
		expect(await browser.executeObsidian(() => document.querySelector('.crosswalker-stack-modal')?.textContent ?? ''))
			.toContain('1 framework crosswalk link created or updated; 0 framework crosswalk links already up to date');
		await click('Done'); await home();
		expect(await browser.executeObsidian(() => document.querySelector('.crosswalker-installed-stacks')?.textContent ?? '')).toContain(fromSlot);
		const after = await browser.executeObsidian(async ({ app }) => {
			const files = app.vault.getMarkdownFiles().filter((file) => file.path.startsWith('_crosswalker/mappings/cri-profile-to-nist-csf-2/'));
			return Promise.all(files.map(async (file) => ({ path: file.path, text: await app.vault.read(file) })));
		});
		expect(after).toHaveLength(1);
		expect(after[0].path).toBe(before[0].path);
		const setId = (text: string) => text.match(/import_set:\s*\n\s*id:\s*([^\s]+)/)?.[1];
		expect(setId(before[0].text)).toBeTruthy();
		expect(setId(after[0].text)).toBe(setId(before[0].text));
	});
});
