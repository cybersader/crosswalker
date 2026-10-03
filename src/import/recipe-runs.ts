/**
 * recipe-runs.ts: where a library recipe last ran (run-again slice 2, R1-R3, R7).
 *
 * One record per (recipe id, import set id), kept in plugin settings and never
 * in the recipe JSON: the recipe file is portable and shared, run facts are
 * vault-local. Mirrors `StackRunRecord` (stack-persistence.ts). The record set
 * is closed (D2): no counts, warnings or actor; outcomes belong to the
 * Execution Record (v0.1.8).
 *
 * Pure. Vault access is injected (`discover`, `settle`) so display filtering is
 * unit-testable and the modal reuses `discoverImportSets` / `settleVaultIndex`.
 */

import { computeRecipeDocumentDigest } from '../generation/hash';
import type { CrosswalkerImportRecipe } from '../types/generated/recipe';
import { normalizeRecipe } from './recipe-document';

export type RecipeRunOverwriteMode = 'skip' | 'replace' | 'error';

export interface RecipeRunSource {
	/** File name only, never a vault path. Shown as "Last time: <name>". */
	name: string;
	/** Whole-file byte digest from the parser; absent when the parser gave none. */
	digest?: string;
	sheet?: string;
	headerRow?: number;
	iterator?: string;
}

export interface RecipeRunRecord {
	recipeId: string;
	/** Document digest of the recipe revision that ran (R7 compares against it). */
	recipeDocumentDigest: string;
	importSetId: string;
	source: RecipeRunSource;
	overwriteMode: RecipeRunOverwriteMode;
	/** ISO timestamp of the successful generation. */
	finishedAt: string;
	/** Crosswalker keeps no copy of the source file. 'retained' arrives with the D4 opt-in store. */
	sourceCopy: 'none';
}

/** Oldest `finishedAt` first out beyond this. */
export const RECIPE_RUN_CAP = 200;

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const DIGEST_RE = /^sha256-[a-f0-9]{64}$/;
const OVERWRITE_MODES: readonly RecipeRunOverwriteMode[] = ['skip', 'replace', 'error'];

function runKey(record: Pick<RecipeRunRecord, 'recipeId' | 'importSetId'>): string {
	return `${record.recipeId}\u0000${record.importSetId}`;
}

/** One record, or null when anything about it is malformed. Never throws. */
export function normalizeRecipeRun(value: unknown): RecipeRunRecord | null {
	if (!object(value) || !nonempty(value.recipeId) || !nonempty(value.importSetId)
		|| typeof value.recipeDocumentDigest !== 'string' || !DIGEST_RE.test(value.recipeDocumentDigest)
		|| !nonempty(value.finishedAt) || Number.isNaN(Date.parse(value.finishedAt))
		|| !OVERWRITE_MODES.includes(value.overwriteMode as RecipeRunOverwriteMode)
		|| value.sourceCopy !== 'none' || !object(value.source) || !nonempty(value.source.name)) return null;
	const raw = value.source;
	const source: RecipeRunSource = { name: raw.name as string };
	if (raw.digest !== undefined) {
		if (!nonempty(raw.digest)) return null;
		source.digest = raw.digest;
	}
	if (raw.sheet !== undefined) {
		if (typeof raw.sheet !== 'string') return null;
		source.sheet = raw.sheet;
	}
	if (raw.headerRow !== undefined) {
		if (typeof raw.headerRow !== 'number' || !Number.isInteger(raw.headerRow) || raw.headerRow < 0) return null;
		source.headerRow = raw.headerRow;
	}
	if (raw.iterator !== undefined) {
		if (typeof raw.iterator !== 'string') return null;
		source.iterator = raw.iterator;
	}
	return {
		recipeId: value.recipeId,
		recipeDocumentDigest: value.recipeDocumentDigest,
		importSetId: value.importSetId,
		source,
		overwriteMode: value.overwriteMode as RecipeRunOverwriteMode,
		finishedAt: value.finishedAt,
		sourceCopy: 'none',
	};
}

/**
 * Load-time normalizer (main.ts, beside `normalizeStackRuns`). Drops malformed
 * rows silently, keeps the newest row per (recipe, set), caps at
 * `RECIPE_RUN_CAP` by dropping the oldest. Output is newest first.
 */
export function normalizeRecipeRuns(value: unknown): RecipeRunRecord[] {
	if (!Array.isArray(value)) return [];
	const byKey = new Map<string, RecipeRunRecord>();
	for (const row of value) {
		const record = normalizeRecipeRun(row);
		if (!record) continue;
		const existing = byKey.get(runKey(record));
		if (!existing || finishedMs(record) >= finishedMs(existing)) byKey.set(runKey(record), record);
	}
	return newestFirst([...byKey.values()]).slice(0, RECIPE_RUN_CAP);
}

