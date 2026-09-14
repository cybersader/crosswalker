/**
 * declared-curie-exactness.test.ts — AM-28 (2026-08-31): the hash sees the exact
 * raw, and a declared curie is honoured verbatim or refused by name.
 *
 * WHAT PASS 11 FOUND. AM-27 built an injective escaper and then fed it a value
 * that had already been through `stripCuriePrefix`, which is many-to-one. The
 * digest therefore never saw the part the stripper removed, so two distinct
 * declared identifiers produced ONE curie — disambiguating hash included — in the
 * rule written to make that impossible:
 *
 *     id: "nist:AC 2"  ->  AC-2..1922ea761b
 *     id: "AC 2"       ->  AC-2..1922ea761b      <- the same identity
 *
 * And the same line discarded a declared curie's PREFIX and put the set's own in
 * front of the surviving local part, so a source stating `other:AC-2` had
 * `nist:AC-2` written into the vault with no error: an identity the source never
 * asserted, joinable back to nothing, with `other:AC-2`, `nist:AC-2` and a bare
 * `AC-2` all collapsing onto one note.
 *
 * WHY THIS IS NOT COSMETIC. Two rows on one curie is either a silent overwrite,
 * or two files permanently holding one identity — which the identity index reports
 * as `Ambiguous identity` and which then fails EVERY later import in that vault,
 * from a cause the user cannot connect to the import that caused it.
 *
 * The file is organised as the two functions alone (where the repro table from the
 * pass-11 dump is pinned verbatim), then the same properties driven end to end
 * through both generation entry points, because a rule that holds in one path and
 * not the others is how the defect underneath it survived eleven passes.
 */

import { TFile, TFolder } from 'obsidian';
import { generateNotes, generateFromRecipe } from '../src/generation/generation-engine';
import {
	DeclaredCurieCharsetError,
	DeclaredCuriePrefixError,
	declaredCurieLocalPart,
	injectiveCurieLocalPart,
	injectiveDeclaredIdLocalPart,
	isValidCurieLocalPart,
} from '../src/generation/curie';
import type { App } from 'obsidian';
import type { Recipe } from '../src/render';
import type { ImportRecipe, ParsedData } from '../src/types/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (text: string) => unknown };

// ---------------------------------------------------------------------------
// 1. `injectiveDeclaredIdLocalPart` — the digest is over the WHOLE raw value.
// ---------------------------------------------------------------------------

