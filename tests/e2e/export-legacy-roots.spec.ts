import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('test-screenshots');
const CONCEPT_PATH = 'LegacyRootExportE2E-concept.md';
const EDGE_PATH = 'LegacyRootExportE2E-edge.md';
const ROOT_CSV = 'vault.export.csv';
const ROOT_TSV = 'vault.export.tsv';
const OLD_CSV = '.export.csv';
const OLD_TSV = '.export.tsv';
const ROOT_PICKER_LABEL = '/ (vault root)';

const CONCEPT_BYTES = `---
curie: "rootcsv:concept-alpha"
kind: "concept"
title: "Root CSV Alpha"
aliases: []
tags: ["root-export-e2e"]
---
# Root CSV Alpha
`;

const EDGE_BYTES = `---
curie: "xwalk:root-export-e2e"
kind: "crosswalk-edge"
subject_id: "rootmap:source-alpha"
predicate_id: "is_equivalent_to"
sssom_predicate: "skos:exactMatch"
object_id: "root-target:target-alpha"
mapping_justification: "Root crosswalk rationale."
match_confidence: 1
---
# Root crosswalk edge
`;

const OLD_CSV_SENTINEL = 'legacy root CSV dotfile sentinel owned by export-root E2E\n';
const OLD_TSV_SENTINEL = 'legacy root TSV dotfile sentinel owned by export-root E2E\n';

interface DotfileBaseline {
	path: string;
	bytes: string;
	ownedByTest: boolean;
}

interface OwnedFile {
	path: string;
	bytes: string;
}

interface OwnedOutput {
	path: string;
	marker: string;
}

let dotfileBaselines: DotfileBaseline[] = [];
let ownedSources: OwnedFile[] = [];
let ownedOutputs: OwnedOutput[] = [];

async function chooseFolder(label: string): Promise<void> {
	await browser.waitUntil(
		async () => browser.execute(() => Boolean(document.querySelector('.prompt-input'))),
		{ timeout: 10_000, interval: 100, timeoutMsg: 'export folder picker did not open' },
	);
	await browser.execute((_label) => {
		const input = document.querySelector<HTMLInputElement>('.prompt-input');
		if (!input) throw new Error('folder picker input disappeared');
		input.value = _label;
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}, label);
	await browser.waitUntil(
		async () => browser.execute((_label) => Array.from(document.querySelectorAll<HTMLElement>('.suggestion-item'))
			.some((item) => item.getClientRects().length > 0 && item.innerText.trim() === _label), label),
		{ timeout: 10_000, interval: 100, timeoutMsg: `folder suggestion did not appear for ${label}` },
	);
	await browser.execute((_label) => {
		const item = Array.from(document.querySelectorAll<HTMLElement>('.suggestion-item'))
			.find((candidate) => candidate.getClientRects().length > 0 && candidate.innerText.trim() === _label);
		if (!item) throw new Error(`folder suggestion disappeared for ${_label}`);
		item.click();
	}, label);
}

async function readPhysicalBytes(paths: string[]): Promise<Record<string, string | null>> {
	return browser.executeObsidian(async ({ app }, wanted) => {
		const result: Record<string, string | null> = {};
		for (const filePath of wanted) {
			result[filePath] = await app.vault.adapter.exists(filePath)
				? await app.vault.adapter.read(filePath)
				: null;
		}
		return result;
	}, paths);
}

async function refusePreExistingOutput(outputPath: string): Promise<void> {
	const exists = await browser.executeObsidian(
		async ({ app }, candidate) => app.vault.adapter.exists(candidate),
		outputPath,
	);
	if (exists) {
		throw new Error(`Refusing to run root export because ${outputPath} already exists`);
	}
}

async function waitForOwnedOutput(outputPath: string, marker: string): Promise<string> {
	await browser.waitUntil(
		async () => browser.executeObsidian(async ({ app }, args) => {
			if (!await app.vault.adapter.exists(args.outputPath)) return false;
			return (await app.vault.adapter.read(args.outputPath)).includes(args.marker);
		}, { outputPath, marker }),
		{ timeout: 15_000, interval: 100, timeoutMsg: `${outputPath} did not settle with the test marker` },
	);
	const bytes = (await readPhysicalBytes([outputPath]))[outputPath];
	if (bytes === null) throw new Error(`${outputPath} disappeared after creation`);
	return bytes;
}

