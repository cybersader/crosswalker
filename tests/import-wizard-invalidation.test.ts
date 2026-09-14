/**
 * import-wizard-invalidation.test.ts — Step-1 parse-cache invalidation.
 *
 * The defect (owner, real CRI Profile v2.2 import): `validateCurrentStep` case 1
 * re-parses only when `parsedData` is null, Back never cleared it, and the Step-1
 * sheet / header-row / JSON-record controls only assigned their field. So editing
 * `xlsxHeaderRow` after Back and clicking Next silently advanced with the stale
 * Step-1 parse (header row 0, wrong columns, `__EMPTY*` names, no recognition) —
 * a hole in cache invalidation.
 *
 * These assertions sit on the seam that broke: the setters the controls call
 * (`selectSheet`, `setHeaderRow`, `setJsonIterator`) and `validateCurrentStep`'s
 * parse gate. Rendering Step 1 is not needed to prove either, and would prove
 * less: the state is what the Next gate reads.
 */

import { ImportFlow } from '../src/import/import-wizard';
import { DEFAULT_SETTINGS } from '../src/settings/settings-data';
import type { ColumnInfo, ParsedData } from '../src/types/config';

type FlowApp = ConstructorParameters<typeof ImportFlow>[0];
type FlowPlugin = ConstructorParameters<typeof ImportFlow>[1];

/** The private parse-derived fields these tests assert on. */
interface FlowInternals {
	recognizedMatch: unknown;
	recognizedDismissed: boolean;
	recognizedFastPath: boolean;
	recognizedEdited: boolean;
	workbench: unknown;
	curatedDestination: string | null;
}

function makeFlow(): ImportFlow {
	const plugin = {
		settings: { ...DEFAULT_SETTINGS },
		debug: { info() {}, trace() {}, warn() {}, error() {} },
	} as unknown as FlowPlugin;
	return new ImportFlow({} as unknown as FlowApp, plugin, {
		containerEl: document.createElement('div'),
		close: () => {},
	});
}

function parsedFixture(columns: string[]): ParsedData {
	return { columns, rows: columns.length ? [{ [columns[0]]: 'v' }] : [], rowCount: 1 };
}

function columnFixture(columns: string[]): ColumnInfo[] {
	return columns.map((name) => ({
		name,
		sampleValues: ['v'],
		detectedType: 'string',
		hasEmptyValues: false,
		uniqueCount: 1,
	}));
}

/**
 * The state after a successful Step-1 parse of an XLSX sheet, the way the real
 * flow leaves it: parsed rows, analyzed columns, a recognition verdict, role
 * suggestions, and a workbench built over those columns.
 */
function seedParsedState(flow: ImportFlow, columns = ['id', 'title']): void {
	flow.sourceFile = { name: 'source.xlsx', size: 1024 } as unknown as File;
	flow.sourceType = 'xlsx';
	flow.availableSheets = ['Cover', 'Structure'];
	flow.selectedSheet = 'Cover';
	flow.parsedData = parsedFixture(columns);
	flow.columnInfos = columnFixture(columns);
	flow.suggestedColumns = new Set([columns[0]]);
	flow.smartDefaultsApplied = true;
	flow.configMatches = [{ config: { name: 'saved' }, score: 90 }] as unknown as typeof flow.configMatches;
	flow.configWarnings = ['stale warning'];
	const internals = flow as unknown as FlowInternals;
	internals.recognizedMatch = { entry: { id: 'cri' }, score: 96 };
	internals.recognizedDismissed = true;
	internals.recognizedFastPath = true;
	internals.recognizedEdited = true;
	internals.workbench = { columnsSignature: () => columns.join('|') };
	internals.curatedDestination = 'Frameworks/CRI Profile';
}

/** Every field `invalidateParse` is required to clear. */
function expectInvalidated(flow: ImportFlow): void {
	const internals = flow as unknown as FlowInternals;
	expect(flow.parsedData).toBeNull();
	expect(flow.columnInfos).toEqual([]);
	expect(internals.recognizedMatch).toBeNull();
	expect(internals.recognizedDismissed).toBe(false);
	expect(internals.recognizedFastPath).toBe(false);
	expect(internals.recognizedEdited).toBe(false);
	expect(flow.configMatches).toEqual([]);
	expect(flow.configWarnings).toEqual([]);
	expect(flow.suggestedColumns.size).toBe(0);
	expect(flow.smartDefaultsApplied).toBe(false);
	expect(internals.workbench).toBeNull();
	expect(internals.curatedDestination).toBeNull();
}

/**
 * Stand in for the real parse: records the header row / sheet / iterator it was
 * called with and installs a parse result, exactly as `doParseSourceFile` does.
 */
