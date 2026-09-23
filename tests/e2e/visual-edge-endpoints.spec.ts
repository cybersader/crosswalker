import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { requireFrontmatterIndexed } from './helpers/vault-readiness';

const OUT = path.resolve('test-screenshots');
const ROOT = 'P2-graph-connected';
const TSV = [
	'# subject_source: "p2ga"', '# object_source: "p2gb"',
	'subject_id\tsubject_label\tpredicate_id\tobject_id\tobject_label\tmapping_justification\tconfidence',
	'p2ga:Alpha\tAlpha\tskos:exactMatch\tp2gb:Beta\tBeta\tsynthetic\t0.9',
].join('\n');

describe('Visual — graph-linked synthetic mapping', function () {
	this.timeout(120000);
	it('writes two concepts and an edge with visible graph connections', async () => {
		mkdirSync(OUT, { recursive: true });
		const created = await browser.executeObsidian(async ({ app }, args) => {
			// @ts-expect-error - plugin E2E handles
			const plugin = app.plugins.plugins['crosswalker'];
			const source = await plugin.runImportFromRecipe(
				{ columns: ['id'], rows: [{ id: 'Alpha' }], rowCount: 1 },
				{ recipe: 'p2-graph-a', source: { ontology: 'p2ga', levels: ['concept'] },
					target: { layout: [{ level: 'concept', mechanism: 'file', template: 'Alpha.md' }] } },
				{ basePath: `${args.root}/source`, overwriteMode: 'replace', createFolders: true, strictValidation: true },
			);
			const target = await plugin.runImportFromRecipe(
				{ columns: ['id'], rows: [{ id: 'Beta' }], rowCount: 1 },
				{ recipe: 'p2-graph-b', source: { ontology: 'p2gb', levels: ['concept'] },
					target: { layout: [{ level: 'concept', mechanism: 'file', template: 'Beta.md' }] } },
				{ basePath: `${args.root}/target`, overwriteMode: 'replace', createFolders: true, strictValidation: true },
			);
			const mapping = await plugin.runSssomImportForE2E(args.tsv,
				{ outputFolder: `${args.root}/edges`, runTier2Projection: false, overwriteMode: 'replace' });
			return { source: source.success, target: target.success, mapping: mapping.generation?.success,
				errors: mapping.generation?.errors, summary: mapping.summary };
		}, { root: ROOT, tsv: TSV });
		expect(created).toEqual({ source: true, target: true, mapping: true, errors: [], summary: [] });
		await requireFrontmatterIndexed({ pathPrefixes: ROOT, expectedCount: 3, requireKeys: ['_crosswalker'] });
		const links = await browser.executeObsidian(({ app }, root) => {
			const files = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${root}/edges/`));
			const edge = files[0];
			return { edge: edge?.path ?? null, links: edge ? app.metadataCache.resolvedLinks[edge.path] ?? {} : {} };
		}, ROOT);
		expect(links.edge).toBeTruthy();
		expect(Object.keys(links.links)).toEqual(expect.arrayContaining([`${ROOT}/source/Alpha.md`, `${ROOT}/target/Beta.md`]));
		const graph = await browser.executeObsidian(async ({ app }, root) => {
			// @ts-expect-error - Obsidian command registry
			app.commands.executeCommandById('graph:open');
			let leaf: HTMLElement | null = null;
			for (let n = 0; n < 80; n++) {
				leaf = document.querySelector('.workspace-leaf-content[data-type="graph"]');
				if (leaf) break;
				await new Promise((r) => setTimeout(r, 100));
			}
			const filters = Array.from(leaf?.querySelectorAll<HTMLElement>('*') ?? [])
				.find((el) => el.textContent?.trim() === 'Filters' && el.children.length === 0);
			filters?.click();
			let search: HTMLInputElement | null | undefined;
			for (let n = 0; n < 80; n++) {
				search = leaf?.querySelector<HTMLInputElement>('input[type="search"], .search-input-container input');
				if (search) break;
				await new Promise((r) => setTimeout(r, 100));
			}
			if (!search) return { opened: !!leaf, filtered: false };
			search.focus();
			search.value = `path:${root}`;
			search.dispatchEvent(new Event('input', { bubbles: true }));
			return { opened: true, filtered: true };
		}, ROOT);
		expect(graph).toEqual({ opened: true, filtered: true });
		await browser.pause(4000);
		await browser.executeObsidian(() => {
			document.querySelector<HTMLInputElement>('.workspace-leaf-content[data-type="graph"] input')?.blur();
			document.querySelector<HTMLElement>('.workspace-leaf-content[data-type="graph"] canvas')?.click();
			for (const notice of document.querySelectorAll('.notice')) notice.remove();
		});
		await browser.pause(600);
		await browser.saveScreenshot(path.join(OUT, 'visual-stack-05-graph-connected.png'));
	});
});
