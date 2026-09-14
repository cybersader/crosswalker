/**
 * set-qualified-roundtrip.test.ts — AM-34 (2026-09-01): a declared prefix is
 * checked against the BASE ontology, and qualification is an open, invertible
 * transform.
 *
 * THE DEFECT THIS FILE PINS. AM-28 made a declared `curie` verbatim-or-refused,
 * and checked its prefix against the prefix the run would actually WRITE. For a
 * second release of a framework that prefix is `nist-iset-<id>` — an id that
 * does not exist until the import runs. Crosswalker's own CSV export writes
 * `curie` as its FIRST column, so:
 *
 *   export a framework  ->  re-import it as a second release  ->  EVERY ROW REFUSED
 *
 * with a message telling the user to rewrite their source using a set id nobody
 * could have known. That is the release-isolation flow and the v0.1.7
 * portability round-trip, both closed by the identity rule meant to protect them.
 *
 * WHAT REPLACES IT, and why it is not the silent rewrite AM-28 forbids. The
 * check is against the set's BASE ontology prefix — the thing a source is
 * entitled to state and always will state. Set-qualification is then applied
 * afterwards as what it already was: a UNIFORM re-prefixing, identical for every
 * row, recorded on every note it touches (`_crosswalker.import_set` carries the
 * scheme and the id), and therefore invertible. Distinct declared curies stay
 * exactly as distinct as the source made them, and export puts the base form
 * back, so the round trip is identity rather than a refusal. A genuinely foreign
 * prefix still refuses by name — which is what that refusal is for.
 *
 * HOW THESE READ. The transform's two halves are pinned as pure functions
 * first (they must be exact inverses, or nothing below is safe), then the whole
 * flow is run end to end through the real generation engine and the real CSV
 * exporter, because "the round trip works" is a claim about the product and not
 * about a helper.
 */

import { TFile, TFolder } from 'obsidian';
import {
	generateFromRecipe,
	curiePrefixFor,
	baseCuriePrefixFor,
} from '../src/generation/generation-engine';
import { baseFormCurie, exportFolderAsCsv } from '../src/export/csv-exporter';
import type { App } from 'obsidian';
import type { Recipe } from '../src/render';
import type { ImportSetOption, ImportSetReference } from '../src/generation/import-set';
import type { ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (s: string) => unknown };

const ONTOLOGY = 'nist';
const SET_ID = 'iset-abc123';
const QUALIFIED: ImportSetReference = { id: SET_ID, scheme: 'set-qualified-v1', ontology: ONTOLOGY };
const PLAIN: ImportSetReference = { id: 'iset-zzz999', scheme: 'endpoint-v1', ontology: ONTOLOGY };

// ---------------------------------------------------------------------------
// The transform, as a pair of pure functions. Exact inverses or nothing holds.
// ---------------------------------------------------------------------------

describe('AM-34: qualification and its inverse', () => {
	it('undoes exactly what curiePrefixFor applies', () => {
		expect(curiePrefixFor(QUALIFIED, ONTOLOGY)).toBe(`${ONTOLOGY}-${SET_ID}`);
		expect(baseCuriePrefixFor(QUALIFIED, ONTOLOGY)).toBe(ONTOLOGY);
	});

	it('is the identity on an unqualified set, where there is nothing to undo', () => {
		expect(curiePrefixFor(PLAIN, ONTOLOGY)).toBe(ONTOLOGY);
		expect(baseCuriePrefixFor(PLAIN, ONTOLOGY)).toBe(ONTOLOGY);
	});

	it('stays idempotent on a legacy set whose pin already carries the id', () => {
		// `curiePrefixFor` is deliberately idempotent (AM-13): a legacy set-qualified
		// set recovers its ontology from the prefix its own notes show, which is
		// already qualified, and re-appending would rename every note it owns. The
		// inverse has to agree, or the two disagree about the same set.
		const legacy = `${ONTOLOGY}-${SET_ID}`;
		expect(curiePrefixFor(QUALIFIED, legacy)).toBe(legacy);
		expect(baseCuriePrefixFor(QUALIFIED, legacy)).toBe(ONTOLOGY);
	});
});

