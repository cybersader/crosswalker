import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(__dirname, '..', 'scripts', 'release-preflight.mjs');

interface RepoOptions {
	version: string;
	manifestVersion?: string;
	minAppVersion?: string;
	versions?: Record<string, string>;
	changelog: string;
}

const roots: string[] = [];

/** Build a throwaway repo shape: the three version files plus a CHANGELOG. */
function makeRepo(options: RepoOptions): string {
	const root = mkdtempSync(join(tmpdir(), 'crosswalker-preflight-'));
	roots.push(root);
	const manifestVersion = options.manifestVersion ?? options.version;
	const minAppVersion = options.minAppVersion ?? '1.10.0';
	const versions = options.versions ?? { [options.version]: minAppVersion };
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'crosswalker', version: options.version }));
	writeFileSync(
		join(root, 'manifest.json'),
		JSON.stringify({ id: 'crosswalker', version: manifestVersion, minAppVersion }),
	);
	writeFileSync(join(root, 'versions.json'), JSON.stringify(versions));
	writeFileSync(join(root, 'CHANGELOG.md'), options.changelog);
	return root;
}

function runPreflight(root: string, args: string[]) {
	const result = spawnSync('node', [SCRIPT, '--repo-root', root, ...args], {
		cwd: root,
		encoding: 'utf-8',
	});
	const outputs: Record<string, string> = {};
	for (const line of result.stdout.split('\n')) {
		const eq = line.indexOf('=');
		if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
	}
	return { status: result.status, stdout: result.stdout, stderr: result.stderr, outputs };
}

