/**
 * summarize-render-notes.test.ts — pure aggregation used by the wizard Step 3
 * preview banner (v0.1.6). No Obsidian dependency; see src/render/summarize-render-notes.ts.
 */

import { summarizeRenderNotes, DEFAULT_MAX_RENDER_NOTE_DETAILS } from '../src/render/summarize-render-notes';
import type { RenderNote } from '../src/render/types';
import type { PreviewRowNotes } from '../src/render/summarize-render-notes';

const note = (overrides: Partial<RenderNote> = {}): RenderNote => ({
	code: 'split-no-delimiter',
	template: '{id|split(.,0)}',
	detail: 'Fallback detail.',
	...overrides,
});

const cleanRow = (row: number): PreviewRowNotes => ({ row, notes: [], path: `Framework/${row}.md` });
const deviantRow = (row: number, detail = 'Fallback detail.'): PreviewRowNotes => ({
	row,
	notes: [note({ detail })],
	path: `Framework/${row}.md`,
});

describe('summarizeRenderNotes — all clean', () => {
	it('reports a quiet confirmation when every previewed row is clean and not sampled', () => {
		const perRow = Array.from({ length: 200 }, (_, i) => cleanRow(i + 1));
		const summary = summarizeRenderNotes(perRow, 200);

		expect(summary.tone).toBe('clean');
		expect(summary.sampled).toBe(false);
		expect(summary.deviantCount).toBe(0);
		expect(summary.details).toHaveLength(0);
		expect(summary.message).toBe('All 200 previewed rows match the recipe pattern.');
	});

	it('says "first N rows previewed" when the preview only sampled part of the source', () => {
		const perRow = Array.from({ length: 200 }, (_, i) => cleanRow(i + 1));
		const summary = summarizeRenderNotes(perRow, 5000);

		expect(summary.sampled).toBe(true);
		expect(summary.message).toBe('All of the first 200 rows previewed match the recipe pattern.');
	});
});

describe('summarizeRenderNotes — deviations present', () => {
	it('builds the warning banner text for the exact 187/200/13 example', () => {
		const perRow: PreviewRowNotes[] = [
			...Array.from({ length: 187 }, (_, i) => cleanRow(i + 1)),
			...Array.from({ length: 13 }, (_, i) => deviantRow(188 + i)),
		];
		const summary = summarizeRenderNotes(perRow, 200);

		expect(summary.tone).toBe('warning');
		expect(summary.deviantCount).toBe(13);
		expect(summary.message).toBe(
			"187 of 200 previewed rows match the pattern fully. 13 rows don't. Expand to see where they'll land.",
		);
	});

	it('uses the sampled phrasing when the source has more rows than were previewed', () => {
		const perRow: PreviewRowNotes[] = [
			...Array.from({ length: 187 }, (_, i) => cleanRow(i + 1)),
			...Array.from({ length: 13 }, (_, i) => deviantRow(188 + i)),
		];
		const summary = summarizeRenderNotes(perRow, 50000);

		expect(summary.sampled).toBe(true);
		expect(summary.message).toBe(
			"187 of the first 200 rows previewed match the pattern fully. 13 rows don't. Expand to see where they'll land.",
		);
	});

	it('uses singular "row doesn\'t" phrasing for exactly one deviation', () => {
		const perRow: PreviewRowNotes[] = [cleanRow(1), deviantRow(2)];
		const summary = summarizeRenderNotes(perRow, 2);

		expect(summary.message).toBe(
			"1 of 2 previewed rows match the pattern fully. 1 row doesn't. Expand to see where they'll land.",
		);
	});

	it('joins multiple notes on the same row into one detail string', () => {
		const row: PreviewRowNotes = {
			row: 3,
			notes: [note({ detail: 'First issue.' }), note({ detail: 'Second issue.' })],
			path: 'Framework/3.md',
		};
		const summary = summarizeRenderNotes([row], 1);

		expect(summary.details[0].detail).toBe('First issue. Second issue.');
	});

	it('caps the details list and reports the remainder via moreCount', () => {
		const perRow = Array.from({ length: 60 }, (_, i) => deviantRow(i + 1));
		const summary = summarizeRenderNotes(perRow, 60);

		expect(summary.details).toHaveLength(DEFAULT_MAX_RENDER_NOTE_DETAILS);
		expect(summary.moreCount).toBe(10);
	});

	it('respects a custom maxDetails override', () => {
		const perRow = Array.from({ length: 10 }, (_, i) => deviantRow(i + 1));
		const summary = summarizeRenderNotes(perRow, 10, 3);

		expect(summary.details).toHaveLength(3);
		expect(summary.moreCount).toBe(7);
	});

	it('includes row number and output path in each detail entry', () => {
		const perRow: PreviewRowNotes[] = [deviantRow(7, 'Something fell back.')];
		const summary = summarizeRenderNotes(perRow, 1);

		expect(summary.details[0]).toEqual({ row: 7, detail: 'Something fell back.', path: 'Framework/7.md' });
	});
});
