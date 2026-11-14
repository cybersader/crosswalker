/**
 * debug-diagnostics.test.ts — Jest tests for the production-diagnostics
 * additions to DebugLog: session id, in-memory ring buffer, perf timers,
 * minLevel filtering, and the redacted "Copy diagnostics" bundle.
 *
 * Complements debug-log.test.ts (NDJSON schema, severity, trace/span,
 * category filtering, and clipboard-export redaction).
 */

import {
	DebugLog,
	type DebugEvent,
	redactPathsAndFilenames,
	redactSecrets,
	redactSettingsSnapshot,
	redactEvent,
	findLastEvent,
	buildDiagnosticsBundle,
} from '../src/utils/debug';
import { TFile } from 'obsidian';

// ---------------------------------------------------------------------------
// Mock vault adapter (same shape as debug-log.test.ts's local helper)
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
				state.files.set(path, { size: Buffer.byteLength(line, 'utf8'), content: line });
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
		read: jest.fn(async (file: TFile) => state.files.get(file.path)?.content ?? ''),
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
	for (let i = 0; i < 5; i++) {
		const wq = (d as unknown as { writeQueue: Promise<void> }).writeQueue;
		if (wq) await wq;
		await new Promise<void>((r) => setTimeout(r, 0));
	}
}

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

describe('redactSecrets()', () => {
	it.each(['sk-', 'ghp_', 'ghs_', 'gho_', 'github_pat_', 'pat-', 'xoxb-', 'AKIA', 'AIza'])('redacts recognized %s tokens embedded in filenames', (prefix) => {
		const token = `${prefix}${'a'.repeat(36)}`;
		for (const leading of ['', 'backup_', 'backup']) {
			expect(redactSecrets(`Mappings/${leading}${token}.md`)).toBe(`Mappings/${leading}[REDACTED].md`);
		}
	});

	it('preserves conservative path redaction and is idempotent', () => {
		const token = `ghp_${'a'.repeat(36)}`;
		const redacted = redactSecrets(`Mappings/${token}/record.md`);
		expect(redacted).toBe('Mappings/[REDACTED].md');
		expect(redactSecrets(redacted)).toBe(redacted);
	});

	it('preserves ordinary relative paths without credential-shaped substrings', () => {
		for (const path of ['Frameworks/reference.md', 'Mappings/backup_record.md', 'Frameworks/AKIA-Control.md']) {
			expect(redactSecrets(path)).toBe(path);
		}
	});
});

describe('DebugLog — in-memory ring buffer', () => {
	it('captures events even when file logging is disabled', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), false); // enabled=false
		d.info('wizard', 'generate-start', 'Starting wizard generation');
		d.warn('drafts', 'save-failed', 'Draft save failed');
		await flushQueue(d);

		expect(state.lines).toHaveLength(0); // nothing on disk
		const ring = d.getRingBuffer();
		expect(ring).toHaveLength(2);
		expect(ring[0].op).toBe('generate-start');
		expect(ring[1].op).toBe('save-failed');
	});

	it('caps at 500 entries, dropping oldest first', () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), false);
		for (let i = 0; i < 520; i++) {
			d.info('test', `op-${i}`, `event ${i}`);
		}
		const ring = d.getRingBuffer();
		expect(ring).toHaveLength(500);
		expect(ring[0].op).toBe('op-20'); // first 20 dropped
		expect(ring[ring.length - 1].op).toBe('op-519');
	});

	it('getRingBuffer(n) returns only the last n entries', () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), false);
		d.info('a', 'one', 'm');
		d.info('a', 'two', 'm');
		d.info('a', 'three', 'm');
		const last2 = d.getRingBuffer(2);
		expect(last2.map((e) => e.op)).toEqual(['two', 'three']);
	});

	it('captures span start/end events in the ring buffer too', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), false);
		await d.span('gen', 'render-row', async () => {
			/* noop */
		});
		const ring = d.getRingBuffer();
		expect(ring.map((e) => e.op)).toEqual(['render-row/start', 'render-row/end']);
	});
});

// ---------------------------------------------------------------------------
// Session id
// ---------------------------------------------------------------------------

