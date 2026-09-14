/**
 * enrichment-reimport.test.ts — Pass 1.5 re-import safety (design §4/§5 case 4),
 * driven END-TO-END through generateFromRecipe against a stateful in-memory vault.
 *
 * Asserts:
 *   - import twice → byte-identical vault (produced_at wall-clock normalized, the
 *     one known non-deterministic field);
 *   - GenerationResult.edgeCount is populated (design §3.5 / case 6 field only);
 *   - user prose added to a facet hub body survives a re-import while `members`
 *     regenerates (managed) and user frontmatter is preserved.
 *   - the folder-note relocation seam (design §4, "the risky one"): re-import
 *     finds a previously-relocated parent BY CURIE and never duplicates it at
 *     the sibling path; flipping `parent_note` back to `'sibling'` relocates it
 *     back (design §5 case 5, the flip-back decision).
 */

import { TFile, TFolder } from 'obsidian';
import { generateFromRecipe } from '../src/generation/generation-engine';
import { discoverImportSets, type ImportSetOption } from '../src/generation/import-set';
import type { Recipe } from '../src/render';
import type { ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

// ---------------------------------------------------------------------------
// A minimal stateful in-memory vault + app (Map-backed).
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
			rename: async (file: { path: string }, newPath: string) => {
				const content = files.get(file.path);
				if (content !== undefined) {
					files.delete(file.path);
					files.set(newPath, content);
				}
			},
			delete: async (file: { path: string }) => {
				files.delete(file.path);
			},
		},
		fileManager: {
			renameFile: async (file: TFile, newPath: string) => {
				const content = files.get(file.path);
				if (content !== undefined) {
					files.delete(file.path);
					files.set(newPath, content);
				}
				file.path = newPath;
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

const RECIPE: Recipe = {
	recipe: 'attack',
	source: { ontology: 'attack', levels: ['leaf'] },
	target: {
		layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }],
		also_emit: {
			tags: ['tactic/{tactic|tagsafe}'],
			frontmatter: { managed: { parent: '[[{parent}]]' } },
		},
		enrichment: { children_lists: true, facet_notes: 'notes', parent_note: 'sibling' },
	},
};

const ROWS = [
	{ id: 'T1078', parent: '', tactic: 'Persistence' },
	{ id: 'T1078.001', parent: 'T1078', tactic: 'Persistence' },
	{ id: 'T1078.002', parent: 'T1078', tactic: 'Persistence' },
];

function parsed(): ParsedData {
	return { columns: ['id', 'parent', 'tactic'], rows: [...ROWS], rowCount: ROWS.length };
}

/** Same rows, but as an AsyncIterable — the streaming-row shape (design §3 step 2 v1 restriction). */
function parsedStreamed(): ParsedData {
	async function* stream() {
		for (const row of ROWS) yield row;
	}
	return { columns: ['id', 'parent', 'tactic'], rows: stream(), rowCount: -1 };
}

const OPTS = {
	basePath: 'Frameworks',
	overwriteMode: 'replace' as const,
	createFolders: true,
	strictValidation: false, // this test is about enrichment, not Tier 1 conformance
	curieLocalPart: (row: Record<string, unknown>) => String(row.id),
	facetsForRow: (row: Record<string, unknown>) => [{ namespace: 'tactic', value: String(row.tactic) }],
};

/**
 * One import, with ownership said out loud.
 *
 * AM-9 (2026-08-30): the engine used to look at the destination folder and, if
 * exactly one import set already lived there, silently refresh it. Every
 * re-import in this file relied on that, which is why an omitted ownership
 * option used to mean "refresh". The branch is deleted -- a folder is an
 * address, and an address does not name an owner -- so an omitted option now
 * MINTS A NEW SET, and "import twice is byte-identical" would be comparing two
 * different `import_set.id` stamps written by two different sets.
 *
 * None of these cases is retired; a re-import is exactly what they are about.
 * The first import into a vault mints, because there is nothing yet to name,
 * and every later one names what the vault already holds -- which is what the
 * wizard does after its review step, and what the SSSOM modal does after its
 * refresh click.
 *
 * `ownership: new` is for the one case that deliberately runs a SECOND,
 * unrelated import into the same vault.
 */
