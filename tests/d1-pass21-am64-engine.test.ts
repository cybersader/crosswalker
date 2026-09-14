/**
 * d1-pass21-am64-engine.test.ts -- AM-64 (2026-09-04, pass 21, Task C items
 * 1-4), end to end through the real engine: accounting is a read over the
 * whole population and always runs; writing is decided writer by writer
 * against the write set, for BOTH level hubs and facet hubs in the same
 * vault.
 *
 * THE DEFECT THIS PINS. AM-61 put the gate back at
 * `enrichRecords.length > 0` to stop an all-skip refresh restamping every
 * index note, and in the same expression it stopped the one derivation that
 * accounts for the hubs the kept rows imply -- so an all-skip refresh
 * reported three notes sitting in the vault as no longer in the source, with
 * `orphansChecked: true`. AM-64 separates the two questions: there is no
 * gate at all on accounting (it runs whenever the run has a population), and
 * each writer -- row bodies, a described folder's level hub, a held-only
 * level hub (existing / absent), a facet hub (existing / absent) -- decides
 * for itself whether it has anything new to say, against the write set.
 *
 * THE FIXTURE. One recipe with BOTH `level_hubs: 'notes'` and
 * `facet_notes: 'notes'`, so every item below exercises the two hub writers
 * together rather than one at a time:
 *
 *   - Persistence (P1, P2, domain EU) -- never recategorised, never
 *     touched between runs. The control: an ordinary folder and facet group
 *     that genuinely has nothing new to say.
 *   - Recon (R1, R2, R3, domain US) -- R3 is dropped from the SOURCE
 *     entirely between runs (a row deleted upstream, not recategorised), so
 *     both Recon's level hub AND the US facet hub genuinely lose a member
 *     and must be rewritten -- while R1 and R2 themselves are held in place
 *     by Skip existing.
 *   - Discovery (D1, domain APAC, alone) -- brand new in the second run,
 *     which is what opens AM-64's population gate for a mixed run at all.
 *     APAC has only one member, so no facet hub is expected for it; it
 *     exists purely to open the gate through an ordinary described folder.
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
	return { app: app as any, files, modifyCalls, createCalls };
}

const BASE = 'Frameworks';
const ONT = 'am64';

function recipe(): Recipe {
	return {
		recipe: 'am64-writer-table',
		source: { ontology: ONT, levels: ['tactic', 'leaf'] },
		target: {
			layout: [
				{ level: 'tactic', mechanism: 'folder', template: '{tactic}' },
				{ level: 'leaf', mechanism: 'file', template: '{id}.md' },
			],
			enrichment: { children_lists: true, facet_notes: 'notes', parent_note: 'sibling', level_hubs: 'notes' },
		},
	};
}

function frontmatterOf(text: string): any {
	const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	return match ? (yaml.load(match[1]) as any) : {};
}

function run(app: any, parsed: ParsedData, overwriteMode: 'skip' | 'replace', importSet: any) {
	return generateFromRecipe(app, parsed, recipe(), {
		basePath: BASE,
		overwriteMode,
		createFolders: true,
		sourceFileName: 'source.csv',
		importSet,
		curieLocalPart: (row: Record<string, unknown>) => String(row.id),
		facetsForRow: (row: Record<string, unknown>) => [{ namespace: 'domain', value: String(row.domain) }],
	});
}

/** Persistence + Recon, five rows, two facet groups (EU, US) each with 2+ members. */
function rowsRun1(): ParsedData {
	const rows = [
		{ id: 'P1', name: 'P one', tactic: 'Persistence', domain: 'EU' },
		{ id: 'P2', name: 'P two', tactic: 'Persistence', domain: 'EU' },
		{ id: 'R1', name: 'R one', tactic: 'Recon', domain: 'US' },
		{ id: 'R2', name: 'R two', tactic: 'Recon', domain: 'US' },
		{ id: 'R3', name: 'R three', tactic: 'Recon', domain: 'US' },
	];
	return { columns: ['id', 'name', 'tactic', 'domain'], rows, rowCount: rows.length };
}

const ROOT_PATH = `${BASE}/${BASE}.md`;
const PERSISTENCE_PATH = `${BASE}/Persistence/Persistence.md`;
const RECON_PATH = `${BASE}/Recon/Recon.md`;
const EU_PATH = `${BASE}/EU.md`;
const US_PATH = `${BASE}/US.md`;
const HUB_PATHS = [ROOT_PATH, PERSISTENCE_PATH, RECON_PATH, EU_PATH, US_PATH];

