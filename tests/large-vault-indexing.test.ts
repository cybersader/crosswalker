/**
 * Large-vault indexing: the startup projection, the query database pass, the
 * Connections window and its release-record reads must all treat a note the
 * metadata cache has not reached yet as "not indexed yet", never as absent or
 * as an error, and must not repeat whole-vault work per mapping set.
 *
 * Synthetic data only.
 */
import * as fs from 'node:fs';
import * as importSets from '../src/generation/import-set';
import { applyMigrations } from '../src/tier2/migrations';
import { projectFromTier1 } from '../src/tier2/projector';
import * as connectionsQuery from '../src/graph/connections-query';
import { ConnectionsModal } from '../src/graph/connections-modal';
import { createFsApp } from '../cli/fs-app';
import * as mappingSets from '../src/mappings/mapping-set';
import * as recipeForNote from '../src/export/recipe-for-note';
import * as importSetRecipes from '../src/import/import-set-recipes';
import { readNoteFrontmatterState } from '../src/export/vault-reader';
import { importSetIdOf } from '../src/mappings/conversion-marker';
import { normalizeFolderSetting } from '../src/settings/folder-settings';
import { MAP, SOURCE, TARGET, fixture, assertion, note, provenance } from './helpers/connections-fixture';

const { DatabaseSync } = require('node:sqlite');

interface FakeFile { path: string; basename: string; extension: string; stat: { mtime: number } }
const file = (path: string): FakeFile => ({ path, basename: path.split('/').pop()!.replace(/\.md$/, ''), extension: 'md', stat: { mtime: 0 } });

/** A vault whose metadata cache fills in on demand, with a `resolved` event hook. */
function indexingVault(paths: string[], indexed: Set<string>, frontmatter: (path: string) => Record<string, unknown> = () => ({})) {
	const files = paths.map(file);
	const handlers: Array<() => void> = [];
	const app = {
		vault: { getMarkdownFiles: jest.fn(() => files) },
		metadataCache: {
			getFileCache: (f: FakeFile) => indexed.has(f.path) ? { frontmatter: frontmatter(f.path) } : null,
			on: jest.fn((name: string, handler: () => void) => { if (name === 'resolved') handlers.push(handler); return { handler }; }),
			offref: jest.fn((ref: { handler: () => void }) => { const i = handlers.indexOf(ref.handler); if (i >= 0) handlers.splice(i, 1); }),
		},
	};
	return { app, files, handlers, resolve: () => [...handlers].forEach((h) => h()) };
}

function createTestDb() {
	const sqlite = new DatabaseSync(':memory:');
	return {
		exec(input: string | { sql: string; bind?: Record<string, unknown>; rowMode?: 'array'; returnValue?: 'resultRows' }): unknown {
			if (typeof input === 'string') { sqlite.exec(input); return; }
			const statement = sqlite.prepare(input.sql);
			if (input.rowMode === 'array') statement.setReturnArrays(true);
			const bind = input.bind ?? {};
			if (input.returnValue === 'resultRows') return Object.keys(bind).length ? statement.all(bind) : statement.all();
			if (Object.keys(bind).length) statement.run(bind); else statement.run();
		},
		close: () => sqlite.close(),
	};
}
const concept = (curie: string) => ({ _crosswalker: { produced_at: '2026-11-14T00:00:00.000Z' }, kind: 'concept', curie, title: curie });

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
afterEach(() => jest.restoreAllMocks());

