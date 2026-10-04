import { DOCS, cleanupRepos, makeRepo, page, runGate } from './gate-harness';

afterAll(cleanupRepos);

const TODAY = ['--today', '2026-10-03'];

function living(marker: string, body = 'Body.'): string {
	return page(`Intro.\n\n${marker}\n\n${body}`);
}

describe('check-freshness (K1, K2, K3)', () => {
	it('passes a fresh, unscoped, canonical marker and ignores pages without one', () => {
		const root = makeRepo({
			[`${DOCS}/a.mdx`]: living('**Status last verified:** 2026-09-20 — verified against `src/main.ts`.'),
			[`${DOCS}/b.mdx`]: living('**Status last verified**: 2026-10-01 — verified against the shipped UI.'),
			[`${DOCS}/log.mdx`]: page('| Rule | Two pages carry a `Status last verified` marker |'),
		});
		const run = runGate('check-freshness.mjs', root, TODAY);
		expect(run.status).toBe(0);
		expect(run.out).toContain('2 living pages');
	});

	it.each([
		['row', '**Status last verified:** 2026-10-03 — the Fast query index row re-checked.'],
		['only', '**Status last verified:** 2026-10-03 — v0.1.7 only.'],
		['scoped', '**Status last verified:** 2026-10-03 — scoped to static contracts.'],
		['paragraph', '**Status last verified:** 2026-10-03 — the Run it again paragraph.'],
		['cell', '**Status last verified:** 2026-10-03 — the v0.1.7 cell.'],
	])('fails a marker scoped by "%s"', (word, marker) => {
		const root = makeRepo({ [`${DOCS}/a.mdx`]: living(marker) });
		const run = runGate('check-freshness.mjs', root, TODAY);
		expect(run.status).toBe(1);
		expect(run.out).toContain(`scoped marker ("${word}")`);
	});

	it('fails an Earlier chain, a malformed marker, and a second marker', () => {
		const root = makeRepo({
			[`${DOCS}/chain.mdx`]: living('**Status last verified:** 2026-10-03 — A. Earlier: 2026-09-01 B. Earlier: 2026-08-01 C.'),
			[`${DOCS}/bad.mdx`]: living('**Status last verified: 2026-10-03** — every entry.'),
			[`${DOCS}/two.mdx`]: living('**Status last verified:** 2026-10-03 — all.', 'Status last verified: 2026-10-01 — a note.'),
		});
		const run = runGate('check-freshness.mjs', root, TODAY);
		expect(run.status).toBe(1);
		expect(run.out).toContain('"Earlier" chain (2)');
		expect(run.out).toContain('malformed marker');
		expect(run.out).toContain('2 markers on one page');
	});

	it('fails a marker older than 30 days and passes one exactly 30 days old', () => {
		const stale = makeRepo({ [`${DOCS}/a.mdx`]: living('**Status last verified:** 2026-09-02 — all.') });
		const staleRun = runGate('check-freshness.mjs', stale, TODAY);
		expect(staleRun.status).toBe(1);
		expect(staleRun.out).toContain('31 days old (limit 30)');
		const edge = makeRepo({ [`${DOCS}/a.mdx`]: living('**Status last verified:** 2026-09-03 — all.') });
		expect(runGate('check-freshness.mjs', edge, TODAY).status).toBe(0);
	});

	it('warns, without failing, when most dates on the page are older than 90 days', () => {
		const body = ['2026-04-01', '2026-04-02', '2026-04-03', '2026-05-01', '2026-05-02'].join(', ');
		const root = makeRepo({ [`${DOCS}/a.mdx`]: living('**Status last verified:** 2026-10-03 — all.', body) });
		const run = runGate('check-freshness.mjs', root, TODAY);
		expect(run.status).toBe(0);
		expect(run.out).toContain('Date drift (warning only)');
		expect(run.out).toContain('5/6 dates (83%)');
	});

	it('prints help and exits 0', () => {
		expect(runGate('check-freshness.mjs', null, ['--help']).status).toBe(0);
	});
});
