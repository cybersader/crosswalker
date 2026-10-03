/**
 * Mapping set release record (v0.1.7 Track 3, 2026-10-03): a synthetic
 * mapping file with a full release header is imported as a table set, the
 * mapping review view opens on it, and the Release section above the grid
 * shows the release, its sources, provider, date, license, count and
 * "Membership intact.". Screenshots in both themes go to test-screenshots/.
 *
 * Synthetic data only: `demo-a:` / `demo-b:` ids, an example.test release id.
 */
import { browser } from '@wdio/globals';
import { expect } from 'expect';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('test-screenshots');
const FOLDER = '_crosswalker/mappings/demo-a-to-demo-b';
const SET_ID = 'https://example.test/mappings/demo-a-to-demo-b';

const TSV = [
	`# mapping_set_id: "${SET_ID}"`,
	'# mapping_set_version: "2026.1"',
	'# mapping_set_title: "Demo A to Demo B"',
	'# mapping_set_description: "A synthetic release for the end-to-end test."',
	'# subject_source: "demo-a"',
	'# subject_source_version: "1.0"',
	'# object_source: "demo-b"',
	'# object_source_version: "2.0"',
	'# mapping_provider: "Demo provider"',
	'# mapping_date: "2026-10-03"',
	'# creator_id:',
	'#   - "demo:creator-1"',
	'# license: "https://example.test/license"',
	'subject_id\tsubject_label\tpredicate_id\tobject_id\tobject_label\tmapping_justification\tconfidence',
	'demo-a:X-1\tDemo one\tskos:exactMatch\tdemo-b:Y-1\tTarget one\tsemapv:ManualMappingCuration\t0.9',
	'demo-a:X-2\tDemo two\tskos:relatedMatch\tdemo-b:Y-2\tTarget two\tsemapv:LexicalMatching\t0.5',
	'demo-a:X-3\tDemo three\tskos:broadMatch\tdemo-b:Y-3\tTarget three\tsemapv:ManualMappingCuration\t0.7',
	'demo-a:X-4\tDemo four\tskos:closeMatch\tdemo-b:Y-4\tTarget four\tsemapv:ManualMappingCuration\t0.8',
].join('\n');

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

describe('Mapping set release record in the review view', function () {
	this.timeout(300_000);
	before(async () => {
		mkdirSync(OUT, { recursive: true });
		const cleaned = await browser.executeObsidian(async ({ app }, folder) => {
			const existing = app.vault.getAbstractFileByPath(folder);
			if (existing) await app.vault.trash(existing, false);
			const deadline = Date.now() + 5000;
			while (app.vault.getAbstractFileByPath(folder) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
			return !app.vault.getAbstractFileByPath(folder);
		}, FOLDER);
		expect(cleaned).toBe(true);
	});

	it('imports a mapping file as a table set and shows its release above the grid', async () => {
		const imported = await browser.executeObsidian(async ({ app }, tsv) => {
			// @ts-expect-error -- plugin registry is internal
			const plugin = app.plugins.plugins['crosswalker'];
			const result = await plugin.runSssomImportForE2E(tsv, { mappingForm: 'table', importSet: 'new-set-qualified', runTier2Projection: false });
			return { success: !!result.generation?.success, errors: (result.generation?.errors ?? []).map((error: { message: string }) => error.message), tablePath: result.tablePath ?? '' };
		}, TSV);
		expect(imported.errors).toEqual([]);
		expect(imported.success).toBe(true);
		expect(imported.tablePath.startsWith(`${FOLDER}/`)).toBe(true);

		await browser.executeObsidian(async ({ app }, tablePath) => {
			// @ts-expect-error -- plugin registry is internal
			await app.plugins.plugins['crosswalker'].openMappingReview(tablePath);
		}, imported.tablePath);
		await browser.waitUntil(async () => browser.executeObsidian(() =>
			!!document.querySelector('.crosswalker-mapping-review .crosswalker-mr-release[data-state="recorded"]')
			&& document.querySelectorAll('.crosswalker-mapping-review .crosswalker-mr-row').length > 0),
		{ timeout: 30_000, timeoutMsg: 'The review view did not show a recorded release' });

		const release = await browser.executeObsidian(() => {
			const section = document.querySelector<HTMLElement>('.crosswalker-mapping-review .crosswalker-mr-release');
			const facts = Array.from(section?.querySelectorAll('.crosswalker-mr-release-fact') ?? [])
				.map((fact) => [fact.querySelector('dt')?.textContent ?? '', fact.querySelector('dd')?.textContent ?? '']);
			// The section sits above the grid.
			const grid = document.querySelector('.crosswalker-mapping-review .crosswalker-mr-body');
			const above = !!section && !!grid && (section.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
			return {
				name: section?.querySelector('.crosswalker-mr-release-name')?.textContent ?? '',
				membership: section?.querySelector('.crosswalker-mr-release-membership')?.textContent ?? '',
				intact: section?.querySelector<HTMLElement>('.crosswalker-mr-release-membership')?.dataset.intact,
				facts,
				above,
			};
		});
		expect(release).toEqual({
			name: 'Demo A to Demo B, version 2026.1',
			membership: 'Membership intact.',
			intact: 'yes',
			facts: [
				['Release id', SET_ID],
				['Sources', 'from demo-a 1.0 to demo-b 2.0'],
				['Provider', 'Demo provider'],
				['Date', '2026-10-03'],
				['License', 'https://example.test/license'],
				['Recorded', '4 mappings'],
			],
			above: true,
		});

		await capture('light', 'mapping-set-release-light.png');
		await capture('dark', 'mapping-set-release-dark.png');
	});
});
