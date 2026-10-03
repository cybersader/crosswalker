/**
 * mapping-review-helpers.ts — the pure pieces of the mapping review view.
 *
 * Slice 5 of the mapping table form (2026-09-30), Part B. No DOM and no vault:
 * the windowed grid's row-range math, the plain wording for predicates, the
 * set label shown in the header, and reading an endpoint wikilink. Kept apart
 * from the view so each rule has a unit test.
 */

import { CROSSWALK_PREDICATES, CROSSWALK_PREDICATE_LABELS, type CrosswalkPredicate } from '../import/mapping/types';
import type { MappingTableHeader, MappingTableRow } from '../mappings/mapping-table';
import {
	computeMappingSetDigests,
	mappingSetFromTableHeader,
	observedParticipants,
	type MappingSetRecord,
} from '../mappings/mapping-set';
import { importSetIdOf } from '../mappings/conversion-marker';
import { plural } from '../utils/plural';

/** The rows a windowed grid puts in the DOM, and the empty space around them. */
export interface RowWindow {
	/** First row index rendered (inclusive). */
	start: number;
	/** One past the last row index rendered (exclusive). */
	end: number;
	/** Height of the empty space above the first rendered row, in pixels. */
	padTop: number;
	/** Height of the empty space below the last rendered row, in pixels. */
	padBottom: number;
}

/**
 * Which rows to render for a scroll position. Only the rows in the viewport,
 * plus `overscan` rows on each side so a small scroll never shows a gap, are
 * put in the DOM; the padding keeps the scrollbar the height of every row.
 *
 * Failure mode prevented: a table with hundreds of thousands of rows rendered
 * as that many DOM rows, which freezes Obsidian. The rendered count stays
 * bounded by the viewport whatever the total.
 *
 * Every input is clamped: a negative or overshooting scroll position (elastic
 * scrolling, a list that shrank under a filter) still returns a valid window.
 */
export function windowRange(scrollTop: number, viewportHeight: number, rowHeight: number, total: number, overscan = 8): RowWindow {
	const count = Math.max(0, Math.floor(total));
	if (count === 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
	const maxScroll = Math.max(0, count * rowHeight - Math.max(0, viewportHeight));
	const top = Math.min(Math.max(0, scrollTop || 0), maxScroll);
	const visible = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / rowHeight));
	const first = Math.floor(top / rowHeight);
	const start = Math.max(0, first - Math.max(0, overscan));
	const end = Math.min(count, first + visible + 1 + Math.max(0, overscan));
	return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight };
}

/**
 * The scroll position that brings row `index` fully into view, or the current
 * one when it already is. Used by arrow-key navigation.
 */
export function scrollToRevealRow(index: number, scrollTop: number, viewportHeight: number, rowHeight: number): number {
	const rowTop = index * rowHeight;
	const rowBottom = rowTop + rowHeight;
	if (rowTop < scrollTop) return rowTop;
	if (rowBottom > scrollTop + viewportHeight) return Math.max(0, rowBottom - viewportHeight);
	return scrollTop;
}

/**
 * Plain wording for a stored predicate, e.g. "They partly overlap". A prefixed
 * id (`strm:intersects_with`) reads as its local name; a predicate outside the
 * crosswalk vocabulary shows as stored, so nothing is hidden or renamed.
 */
export function predicateLabel(predicateId: string): string {
	const local = predicateId.includes(':') ? predicateId.slice(predicateId.lastIndexOf(':') + 1) : predicateId;
	return (CROSSWALK_PREDICATES as readonly string[]).includes(local)
		? CROSSWALK_PREDICATE_LABELS[local as CrosswalkPredicate]
		: predicateId;
}

/**
 * The name the view's header shows for a table: its two frameworks when the
 * header records them, else its mapping set id, else the file name.
 */
export function mappingSetLabel(header: Pick<MappingTableHeader, 'source_framework' | 'target_framework' | 'mapping_set_id'>, path: string): string {
	if (header.source_framework && header.target_framework) return `${header.source_framework} to ${header.target_framework}`;
	if (header.mapping_set_id) return header.mapping_set_id;
	const name = path.slice(path.lastIndexOf('/') + 1);
	return name.replace(/\.mapping-table\.tsv$/, '') || name;
}

/**
 * The link path inside a stored endpoint wikilink (`[[Folder/Note|Label]]`
 * gives `Folder/Note`), or undefined when the value is not a wikilink. The
 * view resolves the path against the vault before showing a link, so a
 * dangling endpoint never looks clickable.
 */
export function wikilinkPath(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const match = /^\s*!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]\s*$/.exec(value);
	const path = match?.[1]?.trim();
	return path ? path : undefined;
}

/**
 * The selected row ids that are still shown, in selection order. The view
 * replaces its selection with this whenever the search or status filter
 * changes, and a bulk edit acts only on this set.
 *
 * Failure mode prevented: a bulk edit reaching rows the user can no longer
 * see. Selecting every unset row, then filtering to one framework family, then
 * choosing Set reviewer must touch only the rows on screen, never the hidden
 * ones selected earlier.
 */
