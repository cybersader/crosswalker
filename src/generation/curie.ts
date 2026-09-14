/**
 * curie.ts — the one normalization every curie prefix passes through.
 *
 * Extracted from `generation-engine.ts` (AM-18, 2026-08-31) so the modules that
 * REASON about curie prefixes (`import-set.ts`, which answers whether a new set
 * would collide with an existing one) can share the same function as the module
 * that MINTS them, without importing the engine and closing a cycle.
 *
 * Failure mode prevented: a second, slightly different slugifier. A prefix
 * compared in one normalization against a prefix stamped in another matches
 * nothing, which reads as "no set occupies this space" and mints a duplicate.
 * `generation-engine.ts` re-exports this so existing importers are unaffected.
 */

import { sha256Hex } from './hash';

/**
 * Slugify a string for use as a CURIE prefix (must match the schema's
 * `^[a-z][a-z0-9_-]*` pattern from spec/tier1.schema.json $defs/curie).
 *
 * Exported so a caller comparing a source against the ontology prefixes ALREADY
 * STAMPED on vault notes produces the same prefix generation stamps. Comparing
 * against the un-slugged ontology instead silently misses every name that needed
 * normalizing, which reads as "no set matches" and mints a duplicate.
 */
export function slugifyForCurie(input: string): string {
	const lower = String(input).toLowerCase();
	const cleaned = lower.replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
	// Ensure first char is a letter (schema requires)
	return /^[a-z]/.test(cleaned) ? cleaned : `cw-${cleaned}`;
}

// ---------------------------------------------------------------------------
// AM-27 (2026-08-31). Injective local parts.
//
// Failure mode prevented: two distinct source values answering to one CURIE.
// Every sanitizer in this codebase was written to make a string safe for a
// FILESYSTEM, and a filesystem sanitizer is many-to-one by design - `AC 2` and
// `AC-2`, `a/b` and `a-b`, `.x` and `x` all collapse. Identity may not pass
// through such a function: two rows that collapse together produce two files
// holding one curie, which is a permanent `Ambiguous identity` collision that
// fails EVERY later import in the vault, and one row silently overwriting the
// other's note when they also share an address.
//
// The construction below is injective by construction rather than by luck: a
// value already inside the target charset (and free of the reserved marker) is
// passed through unchanged, and any other value is rewritten as
// `<safe form><marker><short hash of the EXACT raw value>`. The two output sets
// are disjoint because only the second ever contains the marker, and inside the
// second the hash is fixed-length hex containing no marker character, so the
// last marker is always the separator and the decomposition is unique.
// ---------------------------------------------------------------------------

/**
 * The local half of a CURIE, per `spec/tier1.schema.json` `$defs/curie`
 * (`^[a-z][a-z0-9_-]*:[A-Za-z0-9._\-()/]+$`). Anchored on its own so a single
 * declared value can be checked without rebuilding the prefix.
 */
export const CURIE_LOCAL_PART_PATTERN = /^[A-Za-z0-9._\-()/]+$/;

/** Does this value satisfy the spec's CURIE local-part charset as written? */
export function isValidCurieLocalPart(value: string): boolean {
	return CURIE_LOCAL_PART_PATTERN.test(value);
}

/**
 * Reserved marker for the CURIE charset. `.` is inside the spec charset, so the
 * escaped form stays a legal CURIE; `..` is the marker because a hex digest
 * contains no `.`, which is what makes the separator unambiguous.
 */
const CURIE_ESCAPE_MARKER = '..';

/**
 * Reserved marker for the narrower endpoint-token charset the SSSOM importer
 * uses (`[A-Za-z0-9_-]`). Same argument as above with `-` in place of `.`.
 */
const TOKEN_ESCAPE_MARKER = '--';

/** Characters the spec's CURIE local-part charset does not admit. */
const CURIE_UNSAFE_CHARS = /[^A-Za-z0-9._\-()/]+/g;

/** Short digest of the EXACT pre-sanitizer value. Same 10-hex convention as
 * `evidence-link.ts`'s pair hash (AM-22), so one project reads one length. */
function rawFormHash(raw: string): string {
	return sha256Hex(raw).slice(0, 10);
}

