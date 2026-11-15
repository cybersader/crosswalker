import type { ProjectionResult } from '../src/tier2/projector';

const mockProjectFromTier1 = jest.fn();
const mockWaitForTier2StartupReadiness = jest.fn();

jest.mock('../src/tier2/projector', () => ({
	projectFromTier1: (...args: unknown[]) => mockProjectFromTier1(...args),
}));

jest.mock('../src/tier2/startup-readiness', () => {
	const actual = jest.requireActual('../src/tier2/startup-readiness');
	return {
		...actual,
		waitForTier2StartupReadiness: (...args: unknown[]) => mockWaitForTier2StartupReadiness(...args),
	};
});

jest.mock('../src/tier2/sidecar', () => ({
	openSidecar: jest.fn(),
	clearSidecar: jest.fn(),
	shutdownSidecarHost: jest.fn(),
}));

// main.ts wires many Obsidian UI classes that are irrelevant to these lifecycle
// seams. Keep the test at the plugin coordinator boundary instead of expanding
// the global Obsidian mock with unrelated UI APIs.
jest.mock('../src/settings/settings-tab', () => ({ CrosswalkerSettingTab: class {} }));
jest.mock('../src/import/import-wizard', () => ({ ImportWizardModal: class {} }));
jest.mock('../src/import/sssom-import-modal', () => ({ SssomImportModal: class {} }));
jest.mock('../src/config/config-browser-modal', () => ({ ConfigBrowserModal: class {} }));
jest.mock('../src/views/crosswalker-pivot-view', () => ({ buildCrosswalkerPivotViewFactory: jest.fn() }));
jest.mock('../src/views/workspace-view', () => ({
	CrosswalkerWorkspaceView: class {},
	VIEW_TYPE_CROSSWALKER_WORKSPACE: 'crosswalker-workspace',
}));
jest.mock('../src/views/recipe-picker-modal', () => ({ RecipePickerModal: class {} }));
jest.mock('../src/views/mapping-review-view', () => ({
	MappingReviewView: class {},
	VIEW_TYPE_MAPPING_REVIEW: 'crosswalker-mapping-review',
	statusLabel: jest.fn(),
}));
jest.mock('../src/views/mapping-table-picker', () => ({ MappingTablePickerModal: class {} }));
jest.mock('../src/views/evidence-link-modal', () => ({ EvidenceLinkModal: class {} }));

import * as obsidian from 'obsidian';
import CrosswalkerPlugin from '../src/main';
import { ConnectionsModal } from '../src/graph/connections-modal';
import * as connectionsQuery from '../src/graph/connections-query';
import { VaultStillIndexingError } from '../src/generation/import-set';

const EMPTY_COUNTS = {
	concepts: 0,
	mappings: 0,
	junction_notes: 0,
	ontologies: 0,
	mapping_tables: 0,
	skipped: 0,
	errors: 0,
};

function result(overrides: Partial<ProjectionResult> = {}): ProjectionResult {
	return {
		success: true,
		counts: { ...EMPTY_COUNTS },
		errors: [],
		durationMs: 1,
		...overrides,
	};
}

function makeDebug() {
	const events: Array<Record<string, unknown>> = [];
	let traceId: string | undefined;
	return {
		events,
		newTraceId: () => 'startup-trace',
		currentTraceId: () => traceId,
		withTrace: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
			traceId = id;
			try { return await fn(); } finally { traceId = undefined; }
		},
		info: (category: string, op: string, msg: string, data: Record<string, unknown> = {}) => {
			events.push({ category, op, msg, trace_id: traceId, ...data });
		},
		warn: jest.fn(),
		error: (category: string, op: string, msg: string, data: Record<string, unknown> = {}) => {
			events.push({ category, op, msg, trace_id: traceId, ...data });
		},
	};
}

function makePlugin(): CrosswalkerPlugin & Record<string, any> {
	const plugin = new CrosswalkerPlugin() as CrosswalkerPlugin & Record<string, any>;
	plugin.app = { vault: {}, metadataCache: {} } as any;
	plugin.settings = { enableTier2Projection: true } as any;
	plugin.debug = makeDebug() as any;
	plugin.tier2TeardownInProgress = false;
	plugin.tier2Unloaded = false;
	return plugin;
}

