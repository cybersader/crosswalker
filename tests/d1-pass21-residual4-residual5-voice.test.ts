/**
 * d1-pass21-residual4-residual5-voice.test.ts -- residual rulings 4 and 5
 * (2026-09-04, pass 20 rulings, closed with tests by pass 21's Task C item
 * 7): two more states an `OwnedHubAtFolder` can carry, each with its own
 * voice, and neither one repaired.
 *
 * RESIDUAL 4, AS AMENDED BY AM-68 (2026-09-04, pass 22). `withheld` (S12: the
 * note records a DIFFERENT folder) and an unreadable note are TWO different
 * facts with two different voices. Pass 20 folded the unreadable note into
 * `withheld`, which silenced a folder the run has something true to say about;
 * pass 21 gave the FOLDER an `unreadable` state and made it speak as AM-55's
 * row 2, which said the folder's INDEX NOTE could not be read on the strength of
 * ANY unreadable owned note - a claim about a note the run may never have seen.
 * AM-68 keeps the observation where it was observed: `withheld` stays silent
 * here (the caller's warning is the one voice), and a folder with no readable
 * index note carrying an unreadable note is AM-55's row 3 with a qualifier that
 * states only the observation. This file also closes the other half at the
 * ENGINE level: an
 * S12-withheld folder's warnings contain the caller's own message and
 * NOTHING ELSE about that same folder -- no duplicate row-3 text riding
 * alongside it.
 *
 * RESIDUAL 5. A recorded curie that is not this import's (a foreign prefix,
 * or no prefix at all) is named, once, and never repaired or re-derived --
 * even when the note's recorded VALUES are perfectly usable and would,
 * ordinarily, exempt the folder outright (AM-55 row 1). The shape check
 * (`isCurieOfThisOntology`) is asked BEFORE row 1, so a usable chain cannot
 * paper over an identity this import never minted.
 */

