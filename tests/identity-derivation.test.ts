/**
 * identity-derivation.test.ts — AM-27 (2026-08-31): the identity derivation is
 * part of the pinned scheme, and it is injective.
 *
 * THE DEFECT, present since v0.1.0 and found at the deepest possible site. A
 * concept's primary identity WAS its leaf filename stem:
 * `curie = ${curiePrefix}:${deriveFilenameStem(row, mapping, rowNum)}`, and
 * `deriveFilenameStem` ends in `sanitizeFileName`. A filename sanitizer is
 * many-to-one BY DESIGN — that is what makes a string safe for a filesystem —
 * so `a/b` and `a-b`, `A  B` and `A B`, `.x` and `x` all landed on ONE curie.
 * The recipe path went further and sanitized even a row's DECLARED `curie`
 * column, so a source that states its own identity got a different one written
 * into the vault. The SSSOM endpoint sanitizer had the same collapse.
 *
 * Two rows on one curie is not a cosmetic problem. Either they also share an
 * address and one silently overwrites the other, or they take two addresses and
 * the vault permanently holds one identity twice — which the identity index
 * reports as `Ambiguous identity` and which then fails EVERY later import in
 * that vault, from a cause the user cannot connect to the import that caused it.
 *
 * THE TWO HALVES OF THE FIX, AND WHY BOTH ARE NEEDED.
 *
 *   1. The derivation is PINNED PER SET, exactly like the scheme and the
 *      ontology. Correcting the rule for everyone would give every note in every
 *      existing vault a new curie, so the next refresh would recognise none of
 *      the notes it owns, write the whole framework a second time and orphan the
 *      original. Absence of the pin IS the legacy rule — a recorded fact about
 *      those sets, not a missing answer — and only a NEW mint gets the new one.
 *   2. Where sanitization still happens it is INJECTIVE: a value already inside
 *      the target charset passes through untouched, anything else carries a
 *      digest of the exact raw value. Plus a within-run guard that refuses a
 *      second row claiming an identity this run already produced. The guard is
 *      identity-NEUTRAL, so it protects legacy sets too without re-identifying
 *      one note of theirs.
 *
 * The file is organised as: the sanitizers alone, the pin, then the same
 * properties driven end to end through BOTH generation entry points and the
 * SSSOM importer, because a rule that holds in one path and not the others is
 * how this defect survived ten passes.
 */

import { TFile, TFolder } from 'obsidian';
import { generateNotes, generateFromRecipe } from '../src/generation/generation-engine';
import {
	injectiveCurieLocalPart,
	injectiveEndpointToken,
	isValidCurieLocalPart,
} from '../src/generation/curie';
import {
	CURRENT_IMPORT_SET_DERIVATION,
	LEGACY_IMPORT_SET_DERIVATION,
	derivationOf,
	resolveImportSet,
} from '../src/generation/import-set';
import { importSssom, sssomEdgeCurie } from '../src/import/sssom-importer';
import type { App } from 'obsidian';
import type { Recipe } from '../src/render';
import type { ImportRecipe, ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (text: string) => unknown };

// ---------------------------------------------------------------------------
// Vault double. Shared by both entry points so neither can be shown to hold a
// property the other does not.
// ---------------------------------------------------------------------------

function makeApp(seed: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(seed));
	const folders = new Set<string>(['', 'Frameworks']);
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].map((path) => new TFile(path)),
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
		fileManager: {
			renameFile: async (file: TFile, newPath: string) => {
				const content = files.get(file.path);
				if (content === undefined) throw new Error(`Missing source file: ${file.path}`);
				files.delete(file.path);
				files.set(newPath, content);
				file.path = newPath;
			},
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const content = files.get(file.path);
				if (content === undefined) return null;
				const match = /^---\n([\s\S]*?)\n---/.exec(content.replace(/\r\n/g, '\n'));
				if (!match) return { frontmatter: undefined };
				try {
					return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> };
				} catch {
					return { frontmatter: undefined };
				}
			},
		},
	};
	return { app: app as unknown as App, files };
}