describe('AM-34: the exporter writes the base form back', () => {
	const stamp = (scheme: string, id: string) => ({ _crosswalker: { import_set: { scheme, id } } });

	it('strips the set id a set-qualified run put in front', () => {
		expect(baseFormCurie(`${ONTOLOGY}-${SET_ID}:AC-2`, stamp('set-qualified-v1', SET_ID)))
			.toBe(`${ONTOLOGY}:AC-2`);
	});

	it('leaves an unqualified set alone', () => {
		expect(baseFormCurie(`${ONTOLOGY}:AC-2`, stamp('endpoint-v1', 'iset-zzz999'))).toBe(`${ONTOLOGY}:AC-2`);
	});

	it('returns anything that does not match the recorded transform untouched', () => {
		// A guess about somebody else's identifier is worse than leaving it alone.
		// Covered: no provenance at all, a stamp whose id is not in the prefix, and a
		// value that is not a curie.
		expect(baseFormCurie(`${ONTOLOGY}:AC-2`, {})).toBe(`${ONTOLOGY}:AC-2`);
		expect(baseFormCurie('other-iset-nope:AC-2', stamp('set-qualified-v1', SET_ID))).toBe('other-iset-nope:AC-2');
		expect(baseFormCurie('AC-2', stamp('set-qualified-v1', SET_ID))).toBe('AC-2');
	});

	it('never strips a prefix down to nothing', () => {
		// A prefix that IS the suffix would leave an empty identity space, which is
		// not a base form of anything.
		expect(baseFormCurie(`-${SET_ID}:AC-2`, stamp('set-qualified-v1', SET_ID))).toBe(`-${SET_ID}:AC-2`);
	});

	it('keeps the local part byte-for-byte, punctuation included', () => {
		// The whole point of verbatim-or-refused: the half the source wrote is not
		// touched on the way out any more than on the way in.
		expect(baseFormCurie(`${ONTOLOGY}-${SET_ID}:AC-2(1)/a`, stamp('set-qualified-v1', SET_ID)))
			.toBe(`${ONTOLOGY}:AC-2(1)/a`);
	});
});

// ---------------------------------------------------------------------------
// The flow, end to end, through the real engine and the real exporter.
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
	const fileObj = (p: string) => {
		const f = new TFile(p) as unknown as Record<string, unknown>;
		const base = p.split('/').pop() ?? p;
		const dot = base.lastIndexOf('.');
		f.basename = dot > 0 ? base.slice(0, dot) : base;
		f.extension = dot > 0 ? base.slice(dot + 1) : '';
		return f as unknown as TFile;
	};
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map(fileObj),
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return fileObj(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			create: async (path: string, content: string) => { files.set(path, content); return fileObj(path); },
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
				try {
					return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> };
				} catch {
					return { frontmatter: undefined };
				}
			},
		},
		fileManager: { renameFile: rename },
	};
	return { app: app as unknown as App, files };
}

const BASE = 'Frameworks';
/** A second release's destination. Separate, so neither run can adopt the other's notes by address. */
const OTHER_BASE = 'Frameworks-r2';

