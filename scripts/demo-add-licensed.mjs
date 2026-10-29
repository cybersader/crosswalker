#!/usr/bin/env bun
/**
 * demo-add-licensed: add a licensed framework the user already holds to a demo
 * vault that `bun run demo:build` produced, on the user's own machine.
 *
 *   bun run demo:add-licensed -- --private-room-only --vault <demo vault> --source <workbook>
 *
 * It imports the CRI Profile v2.2 workbook with the shipped recipe
 * recipes/import/cri-profile-v2-2-nested.json, which also writes that recipe's
 * built-in links to NIST CSF 2.0, then adds the framework's color to the graph
 * view settings and the Start here note.
 *
 * Why it is separate and opt-in: the CRI Profile is licensed CC BY-NC-ND, which
 * forbids sharing adapted copies. A vault with it inside must stay in a private
 * room. So this script never runs inside demo:build, refuses to write inside the
 * repository, and refuses to run at all unless --private-room-only is passed.
 * This file is code only; it carries none of the framework's content.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMEWORK_GROUPS, demoGraphGroups, demoGraphJson } from '../tools/lib/demo-graph.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const START_HERE = 'Start here.md';
const GRAPH = '.obsidian/graph.json';
const RECIPE = 'recipes/import/cri-profile-v2-2-nested.json';
const DEFAULT_SOURCE = 'Frameworks/CRI-Profile-ver.-2.2.2026-04-27.xlsx';
const SHEET = 'CRI Profile v2.2 Structure';
const HEADER_ROW = '3';
const DESTINATION = 'Frameworks/CRI-Profile-2.2';
const KEY = 'cri';
const USAGE = 'Usage: bun run demo:add-licensed -- --private-room-only --vault <demo vault> [--source <workbook>]';

function fail(message, code = 1) {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function parseArgs(argv) {
	const args = argv[0] === '--' ? argv.slice(1) : argv;
	const opts = { privateRoomOnly: false, vault: undefined, source: DEFAULT_SOURCE };
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--private-room-only') opts.privateRoomOnly = true;
		else if (a === '--vault') opts.vault = args[++i];
		else if (a === '--source') opts.source = args[++i];
		else fail(`Unknown option "${a}". ${USAGE}`);
	}
	return opts;
}

function inside(parent, child) {
	const rel = path.relative(parent, child);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The framework keys the vault's graph settings already color. */
function presentKeys(vault) {
	const graph = JSON.parse(fs.readFileSync(path.join(vault, GRAPH), 'utf8'));
	const queries = new Set((graph.colorGroups ?? []).map((g) => g.query));
	return FRAMEWORK_GROUPS.filter((g) => queries.has(g.query)).map((g) => g.key);
}

/** Replace the color list under "## Graph colors" with the current groups. */
function updateStartHere(vault, keys) {
	const file = path.join(vault, START_HERE);
	const lines = fs.readFileSync(file, 'utf8').split('\n');
	const start = lines.indexOf('## Graph colors');
	if (start < 0) return;
	let first = start + 1;
	while (first < lines.length && !lines[first].startsWith('- **')) first++;
	let end = first;
	while (end < lines.length && lines[end].startsWith('- **')) end++;
	const list = demoGraphGroups(keys).map((g) => `- **${g.name}**: ${g.label}`);
	lines.splice(first, end - first, ...list);
	fs.writeFileSync(file, lines.join('\n'));
}

/**
 * A relative --source resolves against this checkout, then against the main
 * checkout when this one is a git worktree (the workbook is gitignored, so a
 * fresh worktree does not have it).
 */
function locate(source) {
	if (path.isAbsolute(source)) return source;
	const here = path.resolve(REPO, source);
	if (fs.existsSync(here)) return here;
	const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO, encoding: 'utf8' });
	if (common.status === 0) {
		const main = path.resolve(path.dirname(common.stdout.trim()), source);
		if (fs.existsSync(main)) return main;
	}
	return here;
}

function cw(vault, args) {
	const result = spawnSync('bun', ['--preload', './cli/preload.ts', 'cli/main.ts', ...args, '--vault', vault], {
		cwd: REPO,
		encoding: 'utf8',
	});
	if (result.error) fail(`Could not start bun: ${result.error.message}. Check bun is installed and on PATH, then run this again.`);
	return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (!opts.privateRoomOnly) {
		fail(
			'Refusing to add the licensed framework. The CRI Profile is licensed CC BY-NC-ND, which forbids sharing adapted copies, ' +
				'and a vault with it inside is one. Pass --private-room-only to confirm this vault stays on your machine or in a private room, ' +
				`never in a shared or public one.\n${USAGE}`,
		);
	}
	if (!opts.vault) fail(`Missing --vault. Pass the folder a demo build wrote, for example /tmp/crosswalker-demo.\n${USAGE}`);
	const vault = path.resolve(opts.vault);
	if (inside(REPO, vault)) fail(`Refusing ${vault}: it is inside the repository, where the licensed notes could be committed. Use a folder outside it.`);
	if (!fs.existsSync(path.join(vault, START_HERE)) || !fs.existsSync(path.join(vault, GRAPH))) {
		fail(`${vault} is not a demo vault. Build one first with: bun run demo:build -- --out ${vault}`);
	}
	const keys = presentKeys(vault);
	if (keys.includes(KEY) || fs.existsSync(path.join(vault, DESTINATION))) {
		fail(`${vault} already has the licensed framework. Build a fresh demo vault to add it again.`);
	}
	const source = locate(opts.source);
	if (!fs.existsSync(source)) {
		fail(`Cannot find the workbook at ${source}. Download the CRI Profile v2.2 workbook you are licensed to use, then pass its path with --source.`);
	}

	const imported = cw(vault, ['import', '--source', source, '--recipe', RECIPE, '--sheet', SHEET, '--header-row', HEADER_ROW, '--destination', DESTINATION, '--deterministic']);
	if (imported.code !== 0) {
		process.stderr.write(imported.stdout + imported.stderr);
		fail(`The import stopped (exit ${imported.code}). The lines above say why; nothing else in the vault was changed.`);
	}
	process.stdout.write(`  Licensed framework: ${imported.stdout.trim().split('\n').pop()}\n`);

	const next = [...keys, KEY];
	fs.writeFileSync(path.join(vault, GRAPH), demoGraphJson(next));
	updateStartHere(vault, next);

	const check = cw(vault, ['validate']);
	process.stdout.write(check.stdout);
	if (check.code !== 0) {
		process.stderr.write(check.stderr);
		fail('The vault did not validate after the import. The lines above name each failing note.', 2);
	}
	process.stdout.write(`Added to ${vault}. Keep this vault private: the licensed framework inside it cannot be shared.\n`);
}

main();
