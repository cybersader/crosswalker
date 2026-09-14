/**
 * AM-58 (2026-09-04). THIS MODULE HAS NO VALUE IMPORT OF `obsidian`, and that is
 * a load-bearing property rather than a style preference.
 *
 * Failure mode prevented: a spec that stops declaring. AM-57 routed
 * `evidence-link.ts` - a module whose own header promises "no vault access, so
 * the contract below is unit-testable" - through this one, and this one opened
 * with a VALUE import of the host for `normalizePath`. Jest hides that behind
 * `moduleNameMapper`; the wdio/tsx loader does not, and there is no `obsidian`
 * package on disk, so `tests/e2e/ch43-release-drift.spec.ts` (which loads
 * `buildEvidenceLink` on the Node side) died with `Cannot find module 'obsidian'`
 * BEFORE Mocha registered a single line. Nine green declarations simply stopped
 * existing, and a PASS -> FAIL diff cannot see a spec that emits nothing.
 *
 * So: `App` and `TAbstractFile` are TYPE-ONLY (erased at compile time, and a type
 * import cannot drag the host into a Node process), and the normalization calls
 * the AM-45 mirror in `src/render/vault-path.ts` instead of the host.
 *
 * Parity risk, named rather than hidden: the engine's `normalizeBasePath` still
 * uses the host's `normalizePath`, so the output root is normalized by the mirror
 * on the settings side and by the host at the engine boundary. They agree while
 * the mirror is faithful; the mirror's faithfulness is the AM-45 mock-mutation
 * test's job. A divergence is a bug in the mirror, never a second spelling here.
 */
import type { App, TAbstractFile } from 'obsidian';
import { normalizeVaultPath } from '../render/vault-path';
import type { CrosswalkerSettings } from './settings-data';

/**
 * AM-53 (2026-09-04). THE ONE READING of the configured output root.
 *
 * The settings field stores exactly what the person typed. That is deliberate: a
 * text box that rewrites itself under the cursor is hostile, and the folder
 * suggester hands over host paths that are already well formed. What was not
 * deliberate is that every reader then interpreted that raw text for itself.
 *
 * Failure mode prevented: the engine normalized the root at its own boundary
 * (AM-49) and the two surfaces that COUNT what the engine wrote compared against
 * the same setting raw. `getAbstractFileByPath` is a direct key lookup in the
 * vault's file map and normalizes nothing, so a single trailing separator was
 * enough: the import landed correctly under `Frameworks/`, and then
 * `getAbstractFileByPath('Frameworks/')` answered null, the workspace rendered
 * "Nothing imported yet. Run 'Import structured data' to bring in your first
 * framework." and the status bar read 0 ontologies over a vault that had just
 * imported one. The four characters AM-49 exists for (an NBSP pasted from a
 * document, an NFD accent, a backslash, an internal `//`) do the same thing. This
 * is the memory rule `project_reimport_identity_reconciliation` inside its own
 * stated scope: identity, never path, applies to discovery, counting and display
 * too.
 *
 * A normalization applied to what you record must be applied to what you compare
 * it against, and "applied" means through the SAME function, not through a second
 * spelling of it. This is that function.
 */
export function outputRootPath(settings: Pick<CrosswalkerSettings, 'defaultOutputPath'>): string {
	return normalizeFolderSetting(settings.defaultOutputPath);
}

/**
 * AM-53. The normalization itself, for the callers that read a folder from
 * somewhere other than the output-root setting.
 *
 * S6 ruling (2026-09-04) routes `import-set.ts`'s `normalizeFolder` here. That was
 * trim plus edge separators, which is a fraction of one of the host's four
 * mutations - verbatim what AM-49 says `stripSlashes` was and why it was not
 * enough - and its result was then compared against fully normalized vault paths
 * to decide where a refresh believes an import set lives. A second spelling of one
 * normalization is a second answer to one question.
 *
 * AM-57 (2026-09-04). Renamed from `normalizeOutputRoot` because the output root is
 * not the only folder a person types into settings, and every one of them is
 * composed into a vault path the same way. Same body: the rule was never specific
 * to the root, only its name was.
 */
export function normalizeFolderSetting(value: string): string {
	const trimmed = value.trim();
	if (trimmed === '') return '';
	// AM-58. The AM-45 mirror, not the host. See the module header for why, and
	// for where the parity between the two is pinned.
	const normalized = normalizeVaultPath(trimmed);
	// The host's `normalizePath('')` is `'/'` - and the AM-45 mirror answers `'/'`
	// for exactly the same input, which is what makes this swap a no-op rather
	// than a second spelling. `'/'` is TRUTHY, so every
	// `if (!root)` emptiness guard in this product was dead for the supported
	// "Vault root" state (settings renders it as such) and no vault event ever
	// scheduled the ontology status-bar refresh. Both spellings of the root come
	// back as the empty string, which is the same mapping `normalizeBasePath` makes
	// at the engine boundary, so the two agree by construction rather than by
	// inspection.
	return normalized === '/' ? '' : normalized;
}

