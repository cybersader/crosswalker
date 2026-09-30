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

import { TFile, normalizePath, type App } from 'obsidian';
import manifest from '../../manifest.json';
import type { ParsedData, GenerationResult } from '../types/config';
import type { Recipe } from '../render';
import { generateFromRecipe } from '../generation/generation-engine';
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
import { SSSOM_CURIE_PREFIX, sssomEdgeCurie } from '../generation/crosswalk-identity';
import { edgeBodyOf } from '../generation/edge-endpoints';
import { buildSyntheticRecipe } from '../import/sssom-importer';
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
	CONVERSION_MARKER_FORMAT,
	conversionMarkerPath,
	deleteConversionMarker,
	importSetIdOf,
	readConversionMarkerFiles,
	writeConversionMarker,
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
		const plan = await planConversion(app, set, to);
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
		await writeConversionMarker(app, marker);
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
		for (const note of (await readSetEdgeNotes(app, live.import_set, parentOf(live.path))).notes) {
			await app.vault.trash(note.file, false);
		}
	}
	await deleteConversionMarker(app, live);
}

async function rereadMarker(app: App, marker: ConversionMarker): Promise<{ marker: ConversionMarker } | { reason: string }> {
	const entry = (await readConversionMarkerFiles(app)).find((file) => file.path === normalizePath(marker.path));
	if (!entry) return { reason: `No conversion is waiting to finish for import set ${marker.import_set}. Check the set's mapping form in the stack before converting again.` };
	if (!entry.marker) return { reason: entry.error ?? `Conversion marker ${marker.path} cannot be read.` };
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
			if (marker.phase === 'writing') {
				report('writing', 0, marker.source_count, `Writing ${formLabel(to)} for import set ${setId}...`);
				const written = to === 'table'
					? await writeTableTarget(app, marker)
					: await writeNotesTarget(app, deps, marker, (done, total) => report('writing', done, total, `Writing notes for import set ${setId}...`));
				if (written) return stopped(setId, from, to, 'writing', written, marker.target_path);
				await advance(app, marker, 'verifying');
				continue;
			}
			if (marker.phase === 'verifying') {
				report('verifying', 0, marker.source_count, `Checking ${formLabel(to)} against the ${from === 'table' ? 'table' : 'notes'} for import set ${setId}...`);
				const mismatch = await verifyParity(app, marker);
				if (mismatch) {
					await advance(app, marker, 'writing');
					return stopped(setId, from, to, 'writing',
						`Converting import set ${setId} to ${formLabel(to)} stopped because the ${to === 'table' ? 'written table does' : 'written notes do'} not match the ${from === 'table' ? 'table' : 'notes'}: ${mismatch}. Nothing was moved to the trash. Finish the conversion to write them again, or cancel it.`,
						marker.target_path);
				}
				await advance(app, marker, 'retiring');
				continue;
			}
			// retiring
			const sources = await sourceArtifacts(app, marker);
			let done = 0;
			report('retiring', 0, sources.length, `Moving the old ${from === 'table' ? 'table' : 'notes'} of import set ${setId} to the trash...`);
			for (const file of sources) {
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
	await writeConversionMarker(app, { ...marker, phase });
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
async function planConversion(app: App, set: DiscoveredImportSet, to: MappingForm): Promise<ConversionPlan | { reason: string }> {
	if (set.root === null) {
		return { reason: `Import set ${set.id} does not live under one folder, so Crosswalker cannot tell where the converted form belongs. Move its ${set.mapping_form === 'table' ? 'table' : 'notes'} back under one folder, then convert again.` };
	}
	const folder = set.root;
	if (to === 'table') {
		const read = await readSetEdgeNotes(app, set.id, folder);
		if (read.unreadable.length) return { reason: unreadableReason(set.id, read.unreadable) };
		if (read.others.length) {
			return { reason: `Import set ${set.id} holds notes that are not mappings (${read.others[0]}${read.others.length > 1 ? ` and ${read.others.length - 1} more` : ''}), so it cannot be stored as a table. Only mapping sets can be converted.` };
		}
		if (!read.notes.length) return { reason: `Import set ${set.id} has no mapping notes to convert. Import the mapping file first, then convert it.` };
		const reverse = notesToTableProblem(set.id, read.notes);
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
	const problem = notesFormProblem(set.id, table.table);
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
async function readSetEdgeNotes(app: App, setId: string, folder: string): Promise<{ notes: EdgeNote[]; others: string[]; unreadable: string[] }> {
	const base = normalizeFolderSetting(folder);
	const inFolder = (path: string) => !base || path.startsWith(`${base}/`);
	const notes: EdgeNote[] = [];
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
		else others.push(file.path);
	}
	return { notes, others, unreadable };
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
function notesFormProblem(setId: string, table: MappingTableFile): string | null {
	if (!table.header.source_framework?.trim() || !table.header.target_framework?.trim()) {
		return `Mapping table ${table.path} does not name its source and target frameworks, so its notes cannot be labelled. Add source_framework and target_framework header lines, then convert again.`;
	}
	const managed = conversionManagedKeys(table.header.source_framework, table.header.target_framework);
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
function notesToTableProblem(setId: string, notes: EdgeNote[]): string | null {
	const frameworks = agreedFrameworks(notes.map((note) => note.frontmatter));
	if (!frameworks.source || !frameworks.target) {
		return `The notes of import set ${setId} do not all name the same source_framework and target_framework, so a table made from them could not be converted back to notes. Make those two properties agree on every note, then convert again.`;
	}
	for (const note of notes) {
		const fm = note.frontmatter;
		const title = fm.title;
		const expected = `${String(fm.subject_id)} -> ${String(fm.object_id)}`;
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
	const managed = conversionManagedKeys(frameworks.source, frameworks.target);
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
 * (`sssom_confidence: 0.9` reads as a number). Put back to text before the
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

/** The one value every note agrees on, else undefined. */
function agreed(values: unknown[]): string | undefined {
	const texts = new Set(values.map((value) => typeof value === 'string' && value.trim() ? value.trim() : null));
	if (texts.size !== 1) return undefined;
	return [...texts][0] ?? undefined;
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
async function tableHeaderFor(app: App, marker: ConversionMarker, notes: EdgeNote[]): Promise<MappingTableHeader> {
	const folder = parentOf(marker.path);
	const importSet = await resolveImportSet(app, folder, { id: marker.import_set }, undefined, undefined, undefined, { conversion: { to: 'table' } });
	const first = notes[0].frontmatter._crosswalker as Record<string, unknown> | undefined;
	const sourceRef = first?.source_ref;
	const recipe = first?.recipe;
	const provenance = buildProvenance({
		sourceFile: stringField(sourceRef, 'file'),
		sourceUrl: stringField(sourceRef, 'url'),
		sourceCurie: stringField(sourceRef, 'curie'),
		sourceVersion: stringField(sourceRef, 'version'),
		sourceHash: stringField(sourceRef, 'source_hash'),
		recipeId: stringField(recipe, 'id'),
		recipeHash: stringField(recipe, 'hash'),
		importSet,
	}, PLUGIN_VERSION) as CrosswalkerProvenance;
	const fms = notes.map((note) => note.frontmatter);
	const frameworks = agreedFrameworks(fms);
	const tagsJson = agreed(fms.map((fm) => Array.isArray(fm.tags) && fm.tags.every((tag) => typeof tag === 'string') ? JSON.stringify(fm.tags) : null));
	const mappingSetId = agreed(fms.map((fm) => fm.mapping_set_id));
	const mappingProvider = agreed(fms.map((fm) => fm.mapping_provider));
	return {
		...(mappingSetId ? { mapping_set_id: mappingSetId } : {}),
		...(mappingProvider ? { mapping_provider: mappingProvider } : {}),
		crosswalker_format: MAPPING_TABLE_FORMAT,
		import_set: importSet.id,
		...(frameworks.source ? { source_framework: frameworks.source } : {}),
		...(frameworks.target ? { target_framework: frameworks.target } : {}),
		...(tagsJson ? { tags: JSON.parse(tagsJson) as string[] } : {}),
		crosswalker_provenance: provenance,
	};
}

/** Returns a refusal reason, or null once the table is on disk and byte-verified. */
async function writeTableTarget(app: App, marker: ConversionMarker): Promise<string | null> {
	const read = await readSetEdgeNotes(app, marker.import_set, parentOf(marker.path));
	if (read.unreadable.length) return unreadableReason(marker.import_set, read.unreadable);
	if (!read.notes.length) {
		return `Import set ${marker.import_set} has no mapping notes left to convert. Restore them from the trash or a backup, or cancel the conversion.`;
	}
	const reverse = notesToTableProblem(marker.import_set, read.notes);
	if (reverse) return `${reverse.replace(/ then convert again\.$/, ' then finish the conversion, or cancel it.')} Nothing was moved to the trash.`;
	const header = await tableHeaderFor(app, marker, read.notes);
	const facts = read.notes.map((note) => noteToRowFacts(note.frontmatter, header));
	const rows = assignMappingRowIds(facts, header.mapping_set_id);
	await writeTableDurably(app, marker.target_path, serializeMappingTable(header, rows));
	return null;
}

/**
 * Write a table so an interruption never leaves a half-written file at the
 * target: write `<target>.tmp`, rename it into place, then read the target back
 * and compare byte for byte. Some synced or network folders refuse a rename;
 * then the file is written in place through the vault and verified the same
 * way. Failure mode prevented: a crash mid-write leaving a truncated table that
 * a later phase reads as the whole set.
 */
async function writeTableDurably(app: App, path: string, content: string): Promise<void> {
	const target = normalizePath(path);
	const parent = parentOf(target);
	if (parent && !app.vault.getAbstractFileByPath(parent)) {
		try { await app.vault.createFolder(parent); } catch { /* already present on disk */ }
	}
	const tmp = `${target}.tmp`;
	const adapter = app.vault.adapter;
	let renamed = false;
	if (typeof adapter?.write === 'function' && typeof adapter?.rename === 'function') {
		try {
			await adapter.write(tmp, content);
			await adapter.rename(tmp, target);
			renamed = true;
		} catch {
			await removeAdapterFile(app, tmp);
		}
	}
	if (!renamed) {
		const existing = app.vault.getAbstractFileByPath(target);
		if (existing && !(existing instanceof TFile)) {
			throw new Error(`A folder already exists at ${target}, so the mapping table cannot be written there. Rename or move that folder, then finish the conversion.`);
		}
		if (existing) await app.vault.modify(existing, content);
		else await app.vault.create(target, content);
	}
	if (await readTextAt(app, target) !== content) {
		throw new Error(`Could not verify the mapping table after writing ${target}. Check the folder is writable and not synced by another tool, then finish the conversion.`);
	}
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

/** The managed keys of the transport recipe, so a table row's own extra cannot collide with them. */
function conversionManagedKeys(source: string, target: string): Set<string> {
	const managed = buildSyntheticRecipe(source, target).target.also_emit?.frontmatter?.managed ?? {};
	return new Set([...Object.keys(managed), 'review_status', 'reviewer']);
}

/**
 * The import recipe, adapted to carry a table's rows back into notes for this
 * run only. Every optional fact renders only when present (a table may be
 * sparser than a fresh import), and the review columns plus every user field
 * become source-carried values: the import recipe only preserves them, which on
 * a fresh note means dropping them. `carried` maps each user field to the row
 * column it rides in, so a key with spaces or punctuation never enters a
 * template.
 */
function conversionRecipe(source: string, target: string, carried: Map<string, string>, tags?: string[]): Recipe {
	const base = buildSyntheticRecipe(source, target);
	const frontmatter = base.target.also_emit!.frontmatter!;
	const identity = new Set(['subject_id', 'object_id', 'predicate_id']);
	const managed: Record<string, unknown> = {};
	for (const [key, template] of Object.entries(frontmatter.managed ?? {})) {
		const match = typeof template === 'string' ? /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(template) : null;
		managed[key] = match && !identity.has(match[1]) ? `{${match[1]}|optional}` : template;
	}
	managed.review_status = '{review_status|optional}';
	managed.reviewer = '{reviewer|optional}';
	for (const [key, column] of carried) managed[key] = `{${column}|optional}`;
	return {
		...base,
		target: {
			...base.target,
			also_emit: {
				...base.target.also_emit,
				...(tags !== undefined ? { tags: [...tags] } : {}),
				frontmatter: { ...frontmatter, managed: managed as typeof frontmatter.managed, user_preserve: [] },
			},
		},
	};
}

/** Returns a refusal reason, or null once the engine wrote every row. */
async function writeNotesTarget(
	app: App,
	deps: ConversionDeps,
	marker: ConversionMarker,
	onProgress: (done: number, total: number) => void,
): Promise<string | null> {
	const owned = await ownedTable(app, marker.import_set);
	if ('reason' in owned) return owned.reason;
	const { table } = owned;
	const problem = notesFormProblem(marker.import_set, table);
	if (problem) return problem;
	const source = table.header.source_framework!.trim();
	const target = table.header.target_framework!.trim();
	const carried = new Map<string, string>();
	for (const row of table.rows) {
		for (const key of [...Object.keys(row.notes ?? {}), ...Object.keys(row.extra ?? {})]) {
			if (!carried.has(key)) carried.set(key, `conversion_field_${carried.size}`);
		}
	}
	const rows = table.rows.map((row) => {
		const record: Record<string, unknown> = {
			subject_id: row.subject_id,
			predicate_id: row.predicate_id,
			object_id: row.object_id,
			edge_body: edgeBodyOf(row.subject_id, row.predicate_id, row.object_id, row.subject_note ?? '', row.object_note ?? ''),
		};
		const optional: Array<[string, string | undefined]> = [
			['sssom_predicate', row.sssom_predicate], ['predicate_modifier', row.predicate_modifier],
			['mapping_justification', row.mapping_justification], ['confidence', row.confidence],
			['subject_label', row.subject_label], ['object_label', row.object_label],
			['subject_note', row.subject_note], ['object_note', row.object_note],
			['mapping_provider', row.mapping_provider], ['mapping_set_id', row.mapping_set_id],
			['review_status', row.review_status], ['reviewer', row.reviewer],
		];
		for (const [key, value] of optional) if (value !== undefined) record[key] = value;
		for (const [key, value] of [...Object.entries(row.notes ?? {}), ...Object.entries(row.extra ?? {})]) {
			record[carried.get(key)!] = value;
		}
		return record;
	});
	const provenance = table.header.crosswalker_provenance as Record<string, unknown> | undefined;
	const sourceRef = provenance?.source_ref;
	const recipeBlock = provenance?.recipe;
	const recipeId = stringField(recipeBlock, 'id');
	const sourceHash = stringField(sourceRef, 'source_hash');
	const parsedData: ParsedData = {
		columns: [...new Set(rows.flatMap((row) => Object.keys(row)))],
		rows,
		rowCount: rows.length,
		...(sourceHash ? { sourceByteDigest: sourceHash } : {}),
	};
	const generate = deps.generateFromRecipe ?? generateFromRecipe;
	const gen: GenerationResult = await generate(app, parsedData, conversionRecipe(source, target, carried, table.header.tags), {
		basePath: marker.target_path,
		overwriteMode: 'replace',
		createFolders: true,
		importSet: { id: marker.import_set },
		mappingConversion: { to: 'notes' },
		...(recipeId ? { provenanceRecipe: { id: recipeId, hash: stringField(recipeBlock, 'hash') } } : {}),
		sourceFileName: stringField(sourceRef, 'file') ?? table.header.mapping_set_id,
		sourceVersion: stringField(sourceRef, 'version'),
		strictValidation: true,
		curieLocalPart: (row, _rowNum, importSet) => sssomEdgeCurie(row, importSet),
		curiePrefix: SSSOM_CURIE_PREFIX,
		onProgress: (current, total) => onProgress(current, total),
	});
	if (!gen.success || gen.errors.length) {
		const first = (gen.errors[0]?.message ?? 'the notes could not be written').trim().replace(/[.!?]+$/, '');
		const more = gen.errors.length > 1 ? ` (and ${gen.errors.length - 1} more problems)` : '';
		return `Converting import set ${marker.import_set} to notes stopped while writing notes: ${first}${more}. Nothing was moved to the trash. Fix the cause, then finish the conversion, or cancel it.`;
	}
	return null;
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

async function verifyParity(app: App, marker: ConversionMarker): Promise<string | null> {
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
	for (const note of read.notes) {
		const block = (note.frontmatter._crosswalker as Record<string, unknown> | undefined)?.import_set as Record<string, unknown> | undefined;
		if (block?.mapping_form === 'table') return `${note.file.path} is still pinned to the table form`;
		const expectedTitle = `${String(note.frontmatter.subject_id)} -> ${String(note.frontmatter.object_id)}`;
		if (note.frontmatter.title !== undefined && note.frontmatter.title !== expectedTitle) return `${note.file.path} has a different title`;
		if (header.tags !== undefined && tagsKey(note.frontmatter.tags) !== tagsKey(header.tags)) return `${note.file.path} has different tags from the table`;
	}
	const source = assignMappingRowIds(rowsAsFacts(owned.table.rows), header.mapping_set_id);
	const target = assignMappingRowIds(read.notes.map((note) => noteToRowFacts(note.frontmatter, header)), header.mapping_set_id);
	return compareRows(source, target, 'notes', 'table');
}

// ---------------------------------------------------------------------------
// Retiring and the final summary
// ---------------------------------------------------------------------------

/** What is left of the source form, re-read from the vault. */
async function sourceArtifacts(app: App, marker: ConversionMarker): Promise<TFile[]> {
	if (marker.from === 'notes') {
		const read = await readSetEdgeNotes(app, marker.import_set, parentOf(marker.path));
		if (read.unreadable.length) throw new Error(unreadableReason(marker.import_set, read.unreadable));
		return read.notes.map((note) => note.file);
	}
	const files: TFile[] = [];
	for (const table of await readMappingTables(app)) {
		if (importSetIdOf(table.header.crosswalker_provenance) !== marker.import_set) continue;
		const file = app.vault.getAbstractFileByPath(table.path);
		if (file instanceof TFile) files.push(file);
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
