/**
 * mapping-conversion.ts — convert one mapping set between notes and a table.
 *
 * Slice 4 of the mapping table form (2026-09-30). A set's storage form is
 * pinned at mint; switching it is this job, never a refresh. The job is three
 * idempotent phases behind an on-disk marker (`conversion-marker.ts`):
 *
 *   writing    write the target form from the source form
 *   verifying  re-read both from the vault and compare them row by row
 *   retiring   move the source to the vault trash, then delete the marker
 *
 * Each phase re-reads its inputs from the vault; the marker is the only state
 * carried between phases. So an interruption anywhere (Obsidian closed, a file
 * locked by a sync tool) leaves a vault every reader can use, and
 * `resumeConversion` finishes it. Failure mode prevented: a conversion that
 * loses reviews, or a half-finished one that leaves a set unreadable.
 *
 * One writer per form: a table goes through the durable temp-and-rename write
 * below, notes go through `generateFromRecipe`, so idempotency, folders,
 * identity and provenance of converted notes are the engine's, not a copy.
 */

import { TFile, normalizePath, parseYaml, type App } from 'obsidian';
import manifest from '../../manifest.json';
import type { ParsedData } from '../types/config';
import { generateFromRecipe, prepareMappingConversionNote, resolveWriteTarget, foreignSetClaim, buildNoteContent, type RecipeImportOptions } from '../generation/generation-engine';
import { buildIdentityIndex } from '../generation/identity-index';
import { splitNoteText } from '../generation/note-text';
import { importSetRecipePath } from '../import/import-set-recipes';
import { normalizeMappingSetId, normalizePredicateModifierInput } from '../utils/mapping-provenance';
import { validateTier1Frontmatter } from '../validation/validator';
import { wrapManagedBody, scanRegions } from '../generation/managed-body';
import { conversionManagedKeys, conversionRecipe, conversionRow, expectedConvertedNote } from './mapping-conversion-recipe';
import { selectMappingRecipe, mappingRecipeForGeneration, type SelectedMappingRecipe } from './mapping-recipe';
import {
	discoverImportSets,
	requireVaultIndexed,
	resolveImportSet,
	settleVaultIndex,
	type DiscoveredImportSet,
	type MappingForm,
} from '../generation/import-set';
import { buildProvenance } from '../generation/provenance';
import type { CrosswalkerProvenance } from '../generation/import-set-block';
import { SSSOM_CURIE_PREFIX, crosswalkEdgeCuriePrefix, sssomEdgeCurie } from '../generation/crosswalk-identity';
import { readNoteFrontmatterState } from '../export/vault-reader';
import { normalizeFolderSetting } from '../settings/folder-settings';
import {
	MAPPING_TABLE_FORMAT,
	assignMappingRowIds,
	derivedEdgeCurie,
	edgeFrontmatterToTableRow,
	parseMappingTable,
	REVIEW_STATUSES,
	serializeMappingTable,
	type MappingTableHeader,
	type MappingTableRow,
	type MappingTableRowFacts,
} from './mapping-table';
import { readMappingTables, type MappingTableFile } from './mapping-table-reader';
import { mappingTablePath } from './mapping-table-writer';
import {
	MAPPING_SET_KIND,
	agreed,
	mappingSetFromStored,
	mappingSetFromTableHeader,
	setNoteProvenance,
	storedMappingSet,
	mappingSetNoteDestination,
	type MappingSetRecord,
} from './mapping-set';
import {
	CONVERSION_MARKER_FORMAT,
	conversionMarkerPath,
	deleteConversionMarker,
	importSetIdOf,
	readConversionMarkerFiles,
	serializeConversionMarker,
	type ConversionMarker,
	type ConversionPhase,
} from './conversion-marker';

export type { ConversionPhase } from './conversion-marker';

const PLUGIN_VERSION: string = manifest.version;

export interface ConversionProgress {
	phase: ConversionPhase;
	done: number;
	total: number;
	message: string;
}

/** The injection points the job shares with the stack, so tests can mock them. */
export interface ConversionDeps {
	/** Tier 2 projection, run once after the source is retired. */
	runProjection?: (() => Promise<unknown>) | null;
	/** Closure precompute for the set's framework pair, run after a successful projection. */
	precomputeClosure?: ((sourceOnt: string, targetOnt: string) => Promise<number>) | null;
	/** Defaults to the engine's `generateFromRecipe`. */
	generateFromRecipe?: typeof generateFromRecipe;
}

export interface ConversionResult {
	ok: boolean;
	setId: string;
	from: MappingForm | null;
	to: MappingForm;
	/** Mapping rows the target form holds (0 when the job stopped before verifying). */
	rows: number;
	/** Target rows carrying at least one review value (status, reviewer, or notes). */
	reviewsCarried: number;
	/** The table file, or the folder the notes were written in. */
	targetPath: string | null;
	/** Source artifacts moved to the vault trash by this call. */
	trashed: number;
	/** The phase the job was in when this call returned; `done` once the marker is gone. */
	phaseReached: ConversionPhase | 'done' | 'not-started';
	/** Why the job stopped, naming the set and what to do next. Set when `ok` is false. */
	reason?: string;
	/** Things that did not stop the job but the user should know (a stale query index). */
	warnings: string[];
}

type Progress = (progress: ConversionProgress) => void;

function formLabel(form: MappingForm): string {
	return form === 'table' ? 'a table' : 'notes';
}

function stopped(setId: string, from: MappingForm | null, to: MappingForm, phaseReached: ConversionResult['phaseReached'], reason: string, targetPath: string | null = null, trashed = 0): ConversionResult {
	return { ok: false, setId, from, to, rows: 0, reviewsCarried: 0, targetPath, trashed, phaseReached, reason, warnings: [] };
}

function parentOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash === -1 ? '' : path.slice(0, slash);
}

// ---------------------------------------------------------------------------
// Start, resume, cancel
// ---------------------------------------------------------------------------

/**
 * Start converting `setId` to `to`. Refuses (never throws for an expected
 * refusal) when the set is already converting (resume it instead), does not
 * exist (import it first), or is already stored as `to`.
 */
export async function startConversion(
	app: App,
	deps: ConversionDeps,
	setId: string,
	to: MappingForm,
	onProgress?: Progress,
): Promise<ConversionResult> {
	const from: MappingForm = to === 'table' ? 'notes' : 'table';
	try {
		await requireVaultIndexed(app);
		const markerFiles = (await readConversionMarkerFiles(app)).filter((entry) =>
			entry.marker ? entry.marker.import_set === setId : entry.path.endsWith(`/${setId}.converting.json`) || entry.path === `${setId}.converting.json`);
		if (markerFiles.length) {
			const unusable = markerFiles.find((entry) => !entry.marker);
			return stopped(setId, from, to, 'not-started', unusable
				? `Import set ${setId} has a conversion marker Crosswalker cannot read: ${unusable.error}`
				: `Import set ${setId} is already being converted to ${formLabel(markerFiles[0].marker!.to)}. Finish that conversion instead of starting a new one.`);
		}
		const set = (await discoverImportSets(app)).find((entry) => entry.id === setId);
		if (!set) {
			return stopped(setId, from, to, 'not-started', `Import set ${setId} was not found in the vault. Import the mapping file first, then convert it.`);
		}
		if (set.mapping_form === to) {
			return stopped(setId, from, to, 'not-started', `Import set ${setId} already stores its mappings as ${formLabel(to)}. Nothing needs converting.`);
		}
		const selected = await selectMappingRecipe(app, { setId, operation: to === 'table' ? 'notes-to-table' : 'table-to-notes' });
		const plan = await planConversion(app, set, to, selected);
		if ('reason' in plan) return stopped(setId, from, to, 'not-started', plan.reason);
		const marker: ConversionMarker = {
			format: CONVERSION_MARKER_FORMAT,
			import_set: setId,
			from,
			to,
			phase: 'writing',
			target_path: plan.targetPath,
			source_count: plan.sourceCount,
			started_at: new Date().toISOString(),
			plugin_version: PLUGIN_VERSION,
			path: conversionMarkerPath(plan.folder, setId),
		};
		await prepareConversion(app, marker, selected);
		await app.vault.create(marker.path, serializeConversionMarker(marker));
		return await runPhases(app, deps, marker, onProgress);
	} catch (error) {
		return stopped(setId, from, to, 'not-started', `Could not start converting import set ${setId} to ${formLabel(to)}: ${messageOf(error)}`);
	}
}

/**
 * Finish an interrupted conversion from the phase its marker records. The
 * marker on disk is the authority: `marker` names which one, and is re-read.
 */
export async function resumeConversion(
	app: App,
	deps: ConversionDeps,
	marker: ConversionMarker,
	onProgress?: Progress,
): Promise<ConversionResult> {
	const current = await rereadMarker(app, marker);
	if ('reason' in current) return stopped(marker.import_set, marker.from, marker.to, 'not-started', current.reason);
	return runPhases(app, deps, current.marker, onProgress);
}

