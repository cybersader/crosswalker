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
	toMinimalNode: jest.fn(),
}));
jest.mock('../src/views/recipe-picker-modal', () => ({ RecipePickerModal: class {} }));
jest.mock('../src/views/evidence-link-modal', () => ({ EvidenceLinkModal: class {} }));

import CrosswalkerPlugin from '../src/main';

const EMPTY_COUNTS = {
	concepts: 0,
	mappings: 0,
	junction_notes: 0,
	ontologies: 0,
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