async function seed() {
	const { app, files, modifyCalls, createCalls } = makeApp();
	const first = await run(app, rowsRun1(), 'replace', 'new');
	expect(first.errors).toEqual([]);
	for (const p of HUB_PATHS) expect(files.has(p)).toBe(true);
	const setId = frontmatterOf(files.get(`${BASE}/Persistence/P1.md`)!)?._crosswalker?.import_set?.id;
	expect(typeof setId).toBe('string');
	const before = new Map(HUB_PATHS.map((p) => [p, files.get(p)!]));
	modifyCalls.length = 0;
	createCalls.length = 0;
	return { app, files, modifyCalls, createCalls, setId, before };
}

// ---------------------------------------------------------------------------
// Item 1 -- all-skip refresh: zero vault.modify/vault.create, zero produced_at
// change on every hub (level AND facet), zero orphans, orphansChecked true.
// ---------------------------------------------------------------------------

describe('AM-64 item 1: an all-skip refresh with nothing recategorised touches nothing at all', () => {
	it('zero writes, zero produced_at change, zero orphans, on a vault with both level hubs and a facet hub', async () => {
		const { app, files, modifyCalls, createCalls, setId, before } = await seed();

		const second = await run(app, rowsRun1(), 'skip', { id: setId });

		expect(second.errors).toEqual([]);
		expect(modifyCalls).toEqual([]);
		expect(createCalls).toEqual([]);
		for (const p of HUB_PATHS) {
			expect(files.get(p)).toBe(before.get(p)); // byte-identical, including produced_at
		}
		expect(second.orphansChecked).toBe(true);
		expect(second.orphans ?? []).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Item 2 -- mixed run: described folder written; unchanged held level hub
// untouched; changed held level hub rewritten under its recorded curie;
// unchanged facet hub untouched; changed facet hub rewritten with
// produced_at moved.
// ---------------------------------------------------------------------------

describe('AM-64 item 2: a mixed run writes only what has something new to say', () => {
	it('Discovery (described) is written; Persistence + EU (unchanged, held) are not; Recon + US (changed, held) are rewritten with recorded identity kept', async () => {
		const { app, files, modifyCalls, setId, before } = await seed();

		const rowsRun2 = [
			{ id: 'P1', name: 'P one', tactic: 'Persistence', domain: 'EU' },
			{ id: 'P2', name: 'P two', tactic: 'Persistence', domain: 'EU' },
			{ id: 'R1', name: 'R one', tactic: 'Recon', domain: 'US' },
			{ id: 'R2', name: 'R two', tactic: 'Recon', domain: 'US' },
			// R3 dropped entirely -- Recon and US both genuinely shrink.
			{ id: 'D1', name: 'D one', tactic: 'Discovery', domain: 'APAC' },
		];
		const parsed: ParsedData = { columns: ['id', 'name', 'tactic', 'domain'], rows: rowsRun2, rowCount: rowsRun2.length };

		const second = await run(app, parsed, 'skip', { id: setId });
		expect(second.errors).toEqual([]);

		// The described folder: written normally, like any ordinary import.
		expect(files.has(`${BASE}/Discovery/Discovery.md`)).toBe(true);
		expect(files.has(`${BASE}/Discovery/D1.md`)).toBe(true);

		// Persistence: held, genuinely unchanged -- never even passed to vault.modify.
		expect(modifyCalls).not.toContain(PERSISTENCE_PATH);
		expect(files.get(PERSISTENCE_PATH)).toBe(before.get(PERSISTENCE_PATH));

		// Recon: held, but its children genuinely shrank (R3 left the source) --
		// rewritten, recorded curie preserved, produced_at moved.
		expect(modifyCalls).toContain(RECON_PATH);
		const reconBeforeFm = frontmatterOf(before.get(RECON_PATH)!);
		const reconAfter = files.get(RECON_PATH)!;
		const reconAfterFm = frontmatterOf(reconAfter);
		expect(reconAfterFm.curie).toBe(reconBeforeFm.curie);
		expect(reconAfter).toContain('[[R1]]');
		expect(reconAfter).not.toContain('[[R3]]');
		expect(reconAfterFm._crosswalker?.produced_at).not.toBe(reconBeforeFm._crosswalker?.produced_at);

		// EU facet hub: held, genuinely unchanged (P1, P2 both still there,
		// nothing else changed) -- never touched.
		expect(modifyCalls).not.toContain(EU_PATH);
		expect(files.get(EU_PATH)).toBe(before.get(EU_PATH));

		// US facet hub: held, but its membership genuinely shrank (R3's row
		// left the population) -- rewritten, produced_at moved.
		expect(modifyCalls).toContain(US_PATH);
		const usBeforeFm = frontmatterOf(before.get(US_PATH)!);
		const usAfter = files.get(US_PATH)!;
		const usAfterFm = frontmatterOf(usAfter);
		expect(usAfter).toContain('[[R1]]');
		expect(usAfter).toContain('[[R2]]');
		expect(usAfter).not.toContain('[[R3]]');
		expect(usAfterFm._crosswalker?.produced_at).not.toBe(usBeforeFm._crosswalker?.produced_at);
	});
});

// ---------------------------------------------------------------------------
// Item 3 -- deleted hub: an all-skip refresh after the user deleted a level
// hub does not recreate it, the row-3 refusal names the folder, and it is
// not reported as an orphan. Same for a facet hub whose every member is
// held.
// ---------------------------------------------------------------------------

describe('AM-64 item 3: a hub the user deleted is not recreated on a refresh that writes nothing into its folder', () => {
	it('a deleted LEVEL hub: not recreated, row-3 refusal names the folder, not reported as an orphan', async () => {
		const { app, files, createCalls, setId } = await seed();
		files.delete(PERSISTENCE_PATH); // the user deleted it by hand.

		const second = await run(app, rowsRun1(), 'skip', { id: setId });

		expect(second.errors).toEqual([]);
		expect(files.has(PERSISTENCE_PATH)).toBe(false); // never recreated.
		expect(createCalls).not.toContain(PERSISTENCE_PATH);
		const warned = (second.warnings ?? []).map((w) => w.message).join('\n');
		expect(warned).toContain(`This import has no index note for the folder "${BASE}/Persistence"`);
		expect(warned).toContain('none was created');
		expect(second.orphansChecked).toBe(true);
		expect(second.orphans ?? []).toEqual([]);
	});

	it('a deleted FACET hub whose every member is held: not recreated, not reported as an orphan', async () => {
		const { app, files, createCalls, setId } = await seed();
		files.delete(EU_PATH); // the user deleted the facet hub by hand.

		// All-skip: nothing recategorised, EU's own members (P1, P2) are both
		// held, so neither is in the write set and the hub is never re-created.
		const second = await run(app, rowsRun1(), 'skip', { id: setId });

		expect(second.errors).toEqual([]);
		expect(files.has(EU_PATH)).toBe(false); // never recreated.
		expect(createCalls).not.toContain(EU_PATH);
		expect(second.orphansChecked).toBe(true);
		expect(second.orphans ?? []).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Item 4 -- empty population: applyEnrichment is not called; nothing is
// derived, not even the root catalog hub a non-empty basePath would
// otherwise justify.
// ---------------------------------------------------------------------------

describe('AM-64 item 4: an empty population derives nothing at all', () => {
	it('zero rows in the source: no root hub, no created files, edgeCount 0', async () => {
		const { app, files } = makeApp();
		const empty: ParsedData = { columns: ['id', 'name', 'tactic', 'domain'], rows: [], rowCount: 0 };

		const result = await run(app, empty, 'replace', 'new');

		expect(result.errors).toEqual([]);
		expect(result.created).toEqual([]);
		// `edgeCount` is set ONLY inside applyEnrichment (generation-engine.ts
		// `result.edgeCount = enrichment.edgeCount`); every other path leaves it
		// undefined. `undefined` here is therefore stronger evidence that the
		// pass never ran than `0` would be -- `0` is also what a call that ran
		// and found nothing would leave behind.
		expect(result.edgeCount).toBeUndefined();
		// If applyEnrichment ran at all with an empty population it would still
		// reach the import-root branch (exempt on its own terms, described "by
		// the set, not by a row") and synthesize a catalog hub out of a run that
		// imported nothing. It must not.
		expect(files.size).toBe(0);
	});
});
