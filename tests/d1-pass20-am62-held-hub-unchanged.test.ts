/**
 * d1-pass20-am62-held-hub-unchanged.test.ts -- AM-62 (2026-09-04, pass 20,
 * Task C item 2), end to end through the real engine: a mixed run (some rows
 * written, some held) does not restamp a held level hub whose content has not
 * actually changed, and it DOES rewrite one whose content has -- keeping the
 * recorded curie and moving `produced_at` only on the write that happens.
 *
 * THE DEFECT THIS PINS. Before AM-62, every level hub the enrichment pass
 * wrote through the ordinary merge path took a fresh `produced_at` and a
 * fresh `_crosswalker` block regardless of whether anything about the note
 * actually differed -- so a refresh that changed ONE row somewhere else moved
 * the modification time of every OTHER index note in the vault, none of which
 * this run had anything new to say about.
 *
 * THE SCENARIO, and why every folder below is RECATEGORIZED, not merely
 * untouched. `keptFolders` (the set AM-62's `heldByRecord` reads) is walked
 * only from a row whose RENDERED folder this run differs from where it
 * currently sits (AM-54's chain walk, `enrich.ts` ~949-961) -- an ordinary
 * row that did not move at all never enters it, and its folder instead falls
 * through to AM-50's plain "no row describes this folder" refusal, a
 * different code path this file does not pin. So every row below changes its
 * `tactic` value between runs (a genuine recategorization skip mode leaves in
 * place), which is what makes its OLD folder "held" at all:
 *
 *   - Persistence: P1 recategorized to IA, kept in place by Skip existing.
 *     Physically nothing else changes in Persistence, so the fresh candidate
 *     for its hub is byte-identical to what run 1 already wrote -- the
 *     CONTROL for "nothing new to say".
 *   - Recon: R1 recategorized to IA too (still physically sitting in Recon);
 *     R2 is dropped from the source entirely between runs (simulating a row
 *     deleted upstream) rather than recategorized, so it contributes NOTHING
 *     to this run's batch at all and Recon's held children genuinely shrink
 *     from [R1, R2] to [R1] -- content really did change.
 *   - Discovery: a brand-new row, D1, which is what opens AM-61's gate for a
 *     mixed run at all (`enrichRecords.length > 0`); written through the
 *     ORDINARY described-folder path, not AM-62's, and included only as the
 *     gate opener the other two assertions depend on.
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
	return { app: app as any, files, modifyCalls };
}

const BASE = 'Ontologies';
const ONT = 'am62';

function recipe(): Recipe {
	return {
		recipe: 'am62-held-hub',
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

function parsedRun1(): ParsedData {
	const rows = [
		{ id: 'P1', name: 'Persistence one', tactic: 'Persistence' },
		{ id: 'R1', name: 'Recon one', tactic: 'Recon' },
		{ id: 'R2', name: 'Recon two', tactic: 'Recon' },
	];
	return { columns: ['id', 'name', 'tactic'], rows, rowCount: rows.length };
}

/**
 * P1 and R1 recategorized to IA (found by curie at their OLD address, kept
 * there by Skip existing -- AM-54's exact shape); R2 dropped from the source
 * entirely; D1 is brand new, opening the mixed-run gate.
 */
function parsedRun2(): ParsedData {
	const rows = [
		{ id: 'P1', name: 'Persistence one', tactic: 'IA' },
		{ id: 'R1', name: 'Recon one', tactic: 'IA' },
		{ id: 'D1', name: 'Discovery one', tactic: 'Discovery' },
	];
	return { columns: ['id', 'name', 'tactic'], rows, rowCount: rows.length };
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
	});
}

describe('AM-62: a mixed run does not restamp a held hub with nothing new to say, and rewrites one whose children genuinely changed', () => {
	async function seedThenRefresh() {
		const { app, files, modifyCalls } = makeApp();
		const first = await run(app, parsedRun1(), 'replace', 'new');
		expect(first.errors).toEqual([]);

		const persistencePath = `${BASE}/Persistence/Persistence.md`;
		const reconPath = `${BASE}/Recon/Recon.md`;
		expect(files.has(persistencePath)).toBe(true);
		expect(files.has(reconPath)).toBe(true);

		const setId = frontmatterOf(files.get(`${BASE}/Persistence/P1.md`)!)?._crosswalker?.import_set?.id;
		expect(typeof setId).toBe('string');

		const persistenceBefore = files.get(persistencePath)!;
		const reconFmBefore = frontmatterOf(files.get(reconPath)!);
		const reconCurieBefore = reconFmBefore.curie;
		const reconProducedAtBefore = reconFmBefore._crosswalker?.produced_at;
		expect(typeof reconCurieBefore).toBe('string');
		expect(typeof reconProducedAtBefore).toBe('string');
		// The premise this whole test rests on: Recon really does start with two
		// children. If this were wrong the "children changed" half below would
		// prove nothing.
		expect(files.get(reconPath)).toContain('R1');
		expect(files.get(reconPath)).toContain('R2');

		modifyCalls.length = 0; // only the SECOND run's writes matter below.
		const second = await run(app, parsedRun2(), 'skip', { id: setId });
		expect(second.errors).toEqual([]);

		return {
			app, files, modifyCalls, second,
			persistencePath, persistenceBefore,
			reconPath, reconCurieBefore, reconProducedAtBefore,
		};
	}

	it("does not touch Persistence's hub at all -- byte-identical, never even passed to vault.modify", async () => {
		const { files, modifyCalls, persistencePath, persistenceBefore } = await seedThenRefresh();
		expect(modifyCalls).not.toContain(persistencePath);
		expect(files.get(persistencePath)).toBe(persistenceBefore);
	});

	it("rewrites Recon's hub -- its children genuinely shrank (R2 left the source) -- but keeps the RECORDED curie and moves produced_at", async () => {
		const {
			files, modifyCalls, reconPath, reconCurieBefore, reconProducedAtBefore,
		} = await seedThenRefresh();
		expect(modifyCalls).toContain(reconPath);
		const after = frontmatterOf(files.get(reconPath)!);
		// Identity preserved, not re-minted -- same value the note already carried.
		expect(after.curie).toBe(reconCurieBefore);
		// Content genuinely changed: R2 no longer listed.
		expect(files.get(reconPath)).toContain('R1');
		expect(files.get(reconPath)).not.toContain('R2');
		// produced_at moved because this hub really was written.
		expect(after._crosswalker?.produced_at).not.toBe(reconProducedAtBefore);
	});

	it('the run that opened the gate (a brand-new Discovery row) still succeeds and creates its own hub normally', async () => {
		const { files } = await seedThenRefresh();
		expect(files.has(`${BASE}/Discovery/Discovery.md`)).toBe(true);
	});
});