describe('A. waiting for indexing has no deadline and is event-driven', () => {
	it('resolves only after every note has a cache entry, re-checking on each resolved event', async () => {
		const indexed = new Set<string>(['a.md']);
		const vault = indexingVault(['a.md', 'b.md', 'c.md'], indexed);
		const progress: number[] = [];
		let settled = false;
		// A long poll so only the event can wake the wait inside this test.
		const wait = importSets.waitForVaultIndexed(vault.app as never, { initialDelayMs: 60_000, onProgress: (n) => progress.push(n) })
			.then((r) => { settled = true; return r; });
		await flush();
		expect(settled).toBe(false);
		indexed.add('b.md'); vault.resolve(); await flush();
		expect(settled).toBe(false);
		indexed.add('c.md'); vault.resolve();
		await expect(wait).resolves.toEqual({ pending: 0, cancelled: false });
		expect(progress).toEqual([2, 1]);
		expect(vault.handlers).toHaveLength(0);
	});

	it('falls back to polling with backoff when the host never emits resolved', async () => {
		const indexed = new Set<string>();
		const vault = indexingVault(['a.md'], indexed);
		(vault.app.metadataCache as { on?: unknown }).on = undefined;
		const wait = importSets.waitForVaultIndexed(vault.app as never, { initialDelayMs: 1, maxDelayMs: 4 });
		await new Promise((resolve) => setTimeout(resolve, 10));
		indexed.add('a.md');
		await expect(wait).resolves.toEqual({ pending: 0, cancelled: false });
	});

	it('stops as cancelled when its signal aborts, and unsubscribes', async () => {
		const vault = indexingVault(['a.md'], new Set());
		const controller = new AbortController();
		const wait = importSets.waitForVaultIndexed(vault.app as never, { signal: controller.signal, initialDelayMs: 60_000 });
		controller.abort();
		await expect(wait).resolves.toEqual({ pending: 1, cancelled: true });
		expect(vault.handlers).toHaveLength(0);
	});
});

describe('B. a full query database pass treats a missing cache entry as not indexed yet', () => {
	it('counts unindexed notes once, adds no per-note errors or warnings, and prunes nothing', async () => {
		const db = createTestDb();
		try {
			await applyMigrations(db as never);
			const paths = ['F/A.md', 'F/B.md', 'F/C.md', 'F/D.md'];
			const all = new Set(paths);
			const vault = indexingVault(paths, all, (p) => concept(`ex:${p.slice(2, 3)}`));
			const first = await projectFromTier1(vault.app as never, db as never, { projectionMode: 'full' });
			expect(first.success).toBe(true);

			// Restart: only A is indexed so far.
			const warn = jest.fn();
			const debug = { info: jest.fn(), warn, error: jest.fn() };
			const cold = indexingVault(paths, new Set(['F/A.md']), (p) => concept(`ex:${p.slice(2, 3)}`));
			const result = await projectFromTier1(cold.app as never, db as never, { projectionMode: 'full', debug: debug as never });

			expect(result.errors).toEqual([]);
			expect(result.counts.errors).toBe(0);
			expect(result.notIndexed).toBe(3);
			expect(result.success).toBe(false);
			const rowWarnings = warn.mock.calls.filter((c) => c[1] === 'projection-row-error');
			expect(rowWarnings).toHaveLength(0);
			const summary = warn.mock.calls.filter((c) => c[1] === 'projection-not-indexed');
			expect(summary).toHaveLength(1);
			expect(summary[0][3]).toMatchObject({ not_indexed: 3 });
			// The rows of notes the pass could not see are still there.
			const rows = db.exec({ sql: 'SELECT curie FROM concepts ORDER BY curie', rowMode: 'array', returnValue: 'resultRows' });
			expect(rows).toEqual([['ex:A'], ['ex:B'], ['ex:C'], ['ex:D']]);
		} finally {
			db.close();
		}
	});
});

