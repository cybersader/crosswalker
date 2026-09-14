/**
 * d1-pass23-am68-am70-am71-vault-state.test.ts — the three pass-21 findings that
 * AM-68, AM-70/AM-78 and AM-71 closed in pass 22 and that pass 22 never wrote a
 * unit witness for (its tests leg stopped mid-response and produced no output).
 *
 * AM-68 — an UNREADABLE CONCEPT is not an unreadable INDEX. A fact about a note
 * is not a fact about its folder. When a concept note beside a perfectly
 * readable index note cannot be read, the run must suppress orphan reporting
 * (it cannot know what is still there) and must NOT additionally claim it could
 * not read the folder's index note. When there is no readable index note in the
 * folder either, the qualified row-3 sentence speaks and names the cause.
 *
 * AM-70/AM-78 — the scope is the RECORDED-CHAIN form. A `kind: hub` note in a
 * folder no note's ancestor chain reaches, and whose recorded chain is ABSENT,
 * is unjudged and voiced: the run can say nothing about what it was for.
 * A hub whose recorded chain is PRESENT in a folder no note reaches is what a
 * source release that dropped every row of a folder leaves behind, and it IS an
 * orphan — judged by its recorded identity, not by its path. The wider wording
 * of AM-70 would have deleted the second case, which is why AM-78 narrows it.
 *
 * AM-71 — a home note that is not there is created; one that is there is left
 * alone; and a held folder with no index note of this import still gets row 3
 * even when the caller collected no layout values at all.
 *
 * Scope note: AM-78 explicitly DEFERS two inherited edges to Part B — the
 * `ownedHubs` read gated on `keptRecords.length > 0` (so the same chain-less hub
 * is named under Skip and orphaned under Replace) and a hub hand-dragged to the
 * vault root, never observed. Neither is widened or asserted here.
 */

