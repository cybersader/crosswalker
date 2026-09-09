/**
 * hash.ts — canonical serialization + sha256 for provenance hashing.
 *
 * Provides canonical hash helpers for the `_crosswalker` provenance block's
 * `concept_cid` and `recipe.hash` slots, plus the separate full canonical
 * recipe-document digest referenced by recipe ancestry and Tier 1 provenance.
 * The original provenance helpers landed from the Ch 43 deliverable
 * (`.workspace/2026-07-11-challenge-43-version-migration-deliverable.md` §2 /
 * §0-B), where the schema anticipated both slots but nothing computed them.
 *
 * No new dependency. Node's `crypto` module is unavailable on mobile Obsidian
 * (Capacitor WebView has no Node runtime; esbuild's `external` list — see
 * esbuild.config.mjs — marks Node builtins external, so a `require('crypto')`
 * would survive into the bundle and fail there), and the Web Crypto
 * `subtle.digest` API is async-only, which doesn't fit render()'s pure /
 * synchronous contract. sha256 is implemented in-repo below (standard FIPS
 * 180-4 algorithm, ~90 lines, unit-tested against the official test vectors
 * in tests/generation-hash.test.ts).
 */

import { interpolationColumn, parseTemplateSegments, type Interpolation } from '../render/template';
import type { Recipe } from '../render';
import type { CrosswalkerImportRecipe } from '../types/generated/recipe';

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON-shaped serialization: object keys are sorted
 * recursively so the same logical value always produces the same string
 * regardless of construction/insertion order. Arrays keep their order
 * (order is semantic — e.g. `target.layout` levels are ordered). Object keys
 * whose value is `undefined` are omitted (mirrors `JSON.stringify`'s own
 * behavior), so a key merely being absent vs. explicitly `undefined` hashes
 * identically. `undefined`/`NaN`/`Infinity` inside arrays serialize as `null`
 * (mirrors `JSON.stringify`'s array behavior) rather than throwing.
 */
export function canonicalStringify(value: unknown): string {
	return stringifyCanonical(value);
}

function stringifyCanonical(value: unknown): string {
	if (value === undefined || value === null) return 'null';
	const t = typeof value;
	if (t === 'string') return JSON.stringify(value);
	if (t === 'number') return Number.isFinite(value as number) ? JSON.stringify(value) : 'null';
	if (t === 'boolean') return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((v) => stringifyCanonical(v)).join(',')}]`;
	}
	if (t === 'object') {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj)
			.filter((k) => obj[k] !== undefined)
			.sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${stringifyCanonical(obj[k])}`).join(',')}}`;
	}
	// function/symbol/bigint shouldn't appear in recipe or source-row data;
	// stringify defensively rather than throw.
	return JSON.stringify(String(value));
}

// ---------------------------------------------------------------------------
// sha256 (pure JS, no dependencies)
// ---------------------------------------------------------------------------

// prettier-ignore
const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H_INIT = new Uint32Array([
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
	0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rightRotate(x: number, n: number): number {
	return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * Manual UTF-8 encoder — avoids depending on a global `TextEncoder`. Present
 * in every runtime this plugin actually ships to (Electron desktop, mobile
 * Capacitor WebView) but NOT reliably present in every test environment
 * (jsdom, depending on version), and a hash function that only works in some
 * test environments is worse than a dozen extra lines here.
 */
function utf8Encode(str: string): Uint8Array {
	const bytes: number[] = [];
	for (let i = 0; i < str.length; i++) {
		const codePoint = str.codePointAt(i) as number;
		if (codePoint > 0xffff) i++; // consumed a surrogate pair
		if (codePoint < 0x80) {
			bytes.push(codePoint);
		} else if (codePoint < 0x800) {
			bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
		} else if (codePoint < 0x10000) {
			bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
		} else {
			bytes.push(
				0xf0 | (codePoint >> 18),
				0x80 | ((codePoint >> 12) & 0x3f),
				0x80 | ((codePoint >> 6) & 0x3f),
				0x80 | (codePoint & 0x3f),
			);
		}
	}
	return new Uint8Array(bytes);
}

/**
 * sha256 over an exact byte view. Returns lowercase 64-char hex.
 * Pure, synchronous, deterministic. Standard FIPS 180-4 SHA-256.
 *
 * The view's byteOffset/byteLength are authoritative; bytes elsewhere in its
 * backing allocation are not hashed. Padding length is calculated with ordinary
 * number arithmetic rather than 32-bit bitwise operators, which would wrap an
 * allocation length above 4 GiB before Uint8Array gets a chance to reject it.
 */
export function sha256BytesHex(bytes: Uint8Array): string {
	const byteLen = bytes.byteLength;
	const bitLen = byteLen * 8;
	if (!Number.isSafeInteger(bitLen)) {
		throw new RangeError('SHA-256 input is too large to represent its bit length safely.');
	}

	// Padding: 0x80 byte, then zeros, then the 64-bit big-endian bit length,
	// bringing the total length to a multiple of 64 bytes.
	const totalLen = Math.ceil((byteLen + 1 + 8) / 64) * 64;
	if (!Number.isSafeInteger(totalLen)) {
		throw new RangeError('SHA-256 padded input length is too large to allocate safely.');
	}
	const buf = new Uint8Array(totalLen);
	buf.set(bytes, 0);
	buf[byteLen] = 0x80;
	const view = new DataView(buf.buffer);
	// bitLen fits safely in a JS number by the guard above. setUint32 writes the
	// two halves without using a 32-bit expression to calculate allocation size.
	const hi = Math.floor(bitLen / 0x100000000);
	const lo = bitLen % 0x100000000;
	view.setUint32(totalLen - 8, hi, false);
	view.setUint32(totalLen - 4, lo, false);

	let [h0, h1, h2, h3, h4, h5, h6, h7] = H_INIT;

	const w = new Uint32Array(64);
	for (let chunkStart = 0; chunkStart < totalLen; chunkStart += 64) {
		for (let i = 0; i < 16; i++) {
			w[i] = view.getUint32(chunkStart + i * 4, false);
		}
		for (let i = 16; i < 64; i++) {
			const s0 = rightRotate(w[i - 15], 7) ^ rightRotate(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = rightRotate(w[i - 2], 17) ^ rightRotate(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
		}

		let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

		for (let i = 0; i < 64; i++) {
			const S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
			const ch = (e & f) ^ (~e & g);
			const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
			const S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (S0 + maj) >>> 0;

			h = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}

		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
		h5 = (h5 + f) >>> 0;
		h6 = (h6 + g) >>> 0;
		h7 = (h7 + h) >>> 0;
	}

	return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, '0')).join('');
}

/** sha256 over the existing manual UTF-8 encoding of `input`. */
export function sha256Hex(input: string): string {
	return sha256BytesHex(utf8Encode(input));
}

// ---------------------------------------------------------------------------
// Provenance hash helpers
// ---------------------------------------------------------------------------

/** Wraps a hex digest in the `sha256-{hex}` format spec/tier1.schema.json's `sha256_cid` $def requires. */
export function toSha256Cid(hex: string): string {
	return `sha256-${hex}`;
}

/** Digest the complete pre-parse bytes of one source payload. */
export function computeSourceByteDigest(bytes: Uint8Array): string {
	return toSha256Cid(sha256BytesHex(bytes));
}

/**
 * Digest a complete canonical ImportRecipe revision.
 *
 * The caller must first validate and normalize the recipe with normalizeRecipe().
 * This helper deliberately hashes the full recursively key-sorted object, including
 * normalized defaults, source, target, metadata, ancestry references and ordered
 * arrays. It performs no normalization or field stripping of its own.
 */
export function computeRecipeDocumentDigest(recipe: CrosswalkerImportRecipe): string {
	return toSha256Cid(sha256Hex(canonicalStringify(recipe)));
}

/**
 * Identity of a single concept for `concept_cid` hashing purposes.
 *
 * `curie` + `scope` are exactly the two inputs `render()` itself receives
 * (`ConceptIdentity` in src/render/types.ts) — i.e. this is the PRE-render
 * concept identity, captured before any recipe/template touches it.
 */
export interface ConceptIdentityRecord {
	curie: string;
	/** The source row's own column values, unmodified by any recipe/template. */
	scope: Record<string, unknown>;
}

/**
 * Compute `_crosswalker.concept_cid`.
 *
 * LOAD-BEARING FIELD-SET DEFINITION — this is what "the same concept" means
 * across re-imports, recipe edits, and vault reorganizations for the future
 * v0.2 semantic-diff loop (Ch 43 deliverable §2's two-axes table). Per
 * spec/tier1.schema.json's `sha256_cid` $def description, the cid must be
 * "stable across vault layouts because the recipe's render() output is NOT
 * included" — so this hashes ONLY `{ curie, scope }`, i.e. the row's own
 * identity and attribute values as they existed BEFORE render() ran. It
 * never touches `Address` (render()'s output: path, wikilinkTarget, tags,
 * aliases, frontmatter) — path/folder placement is exactly what must be
 * excluded for the cid to stay stable when only placement changes.
 *
 * Consequence (intentional, matches the schema's own `concept_cid` property
 * description "Same across recipes that produce different vault layouts
 * from identical source data"): two different recipes rendering the same
 * source row to two different vault layouts produce the SAME concept_cid.
 * Only a change to the row's own curie or attribute values changes it.
 */
/**
 * Select the source attributes that participate in a note identity.
 *
 * Crosswalk-edge identity includes the normalized mapping provenance fields
 * used by its assertion identity. Concept and junction identities retain the
 * exact source row they used before P3; an importer must not widen their hash
 * scope merely because it added render-only defaults.
 */
export function identityScopeForNoteKind(
	kind: unknown,
	sourceScope: Record<string, unknown>,
	normalizedRenderScope: Record<string, unknown>,
): Record<string, unknown> {
	return kind === 'crosswalk-edge' ? normalizedRenderScope : sourceScope;
}

export function computeConceptCid(record: ConceptIdentityRecord): string {
	const canonical = canonicalStringify({ curie: record.curie, scope: record.scope });
	return toSha256Cid(sha256Hex(canonical));
}

// ---------------------------------------------------------------------------
// Review normalization + `review_cid` (Ch 43 re-attestation, 2026-08-28)
// ---------------------------------------------------------------------------

/**
 * Fold the COSMETIC shape of one string value, leaving every word intact.
 *
 * This is the whole content-drift feature in one function: it decides which
 * upstream edits are worth a human re-review and which are typography churn.
 * It is deliberately a SECOND, tolerant hash rather than a change to
 * `computeConceptCid` (Ch 43 contract §3.1, fork F1) — `concept_cid` is an
 * IDENTITY hash whose published contract is byte-exactness across layouts
 * (spec/tier1.schema.json `sha256_cid`), and it is the load-bearing input to
 * the two-axes drift analysis. Redefining it would make every note in every
 * existing vault emit a changed value on its next re-import for no gain — the
 * identical hazard `recipeHashCanonicalInput` already refuses below.
 *
 * The fourteen steps run in EXACTLY this order and are pure string operations
 * over a fixed regex subset: no locale, no Unicode tables beyond NFC, no
 * library. That is the reproducibility bar — an external Python or Go producer
 * implements these fourteen steps and gets the same digest.
 *
 * Deliberately NOT done (contract §3.3):
 *   - ASCII punctuation is never DELETED, only folded in shape. Over-
 *     normalizing hides a material change and produces a green report over an
 *     invalidated claim. Under-normalizing costs one false flag and a five-
 *     second human re-review. Bias to under-normalize.
 *   - No case folding. A capitalization change in a control title can be a real
 *     edit, and `toLowerCase` is locale-sensitive (Turkish dotless i), which
 *     breaks the reimplement-and-agree requirement above.
 *   - No stemming, stop-word removal, or semantic similarity. Materiality is a
 *     human call and this rule must not pretend otherwise.
 */
export function normalizeReviewString(value: string): string {
	// 1. Unicode normalization — composed form, so a precomposed and a
	//    decomposed accent are the same content.
	let s = value.normalize('NFC');
	// 2. Citation markers: ATT&CK descriptions carry "(Citation: Author 2024)"
	//    inline, and reference churn is a pure-typography class there.
	s = s.replace(/\(Citation:[^)]*\)/g, '');
	// 3. Numeric footnote markers.
	s = s.replace(/\[\d+\]/g, '');
	// 4. Markdown link destinations: keep the text a reviewer read, drop the URL.
	//    Repeated until stable (bounded at 4) so a nested link collapses fully.
	for (let pass = 0; pass < 4; pass++) {
		const next = s.replace(/\[([^\][]*)\]\((?:[^()\s]*)(?:\s+"[^"]*")?\)/g, '$1');
		if (next === s) break;
		s = next;
	}
	// 5. Markdown autolinks.
	s = s.replace(/<https?:\/\/[^>\s]*>/g, '');
	// 6. HTML tags — the tag, never the text between tags.
	s = s.replace(/<\/?[A-Za-z][^>]*>/g, '');
	// 7. Quote folding: curly single/double quotes and the acute accent.
	s = s.replace(/[\u2018\u2019\u201A\u201B\u00B4]/g, "'");
	s = s.replace(/[\u201C\u201D\u201E\u201F]/g, '"');
	// 8. Dash folding: hyphen/figure/en/em/horizontal-bar/minus.
	s = s.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-');
	// 9. Ellipsis folding.
	s = s.replace(/\u2026/g, '...');
	// 10. Zero-width and soft-hyphen removal.
	s = s.replace(/[\u200B\u200C\u200D\uFEFF\u00AD]/g, '');
	// 11. Space folding — every Unicode space becomes an ASCII space.
	s = s.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
	// 12. Line-ending folding.
	s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	// 13. Whitespace collapse — LAST, so markup removed above cannot leave a
	//     doubled space behind and change the digest for nothing.
	s = s.replace(/\s+/g, ' ');
	// 14. Trim.
	return s.trim();
}

/**
 * Apply `normalizeReviewString` to every string leaf of a value, recursively.
 *
 * OBJECT KEYS ARE NEVER NORMALIZED. A renamed column changes what the row
 * asserts and what templates address; that is a real change, not typography.
 * Non-string leaves (number, boolean, null) pass through untouched.
 *
 * A value that normalizes to the empty string KEEPS ITS KEY with value `""`.
 * `canonicalStringify` drops only `undefined`-valued keys, so emptying a column
 * stays detectable as a change while removing it stays detectable as a
 * different change.
 */
export function normalizeForReview(value: unknown): unknown {
	if (typeof value === 'string') return normalizeReviewString(value);
	if (Array.isArray(value)) return value.map((v) => normalizeForReview(v));
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = normalizeForReview(v);
		}
		return out;
	}
	return value;
}

/**
 * The exact string hashed into `review_cid`. Exported for tests so a failure
 * names the step that diverged rather than only a digest mismatch — the same
 * discipline `recipeHashCanonicalInput` established.
 */
export function reviewCidCanonicalInput(record: ConceptIdentityRecord): string {
	return canonicalStringify({
		curie: record.curie,
		scope: normalizeForReview(record.scope),
	});
}

/**
 * Compute `_crosswalker.review_cid` — the fingerprint an attestation records at
 * approval time and is later compared against.
 *
 * Same input record as `computeConceptCid` (the RAW pre-render source row), so
 * the two hashes describe the same content and differ only in tolerance. The
 * `curie` is inside the hash on purpose: the concept identity a reviewer read
 * is part of what they read, so a CURIE change is a content change.
 *
 * SCOPE IS THE WHOLE ROW (contract fork F4), not a description column. Which
 * fields a reviewer read is not knowable and is recipe-dependent; guessing it
 * silently exempts material changes. The named extension point is an optional
 * recipe-declared `review_scope` field list, additive, later.
 */
export function computeReviewCid(record: ConceptIdentityRecord): string {
	return toSha256Cid(sha256Hex(reviewCidCanonicalInput(record)));
}

/**
 * Recipe-declared sub-fingerprints used to explain a changed `review_cid`.
 *
 * `review_cid` remains the whole-row gate. These hashes never decide whether a
 * subject changed; they only classify an already-detected change. The recipe is
 * the declaration source: body projections are wording, managed frontmatter
 * (including managed links) is scope, and everything else is housekeeping.
 */
export interface ReviewGroupCids {
	wording: string;
	scope: string;
	housekeeping: string;
}

/** Read a complete group-hash block. Partial blocks are absence, never facts. */
export function readReviewGroupCids(value: unknown): ReviewGroupCids | null {
	if (!value || typeof value !== 'object') return null;
	const source = value as Record<string, unknown>;
	const wording = typeof source.wording === 'string' ? source.wording.trim() : '';
	const scope = typeof source.scope === 'string' ? source.scope.trim() : '';
	const housekeeping = typeof source.housekeeping === 'string' ? source.housekeeping.trim() : '';
	const isSha256Cid = (candidate: string) => /^sha256-[a-f0-9]{64}$/.test(candidate);
	return isSha256Cid(wording) && isSha256Cid(scope) && isSha256Cid(housekeeping)
		? { wording, scope, housekeeping }
		: null;
}

type ResolvedReviewPath = {
	/** Stable identity of the selected source location. */
	key: string;
	/** Direct source key or nested traversal segments, as render() resolves it. */
	path: string[];
	value: unknown;
};

/** Collect every interpolation from a set of recipe templates. */
function reviewInterpolations(templates: string[]): Interpolation[] {
	const out: Interpolation[] = [];
	for (const template of templates) {
		for (const segment of parseTemplateSegments(template)) {
			if (segment.kind === 'interp') out.push(segment.interp);
		}
	}
	return out;
}

/**
 * Resolve the source location an interpolation consumes, without applying its
 * filters. This intentionally mirrors template.ts's exact-key fast path: a
 * dotted spreadsheet header remains one source key, while a true nested path
 * selects only its leaf so unrelated siblings remain housekeeping.
 */
function resolveReviewPath(interp: Interpolation, scope: Record<string, unknown>): ResolvedReviewPath {
	const rawPath = interp.rawPath.trim();
	const direct = (
		interp.path.length === 1
		|| (
			interp.path.length > 1
			&& interp.path.every((segment) => !segment.literal)
			&& Object.prototype.hasOwnProperty.call(scope, rawPath)
		)
	);
	const path = direct ? [interpolationColumn(interp).column] : interp.path.map((segment) => segment.name);
	let value: unknown = scope;
	for (const segment of path) {
		if (value === null || typeof value !== 'object') {
			value = undefined;
			break;
		}
		value = (value as Record<string, unknown>)[segment];
	}
	return {
		key: canonicalStringify(path),
		path,
		value,
	};
}

/** Deduplicate and sort selected source values so recipe declaration order is irrelevant. */
function selectedReviewValues(
	interpolations: Interpolation[],
	scope: Record<string, unknown>,
): { values: Array<{ path: string[]; value: unknown }>; paths: string[][] } {
	const selected = new Map<string, ResolvedReviewPath>();
	for (const interp of interpolations) {
		const resolved = resolveReviewPath(interp, scope);
		selected.set(resolved.key, resolved);
	}
	const ordered = [...selected.values()].sort((a, b) => a.key.localeCompare(b.key));
	return {
		values: ordered.map(({ path, value }) => ({ path, value: normalizeForReview(value) })),
		paths: ordered.map(({ path }) => path),
	};
}

function cloneForHousekeeping(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cloneForHousekeeping);
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			out[key] = cloneForHousekeeping(child);
		}
		return out;
	}
	return value;
}

/** Remove one consumed leaf while preserving every unconsumed sibling. */
function omitReviewPath(scope: Record<string, unknown>, path: string[]): void {
	if (path.length === 0) return;
	let parent: unknown = scope;
	for (let index = 0; index < path.length - 1; index++) {
		if (parent === null || typeof parent !== 'object') return;
		parent = (parent as Record<string, unknown>)[path[index]];
	}
	if (parent === null || typeof parent !== 'object') return;
	const leaf = path[path.length - 1];
	if (Array.isArray(parent) && /^\d+$/.test(leaf)) {
		// Do not splice: shifting indexes would turn an excluded field into a
		// housekeeping change. Undefined serializes as null inside arrays.
		parent[Number(leaf)] = undefined;
	} else {
		delete (parent as Record<string, unknown>)[leaf];
	}
}

function reviewGroupCid(group: keyof ReviewGroupCids, value: unknown): string {
	return toSha256Cid(sha256Hex(canonicalStringify({ group, value: normalizeForReview(value) })));
}

/**
 * Compute the three recipe-driven explanation hashes for one concept row.
 *
 * Priority is applied later, when hashes are compared: wording, then scope,
 * then housekeeping. A source field used by both body and managed frontmatter
 * may therefore change both hashes, but receives exactly one `wording` verdict.
 */
export function computeReviewGroupCids(
	record: ConceptIdentityRecord,
	recipe: Pick<Recipe, 'target'>,
): ReviewGroupCids {
	const wordingTemplates = (recipe.target.also_emit?.body ?? []).map((entry) => entry.template);
	const managed = recipe.target.also_emit?.frontmatter?.managed ?? {};
	const managedLinks = recipe.target.also_emit?.frontmatter?.managed_links ?? {};
	const scopeTemplates = [
		...Object.values(managed),
		...Object.values(managedLinks).map((entry) => entry.template),
	];

	const wording = selectedReviewValues(reviewInterpolations(wordingTemplates), record.scope);
	const scope = selectedReviewValues(reviewInterpolations(scopeTemplates), record.scope);
	const housekeepingScope = cloneForHousekeeping(record.scope) as Record<string, unknown>;
	const consumed = new Map<string, string[]>();
	for (const path of [...wording.paths, ...scope.paths]) consumed.set(canonicalStringify(path), path);
	for (const path of consumed.values()) omitReviewPath(housekeepingScope, path);

	return {
		wording: reviewGroupCid('wording', wording.values),
		scope: reviewGroupCid('scope', scope.values),
		// CURIE changes are not recipe projections, but they are part of review_cid.
		// Keeping identity in the residual group guarantees every whole-row change
		// has a conservative explanation rather than falling through unclassified.
		housekeeping: reviewGroupCid('housekeeping', {
			curie: record.curie,
			scope: housekeepingScope,
		}),
	};
}

/**
 * The recipe fields hashed into `_crosswalker.recipe.hash` — the "effective
 * recipe target": everything in `Recipe.target` that currently affects
 * render() output.
 */
export interface EffectiveRecipeTarget {
	layout: unknown;
	also_emit?: unknown;
	enrichment?: unknown;
	auto_heading?: unknown;
}

/**
 * The `recipe.source` fields hashed into `_crosswalker.recipe.hash` — the
 * source-shaping declarations (Ch 46 source contract §8).
 *
 * `recipe.source` as a whole is still excluded as informational; only the
 * declarations that change WHICH NOTES EXIST enter the hash. `ontology`,
 * `version` and `levels` stay out: renaming an ontology does not change what
 * the recipe produces.
 *
 * `joins` enters for the same reason: it changes what a row IS, and therefore
 * what the notes assert. `canonicalStringify` drops undefined-valued keys, so a
 * recipe declaring neither hashes byte-identically to its pre-1.9.0 self.
 */
export interface EffectiveRecipeSource {
	where?: unknown;
	joins?: unknown;
}

/**
 * Compute `_crosswalker.recipe.hash`.
 *
 * LOAD-BEARING FIELD-SET DEFINITION — this is what "the same recipe" means
 * for distinguishing recipe-drift from source-drift (Ch 43 deliverable §2's
 * two-axes table: unchanged concept_cid + changed recipe.hash = pure recipe
 * change, no semantic-diff risk; changed concept_cid + unchanged recipe.hash
 * = pure source-version change). Hashes exactly three fields of
 * `recipe.target`:
 *
 *   - `layout`     — folder/file/heading mechanisms + templates (what
 *                    produces the Address path)
 *   - `also_emit`  — tags/aliases/managed frontmatter/managed_links plus
 *                    canonical body declarations (what produces Address
 *                    metadata and rendered body regions)
 *   - `enrichment` — Pass 1.5 children-lists/facet-hubs/level-hubs config
 *                    (post-render batch shape)
 *   - `auto_heading` — the recipe's control over the note's automatic H1
 *                    (schema SchemaVer 1.8.0). It materially changes emitted
 *                    body text, so it belongs here.
 *
 * ...plus the source-shaping declarations of `recipe.source` (SchemaVer
 * 1.9.0, Ch 46 source contract §8):
 *
 *   - `source.where` — the row predicate. It changes WHICH NOTES EXIST, which
 *                    is exactly what this hash is supposed to track.
 *   - `source.joins` — keyed lookup enrichment. It changes what a row IS, so
 *                    a note's content and its concept_cid depend on it.
 *
 * Deliberately EXCLUDED:
 *   - `recipe.recipe` (the id/name) and the rest of `recipe.source`
 *     (`ontology`, `version`, `levels`) — informational, renaming a recipe or
 *     its ontology without touching what it produces doesn't change the hash.
 *   - `graph_edges` and `linkStyle` — both schema-reserved and unwired in
 *     v0.1 (render() never reads them; see src/render/index.ts's Recipe
 *     type comments). Add them here the moment either starts affecting
 *     render() output, so recipe.hash keeps meaning "hashes what actually
 *     gets produced."
 *   - Anything session-specific — a Recipe object has no wall-clock or
 *     run-specific fields to begin with.
 */
export function computeRecipeHash(target: EffectiveRecipeTarget, source?: EffectiveRecipeSource): string {
	return toSha256Cid(sha256Hex(recipeHashCanonicalInput(target, source)));
}

/**
 * The canonical string `computeRecipeHash` digests. Exported so the
 * byte-identical guarantee can be asserted on the STRING, not just on the
 * digest (acceptance case A2) — a test that only compares digests cannot tell
 * you why they diverged. The field set lives here, once.
 */
export function recipeHashCanonicalInput(target: EffectiveRecipeTarget, source?: EffectiveRecipeSource): string {
	return canonicalStringify({
		layout: target.layout,
		also_emit: target.also_emit ?? null,
		enrichment: target.enrichment ?? null,
		// Deliberately NOT `?? null` (unlike the two above). canonicalStringify
		// drops undefined-valued keys, so a recipe WITHOUT auto_heading hashes
		// byte-identically to its pre-1.8.0 self. Coercing absent to null would
		// inject "auto_heading":null into every canonical string, change every
		// already-written _crosswalker.recipe.hash, and make every existing
		// generated note look recipe-drifted on its next re-import.
		auto_heading: target.auto_heading,
		// Same rule, same reason (Ch 46 source contract §8). Source shaping
		// changes WHICH NOTES EXIST, so it must enter the hash — but a recipe
		// that declares none must hash byte-identically to its pre-1.9.0 self,
		// down to the canonical string. NEVER `?? null` here.
		// tests/source-hash-stability.test.ts pins all 13 shipped recipes.
		source_where: source?.where,
		source_joins: source?.joins,
	});
}