/** Insert or replace the (recipe, set) record, keeping the list newest first and capped. */
export function upsertRecipeRun(runs: readonly RecipeRunRecord[], record: RecipeRunRecord): RecipeRunRecord[] {
	const key = runKey(record);
	return newestFirst([record, ...runs.filter((run) => runKey(run) !== key)]).slice(0, RECIPE_RUN_CAP);
}

/** Every record for one recipe, newest first. */
export function runsForRecipe(runs: readonly RecipeRunRecord[], recipeId: string): RecipeRunRecord[] {
	return newestFirst(runs.filter((run) => run.recipeId === recipeId));
}

/** Drop records whose set is not in `liveSetIds`. Only call with a settled index (R3). */
export function pruneRecipeRuns(runs: readonly RecipeRunRecord[], liveSetIds: ReadonlySet<string>): RecipeRunRecord[] {
	return runs.filter((run) => liveSetIds.has(run.importSetId));
}

/** What the library may show for one recipe's runs. */
export type RecipeRunDisplay =
	| { state: 'checking' }
	| { state: 'ready'; rows: RecipeRunRow[] };

/** One run the library can show: the record, the set's readable name, and its size. */
export interface RecipeRunRow {
	run: RecipeRunRecord;
	setName: string;
	noteCount?: number;
}

export interface RunSetFacts {
	id: string;
	root: string | null;
	noteCount?: number;
	ontology?: string;
	ontologyPrefixes?: string[];
}

/**
 * R3. Show a record only when its set still exists by minted id. While the
 * vault index is unsettled the answer is "checking", never "missing" (cache
 * lag is not absence). `importRoot` is the import folder setting, so a set
 * name reads relative to it.
 */
export async function displayRecipeRuns(
	runs: readonly RecipeRunRecord[],
	recipeId: string,
	vault: { settle: () => Promise<number>; discover: () => Promise<readonly RunSetFacts[]> },
	importRoot?: string | null,
): Promise<RecipeRunDisplay> {
	const mine = runsForRecipe(runs, recipeId);
	if (!mine.length) return { state: 'ready', rows: [] };
	try {
		if (await vault.settle() > 0) return { state: 'checking' };
		const sets = new Map((await vault.discover()).map((set) => [set.id, set]));
		const rows: RecipeRunRow[] = mine.filter((run) => sets.has(run.importSetId)).map((run) => {
			const set = sets.get(run.importSetId)!;
			const row: RecipeRunRow = { run, setName: runSetDisplayName(set, importRoot) };
			if (set.noteCount !== undefined) row.noteCount = set.noteCount;
			return row;
		});
		return { state: 'ready', rows: disambiguateRunRows(rows) };
	} catch {
		return { state: 'checking' };
	}
}

/** Two rows with one name (sets in same-named folders) both get their size appended. */
function disambiguateRunRows(rows: RecipeRunRow[]): RecipeRunRow[] {
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.setName, (counts.get(row.setName) ?? 0) + 1);
	return rows.map((row) => ((counts.get(row.setName) ?? 0) > 1 && row.noteCount !== undefined
		? { ...row, setName: `${row.setName} (${notesPhrase(row.noteCount)})` }
		: row));
}

/**
 * A set name a user can read: the folder the notes live in, relative to the
 * import folder when it sits inside it (`Team A/nist`), else the folder's own
 * name; then the ontology they hold; then a generic phrase. Never an `iset-`
 * id and never a full path.
 */
export function runSetDisplayName(set: RunSetFacts, importRoot?: string | null): string {
	if (set.root) {
		const parts = set.root.split('/').filter(Boolean);
		const base = (importRoot ?? '').split('/').filter(Boolean);
		if (base.length > 0 && parts.length > base.length && base.every((part, i) => part === parts[i])) {
			return parts.slice(base.length).join('/');
		}
		const leaf = parts[parts.length - 1];
		if (leaf) return leaf;
	}
	const prefix = set.ontology || set.ontologyPrefixes?.[0];
	if (prefix) return prefix;
	return 'an import set';
}

/** "1 note" / "4 notes". */
export function notesPhrase(count: number): string {
	return `${count} ${count === 1 ? 'note' : 'notes'}`;
}

/** R7. True when the recipe's current document digest differs from the one that ran. */
export function recipeChangedSinceRun(run: Pick<RecipeRunRecord, 'recipeDocumentDigest'>, currentDigest: string | null | undefined): boolean {
	return !!currentDigest && currentDigest !== run.recipeDocumentDigest;
}

/**
 * The document digest a run record stores and R7 compares: the same
 * normalization `recipeBasedOn()` uses, over the canonical recipe as the
 * library or registry holds it. Null when the recipe cannot be normalized.
 */
export function recipeRunDigest(recipe: CrosswalkerImportRecipe): string | null {
	try {
		return computeRecipeDocumentDigest(normalizeRecipe(recipe));
	} catch {
		return null;
	}
}

export type SourceRunStatus = 'same' | 'changed' | 'unknown';

