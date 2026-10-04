import { DOCS, cleanupRepos, makeRepo, page, runGate } from './gate-harness';

afterAll(cleanupRepos);

describe('check-links: pages and anchors (K11)', () => {
	const target = page([
		'## Where we are (2026-10-03)',
		'',
		'### `render()` and **friends**',
		'',
		'## MITRE ATT&CK — the gold standard :badge[Best Practice]',
		'',
		'<span id="explicit-id"></span>',
		'',
		'## Where we are (2026-10-03)',
	].join('\n'));

	it('passes links to existing pages, heading slugs, duplicate-suffixed slugs and explicit ids', () => {
		const root = makeRepo({
			[`${DOCS}/target.mdx`]: target,
			[`${DOCS}/source.mdx`]: page([
				'[a](/crosswalker/target/)',
				'[b](/crosswalker/target/#where-we-are-2026-10-03)',
				'[c](/crosswalker/target/#where-we-are-2026-10-03-1)',
				'[d](/crosswalker/target/#render-and-friends)',
				'[e](/crosswalker/target/#mitre-attck--the-gold-standard)',
				'[f](/crosswalker/target/#explicit-id)',
				'[g](#local-heading)',
				'## Local heading',
				'`[not a link](/crosswalker/nowhere/)`',
			].join('\n')),
		});
		const run = runGate('check-links.mjs', root);
		expect(run.out).toContain('7 passed');
		expect(run.status).toBe(0);
	});

	it('fails a missing page and a missing anchor, naming file and line', () => {
		const root = makeRepo({
			[`${DOCS}/target.mdx`]: target,
			[`${DOCS}/source.mdx`]: page([
				'[gone](/crosswalker/missing-page/)',
				'[renamed](/crosswalker/target/#old-heading-name)',
				'[self](#not-here)',
			].join('\n')),
		});
		const run = runGate('check-links.mjs', root);
		expect(run.status).toBe(1);
		expect(run.out).toContain('docs/src/content/docs/source.mdx');
		expect(run.out).toContain('/crosswalker/missing-page/');
		expect(run.out).toContain('#old-heading-name  (no such heading or id on the target page)');
		expect(run.out).toContain('#not-here');
		expect(run.out).toContain('3 failed');
	});

	it('prints help and exits 0', () => {
		const run = runGate('check-links.mjs', null, ['--help']);
		expect(run.status).toBe(0);
		expect(run.out).toContain('Usage:');
	});
});
