/**
 * DebugLog — wide structured events with trace correlation (Phase 3.5).
 *
 * Storage: NDJSON. One JSON object per line in `crosswalker-debug.log` at vault
 * root. Designed for agents (Claude Code sessions diagnosing user-reported bugs
 * via `cat | jq` and grep). Humans can `cat | jq` or open the file in any
 * editor; an in-Obsidian viewer is intentionally out of scope.
 *
 * Event schema (every line):
 *   {
 *     ts: ISO-8601 UTC,
 *     level: 'error' | 'warn' | 'info' | 'trace',
 *     category: string,        // subsystem (e.g. 'generation', 'wizard', 'tier2')
 *     op: string,              // operation slug (e.g. 'row-error', 'starting')
 *     msg: string,             // short human-readable message
 *     trace_id?: hex,          // shared across all events in one user action
 *     span_id?: hex,           // this event's span
 *     parent_span_id?: hex,    // for nesting
 *     duration_ms?: number,    // emitted on span-end events
 *     ...freeform context
 *   }
 *
 * Trace propagation is explicit (no AsyncLocalStorage). Top-level user actions
 * call `withTrace(id, fn)` to set the current trace_id for the duration of fn;
 * `span()` auto-emits start + end events with parent_span_id from the
 * surrounding span (if any).
 *
 * Backward-compat: `.log()` and `.error()` keep working during the migration.
 * They emit NDJSON events with category='legacy'. Phase 3.5c will sweep them.
 */

import { App, TFile } from 'obsidian';

// ---------------------------------------------------------------------------
// Event schema
// ---------------------------------------------------------------------------

export type DebugLevel = 'error' | 'warn' | 'info' | 'trace';

/** Severity ranking, most severe first. Used for minLevel filtering. */
const LEVEL_RANK: Record<DebugLevel, number> = { error: 3, warn: 2, info: 1, trace: 0 };

export interface DebugEvent {
	ts: string;
	level: DebugLevel;
	category: string;
	op: string;
	msg: string;
	trace_id?: string;
	span_id?: string;
	parent_span_id?: string;
	duration_ms?: number;
	[key: string]: unknown;
}

export interface SpanContext {
	span_id: string;
	trace_id: string | undefined;
	event(op: string, msg: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Rotation tuning
// ---------------------------------------------------------------------------

// Size-based rotation: crosswalker-debug.log is checked before every append
// (maybeRotate, cheap TFile.stat read). Once it crosses MAX_LOG_BYTES, the
// chain shifts down (.log→.1, .1→.2, .2→.3) and the oldest rotation
// (.MAX_ROTATIONS) is deleted (see rotate()). Total on-disk cap is
// MAX_LOG_BYTES * (MAX_ROTATIONS + 1) — 20 MB at current settings — bounded
// regardless of how long debug logging stays on.
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB per file
const MAX_ROTATIONS = 3;                // .log + .1 + .2 + .3 = 20 MB max

// ---------------------------------------------------------------------------
// In-memory ring buffer
// ---------------------------------------------------------------------------

// Kept regardless of whether file logging (`enabled`) is on, so a diagnostics
// bundle can always be assembled — even for users who never opted into the
// log file. Bounded so long sessions don't grow memory unbounded.
const RING_BUFFER_CAP = 500;

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
	/\b(sk-|ghp_|ghs_|gho_|github_pat_|pat-|xox[abps]-|AKIA|AIza)[A-Za-z0-9_/+-]{10,}\b/g,
	/\b[A-Za-z0-9_-]{60,}\b/g, // long opaque tokens (JWT-like)
];

function redactSecrets(s: string): string {
	let out = s;
	for (const re of SECRET_PATTERNS) {
		out = out.replace(re, '[REDACTED]');
	}
	return out;
}

// ---------------------------------------------------------------------------
// Hex ID generation
// ---------------------------------------------------------------------------

/** Drop undefined-valued keys so NDJSON lines (and ring-buffer copies) stay tight. */
function stripUndefined(event: DebugEvent): DebugEvent {
	const cleaned: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(event)) {
		if (v !== undefined) cleaned[k] = v;
	}
	return cleaned as DebugEvent;
}

/** Monotonic-ish clock for perf timers; falls back to Date.now() if unavailable. */
function now(): number {
	return typeof performance !== 'undefined' && typeof performance.now === 'function'
		? performance.now()
		: Date.now();
}

