/**
 * d1-pass23-c4-corrupt-region.test.ts — C4 (2026-09-04 correction contract):
 * MALFORMED IS NOT ABSENT.
 *
 * `maintainHeldHostRegions` reads a kept host's body with `scanRegions`. When
 * that scan FAILS, the note's managed region is not missing — it is unreadable,
 * and the scanner has already reached a named verdict about why. Two things must
 * not happen:
 *
 *   1. The AM-76 sentence ("carries no managed Contents region") must not be
 *      spoken. It is false, and it reads as a finding about the note's shape
 *      rather than about the writer's inability to read it.
 *   2. The `children:` key must not be silently rebuilt. A note whose body this
 *      writer cannot locate is a note whose properties it has no business
 *      touching either; updating one half of a pair while refusing the other is
 *      how a note ends up internally inconsistent with nobody told.
 *
 * The verdict travels on the existing per-note conflict channel
 * (`result.conflicts`), the way the sibling hub writer reports the same class of
 * unreadability, carrying the scanner's OWN `code` and `detail`.
 *
 * Two corruption shapes, each in both host shapes (with and without a `children:`
 * key), because the key is what decides whether the frontmatter branch would have
 * written anything:
 *
 *   - a DUPLICATED end marker, which is the shape the correction contract names;
 *   - a MALFORMED marker line, which reaches the same arm by a different route.
 *
 * These are witnesses for the repair, not new semantics: nothing here rules what
 * the codes should be. Each test pins the code the parser actually produces and
 * asserts that the host's bytes did not move.
 */

import { TFile, TFolder } from 'obsidian';
import { generateFromRecipe } from '../src/generation/generation-engine';
import { describeConflict } from '../src/generation/managed-body';
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
			create: async (path: string, content: string) => { createCalls.push(path); files.set(path, content); return new TFile(path); },
			modify: async (file: { path: string }, content: string) => { modifyCalls.push(file.path); files.set(file.path, content); },
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
			rename,
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const text = files.get(file.path);
				if (text === undefined) return null;
				const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
				if (!match) return { frontmatter: undefined };
				try { return { frontmatter: (yaml.load(match[1].replace(/\r\n/g, '\n')) ?? {}) as Record<string, unknown> }; }
				catch { return { frontmatter: undefined }; }
			},
		},
		fileManager: { renameFile: rename },
	};
	return { app: app as any, files, modifyCalls, createCalls };
}

const BASE = 'Frameworks';
const ONT = 'p23c4';
const HOST = `${BASE}/T1078.md`;
const HOSTED_FOLDER = `${BASE}/T1078`;
const CHILD1 = `${BASE}/T1078/T1078.001.md`;

const RECIPE: Recipe = {
	recipe: 'p23c4-hosted-parent',
	source: { ontology: ONT, levels: ['group', 'leaf'] },
	target: {
		layout: [
			{ level: 'group', mechanism: 'folder', template: '{parent_folder}' },
			{ level: 'leaf', mechanism: 'file', template: '{id}.md' },
		],
		also_emit: { frontmatter: { managed_links: { parent: { template: '{parent_id}' } } } },
		enrichment: { children_lists: true, facet_notes: 'none', parent_note: 'sibling', level_hubs: 'notes' },
	},
};

const OPTS = {
	basePath: BASE,
	createFolders: true,
	strictValidation: false,
	curieLocalPart: (row: Record<string, unknown>) => String(row.id),
};

const ROWS1 = [
	{ id: 'T1078', parent_folder: '', parent_id: '' },
	{ id: 'T1078.001', parent_folder: 'T1078', parent_id: 'T1078' },
];
const ROWS2 = [...ROWS1, { id: 'T1078.002', parent_folder: 'T1078', parent_id: 'T1078' }];

function parsedOf(rows: Record<string, unknown>[]): ParsedData {
	return { columns: ['id', 'parent_folder', 'parent_id'], rows, rowCount: rows.length };
}

