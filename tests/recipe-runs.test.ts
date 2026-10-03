/**
 * Run records for library recipes (run again slice 2: R1 to R3, R7, section 3,
 * acceptance case 11). Synthetic ids only.
 */

import {
	CHECKING_VAULT_LINE,
	RECIPE_CHANGED_LINE,
	RECIPE_RUN_CAP,
	STALE_SET_MESSAGE,
	STALE_SET_NEXT_HINT,
	STALE_SET_OPTION,
	START_NEW_IMPORT_LABEL,
	chooseFileLine,
	displayRecipeRuns,
	lastRunLine,
	normalizeRecipeRun,
	normalizeRecipeRuns,
	notesPhrase,
	pruneRecipeRuns,
	readyToRefreshLine,
	recipeChangedSinceRun,
	recipeRunDigest,
	refreshingLine,
	runAgainLeadLine,
	runSetDisplayName,
	runsForRecipe,
	sourceRunStatus,
	sourceStatusLine,
	upsertRecipeRun,
	type RecipeRunRecord,
} from '../src/import/recipe-runs';

const D = (c: string) => `sha256-${c.repeat(64)}`;

function run(overrides: Partial<RecipeRunRecord> = {}): RecipeRunRecord {
	return {
		recipeId: 'widget-recipe',
		recipeDocumentDigest: D('a'),
		importSetId: 'set-one',
		source: { name: 'widgets.csv', digest: D('b') },
		overwriteMode: 'replace',
		finishedAt: '2026-03-01T10:00:00.000Z',
		sourceCopy: 'none',
		...overrides,
	};
}

describe('normalizeRecipeRuns', () => {
	it('keeps well-formed records with every field', () => {
		const record = run({ source: { name: 'w.xlsx', digest: D('c'), sheet: 'Sheet two', headerRow: 2 } });
		expect(normalizeRecipeRuns([record])).toEqual([record]);
		const json = run({ source: { name: 'w.json', iterator: '$.items' } });
		expect(normalizeRecipeRun(json)).toEqual(json);
	});

	it('drops malformed rows without throwing (case 11)', () => {
		const bad: unknown[] = [
			null,
			'text',
			{},
			{ ...run(), recipeDocumentDigest: 'not-a-digest' },
			{ ...run(), overwriteMode: 'merge' },
			{ ...run(), sourceCopy: 'retained' },
			{ ...run(), finishedAt: 'yesterday' },
			{ ...run(), source: { name: '' } },
			{ ...run(), source: { name: 'x.csv', headerRow: -1 } },
			{ ...run(), importSetId: '  ' },
		];
		expect(normalizeRecipeRuns([...bad, run()])).toEqual([run()]);
		expect(normalizeRecipeRuns(undefined)).toEqual([]);
		expect(normalizeRecipeRuns({ not: 'an array' })).toEqual([]);
	});

	it('drops unknown extra fields (closed record)', () => {
		const extra = { ...run(), counts: { created: 3 }, actor: 'someone' };
		expect(normalizeRecipeRun(extra)).toEqual(run());
	});

	it('keeps the newest row per recipe and set, newest first', () => {
		const older = run({ finishedAt: '2026-01-01T00:00:00.000Z' });
		const newer = run({ finishedAt: '2026-02-01T00:00:00.000Z' });
		const other = run({ importSetId: 'set-two', finishedAt: '2026-01-15T00:00:00.000Z' });
		expect(normalizeRecipeRuns([older, other, newer])).toEqual([newer, other]);
	});

	it('caps the list, dropping the oldest first', () => {
		const many = Array.from({ length: RECIPE_RUN_CAP + 5 }, (_, i) => run({
			importSetId: `set-${i}`,
			finishedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
		}));
		const out = normalizeRecipeRuns(many);
		expect(out).toHaveLength(RECIPE_RUN_CAP);
		expect(out.some((r) => r.importSetId === 'set-0')).toBe(false);
		expect(out[0].importSetId).toBe(`set-${RECIPE_RUN_CAP + 4}`);
	});
});

