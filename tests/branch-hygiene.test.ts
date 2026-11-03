/** @jest-environment node */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const SCRIPT = join(__dirname, '..', 'scripts', 'branch-hygiene.mjs');
const DECISIONS = pathToFileURL(join(__dirname, '..', 'scripts', 'lib', 'branch-hygiene.mjs')).href;
const roots: string[] = [];
const env = {
	...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
	GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
	GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@test.invalid',
	GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@test.invalid',
};

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sandbox(): string {
	const root = mkdtempSync(join(tmpdir(), 'crosswalker-branch-hygiene-'));
	roots.push(root);
	return root;
}

function init(path: string, hooks: string, branch = 'main', bare = false): void {
	mkdirSync(path, { recursive: true });
	git(path, 'init', ...(bare ? ['--bare'] : []), '--initial-branch', branch);
	git(path, 'config', 'commit.gpgsign', 'false');
	git(path, 'config', 'core.hooksPath', hooks);
}

function fixture(remoteBranch = 'main') {
	const root = sandbox();
	const repo = join(root, 'checkout');
	const origin = join(root, 'origin');
	const hooks = join(root, 'hooks');
	mkdirSync(hooks);
	init(origin, hooks, remoteBranch, true);
	init(repo, hooks);
	writeFileSync(join(repo, '.gitignore'), '.workspace/\n.nested/\n.branch-hygiene-keep\n');
	writeFileSync(join(repo, 'tracked.txt'), 'committed\n');
	git(repo, 'add', '.');
	execFileSync('git', ['-C', repo, 'commit', '-m', 'Fixture baseline'], {
		env: { ...env, GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' }, stdio: 'pipe',
	});
	git(repo, 'remote', 'add', 'origin', origin);
	git(repo, 'push', 'origin', `HEAD:${remoteBranch}`);
	git(repo, 'checkout', '-b', 'session');
	const worktree = (name: string, path = join(root, name)) => {
		git(repo, 'worktree', 'add', '-b', name, path, 'main');
		return path;
	};
	return { root, repo, origin, worktree };
}

function ageBranch(repo: string, name: string): void {
	const log = resolve(repo, git(repo, 'rev-parse', '--git-path', `logs/refs/heads/${name}`));
	writeFileSync(log, readFileSync(log, 'utf8').replace(/> \d+ [+-]\d{4}\t/g, '> 946684800 +0000\t'));
}

function ageAll(repo: string): void {
	for (const name of git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n')) ageBranch(repo, name);
	for (const line of git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree '))) {
		const path = line.slice('worktree '.length);
		const dir = resolve(path, git(path, 'rev-parse', '--git-dir'));
		for (const name of ['HEAD', 'index']) utimesSync(join(dir, name), 946684800, 946684800);
	}
}

function run(repo: string, ...args: string[]) {
	return spawnSync('node', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8', env, timeout: 30_000 });
}

// Jest's existing CommonJS transform does not load ESM. Import the exact pure
// module in Node, without transforming it or copying its decisions into tests.
function decisions(name: string, cases: object[]) {
	return JSON.parse(execFileSync('node', ['--input-type=module', '-e',
		`import { ${name} } from ${JSON.stringify(DECISIONS)}; import { readFileSync } from 'node:fs'; console.log(JSON.stringify(JSON.parse(readFileSync(0, 'utf8')).map(${name})));`,
	], { input: JSON.stringify(cases), encoding: 'utf8', env }));
}

afterAll(() => {
	// Only disposable roots created above are removed. Never operate on this
	// checkout's branch/worktree registry during a test.
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('branch hygiene pure decisions', () => {
	it('classifies locks before dirt, dirt before ancestry, and detached worktrees conservatively', () => {
		const base = { branch: 'topic', merged: true, dirty: false, locked: false, currentBranch: 'session', lastActivity: 0, now: 86400 };
		expect(decisions('classifyWorktree', [
			base,
			{ ...base, locked: true, dirty: true, merged: false },
			{ ...base, dirty: true, merged: false },
			{ ...base, merged: false },
			{ ...base, branch: null },
		])).toEqual([
			{ state: 'clean+merged', removable: true },
			{ state: 'locked', removable: false },
			{ state: 'dirty', removable: false },
			{ state: 'unmerged', removable: false },
			{ state: 'unmerged', removable: false },
		]);
	});

	it('never removes main, the current branch/worktree, primary, nested parent, or kept worktrees', () => {
		const base = { branch: 'topic', merged: true, dirty: false, locked: false, currentBranch: 'session', lastActivity: 0, now: 86400 };
		const protectedCases = [
			{ ...base, branch: 'main' }, { ...base, branch: 'session' },
			{ ...base, current: true }, { ...base, primary: true },
			{ ...base, kept: true }, { ...base, containsWorktree: true },
		];
		expect(decisions('classifyWorktree', protectedCases)).toEqual(protectedCases.map(() => ({ state: 'clean+merged', removable: false })));
	});

	it('reports the exact 30-day threshold only for unmerged branches and never deletes them', () => {
		const now = 40 * 24 * 60 * 60;
		const base = { name: 'topic', merged: false, commitTime: 10 * 24 * 60 * 60, now, lastActivity: 0, currentBranch: 'session' };
		expect(decisions('classifyBranch', [base, { ...base, commitTime: base.commitTime + 1 }, { ...base, merged: true }])).toEqual([
			{ staleUnmerged: true, recent: false, removable: false },
			{ staleUnmerged: false, recent: false, removable: false },
			{ staleUnmerged: false, recent: false, removable: true },
		]);
	});

	it('protects main, current, kept, and still-checked-out branches even when merged', () => {
		const base = { name: 'topic', merged: true, commitTime: 0, now: 86400, lastActivity: 0, currentBranch: 'session' };
		const protectedCases = [{ ...base, name: 'main' }, { ...base, name: 'session' }, { ...base, kept: true }, { ...base, checkedOut: true }];
		expect(decisions('classifyBranch', protectedCases)).toEqual(protectedCases.map(() => ({ staleUnmerged: false, recent: false, removable: false })));
	});
});

describe('branch hygiene recency decisions', () => {
	it('requires known activity at least 24 hours old', () => {
		expect(decisions('isRecent', [
			{ now: 86400, lastActivity: 0 }, { now: 86400, lastActivity: 1 },
			{ now: 86400 }, { now: 86400, lastActivity: null },
		])).toEqual([false, true, true, true]);
	});
});

describe('branch hygiene CLI in disposable repositories', () => {
	it('protects freshly created branches at old commits and recently touched worktrees', () => {
		const { repo, worktree } = fixture();
		git(repo, 'branch', 'fresh-branch', 'main');
		const fresh = worktree('fresh-tree');
		const touched = worktree('touched-tree');
		ageBranch(repo, 'touched-tree');
		const result = run(repo, '--apply');
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('fresh-branch [recent]');
		expect(result.stdout).toContain(`recent: ${fresh}`);
		expect(result.stdout).toContain(`recent: ${touched}`);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(touched)).toBe(true);
		expect(git(repo, 'rev-parse', 'fresh-branch')).toBe(git(repo, 'rev-parse', 'main'));
	});

	it('retains branches without reflogs and worktrees without readable activity evidence', () => {
		const { repo, worktree } = fixture();
		const tree = worktree('missing-index');
		git(repo, 'branch', 'missing-log', 'main');
		ageAll(repo);
		rmSync(resolve(repo, git(repo, 'rev-parse', '--git-path', 'logs/refs/heads/missing-log')));
		rmSync(join(resolve(tree, git(tree, 'rev-parse', '--git-dir')), 'index'));
		const result = run(repo, '--apply');
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('missing-log [recent]');
		expect(existsSync(tree)).toBe(true);
		expect(git(repo, 'rev-parse', 'missing-log')).toBe(git(repo, 'rev-parse', 'main'));
	});

	it('retains in-progress operations and hidden index flags, including otherwise clean files', () => {
		const { repo, worktree } = fixture();
		const operation = worktree('operation');
		const skipped = worktree('skipped');
		const assumed = worktree('assumed');
		ageAll(repo);
		writeFileSync(join(resolve(operation, git(operation, 'rev-parse', '--git-dir')), 'CHERRY_PICK_HEAD'), `${git(repo, 'rev-parse', 'main')}\n`);
		git(skipped, 'update-index', '--skip-worktree', 'tracked.txt');
		git(assumed, 'update-index', '--assume-unchanged', 'tracked.txt');
		writeFileSync(join(skipped, 'tracked.txt'), 'hidden work\n');
		const result = run(repo, '--apply');
		expect(result.status).toBe(0);
		for (const path of [operation, skipped, assumed]) {
			expect(result.stdout).toContain(`dirty: ${path}`);
			expect(existsSync(path)).toBe(true);
		}
		expect(readFileSync(join(skipped, 'tracked.txt'), 'utf8')).toBe('hidden work\n');
	});

	it('rechecks ignored work after acquiring its lock and releases the lock when retaining it', () => {
		const { root, repo, worktree } = fixture();
		const tree = worktree('lock-race');
		ageAll(repo);
		const bin = join(root, 'bin');
		mkdirSync(bin);
		const actualGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env }).trim();
		const wrapper = join(bin, 'git');
		writeFileSync(wrapper, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(actualGit)}, args, { stdio: 'inherit' });
if (result.status === 0 && args.includes('worktree') && args.includes('lock')) {
  mkdirSync(${JSON.stringify(join(tree, '.workspace'))});
  writeFileSync(${JSON.stringify(join(tree, '.workspace', 'arrived.txt'))}, 'arrived after lock');
}
process.exit(result.status ?? 1);
`);
		chmodSync(wrapper, 0o755);
		const result = spawnSync('node', [SCRIPT, '--apply'], {
			cwd: repo, encoding: 'utf8', env: { ...env, PATH: `${bin}:${process.env.PATH}` }, timeout: 30_000,
		});
		expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
		expect(readFileSync(join(tree, '.workspace', 'arrived.txt'), 'utf8')).toBe('arrived after lock');
		expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('locked');
		expect(git(repo, 'rev-parse', 'lock-race')).toBe(git(repo, 'rev-parse', 'main'));
	}, 30_000);

	it('deletes a verified merged branch even when the invoking HEAD is behind origin/main', () => {
		const { repo, worktree } = fixture();
		const ahead = worktree('ahead');
		writeFileSync(join(ahead, 'ahead.txt'), 'new commit\n');
		git(ahead, 'add', '.');
		git(ahead, 'commit', '-m', 'Advance origin');
		git(repo, 'push', 'origin', 'ahead:main');
		git(repo, 'branch', 'merged-ahead', 'ahead');
		ageAll(repo);
		const result = run(repo, '--apply', '--keep', 'ahead');
		expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
		expect(result.stdout).toContain('Deleted local branch: merged-ahead');
		expect(() => git(repo, 'show-ref', '--verify', 'refs/heads/merged-ahead')).toThrow();
	});

	it.each(['squash', 'rebase'])('retains the original %s-merged branch because its tip is not an ancestor', mode => {
		const { repo, worktree } = fixture();
		const topic = worktree('original-topic');
		writeFileSync(join(topic, 'topic.txt'), 'topic change\n');
		git(topic, 'add', '.');
		git(topic, 'commit', '-m', 'Original topic');
		writeFileSync(join(repo, 'base.txt'), 'advance base\n');
		git(repo, 'add', '.');
		git(repo, 'commit', '-m', 'New base');
		if (mode === 'squash') {
			git(repo, 'merge', '--squash', 'original-topic');
			git(repo, 'commit', '-m', 'Squashed topic');
			git(repo, 'push', 'origin', 'session:main');
		} else {
			git(repo, 'checkout', '-b', 'rebased-copy', 'original-topic');
			git(repo, 'rebase', 'session');
			git(repo, 'push', 'origin', 'rebased-copy:main');
			git(repo, 'checkout', 'session');
		}
		git(repo, 'branch', 'original-no-tree', 'original-topic');
		ageAll(repo);
		const original = git(repo, 'rev-parse', 'original-topic');
		const result = run(repo, '--apply');
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(`unmerged: ${topic}`);
		expect(existsSync(topic)).toBe(true);
		expect(git(repo, 'rev-parse', 'original-topic')).toBe(original);
		expect(git(repo, 'rev-parse', 'original-no-tree')).toBe(original);
		expect(spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', original, 'origin/main'], { env }).status).toBe(1);
	});
	it('reports without mutation, then removes only merged clean worktrees/branches and writes an append-only restore manifest', () => {
		const { root, repo, origin, worktree } = fixture();
		const clean = worktree('merged-clean', join(root, 'clean with spaces'));
		const dirty = worktree('dirty-tracked');
		writeFileSync(join(dirty, 'tracked.txt'), 'changed\n');
		const untracked = worktree('dirty-untracked');
		writeFileSync(join(untracked, 'scratch.txt'), 'keep this\n');
		const locked = worktree('locked-topic');
		git(repo, 'worktree', 'lock', '--reason', 'fixture lock', locked);
		const unmerged = worktree('unmerged-topic');
		writeFileSync(join(unmerged, 'tracked.txt'), 'unmerged\n');
		git(unmerged, 'add', '.');
		execFileSync('git', ['-C', unmerged, 'commit', '-m', 'Unmerged fixture'], {
			env: { ...env, GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' },
			stdio: 'pipe',
		});
		git(repo, 'branch', 'unmerged-no-worktree', 'unmerged-topic');
		const keepBranch = worktree('keep-file-branch');
		const keepPath = worktree('keep-file-path', join(root, 'kept with spaces'));
		const cliBranch = worktree('keep-cli-branch');
		const cliPath = worktree('keep-cli-path');
		const mainPath = join(root, 'main-checkout');
		git(repo, 'worktree', 'add', mainPath, 'main');
		const detached = join(root, 'detached');
		git(repo, 'worktree', 'add', '--detach', detached, 'main');
		const outer = worktree('outer');
		const inner = worktree('inner', join(outer, '.nested', 'inner'));
		git(repo, 'branch', 'merged-no-worktree', 'main');
		git(repo, 'branch', 'kept-no-worktree', 'main');
		git(repo, 'branch', 'kept#hash', 'main');
		git(repo, 'push', 'origin', 'main:merged-remote');
		writeFileSync(join(repo, '.branch-hygiene-keep'), `# Important work\nkeep-file-branch\n${relative(repo, keepPath)}\nkept-no-worktree\nkept#hash\n\n`);
		const sha = git(repo, 'rev-parse', 'main');
		const keepArgs = ['--keep', 'keep-cli-branch', '--keep', relative(repo, cliPath)];

		ageAll(repo);
		const report = run(repo, ...keepArgs);
		expect(report.status).toBe(0);
		expect(report.stdout).toContain('report only');
		expect(report.stdout).toContain(`clean+merged: ${clean}`);
		expect(report.stdout).toContain(`dirty: ${dirty}`);
		expect(report.stdout).toContain(`dirty: ${untracked}`);
		expect(report.stdout).toContain(`locked: ${locked}`);
		expect(report.stdout).toContain(`unmerged: ${unmerged}`);
		expect(report.stdout).toContain('Unmerged local branches with no commit in 30+ days (report only): 2');
		expect(report.stdout).toContain('Remote branches merged into origin/main (report only): 1');
		expect(existsSync(clean)).toBe(true);
		expect(existsSync(join(repo, '.workspace'))).toBe(false);
		expect(git(repo, 'rev-parse', 'merged-no-worktree')).toBe(sha);

		const applied = run(repo, '--apply', ...keepArgs);
		expect({ status: applied.status, stderr: applied.stderr }).toEqual({ status: 0, stderr: '' });
		expect(applied.stdout).toContain('Removed worktrees: 2. Deleted local branches: 3. Refused operations: 0.');
		expect(existsSync(clean)).toBe(false);
		expect(existsSync(inner)).toBe(false);
		for (const kept of [dirty, untracked, locked, unmerged, keepBranch, keepPath, cliBranch, cliPath, mainPath, detached, outer, repo]) {
			expect(existsSync(kept)).toBe(true);
		}
		for (const name of ['merged-clean', 'inner', 'merged-no-worktree']) {
			expect(() => git(repo, 'show-ref', '--verify', `refs/heads/${name}`)).toThrow();
		}
		for (const name of ['main', 'session', 'dirty-tracked', 'dirty-untracked', 'locked-topic', 'unmerged-topic', 'unmerged-no-worktree', 'keep-file-branch', 'keep-file-path', 'keep-cli-branch', 'keep-cli-path', 'outer', 'kept-no-worktree', 'kept#hash']) {
			expect(git(repo, 'rev-parse', '--verify', `refs/heads/${name}`)).toMatch(/^[a-f0-9]{40}$/);
		}
		expect(git(origin, 'rev-parse', 'merged-remote')).toBe(sha);
		expect(readFileSync(join(dirty, 'tracked.txt'), 'utf8')).toBe('changed\n');
		expect(readFileSync(join(untracked, 'scratch.txt'), 'utf8')).toBe('keep this\n');
		const manifestPath = join(repo, '.workspace', readdirSync(join(repo, '.workspace'))[0]);
		const firstManifest = readFileSync(manifestPath, 'utf8');
		expect(firstManifest).toContain('# Restore each entry with: git branch <branch> <sha>');
		for (const name of ['merged-clean', 'inner', 'merged-no-worktree']) expect(firstManifest).toContain(`${sha} ${name}\n`);
		expect(firstManifest).not.toContain(`${sha} keep-file-branch\n`);
		git(repo, 'branch', 'second-pass', 'main');
		ageBranch(repo, 'second-pass');
		// Keep the previously protected outer worktree while verifying append.
		const second = run(repo, '--apply', ...keepArgs, '--keep', 'outer');
		expect(second.status).toBe(0);
		const appendedManifest = readFileSync(manifestPath, 'utf8');
		expect(appendedManifest.startsWith(firstManifest)).toBe(true);
		expect(appendedManifest).toContain(`${sha} second-pass\n`);
	}, 30_000);

	it('protects the current merged branch when invoked from a linked worktree', () => {
		const { repo, worktree } = fixture();
		const current = worktree('current-linked');
		const other = worktree('other-linked');
		const kept = worktree('primary-kept');
		writeFileSync(join(repo, '.branch-hygiene-keep'), 'primary-kept\n');
		ageAll(repo);
		const result = run(current, '--apply');
		expect(result.status).toBe(0);
		expect(existsSync(current)).toBe(true);
		expect(existsSync(repo)).toBe(true);
		expect(existsSync(other)).toBe(false);
		expect(existsSync(kept)).toBe(true);
		expect(existsSync(join(current, '.workspace'))).toBe(false);
		expect(readdirSync(join(repo, '.workspace')).length).toBe(1);
		expect(git(current, 'branch', '--show-current')).toBe('current-linked');
	});

	it('fails with actionable errors outside a repo, without origin/main, and on malformed options', () => {
		const outside = run(sandbox());
		expect(outside.status).toBe(1);
		expect(outside.stderr).toContain('Run branch hygiene from a Git working tree');
		const { repo } = fixture('trunk');
		const missing = run(repo, '--apply');
		expect(missing.status).toBe(1);
		expect(missing.stderr).toContain('origin/main is missing');
		expect(git(repo, 'branch', '--show-current')).toBe('session');
		expect(existsSync(join(repo, '.workspace'))).toBe(false);
		const invalid = run(repo, '--keep');
		expect(invalid.status).toBe(1);
		expect(invalid.stderr).toContain('--keep <path-or-branch>');
	});

	it('preserves ignored local scratch work rather than treating it as disposable', () => {
		const { repo, worktree } = fixture();
		const ignored = worktree('ignored-scratch');
		mkdirSync(join(ignored, '.workspace'));
		const scratch = join(ignored, '.workspace', 'private.txt');
		writeFileSync(scratch, 'not recoverable from a branch\n');
		const result = run(repo, '--apply');
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(`dirty: ${ignored}`);
		expect(readFileSync(scratch, 'utf8')).toBe('not recoverable from a branch\n');
		expect(git(repo, 'rev-parse', 'ignored-scratch')).toBe(git(repo, 'rev-parse', 'main'));
	});

	it('does not perform local cleanup if fetching origin fails', () => {
		const { repo, worktree } = fixture();
		const clean = worktree('fetch-failure');
		git(repo, 'remote', 'set-url', 'origin', join(repo, 'missing-remote'));
		const result = run(repo, '--apply');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Could not fetch origin');
		expect(existsSync(clean)).toBe(true);
		expect(existsSync(join(repo, '.workspace'))).toBe(false);
	});
});