async function importInto(
	app: any,
	data: ParsedData,
	recipe: Recipe,
	opts: Parameters<typeof generateFromRecipe>[3] = OPTS,
	/**
	 * AM-13: `'new-set-qualified'` as well as `'new'`. A second import that mints
	 * the SAME curies as the first (same ontology, same rows, different recipe)
	 * needs its own identity space, or AM-12 refuses every row of it and nothing
	 * is written for the caller to inspect.
	 */
	ownership?: ImportSetOption,
) {
	const [existing] = await discoverImportSets(app, undefined);
	const importSet: ImportSetOption | undefined = ownership ?? (existing ? { id: existing.id } : undefined);
	return generateFromRecipe(app, data, recipe, { ...opts, ...(importSet ? { importSet } : {}) });
}

/** Strip the wall-clock provenance field so two imports compare byte-for-byte. */
function normalize(files: Map<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of files) out[k] = v.replace(/produced_at: "[^"]*"/g, 'produced_at: "<ts>"');
	return out;
}

describe('Pass 1.5 re-import — end-to-end via generateFromRecipe', () => {
	it('materializes children + a facet hub and reports edgeCount', async () => {
		const { app, files } = makeApp();
		const result = await importInto(app, parsed(), RECIPE, OPTS);

		expect(result.edgeCount).toBeGreaterThan(0);
		// T1078 note gained children; a Persistence hub exists with members.
		const t1078 = files.get('Frameworks/T1078.md')!;
		expect(t1078).toContain('children:');
		expect(t1078).toContain('[[T1078.001]]');
		const hub = files.get('Frameworks/Persistence.md')!;
		expect(hub).toContain('kind: facet');
		expect(hub).toContain('members:');
		expect(hub).toContain('# Persistence');
		const stamps = [...files.values()].map((content) => {
			const fm = yaml.load(/^---\n([\s\S]*?)\n---/.exec(content)![1]) as any;
			return fm._crosswalker.import_set;
		});
		expect(new Set(stamps.map((stamp) => stamp.id)).size).toBe(1);
		expect(stamps[0].id).toMatch(/^iset-[a-z0-9]{6}$/);
		expect(stamps.every((stamp) => stamp.scheme === 'endpoint-v1')).toBe(true);
	});

	it('reports a removed concept without misreporting stamped facet hubs', async () => {
		const { app } = makeApp();
		await importInto(app, parsed(), RECIPE, OPTS);
		const reduced = { columns: ['id', 'parent', 'tactic'], rows: ROWS.slice(0, 2), rowCount: 2 };
		const result = await importInto(app, reduced, RECIPE, OPTS);
		expect(result.errors).toEqual([]);
		expect(result.orphans).toEqual([{ curie: 'attack:T1078.002', path: 'Frameworks/T1078.002.md' }]);
	});

	it('import twice → byte-identical vault (produced_at normalized)', async () => {
		const { app, files } = makeApp();
		await importInto(app, parsed(), RECIPE, OPTS);
		const first = normalize(files);
		await importInto(app, parsed(), RECIPE, OPTS);
		const second = normalize(files);
		expect(second).toEqual(first);
	});

	it('user prose in a hub body survives re-import; members regenerate', async () => {
		const { app, files } = makeApp();
		await importInto(app, parsed(), RECIPE, OPTS);

		// User edits the hub note: adds prose below the H1 + a hand-added frontmatter key.
		const hubPath = 'Frameworks/Persistence.md';
		const original = files.get(hubPath)!;
		// Prose goes BELOW the managed region's end marker. Since 2026-08-27 a hub
		// note's managed content lives inside `crosswalker:body`, which retires
		// mergeHubBody's "first H1 is managed, everything after it is prose"
		// formatting heuristic (contract §2.2 item 4). The marker is visible while
		// editing, invisible while reading: that asymmetry is what makes the
		// boundary something a user can respect.
		const edited = original
			.replace('<!-- crosswalker:body:end -->', '<!-- crosswalker:body:end -->\n\nMy tradecraft notes on persistence.')
			.replace('kind: facet', 'kind: facet\nreviewer: alice');
		expect(edited).toContain('<!-- crosswalker:body:end -->\n\nMy tradecraft notes');
		files.set(hubPath, edited);

		// Re-import.
		await importInto(app, parsed(), RECIPE, OPTS);
		const after = files.get(hubPath)!;

		expect(after).toContain('My tradecraft notes on persistence.'); // prose survived
		expect(after).toContain('reviewer: alice'); // user frontmatter survived
		expect(after).toContain('members:'); // members regenerated
		expect(after).toContain('[[T1078]]');
		const fm = yaml.load(/^---\n([\s\S]*?)\n---/.exec(after)![1]) as Record<string, unknown>;
		expect(fm.members).toEqual(['[[T1078]]', '[[T1078.001]]', '[[T1078.002]]']);
	});
});

