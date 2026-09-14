/**
 * skip-refresh-am55-engine.test.ts -- AM-55 (2026-09-04, pass 18, Task C item
 * 2), end to end through the real engine: what `readOwnedHubsByFolder` observes
 * when a hub note cannot be READ, and the shared deviation ledger both
 * bookkeeping and writing passes read and write through.
 *
 * THE DEFECT THIS PINS (pass-17 CONFIRMED 4 / Ground 4). `buildRecordedHubValues`
 * treated `read.state !== 'ok'` as one bucket, which collapsed "this note
 * genuinely records nothing" (a fact) into the same bucket as "nothing could be
 * read from this note" (the ABSENCE of a fact, e.g. Obsidian hasn't indexed it
 * yet). A transiently-unreadable hub took AM-55's row-2 refused branch and was
 * published as an orphan in the same run's results, over a note sitting right
 * there in the vault -- `project_cache_lag_is_not_absence`'s tenth recorded
 * instance.
 *
 * THE RULE. `readOwnedHubsByFolder` collects `unreadable` paths separately and
 * NEVER folds them into "no record". `markKeptHubsProduced` treats a non-empty
 * `unreadable` list exactly like a failed derivation: one warning naming the
 * notes, `enrichmentComplete` cleared, and orphan reporting suppressed for the
 * whole run.
 */

