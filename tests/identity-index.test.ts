/**
 * identity-index.test.ts — the reconciliation primitive (Sprint R1, 2026-08-21).
 *
 * Pins the properties the "re-import is identity reconciliation" decision rests on:
 * a note is found by its curie wherever it sits, user notes are structurally
 * unreachable, ambiguous identity is reported rather than silently resolved, and a
 * changed address produces a MOVE rather than a duplicate.
 *
 * 2026-08-29 (F-7): the index now falls back to a raw frontmatter read when
 * Obsidian's metadata cache has not indexed a file yet. Before that, a cold cache
 * made an existing note INVISIBLE here, and invisible means "create a second one".
 * That was survivable only while the desired path always equalled the existing
 * path, so a cache-independent path lookup caught what the index missed. Per-import
 * destinations remove that net, which is why the fallback is now load-bearing
 * rather than defensive.
 */

import * as Obsidian from 'obsidian';
import { TFile } from 'obsidian';
import { buildIdentityIndex, reconcile, type IdentityIndex } from '../src/generation/identity-index';

interface MockNote {
	curie?: string;
	generated?: boolean;
	recipeId?: string;
	importSetId?: string;
}

function mockApp(files: Record<string, MockNote>, coldContents: Record<string, string> = {}) {
	const paths = Array.from(new Set([...Object.keys(files), ...Object.keys(coldContents)]));
	const tfiles = paths.map((p) => {
		const f = new TFile(p);
		f.path = p;
		return f;
	});
	const cachedRead = jest.fn(async (f: { path: string }) => coldContents[f.path] ?? '');
	return {
		vault: { getMarkdownFiles: () => tfiles, cachedRead },
		metadataCache: {
			getFileCache: (f: { path: string }) => {
				// A file present only in `coldContents` is one Obsidian has not
				// indexed yet: the cache answers null, not "no properties".
				if (Object.prototype.hasOwnProperty.call(coldContents, f.path)) return null;
				const note = files[f.path];
				const frontmatter: Record<string, unknown> = {};
				if (note.curie) frontmatter.curie = note.curie;
				if (note.generated !== false) {
					frontmatter._crosswalker = {
						...(note.recipeId ? { recipe: { id: note.recipeId } } : {}),
						...(note.importSetId ? { import_set: { id: note.importSetId, scheme: 'endpoint-v1' } } : {}),
					};
				}
				return { frontmatter };
			},
		},
	} as any;
}

/** A generated note's raw text, for the cache-cold cases. */
function rawGeneratedNote(curie: string, importSetId = 'iset-abc123'): string {
	return `---\ncurie: "${curie}"\n_crosswalker:\n  import_set:\n    id: ${importSetId}\n    scheme: endpoint-v1\n---\n# Generated\n`;
}

describe('buildIdentityIndex', () => {
	it('finds a generated note by curie regardless of where it sits', async () => {
		const app = mockApp({ 'Wherever/Deep/AC-2.md': { curie: 'nist:AC-2' } });
		const index = await buildIdentityIndex(app);
		expect(index.get('nist:AC-2')?.path).toBe('Wherever/Deep/AC-2.md');
		expect(index.size).toBe(1);
	});

	it('ignores notes a user wrote by hand, so reconciliation cannot reach them', async () => {
		const app = mockApp({
			'My notes/Thoughts.md': { curie: 'nist:AC-2', generated: false },
			'Frameworks/AC-2.md': { curie: 'nist:AC-2' },
		});
		const index = await buildIdentityIndex(app);
		// The hand-written note claims the same curie but carries no provenance,
		// so it is invisible here and is neither moved nor counted as a collision.
		expect(index.get('nist:AC-2')?.path).toBe('Frameworks/AC-2.md');
		expect(index.collisions).toEqual([]);
	});

	it('skips generated notes that carry no curie', async () => {
		const app = mockApp({ 'Frameworks/Hub.md': {} });
		expect((await buildIdentityIndex(app)).size).toBe(0);
	});

	it('reports an ambiguous curie instead of silently choosing', async () => {
		const app = mockApp({
			'A/AC-2.md': { curie: 'nist:AC-2' },
			'B/AC-2.md': { curie: 'nist:AC-2' },
		});
		const index = await buildIdentityIndex(app);
		expect(index.collisions).toEqual([{ curie: 'nist:AC-2', paths: ['A/AC-2.md', 'B/AC-2.md'] }]);
	});

	it('scopes ownership to one import set while retaining recipe filtering for compatibility', async () => {
		const app = mockApp({
			'Frameworks/AC-2.md': { curie: 'nist:AC-2', recipeId: 'nist-flat', importSetId: 'iset-abc123' },
			'Other/X-1.md': { curie: 'other:X-1', recipeId: 'other-recipe', importSetId: 'iset-def456' },
		});
		expect((await buildIdentityIndex(app, { importSetId: 'iset-abc123' })).curies()).toEqual(['nist:AC-2']);
		expect((await buildIdentityIndex(app, { recipeId: 'nist-flat' })).curies()).toEqual(['nist:AC-2']);
	});

	it('import-set ownership takes precedence over the deprecated recipe filter', async () => {
		const app = mockApp({
			'Frameworks/stamped.md': { curie: 'nist:STAMPED', recipeId: 'new-recipe', importSetId: 'iset-abc123' },
			'Frameworks/legacy.md': { curie: 'nist:LEGACY', recipeId: 'old-recipe' },
		});
		const index = await buildIdentityIndex(app, { importSetId: 'iset-abc123', recipeId: 'old-recipe' });
		expect(index.curies()).toEqual(['nist:STAMPED']);
	});
});

