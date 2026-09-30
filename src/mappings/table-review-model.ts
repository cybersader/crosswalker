/**
 * table-review-model.ts — the pure model behind the mapping review view.
 *
 * Slice 5 of the mapping table form (2026-09-30). A table-form set has no
 * notes, so the review columns a notes-form user edits as frontmatter need
 * their own editor. This module is that editor's data layer with no DOM and no
 * vault: row projection, search, filter, sort, status counts, and applying
 * review edits to rows. The store (`table-review-store.ts`) owns I/O.
 *
 * Only the review columns (`review_status`, `reviewer`, the `review_notes`
 * key of the notes map) are ever changed here. Failure mode prevented: a
 * review edit rewriting what a mapping asserts, which belongs to its source.
 */

import { REVIEW_STATUSES, type MappingTableRow, type ReviewStatus } from './mapping-table';
import type { MappingTableFile } from './mapping-table-reader';

export { REVIEW_STATUSES, type ReviewStatus };

/** The notes-map key the view edits. Other `*notes*` keys are shown read-only. */
export const REVIEW_NOTES_KEY = 'review_notes';

export interface ReviewRowView {
	row_id: string;
	subject_id: string;
	subject_label?: string;
	object_id: string;
	object_label?: string;
	predicate_id: string;
	justification?: string;
	confidence?: string;
	review_status?: string;
	reviewer?: string;
	review_notes?: string;
	/** Every notes-map key except `review_notes`, read-only in the view. */
	other_notes: Record<string, string>;
	subject_note?: string;
	object_note?: string;
	mapping_set_id?: string;
}

export type SortKey =
	| 'subject' | 'predicate' | 'object' | 'justification' | 'confidence'
	| 'review_status' | 'reviewer' | 'review_notes' | 'mapping_set_id';

export type StatusFilter = ReviewStatus | 'unset' | 'any';

/**
 * One pending change to one row's review columns. A field left out is not
 * touched; `null` (or an empty string, which a TSV cell cannot tell apart from
 * no value) clears it.
 */
export type ReviewEdit = {
	row_id: string;
	review_status?: string | null;
	reviewer?: string | null;
	review_notes?: string | null;
};

export function isReviewStatus(value: unknown): value is ReviewStatus {
	return typeof value === 'string' && (REVIEW_STATUSES as readonly string[]).includes(value);
}

export function reviewRowOf(row: MappingTableRow): ReviewRowView {
	const other: Record<string, string> = {};
	for (const [key, value] of Object.entries(row.notes ?? {})) {
		if (key !== REVIEW_NOTES_KEY) other[key] = value;
	}
	const view: ReviewRowView = {
		row_id: row.row_id,
		subject_id: row.subject_id,
		object_id: row.object_id,
		predicate_id: row.predicate_id,
		other_notes: other,
	};
	const optional: Array<[keyof ReviewRowView, string | undefined]> = [
		['subject_label', row.subject_label], ['object_label', row.object_label],
		['justification', row.mapping_justification], ['confidence', row.confidence],
		['review_status', row.review_status], ['reviewer', row.reviewer],
		['review_notes', row.notes?.[REVIEW_NOTES_KEY]],
		['subject_note', row.subject_note], ['object_note', row.object_note],
		['mapping_set_id', row.mapping_set_id],
	];
	for (const [key, value] of optional) {
		if (value !== undefined) (view as unknown as Record<string, unknown>)[key] = value;
	}
	return view;
}

export function reviewRowsOf(table: MappingTableFile): ReviewRowView[] {
	return table.rows.map(reviewRowOf);
}

/** True when a row has no review status recorded. */
function isUnset(row: ReviewRowView): boolean {
	return row.review_status === undefined || row.review_status === '';
}

/**
 * Rows matching a case-insensitive substring over subject id, object id, both
 * labels and the justification, and a status filter. `unset` matches rows with
 * no status; a status outside the schema enum matches only `any`.
 */
export function filterRows(rows: readonly ReviewRowView[], query: { text?: string; status?: StatusFilter }): ReviewRowView[] {
	const needle = (query.text ?? '').trim().toLowerCase();
	const status = query.status ?? 'any';
	return rows.filter((row) => {
		if (status === 'unset' ? !isUnset(row) : status !== 'any' && row.review_status !== status) return false;
		if (!needle) return true;
		return [row.subject_id, row.object_id, row.subject_label, row.object_label, row.justification]
			.some((value) => value !== undefined && value.toLowerCase().includes(needle));
	});
}

