import { planStack, requiresStackConfirmation, stackPlanRow, stackPlanSummary, stackPlanTotal, type StackPlanInput } from '../src/import/stack/stack-plan';

const exact = (count: number) => ({ count, exact: true });
const estimate = (count: number) => ({ count, exact: false });
const synthetic: StackPlanInput = {
	slots: [{ id: 'flat', label: 'Flat', root: 'Frameworks/Flat', mode: 'new', notes: exact(3), folders: estimate(1) },
		{ id: 'nested', label: 'Nested', root: 'Frameworks/Nested', mode: 'new', notes: exact(5), folders: estimate(3) }],
	mappings: [{ id: 'publisher', label: 'Mapping', root: '_crosswalker/mappings/a-to-b', mode: 'new', form: 'notes', notes: exact(2) }],
};

test('flat, nested and duplicate-filtered mapping counts render honestly', () => {
	const plan = planStack(synthetic);
	expect(plan.totals).toEqual({ newFiles: estimate(14), rewrites: exact(0) });
	expect(plan.slots.map(stackPlanRow)).toMatchInlineSnapshot(`
[
  "Writes 3 notes and about 1 folder.",
  "Writes 5 notes and about 3 folders.",
]
`);
	expect(plan.mappings.map(stackPlanRow)).toEqual(['Writes 2 mapping notes.']);
	expect(stackPlanSummary(plan)).toBe('This run writes about 14 new files into Frameworks/Flat, Frameworks/Nested, _crosswalker/mappings/a-to-b.');
});

test('inline crosswalk notes count separately from framework notes and show their destination', () => {
	const plan = planStack({ slots: [{ id: 'inline', label: 'Framework', root: 'Frameworks/A',
		extraRoots: ['_crosswalker/mappings/a-to-b'], mode: 'new', notes: exact(3), extraNotes: estimate(2) }], mappings: [] });
	expect(plan.totals.newFiles).toEqual(estimate(5));
	expect(plan.roots).toEqual(['Frameworks/A', '_crosswalker/mappings/a-to-b']);
	expect(stackPlanRow(plan.slots[0])).toBe('Writes 3 notes and about 2 crosswalk notes.');
});

test('top levels and built-in mapping are represented by selected-row counts', () => {
	const plan = planStack({ slots: [{ id: 'top', label: 'Top', root: 'Top', mode: 'new', notes: exact(2) }],
		mappings: [{ id: 'built', label: 'Built in', root: 'Mappings', mode: 'new', form: 'notes', notes: exact(4) }] });
	expect(stackPlanTotal(plan)).toBe(6);
	expect(requiresStackConfirmation(plan, 6)).toBe(false);
	expect(requiresStackConfirmation(plan, 5)).toBe(true);
	expect(requiresStackConfirmation(plan, 0)).toBe(true);
	expect(plan.mappings[0].newFiles.exact).toBe(true);
});

test('all Skip disables writes and Refresh is counted as an upper-bound rewrite', () => {
	const skipped = planStack({ slots: synthetic.slots.map((item) => ({ ...item, mode: 'skip' })),
		mappings: synthetic.mappings.map((item) => ({ ...item, mode: 'skip' })) });
	expect(stackPlanTotal(skipped)).toBe(0);
	expect(requiresStackConfirmation(skipped, 0)).toBe(false);
	expect(skipped.slots.map(stackPlanRow)).toEqual(['Skip: writes nothing.', 'Skip: writes nothing.']);
	const refreshed = planStack({ slots: [{ ...synthetic.slots[0], mode: 'refresh' }], mappings: [] });
	expect(refreshed.totals).toEqual({ newFiles: exact(0), rewrites: exact(3) });
	expect(stackPlanRow(refreshed.slots[0])).toBe('Refresh: rewrites up to 3 notes in Frameworks/Flat. Unchanged notes are left alone.');
});

test('count failures retain a lower bound and are explicitly visible', () => {
	const plan = planStack({ slots: [{ ...synthetic.slots[0], failed: true, notes: estimate(0) }, synthetic.slots[1]], mappings: [] });
	expect(plan.failed).toBe(true);
	expect(stackPlanRow(plan.slots[0])).toBe('Could not count this file. The import can still run.');
	expect(stackPlanSummary(plan)).toMatch(/^At least /);
});

test('a table mapping counts as one file and says how many rows it holds', () => {
	const table = { id: 'table', label: 'Table', root: '_crosswalker/mappings/a-to-b', form: 'table' as const,
		notes: exact(250), folders: estimate(2) };
	const fresh = planStack({ slots: [{ id: 'flat', label: 'Flat', root: 'Frameworks/Flat', mode: 'new', notes: exact(3) }],
		mappings: [{ ...table, mode: 'new' }] });
	expect(fresh.mappings[0].newFiles).toEqual(exact(1));
	expect(fresh.totals).toEqual({ newFiles: exact(4), rewrites: exact(0) });
	expect(stackPlanTotal(fresh)).toBe(4);
	// 250 rows as notes would trip a threshold of 100; one table file does not.
	expect(requiresStackConfirmation(fresh, 100)).toBe(false);
	expect(stackPlanRow(fresh.mappings[0])).toBe('Writes 1 mapping table (~250 rows) in _crosswalker/mappings/a-to-b.');
	const refreshed = planStack({ slots: [], mappings: [{ ...table, mode: 'refresh' }] });
	expect(refreshed.totals).toEqual({ newFiles: exact(0), rewrites: exact(1) });
	expect(stackPlanRow(refreshed.mappings[0])).toBe('Refresh: rewrites 1 mapping table (~250 rows) in _crosswalker/mappings/a-to-b.');
	expect(stackPlanSummary(refreshed)).toBe('This run writes 0 new files and may rewrite up to 1 existing file into _crosswalker/mappings/a-to-b.');
	const skipped = planStack({ slots: [], mappings: [{ ...table, mode: 'skip' }] });
	expect(stackPlanTotal(skipped)).toBe(0);
	expect(stackPlanRow(skipped.mappings[0])).toBe('Skip: writes nothing.');
});

test('the same rows stored as notes still count one file per mapping', () => {
	const plan = planStack({ slots: [], mappings: [{ id: 'notes', label: 'Notes', root: 'M', mode: 'new', form: 'notes', notes: exact(250) }] });
	expect(stackPlanTotal(plan)).toBe(250);
	expect(stackPlanRow(plan.mappings[0])).toBe('Writes 250 mapping notes.');
});