const PUBLISHABLE_CHANGELOG = [
	'# Changelog',
	'',
	'## [Unreleased]',
	'',
	'- pending work',
	'',
	'## [0.1.2] - 2026-09-20',
	'',
	'- the notes body',
	'- second line',
	'',
	'## [0.1.1] - 2026-09-14',
	'',
	'- older notes',
	'',
].join('\n');

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('release preflight', () => {
	it('A: skips when both the tag and the release already exist, and writes no notes', () => {
		const root = makeRepo({ version: '0.1.1', changelog: PUBLISHABLE_CHANGELOG });
		const result = runPreflight(root, ['--tag-exists', 'true', '--release-exists', 'true']);
		expect(result.status).toBe(0);
		expect(result.outputs.action).toBe('skip');
		expect(result.outputs.version).toBe('0.1.1');
		expect(result.outputs.tag).toBe('0.1.1');
		expect(result.outputs.reason).toContain('tag');
		expect(result.outputs.reason).toContain('release');
		expect(result.outputs.notes_path).toBeUndefined();
		expect(existsSync(join(root, 'release_notes.md'))).toBe(false);
	});

	it('B: skips when only the tag exists', () => {
		const root = makeRepo({ version: '0.1.1', changelog: PUBLISHABLE_CHANGELOG });
		const result = runPreflight(root, ['--tag-exists', 'true', '--release-exists', 'false']);
		expect(result.status).toBe(0);
		expect(result.outputs.action).toBe('skip');
		expect(existsSync(join(root, 'release_notes.md'))).toBe(false);
	});

	it('C: publishes with notes taken from the matching heading and stopping at the next one', () => {
		const root = makeRepo({ version: '0.1.2', changelog: PUBLISHABLE_CHANGELOG });
		const result = runPreflight(root, ['--tag-exists', 'false', '--release-exists', 'false']);
		expect(result.status).toBe(0);
		expect(result.outputs.action).toBe('publish');
		expect(result.outputs.prerelease).toBe('true');
		const notes = readFileSync(result.outputs.notes_path, 'utf-8');
		expect(notes.trim()).toBe('- the notes body\n- second line');
		expect(notes).not.toContain('older notes');
		expect(notes).not.toContain('pending work');
	});

	it('D: fails when no matching heading exists, and --force does not bypass it', () => {
		const changelog = [
			'# Changelog',
			'',
			'## [Unreleased]',
			'',
			'### Second prerelease preparation, 0.1.2 (2026-09-20)',
			'',
			'- prepared 0.1.2',
			'',
		].join('\n');
		const root = makeRepo({ version: '0.1.2', changelog });
		const plain = runPreflight(root, ['--tag-exists', 'false', '--release-exists', 'false']);
		expect(plain.status).not.toBe(0);
		expect(plain.stderr).toContain('no "## [0.1.2]" heading');
		const forced = runPreflight(root, ['--tag-exists', 'false', '--release-exists', 'false', '--force']);
		expect(forced.status).not.toBe(0);
		expect(forced.stderr).toContain('no "## [0.1.2]" heading');
		expect(existsSync(join(root, 'release_notes.md'))).toBe(false);
	});

	it('E: does not match a longer heading such as the historical scaffold entry', () => {
		const changelog = [
			'# Changelog',
			'',
			'## [Unreleased]',
			'',
			'- pending work',
			'',
			'## [0.1.0-mvp-scaffold] - 2026-04-02',
			'',
			'- the old scaffold notes',
			'',
		].join('\n');
		const root = makeRepo({ version: '0.1.0', changelog });
		const result = runPreflight(root, ['--tag-exists', 'false', '--release-exists', 'false']);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('no "## [0.1.0]" heading');
	});

	it('F: takes the first matching heading when the same version appears twice', () => {
		const changelog = [
			'# Changelog',
			'',
			'## [0.1.0] - 2026-09-13',
			'',
			'- the real notes',
			'',
			'## [0.1.0] - 2026-04-02',
			'',
			'- the stale notes',
			'',
		].join('\n');
		const root = makeRepo({ version: '0.1.0', changelog });
		const result = runPreflight(root, ['--tag-exists', 'false', '--release-exists', 'false']);
		expect(result.status).toBe(0);
		const notes = readFileSync(result.outputs.notes_path, 'utf-8');
		expect(notes.trim()).toBe('- the real notes');
	});

	it('G: fails when manifest.json and package.json disagree, naming both files', () => {
		const root = makeRepo({ version: '0.1.2', manifestVersion: '0.1.1', changelog: PUBLISHABLE_CHANGELOG });
		const result = runPreflight(root, ['--tag-exists', 'false', '--release-exists', 'false']);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('package.json');
		expect(result.stderr).toContain('manifest.json');
	});

	it('H: fails when versions.json has no entry for the version', () => {
		const root = makeRepo({
			version: '0.1.2',
			versions: { '0.1.1': '1.10.0' },
			changelog: PUBLISHABLE_CHANGELOG,
		});
		const result = runPreflight(root, ['--tag-exists', 'false', '--release-exists', 'false']);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('versions.json');
	});

	it('I: treats a 1.0.0 release as a full release', () => {
		const changelog = ['# Changelog', '', '## [1.0.0] - 2026-10-01', '', '- first stable', ''].join('\n');
		const root = makeRepo({ version: '1.0.0', changelog });
		const result = runPreflight(root, ['--tag-exists', 'false', '--release-exists', 'false']);
		expect(result.status).toBe(0);
		expect(result.outputs.action).toBe('publish');
		expect(result.outputs.prerelease).toBe('false');
	});

	it('J: treats a suffixed 1.0.0-rc.1 as a prerelease', () => {
		const changelog = ['# Changelog', '', '## [1.0.0-rc.1] - 2026-10-01', '', '- release candidate', ''].join('\n');
		const root = makeRepo({ version: '1.0.0-rc.1', changelog });
		const result = runPreflight(root, ['--tag-exists', 'false', '--release-exists', 'false']);
		expect(result.status).toBe(0);
		expect(result.outputs.prerelease).toBe('true');
	});

	it('K: appends every emitted output to the --github-output file', () => {
		const root = makeRepo({ version: '0.1.2', changelog: PUBLISHABLE_CHANGELOG });
		const outputFile = join(root, 'github-output.txt');
		const result = runPreflight(root, [
			'--tag-exists',
			'false',
			'--release-exists',
			'false',
			'--github-output',
			outputFile,
		]);
		expect(result.status).toBe(0);
		const written = readFileSync(outputFile, 'utf-8');
		for (const [key, value] of Object.entries(result.outputs)) {
			expect(written).toContain(`${key}=${value}`);
		}
		expect(written).toContain('action=publish');
		expect(written).toContain('tag=0.1.2');
		expect(written).toContain('prerelease=true');
		expect(written).toContain('notes_path=');
	});

	it('never instructs the workflow to delete or move a tag', () => {
		const source = readFileSync(SCRIPT, 'utf-8');
		expect(source).not.toContain('tag -d');
		expect(source).not.toContain(':refs/tags');
	});
});
