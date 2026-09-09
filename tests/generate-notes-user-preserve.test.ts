/**
 * generate-notes-user-preserve.test.ts — M2 (2026-07-12 pre-merge review):
 * `generateNotes` (the wizard/workbench entry point) previously hardcoded
 * `computeManagedKeys(noteData.frontmatter, [])` on re-import merge, ignoring
 * `recipe.target.also_emit.frontmatter.user_preserve` entirely — a
 * user_preserve-declared key was silently overwritten back to the recipe's
 * fresh-render value on every re-import through the wizard. The equivalent
 * call in `generateFromRecipe` (~line 1724) correctly reads user_preserve;
 * this test proves `generateNotes` now matches it (mirrors the stateful-vault
 * pattern used by tests/enrichment-reimport.test.ts + generate-notes-enrichment.test.ts).
 */

import { TFile, TFolder } from 'obsidian';
import { generateNotes } from '../src/generation/generation-engine';
import type { Recipe } from '../src/render';
import type { GenerationOptions } from '../src/generation/generation-engine';
import type { ImportSetOption } from '../src/generation/import-set';
import type { ImportRecipe, ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

// ---------------------------------------------------------------------------
// A minimal stateful in-memory vault + app (Map-backed) — same shape as
// tests/generate-notes-enrichment.test.ts.
// ---------------------------------------------------------------------------

function makeApp() {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);

	const getAbstractFileByPath = (path: string) => {
		if (files.has(path)) return new TFile(path);
		if (folders.has(path)) return new TFolder(path);
		return null;
	};
	const app = {
		vault: {
			// generateNotes resolves existing notes by identity AND, since AM-14
			// (2026-08-30), judges the ownership of whatever sits at a rendered
			// address -- both of which read the vault markdown list. A double that
			// answers `[]` while holding files is telling the engine that a note it
			// wrote itself is not Crosswalker's, so the list has to be real.
			getMarkdownFiles: () => [...files.keys()].map((path) => new TFile(path)),
			getAbstractFileByPath,
			create: async (path: string, content: string) => {
				files.set(path, content);
				return new TFile(path);
			},
			modify: async (file: { path: string }, content: string) => {
				files.set(file.path, content);
			},
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => {
				folders.add(path);
			},
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const text = files.get(file.path);
				if (!text) return null;
				const m = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
				if (!m) return { frontmatter: {} };
				return { frontmatter: (yaml.load(m[1]) as Record<string, unknown>) ?? {} };
			},
		},
	};
	return { app: app as any, files };
}

/** A workbench-shaped recipe with a managed `status` key AND a user_preserve
 *  declaration on that same key — the exact shape that exercises the M2 gap. */
const RECIPE_WITH_USER_PRESERVE: Recipe = {
	recipe: 'attack',
	source: { ontology: 'attack', levels: ['leaf'] },
	target: {
		layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }],
		also_emit: {
			frontmatter: {
				managed: { status: '{status}' },
				user_preserve: ['status'],
			},
		},
	},
};

const ROWS = [{ id: 'T1078', status: 'draft' }];