import { TFile, TFolder } from 'obsidian';
import { generateFromRecipe } from '../src/generation/generation-engine';
import { enrich, type EnrichNote, type OwnedHubsByFolder } from '../src/generation/enrich';
import type { Recipe } from '../src/render';
import type { ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

/**
 * `cacheGoodUntil` lets a note answer from a GOOD cached frontmatter for its
 * first N `getFileCache` calls and fall to its (corrupted) on-disk bytes after —
 * which is how a note gets into the identity index and then becomes unreadable
 * at the moment the run needs to read it again.
 */
function makeApp(cacheGoodUntil: Map<string, number>) {
	const files = new Map<string, string>();
	const folders = new Set<string>(['']);
	const callCounts = new Map<string, number>();
	const goodFm = new Map<string, Record<string, unknown>>();
	const modifyCalls: string[] = [];
	const createCalls: string[] = [];
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
			create: async (path: string, content: string) => { createCalls.push(path); files.set(path, content); return new TFile(path); },
			modify: async (file: { path: string }, content: string) => { modifyCalls.push(file.path); files.set(file.path, content); },
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
			rename,
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const n = (callCounts.get(file.path) ?? 0) + 1;
				callCounts.set(file.path, n);
				const until = cacheGoodUntil.get(file.path);
				if (until !== undefined) {
					if (n <= until) return { frontmatter: JSON.parse(JSON.stringify(goodFm.get(file.path))) };
					return { frontmatter: undefined };
				}
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
	return { app: app as any, files, modifyCalls, createCalls, goodFm };
}

const BASE = 'Frameworks';

function recipe(ontology: string, id: string): Recipe {
	return {
		recipe: id,
		source: { ontology, levels: ['tactic', 'leaf'] },
		target: {
			layout: [
				{ level: 'tactic', mechanism: 'folder', template: '{tactic}' },
				{ level: 'leaf', mechanism: 'file', template: '{id}.md' },
			],
			enrichment: { children_lists: true, facet_notes: 'none', parent_note: 'sibling', level_hubs: 'notes' },
		},
	};
}

function run(app: any, parsed: ParsedData, ontology: string, id: string, overwriteMode: 'skip' | 'replace', importSet: any) {
	return generateFromRecipe(app, parsed, recipe(ontology, id), {
		basePath: BASE,
		overwriteMode,
		createFolders: true,
		sourceFileName: 'source.csv',
		importSet,
		curieLocalPart: (row: Record<string, unknown>) => String(row.id),
	});
}

function frontmatterOf(text: string): any {
	const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	return match ? (yaml.load(match[1]) as any) : {};
}

const messages = (r: { warnings?: { message: string }[] }): string[] => (r.warnings ?? []).map((w) => w.message);
const UNREADABLE_NOTE = 'Could not read a note in this collection, so notes no longer in the source were not reported';
const NO_INDEX_READ = 'No index note of this import could be read in the folder';

// ---------------------------------------------------------------------------
// AM-68
// ---------------------------------------------------------------------------

describe('AM-68: an unreadable concept is not an unreadable index', () => {
	it('a readable hub beside an unreadable concept: the folder is left correct and no index-unreadability is claimed', async () => {
		const ONT = 'p23am68a';
		const cacheGoodUntil = new Map<string, number>();
		const { app, files, modifyCalls, createCalls, goodFm } = makeApp(cacheGoodUntil);
		const parsed: ParsedData = {
			columns: ['id', 'name', 'tactic'],
			rows: [
				{ id: 'P1', name: 'P one', tactic: 'Persistence' },
				{ id: 'P2', name: 'P two', tactic: 'Persistence' },
			],
			rowCount: 2,
		};
		const first = await run(app, parsed, ONT, 'p23am68a', 'replace', 'new');
		expect(first.errors).toEqual([]);
		const P1 = `${BASE}/Persistence/P1.md`;
		const HUB = `${BASE}/Persistence/Persistence.md`;
		const setId = frontmatterOf(files.get(P1)!)?._crosswalker?.import_set?.id;
		const hubBefore = files.get(HUB)!;

		// P1 is in the identity index (the cache answers for the two index scans and
		// the conflict check) and then becomes unreadable on disk.
		goodFm.set(P1, frontmatterOf(files.get(P1)!));
		cacheGoodUntil.set(P1, 3);
		files.set(P1, '---\n: : :\ncurie: bogus\n---\nBody.\n');

		modifyCalls.length = 0;
		createCalls.length = 0;
		const second = await run(app, parsed, ONT, 'p23am68a', 'skip', { id: setId });

		expect(second.errors).toEqual([]);
		// The index note IS readable, so the run must not say otherwise.
		expect(messages(second).filter((m) => m.includes(NO_INDEX_READ))).toEqual([]);
		// It must still say why it cannot report removals, naming the note it failed on.
		expect(messages(second).filter((m) => m.includes(UNREADABLE_NOTE)).length).toBe(1);
		expect(messages(second).find((m) => m.includes(UNREADABLE_NOTE))).toContain(P1);
		// Orphan reporting is suppressed both ways: not checked, and nothing reported.
		expect(second.orphansChecked).toBe(false);
		expect(second.orphans ?? []).toEqual([]);
		// The readable folder state is correct and untouched.
		expect(files.get(HUB)).toBe(hubBefore);
		expect(modifyCalls).toEqual([]);
		expect(createCalls).toEqual([]);
	});

	it('no readable index note in the folder: the qualified row-3 sentence speaks and no hub is created', async () => {
		const ONT = 'p23am68b';
		const cacheGoodUntil = new Map<string, number>();
		const { app, files, modifyCalls, createCalls, goodFm } = makeApp(cacheGoodUntil);
		const parsed: ParsedData = {
			columns: ['id', 'name', 'tactic'],
			rows: [{ id: 'R1', name: 'R one', tactic: 'Recon' }],
			rowCount: 1,
		};
		const first = await run(app, parsed, ONT, 'p23am68b', 'replace', 'new');
		expect(first.errors).toEqual([]);
		const R1 = `${BASE}/Recon/R1.md`;
		const HUB = `${BASE}/Recon/Recon.md`;
		const setId = frontmatterOf(files.get(R1)!)?._crosswalker?.import_set?.id;

		// The user deletes the index note by hand, and the only other note in the
		// folder becomes unreadable.
		files.delete(HUB);
		goodFm.set(R1, frontmatterOf(files.get(R1)!));
		cacheGoodUntil.set(R1, 3);
		files.set(R1, '---\n: : :\ncurie: bogus\n---\nBody.\n');

		modifyCalls.length = 0;
		createCalls.length = 0;
		const second = await run(app, parsed, ONT, 'p23am68b', 'skip', { id: setId });

		expect(second.errors).toEqual([]);
		const rowThree = messages(second).filter((m) => m.includes(NO_INDEX_READ));
		expect(rowThree).toEqual([
			`No index note of this import could be read in the folder "${BASE}/Recon"; a note in it could not be read this run. `
			+ 'The notes in it were kept in place by Skip existing. Wait for Obsidian to finish indexing the vault, then run the '
			+ 'import again. Any list that still names this folder\'s index note is left as it was.',
		]);
		// Refused, not guessed: no index note is created into a folder the run cannot read.
		expect(createCalls).not.toContain(HUB);
		expect(files.has(HUB)).toBe(false);
		expect(modifyCalls).not.toContain(HUB);
		// And orphan reporting stays suppressed.
		expect(second.orphansChecked).toBe(false);
		expect(second.orphans ?? []).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// AM-70 / AM-78
// ---------------------------------------------------------------------------

describe('AM-70/AM-78: unreachable hubs are judged by their recorded chain, not by their path', () => {
	it('a chain-less owned hub is unjudged and named; a chained hub in the same shape is an orphan', async () => {
		const ONT = 'p23am70';
		const { app, files, modifyCalls, createCalls } = makeApp(new Map());
		const parsed1: ParsedData = {
			columns: ['id', 'name', 'tactic'],
			rows: [
				{ id: 'P1', name: 'P one', tactic: 'Persistence' },
				{ id: 'D1', name: 'D one', tactic: 'Discovery' },
			],
			rowCount: 2,
		};
		const first = await run(app, parsed1, ONT, 'p23am70', 'replace', 'new');
		expect(first.errors).toEqual([]);
		const setId = frontmatterOf(files.get(`${BASE}/Persistence/P1.md`)!)?._crosswalker?.import_set?.id;
		const DISCOVERY_HUB = `${BASE}/Discovery/Discovery.md`;
		expect(files.has(DISCOVERY_HUB)).toBe(true);

		// A LEGACY (pre-AM-38) hub, owned by this import set, in a folder no row of
		// the next run reaches: kind: hub, but NO hub_values/hub_levels pair, so its
		// chain is not usable and the run can say nothing about what it was for.
		const LEGACY_HUB = `${BASE}/Archive/Legacy.md`;
		const legacy = [
			'---',
			`curie: "${ONT}:hub/orphan-legacy"`,
			'kind: hub',
			'_crosswalker:',
			'  import_set:',
			`    id: ${setId}`,
			'    scheme: endpoint-v1',
			'    derivation: declared-facts-v1',
			'---',
			'',
			'Legacy.',
			'',
		].join('\n');
		files.set(LEGACY_HUB, legacy);

		// D1 leaves the source entirely: Discovery becomes a folder no note reaches,
		// and its hub DOES carry a usable chain (generation wrote it), so it is the
		// genuine-removal case the orphan report exists for.
		const parsed2: ParsedData = {
			columns: ['id', 'name', 'tactic'],
			rows: [{ id: 'P1', name: 'P one', tactic: 'Persistence' }],
			rowCount: 1,
		};
		modifyCalls.length = 0;
		createCalls.length = 0;
		const second = await run(app, parsed2, ONT, 'p23am70', 'skip', { id: setId });

		expect(second.errors).toEqual([]);
		// Unjudged and NAMED — and explicitly not counted as removed.
		expect(messages(second)).toContain(
			`The index note "${LEGACY_HUB}" sits in a folder no note of this import reaches; `
			+ 'it was left as it was and is not counted as removed from the source.',
		);
		const orphanCuries = (second.orphans ?? []).map((o: { curie: string }) => o.curie);
		expect(orphanCuries).not.toContain(`${ONT}:hub/orphan-legacy`);
		// Still checked: naming one note does not abandon the whole report.
		expect(second.orphansChecked).toBe(true);
		// The chained hub in the same shape IS an orphan.
		expect(orphanCuries).toContain(`${ONT}:hub/discovery`);
		// Neither note is written.
		expect(modifyCalls).not.toContain(LEGACY_HUB);
		expect(createCalls).not.toContain(LEGACY_HUB);
		expect(files.get(LEGACY_HUB)).toBe(legacy);
		expect(modifyCalls).not.toContain(DISCOVERY_HUB);
	});
});

// ---------------------------------------------------------------------------
// AM-71
// ---------------------------------------------------------------------------

describe('AM-71: the home note', () => {
	it('an absent home note on an all-skip refresh is created, and it is the ONLY thing written', async () => {
		const ONT = 'p23am71';
		const { app, files, modifyCalls, createCalls } = makeApp(new Map());
		const parsed: ParsedData = {
			columns: ['id', 'name', 'tactic'],
			rows: [{ id: 'P1', name: 'P one', tactic: 'Persistence' }],
			rowCount: 1,
		};
		const first = await run(app, parsed, ONT, 'p23am71', 'replace', 'new');
		expect(first.errors).toEqual([]);
		const setId = frontmatterOf(files.get(`${BASE}/Persistence/P1.md`)!)?._crosswalker?.import_set?.id;
		const ROOT = `${BASE}/${BASE}.md`;
		const PERSISTENCE_HUB = `${BASE}/Persistence/Persistence.md`;
		const persistenceBefore = files.get(PERSISTENCE_HUB)!;
		files.delete(ROOT);

		modifyCalls.length = 0;
		createCalls.length = 0;
		const second = await run(app, parsed, ONT, 'p23am71', 'skip', { id: setId });

		expect(second.errors).toEqual([]);
		expect(createCalls).toEqual([ROOT]);
		expect(modifyCalls).toEqual([]);
		expect(frontmatterOf(files.get(ROOT)!).curie).toBe(`${ONT}:hub/_root`);
		expect(files.get(PERSISTENCE_HUB)).toBe(persistenceBefore);
	});

	it('CONTROL: an existing home note on an all-skip refresh is written zero times', async () => {
		const ONT = 'p23am71c';
		const { app, files, modifyCalls, createCalls } = makeApp(new Map());
		const parsed: ParsedData = {
			columns: ['id', 'name', 'tactic'],
			rows: [{ id: 'P1', name: 'P one', tactic: 'Persistence' }],
			rowCount: 1,
		};
		const first = await run(app, parsed, ONT, 'p23am71c', 'replace', 'new');
		expect(first.errors).toEqual([]);
		const setId = frontmatterOf(files.get(`${BASE}/Persistence/P1.md`)!)?._crosswalker?.import_set?.id;
		const ROOT = `${BASE}/${BASE}.md`;
		const rootBefore = files.get(ROOT)!;

		modifyCalls.length = 0;
		createCalls.length = 0;
		const second = await run(app, parsed, ONT, 'p23am71c', 'skip', { id: setId });

		expect(second.errors).toEqual([]);
		expect(createCalls).toEqual([]);
		expect(modifyCalls).toEqual([]);
		// Byte-identical, `produced_at` included.
		expect(files.get(ROOT)).toBe(rootBefore);
	});

	/**
	 * Row 3 does not depend on the caller having collected layout values. A bare
	 * harness that collects none at all (the golden-vault shape) must still get the
	 * sentence for a held folder this import has no index note for — otherwise the
	 * silence is a function of who called, not of what is in the vault.
	 *
	 * This is also a direct `enrich()` caller, and it states its write set (AM-65:
	 * without one, every kept row would describe its own folder).
	 */
	it('a held folder with an absent hub and no collected layout values still gets row 3', () => {
		const ONT = 'p23am71d';
		const ROOT_FOLDER = 'Frameworks';
		const FOLDER = `${ROOT_FOLDER}/Persistence`;
		const kept: EnrichNote = { path: `${FOLDER}/T1.md`, curie: `${ONT}:t1`, frontmatter: {}, facets: [] };
		const ownedHubsByFolder: OwnedHubsByFolder = new Map();
		const result = enrich([kept], {
			ontology: ONT,
			config: { children_lists: true, facet_notes: 'none', level_hubs: 'notes' },
			rootFolder: ROOT_FOLDER,
			ownedHubsByFolder,
			writeSet: new Set<string>(),
		});
		const deviation = result.deviations.find((d) => d.includes(`"${FOLDER}"`));
		expect(deviation).toBeDefined();
		expect(deviation).toContain('This import has no index note for the folder');
	});
});