async function expectSourcesAndDotfilesUnchanged(): Promise<void> {
	const paths = [CONCEPT_PATH, EDGE_PATH, ...dotfileBaselines.map((entry) => entry.path)];
	const bytes = await readPhysicalBytes(paths);
	expect(bytes[CONCEPT_PATH]).toBe(CONCEPT_BYTES);
	expect(bytes[EDGE_PATH]).toBe(EDGE_BYTES);
	for (const baseline of dotfileBaselines) {
		expect(bytes[baseline.path]).toBe(baseline.bytes);
	}
}

describe('Legacy export commands at the real vault root', function () {
	this.timeout(120_000);

	before(async () => {
		await browser.executeObsidian(async ({ app }, protectedPaths) => {
			for (const protectedPath of protectedPaths) {
				if (await app.vault.adapter.exists(protectedPath)) {
					throw new Error(`Refusing setup because ${protectedPath} already exists`);
				}
			}
		}, [ROOT_CSV, ROOT_TSV, CONCEPT_PATH, EDGE_PATH]);
		mkdirSync(OUT, { recursive: true });

		dotfileBaselines = [];
		for (const dotfile of [
			{ path: OLD_CSV, sentinel: OLD_CSV_SENTINEL },
			{ path: OLD_TSV, sentinel: OLD_TSV_SENTINEL },
		]) {
			const baseline = await browser.executeObsidian(async ({ app }, candidate) => {
				if (await app.vault.adapter.exists(candidate.path)) {
					return {
						path: candidate.path,
						bytes: await app.vault.adapter.read(candidate.path),
						ownedByTest: false,
					};
				}
				await app.vault.adapter.write(candidate.path, candidate.sentinel);
				return { path: candidate.path, bytes: candidate.sentinel, ownedByTest: true };
			}, dotfile);
			dotfileBaselines.push(baseline);
		}

		ownedSources = [];
		for (const source of [
			{ path: CONCEPT_PATH, bytes: CONCEPT_BYTES },
			{ path: EDGE_PATH, bytes: EDGE_BYTES },
		]) {
			await browser.executeObsidian(async ({ app }, ownedSource) => {
				await app.vault.create(ownedSource.path, ownedSource.bytes);
			}, source);
			ownedSources.push(source);
		}
		ownedOutputs = [];
	});

	after(async () => {
		await browser.execute(() => {
			document.querySelectorAll<HTMLElement>('.modal-close-button, .modal-header-button').forEach((button) => button.click());
		});
		await browser.executeObsidian(async ({ app, obsidian }, fixture) => {
			for (const dotfile of fixture.dotfiles) {
				if (!dotfile.ownedByTest || !await app.vault.adapter.exists(dotfile.path)) continue;
				const bytes = await app.vault.adapter.read(dotfile.path);
				if (bytes === dotfile.bytes) await app.vault.adapter.remove(dotfile.path);
			}
			for (const output of fixture.outputs) {
				if (!await app.vault.adapter.exists(output.path)) continue;
				const bytes = await app.vault.adapter.read(output.path);
				const file = app.vault.getAbstractFileByPath(output.path);
				if (bytes.includes(output.marker) && file instanceof obsidian.TFile) {
					await app.vault.delete(file);
				}
			}
			for (const source of fixture.sources) {
				if (!await app.vault.adapter.exists(source.path)) continue;
				const bytes = await app.vault.adapter.read(source.path);
				const file = app.vault.getAbstractFileByPath(source.path);
				if (bytes === source.bytes && file instanceof obsidian.TFile) {
					await app.vault.delete(file);
				}
			}
		}, {
			outputs: ownedOutputs,
			dotfiles: dotfileBaselines,
			sources: ownedSources,
		});
	});

	it('exports CSV from the real root to vault.export.csv without touching old dotfiles or sources', async () => {
		const registered = await browser.executeObsidian(({ app }) => {
			// @ts-expect-error - internal command registry used only by E2E.
			const command = app.commands.findCommand('crosswalker:export-folder-as-csv');
			const root = app.vault.getRoot();
			return {
				found: Boolean(command),
				name: command?.name ?? '',
				root: {
					path: root.path,
					name: root.name,
					isRoot: root.isRoot(),
					parent: root.parent ? { path: root.parent.path, name: root.parent.name } : null,
				},
			};
		});
		console.log(`[legacy-root-exports:root-facts] ${JSON.stringify(registered.root)}`);
		expect(registered).toMatchObject({
			found: true,
			name: 'Crosswalker: Import and export: export folder as CSV',
			root: { isRoot: true, parent: null },
		});
		expect(typeof registered.root.path).toBe('string');
		expect(typeof registered.root.name).toBe('string');

		await refusePreExistingOutput(ROOT_CSV);
		await browser.executeObsidianCommand('crosswalker:export-folder-as-csv');
		await browser.waitUntil(
			async () => browser.execute(() => Boolean(document.querySelector('.prompt-input'))),
			{ timeout: 10_000, interval: 100, timeoutMsg: 'CSV root picker did not open' },
		);
		await browser.saveScreenshot(path.join(OUT, 'legacy-root-export-01-csv-picker.png'));
		await chooseFolder(ROOT_PICKER_LABEL);

		const csv = await waitForOwnedOutput(ROOT_CSV, 'rootcsv:concept-alpha');
		ownedOutputs.push({ path: ROOT_CSV, marker: 'rootcsv:concept-alpha' });
		const lines = csv.split('\n');
		expect(lines[0]?.split(',').slice(0, 6)).toEqual([
			'curie', 'title', 'parent', 'children', 'aliases', 'tags',
		]);
		const syntheticRows = lines.filter((line) => line.startsWith('rootcsv:concept-alpha,'));
		expect(syntheticRows).toHaveLength(1);
		expect(syntheticRows[0]?.startsWith(
			'rootcsv:concept-alpha,Root CSV Alpha,,,,root-export-e2e',
		)).toBe(true);
		await expectSourcesAndDotfilesUnchanged();
	});

	it('exports crosswalk mappings from the real root to vault.export.tsv without touching old dotfiles or sources', async () => {
		const registered = await browser.executeObsidian(({ app }) => {
			// @ts-expect-error - internal command registry used only by E2E.
			const command = app.commands.findCommand('crosswalker:export-folder-as-crosswalk-mapping-file');
			return { found: Boolean(command), name: command?.name ?? '' };
		});
		expect(registered).toEqual({
			found: true,
			name: 'Crosswalker: Import and export: export folder as a crosswalk mapping file',
		});

		await refusePreExistingOutput(ROOT_TSV);
		await browser.executeObsidianCommand('crosswalker:export-folder-as-crosswalk-mapping-file');
		await browser.waitUntil(
			async () => browser.execute(() => Boolean(document.querySelector('.prompt-input'))),
			{ timeout: 10_000, interval: 100, timeoutMsg: 'crosswalk root picker did not open' },
		);
		await browser.saveScreenshot(path.join(OUT, 'legacy-root-export-02-crosswalk-picker.png'));
		await chooseFolder(ROOT_PICKER_LABEL);

		const tsv = await waitForOwnedOutput(ROOT_TSV, 'rootmap:source-alpha');
		ownedOutputs.push({ path: ROOT_TSV, marker: 'rootmap:source-alpha' });
		expect(tsv.split('\n')).toContain(
			'subject_id\tpredicate_id\tobject_id\tpredicate_modifier\tmapping_justification\tconfidence\tsubject_label\tobject_label',
		);
		expect(tsv.split('\n').filter((line) => line.startsWith('rootmap:source-alpha\t'))).toEqual([
			'rootmap:source-alpha\tskos:exactMatch\troot-target:target-alpha\t\tRoot crosswalk rationale.\t1\t\t',
		]);
		await expectSourcesAndDotfilesUnchanged();
	});
});
