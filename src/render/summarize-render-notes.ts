/**
 * summarizeRenderNotes — pure aggregation of per-row RenderReport notes into
 * the wizard Step 3 preview banner (v0.1.6).
 *
 * render() (see ./index.ts) is silent-fallback-safe: every row still produces
 * an Address even when a folder level renders empty or a split()/regex()
 * filter finds nothing to work with. The RenderReport makes those fallbacks
 * observable per row. This module has no Obsidian dependency so it can be
 * unit-tested directly; the wizard (src/import/import-wizard.ts) supplies
 * the per-row render() output and renders the returned summary as DOM.
 */

import type { RenderNote } from './types';

/** One previewed row's render() output, alongside any deviation notes. */
export interface PreviewRowNotes {
	/** 1-indexed row number, matching the convention used elsewhere in the wizard/engine. */
	row: number;
	notes: RenderNote[];
	/** The output path render() produced for this row. */
	path: string;
}

/** One deviant row, ready to display in the expandable details list. */
export interface RenderNoteDetail {
	row: number;
	/** Plain-language explanation(s) for this row, joined if it has more than one note. */
	detail: string;
	path: string;
}

export interface RenderNoteSummary {
	/** Number of rows actually run through render() for this preview. */
	previewedCount: number;
	/** True when previewedCount is less than the full source row count — i.e.
	 *  the banner is describing a sample, not the whole import, and must say so. */
	sampled: boolean;
	/** Rows with at least one deviation note. */
	deviantCount: number;
	/** 'clean' when every previewed row matched the recipe pattern; 'warning' otherwise. */
	tone: 'clean' | 'warning';
	/** The banner headline, already in its final sentence-case, user-safe form. */
	message: string;
	/** Deviant-row details, capped at maxDetails entries. */
	details: RenderNoteDetail[];
	/** Count of additional deviant rows beyond the cap (0 if none). */
	moreCount: number;
}

/** Default cap on the number of deviant rows shown in the expandable details list. */
export const DEFAULT_MAX_RENDER_NOTE_DETAILS = 50;

export function summarizeRenderNotes(
	perRow: PreviewRowNotes[],
	totalSourceRows: number,
	maxDetails: number = DEFAULT_MAX_RENDER_NOTE_DETAILS,
): RenderNoteSummary {
	const previewedCount = perRow.length;
	const sampled = totalSourceRows > previewedCount;
	const deviant = perRow.filter((r) => r.notes.length > 0);
	const deviantCount = deviant.length;
	const cleanCount = previewedCount - deviantCount;

	const message = deviantCount === 0
		? buildCleanMessage(previewedCount, sampled)
		: buildWarningMessage(cleanCount, previewedCount, deviantCount, sampled);

	const details: RenderNoteDetail[] = deviant.slice(0, maxDetails).map((r) => ({
		row: r.row,
		detail: r.notes.map((n) => n.detail).join(' '),
		path: r.path,
	}));

	const moreCount = Math.max(0, deviantCount - maxDetails);

	return {
		previewedCount,
		sampled,
		deviantCount,
		tone: deviantCount === 0 ? 'clean' : 'warning',
		message,
		details,
		moreCount,
	};
}

function buildCleanMessage(previewedCount: number, sampled: boolean): string {
	return sampled
		? `All of the first ${previewedCount} rows previewed match the recipe pattern.`
		: `All ${previewedCount} previewed rows match the recipe pattern.`;
}

function buildWarningMessage(
	cleanCount: number,
	previewedCount: number,
	deviantCount: number,
	sampled: boolean,
): string {
	const rowsPhrase = deviantCount === 1 ? "row doesn't" : "rows don't";
	const scopePhrase = sampled ? `the first ${previewedCount} rows previewed` : `${previewedCount} previewed rows`;
	return `${cleanCount} of ${scopePhrase} match the pattern fully. ${deviantCount} ${rowsPhrase}. Expand to see where they'll land.`;
}
