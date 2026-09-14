#!/usr/bin/env node
/**
 * Release preflight: every publication decision `.github/workflows/release.yml`
 * makes, in plain Node so it can be tested.
 *
 * Why this exists: the release workflow used to decide everything inline in
 * YAML, where nothing could be proven without pushing to main. That inline
 * logic deleted and recreated an existing tag on every rerun, published every
 * version as a non-prerelease marked latest, and silently fell back to a bare
 * "Release <version>" body whenever CHANGELOG.md had no matching heading. Two
 * already published 0.x prereleases would have been overwritten by the next
 * merge. The rules now live here, and `tests/release-preflight.test.ts` proves
 * them without running Actions. The workflow only executes what this decides.
 *
 * Hard rule: an already published version is skipped, never republished. This
 * script never asks the workflow to delete, move, or overwrite anything.
 *
 * Usage:
 *   node scripts/release-preflight.mjs --tag-exists false --release-exists false
 *   node scripts/release-preflight.mjs --repo-root . --notes-out release_notes.md \
 *     --tag-exists true --release-exists true --github-output "$GITHUB_OUTPUT"
 *
 * Inputs may also be supplied by environment variable; a flag always wins:
 *   RELEASE_PREFLIGHT_REPO_ROOT, RELEASE_PREFLIGHT_CHANGELOG,
 *   RELEASE_PREFLIGHT_NOTES_OUT, RELEASE_PREFLIGHT_TAG_EXISTS,
 *   RELEASE_PREFLIGHT_RELEASE_EXISTS, RELEASE_PREFLIGHT_FORCE, GITHUB_OUTPUT.
 *
 * Exit 0 with `action=publish` or `action=skip` on stdout as `key=value` lines.
 * Exit 1 with a single `cause: ... action: ...` line on stderr when the release
 * must not proceed.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Flags win over environment. `--flag value`, `--flag=value`, and bare `--flag` all parse. */
function parseArgs(argv) {
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) continue;
		const eq = arg.indexOf('=');
		if (eq !== -1) {
			flags[arg.slice(2, eq)] = arg.slice(eq + 1);
			continue;
		}
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) {
			flags[key] = 'true';
			continue;
		}
		flags[key] = next;
		i++;
	}
	return flags;
}

