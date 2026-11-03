/**
 * ch46-unfiltered-cprt.spec.ts — the Ch 46 central claim, for the JSON source.
 *
 *   CW_CH46=1 DISPLAY=:0 bun run e2e -- --spec tests/e2e/ch46-unfiltered-cprt.spec.ts
 *
 * Separate from ch46-unfiltered-source.spec.ts so the three CPRT imports (679
 * concepts each, plus linked indexes) get their own Obsidian session rather than
 * piling onto the XLSX cases in one renderer. No screenshots here either.
 *
 * The CPRT export is the widest of the five: 906 elements of seven kinds, of
 * which 225 `sort` and 2 `party` are navigation scaffolding rather than
 * concepts. Both CPRT recipes previously told the operator to strip them by
 * hand. This spec hands the recipe all 906 and asserts it keeps 679.
 *
 * It also exercises the OTHER generation entry point. The XLSX spec drives
 * `runImport` (generateNotes + recipeOverride, the recognized-source wizard
 * path); the last case here drives `runImportFromRecipe` (generateFromRecipe,
 * the native recipe path). The source stage was added to both, so both are
 * proved rather than one being assumed from the other.
 *
 * RIGHTS: NIST CPRT is a public-domain United States Government work.
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import cprtRecipe from '../../recipes/import/nist-csf-2-cprt.json';
import cprtHierarchicalRecipe from '../../recipes/import/nist-csf-2-cprt-hierarchical.json';
import cprtLinkedRecipe from '../../recipes/import/nist-csf-2-cprt-linked.json';
import { requireFrontmatterIndexed } from './helpers/vault-readiness';

const RUN = process.env.CW_CH46 === '1';
const describeCh46 = RUN ? describe : describe.skip;

const CORPUS = process.env.CW_CH46_CPRT_SOURCE ?? path.resolve(__dirname, '..', '..', 'Frameworks', 'cprt_CSF_2_0_0_06-01-2026.json');
const SOURCE_FILE_NAME = 'cprt_CSF_2_0_0_06-01-2026.json';
const ITERATOR = '$.response.elements.elements[*]';

const EXPECTED_TOTAL = 906;
const EXPECTED_KEPT = 679;
const EXPECTED_EXCLUDED = 227; // 225 sort + 2 party

/**
 * Mirror src/import/parsers/json-parser.ts: iterate to rows, coerce top-level
 * scalars to trimmed strings, columns in first-appearance order.
 */
function loadCorpus() {
	const document = JSON.parse(readFileSync(CORPUS, 'utf8'));
	const elements = document.response.elements.elements as Record<string, unknown>[];
	const rows = elements.map((element) => {
		const row: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(element)) {
			row[key] = value !== null && typeof value === 'object' ? value : String(value ?? '').trim();
		}
		return row;
	});
	const columns: string[] = [];
	const seen = new Set<string>();
	for (const row of rows) for (const key of Object.keys(row)) if (!seen.has(key)) { seen.add(key); columns.push(key); }
	return { columns, rows };
}

