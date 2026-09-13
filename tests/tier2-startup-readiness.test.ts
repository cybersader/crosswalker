import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import { settleVaultIndex } from '../src/generation/import-set';
import {
	countTier2StartupPendingFiles,
	projectionErrorDiagnostics,
	waitForTier2StartupReadiness,
} from '../src/tier2/startup-readiness';

interface FakeCacheEntry {
	frontmatter?: unknown;
	frontmatterPosition?: unknown;
}

function makeApp(entries: Array<[string, FakeCacheEntry | null]>) {
	const cacheByPath = new Map(entries);
	const listeners = new Set<() => void>();
	let subscriptions = 0;
	let unsubscribes = 0;
	let metadataAccesses = 0;
	const app = {
		vault: {
			getMarkdownFiles: () => {
				metadataAccesses += 1;
				return [...cacheByPath.keys()].map((path) => new TFile(path));
			},
		},
		metadataCache: {
			getFileCache: (file: TFile) => {
				metadataAccesses += 1;
				return cacheByPath.get(file.path) ?? null;
			},
			on: (_event: string, callback: () => void) => {
				subscriptions += 1;
				listeners.add(callback);
				return callback;
			},
			offref: (callback: () => void) => {
				unsubscribes += 1;
				listeners.delete(callback);
			},
		},
	} as unknown as App;
	return {
		app,
		cacheByPath,
		emitResolved() { for (const listener of [...listeners]) listener(); },
		subscriptions: () => subscriptions,
		unsubscribes: () => unsubscribes,
		listenerCount: () => listeners.size,
		metadataAccesses: () => metadataAccesses,
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe('Tier 2 startup readiness', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.restoreAllMocks();
		jest.useRealTimers();
	});

	it('treats only absent caches and partially parsed frontmatter as pending', () => {
		const vault = makeApp([
			['Absent.md', null],
			['Plain.md', {}],
			['Parsed.md', { frontmatterPosition: {}, frontmatter: { curie: 'x:A' } }],
			['Partial.md', { frontmatterPosition: {} }],
			['InvalidParsedValue.md', { frontmatterPosition: {}, frontmatter: 'not-an-object' }],
		]);
		expect(countTier2StartupPendingFiles(vault.app)).toBe(3);
	});

	it.each([
		['empty', [] as Array<[string, FakeCacheEntry | null]>],
		['warm', [['Plain.md', {}]] as Array<[string, FakeCacheEntry | null]>],
	])('returns immediately for an %s vault without timers or subscriptions', async (_label, entries) => {
		const vault = makeApp(entries);
		const timerSpy = jest.spyOn(globalThis, 'setTimeout');
		await expect(waitForTier2StartupReadiness(vault.app, () => false)).resolves.toEqual({
			pending: 0,
			checks: 1,
			elapsedMs: 0,
			timedOut: false,
			cancelled: false,
		});
		expect(vault.subscriptions()).toBe(0);
		expect(timerSpy).not.toHaveBeenCalled();
	});

	it('checks cancellation before initial metadata access', async () => {
		const vault = makeApp([['Cold.md', null]]);
		await expect(waitForTier2StartupReadiness(vault.app, () => true)).resolves.toEqual({
			pending: 0,
			checks: 0,
			elapsedMs: 0,
			timedOut: false,
			cancelled: true,
		});
		expect(vault.metadataAccesses()).toBe(0);
		expect(jest.getTimerCount()).toBe(0);
	});

	it('accepts readiness only after a fresh poll, without any metadata event', async () => {
		const vault = makeApp([['Cold.md', null]]);
		const waiting = waitForTier2StartupReadiness(vault.app, () => false, { timeoutMs: 1000 });
		setTimeout(() => vault.cacheByPath.set('Cold.md', {}), 250);
		await jest.advanceTimersByTimeAsync(300);
		await expect(waiting).resolves.toEqual({
			pending: 0,
			checks: 4,
			elapsedMs: 300,
			timedOut: false,
			cancelled: false,
		});
		expect(vault.subscriptions()).toBe(0);
		expect(jest.getTimerCount()).toBe(0);
	});

	it('does not let rapid irrelevant resolved events consume the deadline', async () => {
		const vault = makeApp([['Cold.md', null]]);
		let settled = false;
		const waiting = waitForTier2StartupReadiness(vault.app, () => false, { timeoutMs: 1200 })
			.then((value) => { settled = true; return value; });
		setTimeout(() => vault.cacheByPath.set('Cold.md', {}), 800);

		for (let event = 0; event < 5; event += 1) {
			vault.emitResolved();
			await flushMicrotasks();
		}
		// Behavior first: the superseded implementation settled here after its
		// three event rounds. Keep the structural no-subscription assertion second
		// so a historical replay proves premature settlement rather than stopping at
		// an implementation-detail mismatch.
		expect(settled).toBe(false);
		expect(vault.subscriptions()).toBe(0);
		await jest.advanceTimersByTimeAsync(799);
		expect(settled).toBe(false);
		await jest.advanceTimersByTimeAsync(1);
		await expect(waiting).resolves.toEqual({
			pending: 0,
			checks: 9,
			elapsedMs: 800,
			timedOut: false,
			cancelled: false,
		});
	});

	it('freshly observes missing cache becoming partial and then ready', async () => {
		const vault = makeApp([['Changing.md', null]]);
		const waiting = waitForTier2StartupReadiness(vault.app, () => false, { timeoutMs: 1000 });
		setTimeout(() => vault.cacheByPath.set('Changing.md', { frontmatterPosition: {} }), 150);
		setTimeout(() => vault.cacheByPath.set('Changing.md', { frontmatterPosition: {}, frontmatter: { curie: 'x:A' } }), 450);
		await jest.advanceTimersByTimeAsync(500);
		await expect(waiting).resolves.toEqual({
			pending: 0,
			checks: 6,
			elapsedMs: 500,
			timedOut: false,
			cancelled: false,
		});
	});

	it('uses 100/100/50 polling and returns a fresh pending count at a 250ms deadline', async () => {
		const vault = makeApp([['Partial.md', { frontmatterPosition: {} }]]);
		const timerSpy = jest.spyOn(globalThis, 'setTimeout');
		const waiting = waitForTier2StartupReadiness(vault.app, () => false, { timeoutMs: 250 });
		await jest.advanceTimersByTimeAsync(250);
		await expect(waiting).resolves.toEqual({
			pending: 1,
			checks: 4,
			elapsedMs: 250,
			timedOut: true,
			cancelled: false,
		});
		const scheduled = timerSpy.mock.calls.map((call) => call[1]);
		expect(scheduled).toEqual([100, 100, 50]);
		expect(jest.getTimerCount()).toBe(0);
	});

	it('recognizes readiness in the fresh final sample at the deadline boundary', async () => {
		const vault = makeApp([['Boundary.md', null]]);
		const waiting = waitForTier2StartupReadiness(vault.app, () => false, { timeoutMs: 250 });
		setTimeout(() => vault.cacheByPath.set('Boundary.md', {}), 250);
		await jest.advanceTimersByTimeAsync(250);
		await expect(waiting).resolves.toEqual({
			pending: 0,
			checks: 4,
			elapsedMs: 250,
			timedOut: false,
			cancelled: false,
		});
	});

	it('gives cancellation precedence when it arrives at the deadline', async () => {
		const vault = makeApp([['Cold.md', null]]);
		let cancelled = false;
		const waiting = waitForTier2StartupReadiness(vault.app, () => cancelled, { timeoutMs: 250 });
		setTimeout(() => { cancelled = true; }, 250);
		await jest.advanceTimersByTimeAsync(250);
		await expect(waiting).resolves.toEqual({
			pending: 1,
			checks: 3,
			elapsedMs: 250,
			timedOut: false,
			cancelled: true,
		});
		expect(jest.getTimerCount()).toBe(0);
	});

	it('handles a zero timeout with one fresh count and no timer', async () => {
		const vault = makeApp([['Cold.md', null]]);
		await expect(waitForTier2StartupReadiness(vault.app, () => false, { timeoutMs: 0 })).resolves.toEqual({
			pending: 1,
			checks: 1,
			elapsedMs: 0,
			timedOut: true,
			cancelled: false,
		});
		expect(jest.getTimerCount()).toBe(0);
	});

	it('normalizes invalid or oversized bounds without zero-delay spinning', async () => {
		const vault = makeApp([['Cold.md', null]]);
		const timerSpy = jest.spyOn(globalThis, 'setTimeout');
		const waiting = waitForTier2StartupReadiness(vault.app, () => false, {
			timeoutMs: Number.POSITIVE_INFINITY,
			pollIntervalMs: 0,
		});
		await jest.advanceTimersByTimeAsync(12_000);
		await expect(waiting).resolves.toEqual({
			pending: 1,
			checks: 121,
			elapsedMs: 12_000,
			timedOut: true,
			cancelled: false,
		});
		expect(timerSpy.mock.calls.every((call) => Number(call[1]) > 0 && Number(call[1]) <= 100)).toBe(true);
		expect(jest.getTimerCount()).toBe(0);
	});

	it('cancels after the active timer without another metadata evaluation', async () => {
		const vault = makeApp([['Cold.md', null]]);
		let cancelled = false;
		const waiting = waitForTier2StartupReadiness(vault.app, () => cancelled, { timeoutMs: 1000 });
		const accessesAfterInitialCount = vault.metadataAccesses();
		setTimeout(() => { cancelled = true; }, 50);
		await jest.advanceTimersByTimeAsync(100);
		await expect(waiting).resolves.toEqual({
			pending: 1,
			checks: 1,
			elapsedMs: 100,
			timedOut: false,
			cancelled: true,
		});
		expect(vault.metadataAccesses()).toBe(accessesAfterInitialCount);
		expect(jest.getTimerCount()).toBe(0);
	});

	it('preserves metadata access errors', async () => {
		const app = {
			vault: { getMarkdownFiles: () => { throw new Error('cache scan failed'); } },
			metadataCache: { getFileCache: jest.fn() },
		} as unknown as App;
		await expect(waitForTier2StartupReadiness(app, () => false)).rejects.toThrow('cache scan failed');
	});

	it('keeps settleVaultIndex two-argument behavior and clears its early timer', async () => {
		const vault = makeApp([['Cold.md', null]]);
		const waiting = settleVaultIndex(vault.app, 4000);
		vault.cacheByPath.set('Cold.md', {});
		vault.emitResolved();
		await expect(waiting).resolves.toBe(0);
		expect(vault.unsubscribes()).toBe(1);
		expect(jest.getTimerCount()).toBe(0);
	});
});

describe('projection error diagnostics', () => {
	it('caps samples and every path/message while retaining the total', () => {
		const errors = Array.from({ length: 7 }, (_, index) => ({
			vault_path: `${index}-${'p'.repeat(300)}`,
			message: `${index}-${'m'.repeat(600)}`,
		}));
		const diagnostics = projectionErrorDiagnostics(errors);
		expect(diagnostics.errorTotal).toBe(7);
		expect(diagnostics.errorSamples).toHaveLength(5);
		expect(diagnostics.errorSamplesTruncated).toBe(true);
		for (const sample of diagnostics.errorSamples) {
			expect(sample.vault_path.length).toBeLessThanOrEqual(256);
			expect(sample.message.length).toBeLessThanOrEqual(512);
		}
	});
});
