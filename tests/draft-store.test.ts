/**
 * draft-store.test.ts — Phase 3.6a unit tests for the wizard draft store.
 *
 * Mocks the vault adapter with an in-memory file map. Verifies the
 * round-trip, expiry filter, max-drafts cap, schema-version gate, and
 * Map↔Record serialization helpers.
 */

import {
	DraftStore,
	DRAFT_SCHEMA_VERSION,
	autoDraftName,
	columnConfigsToDict,
	dictToColumnConfigs,
	newDraftId,
	resolveDraftSource,
	type WizardDraft,
} from '../src/import/draft-store';
import type { ImportMapping } from '../src/import/mapping/types';
import type { DebugLog } from '../src/utils/debug';
import { TFile, TFolder } from 'obsidian';

// ---------------------------------------------------------------------------
// Mock vault — in-memory file tree
// ---------------------------------------------------------------------------

interface MockFile {
	path: string;
	content: string;
}

function createMockApp() {
	const files: Map<string, MockFile> = new Map();
	const folders: Set<string> = new Set();

	const getAbstract = (path: string): TFile | TFolder | null => {
		if (folders.has(path)) {
			const f = Object.create(TFolder.prototype);
			f.path = path;
			f.children = [];
			for (const file of files.values()) {
				if (file.path.startsWith(`${path}/`) && !file.path.slice(path.length + 1).includes('/')) {
					const childTFile = Object.create(TFile.prototype);
					childTFile.path = file.path;
					childTFile.name = file.path.split('/').pop();
					childTFile.stat = { size: file.content.length };
					f.children.push(childTFile);
				}
			}
			return f as TFolder;
		}
		const file = files.get(path);
		if (file) {
			const f = Object.create(TFile.prototype);
			f.path = file.path;
			f.name = file.path.split('/').pop();
			f.stat = { size: file.content.length };
			return f as TFile;
		}
		return null;
	};

	return {
		state: { files, folders },
		app: {
			vault: {
				getAbstractFileByPath: jest.fn(getAbstract),
				createFolder: jest.fn(async (path: string) => {
					folders.add(path);
				}),
				create: jest.fn(async (path: string, content: string) => {
					files.set(path, { path, content });
				}),
				modify: jest.fn(async (file: TFile, content: string) => {
					files.set(file.path, { path: file.path, content });
				}),
				read: jest.fn(async (file: TFile) => {
					return files.get(file.path)?.content ?? '';
				}),
				delete: jest.fn(async (file: TFile) => {
					files.delete(file.path);
				}),
			},
		} as never,
	};
}

const mockDebug: DebugLog = {
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	trace: jest.fn(),
} as never;

/** ISO timestamp n days before now — keeps expiry-window tests calendar-proof. */
function daysAgo(n: number): string {
	return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function buildDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
	const now = new Date().toISOString();
	return {
		schemaVersion: DRAFT_SCHEMA_VERSION,
		id: newDraftId(),
		name: 'test draft',
		createdAt: now,
		updatedAt: now,
		currentStep: 2,
		sourceFile: { name: 'test.csv', vaultPath: null },
		sourceType: 'csv',
		selectedSheet: null,
		columnInfos: [],
		columnConfigsDict: {},
		config: {},
		outputPath: 'Frameworks',
		overwriteMode: 'skip',
		frameworkId: '',
		appliedConfigId: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DraftStore — save + list round-trip', () => {
	it('persists a draft and lists it back with all fields preserved', async () => {
		const { app } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		const draft = buildDraft({
			columnConfigsDict: { 'Control ID': { useAs: 'hierarchy', outputKey: 'control_id' } },
			outputPath: 'Frameworks/NIST',
		});
		await store.save(draft);
		const list = await store.list();
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe(draft.id);
		expect(list[0].outputPath).toBe('Frameworks/NIST');
		expect(list[0].columnConfigsDict['Control ID'].useAs).toBe('hierarchy');
	});

	it('still lists an older draft literal without xlsxHeaderRow', async () => {
		const { app } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		const oldDraft = buildDraft({ sourceType: 'xlsx', selectedSheet: 'Profile' });
		expect(oldDraft).not.toHaveProperty('xlsxHeaderRow');

		await store.save(oldDraft);

		const list = await store.list();
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe(oldDraft.id);
		expect(list[0]).not.toHaveProperty('xlsxHeaderRow');
	});

	it('save() with same ID overwrites existing draft (idempotent)', async () => {
		const { app } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		const draft = buildDraft({ currentStep: 1 });
		await store.save(draft);
		await store.save({ ...draft, currentStep: 3, updatedAt: new Date().toISOString() });
		const list = await store.list();
		expect(list).toHaveLength(1);
		expect(list[0].currentStep).toBe(3);
	});

	it('load(id) returns the draft for an existing ID', async () => {
		const { app } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		const draft = buildDraft();
		await store.save(draft);
		const loaded = await store.load(draft.id);
		expect(loaded).not.toBeNull();
		expect(loaded!.id).toBe(draft.id);
	});

	it('load(id) returns null for a missing ID without throwing', async () => {
		const { app } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		const loaded = await store.load('nonexistent');
		expect(loaded).toBeNull();
	});

	it('list() sorts drafts newest-first', async () => {
		const { app } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		// Relative dates — fixed timestamps rot past the 30-day expiry window
		// as the calendar advances and start getting filtered by list().
		const older = buildDraft({ updatedAt: daysAgo(5), id: newDraftId() });
		const newer = buildDraft({ updatedAt: daysAgo(1), id: newDraftId() });
		await store.save(older);
		await store.save(newer);
		const list = await store.list();
		expect(list[0].id).toBe(newer.id);
		expect(list[1].id).toBe(older.id);
	});
});

