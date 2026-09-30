/**
 * Slice 5 Part A of the mapping table form (2026-09-30): the review model and
 * the review store behind the mapping review view.
 *
 * Synthetic data only: `demo-a:` / `demo-b:` ids, `iset-demo12`.
 */
import type { App } from 'obsidian';
import * as obsidian from 'obsidian';
import { TFile, TFolder } from 'obsidian';
import tier1Schema from '../spec/tier1.schema.json';
import {
	MAPPING_TABLE_FORMAT, REVIEW_STATUSES, assignMappingRowIds, parseMappingTable, serializeMappingTable,
	type MappingTableHeader, type MappingTableRow,
} from '../src/mappings/mapping-table';
import {
	applyEdits, filterRows, reviewRowsOf, sortRows, statusCounts, type ReviewRowView,
} from '../src/mappings/table-review-model';
import { TableReviewStore, unknownStatusMessage, type ReviewSaveStatus } from '../src/mappings/table-review-store';
import { CONVERSION_MARKER_FORMAT, type ConversionMarker, type UnusableConversionMarker } from '../src/mappings/conversion-marker';
import type { MappingTableFile } from '../src/mappings/mapping-table-reader';

const PATH = 'Maps/demo-a-to-demo-b.mapping-table.tsv';

const header: MappingTableHeader = {
	crosswalker_format: MAPPING_TABLE_FORMAT,
	import_set: 'iset-demo12',
	mapping_set_id: 'demo-map',
	crosswalker_provenance: {
		spec_version: 'https://crosswalker.dev/spec/tier1.schema.json',
		source_ref: { file: 'demo-map' },
		produced_at: '2026-09-30T00:00:00.000Z',
		producer: { kind: 'plugin-engine', name: 'crosswalker-plugin', version: '0.0.0-test' },
		import_set: { id: 'iset-demo12', scheme: 'endpoint-v1', mapping_form: 'table' },
	},
};

function rows(): MappingTableRow[] {
	return assignMappingRowIds([
		{ subject_id: 'demo-a:X-1', subject_label: 'Alpha gate', predicate_id: 'is_equivalent_to', object_id: 'demo-b:Y-1', object_label: 'Target one', mapping_justification: 'Manual review', confidence: '0.9', mapping_set_id: 'demo-map' },
		{ subject_id: 'demo-a:X-2', subject_label: 'Beta gate', predicate_id: 'intersects_with', object_id: 'demo-b:Y-2', object_label: 'Target two', confidence: '0.5', review_status: 'approved', reviewer: 'reviewer-1', mapping_set_id: 'demo-map' },
		{ subject_id: 'demo-a:X-3', subject_label: 'Gamma gate', predicate_id: 'subset_of', object_id: 'demo-b:Y-3', object_label: 'Target three', confidence: '0.7', notes: { review_notes: 'Looks right.', crosswalker_notes_extra: 'Kept.' }, mapping_set_id: 'demo-map' },
	], 'demo-map');
}

function tsv(tableRows: MappingTableRow[] = rows()): string {
	return serializeMappingTable(header, tableRows);
}

function idOf(subject: string, tableRows: MappingTableRow[] = rows()): string {
	return tableRows.find((row) => row.subject_id === subject)!.row_id;
}

function tableOf(content: string): MappingTableFile {
	const parsed = parseMappingTable(content);
	return { path: PATH, ...parsed, readable: true };
}

// ---------------------------------------------------------------- model

describe('REVIEW_STATUSES', () => {
	it('is the Tier 1 schema review_status enum', () => {
		const text = JSON.stringify(tier1Schema);
		const match = /"review_status":\{"type":"string","enum":(\[[^\]]*\])\}/.exec(text);
		expect(match).not.toBeNull();
		expect(JSON.parse(match![1])).toEqual([...REVIEW_STATUSES]);
	});
});

