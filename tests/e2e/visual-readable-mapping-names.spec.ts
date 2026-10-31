import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { captureScreenshot, setupVisualSpec } from '../helpers/visual-spec-runner';

/** New mapping sets get readable note names; refresh keeps them. Synthetic source only. */
const FOLDER = '_crosswalker/mappings/demoattack-to-demomit';
const TSV = 'subject_id\tpredicate_id\tobject_id\tsubject_label\tobject_label\n'
	+ 'demoattack:T1059.001\tskos:relatedMatch\tdemomit:M1036\tPowerShell\tAccount use policies\n'
	+ 'demoattack:T1059.001\tskos:relatedMatch\tdemomit:M1042\tPowerShell\tDisable or remove feature\n'
	+ 'demoattack:GV.SC-04\tskos:closeMatch\tdemomit:AC-2(1)/a\tSuppliers known\tAutomated account management\n';

async function theme(value: 'light' | 'dark') {
	await browser.executeObsidian(({ app }, requested) => {
		(app as unknown as { changeTheme(t: string): void }).changeTheme(requested === 'dark' ? 'obsidian' : 'moonstone');
		document.body.classList.toggle('theme-dark', requested === 'dark');
		document.body.classList.toggle('theme-light', requested === 'light');
	}, value);
}

async function names(): Promise<string[]> {
	return browser.executeObsidian(({ app }, folder) => app.vault.getMarkdownFiles()
		.filter((f) => f.path.startsWith(folder + '/') && f.basename.includes(' · '))
		.map((f) => f.name).sort(), FOLDER);
}

describe('Visual: readable mapping note names', function () {
	setupVisualSpec(this, { timeoutMs: 180_000 });

	it('names new mapping notes by endpoint and keeps the names on refresh', async () => {
		const setId = await browser.executeObsidian(async ({ app, obsidian }, tsv, folder) => {
			// @ts-expect-error internal plugin API
			const plugin = app.plugins.plugins.crosswalker;
			const result = await plugin.runSssomImportForE2E(tsv, { basePath: folder, importSet: 'new', runTier2Projection: false });
			if (!result.generation?.success) throw new Error(JSON.stringify(result.generation?.errors));
			const note = app.vault.getMarkdownFiles().find((f) => f.path.startsWith(folder + '/') && f.basename.includes(' · '));
			const text = note ? await app.vault.read(note) : '';
			const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const fm = match ? (obsidian.parseYaml(match[1]) as any) : undefined;
			const id = fm?._crosswalker?.import_set?.id;
			if (typeof id !== 'string') throw new Error('first import stamped no import set id');
			return id;
		}, TSV, FOLDER);
		await browser.waitUntil(async () => (await names()).length === 3, { timeout: 20_000, timeoutMsg: 'expected 3 readable mapping notes' });
		const first = await names();
		expect(first.every((n) => /^[^:]+ · [^:]+ \([0-9a-f]{8}\)\.md$/.test(n))).toBe(true);
		expect(first.some((n) => n.startsWith('T1059.001 · M1036 ('))).toBe(true);
		expect(first.some((n) => n.startsWith('GV.SC-04 · AC-2(1) a ('))).toBe(true);
		expect(first.some((n) => n.startsWith('cw-'))).toBe(false);

		await browser.executeObsidian(async ({ app }, tsv, folder, id) => {
			// @ts-expect-error internal plugin API
			const plugin = app.plugins.plugins.crosswalker;
			const result = await plugin.runSssomImportForE2E(tsv, { basePath: folder, importSet: { id }, runTier2Projection: false });
			if (!result.generation?.success) throw new Error(JSON.stringify(result.generation?.errors));
		}, TSV, FOLDER, setId);
		expect(await names()).toEqual(first);

		const note = first.find((n) => n.startsWith('T1059.001 · M1036 ('))!;
		await browser.executeObsidian(async ({ app }, path) => {
			const file = app.vault.getAbstractFileByPath(path);
			// @ts-expect-error TFile narrowing in the driver context
			await app.workspace.getLeaf(false).openFile(file);
			// @ts-expect-error internal file explorer API
			const explorer = app.workspace.getLeavesOfType('file-explorer')[0]?.view;
			explorer?.revealInFolder?.(file);
		}, `${FOLDER}/${note}`);
		await browser.pause(1500);
		for (const value of ['light', 'dark'] as const) {
			await theme(value);
			await captureScreenshot(`readable-mapping-names-${value}`);
		}
	});
});