import { TFile, TFolder } from 'obsidian';
import { enrich, type EnrichNote, type OwnedHubsByFolder } from '../src/generation/enrich';
import { generateFromRecipe } from '../src/generation/generation-engine';
import type { Recipe } from '../src/render';
import type { ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

const ONT = 'r45';
const HUB_CONFIG = { children_lists: true, facet_notes: 'none' as const, level_hubs: 'notes' as const };
const ROOT = 'Frameworks';
const FOLDER = `${ROOT}/Persistence`;
const NOTHING_WRITABLE: ReadonlySet<string> = new Set<string>();

/** A single kept row holding FOLDER, recategorised to a different folder this run. */
function keptNote(): EnrichNote {
	return {
		path: `${FOLDER}/T1.md`,
		renderedPath: `${ROOT}/IA/T1.md`,
		curie: `${ONT}:t1`,
		frontmatter: {},
		facets: [],
		layoutValues: [{ level: 'tactic', value: 'IA' }],
	};
}

const hubByPath = (result: ReturnType<typeof enrich>, path: string) =>
	result.levelHubs.notes.find((h) => h.path === path);
const deviationFor = (result: ReturnType<typeof enrich>, folder: string) =>
	result.deviations.find((d) => d.includes(`"${folder}"`));

// ---------------------------------------------------------------------------
// Residual 4: `unreadable` is its own voice (row 2), distinct from `withheld`
// (silent), at the enrich() level.
// ---------------------------------------------------------------------------

describe('Residual ruling 4, as amended by AM-68: an unreadable NOTE qualifies row 3, and never speaks as row 2 about an index note', () => {
	it('the deviation is the exact qualified row-3 text, nothing is accounted, and no hub is written', () => {
		// AM-67 / AM-68 (2026-09-04). RE-POINTED TO THE AMENDMENT THAT CHANGED IT.
		//
		// Residual ruling 4 (pass 20) gave the FOLDER an `unreadable` state and made
		// it speak as AM-55's row 2 ("its recorded identity could not be read"). The
		// state was set by any owned note the run could not read - the walk's
		// `kind: 'hub'` filter sits BELOW the unreadable branch - so a cache-cold
		// concept note made the run assert something about an index note it may never
		// have seen, and the sticky guard then discarded the readable index note
		// sitting beside it. AM-68 withdraws the folder-level state: the unreadable
		// note stays a note-level fact, and a folder with no readable index note is
		// AM-55's row 3 with a qualifier that says only what was observed.
		//
		// So the fixture is the state the walk can now produce (no readable index
		// note in the folder, and something in it unreadable), and the assertion is
		// the pass-22 tree's own text, verbatim.
		const ownedHubsByFolder: OwnedHubsByFolder = new Map([[FOLDER, { state: 'absent', hasUnreadableNote: true }]]);
		const result = enrich([keptNote()], {
			ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder, writeSet: NOTHING_WRITABLE,
		});

		expect(hubByPath(result, `${FOLDER}/Persistence.md`)).toBeUndefined();
		const deviation = deviationFor(result, FOLDER);
		expect(deviation).toBe(
			`No index note of this import could be read in the folder "${FOLDER}"; a note in it could not be read `
			+ 'this run. The notes in it were kept in place by Skip existing. Wait for Obsidian to finish '
			+ "indexing the vault, then run the import again. Any list that still names this folder's index note "
			+ 'is left as it was.',
		);
		// AM-68. It never claims something about the folder's INDEX NOTE, which is
		// the claim the run has no evidence for.
		expect(deviation).not.toContain('The index note for the folder');
		expect(deviation).not.toContain('its recorded identity could not be read');
		// Residual ruling 4, as implemented: nothing is accounted here -- the run
		// could not read the note, so it has no identity to vouch for.
		expect(result.levelHubs.keptExistingCuries).toEqual([]);
	});

	it('CONTROL: the SAME folder as `withheld` (S12) instead gets total silence from this pass -- proving the qualified row 3 is a genuinely different voice, not the same suppression under a new name', () => {
		const ownedHubsByFolder: OwnedHubsByFolder = new Map([[FOLDER, { state: 'withheld' }]]);
		const result = enrich([keptNote()], {
			ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder, writeSet: NOTHING_WRITABLE,
		});
		expect(deviationFor(result, FOLDER)).toBeUndefined();
		expect(result.levelHubs.keptExistingCuries).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Residual 5: a recorded curie foreign to this ontology is named, accounted,
// and never repaired -- even with a usable values chain that would otherwise
// exempt the folder under row 1.
// ---------------------------------------------------------------------------

describe('Residual ruling 5: a recorded curie that is not this import\'s is reported, never repaired or re-derived', () => {
	it('a foreign-prefix curie, even WITH usable recorded values, is refused with the row-2 "not a curie of this import" text -- not silently exempted by row 1', () => {
		const FOREIGN_CURIE = 'someotherplugin:hub/persistence';
		const ownedHubsByFolder: OwnedHubsByFolder = new Map([
			[FOLDER, {
				state: 'one',
				path: `${FOLDER}/Persistence.md`,
				curie: FOREIGN_CURIE,
				values: [{ level: 'tactic', value: 'Persistence' }], // usable -- would ordinarily be row 1.
			}],
		]);
		const result = enrich([keptNote()], {
			ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder, writeSet: NOTHING_WRITABLE,
		});

		// Not written under the foreign identity...
		expect(hubByPath(result, `${FOLDER}/Persistence.md`)).toBeUndefined();
		// ...and not RE-DERIVED under this ontology's own scheme either -- no hub
		// anywhere in the result carries the curie this run's derivation would mint.
		expect(result.levelHubs.notes.some((h) => h.curie === `${ONT}:hub/persistence`)).toBe(false);

		const deviation = deviationFor(result, FOLDER);
		expect(deviation).toContain('its recorded identity is not a curie of this import');
		expect(deviation).toContain('Re-run with Replace to re-establish it');
		// The foreign curie IS accounted for: the note demonstrably exists, this
		// run just read it, and it must not be reported as an orphan on top of
		// being refused.
		expect(result.levelHubs.keptExistingCuries).toEqual([FOREIGN_CURIE]);
	});

	it('a curie with no ontology prefix at all (no colon) is refused the same way', () => {
		const MALFORMED = 'not-a-curie-at-all';
		const ownedHubsByFolder: OwnedHubsByFolder = new Map([
			[FOLDER, { state: 'one', path: `${FOLDER}/Persistence.md`, curie: MALFORMED, values: [{ level: 'tactic', value: 'Persistence' }] }],
		]);
		const result = enrich([keptNote()], {
			ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder, writeSet: NOTHING_WRITABLE,
		});
		expect(hubByPath(result, `${FOLDER}/Persistence.md`)).toBeUndefined();
		expect(deviationFor(result, FOLDER)).toContain('its recorded identity is not a curie of this import');
		expect(result.levelHubs.keptExistingCuries).toEqual([MALFORMED]);
	});

	it("CONTROL: the SAME values, under this ontology's OWN prefix, exempt the folder normally (row 1) -- proving the refusal above is about the PREFIX, not the values", () => {
		const OWN_CURIE = `${ONT}:hub/persistence`;
		const ownedHubsByFolder: OwnedHubsByFolder = new Map([
			[FOLDER, { state: 'one', path: `${FOLDER}/Persistence.md`, curie: OWN_CURIE, values: [{ level: 'tactic', value: 'Persistence' }] }],
		]);
		const result = enrich([keptNote()], {
			ontology: ONT, config: HUB_CONFIG, rootFolder: ROOT, ownedHubsByFolder, writeSet: NOTHING_WRITABLE,
		});
		const hub = hubByPath(result, `${FOLDER}/Persistence.md`);
		expect(hub).toBeDefined();
		expect(hub!.curie).toBe(OWN_CURIE);
		expect(deviationFor(result, FOLDER)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Item 7 (engine level): an S12-withheld folder's warnings carry ONLY the
// caller's own S12 message about that folder -- never a second, row-3-style
// message riding alongside it.
// ---------------------------------------------------------------------------

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
			getFiles: () => [...files.keys()].map((p) => new TFile(p)),
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
				try { return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> }; }
				catch { return { frontmatter: undefined }; }
			},
		},
		fileManager: { renameFile: rename },
	};
	return { app: app as any, files };
}

const BASE = 'Ontologies';
const ONT2 = 's12voice';

function recipe(): Recipe {
	return {
		recipe: 's12-voice',
		source: { ontology: ONT2, levels: ['tactic', 'leaf'] },
		target: {
			layout: [
				{ level: 'tactic', mechanism: 'folder', template: '{tactic}' },
				{ level: 'leaf', mechanism: 'file', template: '{id}.md' },
			],
			enrichment: { children_lists: true, facet_notes: 'none', parent_note: 'sibling', level_hubs: 'notes' },
		},
	};
}

function parsedTwoFamilies(): ParsedData {
	const rows = [
		{ id: 'T1', name: 'One', tactic: 'Family-A' },
		{ id: 'T2', name: 'Two', tactic: 'Family-B' },
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

describe('Item 7, engine level: an S12-withheld folder\'s warnings carry the S12 message and nothing else about that folder', () => {
	it('no duplicate row-3 "no index note" text rides alongside the S12 warning for the SAME folder', async () => {
		const { app, files } = makeApp();
		const first = await run(app, parsedTwoFamilies(), 'replace', 'new');
		expect(first.errors).toEqual([]);
		const hubAPath = `${BASE}/Family-A/Family-A.md`;
		const setId = frontmatterOf(files.get(`${BASE}/Family-A/T1.md`)!)?._crosswalker?.import_set?.id;
		expect(typeof setId).toBe('string');

		// Hand-drag Family-A's hub note into Family-B's folder, keeping its OWN
		// hub_values ("Family-A") untouched -- the S12 shape.
		const draggedPath = `${BASE}/Family-B/Family-A.md`;
		files.set(draggedPath, files.get(hubAPath)!);
		files.delete(hubAPath);

		const second = await run(app, parsedTwoFamilies(), 'skip', { id: setId });
		expect(second.errors).toEqual([]);

		const messages = (second.warnings ?? []).map((w) => w.message);
		const aboutFamilyB = messages.filter((m) => m.includes(`${BASE}/Family-B`));
		// Exactly one message mentions Family-B, and it is the S12 one -- not a
		// SECOND message also claiming "no index note of this import was found"
		// for the very folder the S12 warning just named a note inside.
		expect(aboutFamilyB.length).toBe(1);
		expect(aboutFamilyB[0]).toContain('records the identity of a different folder');
		expect(aboutFamilyB[0]).not.toContain('no index note');
	});
});
