/**
 * table-review-store.ts — load one mapping table for review and save review
 * edits back into it.
 *
 * Slice 5 of the mapping table form (2026-09-30). The view queues edits here;
 * the store coalesces them by `row_id` and, after a short pause, saves them
 * through the one table writer (`writeMappingTable`: write, read back, compare).
 *
 * Saving never writes the snapshot the view loaded. Every save reads the file
 * again and applies the pending edits to what is on disk now, by `row_id`.
 * Failure mode prevented: a refresh, a sync tool or a hand edit that changed
 * the file after the view opened being silently overwritten by a stale copy.
 * A pending edit whose row is gone from the file is dropped with a notice that
 * names the count, never silently. When a save finds the file changed, the
 * `onReload` listeners get the table as it is now, so the view can re-render.
 *
 * The table is read-only, at load or from the save that finds it, when:
 * - a usable conversion marker names the set (a conversion job owns the file);
 * - an unusable marker file may name the set (its phase is unknown, so the
 *   store fails closed the way `conversionReadRule` does);
 * - the marker scan itself failed;
 * - the file no longer parses as a table (structural errors);
 * - the file has rows the reader could not read (`rowErrors`). The writer can
 *   only write rows it parsed, so any save would delete those rows. The table
 *   is read-only instead of accepting edits that could never be saved.
 *   Deviation from the slice 5 spec (which kept such tables editable), chosen
 *   so no edit is accepted that cannot persist.
 *
 * A refused save keeps its edits in memory and marks the table read-only until
 * `load` runs again (the view's reopen action). `load` re-checks and, when the
 * table is editable again, saves the kept edits. `dispose` never drops edits
 * silently: any it could not save come back in its result and in a notice.
 */

import { Notice, TFile, normalizePath, type App } from 'obsidian';
import { REVIEW_STATUSES, serializeMappingTable } from './mapping-table';
import {
	mappingTableFromContent,
	unreadableMappingTable,
	type MappingTableFile,
} from './mapping-table-reader';
import { writeMappingTable } from './mapping-table-writer';
import { importSetIdOf, type ConversionMarker, type UnusableConversionMarker } from './conversion-marker';
import { applyEdits, isReviewStatus, mergeEdit, type ReviewEdit } from './table-review-model';

export interface TableReviewDeps {
	/** Re-project one table into the query index (projector `pathFilter` = that path). */
	project(path: string): Promise<void>;
	/**
	 * The vault's conversion markers: usable ones plus every unusable one with
	 * the sets it may govern (the shape `readConversionReadState` returns).
	 */
	markers(): Promise<{ markers: ConversionMarker[]; unusable: UnusableConversionMarker[] }>;
}

export interface TableReviewTiming {
	/** Pause after the last edit before saving. Default 600 ms. */
	saveDelayMs?: number;
	/** Pause after the last save before re-projecting. Default 2 s. */
	projectDelayMs?: number;
}

export type ReviewSaveStatus = 'saved' | 'saving' | 'error';

export interface ReadOnlyReason {
	reason: string;
	action: string;
}

export interface SaveResult {
	/**
	 * `saved`: written and verified. `nothing`: no edit was pending.
	 * `refused`: the file is in a state the store must not write; edits kept.
	 * `error`: the read or write failed; edits kept.
	 */
	outcome: 'saved' | 'nothing' | 'refused' | 'error';
	/** Edits applied to rows that still exist. */
	applied: number;
	/** Row ids whose edits were dropped because the row left the file. */
	dropped: string[];
	/** True when the file on disk differed from what the store last loaded or wrote. */
	reloaded: boolean;
	message?: string;
}

export interface DisposeResult extends SaveResult {
	/** Edits that could not be saved before closing. Empty when everything saved. */
	unsaved: ReviewEdit[];
}

const DEFAULT_SAVE_DELAY_MS = 600;
const DEFAULT_PROJECT_DELAY_MS = 2000;

