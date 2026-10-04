import { join } from 'node:path';
import { cleanupRepos, makeRepo, runGate } from './gate-harness';

afterAll(cleanupRepos);

const TODAY = ['--today', '2026-10-03'];
const SSSOM = 'the real SSSOM importer retains a missing end';

function ledger(rows: string[]): string {
	return [
		'# E2E red ledger',
		'',
		'| Spec | Case | Kind | Since | Reason | Tracked |',
		'|---|---|---|---|---|---|',
		...rows,
		'',
	].join('\n');
}

const ROW = (kind: string, since = '2026-10-03', tracked = '[Follow-ups](../../CHANGELOG.md#follow-ups)') =>
	`| \`sssom-import.spec.ts\` | ${SSSOM} | ${kind} | ${since} | why | ${tracked} |`;

function results(tests: Array<[string, string, string]>): Record<string, string> {
	const out: Record<string, string> = {};
	tests.forEach(([spec, title, state], i) => {
		out[`results/main/results-${i}.json`] = JSON.stringify({ spec: `tests/e2e/${spec}`, tests: [{ title, fullTitle: title, state }] });
	});
	return out;
}

function repo(rows: string[], tests: Array<[string, string, string]>): string {
	return makeRepo({
		'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n### Follow-ups\n\n- item\n',
		'tests/e2e/KNOWN_RED.md': ledger(rows),
		...results(tests),
	});
}

function run(root: string) {
	return runGate('check-known-red.mjs', root, [join(root, 'results/main'), ...TODAY]);
}

describe('check-known-red (K6)', () => {
	it('passes when every red case is listed and still red', () => {
		const r = run(repo([ROW('red')], [['sssom-import.spec.ts', SSSOM, 'failed'], ['smoke.spec.ts', 'loads', 'passed']]));
		expect(r.out).toContain('2 cases, 1 red, 1 ledger entries');
		expect(r.status).toBe(0);
	});

	it('fails an unlisted red case', () => {
		const r = run(repo([], [['first-run-stack.spec.ts', 'imports three sets', 'failed']]));
		expect(r.status).toBe(1);
		expect(r.out).toContain('red and not in the ledger: "imports three sets"');
	});

	it('fails a listed red case that passed (stale) but tolerates a flaky one either way', () => {
		const stale = run(repo([ROW('red')], [['sssom-import.spec.ts', SSSOM, 'passed']]));
		expect(stale.status).toBe(1);
		expect(stale.out).toContain('passed; the entry is stale');
		expect(run(repo([ROW('flaky')], [['sssom-import.spec.ts', SSSOM, 'passed']])).status).toBe(0);
		expect(run(repo([ROW('flaky')], [['sssom-import.spec.ts', SSSOM, 'failed']])).status).toBe(0);
	});

	it('fails an entry older than 30 days, a bad kind, and an unresolvable tracked link', () => {
		const r = run(repo([
			ROW('flaky', '2026-09-01'),
			`| \`other.spec.ts\` | case | sometimes | 2026-10-03 | why | [x](../../CHANGELOG.md#nope) |`,
		], [['sssom-import.spec.ts', SSSOM, 'failed']]));
		expect(r.status).toBe(1);
		expect(r.out).toContain('listed since 2026-09-01, over 30 days');
		expect(r.out).toContain('kind must be "red" or "flaky"');
		expect(r.out).toContain('tracked link missing or does not resolve');
	});

	it('reads QUARANTINE.md as whole-spec red entries with their own dates', () => {
		const quarantine = (date: string) => [
			'| Spec | Verdict | Evidence | Date added | Exact removal condition | Blocks release | Review by |',
			'|---|---|---|---|---|---|---|',
			`| \`visual-graph.spec.ts\` | Unclear | e | ${date} | c | No | 2026-10-20 |`,
			'',
		].join('\n');
		const build = (date: string, state: string) => makeRepo({
			'tests/e2e/KNOWN_RED.md': ledger([]),
			'tests/e2e/QUARANTINE.md': quarantine(date),
			...results([['visual-graph.spec.ts', 'any case', state], ['visual-graph.spec.ts', 'other', 'passed']]),
		});
		const covered = run(build('2026-09-20', 'failed'));
		expect(covered.out).toContain('1 quarantined specs');
		expect(covered.status).toBe(0);
		const stale = run(build('2026-09-20', 'passed'));
		expect(stale.status).toBe(1);
		expect(stale.out).toContain('visual-graph.spec.ts (quarantined spec)" passed; the entry is stale');
		const old = run(build('2026-08-27', 'failed'));
		expect(old.status).toBe(1);
		expect(old.out).toContain('listed since 2026-08-27, over 30 days');
	});

	it('fails when the results directory is empty', () => {
		const root = makeRepo({ 'tests/e2e/KNOWN_RED.md': ledger([]) });
		const r = run(root);
		expect(r.status).toBe(1);
		expect(r.out).toContain('no results found');
	});

	it('prints help and exits 0', () => {
		expect(runGate('check-known-red.mjs', null, ['--help']).status).toBe(0);
	});
});