/**
 * Cancel a conversion that has not started retiring its source: the target's
 * artifacts go to the vault trash, the marker is deleted, the source is not
 * touched. Refused in `retiring`, where the source is partly gone and only
 * finishing keeps every mapping.
 */
export async function cancelConversion(app: App, marker: ConversionMarker): Promise<void> {
	const current = await rereadMarker(app, marker);
	if ('reason' in current) throw new Error(current.reason);
	const live = current.marker;
	if (live.phase === 'retiring') {
		throw new Error(`The conversion of import set ${live.import_set} to ${formLabel(live.to)} is past the point where it can be cancelled: the ${live.to === 'table' ? 'table' : 'notes'} are verified and the old ${live.from === 'table' ? 'table' : 'notes'} are partly in the trash. Finish the conversion instead.`);
	}
	if (live.to === 'table') {
		await trashIfPresent(app, live.target_path);
		await removeAdapterFile(app, `${live.target_path}.tmp`);
	} else {
		const written = await readSetEdgeNotes(app, live.import_set, parentOf(live.path));
		for (const note of [...written.notes, ...written.releaseNotes]) {
			await app.vault.trash(note.file, false);
		}
	}
	await deleteConversionMarker(app, live);
}

async function rereadMarker(app: App, marker: ConversionMarker): Promise<{ marker: ConversionMarker } | { reason: string }> {
	const entry = (await readConversionMarkerFiles(app)).find((file) => file.path === normalizePath(marker.path));
	if (!entry) return { reason: `No conversion is waiting to finish for import set ${marker.import_set}. Check the set's mapping form in the stack before converting again.` };
	if (!entry.marker) return { reason: entry.error ?? `Conversion marker ${marker.path} cannot be read.` };
	if (entry.marker.import_set !== marker.import_set || entry.marker.from !== marker.from || entry.marker.to !== marker.to || entry.marker.target_path !== marker.target_path || entry.marker.source_count !== marker.source_count) return { reason: 'The conversion marker identity, destination or count changed. Nothing was changed. Reopen the conversion from the stack before finishing it.' };
	return { marker: entry.marker };
}

// ---------------------------------------------------------------------------
// The phase loop
// ---------------------------------------------------------------------------

async function runPhases(app: App, deps: ConversionDeps, start: ConversionMarker, onProgress?: Progress): Promise<ConversionResult> {
	const marker: ConversionMarker = { ...start };
	const { import_set: setId, from, to } = marker;
	let trashed = 0;
	const report = (phase: ConversionPhase, done: number, total: number, message: string) =>
		onProgress?.({ phase, done, total, message });
	try {
		for (;;) {
			const selected = await selectMappingRecipe(app, { setId, operation: 'resume' });
			conversionRecipe(selected);
			const prepared = marker.phase === 'retiring' ? undefined : await prepareConversion(app, marker, selected);
			if (!prepared) await validateTargetLineage(app, marker, selected);
			if (marker.phase === 'writing') {
				report('writing', 0, marker.source_count, `Writing ${formLabel(to)} for import set ${setId}...`);
				const written = await writePreparedConversion(app, deps, marker, prepared!, (done, total) => report('writing', done, total, `Writing notes for import set ${setId}...`));
				if (written) return stopped(setId, from, to, 'writing', written, marker.target_path);
				await assertPreparedSafe(app, marker, prepared!, true);
				await advance(app, marker, 'verifying');
				continue;
			}
			if (marker.phase === 'verifying') {
				report('verifying', 0, marker.source_count, `Checking ${formLabel(to)} against the ${from === 'table' ? 'table' : 'notes'} for import set ${setId}...`);
				const incomplete = await writePreparedConversion(app, deps, marker, prepared!);
				if (incomplete) return stopped(setId, from, to, 'verifying', incomplete, marker.target_path);
				await assertPreparedSafe(app, marker, prepared!, true);
				const mismatch = await verifyParity(app, marker, selected);
				if (mismatch) {
					return stopped(setId, from, to, 'verifying',
						`Converting import set ${setId} to ${formLabel(to)} stopped because the ${to === 'table' ? 'written table does' : 'written notes do'} not match the ${from === 'table' ? 'table' : 'notes'}: ${mismatch}. Nothing was changed or moved to the trash. Restore the exact converted output before finishing, or cancel the conversion.`,
						marker.target_path);
				}
				await assertPreparedSafe(app, marker, prepared!, true);
				await advance(app, marker, 'retiring');
				continue;
			}
			// retiring
			const sources = await sourceArtifacts(app, marker, selected);
			let done = 0;
			report('retiring', 0, sources.length, `Moving the old ${from === 'table' ? 'table' : 'notes'} of import set ${setId} to the trash...`);
			for (const { file, text } of sources) {
				if (!(app.vault.getAbstractFileByPath(file.path) instanceof TFile) || await readTextAt(app, file.path) !== text) conversionConflict(`Source ${file.path} changed before retirement`);
				await app.vault.trash(file, false);
				trashed += 1;
				done += 1;
				report('retiring', done, sources.length, `Moving the old ${from === 'table' ? 'table' : 'notes'} of import set ${setId} to the trash...`);
			}
			if (to === 'table') await removeAdapterFile(app, `${marker.target_path}.tmp`);
			await deleteConversionMarker(app, marker);
			const summary = await summarizeTarget(app, marker);
			const warnings = await projectAndPrecompute(app, deps, summary.frameworks);
			return {
				ok: true, setId, from, to, rows: summary.rows, reviewsCarried: summary.reviews,
				targetPath: marker.target_path, trashed, phaseReached: 'done', warnings,
			};
		}
	} catch (error) {
		return stopped(setId, from, to, marker.phase,
			`Converting import set ${setId} to ${formLabel(to)} was interrupted while ${marker.phase}: ${messageOf(error)} Fix the cause, then finish the conversion.`,
			marker.target_path, trashed);
	}
}

/**
 * Record the next phase on disk, and only then in memory. Failure mode
 * prevented: a marker write that did not land being reported as the phase
 * reached, so the result disagrees with what a resume will actually do.
 */
async function advance(app: App, marker: ConversionMarker, phase: ConversionPhase): Promise<void> {
	const file = app.vault.getAbstractFileByPath(marker.path);
	if (!(file instanceof TFile) || typeof app.vault.process !== 'function') conversionConflict('Current-text guarded phase updates are unavailable');
	await app.vault.process(file, text => {
		if (text !== serializeConversionMarker(marker)) conversionConflict('The conversion marker changed before its phase could advance');
		return serializeConversionMarker({ ...marker, phase });
	});
	marker.phase = phase;
}