function parsed(rows: Record<string, unknown>[]): ParsedData {
	const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	return { columns, rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
}

const RECIPE: Recipe = {
	recipe: 'roundtrip',
	source: { ontology: ONTOLOGY, levels: ['leaf'] },
	target: {
		layout: [{ level: 'leaf', mechanism: 'file', template: '{title|fs-safe}.md' }],
		enrichment: { children_lists: false, facet_notes: 'none', level_hubs: 'none' },
	},
};

function run(app: App, rows: Record<string, unknown>[], importSet: ImportSetOption, basePath = BASE) {
	return generateFromRecipe(app, parsed(rows), RECIPE, {
		basePath,
		overwriteMode: 'replace',
		createFolders: true,
		sourceFileName: 'source.csv',
		importSet,
	});
}

/**
 * Mint a NEW set-qualified set and import into it. `new-set-qualified` is the
 * option the product itself takes when an ontology prefix is already occupied
 * (`newSetSchemeFrom`), and it is the only branch that mints under the current
 * identity derivation, so it is what a real second release actually runs.
 */
async function runQualified(app: App, rows: Record<string, unknown>[], basePath = BASE) {
	const result = await run(app, rows, 'new-set-qualified', basePath);
	return result;
}

/** The import set id a run minted, read back off a note it wrote. */
function setIdUnder(files: Map<string, string>, root: string): string {
	for (const [path, text] of files) {
		if (!path.startsWith(`${root}/`)) continue;
		const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
		if (!match) continue;
		const fm = (yaml.load(match[1]) ?? {}) as any;
		const id = fm?._crosswalker?.import_set?.id;
		if (typeof id === 'string') return id;
	}
	throw new Error(`no import set id found under ${root}`);
}

/** Every identity actually written under `root`, sorted. */
function curiesUnder(files: Map<string, string>, root: string): string[] {
	const out: string[] = [];
	for (const [path, text] of files) {
		if (!path.startsWith(`${root}/`)) continue;
		const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
		if (!match) continue;
		const fm = (yaml.load(match[1]) ?? {}) as Record<string, unknown>;
		if (typeof fm.curie === 'string') out.push(fm.curie);
	}
	return out.sort();
}

/** The `curie` column of an exported CSV, sorted. Papa quotes any cell it must. */
function curieColumnOf(csv: string): string[] {
	return csv
		.split('\n')
		.slice(1)
		.filter((line) => line.trim() !== '')
		.map((line) => (line.startsWith('"') ? line.slice(1, line.indexOf('"', 1)) : line.split(',')[0]))
		.sort();
}

/** The rows a source states. Two distinct identifiers, one of them heavily punctuated. */
const SOURCE = [
	{ curie: `${ONTOLOGY}:AC-2`, title: 'Account Management' },
	{ curie: `${ONTOLOGY}:AC-2(1)/a`, title: 'Automated System Account Management' },
];

describe('AM-34: a set-qualified import accepts the base-ontology curies its own export writes', () => {
	it('accepts every declared base-prefix row, refusing none', async () => {
		// The flagship flow. Before this, all of these were refused, each with an
		// instruction to rewrite the source using a set id invented by the run that
		// was refusing it.
		const { app } = makeApp();
		const result = await runQualified(app, SOURCE);
		expect(result.errors).toEqual([]);
		expect(result.created).toHaveLength(2);
	});

	it('writes them under the set-qualified prefix, with the declared local part verbatim', async () => {
		// Uniform: the same prefix in front of every row, and the half the source
		// wrote untouched, punctuation included. That is what makes the transform
		// invertible rather than a rewrite of somebody's identifier.
		const { app, files } = makeApp();
		await runQualified(app, SOURCE);
		const setId = setIdUnder(files, BASE);
		expect(curiesUnder(files, BASE)).toEqual([
			`${ONTOLOGY}-${setId}:AC-2`,
			`${ONTOLOGY}-${setId}:AC-2(1)/a`,
		]);
	});

	it('keeps distinct declared curies distinct through qualification', async () => {
		// A uniform re-prefixing cannot merge two identifiers. Stated as its own
		// declaration because a transform that collapsed them would still satisfy
		// "no refusals", and the collapse is the silent data loss.
		const { app, files } = makeApp();
		const result = await runQualified(app, SOURCE);
		expect(result.errors).toEqual([]);
		expect(new Set(curiesUnder(files, BASE)).size).toBe(2);
	});

	it('round-trips: export the set, re-import the export, and the local parts are identical', async () => {
		// The acceptance case, run rather than argued. Export writes the BASE form
		// back, so the file it produces is a file this product can read; re-importing
		// it as a second release reproduces the same local parts under that release's
		// own prefix, which is exactly what release isolation means.
		const { app, files } = makeApp();
		const first = await runQualified(app, SOURCE);
		expect(first.errors).toEqual([]);

		const exported = await exportFolderAsCsv(app, BASE);
		const curieColumn = curieColumnOf(exported.csv);
		expect(curieColumn).toEqual([`${ONTOLOGY}:AC-2`, `${ONTOLOGY}:AC-2(1)/a`]);

		// Re-import that exported file as a SECOND release, into its own destination.
		const second = await runQualified(
			app,
			curieColumn.map((curie, i) => ({ curie, title: `Round trip ${i}` })),
			OTHER_BASE,
		);
		expect(second.errors).toEqual([]);
		const otherId = setIdUnder(files, OTHER_BASE);
		expect(curiesUnder(files, OTHER_BASE)).toEqual([
			`${ONTOLOGY}-${otherId}:AC-2`,
			`${ONTOLOGY}-${otherId}:AC-2(1)/a`,
		]);
	});

	it('proves the two releases really are two identity spaces, so the round trip is not a merge', () => {
		// The anti-vacuity control for the declaration above: if the second import
		// had simply landed on the first set's identities, "no refusals" would still
		// hold and release isolation would be gone.
		expect(curiePrefixFor({ id: 'iset-aaa111', scheme: 'set-qualified-v1' }, ONTOLOGY))
			.not.toBe(curiePrefixFor({ id: 'iset-bbb222', scheme: 'set-qualified-v1' }, ONTOLOGY));
	});

	it('still refuses a genuinely foreign prefix, by name, on that row alone', async () => {
		// The refusal AM-28 exists for is untouched: `other:` is not this ontology
		// under any transform, and Crosswalker will not change an identity a source
		// states. The neighbouring row is unaffected, because a refusal is per row.
		const { app, files } = makeApp();
		const result = await runQualified(app, [
			{ curie: 'other:AC-2', title: 'Foreign' },
			{ curie: `${ONTOLOGY}:AC-3`, title: 'Ours' },
		]);

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].message).toContain('other:AC-2');
		const setId = setIdUnder(files, BASE);
		expect(curiesUnder(files, BASE)).toEqual([`${ONTOLOGY}-${setId}:AC-3`]);
	});

	it('names the ontology a source can actually state, never the set id', async () => {
		// The message is the other half of the defect: it used to demand a prefix
		// containing an id that does not exist until the import runs, so the action
		// it offered could not be taken.
		const { app, files } = makeApp();
		const result = await runQualified(app, [
			{ curie: 'other:AC-2', title: 'Foreign' },
			{ curie: `${ONTOLOGY}:AC-3`, title: 'Ours' },
		]);

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].message).toContain(`"${ONTOLOGY}"`);
		expect(result.errors[0].message).not.toContain(setIdUnder(files, BASE));
	});

	it('leaves an ordinary unqualified import exactly as it was', async () => {
		// The control, and the AM-27 pinning obligation: the sets that already exist
		// keep the identities they already wrote.
		const { app, files } = makeApp();
		const result = await run(app, SOURCE, 'new');
		expect(result.errors).toEqual([]);
		expect(curiesUnder(files, BASE)).toEqual([`${ONTOLOGY}:AC-2`, `${ONTOLOGY}:AC-2(1)/a`]);
	});
});
