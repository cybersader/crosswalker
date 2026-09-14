/**
 * vault-path-normalization-am45.test.ts — AM-45 (2026-09-02, pass 15, Task C
 * item 5): values are recorded in the form the path takes.
 *
 * THE DEFECT THIS PINS (pass-14 SUSPECTED 6). A layout value was recorded
 * BEFORE `generation-engine.ts` ran the assembled path through Obsidian's
 * `normalizePath`, which performs four mutations: (1) collapse every `\` and
 * every run of separators to a single `/`; (2) strip leading/trailing
 * separators; (3) fold `U+00A0`/`U+202F` (non-breaking spaces) to an ordinary
 * space; (4) Unicode-normalize the whole string to NFC. Mutations 1-2 change
 * the segment COUNT and were caught by AM-44's elementwise check. Mutation 4
 * does NOT change the count: a source cell carrying a DECOMPOSED character
 * ("a" + U+0308 COMBINING DIAERESIS, ordinary in exports from macOS and
 * several CSV toolchains) produced a value whose BYTES differ from the
 * segment while the counts agree perfectly — invisible to the check, and
 * enough to silently re-identify every level hub in an existing vault.
 *
 * THE RULE. Every recorded value passes through the SAME normalization the
 * rendered path receives before it is compared or stored. The corrected test
 * mock (`tests/__mocks__/obsidian.ts`) reproduces all four mutations, kept
 * byte-for-byte in step with the pure copy (`src/render/vault-path.ts`) the
 * runtime-agnostic render layer uses.
 *
 * UNICODE HYGIENE: every decomposed/composed/NBSP string below is built from
 * explicit `\u` escapes rather than typed literals, so this file's own bytes
 * cannot silently drift between the two normal forms under an editor or tool
 * that quietly re-normalizes text it touches.
 */