describe('DraftStore — expiry', () => {
	it('list() filters drafts older than draftExpiryDays', async () => {
		const { app } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		const old = buildDraft({
			id: newDraftId(),
			updatedAt: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString(),
		});
		const fresh = buildDraft({ id: newDraftId(), updatedAt: new Date().toISOString() });
		await store.save(old);
		await store.save(fresh);
		const list = await store.list();
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe(fresh.id);
	});

	it('draftExpiryDays=0 disables expiry (never expires)', async () => {
		const { app } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 0, maxDrafts: 20 });
		const ancient = buildDraft({
			id: newDraftId(),
			updatedAt: '2020-01-01T00:00:00.000Z',
		});
		await store.save(ancient);
		const list = await store.list();
		expect(list).toHaveLength(1);
	});

	it('purgeExpired() removes expired drafts from disk and returns count', async () => {
		const { app, state } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		const old = buildDraft({
			id: newDraftId(),
			updatedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
		});
		const fresh = buildDraft({ id: newDraftId(), updatedAt: new Date().toISOString() });
		await store.save(old);
		await store.save(fresh);
		const purged = await store.purgeExpired();
		expect(purged).toBe(1);
		expect(state.files.size).toBe(1);
	});
});

describe('DraftStore — max-drafts cap', () => {
	it('enforces maxDrafts on save() by deleting oldest', async () => {
		const { app } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 2 });
		// Relative dates — see the sort test above for why fixed dates rot.
		const oldestAt = daysAgo(6);
		const middleAt = daysAgo(5);
		const newestAt = daysAgo(1);
		await store.save(buildDraft({ id: newDraftId(), updatedAt: oldestAt }));
		await store.save(buildDraft({ id: newDraftId(), updatedAt: middleAt }));
		const newest = buildDraft({ id: newDraftId(), updatedAt: newestAt });
		await store.save(newest);
		const list = await store.list();
		expect(list).toHaveLength(2);
		// Oldest should have been deleted; newest 2 kept
		expect(list.map((d) => d.updatedAt)).toEqual([newestAt, middleAt]);
	});

	it('maxDrafts=0 disables the cap', async () => {
		const { app } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 0 });
		for (let i = 0; i < 5; i++) {
			await store.save(buildDraft({ id: newDraftId() }));
		}
		const list = await store.list();
		expect(list).toHaveLength(5);
	});
});

describe('DraftStore — corruption + version safety', () => {
	it('list() skips drafts with mismatched schemaVersion', async () => {
		const { app, state } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		state.folders.add('_crosswalker');
		state.folders.add('_crosswalker/drafts');
		state.files.set('_crosswalker/drafts/draft_future.json', {
			path: '_crosswalker/drafts/draft_future.json',
			content: JSON.stringify({ ...buildDraft(), schemaVersion: 999 }),
		});
		const list = await store.list();
		expect(list).toHaveLength(0);
	});

	it('list() skips corrupt JSON without throwing', async () => {
		const { app, state } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		state.folders.add('_crosswalker');
		state.folders.add('_crosswalker/drafts');
		state.files.set('_crosswalker/drafts/draft_corrupt.json', {
			path: '_crosswalker/drafts/draft_corrupt.json',
			content: '{not valid json',
		});
		const list = await store.list();
		expect(list).toHaveLength(0);
	});
});

