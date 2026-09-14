/**
 * d1-pass23-am76-rebuild-what-exists.test.ts — AM-76 (2026-09-04, twentieth
 * amendment set): "rebuilds those regions only" means WHAT EXISTS.
 *
 * A `children:` block present on disk is rebuilt. A `## Contents` managed region
 * present on disk is rebuilt. A host with NEITHER receives no write at all and
 * is voiced once per run in the row-3 register, because a stale list nobody
 * mentions is worse than a stale list somebody named.
 * `mergeManagedChildrenSection`'s append-when-absent path must not be reached
 * from this writer: a host that never had a managed region does not acquire one
 * because a refresh ran.
 *
 * The folder in the sentence comes from the pass that DECIDED the hosting
 * (`levelHubs.hostedFolderByPath`), never from the note's path — the sibling
 * shape (`T1078.md` hosts `T1078/`) and the folder-note shape
 * (`T1078/T1078.md` hosts `T1078/`) are different derivations of the same
 * string, and choosing between them by inspecting a path is the inference
 * `project_reimport_identity_reconciliation` rules out.
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
const ONT = 'p23am76';
const HOST = `${BASE}/T1078.md`;
const HOSTED_FOLDER = `${BASE}/T1078`;
const CHILD1 = `${BASE}/T1078/T1078.001.md`;

const NO_REGION_SENTENCE = `The note "${HOST}" hosts the folder "${HOSTED_FOLDER}" `
	+ 'but carries no managed Contents region; it was left as it was.';

const RECIPE: Recipe = {
	recipe: 'p23am76-hosted-parent',
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

interface HostShape { childrenKey: boolean; region: boolean }

function handWrittenHost(provenance: string[], children: string[], shape: HostShape): string {
	const lines = ['---', 'created: 2024-01-05', "title: Don't Panic", `curie: "${ONT}:T1078"`];
	if (shape.childrenKey) {
		lines.push('children:');
		for (const c of children) lines.push(`  - "[[${c}]]"`);
	}
	lines.push(...provenance, '---', '', 'User prose above.', '');
	if (shape.region) {
		lines.push('<!-- crosswalker:children:start v=1 -->', '## Contents');
		for (const c of children) lines.push(`- [[${c}]]`);
		lines.push('<!-- crosswalker:children:end -->', '');
	}
	lines.push('User prose below.', '');
	return lines.join('\n');
}

async function seed(shape: HostShape, children = ['T1078.001']) {
	const { app, files, modifyCalls, createCalls } = makeApp();
	const first = await generateFromRecipe(app, parsedOf(ROWS1), RECIPE, {
		...OPTS, overwriteMode: 'replace', sourceFileName: 'source.csv', importSet: 'new',
	});
	expect(first.errors).toEqual([]);
	const setId = frontmatterOf(files.get(CHILD1)!)?._crosswalker?.import_set?.id;
	const host = handWrittenHost(provenanceBlock(files.get(HOST)!), children, shape);
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

const voices = (r: { warnings?: { message: string }[] }): string[] =>
	(r.warnings ?? []).map((w) => w.message).filter((m) => m.includes('no managed Contents region'));

describe('AM-76: rebuild means what exists', () => {
	it('neither a children key nor a region: zero writes and exactly one ruled sentence, once per run', async () => {
		const { app, files, modifyCalls, setId, host } = await seed({ childrenKey: false, region: false });
		const second = await refresh(app, ROWS2, setId);
		expect(second.errors).toEqual([]);
		expect(modifyCalls).not.toContain(HOST);
		expect(files.get(HOST)).toBe(host);
		// The exact sentence, and exactly one of it — the folder named by the pass
		// that decided the hosting, not derived from the note's own path.
		expect(voices(second)).toEqual([NO_REGION_SENTENCE]);
		// And nothing was appended: the append-when-absent path is unreachable here.
		expect(files.get(HOST)).not.toContain('crosswalker:children:start');
		expect(files.get(HOST)).not.toContain('\nchildren:');
	});

	it('a children key with no region: the key is rebuilt, no region is appended, and nothing is voiced', async () => {
		const { app, files, modifyCalls, setId, host } = await seed({ childrenKey: true, region: false });
		const second = await refresh(app, ROWS2, setId);
		expect(second.errors).toEqual([]);
		expect(modifyCalls).toContain(HOST);
		const after = files.get(HOST)!;
		expect(frontmatterOf(after).children).toEqual(['[[T1078.001]]', '[[T1078.002]]']);
		// No managed region acquired.
		expect(after).not.toContain('crosswalker:children:start');
		expect(after).not.toContain('## Contents');
		// The user's prose either side is untouched, and only the managed key moved.
		expect(after).toContain('User prose above.');
		expect(after).toContain('User prose below.');
		expect(voices(second)).toEqual([]);
		expect(after).not.toBe(host);
	});

	it('a region with no children key: the region is rebuilt, the missing key is NOT added, and nothing is voiced', async () => {
		const { app, files, modifyCalls, setId } = await seed({ childrenKey: false, region: true });
		const second = await refresh(app, ROWS2, setId);
		expect(second.errors).toEqual([]);
		expect(modifyCalls).toContain(HOST);
		const after = files.get(HOST)!;
		expect(after).toContain('- [[T1078.001]]\n- [[T1078.002]]');
		// AM-76 limits rebuilding to the parts that are present. A `children:` key
		// that was never on disk is not invented because the region was rebuilt.
		expect(frontmatterOf(after).children).toBeUndefined();
		expect(voices(second)).toEqual([]);
	});

	/**
	 * AN AMBIGUITY IN THE CONTRACT, CHARACTERISED RATHER THAN RULED.
	 *
	 * AM-56 says an empty list never CREATES a region; AM-76 says a host with no
	 * region is voiced. Neither text says what happens when both apply at once,
	 * and an empty desired child list is NOT itself evidence that a region exists.
	 *
	 * What is measured below is the only "empty list" state this harness can
	 * actually reach: when every row under the hosted folder leaves the source,
	 * the folder stops being described at all, so the note stops being a host and
	 * NOTHING is said about it — not the AM-76 sentence, not a write. The state
	 * the pass-23 implement leg worried about (a folder still hosted, whose
	 * children were all refused, leaving `hubChildren: []` with no region) is a
	 * different state and was not reachable here; it is recorded as unresolved
	 * rather than asserted either way.
	 */
	it('CHARACTERISATION: a hosted folder that loses every row stops being hosted, so the AM-76 sentence is not spoken', async () => {
		const { app, files, modifyCalls, setId, host } = await seed({ childrenKey: false, region: false }, []);
		// Only the host row survives, so the hosted folder is no longer described.
		const second = await refresh(app, [ROWS1[0]], setId);
		expect(second.errors).toEqual([]);
		expect(modifyCalls).not.toContain(HOST);
		expect(files.get(HOST)).toBe(host);
		expect(voices(second)).toEqual([]);
	});

	/**
	 * The DISPUTED edge from the pass-23 implement leg (its deviation 2): a host
	 * carrying a managed part but NO `_crosswalker` block, where the writer would
	 * append provenance the note never had. AM-75 limits this writer's changes to
	 * the managed parts and no ruling authorises inventing metadata, so the
	 * question is whether the branch is reachable at all. It is not: import-set
	 * ownership is read from `_crosswalker`, so a note without it is not a host —
	 * it is an unowned note at the address, refused by name, and a synthetic hub is
	 * created inside the folder instead. The append branch is therefore dead code
	 * on this shape, and the ruling is not urgent.
	 */
	it('a host with a managed region but no _crosswalker block is refused as not this import\'s, not silently stamped', async () => {
		const { app, files, modifyCalls, setId, host } = await seed({ childrenKey: true, region: true });
		const stripped = host.replace(/_crosswalker:\n(?:  .*\n)+/, '');
		expect(stripped).not.toContain('_crosswalker');
		files.set(HOST, stripped);
		modifyCalls.length = 0;
		const second = await refresh(app, ROWS2, setId);
		expect(files.get(HOST)).toBe(stripped);
		expect(modifyCalls).not.toContain(HOST);
		expect(second.errors.map((e) => e.message).join('\n')).toContain(`a note that is not Crosswalker's sits at ${HOST}`);
	});
});