async function clearDestination(destination: string): Promise<boolean> {
	return browser.executeObsidian(async ({ app }, root) => {
		const existing = app.vault.getAbstractFileByPath(root);
		if (existing) {
			// @ts-expect-error - internal trash API, isolated E2E sandbox only
			await app.vault.trash(existing, false);
		}
		const deadline = Date.now() + 30_000;
		while (app.vault.getAbstractFileByPath(root) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return !app.vault.getAbstractFileByPath(root);
	}, destination);
}

async function basenamesUnder(destination: string): Promise<string[]> {
	return browser.executeObsidian(async ({ app }, root) => app.vault
		.getMarkdownFiles()
		.filter((file) => file.path === root || file.path.startsWith(`${root}/`))
		.map((file) => file.basename)
		.sort(), destination);
}

describeCh46('Ch 46 — a recipe points at its own unfiltered source (CPRT JSON)', function () {
	this.timeout(15 * 60_000);

	let columns: string[] = [];
	let rows: Record<string, unknown>[] = [];
	let sortAndPartyIds: string[] = [];
	let conceptIds: string[] = [];

	before(() => {
		({ columns, rows } = loadCorpus());
		sortAndPartyIds = rows
			.filter((row) => row.element_type === 'sort' || row.element_type === 'party')
			.map((row) => String(row.element_identifier));
		conceptIds = rows
			.filter((row) => row.element_type !== 'sort' && row.element_type !== 'party')
			.map((row) => String(row.element_identifier));
	});

	it('the corpus really is unfiltered and contains the scaffolding rows', () => {
		expect(rows.length).toBe(EXPECTED_TOTAL);
		expect(sortAndPartyIds.length).toBe(EXPECTED_EXCLUDED);
		expect(conceptIds.length).toBe(EXPECTED_KEPT);
		expect((cprtRecipe as any).source.where).toBe("$not(element_type in ['sort', 'party'])");
		for (const recipe of [cprtHierarchicalRecipe, cprtLinkedRecipe]) {
			expect(recipe.source.where).toBe("$not(element_type in ['sort', 'party'])");
		}
	});

	it('flat CPRT: all 906 elements in, exactly the 679 concept notes out', async () => {
		const destination = 'Frameworks/ch46-cprt-flat-unfiltered';
		expect(await clearDestination(destination)).toBe(true);

		const generation = await browser.executeObsidian(async ({ app }, args) => {
			// @ts-expect-error - Crosswalker E2E API
			const plugin = app.plugins.plugins['crosswalker'];
			return plugin.runImport(
				{
					columns: args.columns, rows: args.rows, rowCount: args.rows.length,
					source: { type: 'json' }, iterator: args.iterator,
				},
				{
					name: 'shape-workbench',
					mapping: {
						hierarchy: [], frontmatter: [], links: [], body: [],
						filename: { template: '{element_identifier|fs-safe}.md', sanitize: true },
					},
				},
				{
					basePath: args.destination, overwriteMode: 'replace', createFolders: true,
					strictValidation: true, sourceFileName: args.sourceFileName, recipeOverride: args.recipe,
				},
			);
		}, { columns, rows, recipe: cprtRecipe, destination, sourceFileName: SOURCE_FILE_NAME, iterator: ITERATOR });

		expect(generation.errors ?? []).toEqual([]);
		expect(generation.success).toBe(true);
		expect(generation.created.length).toBe(EXPECTED_KEPT);

		await requireFrontmatterIndexed({
			pathPrefixes: destination, expectedCount: EXPECTED_KEPT,
			requireKeys: ['curie', '_crosswalker'], timeoutMs: 300_000, pollMs: 200,
		});

		const written = await basenamesUnder(destination);
		expect(written.length).toBe(EXPECTED_KEPT);
		expect(new Set(written).size).toBe(EXPECTED_KEPT);
		// Not one scaffolding element became a note. `sort` ids are `S-`-prefixed,
		// the two `party` ids are `first` and `third`.
		const leaked = written.filter((name) => sortAndPartyIds.includes(name));
		expect(leaked).toEqual([]);
		expect(written).toEqual([...conceptIds].sort());
	});

	for (const [variant, recipe, hubCount] of [
		['hierarchical', cprtHierarchicalRecipe, 0], ['linked', cprtLinkedRecipe, 17],
	] as const) {
		it(`${variant} CPRT via native recipe: 906 in, 679 concepts and ${hubCount} indexes out`, async () => {
			// Reuse a cleared destination so independent native cases cannot collide
			// with the preceding case's fallback row identities.
			const destination = 'Frameworks/ch46-cprt-native-unfiltered';
			expect(await clearDestination(destination)).toBe(true);

			// runImportFromRecipe → generateFromRecipe: the OTHER entry point the
			// source stage was wired into.
			const generation = await browser.executeObsidian(async ({ app }, args) => {
				// @ts-expect-error - Crosswalker E2E API
				const plugin = app.plugins.plugins['crosswalker'];
				return plugin.runImportFromRecipe(
					{
						columns: args.columns, rows: args.rows, rowCount: args.rows.length,
						source: { type: 'json' }, iterator: args.iterator,
					},
					args.recipe,
					{
						basePath: args.destination, overwriteMode: 'replace', createFolders: true,
						strictValidation: true, sourceFileName: args.sourceFileName,
					},
				);
			}, { columns, rows, recipe, destination, sourceFileName: SOURCE_FILE_NAME, iterator: ITERATOR });

			expect(generation.errors ?? []).toEqual([]);
			expect(generation.success).toBe(true);
			expect(generation.created.length).toBe(EXPECTED_KEPT + hubCount);

			await requireFrontmatterIndexed({
				pathPrefixes: destination, expectedCount: EXPECTED_KEPT + hubCount,
				requireKeys: ['curie', '_crosswalker'], timeoutMs: 300_000, pollMs: 200,
			});

			const written = await basenamesUnder(destination);
			expect(written.length).toBe(EXPECTED_KEPT + hubCount);
			expect(written.filter((name) => sortAndPartyIds.includes(name))).toEqual([]);
			const navigation = await browser.executeObsidian(({ app }, root) => {
				const records = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${root}/`))
					.map((f) => app.metadataCache.getFileCache(f)?.frontmatter);
				const gvHub = app.vault.getFileByPath(`${root}/GV/GV.md`);
				return {
					concepts: records.filter((fm) => fm?.csf_id).map((fm) => fm!.csf_id).sort(),
					hubs: records.filter((fm) => fm?.kind === 'hub').length,
					gvChildren: gvHub ? app.metadataCache.getFileCache(gvHub)?.frontmatter?.children ?? [] : [],
				};
			}, destination);
			expect(navigation.concepts).toEqual([...conceptIds].sort());
			expect(navigation.hubs).toBe(hubCount);
			expect([...navigation.gvChildren].sort()).toEqual((variant === 'linked' ? [
				`[[${destination}/GV/GV/GV|GV]]`,
				'[[GV.OC]]', '[[GV.OV]]', '[[GV.PO]]', '[[GV.RM]]', '[[GV.RR]]', '[[GV.SC]]',
			] : []).sort());
		});
	}
});
