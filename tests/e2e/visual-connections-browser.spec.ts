/** Synthetic read-only list navigation. No native local-graph production action. */
import { browser, $, $$ } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fixture, assertion, table, SOURCE, TARGET } from '../helpers/connections-fixture';
const OUT = path.resolve('test-screenshots');
let root: string;
async function open() {
	await browser.executeObsidian(({ app }) => {
		// @ts-expect-error internal command API
		app.commands.executeCommandById('crosswalker:explore-framework-connections');
	});
	await $('.crosswalker-connections').waitForDisplayed({ timeout: 20000 });
	await $('[aria-label="Source set"]').waitForExist({ timeout: 20000 });
}
async function choose() {
	await $('[aria-label="Source set"]').selectByAttribute('value', SOURCE);
	await $('[aria-label="Target set"]').selectByAttribute('value', TARGET);
	await browser.waitUntil(async () => (await $('.cw-connections-output').getText()).includes('Connections:'), { timeout: 20000 });
}
async function close() {
	await $('.cw-connections-close').click();
	await $('.crosswalker-connections-modal').waitForExist({ reverse: true });
}
async function snapshot() {
	return browser.executeObsidian(async ({ app }) => {
		const files: Record<string, string> = {};
		for (const f of app.vault.getFiles()) files[f.path] = await app.vault.read(f);
		return { files, graph: await app.vault.adapter.read(`${app.vault.configDir}/graph.json`), data: await app.vault.adapter.read(`${app.vault.configDir}/plugins/crosswalker/data.json`) };
	});
}
describe('Readable Connections browser', function () {
	this.timeout(180000);
	before(async () => {
		mkdirSync(OUT, { recursive: true }); root = fixture();
		for (let n = 0; n < 45; n++) assertion(root, `Mappings/${n}.md`, `edge:${String(n).padStart(3, '0')}`, { mapping_provider: 'Recorded provider', subject_note: '[[Renamed/Access]]', object_note: '[[Moved/Backups]]' });
		table(root, [{ subject_id: 'same:A', object_id: 'same:B', predicate_id: 'is_equivalent_to', predicate_modifier: 'NOT', mapping_provider: 'Table equivalence' }, { subject_id: 'same:A', object_id: 'same:B', predicate_id: 'no_relationship', predicate_modifier: 'NOT', mapping_provider: 'Table no relationship' }], 'iset-tttttt');
		mkdirSync(path.join(root, '.obsidian/plugins/crosswalker'), { recursive: true });
		writeFileSync(path.join(root, '.obsidian/graph.json'), '{"search":"chosen saved search","showTags":true}');
		writeFileSync(path.join(root, '.obsidian/plugins/crosswalker/data.json'), '{"enableTier2Projection":false}');
		await browser.reloadObsidian({ vault: root });
		await browser.waitUntil(async () => browser.executeObsidian(({ app }) => app.vault.getMarkdownFiles().some((f) => f.path === 'Mappings/44.md') && app.vault.getMarkdownFiles().every((f) => app.metadataCache.getFileCache(f) !== null)), { timeout: 60000 });
	});
	it('selects, pages and searches; opens actual notes/table; ignores stale requests; writes no data in either theme', async () => {
		const before = await snapshot();
		await open();
		expect(await $('[aria-label="Source set"]').getValue()).toBe(''); expect(await $('[aria-label="Target set"]').getValue()).toBe('');
		await $('[aria-label="Find source set"]').setValue('Policy release one');
		await choose();
		await $('[aria-label="Focal concept"]').selectByVisibleText('Access policy · same:A (iset-aaaaaa)');
		await browser.waitUntil(async () => (await $$('.cw-connection-row')).length === 40, { timeout: 10000 });
		expect(await $$('.cw-connection-row')).toHaveLength(40);
		expect(await $('.cw-connections-output').getText()).toContain('Negative relationships: 2');
		await $('.cw-connections-pagination').$('button=Next page').click();
		await browser.waitUntil(async () => (await $('.cw-connections-pagination').getText()).includes('Rows 41–47'), { timeout: 10000 });
		expect(await $$('.cw-connection-row')).toHaveLength(7);
		await $('[aria-label="Search recorded connections"]').setValue('edge:000');
		await browser.waitUntil(async () => (await $$('.cw-connection-row')).length === 1, { timeout: 10000 });
		const row = $('.cw-connection-row');
		await row.$('summary=Source details and recorded fields').click();
		expect(await row.getText()).toContain('Synthetic/publisher status not recorded');
		await row.$('summary=Source details and recorded fields').click();
		await browser.waitUntil(async () => browser.execute(() => document.querySelectorAll('.notice').length === 0), { timeout: 20000 });
		await browser.execute(() => { document.querySelector('.crosswalker-connections')!.scrollTop = 0; });
		for (const theme of ['light', 'dark'] as const) {
			await browser.executeObsidian(({ app }, t) => { (app as unknown as { changeTheme(t: string): void }).changeTheme(t === 'dark' ? 'obsidian' : 'moonstone'); }, theme);
			await browser.pause(300);
			const visible = await browser.execute(() => {
				const card = document.querySelector('.cw-connection-row')!.getBoundingClientRect();
				const action = Array.from(document.querySelectorAll('.cw-connection-row button')).find((b) => b.textContent === 'Open assertion note')!.getBoundingClientRect();
				const content = document.querySelector('.crosswalker-connections-modal .modal-content')!.getBoundingClientRect();
				return card.top >= content.top && card.bottom <= Math.min(content.bottom, window.innerHeight) && action.bottom <= Math.min(content.bottom, window.innerHeight);
			}); expect(visible).toBe(true);
			await browser.saveScreenshot(path.join(OUT, `connections-browser-${theme}.png`));
		}
		await row.$('button=Open assertion note').click();
		expect(await browser.executeObsidian(({ app }) => app.workspace.getLeavesOfType('markdown').some((l) => (l.view as unknown as { file?: { path: string } }).file?.path === 'Mappings/0.md'))).toBe(true);
		await row.$('button=Open concept note').click();
		expect(await browser.executeObsidian(({ app }) => app.workspace.getLeavesOfType('markdown').some((l) => (l.view as unknown as { file?: { path: string } }).file?.path === 'Renamed/Access.md'))).toBe(true);
		for (const [search, predicate, gloss, shot] of [
			['Table equivalence', 'is_equivalent_to', 'Exactly the same requirement', 'equivalence'],
			['Table no relationship', 'no_relationship', 'No relationship asserted', 'no-relationship'],
		]) {
			await $('[aria-label="Search recorded connections"]').setValue(search);
			await browser.waitUntil(async () => (await $$('.cw-connection-row')).length === 1 && (await $('.cw-connection-row').getText()).includes('Table row:'), { timeout: 10000 });
			const negative = $('.cw-connection-row');
			expect(await negative.$('details').getProperty('open')).toBe(false);
			for (const theme of ['light', 'dark'] as const) {
				await browser.executeObsidian(({ app }, t) => { (app as unknown as { changeTheme(t: string): void }).changeTheme(t === 'dark' ? 'obsidian' : 'moonstone'); }, theme);
				await browser.pause(300);
				const primary = negative.$('.cw-connection-predicate');
				expect(await primary.isDisplayed()).toBe(true);
				expect(await primary.getText()).toBe(`NOT: ${gloss}`);
				expect(await browser.execute(() => {
					const relation = document.querySelector('.cw-connection-predicate')!.getBoundingClientRect();
					const content = document.querySelector('.crosswalker-connections-modal .modal-content')!.getBoundingClientRect();
					return relation.top >= content.top && relation.bottom <= Math.min(content.bottom, window.innerHeight);
				})).toBe(true);
				await browser.saveScreenshot(path.join(OUT, `connections-browser-negative-${shot}-${theme}.png`));
			}
			await negative.$('summary=Source details and recorded fields').click();
			expect(await negative.getText()).toContain(`Recorded relationship: NOT ${predicate}`);
			await negative.$('summary=Source details and recorded fields').click();
		}
		await $('.cw-connection-row').$('button=Open mapping table').click();
		expect(await browser.executeObsidian(({ app }) => app.workspace.getLeavesOfType('crosswalker-mapping-review').length)).toBe(1);
		await $('[aria-label="Search recorded connections"]').setValue('no recorded match');
		await browser.waitUntil(async () => (await $('.cw-connections-output').getText()).includes('No readable matching assertions found'), { timeout: 10000 });
		expect(await $('.cw-connections-output').getText()).toContain('Some vault records could not be checked');
		// Queue a yielding query, then supersede its selection in the same event turn.
		await browser.execute(() => {
			const search = document.querySelector<HTMLInputElement>('[aria-label="Search recorded connections"]')!;
			search.value = ''; search.dispatchEvent(new Event('input'));
			const target = document.querySelector<HTMLSelectElement>('[aria-label="Target set"]')!;
			target.value = ''; target.dispatchEvent(new Event('change'));
		});
		await browser.pause(500);
		expect(await $('.cw-connections-output').getText()).toContain('Choose both imported sets');
		expect(await $$('.cw-connection-row')).toHaveLength(0);
		await choose();
		await browser.execute(() => {
			const search = document.querySelector<HTMLInputElement>('[aria-label="Search recorded connections"]')!; search.value = 'edge:'; search.dispatchEvent(new Event('input'));
			(document.querySelector('.cw-connections-close') as HTMLElement).click();
		});
		await browser.pause(500); expect(await $('.crosswalker-connections-modal').isExisting()).toBe(false);
		expect(await snapshot()).toEqual(before);
		writeFileSync(path.join(OUT, 'connections-browser-readonly.json'), JSON.stringify({ unchanged: true, assertions: 47, positive: 45, negative: 2, pageSize: 40, nativeGraphActionAvailable: false, notesBefore: Object.keys(before.files).length }, null, 2));
		// Ready state remains repeatable without resetting data.
		await open(); expect(await $('[aria-label="Source set"]').getValue()).toBe(''); await close();
		expect(await snapshot()).toEqual(before);
	});
	it('shows current filtered counts and discloses broader counts without changing vault data', async () => {
		const tablePath = 'Moved/mappings.mapping-table.tsv';
		const original = await browser.executeObsidian(async ({ app }, p) => app.vault.adapter.read(p), tablePath);
		table(root, [...Array.from({ length: 180 }, () => ({ subject_id: 'same:A', object_id: 'same:B', predicate_id: 'is_equivalent_to', mapping_provider: 'Resolved family' })), ...Array.from({ length: 3000 }, (_, n) => ({ subject_id: 'same:A', object_id: `absent:${n}`, predicate_id: 'is_equivalent_to', mapping_provider: 'Other family' }))], 'iset-tttttt');
		await browser.executeObsidian(async ({ app }, p, content) => { await app.vault.adapter.write(p, content); }, tablePath, readFileSync(path.join(root, tablePath), 'utf8'));
		const before = await snapshot();
		try {
			await open(); await choose();
			await browser.waitUntil(async () => (await $('.cw-connections-totals').getText()).includes('Needs resolution: 3000'), { timeout: 30000 });
			await $('[aria-label="Search recorded connections"]').setValue('Resolved family');
			await browser.waitUntil(async () => (await $('.cw-connections-totals').getText()).includes('Connections: 180 · Negative relationships: 0 · Needs resolution: 0'), { timeout: 30000 });
			expect(await $('.cw-connections-totals').getText()).toContain('Search: 180 of 3225');
			await $('.cw-connections-coverage').$('summary').click();
			expect(await $('.cw-connections-coverage').getText()).toContain('Before search: Connections: 225 · Negative relationships: 0 · Needs resolution: 3000');
			await $('.cw-connections-coverage').$('summary').click();
			expect(await $('.cw-connections-warning').getText()).toContain('vault records');
			for (const theme of ['light', 'dark'] as const) {
				await browser.executeObsidian(({ app }, t) => { (app as unknown as { changeTheme(t: string): void }).changeTheme(t === 'dark' ? 'obsidian' : 'moonstone'); }, theme);
				await browser.pause(300);
				expect(await $('.cw-connections-totals').isDisplayed()).toBe(true);
				await browser.saveScreenshot(path.join(OUT, `connections-browser-filtered-counts-${theme}.png`));
			}
			await $('[aria-label="Search recorded connections"]').click();
			await browser.keys(['Control', 'a']); await browser.keys('Backspace');
			expect(await $('[aria-label="Search recorded connections"]').getValue()).toBe('');
			await browser.waitUntil(async () => (await $('.cw-connections-totals').getText()).includes('Connections: 225 · Negative relationships: 0 · Needs resolution: 3000'), { timeout: 30000 });
			await close(); expect(await snapshot()).toEqual(before);
			writeFileSync(path.join(OUT, 'connections-browser-filtered-counts-readonly.json'), JSON.stringify({ unchanged: true, filtered: { resolved: 180, unresolved: 0 }, beforeSearch: { resolved: 225, unresolved: 3000 }, restoredAfterClearing: true }, null, 2));
		} finally {
			await browser.executeObsidian(async ({ app }, p, content) => { await app.vault.adapter.write(p, content); }, tablePath, original);
		}
	});
	it('shows discovery failures as unavailable rather than zero connections', async () => {
		await browser.executeObsidian(async ({ app }) => {
			const p = 'Moved/mappings.mapping-table.tsv';
			const text = await app.vault.adapter.read(p);
			await app.vault.adapter.write(p, text.replace('endpoint-v1', 'invalid-scheme'));
		});
		const before = await snapshot();
		await browser.executeObsidian(({ app }) => {
			// @ts-expect-error internal command API
			app.commands.executeCommandById('crosswalker:explore-framework-connections');
		});
		await browser.waitUntil(async () => (await $('.crosswalker-connections-modal').getText()).includes('Connections are unavailable'), { timeout: 20000 });
		await $('.crosswalker-connections-modal').$('summary=Error details').click();
		expect(await $('.crosswalker-connections-modal').getText()).toContain('Moved/mappings.mapping-table.tsv');
		expect(await $('.crosswalker-connections-modal').getText()).toContain('Update Crosswalker');
		expect(await $$('.cw-connection-row')).toHaveLength(0);
		expect(await $('[aria-label="Source set"]').isExisting()).toBe(false);
		await browser.saveScreenshot(path.join(OUT, 'connections-browser-unavailable-dark.png'));
		await browser.keys('Escape');
		expect(await snapshot()).toEqual(before);
	});
});
