import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('test-screenshots');
const TOP = 'TypedMappingExportE2E';
const SOURCE_FOLDER = `${TOP}/Mappings`;
const SOURCE_A = `${SOURCE_FOLDER}/AC-2--A-9-2-1.md`;
const SOURCE_B = `${SOURCE_FOLDER}/AC-3--A-9-4-1.md`;
const CROSSWALK_EXPORT = `${TOP}/Mappings.export.tsv`;
const TYPED_EXPORT = `${TOP}/Mappings.export.typed-mappings.tsv`;
const ROOT_TYPED_EXPORT = 'vault.export.typed-mappings.tsv';

const SOURCE_A_BYTES = `---
curie: "xwalk:e2e-ac-2--a-9-2-1"
kind: "crosswalk-edge"
subject_id: "typed-e2e:source-alpha"
predicate_id: "is_narrower_than"
object_id: "typed-target:target-alpha"
match_confidence: 0.8
mapping_justification: "Account lifecycle requirements overlap."
---
# AC-2 to A.9.2.1
`;

const SOURCE_B_BYTES = `---
curie: "xwalk:e2e-ac-3--a-9-4-1"
kind: "crosswalk-edge"
subject_id: "typed-e2e:source-beta"
predicate_id: "is_equivalent_to"
object_id: "typed-target:target-beta"
match_confidence: 1
mapping_justification: "Access enforcement requirements align."
---
# AC-3 to A.9.4.1
`;

const CROSSWALK_BYTES = 'subject_id\tpredicate_id\tobject_id\nnist:sentinel\tskos:exactMatch\tiso:sentinel\n';

async function removeFixture(): Promise<void> {
	await browser.executeObsidian(async ({ app, obsidian }, args) => {
		const rootOutput = app.vault.getAbstractFileByPath(args.rootOutput);
		if (rootOutput instanceof obsidian.TFile) {
			const bytes = await app.vault.read(rootOutput);
			if (bytes.includes('typed-e2e\tsource-alpha\ttyped-target\ttarget-alpha')) {
				await app.vault.delete(rootOutput, true);
			}
		}
		const existing = app.vault.getAbstractFileByPath(args.top);
		if (existing) await app.vault.delete(existing, true);
	}, { top: TOP, rootOutput: ROOT_TYPED_EXPORT });
}

async function chooseFolder(folderPath: string): Promise<void> {
	await browser.waitUntil(
		async () => browser.execute(() => Boolean(document.querySelector('.prompt-input'))),
		{ timeout: 10_000, interval: 100, timeoutMsg: 'export folder picker did not open' },
	);
	await browser.execute((_folderPath) => {
		const input = document.querySelector<HTMLInputElement>('.prompt-input');
		if (!input) throw new Error('folder picker input disappeared');
		input.value = _folderPath;
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}, folderPath);
	await browser.waitUntil(
		async () => browser.execute((_folderPath) => Array.from(document.querySelectorAll<HTMLElement>('.suggestion-item'))
			.some((item) => item.getClientRects().length > 0 && item.innerText.trim() === _folderPath), folderPath),
		{ timeout: 10_000, interval: 100, timeoutMsg: `folder suggestion did not appear for ${folderPath}` },
	);
	await browser.execute((_folderPath) => {
		const item = Array.from(document.querySelectorAll<HTMLElement>('.suggestion-item'))
			.find((candidate) => candidate.getClientRects().length > 0 && candidate.innerText.trim() === _folderPath);
		if (!item) throw new Error(`folder suggestion disappeared for ${_folderPath}`);
		item.click();
	}, folderPath);
}

async function readVaultBytes(paths: string[]): Promise<Record<string, string | null>> {
	return browser.executeObsidian(async ({ app, obsidian }, wanted) => {
		const result: Record<string, string | null> = {};
		for (const filePath of wanted) {
			const file = app.vault.getAbstractFileByPath(filePath);
			result[filePath] = file instanceof obsidian.TFile ? await app.vault.read(file) : null;
		}
		return result;
	}, paths);
}