describe('DebugLog — session id', () => {
	it('tags every event (file-written or ring-buffer-only) with the same session_id', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		d.info('a', 'x', 'm');
		d.info('b', 'y', 'm');
		await flushQueue(d);

		const sessionId = d.getSessionId();
		expect(sessionId).toMatch(/^[0-9a-f]{8}$/);
		const fromFile = state.lines.map((l) => JSON.parse(l));
		expect(fromFile.every((e) => e.session_id === sessionId)).toBe(true);
		expect(d.getRingBuffer().every((e) => e.session_id === sessionId)).toBe(true);
	});

	it('two DebugLog instances get different session ids', () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const a = new DebugLog(createMockApp(state), false);
		const b = new DebugLog(createMockApp(state), false);
		expect(a.getSessionId()).not.toBe(b.getSessionId());
	});
});

// ---------------------------------------------------------------------------
// Performance timers
// ---------------------------------------------------------------------------

describe('DebugLog — time()/end() perf timer', () => {
	it('emits an info event with duration_ms when end() is called', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		const t = d.time('generation', 'render-all-rows', { rowCount: 42 });
		await new Promise((r) => setTimeout(r, 5));
		const duration = t.end({ extraTag: 'ok' });
		await flushQueue(d);

		expect(duration).toBeGreaterThanOrEqual(0);
		const ev = JSON.parse(state.lines[0]);
		expect(ev.category).toBe('generation');
		expect(ev.op).toBe('render-all-rows');
		expect(ev.rowCount).toBe(42);
		expect(ev.extraTag).toBe('ok');
		expect(typeof ev.duration_ms).toBe('number');
	});

	it('never emitting end() means never emitting an event (no dangling timers)', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		d.time('generation', 'abandoned');
		await flushQueue(d);
		expect(state.lines).toHaveLength(0);
	});

	it('still records to the ring buffer when file logging is disabled', () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), false);
		const t = d.time('wizard', 'parse');
		t.end();
		expect(d.getRingBuffer()).toHaveLength(1);
		expect(d.getRingBuffer()[0].op).toBe('parse');
	});
});

// ---------------------------------------------------------------------------
// minLevel filtering (5th constructor arg, additive/back-compat)
// ---------------------------------------------------------------------------

describe('DebugLog — minLevel filtering', () => {
	it('defaults to trace (no additional filtering beyond existing verbose gate)', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true); // 4-arg call, back-compat
		d.error('a', 'x', 'm');
		d.warn('a', 'x', 'm');
		d.info('a', 'x', 'm');
		await flushQueue(d);
		expect(state.lines).toHaveLength(3);
	});

	it('setMinLevel("warn") suppresses info/trace from the file but not the ring buffer', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true);
		d.setMinLevel('warn');
		d.error('a', 'e', 'm');
		d.warn('a', 'w', 'm');
		d.info('a', 'i', 'm');
		await flushQueue(d);

		const fromFile = state.lines.map((l) => JSON.parse(l).level);
		expect(fromFile).toEqual(['error', 'warn']);
		expect(d.getRingBuffer().map((e) => e.level)).toEqual(['error', 'warn', 'info']);
	});

	it('constructor 5th arg sets minLevel at construction time', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), true, false, {}, 'error');
		d.warn('a', 'x', 'm');
		d.error('a', 'y', 'm');
		await flushQueue(d);
		expect(state.lines).toHaveLength(1);
		expect(JSON.parse(state.lines[0]).op).toBe('y');
	});
});

// ---------------------------------------------------------------------------
// Redaction — path/filename scrubbing
// ---------------------------------------------------------------------------

describe('redactPathsAndFilenames()', () => {
	it('scrubs Windows absolute paths', () => {
		const out = redactPathsAndFilenames('Failed to read C:\\Users\\jsmith\\Vault\\Ontologies\\NIST\\AC-1.md');
		expect(out).not.toContain('jsmith');
		expect(out).not.toContain('C:\\Users');
		expect(out).toContain('[path]');
	});

	it('scrubs unix-style vault paths', () => {
		const out = redactPathsAndFilenames('wrote note at /Users/jsmith/vault/Ontologies/NIST/AC-1.md');
		expect(out).not.toContain('jsmith');
		expect(out).toContain('[path]');
	});

	it('scrubs bare filenames with common data extensions', () => {
		const out = redactPathsAndFilenames('Starting file parse: nist-csf-2.0-govern-identify.csv');
		expect(out).not.toContain('nist-csf-2.0-govern-identify.csv');
		expect(out).toContain('[file]');
	});

	it('leaves plain non-path text untouched', () => {
		const out = redactPathsAndFilenames('Wizard generation complete (120 created)');
		expect(out).toBe('Wizard generation complete (120 created)');
	});
});

