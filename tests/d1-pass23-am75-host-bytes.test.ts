/**
 * d1-pass23-am75-host-bytes.test.ts — AM-75 (2026-09-04, twentieth amendment
 * set): the kept-host writer preserves the USER'S bytes.
 *
 * THE DEFECT THIS PINS. AM-72 extended AM-64's byte comparison to a subject it
 * was not designed for. A host note is the user's own concept note (`T1078.md`
 * beside `T1078/`), annotated through Obsidian's property editor, so its
 * properties are routinely not Crosswalker's. Rebuilding the candidate from the
 * PARSED frontmatter through `buildNoteContent` re-serialised every one of them:
 * `created: 2024-01-05` gained quotes, an apostrophe gained quotes, YAML
 * comments and blank lines disappeared, CRLF folded to LF, and a `|` block
 * scalar took the double-quote branch whose escape covers only `"`, so its raw
 * newline survived inside a quoted scalar and folded to a space on the next
 * read — a changed VALUE, in a note the run promised to leave alone. Each of
 * those differences was itself the write trigger (whole-note byte inequality),
 * so a Skip run that put nothing into the folder still restamped `produced_at`.
 *
 * WHY THE HOST IS HAND-WRITTEN HERE. The witness AM-72 shipped with built its
 * host through `buildNoteContent` and therefore round-tripped by construction:
 * it could not see the defect. Every host below is a hand-written string. The
 * only part copied from a generated note is the `_crosswalker:` block, verbatim,
 * because import-set ownership is what makes the note a host at all.
 *
 * LINE ENDINGS. AM-75 requires one LF variant and one CRLF variant, and that
 * "a CRLF note stays CRLF". Both are asserted. See the CRLF cases for what is
 * currently measured.
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
			create: async (path: string, content: string) => { createCalls.push(path); files.set(path, content); return new TFile(path); },
			modify: async (file: { path: string }, content: string) => { modifyCalls.push(file.path); files.set(file.path, content); },
			read: async (file: { path: string }) => files.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => files.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
			rename,
		},
		metadataCache: {
			// Deliberately tolerant of CRLF: the point of these cases is what the
			// WRITER does with a CRLF note, not what a mock reader does with one.
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
const ONT = 'p23am75';
const HOST = `${BASE}/T1078.md`;
const CHILD1 = `${BASE}/T1078/T1078.001.md`;

/**
 * `managed_links` on `parent` is what makes the host a children_lists parent as
 * well as a folder host, so BOTH managed parts — the `children:` properties key
 * and the `## Contents` body region — are this run's to rebuild. Without it
 * `patch.children` is undefined and the properties key is never touched at all
 * (measured; see d1-pass23-am76-rebuild-what-exists.test.ts).
 */
