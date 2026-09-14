/**
 * smoke-ci.spec.ts — one vertical CI journey through Crosswalker's runtime.
 *
 * Why this is consolidated instead of an explicit list of existing specs:
 * every spec invocation pays the Obsidian/Electron launch, plugin install, and
 * seed-indexing cost. The six source specs observed green before this file was
 * written took 41.80 s locally in separate launches. This purpose-built journey
 * pays that cost once and shares one two-note fixture across the Tier 1 and Tier
 * 2 contracts without scanning a development-sized vault.
 *
 * Contract order is deliberate:
 *   1. harness + plugin load + command registration;
 *   2. user entry surface (the import wizard opens);
 *   3. Tier 1 write + provenance + immediate re-import identity;
 *   4. Tier 2 WASM + migration + projection + query.
 *
 * Run: bun run e2e -- --spec tests/e2e/smoke-ci.spec.ts
 */

import { browser } from '@wdio/globals';
import { expect } from 'expect';
import path from 'node:path';
import { obsidianPage } from 'wdio-obsidian-service';
import { TIER2_SCHEMA_VERSION } from '../../src/tier2/migrations';
import {
	readFrontmatterFromDisk,
	requireFrontmatterIndexed,
	resetTier2Sidecar,
	waitForVaultIndexed,
} from './helpers/vault-readiness';

const TRACKED_SEED_VAULT = path.resolve(__dirname, 'seed-vault');
const TEST_DIR = 'Frameworks/smoke-ci';
const NOTE_PATH = `${TEST_DIR}/AC/AC-1.md`;

const smokeConfig = {
	name: 'smoke-ci',
	version: '1.0',
	source: { type: 'csv' as const },
	transforms: {},
	mapping: {
		hierarchy: [{ column: 'family', level: 1 }],
		frontmatter: [
			{ column: 'title', key: 'title' },
			{ column: 'family', key: 'family_id' },
		],
		body: [],
		links: [],
		filename: { template: '{id}', sanitize: true },
	},
	output: { basePath: TEST_DIR, overwriteMode: 'replace' as const, createFolders: true },
};

const smokeData = {
	columns: ['id', 'title', 'family'],
	rows: [
		{ id: 'AC-1', title: 'Policy and Procedures', family: 'AC' },
		{ id: 'AU-1', title: 'Audit Policy', family: 'AU' },
	],
	rowCount: 2,
	source: { type: 'csv' as const },
	headerRow: 0,
};

const importOptions = {
	...smokeConfig.output,
	sourceFileName: 'smoke-ci.csv',
	configId: 'smoke-ci',
};