function randHex(bytes: number): string {
	// 4 bytes → 8 hex chars; collision-resistant enough for trace/span IDs
	// within one plugin session.
	let out = '';
	for (let i = 0; i < bytes; i++) {
		out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
	}
	return out;
}

// ---------------------------------------------------------------------------
// DebugLog
// ---------------------------------------------------------------------------

export class DebugLog {
	private app: App;
	private enabled: boolean;
	private verbose: boolean;
	private categoryFilters: Record<string, boolean>;
	private minLevel: DebugLevel;
	private logPath = 'crosswalker-debug.log';

	// One id per plugin load, so every event in a session (file-logged or
	// ring-buffer-only) can be correlated back to a single Obsidian session
	// when a user attaches a diagnostics bundle to a bug report.
	private readonly sessionId: string;

	// Last RING_BUFFER_CAP events, newest last. Populated unconditionally
	// (independent of `enabled`) — see RING_BUFFER_CAP comment above.
	private ringBuffer: DebugEvent[] = [];

	// Trace + span context (stack-based; safe for sequential async; not
	// concurrent-safe, but Crosswalker has no concurrent top-level imports).
	private currentTrace: string | undefined;
	private currentSpan: string | undefined;

	// Serialized write queue prevents interleaved partial writes when many
	// events fire in quick succession.
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(
		app: App,
		enabled = false,
		verbose = false,
		categoryFilters: Record<string, boolean> = {},
		minLevel: DebugLevel = 'trace',
	) {
		this.app = app;
		this.enabled = enabled;
		this.verbose = verbose;
		this.categoryFilters = categoryFilters;
		this.minLevel = minLevel;
		this.sessionId = randHex(4);
	}

	// -----------------------------------------------------------------------
	// Configuration
	// -----------------------------------------------------------------------

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	setVerbose(verbose: boolean): void {
		this.verbose = verbose;
	}

	setCategoryFilters(filters: Record<string, boolean>): void {
		this.categoryFilters = filters;
	}

	/**
	 * Minimum severity written to the log file. Independent of `verbose`
	 * (which specifically gates 'trace') — e.g. minLevel='warn' silences
	 * 'info' events too, for a quieter file while still catching problems.
	 * Does not affect the in-memory ring buffer or console mirror, which
	 * always capture every level.
	 */
	setMinLevel(level: DebugLevel): void {
		this.minLevel = level;
	}

	/**
	 * One id generated at construction time (one per plugin load). Included
	 * on every event (file-logged or ring-buffer-only) so a bug report can
	 * be correlated to a single session.
	 */
	getSessionId(): string {
		return this.sessionId;
	}

	/**
	 * Last `maxEntries` events (default: everything currently buffered, up to
	 * RING_BUFFER_CAP). Populated regardless of file logging being enabled —
	 * this is what powers "Copy diagnostics" for users who never turned on
	 * the log file.
	 */
	getRingBuffer(maxEntries?: number): DebugEvent[] {
		if (maxEntries === undefined || maxEntries >= this.ringBuffer.length) {
			return [...this.ringBuffer];
		}
		return this.ringBuffer.slice(this.ringBuffer.length - maxEntries);
	}

	// -----------------------------------------------------------------------
	// Performance timers
	// -----------------------------------------------------------------------

	/**
	 * Start a timer for a heavy operation. Call `.end()` when it finishes to
	 * emit an 'info' event with `duration_ms`. Wrapper-compatible: callers
	 * that never call `.end()` simply never emit (no timers/intervals held).
	 *
	 *   const t = debug.time('generation', 'render-all-rows');
	 *   ...
	 *   t.end({ rowCount });
	 */
	time(category: string, label: string, data?: Record<string, unknown>): { end: (extra?: Record<string, unknown>) => number } {
		const start = now();
		return {
			end: (extra?: Record<string, unknown>): number => {
				const duration_ms = Math.round(now() - start);
				this.info(category, label, `${label} took ${duration_ms}ms`, { duration_ms, ...data, ...extra });
				return duration_ms;
			},
		};
	}

	// -----------------------------------------------------------------------
	// Trace + span context (explicit propagation)
	// -----------------------------------------------------------------------

	newTraceId(): string {
		return randHex(4);
	}