import { normalizeVaultPath, normalizedPathPieces } from '../src/render/vault-path';
import { normalizePath as mockNormalizePath } from '../tests/__mocks__/obsidian';
import { render, type Recipe } from '../src/render';
import { generateFromRecipe } from '../src/generation/generation-engine';
import { TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import type { ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

// Built from \u escapes, deliberately -- see the module doc comment. No
// literal non-ASCII character appears anywhere else in this file.
const COMPOSED_AE = '\u00E4'; // "a WITH DIAERESIS", ONE code point
const DECOMPOSED_AE = 'a\u0308'; // "a" + COMBINING DIAERESIS, TWO code points
const COMPOSED = `Zug${COMPOSED_AE}nge`;
const DECOMPOSED = `Zug${DECOMPOSED_AE}nge`;
const NBSP = '\u00A0';
const NNBSP = '\u202F';

// ---------------------------------------------------------------------------
// The mock reproduces all four of the host's mutations.
// ---------------------------------------------------------------------------

describe('AM-45: the mock reproduces all four of normalizePath\'s mutations', () => {
	it('1. every backslash and every run of separators collapses to one /', () => {
		expect(mockNormalizePath('A\\\\B//C')).toBe('A/B/C');
		expect(mockNormalizePath('A\\B')).toBe('A/B');
	});

	it('2. leading and trailing separators are stripped', () => {
		expect(mockNormalizePath('/A/B/')).toBe('A/B');
		expect(mockNormalizePath('///A///')).toBe('A');
	});

	it('3. U+00A0 and U+202F fold to an ordinary space', () => {
		expect(mockNormalizePath(`A${NBSP}B`)).toBe('A B');
		expect(mockNormalizePath(`A${NNBSP}B`)).toBe('A B');
	});

	it('4. the whole string is Unicode-normalized to NFC', () => {
		expect(DECOMPOSED).not.toBe(COMPOSED); // the raw bytes really do differ
		expect(DECOMPOSED.length).not.toBe(COMPOSED.length); // two code points vs one
		expect(mockNormalizePath(DECOMPOSED)).toBe(COMPOSED);
	});

	it('a mutation that changes nothing is a no-op, not a rewrite', () => {
		expect(mockNormalizePath('Frameworks/NIST-mini')).toBe('Frameworks/NIST-mini');
	});
});

// ---------------------------------------------------------------------------
// The pure copy (src/render/vault-path.ts) agrees with the mock byte-for-byte
// across a battery of inputs — this IS the guarantee AM-44's elementwise check
// exists to enforce if it is ever violated.
// ---------------------------------------------------------------------------

describe('AM-45: the pure copy matches the host mock on every input this project can produce', () => {
	const inputs = [
		'Ordinary',
		'IT/OT',
		'IT\\OT',
		'/Identify',
		'Identify/',
		'A//B',
		`A${NBSP}B`,
		`A${NNBSP}B`,
		COMPOSED,
		DECOMPOSED,
		'',
		'   ',
		'A/B/C/D',
	];
	for (const input of inputs) {
		it(`agrees on ${JSON.stringify(input)}`, () => {
			expect(normalizeVaultPath(input)).toBe(mockNormalizePath(input));
		});
	}
});

describe('AM-45: normalizedPathPieces drops pieces that collapse to nothing, on both sides identically', () => {
	it('a leading separator produces no empty leading piece', () => {
		expect(normalizedPathPieces('/Identify')).toEqual(['Identify']);
	});

	it('a doubled separator collapses to one directory, not two with an empty middle', () => {
		expect(normalizedPathPieces('IT//OT')).toEqual(['IT', 'OT']);
	});

	it('an all-separator or empty segment yields no pieces at all', () => {
		expect(normalizedPathPieces('')).toEqual([]);
		expect(normalizedPathPieces('///')).toEqual([]);
	});

	it('NFD input yields the SAME piece as the NFC-typed equivalent', () => {
		expect(normalizedPathPieces(DECOMPOSED)).toEqual(normalizedPathPieces(COMPOSED));
		expect(normalizedPathPieces(DECOMPOSED)).toEqual([COMPOSED]);
	});
});

// ---------------------------------------------------------------------------
// render() itself: a decomposed source cell records the COMPOSED value.
// ---------------------------------------------------------------------------

describe('AM-45 at render: a decomposed source cell records the value in NFC', () => {
	// NOTE ON WHAT render() DOES NOT DO: render() itself never calls
	// `normalizePath` — it is deliberately pure and runtime-agnostic (commitment
	// 5), so `address.primary.path`'s own segment stays whatever raw bytes the
	// template interpolated. It is generation-engine.ts that runs the ASSEMBLED
	// path through `normalizePath` before it reaches the vault (`basePath + '/'
	// + render's output`), which is why the byte-identity claim compares a
	// recorded VALUE against the note's actual FILE PATH (post-normalizePath),
	// never against render()'s raw internal address. That end-to-end claim is
	// asserted through `generateFromRecipe` below.
	it('the recorded value is the COMPOSED form, though the raw rendered segment is not', () => {
		const recipe: Recipe = {
			recipe: 'nfd-test',
			source: { ontology: 'o', levels: ['group', 'leaf'] },
			target: {
				layout: [
					{ level: 'group', mechanism: 'folder', template: '{group}' },
					{ level: 'leaf', mechanism: 'file', template: '{id}.md' },
				],
			},
		};
		const values: import('../src/render').LayoutValue[] = [];
		const address = render(recipe, { curie: 'x:1', scope: { group: DECOMPOSED, id: 'A' } }, undefined, values);
		const rawDir = address.primary.path.slice(0, address.primary.path.lastIndexOf('/'));

		// render()'s own (pure, un-normalized) path segment still carries the raw
		// decomposed bytes — nothing in render() itself touches Unicode form.
		expect(rawDir).toBe(DECOMPOSED);
		// But the value AM-45 records is already normalized to NFC — the form the
		// vault path will actually take once generation-engine.ts normalizes it.
		expect(values.map((v) => v.value)).toEqual([COMPOSED]);
		expect(values[0].value).not.toBe(rawDir);
	});
});

// ---------------------------------------------------------------------------
// AM-38's byte-identity proof, at the point SUSPECTED 6 named: an NFD vs NFC
// source cell must derive ONE hub curie, not two.
// ---------------------------------------------------------------------------

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

describe('AM-45 end-to-end: a decomposed cell mints the SAME hub curie the composed form would', () => {
	const ONT = 'hg';
	const BASE = 'Frameworks';
	const HUB_CONFIG = { children_lists: true, facet_notes: 'none' as const, level_hubs: 'notes' as const };
	// The product's own hub-curie `slug()` (enrich.ts) is a plain ASCII fold —
	// lowercase, then any run of non-[a-z0-9] collapses to one "-". A single
	// precomposed "ä" is one non-ASCII character, so it becomes one "-".
	const EXPECTED_CURIE = `${ONT}:hub/zug-nge`;

	async function importOne(catalogValue: string) {
		const { app, files } = makeApp();
		const recipe: Recipe = {
			recipe: 'nfd-shipped-shape',
			source: { ontology: ONT, levels: ['catalog', 'control'] },
			target: {
				layout: [
					{ level: 'catalog', mechanism: 'folder', template: '{catalog}' },
					{ level: 'control', mechanism: 'file', template: '{id}.md' },
				],
				enrichment: HUB_CONFIG,
			},
		};
		const rows = [{ id: 'AC-2', catalog: catalogValue }];
		const result = await generateFromRecipe(app, parsedData(rows), recipe, {
			basePath: BASE,
			overwriteMode: 'replace',
			createFolders: true,
			sourceFileName: 'source.csv',
			importSet: 'new',
		});
		return { result, files };
	}

	it('the decomposed cell mints the composed identity', async () => {
		const { result, files } = await importOne(DECOMPOSED);
		expect(result.errors).toEqual([]);
		const hubs = hubsInVault(files);
		const catalogHub = hubs.find((h) => h.path === `${BASE}/${COMPOSED}/${COMPOSED}.md`);
		expect(catalogHub).toBeDefined();
		expect(catalogHub!.curie).toBe(EXPECTED_CURIE);
		// Exactly one hub for the catalog level — the decomposed form never leaks
		// through as a second identity beside it.
		const catalogHubs = hubs.filter((h) => h.path.startsWith(`${BASE}/`) && h.path !== `${BASE}/${BASE}.md`);
		expect(catalogHubs).toHaveLength(1);
	});

	it('a composed-cell import derives the SAME curie — one hub either way', async () => {
		const decomposedRun = await importOne(DECOMPOSED);
		const composedRun = await importOne(COMPOSED);
		const decomposedCuries = hubsInVault(decomposedRun.files).map((h) => h.curie).sort();
		const composedCuries = hubsInVault(composedRun.files).map((h) => h.curie).sort();
		expect(decomposedCuries).toEqual(composedCuries);
		expect(decomposedCuries).toContain(EXPECTED_CURIE);
	});
});