function messageOf(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

// ---------------------------------------------------------------------------
// Planning (start only)
// ---------------------------------------------------------------------------

interface ConversionPlan {
	folder: string;
	targetPath: string;
	sourceCount: number;
}

/**
 * Where the job writes and what it starts from. Refuses a set with no single
 * home folder (the marker and the target need one), a notes set holding
 * anything but mapping notes, and a table the notes form cannot hold.
 */
async function planConversion(app: App, set: DiscoveredImportSet, to: MappingForm, selected: SelectedMappingRecipe): Promise<ConversionPlan | { reason: string }> {
	if (set.root === null) {
		return { reason: `Import set ${set.id} does not live under one folder, so Crosswalker cannot tell where the converted form belongs. Move its ${set.mapping_form === 'table' ? 'table' : 'notes'} back under one folder, then convert again.` };
	}
	const folder = set.root;
	conversionRecipe(selected); // closed dependency proof, before marker creation
	if (to === 'table') {
		const read = await readSetEdgeNotes(app, set.id, folder);
		if (read.unreadable.length) return { reason: unreadableReason(set.id, read.unreadable) };
		if (read.others.length) {
			return { reason: `Import set ${set.id} holds notes that are not mappings (${read.others[0]}${read.others.length > 1 ? ` and ${read.others.length - 1} more` : ''}), so it cannot be stored as a table. Only mapping sets can be converted.` };
		}
		if (!read.notes.length) return { reason: `Import set ${set.id} has no mapping notes to convert. Import the mapping file first, then convert it.` };
		const release = releaseRecordOfNotes(set.id, read.releaseNotes);
		if ('reason' in release) return { reason: release.reason };
		const reverse = notesToTableProblem(set.id, read.notes, selected) ?? await notesFidelityProblem(app, read.notes, selected);
		if (reverse) return { reason: reverse };
		const frameworks = agreedFrameworks(read.notes.map((note) => note.frontmatter));
		let targetPath = mappingTablePath(folder, frameworks.source, frameworks.target);
		if (app.vault.getAbstractFileByPath(targetPath)) {
			targetPath = mappingTablePath(folder, frameworks.source, frameworks.target, set.id);
			if (app.vault.getAbstractFileByPath(targetPath)) {
				return { reason: `A file already exists at ${targetPath}, so import set ${set.id} cannot be converted to a table there. Rename or move that file, then convert again.` };
			}
		}
		return { folder, targetPath, sourceCount: read.notes.length };
	}
	const table = await ownedTable(app, set.id);
	if ('reason' in table) return table;
	const release = releaseRecordOfTable(set.id, table.table);
	if ('reason' in release) return { reason: release.reason };
	const problem = notesFormProblem(set.id, table.table, selected);
	if (problem) return { reason: problem };
	return { folder, targetPath: parentOf(table.table.path), sourceCount: table.table.rows.length };
}

// ---------------------------------------------------------------------------
// Reading the two forms
// ---------------------------------------------------------------------------

interface EdgeNote {
	file: TFile;
	frontmatter: Record<string, unknown>;
}

/**
 * The set's markdown notes, by the import set id stamped in each. Cache first;
 * a cache-cold note is read raw only inside `folder`, so the scan never
 * becomes a whole-vault content read (the same bound discovery uses).
 */
async function readSetEdgeNotes(app: App, setId: string, folder: string): Promise<{ notes: EdgeNote[]; releaseNotes: EdgeNote[]; others: string[]; unreadable: string[] }> {
	const base = normalizeFolderSetting(folder);
	const inFolder = (path: string) => !base || path.startsWith(`${base}/`);
	const notes: EdgeNote[] = [];
	const releaseNotes: EdgeNote[] = [];
	const others: string[] = [];
	const unreadable: string[] = [];
	const files = [...app.vault.getMarkdownFiles()].sort((a, b) => a.path.localeCompare(b.path));
	for (const file of files) {
		let fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		if (!fm) {
			if (!inFolder(file.path)) continue;
			const read = await readNoteFrontmatterState(app, file);
			if (read.state === 'unreadable') { unreadable.push(file.path); continue; }
			if (read.state === 'none') continue;
			fm = read.frontmatter;
		}
		if (importSetIdOf(fm._crosswalker) !== setId) continue;
		if (fm.kind === 'crosswalk-edge') notes.push({ file, frontmatter: fm });
		// The set's release record travels with the set; it is not a stray note.
		else if (fm.kind === MAPPING_SET_KIND) releaseNotes.push({ file, frontmatter: fm });
		else others.push(file.path);
	}
	return { notes, releaseNotes, others, unreadable };
}

/**
 * The release record the set's notes carry (M8), undefined for a set without
 * one (M9), or a refusal when it cannot be read or two notes disagree. Failure
 * mode prevented: a conversion silently dropping the release record.
 */
function releaseRecordOfNotes(setId: string, releaseNotes: EdgeNote[]): { record?: MappingSetRecord } | { reason: string } {
	if (!releaseNotes.length) return {};
	try {
		const records = releaseNotes.map((note) => mappingSetFromStored(note.frontmatter, setId, note.file.path));
		const first = JSON.stringify(storedMappingSet(records[0]));
		const other = records.findIndex((record) => JSON.stringify(storedMappingSet(record)) !== first);
		if (other !== -1) {
			return { reason: `Import set ${setId} has two different release records: ${releaseNotes[0].file.path} and ${releaseNotes[other].file.path}. Delete the one that is wrong, then convert again.` };
		}
		return { record: records[0] };
	} catch (error) {
		return { reason: messageOf(error) };
	}
}

/** The release record a table header carries, or a refusal when it cannot be read. */
function releaseRecordOfTable(setId: string, table: MappingTableFile): { record?: MappingSetRecord } | { reason: string } {
	try {
		return { record: mappingSetFromTableHeader(table.header, setId, table.path) };
	} catch (error) {
		return { reason: messageOf(error) };
	}
}

function unreadableReason(setId: string, paths: string[]): string {
	return `Crosswalker could not read the properties of ${paths[0]}${paths.length > 1 ? ` and ${paths.length - 1} more notes` : ''}, so it cannot tell whether they belong to import set ${setId}. Fix their properties blocks, then try again.`;
}

/** The one table whose header names the set, readable in full. */
async function ownedTable(app: App, setId: string): Promise<{ table: MappingTableFile } | { reason: string }> {
	const owned = (await readMappingTables(app)).filter((table) => importSetIdOf(table.header.crosswalker_provenance) === setId);
	if (owned.length !== 1) {
		return { reason: owned.length === 0
			? `Import set ${setId} has no mapping table in the vault. Restore the table from the trash or a backup, then try again.`
			: `Import set ${setId} has ${owned.length} mapping tables: ${owned.map((table) => table.path).join(', ')}. Delete or move all but one, then try again.` };
	}
	const [table] = owned;
	const problems = [...table.errors, ...table.rowErrors];
	if (problems.length) {
		return { reason: `Mapping table ${table.path} has rows Crosswalker could not read, so converting it would lose them. Fix or remove those rows in the file, then try again. Detail: ${problems[0]}` };
	}
	return { table };
}

/** Review statuses a note can store (source: spec/tier1.schema.json via `REVIEW_STATUSES`). */
const NOTE_REVIEW_STATUSES = new Set<string>(REVIEW_STATUSES);

/** Keys a converted note derives itself; a table row may not carry its own. */
const DERIVED_NOTE_KEYS = new Set(['curie', 'kind', 'title', 'tags', '_crosswalker', '_crosswalker_managed_keys']);

/**
 * Why this table cannot become notes without losing something, or null. A
 * refusal before any write beats a conversion that silently drops a value.
 */
function notesFormProblem(setId: string, table: MappingTableFile, selected: SelectedMappingRecipe): string | null {
	if (!table.header.source_framework?.trim() || !table.header.target_framework?.trim()) {
		return `Mapping table ${table.path} does not name its source and target frameworks, so its notes cannot be labelled. Add source_framework and target_framework header lines, then convert again.`;
	}
	const managed = conversionManagedKeys(selected);
	for (const row of table.rows) {
		const problem = rowNotesFormProblem(row, managed, `Mapping ${row.subject_id} -> ${row.object_id} in import set ${setId}`, 'row');
		if (problem) return problem;
	}
	const clash = pairClash(table.rows.map((row) => ({ facts: row, name: `row ${row.row_id}` })), table.header);
	if (clash) {
		return `Rows ${clash[0].name} and ${clash[1].name} of import set ${setId} both map ${clash[0].facts.subject_id} to ${clash[0].facts.object_id}, and the notes form keeps one note for each subject and object pair. Keep this set as a table, or remove one of the two rows, then convert again.`;
	}
	return null;
}

/**
 * Why one mapping's facts cannot be stored as a note, or null. Both directions
 * ask this, so a set converted to a table can always be converted back.
 * `owner` names what the user edits to fix it ('row' or 'note').
 */
function rowNotesFormProblem(row: MappingTableRowFacts, managed: Set<string>, where: string, owner: 'row' | 'note'): string | null {
	if (row.review_status !== undefined && !NOTE_REVIEW_STATUSES.has(row.review_status)) {
		return `${where} has review status "${row.review_status}", which a note cannot store. Change it to proposed, in_review, approved or deprecated, then convert again.`;
	}
	for (const [key, value] of [...Object.entries(row.notes ?? {}), ...Object.entries(row.extra ?? {})]) {
		// An optional template renders nothing for an empty value, so an empty
		// field would silently vanish from the note.
		if (value === '' || value === null || value === undefined) {
			return `${where} has an empty field ${key}, which the notes form cannot carry. Fill it in or remove it from the ${owner}, then convert again.`;
		}
		if (typeof value !== 'string') {
			return `${where} has a field ${key} that is not text, which the notes form cannot carry yet. Make it text or remove it from the ${owner}, then convert again.`;
		}
		if (DERIVED_NOTE_KEYS.has(key) || managed.has(key)) {
			return `${where} carries its own ${key}, which the notes form sets itself. Remove that value from the ${owner}, then convert again.`;
		}
	}
	return null;
}

/**
 * The first two mappings the notes form would store as the same note (one
 * note per subject and object pair), or null.
 */
function pairClash<T extends { facts: Pick<MappingTableRowFacts, 'subject_id' | 'object_id'>; name: string }>(items: T[], header: MappingTableHeader): [T, T] | null {
	const seen = new Map<string, T>();
	for (const item of items) {
		const curie = derivedEdgeCurie(item.facts, header) ?? JSON.stringify([item.facts.subject_id, item.facts.object_id]);
		const earlier = seen.get(curie);
		if (earlier) return [earlier, item];
		seen.set(curie, item);
	}
	return null;
}

/** A note's tags as one comparable key, or null when they are not a list of text. */
function tagsKey(tags: unknown): string | null {
	if (tags === undefined) return '';
	if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) return null;
	return JSON.stringify(tags);
}

/**
 * Why these notes cannot become a table that converts back to the same notes,
 * or null. A table stores one tag list for the whole set and derives each
 * title, and every row must pass the checks the reverse direction applies.
 * Failure mode prevented: a note's own tag, title, or a value the notes form
 * cannot carry passing into (or being dropped by) the table, and the notes
 * then being trashed.
 */