	/**
	 * Set the current trace_id for the duration of `fn`. Restores the previous
	 * trace_id afterward. Sync- and async-safe for sequential code.
	 */
	async withTrace<T>(traceId: string, fn: () => Promise<T> | T): Promise<T> {
		const prev = this.currentTrace;
		this.currentTrace = traceId;
		try {
			return await fn();
		} finally {
			this.currentTrace = prev;
		}
	}

	/**
	 * Get the current trace_id (or undefined if not inside withTrace).
	 */
	currentTraceId(): string | undefined {
		return this.currentTrace;
	}

	/**
	 * Wrap an async operation in a span. Auto-emits start + end events with
	 * duration_ms. The end event becomes a 'span-end' op with the original op
	 * as suffix; the start event uses op as-is. If `fn` throws, the end event
	 * is emitted at 'error' level with error_class + error_message.
	 *
	 * The SpanContext passed to fn lets you emit child events that share this
	 * span's ID.
	 */
	async span<T>(
		category: string,
		op: string,
		fn: (ctx: SpanContext) => Promise<T>,
		data?: Record<string, unknown>,
	): Promise<T> {
		const span_id = randHex(4);
		const parent_span_id = this.currentSpan;
		const startTs = Date.now();

		this.recordAndMaybeWrite({
			ts: new Date().toISOString(),
			level: 'info',
			category,
			op: `${op}/start`,
			msg: `${category}.${op} starting`,
			trace_id: this.currentTrace,
			span_id,
			parent_span_id,
			...data,
		});

		const prevSpan = this.currentSpan;
		this.currentSpan = span_id;
		try {
			const ctx: SpanContext = {
				span_id,
				trace_id: this.currentTrace,
				event: (childOp, childMsg, childData) => {
					this.recordAndMaybeWrite({
						ts: new Date().toISOString(),
						level: 'info',
						category,
						op: `${op}/${childOp}`,
						msg: childMsg,
						trace_id: this.currentTrace,
						span_id,
						...childData,
					});
				},
			};
			const result = await fn(ctx);
			this.recordAndMaybeWrite({
				ts: new Date().toISOString(),
				level: 'info',
				category,
				op: `${op}/end`,
				msg: `${category}.${op} complete`,
				trace_id: this.currentTrace,
				span_id,
				parent_span_id,
				duration_ms: Date.now() - startTs,
			});
			return result;
		} catch (err) {
			this.recordAndMaybeWrite({
				ts: new Date().toISOString(),
				level: 'error',
				category,
				op: `${op}/end`,
				msg: `${category}.${op} failed`,
				trace_id: this.currentTrace,
				span_id,
				parent_span_id,
				duration_ms: Date.now() - startTs,
				error_class: err instanceof Error ? err.constructor.name : typeof err,
				error_message: err instanceof Error ? err.message : String(err),
				...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
			});
			throw err;
		} finally {
			this.currentSpan = prevSpan;
		}
	}

	// -----------------------------------------------------------------------
	// Severity methods (preferred API)
	// -----------------------------------------------------------------------

	info(category: string, op: string, msg: string, data?: Record<string, unknown>): void {
		this.emit('info', category, op, msg, data);
	}

	warn(category: string, op: string, msg: string, data?: Record<string, unknown>): void {
		this.emit('warn', category, op, msg, data);
	}

	error(category: string, op: string, msg: string, data?: Record<string, unknown>): void {
		this.emit('error', category, op, msg, data);
	}