/**
 * AM-28 (2026-08-31). The hash sees the EXACT raw, never a pre-stripped copy.
 *
 * `raw` is what the source stated and is the only thing hashed; `safeSource` is
 * the (possibly already-shortened) string the readable half is built from. Until
 * this amendment the caller ran `stripCuriePrefix` first and handed the RESULT to
 * this function as both arguments, so the digest never saw what the stripper
 * removed and `nist:AC 2` and `AC 2` produced one byte-identical curie -
 * disambiguating hash included - in the rule written to make that impossible.
 *
 * Injectivity argument, restated for the two-argument form:
 *   - the passthrough branch requires `safe === raw`, which can only hold when
 *     `safeSource === raw` (nothing was stripped) AND nothing was escaped, so a
 *     passthrough output is the raw itself and carries no marker;
 *   - every other output ends `<marker><10 hex>`, and a hex digest contains no
 *     marker character, so the LAST marker is always the separator and the
 *     decomposition into (safe form, digest of raw) is unique;
 *   - the two sets are therefore disjoint, and inside the second the digest is a
 *     function of the exact raw. Two distinct raw values cannot meet.
 */
function escapeFrom(raw: string, safeSource: string, unsafe: RegExp, marker: string): string {
	const safe = safeSource.replace(unsafe, '-');
	// The marker test is not decoration. Without it an unchanged raw value that
	// happened to contain the marker could equal some other value's escaped form,
	// and the two output sets would overlap at exactly that point.
	if (safe === raw && !raw.includes(marker)) return raw;
	return `${safe}${marker}${rawFormHash(raw)}`;
}

/**
 * A CURIE local part that is safe for the spec charset AND injective.
 *
 * Readable values (`AC-2`, `A.9.2.1`, `T1078`) pass through untouched, so a
 * vault stays legible; only a value that would otherwise have been collapsed
 * pays for the disambiguation.
 */
export function injectiveCurieLocalPart(raw: string): string {
	return escapeFrom(raw, raw, CURIE_UNSAFE_CHARS, CURIE_ESCAPE_MARKER);
}

/**
 * AM-28. The local part of a DECLARED IDENTIFIER (`id`, `control_id`, `code`) -
 * not a declared CURIE, which `declaredCurieLocalPart` handles and never rewrites.
 *
 * A source often writes an already-prefixed identifier in these columns
 * (`nist:AC-2`), and the readable half stays the part after the prefix so a vault
 * reads as `nist:AC-2` rather than `nist:nist-AC-2`. The digest is taken over the
 * WHOLE raw value, so `nist:AC 2` and `AC 2`, and `nist:AC-2` and `AC-2`, stay
 * four distinct identities.
 *
 * Failure mode prevented: `stripCuriePrefix` is many-to-one, so running it before
 * the digest let two distinct declared identifiers land on one curie - two rows
 * claiming one identity, which is either a silent overwrite or a permanent
 * `Ambiguous identity` collision failing every later import in the vault.
 */
export function injectiveDeclaredIdLocalPart(raw: string): string {
	return escapeFrom(raw, stripCuriePrefix(raw), CURIE_UNSAFE_CHARS, CURIE_ESCAPE_MARKER);
}

/**
 * The same treatment for a deterministic endpoint token (SSSOM subject/object
 * ids), whose target charset is deliberately narrower than the spec's so the
 * assembled `cw-<subject>-<object>` local part stays legible and filesystem-safe.
 */
export function injectiveEndpointToken(raw: string): string {
	return escapeFrom(raw, raw, /[^A-Za-z0-9_-]+/g, TOKEN_ESCAPE_MARKER);
}

// ---------------------------------------------------------------------------
// AM-29 (2026-08-31). The declared-facts chain is SHAPE-AWARE.
//
// Failure mode prevented: an endpoint answering for an edge. `subject_id` used to
// sit in the self-identity chain, so every crosswalk edge leaving one control
// derived that CONTROL's identity - 30 edges collapsing onto 22 curies in the
// bundled OLIR fixture alone. Before the within-run guard existed those edges
// were written on top of each other and the last writer won, silently; after it,
// every edge but the first is correctly refused. Either way the identity was
// wrong: a relationship is identified by its endpoints TOGETHER, never by one of
// them.
//
// The shape is read from what the RECIPE/RUN declares - the row carries both a
// subject and an object - never from the note's filename or folder, which is the
// rule this whole arc exists to enforce.
// ---------------------------------------------------------------------------

/**
 * Columns in which a row states ITS OWN identity. `curie` is a declared CURIE and
 * is honoured verbatim or refused (`declaredCurieLocalPart`); `id` is an
 * identifier and may be made charset-safe, injectively.
 */
export const SELF_IDENTITY_COLUMNS = ['curie', 'id'] as const;