describe('upsert, filter and prune', () => {
	it('upsert replaces the record for the same recipe and set', () => {
		const first = run();
		const second = run({ finishedAt: '2026-04-01T00:00:00.000Z', overwriteMode: 'skip' });
		const other = run({ recipeId: 'other-recipe' });
		const runs = upsertRecipeRun(upsertRecipeRun([first, other], second), run({ importSetId: 'set-two', finishedAt: '2026-03-15T00:00:00.000Z' }));
		expect(runs.filter((r) => r.recipeId === 'widget-recipe' && r.importSetId === 'set-one')).toEqual([second]);
		expect(runsForRecipe(runs, 'widget-recipe').map((r) => r.importSetId)).toEqual(['set-one', 'set-two']);
	});

	it('prune keeps only records whose set is live', () => {
		const runs = [run(), run({ importSetId: 'gone' })];
		expect(pruneRecipeRuns(runs, new Set(['set-one']))).toEqual([run()]);
	});
});

describe('displayRecipeRuns (R3)', () => {
	const sets = [
		{ id: 'set-one', root: 'Imports/Widgets', noteCount: 3 },
		{ id: 'set-two', root: null, ontology: 'zz' },
	];

	it('shows only records whose set still exists, with a readable set name', async () => {
		const runs = [run(), run({ importSetId: 'gone', finishedAt: '2026-05-01T00:00:00.000Z' }), run({ importSetId: 'set-two', finishedAt: '2026-02-01T00:00:00.000Z' })];
		const display = await displayRecipeRuns(runs, 'widget-recipe', { settle: async () => 0, discover: async () => sets });
		expect(display).toEqual({
			state: 'ready',
			rows: [
				{ run: runs[0], setName: 'Widgets', noteCount: 3 },
				{ run: runs[2], setName: 'zz' },
			],
		});
	});

	it('says checking while the index is unsettled, never missing', async () => {
		let discovered = false;
		const display = await displayRecipeRuns([run()], 'widget-recipe', {
			settle: async () => 3,
			discover: async () => { discovered = true; return []; },
		});
		expect(display).toEqual({ state: 'checking' });
		expect(discovered).toBe(false);
		expect(await displayRecipeRuns([run()], 'widget-recipe', { settle: async () => { throw new Error('x'); }, discover: async () => [] }))
			.toEqual({ state: 'checking' });
	});

	it('returns no rows without touching the vault when there are no records', async () => {
		const display = await displayRecipeRuns([run()], 'unrelated', {
			settle: async () => { throw new Error('should not be called'); },
			discover: async () => [],
		});
		expect(display).toEqual({ state: 'ready', rows: [] });
	});

	it('appends the size to both rows when two sets share a name', async () => {
		const twins = [
			{ id: 'set-a', root: 'Imports/Team A/widgets', noteCount: 4 },
			{ id: 'set-b', root: 'Other/widgets', noteCount: 1 },
		];
		const runs = [run({ importSetId: 'set-a' }), run({ importSetId: 'set-b', finishedAt: '2026-02-01T00:00:00.000Z' })];
		const display = await displayRecipeRuns(runs, 'widget-recipe', { settle: async () => 0, discover: async () => twins });
		expect(display.state === 'ready' && display.rows.map((row) => row.setName)).toEqual(['widgets (4 notes)', 'widgets (1 note)']);
		const relative = await displayRecipeRuns(runs, 'widget-recipe', { settle: async () => 0, discover: async () => twins }, 'Imports');
		expect(relative.state === 'ready' && relative.rows.map((row) => row.setName)).toEqual(['Team A/widgets', 'widgets']);
	});

	it('never names a set by its id or a full path', () => {
		expect(runSetDisplayName({ id: 'iset-123', root: 'A/B/Leaf' })).toBe('Leaf');
		expect(runSetDisplayName({ id: 'iset-123', root: 'Imports/Team A/Leaf' }, 'Imports')).toBe('Team A/Leaf');
		expect(runSetDisplayName({ id: 'iset-123', root: 'Elsewhere/Leaf' }, 'Imports')).toBe('Leaf');
		expect(runSetDisplayName({ id: 'iset-123', root: null, ontologyPrefixes: ['qq'] })).toBe('qq');
		expect(runSetDisplayName({ id: 'iset-123', root: null })).toBe('an import set');
	});
});