export function visibleSelection(selected: Iterable<string>, visibleIds: Iterable<string>): Set<string> {
	const shown: ReadonlySet<string> = visibleIds instanceof Set ? visibleIds : new Set(visibleIds);
	const kept = new Set<string>();
	for (const rowId of selected) if (shown.has(rowId)) kept.add(rowId);
	return kept;
}

// ---------------------------------------------------------------------------
// Release section (v0.1.7 Track 3, mapping set release record)
// ---------------------------------------------------------------------------

/** One labelled fact in the Release section. */
export interface ReleaseFact {
	label: string;
	value: string;
}

/**
 * What the Release section above the grid shows:
 * - `recorded`: the set's release record, plus a membership check against the
 *   rows the table holds now;
 * - `none`: a set imported before release records existed (M9);
 * - `unreadable`: the record is there and malformed; `text` names the cause
 *   and the action (the reader's own message).
 */
export type ReleaseSection =
	| { state: 'recorded'; heading: string; facts: ReleaseFact[]; membership: { intact: boolean; text: string } }
	| { state: 'none'; text: string }
	| { state: 'unreadable'; text: string };

export const NO_RELEASE_RECORD_TEXT = 'No release record for this set. Import it again to record one.';

/** "demo-a 1.0" from a declared source and its version. */
function sourceText(source: string, version: string | undefined): string {
	return version ? `${source} ${version}` : source;
}

/**
 * "from X vA to Y vB": declared sources when the record states them, else the
 * curie prefixes the rows use, labelled "observed from rows" (M7). Observed
 * values are shown, never written into the record.
 */
export function releaseParticipantsText(record: MappingSetRecord, rows: readonly Pick<MappingTableRow, 'subject_id' | 'object_id'>[]): string {
	let observed = false;
	const observedSides = (subject: boolean): string => {
		observed = true;
		const seen = observedParticipants(rows);
		const prefixes = subject ? seen.subjectPrefixes : seen.objectPrefixes;
		return prefixes.length ? prefixes.join(', ') : 'unknown';
	};
	const from = record.subject_source ? sourceText(record.subject_source, record.subject_source_version) : observedSides(true);
	const to = record.object_source ? sourceText(record.object_source, record.object_source_version) : observedSides(false);
	return `from ${from} to ${to}${observed ? ' (observed from rows)' : ''}`;
}

/**
 * The membership check: the digest recomputed over the rows the table holds
 * now, compared with the recorded one. Review columns never enter the digest,
 * so reviewing never makes a set read as changed. The record keeps only a
 * digest, not the recorded rows, so a difference is reported with both counts
 * rather than which rows moved.
 */
export function releaseMembershipText(record: MappingSetRecord, rows: readonly MappingTableRow[]): { intact: boolean; text: string } {
	const now = computeMappingSetDigests(rows.map((row) => ({
		subject_id: row.subject_id,
		predicate_id: row.predicate_id,
		object_id: row.object_id,
		predicate_modifier: row.predicate_modifier,
		mapping_justification: row.mapping_justification,
		confidence: row.confidence,
		mapping_provider: row.mapping_provider,
	})));
	if (now.membership_digest !== record.membership_digest) {
		return {
			intact: false,
			text: `Membership differs from the recorded release: ${plural(now.assertion_count, 'mapping')} now, ${record.assertion_count.toLocaleString()} recorded.`,
		};
	}
	if (now.content_digest !== record.content_digest) {
		return {
			intact: true,
			text: 'Membership intact. Some justification, confidence or provider values differ from the recorded release.',
		};
	}
	return { intact: true, text: 'Membership intact.' };
}

/** The Release section of one mapping table, from its header and current rows. Pure. */
export function releaseSectionOf(table: { path: string; header: MappingTableHeader; rows: readonly MappingTableRow[] }): ReleaseSection {
	let record: MappingSetRecord | undefined;
	try {
		record = mappingSetFromTableHeader(table.header, importSetIdOf(table.header.crosswalker_provenance) ?? '', table.path);
	} catch (error) {
		return { state: 'unreadable', text: error instanceof Error ? error.message : `The release record in ${table.path} could not be read. Import the set again to record one.` };
	}
	if (!record) return { state: 'none', text: NO_RELEASE_RECORD_TEXT };
	const heading = [record.mapping_set_title ?? record.mapping_set_id, record.mapping_set_version ? `version ${record.mapping_set_version}` : '']
		.filter(Boolean).join(', ');
	const facts: ReleaseFact[] = [];
	if (record.mapping_set_title) facts.push({ label: 'Release id', value: record.mapping_set_id });
	facts.push({ label: 'Sources', value: releaseParticipantsText(record, table.rows) });
	if (record.mapping_provider) facts.push({ label: 'Provider', value: record.mapping_provider });
	if (record.mapping_date) facts.push({ label: 'Date', value: record.mapping_date });
	if (record.license) facts.push({ label: 'License', value: record.license });
	facts.push({ label: 'Recorded', value: plural(record.assertion_count, 'mapping') });
	return { state: 'recorded', heading, facts, membership: releaseMembershipText(record, table.rows) };
}