describe('runProjection full-pass coalescing', () => {
	beforeEach(() => {
		mockProjectFromTier1.mockReset();
		mockWaitForTier2StartupReadiness.mockReset();
	});

	it('shares one open/project pass between overlapping callers and allows a later pass', async () => {
		const plugin = makePlugin();
		let resolveOpen!: (value: any) => void;
		const open = jest.fn(() => new Promise((resolve) => { resolveOpen = resolve; }));
		plugin.openTier2 = open;
		mockProjectFromTier1.mockResolvedValue(result());

		const first = plugin.runProjection();
		const second = plugin.runProjection();
		expect(open).toHaveBeenCalledTimes(1);
		resolveOpen({ db: {} });
		await expect(Promise.all([first, second])).resolves.toEqual([result(), result()]);
		expect(mockProjectFromTier1).toHaveBeenCalledTimes(1);

		plugin.openTier2 = jest.fn().mockResolvedValue({ db: {} });
		await expect(plugin.runProjection()).resolves.toEqual(result());
		expect(mockProjectFromTier1).toHaveBeenCalledTimes(2);
	});

	it('clears the in-flight slot after rejection so a later pass can start', async () => {
		const plugin = makePlugin();
		plugin.openTier2 = jest.fn().mockResolvedValue({ db: {} });
		mockProjectFromTier1
			.mockRejectedValueOnce(new Error('projection failed'))
			.mockResolvedValueOnce(result());

		await expect(plugin.runProjection()).rejects.toThrow('projection failed');
		await expect(plugin.runProjection()).resolves.toEqual(result());
		expect(mockProjectFromTier1).toHaveBeenCalledTimes(2);
	});
});