describe('C. Connections waits for indexing instead of failing fast', () => {
	function fakeNode() {
		const texts: string[] = [];
		const clicks: Array<() => void> = [];
		const make = (): Record<string, unknown> => {
			const node: Record<string, unknown> = {};
			node.createEl = jest.fn((_tag: string, opts?: { text?: string }) => { if (opts?.text) texts.push(opts.text); const child = make(); return child; });
			node.createDiv = jest.fn(() => make());
			node.createSpan = jest.fn((opts?: { text?: string }) => { if (opts?.text) texts.push(opts.text); return make(); });
			node.setText = jest.fn((t: string) => texts.push(t));
			node.addEventListener = jest.fn((ev: string, fn: () => void) => { if (ev === 'click') clicks.push(fn); });
			node.addClass = jest.fn();
			node.empty = jest.fn();
			return node;
		};
		return { root: make(), texts, clicks };
	}

	it('shows the indexing state with a count, then loads on its own once indexing finishes', async () => {
		const indexed = new Set<string>(['a.md']);
		const vault = indexingVault(['a.md', 'b.md'], indexed);
		const load = jest.spyOn(connectionsQuery, 'loadConnectionsSnapshot')
			.mockRejectedValueOnce(new importSets.VaultStillIndexingError())
			.mockRejectedValueOnce(new connectionsQuery.ConnectionsError('Synthetic second load.'));
		const modal = new ConnectionsModal(vault.app as never, { openMappingReview: jest.fn() });
		const ui = fakeNode();
		modal.contentEl = ui.root as never;
		await (modal as unknown as { load(): Promise<void> }).load();
		await flush();
		expect(ui.texts.some((t) => t.startsWith('Obsidian is still indexing this vault'))).toBe(true);
		expect(ui.texts).toContain('1 note left to index.');
		expect(load).toHaveBeenCalledTimes(1);
		for (const text of ui.texts) expect(text).not.toMatch(/—/);

		indexed.add('b.md'); vault.resolve(); await flush(); await flush();
		expect(load).toHaveBeenCalledTimes(2);
		expect(ui.texts).toContain('Synthetic second load.');
	});

	it('stops waiting when the window closes', async () => {
		const vault = indexingVault(['a.md'], new Set());
		const load = jest.spyOn(connectionsQuery, 'loadConnectionsSnapshot').mockRejectedValue(new importSets.VaultStillIndexingError());
		const modal = new ConnectionsModal(vault.app as never, { openMappingReview: jest.fn() });
		modal.contentEl = fakeNode().root as never;
		await (modal as unknown as { load(): Promise<void> }).load();
		await flush();
		expect(vault.handlers).toHaveLength(1);
		modal.onClose();
		await flush();
		expect(vault.handlers).toHaveLength(0);
		expect(load).toHaveBeenCalledTimes(1);
	});
});

describe('D. release records are read from one vault scan per snapshot', () => {
	const roots: string[] = [];
	afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

	const ownerId = (n: number) => n === 0 ? MAP : `iset-map${String(n).padStart(3, '0')}`;
	const storedFor = (n: number) => mappingSets.storedMappingSet(mappingSets.buildMappingSetRecord({ mapping_set_id: `release:${n}`, mapping_provider: `Provider ${n}` } as never, [], ownerId(n)));

	async function snapshotWork(owners: number, plainNotes = 0) {
		const root = fixture(); roots.push(root);
		for (let n = 0; n < owners; n++) {
			assertion(root, `Mappings ${n}/edge.md`, `edge:${n}`, { _crosswalker: provenance(ownerId(n)) });
			note(root, `Mappings ${n}/release.md`, { ...storedFor(n), _crosswalker: provenance(ownerId(n)) });
		}
		for (let n = 0; n < plainNotes; n++) {
			const p = `${root}/Mappings 0/plain ${n}.md`;
			fs.writeFileSync(p, 'A plain synthetic note with no properties.\n');
		}
		const app = createFsApp(root);
		const scans = jest.spyOn(app.vault, 'getMarkdownFiles');
		const stamps = jest.spyOn(recipeForNote, 'recipeStampOf');
		const indexes = jest.spyOn(mappingSets, 'buildSetNoteIndex');
		const snapshot = await connectionsQuery.loadConnectionsSnapshot(app as never);
		const index = indexes.mock.results.length ? await indexes.mock.results[0].value as mappingSets.SetNoteIndex : undefined;
		const work = { scans: scans.mock.calls.length, stampReads: stamps.mock.calls.length, indexBuilds: indexes.mock.calls.length, candidateVisits: index?.candidateVisits, snapshot };
		jest.restoreAllMocks();
		return work;
	}

	it('reads every owner\'s exact release record with no warnings', async () => {
		const { snapshot } = await snapshotWork(6);
		expect(snapshot.coverage.metadataWarnings).toEqual([]);
		expect([...snapshot.releases.keys()].sort()).toEqual(Array.from({ length: 6 }, (_, n) => ownerId(n)).sort());
		for (let n = 0; n < 6; n++) {
			expect(snapshot.releases.get(ownerId(n))).toEqual(mappingSets.mappingSetFromStored(storedFor(n), ownerId(n), 'expected'));
		}
	});

	it('does not repeat whole-vault work per mapping set', async () => {
		const one = await snapshotWork(1, 300);
		const six = await snapshotWork(6, 300);
		// One recipe-stamp read per concept, however many sets there are.
		expect(six.stampReads).toBe(six.snapshot.tree.concepts.length);
		expect(one.stampReads).toBe(one.snapshot.tree.concepts.length);
		expect(six.scans).toBe(one.scans);
		expect(six.indexBuilds).toBe(1);
		// Indexed notes without properties are answered by the cache: no lookup revisits them.
		expect(six.candidateVisits).toBe(0);
	});
});

