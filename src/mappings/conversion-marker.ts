/**
 * conversion-marker.ts — the on-disk intent record of one mapping set conversion.
 *
 * Slice 4 of the mapping table form (2026-09-30). Converting a set between
 * notes and a table is a job that can be interrupted at any point (Obsidian
 * closed, a sync tool locking a file). The marker is the only thing the job
 * carries across phases, and the only place every reader looks to decide which
 * of a set's two storage forms is authoritative right now. Failure mode
 * prevented: an interrupted conversion leaving a set that every reader refuses
 * ("recorded as both notes and a table") with no record of how to finish it.
 *
 * The marker is a visible vault file, `<set destination>/<set-id>.converting.json`,
 * not a dotfile: Obsidian hides dotfiles from the vault API, so a hidden marker
 * would be invisible to the very readers that must honour it.
 */

import { TFile, normalizePath, type App } from 'obsidian';
import { normalizeFolderSetting } from '../settings/folder-settings';
import { IMPORT_SET_ID_PATTERN, MAPPING_FORMS, type MappingForm } from '../generation/import-set-block';

export const CONVERSION_MARKER_FORMAT = 'crosswalker-conversion-v1';
export const CONVERSION_MARKER_SUFFIX = '.converting.json';

/**
 * `writing`: the target form is being written. `verifying`: the target is on
 * disk and is being compared with the source. `retiring`: the target is
 * verified and the source is being moved to the trash. Each phase is safe to
 * re-run from its start.
 */
export const CONVERSION_PHASES = ['writing', 'verifying', 'retiring'] as const;
export type ConversionPhase = typeof CONVERSION_PHASES[number];

export interface ConversionMarker {
	format: typeof CONVERSION_MARKER_FORMAT;
	import_set: string;
	from: MappingForm;
	to: MappingForm;
	phase: ConversionPhase;
	/** Table direction: the table file. Notes direction: the folder the notes go in. */
	target_path: string;
	/** Rows (table) or notes the source held when the job started. */
	source_count: number;
	started_at: string;
	plugin_version: string;
	/**
	 * Vault path of the marker file itself. Not written into the file: the path
	 * is where the file is, and a copy inside it could only disagree.
	 */
	path: string;
}

/** Where a set's marker lives. `folder` is the set's destination ('' = vault root). */
export function conversionMarkerPath(folder: string, setId: string): string {
	const base = normalizeFolderSetting(folder ?? '');
	return normalizePath(base ? `${base}/${setId}${CONVERSION_MARKER_SUFFIX}` : `${setId}${CONVERSION_MARKER_SUFFIX}`);
}

/**
 * The storage form readers must use for a set that has a live marker. While
 * the target is being written or verified the source is still the truth; once
 * the target is verified (`retiring`) the target is, and whatever is left of
 * the source is ignored.
 *
 * Every consumer asks this one function. Failure mode prevented: the projector
 * and the exporter deriving the rule separately and disagreeing mid-job, so the
 * query index and an export show different mappings for the same instant.
 */
export function formToReadFor(marker: Pick<ConversionMarker, 'from' | 'to' | 'phase'>): MappingForm {
	return marker.phase === 'retiring' ? marker.to : marker.from;
}

/**
 * A reader's question, answered from the markers it read once: should an
 * artifact of `form` stamped with `setId` be read? Always yes for a set with
 * no live marker, and for an artifact whose set cannot be named.
 */
export type ConversionReadRule = (setId: string | null | undefined, form: MappingForm) => boolean;

/**
 * `unusable` are marker files that could not be parsed. A set such a marker
 * may govern is read in neither form: without the marker's phase no reader can
 * tell which form is the whole set, and reading both would double it. Failure
 * mode prevented: a newer or hand-edited marker making an older plugin project
 * and export every mapping of a half-converted set twice.
 */
export function conversionReadRule(
	markers: readonly ConversionMarker[],
	unusable: readonly Pick<UnusableConversionMarker, 'setIds'>[] = [],
): ConversionReadRule {
	const bySet = new Map(markers.map((marker) => [marker.import_set, marker]));
	const blocked = new Set(unusable.flatMap((entry) => entry.setIds));
	return (setId, form) => {
		if (!setId) return true;
		if (blocked.has(setId)) return false;
		const marker = bySet.get(setId);
		return !marker || formToReadFor(marker) === form;
	};
}

