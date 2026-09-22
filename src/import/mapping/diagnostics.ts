/**
 * mapping/diagnostics.ts — recipe-build errors turned into sentences a user can
 * act on.
 *
 * `buildRecipe()` rethrows the schema validator's own wording, which is written
 * for whoever wrote the schema ("/target/layout must not have fewer than 1
 * items"). Two surfaces show that text: the workbench preview rail and the
 * wizard's step-3 banner. Both call THIS module so they say the same thing, and
 * so a new translation lands in both at once.
 *
 * Pure module: NO Obsidian imports.
 */

/**
 * The validator's shape for "this recipe places nothing in the vault". Both
 * pointers report it: `target.layout` is empty because no mapping carries a
 * folder, file-name or one-file destination, and `source.levels` is derived from
 * that same empty layout. The real text is
 * `/source/levels: must NOT have fewer than 1 items`, joined with `; ` when both
 * fire; matched case-insensitively so a validator wording tweak on `NOT` does
 * not silently drop the user back to raw pointer text.
 */
const NOTHING_PLACED = /(\/source\/levels|\/target\/layout)\b[^;]*must not have fewer than 1 items/i;

/** Plain-language replacement for the empty-layout validator error. */
export const NOTHING_PLACED_MESSAGE =
	'No column is set to place notes in the vault. Open a column\'s mapping and turn on File names, Folders, or One file, then try again.';

/**
 * A plain-language sentence for a blocking recipe-build error, or `null` when
 * this error has no translation yet (the caller keeps its own generic wording).
 */
export function explainRecipeError(message: string): string | null {
	return NOTHING_PLACED.test(message) ? NOTHING_PLACED_MESSAGE : null;
}