function frontmatterOf(text: string): any {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	return match ? (yaml.load(match[1].replace(/\r\n/g, '\n')) as any) : {};
}

function provenanceBlock(text: string): string[] {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const start = lines.indexOf('_crosswalker:');
	const out = [lines[start]];
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i] === '---') break;
		out.push(lines[i]);
	}
	return out;
}

type Corruption = 'duplicate-end' | 'malformed';

/**
 * A kept host written by hand. The `_crosswalker` block is lifted verbatim from a
 * generated note so ownership reads exactly as it would in a real vault; every
 * other byte is the user's.
 */
function corruptHost(provenance: string[], childrenKey: boolean, corruption: Corruption): string {
	const lines = ['---', 'created: 2024-01-05', "title: Don't Panic", `curie: "${ONT}:T1078"`];
	if (childrenKey) {
		lines.push('children:', '  - "[[T1078.001]]"');
	}
	lines.push(...provenance, '---', '', 'User prose above.', '');
	lines.push('<!-- crosswalker:children:start v=1 -->', '## Contents', '- [[T1078.001]]');
	if (corruption === 'duplicate-end') {
		// The shape the correction contract names: the region closes, and then closes
		// again. A hand-merge or a duplicated paste produces exactly this.
		lines.push('<!-- crosswalker:children:end -->', '<!-- crosswalker:children:end -->');
	} else {
		// A marker-shaped line that is not a marker under the grammar. It reaches the
		// same arm by a different route, so the repair is not pinned to one code.
		lines.push('<!-- crosswalker:children:stop -->', '<!-- crosswalker:children:end -->');
	}
	lines.push('', 'User prose below.', '');
	return lines.join('\n');
}

async function seed(childrenKey: boolean, corruption: Corruption) {
	const { app, files, modifyCalls, createCalls } = makeApp();
	const first = await generateFromRecipe(app, parsedOf(ROWS1), RECIPE, {
		...OPTS, overwriteMode: 'replace', sourceFileName: 'source.csv', importSet: 'new',
	});
	expect(first.errors).toEqual([]);
	const setId = frontmatterOf(files.get(CHILD1)!)?._crosswalker?.import_set?.id;
	const host = corruptHost(provenanceBlock(files.get(HOST)!), childrenKey, corruption);
	files.set(HOST, host);
	modifyCalls.length = 0;
	createCalls.length = 0;
	return { app, files, modifyCalls, createCalls, setId, host };
}

function refresh(app: any, rows: Record<string, unknown>[], setId: string) {
	return generateFromRecipe(app, parsedOf(rows), RECIPE, {
		...OPTS, overwriteMode: 'skip', sourceFileName: 'source.csv', importSet: { id: setId },
	});
}

interface Conflict { path: string; curie?: string; code: string; detail: string }

const hostConflicts = (r: { conflicts?: Conflict[] }): Conflict[] =>
	(r.conflicts ?? []).filter((c) => c.path === HOST);

const missingRegionVoices = (r: { warnings?: { message: string }[] }): string[] =>
	(r.warnings ?? []).map((w) => w.message).filter((m) => m.includes('no managed Contents region'));

/** Every corruption verdict the scanner can reach. Nothing else is acceptable here. */
const CORRUPTION_CODES = [
	'unclosed-region',
	'orphan-end-marker',
	'inverted-region',
	'duplicate-region',
	'duplicate-end-marker',
	'interleaved-regions',
	'nested-region',
	'malformed-marker',
	'future-region-version',
];

/**
 * The four assertions that make this a repair witness rather than a smoke test,
 * shared so the two corruption shapes cannot drift apart.
 */
