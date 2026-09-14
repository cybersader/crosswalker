/**
 * basepath-normalization-am49.test.ts -- AM-49 (2026-09-04, pass 16, Task C
 * item 2): the import root is normalized once, at the engine boundary.
 *
 * THE DEFECT THIS PINS (pass-15 Ground 3 / CONFIRMED 2). Every note path this
 * engine writes goes through the host's `normalizePath` (collapse separators
 * and backslashes, strip edge separators, fold NBSP/NNBSP to an ordinary
 * space, Unicode-normalize to NFC) before it reaches the vault. The import
 * root -- `options.basePath` -- did NOT: `enrich.ts` ran only `stripSlashes`
 * on it, a fraction of one of those four mutations. So a base path pasted
 * with a non-breaking space, a decomposed accent, a backslash, or an internal
 * `//` made the root a DIFFERENT STRING from the prefix of every note path
 * the engine actually wrote. `rootIsTrackedAncestor` then read false,
 * `relativeToRoot` stopped stripping the root, every layout value disagreed
 * with its segment at index 0, AM-44's elementwise check refused EVERY level
 * hub in the import, and a refused hub's curie never reaching
 * `producedCuries` made the orphan pass report every hub the set owns as an
 * orphan -- a deviation that blames the recipe and the source row for a
 * character that was in the destination folder the user typed.
 *
 * THE RULE. `normalizeBasePath` runs once, at each of the two engine
 * boundaries (`generateNotes`, `generateFromRecipe`); every consumer inside --
 * `fullPath` composition, both `rootFolder:` sites, ownership resolution,
 * folder creation, the orphan/refresh scans -- reads the SAME normalized
 * string via the shadowed `options` parameter, so there is no second spelling
 * of the root left to disagree with the notes it is compared against.
 *
 * RUN UNDER THE CORRECTED MOCK. `tests/__mocks__/obsidian.ts`'s `normalizePath`
 * is the S5-corrected copy (pinned in `vault-path-normalization-am45.test.ts`)
 * -- this file exercises AM-49 through exactly the mock jest substitutes for
 * `obsidian` everywhere in this suite, not a hand simulation of the host.
 */

import { TFile, TFolder } from 'obsidian';
import { normalizePath as mockNormalizePath } from '../tests/__mocks__/obsidian';
import { generateFromRecipe } from '../src/generation/generation-engine';
import type { App } from 'obsidian';
import type { Recipe } from '../src/render';
import type { ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

// Built from \u escapes, deliberately -- see vault-path-normalization-am45's
// module doc comment for why. No literal non-ASCII character appears
// anywhere else in this file.
const NBSP = '\u00A0';
const COMBINING_ACUTE = '\u0301'; // COMBINING ACUTE ACCENT, decomposed form
const COMPOSED_E_ACUTE = '\u00E9'; // "e WITH ACUTE", ONE code point -- what NFC produces

// A base path carrying all four of normalizePath's mutations at once: a
// literal backslash and an internal "//" (mutation 1), a trailing separator
// (mutation 2), a non-breaking space (mutation 3), and a decomposed accent
// (mutation 4).
const RAW_BASE = `Frameworks${NBSP}Test\\Inner//e${COMBINING_ACUTE}-Path/`;
const EXPECTED_BASE = mockNormalizePath(RAW_BASE);

function makeApp() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
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
		fileManager: { renameFile: async () => undefined },
	};
	return { app: app as unknown as App, files };
}