	trace(category: string, op: string, msg: string, data?: Record<string, unknown>): void {
		this.emit('trace', category, op, msg, data);
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	async clear(): Promise<void> {
		try {
			const file = this.app.vault.getAbstractFileByPath(this.logPath);
			if (file instanceof TFile) {
				await this.app.vault.modify(file, '');
			}
		} catch (err) {
			console.error('[Crosswalker] Failed to clear debug log:', err);
		}
	}

	async delete(): Promise<void> {
		try {
			const file = this.app.vault.getAbstractFileByPath(this.logPath);
			if (file instanceof TFile) {
				await this.app.vault.delete(file);
			}
		} catch (err) {
			console.error('[Crosswalker] Failed to delete debug log:', err);
		}
	}

	/**
	 * Return the path the debug log lives at (vault-relative).
	 */
	getLogPath(): string {
		return this.logPath;
	}

	/**
	 * Read up to `maxBytes` (tail) of the current log file, redact secrets AND
	 * vault paths/file names, and return the string. For the "Export debug log
	 * to clipboard" command (Settings → Diagnostics).
	 *
	 * B4 (2026-07-12 pre-merge review): this is the older, more prominently
	 * surfaced export path — most users find it before "Copy diagnostics" —
	 * and it previously only ran `redactSecrets` (API-key/JWT patterns),
	 * leaking raw vault-relative paths and file names (which can carry
	 * sensitive compliance-framework/document names) into a bundle a user
	 * pastes into a public bug report. Now routes through the SAME
	 * `redactEvent`/`redactPathsAndFilenames` machinery the newer "Copy
	 * diagnostics" command uses, so both commands make the same "no vault
	 * paths or file names" promise.
	 */
	async readForExport(maxBytes = 1024 * 1024): Promise<string> {
		try {
			const file = this.app.vault.getAbstractFileByPath(this.logPath);
			if (!(file instanceof TFile)) return '';
			const content = await this.app.vault.read(file);
			const tail = content.length > maxBytes
				? content.slice(content.length - maxBytes)
				: content;
			return redactExportedLog(tail);
		} catch (err) {
			console.error('[Crosswalker] Failed to read debug log:', err);
			return '';
		}
	}

	// -----------------------------------------------------------------------
	// Internal: event emission + write queue + rotation
	// -----------------------------------------------------------------------

	private emit(
		level: DebugLevel,
		category: string,
		op: string,
		msg: string,
		data?: Record<string, unknown>,
	): void {
		this.recordAndMaybeWrite({
			ts: new Date().toISOString(),
			level,
			category,
			op,
			msg,
			trace_id: this.currentTrace,
			span_id: this.currentSpan,
			...data,
		});
	}

	private shouldEmitCategory(category: string): boolean {
		// Per-category opt-out (TaskNotes pattern). Default: emit all.
		return this.categoryFilters[category] !== false;
	}

	/**
	 * Single choke point for every event, whether it came from a severity
	 * method (info/warn/error/trace) or a span. Order matters:
	 *   1. Tag with session_id.
	 *   2. Push to the in-memory ring buffer — unconditional, so diagnostics
	 *      work even with file logging off.
	 *   3. Mirror to console — unconditional, matches the pre-ring-buffer
	 *      behavior (helps when the log file is disabled).
	 *   4. Write to the log file — gated on enabled + minLevel + (trace ⇒
	 *      verbose) + category filter.
	 */
	private recordAndMaybeWrite(event: DebugEvent): void {
		const full: DebugEvent = { ...event, session_id: this.sessionId };

		const cleaned = stripUndefined(full);
		this.ringBuffer.push(cleaned);
		if (this.ringBuffer.length > RING_BUFFER_CAP) {
			this.ringBuffer.shift();
		}

		const { ts: _ts, level: _level, category: _category, op: _op, msg: _msg, session_id: _sid, ...rest } = cleaned;
		void _ts; void _level; void _category; void _op; void _msg; void _sid;
		const consoleArgs: unknown[] = [`[Crosswalker:${cleaned.level}] ${cleaned.category}/${cleaned.op}: ${cleaned.msg}`];
		if (Object.keys(rest).length > 0) consoleArgs.push(rest);
		if (cleaned.level === 'error') {
			console.error(...consoleArgs);
		} else if (cleaned.level === 'warn') {
			console.warn(...consoleArgs);
		} else {
			console.log(...consoleArgs);
		}

		if (!this.enabled) return;
		if (cleaned.level === 'trace' && !this.verbose) return;
		if (LEVEL_RANK[cleaned.level] < LEVEL_RANK[this.minLevel]) return;
		if (!this.shouldEmitCategory(cleaned.category)) return;

		this.write(cleaned);
	}

	private write(event: DebugEvent): void {
		// Already stripped of undefined fields by recordAndMaybeWrite; stripping
		// again here is a cheap no-op safeguard for any future direct caller.
		const cleaned = stripUndefined(event);
		const line = JSON.stringify(cleaned) + '\n';

		// Serialize via promise chain — fire-and-forget but ordered
		this.writeQueue = this.writeQueue
			.then(() => this.appendLine(line))
			.catch((err) => {
				console.error('[Crosswalker] Failed to write debug log:', err);
			});
	}

	private async appendLine(line: string): Promise<void> {
		// Rotate first if needed (cheap stat check)
		await this.maybeRotate();
		// Use adapter.append for O(1) appends (vs vault.read + vault.modify O(n)).
		await this.app.vault.adapter.append(this.logPath, line);
	}

	private async maybeRotate(): Promise<void> {
		try {
			const file = this.app.vault.getAbstractFileByPath(this.logPath);
			if (!(file instanceof TFile)) return;
			if (file.stat.size < MAX_LOG_BYTES) return;
			await this.rotate();
		} catch (err) {
			console.error('[Crosswalker] Failed to check log rotation:', err);
		}
	}

	private async rotate(): Promise<void> {
		// Drop oldest rotation if it exists
		const oldest = this.app.vault.getAbstractFileByPath(`${this.logPath}.${MAX_ROTATIONS}`);
		if (oldest instanceof TFile) {
			await this.app.vault.delete(oldest);
		}
		// Shift .N-1 → .N, .N-2 → .N-1, ..., .1 → .2 (in reverse so no clobber)
		for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
			const src = this.app.vault.getAbstractFileByPath(`${this.logPath}.${i}`);
			if (src instanceof TFile) {
				await this.app.vault.rename(src, `${this.logPath}.${i + 1}`);
			}
		}
		// .log → .1
		const current = this.app.vault.getAbstractFileByPath(this.logPath);
		if (current instanceof TFile) {
			await this.app.vault.rename(current, `${this.logPath}.1`);
		}
	}