/** The import set id stamped in a note's frontmatter or a table header's block, or null. */
export function importSetIdOf(provenance: unknown): string | null {
	if (!provenance || typeof provenance !== 'object') return null;
	const block = (provenance as Record<string, unknown>).import_set;
	if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
	const id = (block as Record<string, unknown>).id;
	return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * Parse one marker file. Refuses an unknown format, an unknown phase, or a
 * conversion from a form to itself, each with the fix. Failure mode prevented:
 * a hand-edited or newer-version marker steering readers to the wrong form.
 */
export function parseConversionMarker(text: string, path: string): { marker?: ConversionMarker; error?: string } {
	const fix = 'Restore it from a backup, or delete it and check which form the set is stored in before converting again.';
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { error: `Conversion marker ${path} is not readable JSON. ${fix}` };
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { error: `Conversion marker ${path} is not a JSON object. ${fix}` };
	}
	const record = raw as Record<string, unknown>;
	if (record.format !== CONVERSION_MARKER_FORMAT) {
		return { error: `Conversion marker ${path} has an unknown format ${JSON.stringify(record.format ?? null)}. It was probably written by a newer Crosswalker. Update the plugin, then finish the conversion.` };
	}
	const id = typeof record.import_set === 'string' ? record.import_set.trim() : '';
	if (!IMPORT_SET_ID_PATTERN.test(id)) {
		return { error: `Conversion marker ${path} does not name a valid import set. ${fix}` };
	}
	const isForm = (value: unknown): value is MappingForm => typeof value === 'string' && (MAPPING_FORMS as readonly string[]).includes(value);
	if (!isForm(record.from) || !isForm(record.to)) {
		return { error: `Conversion marker ${path} names an unknown mapping form. Update the plugin, then finish the conversion.` };
	}
	if (record.from === record.to) {
		return { error: `Conversion marker ${path} converts ${record.from} to ${record.to}, which is not a conversion. Delete the marker, then start the conversion again.` };
	}
	if (typeof record.phase !== 'string' || !(CONVERSION_PHASES as readonly string[]).includes(record.phase)) {
		return { error: `Conversion marker ${path} has an unknown phase ${JSON.stringify(record.phase ?? null)}. Update the plugin, then finish the conversion.` };
	}
	if (typeof record.target_path !== 'string' || (record.to === 'table' && record.target_path.trim() === '')) {
		return { error: `Conversion marker ${path} does not say where the ${record.to} form is written. ${fix}` };
	}
	const count = record.source_count;
	if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
		return { error: `Conversion marker ${path} has an invalid source_count. ${fix}` };
	}
	return {
		marker: {
			format: CONVERSION_MARKER_FORMAT,
			import_set: id,
			from: record.from,
			to: record.to,
			phase: record.phase as ConversionPhase,
			target_path: record.target_path,
			source_count: count,
			started_at: typeof record.started_at === 'string' ? record.started_at : '',
			plugin_version: typeof record.plugin_version === 'string' ? record.plugin_version : '',
			path,
		},
	};
}

/** The file body of a marker: every field but `path`, in a fixed order. */
export function serializeConversionMarker(marker: ConversionMarker): string {
	const { path: _path, ...body } = marker;
	const ordered = {
		format: body.format,
		import_set: body.import_set,
		from: body.from,
		to: body.to,
		phase: body.phase,
		target_path: body.target_path,
		source_count: body.source_count,
		started_at: body.started_at,
		plugin_version: body.plugin_version,
	};
	return `${JSON.stringify(ordered, null, 2)}\n`;
}

function isWithinBase(path: string, basePath?: string): boolean {
	if (basePath === undefined) return true;
	const base = normalizeFolderSetting(basePath);
	if (!base) return true;
	return path.startsWith(`${base}/`);
}

export interface ConversionMarkerFile {
	path: string;
	marker?: ConversionMarker;
	/** Why the file could not be used. Readers skip the sets it names; the job refuses on it. */
	error?: string;
	/**
	 * Unusable markers only: the import sets it may govern, from its file name
	 * (`<set-id>.converting.json`) and, when the JSON still parses, its
	 * `import_set` field. Empty when neither names a set.
	 */
	setIds?: string[];
}

export interface UnusableConversionMarker {
	path: string;
	error: string;
	setIds: string[];
}

/** The set ids an unusable marker may govern, read leniently. */
function unusableMarkerSetIds(path: string, text: string | undefined): string[] {
	const ids = new Set<string>();
	const name = path.slice(path.lastIndexOf('/') + 1);
	if (name.endsWith(CONVERSION_MARKER_SUFFIX)) {
		const fromName = name.slice(0, -CONVERSION_MARKER_SUFFIX.length).trim();
		if (IMPORT_SET_ID_PATTERN.test(fromName)) ids.add(fromName);
	}
	if (text !== undefined) {
		try {
			const raw = JSON.parse(text) as unknown;
			const id = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).import_set : undefined;
			if (typeof id === 'string' && IMPORT_SET_ID_PATTERN.test(id.trim())) ids.add(id.trim());
		} catch {
			// Unreadable JSON: the file name is all there is.
		}
	}
	return [...ids].sort();
}