describe('change detection (R7) and copy', () => {
	it('recipeRunDigest is stable and follows edits', () => {
		const recipe = { recipe: 'widget-recipe', source: { ontology: 'zz', levels: ['leaf'] }, target: { layout: [{ level: 'leaf', mechanism: 'file', template: '{id}.md' }] } };
		const first = recipeRunDigest(recipe as never);
		expect(first).toMatch(/^sha256-[a-f0-9]{64}$/);
		expect(recipeRunDigest(JSON.parse(JSON.stringify(recipe)))).toBe(first);
		const edited = { ...recipe, target: { layout: [{ level: 'leaf', mechanism: 'file', template: '{id}-x.md' }] } };
		expect(recipeRunDigest(edited as never)).not.toBe(first);
		expect(recipeChangedSinceRun(run({ recipeDocumentDigest: first! }), first)).toBe(false);
		expect(recipeChangedSinceRun(run({ recipeDocumentDigest: first! }), recipeRunDigest(edited as never))).toBe(true);
		expect(recipeChangedSinceRun(run(), null)).toBe(false);
	});

	it('compares the source by content, not by name', () => {
		expect(sourceRunStatus(run(), D('b'))).toBe('same');
		expect(sourceRunStatus(run(), D('c'))).toBe('changed');
		expect(sourceRunStatus(run({ source: { name: 'widgets.csv' } }), D('b'))).toBe('unknown');
		expect(sourceRunStatus(run(), undefined)).toBe('unknown');
	});

	it('writes the spec copy without internal words', () => {
		const record = run();
		const date = new Date(record.finishedAt).toLocaleDateString();
		const lines = [
			chooseFileLine(record),
			sourceStatusLine(record, 'same', false)!,
			sourceStatusLine(record, 'same', false, true)!,
			sourceStatusLine(record, 'changed', true, false, 'Widgets')!,
			lastRunLine({ run: record, setName: 'Widgets' }),
			RECIPE_CHANGED_LINE,
			STALE_SET_MESSAGE,
			CHECKING_VAULT_LINE,
			runAgainLeadLine('Widget recipe', 'Widgets', 4, 'replace'),
			refreshingLine('Widgets', 4, true),
			readyToRefreshLine('Widgets', 'replace'),
			STALE_SET_OPTION,
			STALE_SET_NEXT_HINT,
			START_NEW_IMPORT_LABEL,
		];
		expect(lines[0]).toBe('Choose the source file for this run. Last time it was widgets.csv. Crosswalker does not keep a copy of your source.');
		expect(lines[1]).toBe(`This file matches the last run on ${date}. Running again adds nothing new; it only puts back fields this recipe fills if someone edited them.`);
		expect(lines[2]).toBe(`This file matches the last run on ${date}.`);
		expect(lines[3]).toBe(`This file changed since the last run on ${date}. Notes in Widgets will be updated to match it. Any sheet counts, not only the one you import.`);
		expect(sourceStatusLine(record, 'changed', false)).toBe(`This file changed since the last run on ${date}.`);
		expect(sourceStatusLine(record, 'unknown', false)).toBeNull();
		expect(lines[4]).toBe(`Last run ${date} into Widgets`);
		expect(lines[8]).toBe('Running "Widget recipe" again into Widgets (4 notes). Notes it already owns are updated to match the file. New rows become new notes.');
		expect(lines[9]).toBe('Refreshing Widgets (4 notes it already owns). You chose this set with Run again.');
		expect(refreshingLine('Widgets', 1, false)).toBe('Refreshing Widgets (1 note it already owns).');
		expect(lines[10]).toBe('Ready to refresh Widgets. Notes it already owns are updated to match the file. New rows become new notes.');
		expect(notesPhrase(1)).toBe('1 note');
		expect(notesPhrase(0)).toBe('0 notes');
		for (const line of lines) {
			expect(line).not.toMatch(/binding|digest|hash|provenance|import set id|tier|iset-|—/i);
		}
	});

	it('never promises an update the write policy will not make', () => {
		const record = run();
		const date = new Date(record.finishedAt).toLocaleDateString();
		expect(sourceStatusLine(record, 'same', false, false, 'Widgets', 'skip')).toBe(`This file matches the last run on ${date}. Running again will not change your notes.`);
		expect(sourceStatusLine(record, 'same', false, false, 'Widgets', 'error')).toBe(`This file matches the last run on ${date}.`);
		expect(sourceStatusLine(record, 'changed', false, false, 'Widgets', 'skip')).toBe(`This file changed since the last run on ${date}. New rows are added to Widgets; notes it already owns are kept.`);
		expect(runAgainLeadLine('Widget recipe', 'Widgets', undefined, 'skip')).toBe('Running "Widget recipe" again into Widgets. Notes it already owns are kept as they are. New rows become new notes.');
		expect(readyToRefreshLine('Widgets', 'error')).toBe('Ready to refresh Widgets. The run stops if a note it would write already exists.');
		for (const mode of ['skip', 'error'] as const) {
			expect(readyToRefreshLine('Widgets', mode)).not.toMatch(/updated/);
		}
	});
});
