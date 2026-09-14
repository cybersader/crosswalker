/**
 * output-root-am53-extended.test.ts -- AM-53, extended (2026-09-04, pass 18,
 * Task C item 4): the wizard shows the destination it writes.
 *
 * THE DEFECT THIS PINS (pass-17 SUSPECTED 6, promoted). `deriveDestinationDefault`
 * (the review screen's own destination-preview function) carried a SECOND
 * spelling of the root normalization -- `.trim().replace(/\/+$/, '')`, trim plus
 * TRAILING separators only, verbatim the `stripSlashes` shape AM-49's own doc
 * comment names as insufficient. The engine re-normalizes the base at its own
 * boundary (`normalizeBasePath`, AM-49) before writing, so what LANDED on disk
 * was always correct; what the review screen SHOWED and the user accepted was
 * not: `Frame//works` configured as the global root displayed as
 * `Frame//works/nist` and the import actually wrote to `Frame/works/nist` --
 * a destination the user never saw and never approved.
 *
 * THE RULE. `deriveDestinationDefault` (and `recognizedDestination`) now route
 * through `normalizeFolderSetting`, the SAME function `outputRootPath` uses at
 * the settings boundary. This test proves the fix end to end: what the wizard
 * DISPLAYS via `deriveDestinationDefault` is byte-identical to where the real
 * engine (`generateNotes`) actually creates the file, for a root carrying
 * exactly the defect's malformed shape (an internal double separator).
 */

import { TFile, TFolder } from 'obsidian';
import { generateNotes } from '../src/generation/generation-engine';
import { deriveDestinationDefault } from '../src/import/mapping/view-model';
import type { Recipe } from '../src/render';
import type { GenerationOptions } from '../src/generation/generation-engine';
import type { ImportRecipe, ParsedData } from '../src/types/config';

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
			createFolder: async (path: string) => { folders.add(path); },
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const text = files.get(file.path);
				return text === undefined ? null : { frontmatter: {} };
			},
		},
	};
	return { app: app as any, files };
}

const RECIPE: Recipe = {
	recipe: 'am53-extended',
	source: { ontology: 'am53', levels: ['leaf'] },
	target: { layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }] },
};

const CONFIG: Partial<ImportRecipe> = {
	name: 'am53',
	mapping: { hierarchy: [], frontmatter: [], links: [], body: [], filename: { template: '{id}.md', sanitize: true } },
};

function parsed(): ParsedData {
	const rows = [{ id: 'ctrl-1' }];
	return { columns: ['id'], rows, rowCount: rows.length };
}

describe('AM-53, extended: the wizard\'s displayed destination is byte-identical to what the engine writes', () => {
	it('a malformed root (internal double separator) composes ONE destination string, shown and written alike', async () => {
		const malformedRoot = 'Frame//works';
		const shown = deriveDestinationDefault(malformedRoot, 'nist-csf.csv');
		// The bug this pins, pinned as a value: before AM-53 extended this would
		// have been 'Frame//works/nist-csf' (the second, insufficient spelling).
		expect(shown).toBe('Frame/works/nist-csf');
		expect(shown).not.toContain('//');

		const { app, files } = makeApp();
		const options: GenerationOptions = {
			basePath: shown,
			overwriteMode: 'replace',
			createFolders: true,
			recipeOverride: RECIPE,
		};
		const result = await generateNotes(app, parsed(), CONFIG, options);
		expect(result.errors).toEqual([]);
		expect(result.created).toEqual([`${shown}/ctrl-1.md`]);
		// Byte-identical: the composed destination the review screen showed is
		// the literal prefix of what landed on disk, with no further mutation.
		expect(files.has(`${shown}/ctrl-1.md`)).toBe(true);
	});

	it('an unnamed source falls back to "Imported" through the same normalization -- still byte-identical', async () => {
		const shown = deriveDestinationDefault('Frame//works', undefined);
		expect(shown).toBe('Frame/works/Imported');

		const { app } = makeApp();
		const result = await generateNotes(app, parsed(), CONFIG, {
			basePath: shown,
			overwriteMode: 'replace',
			createFolders: true,
			recipeOverride: RECIPE,
		});
		expect(result.errors).toEqual([]);
		expect(result.created).toEqual([`${shown}/ctrl-1.md`]);
	});
});