describe('reviewRowsOf', () => {
	it('splits review_notes from the other notes keys and maps managed columns', () => {
		const view = reviewRowsOf(tableOf(tsv())).find((row) => row.subject_id === 'demo-a:X-3')!;
		expect(view.review_notes).toBe('Looks right.');
		expect(view.other_notes).toEqual({ crosswalker_notes_extra: 'Kept.' });
		expect(view.object_label).toBe('Target three');
		expect(view.confidence).toBe('0.7');
		expect(view.mapping_set_id).toBe('demo-map');
	});
});

describe('filterRows', () => {
	const views = reviewRowsOf(tableOf(tsv()));

	it('matches a case-insensitive substring over ids, labels and justification', () => {
		expect(filterRows(views, { text: 'BETA' }).map((row) => row.subject_id)).toEqual(['demo-a:X-2']);
		expect(filterRows(views, { text: 'y-3' }).map((row) => row.subject_id)).toEqual(['demo-a:X-3']);
		expect(filterRows(views, { text: 'manual' }).map((row) => row.subject_id)).toEqual(['demo-a:X-1']);
		expect(filterRows(views, { text: '  ' })).toHaveLength(3);
	});

	it('filters by one status, by unset, or by any', () => {
		expect(filterRows(views, { status: 'approved' }).map((row) => row.subject_id)).toEqual(['demo-a:X-2']);
		expect(filterRows(views, { status: 'unset' }).map((row) => row.subject_id).sort()).toEqual(['demo-a:X-1', 'demo-a:X-3']);
		expect(filterRows(views, { status: 'any' })).toHaveLength(3);
		expect(filterRows(views, { text: 'gate', status: 'approved' })).toHaveLength(1);
	});
});

describe('sortRows', () => {
	const view = (row_id: string, extra: Partial<ReviewRowView> = {}): ReviewRowView => ({
		row_id, subject_id: `demo-a:${row_id}`, object_id: 'demo-b:Y', predicate_id: 'subset_of', other_notes: {}, ...extra,
	});

	it('is stable for ties in both directions', () => {
		const input = [view('a', { reviewer: 'r1' }), view('b', { reviewer: 'r1' }), view('c', { reviewer: 'r0' })];
		expect(sortRows(input, 'reviewer', 'asc').map((row) => row.row_id)).toEqual(['c', 'a', 'b']);
		expect(sortRows(input, 'reviewer', 'desc').map((row) => row.row_id)).toEqual(['a', 'b', 'c']);
	});

	it('keeps empty values last in both directions', () => {
		const input = [view('a'), view('b', { review_status: 'proposed' }), view('c', { review_status: 'approved' })];
		expect(sortRows(input, 'review_status', 'asc').map((row) => row.row_id)).toEqual(['c', 'b', 'a']);
		expect(sortRows(input, 'review_status', 'desc').map((row) => row.row_id)).toEqual(['b', 'c', 'a']);
	});

	it('compares confidence as a number', () => {
		const input = [view('a', { confidence: '0.9' }), view('b', { confidence: '10' }), view('c', { confidence: '2' })];
		expect(sortRows(input, 'confidence', 'asc').map((row) => row.row_id)).toEqual(['a', 'c', 'b']);
	});

	it('does not reorder its input', () => {
		const input = [view('b'), view('a')];
		sortRows(input, 'subject', 'asc');
		expect(input.map((row) => row.row_id)).toEqual(['b', 'a']);
	});
});

describe('statusCounts', () => {
	it('counts every status, unset rows, and statuses outside the enum', () => {
		const views = reviewRowsOf(tableOf(tsv()));
		views.push({ ...views[0], row_id: 'x', review_status: 'rejected' });
		expect(statusCounts(views)).toEqual({ proposed: 0, in_review: 0, approved: 1, deprecated: 0, unset: 2, other: 1 });
	});
});