// ===========================================================================
// Folder-note relocation — the risky seam (design §4)
// ===========================================================================

// A variadic-folder layout (unlike RECIPE above, which is flat file-only) so a
// root id (T1078, 0 dots) renders straight to T1078.md while a child id
// (T1078.001, 1 dot) nests under T1078/ — the real collision folder-note
// relocation needs. Mirrors BROWSABLE_FRAMEWORK's ragged-tail shape.
const FOLDER_NOTE_RECIPE: Recipe = {
	recipe: 'attack-fn',
	source: { ontology: 'attack-fn', levels: ['tail', 'leaf'] },
	target: {
		layout: [
			{ level: 'tail', mechanism: 'folder', template: '{id}', variadic: { delimiter: '.' } },
			{ level: 'leaf', mechanism: 'file', template: '{id}.md' },
		],
		also_emit: {
			tags: ['tactic/{tactic|tagsafe}'],
			frontmatter: { managed: { parent: '[[{parent}]]' } },
		},
		enrichment: { children_lists: true, facet_notes: 'none', parent_note: 'folder-note' },
	},
};

/** `FOLDER_NOTE_RECIPE`, but with `parent_note` overridden (for the flip-back import). */
function folderNoteRecipe(parentNote: 'sibling' | 'folder-note'): Recipe {
	return {
		...FOLDER_NOTE_RECIPE,
		target: { ...FOLDER_NOTE_RECIPE.target, enrichment: { ...FOLDER_NOTE_RECIPE.target.enrichment, parent_note: parentNote } },
	};
}

describe('Pass 1.5 folder-note relocation — re-import identity (design §4, the risky seam)', () => {
	it('T1078 relocates to T1078/T1078.md; every inbound link still resolves', async () => {
		const { app, files } = makeApp();
		const result = await importInto(app, parsed(), FOLDER_NOTE_RECIPE, OPTS);

		expect(files.has('Frameworks/T1078/T1078.md')).toBe(true);
		expect(files.has('Frameworks/T1078.md')).toBe(false); // no stray sibling
		expect(result.created).toContain('Frameworks/T1078/T1078.md');
		expect(result.created).not.toContain('Frameworks/T1078.md');

		const parent = files.get('Frameworks/T1078/T1078.md')!;
		expect(parent).toContain('[[T1078.001]]'); // children list, at the new path
		const child = files.get('Frameworks/T1078/T1078.001.md')!;
		expect(child).toContain('[[T1078]]'); // basename parent link — resolves regardless of T1078's folder
	});

	it('re-import finds the relocated parent BY CURIE — byte-identical vault, zero duplicates', async () => {
		const { app, files } = makeApp();
		await importInto(app, parsed(), FOLDER_NOTE_RECIPE, OPTS);
		const first = normalize(files);

		const result = await importInto(app, parsed(), FOLDER_NOTE_RECIPE, OPTS);
		const second = normalize(files);

		expect(second).toEqual(first); // byte-identical (produced_at normalized)
		expect(files.has('Frameworks/T1078.md')).toBe(false); // still no stray duplicate
		expect([...files.keys()].filter((p) => p.endsWith('T1078.md'))).toEqual(['Frameworks/T1078/T1078.md']);
		// Steady state: T1078 is ALREADY folder-note-shaped, so relocation is a
		// no-op (enrich()'s idempotency guard) — no relocation deviation on the
		// re-import, unlike the very first import (which DOES report one).
		expect(result.warnings ?? []).toEqual([]);
	});

	it('a third import with parent_note flipped back to sibling relocates T1078 back (least-surprising, design §5 flip-back)', async () => {
		const { app, files } = makeApp();
		await importInto(app, parsed(), FOLDER_NOTE_RECIPE, OPTS); // import 1: folder-note
		await importInto(app, parsed(), FOLDER_NOTE_RECIPE, OPTS); // import 2: folder-note (steady state)

		const result = await importInto(app, parsed(), folderNoteRecipe('sibling'), OPTS); // import 3: flip to sibling

		expect(files.has('Frameworks/T1078.md')).toBe(true); // relocated back
		expect(files.has('Frameworks/T1078/T1078.md')).toBe(false); // no orphan left behind
		// This IS a real relocation (not idempotent), so it DOES report — the
		// deviation is the visible trail explaining why T1078 moved.
		expect((result.warnings ?? []).map((w) => w.message)).toEqual([
			'parent_note: relocated attack-fn:T1078 back to sibling form (Frameworks/T1078/T1078.md → Frameworks/T1078.md).',
		]);

		const back = files.get('Frameworks/T1078.md')!;
		expect(back).toContain('[[T1078.001]]'); // children list carried across the flip

		// The T1078/ folder still holds the children — only the parent note moved
		// back out of it. (Children live there because of the variadic FOLDER
		// layout, independent of parent_note; relocation only ever moves the
		// concept note that shares the folder's own name.)
		expect(files.has('Frameworks/T1078/T1078.001.md')).toBe(true);
		expect(files.has('Frameworks/T1078/T1078.002.md')).toBe(true);
	});

	it('a streamed source keeps every parent as a sibling, with a deviation (v1 restriction)', async () => {
		const { app, files } = makeApp();
		const result = await importInto(app, parsedStreamed(), FOLDER_NOTE_RECIPE, OPTS);

		expect(files.has('Frameworks/T1078.md')).toBe(true); // sibling, not relocated
		expect(files.has('Frameworks/T1078/T1078.md')).toBe(false);
		expect((result.warnings ?? []).map((w) => w.message)).toEqual([
			"parent_note: folder-note requires an eager (non-streamed) source; this streamed import kept parent notes as siblings.",
		]);
	});
});