describe('redactEvent()', () => {
	it('redacts key-named path/file/folder/dir fields outright', () => {
		const ev: DebugEvent = {
			ts: '2026-07-11T00:00:00.000Z',
			level: 'info',
			category: 'wizard',
			op: 'generate-start',
			msg: 'Starting wizard generation (12 rows)',
			basePath: 'Ontologies/NIST CSF',
			sourceFileName: 'nist-csf-2.0-govern-identify.csv',
			rowCount: 12,
		};
		const out = redactEvent(ev);
		expect(out.basePath).toBe('[redacted]');
		expect(out.sourceFileName).toBe('[redacted]');
		expect(out.rowCount).toBe(12); // counts pass through
		expect(out.category).toBe('wizard'); // non-path strings pass through
	});

	it('scrubs path-shaped substrings even inside msg (defense in depth)', () => {
		const ev: DebugEvent = {
			ts: '2026-07-11T00:00:00.000Z',
			level: 'info',
			category: 'csv-parser',
			op: 'parse-start',
			msg: 'Starting file parse: nist-csf-2.0-govern-identify.csv',
		};
		const out = redactEvent(ev);
		expect(out.msg).not.toContain('nist-csf-2.0-govern-identify.csv');
	});

	it('caps nested objects/arrays and never throws on deep data', () => {
		const ev: DebugEvent = {
			ts: '2026-07-11T00:00:00.000Z',
			level: 'error',
			category: 'tier2',
			op: 'deep',
			msg: 'deep payload',
			nested: { a: { b: { c: { d: 'C:\\Users\\jsmith\\deep.md' } } } },
			items: Array.from({ length: 30 }, (_, i) => `row-${i}.csv`),
		};
		expect(() => redactEvent(ev)).not.toThrow();
		const out = redactEvent(ev) as unknown as { items: unknown[] };
		expect(out.items.length).toBeLessThanOrEqual(21); // 20 capped + "…N more"
	});
});

describe('redactSettingsSnapshot()', () => {
	it('collapses path-bearing settings fields to a customized/default flag', () => {
		const settings = {
			defaultOutputPath: 'C:\\Users\\jsmith\\Vault\\Ontologies',
			tier2SidecarPath: '.crosswalker.sqlite',
			customLinkNamespace: 'crosswalker',
			enableDebugLog: true,
			maxRowsForPreview: 100,
		};
		const out = redactSettingsSnapshot(settings);
		expect(out.defaultOutputPath).toBe('[custom]');
		expect(JSON.stringify(out)).not.toContain('jsmith');
		expect(out.enableDebugLog).toBe(true);
		expect(out.maxRowsForPreview).toBe(100);
	});

	it('collapses savedConfigs to a count, never the config contents', () => {
		const settings = {
			savedConfigs: [
				{ id: '1', name: 'NIST import', sourceFileName: 'nist.csv' },
				{ id: '2', name: 'CIS import', sourceFileName: 'cis.csv' },
			],
		};
		const out = redactSettingsSnapshot(settings);
		expect(out.savedConfigs).toBeUndefined();
		expect(out.savedConfigsCount).toBe(2);
	});

	it('marks an empty/default path field as [default]', () => {
		const out = redactSettingsSnapshot({ tier2SidecarPath: '' });
		expect(out.tier2SidecarPath).toBe('[default]');
	});
});

// ---------------------------------------------------------------------------
// findLastEvent + full bundle assembly
// ---------------------------------------------------------------------------

describe('findLastEvent()', () => {
	it('returns the most recent matching category+op', () => {
		const events: DebugEvent[] = [
			{ ts: '1', level: 'info', category: 'wizard', op: 'generate-complete', msg: 'first', created: 3 },
			{ ts: '2', level: 'info', category: 'other', op: 'noise', msg: 'x' },
			{ ts: '3', level: 'info', category: 'wizard', op: 'generate-complete', msg: 'second', created: 10 },
		];
		const last = findLastEvent(events, 'wizard', 'generate-complete');
		expect(last?.created).toBe(10);
	});

	it('returns undefined when nothing matches', () => {
		expect(findLastEvent([], 'wizard', 'generate-complete')).toBeUndefined();
	});
});