function notesToTableProblem(setId: string, notes: EdgeNote[], selected: SelectedMappingRecipe): string | null {
	const frameworks = agreedFrameworks(notes.map((note) => note.frontmatter));
	if (!frameworks.source || !frameworks.target) {
		return `The notes of import set ${setId} do not all name the same source_framework and target_framework, so a table made from them could not be converted back to notes. Make those two properties agree on every note, then convert again.`;
	}
	for (const note of notes) {
		const fm = note.frontmatter;
		const title = fm.title;
		const previewHeader: MappingTableHeader = { crosswalker_format: MAPPING_TABLE_FORMAT, source_framework: frameworks.source, target_framework: frameworks.target, crosswalker_provenance: fm._crosswalker as CrosswalkerProvenance, tags: fm.tags as string[] };
		const expected = expectedConvertedNote(selected, previewHeader, noteToRowFacts(fm, previewHeader)).frontmatter.title;
		if (title !== undefined && title !== expected) {
			return `Note ${note.file.path} in import set ${setId} has its own title, which a table cannot store. Change the title back to "${expected}", then convert again.`;
		}
		if (tagsKey(fm.tags) === null) {
			return `Note ${note.file.path} in import set ${setId} has tags that are not a list of text, which a table cannot store. Fix its tags, then convert again.`;
		}
	}
	const counts = new Map<string, number>();
	for (const note of notes) {
		const key = tagsKey(note.frontmatter.tags)!;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	if (counts.size > 1) {
		const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
		const odd = notes.find((note) => tagsKey(note.frontmatter.tags) !== common)!;
		return `Note ${odd.file.path} in import set ${setId} has different tags from the other mappings, and a table stores one tag list for the whole set. Remove the extra tag or tag change from ${odd.file.path}, then convert again.`;
	}
	const header: MappingTableHeader = {
		crosswalker_format: MAPPING_TABLE_FORMAT,
		source_framework: frameworks.source,
		target_framework: frameworks.target,
		...(notes[0].frontmatter._crosswalker && typeof notes[0].frontmatter._crosswalker === 'object'
			? { crosswalker_provenance: notes[0].frontmatter._crosswalker as CrosswalkerProvenance }
			: {}),
	};
	const managed = conversionManagedKeys(selected);
	const items: Array<{ facts: MappingTableRowFacts; name: string }> = [];
	for (const note of notes) {
		let facts: MappingTableRowFacts;
		try {
			facts = noteToRowFacts(note.frontmatter, header);
		} catch (error) {
			return `Note ${note.file.path} in import set ${setId} cannot be read as a mapping: ${messageOf(error)}`;
		}
		const problem = rowNotesFormProblem(facts, managed, `Note ${note.file.path} in import set ${setId}`, 'note');
		if (problem) return problem;
		items.push({ facts, name: note.file.path });
	}
	const clash = pairClash(items, header);
	if (clash) {
		return `Notes ${clash[0].name} and ${clash[1].name} in import set ${setId} both map ${clash[0].facts.subject_id} to ${clash[0].facts.object_id}, and the notes form keeps one note for each subject and object pair. Delete or merge one of the two notes, then convert again.`;
	}
	return null;
}

/**
 * Edge-note fields the engine writes as text but YAML can hand back typed
 * (an older note's `sssom_confidence: 0.9` reads as a number; the current
 * `match_confidence` is a number on purpose and is not listed). Put back to text before the
 * codec routes them, so a typed read does not move a managed fact into
 * `extra` and fail the parity check.
 */
const TEXT_FIELDS = [
	'subject_label', 'object_label', 'mapping_justification', 'mapping_provider', 'mapping_set_id',
	'sssom_predicate', 'predicate_modifier', 'subject_note', 'object_note', 'review_status', 'reviewer',
	'sssom_confidence',
] as const;

/**
 * One edge note as table row facts, through the shared codec. The fields the
 * table header or the notes form regenerates (`kind`, the framework pair) are
 * dropped from `extra` when they agree with the header, so a converted table
 * matches one the importer would write. A `curie` the set derives is already
 * dropped by the codec itself (`derivedEdgeCurie`).
 */
function noteToRowFacts(frontmatter: Record<string, unknown>, header: MappingTableHeader): MappingTableRowFacts {
	const normalized: Record<string, unknown> = { ...frontmatter };
	for (const key of TEXT_FIELDS) {
		const value = normalized[key];
		if (typeof value === 'number' || typeof value === 'boolean') normalized[key] = String(value);
	}
	const converted = edgeFrontmatterToTableRow(normalized, header);
	if (!converted.row) throw new Error(converted.error ?? 'A mapping note could not be read as a table row.');
	const row = converted.row;
	if (row.extra) {
		if (row.extra.kind === 'crosswalk-edge') delete row.extra.kind;
		if (row.extra.source_framework === header.source_framework) delete row.extra.source_framework;
		if (row.extra.target_framework === header.target_framework) delete row.extra.target_framework;
		delete row.extra._crosswalker_managed_keys;
		if (!Object.keys(row.extra).length) delete row.extra;
	}
	return row;
}

function agreedFrameworks(notes: Array<Record<string, unknown>>): { source?: string; target?: string } {
	return {
		source: agreed(notes.map((fm) => fm.source_framework)),
		target: agreed(notes.map((fm) => fm.target_framework)),
	};
}

function stringField(record: unknown, key: string): string | undefined {
	if (!record || typeof record !== 'object') return undefined;
	const value = (record as Record<string, unknown>)[key];
	return typeof value === 'string' && value.trim() ? value : undefined;
}

// ---------------------------------------------------------------------------
// Writing the target
// ---------------------------------------------------------------------------

/**
 * The table header for a notes set: the set's pin flipped to table (the only
 * place that happens), and the recipe and source the notes were produced by.
 */
async function tableHeaderFor(app: App, marker: ConversionMarker, notes: EdgeNote[], selected: SelectedMappingRecipe, record?: MappingSetRecord): Promise<MappingTableHeader> {
	const folder = parentOf(marker.path);
	const importSet = await resolveImportSet(app, folder, { id: marker.import_set }, undefined, undefined, undefined, { conversion: { to: 'table' } });
	const first = notes[0].frontmatter._crosswalker as Record<string, unknown> | undefined;
	const sourceRef = first?.source_ref;
	const provenance = buildProvenance({
		sourceFile: stringField(sourceRef, 'file'),
		sourceUrl: stringField(sourceRef, 'url'),
		sourceCurie: stringField(sourceRef, 'curie'),
		sourceVersion: stringField(sourceRef, 'version'),
		sourceHash: stringField(sourceRef, 'source_hash'),
		recipeId: selected.provenanceRecipe.id,
		recipeHash: selected.provenanceRecipe.hash,
		recipeDocumentDigest: selected.provenanceRecipe.recipe_document_digest,
		importSet,
	}, PLUGIN_VERSION) as CrosswalkerProvenance;
	const fms = notes.map((note) => note.frontmatter);
	const frameworks = agreedFrameworks(fms);
	const tagsJson = agreed(fms.map((fm) => Array.isArray(fm.tags) && fm.tags.every((tag) => typeof tag === 'string') ? JSON.stringify(fm.tags) : null));
	// The release record is the authority for the set-level header keys, the
	// same keys the importer writes from it. Agreement across rows is only the
	// fallback for a set without a record (M9).
	const mappingSetId = record ? record.mapping_set_id : agreed(fms.map((fm) => fm.mapping_set_id));
	const mappingProvider = record ? record.mapping_provider : agreed(fms.map((fm) => fm.mapping_provider));
	return {
		...(mappingSetId ? { mapping_set_id: mappingSetId } : {}),
		...(mappingProvider ? { mapping_provider: mappingProvider } : {}),
		...(record?.mapping_date ? { mapping_date: record.mapping_date } : {}),
		...(record?.subject_source ? { subject_source: record.subject_source } : {}),
		...(record?.object_source ? { object_source: record.object_source } : {}),
		...(record?.license ? { license: record.license } : {}),
		crosswalker_format: MAPPING_TABLE_FORMAT,
		import_set: importSet.id,
		...(frameworks.source ? { source_framework: frameworks.source } : {}),
		...(frameworks.target ? { target_framework: frameworks.target } : {}),
		...(tagsJson ? { tags: JSON.parse(tagsJson) as string[] } : {}),
		crosswalker_provenance: provenance,
		...(record ? { mapping_set: storedMappingSet(record) } : {}),
	};
}

async function readTextAt(app: App, path: string): Promise<string | undefined> {
	try {
		if (typeof app.vault.adapter?.read === 'function') return await app.vault.adapter.read(path);
		const file = app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? await app.vault.read(file) : undefined;
	} catch {
		return undefined;
	}
}

async function removeAdapterFile(app: App, path: string): Promise<void> {
	const adapter = app.vault.adapter;
	try {
		if (typeof adapter?.exists === 'function' && typeof adapter?.remove === 'function' && await adapter.exists(path)) {
			await adapter.remove(path);
		}
	} catch {
		// A leftover temp file is harmless: no reader matches its suffix.
	}
}

/**
 * Move a file to the vault trash. A table just renamed into place through the
 * adapter may not be in the vault's file list yet, so the adapter's own trash
 * is the fallback; either way nothing is hard-deleted.
 */
async function trashIfPresent(app: App, path: string): Promise<void> {
	const target = normalizePath(path);
	const file = app.vault.getAbstractFileByPath(target);
	if (file instanceof TFile) {
		await app.vault.trash(file, false);
		return;
	}
	const adapter = app.vault.adapter;
	if (typeof adapter?.exists === 'function' && typeof adapter?.trashLocal === 'function' && await adapter.exists(target)) {
		await adapter.trashLocal(target);
	}
}

// ---------------------------------------------------------------------------
// Verifying
// ---------------------------------------------------------------------------

/** Assertion facts every row must carry unchanged across forms. */
const FACT_FIELDS = [
	'subject_id', 'predicate_id', 'object_id', 'sssom_predicate', 'predicate_modifier',
	'mapping_justification', 'confidence', 'subject_label', 'object_label', 'subject_note',
	'object_note', 'mapping_provider', 'mapping_set_id',
] as const;
/** The values a person owns. */
const REVIEW_FIELDS = ['review_status', 'reviewer'] as const;

/**
 * Equal, or equal as numbers. A numeric-looking text such as a confidence of
 * `0.90` comes back from note YAML as the number 0.9; that is how the note form
 * already stores it, not a conversion loss.
 */
function sameValue(a: string | undefined, b: string | undefined): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined) return false;
	const numeric = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
	return numeric.test(a.trim()) && numeric.test(b.trim()) && Number(a) === Number(b);
}