// ===========================================================================
// Level hubs + Waypoint marker — end-to-end (2026-07-11 ICSB audit gaps #1/#3)
// ===========================================================================

// FOLDER_NOTE_RECIPE's shape (T1078 nests sub-techniques under T1078/) is what
// exercises a level hub HOSTED by a sibling parent note; level_hubs is
// independent of parent_note (works whether the parent is sibling or
// folder-note shaped — see enrich.ts's byBasename-based host detection).
const LEVEL_HUB_RECIPE: Recipe = {
	...FOLDER_NOTE_RECIPE,
	recipe: 'attack-hubs',
	source: { ontology: 'attack-hubs', levels: ['tail', 'leaf'] },
	target: {
		...FOLDER_NOTE_RECIPE.target,
		enrichment: { children_lists: true, facet_notes: 'none', parent_note: 'sibling', level_hubs: 'notes' },
	},
};

function levelHubRecipe(waypointMarker: boolean): Recipe {
	return {
		...LEVEL_HUB_RECIPE,
		target: { ...LEVEL_HUB_RECIPE.target, enrichment: { ...LEVEL_HUB_RECIPE.target.enrichment, waypoint_marker: waypointMarker } },
	};
}

describe('Pass 1.5 level hubs — end-to-end via generateFromRecipe', () => {
	it('T1078.md (sibling parent) hosts a managed Contents section listing its sub-techniques', async () => {
		const { app, files } = makeApp();
		const result = await importInto(app, parsed(), LEVEL_HUB_RECIPE, OPTS);

		expect(result.edgeCount).toBeGreaterThan(0);
		const t1078 = files.get('Frameworks/T1078.md')!;
		expect(t1078).toContain('## Contents');
		expect(t1078).toContain('- [[T1078.001]]');
		expect(t1078).toContain('- [[T1078.002]]');
		expect(t1078).toContain('children:'); // children_lists frontmatter still present too
	});

	it('a pure structural root folder with no matching concept note gets a synthetic hub note', async () => {
		const { app, files } = makeApp();
		await importInto(app, parsed(), LEVEL_HUB_RECIPE, OPTS);

		// "Frameworks" is the basePath; nothing in this fixture is named "Frameworks",
		// so it's synthetic — the import's home note.
		const home = files.get('Frameworks/Frameworks.md')!;
		expect(home).toBeDefined();
		expect(home).toContain('kind: hub');
		expect(home).toContain('# Frameworks');
		expect(home).toContain('- [[T1078]]');
		const homeFm = yaml.load(/^---\n([\s\S]*?)\n---/.exec(home)![1]) as any;
		// `destination` records where the set was written, so a later refresh can
		// look up where its own notes live instead of re-deriving a folder that may
		// no longer be the right one (2026-08-29). `ontology` pins the identity
		// space the same way `scheme` does, so a refresh mints curies the set's own
		// notes already answer to rather than recomputing them from its own recipe
		// (AM-6, 2026-08-30). `derivation` pins HOW a row becomes a curie, for the
		// same reason: a refresh that derives identities differently recognises none
		// of the notes it owns (AM-27, 2026-08-31). This set was minted by this run,
		// so it carries the current rule; a set written before the pin existed
		// carries no `derivation` key at all, which is the legacy rule.
		expect(homeFm._crosswalker.import_set).toEqual({
			id: expect.stringMatching(/^iset-[a-z0-9]{6}$/),
			scheme: 'endpoint-v1',
			destination: 'Frameworks',
			ontology: 'attack-hubs',
			derivation: 'declared-facts-v1',
		});
	});

	it('import twice → byte-identical vault (level hubs included)', async () => {
		const { app, files } = makeApp();
		await importInto(app, parsed(), LEVEL_HUB_RECIPE, OPTS);
		const first = normalize(files);
		await importInto(app, parsed(), LEVEL_HUB_RECIPE, OPTS);
		const second = normalize(files);
		expect(second).toEqual(first);
	});

	it('user prose on the synthetic home note survives re-import; the Contents section regenerates', async () => {
		const { app, files } = makeApp();
		await importInto(app, parsed(), LEVEL_HUB_RECIPE, OPTS);

		const homePath = 'Frameworks/Frameworks.md';
		const original = files.get(homePath)!;
		const edited = original
			.replace('# Frameworks', '# Frameworks\n\nWelcome to my compliance vault.')
			.replace('kind: hub', 'kind: hub\nreviewer: alice');
		files.set(homePath, edited);

		await importInto(app, parsed(), LEVEL_HUB_RECIPE, OPTS);
		const after = files.get(homePath)!;

		expect(after).toContain('Welcome to my compliance vault.'); // prose survived
		expect(after).toContain('reviewer: alice'); // user frontmatter survived
		expect(after).toContain('- [[T1078]]'); // managed section regenerated
		expect(after.match(/crosswalker:children:start/g)?.length).toBe(1); // not duplicated
	});

	it('waypoint_marker: false (default) never appends the trigger comment', async () => {
		const { app, files } = makeApp();
		await importInto(app, parsed(), levelHubRecipe(false), OPTS);
		expect(files.get('Frameworks/T1078.md')).not.toContain('%% Waypoint %%');
		expect(files.get('Frameworks/Frameworks.md')).not.toContain('%% Waypoint %%');
	});

	it('waypoint_marker: true appends the trigger comment to hosted AND synthetic hub notes, idempotently', async () => {
		const { app, files } = makeApp();
		await importInto(app, parsed(), levelHubRecipe(true), OPTS);
		expect(files.get('Frameworks/T1078.md')).toContain('%% Waypoint %%');
		expect(files.get('Frameworks/Frameworks.md')).toContain('%% Waypoint %%');

		// Re-import: still exactly one marker each, never duplicated.
		await importInto(app, parsed(), levelHubRecipe(true), OPTS);
		const t1078Markers = (files.get('Frameworks/T1078.md')!.match(/%% Waypoint %%/g) ?? []).length;
		const homeMarkers = (files.get('Frameworks/Frameworks.md')!.match(/%% Waypoint %%/g) ?? []).length;
		expect(t1078Markers).toBe(1);
		expect(homeMarkers).toBe(1);
	});

	it('does not strip a block Waypoint has already expanded on the home note', async () => {
		const { app, files } = makeApp();
		await importInto(app, parsed(), levelHubRecipe(true), OPTS);

		// Simulate Waypoint itself having expanded the marker into its listing.
		const homePath = 'Frameworks/Frameworks.md';
		const withExpansion = files.get(homePath)!.replace(
			'%% Waypoint %%',
			'%% Begin Waypoint %%\n- [[Some Hand-Added Note]]\n%% End Waypoint %%',
		);
		files.set(homePath, withExpansion);

		await importInto(app, parsed(), levelHubRecipe(true), OPTS);
		const after = files.get(homePath)!;
		expect(after).toContain('%% Begin Waypoint %%');
		expect(after).toContain('[[Some Hand-Added Note]]');
		expect(after).not.toContain('%% Waypoint %%\n\n%% Waypoint %%'); // no duplicate re-append
	});
});