describe('buildDiagnosticsBundle()', () => {
	function fakeEvents(): DebugEvent[] {
		return [
			{
				ts: '2026-07-11T00:00:00.000Z',
				level: 'info',
				category: 'wizard',
				op: 'generate-start',
				msg: 'Starting wizard generation (12 rows)',
				basePath: 'C:\\Users\\jsmith\\Vault\\Ontologies\\NIST',
				sourceFileName: 'nist-csf-2.0-govern-identify.csv',
			},
			{
				ts: '2026-07-11T00:00:01.000Z',
				level: 'info',
				category: 'wizard',
				op: 'generate-complete',
				msg: 'Wizard generation complete (12 created)',
				success: true,
				created: 12,
				skipped: 0,
				errors: 0,
				duration: 240,
			},
		];
	}

	it('produces valid JSON containing no vault paths or file names', () => {
		const json = buildDiagnosticsBundle({
			pluginVersion: '0.1.6',
			obsidianVersion: '1.6.0',
			platform: 'desktop-win',
			sessionId: 'deadbeef',
			settings: {
				defaultOutputPath: 'C:\\Users\\jsmith\\Vault\\Ontologies',
				enableDebugLog: true,
			},
			ringBuffer: fakeEvents(),
		});

		expect(() => JSON.parse(json)).not.toThrow();
		expect(json).not.toContain('jsmith');
		expect(json).not.toContain('nist-csf-2.0-govern-identify.csv');
		expect(json).not.toContain('C:\\Users');

		const parsed = JSON.parse(json);
		expect(parsed.session_id).toBe('deadbeef');
		expect(parsed.plugin_version).toBe('0.1.6');
		expect(parsed.settings.defaultOutputPath).toBe('[custom]');
	});

	it('surfaces the last import summary as counts only', () => {
		const json = buildDiagnosticsBundle({
			pluginVersion: '0.1.6',
			obsidianVersion: '1.6.0',
			platform: 'desktop-win',
			sessionId: 'deadbeef',
			settings: {},
			ringBuffer: fakeEvents(),
		});
		const parsed = JSON.parse(json);
		expect(parsed.last_import_summary).toMatchObject({
			created: 12,
			skipped: 0,
			errors: 0,
			duration: 240,
		});
	});

	it('last_import_summary is null when no import has happened yet', () => {
		const json = buildDiagnosticsBundle({
			pluginVersion: '0.1.6',
			obsidianVersion: '1.6.0',
			platform: 'desktop-win',
			sessionId: 'deadbeef',
			settings: {},
			ringBuffer: [],
		});
		expect(JSON.parse(json).last_import_summary).toBeNull();
	});

	it('respects maxRecentEvents', () => {
		const many: DebugEvent[] = Array.from({ length: 10 }, (_, i) => ({
			ts: String(i),
			level: 'info',
			category: 'test',
			op: `op-${i}`,
			msg: 'm',
		}));
		const json = buildDiagnosticsBundle({
			pluginVersion: '0.1.6',
			obsidianVersion: '1.6.0',
			platform: 'desktop-win',
			sessionId: 'deadbeef',
			settings: {},
			ringBuffer: many,
			maxRecentEvents: 3,
		});
		expect(JSON.parse(json).recent_events).toHaveLength(3);
	});
});

describe('DebugLog#assembleDiagnostics — instance method integration', () => {
	it('pulls sessionId + ringBuffer from the instance automatically', async () => {
		const state: MockVaultState = { lines: [], files: new Map() };
		const d = new DebugLog(createMockApp(state), false); // file logging off
		d.info('wizard', 'generate-complete', 'Wizard generation complete (5 created)', {
			success: true,
			created: 5,
			skipped: 0,
			errors: 0,
			duration: 100,
		});

		const json = d.assembleDiagnostics({
			pluginVersion: '0.1.6',
			obsidianVersion: '1.6.0',
			platform: 'desktop-linux',
			settings: { defaultOutputPath: '/home/jsmith/vault/Ontologies' },
		});
		const parsed = JSON.parse(json);
		expect(parsed.session_id).toBe(d.getSessionId());
		expect(parsed.last_import_summary.created).toBe(5);
		expect(json).not.toContain('jsmith');
	});
});
