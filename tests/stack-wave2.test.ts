import type { App } from 'obsidian';
import { needsLateCrosswalkRefresh, waitForIndexedDestination } from '../src/import/stack/stack-run';

test('late crosswalk replay is needed only for newly imported target identities', () => {
	expect(needsLateCrosswalkRefresh(['beta'], ['alpha', 'beta'])).toBe(true);
	expect(needsLateCrosswalkRefresh(['beta'], ['alpha'])).toBe(false);
	expect(needsLateCrosswalkRefresh(['beta'], [])).toBe(false);
});

test('previously imported target is already indexed before source import', async () => {
	const files = [{ path: 'Frameworks/Previously imported/Target.md' }];
	const app = { vault: { getMarkdownFiles: () => files }, metadataCache: { getFileCache: () => ({ frontmatter: { curie: 'beta:B' } }) } } as unknown as App;
	expect(await waitForIndexedDestination(app, 'Frameworks/Previously imported', 10)).toBe(0);
	expect(needsLateCrosswalkRefresh(['beta'], [])).toBe(false);
});