// ---------------------------------------------------------------------------
// F-7: a cold metadata cache means "not indexed yet", never "absent".
// ---------------------------------------------------------------------------

describe('a note the metadata cache has not indexed yet', () => {
	it('is still found by its curie (cache lag is not absence)', async () => {
		// The whole failure this closes: the note EXISTS and holds the identity,
		// but the index could not see it, so a re-import created a second one
		// beside it and the vault permanently held two files claiming one thing.
		const app = mockApp({}, { 'Ontologies/AC-2.md': rawGeneratedNote('nist:AC-2') });
		const index = await buildIdentityIndex(app);
		expect(index.get('nist:AC-2')?.path).toBe('Ontologies/AC-2.md');
		expect(index.size).toBe(1);
	});

	it('still obeys the import-set ownership filter it was built with', async () => {
		const app = mockApp({}, {
			'Ontologies/AC-2.md': rawGeneratedNote('nist:AC-2', 'iset-abc123'),
			'Elsewhere/X-1.md': rawGeneratedNote('other:X-1', 'iset-def456'),
		});
		const index = await buildIdentityIndex(app, { importSetId: 'iset-abc123' });
		expect(index.curies()).toEqual(['nist:AC-2']);
	});

	it('collides with a warm-cache note claiming the same curie, rather than being missed', async () => {
		const app = mockApp(
			{ 'Warm/AC-2.md': { curie: 'nist:AC-2' } },
			{ 'Cold/AC-2.md': rawGeneratedNote('nist:AC-2') },
		);
		const index = await buildIdentityIndex(app);
		expect(index.collisions).toEqual([{ curie: 'nist:AC-2', paths: ['Cold/AC-2.md', 'Warm/AC-2.md'] }]);
	});

	it('does not raw-read a file the cache already answered for', async () => {
		// The fallback costs one read per not-yet-indexed file, which is normally
		// zero. A regression that reads every file in the vault would still pass
		// every assertion above, so the cost is pinned separately.
		const app = mockApp({ 'Frameworks/AC-2.md': { curie: 'nist:AC-2' } });
		await buildIdentityIndex(app);
		expect(app.vault.cachedRead).not.toHaveBeenCalled();
	});

	it('treats a corrupt cache-cold note as having no frontmatter instead of throwing', async () => {
		// One unparseable note anywhere in the vault must not be able to stop an
		// unrelated import: the index is built over EVERY markdown file, so a throw
		// here would take down every import in a vault that holds one bad note.
		const app = mockApp({}, {
			'Broken/note.md': '---\n_crosswalker: [\ncurie: "nist:BROKEN"\n---\n',
			'Ontologies/AC-2.md': rawGeneratedNote('nist:AC-2'),
		});
		const parseSpy = jest.spyOn(Obsidian, 'parseYaml').mockImplementationOnce(() => {
			throw new Error('bad YAML');
		});
		try {
			const index = await buildIdentityIndex(app);
			expect(index.curies()).toEqual(['nist:AC-2']);
		} finally {
			parseSpy.mockRestore();
		}
	});

	it('ignores a cache-cold note with no frontmatter at all', async () => {
		const app = mockApp({}, { 'Notes/plain.md': '# Just a heading\n' });
		expect((await buildIdentityIndex(app)).size).toBe(0);
	});
});

describe('reconcile', () => {
	let index: IdentityIndex;

	beforeAll(async () => {
		index = await buildIdentityIndex(mockApp({ 'Old/Layout/AC-2.md': { curie: 'nist:AC-2' } }));
	});

	it('creates when the vault has never seen this identity', () => {
		expect(reconcile(index, 'nist:NEW-1', 'New/NEW-1.md').action).toBe('create');
	});

	it('merges in place when the note is already at the desired address', () => {
		expect(reconcile(index, 'nist:AC-2', 'Old/Layout/AC-2.md').action).toBe('merge-in-place');
	});

	it('MOVES rather than duplicating when the desired address changed', () => {
		const r = reconcile(index, 'nist:AC-2', 'New/Layout/AC-2.md');
		expect(r.action).toBe('move-then-merge');
		expect(r.existingFile?.path).toBe('Old/Layout/AC-2.md');
		expect(r.writePath).toBe('New/Layout/AC-2.md');
	});

	it('leaves a note alone at an address Crosswalker itself chose', () => {
		// Enrichment relocates concepts to a folder-note shape on purpose. Moving
		// such a note back would fight the pass that deliberately put it there.
		const r = reconcile(index, 'nist:AC-2', 'New/AC-2.md', (current) => current === 'Old/Layout/AC-2.md');
		expect(r.action).toBe('keep-in-place');
		expect(r.writePath).toBe('Old/Layout/AC-2.md');
	});
});
