/**
 * d1-pass21-residual3-legacy-note-at-address.test.ts -- residual ruling 3
 * (2026-09-04, pass 20 rulings, closed with a test by pass 21's Task C item
 * 6): S17's `producedThisRun` narrowing reaches the ADDRESS route, end to
 * end, for a note that carries no `_crosswalker` block at all.
 *
 * THE SCENARIO. A folder this run describes (a row's layout renders into it)
 * already holds a note at the level hub's own address (`<folder>/<folder
 * basename>.md`) that Crosswalker never wrote and never stamped -- a plain
 * legacy note a person wrote by hand, or one imported by an entirely
 * different tool. Before AM-14 this address route had no ownership check at
 * all: whatever sat there was adopted, restamped, and its content merged
 * into a Crosswalker hub, no matter whose it was. AM-14 closed that by
 * consulting `addressRefusal` at this exact site; S17 (pass 20) is the
 * narrowing that keeps the refusal in force even when the OCCUPYING note
 * happens to be part of this run's own batch (see
 * `tests/d1-pass20-s17-s18-address-and-withheld.test.ts` for that mechanism,
 * pinned structurally). This file is the end-to-end proof neither
 * pass-20's nor pass-21's own report had: the refusal actually fires through
 * the real engine, for a note that predates Crosswalker entirely.
 *
 * THE RULE, AS OBSERVED. The hub is refused by name (`AddressRefusalReason
 * 'not-crosswalker'`), the note is left byte-for-byte as it was, and the
 * folder's derived curie is never accounted -- no create, no restamp, no
 * curie written back onto a note that was never Crosswalker's to claim.
 */

import { TFile, TFolder } from 'obsidian';
import { generateFromRecipe } from '../src/generation/generation-engine';
import type { Recipe } from '../src/render';
import type { ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

function makeApp(seed: Map<string, string>, seedFolders: string[]) {
	const files = new Map(seed);
	const folders = new Set<string>(['', ...seedFolders]);
	const createCalls: string[] = [];
	const modifyCalls: string[] = [];
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
			create: async (path: string, content: string) => {
				createCalls.push(path);
				files.set(path, content);
				return new TFile(path);
			},
			modify: async (file: { path: string }, content: string) => {
				modifyCalls.push(file.path);
				files.set(file.path, content);
			},
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
	return { app: app as any, files, createCalls, modifyCalls };
}

const BASE = 'Frameworks';
const ONT = 'residual3';
const LEGACY_PATH = `${BASE}/A/A.md`;
const LEGACY_TEXT = '---\ntitle: A\n---\n# A\n\nHand-written content nobody asked Crosswalker to touch.\n';

function recipe(): Recipe {
	return {
		recipe: 'residual3-legacy-address',
		source: { ontology: ONT, levels: ['cat', 'leaf'] },
		target: {
			layout: [
				{ level: 'cat', mechanism: 'folder', template: '{cat}' },
				{ level: 'leaf', mechanism: 'file', template: '{id}.md' },
			],
			enrichment: { children_lists: true, facet_notes: 'none', parent_note: 'sibling', level_hubs: 'notes' },
		},
	};
}

function parsed(): ParsedData {
	const rows = [{ id: 'X1', name: 'X one', cat: 'A' }];
	return { columns: ['id', 'name', 'cat'], rows, rowCount: rows.length };
}

function frontmatterOf(text: string): any {
	const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	return match ? (yaml.load(match[1]) as any) : {};
}

describe('Residual ruling 3 / S17: a legacy note (no _crosswalker stamp) sitting at a described folder\'s hub address', () => {
	it('the hub is refused by name, the note is untouched, and the folder is not accounted under the hub\'s curie', async () => {
		const { app, files, createCalls, modifyCalls } = makeApp(
			new Map([[LEGACY_PATH, LEGACY_TEXT]]),
			[BASE, `${BASE}/A`],
		);

		const result = await generateFromRecipe(app, parsed(), recipe(), {
			basePath: BASE,
			overwriteMode: 'replace',
			createFolders: true,
			sourceFileName: 'source.csv',
			importSet: 'new',
			curieLocalPart: (row: Record<string, unknown>) => String(row.id),
		});

		// The described folder's OWN row is written normally -- the collision is
		// only at the hub's own address, not at the row's.
		expect(files.has(`${BASE}/A/X1.md`)).toBe(true);

		// The hub is refused BY NAME: one error, naming the exact path and the
		// exact cause a note nobody stamped gets.
		expect(result.errors.length).toBe(1);
		expect(result.errors[0].message).toBe(
			`Address collision: a note that is not Crosswalker's sits at ${LEGACY_PATH}. `
			+ 'Nothing was written for it. Move or rename that note, or choose a different destination folder for this import.',
		);

		// The note is untouched: never modified, never (re)created, byte-for-byte
		// the same text it started with, and it acquired no curie.
		expect(modifyCalls).not.toContain(LEGACY_PATH);
		expect(createCalls).not.toContain(LEGACY_PATH);
		expect(files.get(LEGACY_PATH)).toBe(LEGACY_TEXT);
		expect(frontmatterOf(files.get(LEGACY_PATH)!).curie).toBeUndefined();

		// Not accounted under the hub's curie: nothing this run wrote claims the
		// folder's identity, so the run cannot have adopted it either.
		expect(result.created).not.toContain(LEGACY_PATH);
	});
});