const RECIPE: Recipe = {
	recipe: 'p23am75-hosted-parent',
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

/** The generated note's `_crosswalker:` block, line for line. */
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

/**
 * A host as a PERSON writes it: a bare ISO date (which `formatYamlValue` would
 * quote), an apostrophe (which it would quote), a YAML comment and a blank line
 * (which it would drop), and a `|` block scalar (which it would fold to a quoted
 * scalar containing a raw newline — a changed value). Nothing here goes through
 * `buildNoteContent`.
 */
function handWrittenHost(provenance: string[], children: string[], eol: string): string {
	const lines = [
		'---',
		'created: 2024-01-05',
		"title: Don't Panic",
		'# the user left this comment here',
		'',
		'notes: |',
		'  first line',
		'  second line',
		'curie: "p23am75:T1078"',
		'children:',
		...children.map((c) => `  - "[[${c}]]"`),
		...provenance,
		'---',
		'',
		'User prose above the region.',
		'',
		'<!-- crosswalker:children:start v=1 -->',
		'## Contents',
		...children.map((c) => `- [[${c}]]`),
		'<!-- crosswalker:children:end -->',
		'',
		'User prose below.',
		'',
	];
	return lines.join(eol);
}

async function seed(eol: string) {
	const { app, files, modifyCalls, createCalls } = makeApp();
	const first = await generateFromRecipe(app, parsedOf(ROWS1), RECIPE, {
		...OPTS, overwriteMode: 'replace', sourceFileName: 'source.csv', importSet: 'new',
	});
	expect(first.errors).toEqual([]);
	const setId = frontmatterOf(files.get(CHILD1)!)?._crosswalker?.import_set?.id;
	expect(typeof setId).toBe('string');
	const host = handWrittenHost(provenanceBlock(files.get(HOST)!), ['T1078.001'], eol);
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

/**
 * The note the run is entitled to produce: the original, with the one new link
 * added to each managed part and `produced_at` moved. Every other byte is the
 * user's and must survive unchanged, which is what comparing against this
 * string — rather than against a re-serialisation — actually tests.
 */
function expectedAfterOneRowAdded(before: string, after: string, eol: string): string {
	const newProducedAt = after.split(eol).find((l) => l.trim().startsWith('produced_at:'));
	expect(typeof newProducedAt).toBe('string');
	const out: string[] = [];
	for (const line of before.split(eol)) {
		if (line.trim().startsWith('produced_at:')) { out.push(newProducedAt as string); continue; }
		out.push(line);
		if (line === '  - "[[T1078.001]]"') out.push('  - "[[T1078.002]]"');
		if (line === '- [[T1078.001]]') out.push('- [[T1078.002]]');
	}
	return out.join(eol);
}

describe('AM-75: a kept host keeps the user\'s bytes (LF)', () => {
	it('all-skip refresh writes nothing at all and the host is byte-identical', async () => {
		const { app, files, modifyCalls, createCalls, setId, host } = await seed('\n');
		const second = await refresh(app, ROWS1, setId);
		expect(second.errors).toEqual([]);
		expect(modifyCalls).toEqual([]);
		expect(createCalls).toEqual([]);
		// The whole string, not a normalised comparison.
		expect(files.get(HOST)).toBe(host);
	});

	it('one row added under the host changes only the managed lines and produced_at', async () => {
		const { app, files, modifyCalls, setId, host } = await seed('\n');
		const second = await refresh(app, ROWS2, setId);
		expect(second.errors).toEqual([]);
		expect(modifyCalls).toContain(HOST);
		const after = files.get(HOST)!;
		expect(after).toBe(expectedAfterOneRowAdded(host, after, '\n'));

		// The user's own properties, stated one at a time so a failure names which.
		expect(after).toContain('created: 2024-01-05');
		expect(after).not.toContain('created: "2024-01-05"');
		expect(after).toContain("title: Don't Panic");
		expect(after).toContain('# the user left this comment here');
		expect(after).toContain('notes: |\n  first line\n  second line');
		// And the multi-line value is still a multi-line value AFTER a parse — the
		// half the byte comparison alone cannot see.
		expect(frontmatterOf(after).notes).toBe('first line\nsecond line\n');
		// LF stays LF.
		expect(after).not.toContain('\r');
	});
});

describe('AM-75: a kept host keeps the user\'s bytes (CRLF)', () => {
	it('all-skip refresh writes nothing at all and the CRLF host is byte-identical', async () => {
		const { app, files, modifyCalls, createCalls, setId, host } = await seed('\r\n');
		const second = await refresh(app, ROWS1, setId);
		expect(second.errors).toEqual([]);
		expect(modifyCalls).toEqual([]);
		expect(createCalls).toEqual([]);
		expect(files.get(HOST)).toBe(host);
	});

	it('one row added under a CRLF host changes only the managed lines, and the note stays CRLF', async () => {
		const { app, files, modifyCalls, setId, host } = await seed('\r\n');
		const second = await refresh(app, ROWS2, setId);
		expect(second.errors).toEqual([]);
		expect(modifyCalls).toContain(HOST);
		const after = files.get(HOST)!;
		// Every newline is a CRLF: no bare LF survives once the CRLF pairs are gone,
		// and no doubled CR is introduced either.
		expect(after.replace(/\r\n/g, '')).not.toContain('\n');
		expect(after).not.toContain('\r\r');
		expect(after).toBe(expectedAfterOneRowAdded(host, after, '\r\n'));
		expect(frontmatterOf(after).notes).toBe('first line\nsecond line\n');
	});
});