/** Every identity actually written to the vault, in path order. */
function curiesIn(files: Map<string, string>): string[] {
	return [...files.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => {
			const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
			const fm = match ? (yaml.load(match[1]) as Record<string, unknown>) : {};
			return String(fm.curie ?? '');
		});
}

function provenanceOf(text: string): Record<string, any> {
	const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
	const fm = match ? (yaml.load(match[1]) as Record<string, any>) : {};
	return fm._crosswalker ?? {};
}

// ---------------------------------------------------------------------------
// The source. The address is deliberately taken from a column (`key`) that no
// identity rule consults, so a test that says "the identity changed" can never
// be a test that says "the file moved".
// ---------------------------------------------------------------------------

const ROWS = [
	// A row that DECLARES its identity, using two characters the spec's curie
	// charset permits and `sanitizeFileName` destroys.
	//
	// AM-28 (2026-08-31): the prefix is `attack:` because that is the prefix this
	// import writes. A declared curie is now honoured VERBATIM, prefix included, or
	// refused by name — the previous behaviour kept only the local part and put the
	// set's own prefix in front of it, so a source stating `nist:AC-2/a` inside an
	// `attack` import had `attack:AC-2/a` written with no error. This fixture used
	// to state exactly that, and so could never observe the substitution.
	{ key: 'r1', curie: 'attack:AC-2/a' },
	// A declared identifier (not a declared curie) that the filename sanitizer
	// collapses onto the next row's.
	{ key: 'r2', id: 'a/b' },
	// The leading-dot collapse.
	{ key: 'r3', id: '.hidden' },
	// Nothing declared at all: the stem is the LAST RESORT, not the first answer.
	{ key: 'r4' },
];