function stubParse(flow: ImportFlow, columns: string[]): jest.SpyInstance {
	return jest.spyOn(flow, 'parseSourceFile').mockImplementation(async () => {
		flow.parsedData = parsedFixture(columns);
		flow.columnInfos = columnFixture(columns);
		return true;
	});
}

describe('Step-1 parse invalidation', () => {
	// A1
	it('drops the parse and everything derived from it when the header row changes', () => {
		const flow = makeFlow();
		seedParsedState(flow);

		flow.setHeaderRow('2');

		expect(flow.xlsxHeaderRow).toBe(2);
		expectInvalidated(flow);
	});

	// A1
	it('re-parses on Next after the header row changed', async () => {
		const flow = makeFlow();
		seedParsedState(flow, ['banner', '__EMPTY']);
		const parse = stubParse(flow, ['col_one', 'col_two']);

		flow.setHeaderRow('2');
		const advanced = await flow.validateCurrentStep();

		expect(parse).toHaveBeenCalledTimes(1);
		expect(advanced).toBe(true);
		expect(flow.parsedData?.columns).toEqual(['col_one', 'col_two']);
	});

	// A2
	it('drops the parse when the sheet changes', () => {
		const flow = makeFlow();
		seedParsedState(flow);

		flow.selectSheet('Structure');

		expect(flow.selectedSheet).toBe('Structure');
		expectInvalidated(flow);
	});

	// A2
	it('re-parses on Next after the sheet changed', async () => {
		const flow = makeFlow();
		seedParsedState(flow);
		const parse = stubParse(flow, ['col_one', 'col_two']);

		flow.selectSheet('Structure');
		await flow.validateCurrentStep();

		expect(parse).toHaveBeenCalledTimes(1);
	});

	// A2: the other half of the contract. Invalidation is keyed to the inputs
	// that make the parse stale, so an untouched Step 1 must still be a cache.
	it('does not re-parse on Next when nothing changed', async () => {
		const flow = makeFlow();
		seedParsedState(flow);
		const parse = stubParse(flow, ['other']);

		const advanced = await flow.validateCurrentStep();

		expect(parse).not.toHaveBeenCalled();
		expect(advanced).toBe(true);
		expect(flow.parsedData?.columns).toEqual(['id', 'title']);
	});

	it('does not invalidate when a control fires with the value it already had', () => {
		const flow = makeFlow();
		seedParsedState(flow);

		flow.setHeaderRow('0');
		flow.selectSheet('Cover');

		expect(flow.parsedData).not.toBeNull();
		expect(flow.columnInfos).toHaveLength(2);
	});

	it('reads a non-numeric header row as row 0 rather than NaN', () => {
		const flow = makeFlow();
		seedParsedState(flow);
		flow.setHeaderRow('3');

		flow.setHeaderRow('');

		expect(flow.xlsxHeaderRow).toBe(0);
	});

	it('floors a negative header row at 0', () => {
		const flow = makeFlow();
		seedParsedState(flow);

		flow.setHeaderRow('-4');

		expect(flow.xlsxHeaderRow).toBe(0);
	});

	// Same hole, JSON shape: the iterator is what `parseJSONFile` reads.
	it('drops the parse when the JSON record list changes, and re-parses on Next', async () => {
		const flow = makeFlow();
		seedParsedState(flow);
		flow.sourceType = 'json';
		const parse = stubParse(flow, ['ref', 'text']);

		flow.setJsonIterator('$.objects[*]');
		expectInvalidated(flow);
		await flow.validateCurrentStep();

		expect(flow.jsonIterator).toBe('$.objects[*]');
		expect(parse).toHaveBeenCalledTimes(1);
	});

	// The row filter is `source.where` and runs at generation, so it is not a
	// parse input and must not throw away a good parse.
	it('keeps the parse when only the record filter changes', () => {
		const flow = makeFlow();
		seedParsedState(flow);

		flow.jsonWhere = 'status=active';

		expect(flow.parsedData).not.toBeNull();
	});

	// The user's column decisions survive: both consumers reconcile against the
	// new columns (Step 2 seeds per `columnInfos`; `buildConfigFromWizardState`
	// iterates the parsed columns and skips configs without one).
	it('keeps the source file, its inputs, and the user column decisions', () => {
		const flow = makeFlow();
		seedParsedState(flow);
		flow.columnConfigs.set('id', { useAs: 'title', outputKey: 'id' });
		flow.presetRecipeId = 'cri';

		flow.setHeaderRow('2');

		expect(flow.sourceFile).not.toBeNull();
		expect(flow.sourceType).toBe('xlsx');
		expect(flow.availableSheets).toEqual(['Cover', 'Structure']);
		expect(flow.selectedSheet).toBe('Cover');
		expect(flow.xlsxHeaderRow).toBe(2);
		expect(flow.columnConfigs.get('id')).toEqual({ useAs: 'title', outputKey: 'id' });
		expect(flow.presetRecipeId).toBe('cri');
	});
});