function notesKey(notes: Record<string, string> | undefined): string {
	return JSON.stringify(Object.entries(notes ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * A row's user fields as one comparable key: keys sorted, and a scalar held as
 * a number, a boolean or numeric-looking text compared by its text form, the
 * same equivalence `sameValue` applies (note YAML hands `42` back as a number).
 */
function extraKey(extra: Record<string, unknown> | undefined): string {
	const numeric = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
	const canonical = (value: unknown): unknown => {
		if (typeof value === 'number' || typeof value === 'boolean') return `scalar:${String(value)}`;
		if (typeof value === 'string') return numeric.test(value.trim()) ? `scalar:${String(Number(value))}` : value;
		return value;
	};
	return JSON.stringify(Object.entries(extra ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)]));
}

/**
 * Compare the two forms row by row. Ids are computed on both sides by
 * `assignMappingRowIds` from the facts, never read from the file, so a table
 * whose `row_id` column was edited cannot pass. Returns what differs, or null.
 */
function compareRows(sourceRows: MappingTableRow[], targetRows: MappingTableRow[], targetLabel: string, sourceLabel: string): string | null {
	if (sourceRows.length !== targetRows.length) {
		return `the ${sourceLabel} hold ${sourceRows.length} mappings and the ${targetLabel} hold ${targetRows.length}`;
	}
	const targetById = new Map(targetRows.map((row) => [row.row_id, row]));
	for (const row of sourceRows) {
		const other = targetById.get(row.row_id);
		const name = `mapping ${row.subject_id} -> ${row.object_id}`;
		if (!other) return `${name} is missing from the ${targetLabel}`;
		for (const field of FACT_FIELDS) {
			if (!sameValue(row[field], other[field])) return `${name} has a different ${field} in the ${targetLabel}`;
		}
		for (const field of REVIEW_FIELDS) {
			if (!sameValue(row[field], other[field])) return `${name} has a different ${field} in the ${targetLabel}`;
		}
		if (notesKey(row.notes) !== notesKey(other.notes)) return `${name} has different review notes in the ${targetLabel}`;
		if (extraKey(row.extra) !== extraKey(other.extra)) return `${name} has different other fields in the ${targetLabel}`;
	}
	return null;
}

function rowsAsFacts(rows: MappingTableRow[]): MappingTableRowFacts[] {
	return rows.map(({ row_id: _id, ...facts }) => facts);
}

/** Whether a release record read from one form equals the record the other form stores. */
function sameRelease(record: MappingSetRecord | undefined, stored: Record<string, unknown> | undefined): boolean {
	if (!record || !stored) return !record && !stored;
	try {
		// Both through one reader, so key order in a hand-written header never counts as a difference.
		const other = mappingSetFromStored(stored, record.importSetId, 'the converted form');
		return JSON.stringify(storedMappingSet(record)) === JSON.stringify(storedMappingSet(other));
	} catch {
		return false;
	}
}

async function verifyParity(app: App, marker: ConversionMarker, selected: SelectedMappingRecipe): Promise<string | null> {
	const folder = parentOf(marker.path);
	if (marker.to === 'table') {
		const text = await readTextAt(app, marker.target_path);
		if (text === undefined) return `the table at ${marker.target_path} could not be read`;
		const parsed = parseMappingTable(text);
		const problems = [...parsed.errors, ...parsed.rowErrors];
		if (problems.length) return `the table at ${marker.target_path} does not read cleanly (${problems[0]})`;
		if (importSetIdOf(parsed.header.crosswalker_provenance) !== marker.import_set) {
			return `the table at ${marker.target_path} names a different import set`;
		}
		const read = await readSetEdgeNotes(app, marker.import_set, folder);
		if (read.unreadable.length) return `${read.unreadable[0]} could not be read`;
		const release = releaseRecordOfNotes(marker.import_set, read.releaseNotes);
		if ('reason' in release) return release.reason.replace(/\.$/, '');
		if (!sameRelease(release.record, parsed.header.mapping_set)) return 'the table carries a different release record from the notes';
		const noteTags = new Set(read.notes.map((note) => tagsKey(note.frontmatter.tags)));
		if (noteTags.size === 1 && [...noteTags][0] !== tagsKey(parsed.header.tags)) return `the table has different tags from the notes`;
		const source = assignMappingRowIds(read.notes.map((note) => noteToRowFacts(note.frontmatter, parsed.header)), parsed.header.mapping_set_id);
		const target = assignMappingRowIds(rowsAsFacts(parsed.rows), parsed.header.mapping_set_id);
		return compareRows(source, target, 'table', 'notes');
	}
	const owned = await ownedTable(app, marker.import_set);
	if ('reason' in owned) return owned.reason.replace(/\.$/, '');
	const header = owned.table.header;
	const read = await readSetEdgeNotes(app, marker.import_set, marker.target_path);
	if (read.unreadable.length) return `${read.unreadable[0]} could not be read`;
	const release = releaseRecordOfNotes(marker.import_set, read.releaseNotes);
	if ('reason' in release) return release.reason.replace(/\.$/, '');
	if (!sameRelease(release.record, header.mapping_set)) return 'the notes carry a different release record from the table';
	for (const note of read.notes) {
		const block = (note.frontmatter._crosswalker as Record<string, unknown> | undefined)?.import_set as Record<string, unknown> | undefined;
		if (block?.mapping_form === 'table') return `${note.file.path} is still pinned to the table form`;
		const expectedTitle = expectedConvertedNote(selected, header, noteToRowFacts(note.frontmatter, header)).frontmatter.title;
		if (note.frontmatter.title !== undefined && note.frontmatter.title !== expectedTitle) return `${note.file.path} has a different title`;
		if (header.tags !== undefined && tagsKey(note.frontmatter.tags) !== tagsKey(header.tags)) return `${note.file.path} has different tags from the table`;
	}
	const source = assignMappingRowIds(rowsAsFacts(owned.table.rows), header.mapping_set_id);
	const target = assignMappingRowIds(read.notes.map((note) => noteToRowFacts(note.frontmatter, header)), header.mapping_set_id);
	return compareRows(source, target, 'notes', 'table') ?? await notesFidelityProblem(app, read.notes, selected, header);
}

// ---------------------------------------------------------------------------
// Retiring and the final summary
// ---------------------------------------------------------------------------

/** What is left of the source form, re-read from the vault. */
async function sourceArtifacts(app: App, marker: ConversionMarker, selected: SelectedMappingRecipe): Promise<Array<{ file: TFile; text: string }>> {
	if (marker.from === 'notes') {
		const read = await readSetEdgeNotes(app, marker.import_set, parentOf(marker.path));
		if (read.unreadable.length) throw new Error(unreadableReason(marker.import_set, read.unreadable));
		const sources: Array<{ file: TFile; text: string }> = [];
		const assertions = new Set(read.notes);
		for (const note of [...read.notes, ...read.releaseNotes]) {
			const text = await readTextAt(app, note.file.path);
			if (text === undefined) conversionConflict(`Source ${note.file.path} cannot be read before retirement`);
			note.frontmatter = rawNote(text).frontmatter;
			if (importSetIdOf(note.frontmatter._crosswalker) !== marker.import_set || note.frontmatter.kind !== (assertions.has(note) ? 'crosswalk-edge' : MAPPING_SET_KIND)) conversionConflict(`Source ${note.file.path} changed before retirement`);
			sources.push({ file: note.file, text });
		}
		if (read.others.length || read.notes.some(note => !sameRecipeStamp(note.frontmatter._crosswalker, selected))) throw new Error('The remaining source notes have unverifiable ownership or recipe lineage. Nothing was retired. Restore their verified versions before finishing the conversion.');
		const target = parseMappingTable((await readTextAt(app, marker.target_path)) ?? '');
		const remaining = assignMappingRowIds(read.notes.map(note => noteToRowFacts(note.frontmatter, target.header)), target.header.mapping_set_id);
		const ids = new Set(remaining.map(row => row.row_id));
		if (target.header.tags !== undefined && read.notes.some(note => tagsKey(note.frontmatter.tags) !== tagsKey(target.header.tags))) throw new Error('The remaining source tags no longer agree with the verified target. Nothing was retired. Restore their verified versions before finishing the conversion.');
		const mismatch = compareRows(remaining, target.rows.filter(row => ids.has(row.row_id)), 'verified table', 'remaining notes')
			?? await notesFidelityProblem(app, read.notes, selected, target.header);
		if (mismatch) throw new Error(`The remaining source no longer matches the verified target: ${mismatch}. Nothing was retired. Restore the verified versions before finishing the conversion.`);
		const release = releaseRecordOfNotes(marker.import_set, read.releaseNotes);
		if ('reason' in release || (release.record && !sameRelease(release.record, target.header.mapping_set))) throw new Error('The remaining release record no longer agrees with the verified target. Nothing was retired. Restore its verified version before finishing the conversion.');
		return sources;
	}
	const files: Array<{ file: TFile; text: string }> = [];
	for (const listed of await readMappingTables(app)) {
		if (importSetIdOf(listed.header.crosswalker_provenance) !== marker.import_set) continue;
		const text = await readTextAt(app, listed.path);
		if (text === undefined) conversionConflict(`Source ${listed.path} cannot be read before retirement`);
		const table = { ...listed, ...parseMappingTable(text) };
		if (importSetIdOf(table.header.crosswalker_provenance) !== marker.import_set) conversionConflict(`Source ${listed.path} changed before retirement`);
		if (!table.readable || table.errors.length || table.rowErrors.length || !sameRecipeStamp(table.header.crosswalker_provenance, selected)) throw new Error('The remaining source table is unreadable or has unverifiable recipe lineage. Nothing was retired. Restore its verified version before finishing the conversion.');
		const target = await readSetEdgeNotes(app, marker.import_set, marker.target_path);
		const release = releaseRecordOfNotes(marker.import_set, target.releaseNotes);
		if ('reason' in release || !sameRelease(release.record, table.header.mapping_set) || (table.header.tags !== undefined && target.notes.some(note => tagsKey(note.frontmatter.tags) !== tagsKey(table.header.tags)))) throw new Error('The remaining source tags or release record no longer agree with the verified target. Nothing was retired. Restore its verified version before finishing the conversion.');
		const targetRows = assignMappingRowIds(target.notes.map(note => noteToRowFacts(note.frontmatter, table.header)), table.header.mapping_set_id);
		const mismatch = compareRows(assignMappingRowIds(rowsAsFacts(table.rows), table.header.mapping_set_id), targetRows, 'verified notes', 'remaining table');
		if (mismatch) throw new Error(`The remaining source no longer matches the verified target: ${mismatch}. Nothing was retired. Restore its verified version before finishing the conversion.`);
		const file = app.vault.getAbstractFileByPath(table.path);
		if (file instanceof TFile) files.push({ file, text });
	}
	return files;
}

async function summarizeTarget(app: App, marker: ConversionMarker): Promise<{ rows: number; reviews: number; frameworks: { source?: string; target?: string } }> {
	const hasReview = (row: Pick<MappingTableRow, 'review_status' | 'reviewer' | 'notes'>) =>
		row.review_status !== undefined || row.reviewer !== undefined || Object.keys(row.notes ?? {}).length > 0;
	if (marker.to === 'table') {
		const text = await readTextAt(app, marker.target_path);
		const parsed = parseMappingTable(text ?? '');
		return {
			rows: parsed.rows.length,
			reviews: parsed.rows.filter(hasReview).length,
			frameworks: { source: parsed.header.source_framework, target: parsed.header.target_framework },
		};
	}
	const read = await readSetEdgeNotes(app, marker.import_set, marker.target_path);
	const header: MappingTableHeader = { crosswalker_format: MAPPING_TABLE_FORMAT };
	const rows = read.notes.map((note) => noteToRowFacts(note.frontmatter, header));
	return {
		rows: rows.length,
		reviews: rows.filter(hasReview).length,
		frameworks: agreedFrameworks(read.notes.map((note) => note.frontmatter)),
	};
}

/**
 * Projection, then closure, once, after the marker is gone, so the query index
 * reflects the converted form. A failure here does not undo the conversion; it
 * is reported so the user refreshes the query database.
 */
async function projectAndPrecompute(app: App, deps: ConversionDeps, frameworks: { source?: string; target?: string }): Promise<string[]> {
	const warnings: string[] = [];
	if (!deps.runProjection) return warnings;
	if (await settleVaultIndex(app, 30_000) > 0) {
		warnings.push('Some notes are still indexing, so the query database was not refreshed. Refresh the query database once indexing finishes.');
		return warnings;
	}
	try {
		const outcome = await deps.runProjection();
		if (outcome && typeof outcome === 'object' && 'success' in outcome && (outcome as { success: unknown }).success === false) {
			warnings.push('The query database refresh was incomplete. Refresh the query database before using mapping chains.');
			return warnings;
		}
	} catch {
		warnings.push('The query database refresh failed. Refresh the query database before using mapping chains.');
		return warnings;
	}
	if (deps.precomputeClosure && frameworks.source && frameworks.target) {
		try {
			await deps.precomputeClosure(frameworks.source, frameworks.target);
		} catch {
			warnings.push('Mapping chains could not be precomputed. Refresh the query database before using mapping chains.');
		}
	}
	return warnings;
}


function sameRecipeStamp(provenance: unknown, selected: SelectedMappingRecipe): boolean {
 const recipe = provenance && typeof provenance === 'object' ? (provenance as Record<string, unknown>).recipe : undefined;
 if (!recipe || typeof recipe !== 'object') return false;
 const stamp = recipe as Record<string, unknown>;
 return stamp.id === selected.provenanceRecipe.id && stamp.hash === selected.provenanceRecipe.hash && stamp.recipe_document_digest === selected.provenanceRecipe.recipe_document_digest;
}
async function validateTargetLineage(app: App, marker: ConversionMarker, selected: SelectedMappingRecipe): Promise<void> {
 if (marker.to === 'table') {
  const file = app.vault.getAbstractFileByPath(marker.target_path);
  const text = await readTextAt(app, marker.target_path);
  if (!file && text === undefined && marker.phase === 'writing') return;
  const parsed = parseMappingTable(text ?? '');
  if ((marker.phase !== 'writing' && parsed.rows.length !== marker.source_count) || parsed.errors.length || parsed.rowErrors.length || importSetIdOf(parsed.header.crosswalker_provenance) !== marker.import_set || !sameRecipeStamp(parsed.header.crosswalker_provenance, selected)) throw new Error('The partial or verified target table has unverifiable ownership, contents or recipe lineage. It was left unchanged. Restore its exact saved version before finishing the conversion.');
 } else {
  const read = await readSetEdgeNotes(app, marker.import_set, marker.target_path);
  if ((marker.phase !== 'writing' && read.notes.length !== marker.source_count) || read.unreadable.length || read.others.length || read.notes.some(n => (marker.target_path && !n.file.path.startsWith(`${marker.target_path.replace(/\/$/, '')}/`)) || !sameRecipeStamp(n.frontmatter._crosswalker, selected))) throw new Error('The partial or verified target notes have unverifiable ownership or recipe lineage. They were left unchanged. Restore their exact saved versions before finishing the conversion.');
 }
}
async function notesFidelityProblem(app: App, notes: EdgeNote[], selected: SelectedMappingRecipe, supplied?: MappingTableHeader): Promise<string | null> {
 for (const note of notes) {
  const fm = note.frontmatter;
  const header: MappingTableHeader = supplied ?? { crosswalker_format: MAPPING_TABLE_FORMAT, source_framework: String(fm.source_framework), target_framework: String(fm.target_framework), crosswalker_provenance: fm._crosswalker as CrosswalkerProvenance, tags: fm.tags as string[] };
  const expected = expectedConvertedNote(selected, header, noteToRowFacts(fm, header));
  for (const [key, value] of Object.entries(expected.address.frontmatter)) {
   if (['review_status', 'reviewer'].includes(key)) continue;
   if (JSON.stringify(fm[key]) !== JSON.stringify(value)) return `Note ${note.file.path} has a different recipe-managed ${key}, which the selected original cannot reproduce from the table`;
  }
  const text = await app.vault.read(note.file);
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/\r\n/g, '\n');
  const scan = scanRegions(body);
  if (!scan.ok || scan.spans.length !== 1 || scan.spans[0].name !== 'body') return `Note ${note.file.path} has an unverified managed body that the table cannot reproduce`;
  const span = scan.spans[0];
  if (body.slice(0, span.outerStart).trim() || body.slice(span.outerEnd).trim()) return `Note ${note.file.path} has user body content that a table cannot carry; keep it as notes`;
  if (body.slice(span.outerStart, span.outerEnd) !== wrapManagedBody(expected.body).trimEnd()) return `Note ${note.file.path} has recipe-managed body content that the table cannot reproduce`;
 }
 return null;
}