function sortValue(row: ReviewRowView, by: SortKey): string | undefined {
	switch (by) {
		case 'subject': return row.subject_id;
		case 'predicate': return row.predicate_id;
		case 'object': return row.object_id;
		case 'justification': return row.justification;
		case 'confidence': return row.confidence;
		case 'review_status': return row.review_status;
		case 'reviewer': return row.reviewer;
		case 'review_notes': return row.review_notes;
		case 'mapping_set_id': return row.mapping_set_id;
	}
}

/** One collator for every comparison: `localeCompare` with options re-resolves the locale per call, which is slow at 100,000 rows. */
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * A stable sort (ties keep their input order in both directions). Empty values
 * sort last in both directions, so toggling direction never buries the rows
 * that still need a value. Confidence compares as a number when both sides
 * parse as one.
 */
export function sortRows(rows: readonly ReviewRowView[], by: SortKey, direction: 'asc' | 'desc'): ReviewRowView[] {
	const sign = direction === 'asc' ? 1 : -1;
	const decorated = rows.map((row, index) => ({ row, index, value: sortValue(row, by) }));
	decorated.sort((a, b) => {
		const aEmpty = a.value === undefined || a.value === '';
		const bEmpty = b.value === undefined || b.value === '';
		if (aEmpty || bEmpty) return aEmpty === bEmpty ? a.index - b.index : aEmpty ? 1 : -1;
		let order: number;
		const aNumber = by === 'confidence' ? Number(a.value) : NaN;
		const bNumber = by === 'confidence' ? Number(b.value) : NaN;
		if (!Number.isNaN(aNumber) && !Number.isNaN(bNumber)) order = aNumber - bNumber;
		else order = COLLATOR.compare(a.value!, b.value!);
		return order !== 0 ? sign * order : a.index - b.index;
	});
	return decorated.map((entry) => entry.row);
}

/**
 * How many rows carry each status. `other` counts statuses outside the schema
 * enum (a hand-edited or legacy value), so the counts always add up to the
 * row count instead of silently hiding those rows.
 */
export function statusCounts(rows: readonly ReviewRowView[]): Record<ReviewStatus | 'unset' | 'other', number> {
	const counts = { unset: 0, other: 0 } as Record<ReviewStatus | 'unset' | 'other', number>;
	for (const status of REVIEW_STATUSES) counts[status] = 0;
	for (const row of rows) {
		if (isUnset(row)) counts.unset++;
		else if (isReviewStatus(row.review_status)) counts[row.review_status]++;
		else counts.other++;
	}
	return counts;
}

/** Fold `next` into `into`: a field present in `next` wins, including a `null` clear. */
export function mergeEdit(into: ReviewEdit | undefined, next: ReviewEdit): ReviewEdit {
	const merged: ReviewEdit = { ...(into ?? { row_id: next.row_id }) };
	if (next.review_status !== undefined) merged.review_status = next.review_status;
	if (next.reviewer !== undefined) merged.reviewer = next.reviewer;
	if (next.review_notes !== undefined) merged.review_notes = next.review_notes;
	return merged;
}

/**
 * Apply review edits by `row_id`, returning new rows (the input is not
 * mutated). `applied` counts edits whose row exists; `missing` lists, once
 * each and in edit order, the row ids no row carries. Only the review columns
 * change: managed columns and every other notes key are copied as they were.
 */
export function applyEdits(rows: readonly MappingTableRow[], edits: readonly ReviewEdit[]): { rows: MappingTableRow[]; applied: number; missing: string[] } {
	const index = new Map<string, number>();
	rows.forEach((row, position) => index.set(row.row_id, position));
	const out = rows.slice();
	const missing: string[] = [];
	let applied = 0;
	for (const edit of edits) {
		const position = index.get(edit.row_id);
		if (position === undefined) {
			if (!missing.includes(edit.row_id)) missing.push(edit.row_id);
			continue;
		}
		const row: MappingTableRow = { ...out[position] };
		if (row.notes) row.notes = { ...row.notes };
		if (edit.review_status !== undefined) {
			if (edit.review_status === null || edit.review_status === '') delete row.review_status;
			else row.review_status = edit.review_status;
		}
		if (edit.reviewer !== undefined) {
			if (edit.reviewer === null || edit.reviewer === '') delete row.reviewer;
			else row.reviewer = edit.reviewer;
		}
		if (edit.review_notes !== undefined) {
			const notes = { ...(row.notes ?? {}) };
			if (edit.review_notes === null || edit.review_notes === '') delete notes[REVIEW_NOTES_KEY];
			else notes[REVIEW_NOTES_KEY] = edit.review_notes;
			if (Object.keys(notes).length) row.notes = notes;
			else delete row.notes;
		}
		out[position] = row;
		applied++;
	}
	return { rows: out, applied, missing };
}
