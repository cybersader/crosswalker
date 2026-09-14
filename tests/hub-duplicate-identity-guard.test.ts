/**
 * hub-duplicate-identity-guard.test.ts — AM-31 (2026-08-31): one rule, all
 * writers.
 *
 * THE SPLIT THIS CLOSES. AM-27 gave the run a within-run duplicate-identity
 * guard, and wired it into the two ROW loops only. Every hub, facet and level
 * writer added its curie to `producedCuries` and consulted nothing:
 *
 *   rows   ->  record in `curieOrigins`, and refuse a second claimant by name
 *   hubs   ->  `producedCuries.add(...)`, and check nothing for this run
 *
 * Hubs run after rows, so the row could not see the hub and the hub did not look.
 * A hub curie equal to a row curie produced by the same run was written anyway,
 * and two hubs whose grouping values slug together (`Access Control` and
 * `access-control`) were written twice under one identity.
 *
 * WHY THAT IS NOT A COSMETIC GAP. Two notes holding one curie is permanent: the
 * identity index reports `Ambiguous identity`, and every later import in that
 * vault fails from a cause the user cannot connect to the import that caused it.
 * The guard is identity-NEUTRAL — it changes no curie and re-identifies nothing —
 * so there was never a pinning cost to applying it everywhere.
 *
 * THE FOUR WRITE SITES, and what this file reaches. Each hub loop claims twice:
 * once for the identity it is about to write, and once for a SUPERSEDED identity
 * it is adopting as an alias.
 *
 *   facet hub curie          covered below
 *   facet hub adopted alias  UNREACHABLE as the code stands, and stated here so
 *                            the gap is a known one: only level hubs are given
 *                            `legacyCuries`, so `resolveHubTarget` can never hand
 *                            a facet hub an adopted alias to claim.
 *   level hub curie          covered below, from both directions (hub vs hub,
 *                            and row vs hub)
 *   level hub adopted alias  covered below
 *
 * `markKeptHubsProduced` is deliberately unguarded and is not tested here: it
 * writes nothing, and it is handed the same hubs `applyEnrichment` is about to
 * write in a mixed skip/write run, so a claim recorded there would make every one
 * of those hubs refuse itself as a duplicate of its own bookkeeping entry.
 */

import { TFile, TFolder } from 'obsidian';
import { generateFromRecipe } from '../src/generation/generation-engine';
import type { App } from 'obsidian';
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
	return { app: app as unknown as App, files };
}

const BASE = 'Frameworks';
const ONTOLOGY = 'hg';