/**
 * Every marker file under `basePath` (the whole vault when omitted), sorted by
 * path, with a parse error for each unusable one. Never throws for one bad file.
 */
export async function readConversionMarkerFiles(app: App, basePath?: string): Promise<ConversionMarkerFile[]> {
	// A vault double that lists only markdown has no markers to offer; the real
	// vault always has `getFiles`.
	const listFiles = typeof app.vault.getFiles === 'function' ? app.vault.getFiles.bind(app.vault) : (): TFile[] => [];
	const files = listFiles()
		.filter((file: TFile) => file.path.endsWith(CONVERSION_MARKER_SUFFIX) && isWithinBase(file.path, basePath))
		.sort((a: TFile, b: TFile) => a.path.localeCompare(b.path));
	const out: ConversionMarkerFile[] = [];
	for (const file of files) {
		let text: string;
		try {
			text = await app.vault.read(file);
		} catch {
			out.push({
				path: file.path,
				error: `Could not read conversion marker ${file.path}. Check the file still exists and is not open in another program, then try again.`,
				setIds: unusableMarkerSetIds(file.path, undefined),
			});
			continue;
		}
		const parsed = parseConversionMarker(text, file.path);
		out.push(parsed.marker
			? { path: file.path, marker: parsed.marker }
			: { path: file.path, error: parsed.error, setIds: unusableMarkerSetIds(file.path, text) });
	}
	return out;
}

/**
 * The usable markers only. Discovery uses this: an unusable marker's set then
 * shows both forms and discovery refuses it by name. A reader that would
 * otherwise read both forms (projection, export) must use
 * `readConversionReadState` instead and pass its `unusable` to
 * `conversionReadRule`, so it reads neither.
 */
export async function readConversionMarkers(app: App, basePath?: string): Promise<ConversionMarker[]> {
	return (await readConversionReadState(app, basePath)).markers;
}

/** Usable markers plus every unusable one with the sets it may govern. */
export async function readConversionReadState(app: App, basePath?: string): Promise<{ markers: ConversionMarker[]; unusable: UnusableConversionMarker[] }> {
	const markers: ConversionMarker[] = [];
	const unusable: UnusableConversionMarker[] = [];
	for (const entry of await readConversionMarkerFiles(app, basePath)) {
		if (entry.marker) markers.push(entry.marker);
		else unusable.push({ path: entry.path, error: entry.error ?? `Conversion marker ${entry.path} cannot be read.`, setIds: entry.setIds ?? [] });
	}
	return { markers, unusable };
}

/**
 * What a reader reports for an unusable marker: its own error plus what the
 * reader did about it.
 */
export function unusableMarkerMessage(entry: UnusableConversionMarker, consequence: string): string {
	const sets = entry.setIds.length ? `import set ${entry.setIds.join(', ')}` : 'the set it belongs to';
	return `${entry.error} Until then, ${consequence.replace('{sets}', sets)}`;
}

function parentOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * Create or update a marker, then read it back. A phase is only advanced once
 * its marker is on disk, so a write that did not land is thrown, never
 * reported as progress.
 */
export async function writeConversionMarker(app: App, marker: ConversionMarker): Promise<void> {
	const path = normalizePath(marker.path);
	const content = serializeConversionMarker(marker);
	const parent = parentOf(path);
	if (parent && !app.vault.getAbstractFileByPath(parent)) {
		try {
			await app.vault.createFolder(parent);
		} catch {
			// Created concurrently, or already present on disk: the write below decides.
		}
	}
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing && !(existing instanceof TFile)) {
		throw new Error(`Could not record the conversion because a folder already exists at ${path}. Rename or move that folder, then start the conversion again.`);
	}
	let file: TFile;
	if (existing) {
		await app.vault.modify(existing, content);
		file = existing;
	} else {
		file = await app.vault.create(path, content);
	}
	let readBack: string | undefined;
	try {
		readBack = await app.vault.read(file);
	} catch {
		readBack = undefined;
	}
	if (readBack !== content) {
		throw new Error(`Could not verify the conversion marker at ${path}. Check the folder is writable and not synced by another tool, then finish the conversion.`);
	}
}

/** Remove a finished or cancelled job's marker. A missing marker is already done. */
export async function deleteConversionMarker(app: App, marker: Pick<ConversionMarker, 'path'>): Promise<void> {
	const file = app.vault.getAbstractFileByPath(normalizePath(marker.path));
	if (!file) return;
	if (!(file instanceof TFile)) {
		throw new Error(`Could not remove the conversion marker because ${marker.path} is a folder. Rename or move that folder, then finish the conversion.`);
	}
	await app.vault.delete(file);
}