// ===========================================================================
// concept_cid + recipe.hash — Ch 43 deliverable §2 wiring
// (.workspace/2026-07-11-challenge-43-version-migration-deliverable.md)
// ===========================================================================

/** Pull `_crosswalker.{concept_cid, recipe.hash}` out of a rendered note's frontmatter. */
function crosswalkerBlock(text: string): { conceptCid?: string; recipeHash?: string } {
	const m = /^---\n([\s\S]*?)\n---/.exec(text);
	const fm = (yaml.load(m![1]) as Record<string, unknown>) ?? {};
	const cw = (fm._crosswalker as Record<string, unknown>) ?? {};
	const recipe = (cw.recipe as Record<string, unknown>) ?? {};
	return { conceptCid: cw.concept_cid as string | undefined, recipeHash: recipe.hash as string | undefined };
}

/** `RECIPE`, but wrapped under an extra literal folder level — same also_emit/enrichment, different layout/path. */
const RECIPE_WRAPPED_FOLDER: Recipe = {
	...RECIPE,
	recipe: 'attack-wrapped',
	target: {
		...RECIPE.target,
		layout: [
			{ level: 'wrapper', mechanism: 'folder', template: 'Wrapped' },
			...RECIPE.target.layout,
		],
	},
};

/**
 * AM-60 (2026-09-04, pass 19): ONE POPULATION, ONE PASS -- the `overwriteMode:
 * 'skip'` twin of this file's `'replace'`-only re-import coverage.
 *
 * THE DEFECT THIS PINS (pass-18 CONFIRMED 2 / Ground 3). `applyEnrichment`
 * used to receive `enrichRecords` ALONE (the rows this run actually WROTE),
 * never the rows it kept. In the DEFAULT overwrite mode (Skip existing), a
 * refresh that adds one row to an existing framework computed every
 * ancestor's managed Contents from a batch of ONE and rewrote the hub to name
 * only the new row -- twenty existing links vanish from the one region a
 * user is told not to hand-edit, with zero warnings and zero orphans. AM-60
 * hands `applyEnrichment` the WHOLE in-scope population
 * (`[...enrichRecords, ...keptRecords]`) so every list it derives (Contents
 * included) is computed over what the folder actually holds, while confining
 * the note-body WRITE itself to the rows this run produced (`writeSet`).
 */