describe('applyEdits', () => {
	it('sets and clears review columns, reports missing ids once, and does not mutate its input', () => {
		const input = rows();
		const snapshot = JSON.stringify(input);
		const result = applyEdits(input, [
			{ row_id: idOf('demo-a:X-1'), review_status: 'in_review', reviewer: 'reviewer-2', review_notes: 'Check scope.' },
			{ row_id: idOf('demo-a:X-2'), review_status: null, reviewer: null },
			{ row_id: idOf('demo-a:X-3'), review_notes: null },
			{ row_id: 'm-missing', reviewer: 'reviewer-2' },
			{ row_id: 'm-missing', reviewer: 'reviewer-3' },
		]);
		expect(JSON.stringify(input)).toBe(snapshot);
		expect(result.applied).toBe(3);
		expect(result.missing).toEqual(['m-missing']);
		const byId = new Map(result.rows.map((row) => [row.row_id, row]));
		expect(byId.get(idOf('demo-a:X-1'))).toMatchObject({ review_status: 'in_review', reviewer: 'reviewer-2', notes: { review_notes: 'Check scope.' } });
		const cleared = byId.get(idOf('demo-a:X-2'))!;
		expect(cleared.review_status).toBeUndefined();
		expect(cleared.reviewer).toBeUndefined();
		expect(cleared.subject_label).toBe('Beta gate');
		expect(byId.get(idOf('demo-a:X-3'))!.notes).toEqual({ crosswalker_notes_extra: 'Kept.' });
	});

	it('removes the notes map when clearing its only key', () => {
		const input = rows().map((row) => row.subject_id === 'demo-a:X-3' ? { ...row, notes: { review_notes: 'Only.' } } : row);
		const result = applyEdits(input, [{ row_id: idOf('demo-a:X-3'), review_notes: '' }]);
		expect(result.rows.find((row) => row.subject_id === 'demo-a:X-3')!.notes).toBeUndefined();
	});
});

// ---------------------------------------------------------------- store

interface MockVault {
	app: App;
	files: Map<string, string>;
	writes: string[];
	/** Replace a file's bytes on the next read-back after a write (a racing writer). */
	corruptNextReadBack: boolean;
}

function mockVault(seed: Record<string, string>): MockVault {
	const files = new Map(Object.entries(seed));
	const folders = new Set<string>(['Maps']);
	const vault: MockVault = { app: undefined as unknown as App, files, writes: [], corruptNextReadBack: false };
	let justWrote = false;
	vault.app = {
		vault: {
			getFiles: () => [...files.keys()].map((path) => new TFile(path)),
			getAbstractFileByPath: (path: string) => {
				if (files.has(path)) return new TFile(path);
				if (folders.has(path)) return new TFolder(path);
				return null;
			},
			createFolder: async (path: string) => { folders.add(path); },
			create: async (path: string, content: string) => { vault.writes.push(path); files.set(path, content); justWrote = true; return new TFile(path); },
			modify: async (file: TFile, content: string) => { vault.writes.push(file.path); files.set(file.path, content); justWrote = true; },
			read: async (file: TFile) => {
				if (!files.has(file.path)) throw new Error('missing');
				const content = files.get(file.path)!;
				if (justWrote && vault.corruptNextReadBack) {
					justWrote = false;
					vault.corruptNextReadBack = false;
					return content.slice(0, 10);
				}
				justWrote = false;
				return content;
			},
		},
	} as unknown as App;
	return vault;
}

function marker(setId = 'iset-demo12'): ConversionMarker {
	return {
		format: CONVERSION_MARKER_FORMAT, import_set: setId, from: 'table', to: 'notes', phase: 'writing',
		target_path: 'Maps', source_count: 3, started_at: '2026-09-30T00:00:00.000Z', plugin_version: '0.0.0-test',
		path: `Maps/${setId}.converting.json`,
	};
}

function makeStore(vault: MockVault, options: { markers?: ConversionMarker[]; unusable?: UnusableConversionMarker[] } = {}) {
	const projected: string[] = [];
	const statuses: Array<[ReviewSaveStatus, string | undefined]> = [];
	const markers = options.markers ?? [];
	const unusable = options.unusable ?? [];
	const scan = { fail: false };
	const store = new TableReviewStore(vault.app, {
		project: async (path) => { projected.push(path); },
		markers: async () => {
			if (scan.fail) throw new Error('scan failed');
			return { markers, unusable };
		},
	}, PATH);
	store.onStatus((status, message) => statuses.push([status, message]));
	return { store, projected, statuses, markers, unusable, scan };
}