/**
 * AM-53. The output root AS A VAULT ENTRY, for the surfaces that count what is
 * under it.
 *
 * The empty root is the vault root, whose own key in the file map is `'/'` and not
 * `''`; asking for `''` returns null, which reads to every caller as "nothing is
 * installed". So the one place that difference matters converts back here, beside
 * the mapping that produced it, rather than in each caller.
 */
export function outputRootFile(
	app: App,
	settings: Pick<CrosswalkerSettings, 'defaultOutputPath'>,
): TAbstractFile | null {
	const root = outputRootPath(settings);
	return app.vault.getAbstractFileByPath(root === '' ? '/' : root);
}

/**
 * AM-57. The fallbacks the settings tab writes when a person clears the field, and
 * the fallbacks the accessors apply when the field is not stored at all (S11).
 * Named once so the two cannot drift into disagreeing about where evidence lands.
 */
export const DEFAULT_EVIDENCE_JUNCTION_FOLDER = 'Evidence/Junctions';
export const DEFAULT_EVIDENCE_REPORT_FOLDER = 'Reports';

/**
 * AM-57 (2026-09-04). THE ONE READING of the evidence link folder.
 *
 * Failure mode prevented: the output root's own bug, one settings field over. This
 * value is composed straight into a vault path (`<folder>/<name>-<hash>.md`) which
 * is then handed to `getAbstractFileByPath`, `createFolder` and `create`. Typed
 * with a trailing separator it produced `Evidence/Junctions//X.md`: the occupant
 * check answered null on a key the file map does not hold, so the address refusal
 * that exists to stop a junction from landing on somebody else's note could not
 * fire, and the note was created at a path nobody had normalized. The four
 * characters AM-49 names (an NBSP, a backslash, an internal `//`, a bare `/`) all
 * reach the same place.
 *
 * The default is applied here rather than at each composition site, so "the person
 * cleared the field" has one answer instead of one per caller.
 */
export function evidenceJunctionFolder(
	settings: Partial<Pick<CrosswalkerSettings, 'evidenceJunctionFolder'>>,
): string {
	return evidenceFolderOf(settings.evidenceJunctionFolder, DEFAULT_EVIDENCE_JUNCTION_FOLDER);
}

/** AM-57. THE ONE READING of the coverage report folder. Same rule, same reason. */
export function evidenceReportFolder(
	settings: Partial<Pick<CrosswalkerSettings, 'evidenceReportFolder'>>,
): string {
	return evidenceFolderOf(settings.evidenceReportFolder, DEFAULT_EVIDENCE_REPORT_FOLDER);
}

/**
 * S11 (2026-09-04). These accessors mirror `outputRootPath`, NOT `outputRootFile`:
 * a value that normalizes to nothing IS the vault root, and it is returned as
 * such.
 *
 * Failure mode prevented: the very bug AM-57 exists to remove, one field over -
 * the destination a person chose is not the destination that gets written. The
 * folder suggester offers the vault root and the settings tab stores the bare
 * separator it hands back; `normalizeFolderSetting('/')` is `''` by design, and
 * `'' || DEFAULT` silently substituted `Evidence/Junctions`. The vault root was
 * unreachable for these two settings and nothing said so.
 *
 * The default therefore applies to exactly ONE state: the stored field is
 * `undefined`, i.e. a settings record written before the field existed. An empty
 * or root-shaped value is a choice, not an absence. Composition sites join with a
 * separator only when there is a folder to join, so an empty folder composes
 * `<name>.md` and never `/<name>.md`.
 */
function evidenceFolderOf(stored: string | undefined, fallback: string): string {
	if (stored === undefined) return fallback;
	return normalizeFolderSetting(stored);
}

/**
 * S10 (2026-09-04). THE ONE READING of the Tier 2 sidecar path - the fourth and
 * last path-shaped setting (`settings-data.ts`), which AM-53 and AM-57 routed
 * three of.
 *
 * Failure mode prevented: a second spelling of one normalization, on the setting
 * that decides which file the query index lives in. Both consumers applied a bare
 * `normalizePath`, which does not trim and answers `'/'` where this module answers
 * `''`, so "open the index" and "clear the index" agreed with each other only by
 * both being wrong in the same way; a leading space or a pasted non-breaking space
 * would have keyed the sahpool VFS under a name the pool does not hold, and a
 * clear that finds no files deletes nothing and reports the index as already
 * empty.
 *
 * Unlike the evidence folders above, an empty value takes the DEFAULT here rather
 * than meaning the vault root: this setting names a FILE, and the vault root is
 * not a file name. The settings tab already stores `value || '.crosswalker.sqlite'`
 * for the same reason, so the two agree.
 */
export const DEFAULT_TIER2_SIDECAR_PATH = '.crosswalker.sqlite';

export function tier2SidecarPath(
	settings: Partial<Pick<CrosswalkerSettings, 'tier2SidecarPath'>>,
): string {
	return normalizeSidecarPath(settings.tier2SidecarPath);
}

/**
 * S10. The same reading for a caller that already holds the raw string rather
 * than the settings record (the sidecar module's own two entry points, which are
 * handed a path by their callers and must not re-spell the rule).
 */
export function normalizeSidecarPath(value: string | undefined): string {
	return normalizeFolderSetting(value ?? '') || DEFAULT_TIER2_SIDECAR_PATH;
}