function parsed(rows: Record<string, unknown>[]): ParsedData {
	const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	return { columns, rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
}

/** Every identity actually written into the vault. */
function curiesIn(files: Map<string, string>): string[] {
	return [...files.values()].map((text) => {
		const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
		const fm = match ? (yaml.load(match[1]) as Record<string, unknown>) : {};
		return String(fm.curie ?? '');
	});
}

/** Any identity written more than once. Empty is the property; a name is the bug. */
function duplicated(files: Map<string, string>): string[] {
	const seen = new Map<string, number>();
	for (const curie of curiesIn(files)) {
		if (curie === '') continue;
		seen.set(curie, (seen.get(curie) ?? 0) + 1);
	}
	return [...seen].filter(([, count]) => count > 1).map(([curie]) => curie);
}

function recipe(opts: {
	folderTemplate?: string;
	facets?: boolean;
	levelHubs?: 'none' | 'notes';
}): Recipe {
	return {
		recipe: 'hub-guard',
		source: { ontology: ONTOLOGY, levels: opts.folderTemplate ? ['group', 'leaf'] : ['leaf'] },
		target: {
			layout: [
				...(opts.folderTemplate
					? [{ level: 'group', mechanism: 'folder' as const, template: opts.folderTemplate }]
					: []),
				{ level: 'leaf', mechanism: 'file' as const, template: '{key}.md' },
			],
			also_emit: {
				...(opts.facets ? { tags: ['tactic/{tactic|tagsafe}'] } : {}),
			},
			enrichment: {
				children_lists: true,
				facet_notes: opts.facets ? 'notes' : 'none',
				level_hubs: opts.levelHubs ?? 'none',
			},
		},
	};
}

function run(app: App, rows: Record<string, unknown>[], rec: Recipe, importSet: ImportSetOption) {
	return generateFromRecipe(app, parsed(rows), rec, {
		basePath: BASE,
		overwriteMode: 'replace',
		createFolders: true,
		sourceFileName: 'source.csv',
		importSet,
	});
}

// ---------------------------------------------------------------------------
// The facet-hub write site.
// ---------------------------------------------------------------------------

describe('AM-31: a facet hub may not take an identity this run already produced', () => {
	// Two rows share a facet value, which is what `HUB_MIN_MEMBERS` needs before a
	// facet hub exists at all. A third row DECLARES the identity that hub will
	// want. Nothing here is exotic: `facet/<namespace>/<value>` is an ordinary
	// identifier shape, and a source that ships one is not doing anything wrong.
	const ROWS = [
		{ key: 'T1', tactic: 'ops' },
		{ key: 'T2', tactic: 'ops' },
		{ key: 'claimant', id: `facet/tactic/ops`, tactic: 'solo' },
	];

	it('refuses the hub by name, and writes no second note under that identity', async () => {
		const { app, files } = makeApp();
		const result = await run(app, ROWS, recipe({ facets: true }), 'new');

		expect(duplicated(files)).toEqual([]);
		const refusal = result.errors.find((error) => error.message.includes('Duplicate identity in this import'));
		expect(refusal).toBeDefined();
		// A hub refusal names the note and the identity, and says what a user can
		// actually change — they cannot fix a hub by editing an identity column.
		expect(refusal!.message).toContain(`${ONTOLOGY}:facet/tactic/ops`);
		expect(refusal!.message).toMatch(/would be written as/);
		expect(refusal!.row).toBe(0);
	});

	it('writes nothing at the refused hub\'s address, and leaves the first claimant alone', async () => {
		// The refusal falls on the second writer, never retroactively on the first —
		// and a refused hub is one this run never touched, so no file appears where
		// it would have gone.
		const { app, files } = makeApp();
		await run(app, ROWS, recipe({ facets: true }), 'new');
		expect(files.has(`${BASE}/ops.md`)).toBe(false);
		expect(curiesIn(files)).toContain(`${ONTOLOGY}:facet/tactic/ops`);
	});
});

// ---------------------------------------------------------------------------
// The level-hub write site.
// ---------------------------------------------------------------------------

describe('AM-31: a level hub may not take an identity this run already produced', () => {
	it('refuses the second of two folders whose names slug together', async () => {
		// The case the amendment names. A level hub's identity is its folder path
		// relative to the import root, slugged - and `slug()` is many-to-one, so
		// `Ops Team` and `ops-team` are two folders and one identity. Before this,
		// both hub notes were written and the vault held that curie twice, forever.
		const { app, files } = makeApp();
		const result = await run(app, [
			{ key: 'T1', group: 'Ops Team' },
			{ key: 'T2', group: 'ops-team' },
		], recipe({ folderTemplate: '{group}', levelHubs: 'notes' }), 'new');

		expect(duplicated(files)).toEqual([]);
		const refusal = result.errors.find((error) => error.message.includes('Duplicate identity in this import'));
		expect(refusal).toBeDefined();
		expect(refusal!.message).toContain(`${ONTOLOGY}:hub/ops-team`);
	});

	it('refuses a level hub whose identity a source row already declared', async () => {
		// The other direction, and the one the split made invisible: rows run first,
		// so the row could not see the hub and the hub did not look.
		const { app, files } = makeApp();
		const result = await run(app, [
			{ key: 'T1', group: 'Ops' },
			{ key: 'T2', group: 'Ops' },
			{ key: 'claimant', group: 'Ops', id: 'hub/ops' },
		], recipe({ folderTemplate: '{group}', levelHubs: 'notes' }), 'new');

		expect(duplicated(files)).toEqual([]);
		const refusal = result.errors.find((error) => error.message.includes('Duplicate identity in this import'));
		expect(refusal).toBeDefined();
		expect(refusal!.message).toContain(`${ONTOLOGY}:hub/ops`);
		// Names the row that holds it, so the two writers are both identifiable.
		expect(refusal!.message).toMatch(/row 3|Frameworks\/Ops\/claimant\.md/);
	});

	it('refuses the SUPERSEDED identity a hub is adopting, not only its current one', async () => {
		// The second claim each level hub makes. A hub whose identity was corrected
		// (it used to be derived from its full vault path) adopts the old form as an
		// alias, and records it as produced so the superseded identity is not then
		// reported as a note that vanished. That recording is a claim like any other:
		// if something else in this run already produced it, two writers disagree
		// about one identity and neither may proceed silently.
		//
		// Built out of a real vault rather than a hand-written note: import once, then
		// rewrite the level hub's curie to the address-derived form those vaults
		// actually carry. The second import brings a row that declares that same
		// identifier.
		const { app, files } = makeApp();
		const first = await run(app, [
			{ key: 'T1', group: 'ops' },
			{ key: 'T2', group: 'ops' },
		], recipe({ folderTemplate: '{group}', levelHubs: 'notes' }), 'new');
		expect(first.errors).toEqual([]);

		const hubPath = `${BASE}/ops/ops.md`;
		const hubText = files.get(hubPath);
		expect(hubText).toBeDefined();
		const setId = String(
			((yaml.load(/^---\n([\s\S]*?)\n---/.exec(hubText!.replace(/\r\n/g, '\n'))![1]) as any)
				._crosswalker.import_set.id),
		);
		files.set(hubPath, hubText!.replace(`${ONTOLOGY}:hub/ops`, `${ONTOLOGY}:hub/frameworks/ops`));

		const second = await run(app, [
			{ key: 'T1', group: 'ops' },
			{ key: 'T2', group: 'ops' },
			{ key: 'claim', group: 'ops', id: 'hub/frameworks/ops' },
		], recipe({ folderTemplate: '{group}', levelHubs: 'notes' }), { id: setId });

		expect(duplicated(files)).toEqual([]);
		const refusal = second.errors.find((error) => error.message.includes('Duplicate identity in this import'));
		expect(refusal).toBeDefined();
		// The SUPERSEDED identity is the one named — the hub's current curie
		// (`hg:hub/ops`) is uncontested and was claimed without complaint.
		expect(refusal!.message).toContain(`${ONTOLOGY}:hub/frameworks/ops`);
		expect(refusal!.message).not.toContain(`${ONTOLOGY}:hub/ops,`);
		expect(refusal!.message).toContain('row 3');
	});

	it('does not refuse an ordinary import that has no collision at all', async () => {
		// The control. A guard that refused everything would pass every test above
		// and make hubs unusable.
		const { app, files } = makeApp();
		const result = await run(app, [
			{ key: 'T1', group: 'Ops' },
			{ key: 'T2', group: 'Detect' },
		], recipe({ folderTemplate: '{group}', levelHubs: 'notes' }), 'new');

		expect(result.errors).toEqual([]);
		expect(duplicated(files)).toEqual([]);
		expect(curiesIn(files)).toContain(`${ONTOLOGY}:hub/ops`);
		expect(curiesIn(files)).toContain(`${ONTOLOGY}:hub/detect`);
	});
});