import { TFile, TFolder } from 'obsidian';
import { generateFromRecipe } from '../src/generation/generation-engine';
import { enrich } from '../src/generation/enrich';
import type { Recipe } from '../src/render';
import type { ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

/**
 * `cacheBudget`: for a path listed here, `getFileCache` returns a valid cache
 * entry the first N times it is asked (consumed on every call, whichever
 * caller makes it), then starts answering null AND `read`/`cachedRead` starts
 * throwing for that path. This simulates a note whose cache entry is present
 * during the vault's own identity scan (so it is genuinely tracked as owned)
 * and becomes unreadable by the time the enrichment pass asks about it again
 * -- the shape S8/AM-55 exist for: a fact the run once had and then lost, not
 * a note that was never indexed at all.
 */
function makeApp(cacheBudget: Map<string, number> = new Map()) {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const rename = async (file: { path: string }, to: string) => {
		const text = files.get(file.path);
		files.delete(file.path);
		if (text !== undefined) files.set(to, text);
		file.path = to;
	};
	const exhausted = (path: string): boolean => {
		if (!cacheBudget.has(path)) return false;
		const remaining = cacheBudget.get(path)!;
		if (remaining <= 0) return true;
		cacheBudget.set(path, remaining - 1);
		return false;
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
			read: async (file: { path: string }) => {
				if (cacheBudget.has(file.path) && cacheBudget.get(file.path)! <= 0) throw new Error('simulated transient read failure');
				return files.get(file.path) ?? '';
			},
			cachedRead: async (file: { path: string }) => {
				if (cacheBudget.has(file.path) && cacheBudget.get(file.path)! <= 0) throw new Error('simulated transient read failure');
				return files.get(file.path) ?? '';
			},
			createFolder: async (path: string) => { folders.add(path); },
			rename,
		},
		metadataCache: {
			// S8's own discriminator: a cache MISS (not merely empty properties)
			// must fall through to the read, never be read as "records nothing".
			getFileCache: (file: { path: string }) => {
				const text = files.get(file.path);
				if (text === undefined) return null;
				if (exhausted(file.path)) return null;
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
const ONT = 'skiprecat';

function recipe(): Recipe {
	return {
		recipe: 'skip-recat-am55',
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

function parsedV1(): ParsedData {
	const rows = [{ id: 'T1', name: 'One', tactic: 'Persistence' }];
	return { columns: ['id', 'name', 'tactic'], rows, rowCount: rows.length };
}

/** Same row, kept in place, but recategorised so Persistence describes no chain of this run. */
function parsedV2Recategorized(): ParsedData {
	const rows = [{ id: 'T1', name: 'One', tactic: 'IA' }];
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

describe('AM-55: a hub note that cannot be READ is not treated as a hub that records nothing', () => {
	it('suppresses orphan reporting for the run and names the unreadable note in a warning', async () => {
		// One mutable budget map, shared with the app's read/cache stubs by
		// reference -- empty (unlimited) for the seeding run, then set to 2 for
		// the hub note before the refresh: exactly enough for the two
		// `buildIdentityIndex` scans (owned + vault-wide) that legitimately need
		// to see this note's curie to track it as owned, so it is genuinely
		// indexed -- and exhausted by the time `readOwnedHubsByFolder`'s own,
		// LATER read asks about the same note again.
		const cacheBudget = new Map<string, number>();
		const { app, files } = makeApp(cacheBudget);
		const first = await run(app, recipe(), parsedV1(), 'replace', 'new');
		expect(first.errors).toEqual([]);
		const hubPath = `${BASE}/Persistence/Persistence.md`;
		expect(files.has(hubPath)).toBe(true);
		const setId = frontmatterOf(files.get(`${BASE}/Persistence/T1.md`)!)?._crosswalker?.import_set?.id;

		cacheBudget.set(hubPath, 2);

		const second = await run(app, recipe(), parsedV2Recategorized(), 'skip', { id: setId });
		expect(second.errors).toEqual([]);

		// Fail-closed: a run that could not read an owned note cannot prove
		// anything is absent, so it does not publish an orphan list at all.
		expect(second.orphansChecked).toBe(false);
		expect(second.orphans ?? []).toEqual([]);

		const warned = (second.warnings ?? []).map((w) => w.message).join('\n');
		expect(warned).toContain('Could not read');
		expect(warned).toContain(hubPath);
		// Named as "notes", never asserted to BE (or not be) an index note --
		// the run could not observe that either.
		expect(warned).not.toContain('have been moved');
	});
});

/**
 * AM-59 (2026-09-04, pass 19), end to end: `many` is a refusal by NAME and
 * BOTH competing notes are accounted for, so neither is reported as an orphan
 * in the same run that just printed its path as present.
 *
 * THE DEFECT THIS PINS (pass-18 Ground 2 / CONFIRMED). A folder holding two
 * `kind: hub` notes refused with a message naming both paths and asking the
 * user to pick one, while the SAME run's orphan pass reported both notes as
 * no longer in the source -- a consequence clause the run's own refusal text
 * contradicts.
 */
describe('AM-59: two index notes in one kept folder -- refused by name, neither reported as an orphan', () => {
	it('names both notes in a warning and reports zero orphans for either curie', async () => {
		const { app, files } = makeApp();
		const first = await run(app, recipe(), parsedV1(), 'replace', 'new');
		expect(first.errors).toEqual([]);
		const hubPath = `${BASE}/Persistence/Persistence.md`;
		expect(files.has(hubPath)).toBe(true);
		const setId = frontmatterOf(files.get(`${BASE}/Persistence/T1.md`)!)?._crosswalker?.import_set?.id;

		// A second `kind: hub` note in the SAME folder, sharing every provenance
		// field with the first (same import set, so it is "owned" the same way)
		// but its own distinct curie -- e.g. a hub the user copied, or left beside
		// a renamed one.
		const copyPath = `${BASE}/Persistence/Persistence-copy.md`;
		const copyContent = files.get(hubPath)!.replace(
			/^curie: .*$/m,
			'curie: skiprecat:hub/persistence-copy',
		);
		expect(copyContent).not.toBe(files.get(hubPath));
		files.set(copyPath, copyContent);

		const second = await run(app, recipe(), parsedV2Recategorized(), 'skip', { id: setId });
		expect(second.errors).toEqual([]);

		const warned = (second.warnings ?? []).map((w) => w.message).join('\n');
		expect(warned).toContain('more than one index note');
		expect(warned).toContain(hubPath);
		expect(warned).toContain(copyPath);
		expect(warned).toContain('cannot say which one');

		// Refusing to pick is not evidence either note left the source: the run
		// checked orphans (this is not the unreadable/misplaced suppression path)
		// and reported neither curie.
		expect(second.orphansChecked).toBe(true);
		const orphanCuries = (second.orphans ?? []).map((o) => o.curie);
		expect(orphanCuries).not.toContain('skiprecat:hub/persistence');
		expect(orphanCuries).not.toContain('skiprecat:hub/persistence-copy');
	});
});

/**
 * AM-55's shared-ledger dedup contract, tested directly.
 *
 * `markKeptHubsProduced` and `applyEnrichment` each call `enrich()` separately
 * (bookkeeping over `[...enrichRecords, ...keptRecords]`, writing over
 * `enrichRecords` alone -- generation-engine.ts:898/921, :3201-3230) and each
 * forwards `implied.deviations` / `enrichment.deviations` through ONE shared
 * `deviationsSeen` Set built once per run (generation-engine.ts:888, :3196) via
 * the identical guard both call sites use verbatim
 * (generation-engine.ts:3743-3745, :3836-3838):
 *
 *   if (deviationsSeen.has(d)) continue;
 *   deviationsSeen.add(d);
 *   result.warnings.push({ row: 0, message: d });
 *
 * Pass 18's own residual risk #3 records that constructing an ORGANIC run
 * where both passes independently compute the identical KEPT-cause text for
 * one folder could not be done: `applyEnrichment`'s own `enrich()` call is
 * fed `enrichRecords` only, and every real producer of a kept-shaped record
 * among `enrichRecords` (the folder-note relocation branch) is exempted by
 * `hostByFolder` before the kept branch is ever asked, so `keptFolders` is
 * structurally empty in the one pass that can write. This test instead proves
 * the LEDGER's own contract directly: two independent `enrich()` calls that
 * genuinely compute the same kept-cause text (built the same way the two real
 * call sites are), routed through the SAME shared Set with the SAME guard
 * used in the run, produce that text in `result.warnings` exactly once --
 * never zero times (which would be Ground 5 again) and never twice (which is
 * risk 3's still-open asymmetry made concrete).
 */
describe('AM-55: the shared deviationsSeen ledger reports one identical deviation exactly once, never twice', () => {
	it('two enrich() calls that independently compute the same kept-cause text push it into result.warnings exactly once', () => {
		const ONT = 'ledger';
		const ROOT = 'Frameworks';
		const HUB_CONFIG = { children_lists: true, facet_notes: 'none' as const, level_hubs: 'notes' as const };
		const keptNote = () => ({
			path: `${ROOT}/Persistence/T1.md`,
			renderedPath: `${ROOT}/IA/T1.md`,
			curie: `${ONT}:t1`,
			frontmatter: {},
			facets: [],
			layoutValues: [{ level: 'tactic', value: 'IA' }],
		});

		// AM-65 (2026-09-04). THE WRITE SET, STATED: both passes see the same single
		// row this run KEPT, so nothing in either batch is writable. `enrich()` no
		// longer infers that from `renderedPath` vs `path`, and omitting the set is a
		// refusal by name. The assertions below are unchanged.
		const NOTHING_WRITABLE: ReadonlySet<string> = new Set<string>();
		// "Pass 1" (mirrors markKeptHubsProduced): sees the kept record, no
		// recorded hub for its old folder.
		const pass1 = enrich([keptNote()], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: NOTHING_WRITABLE });
		// "Pass 2" (mirrors applyEnrichment): a SEPARATE enrich() call that, in
		// this constructed scenario, is ALSO handed the same kept-shaped record
		// (standing in for the organic case pass 18 could not build) and
		// therefore computes the byte-identical text.
		const pass2 = enrich([keptNote()], { ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, writeSet: NOTHING_WRITABLE });

		expect(pass1.deviations).toEqual(pass2.deviations);
		expect(pass1.deviations.some((d) => d.includes('kept in place'))).toBe(true);

		// The REAL guard, verbatim (generation-engine.ts:3740-3747, :3833-3840).
		const deviationsSeen = new Set<string>();
		const warnings: { row: number; message: string }[] = [];
		const forward = (deviations: string[]) => {
			for (const d of deviations) {
				if (deviationsSeen.has(d)) continue;
				deviationsSeen.add(d);
				warnings.push({ row: 0, message: d });
			}
		};
		forward(pass1.deviations); // markKeptHubsProduced runs first in the real run.
		forward(pass2.deviations); // applyEnrichment runs second, same ledger.

		const keptCauseWarnings = warnings.filter((w) => w.message.includes('kept in place'));
		expect(keptCauseWarnings).toHaveLength(1);
	});
});