describe('DraftStore — clearAll', () => {
	it('clearAll() removes every draft + returns the deleted count', async () => {
		const { app, state } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		for (let i = 0; i < 3; i++) {
			await store.save(buildDraft({ id: newDraftId() }));
		}
		const deleted = await store.clearAll();
		expect(deleted).toBe(3);
		expect(state.files.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Serialization helper tests
// ---------------------------------------------------------------------------

describe('columnConfigsToDict / dictToColumnConfigs', () => {
	it('round-trips a Map through Record without losing entries', () => {
		const m = new Map([
			['Control ID', { useAs: 'hierarchy', outputKey: 'control_id' }],
			['Title', { useAs: 'title', outputKey: 'title' }],
		]);
		const dict = columnConfigsToDict(m);
		expect(dict['Control ID'].useAs).toBe('hierarchy');
		expect(dict['Title'].outputKey).toBe('title');
		const round = dictToColumnConfigs(dict);
		expect(round.size).toBe(2);
		expect(round.get('Control ID')?.useAs).toBe('hierarchy');
	});

	it('JSON.stringify on Map directly produces empty object (sanity)', () => {
		const m = new Map([['a', { useAs: 'x', outputKey: 'x' }]]);
		expect(JSON.stringify(m)).toBe('{}');
		// And the helper produces a proper object:
		expect(JSON.stringify(columnConfigsToDict(m))).toContain('useAs');
	});
});

// ---------------------------------------------------------------------------
// Workbench mapping persistence (spec §7i)
// ---------------------------------------------------------------------------

/** A representative ragged-hierarchy ImportMapping (leaf + variadic tail). */
function sampleWorkbenchMapping(): ImportMapping {
	return {
		mappings: [
			{
				levels: [
					{
						level: 'leaf',
						source: { column: 'technique_id' },
						destinations: [{ primitive: 'name' }],
						naming: 'part',
						missing: 'skip',
						materialize: false,
					},
				],
				tail: {
					source: { column: 'technique_id' },
					delimiter: '.',
					drop_last: true,
					destinations: [{ primitive: 'folder' }],
					naming: 'prefix',
					max_depth: 6,
				},
			},
			{
				levels: [
					{
						level: 'tactic',
						source: { column: 'tactic' },
						destinations: [{ primitive: 'tag', namespace: 'tactic' }],
						naming: 'part',
						missing: 'skip',
						materialize: false,
					},
				],
			},
		],
	};
}

describe('DraftStore — workbench mapping round-trip', () => {
	it('persists a workbenchMapping and restores it deep-equal after save→list', async () => {
		const { app } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		const workbenchMapping = sampleWorkbenchMapping();
		const draft = buildDraft({ workbenchMapping });
		await store.save(draft);
		const list = await store.list();
		expect(list).toHaveLength(1);
		expect(list[0].workbenchMapping).toEqual(workbenchMapping);
	});

	it('restores a workbenchMapping deep-equal after load(id)', async () => {
		const { app } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		const workbenchMapping = sampleWorkbenchMapping();
		const draft = buildDraft({ workbenchMapping });
		await store.save(draft);
		const loaded = await store.load(draft.id);
		expect(loaded).not.toBeNull();
		expect(loaded!.workbenchMapping).toEqual(workbenchMapping);
	});

	it('omitting workbenchMapping stays undefined (classic mode drafts)', async () => {
		const { app } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		const draft = buildDraft();
		await store.save(draft);
		const list = await store.list();
		expect(list[0].workbenchMapping).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// B5 + M8 (2026-07-12) — recognizedFastPath / columnDests / dismissed
// persistence. Schema-level: the round-trip through the store, and the
// backward-compatibility contract that a pre-B5/M8 draft (missing these
// optional fields) still loads without throwing.
// ---------------------------------------------------------------------------

describe('DraftStore — recognizedFastPath persistence (B5)', () => {
	it('persists recognizedFastPath and restores it deep-equal after save→list', async () => {
		const { app } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		const draft = buildDraft({ recognizedFastPath: true, workbenchMapping: sampleWorkbenchMapping() });
		await store.save(draft);
		const list = await store.list();
		expect(list[0].recognizedFastPath).toBe(true);
	});

	it('omitting recognizedFastPath stays undefined (pre-B5 drafts hydrate safely, not throw)', async () => {
		const { app } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		const draft = buildDraft();
		await store.save(draft);
		const list = await store.list();
		expect(list[0].recognizedFastPath).toBeUndefined();
	});
});

describe('DraftStore — workbenchColumnDests / workbenchDismissed persistence (M8)', () => {
	it('persists a columnDests snapshot and dismissed keys, restored deep-equal after save→list', async () => {
		const { app } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		const workbenchColumnDests = { severity: 'property' as const, notes: 'body' as const, internal_id: 'skip' as const };
		const workbenchDismissed = ['facet-candidate:severity', 'title-candidate:name'];
		const draft = buildDraft({
			workbenchMapping: sampleWorkbenchMapping(),
			workbenchColumnDests,
			workbenchDismissed,
		});
		await store.save(draft);
		const list = await store.list();
		expect(list[0].workbenchColumnDests).toEqual(workbenchColumnDests);
		expect(list[0].workbenchDismissed).toEqual(workbenchDismissed);
	});

	it('restores workbenchColumnDests / workbenchDismissed deep-equal after load(id)', async () => {
		const { app } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		const workbenchColumnDests = { owner: 'alias' as const };
		const workbenchDismissed = ['body-candidate:description'];
		const draft = buildDraft({ workbenchColumnDests, workbenchDismissed });
		await store.save(draft);
		const loaded = await store.load(draft.id);
		expect(loaded!.workbenchColumnDests).toEqual(workbenchColumnDests);
		expect(loaded!.workbenchDismissed).toEqual(workbenchDismissed);
	});

	it('omitting workbenchColumnDests / workbenchDismissed stays undefined (pre-M8 drafts hydrate safely)', async () => {
		const { app } = createMockApp();
		const store = new DraftStore(app, mockDebug, { draftExpiryDays: 30, maxDrafts: 20 });
		const draft = buildDraft();
		await store.save(draft);
		const list = await store.list();
		expect(list[0].workbenchColumnDests).toBeUndefined();
		expect(list[0].workbenchDismissed).toBeUndefined();
	});
});

describe('resolveDraftSource — resume without re-selection (spec §7i)', () => {
	it('re-parses automatically when vaultPath is set and the file exists', () => {
		const draft = buildDraft({ sourceFile: { name: 'atlas.csv', vaultPath: 'Sources/atlas.csv' } });
		const decision = resolveDraftSource(draft, (p) => p === 'Sources/atlas.csv');
		expect(decision).toEqual({ action: 'reparse', vaultPath: 'Sources/atlas.csv' });
	});

	it('falls back to re-select when the vault file no longer exists', () => {
		const draft = buildDraft({ sourceFile: { name: 'atlas.csv', vaultPath: 'Sources/atlas.csv' } });
		const decision = resolveDraftSource(draft, () => false);
		expect(decision).toEqual({ action: 'reselect' });
	});

	it('falls back to re-select for an external OS-picker file (vaultPath null)', () => {
		const draft = buildDraft({ sourceFile: { name: 'atlas.csv', vaultPath: null } });
		const decision = resolveDraftSource(draft, () => true);
		expect(decision).toEqual({ action: 'reselect' });
	});

	it('falls back to re-select when there is no source file at all', () => {
		const draft = buildDraft({ sourceFile: null });
		const decision = resolveDraftSource(draft, () => true);
		expect(decision).toEqual({ action: 'reselect' });
	});
});

describe('newDraftId / autoDraftName', () => {
	it('newDraftId() returns IDs matching the documented format', () => {
		const id = newDraftId();
		expect(id).toMatch(/^draft_\d+_[0-9a-f]{8}$/);
	});

	it('autoDraftName strips the file extension and includes the step', () => {
		expect(autoDraftName('NIST-800-53.csv', 2)).toBe('NIST-800-53 (Step 2)');
		expect(autoDraftName('data.xlsx', 3)).toBe('data (Step 3)');
		expect(autoDraftName(undefined, 1)).toBe('untitled (Step 1)');
	});
});