function fail(cause, action) {
	process.stderr.write(`release preflight: cause: ${cause} action: ${action}\n`);
	process.exit(1);
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readJson(path, label) {
	let raw;
	try {
		raw = readFileSync(path, 'utf8');
	} catch {
		fail(`${label} could not be read.`, `run this from the repository root, or pass --repo-root.`);
	}
	try {
		return JSON.parse(raw);
	} catch {
		fail(`${label} is not valid JSON.`, `fix the file, then rerun.`);
	}
	return undefined;
}

/**
 * The heading must be exactly `## [<version>]`, so `## [0.1.0]` never matches
 * `## [0.1.0-mvp-scaffold]`. The body runs to the next `## ` heading or a `---`
 * rule. There is deliberately no fallback body: a missing heading is an error,
 * not a reason to publish a placeholder.
 */
function extractNotes(changelog, version) {
	const lines = changelog.split(/\r?\n/);
	const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\](?=$|\\s)`);
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (heading.test(lines[i])) {
			start = i + 1;
			break;
		}
	}
	if (start === -1) return null;
	const body = [];
	for (let i = start; i < lines.length; i++) {
		if (/^## /.test(lines[i])) break;
		if (/^---\s*$/.test(lines[i])) break;
		body.push(lines[i]);
	}
	return body.join('\n').trim();
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const env = process.env;

	const pick = (flag, envName, fallback) => {
		if (args[flag] !== undefined) return args[flag];
		if (envName && env[envName] !== undefined && env[envName] !== '') return env[envName];
		return fallback;
	};

	const repoRoot = resolve(pick('repo-root', 'RELEASE_PREFLIGHT_REPO_ROOT', process.cwd()));
	const changelogPath = resolve(
		repoRoot,
		pick('changelog', 'RELEASE_PREFLIGHT_CHANGELOG', join(repoRoot, 'CHANGELOG.md'))
	);
	const notesOut = resolve(process.cwd(), pick('notes-out', 'RELEASE_PREFLIGHT_NOTES_OUT', 'release_notes.md'));
	const githubOutput = pick('github-output', 'GITHUB_OUTPUT', '');

	// `--force` is accepted and deliberately changes nothing here. It exists so
	// the workflow's `force_release` dispatch input can bypass the cheap
	// "version unchanged since the previous commit" early exit in the YAML. It
	// never bypasses a missing changelog heading and never republishes.
	pick('force', 'RELEASE_PREFLIGHT_FORCE', 'false');

	const readBoolean = (flag, envName) => {
		const raw = pick(flag, envName, undefined);
		if (raw === undefined) {
			fail(
				`--${flag} was not supplied.`,
				`pass --${flag} true or --${flag} false; the workflow computes it before calling this script.`
			);
		}
		if (raw === 'true') return true;
		if (raw === 'false') return false;
		fail(`--${flag} must be true or false, got "${raw}".`, `pass a literal true or false.`);
		return false;
	};

	const tagExists = readBoolean('tag-exists', 'RELEASE_PREFLIGHT_TAG_EXISTS');
	const releaseExists = readBoolean('release-exists', 'RELEASE_PREFLIGHT_RELEASE_EXISTS');

	const emit = (outputs) => {
		const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
		process.stdout.write(lines.map((line) => `${line}\n`).join(''));
		if (githubOutput) appendFileSync(githubOutput, `${lines.join('\n')}\n`, 'utf8');
	};

	// 1. Version consistency across the three files that carry a version.
	const pkg = readJson(join(repoRoot, 'package.json'), 'package.json');
	const manifest = readJson(join(repoRoot, 'manifest.json'), 'manifest.json');
	const versions = readJson(join(repoRoot, 'versions.json'), 'versions.json');

	const version = typeof pkg.version === 'string' ? pkg.version : '';
	const manifestVersion = typeof manifest.version === 'string' ? manifest.version : '';
	const minAppVersion = typeof manifest.minAppVersion === 'string' ? manifest.minAppVersion : '';

	if (!version) {
		fail(`package.json has no version string.`, `set package.json version, then rerun.`);
	}
	if (version !== manifestVersion) {
		fail(
			`package.json version "${version}" does not match manifest.json version "${manifestVersion}".`,
			`set both files to the same version, for example with bun run version, then rerun.`
		);
	}
	if (!Object.prototype.hasOwnProperty.call(versions, version)) {
		fail(
			`versions.json has no "${version}" entry.`,
			`add "${version}": "${minAppVersion}" to versions.json, or run bun run version.`
		);
	}
	if (String(versions[version]) !== minAppVersion) {
		fail(
			`versions.json maps "${version}" to "${versions[version]}", but manifest.json minAppVersion is "${minAppVersion}".`,
			`make the two agree, then rerun.`
		);
	}

	// 2. Version shape.
	const parsed = SEMVER.exec(version);
	if (!parsed) {
		fail(
			`version "${version}" is not MAJOR.MINOR.PATCH with an optional prerelease suffix.`,
			`correct package.json and manifest.json, then rerun.`
		);
	}

	// 5. Prerelease decision, computed up front so a skip still reports it.
	const prerelease = Number(parsed[1]) === 0 || Boolean(parsed[4]);

	// 3. Publication state. Already published means skip, never republish.
	if (tagExists || releaseExists) {
		const found = [];
		if (tagExists) found.push('tag');
		if (releaseExists) found.push('release');
		emit({
			action: 'skip',
			version,
			tag: version,
			prerelease: String(prerelease),
			reason: `version ${version} is already published: existing ${found.join(' and ')}. Nothing was deleted or overwritten.`,
		});
		return;
	}

	// 4. Notes extraction. No fallback body.
	let changelog;
	try {
		changelog = readFileSync(changelogPath, 'utf8');
	} catch {
		fail(`CHANGELOG.md could not be read.`, `check the --changelog path, then rerun.`);
	}
	const notes = extractNotes(changelog, version);
	if (notes === null) {
		fail(
			`CHANGELOG.md has no "## [${version}]" heading.`,
			`add one above [Unreleased] content for this version, or dispatch with force_release only after adding it.`
		);
	}
	if (notes === '') {
		fail(
			`the "## [${version}]" section in CHANGELOG.md is empty.`,
			`write the release notes under that heading, then rerun.`
		);
	}
	writeFileSync(notesOut, `${notes}\n`, 'utf8');

	emit({
		action: 'publish',
		version,
		tag: version,
		prerelease: String(prerelease),
		notes_path: notesOut,
	});
}

main();