/** An in-memory vault with a chosen cache state per note. Synthetic only. */
type CacheState = 'cached' | 'missing' | 'unparsed' | 'plain';
function memoryVault(entries: Array<{ path: string; fm?: Record<string, unknown>; cache: CacheState }>) {
	const files = entries.map((e) => file(e.path));
	const byPath = new Map(entries.map((e) => [e.path, e]));
	const yaml = (value: Record<string, unknown>, indent = ''): string => Object.entries(value).map(([k, v]) =>
		v && typeof v === 'object' ? `${indent}${k}:\n${yaml(v as Record<string, unknown>, `${indent}  `)}` : `${indent}${k}: "${String(v)}"`).join('\n');
	const cachedRead = jest.fn(async (f: FakeFile) => {
		const e = byPath.get(f.path)!;
		return e.fm ? `---\n${yaml(e.fm)}\n---\n\nSynthetic.\n` : 'Synthetic.\n';
	});
	const app = {
		vault: { getMarkdownFiles: () => files, cachedRead, read: cachedRead },
		metadataCache: {
			getFileCache: (f: FakeFile) => {
				const e = byPath.get(f.path)!;
				if (e.cache === 'missing') return null;
				if (e.cache === 'unparsed') return { frontmatterPosition: { start: { line: 0 }, end: { line: 3 } } };
				if (e.cache === 'plain') return {};
				return { frontmatter: e.fm, frontmatterPosition: { start: { line: 0 }, end: { line: 3 } } };
			},
		},
	};
	return { app, cachedRead };
}
const owned = (id: string, kind = 'mapping-set') => ({ kind, mapping_set_id: `release-${id}`, _crosswalker: { import_set: { id } } });

/** The lookup as it was before the shared index: sort the vault, scan it, read raw in scope. */
async function referenceLookup(app: never, setId: string, kind: string, scope: { folder?: string | null; paths?: readonly string[] }): Promise<string[]> {
	const a = app as { vault: { getMarkdownFiles(): FakeFile[] }; metadataCache: { getFileCache(f: FakeFile): { frontmatter?: Record<string, unknown> } | null } };
	const base = scope.folder ? normalizeFolderSetting(scope.folder) : '';
	const listed = new Set(scope.paths ?? []);
	const inScope = (path: string) => listed.has(path) || (!!base && path.startsWith(`${base}/`));
	const found: string[] = [];
	for (const f of [...a.vault.getMarkdownFiles()].sort((x, y) => x.path.localeCompare(y.path))) {
		let fm = a.metadataCache.getFileCache(f)?.frontmatter;
		if (!fm || Object.keys(fm).length === 0) {
			if (!inScope(f.path)) continue;
			const read = await readNoteFrontmatterState(app, f as never);
			if (read.state !== 'ok') continue;
			fm = read.frontmatter;
		}
		if (fm.kind !== kind || importSetIdOf(fm._crosswalker) !== setId) continue;
		found.push(f.path);
	}
	return found;
}

