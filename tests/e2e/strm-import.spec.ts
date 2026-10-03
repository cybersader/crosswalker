/**
 * Typed mapping table round trip in real Obsidian (v0.1.7 Track 3 slice 2,
 * 2026-10-03). A synthetic table-form set with a full release header is
 * seeded, exported through the "export folder as a typed mapping table"
 * command (table plus release file beside it), then imported through the
 * "import a typed mapping table" command, picking the exported table from the
 * in-app vault picker. The first step must say the release file was found, and
 * the new set's release record must equal the original on id, version,
 * sources and both fingerprints. Screenshots of the first step in both themes
 * go to test-screenshots/.
 *
 * Synthetic data only: `demo-a:` / `demo-b:` ids, an example.test release id.
 */
import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('test-screenshots');
const FOLDER = '_crosswalker/mappings/demo-a-to-demo-b';
const TYPED_EXPORT = '_crosswalker/mappings/demo-a-to-demo-b.export.typed-mappings.tsv';
const RELEASE_FILE = '_crosswalker/mappings/demo-a-to-demo-b.export.typed-mappings.mapping-set.json';
const RELEASE_NAME = 'demo-a-to-demo-b.export.typed-mappings.mapping-set.json';
const SET_ID = 'https://example.test/mappings/demo-a-to-demo-b';

// No closeMatch, no negation, confidences on the 0.1 grid: what a typed table
// carries exactly, so the re-imported fingerprints can equal the original's.
const TSV = [
	`# mapping_set_id: "${SET_ID}"`,
	'# mapping_set_version: "2026.1"',
	'# mapping_set_title: "Demo A to Demo B"',
	'# subject_source: "demo-a"',
	'# subject_source_version: "1.0"',
	'# object_source: "demo-b"',
	'# object_source_version: "2.0"',
	'# mapping_provider: "Demo provider"',
	'# license: "https://example.test/license"',
	'subject_id\tsubject_label\tpredicate_id\tobject_id\tobject_label\tmapping_justification\tconfidence',
	'demo-a:X-1\tDemo one\tskos:exactMatch\tdemo-b:Y-1\tTarget one\tsemapv:ManualMappingCuration\t0.9',
	'demo-a:X-2\tDemo two\tskos:relatedMatch\tdemo-b:Y-2\tTarget two\tsemapv:LexicalMatching\t0.5',
	'demo-a:X-3\tDemo three\tskos:broadMatch\tdemo-b:Y-3\tTarget three\tsemapv:ManualMappingCuration\t0.7',
	'demo-a:X-4\tDemo four\tskos:narrowMatch\tdemo-b:Y-4\tTarget four\tsemapv:ManualMappingCuration\t',
].join('\n');

const COMPARED = [
	'mapping_set_id', 'mapping_set_version', 'subject_source', 'subject_source_version',
	'object_source', 'object_source_version', 'membership_digest', 'content_digest', 'assertion_count',
] as const;

async function capture(theme: 'light' | 'dark', fileName: string): Promise<void> {
	await browser.executeObsidian(({ app }, value) => {
		app.workspace.leftSplit.collapse();
		document.querySelectorAll('.notice-container .notice').forEach((notice) => notice.remove());
		document.body.classList.toggle('theme-light', value === 'light');
		document.body.classList.toggle('theme-dark', value === 'dark');
	}, theme);
	await browser.pause(300);
	await browser.saveScreenshot(path.join(OUT, fileName));
}