/** Identity is the content, not the name: compare digests only. */
export function sourceRunStatus(run: Pick<RecipeRunRecord, 'source'>, currentDigest: string | null | undefined): SourceRunStatus {
	if (!run.source.digest || !currentDigest) return 'unknown';
	return run.source.digest === currentDigest ? 'same' : 'changed';
}

// ---------------------------------------------------------------------------
// Copy (spec 4.1 / 4.2). Sentence case, no em dashes, no internal vocabulary.
// ---------------------------------------------------------------------------

export function formatRunDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

export function lastRunLine(row: { run: RecipeRunRecord; setName: string }): string {
	return `Last run ${formatRunDate(row.run.finishedAt)} into ${row.setName}`;
}

export const CHECKING_VAULT_LINE = 'Checking your vault...';

/**
 * What a refresh does to the notes a set already owns, under the write policy
 * the user has chosen. Copy that promised "updated" under "Skip existing"
 * would be untrue, so every refresh line is built from this one sentence.
 */
export function refreshEffectLine(mode: RecipeRunOverwriteMode): string {
	if (mode === 'replace') return 'Notes it already owns are updated to match the file. New rows become new notes.';
	if (mode === 'skip') return 'Notes it already owns are kept as they are. New rows become new notes.';
	return 'The run stops if a note it would write already exists.';
}

/** The Step 1 lead in Run again mode: which recipe, which set, and what happens. */
export function runAgainLeadLine(recipeName: string, setName: string, noteCount: number | undefined, mode: RecipeRunOverwriteMode): string {
	const size = noteCount === undefined ? '' : ` (${notesPhrase(noteCount)})`;
	return `Running "${recipeName}" again into ${setName}${size}. ${refreshEffectLine(mode)}`;
}

export function chooseFileLine(run: RecipeRunRecord): string {
	return `Choose the source file for this run. Last time it was ${run.source.name}. Crosswalker does not keep a copy of your source.`;
}

/**
 * The Step 1 / review status line, or null when the status is unknown. The
 * second sentence says what the run does to the vault, under the write policy
 * in force. When the recipe itself changed (R7), the "matches" promise is not
 * true, so it is left off and the recipe-changed line carries the news.
 */
export function sourceStatusLine(
	run: RecipeRunRecord,
	status: SourceRunStatus,
	isWorkbook: boolean,
	recipeChanged = false,
	setName: string | null = null,
	mode: RecipeRunOverwriteMode = 'replace',
): string | null {
	const date = formatRunDate(run.finishedAt);
	if (status === 'same') {
		let effect = '';
		if (!recipeChanged && mode === 'replace') effect = ' Running again adds nothing new; it only puts back fields this recipe fills if someone edited them.';
		if (!recipeChanged && mode === 'skip') effect = ' Running again will not change your notes.';
		return `This file matches the last run on ${date}.${effect}`;
	}
	if (status === 'changed') {
		let effect = '';
		if (setName && mode === 'replace') effect = ` Notes in ${setName} will be updated to match it.`;
		if (setName && mode === 'skip') effect = ` New rows are added to ${setName}; notes it already owns are kept.`;
		return `This file changed since the last run on ${date}.${effect}${isWorkbook ? ' Any sheet counts, not only the one you import.' : ''}`;
	}
	return null;
}

/** Review: the set this run refreshes, by its readable name. */
export function refreshingLine(setName: string, noteCount: number, chosenWithRunAgain: boolean): string {
	const owns = noteCount === 1 ? '1 note it already owns' : `${noteCount} notes it already owns`;
	return `Refreshing ${setName} (${owns}).${chosenWithRunAgain ? ' You chose this set with Run again.' : ''}`;
}

/** Step 4 intro when the run refreshes a set. */
export function readyToRefreshLine(setName: string, mode: RecipeRunOverwriteMode): string {
	return `Ready to refresh ${setName}. ${refreshEffectLine(mode)}`;
}

/** Review dropdown: the run-again set that is gone. */
export const STALE_SET_OPTION = 'The set from the last run (no longer in your vault)';

/** Footer hint and button tooltip while Next is disabled on a stale set. */
export const STALE_SET_NEXT_HINT = 'Choose "Import as a new set" first';

/** Step 1 exit from Run again mode. */
export const START_NEW_IMPORT_LABEL = 'Start a new import instead';

export const RECIPE_CHANGED_LINE = 'This recipe changed since the last run. Notes will follow the new version.';

export const STALE_SET_MESSAGE = 'The set this recipe last ran into is no longer in your vault. Choose "Import as a new set" to run it again.';

function finishedMs(run: RecipeRunRecord): number {
	const ms = Date.parse(run.finishedAt);
	return Number.isNaN(ms) ? 0 : ms;
}

function newestFirst(runs: RecipeRunRecord[]): RecipeRunRecord[] {
	return [...runs].sort((a, b) => finishedMs(b) - finishedMs(a));
}