describe('D. set-note lookups visit only pending notes inside their own scope', () => {
	it('never revisits indexed notes without properties, however many owners look', async () => {
		const entries: Array<{ path: string; fm?: Record<string, unknown>; cache: CacheState }> = [];
		for (let n = 0; n < 3000; n++) entries.push({ path: `Plain/note ${n}.md`, cache: 'plain' });
		const owners = Array.from({ length: 40 }, (_, n) => `iset-own${String(n).padStart(3, '0')}`);
		for (const id of owners) entries.push({ path: `Sets/${id}/release.md`, fm: owned(id), cache: 'cached' });
		// Five pending notes in one owner's folder, five outside every scope.
		for (let n = 0; n < 5; n++) entries.push({ path: `Sets/${owners[0]}/pending ${n}.md`, fm: owned(owners[0], 'crosswalk-edge'), cache: 'missing' });
		for (let n = 0; n < 5; n++) entries.push({ path: `Elsewhere/pending ${n}.md`, fm: owned(owners[1]), cache: 'missing' });
		const { app, cachedRead } = memoryVault(entries);
		const index = await mappingSets.buildSetNoteIndex(app as never);
		expect(index.pending).toHaveLength(10);
		for (const id of owners) {
			const notes = await mappingSets.findMappingSetNotes(app as never, id, { folder: `Sets/${id}` }, index);
			expect(notes.map((n) => n.file.path)).toEqual([`Sets/${id}/release.md`]);
		}
		expect(index.candidateVisits).toBe(5);
		expect(cachedRead).toHaveBeenCalledTimes(5);
	});

	it('matches the old lookup for scope, ownership, ordering and overlapping scopes', async () => {
		const A = 'iset-aaaaaa', B = 'iset-bbbbbb';
		const { app } = memoryVault([
			// Cached ownership outside every scope still counts: ownership is the stamp, not the path.
			{ path: 'Other/a-release.md', fm: owned(A), cache: 'cached' },
			// Uncached ownership inside scope is read raw; outside scope it is not.
			{ path: 'Shared/a-pending.md', fm: owned(A), cache: 'missing' },
			{ path: 'Far/a-pending.md', fm: owned(A), cache: 'missing' },
			{ path: 'Shared/a-unparsed.md', fm: owned(A), cache: 'unparsed' },
			// Foreign ownership inside A's folder belongs to B only.
			{ path: 'Shared/b-in-a-folder.md', fm: owned(B), cache: 'missing' },
			{ path: 'Shared/Sub/b-release.md', fm: owned(B), cache: 'missing' },
			{ path: 'Shared/Sub/a-in-b-folder.md', fm: owned(A), cache: 'missing' },
			// Ordering: case, accents and digits under localeCompare.
			{ path: 'Shared/b.md', fm: owned(A), cache: 'cached' },
			{ path: 'Shared/B.md', fm: owned(A), cache: 'missing' },
			{ path: 'Shared/é.md', fm: owned(A), cache: 'cached' },
			{ path: 'Shared/z10.md', fm: owned(A), cache: 'missing' },
			{ path: 'Shared/z9.md', fm: owned(A), cache: 'cached' },
			// Wrong kind, plain notes and a folder whose name only starts like the scope.
			{ path: 'Shared/a-edge.md', fm: owned(A, 'crosswalk-edge'), cache: 'missing' },
			{ path: 'Shared/plain.md', cache: 'plain' },
			{ path: 'Shared-other/a.md', fm: owned(A), cache: 'missing' },
			{ path: 'Listed/a-listed.md', fm: owned(A), cache: 'missing' },
		]);
		const cases: Array<[string, { folder?: string | null; paths?: readonly string[] }]> = [
			[A, { folder: 'Shared' }],
			[A, { folder: 'Shared/' }],
			[A, { folder: 'Shared/Sub', paths: ['Listed/a-listed.md', 'Shared/a-pending.md'] }],
			[A, { paths: ['Far/a-pending.md'] }],
			[A, {}],
			[B, { folder: 'Shared' }],
			[B, { folder: 'Shared/Sub', paths: ['Shared/b-in-a-folder.md'] }],
			[B, { folder: null }],
		];
		const index = await mappingSets.buildSetNoteIndex(app as never);
		for (const [setId, scope] of cases) {
			const expected = await referenceLookup(app as never, setId, 'mapping-set', scope);
			const shared = (await mappingSets.findMappingSetNotes(app as never, setId, scope, index)).map((n) => n.file.path);
			const oneShot = (await mappingSets.findMappingSetNotes(app as never, setId, scope)).map((n) => n.file.path);
			expect({ setId, scope, paths: shared }).toEqual({ setId, scope, paths: expected });
			expect(oneShot).toEqual(expected);
		}
		// The fixture really exercises each branch.
		expect(await referenceLookup(app as never, A, 'mapping-set', { folder: 'Shared' })).toEqual(expect.arrayContaining(['Other/a-release.md', 'Shared/a-pending.md', 'Shared/a-unparsed.md']));
	});
});

