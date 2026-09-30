/**
 * Slice 5 Part B of the mapping table form (2026-09-30): the pure helpers of
 * the mapping review view. The window math is what keeps a large table from
 * freezing Obsidian, so its bounds are pinned here.
 *
 * Synthetic data only: `demo-a:` / `demo-b:` ids.
 */
import {
	mappingSetLabel, predicateLabel, scrollToRevealRow, visibleSelection, wikilinkPath, windowRange,
} from '../src/views/mapping-review-helpers';
import { DEFAULT_SETTINGS } from '../src/settings/settings-data';

const ROW = 34;

describe('windowRange', () => {
	it('renders only the viewport plus overscan at the top of a large table', () => {
		const range = windowRange(0, 340, ROW, 100_000, 5);
		expect(range.start).toBe(0);
		// 10 visible rows, one partial, plus 5 overscan below.
		expect(range.end).toBe(16);
		expect(range.padTop).toBe(0);
		expect(range.padBottom).toBe((100_000 - 16) * ROW);
	});

	it('keeps the rendered count bounded by the viewport, not the row count', () => {
		for (const total of [1_000, 100_000, 500_000]) {
			const range = windowRange(total * ROW / 2, 680, ROW, total, 8);
			expect(range.end - range.start).toBeLessThanOrEqual(Math.ceil(680 / ROW) + 1 + 16);
			expect(range.padTop + (range.end - range.start) * ROW + range.padBottom).toBe(total * ROW);
		}
	});

	it('starts at the row under the scroll position, minus overscan', () => {
		const range = windowRange(50 * ROW + 10, 340, ROW, 1_000, 4);
		expect(range.start).toBe(46);
		expect(range.end).toBe(50 + 10 + 1 + 4);
		expect(range.padTop).toBe(46 * ROW);
	});

	it('clamps a scroll past the end (a list that shrank under a filter) to the last screen', () => {
		const range = windowRange(1_000_000, 340, ROW, 30, 2);
		expect(range.end).toBe(30);
		expect(range.start).toBe(18);
		expect(range.padBottom).toBe(0);
	});

	it('clamps a negative scroll (elastic scrolling) to the top', () => {
		expect(windowRange(-200, 340, ROW, 100, 0)).toEqual(windowRange(0, 340, ROW, 100, 0));
	});

	it('returns an empty window for no rows or a bad row height', () => {
		expect(windowRange(0, 340, ROW, 0)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
		expect(windowRange(0, 340, 0, 50)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
	});

	it('renders every row of a table shorter than the viewport', () => {
		const range = windowRange(0, 680, ROW, 5, 8);
		expect(range).toEqual({ start: 0, end: 5, padTop: 0, padBottom: 0 });
	});
});

describe('scrollToRevealRow', () => {
	it('leaves the scroll alone when the row is already fully visible', () => {
		expect(scrollToRevealRow(3, 0, 340, ROW)).toBe(0);
	});
	it('scrolls up to a row above the viewport', () => {
		expect(scrollToRevealRow(2, 10 * ROW, 340, ROW)).toBe(2 * ROW);
	});
	it('scrolls down just enough to show a row below the viewport', () => {
		expect(scrollToRevealRow(20, 0, 340, ROW)).toBe(21 * ROW - 340);
	});
});

describe('predicateLabel', () => {
	it('words crosswalk predicates plainly, with or without a prefix', () => {
		expect(predicateLabel('intersects_with')).toBe('They partly overlap');
		expect(predicateLabel('strm:is_equivalent_to')).toBe('Exactly the same requirement');
	});
	it('shows an unknown predicate as stored', () => {
		expect(predicateLabel('demo:relates_somehow')).toBe('demo:relates_somehow');
	});
});

describe('mappingSetLabel', () => {
	it('prefers the two frameworks, then the set id, then the file name', () => {
		expect(mappingSetLabel({ source_framework: 'demo-a', target_framework: 'demo-b', mapping_set_id: 'demo-map' }, 'M/x.mapping-table.tsv')).toBe('demo-a to demo-b');
		expect(mappingSetLabel({ mapping_set_id: 'demo-map' }, 'M/x.mapping-table.tsv')).toBe('demo-map');
		expect(mappingSetLabel({}, 'Maps/demo-a-to-demo-b.mapping-table.tsv')).toBe('demo-a-to-demo-b');
	});
});

describe('wikilinkPath', () => {
	it('reads the link path from a stored endpoint wikilink', () => {
		expect(wikilinkPath('[[Frameworks/demo-a/X-1|X-1 Alpha gate]]')).toBe('Frameworks/demo-a/X-1');
		expect(wikilinkPath('[[X-1]]')).toBe('X-1');
		expect(wikilinkPath('[[X-1#Heading|Alias]]')).toBe('X-1');
	});
	it('refuses values that are not a single wikilink', () => {
		expect(wikilinkPath(undefined)).toBeUndefined();
		expect(wikilinkPath('demo-a:X-1')).toBeUndefined();
		expect(wikilinkPath('[[]]')).toBeUndefined();
		expect(wikilinkPath('see [[X-1]] too')).toBeUndefined();
	});
});

describe('visibleSelection', () => {
	it('drops selected rows that the filter now hides', () => {
		const kept = visibleSelection(new Set(['demo-r1', 'demo-r2', 'demo-r3']), ['demo-r2', 'demo-r3', 'demo-r4']);
		expect([...kept]).toEqual(['demo-r2', 'demo-r3']);
	});
	it('never adds a visible row that was not selected', () => {
		expect(visibleSelection(['demo-r1'], ['demo-r1', 'demo-r2']).has('demo-r2')).toBe(false);
	});
	it('is empty when nothing selected is shown, or nothing is shown', () => {
		expect(visibleSelection(['demo-r1'], ['demo-r2']).size).toBe(0);
		expect(visibleSelection(['demo-r1', 'demo-r2'], []).size).toBe(0);
	});
	it('keeps the whole selection when every selected row is shown', () => {
		const visible = new Set(['demo-r1', 'demo-r2', 'demo-r3']);
		expect([...visibleSelection(['demo-r3', 'demo-r1'], visible)]).toEqual(['demo-r3', 'demo-r1']);
	});
	it('does not change the selection it was given', () => {
		const selected = new Set(['demo-r1', 'demo-r2']);
		visibleSelection(selected, ['demo-r1']);
		expect(selected.size).toBe(2);
	});
});

describe('mapping review setting', () => {
	it('opens mapping tables in Crosswalker by default', () => {
		expect(DEFAULT_SETTINGS.openMappingTablesInCrosswalker).toBe(true);
	});
});