/**
 * Domain-specific identifiers a CONCEPT row may use. Deliberately not consulted
 * for an edge row: an edge that carries a `control_id` is naming its subject, and
 * taking that as the edge's identity is the same defect `subject_id` caused.
 */
export const CONCEPT_IDENTITY_COLUMNS = ['control_id', 'code'] as const;

/** Where a row states the SUBJECT of a relationship. */
export const EDGE_SUBJECT_COLUMNS = ['subject_id', 'subject_curie'] as const;
/** Where a row states the OBJECT of a relationship. */
export const EDGE_OBJECT_COLUMNS = ['object_id', 'object_curie'] as const;
/**
 * Where a row states the PREDICATE. Optional: an edge with no stated predicate is
 * still an edge, and its identity then carries an empty predicate field, which is
 * a distinct value rather than a missing one.
 */
export const EDGE_PREDICATE_COLUMNS = ['predicate_id', 'strm_predicate', 'sssom_predicate', 'predicate'] as const;

export type DeclaredIdentityColumn =
	| typeof SELF_IDENTITY_COLUMNS[number]
	| typeof CONCEPT_IDENTITY_COLUMNS[number];

/** First non-empty string among `columns`, with the column that answered. */
function firstStated(
	row: Record<string, unknown>,
	columns: readonly string[],
): { column: string; raw: string } | null {
	for (const column of columns) {
		const value = row[column];
		if (typeof value === 'string' && value.length > 0) return { column, raw: value };
	}
	return null;
}

/** The endpoints a row states, when it states both. Null means "not an edge". */
export function edgeShapeOf(
	row: Record<string, unknown>,
): { subject: string; predicate: string; object: string } | null {
	const subject = firstStated(row, EDGE_SUBJECT_COLUMNS);
	const object = firstStated(row, EDGE_OBJECT_COLUMNS);
	if (!subject || !object) return null;
	return {
		subject: subject.raw,
		predicate: firstStated(row, EDGE_PREDICATE_COLUMNS)?.raw ?? '',
		object: object.raw,
	};
}

/**
 * AM-29. One relationship's identity, from its three endpoints together.
 *
 * Shape borrowed from AM-22's evidence junction: a readable head so a person
 * opening the folder can tell what the note is, ended with a digest of the EXACT
 * triple, which is what makes the identity injective. The head is a courtesy and
 * may collapse; nothing rests on it.
 */
export function edgeIdentityLocalPart(subject: string, predicate: string, object: string): string {
	// Separated by NUL, a character no source field can contain, so no two
	// different triples can produce one key by shifting the boundary between the
	// fields. Written as an escape so this file stays plain text to git and grep.
	const key = ['crosswalk-edge/v1', 'subject', subject, 'predicate', predicate, 'object', object].join('\u0000');
	const head = [subject, predicate, object]
		.map((part) => part.replace(CURIE_UNSAFE_CHARS, '-').replace(/^-+|-+$/g, ''))
		.join('--');
	return `cw-${head}-${rawFormHash(key)}`;
}

/**
 * AM-27/AM-29. What this row declares its identity to be, if anything.
 *
 * Returns the column that answered and its EXACT raw value (so a caller can name
 * the column in a refusal), or the endpoints of a relationship when the row is
 * edge-shaped. `curie` is first and is treated differently by callers: a value in
 * that column is a declared CURIE, and rewriting a declared identity is the thing
 * these amendments forbid.
 */
export type DeclaredIdentity =
	| { kind: 'column'; column: DeclaredIdentityColumn; raw: string }
	| { kind: 'edge'; subject: string; predicate: string; object: string };

export function declaredIdentity(row: Record<string, unknown>): DeclaredIdentity | null {
	const self = firstStated(row, SELF_IDENTITY_COLUMNS);
	// A row that states its own identity is taken at its word whatever its shape:
	// an edge export carrying an explicit `id` per mapping is naming the mapping.
	if (self) return { kind: 'column', column: self.column as DeclaredIdentityColumn, raw: self.raw };

	const edge = edgeShapeOf(row);
	if (edge) return { kind: 'edge', ...edge };

	const concept = firstStated(row, CONCEPT_IDENTITY_COLUMNS);
	if (concept) return { kind: 'column', column: concept.column as DeclaredIdentityColumn, raw: concept.raw };

	return null;
}

/**
 * The local half of a value that may already be a full CURIE (`nist:AC-2`).
 * Identical to what the recipe path has always done, kept in one place so the
 * legacy and the new derivation cannot disagree about where the prefix ends.
 */