function unusableMarker(setIds = ['iset-demo12']): UnusableConversionMarker {
	return { path: 'Maps/iset-demo12.converting.json', error: 'Conversion marker Maps/iset-demo12.converting.json has an unknown phase.', setIds };
}

/** The synthetic table with its third row made unreadable (empty subject_id). */
function brokenTsv(): string {
	const good = tsv();
	const broken = good.replace('\tdemo-a:X-3\t', '\t\t');
	expect(broken).not.toBe(good);
	return broken;
}

function savedRows(vault: MockVault): Map<string, MappingTableRow> {
	const parsed = parseMappingTable(vault.files.get(PATH)!);
	expect(parsed.errors).toEqual([]);
	return new Map(parsed.rows.map((row) => [row.subject_id, row]));
}

describe('TableReviewStore', () => {
	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
	});

	it('loads an editable table', async () => {
		const vault = mockVault({ [PATH]: tsv() });
		const { store } = makeStore(vault);
		const loaded = await store.load();
		expect(loaded.readOnly).toBeUndefined();
		expect(loaded.table.rows).toHaveLength(3);
	});

	it('coalesces edits by row_id and saves once after the pause', async () => {
		jest.useFakeTimers();
		const vault = mockVault({ [PATH]: tsv() });
		const { store, statuses } = makeStore(vault);
		await store.load();
		store.queueEdit({ row_id: idOf('demo-a:X-1'), review_status: 'proposed' });
		await jest.advanceTimersByTimeAsync(400);
		store.queueEdit({ row_id: idOf('demo-a:X-1'), reviewer: 'reviewer-2' });
		store.queueEdit({ row_id: idOf('demo-a:X-1'), review_status: 'approved' });
		expect(store.pendingCount()).toBe(1);
		await jest.advanceTimersByTimeAsync(599);
		expect(vault.writes).toEqual([]);
		await jest.advanceTimersByTimeAsync(1);
		await store.flush();
		expect(vault.writes).toEqual([PATH]);
		expect(savedRows(vault).get('demo-a:X-1')).toMatchObject({ review_status: 'approved', reviewer: 'reviewer-2' });
		expect(statuses[statuses.length - 1]).toEqual(['saved', undefined]);
	});

	it('flush writes through the writer, verifies, and re-projects the one table after 2 s', async () => {
		jest.useFakeTimers();
		const vault = mockVault({ [PATH]: tsv() });
		const { store, projected } = makeStore(vault);
		await store.load();
		store.queueEdit({ row_id: idOf('demo-a:X-2'), review_status: null, review_notes: 'Recheck.' });
		const result = await store.flush();
		expect(result).toMatchObject({ outcome: 'saved', applied: 1, dropped: [], reloaded: false });
		const saved = savedRows(vault).get('demo-a:X-2')!;
		expect(saved.review_status).toBeUndefined();
		expect(saved.reviewer).toBe('reviewer-1');
		expect(saved.notes).toEqual({ review_notes: 'Recheck.' });
		// Unchanged rows keep their bytes: the file differs only in the edited row.
		expect(vault.files.get(PATH)).toBe(tsv(applyEdits(rows(), [{ row_id: idOf('demo-a:X-2'), review_status: null, review_notes: 'Recheck.' }]).rows));
		// Idempotent: a second flush has nothing to do.
		expect((await store.flush()).outcome).toBe('nothing');
		expect(vault.writes).toHaveLength(1);
		expect(projected).toEqual([]);
		await jest.advanceTimersByTimeAsync(2000);
		expect(projected).toEqual([PATH]);
	});

	it('runs one save when flush is called twice at once', async () => {
		const vault = mockVault({ [PATH]: tsv() });
		const { store } = makeStore(vault);
		await store.load();
		store.queueEdit({ row_id: idOf('demo-a:X-1'), reviewer: 'reviewer-2' });
		const [first, second] = await Promise.all([store.flush(), store.flush()]);
		expect(first.outcome).toBe('saved');
		expect(second.outcome).toBe('nothing');
		expect(vault.writes).toHaveLength(1);
	});

	it('reapplies edits onto a file whose managed columns changed underneath', async () => {
		const vault = mockVault({ [PATH]: tsv() });
		const { store } = makeStore(vault);
		await store.load();
		// Another writer relabels a row the user did not touch and reviews a third.
		const external = rows().map((row) => row.subject_id === 'demo-a:X-3'
			? { ...row, object_label: 'Target three renamed', reviewer: 'reviewer-9' }
			: row);
		vault.files.set(PATH, tsv(external));
		store.queueEdit({ row_id: idOf('demo-a:X-1'), review_status: 'deprecated' });
		const result = await store.flush();
		expect(result).toMatchObject({ outcome: 'saved', applied: 1, reloaded: true });
		const saved = savedRows(vault);
		expect(saved.get('demo-a:X-1')!.review_status).toBe('deprecated');
		expect(saved.get('demo-a:X-3')).toMatchObject({ object_label: 'Target three renamed', reviewer: 'reviewer-9' });
		expect(store.current()!.rows.find((row) => row.subject_id === 'demo-a:X-3')!.object_label).toBe('Target three renamed');
	});

	it('drops an edit whose row left the file, with a notice naming the count', async () => {
		const notice = jest.spyOn(obsidian, 'Notice').mockImplementation(() => ({}) as never);
		const vault = mockVault({ [PATH]: tsv() });
		const { store } = makeStore(vault);
		await store.load();
		const gone = idOf('demo-a:X-1');
		vault.files.set(PATH, tsv(rows().filter((row) => row.row_id !== gone)));
		store.queueEdit({ row_id: gone, reviewer: 'reviewer-2' });
		store.queueEdit({ row_id: idOf('demo-a:X-2'), reviewer: 'reviewer-3' });
		const result = await store.flush();
		expect(result).toMatchObject({ outcome: 'saved', applied: 1, dropped: [gone], reloaded: true });
		expect(notice).toHaveBeenCalledTimes(1);
		expect(String(notice.mock.calls[0][0])).toMatch(/^Dropped edits for 1 mapping that is no longer in the table\./);
		expect(savedRows(vault).get('demo-a:X-2')!.reviewer).toBe('reviewer-3');
		expect(savedRows(vault).has('demo-a:X-1')).toBe(false);
	});

	it('is read-only while a conversion marker names the set', async () => {
		const vault = mockVault({ [PATH]: tsv() });
		const { store } = makeStore(vault, { markers: [marker()] });
		const loaded = await store.load();
		expect(loaded.readOnly?.reason).toMatch(/Import set iset-demo12 is being converted/);
		expect(loaded.readOnly?.action).toMatch(/Finish or cancel the conversion/);
		expect(() => store.queueEdit({ row_id: idOf('demo-a:X-1'), reviewer: 'reviewer-2' })).toThrow(/being converted/);
	});

	it('ignores a marker for a different set', async () => {
		const vault = mockVault({ [PATH]: tsv() });
		const { store } = makeStore(vault, { markers: [marker('iset-other1')] });
		expect((await store.load()).readOnly).toBeUndefined();
	});

	it('refuses to save when a conversion starts after load, and keeps the edits', async () => {
		const vault = mockVault({ [PATH]: tsv() });
		const { store, markers, statuses } = makeStore(vault);
		await store.load();
		store.queueEdit({ row_id: idOf('demo-a:X-1'), reviewer: 'reviewer-2' });
		markers.push(marker());
		const before = vault.files.get(PATH);
		const result = await store.flush();
		expect(result.outcome).toBe('refused');
		expect(vault.files.get(PATH)).toBe(before);
		expect(store.pendingCount()).toBe(1);
		expect(statuses[statuses.length - 1]![0]).toBe('error');
		expect(statuses[statuses.length - 1]![1]).toMatch(/Your edits are kept/);
	});

	it('is read-only when the table has structural errors', async () => {
		const vault = mockVault({ [PATH]: 'subject_id\tobject_id\ndemo-a:X-1\tdemo-b:Y-1\n' });
		const { store } = makeStore(vault);
		const loaded = await store.load();
		expect(loaded.readOnly?.reason).toMatch(/not a Crosswalker mapping table/);
		expect(loaded.table.rows).toEqual([]);
	});

	it('is read-only when the file is missing', async () => {
		const vault = mockVault({});
		const { store } = makeStore(vault);
		const loaded = await store.load();
		expect(loaded.readOnly?.reason).toMatch(/no longer exists/);
	});

	it('is read-only when the table has row errors, since any save would delete the unreadable rows', async () => {
		const broken = brokenTsv();
		const vault = mockVault({ [PATH]: broken });
		const { store } = makeStore(vault);
		const loaded = await store.load();
		expect(loaded.table.rowErrors).toHaveLength(1);
		expect(loaded.table.rows).toHaveLength(2);
		expect(loaded.readOnly?.reason).toMatch(/^1 row in this table could not be read, and saving would remove it/);
		expect(loaded.readOnly?.action).toMatch(/Fix that row in the file/);
		expect(() => store.queueEdit({ row_id: idOf('demo-a:X-1'), reviewer: 'reviewer-2' })).toThrow(/could not be read/);
		expect(store.pendingCount()).toBe(0);
		expect(vault.files.get(PATH)).toBe(broken);
	});

	it('refuses a save when row errors appear after load, keeps the edits, and saves them on reopen once fixed', async () => {
		jest.useFakeTimers();
		const good = tsv();
		const vault = mockVault({ [PATH]: good });
		const { store } = makeStore(vault);
		await store.load();
		store.queueEdit({ row_id: idOf('demo-a:X-1'), reviewer: 'reviewer-2' });
		vault.files.set(PATH, brokenTsv());
		const refused = await store.flush();
		expect(refused.outcome).toBe('refused');
		expect(refused.message).toMatch(/1 row in this table could not be read/);
		expect(store.pendingCount()).toBe(1);
		// No new edit is accepted while the save cannot go through.
		expect(() => store.queueEdit({ row_id: idOf('demo-a:X-2'), reviewer: 'reviewer-3' })).toThrow(/could not be read/);
		vault.files.set(PATH, good);
		expect((await store.load()).readOnly).toBeUndefined();
		await jest.advanceTimersByTimeAsync(600);
		await store.flush();
		expect(savedRows(vault).get('demo-a:X-1')!.reviewer).toBe('reviewer-2');
		expect(savedRows(vault).size).toBe(3);
	});

	it('is read-only when an unusable marker file may name the set', async () => {
		const vault = mockVault({ [PATH]: tsv() });
		const { store } = makeStore(vault, { unusable: [unusableMarker()] });
		const loaded = await store.load();
		expect(loaded.readOnly?.reason).toMatch(/Conversion marker Maps\/iset-demo12\.converting\.json could not be read/);
		expect(loaded.readOnly?.action).toMatch(/Fix or delete that marker file, then reopen this table/);
		expect(() => store.queueEdit({ row_id: idOf('demo-a:X-1'), reviewer: 'reviewer-2' })).toThrow(/could not be read/);
	});

	it('refuses a save when an unusable marker for the set appears after load', async () => {
		const vault = mockVault({ [PATH]: tsv() });
		const { store, unusable } = makeStore(vault);
		await store.load();
		store.queueEdit({ row_id: idOf('demo-a:X-1'), reviewer: 'reviewer-2' });
		unusable.push(unusableMarker());
		const before = vault.files.get(PATH);
		const result = await store.flush();
		expect(result.outcome).toBe('refused');
		expect(vault.files.get(PATH)).toBe(before);
		expect(store.pendingCount()).toBe(1);
	});

	it('ignores an unusable marker that names a different set', async () => {
		const vault = mockVault({ [PATH]: tsv() });
		const { store } = makeStore(vault, { unusable: [unusableMarker(['iset-other1'])] });
		expect((await store.load()).readOnly).toBeUndefined();
	});

	it('fails closed when the marker scan fails, naming that cause instead of a file lock', async () => {
		const vault = mockVault({ [PATH]: tsv() });
		const { store, scan } = makeStore(vault);
		scan.fail = true;
		const loaded = await store.load();
		expect(loaded.readOnly).toEqual({ reason: 'Could not check whether this set is being converted.', action: 'Reopen this table to try again.' });
		scan.fail = false;
		expect((await store.load()).readOnly).toBeUndefined();
		store.queueEdit({ row_id: idOf('demo-a:X-1'), reviewer: 'reviewer-2' });
		scan.fail = true;
		const result = await store.flush();
		expect(result.outcome).toBe('refused');
		expect(result.message).toMatch(/Could not check whether this set is being converted/);
		expect(result.message).not.toMatch(/another program/);
		expect(store.pendingCount()).toBe(1);
	});

	it('clears a refusal on reopen and saves the kept edits once the conversion is gone', async () => {
		jest.useFakeTimers();
		const vault = mockVault({ [PATH]: tsv() });
		const { store, markers } = makeStore(vault);
		await store.load();
		store.queueEdit({ row_id: idOf('demo-a:X-1'), reviewer: 'reviewer-2' });
		markers.push(marker());
		expect((await store.flush()).outcome).toBe('refused');
		expect(() => store.queueEdit({ row_id: idOf('demo-a:X-2'), reviewer: 'reviewer-3' })).toThrow(/being converted/);
		// The conversion is cancelled and the view reopens the table.
		markers.length = 0;
		expect((await store.load()).readOnly).toBeUndefined();
		store.queueEdit({ row_id: idOf('demo-a:X-2'), reviewer: 'reviewer-3' });
		await jest.advanceTimersByTimeAsync(600);
		await store.flush();
		expect(savedRows(vault).get('demo-a:X-1')!.reviewer).toBe('reviewer-2');
		expect(savedRows(vault).get('demo-a:X-2')!.reviewer).toBe('reviewer-3');
	});

	it('tells onReload listeners when a debounced save found the file changed underneath', async () => {
		jest.useFakeTimers();
		const vault = mockVault({ [PATH]: tsv() });
		const { store } = makeStore(vault);
		const reloads: MappingTableFile[] = [];
		store.onReload((table) => reloads.push(table));
		await store.load();
		const gone = idOf('demo-a:X-3');
		vault.files.set(PATH, tsv(rows().filter((row) => row.row_id !== gone)));
		store.queueEdit({ row_id: idOf('demo-a:X-1'), reviewer: 'reviewer-2' });
		await jest.advanceTimersByTimeAsync(600);
		await store.flush();
		expect(reloads).toHaveLength(1);
		expect(reloads[0].rows.map((row) => row.subject_id).sort()).toEqual(['demo-a:X-1', 'demo-a:X-2']);
		// A save onto an unchanged file does not announce a reload.
		store.queueEdit({ row_id: idOf('demo-a:X-1'), reviewer: 'reviewer-4' });
		await store.flush();
		expect(reloads).toHaveLength(1);
	});

	it('reports a failed verification and keeps the edits for the next save', async () => {
		const vault = mockVault({ [PATH]: tsv() });
		const { store, statuses } = makeStore(vault);
		await store.load();
		store.queueEdit({ row_id: idOf('demo-a:X-1'), reviewer: 'reviewer-2' });
		vault.corruptNextReadBack = true;
		const failed = await store.flush();
		expect(failed.outcome).toBe('error');
		expect(failed.message).toMatch(/^Could not verify the mapping table after writing .* Your edits are kept/);
		expect(statuses[statuses.length - 1]![0]).toBe('error');
		expect(store.pendingCount()).toBe(1);
		const retried = await store.flush();
		expect(retried.outcome).toBe('saved');
		expect(savedRows(vault).get('demo-a:X-1')!.reviewer).toBe('reviewer-2');
	});

	it('refuses a status outside the schema enum', async () => {
		const vault = mockVault({ [PATH]: tsv() });
		const { store } = makeStore(vault);
		await store.load();
		const listed = `${REVIEW_STATUSES.slice(0, -1).join(', ')} or ${REVIEW_STATUSES[REVIEW_STATUSES.length - 1]}`;
		expect(unknownStatusMessage('rejected')).toBe(`Review status "rejected" is not one Crosswalker can store. Choose ${listed}.`);
		expect(() => store.queueEdit({ row_id: idOf('demo-a:X-1'), review_status: 'rejected' })).toThrow(unknownStatusMessage('rejected'));
		expect(store.pendingCount()).toBe(0);
	});

	it('dispose saves pending edits, runs the waiting re-projection, and cancels the timers', async () => {
		jest.useFakeTimers();
		const vault = mockVault({ [PATH]: tsv() });
		const { store, projected } = makeStore(vault);
		await store.load();
		store.queueEdit({ row_id: idOf('demo-a:X-1'), reviewer: 'reviewer-2' });
		const result = await store.dispose();
		expect(result.outcome).toBe('saved');
		expect(savedRows(vault).get('demo-a:X-1')!.reviewer).toBe('reviewer-2');
		expect(projected).toEqual([PATH]);
		expect(jest.getTimerCount()).toBe(0);
		expect(() => store.queueEdit({ row_id: idOf('demo-a:X-1'), reviewer: 'reviewer-3' })).toThrow(/closed/);
		await jest.advanceTimersByTimeAsync(5000);
		expect(vault.writes).toHaveLength(1);
		expect(projected).toEqual([PATH]);
	});

	it('dispose returns and announces edits it could not save instead of dropping them', async () => {
		const notice = jest.spyOn(obsidian, 'Notice').mockImplementation(() => ({}) as never);
		jest.useFakeTimers();
		const vault = mockVault({ [PATH]: tsv() });
		const { store, markers } = makeStore(vault);
		await store.load();
		store.queueEdit({ row_id: idOf('demo-a:X-1'), reviewer: 'reviewer-2' });
		markers.push(marker());
		const result = await store.dispose();
		expect(result.outcome).toBe('refused');
		expect(result.unsaved).toEqual([{ row_id: idOf('demo-a:X-1'), reviewer: 'reviewer-2' }]);
		expect(notice).toHaveBeenCalledTimes(1);
		const text = String(notice.mock.calls[0][0]);
		expect(text).toMatch(/^Closed the mapping review with 1 unsaved edit\. Import set iset-demo12 is being converted/);
		expect(text).toMatch(/Make that edit again after reopening\.$/);
		expect(text).not.toMatch(/kept/);
		expect(jest.getTimerCount()).toBe(0);
	});

	it('rejects an edit queued while dispose is saving, so none is left pending', async () => {
		const vault = mockVault({ [PATH]: tsv() });
		const { store } = makeStore(vault);
		await store.load();
		store.queueEdit({ row_id: idOf('demo-a:X-1'), reviewer: 'reviewer-2' });
		const closing = store.dispose();
		expect(() => store.queueEdit({ row_id: idOf('demo-a:X-2'), reviewer: 'reviewer-3' })).toThrow(/closed/);
		const result = await closing;
		expect(result.outcome).toBe('saved');
		expect(result.unsaved).toEqual([]);
		expect(store.pendingCount()).toBe(0);
		expect(savedRows(vault).get('demo-a:X-2')!.reviewer).toBe('reviewer-1');
	});
});
