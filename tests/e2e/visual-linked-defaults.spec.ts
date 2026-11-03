/** Synthetic-only visual proof of linked defaults. No publisher corpus is read.
 * Run: bun run e2e:xvfb -- --spec tests/e2e/visual-linked-defaults.spec.ts
 * Each surface is captured in both themes under test-screenshots/linked-*.
 */
import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { RECIPE_REGISTRY } from '../../src/import/recipe-registry';
import { frameworkOverviewPatch } from '../../src/graph/graph-colors';
import { closeImportWizard, requireImportWizard } from './helpers/wizard-modal';
import { requireFrontmatterIndexed } from './helpers/vault-readiness';

const OUT = path.resolve('test-screenshots');

// Mirror buildRecognizedImportConfig: the leaf file template comes from the recipe's own file layout entry.
function leafFileTemplate(recipe: unknown): string {
	const layout = (recipe as { target?: { layout?: Array<{ mechanism?: string; template?: string }> } }).target?.layout ?? [];
	const file = layout.find((entry) => entry.mechanism === 'file');
	if (!file?.template) throw new Error('linked recipe has no file layout entry');
	return file.template;
}
const WIZARD = '.crosswalker-wizard-modal';
type Row = Record<string, string>;
type Theme = 'light' | 'dark';
const SOURCES = [
	{
		key: 'csf', id: 'nist-csf-2-linked', root: 'Linked-CSF',
		rows: [
			{ Subcategory: 'GV.OC-01: Invented organizational outcome.', 'Implementation Examples': 'Invented example.' },
			{ Subcategory: 'GV.OC-02: Another invented outcome.', 'Implementation Examples': 'Another invented example.' },
			{ Subcategory: 'GV.RM-01: Invented risk outcome.', 'Implementation Examples': 'Invented review.' },
		] as Row[],
		leaf: 'GV/GV.OC/GV.OC-01.md', parent: 'GV/GV.OC/GV.OC.md',
	},
	{
		key: 'attack', id: 'mitre-attack-technique-linked', root: 'Linked-ATTACK',
		rows: [
			{ ID: 'T9991', name: 'Invented parent technique', description: 'Synthetic parent, not publisher content.', tactics: 'Execution, Persistence', 'is sub-technique': 'false' },
			{ ID: 'T9991.001', name: 'Invented child one', description: 'Synthetic child, not publisher content.', tactics: 'Execution, Persistence', 'is sub-technique': 'true' },
			{ ID: 'T9991.002', name: 'Invented child two', description: 'Another synthetic child.', tactics: 'Execution', 'is sub-technique': 'true' },
		] as Row[],
		leaf: 'T9991.001.md', parent: 'T9991.md',
	},
	{
		key: 'd3fend', id: 'mitre-d3fend-linked', root: 'Linked-D3FEND',
		rows: [
			{ ID: 'D3-SYNROOT', 'D3FEND Tactic': 'Synthetic tactic', 'D3FEND Technique': 'Invented root', 'D3FEND Technique Level 0': '', 'D3FEND Technique Level 1': '', Definition: 'Synthetic outline root, not publisher content.' },
			{ ID: 'D3-SYNPARENT', 'D3FEND Tactic': 'Synthetic tactic', 'D3FEND Technique': '', 'D3FEND Technique Level 0': 'Invented parent', 'D3FEND Technique Level 1': '', Definition: 'Synthetic outline parent.' },
			{ ID: 'D3-SYNCHILD', 'D3FEND Tactic': 'Synthetic tactic', 'D3FEND Technique': '', 'D3FEND Technique Level 0': '', 'D3FEND Technique Level 1': 'Invented child', Definition: 'Synthetic outline child.' },
		] as Row[],
		leaf: 'D3-SYNCHILD.md', parent: 'D3-SYNPARENT.md',
	},
	{
		key: 'sp80053', id: 'nist-800-53-linked', root: 'Linked-SP80053',
		rows: [
			{ identifier: 'ZZ-1', name: 'Invented control', control_text: 'Synthetic control.', discussion: '', related: 'ZZ-1(1)' },
			{ identifier: 'ZZ-1(1)', name: 'Invented enhancement', control_text: 'Synthetic enhancement.', discussion: '', related: 'ZZ-1' },
		] as Row[],
		leaf: 'ZZ/ZZ-1/ZZ-1(1).md', parent: 'ZZ/ZZ-1/ZZ-1.md',
	},
];