const TACTIC_FOLDER_RECIPE: Recipe = {
	recipe: 'am60-tactic-folder',
	source: { ontology: 'am60', levels: ['tactic', 'leaf'] },
	target: {
		layout: [
			{ level: 'tactic', mechanism: 'folder', template: '{tactic}' },
			{ level: 'leaf', mechanism: 'file', template: '{id}.md' },
		],
		enrichment: { children_lists: true, facet_notes: 'none', parent_note: 'sibling', level_hubs: 'notes' },
	},
};

function am60RowsV1(): ParsedData {
	const rows = [
		{ id: 'T1', name: 'One', tactic: 'Persistence' },
		{ id: 'T2', name: 'Two', tactic: 'Persistence' },
	];
	return { columns: ['id', 'name', 'tactic'], rows, rowCount: rows.length };
}

/** Same two rows, unchanged -- plus ONE new row appended to the same tactic. */
function am60RowsV2(): ParsedData {
	const rows = [
		{ id: 'T1', name: 'One', tactic: 'Persistence' },
		{ id: 'T2', name: 'Two', tactic: 'Persistence' },
		{ id: 'T3', name: 'Three', tactic: 'Persistence' },
	];
	return { columns: ['id', 'name', 'tactic'], rows, rowCount: rows.length };
}

const AM60_OPTS = {
	basePath: 'Frameworks',
	createFolders: true,
	strictValidation: false,
	curieLocalPart: (row: Record<string, unknown>) => String(row.id),
};