	// -----------------------------------------------------------------------
	// Diagnostics bundle ("Copy diagnostics" in Settings → Diagnostics)
	// -----------------------------------------------------------------------

	/**
	 * Assemble a redacted, shareable diagnostics bundle for bug reports.
	 * Pulls from the in-memory ring buffer (works even with file logging
	 * off) plus environment info and a redacted settings snapshot supplied
	 * by the caller (settings-tab.ts owns reading plugin/app version info —
	 * this class only knows about its own events).
	 */
	assembleDiagnostics(input: {
		pluginVersion: string;
		obsidianVersion: string;
		platform: string;
		/** Where the search index lives this session (W5), when known. */
		searchIndex?: string;
		settings: Record<string, unknown>;
		maxRecentEvents?: number;
	}): string {
		return buildDiagnosticsBundle({
			...input,
			sessionId: this.sessionId,
			ringBuffer: this.ringBuffer,
		});
	}
}

// ---------------------------------------------------------------------------
// Diagnostics bundle redaction
// ---------------------------------------------------------------------------
//
// Rule: the bundle never includes vault paths, file names from the user's
// vault, or cell values — counts and shapes only. Two layers:
//   1. Key-based: any key that looks like it holds a path/file/folder is
//      replaced outright.
//   2. Value-based: every remaining string (including free-text `msg`
//      fields, which sometimes interpolate a file name inline) is scrubbed
//      of path- and filename-shaped substrings as defense in depth.

const WINPATH_RE = /[A-Za-z]:\\(?:[^\s"'<>|*?]+\\)*[^\s"'<>|*?]*/g;
const UNIXPATH_RE = /(?:\/[^\s"'<>]+){2,}/g;
const FILENAME_RE = /\b[\w][\w\-. ]{0,80}\.(csv|xlsx|xls|json|md|markdown|txt|sqlite|db|log|yaml|yml)\b/gi;
const REDACT_KEY_RE = /(path|file|folder|dir)/i;
const MAX_REDACT_DEPTH = 3;
const MAX_ARRAY_ITEMS = 20;

/** Scrub filesystem/vault paths and bare filenames out of a free-text string. */
export function redactPathsAndFilenames(input: string): string {
	return input
		.replace(WINPATH_RE, '[path]')
		.replace(UNIXPATH_RE, '[path]')
		.replace(FILENAME_RE, '[file]');
}

function redactValue(key: string, value: unknown, depth: number): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === 'string') {
		return REDACT_KEY_RE.test(key) ? '[redacted]' : redactPathsAndFilenames(value);
	}
	if (typeof value === 'number' || typeof value === 'boolean') return value;
	if (Array.isArray(value)) {
		if (depth >= MAX_REDACT_DEPTH) return `[array:${value.length}]`;
		const items = value.slice(0, MAX_ARRAY_ITEMS).map((v) => redactValue(key, v, depth + 1));
		return value.length > MAX_ARRAY_ITEMS ? [...items, `…${value.length - MAX_ARRAY_ITEMS} more`] : items;
	}
	if (typeof value === 'object') {
		if (depth >= MAX_REDACT_DEPTH) return '[nested]';
		return redactObject(value as Record<string, unknown>, depth + 1);
	}
	return '[unsupported]';
}

function redactObject(obj: Record<string, unknown>, depth: number): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		out[k] = redactValue(k, v, depth);
	}
	return out;
}