function parsed(rows: Record<string, unknown>[] = ROWS): ParsedData {
	const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	return { columns, rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
}

const RECIPE: Recipe = {
	recipe: 'attack',
	source: { ontology: 'attack', levels: ['leaf'] },
	target: { layout: [{ level: 'leaf', mechanism: 'file', template: '{key}.md' }] },
};

const CONFIG: Partial<ImportRecipe> = {
	name: 'attack',
	mapping: {
		hierarchy: [],
		frontmatter: [],
		links: [],
		body: [],
		filename: { template: '{key}.md', sanitize: true },
	},
};

/** An id that exists only as a REFERENCE — the vault holds none of its notes,
 *  which is the branch that must leave the derivation absent (legacy). */
const LEGACY_SET = { id: 'iset-legacy' } as const;

const nativeOptions = (importSet: unknown) => ({
	basePath: 'Frameworks',
	overwriteMode: 'replace' as const,
	createFolders: true,
	recipeOverride: RECIPE,
	importSet: importSet as never,
});

const recipeOptions = (importSet: unknown) => ({
	basePath: 'Frameworks',
	overwriteMode: 'replace' as const,
	createFolders: true,
	importSet: importSet as never,
});

// ===========================================================================
// 1. The sanitizers, alone.
// ===========================================================================

describe('AM-27: a sanitizer that identity passes through must be injective', () => {
	it('leaves a value the charset already permits exactly as it was', () => {
		// The legibility half of the bargain. If every value paid a digest, a vault
		// full of `AC-2..1f2e3d4c5b` would be the cost of the fix, and the fix would
		// not survive contact with a user.
		for (const raw of ['AC-2', 'AC-2(1)', 'A.9.2.1', 'T1078', 'a/b', '.hidden']) {
			expect(injectiveCurieLocalPart(raw)).toBe(raw);
			expect(isValidCurieLocalPart(injectiveCurieLocalPart(raw))).toBe(true);
		}
	});

	it('separates the values the filename sanitizer collapsed', () => {
		// The three named collapses, each stated as the property that failed: two
		// distinct raw values, two distinct identities.
		expect(injectiveCurieLocalPart('a/b')).not.toBe(injectiveCurieLocalPart('a-b'));
		expect(injectiveCurieLocalPart('A  B')).not.toBe(injectiveCurieLocalPart('A B'));
		expect(injectiveCurieLocalPart('.x')).not.toBe(injectiveCurieLocalPart('x'));
	});

	it('produces a LEGAL curie for a value that had none before', () => {
		// `A B` used to reach the vault with its space intact and fail Tier 1
		// validation, so the row was refused for a reason the source could not act
		// on. Both forms now validate, and they still differ.
		for (const raw of ['A  B', 'A B', 'x:y', 'a?b']) {
			expect(isValidCurieLocalPart(injectiveCurieLocalPart(raw))).toBe(true);
		}
	});

	it('escapes a raw value that already contains the marker, so the two output sets stay disjoint', () => {
		// The load-bearing case. Without it, a raw value containing `..` could equal
		// some OTHER value's escaped form, and the construction would be injective
		// everywhere except at the one point where it is claimed to be.
		expect(injectiveCurieLocalPart('a..b')).not.toBe('a..b');
		expect(injectiveCurieLocalPart('a..b')).not.toBe(injectiveCurieLocalPart('a b'));
		expect(injectiveCurieLocalPart('a..b')).not.toBe(injectiveCurieLocalPart('a/b'));
	});

	it('is deterministic, because an identity that varied per run would be no identity', () => {
		expect(injectiveCurieLocalPart('A  B')).toBe(injectiveCurieLocalPart('A  B'));
		expect(injectiveEndpointToken('x:A')).toBe(injectiveEndpointToken('x:A'));
	});

	it('gives the SSSOM endpoint token the same treatment on its narrower charset', () => {
		// AM-27 bullet 5. `legacySanitizeCuriePart` maps every non-word character to
		// `-`, so `x:A`, `x-A`, `x A` and `x.A` were one endpoint.
		const tokens = ['x:A', 'x-A', 'x A', 'x.A'].map(injectiveEndpointToken);
		expect(new Set(tokens).size).toBe(4);
		expect(injectiveEndpointToken('T1078')).toBe('T1078');
	});
});

// ===========================================================================
// 2. The pin. Which rule a run uses is a fact about the SET.
// ===========================================================================

describe('AM-27: the derivation is pinned per set, and absence is the legacy rule', () => {
	it('reads an unstamped set as the legacy rule rather than as unknown', () => {
		// One reader, so no call site can default by omission. Every note written
		// before the pin existed was written by the legacy rule; that is a recorded
		// fact, and reading it as "unknown" is what would re-identify a vault.
		expect(derivationOf(undefined)).toBe(LEGACY_IMPORT_SET_DERIVATION);
		expect(derivationOf({})).toBe(LEGACY_IMPORT_SET_DERIVATION);
		expect(derivationOf({ derivation: 'declared-facts-v1' })).toBe('declared-facts-v1');
	});

	it('pins a NEW mint to the current rule', async () => {
		const { app } = makeApp();
		const set = await resolveImportSet(app, 'Frameworks', 'new', 'attack');
		expect(set.derivation).toBe(CURRENT_IMPORT_SET_DERIVATION);
	});

	it('leaves the derivation ABSENT for an explicit id whose notes it did not see', async () => {
		// The cache-lag branch. Whole-vault discovery has no raw-frontmatter
		// fallback by design, so "no observations" is not proof of "no notes":
		// minting the current rule here would hand a legacy set's refresh a rule
		// none of its notes were written under, and the run would match nothing it
		// owns and write a duplicate of the entire framework.
		const { app } = makeApp();
		const set = await resolveImportSet(app, 'Frameworks', LEGACY_SET, 'attack');
		expect(set.derivation).toBeUndefined();
		expect(derivationOf(set)).toBe(LEGACY_IMPORT_SET_DERIVATION);
	});

	it('stamps the pin on what it writes, so the next refresh can read it back', async () => {
		// A pin nobody records is not a pin. This is the whole round trip: mint,
		// write, read the note's own provenance.
		const { app, files } = makeApp();
		const result = await generateNotes(app, parsed(), CONFIG, nativeOptions('new'));
		expect(result.errors).toEqual([]);
		const written = [...files.values()][0];
		expect(provenanceOf(written).import_set.derivation).toBe(CURRENT_IMPORT_SET_DERIVATION);
	});

	it('omits the pin for a legacy set, because absence is the recorded state', async () => {
		const { app, files } = makeApp();
		await generateNotes(app, parsed(), CONFIG, nativeOptions(LEGACY_SET));
		const written = [...files.values()][0];
		expect(provenanceOf(written).import_set.derivation).toBeUndefined();
	});
});

// ===========================================================================
// 3. No existing vault re-identifies a note. Both entry points.
// ===========================================================================

describe('AM-27: a legacy set keeps its identities byte-for-byte', () => {
	// Pinned as LITERALS rather than recomputed. A test that derives its
	// expectation from the code under test would follow the code anywhere,
	// which is precisely what must not happen to a frozen rule.

	it('the wizard path still derives a legacy set\'s curies from the filename stem', async () => {
		const { app, files } = makeApp();
		const result = await generateNotes(app, parsed(), CONFIG, nativeOptions(LEGACY_SET));
		expect(result.errors).toEqual([]);
		expect(curiesIn(files)).toEqual(['attack:r1', 'attack:r2', 'attack:r3', 'attack:r4']);
	});

	it('the recipe path still sanitizes a legacy set\'s declared values exactly as it did', async () => {
		// Including the part the amendment calls the defect: `nist:AC-2/a` becomes
		// `AC-2-a`, an identity the source never declared. Kept, because it is what
		// those notes carry.
		const { app, files } = makeApp();
		const result = await generateFromRecipe(app, parsed(), RECIPE, recipeOptions(LEGACY_SET));
		expect(result.errors).toEqual([]);
		expect(curiesIn(files)).toEqual(['attack:AC-2-a', 'attack:a-b', 'attack:hidden', 'attack:row-4']);
	});

	it('a run that names no set MINTS one, so it gets the new rule and owns nothing', async () => {
		// Worth pinning because it is the surprising half. Passing no set is not
		// "the legacy default": AM-9 made it a MINT, deliberately, because a folder
		// is an address and an address does not name an owner. A mint holds no
		// existing notes, so the new rule cannot re-identify anything - the safety
		// argument rests on ownership, not on which rule is the default.
		const { app, files } = makeApp();
		await generateNotes(app, parsed(), CONFIG, nativeOptions(undefined));
		expect(curiesIn(files)).toEqual(['attack:AC-2/a', 'attack:a/b', 'attack:.hidden', 'attack:r4']);
		expect(provenanceOf([...files.values()][0]).import_set.derivation).toBe(CURRENT_IMPORT_SET_DERIVATION);
	});
});

// ===========================================================================
// 4. A new set derives from declared facts. Both entry points.
// ===========================================================================

describe('AM-27: a new set derives identity from what the source declares', () => {
	it('honours a declared curie exactly, on the wizard path', async () => {
		const { app, files } = makeApp();
		const result = await generateNotes(app, parsed(), CONFIG, nativeOptions('new'));
		expect(result.errors).toEqual([]);
		// r1 declared it; r2 and r3 declared an identifier; r4 declared nothing and
		// only THEN falls back to the stem.
		expect(curiesIn(files)).toEqual(['attack:AC-2/a', 'attack:a/b', 'attack:.hidden', 'attack:r4']);
	});

	it('honours a declared curie exactly, on the recipe path', async () => {
		const { app, files } = makeApp();
		const result = await generateFromRecipe(app, parsed(), RECIPE, recipeOptions('new'));
		expect(result.errors).toEqual([]);
		expect(curiesIn(files)).toEqual(['attack:AC-2/a', 'attack:a/b', 'attack:.hidden', 'attack:row-4']);
	});

	it('uses the stem only as a LAST resort, after every declared column', async () => {
		// Stated as the ordering rather than as one row's output: adding a declared
		// column to a row must change its identity away from the address-derived one.
		const bare = parsed([{ key: 'only-a-filename' }]);
		const declared = parsed([{ key: 'only-a-filename', id: 'STATED-1' }]);
		const a = makeApp();
		const b = makeApp();
		await generateNotes(a.app, bare, CONFIG, nativeOptions('new'));
		await generateNotes(b.app, declared, CONFIG, nativeOptions('new'));
		expect(curiesIn(a.files)).toEqual(['attack:only-a-filename']);
		expect(curiesIn(b.files)).toEqual(['attack:STATED-1']);
	});

	it('refuses a declared curie the charset rejects, by name, for THAT row only', async () => {
		// Never "fixed" by a sanitizer. The row SAID what its identity is; quietly
		// rewriting it puts a value in the vault the source never asserted, and
		// merges two rows whose declared curies differ only in a rejected character.
		const rows = [
			{ key: 'good', id: 'AC-1' },
			{ key: 'bad', curie: 'nist:AC 2' },
		];
		const { app, files } = makeApp();
		const result = await generateNotes(app, parsed(rows), CONFIG, nativeOptions('new'));

		const refusal = result.errors.find((error) => error.row === 2);
		expect(refusal).toBeDefined();
		// Names the offending value verbatim, and says what to do about it.
		expect(refusal!.message).toContain('nist:AC 2');
		expect(refusal!.message).toMatch(/curie column/i);
		// The neighbouring row is unaffected: one bad value is not a failed import.
		expect(curiesIn(files)).toEqual(['attack:AC-1']);
		expect(files.has('Frameworks/bad.md')).toBe(false);
	});

	it('names the column rather than silently choosing the next one', async () => {
		// The tempting "repair": fall through to `id` when `curie` is unusable. That
		// writes an identity the source did not declare while its declared one sits
		// in the row, unreported.
		const rows = [{ key: 'bad', curie: 'nist:AC 2', id: 'AC-2' }];
		const { app, files } = makeApp();
		const result = await generateNotes(app, parsed(rows), CONFIG, nativeOptions('new'));
		expect(files.size).toBe(0);
		expect(result.errors[0].message).toContain('nist:AC 2');
	});
});

// ===========================================================================
// 5. Injectivity end to end: what used to collapse now does not.
// ===========================================================================

describe('AM-27: two rows the old rule merged are two notes under the new one', () => {
	const COLLIDING = [
		{ key: 'slash', id: 'a/b' },
		{ key: 'hyphen', id: 'a-b' },
		{ key: 'dotted', id: '.x' },
		{ key: 'plain', id: 'x' },
		{ key: 'spaced', id: 'A  B' },
		{ key: 'single', id: 'A B' },
	];

	it('keeps all six apart on the recipe path', async () => {
		const { app, files } = makeApp();
		const result = await generateFromRecipe(app, parsed(COLLIDING), RECIPE, recipeOptions('new'));
		expect(result.errors).toEqual([]);
		expect(files.size).toBe(6);
		expect(new Set(curiesIn(files)).size).toBe(6);
	});

	it('keeps all six apart on the wizard path', async () => {
		// Asserted as the VALUES, not merely as six distinct strings. The wizard's
		// addresses are already distinct here (they come from `key`), so a
		// distinctness-only assertion would stay green under the legacy rule and
		// prove nothing about the derivation.
		const { app, files } = makeApp();
		const result = await generateNotes(app, parsed(COLLIDING), CONFIG, nativeOptions('new'));
		expect(result.errors).toEqual([]);

		const curies = curiesIn(files).sort();
		expect(curies).toContain('attack:a/b');
		expect(curies).toContain('attack:a-b');
		expect(curies).toContain('attack:.x');
		expect(curies).toContain('attack:x');
		// The whitespace pair is where a digest is actually spent: same readable
		// form, two identities, and the digest is not written out here because
		// pinning it would pin the hash function rather than the property.
		const escaped = curies.filter((curie) => curie.startsWith('attack:A-B..'));
		expect(escaped).toHaveLength(2);
		expect(escaped[0]).not.toBe(escaped[1]);
	});

	it('and the LEGACY rule merged them, which is why this matters', async () => {
		// The frozen record of the defect, driven through the shipped legacy rule
		// rather than asserted from memory. The two character-class pairs collapse
		// onto one identity each; the within-run guard turns the second claimant of
		// each into a named refusal instead of the silent overwrite it used to be.
		const { app, files } = makeApp();
		const result = await generateFromRecipe(app, parsed(COLLIDING.slice(0, 4)), RECIPE, recipeOptions(LEGACY_SET));
		expect(curiesIn(files).sort()).toEqual(['attack:a-b', 'attack:x']);
		expect(result.errors).toHaveLength(2);
		for (const error of result.errors) expect(error.message).toContain('Duplicate identity in this import');
	});

	it('and the whitespace pair reached the vault as an ILLEGAL identity under the legacy rule', async () => {
		// The third collapse is worse than a merge: `sanitizeFileName` normalizes a
		// whitespace run to a single space, which is legal in a filename and illegal
		// in a CURIE. Both rows were refused by Tier 1 validation for a reason no
		// change to the source could fix, since the space was in the source.
		const { app, files } = makeApp();
		const result = await generateFromRecipe(app, parsed(COLLIDING.slice(4)), RECIPE, recipeOptions(LEGACY_SET));
		expect(files.size).toBe(0);
		expect(result.errors.some((error) => /Tier 1 validation failed/.test(error.message))).toBe(true);
	});

	it('gives the SSSOM endpoint sanitizer the same before/after', () => {
		// Pinned per set here too: changing it unconditionally would re-identify
		// every junction note ever imported.
		const pair = (subject: string) => ({ subject_id: subject, object_id: 'y:B' });
		const legacy = { id: 'iset-legacy', scheme: 'endpoint-v1' } as const;
		const fresh = { id: 'iset-fresh1', scheme: 'endpoint-v1', derivation: 'declared-facts-v1' } as const;

		// What is already in vaults: two different endpoints, one edge identity.
		expect(sssomEdgeCurie(pair('x:A'), legacy)).toBe(sssomEdgeCurie(pair('x-A'), legacy));
		expect(sssomEdgeCurie(pair('x:A'), legacy)).toBe('cw-x-A-y-B');
		// What a new set does.
		expect(sssomEdgeCurie(pair('x:A'), fresh)).not.toBe(sssomEdgeCurie(pair('x-A'), fresh));
	});
});

// ===========================================================================
// 6. The within-run guard. Every path, every scheme, including legacy sets.
// ===========================================================================

describe('AM-27: one run never writes two rows onto one identity', () => {
	// Two rows that state the SAME identity. No sanitizer is involved and no
	// derivation can separate them, which is exactly why the guard has to exist
	// independently of the injectivity work.
	const TWINS = [
		{ key: 'first', id: 'AC-2' },
		{ key: 'second', id: 'AC-2' },
	];

	it('writes one note and reports the second row, on the wizard path', async () => {
		const { app, files } = makeApp();
		const result = await generateNotes(app, parsed(TWINS), CONFIG, nativeOptions('new'));

		expect(files.size).toBe(1);
		expect(files.has('Frameworks/first.md')).toBe(true);
		// The second row never reserved its address either: a row this run declines
		// to write must not cost a render, a folder or a produced count.
		expect(files.has('Frameworks/second.md')).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].row).toBe(2);
		// Names the identity, the first claimant AND where it went, so the user can
		// see which two rows disagree rather than being told a count.
		expect(result.errors[0].message).toContain('attack:AC-2');
		expect(result.errors[0].message).toContain('row 1');
		expect(result.errors[0].message).toContain('Frameworks/first.md');
	});

	it('writes one note and reports the second row, on the recipe path', async () => {
		const { app, files } = makeApp();
		const result = await generateFromRecipe(app, parsed(TWINS), RECIPE, recipeOptions('new'));

		expect(files.size).toBe(1);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].message).toContain('Duplicate identity in this import');
		expect(result.errors[0].message).toContain('attack:AC-2');
	});

	it('holds on a LEGACY-pinned set, because the guard changes no identity', async () => {
		// The retroactivity claim, stated where it can fail. The guard only refuses
		// to write a duplicate; it re-identifies nothing, so it is safe to apply to
		// sets that must keep their existing curies forever.
		const { app, files } = makeApp();
		const result = await generateNotes(app, parsed([
			{ key: 'same-stem', id: 'ignored-by-legacy' },
			{ key: 'same-stem', id: 'also-ignored' },
		]), CONFIG, nativeOptions(LEGACY_SET));

		expect(curiesIn(files)).toEqual(['attack:same-stem']);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].message).toContain('Duplicate identity in this import');
	});

	it('holds on the SSSOM path, where the collapse is in the endpoint pair', async () => {
		// Two rows whose endpoints differ only in a character the endpoint sanitizer
		// used to erase. Before the guard the second row's assertion silently
		// replaced the first's, in the notes a compliance claim is built out of.
		// Every column the bundled crosswalk recipe renders is present. A TSV
		// missing one fails every row inside render() instead, which would leave
		// this test green about nothing.
		const tsv = [
			'# subject_source: "x"',
			'# object_source: "y"',
			'subject_id\tpredicate_id\tobject_id\tmapping_set_id\tsubject_label\tobject_label\tmapping_justification\tconfidence',
			'x:A\tskos:exactMatch\ty:B\tset:one\tA\tB\tsemapv:ManualMappingCuration\t1',
			'x:A\tskos:closeMatch\ty:B\tset:one\tA\tB\tsemapv:ManualMappingCuration\t1',
		].join('\n');
		const { app, written } = makeSssomApp();

		const result = await importSssom(app, tsv, null, null, {
			runTier2Projection: false,
			importSet: { id: 'iset-legacy', scheme: 'endpoint-v1' } as never,
		});

		const notes = [...written.keys()].filter((path) => path.endsWith('.md'));
		expect(notes).toHaveLength(1);
		expect(result.generation!.errors).toHaveLength(1);
		expect(result.generation!.errors[0].message).toContain('Duplicate identity in this import');
	});
});