describe('Crosswalker plugin — CI vertical smoke', function () {
	this.timeout(120_000);

	before(async () => {
		const cleaned = await browser.executeObsidian(async ({ app }, dir) => {
			const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
			const folder = app.vault.getAbstractFileByPath(dir);
			if (folder) {
				// @ts-expect-error - internal trash API, safe in the sandbox vault.
				await app.vault.trash(folder, false);
			}
			const deadline = Date.now() + 5_000;
			while (app.vault.getAbstractFileByPath(dir) && Date.now() < deadline) await sleep(50);
			return !app.vault.getAbstractFileByPath(dir);
		}, TEST_DIR);
		expect(cleaned).toBe(true);
	});

	after(async () => {
		await browser.executeObsidian(() => {
			document.querySelectorAll('.crosswalker-wizard-modal .modal-close-button, .crosswalker-wizard-modal .modal-header-button').forEach((button) => {
				(button as HTMLElement).click();
			});
		});
	});

	it('loads the sandboxed plugin and registers the import command', async () => {
		const sandboxPath = await obsidianPage.getVaultPath();
		const state = await browser.executeObsidian(({ app }) => {
			// @ts-expect-error - internal plugin registry used only by E2E.
			const plugin = app.plugins.plugins.crosswalker;
			return {
				pluginLoaded: !!plugin,
				commandRegistered: !!app.commands.findCommand('crosswalker:import-structured-data'),
			};
		});

		expect(path.resolve(sandboxPath)).not.toBe(TRACKED_SEED_VAULT);
		expect(state.pluginLoaded).toBe(true);
		expect(state.commandRegistered).toBe(true);
	});

	it('opens the import wizard from the user command surface', async () => {
		await browser.executeObsidianCommand('crosswalker:import-structured-data');
		const modal = browser.$('.crosswalker-wizard-modal');
		await modal.waitForDisplayed({ timeout: 5_000 });
		expect(await modal.isDisplayed()).toBe(true);

		await browser.executeObsidian(() => {
			document.querySelectorAll('.modal-close-button, .modal-header-button').forEach((button) => {
				(button as HTMLElement).click();
			});
		});
		await browser.pause(150);
	});

	it('writes Tier 1 provenance and retains import-set identity on an explicitly chosen re-import', async () => {
		const first = await browser.executeObsidian(async ({ app }, args) => {
			// @ts-expect-error - internal plugin registry used only by E2E.
			const plugin = app.plugins.plugins.crosswalker;
			return plugin.runImport(args.data, args.config, args.options);
		}, { data: smokeData, config: smokeConfig, options: importOptions });
		expect(first.success).toBe(true);
		const generatedPaths = await browser.executeObsidian(({ app }, dir) => [
			`${dir}/AC/AC-1.md`,
			`${dir}/AU/AU-1.md`,
		].filter((notePath) => !!app.vault.getAbstractFileByPath(notePath)), TEST_DIR);
		expect(generatedPaths).toHaveLength(2);

		const firstFrontmatter = await readFrontmatterFromDisk(NOTE_PATH) as Record<string, any> | null;
		expect(firstFrontmatter?.curie).toBe('smoke-ci:AC-1');
		expect(firstFrontmatter?._crosswalker?.producer?.kind).toBe('plugin-engine');
		expect(firstFrontmatter?._crosswalker?.source_ref?.file).toBe('smoke-ci.csv');
		const firstImportSetId = firstFrontmatter?._crosswalker?.import_set?.id;
		expect(firstImportSetId).toMatch(/^iset-/);

		// AM-9: the engine no longer adopts whatever set shares the destination, so
		// a refresh is expressed here the way the wizard expresses a user's click,
		// by naming the set. No metadata-cache barrier belongs here either: the
		// regression this covers was an immediate second import reading cache lag as
		// a set it could not see, and naming the set does not read the cache to find
		// the folder's contents - it reads the notes stamped with that id.
		const second = await browser.executeObsidian(async ({ app }, args) => {
			// @ts-expect-error - internal plugin registry used only by E2E.
			const plugin = app.plugins.plugins.crosswalker;
			return plugin.runImport(args.data, args.config, args.options);
		}, {
			data: smokeData,
			config: smokeConfig,
			options: { ...importOptions, importSet: { id: firstImportSetId } },
		});
		expect(second.success).toBe(true);

		const secondFrontmatter = await readFrontmatterFromDisk(NOTE_PATH) as Record<string, any> | null;
		expect(secondFrontmatter?._crosswalker?.import_set?.id).toBe(firstImportSetId);
	});

	it('opens migrated Tier 2, projects the tiny fixture, and queries it', async () => {
		await requireFrontmatterIndexed({
			pathPrefixes: TEST_DIR,
			expectedCount: 2,
			requireKeys: ['_crosswalker'],
		});
		const indexed = await waitForVaultIndexed();
		expect(indexed.ready).toBe(true);

		const reset = await resetTier2Sidecar();
		expect(reset.errors).toEqual([]);

		const runtime = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error - internal plugin registry used only by E2E.
			const plugin = app.plugins.plugins.crosswalker;
			const handle = await plugin.openTier2();
			const selected = handle.db.exec({
				sql: 'SELECT 1',
				rowMode: 'array',
				returnValue: 'resultRows',
			}) as unknown[][];
			const versionRows = handle.db.exec({
				sql: "SELECT value FROM schema_meta WHERE key = 'schema_version' LIMIT 1",
				rowMode: 'array',
				returnValue: 'resultRows',
			}) as unknown[][];
			return { selected: selected[0]?.[0] ?? null, schemaVersion: versionRows[0]?.[0] ?? null };
		});
		expect(Number(runtime.selected)).toBe(1);
		expect(runtime.schemaVersion).toBe(TIER2_SCHEMA_VERSION);

		const projection = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error - internal plugin registry used only by E2E.
			const plugin = app.plugins.plugins.crosswalker;
			return plugin.runProjection();
		});
		expect(projection.success).toBe(true);
		expect(projection.counts.concepts).toBeGreaterThanOrEqual(2);

		const concepts = await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error - internal plugin registry used only by E2E.
			const plugin = app.plugins.plugins.crosswalker;
			return plugin.queryConcepts('smoke-ci');
		});
		expect(concepts.map((concept: any) => concept.curie).sort()).toEqual(['smoke-ci:AC-1', 'smoke-ci:AU-1']);
	});
});
