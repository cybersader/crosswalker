import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Shared harness for the documentation-gate tests: build a throwaway repo
 * from fixture strings, run one gate script against it with --repo-root, and
 * return its exit code and plain-text output.
 */

export const SCRIPTS = join(__dirname, '..', '..', 'scripts');

const roots: string[] = [];

export function makeRepo(files: Record<string, string>, options: { git?: boolean } = {}): string {
	const root = mkdtempSync(join(tmpdir(), 'crosswalker-gate-'));
	roots.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
	if (options.git) {
		const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf-8' });
		git('init', '-q');
		git('add', '-A');
	}
	return root;
}

export function cleanupRepos(): void {
	while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
}

export interface GateRun {
	status: number | null;
	out: string;
}

export function runGate(script: string, root: string | null, args: string[] = []): GateRun {
	const full = [join(SCRIPTS, script), ...(root ? ['--repo-root', root] : []), ...args];
	const result = spawnSync('node', full, { encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } });
	return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** A minimal docs page with frontmatter. */
export function page(body: string, title = 'Page'): string {
	return `---\ntitle: ${title}\n---\n\n${body}\n`;
}

export const DOCS = 'docs/src/content/docs';
