import { DOCS, cleanupRepos, makeRepo, page, runGate } from './gate-harness';

afterAll(cleanupRepos);

const M = `${DOCS}/reference/roadmap/milestones`;
const link = (slug: string, label: string) => `[${label}](/crosswalker/reference/roadmap/milestones/${slug}/)`;

function milestone(status: string): string {
	return page(`## Status\n\n${status}\n\n## Goal\n\nText.`);
}

function hub(rows: Array<[string, string, string]>): string {
	return page([
		'| Milestone | Title | Status |',
		'|---|---|---|',
		...rows.map(([slug, label, status]) => `| ${link(slug, label)} | t | ${status} |`),
	].join('\n'));
}

function roadmap(rows: string[], active = ''): string {
	return [
		'## Where we are',
		'',
		'| Milestone | Status | Date | What |',
		'|---|---|---|---|',
		...rows,
		'',
		'## Active: v0.1.3',
		'',
		active,
		'',
	].join('\n');
}

function tree(overrides: Record<string, string> = {}): Record<string, string> {
	const rows = [
		`| ${link('v0-1-1-types', 'v0.1.1')} to ${link('v0-1-2-render', 'v0.1.2')} | ✅ Done | d | w |`,
		`| ${link('v0-1-3-exporters', 'v0.1.3')} | 🚧 Active | d | w |`,
		`| ${link('v0-1-rc-ship', 'v0.1-RC')} | 📋 Planning | d | w |`,
	];
	return {
		[`${M}/v0-1-1-types.mdx`]: milestone('✅ Done (2026-05-04).'),
		[`${M}/v0-1-2-render.mdx`]: milestone('✅ **Done (2026-05-05).**'),
		[`${M}/v0-1-3-exporters.mdx`]: milestone('🚧 In progress — first slice ✅.'),
		[`${M}/v0-1-rc-ship.mdx`]: milestone('📋 Planning'),
		[`${M}/index.mdx`]: hub([
			['v0-1-1-types', 'v0.1.1', '✅ Done'],
			['v0-1-2-render', 'v0.1.2', '✅ Done'],
			['v0-1-3-exporters', 'v0.1.3', '🚧 In progress — slice ✅'],
			['v0-1-rc-ship', 'v0.1-RC', '📋 Planning'],
		]),
		[`${DOCS}/reference/roadmap/index.mdx`]: page(roadmap(rows, `See ${link('v0-1-3-exporters', 'v0.1.3')}.`)),
		'ROADMAP.md': roadmap(rows.map((r) => r.replace(/\/crosswalker\//g, 'https://cybersader.github.io/crosswalker/'))),
		...overrides,
	};
}

describe('check-roadmap-sync (K5)', () => {
	it('passes when all four sources agree, expanding "A to B" ranges', () => {
		const run = runGate('check-roadmap-sync.mjs', makeRepo(tree()));
		expect(run.out).toContain('4 milestones, 12 cross-source comparisons');
		expect(run.status).toBe(0);
	});

	it('reports every disagreement with file and line', () => {
		const run = runGate('check-roadmap-sync.mjs', makeRepo(tree({
			[`${M}/v0-1-3-exporters.mdx`]: milestone('✅ Done (2026-10-03).'),
		})));
		expect(run.status).toBe(1);
		expect(run.out).toContain('v0.1.3 is 🚧 In progress here but ✅ Done in docs/src/content/docs/reference/roadmap/milestones/v0-1-3-exporters.mdx:7');
		expect(run.out).toContain('ROADMAP.md');
		expect(run.out).toContain('v0.1.3 is ✅ Done but linked under an "Active" heading');
	});

	it('fails a milestone missing from the hub and a mirror that lists a different set', () => {
		const run = runGate('check-roadmap-sync.mjs', makeRepo(tree({
			[`${M}/index.mdx`]: hub([['v0-1-1-types', 'v0.1.1', '✅ Done']]),
			'ROADMAP.md': roadmap([]),
		})));
		expect(run.status).toBe(1);
		expect(run.out).toContain('v0.1.2 has a milestone page but no row in the hub');
		expect(run.out).toContain('is listed in the roadmap index but not here; the two are mirrors');
	});

	it('prints help and exits 0', () => {
		expect(runGate('check-roadmap-sync.mjs', null, ['--help']).status).toBe(0);
	});
});
