import type { App } from 'obsidian';

const STARTUP_DEADLINE_MS = 12_000;
const STARTUP_POLL_INTERVAL_MS = 100;
const MIN_POLL_INTERVAL_MS = 1;
const ERROR_SAMPLE_LIMIT = 5;
const ERROR_PATH_LIMIT = 256;
const ERROR_MESSAGE_LIMIT = 512;

export interface Tier2StartupReadinessResult {
	pending: number;
	checks: number;
	elapsedMs: number;
	timedOut: boolean;
	cancelled: boolean;
}

export interface Tier2StartupReadinessOptions {
	/** Test seam. Production is capped at the 12,000 ms intentional wait budget. */
	timeoutMs?: number;
	/** Test seam. Production polls every 100 ms; callers cannot exceed that interval. */
	pollIntervalMs?: number;
	/** Test seam for a monotonic clock. */
	now?: () => number;
}

/**
 * Count metadata-cache states that the existing full projector refuses to prune
 * through: no cache entry, or a known frontmatter block whose parsed value is
 * not available yet. The file list and cache are read fresh on every call.
 */
export function countTier2StartupPendingFiles(app: App): number {
	const getMarkdownFiles = app.vault?.getMarkdownFiles?.bind(app.vault);
	const getFileCache = app.metadataCache?.getFileCache?.bind(app.metadataCache);
	if (!getMarkdownFiles || !getFileCache) return 0;

	let pending = 0;
	for (const file of getMarkdownFiles()) {
		const cacheEntry = getFileCache(file);
		if (!cacheEntry) {
			pending += 1;
			continue;
		}
		const frontmatter = (cacheEntry as { frontmatter?: unknown }).frontmatter;
		const hasUnparsedFrontmatter = Boolean(
			(cacheEntry as { frontmatterPosition?: unknown }).frontmatterPosition,
		) && (!frontmatter || typeof frontmatter !== 'object');
		if (hasUnparsedFrontmatter) pending += 1;
	}
	return pending;
}

/**
 * Poll the projector's exact readiness predicate until it is true or the
 * intentional waiting budget expires. Timer/event completion is never treated
 * as readiness: every answer follows a fresh full predicate evaluation.
 */
export async function waitForTier2StartupReadiness(
	app: App,
	shouldCancel: () => boolean,
	options: Tier2StartupReadinessOptions = {},
): Promise<Tier2StartupReadinessResult> {
	if (shouldCancel()) return cancelledReadiness(0, 0, 0);

	const timeoutMs = normalizeTimeout(options.timeoutMs);
	const pollIntervalMs = normalizePollInterval(options.pollIntervalMs);
	const now = options.now ?? defaultMonotonicNow();
	const startedAt = now();
	let checks = 1;
	let pending = countTier2StartupPendingFiles(app);
	let elapsedMs = elapsedSince(startedAt, now);

	if (shouldCancel()) return cancelledReadiness(pending, checks, elapsedMs);
	if (pending === 0) return readyReadiness(checks, elapsedMs);
	if (elapsedMs >= timeoutMs) return timedOutReadiness(pending, checks, elapsedMs);

	while (true) {
		const remainingMs = timeoutMs - elapsedMs;
		if (remainingMs <= 0) return timedOutReadiness(pending, checks, elapsedMs);

		await wait(Math.min(pollIntervalMs, remainingMs));
		if (shouldCancel()) {
			return cancelledReadiness(pending, checks, elapsedSince(startedAt, now));
		}

		pending = countTier2StartupPendingFiles(app);
		checks += 1;
		elapsedMs = elapsedSince(startedAt, now);
		if (shouldCancel()) return cancelledReadiness(pending, checks, elapsedMs);
		if (pending === 0) return readyReadiness(checks, elapsedMs);
		if (elapsedMs >= timeoutMs) return timedOutReadiness(pending, checks, elapsedMs);
	}
}

function defaultMonotonicNow(): () => number {
	const performanceApi = globalThis.performance;
	if (performanceApi && typeof performanceApi.now === 'function') {
		// Some hosts require `performance.now` to retain its receiver.
		return performanceApi.now.bind(performanceApi);
	}
	return Date.now;
}

function normalizeTimeout(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return STARTUP_DEADLINE_MS;
	return Math.min(STARTUP_DEADLINE_MS, Math.max(0, value));
}

function normalizePollInterval(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return STARTUP_POLL_INTERVAL_MS;
	return Math.min(STARTUP_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, value));
}

function elapsedSince(startedAt: number, now: () => number): number {
	return Math.max(0, now() - startedAt);
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function readyReadiness(checks: number, elapsedMs: number): Tier2StartupReadinessResult {
	return { pending: 0, checks, elapsedMs, timedOut: false, cancelled: false };
}

function timedOutReadiness(
	pending: number,
	checks: number,
	elapsedMs: number,
): Tier2StartupReadinessResult {
	return { pending, checks, elapsedMs, timedOut: true, cancelled: false };
}

function cancelledReadiness(
	pending: number,
	checks: number,
	elapsedMs: number,
): Tier2StartupReadinessResult {
	return { pending, checks, elapsedMs, timedOut: false, cancelled: true };
}

export interface ProjectionErrorDiagnostics {
	errorTotal: number;
	errorSamples: Array<{ vault_path: string; message: string }>;
	errorSamplesTruncated: boolean;
}

/** Keep automatic-startup diagnostics useful without copying unbounded values. */
export function projectionErrorDiagnostics(
	errors: ReadonlyArray<{ vault_path: string; message: string }>,
): ProjectionErrorDiagnostics {
	let truncated = errors.length > ERROR_SAMPLE_LIMIT;
	const errorSamples = errors.slice(0, ERROR_SAMPLE_LIMIT).map((error) => {
		if (error.vault_path.length > ERROR_PATH_LIMIT || error.message.length > ERROR_MESSAGE_LIMIT) {
			truncated = true;
		}
		return {
			vault_path: error.vault_path.slice(0, ERROR_PATH_LIMIT),
			message: error.message.slice(0, ERROR_MESSAGE_LIMIT),
		};
	});
	return {
		errorTotal: errors.length,
		errorSamples,
		errorSamplesTruncated: truncated,
	};
}