export function stripCuriePrefix(value: string): string {
	const colon = value.indexOf(':');
	return colon > 0 ? value.slice(colon + 1) : value;
}

/**
 * AM-27. A declared `curie` column whose value the spec charset rejects.
 *
 * Thrown, not sanitized: the row SAID what its identity is. Quietly rewriting it
 * means the vault holds an identity the source never declared, nothing downstream
 * can join back to the source system, and two rows whose declared curies differ
 * only in a rejected character silently become one note.
 */
export class DeclaredCurieCharsetError extends Error {
	constructor(public readonly declared: string, empty = false) {
		super(
			empty
				? `The curie column on this row is "${declared}", which has nothing after the colon. `
					+ 'A CURIE needs an identifier after its prefix, for example "nist:AC-2". '
					+ 'Fix the value in your source, or clear the curie column and let the import derive an identity from another column.'
				: `The curie column on this row is "${declared}", which uses characters a CURIE cannot contain. `
					+ 'After the prefix, a CURIE allows letters, digits, and these characters: . _ - ( ) / '
					+ 'Fix the value in your source, or clear the curie column and let the import derive an identity from another column.',
		);
		this.name = 'DeclaredCurieCharsetError';
	}
}

/**
 * AM-28. A declared `curie` whose PREFIX is not this set's ontology.
 *
 * Thrown, not repaired. The previous behaviour kept only the local part and put
 * the set's own prefix in front of it, so a source stating `other:AC-2` had
 * `nist:AC-2` written into the vault with no error: an identity the source never
 * asserted, joinable back to nothing, and `other:AC-2`, `nist:AC-2` and a bare
 * `AC-2` all collapsing onto one note. A bare value is refused for the same
 * reason - it is not a CURIE, and accepting it would put it back in collision
 * with the fully-qualified form.
 *
 * AM-34 (2026-09-01). The prefix a source is checked against is the set's BASE
 * ontology prefix, not the prefix the vault will hold. Under AM-13 a second
 * release of a framework is minted `set-qualified-v1` and writes
 * `nist-iset-<id>:`, an id that does not exist until the import runs - so
 * checking against the written prefix refused every row of Crosswalker's own CSV
 * export (`curie` is its first column), which is the release-isolation flow and
 * the portability round-trip. Set-qualification is applied AFTER this check, as
 * the scheme's uniform, recorded, invertible re-prefixing: distinct declared
 * curies stay distinct, the set stamp records the scheme and id that produced
 * the transform, and export inverts it. A genuinely foreign prefix still refuses
 * by name, which is what this error is for.
 */
export class DeclaredCuriePrefixError extends Error {
	constructor(public readonly declared: string, public readonly expectedPrefix: string) {
		super(
			`The curie column on this row is "${declared}", but this import's identifiers belong to `
			+ `"${expectedPrefix}". Crosswalker will not change an identity a source states. `
			+ `Either write the value as "${expectedPrefix}:..." in your source, or clear the curie column and `
			+ 'let the import derive an identity from another column.',
		);
		this.name = 'DeclaredCuriePrefixError';
	}
}

/**
 * AM-28. The local part of a DECLARED `curie`, verbatim, or a named refusal.
 *
 * AM-34. `expectedBasePrefix` is the set's BASE ontology prefix. The caller puts
 * the set's RESOLVED prefix back in front of the returned value - the same
 * prefix for every row, so the local parts a source declared stay exactly as
 * distinct from each other as the source made them, and the set stamp records
 * the scheme and id needed to invert the transform. A value that passes is
 * therefore reproduced byte-for-byte in its local half, and its prefix is the
 * set's, openly and uniformly. Nothing here sanitizes: every rejection is a
 * refusal for that row alone.
 *
 * Checked in this order because it is the order a person diagnoses in: a value
 * whose local half the spec rejects is malformed whoever's prefix it carries, and
 * only a well-formed value raises the question of whose prefix it is.
 */
export function declaredCurieLocalPart(declared: string, expectedPrefix: string): string {
	const colon = declared.indexOf(':');
	const local = colon > 0 ? declared.slice(colon + 1) : declared;
	if (local.length === 0) throw new DeclaredCurieCharsetError(declared, true);
	if (!isValidCurieLocalPart(local)) throw new DeclaredCurieCharsetError(declared);
	const prefix = colon > 0 ? declared.slice(0, colon) : '';
	if (prefix !== expectedPrefix) throw new DeclaredCuriePrefixError(declared, expectedPrefix);
	return local;
}
