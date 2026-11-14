/**
 * debug-log.test.ts — Jest tests for the Phase 3.5 wide-event logger.
 *
 * Verifies the NDJSON event schema, severity routing, trace + span context,
 * category filtering, and rotation triggering.
 */

import { DebugLog, type DebugEvent } from '../src/utils/debug';
import { TFile } from 'obsidian';

// ---------------------------------------------------------------------------
// Mock vault adapter — captures every `append()` call as one log line.
// ---------------------------------------------------------------------------

interface MockVaultState {
	lines: string[];
	files: Map<string, { size: number; content: string }>;
}

function createMockApp(state: MockVaultState) {
	const adapter = {
		append: jest.fn(async (path: string, line: string) => {
			state.lines.push(line);
			const existing = state.files.get(path);
			if (existing) {
				existing.content += line;
				existing.size = Buffer.byteLength(existing.content, 'utf8');
			} else {
				state.files.set(path, {
					size: Buffer.byteLength(line, 'utf8'),
					content: line,
				});
			}
		}),
	};

	const vault = {
		adapter,
		getAbstractFileByPath: jest.fn((path: string) => {
			const meta = state.files.get(path);
			if (!meta) return null;
			const f = Object.create(TFile.prototype);
			f.path = path;
			f.stat = { size: meta.size };
			return f as TFile;
		}),
		read: jest.fn(async (file: TFile) => {
			return state.files.get(file.path)?.content ?? '';
		}),
		modify: jest.fn(async (file: TFile, content: string) => {
			state.files.set(file.path, { size: Buffer.byteLength(content, 'utf8'), content });
		}),
		delete: jest.fn(async (file: TFile) => {
			state.files.delete(file.path);
		}),
		rename: jest.fn(async (file: TFile, newPath: string) => {
			const meta = state.files.get(file.path);
			if (meta) {
				state.files.set(newPath, meta);
				state.files.delete(file.path);
			}
		}),
	};

	return { vault } as never;
}

async function flushQueue(d: DebugLog) {
	// Force the internal write queue to settle. Drains microtasks, then the
	// promise-chain `writeQueue` field. Doing this multiple times handles
	// queued writes that themselves enqueue follow-up work.
	for (let i = 0; i < 5; i++) {
		const wq = (d as unknown as { writeQueue: Promise<void> }).writeQueue;
		if (wq) await wq;
		await new Promise<void>((r) => setTimeout(r, 0));
	}
}

function parseLines(lines: string[]): DebugEvent[] {
	return lines.map((l) => JSON.parse(l.trim()));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DebugLog — NDJSON event schema', () => {
	it('info() writes one valid JSON line with required fields', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		d.info('generation', 'starting', 'Starting generation', { row_count: 12 });
		await flushQueue(d);
		expect(state.lines).toHaveLength(1);
		const ev = JSON.parse(state.lines[0]);
		expect(ev.level).toBe('info');
		expect(ev.category).toBe('generation');
		expect(ev.op).toBe('starting');
		expect(ev.msg).toBe('Starting generation');
		expect(ev.row_count).toBe(12);
		expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(Number.isFinite(new Date(ev.ts).getTime())).toBe(true);
	});

	it('writes nothing when disabled', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), false);
		d.info('generation', 'x', 'y');
		await flushQueue(d);
		expect(state.lines).toHaveLength(0);
	});

	it('strips undefined fields from the line', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		d.info('test', 'op', 'msg'); // no data → no trace_id/span_id keys
		await flushQueue(d);
		const ev = JSON.parse(state.lines[0]);
		expect('trace_id' in ev).toBe(false);
		expect('span_id' in ev).toBe(false);
	});
});