describe('Typed mapping table export command', function () {
	this.timeout(120_000);

	before(async () => {
		mkdirSync(OUT, { recursive: true });
		await removeFixture();
		await browser.executeObsidian(async ({ app }, fixture) => {
			await app.vault.createFolder(fixture.top);
			await app.vault.createFolder(fixture.sourceFolder);
			await app.vault.create(fixture.sourceA, fixture.sourceABytes);
			await app.vault.create(fixture.sourceB, fixture.sourceBBytes);
			await app.vault.create(fixture.crosswalkExport, fixture.crosswalkBytes);
		}, {
			top: TOP,
			sourceFolder: SOURCE_FOLDER,
			sourceA: SOURCE_A,
			sourceB: SOURCE_B,
			sourceABytes: SOURCE_A_BYTES,
			sourceBBytes: SOURCE_B_BYTES,
			crosswalkExport: CROSSWALK_EXPORT,
			crosswalkBytes: CROSSWALK_BYTES,
		});
	});

	after(async () => {
		await browser.execute(() => {
			document.querySelectorAll<HTMLElement>('.modal-close-button, .modal-header-button').forEach((button) => button.click());
		});
		await removeFixture();
	});

	it('invokes the registered command, exports safely, and requires confirmation before replacement', async () => {
		const registered = await browser.executeObsidian(({ app }) => {
			// @ts-expect-error - internal command registry used only by E2E.
			const command = app.commands.findCommand('crosswalker:export-folder-as-typed-mapping-table');
			return { found: Boolean(command), name: command?.name ?? '' };
		});
		expect(registered).toEqual({
			found: true,
			name: 'Crosswalker: Import and export: export folder as a typed mapping table',
		});

		await browser.executeObsidianCommand('crosswalker:export-folder-as-typed-mapping-table');
		await browser.waitUntil(
			async () => browser.execute(() => Boolean(document.querySelector('.prompt-input'))),
			{ timeout: 10_000, interval: 100, timeoutMsg: 'first folder picker did not open' },
		);
		await browser.saveScreenshot(path.join(OUT, 'typed-mappings-01-folder-picker.png'));
		await chooseFolder(SOURCE_FOLDER);

		await browser.waitUntil(
			async () => (await readVaultBytes([TYPED_EXPORT]))[TYPED_EXPORT] !== null,
			{ timeout: 15_000, interval: 100, timeoutMsg: 'typed mapping table was not created' },
		);
		const first = await readVaultBytes([SOURCE_A, SOURCE_B, CROSSWALK_EXPORT, TYPED_EXPORT]);
		expect(first[SOURCE_A]).toBe(SOURCE_A_BYTES);
		expect(first[SOURCE_B]).toBe(SOURCE_B_BYTES);
		expect(first[CROSSWALK_EXPORT]).toBe(CROSSWALK_BYTES);
		expect(first[TYPED_EXPORT]).toBe(
			'Focal Document\tFocal Document Element\tReference Document\tReference Document Element\tRelationship\tStrength of Relationship (Optional)\tRationale\n' +
			'typed-e2e\tsource-alpha\ttyped-target\ttarget-alpha\tsubset of\t8\tAccount lifecycle requirements overlap.\n' +
			'typed-e2e\tsource-beta\ttyped-target\ttarget-beta\tequal\t10\tAccess enforcement requirements align.\n',
		);
		const sentinel = 'existing typed table must survive cancellation\n';
		await browser.executeObsidian(async ({ app, obsidian }, args) => {
			const file = app.vault.getAbstractFileByPath(args.path);
			if (!(file instanceof obsidian.TFile)) throw new Error('typed export disappeared before cancellation test');
			await app.vault.modify(file, args.sentinel);
		}, { path: TYPED_EXPORT, sentinel });

		await browser.executeObsidianCommand('crosswalker:export-folder-as-typed-mapping-table');
		await chooseFolder(SOURCE_FOLDER);
		await browser.waitUntil(
			async () => browser.execute(() => Boolean(document.querySelector('.crosswalker-typed-table-replace-confirmation'))),
			{ timeout: 10_000, interval: 100, timeoutMsg: 'replacement confirmation did not open' },
		);
		await browser.saveScreenshot(path.join(OUT, 'typed-mappings-02-replace-confirmation.png'));
		await browser.keys('Escape');
		await browser.waitUntil(
			async () => browser.execute(() => !document.querySelector('.crosswalker-typed-table-replace-confirmation')),
			{ timeout: 5_000, interval: 100, timeoutMsg: 'replacement confirmation did not close on Escape' },
		);
		expect((await readVaultBytes([TYPED_EXPORT]))[TYPED_EXPORT]).toBe(sentinel);

		await browser.executeObsidianCommand('crosswalker:export-folder-as-typed-mapping-table');
		await chooseFolder(SOURCE_FOLDER);
		await browser.waitUntil(
			async () => browser.execute(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
				.some((button) => button.getClientRects().length > 0 && button.textContent?.trim() === 'Replace file')),
			{ timeout: 10_000, interval: 100, timeoutMsg: 'Replace file button did not appear' },
		);
		await browser.execute(() => {
			const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
				.find((candidate) => candidate.getClientRects().length > 0 && candidate.textContent?.trim() === 'Replace file');
			if (!button) throw new Error('Replace file button disappeared');
			button.click();
		});
		await browser.waitUntil(
			async () => (await readVaultBytes([TYPED_EXPORT]))[TYPED_EXPORT] === first[TYPED_EXPORT],
			{ timeout: 15_000, interval: 100, timeoutMsg: 'confirmed replacement did not settle with deterministic bytes' },
		);
		const final = await readVaultBytes([SOURCE_A, SOURCE_B, CROSSWALK_EXPORT, TYPED_EXPORT]);
		expect(final[SOURCE_A]).toBe(SOURCE_A_BYTES);
		expect(final[SOURCE_B]).toBe(SOURCE_B_BYTES);
		expect(final[CROSSWALK_EXPORT]).toBe(CROSSWALK_BYTES);
		expect(final[TYPED_EXPORT]).toBe(first[TYPED_EXPORT]);
		await browser.saveScreenshot(path.join(OUT, 'typed-mappings-03-confirmed-export.png'));
	});

	it('selects the real vault root and exports only asserted synthetic evidence without replacing prior root output', async () => {
		const rootFacts = await browser.executeObsidian(({ app, obsidian }, rootOutputPath) => {
			const root = app.vault.getRoot();
			const existingOutput = app.vault.getAbstractFileByPath(rootOutputPath);
			return {
				path: root.path,
				name: root.name,
				isRoot: root.isRoot(),
				parent: root.parent ? { path: root.parent.path, name: root.parent.name } : null,
				outputKind: existingOutput instanceof obsidian.TFile
					? 'file'
					: existingOutput
						? 'non-file'
						: 'missing',
			};
		}, ROOT_TYPED_EXPORT);
		console.log(`[typed-mappings:root-facts] ${JSON.stringify(rootFacts)}`);

		expect(typeof rootFacts.path).toBe('string');
		expect(typeof rootFacts.name).toBe('string');
		expect(rootFacts.isRoot).toBe(true);
		expect(rootFacts.parent).toBeNull();
		expect(rootFacts.outputKind).toBe('missing');

		await browser.executeObsidianCommand('crosswalker:export-folder-as-typed-mapping-table');
		await browser.waitUntil(
			async () => browser.execute(() => Boolean(document.querySelector('.prompt-input'))),
			{ timeout: 10_000, interval: 100, timeoutMsg: 'root folder picker did not open' },
		);
		await browser.saveScreenshot(path.join(OUT, 'typed-mappings-04-root-picker.png'));
		await chooseFolder('/ (vault root)');

		await browser.waitUntil(
			async () => (await readVaultBytes([ROOT_TYPED_EXPORT]))[ROOT_TYPED_EXPORT] !== null,
			{ timeout: 15_000, interval: 100, timeoutMsg: 'vault-root typed mapping table was not created' },
		);
		const after = await readVaultBytes([SOURCE_A, SOURCE_B, CROSSWALK_EXPORT, ROOT_TYPED_EXPORT]);
		expect(after[SOURCE_A]).toBe(SOURCE_A_BYTES);
		expect(after[SOURCE_B]).toBe(SOURCE_B_BYTES);
		expect(after[CROSSWALK_EXPORT]).toBe(CROSSWALK_BYTES);
		expect(after[ROOT_TYPED_EXPORT]?.split('\n')[0]).toBe(
			'Focal Document\tFocal Document Element\tReference Document\tReference Document Element\tRelationship\tStrength of Relationship (Optional)\tRationale',
		);
		const syntheticRows = after[ROOT_TYPED_EXPORT]?.split('\n')
			.filter((line) => line.startsWith('typed-e2e\t')) ?? [];
		expect(syntheticRows).toEqual([
			'typed-e2e\tsource-alpha\ttyped-target\ttarget-alpha\tsubset of\t8\tAccount lifecycle requirements overlap.',
			'typed-e2e\tsource-beta\ttyped-target\ttarget-beta\tequal\t10\tAccess enforcement requirements align.',
		]);
	});
});