describe('AM-60 end to end: Skip existing, one new row added to an existing folder -- the parent hub\'s Contents lists every child the folder holds, not just the one row this run wrote', () => {
	it('two rows imported, one row added, refreshed with Skip existing: the tactic hub\'s Contents names all three', async () => {
		const { app, files } = makeApp();
		await importInto(app, am60RowsV1(), TACTIC_FOLDER_RECIPE, { ...AM60_OPTS, overwriteMode: 'replace' });

		const hubPath = 'Frameworks/Persistence/Persistence.md';
		expect(files.get(hubPath)).toContain('- [[T1]]');
		expect(files.get(hubPath)).toContain('- [[T2]]');

		const result = await importInto(app, am60RowsV2(), TACTIC_FOLDER_RECIPE, { ...AM60_OPTS, overwriteMode: 'skip' });
		expect(result.errors).toEqual([]);
		// T1 and T2 were left exactly where they were (Skip existing); only T3 is
		// newly created.
		expect(result.created).toEqual(['Frameworks/Persistence/T3.md']);
		expect(result.skipped).toEqual(expect.arrayContaining(['Frameworks/Persistence/T1.md', 'Frameworks/Persistence/T2.md']));

		const hub = files.get(hubPath)!;
		// THE FIX: the parent's Contents lists every child the folder holds --
		// the two rows this run left alone AND the one row it wrote -- not just
		// the single row `applyEnrichment` was, before AM-60, handed alone.
		expect(hub).toContain('- [[T1]]');
		expect(hub).toContain('- [[T2]]');
		expect(hub).toContain('- [[T3]]');
		const contentsLinks = (/## Contents\n([\s\S]*?)(\n##|\n%%|$)/.exec(hub)?.[1] ?? '')
			.split('\n').filter((l) => l.trim().startsWith('- [['));
		expect(contentsLinks).toHaveLength(3);

		expect(result.orphans ?? []).toEqual([]);
	});

	it('no second derivation survives: markKeptHubsProduced no longer exists as a symbol in generation-engine.ts', () => {
		// AM-60's own invariant, checked structurally rather than behaviourally:
		// the two-pass shape (a bookkeeping `enrich()` call over the whole
		// population, a SEPARATE writing `enrich()` call over half of it) is what
		// produced two answers for one folder. There is now exactly one call, and
		// the function that used to be the bookkeeping half is gone -- not merely
		// unused, not renamed and kept around, gone.
		const fs = require('node:fs') as typeof import('node:fs');
		const path = require('node:path') as typeof import('node:path');
		const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'generation', 'generation-engine.ts'), 'utf-8');
		// No DECLARATION and no CALL SITE -- a historical mention in a comment
		// (the header explaining what AM-60 removed and why) is fine and expected.
		expect(source).not.toMatch(/function markKeptHubsProduced/);
		expect(source).not.toMatch(/[^.]\bmarkKeptHubsProduced\(/);
		expect(source).toContain('reportOwnedHubReadProblems'); // what's left of it (AM-60's own naming)
	});
});

