/**
 * hub-relocation-produced.test.ts — AM-20 (2026-08-31): a hub this run moved is
 * a note this run produced.
 *
 * THE STAKE. `producedThisRun` is how the address door tells "a note that was
 * already there" from "a note we put there thirty milliseconds ago": the
 * vault-wide index is a PRE-RUN snapshot, so anything this run creates is
 * invisible to it and `provenanceAt` answers null, which `addressRefusal` reads
 * as `not-crosswalker`. Every create records itself there. A RENAME did not.
 *
 * A rename is a mutation this run made, exactly like a create. The snapshot
 * knows the moved note only under its OLD path, so a later hub resolving onto
 * its NEW address refused one of this run's own notes as a stranger's — a false
 * refusal, safe in direction and wrong in cause, on a note the run had just
 * finished writing.
 *
 * THE REACHABLE ORDERING. The facet-hub loop runs before the level-hub loop, so
 * the scenario below is the real one, not a contrivance: a recipe whose
 * `hub_note_folder` names a layout folder puts a facet hub at the same address a
 * level hub resolves to. Change `hub_note_folder` between imports (a plain
 * recipe edit) and the facet hub RELOCATES into that address, in the same run,
 * before the level-hub loop looks at it.
 */

import { TFile, TFolder } from 'obsidian';
import { generateFromRecipe } from '../src/generation/generation-engine';
import type { Recipe } from '../src/render';
import type { ImportSetOption } from '../src/generation/import-set';
import type { ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

function makeApp() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const rename = async (file: { path: string }, to: string) => {
		const text = files.get(file.path);
		files.delete(file.path);
		if (text !== undefined) files.set(to, text);
		file.path = to;
	};
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((p) => new TFile(p)),
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			create: async (path: string, content: string) => { files.set(path, content); return new TFile(path); },
			modify: async (file: { path: string }, content: string) => { files.set(file.path, content); },
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
			rename,
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const text = files.get(file.path);
				if (text === undefined) return null;
				const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
				if (!match) return { frontmatter: undefined };
				try {
					return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> };
				} catch {
					return { frontmatter: undefined };
				}
			},
		},
		fileManager: { renameFile: rename },
	};
	return { app: app as any, files };
}

const BASE = 'Frameworks';
/** Lowercase deliberately: the facet hub's filename is the TAGSAFE facet value,
 *  and the level hub's is the folder's own basename. They only land on one
 *  address when the folder is named the way a tag is. */
const FOLDER = 'ops';
const SHARED = `${BASE}/${FOLDER}/${FOLDER}.md`;

/** Two rows in one tactic, which is what `HUB_MIN_MEMBERS` needs for a facet hub. */
function parsed(): ParsedData {
	const rows = [
		{ id: 'T1', name: 'One', tactic: 'ops' },
		{ id: 'T2', name: 'Two', tactic: 'ops' },
	];
	return { columns: ['id', 'name', 'tactic'], rows, rowCount: rows.length };
}

function recipe(opts: { hubFolder: string; levelHubs: 'none' | 'notes' }): Recipe {
	return {
		recipe: 'relocating-hubs',
		source: { ontology: 'relocating-hubs', levels: ['group', 'leaf'] },
		target: {
			layout: [
				{ level: 'group', mechanism: 'folder', template: FOLDER },
				{ level: 'leaf', mechanism: 'file', template: '{id}.md' },
			],
			also_emit: {
				tags: ['tactic/{tactic|tagsafe}'],
				frontmatter: { managed: { title: '{name}' } },
			},
			enrichment: {
				children_lists: true,
				facet_notes: 'notes',
				hub_note_folder: opts.hubFolder,
				level_hubs: opts.levelHubs,
			},
		},
	};
}

function run(app: any, rec: Recipe, importSet: ImportSetOption) {
	return generateFromRecipe(app, parsed(), rec, {
		basePath: BASE,
		overwriteMode: 'replace',
		createFolders: true,
		sourceFileName: 'source.csv',
		importSet,
	});
}

function frontmatterOf(text: string): any {
	const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	return match ? (yaml.load(match[1]) as any) : {};
}

describe('a hub this run relocated', () => {
	/**
	 * Import once with the facet hubs parked in their own folder and no level
	 * hubs, then re-import with `hub_note_folder` pointing at the layout folder
	 * and level hubs turned on. The second run must MOVE the facet hub onto the
	 * address the level-hub loop then resolves to.
	 */
	async function relocateThenResolve() {
		const { app, files } = makeApp();
		const first = await run(app, recipe({ hubFolder: 'facets', levelHubs: 'none' }), 'new');
		expect(first.errors).toEqual([]);
		// The facet hub exists, parked away from the layout folder.
		expect(files.has(`${BASE}/facets/${FOLDER}.md`)).toBe(true);
		expect(files.has(SHARED)).toBe(false);
		const setId = frontmatterOf(files.get(`${BASE}/facets/${FOLDER}.md`)!)?._crosswalker?.import_set?.id;
		expect(typeof setId).toBe('string');

		const second = await run(app, recipe({ hubFolder: FOLDER, levelHubs: 'notes' }), { id: setId });
		return { app, files, setId, second };
	}

	it('really does move, in the same run the later hub then resolves onto it', async () => {
		// The premise of every assertion below. If the move stopped happening the
		// case would go green for the wrong reason.
		const { files, second } = await relocateThenResolve();
		expect(files.has(`${BASE}/facets/${FOLDER}.md`)).toBe(false);
		expect(files.has(SHARED)).toBe(true);
		expect(second.moved ?? []).toEqual([
			expect.objectContaining({ from: `${BASE}/facets/${FOLDER}.md`, to: SHARED }),
		]);
	});

	it('is not refused by a later hub in the same run as a note that is not ours', async () => {
		const { second } = await relocateThenResolve();
		const said = second.errors.map((e) => e.message).join('\n');
		expect(said).not.toContain("not Crosswalker's");
		expect(said).not.toContain(SHARED);
		expect(second.errors).toEqual([]);
	});

	it('leaves nothing on the conflict surface either', async () => {
		// The refusal could equally have surfaced as a conflict on a future
		// routing change. Neither surface should carry the moved hub's address.
		const { second } = await relocateThenResolve();
		for (const conflict of second.conflicts ?? []) expect(conflict.path).not.toBe(SHARED);
	});

	it('keeps the moved note, and lets the later hub write its own section into it', async () => {
		// The point of not refusing: the level hub adopts the note this run just
		// moved there and merges into it, rather than abandoning the file at an
		// address the run itself chose. The facet hub's own managed keys survive
		// the merge, which is how you can tell this is the same file and not a
		// second one written over the top.
		const { files } = await relocateThenResolve();
		const text = files.get(SHARED)!;
		expect(text).toContain('members:');
		expect(text).toContain('tactic/ops');
		expect(text).toContain('Contents');
	});
});