describe('automatic Tier 2 startup coordination', () => {
	beforeEach(() => {
		mockProjectFromTier1.mockReset();
		mockWaitForTier2StartupReadiness.mockReset();
		mockWaitForTier2StartupReadiness.mockResolvedValue({ pending: 0, checks: 1, elapsedMs: 0, timedOut: false, cancelled: false });
	});

	it('does not enter readiness or projection when disabled initially', async () => {
		const plugin = makePlugin();
		plugin.settings.enableTier2Projection = false;
		plugin.runProjection = jest.fn();
		await plugin.autoProjectOnLayoutReady();
		expect(mockWaitForTier2StartupReadiness).not.toHaveBeenCalled();
		expect(plugin.runProjection).not.toHaveBeenCalled();
	});

	it('does not access the database when disabled during the active wait', async () => {
		const plugin = makePlugin();
		plugin.runProjection = jest.fn();
		mockWaitForTier2StartupReadiness.mockImplementation(async (_app, shouldCancel: () => boolean) => {
			plugin.settings.enableTier2Projection = false;
			return { pending: 1, checks: 1, elapsedMs: 100, timedOut: false, cancelled: shouldCancel() };
		});
		await plugin.autoProjectOnLayoutReady();
		expect(plugin.runProjection).not.toHaveBeenCalled();
		expect(plugin.debug.events.find((event: any) => event.op === 'auto-projection-cancelled')).toBeTruthy();
	});

	it.each(['tier2TeardownInProgress', 'tier2Unloaded'])('does not access the database when %s begins during the wait', async (flag) => {
		const plugin = makePlugin();
		plugin.runProjection = jest.fn();
		mockWaitForTier2StartupReadiness.mockImplementation(async (_app, shouldCancel: () => boolean) => {
			plugin[flag] = true;
			return { pending: 1, checks: 1, elapsedMs: 100, timedOut: false, cancelled: shouldCancel() };
		});
		await plugin.autoProjectOnLayoutReady();
		expect(plugin.runProjection).not.toHaveBeenCalled();
	});

	it('proceeds to the strict projector after the readiness deadline and retains bounded real errors', async () => {
		const notice = jest.spyOn(obsidian, 'Notice').mockImplementation((() => ({})) as never);
		const plugin = makePlugin();
		const errors = Array.from({ length: 7 }, (_, index) => ({
			vault_path: `${index}-${'p'.repeat(300)}`,
			message: `${index}-${'m'.repeat(600)}`,
		}));
		mockWaitForTier2StartupReadiness.mockResolvedValue({
			pending: 2,
			checks: 121,
			elapsedMs: 12_008,
			timedOut: true,
			cancelled: false,
		});
		plugin.runProjection = jest.fn().mockResolvedValue(result({
			success: false,
			counts: { ...EMPTY_COUNTS, errors: 7 },
			errors,
		}));

		await plugin.autoProjectOnLayoutReady();
		expect(plugin.runProjection).toHaveBeenCalledTimes(1);
		const complete = plugin.debug.events.find((event: any) => event.op === 'auto-projection-complete') as any;
		expect(complete.success).toBe(false);
		expect(complete.aborted).toBe(false);
		expect(complete.counts.errors).toBe(7);
		expect(complete.readiness).toEqual({
			pending: 2,
			checks: 121,
			elapsedMs: 12_008,
			timedOut: true,
			cancelled: false,
		});
		expect(plugin.debug.warn).toHaveBeenCalledWith(
			'tier2',
			'auto-projection-readiness-timeout',
			'Tier 2 startup readiness deadline reached; running the strict projector',
			{ pending: 2, checks: 121, elapsedMs: 12_008, timedOut: true },
		);
		expect(complete.errorTotal).toBe(7);
		expect(complete.errorSamples).toHaveLength(5);
		expect(complete.errorSamplesTruncated).toBe(true);
		expect(complete.trace_id).toBe('startup-trace');
		// Control for the notice spy used below: real skipped notes do raise one.
		expect(notice).toHaveBeenCalledTimes(1);
		notice.mockRestore();
	});

	/** A vault mid-index: `indexed` fills in, and each resolved handler re-checks. */
	function indexingApp(paths: string[], indexed: Set<string>) {
		const files = paths.map((path) => ({ path }));
		const handlers: Array<() => void> = [];
		return {
			handlers,
			resolve: () => [...handlers].forEach((handler) => handler()),
			app: {
				vault: { getMarkdownFiles: () => files },
				metadataCache: {
					getFileCache: (file: { path: string }) => indexed.has(file.path) ? { frontmatter: {} } : null,
					on: (name: string, handler: () => void) => { if (name === 'resolved') handlers.push(handler); return { handler }; },
					offref: (ref: { handler: () => void }) => { const at = handlers.indexOf(ref.handler); if (at >= 0) handlers.splice(at, 1); },
				},
			},
		};
	}
	const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

	it('defers the full pass past the readiness deadline until indexing finishes, then projects once', async () => {
		const plugin = makePlugin();
		const indexed = new Set<string>(['a.md']);
		const vault = indexingApp(['a.md', 'b.md', 'c.md'], indexed);
		plugin.app = vault.app as any;
		mockWaitForTier2StartupReadiness
			.mockResolvedValueOnce({ pending: 2, checks: 121, elapsedMs: 12_008, timedOut: true, cancelled: false })
			.mockResolvedValueOnce({ pending: 0, checks: 1, elapsedMs: 0, timedOut: false, cancelled: false });
		plugin.runProjection = jest.fn().mockResolvedValue(result());

		const run = plugin.autoProjectOnLayoutReady();
		await tick(); await tick();
		expect(plugin.runProjection).not.toHaveBeenCalled();
		expect(plugin.debug.events.find((event: any) => event.op === 'auto-projection-deferred')).toMatchObject({ unindexed: 2 });

		indexed.add('b.md'); indexed.add('c.md'); vault.resolve();
		await run;
		expect(plugin.runProjection).toHaveBeenCalledTimes(1);
		expect(mockWaitForTier2StartupReadiness).toHaveBeenCalledTimes(2);
		expect(plugin.debug.warn).not.toHaveBeenCalledWith('tier2', 'auto-projection-readiness-timeout', expect.anything(), expect.anything());
		const complete = plugin.debug.events.find((event: any) => event.op === 'auto-projection-complete') as any;
		expect(complete).toMatchObject({ success: true, deferrals: 1, notIndexed: 0 });
	});

	it('stops a deferred wait without touching the database when the plugin unloads', async () => {
		const plugin = makePlugin();
		const vault = indexingApp(['a.md'], new Set());
		plugin.app = vault.app as any;
		mockWaitForTier2StartupReadiness.mockResolvedValueOnce({ pending: 1, checks: 121, elapsedMs: 12_008, timedOut: true, cancelled: false });
		plugin.runProjection = jest.fn();
		const run = plugin.autoProjectOnLayoutReady();
		await tick(); await tick();
		plugin.tier2Unloaded = true;
		vault.resolve();
		await run;
		expect(plugin.runProjection).not.toHaveBeenCalled();
		expect(plugin.debug.events.find((event: any) => event.op === 'auto-projection-cancelled')).toBeTruthy();
		expect(vault.handlers).toHaveLength(0);
	});

	it('reruns after a pass that met notes not indexed yet, and shows no skipped-notes notice', async () => {
		const notice = jest.spyOn(obsidian, 'Notice').mockImplementation((() => ({})) as never);
		const plugin = makePlugin();
		const indexed = new Set<string>(['a.md']);
		const vault = indexingApp(['a.md', 'b.md'], indexed);
		plugin.app = vault.app as any;
		plugin.runProjection = jest.fn()
			.mockResolvedValueOnce(result({ success: false, notIndexed: 1 }))
			.mockResolvedValueOnce(result());
		const run = plugin.autoProjectOnLayoutReady();
		await tick(); await tick();
		expect(plugin.runProjection).toHaveBeenCalledTimes(1);
		indexed.add('b.md'); vault.resolve();
		await run;
		expect(plugin.runProjection).toHaveBeenCalledTimes(2);
		const complete = plugin.debug.events.find((event: any) => event.op === 'auto-projection-complete') as any;
		expect(complete).toMatchObject({ success: true, deferrals: 1, errorTotal: 0 });
		expect(notice).not.toHaveBeenCalled();
		notice.mockRestore();
	});

	it('keeps one recovery trigger after the deferral cap and runs a complete pass once indexing is quiet', async () => {
		const plugin = makePlugin();
		const indexed = new Set<string>(['a.md', 'b.md']);
		const vault = indexingApp(['a.md', 'b.md'], indexed);
		plugin.app = vault.app as any;
		plugin.tier2RecoveryQuietMs = 5;
		plugin.tier2RecoveryPollMs = 60_000;
		const incomplete = result({ success: false, notIndexed: 1 });
		// Notes keep arriving: the startup pass and all five reruns are incomplete.
		plugin.runProjection = jest.fn().mockResolvedValue(incomplete);
		await plugin.autoProjectOnLayoutReady();
		expect(plugin.runProjection).toHaveBeenCalledTimes(6);
		expect(plugin.debug.warn).toHaveBeenCalledWith('tier2', 'auto-projection-recovery-armed', expect.any(String), expect.objectContaining({ deferrals: 5 }));
		expect(vault.handlers).toHaveLength(1);

		// A resolved event while notes are still pending does not run a pass.
		indexed.delete('b.md'); vault.resolve();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(plugin.runProjection).toHaveBeenCalledTimes(6);

		// Indexing settles: one quiet resolved event runs one complete pass and disarms.
		plugin.runProjection = jest.fn().mockResolvedValue(result({ counts: { ...EMPTY_COUNTS, concepts: 2 } }));
		indexed.add('b.md'); vault.resolve(); vault.resolve();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(plugin.runProjection).toHaveBeenCalledTimes(1);
		expect(plugin.debug.events.find((event: any) => event.op === 'auto-projection-recovery-complete')).toMatchObject({ success: true, notIndexed: 0 });
		expect(vault.handlers).toHaveLength(0);
	});

	it('re-arms recovery when the recovery pass is still incomplete, and unload disarms it', async () => {
		const plugin = makePlugin();
		const vault = indexingApp(['a.md'], new Set(['a.md']));
		plugin.app = vault.app as any;
		plugin.tier2RecoveryQuietMs = 5;
		plugin.runProjection = jest.fn().mockResolvedValue(result({ success: false, notIndexed: 1 }));
		await plugin.autoProjectOnLayoutReady();
		expect(vault.handlers).toHaveLength(1);
		vault.resolve();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(plugin.runProjection).toHaveBeenCalledTimes(7);
		expect(vault.handlers).toHaveLength(1);
		plugin.onunload();
		expect(vault.handlers).toHaveLength(0);
		vault.resolve();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(plugin.runProjection).toHaveBeenCalledTimes(7);
	});

	const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
	/** Exhaust the deferral cap so one recovery trigger is armed, with fast test timings. */
	async function armRecovery(timings: { quiet?: number; poll?: number; retry?: number } = {}) {
		const plugin = makePlugin();
		const vault = indexingApp(['a.md', 'b.md'], new Set(['a.md', 'b.md']));
		plugin.app = vault.app as any;
		plugin.tier2RecoveryQuietMs = timings.quiet ?? 50;
		plugin.tier2RecoveryPollMs = timings.poll ?? 200;
		plugin.tier2RecoveryRetryBaseMs = timings.retry ?? 30;
		plugin.runProjection = jest.fn().mockResolvedValue(result({ success: false, notIndexed: 1 }));
		await plugin.autoProjectOnLayoutReady();
		expect(plugin.runProjection).toHaveBeenCalledTimes(6);
		expect(vault.handlers).toHaveLength(1);
		return { plugin, vault };
	}
	const disarmed = (plugin: any, vault: { handlers: unknown[] }) => {
		expect(vault.handlers).toHaveLength(0);
		expect(plugin.tier2Recovery).toBeNull();
		expect(plugin.tier2RecoveryRetryTimer).toBeNull();
	};

	it('recovers within the poll window even when resolved events never stop', async () => {
		const { plugin, vault } = await armRecovery({ quiet: 50, poll: 200 });
		plugin.runProjection = jest.fn().mockResolvedValue(result());
		// Events every 20 ms, closer together than the 50 ms quiet window, for 600 ms.
		const stream = setInterval(() => vault.resolve(), 20);
		try {
			const started = Date.now();
			while (Date.now() - started < 600 && (plugin.runProjection as jest.Mock).mock.calls.length === 0) await sleep(10);
		} finally {
			clearInterval(stream);
		}
		expect(plugin.runProjection).toHaveBeenCalledTimes(1);
		await sleep(20);
		expect(plugin.debug.events.find((event: any) => event.op === 'auto-projection-recovery-complete')).toMatchObject({ success: true });
		disarmed(plugin, vault);
	});

	it('turning automatic indexing off mid-stream removes the listener and timers at once', async () => {
		const { plugin, vault } = await armRecovery({ quiet: 50, poll: 200 });
		const stream = setInterval(() => vault.resolve(), 20);
		try {
			await sleep(45);
			plugin.settings.enableTier2Projection = false;
			vault.resolve();
			disarmed(plugin, vault);
		} finally {
			clearInterval(stream);
		}
		await sleep(300);
		expect(plugin.runProjection).toHaveBeenCalledTimes(6);
	});

	it('saving the setting off disarms recovery without waiting for an event', async () => {
		const { plugin, vault } = await armRecovery();
		plugin.settings.enableTier2Projection = false;
		await plugin.saveSettings();
		disarmed(plugin, vault);
	});

	it('the reset command disarms recovery when teardown begins, and nothing runs after it', async () => {
		const { plugin, vault } = await armRecovery({ quiet: 20, poll: 100 });
		const sidecar = jest.requireMock('../src/tier2/sidecar') as { clearSidecar: jest.Mock };
		sidecar.clearSidecar.mockResolvedValueOnce({ hadPersistentStore: false, removed: [] });
		plugin.tier2Handle = null;
		await plugin.resetSearchData();
		disarmed(plugin, vault);
		expect(plugin.tier2TeardownInProgress).toBe(false);
		vault.resolve();
		await sleep(200);
		expect(plugin.runProjection).toHaveBeenCalledTimes(6);
	});

	/** Poll until `condition` holds, failing after `timeoutMs`. Keeps timing tests stable on a loaded host. */
	async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
		const started = Date.now();
		while (!condition()) {
			if (Date.now() - started > timeoutMs) throw new Error('condition not reached in time');
			await sleep(5);
		}
	}

	it('a failed recovery pass shows one plain notice, re-arms with backoff, and stops after three failures', async () => {
		const notice = jest.spyOn(obsidian, 'Notice').mockImplementation((() => ({})) as never);
		try {
			const { plugin, vault } = await armRecovery({ quiet: 10, poll: 60_000, retry: 100 });
			plugin.runProjection = jest.fn().mockRejectedValue(new Error('synthetic worker failure'));
			const runs = () => (plugin.runProjection as jest.Mock).mock.calls.length;

			vault.resolve();
			await until(() => notice.mock.calls.length === 1);
			expect(runs()).toBe(1);
			const first = notice.mock.calls[0][0] as unknown as string;
			expect(first).toContain('will try again');
			for (const forbidden of ['Tier 2', 'projection', 'synthetic worker failure', '\u2014']) expect(first).not.toContain(forbidden);
			// Not re-armed immediately: the retry waits for its backoff (100 ms).
			expect(vault.handlers).toHaveLength(0);
			expect(plugin.tier2RecoveryRetryTimer).not.toBeNull();
			let waitedFrom = Date.now();
			await until(() => vault.handlers.length === 1);
			expect(Date.now() - waitedFrom).toBeGreaterThanOrEqual(90);
			expect(notice).toHaveBeenCalledTimes(1);

			vault.resolve();
			await until(() => notice.mock.calls.length === 2);
			expect(runs()).toBe(2);
			// Second backoff doubles to 200 ms.
			waitedFrom = Date.now();
			await until(() => vault.handlers.length === 1);
			expect(Date.now() - waitedFrom).toBeGreaterThanOrEqual(190);

			vault.resolve();
			await until(() => notice.mock.calls.length === 3);
			expect(runs()).toBe(3);
			const last = notice.mock.calls[2][0] as unknown as string;
			expect(last).toContain('after several tries');
			expect(last).toContain('Reload Obsidian');
			disarmed(plugin, vault);
			vault.resolve();
			await sleep(300);
			expect(runs()).toBe(3);
			expect(notice).toHaveBeenCalledTimes(3);
			expect(plugin.debug.events.filter((event: any) => event.op === 'auto-projection-recovery-failed').map((event: any) => event.retry)).toEqual([true, true, false]);
		} finally {
			notice.mockRestore();
		}
	});

	it('a complete pass from any caller during backoff cancels the pending retry and resets the failure streak', async () => {
		const notice = jest.spyOn(obsidian, 'Notice').mockImplementation((() => ({})) as never);
		try {
			const plugin = makePlugin();
			const vault = indexingApp(['a.md'], new Set(['a.md']));
			plugin.app = vault.app as any;
			plugin.tier2RecoveryQuietMs = 10;
			plugin.tier2RecoveryPollMs = 60_000;
			plugin.tier2RecoveryRetryBaseMs = 150;
			// The class's own full pass, as another caller (e.g. a mapping conversion) would run it.
			const realRunProjection = plugin.runProjection;
			plugin.openTier2 = jest.fn().mockResolvedValue({ db: {} });
			plugin.runProjection = jest.fn().mockRejectedValue(new Error('synthetic worker failure'));
			plugin.armTier2ProjectionRecovery();
			vault.resolve();
			await until(() => notice.mock.calls.length === 1 && plugin.tier2RecoveryRetryTimer !== null);
			expect(plugin.tier2RecoveryFailures).toBe(1);

			// An incomplete pass ends the failure streak but keeps recovery pending.
			mockProjectFromTier1.mockResolvedValueOnce(result({ success: false, notIndexed: 1 }));
			await realRunProjection();
			expect(plugin.tier2RecoveryFailures).toBe(0);
			expect(plugin.tier2RecoveryRetryTimer).not.toBeNull();

			// A complete pass makes the pending retry moot.
			mockProjectFromTier1.mockResolvedValueOnce(result());
			await realRunProjection();
			expect(plugin.tier2RecoveryFailures).toBe(0);
			disarmed(plugin, vault);
			await sleep(250);
			vault.resolve();
			await sleep(50);
			expect(plugin.runProjection).toHaveBeenCalledTimes(1);
			expect(notice).toHaveBeenCalledTimes(1);
		} finally {
			notice.mockRestore();
		}
	});

	it('ends an open Connections window\'s indexing wait when the plugin unloads', async () => {
		const plugin = makePlugin();
		const vault = indexingApp(['a.md'], new Set());
		plugin.app = vault.app as any;
		const load = jest.spyOn(connectionsQuery, 'loadConnectionsSnapshot').mockRejectedValue(new VaultStillIndexingError());
		// Constructed exactly as the command does: the plugin is the host.
		const modal = new ConnectionsModal(plugin.app, plugin);
		const node: any = { createEl: jest.fn(() => node), createDiv: jest.fn(() => node), setText: jest.fn(), addEventListener: jest.fn(), addClass: jest.fn(), empty: jest.fn() };
		modal.contentEl = node;
		await (modal as unknown as { load(): Promise<void> }).load();
		await tick();
		expect(vault.handlers).toHaveLength(1);

		plugin.onunload();
		await tick();
		expect(vault.handlers).toHaveLength(0);
		expect(modal.close).toHaveBeenCalled();
		{
			vault.resolve();
			await tick();
		}
		expect(load).toHaveBeenCalledTimes(1);
		load.mockRestore();
	});

	it('retains aborted state without treating it as a failed automatic pass', async () => {
		const plugin = makePlugin();
		plugin.runProjection = jest.fn().mockResolvedValue(result({ aborted: true }));
		await plugin.autoProjectOnLayoutReady();
		const complete = plugin.debug.events.find((event: any) => event.op === 'auto-projection-complete') as any;
		expect(complete.success).toBe(true);
		expect(complete.aborted).toBe(true);
		expect(complete.errorTotal).toBe(0);
	});
});