describe('concept_cid + recipe.hash (Ch 43 deliverable §2 wiring)', () => {
	it('every generated note carries a well-formed concept_cid and recipe.hash', async () => {
		const { app, files } = makeApp();
		await importInto(app, parsed(), RECIPE, OPTS);
		const t1078 = crosswalkerBlock(files.get('Frameworks/T1078.md')!);
		expect(t1078.conceptCid).toMatch(/^sha256-[a-f0-9]{64}$/);
		expect(t1078.recipeHash).toMatch(/^sha256-[a-f0-9]{64}$/);
	});

	it('concept_cid is identical across DIFFERENT concepts\' notes only when their (curie, row) differ — sanity: distinct rows get distinct cids', async () => {
		const { app, files } = makeApp();
		await importInto(app, parsed(), RECIPE, OPTS);
		const cid1078 = crosswalkerBlock(files.get('Frameworks/T1078.md')!).conceptCid;
		const cid1078001 = crosswalkerBlock(files.get('Frameworks/T1078.001.md')!).conceptCid;
		expect(cid1078).toBeDefined();
		expect(cid1078001).toBeDefined();
		expect(cid1078).not.toBe(cid1078001);
	});

	it('concept_cid is stable under a PLACEMENT-only change: same (curie, row) rendered by two different recipes → same cid, different path', async () => {
		const { app: appA, files: filesA } = makeApp();
		await importInto(appA, parsed(), RECIPE, OPTS);
		const { app: appB, files: filesB } = makeApp();
		await importInto(appB, parsed(), RECIPE_WRAPPED_FOLDER, OPTS);

		// Different recipe → different path (placement changed).
		expect(filesA.has('Frameworks/T1078.md')).toBe(true);
		expect(filesB.has('Frameworks/Wrapped/T1078.md')).toBe(true);

		// Same source row → same concept_cid despite the different vault layout
		// (per spec/tier1.schema.json's sha256_cid description: "stable across
		// vault layouts because the recipe's render() output is NOT included").
		const cidA = crosswalkerBlock(filesA.get('Frameworks/T1078.md')!).conceptCid;
		const cidB = crosswalkerBlock(filesB.get('Frameworks/Wrapped/T1078.md')!).conceptCid;
		expect(cidA).toBe(cidB);

		// But recipe.hash DOES differ — the two recipes have different layouts.
		const hashA = crosswalkerBlock(filesA.get('Frameworks/T1078.md')!).recipeHash;
		const hashB = crosswalkerBlock(filesB.get('Frameworks/Wrapped/T1078.md')!).recipeHash;
		expect(hashA).not.toBe(hashB);
	});

	it('concept_cid changes when the row content changes, same recipe (source-version drift)', async () => {
		const { app, files } = makeApp();
		await importInto(app, parsed(), RECIPE, OPTS);
		const before = crosswalkerBlock(files.get('Frameworks/T1078.md')!).conceptCid;

		const editedRows = ROWS.map((r) => (r.id === 'T1078' ? { ...r, tactic: 'Defense Evasion' } : r));
		const editedParsed: ParsedData = { columns: ['id', 'parent', 'tactic'], rows: editedRows, rowCount: editedRows.length };
		await importInto(app, editedParsed, RECIPE, OPTS);
		const after = crosswalkerBlock(files.get('Frameworks/T1078.md')!).conceptCid;

		expect(after).not.toBe(before);
	});

	it('recipe.hash is STABLE across a re-import where only row content changed (recipe target untouched)', async () => {
		const { app, files } = makeApp();
		await importInto(app, parsed(), RECIPE, OPTS);
		const before = crosswalkerBlock(files.get('Frameworks/T1078.md')!).recipeHash;

		const editedRows = ROWS.map((r) => (r.id === 'T1078' ? { ...r, tactic: 'Defense Evasion' } : r));
		const editedParsed: ParsedData = { columns: ['id', 'parent', 'tactic'], rows: editedRows, rowCount: editedRows.length };
		await importInto(app, editedParsed, RECIPE, OPTS);
		const after = crosswalkerBlock(files.get('Frameworks/T1078.md')!).recipeHash;

		expect(after).toBe(before);
	});

	it('recipe.hash CHANGES when the recipe target changes (layout, also_emit, or enrichment)', async () => {
		const { app: appLayout, files: filesLayout } = makeApp();
		await importInto(appLayout, parsed(), RECIPE, OPTS);
		const baseHash = crosswalkerBlock(filesLayout.get('Frameworks/T1078.md')!).recipeHash;
		// A SECOND, unrelated import, not a refresh of the first: a different
		// recipe into a different root, run only to compare the two hashes.
		//
		// `new-set-qualified`, which is what the wizard mints for it (AM-13): the
		// two imports share an ontology and a row set, so under `endpoint-v1` they
		// would claim the same curies and AM-12 would refuse the second one
		// wholesale -- leaving no note here to read a hash off.
		await importInto(appLayout, parsed(), RECIPE_WRAPPED_FOLDER, { ...OPTS, basePath: 'Frameworks2' }, 'new-set-qualified');
		const layoutHash = crosswalkerBlock(filesLayout.get('Frameworks2/Wrapped/T1078.md')!).recipeHash;
		expect(layoutHash).not.toBe(baseHash);

		const alsoEmitChanged: Recipe = { ...RECIPE, target: { ...RECIPE.target, also_emit: { ...RECIPE.target.also_emit, tags: ['different-tag'] } } };
		const { app: appAlso, files: filesAlso } = makeApp();
		await importInto(appAlso, parsed(), alsoEmitChanged, OPTS);
		const alsoEmitHash = crosswalkerBlock(filesAlso.get('Frameworks/T1078.md')!).recipeHash;
		expect(alsoEmitHash).not.toBe(baseHash);

		const enrichmentChanged: Recipe = { ...RECIPE, target: { ...RECIPE.target, enrichment: { ...RECIPE.target.enrichment, children_lists: false } } };
		const { app: appEnrich, files: filesEnrich } = makeApp();
		await importInto(appEnrich, parsed(), enrichmentChanged, OPTS);
		const enrichmentHash = crosswalkerBlock(filesEnrich.get('Frameworks/T1078.md')!).recipeHash;
		expect(enrichmentHash).not.toBe(baseHash);
	});

	it('determinism double-run: re-running the identical import produces byte-identical concept_cid and recipe.hash', async () => {
		const { app, files } = makeApp();
		await importInto(app, parsed(), RECIPE, OPTS);
		const first = crosswalkerBlock(files.get('Frameworks/T1078.md')!);

		await importInto(app, parsed(), RECIPE, OPTS); // re-import, unchanged source + recipe
		const second = crosswalkerBlock(files.get('Frameworks/T1078.md')!);

		expect(second.conceptCid).toBe(first.conceptCid);
		expect(second.recipeHash).toBe(first.recipeHash);
	});
});
