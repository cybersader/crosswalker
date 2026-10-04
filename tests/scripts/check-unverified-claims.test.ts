import { DOCS, cleanupRepos, makeRepo, page, runGate } from './gate-harness';

afterAll(cleanupRepos);

function changelog(unreleased: string, released = ''): string {
	return [
		'# Changelog',
		'',
		'## [Unreleased] — in progress',
		'',
		'### Follow-ups',
		'',
		'- an open item',
		'',
		unreleased,
		'',
		'## [0.1.0] - 2026-09-13',
		'',
		released,
		'',
	].join('\n');
}

const LIVING = (body: string) => page(`**Status last verified:** 2026-10-03 — all.\n\n${body}`);

describe('check-unverified-claims (K4)', () => {
	it('passes tracked claims and ignores released sections, code and non-living pages', () => {
		const root = makeRepo({
			'CHANGELOG.md': changelog(
				'- Persistence was not observed in either run (tracked: #follow-ups). The next sentence is fine.\n- The `unverified` status is a value name.',
				'- Mobile remains unverified.',
			),
			[`${DOCS}/m.mdx`]: page('## Status\n\nOpen task.'),
			[`${DOCS}/living.mdx`]: LIVING('The picker is not yet verified in real Obsidian (tracked: /crosswalker/m/#status).'),
			[`${DOCS}/log.mdx`]: page('This was not tested.'),
		});
		const run = runGate('check-unverified-claims.mjs', root);
		expect(run.out).toContain('2 unverified-claim sentences');
		expect(run.status).toBe(0);
	});

	it('fails an untracked claim, an unresolvable anchor, and a non-doc target', () => {
		const root = makeRepo({
			'CHANGELOG.md': changelog([
				'- Mode was not observed. Other text.',
				'- BRAT install could not test it (tracked: #no-such-heading).',
				'- Coverage is not verified (tracked: https://example.com/issue).',
			].join('\n')),
			[`${DOCS}/living.mdx`]: LIVING('This is unverified on mobile.'),
		});
		const run = runGate('check-unverified-claims.mjs', root);
		expect(run.status).toBe(1);
		expect(run.out).toContain('untracked "not observed": - Mode was not observed.');
		expect(run.out).toContain('tracked link does not resolve: #no-such-heading');
		expect(run.out).toContain('tracked link does not resolve: https://example.com/issue');
		expect(run.out).toContain('untracked "unverified"');
		expect(run.out).toContain('4 failed');
	});

	it('accepts a tracked tag written just after the full stop', () => {
		const root = makeRepo({ 'CHANGELOG.md': changelog('- Mode was not observed. (tracked: #follow-ups)') });
		expect(runGate('check-unverified-claims.mjs', root).status).toBe(0);
	});

	it('prints help and exits 0', () => {
		expect(runGate('check-unverified-claims.mjs', null, ['--help']).status).toBe(0);
	});
});
