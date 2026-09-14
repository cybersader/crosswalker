/**
 * vault-path.ts — the normalization a rendered path receives, applied to the
 * pieces recorded beside it.
 *
 * AM-45 (2026-09-02). The layout values and the rendered path are compared
 * BYTE-FOR-BYTE (AM-44), and the rendered path does not reach the vault as
 * render() produced it: the generation engine hands it to Obsidian's
 * `normalizePath` first (`generation-engine.ts`, "Combine basePath with the
 * recipe-relative path"). That function performs four mutations, and a value
 * recorded before them is a different string from the segment it describes:
 *
 *   1. every `\` and every run of separators collapses to a single `/`
 *   2. leading and trailing separators are stripped
 *   3. `U+00A0` and `U+202F` (non-breaking spaces) fold to an ordinary space
 *   4. the whole string is Unicode-normalized to NFC
 *
 * Mutations 1 and 2 change how many segments there are, so they were caught by
 * the arity check that AM-44 replaces. Mutation 4 does not: a source cell
 * carrying a decomposed character (`Zugänge` written as `a` + U+0308, ordinary
 * in exports from macOS and from several CSV toolchains) yields a value whose
 * bytes differ from the segment while the counts agree perfectly.
 *
 * Failure mode prevented: hub identity silently moving. The value form derived
 * `o:hub/zuga-nge` where the shipped, path-derived form derived `o:hub/zug-nge`,
 * so every level hub in an existing vault acquired a second name with no
 * duplicate note and no error to see it by. That is the exact re-identification
 * AM-38's pinning promise exists to make impossible.
 *
 * WHY THIS IS A LOCAL COPY AND NOT AN IMPORT. `src/render` is deliberately free
 * of any `obsidian` import: the recipe engine is runtime-agnostic (v0.1
 * commitment 5), and a pure module is what lets a recipe render outside a vault.
 * The cost of the copy is that it could drift from the host's implementation,
 * and that cost is paid for by AM-44's elementwise check: if these two ever
 * disagree, the hub is refused BY NAME rather than silently re-identified. The
 * copy is what makes them agree; the check is what happens when they do not.
 */

/**
 * The four mutations, in the host's own order, plus the host's own answer for a
 * string that collapses to nothing. Kept as one expression per mutation so a
 * future divergence is visible line by line rather than buried in a chained
 * regex.
 *
 * S5 (2026-09-04). The host returns `'/'` \u2014 the vault root \u2014 for an input that
 * normalizes to the empty string, and both copies returned `''`. A copy that
 * answers a DIFFERENT string than the host is the whole failure this module
 * exists to prevent, and this one is answered in the truthiness direction:
 * `'/'` is truthy and `''` is not, so every caller that guards on "did the user
 * give me a path" read an empty answer as a real one on the host and as an
 * empty one here. See the modal's evidence-path guard, which now tests the RAW
 * input for exactly this reason.
 */
export function normalizeVaultPath(path: string): string {
	let out = path.replace(/([\\/])+/g, '/');
	out = out.replace(/(^\/+|\/+$)/g, '');
	// Escapes, not the characters themselves: a literal non-breaking space in
	// source is invisible and one stray editor pass would silently delete the fold.
	out = out.replace(/\u00A0|\u202F/g, ' ');
	out = out.normalize('NFC');
	return out === '' ? '/' : out;
}

/**
 * One rendered layout segment, in the form the vault path will take, split into
 * the directory pieces it actually contributes.
 *
 * A piece that collapses to nothing contributes no directory (`"IT//OT"` and
 * `"/Identify"` are one and two directories respectively, exactly as the
 * normalized path has them), so it is dropped here for the same reason it
 * disappears there. Dropping on both sides identically is what makes the k-th
 * value and the k-th segment the same string.
 */
export function normalizedPathPieces(segment: string): string[] {
	// S5. A segment that collapses to nothing normalizes to `'/'` (the host's own
	// answer for an empty path), never to `''`, so the empty-string early return
	// this used to carry is gone: the filter below drops the two empty halves
	// `'/'` splits into and reaches the same empty list, and one code path serves
	// both spellings of "this segment contributes no directory".
	const normalized = normalizeVaultPath(segment);
	return normalized.split('/').filter((piece) => piece !== '');
}
