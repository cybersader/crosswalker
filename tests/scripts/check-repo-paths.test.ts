import { DOCS, cleanupRepos, makeRepo, page, runGate } from './gate-harness';

afterAll(cleanupRepos);

const BASE = {
	'package.json': '{}',
	'src/main.ts': '',
	'tests/e2e/smoke-ci.spec.ts': '',
	'scripts/check-links.mjs': '',
};

describe('check-repo-paths (K8)', () => {
	it('passes tracked files and directories, opt-outs, placeholders and historical records', () => {
		const root = makeRepo({
			...BASE,
			[`${DOCS}/a.mdx`]: page([
				'See `src/main.ts`, `tests/e2e/`, `tests/e2e/smoke-ci.spec.ts` and `package.json`.',
				'Install into `docs/node_modules` (local, gitignored).',
				'Files to touch: `src/audit/` (planned).',
				'A log lands at `docs/src/content/docs/agent-context/zz-log/YYYY-MM-DD-name.mdx`.',
				'```',
				'`src/not-checked-in-a-fence.ts`',
				'```',
			].join('\n')),
			[`${DOCS}/agent-context/zz-log/2026-05-01-old.mdx`]: page('Wrote `src/renamed-long-ago.ts`.'),
			'CHANGELOG.md': '## [Unreleased]\n\n### Old (2026-08-20)\n\n- `src/gone.ts`\n\n### New (2026-10-03)\n\n- `src/main.ts`\n',
		}, { git: true });
		const run = runGate('check-repo-paths.mjs', root);
		expect(run.out).toContain('5 path references');
		expect(run.status).toBe(0);
	});

	it('fails untracked, gitignored-without-opt-out and renamed paths', () => {
		const root = makeRepo({
			...BASE,
			[`${DOCS}/a.mdx`]: page('The repo gains `tools/openclast-smoke.toml`; see `scripts/check-links.js` and `docs/dist`.'),
			'CHANGELOG.md': '## [Unreleased]\n\n### New (2026-10-03)\n\n- `src/missing.ts`\n',
		}, { git: true });
		const run = runGate('check-repo-paths.mjs', root);
		expect(run.status).toBe(1);
		for (const token of ['tools/openclast-smoke.toml', 'scripts/check-links.js', 'docs/dist', 'src/missing.ts']) {
			expect(run.out).toContain(token);
		}
		expect(run.out).toContain('4 failed');
	});

	it('prints help and exits 0', () => {
		expect(runGate('check-repo-paths.mjs', null, ['--help']).status).toBe(0);
	});
});
