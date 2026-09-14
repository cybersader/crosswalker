/**
 * d1-pass23-am77-root-identity.test.ts — AM-77 (2026-09-04, twentieth amendment
 * set): the home note's carried identity is CLAIMED at the site that accounts
 * for it, and the run says which of two things it saw.
 *
 * THE DEFECT THIS PINS. AM-73 carried the home note's recorded curie onto the
 * note, shape-tested it, named it when the test failed, and stopped. The
 * identity was therefore written onto the note and absent from `producedCuries`:
 * the root is excluded from `keptFolders` by construction and its folder IS
 * reached, so it is not among the observed-unjudged curies either. It fell
 * straight into the orphan diff — a Skip run over a hand-edited home note showed
 * the refusal and an orphan report about the same note on one screen, which is
 * exactly what AM-70 rules out in its own text. The quieter half was worse: a
 * recorded curie that PASSES the shape test but simply differs was preserved in
 * silence and reported as gone from the source.
 *
 * The root is the one folder where the preserved and the claimed identity can
 * diverge at all: `recordedHubCurieOf` hands every other held folder's recorded
 * string to Pass B as the hub's curie, so those writers already claim what they
 * preserve.
 *
 * TWO VOICES, NEVER BOTH, each said once per run. "Not a curie of this import"
 * and "this import's, but not this one" send the user to different places.
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
const ONT = 'p23am77';
const ROOT = `${BASE}/${BASE}.md`;
const P1 = `${BASE}/Persistence/P1.md`;
const PERSISTENCE_HUB = `${BASE}/Persistence/Persistence.md`;

function recipe(): Recipe {
	return {
		recipe: 'p23am77-root-identity',
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

const ROWS = [{ id: 'P1', name: 'P one', tactic: 'Persistence' }];
const PARSED: ParsedData = { columns: ['id', 'name', 'tactic'], rows: ROWS, rowCount: 1 };

function run(app: any, overwriteMode: 'skip' | 'replace', importSet: any) {
	return generateFromRecipe(app, PARSED, recipe(), {
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

/** Seed a vault, then hand-edit the home note's recorded identity. */
async function seedWithRecordedRootCurie(recorded: string) {
	const { app, files, modifyCalls, createCalls } = makeApp();
	const first = await run(app, 'replace', 'new');
	expect(first.errors).toEqual([]);
	const setId = frontmatterOf(files.get(P1)!)?._crosswalker?.import_set?.id;
	expect(typeof setId).toBe('string');
	const edited = files.get(ROOT)!.replace(/^curie: .*$/m, `curie: "${recorded}"`);
	expect(edited).toContain(`curie: "${recorded}"`);
	files.set(ROOT, edited);
	modifyCalls.length = 0;
	createCalls.length = 0;
	return { app, files, modifyCalls, createCalls, setId, rootBefore: edited };
}

const messages = (r: { warnings?: { message: string }[] }): string[] => (r.warnings ?? []).map((w) => w.message);
const aboutTheHomeNote = (r: { warnings?: { message: string }[] }): string[] =>
	messages(r).filter((m) => m.includes("home note's recorded identity"));

