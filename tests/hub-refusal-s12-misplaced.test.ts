/**
 * hub-refusal-s12-misplaced.test.ts -- S12 (2026-09-04, pass 19, Task C item
 * 6), end to end through the real engine: a hub note whose OWN recorded chain
 * describes a folder it does not sit in is refused by name, never adopted.
 *
 * THE DEFECT THIS PINS. AM-55 keyed `readOwnedHubsByFolder` by PLACEMENT
 * (`dirOf(hubPath)`) and dropped the `<folder>/<basename>.md` address
 * requirement -- correctly, since that address rule is what made a
 * `applyHubRelocation`-moved hub answer for nothing and report itself as
 * vanished. But nothing then checked the recorded chain against the folder
 * the note was actually found in. A `kind: hub` note a person drags into a
 * SIBLING folder by hand becomes that sibling folder's recorded identity:
 * `recordedValuesOf` would return the dragged hub's chain, `identityOf` would
 * adopt its curie, and its `hub_values` would be written back onto a folder
 * it never described -- and on a later Replace the note would be physically
 * RENAMED into the new folder under a meaning it never had. The old address
 * rule blocked this by accident; S12 blocks it on purpose.
 *
 * THE RULE. `readOwnedHubsByFolder` compares the rendered LAST SEGMENT of the
 * note's own recorded `hub_values` chain against the folder's own basename
 * (both through the AM-45 mirror). A mismatch: the note is never entered into
 * `byFolder` (so the engine cannot adopt it), the path joins a `misplaced`
 * list, and `reportOwnedHubReadProblems` refuses it BY NAME, exactly the way
 * an unreadable note is refused -- orphan reporting suppressed for the whole
 * run, because the run's picture of the vault is incomplete.
 */

import { TFile, TFolder } from 'obsidian';
import { generateFromRecipe } from '../src/generation/generation-engine';
import type { Recipe } from '../src/render';
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
			getFiles: () => [...files.keys()].map((p) => new TFile(p)),
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
				try { return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> }; }
				catch { return { frontmatter: undefined }; }
			},
		},
		fileManager: { renameFile: rename },
	};
	return { app: app as any, files };
}

const BASE = 'Ontologies';
const ONT = 's12misplaced';

function recipe(): Recipe {
	return {
		recipe: 's12-misplaced',
		source: { ontology: ONT, levels: ['tactic', 'leaf'] },
		target: {
			layout: [
				{ level: 'tactic', mechanism: 'folder', template: '{tactic}' },
				{ level: 'leaf', mechanism: 'file', template: '{id}.md' },
			],
			enrichment: { children_lists: true, facet_notes: 'none', parent_note: 'sibling', level_hubs: 'notes' },
		},
	};
}

/** T1 in Family-A, T2 in some OTHER folder so the run genuinely keeps something. */
function parsedTwoFamilies(): ParsedData {
	const rows = [
		{ id: 'T1', name: 'One', tactic: 'Family-A' },
		{ id: 'T2', name: 'Two', tactic: 'Family-B' },
	];
	return { columns: ['id', 'name', 'tactic'], rows, rowCount: rows.length };
}

function frontmatterOf(text: string): any {
	const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	return match ? (yaml.load(match[1]) as any) : {};
}

function run(app: any, rec: Recipe, parsed: ParsedData, overwriteMode: 'skip' | 'replace', importSet: any) {
	return generateFromRecipe(app, parsed, rec, {
		basePath: BASE,
		overwriteMode,
		createFolders: true,
		sourceFileName: 'source.csv',
		importSet,
		curieLocalPart: (row: Record<string, unknown>) => String(row.id),
	});
}

describe('S12 end to end: a hub note whose recorded chain describes a DIFFERENT folder than the one it sits in', () => {
	it('is refused by name, never adopted as the folder it was dragged into, and suppresses orphan reporting for the run', async () => {
		const { app, files } = makeApp();
		const first = await run(app, recipe(), parsedTwoFamilies(), 'replace', 'new');
		expect(first.errors).toEqual([]);
		const hubAPath = `${BASE}/Family-A/Family-A.md`;
		expect(files.has(hubAPath)).toBe(true);
		expect(frontmatterOf(files.get(hubAPath)!).hub_values).toEqual(['Family-A']);
		const setId = frontmatterOf(files.get(`${BASE}/Family-A/T1.md`)!)?._crosswalker?.import_set?.id;
		expect(typeof setId).toBe('string');

		// The hand-drag: physically move Family-A's hub note into Family-B's
		// folder WITHOUT touching its own frontmatter -- its `hub_values` still
		// says "Family-A", but it now SITS in Family-B. (Family-B's own genuine
		// hub is left alone at its own address, so this is a hub note copied
		// beside another, not a `many`-state collision.)
		const draggedPath = `${BASE}/Family-B/Family-A.md`;
		files.set(draggedPath, files.get(hubAPath)!);
		files.delete(hubAPath);

		const second = await run(app, recipe(), parsedTwoFamilies(), 'skip', { id: setId });
		expect(second.errors).toEqual([]);

		// NEVER adopted: Family-B's own recorded identity is not overwritten by
		// the dragged note's chain, and the dragged note is not renamed anywhere.
		expect(files.has(draggedPath)).toBe(true); // still exactly where it was dragged
		expect(frontmatterOf(files.get(draggedPath)!).hub_values).toEqual(['Family-A']); // untouched

		const warned = (second.warnings ?? []).map((w) => w.message).join('\n');
		expect(warned).toContain('records the identity of a different folder');
		expect(warned).toContain(draggedPath);

		// Fail-closed exactly like the unreadable-note case: the run's picture is
		// incomplete, so it does not publish an orphan list built from it.
		expect(second.orphansChecked).toBe(false);
		expect(second.orphans ?? []).toEqual([]);
	});
});