interface PreparedConversion {
 sources: Map<string, string>;
 sourceStats: Map<string, { mtime: number; size: number }>;
 sourceAssertions: string[];
 sourceReleases: string[];
 markerText?: string;
 artifacts: Map<string, string>;
 table?: { header: MappingTableHeader; rows: MappingTableRow[] };
 notes?: { data: ParsedData & { rows: Record<string, unknown>[] }; recipe: ReturnType<typeof conversionRecipe>; options: RecipeImportOptions; rowPaths: string[]; releasePath?: string };
}
function conversionConflict(detail: string): never {
 throw new Error(`${detail}. No changed data was overwritten or deleted. Inspect the partial output and restore its expected contents before finishing, or cancel the conversion.`);
}
function rawNote(text: string): { frontmatter: Record<string, unknown>; body: string } {
 const { frontmatterText, body } = splitNoteText(text);
 const frontmatter = parseYaml(frontmatterText) as unknown;
 if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) conversionConflict('A conversion note has unreadable properties');
 return { frontmatter: frontmatter as Record<string, unknown>, body };
}
function canonical(value: unknown): string {
 const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v;
 return JSON.stringify(sort(value));
}
function withoutGeneratedRunFields(frontmatter: Record<string, unknown>, provenanceKey = '_crosswalker'): Record<string, unknown> {
 const copy = { ...frontmatter };
 const provenance = copy[provenanceKey];
 if (provenance && typeof provenance === 'object' && !Array.isArray(provenance)) {
  const block = { ...provenance as Record<string, unknown> }; delete block.produced_at;
  if (block.producer && typeof block.producer === 'object' && !Array.isArray(block.producer)) {
   const producer = { ...block.producer as Record<string, unknown> }; delete producer.version; block.producer = producer;
  }
  copy[provenanceKey] = block;
 }
 return copy;
}
function targetProblem(plan: PreparedConversion, path: string, text: string): string | null {
 if (plan.table) {
  const parsed = parseMappingTable(text);
  if (parsed.errors.length || parsed.rowErrors.length) return 'The existing target table cannot be read in full';
  if (canonical(withoutGeneratedRunFields(parsed.header as unknown as Record<string, unknown>, 'crosswalker_provenance')) !== canonical(withoutGeneratedRunFields(plan.table.header as unknown as Record<string, unknown>, 'crosswalker_provenance'))) return 'The existing target table header differs from the source-prepared output';
  const expected = new Map(plan.table.rows.map(row => [row.row_id, row]));
  for (const row of parsed.rows) if (!expected.has(row.row_id) || canonical(row) !== canonical(expected.get(row.row_id))) return 'The existing target table assertion differs from the source-prepared output';
  return null;
 }
 const expectedText = plan.artifacts.get(path);
 if (expectedText === undefined) return 'An additional target note is not part of the source-prepared output';
 const current = rawNote(text); const expected = rawNote(expectedText);
 if (canonical(withoutGeneratedRunFields(current.frontmatter)) !== canonical(withoutGeneratedRunFields(expected.frontmatter)) || current.body !== expected.body) return `The existing target note ${path} differs from the source-prepared output`;
 return null;
}
function sourceStat(app: App, path: string): { mtime: number; size: number } | undefined {
 const file = app.vault.getAbstractFileByPath(path);
 if (!(file instanceof TFile) || !file.stat || !Number.isFinite(file.stat.mtime) || !Number.isFinite(file.stat.size) || file.stat.size < 0) return undefined;
 return { mtime: file.stat.mtime, size: file.stat.size };
}
async function captureSource(app: App, plan: PreparedConversion, path: string): Promise<string> {
 const text = await readTextAt(app, path);
 if (text === undefined) conversionConflict(`Source ${path} cannot be read`);
 plan.sources.set(path, text);
 const stat = sourceStat(app, path); if (stat) plan.sourceStats.set(path, stat);
 return text;
}
async function checkDestination(app: App, path: string): Promise<void> {
 if (!path || normalizePath(path) !== path || path === '.md') conversionConflict('The prepared target has an invalid normalized address');
 const pieces = path.split('/');
 for (let n = 1; n < pieces.length; n++) {
  const ancestor = app.vault.getAbstractFileByPath(pieces.slice(0, n).join('/'));
  if (ancestor instanceof TFile) conversionConflict(`A file occupies the prepared target folder ${ancestor.path}`);
  if (!ancestor && await app.vault.adapter?.exists?.(pieces.slice(0, n).join('/'))) conversionConflict('A prepared target folder is not indexed yet');
 }
 const existing = app.vault.getAbstractFileByPath(path);
 if (existing && !(existing instanceof TFile)) conversionConflict(`A folder occupies the prepared target file ${path}`);
 if (!existing && await app.vault.adapter?.exists?.(path)) conversionConflict(`The prepared target ${path} is not indexed yet`);
}
/** One complete, mutation-free source-to-target preparation, shared by start and execution. */
async function prepareConversion(app: App, marker: ConversionMarker, selected: SelectedMappingRecipe): Promise<PreparedConversion> {
 if (typeof app.vault.process !== 'function') conversionConflict('Current-text guarded conversion updates are unavailable');
 const plan: PreparedConversion = { sources: new Map(), sourceStats: new Map(), sourceAssertions: [], sourceReleases: [], markerText: await readTextAt(app, marker.path), artifacts: new Map() };
 const originalPath = importSetRecipePath(marker.import_set, selected.provenanceRecipe.recipe_document_digest);
 if (!originalPath) conversionConflict('The retained original has no valid storage address');
 await captureSource(app, plan, originalPath);
 if (marker.to === 'table') {
  const read = await readSetEdgeNotes(app, marker.import_set, parentOf(marker.path));
  if (read.unreadable.length || read.others.length || read.releaseNotes.length > 1) conversionConflict('The source notes or duplicate release records cannot be verified');
  for (const note of [...read.notes, ...read.releaseNotes]) {
   const assertion = read.notes.includes(note);
   note.frontmatter = rawNote(await captureSource(app, plan, note.file.path)).frontmatter;
   if (importSetIdOf(note.frontmatter._crosswalker) !== marker.import_set || note.frontmatter.kind !== (assertion ? 'crosswalk-edge' : MAPPING_SET_KIND) || (assertion && !sameRecipeStamp(note.frontmatter._crosswalker, selected))) conversionConflict('The raw source ownership, kind or recipe changed after selection');
  }
  plan.sourceAssertions = read.notes.map(note => note.file.path).sort(); plan.sourceReleases = read.releaseNotes.map(note => note.file.path).sort();
  const problem = notesToTableProblem(marker.import_set, read.notes, selected) ?? await notesFidelityProblem(app, read.notes, selected);
  if (problem) conversionConflict(problem);
  const release = releaseRecordOfNotes(marker.import_set, read.releaseNotes); if ('reason' in release) conversionConflict(release.reason);
  const header = await tableHeaderFor(app, marker, read.notes, selected, release.record);
  const rows = assignMappingRowIds(read.notes.map(note => noteToRowFacts(note.frontmatter, header)), header.mapping_set_id);
  plan.table = { header, rows }; plan.artifacts.set(marker.target_path, serializeMappingTable(header, rows));
 } else {
  const owned = await ownedTable(app, marker.import_set); if ('reason' in owned) conversionConflict(owned.reason);
  const text = await captureSource(app, plan, owned.table.path); const parsed = parseMappingTable(text);
  const table = { ...owned.table, ...parsed }; plan.sourceAssertions = [table.path];
  if (parsed.errors.length || parsed.rowErrors.length || importSetIdOf(parsed.header.crosswalker_provenance) !== marker.import_set || !sameRecipeStamp(parsed.header.crosswalker_provenance, selected)) conversionConflict('The raw source table changed after selection');
  const problem = notesFormProblem(marker.import_set, table, selected); if (problem) conversionConflict(problem);
  const carried = new Map<string, string>();
  for (const row of table.rows) for (const key of [...Object.keys(row.notes ?? {}), ...Object.keys(row.extra ?? {})]) if (!carried.has(key)) carried.set(key, `conversion_field_${carried.size}`);
  const rows = table.rows.map(row => conversionRow(row, carried));
  const recipe = conversionRecipe(selected, carried, table.header.tags);
  const provenance = table.header.crosswalker_provenance as Record<string, unknown>; const sourceRef = provenance.source_ref;
  const sourceHash = stringField(sourceRef, 'source_hash');
  const data: ParsedData & { rows: Record<string, unknown>[] } = { columns: [...new Set(rows.flatMap(row => Object.keys(row)))], rows, rowCount: rows.length, ...(sourceHash ? { sourceByteDigest: sourceHash } : {}) };
  const options: RecipeImportOptions = { concurrency: 1, basePath: marker.target_path, overwriteMode: 'skip', createFolders: true, importSet: { id: marker.import_set }, mappingConversion: { to: 'notes' }, provenanceRecipe: mappingRecipeForGeneration(selected), sourceFileName: stringField(sourceRef, 'file') ?? table.header.mapping_set_id, sourceVersion: stringField(sourceRef, 'version'), strictValidation: true, curieLocalPart: (row, _row, set) => sssomEdgeCurie(row, set), curiePrefix: SSSOM_CURIE_PREFIX };
  const importSet = await resolveImportSet(app, options.basePath, options.importSet, SSSOM_CURIE_PREFIX, undefined, undefined, { conversion: { to: 'notes' } });
  const ownedIndex = await buildIdentityIndex(app, { importSetId: marker.import_set }); const index = await buildIdentityIndex(app);
  const rowPaths: string[] = [];
  for (const row of rows) {
   const scope = { ...row, mapping_set_id: normalizeMappingSetId(row.mapping_set_id), predicate_modifier: normalizePredicateModifierInput(row.predicate_modifier) };
   const curie = `${crosswalkEdgeCuriePrefix(importSet.ontology ?? SSSOM_CURIE_PREFIX)}:${sssomEdgeCurie(scope, importSet)}`;
   const prepared = prepareMappingConversionNote(recipe, curie, row, scope, options, importSet, data.sourceByteDigest);
   if (!validateTier1Frontmatter(prepared.frontmatter).valid) conversionConflict(`The prepared assertion at ${prepared.fullPath} does not satisfy the note contract`);
   if (foreignSetClaim(ownedIndex, index, curie)) conversionConflict(`The prepared identity ${curie} belongs to another import set`);
   if (plan.artifacts.has(prepared.fullPath)) conversionConflict(`Path collision: multiple source assertions prepare ${prepared.fullPath}`);
   const target = resolveWriteTarget(app, prepared.fullPath, curie, false, ownedIndex, index, marker.import_set);
   if (target.refusal || target.moveFrom || target.writePath !== prepared.fullPath || index.collisions.some(collision => collision.curie === curie)) conversionConflict(`The prepared destination ${prepared.fullPath} has an incompatible identity or owner`);
   plan.artifacts.set(prepared.fullPath, buildNoteContent(prepared.frontmatter, wrapManagedBody(prepared.managedBody))); rowPaths.push(prepared.fullPath);
  }
  plan.notes = { data, recipe, options, rowPaths };
  const release = releaseRecordOfTable(marker.import_set, table); if ('reason' in release) conversionConflict(release.reason);
  if (release.record) {
   const targetNotes = await readSetEdgeNotes(app, marker.import_set, marker.target_path);
   if (targetNotes.releaseNotes.length > 1) conversionConflict('Duplicate target release records cannot be repaired by conversion');
   const ownedRelease = targetNotes.releaseNotes[0]?.file.path;
   const path = ownedRelease ?? mappingSetNoteDestination(marker.target_path, release.record, path => plan.artifacts.has(path) || !!app.vault.getAbstractFileByPath(path));
   if (plan.artifacts.has(path)) conversionConflict(`Path collision: release and assertion prepare ${path}`);
   const edge = rawNote(plan.artifacts.get(rowPaths[0])!).frontmatter._crosswalker as Record<string, unknown>;
   plan.artifacts.set(path, buildNoteContent({ ...storedMappingSet(release.record), _crosswalker: setNoteProvenance(edge) }, '')); plan.notes.releasePath = path;
  }
 }
 for (const path of plan.artifacts.keys()) await checkDestination(app, path);
 await assertPreparedSafe(app, marker, plan);
 return plan;
}
async function assertPreparedSafe(app: App, marker: ConversionMarker, plan: PreparedConversion, complete = false): Promise<void> {
 if (await readTextAt(app, marker.path) !== plan.markerText) conversionConflict('The conversion marker changed after preparation');
 for (const [path, text] of plan.sources) if (await readTextAt(app, path) !== text) conversionConflict(`Source ${path} changed after preparation`);
 if (marker.from === 'notes') {
  const read = await readSetEdgeNotes(app, marker.import_set, parentOf(marker.path));
  if (read.unreadable.length || read.others.length || canonical(read.notes.map(note => note.file.path).sort()) !== canonical(plan.sourceAssertions) || canonical(read.releaseNotes.map(note => note.file.path).sort()) !== canonical(plan.sourceReleases)) conversionConflict('The source population changed after preparation');
 } else {
  const tables = (await readMappingTables(app)).filter(table => importSetIdOf(table.header.crosswalker_provenance) === marker.import_set);
  if (canonical(tables.map(table => table.path).sort()) !== canonical(plan.sourceAssertions)) conversionConflict('The source table population changed after preparation');
  const read = await readSetEdgeNotes(app, marker.import_set, marker.target_path);
  if (read.unreadable.length || read.others.length || [...read.notes, ...read.releaseNotes].some(note => !plan.artifacts.has(note.file.path))) conversionConflict('Additional or unreadable target notes are not in the prepared output');
 }
 for (const path of plan.artifacts.keys()) {
  await checkDestination(app, path);
  const text = await readTextAt(app, path);
  if (text === undefined) { if (app.vault.getAbstractFileByPath(path) || complete) conversionConflict(`Prepared target ${path} is missing or unreadable`); continue; }
  const problem = targetProblem(plan, path, text); if (problem) conversionConflict(problem);
  if (complete && plan.table && parseMappingTable(text).rows.length !== plan.table.rows.length) conversionConflict('The prepared target table is incomplete');
 }
}
/** Per-row boundary: compare source stats (bytes only without stats) and this destination, never rescan populations. */
async function assertWriteSafe(app: App, marker: ConversionMarker, plan: PreparedConversion, path: string): Promise<void> {
 if (await readTextAt(app, marker.path) !== plan.markerText) conversionConflict('The conversion marker changed after preparation');
 for (const [source, text] of plan.sources) {
  const expected = plan.sourceStats.get(source); const current = sourceStat(app, source);
  if (expected && current) {
   if (current.mtime !== expected.mtime || current.size !== expected.size) conversionConflict(`Source ${source} changed after preparation`);
  } else if (await readTextAt(app, source) !== text) conversionConflict(`Source ${source} changed after preparation`);
 }
 if (!plan.artifacts.has(path)) conversionConflict(`Target ${path} is not part of the prepared output`);
 await checkDestination(app, path);
 const text = await readTextAt(app, path);
 if (text === undefined) { if (app.vault.getAbstractFileByPath(path)) conversionConflict(`Prepared target ${path} is unreadable`); return; }
 const problem = targetProblem(plan, path, text); if (problem) conversionConflict(problem);
}
async function writePreparedConversion(app: App, deps: ConversionDeps, marker: ConversionMarker, plan: PreparedConversion, onProgress: (done: number, total: number) => void = () => {}): Promise<string | null> {
 await assertPreparedSafe(app, marker, plan);
 if (plan.table) {
  const path = marker.target_path; const expected = plan.artifacts.get(path)!; const current = await readTextAt(app, path);
  if (current !== undefined && parseMappingTable(current).rows.length === plan.table.rows.length) return null;
  await assertPreparedSafe(app, marker, plan);
  const file = app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) {
   if (typeof app.vault.process !== 'function') conversionConflict('Current-text guarded table updates are unavailable');
   await app.vault.process(file, text => { const problem = targetProblem(plan, path, text); if (problem) conversionConflict(problem); return expected; });
  } else await app.vault.create(path, expected);
  return null;
 }
 const notes = plan.notes!;
 const missing: Record<string, unknown>[] = []; const sourceRows: number[] = [];
 for (let index = 0; index < notes.rowPaths.length; index++) if (await readTextAt(app, notes.rowPaths[index]) === undefined) { missing.push(notes.data.rows[index]); sourceRows.push(index + 1); }
 if (missing.length) {
  await assertPreparedSafe(app, marker, plan);
  const gen = await (deps.generateFromRecipe ?? generateFromRecipe)(app, { ...notes.data, rows: missing, rowCount: missing.length }, notes.recipe, { ...notes.options, mappingConversion: { to: 'notes', beforeWrite: path => path === undefined ? assertPreparedSafe(app, marker, plan) : assertWriteSafe(app, marker, plan, path) }, onProgress });
  if (!gen.success || gen.errors.length) {
   // Engine error rows are 1-based positions in missing, not in the original source rows.
   const error = gen.errors[0]; const row = error && error.row > 0 ? sourceRows[error.row - 1] : undefined;
   const source = row === undefined ? undefined : notes.data.rows[row - 1];
   const first = `${source ? `Source row ${row} (${String(source.subject_id)} -> ${String(source.object_id)}): ` : ''}${(error?.message ?? 'the notes could not be written').trim().replace(/[.!?]+$/, '')}`;
   return `Converting import set ${marker.import_set} to notes stopped while writing notes: ${first}${gen.errors.length > 1 ? ` (and ${gen.errors.length - 1} more problems)` : ''}. Nothing was moved to the trash. Fix the cause, then finish the conversion, or cancel it.`;
  }
 }
 await assertPreparedSafe(app, marker, plan);
 if (notes.releasePath && await readTextAt(app, notes.releasePath) === undefined) {
  await assertPreparedSafe(app, marker, plan);
  await app.vault.create(notes.releasePath, plan.artifacts.get(notes.releasePath)!);
 }
 return null;
}