function expectRefusedNotMisreported(
	second: { errors: { message: string }[]; conflicts?: Conflict[]; warnings?: { message: string }[] },
	files: Map<string, string>,
	modifyCalls: string[],
	host: string,
	expectedCode: string,
): void {
	// 1. The parser's OWN verdict reached the user, once, on the conflict channel.
	const conflicts = hostConflicts(second);
	expect(conflicts).toHaveLength(1);
	expect(conflicts[0].code).toBe(expectedCode);
	expect(CORRUPTION_CODES).toContain(conflicts[0].code);
	// A code with no sentence behind it is a silent failure wearing a different
	// hat; the detail must be a real sentence and must reach plain language.
	expect(conflicts[0].detail.length).toBeGreaterThan(20);
	expect(describeConflict(conflicts[0].code, conflicts[0].detail))
		.toContain("Crosswalker could not read this note's body markers.");

	// 2. The AM-76 missing-region claim was NOT made about this note.
	expect(missingRegionVoices(second)).toEqual([]);
	expect(JSON.stringify(second.warnings ?? [])).not.toContain(HOSTED_FOLDER + '" but carries no managed');

	// 3. Zero writes.
	expect(modifyCalls).not.toContain(HOST);

	// 4. Exact bytes unchanged — the whole file, not a field of it.
	expect(files.get(HOST)).toBe(host);
}

describe('C4: a corrupt managed region on a kept host is reported, not treated as absent', () => {
	it('duplicated end marker, NO children key: the parser verdict is reported and nothing moves', async () => {
		const { app, files, modifyCalls, setId, host } = await seed(false, 'duplicate-end');
		const second = await refresh(app, ROWS2, setId);
		expectRefusedNotMisreported(second, files, modifyCalls, host, 'duplicate-end-marker');
	});

	it('duplicated end marker, WITH a children key: the key is not rebuilt either', async () => {
		const { app, files, modifyCalls, setId, host } = await seed(true, 'duplicate-end');
		const second = await refresh(app, ROWS2, setId);
		expectRefusedNotMisreported(second, files, modifyCalls, host, 'duplicate-end-marker');
		// The point of this shape: `children:` is present and stale, and the run had a
		// newer list in hand. It is still not written, because the body this writer
		// would have had to rebuild alongside it could not be located.
		expect(frontmatterOf(files.get(HOST)!).children).toEqual(['[[T1078.001]]']);
	});

	it('malformed marker line, NO children key: the parser verdict is reported and nothing moves', async () => {
		const { app, files, modifyCalls, setId, host } = await seed(false, 'malformed');
		const second = await refresh(app, ROWS2, setId);
		expectRefusedNotMisreported(second, files, modifyCalls, host, 'malformed-marker');
	});

	it('malformed marker line, WITH a children key: the key is not rebuilt either', async () => {
		const { app, files, modifyCalls, setId, host } = await seed(true, 'malformed');
		const second = await refresh(app, ROWS2, setId);
		expectRefusedNotMisreported(second, files, modifyCalls, host, 'malformed-marker');
		expect(frontmatterOf(files.get(HOST)!).children).toEqual(['[[T1078.001]]']);
	});

	/**
	 * CONTROL. The same host, same recipe, same refresh, with the region intact —
	 * so the four assertions above are known to be caused by the corruption and not
	 * by the fixture refusing for some unrelated reason.
	 */
	it('CONTROL: the same host with an intact region is rebuilt, with no conflict raised', async () => {
		const { app, files, modifyCalls, setId } = await seed(true, 'duplicate-end');
		const repaired = files.get(HOST)!.replace(
			'<!-- crosswalker:children:end -->\n<!-- crosswalker:children:end -->',
			'<!-- crosswalker:children:end -->',
		);
		files.set(HOST, repaired);
		modifyCalls.length = 0;
		const second = await refresh(app, ROWS2, setId);
		expect(hostConflicts(second)).toEqual([]);
		expect(missingRegionVoices(second)).toEqual([]);
		expect(modifyCalls).toContain(HOST);
		expect(files.get(HOST)).toContain('- [[T1078.001]]\n- [[T1078.002]]');
		expect(frontmatterOf(files.get(HOST)!).children).toEqual(['[[T1078.001]]', '[[T1078.002]]']);
	});
});