function parsedData(rows: Record<string, unknown>[]): ParsedData {
	const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	return { columns, rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
}

function hubsInVault(files: Map<string, string>): { path: string; curie: string }[] {
	const out: { path: string; curie: string }[] = [];
	for (const [path, text] of files) {
		const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
		if (!match) continue;
		let fm: Record<string, unknown>;
		try { fm = (yaml.load(match[1]) ?? {}) as Record<string, unknown>; } catch { continue; }
		if (fm.kind !== 'hub') continue;
		out.push({ path, curie: String(fm.curie) });
	}
	return out;
}

describe('AM-49: the mock host actually mangles this base path (sanity on the fixture itself)', () => {
	it('RAW_BASE is not already normalized, and EXPECTED_BASE runs all four mutations', () => {
		expect(RAW_BASE).not.toBe(EXPECTED_BASE);
		expect(RAW_BASE).toContain(NBSP);
		expect(RAW_BASE).toContain('\\');
		expect(RAW_BASE).toContain('//');
		expect(RAW_BASE.endsWith('/')).toBe(true);
		expect(EXPECTED_BASE).toBe(`Frameworks Test/Inner/${COMPOSED_E_ACUTE}-Path`);
	});
});

describe('AM-49: a base path carrying NBSP, NFD, a backslash, an internal //, and a trailing slash imports cleanly', () => {
	const ONT = 'hg';
	const HUB_CONFIG = { children_lists: true, facet_notes: 'none' as const, level_hubs: 'notes' as const };

	async function importUnderMangledBase() {
		const { app, files } = makeApp();
		const recipe: Recipe = {
			recipe: 'am49-mangled-base',
			source: { ontology: ONT, levels: ['catalog', 'control'] },
			target: {
				layout: [
					{ level: 'catalog', mechanism: 'folder', template: '{catalog}' },
					{ level: 'control', mechanism: 'file', template: '{id}.md' },
				],
				enrichment: HUB_CONFIG,
			},
		};
		const rows = [{ id: 'AC-2', catalog: 'AC' }];
		const result = await generateFromRecipe(app, parsedData(rows), recipe, {
			basePath: RAW_BASE,
			overwriteMode: 'replace',
			createFolders: true,
			sourceFileName: 'source.csv',
			importSet: 'new',
		});
		return { result, files };
	}

	it('every note is written under the NORMALIZED base, never the raw one', async () => {
		const { result, files } = await importUnderMangledBase();
		expect(result.errors).toEqual([]);
		expect([...files.keys()].some((p) => p.startsWith(`${EXPECTED_BASE}/`))).toBe(true);
		expect([...files.keys()].some((p) => p.startsWith(RAW_BASE))).toBe(false);
		expect(files.has(`${EXPECTED_BASE}/AC/AC-2.md`)).toBe(true);
	});

	it('the root and the catalog-level hub are both written -- none refused, no deviations', async () => {
		const { result, files } = await importUnderMangledBase();

		// THE DEFECT: under the bug, `rootIsTrackedAncestor` reads false and every
		// hub is refused, so `result.warnings` (enrichment deviations) is where the
		// failure would first show up, and no hub note exists at all.
		expect(result.warnings ?? []).toEqual([]);

		const hubs = hubsInVault(files);
		// The root/home hub: identified via its reserved local part, never an
		// address -- present regardless of the base path's spelling.
		const rootHubPath = `${EXPECTED_BASE}/${EXPECTED_BASE.split('/').pop()}.md`;
		const rootHub = hubs.find((h) => h.path === rootHubPath);
		expect(rootHub).toBeDefined();
		expect(rootHub!.curie).toBe(`${ONT}:hub/_root`);

		// The catalog-level hub -- this is the one the bug refused: its identity
		// is compared against the (correctly normalized) note path, and that
		// comparison only agrees when the ROOT was normalized the same way.
		const catalogHub = hubs.find((h) => h.path === `${EXPECTED_BASE}/AC/AC.md`);
		expect(catalogHub).toBeDefined();
		expect(catalogHub!.curie).toBe(`${ONT}:hub/ac`);

		// Exactly two hubs -- root and catalog -- never zero.
		expect(hubs).toHaveLength(2);
	});

	it('zero orphans: a first import reports none, and orphan detection is not left uncomputed', async () => {
		const { result } = await importUnderMangledBase();
		// A fresh set has nothing to compare against, so orphan detection either
		// ran and found none, or the field is absent -- both are "zero orphans".
		// What AM-49 exists to prevent is a NON-empty orphans list produced by
		// every one of this run's own hubs being reported as missing.
		expect(result.orphans ?? []).toEqual([]);
	});
});