/** Redact one debug event for inclusion in a shareable diagnostics bundle. */
export function redactEvent(event: DebugEvent): DebugEvent {
	return redactObject(event as unknown as Record<string, unknown>, 0) as unknown as DebugEvent;
}

/**
 * Redact a raw NDJSON log tail (the shape `readForExport` reads off disk) for
 * the "Export debug log to clipboard" command — B4 fix, 2026-07-12 pre-merge
 * review. Each line is parsed as one JSON event and run through `redactEvent`
 * (the same structured, key + value aware redaction "Copy diagnostics" uses),
 * then re-serialized. A line that fails to parse — e.g. a partial line cut
 * off by the `maxBytes` tail truncation, or stray non-JSON content — falls
 * back to the raw regex-based `redactPathsAndFilenames` pass so nothing
 * slips through unredacted just because it didn't parse cleanly. A final
 * `redactSecrets` pass over the whole result catches API-key/JWT-shaped
 * tokens that `redactEvent`'s path/filename patterns don't target.
 */
export function redactExportedLog(raw: string): string {
	const lines = raw.split('\n').map((line) => {
		if (line.trim() === '') return line;
		try {
			const parsed = JSON.parse(line) as DebugEvent;
			return JSON.stringify(redactEvent(parsed));
		} catch {
			return redactPathsAndFilenames(line);
		}
	});
	return redactSecrets(lines.join('\n'));
}

// Settings fields that are user-chosen paths or free text rather than
// counts/enums/flags; collapsed to a customized/default flag instead of
// their literal value.
const SETTINGS_PATH_KEYS = new Set(['defaultOutputPath', 'tier2SidecarPath', 'customLinkNamespace']);

/**
 * Redact a settings object for inclusion in a shareable diagnostics bundle.
 * Counts and flags only — no vault paths or other user-chosen free text.
 */
export function redactSettingsSnapshot(settings: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(settings)) {
		if (k === 'savedConfigs' && Array.isArray(v)) {
			out.savedConfigsCount = v.length;
			continue;
		}
		if (SETTINGS_PATH_KEYS.has(k)) {
			out[k] = typeof v === 'string' && v.trim().length > 0 ? '[custom]' : '[default]';
			continue;
		}
		out[k] = redactValue(k, v, 0);
	}
	return out;
}

/** Find the most recent event matching category+op (e.g. "last import summary"). */
export function findLastEvent(events: DebugEvent[], category: string, op: string): DebugEvent | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].category === category && events[i].op === op) return events[i];
	}
	return undefined;
}

export interface DiagnosticsBundleInput {
	pluginVersion: string;
	obsidianVersion: string;
	platform: string;
	/** Where the search index lives this session (W5), when known. */
	searchIndex?: string;
	sessionId: string;
	settings: Record<string, unknown>;
	ringBuffer: DebugEvent[];
	maxRecentEvents?: number;
}

/** Assemble a redacted, shareable diagnostics bundle for bug reports. */
export function buildDiagnosticsBundle(input: DiagnosticsBundleInput): string {
	const maxRecent = input.maxRecentEvents ?? 100;
	const recentEvents = input.ringBuffer.slice(-maxRecent).map(redactEvent);
	const lastImportSummary = findLastEvent(input.ringBuffer, 'wizard', 'generate-complete');

	const bundle = {
		generated_at: new Date().toISOString(),
		session_id: input.sessionId,
		plugin_version: input.pluginVersion,
		obsidian_version: input.obsidianVersion,
		platform: input.platform,
		...(input.searchIndex ? { search_index: input.searchIndex } : {}),
		settings: redactSettingsSnapshot(input.settings),
		last_import_summary: lastImportSummary ? redactEvent(lastImportSummary) : null,
		recent_events: recentEvents,
	};
	return JSON.stringify(bundle, null, 2);
}