describe('AM-77: the home note\'s carried identity is claimed where it is carried', () => {
	it('a foreign recorded curie: one exact sentence, no orphan, no write', async () => {
		const { app, files, modifyCalls, createCalls, setId, rootBefore } = await seedWithRecordedRootCurie('other:hub/_root');
		const second = await run(app, 'skip', { id: setId });

		expect(second.errors).toEqual([]);
		expect(aboutTheHomeNote(second)).toEqual([
			'The home note\'s recorded identity "other:hub/_root" is not a curie of this import; it was left as it was.',
		]);
		// The note is accounted under the identity it keeps, so it never enters the
		// orphan diff — and the run still checked, rather than giving up.
		expect(second.orphansChecked).toBe(true);
		expect(second.orphans ?? []).toEqual([]);
		// The fact is what the note records: preserved, never repaired.
		expect(modifyCalls).toEqual([]);
		expect(createCalls).toEqual([]);
		expect(files.get(ROOT)).toBe(rootBefore);
		expect(frontmatterOf(files.get(ROOT)!).curie).toBe('other:hub/_root');
	});

	it('a same-ontology recorded curie that is not this run\'s: the other exact sentence, no orphan, no write', async () => {
		const { app, files, modifyCalls, createCalls, setId, rootBefore } = await seedWithRecordedRootCurie(`${ONT}:hub/home`);
		const second = await run(app, 'skip', { id: setId });

		expect(second.errors).toEqual([]);
		expect(aboutTheHomeNote(second)).toEqual([
			`The home note's recorded identity "${ONT}:hub/home" is not this import's "${ONT}:hub/_root"; it was left as it was.`,
		]);
		// Mutually exclusive: the shape test passed, so the AM-73 sentence is silent.
		expect(messages(second).some((m) => m.includes('is not a curie of this import'))).toBe(false);
		expect(second.orphansChecked).toBe(true);
		expect(second.orphans ?? []).toEqual([]);
		expect(modifyCalls).toEqual([]);
		expect(createCalls).toEqual([]);
		expect(files.get(ROOT)).toBe(rootBefore);
	});

	it('CONTROL: an unedited home note says nothing and writes nothing', async () => {
		const { app, files, modifyCalls, createCalls } = makeApp();
		const first = await run(app, 'replace', 'new');
		expect(first.errors).toEqual([]);
		const setId = frontmatterOf(files.get(P1)!)?._crosswalker?.import_set?.id;
		const rootBefore = files.get(ROOT)!;
		modifyCalls.length = 0;
		createCalls.length = 0;
		const second = await run(app, 'skip', { id: setId });
		expect(second.errors).toEqual([]);
		expect(aboutTheHomeNote(second)).toEqual([]);
		expect(modifyCalls).toEqual([]);
		expect(createCalls).toEqual([]);
		expect(files.get(ROOT)).toBe(rootBefore);
	});

	/**
	 * ONE NOTE KEEPING ONE IDENTITY IS ACCOUNTED, NOT AMBIGUOUS.
	 *
	 * The claim is idempotent for the SAME note: re-recording this run's own root
	 * curie re-claims a string the same note already produced, and that is not a
	 * collision. (The legacy-vault case — where the recorded curie IS
	 * `target.adoptedAlias`, claimed a few lines earlier under the same path — is
	 * the frozen witness in `tests/legacy-vault-refresh.test.ts`, which this file
	 * does not duplicate and does not touch.)
	 */
	it('re-recording this run\'s own root curie is idempotent: no refusal, no voice, no write', async () => {
		const { app, files, modifyCalls, createCalls, setId, rootBefore } = await seedWithRecordedRootCurie(`${ONT}:hub/_root`);
		const second = await run(app, 'skip', { id: setId });
		expect(second.errors).toEqual([]);
		expect(aboutTheHomeNote(second)).toEqual([]);
		expect(modifyCalls).toEqual([]);
		expect(createCalls).toEqual([]);
		expect(files.get(ROOT)).toBe(rootBefore);
	});

	/**
	 * AND A DIFFERENT NOTE HOLDING THE SAME CLAIM IS STILL A REFUSAL BY NAME.
	 *
	 * The self-collision guard the implement leg added is not a relaxation of
	 * AM-31: it exempts only the same note. Here the home note is hand-edited to
	 * record the identity the Persistence index note produces in this very run, so
	 * two DIFFERENT notes claim one identity and the run must say so rather than
	 * let them agree silently.
	 */
	it('a different note already holding the carried curie is refused by name', async () => {
		const { app, files, setId } = await seedWithRecordedRootCurie(`${ONT}:hub/persistence`);
		expect(frontmatterOf(files.get(PERSISTENCE_HUB)!).curie).toBe(`${ONT}:hub/persistence`);
		const second = await run(app, 'skip', { id: setId });
		const text = second.errors.map((e) => e.message).join('\n');
		// Refused by NAME: the identity, and both notes that claim it.
		expect(text).toContain(`${ONT}:hub/persistence`);
		expect(text).toContain(ROOT);
		expect(text).toContain(PERSISTENCE_HUB);
	});
});