describe('DebugLog — severity levels + verbose gating', () => {
	it('writes error/warn/info by default; gates trace until verbose=true', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		d.error('test', 'op', 'an error');
		d.warn('test', 'op', 'a warning');
		d.info('test', 'op', 'an info');
		d.trace('test', 'op', 'a trace'); // suppressed: verbose=false
		await flushQueue(d);
		expect(parseLines(state.lines).map((e) => e.level)).toEqual(['error', 'warn', 'info']);
	});

	it('emits trace events when setVerbose(true)', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		d.setVerbose(true);
		d.trace('test', 'op', 'verbose trace');
		await flushQueue(d);
		expect(state.lines).toHaveLength(1);
		expect(JSON.parse(state.lines[0]).level).toBe('trace');
	});
});

describe('DebugLog — trace context', () => {
	it('withTrace() tags events emitted inside its callback', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		const traceId = d.newTraceId();
		await d.withTrace(traceId, () => {
			d.info('gen', 'a', 'inside');
			d.info('gen', 'b', 'also inside');
		});
		d.info('gen', 'c', 'after withTrace');
		await flushQueue(d);
		const events = parseLines(state.lines);
		expect(events[0].trace_id).toBe(traceId);
		expect(events[1].trace_id).toBe(traceId);
		expect(events[2].trace_id).toBeUndefined();
	});

	it('newTraceId() returns 8-char hex strings', () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		const a = d.newTraceId();
		const b = d.newTraceId();
		expect(a).toMatch(/^[0-9a-f]{8}$/);
		expect(b).toMatch(/^[0-9a-f]{8}$/);
		expect(a).not.toBe(b); // collision-unlikely in same test
	});
});

describe('DebugLog — span helper', () => {
	it('span() emits start + end events with duration_ms', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		// Sleep well above the asserted floor. A 10ms sleep asserted at >=10ms is
		// flaky: setTimeout may fire a hair early and the duration is measured on a
		// millisecond-resolution clock, so it lands on 9 often enough to fail a
		// gate run for no real reason. The point is that duration_ms reflects the
		// wrapped work's elapsed time, not that it equals the timer exactly.
		await d.span('gen', 'render-row', async () => {
			await new Promise((r) => setTimeout(r, 30));
		}, { row: 5 });
		await flushQueue(d);
		const events = parseLines(state.lines);
		expect(events).toHaveLength(2);
		expect(events[0].op).toBe('render-row/start');
		expect(events[0].row).toBe(5);
		expect(events[1].op).toBe('render-row/end');
		expect(events[1].duration_ms).toBeGreaterThanOrEqual(10);
	});

	it('span() emits error-level end event when fn throws, then rethrows', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		await expect(
			d.span('gen', 'render-row', async () => {
				throw new TypeError('boom');
			}),
		).rejects.toThrow('boom');
		await flushQueue(d);
		const events = parseLines(state.lines);
		expect(events[1].level).toBe('error');
		expect(events[1].error_class).toBe('TypeError');
		expect(events[1].error_message).toBe('boom');
	});

	it('child events inside ctx.event() share the span_id', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		await d.span('gen', 'work', async (ctx) => {
			ctx.event('child-a', 'progress 50%', { pct: 50 });
			ctx.event('child-b', 'progress 100%', { pct: 100 });
		});
		await flushQueue(d);
		const events = parseLines(state.lines);
		// start, child-a, child-b, end
		expect(events).toHaveLength(4);
		const startSpan = events[0].span_id;
		expect(events[1].span_id).toBe(startSpan);
		expect(events[2].span_id).toBe(startSpan);
		expect(events[3].span_id).toBe(startSpan);
	});

	it('nested spans propagate parent_span_id', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		await d.span('a', 'outer', async () => {
			await d.span('a', 'inner', async () => { /* noop */ });
		});
		await flushQueue(d);
		const events = parseLines(state.lines);
		const outerStart = events.find((e) => e.op === 'outer/start')!;
		const innerStart = events.find((e) => e.op === 'inner/start')!;
		expect(innerStart.parent_span_id).toBe(outerStart.span_id);
		expect(outerStart.parent_span_id).toBeUndefined();
	});
});