/** "a, b, c or d": the list the error copy offers, built from the enum itself. */
function listWithOr(items: readonly string[]): string {
	if (items.length <= 1) return items.join('');
	return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** The status error `queueEdit` throws; exported so tests read the same copy. */
export function unknownStatusMessage(status: string): string {
	return `Review status "${status}" is not one Crosswalker can store. Choose ${listWithOr(REVIEW_STATUSES)}.`;
}

function conversionReadOnly(setId: string): ReadOnlyReason {
	return {
		reason: `Import set ${setId} is being converted between notes and a table, so this table cannot be edited now.`,
		action: 'Finish or cancel the conversion from Installed stacks, then reopen this table.',
	};
}

function unusableMarkerReadOnly(setId: string, entry: UnusableConversionMarker): ReadOnlyReason {
	return {
		reason: `Conversion marker ${entry.path} could not be read, so Crosswalker cannot tell whether import set ${setId} is being converted. This table cannot be edited until that is known.`,
		action: 'Fix or delete that marker file, then reopen this table.',
	};
}

const MARKER_SCAN_FAILED: ReadOnlyReason = {
	reason: 'Could not check whether this set is being converted.',
	action: 'Reopen this table to try again.',
};

function structuralReadOnly(table: MappingTableFile): ReadOnlyReason {
	return {
		reason: table.errors[0] ?? `Mapping table ${table.path} could not be read.`,
		action: 'Fix the file, or run the import again to rewrite it, then reopen this table.',
	};
}

function rowErrorsReadOnly(table: MappingTableFile): ReadOnlyReason {
	const count = table.rowErrors.length;
	const one = count === 1;
	return {
		reason: `${count} row${one ? '' : 's'} in this table could not be read, and saving would remove ${one ? 'it' : 'them'}, so this table cannot be edited. ${table.rowErrors[0]}`,
		action: `Fix ${one ? 'that row' : 'those rows'} in the file, or run the import again to rewrite it, then reopen this table.`,
	};
}

function missingFileReadOnly(path: string): ReadOnlyReason {
	return {
		reason: `Mapping table ${path} no longer exists. It may have been moved, renamed or converted to notes.`,
		action: 'Reopen it from Installed stacks to keep reviewing.',
	};
}

function describe(readOnly: ReadOnlyReason): string {
	return `${readOnly.reason} ${readOnly.action}`;
}

export class TableReviewStore {
	private readonly path: string;
	private readonly saveDelayMs: number;
	private readonly projectDelayMs: number;
	private readonly pending = new Map<string, ReviewEdit>();
	private readonly listeners: Array<(status: ReviewSaveStatus, message?: string) => void> = [];
	private readonly reloadListeners: Array<(table: MappingTableFile) => void> = [];
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private projectTimer: ReturnType<typeof setTimeout> | null = null;
	private inFlight: Promise<SaveResult> | null = null;
	/** The bytes last loaded or written; a differing re-read means someone else wrote. */
	private content: string | undefined;
	private table: MappingTableFile | undefined;
	/** Set by `load`, or by a refused save; cleared only by the next `load`. */
	private readOnly: ReadOnlyReason | undefined;
	/** Why the last save did not go through, for the close notice. */
	private lastFailure: ReadOnlyReason | undefined;
	/** Set when `dispose` starts, so no edit can slip in behind its flush. */
	private closing = false;

	constructor(
		private readonly app: App,
		private readonly deps: TableReviewDeps,
		path: string,
		timing: TableReviewTiming = {},
	) {
		this.path = normalizePath(path);
		this.saveDelayMs = timing.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS;
		this.projectDelayMs = timing.projectDelayMs ?? DEFAULT_PROJECT_DELAY_MS;
	}

	/** The table as last loaded or saved, or undefined before `load`. */
	current(): MappingTableFile | undefined {
		return this.table;
	}

	/**
	 * Why the table cannot be edited right now, or undefined when it can. Set by
	 * `load` and by a refused save, so the view can show its banner after a save
	 * it did not start (the pause timer's) turns the table read-only.
	 */
	readOnlyReason(): ReadOnlyReason | undefined {
		return this.readOnly;
	}

	/** How many rows have edits waiting to be saved. */
	pendingCount(): number {
		return this.pending.size;
	}

	/**
	 * Read the table and decide whether it may be edited. Never throws: a
	 * missing or malformed file, row errors, or a failed marker scan come back
	 * as a read-only reason. Call again to reopen after the cause is fixed;
	 * edits kept from a refused save are then saved after the usual pause.
	 */
	async load(): Promise<{ table: MappingTableFile; readOnly?: ReadOnlyReason }> {
		const file = this.app.vault.getAbstractFileByPath(this.path);
		let table: MappingTableFile;
		if (!(file instanceof TFile)) {
			table = unreadableMappingTable(this.path);
			table.errors = [missingFileReadOnly(this.path).reason];
			this.content = undefined;
		} else {
			// Read the bytes once and parse those same bytes, so the change check
			// on the next save compares against exactly what the view shows.
			let content: string | undefined;
			try {
				content = await this.app.vault.read(file);
			} catch {
				content = undefined;
			}
			table = content === undefined ? unreadableMappingTable(this.path) : mappingTableFromContent(this.path, content);
			this.content = content;
		}
		this.table = table;
		this.readOnly = await this.readOnlyReasonFor(table);
		if (!this.readOnly && this.pending.size && !this.closing) this.scheduleSave();
		return this.readOnly ? { table, readOnly: this.readOnly } : { table };
	}

	/**
	 * Queue one edit, coalesced with any pending edit for the same row (later
	 * fields win, a `null` clear included), and restart the save pause.
	 * Throws on a read-only or closed table, or a status outside the schema
	 * enum, so a caller bug surfaces instead of being written.
	 */
	queueEdit(edit: ReviewEdit): void {
		if (this.closing) throw new Error('This mapping review is closed. Reopen the table to keep editing.');
		if (this.readOnly) throw new Error(describe(this.readOnly));
		if (edit.review_status !== undefined && edit.review_status !== null && edit.review_status !== '' && !isReviewStatus(edit.review_status)) {
			throw new Error(unknownStatusMessage(edit.review_status));
		}
		this.pending.set(edit.row_id, mergeEdit(this.pending.get(edit.row_id), edit));
		this.emit('saving');
		this.scheduleSave();
	}

	/**
	 * Save every pending edit now. Idempotent and safe to call concurrently: a
	 * call made while a save runs waits for it, then saves whatever is still
	 * pending (or reports `nothing`).
	 */
	async flush(): Promise<SaveResult> {
		this.clearSaveTimer();
		while (this.inFlight) {
			await this.inFlight.catch(() => undefined);
		}
		if (!this.pending.size) return { outcome: 'nothing', applied: 0, dropped: [], reloaded: false };
		const run = this.save();
		this.inFlight = run;
		try {
			return await run;
		} finally {
			if (this.inFlight === run) this.inFlight = null;
		}
	}

	onStatus(cb: (status: ReviewSaveStatus, message?: string) => void): void {
		this.listeners.push(cb);
	}

	/**
	 * Called with the table as it is now whenever a save found the file changed
	 * underneath (rows added, removed or relabelled), so the view re-renders
	 * instead of showing rows that are gone.
	 */
	onReload(cb: (table: MappingTableFile) => void): void {
		this.reloadListeners.push(cb);
	}

	/**
	 * Save what is pending, run any re-projection that was waiting, and stop
	 * every timer. Failure mode prevented: closing the view inside the save
	 * pause losing the last edit, or leaving the index a save behind. Edits that
	 * still could not be saved are returned as `unsaved` and named in a notice.
	 */
	async dispose(): Promise<DisposeResult> {
		this.closing = true;
		const result = await this.flush();
		this.clearSaveTimer();
		const projectWaiting = this.projectTimer !== null;
		if (this.projectTimer !== null) clearTimeout(this.projectTimer);
		this.projectTimer = null;
		if (projectWaiting) await this.runProjection();
		const unsaved = [...this.pending.values()];
		this.pending.clear();
		if (unsaved.length) {
			const count = unsaved.length;
			const failure = this.lastFailure ?? { reason: `Could not save the review edits to ${this.path}.`, action: 'Reopen this table.' };
			new Notice(`Closed the mapping review with ${count} unsaved edit${count === 1 ? '' : 's'}. ${failure.reason} ${failure.action} Make ${count === 1 ? 'that edit' : 'those edits'} again after reopening.`);
		}
		return { ...result, unsaved };
	}

	private emit(status: ReviewSaveStatus, message?: string): void {
		for (const listener of this.listeners) {
			try {
				listener(status, message);
			} catch {
				// A broken listener must not stop a save or the other listeners.
			}
		}
	}

	private emitReload(table: MappingTableFile): void {
		for (const listener of this.reloadListeners) {
			try {
				listener(table);
			} catch {
				// A broken listener must not stop a save or the other listeners.
			}
		}
	}

	private clearSaveTimer(): void {
		if (this.saveTimer !== null) clearTimeout(this.saveTimer);
		this.saveTimer = null;
	}

	private scheduleSave(): void {
		this.clearSaveTimer();
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			// The outcome reaches the view through onStatus and onReload; the timer
			// has no caller to return it to.
			void this.flush().catch(() => undefined);
		}, this.saveDelayMs);
	}

	private scheduleProjection(): void {
		if (this.projectTimer !== null) clearTimeout(this.projectTimer);
		this.projectTimer = setTimeout(() => {
			this.projectTimer = null;
			void this.runProjection();
		}, this.projectDelayMs);
	}

	private async runProjection(): Promise<void> {
		try {
			await this.deps.project(this.path);
		} catch {
			this.emit('error', 'Your review was saved to the file, but the query index was not updated. Edit any row to try again, or run Maintenance: reset search data to rebuild the index.');
		}
	}

	private async readOnlyReasonFor(table: MappingTableFile): Promise<ReadOnlyReason | undefined> {
		if (table.errors.length) return structuralReadOnly(table);
		const setId = importSetIdOf(table.header.crosswalker_provenance);
		if (setId) {
			let state: { markers: ConversionMarker[]; unusable: UnusableConversionMarker[] };
			try {
				state = await this.deps.markers();
			} catch {
				return MARKER_SCAN_FAILED;
			}
			if (state.markers.some((marker) => marker.import_set === setId)) return conversionReadOnly(setId);
			const unusable = state.unusable.find((entry) => entry.setIds.includes(setId));
			if (unusable) return unusableMarkerReadOnly(setId, unusable);
		}
		if (table.rowErrors.length) return rowErrorsReadOnly(table);
		return undefined;
	}

	/** Put taken edits back under any edit queued since, so newer values win. */
	private restore(edits: ReviewEdit[]): void {
		for (const edit of edits) {
			const newer = this.pending.get(edit.row_id);
			this.pending.set(edit.row_id, newer ? mergeEdit(edit, newer) : edit);
		}
	}

	/** Keep the edits, and stop accepting new ones until `load` re-checks. */
	private refuse(edits: ReviewEdit[], readOnly: ReadOnlyReason, reloaded: boolean): SaveResult {
		this.restore(edits);
		this.readOnly = readOnly;
		this.lastFailure = readOnly;
		const message = `Could not save: ${readOnly.reason} Your edits are kept. ${readOnly.action}`;
		this.emit('error', message);
		return { outcome: 'refused', applied: 0, dropped: [], reloaded, message };
	}

	private async save(): Promise<SaveResult> {
		const edits = [...this.pending.values()];
		this.pending.clear();
		this.emit('saving');
		let reloaded = false;
		try {
			const file = this.app.vault.getAbstractFileByPath(this.path);
			if (!(file instanceof TFile)) return this.refuse(edits, missingFileReadOnly(this.path), false);
			const content = await this.app.vault.read(file);
			reloaded = content !== this.content;
			const table = mappingTableFromContent(this.path, content);
			const readOnly = await this.readOnlyReasonFor(table);
			if (readOnly) return this.refuse(edits, readOnly, reloaded);
			const { rows, applied, missing } = applyEdits(table.rows, edits);
			if (applied > 0) {
				await writeMappingTable(this.app, { path: this.path, header: table.header, rows });
				this.content = serializeMappingTable(table.header, rows);
				this.scheduleProjection();
			} else {
				this.content = content;
			}
			this.table = { ...table, rows: applied > 0 ? rows : table.rows };
			this.lastFailure = undefined;
			// After the write, so a failed save (which keeps every edit) does not
			// announce a drop it will announce again on the retry.
			if (missing.length) {
				new Notice(`Dropped edits for ${missing.length} mapping${missing.length === 1 ? '' : 's'} that ${missing.length === 1 ? 'is' : 'are'} no longer in the table. The file changed since it was opened, for example by a refresh.`);
			}
			if (reloaded) this.emitReload(this.table);
			this.emit('saved');
			return { outcome: 'saved', applied, dropped: missing, reloaded };
		} catch (error) {
			this.restore(edits);
			const detail = error instanceof Error ? error.message : String(error);
			const known = detail.startsWith('Could not');
			// Kept for the close notice, whose action is to reopen rather than edit again.
			this.lastFailure = {
				reason: known ? detail : `Could not save the review edits to ${this.path}.`,
				action: 'Check the file is not open in another program, then reopen this table.',
			};
			const message = known
				? `${detail} Your edits are kept and saved on the next change.`
				: `Could not save the review edits to ${this.path}. Your edits are kept. Check the file is not open in another program, then edit any row to try again.`;
			this.emit('error', message);
			return { outcome: 'error', applied: 0, dropped: [], reloaded, message };
		}
	}
}