async function capture(name: string): Promise<void> {
	for (const theme of ['light', 'dark'] as Theme[]) {
		await browser.executeObsidian(({ app }, value) => {
			const host = app as unknown as { changeTheme?: (name: string) => void };
			host.changeTheme?.(value === 'dark' ? 'obsidian' : 'moonstone');
			document.body.classList.toggle('theme-light', value === 'light');
			document.body.classList.toggle('theme-dark', value === 'dark');
			document.querySelectorAll('.notice').forEach((notice) => notice.remove());
			app.workspace.trigger('css-change');
		}, theme);
		await browser.pause(900);
		await browser.saveScreenshot(path.join(OUT, `linked-${name}-${theme}.png`));
	}
}

async function openNote(filePath: string): Promise<void> {
	await browser.executeObsidian(async ({ app, obsidian }, target) => {
		const file = app.vault.getAbstractFileByPath(target);
		if (!(file instanceof obsidian.TFile)) throw new Error(`Missing generated note: ${target}`);
		await app.workspace.getLeaf(false).openFile(file, { state: { mode: 'preview' } });
	}, filePath);
	await browser.pause(1000);
}

// Keep screenshots and contract checks separate: a visible link alone cannot prove resolution.
describe('Visual: linked recommended defaults, synthetic sources only', function () {
	this.timeout(300_000);
	before(async () => {
		mkdirSync(OUT, { recursive: true });
		mkdirSync(path.resolve('test-results'), { recursive: true });
		await browser.executeObsidian(async ({ app }) => {
			// @ts-expect-error -- internal plugin registry, used only in the E2E sandbox
			const plugin = app.plugins.plugins.crosswalker;
			Object.assign(plugin.settings, { enableShapeWorkbench: true, enableConfigSuggestions: false, enableDraftSessions: false, autoApplyExactMatch: false });
			await plugin.saveSettings();
		});
	});
	after(async () => { await closeImportWizard(); });

	for (const source of SOURCES) {
		// The picker covers CSF, ATT&CK and D3FEND; SP 800-53 is checked by the
		// import, children and replay cases below, not by this picker case.
		if (source.key !== 'sp80053') it(`${source.key}: recommended recipe first, previous default still selectable`, async () => {
			await requireImportWizard();
			const entry = RECIPE_REGISTRY.find((candidate) => candidate.id === source.id)!;
			// Union includes the previous recipe's optional signature column, proving an
			// equal-score match rather than hiding the previous default by missing headers.
			const previous = RECIPE_REGISTRY.find((candidate) => candidate.supersededBy === source.id)!;
			const columns = [...new Set([...entry.signatureColumns, ...previous.signatureColumns])];
			const csv = [columns, ...source.rows.map((row) => columns.map((column) => row[column] ?? ''))]
				.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n');
			await browser.executeObsidian((_obs, value) => {
				const input = document.querySelector<HTMLInputElement>('.crosswalker-wizard-modal input[type=file]');
				if (!input) throw new Error('Wizard file input missing');
				const transfer = new DataTransfer();
				transfer.items.add(new File([value.csv], `synthetic-${value.key}.csv`, { type: 'text/csv' }));
				input.files = transfer.files;
				input.dispatchEvent(new Event('change'));
			}, { csv, key: source.key });
			await browser.waitUntil(async () => browser.executeObsidian(() =>
				!!Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-wizard-modal button'))
					.find((button) => button.textContent?.includes('Next') && !button.disabled)), { timeout: 15_000 });
			await browser.executeObsidian(() => {
				Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-wizard-modal button'))
					.find((button) => button.textContent?.includes('Next') && !button.disabled)?.click();
			});
			await browser.$(`${WIZARD} .crosswalker-recognized-card`).waitForDisplayed({ timeout: 20_000 });
			const choices = await browser.executeObsidian(() => Array.from(document.querySelectorAll<HTMLButtonElement>(
				'.crosswalker-recognized-alternatives button',
			)).map((button) => ({ label: button.textContent ?? '', disabled: button.disabled })));
			console.log(`[linked-picker:${source.key}] ${JSON.stringify(choices)}`);
			expect(choices[0]).toEqual({ label: entry.label, disabled: true });
			expect(choices[1]).toEqual({ label: previous.label + ' (previous default)', disabled: false });
			expect(choices.filter((choice) => choice.label.includes('(previous default)')).map((choice) => choice.label))
				.toEqual([previous.label + ' (previous default)']);
			await browser.executeObsidian(() => document.querySelector('.crosswalker-recognized-card')?.scrollIntoView({ block: 'center' }));
			await capture(`${source.key}-picker`);
			await browser.executeObsidian(() => {
				document.querySelectorAll<HTMLButtonElement>('.crosswalker-recognized-alternatives button')[1]?.click();
			});
			const selected = await browser.executeObsidian(() => document.querySelector('.crosswalker-recognized-title')?.textContent ?? '');
			expect(selected).toBe(previous.label);
			if (source.key === 'd3fend') {
				await browser.executeObsidian(() => {
					document.querySelectorAll<HTMLButtonElement>('.crosswalker-recognized-alternatives button')[0]?.click();
					Array.from(document.querySelectorAll<HTMLButtonElement>('.crosswalker-recognized-actions button'))
						.find((button) => button.textContent?.trim() === 'Customize')?.click();
				});
				await browser.waitUntil(async () => browser.executeObsidian(() =>
					document.querySelector('.crosswalker-wb-connection-stats')?.textContent?.includes('2 parent links') ?? false,
				), { timeout: 15_000, timeoutMsg: 'Outline preview must show its two real parent links.' });
				await browser.executeObsidian(() => document.querySelector('.crosswalker-wb-connection-stats')?.scrollIntoView({ block: 'center' }));
				await capture('d3fend-preview');
			}
			await closeImportWizard();
		});

		it(`${source.key}: linked import, explorer, leaf, parent and native graph in both themes`, async () => {
			const entry = RECIPE_REGISTRY.find((candidate) => candidate.id === source.id)!;
			const columns = [...new Set([...entry.signatureColumns, ...source.rows.flatMap((row) => Object.keys(row))])];
			const generation = await browser.executeObsidian(async ({ app }, args) => {
				// @ts-expect-error -- internal plugin registry, same API used by recognized import
				const plugin = app.plugins.plugins.crosswalker;
				return plugin.runImport({ columns: args.columns, rows: args.rows, rowCount: args.rows.length, source: { type: 'csv' } },
					{ name: 'shape-workbench', mapping: { hierarchy: [], frontmatter: [], links: [], body: [], filename: { template: args.fileTemplate, sanitize: true } } },
					{ basePath: args.root, overwriteMode: 'replace', createFolders: true, strictValidation: true, sourceFileName: `synthetic-${args.key}.csv`, recipeOverride: args.recipe });
			}, { ...source, columns, recipe: entry.recipe, fileTemplate: leafFileTemplate(entry.recipe) });
			console.log(`[linked-generation:${source.key}] ${JSON.stringify(generation)}`);
			expect(generation.success).toBe(true);
			expect(generation.errors ?? []).toEqual([]);
			await requireFrontmatterIndexed({ pathPrefixes: source.root, requireKeys: ['curie'] });

			const proof = await browser.executeObsidian(async ({ app }, args) => {
				const files = app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${args.root}/`));
				return Promise.all(files.map(async (file) => {
					const fm = app.metadataCache.getFileCache(file)!.frontmatter!;
					const parent = String(fm.parent ?? '').replace(/^\[\[|\]\]$/g, '').split('|')[0];
					return { path: file.path, kind: fm.kind, tags: fm.tags ?? [], parent, children: fm.children ?? [],
						parentTarget: parent ? app.metadataCache.getFirstLinkpathDest(parent, file.path)?.path ?? null : null,
						body: await app.vault.read(file) };
				}));
			}, source);
			console.log(`[linked-proof:${source.key}] ${JSON.stringify(proof)}`);
			for (const note of proof) {
				if (note.parent) expect(note.parentTarget?.startsWith(`${source.root}/`)).toBe(true);
				if (source.key === 'csf') expect(note.tags).toEqual([]);
				else if (source.key === 'sp80053') expect(note.tags).toEqual([]);
			}
			const leafCurie = await browser.executeObsidian(({ app }, leafPath) =>
				String(app.metadataCache.getCache(leafPath)?.frontmatter?.curie ?? ''), `${source.root}/${source.leaf}`);
			expect(leafCurie).not.toBe('');
			expect(leafCurie).not.toContain(':row-');
			expect(proof.find((note) => note.path === `${source.root}/${source.leaf}`)?.parentTarget).toBe(`${source.root}/${source.parent}`);
			expect(proof.find((note) => note.path === `${source.root}/${source.parent}`)?.children.length).toBeGreaterThan(0);
			if (source.key === 'attack') {
				expect(proof.filter((note) => note.kind === 'facet').map((note) => path.basename(note.path)).sort()).toEqual(['Execution.md', 'Persistence.md']);
				expect(proof.find((note) => note.path === `${source.root}/${source.leaf}`)?.tags)
					.toEqual(['mitre-attack/tactic/execution', 'mitre-attack/tactic/persistence']);
			} else if (source.key === 'd3fend') {
					expect(proof.filter((note) => note.kind === 'facet')).toHaveLength(1);
					expect(leafCurie).toBe('mitre-d3fend:D3-SYNCHILD');
					const identities = await browser.executeObsidian(({ app }, root) => {
						const parent = app.metadataCache.getCache(`${root}/D3-SYNPARENT.md`)?.frontmatter;
						const child = app.metadataCache.getCache(`${root}/D3-SYNCHILD.md`)?.frontmatter;
						return { parent: parent?.curie, childParent: child?.parent_curie };
					}, source.root);
					expect(identities.childParent).toBe(identities.parent);
				} else if (source.key === 'csf') {
				expect(proof.some((note) => note.path === `${source.root}/GV/GV.md`)).toBe(true);
			} else {
				expect(proof.some((note) => note.path === `${source.root}/ZZ/ZZ.md`)).toBe(true);
			}

			const replay = await browser.executeObsidian(async ({ app }, args) => {
				// @ts-expect-error -- internal plugin registry in the E2E sandbox
				const plugin = app.plugins.plugins.crosswalker;
				const result = await plugin.runImport({ columns: args.columns, rows: args.rows, rowCount: args.rows.length, source: { type: 'csv' } },
					{ name: 'shape-workbench', mapping: { hierarchy: [], frontmatter: [], links: [], body: [], filename: { template: args.fileTemplate, sanitize: true } } },
					{ basePath: args.root, importSet: { id: args.setId }, overwriteMode: 'replace', createFolders: true,
						sourceFileName: `synthetic-${args.key}.csv`, recipeOverride: args.recipe });
				return { success: result.success, errors: result.errors ?? [] };
			}, { ...source, columns, recipe: entry.recipe, fileTemplate: leafFileTemplate(entry.recipe), setId: generation.importSetId });
			expect(generation.importSetId).toMatch(/^iset-/);
			expect(replay).toEqual({ success: true, errors: [] });
			await requireFrontmatterIndexed({ pathPrefixes: source.root, requireKeys: ['curie'] });
			const afterReplay = await browser.executeObsidian(({ app }, root) => app.vault.getMarkdownFiles()
				.filter((file) => file.path.startsWith(`${root}/`)).map((file) => {
					const fm = app.metadataCache.getFileCache(file)!.frontmatter!;
					return { path: file.path, kind: fm.kind, hash: fm._crosswalker?.recipe?.hash ?? null };
				}), source.root);
			expect(afterReplay.map((note) => note.path).sort()).toEqual(proof.map((note) => note.path).sort());
			expect(afterReplay.filter((note) => note.kind === 'facet' || note.kind === 'hub').map((note) => note.path).sort())
				.toEqual(proof.filter((note) => note.kind === 'facet' || note.kind === 'hub').map((note) => note.path).sort());
			const hashes = [...new Set(afterReplay.map((note) => note.hash))];
			expect(hashes).toHaveLength(1);
			expect(hashes[0]).toMatch(/^sha256-[a-f0-9]{64}$/);

			await openNote(`${source.root}/${source.leaf}`);
			await browser.executeObsidian(({ app }, root) => {
				const workspace = app.workspace as unknown as { leftSplit?: { expand(): void }; rightSplit?: { collapse(): void } };
				workspace.leftSplit?.expand();
				workspace.rightSplit?.collapse();
				const explorer = app.workspace.getLeavesOfType('file-explorer')[0]?.view as unknown as {
					fileItems?: Record<string, { setCollapsed?(collapsed: boolean): void }>;
				};
				for (const [name, item] of Object.entries(explorer?.fileItems ?? {})) item.setCollapsed?.(!name.startsWith(root));
			}, source.root);
			await browser.pause(600);
			await capture(`${source.key}-explorer`);
			await browser.executeObsidian(({ app }) => {
				(app.workspace as unknown as { leftSplit?: { collapse(): void } }).leftSplit?.collapse();
			});
			await capture(`${source.key}-leaf`);
			await openNote(`${source.root}/${source.parent}`);
			await capture(`${source.key}-parent`);

			await browser.executeObsidian(async ({ app }, args) => {
				const host = app as unknown as { internalPlugins: { getPluginById(id: string): { enabled: boolean; enable(save: boolean): Promise<void> } }; commands: { executeCommandById(id: string): void } };
				const graph = host.internalPlugins.getPluginById('graph');
				if (!graph.enabled) await graph.enable(false);
				await app.vault.adapter.write(`${app.vault.configDir}/graph.json`, JSON.stringify({
					...args.patch, search: `path:${args.root}`, hideUnresolved: true, showOrphans: true, nodeSizeMultiplier: 1.5, textFadeMultiplier: 0,
				}));
				for (const leaf of app.workspace.getLeavesOfType('graph')) leaf.detach();
				host.commands.executeCommandById('graph:open');
			}, { root: source.root, patch: frameworkOverviewPatch() });
			await browser.$('.workspace-leaf-content[data-type="graph"]').waitForDisplayed({ timeout: 20_000 });
			// The core plugin caches settings before graph.json is written. Apply the
			// same overview preset to this live graph too, not just its saved defaults.
			await browser.executeObsidian(({ app }, args) => {
				const engine = (app.workspace.getLeavesOfType('graph')[0].view as unknown as {
					dataEngine: { getOptions(): Record<string, unknown>; setOptions(options: Record<string, unknown>): void };
				}).dataEngine;
				engine.setOptions({ ...engine.getOptions(), ...args.patch, search: `path:${args.root}`, hideUnresolved: true, showOrphans: true, nodeSizeMultiplier: 1.5, textFadeMultiplier: 0 });
			}, { root: source.root, patch: frameworkOverviewPatch() });
			await browser.pause(7000);
			const graphProof = await browser.executeObsidian(({ app }) => {
				const view = app.workspace.getLeavesOfType('graph')[0]?.view as unknown as {
					renderer: { nodes: { id: string; x: number; y: number }[]; width: number; height: number; targetScale: number; setScale(value: number): void; setPan(x: number, y: number): void; changed(): void };
				};
				const r = view.renderer;
				if (!r?.nodes.length) return [];
				const xs = r.nodes.map((node) => node.x), ys = r.nodes.map((node) => node.y);
				const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
				const scale = Math.min(2, 0.7 * Math.min(r.width / (x1 - x0 || 1), r.height / (y1 - y0 || 1)));
				r.targetScale = scale;
				r.setScale(scale);
				r.setPan(r.width / 2 - (x0 + x1) / 2 * scale, r.height / 2 - (y0 + y1) / 2 * scale);
				r.changed();
				return r.nodes.map((node) => node.id);
			});
			console.log(`[linked-graph:${source.key}] ${JSON.stringify(graphProof)}`);
			expect(graphProof.length).toBe(proof.length);
			expect(graphProof.every((id) => id.startsWith(`${source.root}/`))).toBe(true);
			await capture(`${source.key}-graph`);
		});
	}
});