describe('DebugLog — category filtering', () => {
	it('suppresses events for categories explicitly disabled', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true, false, { config: false });
		d.info('config', 'save', 'config save');
		d.info('generation', 'start', 'gen start');
		await flushQueue(d);
		const events = parseLines(state.lines);
		expect(events).toHaveLength(1);
		expect(events[0].category).toBe('generation');
	});

	it('default (empty filters) emits all categories', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		d.info('a', 'x', 'm');
		d.info('b', 'x', 'm');
		await flushQueue(d);
		expect(state.lines).toHaveLength(2);
	});
});

describe('DebugLog — error() severity', () => {
	it('.error(category, op, msg, data) emits properly categorized error', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		d.error('generation', 'row-error', 'render failed', { row: 8 });
		await flushQueue(d);
		const ev = JSON.parse(state.lines[0]);
		expect(ev.level).toBe('error');
		expect(ev.category).toBe('generation');
		expect(ev.op).toBe('row-error');
		expect(ev.row).toBe(8);
	});
});

describe('DebugLog — export to clipboard', () => {
	it('readForExport() redacts long opaque tokens', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		d.info('test', 'op', 'msg', {
			token: 'sk-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKL',
		});
		await flushQueue(d);
		const out = await d.readForExport();
		expect(out).toContain('[REDACTED]');
		expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
	});

	it('readForExport() redacts recognized tokens embedded after an underscore', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		const token = `ghp_${'a'.repeat(36)}`;
		d.info('test', 'op', 'Synthetic export regression', { reference: `backup_${token}` });
		await flushQueue(d);
		const out = await d.readForExport();
		expect(out).not.toContain(token);
		expect(out).toContain('backup_[REDACTED]');
	});

	// B4 (2026-07-12 pre-merge review): readForExport() previously ONLY ran
	// redactSecrets() (API-key/JWT patterns) — vault-relative paths and file
	// names (which can carry sensitive compliance-framework/document names)
	// leaked straight into the clipboard export. This pins that the same
	// redactPathsAndFilenames/redactEvent machinery "Copy diagnostics" uses is
	// now wired into readForExport() too.
	it('readForExport() redacts a path-shaped key value', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		d.info('generation', 'file-created', 'Created new file', {
			path: 'Frameworks/NIST-800-53/AC-2 Account Management.md',
		});
		await flushQueue(d);
		const out = await d.readForExport();
		expect(out).not.toContain('Frameworks/NIST-800-53');
		expect(out).not.toContain('Account Management.md');
		expect(out).toContain('[redacted]');
	});

	it('readForExport() redacts a vault path embedded in free-text msg', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		d.info('generation', 'file-replaced', 'Replaced existing file Frameworks/CIS-Controls/1.1 Inventory.md');
		await flushQueue(d);
		const out = await d.readForExport();
		expect(out).not.toContain('Frameworks/CIS-Controls');
		expect(out).not.toContain('Inventory.md');
	});

	it('readForExport() redacts a bare source file name', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		d.info('wizard', 'file-selected', 'Selected source file', {
			sourceFileName: 'nist-csf-2.0-govern-identify.csv',
		});
		await flushQueue(d);
		const out = await d.readForExport();
		expect(out).not.toContain('nist-csf-2.0-govern-identify.csv');
	});

	it('readForExport() still redacts secrets AND paths in the same event', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		d.error('tier2', 'sync-failed', 'Sync failed for Frameworks/MITRE-ATTACK/T1078.md', {
			path: 'Frameworks/MITRE-ATTACK/T1078.md',
			token: 'sk-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKL',
		});
		await flushQueue(d);
		const out = await d.readForExport();
		expect(out).not.toContain('Frameworks/MITRE-ATTACK');
		expect(out).toContain('[REDACTED]');
	});
});

describe('DebugLog — getLogPath', () => {
	it('returns the vault-relative log file path', () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		expect(d.getLogPath()).toBe('crosswalker-debug.log');
	});
});