async function chooseFolder(folderPath: string): Promise<void> {
	await browser.waitUntil(
		async () => browser.execute(() => Boolean(document.querySelector('.prompt-input'))),
		{ timeout: 10_000, interval: 100, timeoutMsg: 'export folder picker did not open' },
	);
	await browser.execute((value) => {
		const input = document.querySelector<HTMLInputElement>('.prompt-input');
		if (!input) throw new Error('folder picker input disappeared');
		input.value = value;
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}, folderPath);
	await browser.waitUntil(
		async () => browser.execute((value) => Array.from(document.querySelectorAll<HTMLElement>('.suggestion-item'))
			.some((item) => item.getClientRects().length > 0 && item.innerText.trim() === value), folderPath),
		{ timeout: 10_000, interval: 100, timeoutMsg: `folder suggestion did not appear for ${folderPath}` },
	);
	await browser.execute((value) => {
		const item = Array.from(document.querySelectorAll<HTMLElement>('.suggestion-item'))
			.find((candidate) => candidate.getClientRects().length > 0 && candidate.innerText.trim() === value);
		if (!item) throw new Error(`folder suggestion disappeared for ${value}`);
		item.click();
	}, folderPath);
}

async function removeFixture(): Promise<boolean> {
	return browser.executeObsidian(async ({ app }, paths) => {
		for (const target of paths) {
			const existing = app.vault.getAbstractFileByPath(target);
			if (existing) await app.vault.trash(existing, false);
		}
		const deadline = Date.now() + 5000;
		while (paths.some((target) => app.vault.getAbstractFileByPath(target)) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return !paths.some((target) => app.vault.getAbstractFileByPath(target));
	}, [FOLDER, TYPED_EXPORT, RELEASE_FILE]);
}

describe('Typed mapping table import round trip', function () {
	this.timeout(300_000);
	before(async () => {
		mkdirSync(OUT, { recursive: true });
		expect(await removeFixture()).toBe(true);
	});

	after(async () => {
		await browser.execute(() => {
			document.querySelectorAll<HTMLElement>('.modal-close-button').forEach((button) => button.click());
		});
		await browser.executeObsidian(({ app }) => {
			document.body.classList.toggle('theme-dark', app.getTheme?.() === 'obsidian');
			document.body.classList.toggle('theme-light', app.getTheme?.() !== 'obsidian');
		});
		await removeFixture();
	});

	it('exports a table set with its release file, then imports the table into a new set with the same release', async () => {
		const seeded = await browser.executeObsidian(async ({ app }, tsv) => {
			// @ts-expect-error -- plugin registry is internal
			const plugin = app.plugins.plugins['crosswalker'];
			const result = await plugin.runSssomImportForE2E(tsv, { mappingForm: 'table', importSet: 'new-set-qualified', runTier2Projection: false });
			return { success: !!result.generation?.success, errors: (result.generation?.errors ?? []).map((error: { message: string }) => error.message), setId: result.generation?.importSetId ?? '' };
		}, TSV);
		expect(seeded.errors).toEqual([]);
		expect(seeded.success).toBe(true);

		// Export through the registered command and its folder picker.
		await browser.executeObsidian(() => {
			document.querySelectorAll('.notice-container .notice').forEach((notice) => notice.remove());
		});
		await browser.executeObsidianCommand('crosswalker:export-folder-as-typed-mapping-table');
		await chooseFolder(FOLDER);
		await browser.waitUntil(async () => browser.executeObsidian(({ app }, paths) =>
			paths.every((target) => !!app.vault.getAbstractFileByPath(target)), [TYPED_EXPORT, RELEASE_FILE]),
		{ timeout: 15_000, interval: 100, timeoutMsg: 'the typed mapping table and its release file were not both written' });
		await browser.waitUntil(async () => browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('.notice'))
			.some((notice) => /Release record written to /.test(notice.innerText))),
		{ timeout: 10_000, interval: 100, timeoutMsg: 'the export notice did not say the release record was written' });
		const exportNotice = await browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('.notice'))
			.map((notice) => notice.innerText).find((text) => /Release record written to /.test(text)) ?? '');
		expect(exportNotice).toContain('Exported 4 typed mappings to _crosswalker/mappings/demo-a-to-demo-b.export.typed-mappings.tsv.');
		expect(exportNotice).toContain(`Release record written to ${RELEASE_FILE}.`);

		const original = await browser.executeObsidian(async ({ app, obsidian }, releasePath) => {
			const file = app.vault.getAbstractFileByPath(releasePath);
			if (!(file instanceof obsidian.TFile)) throw new Error('release file missing');
			return JSON.parse(await app.vault.read(file)) as Record<string, unknown>;
		}, RELEASE_FILE);
		expect(original.format).toBe('crosswalker-mapping-set-v1');
		expect(original.mapping_set_id).toBe(SET_ID);

		// Import through the registered command, picking the table in the in-app vault picker.
		await browser.executeObsidianCommand('crosswalker:import-typed-mapping-table');
		await browser.waitUntil(async () => browser.execute(() => Array.from(document.querySelectorAll<HTMLButtonElement>('.modal button'))
			.some((button) => button.textContent?.trim() === 'Pick from vault')),
		{ timeout: 10_000, interval: 100, timeoutMsg: 'the typed mapping table import modal did not open' });
		await browser.execute(() => {
			Array.from(document.querySelectorAll<HTMLButtonElement>('.modal button'))
				.find((button) => button.textContent?.trim() === 'Pick from vault')!.click();
		});
		await browser.waitUntil(async () => browser.execute((tablePath) => Array.from(document.querySelectorAll<HTMLElement>('.modal .setting-item'))
			.some((item) => item.querySelector('.setting-item-name')?.textContent === tablePath), TYPED_EXPORT),
		{ timeout: 10_000, interval: 100, timeoutMsg: 'the vault picker did not list the exported table' });
		await browser.execute((tablePath) => {
			const item = Array.from(document.querySelectorAll<HTMLElement>('.modal .setting-item'))
				.find((candidate) => candidate.querySelector('.setting-item-name')?.textContent === tablePath)!;
			item.querySelector<HTMLButtonElement>('button')!.click();
		}, TYPED_EXPORT);

		await browser.waitUntil(async () => browser.execute(() => {
			const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.modal button.mod-cta'))
				.find((candidate) => candidate.textContent?.trim() === 'Import');
			return !!document.querySelector('.crosswalker-release-file-line') && !!button && !button.disabled;
		}), { timeout: 15_000, interval: 100, timeoutMsg: 'the first step did not finish its preview' });
		const firstStep = await browser.execute(() => ({
			releaseLine: document.querySelector('.crosswalker-release-file-line')?.textContent ?? '',
			heading: document.querySelector('.modal h2')?.textContent ?? '',
			text: (document.querySelector<HTMLElement>('.modal')?.innerText ?? ''),
		}));
		expect(firstStep.releaseLine).toBe(`Release file found: ${RELEASE_NAME}`);
		expect(firstStep.heading).toBe('Import typed mapping table');
		expect(firstStep.text).not.toMatch(/SSSOM|STRM/);

		await capture('light', 'strm-import-light.png');
		await capture('dark', 'strm-import-dark.png');

		// The default is a new set; import into it.
		await browser.execute(() => {
			Array.from(document.querySelectorAll<HTMLButtonElement>('.modal button.mod-cta'))
				.find((button) => button.textContent?.trim() === 'Import')!.click();
		});

		const reimported = await browser.waitUntil(async () => browser.executeObsidian(async ({ app }, args) => {
			// The new set is the one record in the folder that is not the seeded set's.
			for (const file of app.vault.getMarkdownFiles()) {
				if (!file.path.startsWith(`${args.folder}/`)) continue;
				const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
				const setId = (fm?._crosswalker as { import_set?: { id?: string } } | undefined)?.import_set?.id;
				if (fm?.kind === 'mapping-set' && setId && setId !== args.seeded) return fm;
			}
			// A new set takes the default form, notes, so its record is a set note.
			return false;
		}, { folder: FOLDER, seeded: seeded.setId }), { timeout: 30_000, interval: 250, timeoutMsg: 'the new set did not get a release record' }) as Record<string, unknown>;

		for (const key of COMPARED) expect([key, reimported[key]]).toEqual([key, original[key]]);
		expect(reimported.id_origin).toBe('declared');
	});
});