function parsedRows(rows: Record<string, unknown>[]): ParsedData {
	return { columns: ['id', 'status'], rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
}

function parsed(): ParsedData {
	return parsedRows(ROWS);
}

const CONFIG: Partial<ImportRecipe> = {
	name: 'attack',
	mapping: {
		hierarchy: [],
		frontmatter: [],
		links: [],
		body: [],
		filename: { template: '{id}.md', sanitize: true },
	},
};

/** Populated classic mapping that exercises the supplemental legacy merge. */
const CONFIG_WITH_STATUS_MAPPING: Partial<ImportRecipe> = {
	...CONFIG,
	mapping: {
		...CONFIG.mapping!,
		frontmatter: [{ column: 'status', key: 'status' }],
	},
};

function baseOptions(recipeOverride: Recipe, importSet?: ImportSetOption): GenerationOptions {
	return {
		basePath: 'Frameworks',
		overwriteMode: 'replace',
		createFolders: true,
		recipeOverride,
		...(importSet !== undefined ? { importSet } : {}),
	};
}

/**
 * The import set stamped on a note, read back off the note itself.
 *
 * AM-9 (2026-08-30): the engine never adopts, so a second call that names no
 * set MINTS one -- and AM-14 then refuses to write into the first set's notes,
 * which is the correct answer to "a new set walked into an occupied address"
 * and the wrong shape for a fixture about RE-IMPORT. Naming the set is the
 * headless stand-in for the ownership click the wizard puts on screen, exactly
 * as the E2E specs do it.
 */
function ownedImportSet(files: Map<string, string>, path: string): ImportSetOption {
	const fm = yaml.load(/^---\n([\s\S]*?)\n---/.exec(files.get(path)!)![1]) as Record<string, any>;
	const block = fm._crosswalker.import_set;
	return { id: block.id, scheme: block.scheme };
}

describe('generateNotes honors user_preserve on re-import merge (M2)', () => {
	it('a user_preserve-declared managed key survives re-import unchanged', async () => {
		const { app, files } = makeApp();

		// First import: recipe writes status: draft from the row.
		await generateNotes(app, parsed(), CONFIG, baseOptions(RECIPE_WITH_USER_PRESERVE));
		const notePath = 'Frameworks/T1078.md';
		const first = files.get(notePath)!;
		expect(first).toContain('status: draft');

		// User hand-edits status after import (the scenario user_preserve exists for).
		files.set(notePath, first.replace('status: draft', 'status: approved'));

		// Second import: the row still says status: draft, but user_preserve
		// declares 'status' as user-owned — the hand-edit must survive.
		const result = await generateNotes(
			app, parsed(), CONFIG, baseOptions(RECIPE_WITH_USER_PRESERVE, ownedImportSet(files, notePath)),
		);
		expect(result.errors).toEqual([]);

		const after = files.get(notePath)!;
		const fm = yaml.load(/^---\n([\s\S]*?)\n---/.exec(after)![1]) as Record<string, unknown>;
		expect(fm.status).toBe('approved');
	});

	it('without user_preserve, the same managed key IS overwritten on re-import (control case)', async () => {
		const RECIPE_NO_PRESERVE: Recipe = {
			...RECIPE_WITH_USER_PRESERVE,
			target: {
				...RECIPE_WITH_USER_PRESERVE.target,
				also_emit: { frontmatter: { managed: { status: '{status}' } } },
			},
		};
		const { app, files } = makeApp();

		await generateNotes(app, parsed(), CONFIG, baseOptions(RECIPE_NO_PRESERVE));
		const notePath = 'Frameworks/T1078.md';
		const first = files.get(notePath)!;
		files.set(notePath, first.replace('status: draft', 'status: approved'));

		await generateNotes(app, parsed(), CONFIG, baseOptions(RECIPE_NO_PRESERVE, ownedImportSet(files, notePath)));
		const after = files.get(notePath)!;
		const fm = yaml.load(/^---\n([\s\S]*?)\n---/.exec(after)![1]) as Record<string, unknown>;
		// No user_preserve declared -> managed value wins, overwriting the hand-edit.
		expect(fm.status).toBe('draft');
	});

	it('removes a stale declared managed value when an allowed refresh now omits it', async () => {
		const optionalRecipe: Recipe = {
			...RECIPE_WITH_USER_PRESERVE,
			target: {
				...RECIPE_WITH_USER_PRESERVE.target,
				also_emit: { frontmatter: { managed: { status: '{status|optional}' } } },
			},
		};
		const { app, files } = makeApp();
		await generateNotes(app, parsed(), CONFIG_WITH_STATUS_MAPPING, baseOptions(optionalRecipe));
		const notePath = 'Frameworks/T1078.md';
		const importSet = ownedImportSet(files, notePath);

		const result = await generateNotes(
			app,
			parsedRows([{ id: 'T1078' }]),
			CONFIG_WITH_STATUS_MAPPING,
			baseOptions(optionalRecipe, importSet),
		);

		expect(result.errors).toEqual([]);
		const fm = yaml.load(/^---\n([\s\S]*?)\n---/.exec(files.get(notePath)!)![1]) as Record<string, unknown>;
		expect(fm).not.toHaveProperty('status');
	});

	it('does not remove a stale managed value when overwrite mode skips the note', async () => {
		const optionalRecipe: Recipe = {
			...RECIPE_WITH_USER_PRESERVE,
			target: {
				...RECIPE_WITH_USER_PRESERVE.target,
				also_emit: { frontmatter: { managed: { status: '{status|optional}' } } },
			},
		};
		const { app, files } = makeApp();
		await generateNotes(app, parsed(), CONFIG_WITH_STATUS_MAPPING, baseOptions(optionalRecipe));
		const notePath = 'Frameworks/T1078.md';
		const before = files.get(notePath)!;
		const importSet = ownedImportSet(files, notePath);

		const result = await generateNotes(
			app,
			parsedRows([{ id: 'T1078' }]),
			CONFIG_WITH_STATUS_MAPPING,
			{ ...baseOptions(optionalRecipe, importSet), overwriteMode: 'skip' },
		);

		expect(result.skipped).toEqual([notePath]);
		expect(files.get(notePath)).toBe(before);
		const fm = yaml.load(/^---\n([\s\S]*?)\n---/.exec(files.get(notePath)!)![1]) as Record<string, unknown>;
		expect(fm.status).toBe('draft');
	});

	it('user_preserve wins when a declared managed value is omitted on refresh', async () => {
		const optionalPreserveRecipe: Recipe = {
			...RECIPE_WITH_USER_PRESERVE,
			target: {
				...RECIPE_WITH_USER_PRESERVE.target,
				also_emit: {
					frontmatter: {
						managed: { status: '{status|optional}' },
						user_preserve: ['status'],
					},
				},
			},
		};
		const { app, files } = makeApp();
		await generateNotes(app, parsed(), CONFIG_WITH_STATUS_MAPPING, baseOptions(optionalPreserveRecipe));
		const notePath = 'Frameworks/T1078.md';
		const first = files.get(notePath)!;
		files.set(notePath, first.replace('status: draft', 'status: approved'));
		const importSet = ownedImportSet(files, notePath);

		const result = await generateNotes(
			app,
			parsedRows([{ id: 'T1078' }]),
			CONFIG_WITH_STATUS_MAPPING,
			baseOptions(optionalPreserveRecipe, importSet),
		);

		expect(result.errors).toEqual([]);
		const fm = yaml.load(/^---\n([\s\S]*?)\n---/.exec(files.get(notePath)!)![1]) as Record<string, unknown>;
		expect(fm.status).toBe('approved');
	});
});