/**
 * The SSSOM importer drives `generateFromRecipe` through its own options, so it
 * needs a vault double shaped the way that importer expects (an adapter, a
 * folder set it creates through, and `processFrontMatter`). Kept local and
 * minimal rather than imported, so this file states its own preconditions.
 */
function makeSssomApp(): { app: App; written: Map<string, string> } {
	const written = new Map<string, string>();
	const folders = new Set<string>();
	const app = {
		vault: {
			getMarkdownFiles: () => [...written.keys()]
				.filter((path) => path.endsWith('.md'))
				.map((path) => ({ path, basename: path.split('/').pop()?.replace(/\.md$/, '') ?? path, extension: 'md' })),
			// The importer asks the adapter whether its destination exists before it
			// creates one. Without it every row fails at the folder, not the guard.
			adapter: {
				exists: async (path: string) => written.has(path) || folders.has(path),
				mkdir: async (path: string) => { folders.add(path); },
			},
			getAbstractFileByPath: (path: string) => {
				if (folders.has(path)) return { path, children: [] } as never;
				if (written.has(path)) return { path, extension: 'md' } as never;
				return null;
			},
			create: async (path: string, content: string) => { written.set(path, content); return { path } as never; },
			modify: async (file: { path: string }, content: string) => { written.set(file.path, content); },
			read: async (file: { path: string }) => written.get(file.path) ?? '',
			cachedRead: async (file: { path: string }) => written.get(file.path) ?? '',
			createFolder: async (path: string) => { folders.add(path); },
		},
		metadataCache: {
			getFileCache: (file: { path: string }) => {
				const content = written.get(file.path);
				if (content === undefined) return null;
				const match = /^---\n([\s\S]*?)\n---/.exec(content.replace(/\r\n/g, '\n'));
				if (!match) return { frontmatter: undefined };
				try {
					return { frontmatter: (yaml.load(match[1]) ?? {}) as Record<string, unknown> };
				} catch {
					return { frontmatter: undefined };
				}
			},
		},
		fileManager: {
			processFrontMatter: async () => { /* not reached by these rows */ },
			renameFile: async () => { /* not reached by these rows */ },
		},
	};
	return { app: app as unknown as App, written };
}
