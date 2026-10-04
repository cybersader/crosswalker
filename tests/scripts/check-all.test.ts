import { runGate } from './gate-harness';

describe('check-all (K9)', () => {
	it('lists every check:* gate from package.json except the fixture regeneration', () => {
		const run = runGate('check-all.mjs', null, ['--list']);
		expect(run.status).toBe(0);
		const gates = run.out.trim().split('\n');
		expect(gates).toEqual(expect.arrayContaining([
			'check:personal-data',
			'check:mdx',
			'check:frontmatter',
			'check:not-content',
			'check:log-labels',
			'check:links',
			'check:freshness',
			'check:unverified-claims',
			'check:roadmap-sync',
			'check:repo-paths',
		]));
		expect(gates).toHaveLength(10);
		expect(gates).not.toContain('check:fixtures-drift');
	});

	it('prints help and exits 0', () => {
		expect(runGate('check-all.mjs', null, ['--help']).status).toBe(0);
	});
});