describe('AM-28: a declared identifier is hashed as the source wrote it', () => {
	it('keeps "nist:AC 2" and "AC 2" apart, which is the exact pair pass 11 collapsed', () => {
		// THE repro. Both values collapse to the same readable form (`AC-2`), so the
		// digest is the only thing separating them — and until this amendment the
		// digest was taken over the already-stripped copy, which made it identical.
		const prefixed = injectiveDeclaredIdLocalPart('nist:AC 2');
		const bare = injectiveDeclaredIdLocalPart('AC 2');
		expect(prefixed).not.toBe(bare);
		// Both must still be legal CURIE local parts: separating them by producing a
		// value the spec rejects would trade one defect for another.
		expect(isValidCurieLocalPart(prefixed)).toBe(true);
		expect(isValidCurieLocalPart(bare)).toBe(true);
	});

	it('keeps "nist:AC-2" and "AC-2" apart, where nothing needed escaping at all', () => {
		// The quieter half of the same defect: the stripped form was already inside
		// the charset, so BOTH values passed straight through as `AC-2`. No hash was
		// spent, and no evidence was left that two identifiers had merged.
		expect(injectiveDeclaredIdLocalPart('nist:AC-2')).not.toBe(injectiveDeclaredIdLocalPart('AC-2'));
		// The bare value is the readable one and keeps its exact form, so a vault
		// stays legible. Only the value that had something stripped pays a digest.
		expect(injectiveDeclaredIdLocalPart('AC-2')).toBe('AC-2');
	});

	it('separates all four members of the pass-11 table at once', () => {
		// Stated as the set, because pairwise assertions can all pass while three of
		// the four still share one identity.
		const table = ['nist:AC 2', 'AC 2', 'nist:AC-2', 'AC-2'].map(injectiveDeclaredIdLocalPart);
		expect(new Set(table).size).toBe(4);
	});

	it('gives a value with nothing after the colon a name instead of the empty string', () => {
		// `x:` and `y:` both stripped to `""`, which reached the vault as the curie
		// `nist:` — outside the spec pattern, and caught only by a second gate
		// downstream. Two distinct sources, one non-identity.
		const x = injectiveDeclaredIdLocalPart('x:');
		const y = injectiveDeclaredIdLocalPart('y:');
		expect(x).not.toBe(y);
		expect(x).not.toBe('');
		expect(isValidCurieLocalPart(x)).toBe(true);
		expect(isValidCurieLocalPart(y)).toBe(true);
	});

	it('is deterministic, because an identity that varied per run would be no identity', () => {
		expect(injectiveDeclaredIdLocalPart('nist:AC 2')).toBe(injectiveDeclaredIdLocalPart('nist:AC 2'));
	});

	it('leaves `injectiveCurieLocalPart` alone, so the pinned and SSSOM callers are untouched', () => {
		// AM-28 changed a two-argument helper underneath this function. The last-resort
		// and SSSOM callers hand it one value that is both raw and safe source, and
		// their outputs are frozen by `identity-derivation.test.ts`; this states the
		// no-op here too, where a future edit to `escapeFrom` would be felt first.
		expect(injectiveCurieLocalPart('AC-2')).toBe('AC-2');
		expect(injectiveCurieLocalPart('nist:AC-2')).not.toBe('nist:AC-2');
		expect(isValidCurieLocalPart(injectiveCurieLocalPart('nist:AC-2'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 2. `declaredCurieLocalPart` — verbatim, or a named refusal.
// ---------------------------------------------------------------------------

describe('AM-28: a declared curie is reproduced exactly or refused by name', () => {
	it('returns the local part unchanged when the prefix is the one this import writes', () => {
		// The caller puts `expectedPrefix` back in front, so a value that passes is
		// reproduced byte-for-byte. Asserted as the round trip rather than as the
		// local part alone, since the round trip is the property that matters.
		expect(`nist:${declaredCurieLocalPart('nist:AC-2', 'nist')}`).toBe('nist:AC-2');
		expect(`nist:${declaredCurieLocalPart('nist:AC-2(1)/a', 'nist')}`).toBe('nist:AC-2(1)/a');
	});

	it('refuses a foreign prefix by name instead of substituting its own', () => {
		// The pass-11 table: `other:AC-2` was written as `nist:AC-2`, silently.
		expect(() => declaredCurieLocalPart('other:AC-2', 'nist')).toThrow(DeclaredCuriePrefixError);
		try {
			declaredCurieLocalPart('other:AC-2', 'nist');
			throw new Error('expected a refusal');
		} catch (err) {
			// Names the value the source actually wrote AND the prefix this import
			// writes, so the user can see both halves of the disagreement.
			expect((err as Error).message).toContain('other:AC-2');
			expect((err as Error).message).toContain('nist:');
		}
	});

	it('refuses a bare value, because accepting it would put it back in collision', () => {
		// `AC-2` is not a CURIE. Prefixing it silently is what made `other:AC-2`,
		// `nist:AC-2` and `AC-2` one identity.
		expect(() => declaredCurieLocalPart('AC-2', 'nist')).toThrow(DeclaredCuriePrefixError);
	});

	it('refuses the URI-shaped values that used to become "nist://x/y"', () => {
		// Every one of these passed the local-part charset (`/` is legal) and lost
		// only its scheme, so three different sources produced one identity.
		for (const declared of ['http://x/y', 'ftp://x/y', '//x/y']) {
			expect(() => declaredCurieLocalPart(declared, 'nist')).toThrow(DeclaredCuriePrefixError);
		}
	});

	it('refuses an empty local part as its own case, not as a charset violation', () => {
		// `x:` used to strip to `""`. The message has to say "nothing after the
		// colon", because "characters a CURIE cannot contain" describes no character
		// the user can find in their source.
		expect(() => declaredCurieLocalPart('x:', 'x')).toThrow(DeclaredCurieCharsetError);
		try {
			declaredCurieLocalPart('x:', 'x');
			throw new Error('expected a refusal');
		} catch (err) {
			expect((err as Error).message).toMatch(/nothing after the colon/i);
		}
	});

	it('reports a malformed local part as malformed whoever\'s prefix it carries', () => {
		// Ordering, stated where it can regress: a value the spec rejects is
		// diagnosed as such first. Telling a user to change their prefix when the
		// real problem is a space in the identifier sends them to the wrong column.
		expect(() => declaredCurieLocalPart('nist:AC 2', 'nist')).toThrow(DeclaredCurieCharsetError);
		expect(() => declaredCurieLocalPart('other:AC 2', 'nist')).toThrow(DeclaredCurieCharsetError);
	});
});

// ---------------------------------------------------------------------------
// End to end. Same vault double for both entry points, so neither can be shown
// to hold a property the other does not.
// ---------------------------------------------------------------------------

function makeApp() {
	const files = new Map<string, string>();
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

function parsed(rows: Record<string, unknown>[]): ParsedData {
	const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	return { columns, rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
}

/** The address comes from a column no identity rule consults, so "the identity
 *  changed" can never quietly be "the file moved". */
const RECIPE: Recipe = {
	recipe: 'nist',
	source: { ontology: 'nist', levels: ['leaf'] },
	target: { layout: [{ level: 'leaf', mechanism: 'file', template: '{key}.md' }] },
};

const CONFIG: Partial<ImportRecipe> = {
	name: 'nist',
	mapping: {
		hierarchy: [],
		frontmatter: [],
		links: [],
		body: [],
		filename: { template: '{key}.md', sanitize: true },
	},
};

const nativeOptions = {
	basePath: 'Frameworks',
	overwriteMode: 'replace' as const,
	createFolders: true,
	recipeOverride: RECIPE,
	importSet: 'new' as never,
};

const recipeOptions = {
	basePath: 'Frameworks',
	overwriteMode: 'replace' as const,
	createFolders: true,
	importSet: 'new' as never,
};

describe('AM-28 end to end: two declared identifiers are two notes', () => {
	// The pair that produced one note and one "duplicate identity" refusal before
	// the amendment, because the two raw values hashed to the same digest.
	const PAIR = [
		{ key: 'prefixed', id: 'nist:AC 2' },
		{ key: 'bare', id: 'AC 2' },
	];

	it('writes both rows on the wizard path, with no duplicate refusal', async () => {
		const { app, files } = makeApp();
		const result = await generateNotes(app, parsed(PAIR), CONFIG, nativeOptions);
		expect(result.errors).toEqual([]);
		expect(files.size).toBe(2);
		expect(new Set(curiesIn(files)).size).toBe(2);
	});

	it('writes both rows on the recipe path, with no duplicate refusal', async () => {
		const { app, files } = makeApp();
		const result = await generateFromRecipe(app, parsed(PAIR), RECIPE, recipeOptions);
		expect(result.errors).toEqual([]);
		expect(files.size).toBe(2);
		expect(new Set(curiesIn(files)).size).toBe(2);
	});

	it('keeps the prefixed and unprefixed forms of the SAME identifier apart', async () => {
		// The case where nothing is escaped and the collapse left no trace at all.
		const { app, files } = makeApp();
		const result = await generateNotes(app, parsed([
			{ key: 'prefixed', id: 'nist:AC-2' },
			{ key: 'bare', id: 'AC-2' },
		]), CONFIG, nativeOptions);
		expect(result.errors).toEqual([]);
		const curies = curiesIn(files);
		expect(new Set(curies).size).toBe(2);
		// The bare form is the readable one and is written exactly as stated.
		expect(curies).toContain('nist:AC-2');
	});
});

describe('AM-28 end to end: a declared curie reaches the vault as the source wrote it', () => {
	it('writes a matching-prefix curie verbatim, punctuation included', async () => {
		const { app, files } = makeApp();
		const result = await generateNotes(app, parsed([{ key: 'r', curie: 'nist:AC-2(1)/a' }]), CONFIG, nativeOptions);
		expect(result.errors).toEqual([]);
		expect(curiesIn(files)).toEqual(['nist:AC-2(1)/a']);
	});

	it('refuses a foreign prefix for that row alone, naming the value', async () => {
		// Never repaired. The neighbouring row still imports: one refused identity
		// is not a failed import.
		const { app, files } = makeApp();
		const result = await generateNotes(app, parsed([
			{ key: 'good', id: 'AC-1' },
			{ key: 'foreign', curie: 'other:AC-2' },
		]), CONFIG, nativeOptions);

		const refusal = result.errors.find((error) => error.row === 2);
		expect(refusal).toBeDefined();
		expect(refusal!.message).toContain('other:AC-2');
		expect(refusal!.message).toMatch(/curie column/i);
		expect(curiesIn(files)).toEqual(['nist:AC-1']);
		// Nothing was written for the refused row, and it reserved no address.
		expect(files.has('Frameworks/foreign.md')).toBe(false);
	});

	it('never writes the set\'s own prefix in front of a foreign one', async () => {
		// The defect stated as its consequence: `other:AC-2` became `nist:AC-2`,
		// which is an identity no source asserted and which nothing can join back.
		const { app, files } = makeApp();
		await generateFromRecipe(app, parsed([{ key: 'foreign', curie: 'other:AC-2' }]), RECIPE, recipeOptions);
		expect(curiesIn(files)).not.toContain('nist:AC-2');
		expect(files.size).toBe(0);
	});

	it('refuses three colliding declared forms rather than merging them onto one note', async () => {
		// `other:AC-2`, `AC-2` and `http://x/y` all used to survive as `nist:...`.
		// Only the correctly-prefixed row may be written.
		const { app, files } = makeApp();
		const result = await generateNotes(app, parsed([
			{ key: 'a', curie: 'other:AC-2' },
			{ key: 'b', curie: 'AC-2' },
			{ key: 'c', curie: 'http://x/y' },
			{ key: 'd', curie: 'nist:AC-2' },
		]), CONFIG, nativeOptions);

		expect(result.errors).toHaveLength(3);
		expect(curiesIn(files)).toEqual(['nist:AC-2']);
	});
});