describe('D. Connections choices read each set\'s recipe revisions once', () => {
	const roots: string[] = [];
	afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

	it('produces the same choices and recipe reads as the per-set scan', async () => {
		const root = fixture(); roots.push(root);
		const stamped = (set: string, id: string, digest: string) => ({ ...provenance(set), recipe: { id, recipe_document_digest: digest } });
		const add = (name: string, curie: string, set: string, id: string, digest: string) =>
			note(root, name, { curie, kind: 'concept', title: curie, _crosswalker: stamped(set, id, digest) });
		add('A/1.md', 'a:1', SOURCE, 'recipe-a', 'd1');
		add('A/2.md', 'a:2', SOURCE, 'recipe-other', 'd1'); // later id for a seen digest is ignored
		add('A/3.md', 'a:3', SOURCE, 'recipe-a', 'd2');
		add('A/4.md', 'a:4', SOURCE, 'recipe-mismatch', 'd3'); // library says a different recipe
		add('B/1.md', 'b:1', TARGET, 'recipe-b', 'd4');
		add('B/2.md', 'b:2', TARGET, 'recipe-b', 'd1'); // same digest, different set
		add('X/1.md', 'x:1', 'iset-xxxxxx', 'recipe-x', 'd5'); // a third set whose recipe is not in the library
		const library: Record<string, { recipe: string; metadata?: { title?: string }; source: { levels: string[] } }> = {
			[`${SOURCE}:d1`]: { recipe: 'recipe-a', metadata: { title: 'Policy catalog' }, source: { levels: ['Function', 'Control'] } },
			[`${SOURCE}:d2`]: { recipe: 'recipe-a', metadata: { title: 'Policy catalog' }, source: { levels: ['Control', 'Enhancement'] } },
			[`${SOURCE}:d3`]: { recipe: 'recipe-a', metadata: { title: 'Ignored title' }, source: { levels: ['Ignored'] } },
			[`${TARGET}:d4`]: { recipe: 'recipe-b', metadata: { title: 'Backup catalog' }, source: { levels: ['Domain'] } },
			[`${TARGET}:d1`]: { recipe: 'recipe-b', metadata: { title: 'Second title' }, source: { levels: ['Domain'] } },
		};
		const reads = jest.spyOn(importSetRecipes, 'readImportSetRecipe').mockImplementation(async (_adapter, setId, digest) => library[`${setId}:${digest}`] as never);
		const app = createFsApp(root);
		const snapshot = await connectionsQuery.loadConnectionsSnapshot(app as never);

		// Reference: the old per-set scan's read order.
		const expectedReads: Array<[string, string]> = [];
		for (const set of snapshot.sets) {
			const seen = new Set<string>();
			for (const row of snapshot.tree.concepts) {
				const stamp = recipeForNote.recipeStampOf(row.frontmatter);
				if (stamp.setId !== set.id || !stamp.id || !stamp.digest || seen.has(stamp.digest)) continue;
				seen.add(stamp.digest); expectedReads.push([set.id, stamp.digest]);
			}
		}
		expect(reads.mock.calls.map((c) => [c[1], c[2]])).toEqual(expectedReads);
		const labels = Object.fromEntries(snapshot.choices.map((c) => [c.id, c.label]));
		expect(labels[SOURCE]).toBe(`Policy catalog · Source types: Control, Enhancement, Function (${SOURCE}, framework)`);
		expect(labels[TARGET]).toBe(`Policy release two · Source types: Domain (${TARGET}, framework)`);
	});
});
