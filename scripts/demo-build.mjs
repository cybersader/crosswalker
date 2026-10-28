#!/usr/bin/env bun
/**
 * demo-build.mjs: build the multi-framework demo vault.
 *
 *   bun run demo:build -- --out <dir>
 *
 * Every Crosswalker note is written by the command line (`bun run cw`), never
 * by calling the engine from here, so the demo is exactly what a user running
 * the same commands would get. Every step runs with --deterministic and reads
 * only committed fixtures, so two builds write byte-identical trees and the
 * build works offline.
 *
 * The script itself writes only the non-Crosswalker files a person would add
 * by hand: the evidence documents, the reviewer's approval on some evidence
 * links, the saved queries (rendered from the shipped query templates) and the
 * "Start here" note.
 *
 * Content rule: public-domain or synthetic only. Nothing from
 * test-vault/Frameworks/_licensed/, and none of the licensed frameworks or
 * their realistic subsets (CRI, ISO, SOC 2, PCI, CIS, SCF).
 *
 * Exit codes: 0 built and valid, 1 a step failed, 2 the finished vault did not
 * validate.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRecipeTemplate } from '../src/views/recipe-templates.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const START_HERE = 'Start here.md';

/** Names that must never appear in a demo source path or a demo folder name. */
export const RESTRICTED = /(_licensed|\bcri\b|cri-profile|iso[-_ ]?27|\biso\b|soc[-_ ]?2|\bpci\b|\bcis\b|cis-controls|\bscf\b)/i;

const FRAMEWORKS = [
	{ key: 'csf', label: 'NIST CSF 2.0 (Govern and Identify functions)', source: 'tools/fixtures/realistic/nist-csf-2.0-govern-identify.csv', ontology: 'nist-csf-2', destination: 'Frameworks/NIST-CSF-2.0' },
	{ key: 'sp80053', label: 'NIST SP 800-53 Rev. 5 (Access Control family)', source: 'tools/fixtures/realistic/nist-800-53-ac-family.csv', ontology: 'nist-800-53', destination: 'Frameworks/NIST-SP-800-53-r5' },
	{ key: 'attack', label: 'MITRE ATT&CK (Persistence techniques)', source: 'tools/fixtures/realistic/mitre-attack-persistence-subset.csv', ontology: 'mitre-attack', destination: 'Frameworks/MITRE-ATT&CK' },
];

const MAPPINGS = [
	{ key: 'csfTo80053', label: 'NIST CSF 2.0 to SP 800-53', source: 'recipes/import/crosswalks/nist-csf-2-to-nist-800-53.sssom.tsv', destination: '_crosswalker/mappings/csf-to-800-53' },
	{ key: 'csfToAttack', label: 'NIST CSF to MITRE ATT&CK', source: 'tools/fixtures/realistic/nist-csf-to-mitre-attack.sssom.tsv', destination: '_crosswalker/mappings/csf-to-mitre' },
];

const EVIDENCE_LINKS = 'tools/fixtures/demo/evidence-links.csv';

/** Added last when the checkout ships it, so the set ids above never shift. */
const F3 = { key: 'f3', label: 'MITRE Fight Fraud Framework (sample techniques)', source: 'tools/fixtures/synthetic/mitre-f3-mini.csv', recipe: 'mitre-f3-technique-flat', destination: 'Frameworks/MITRE-F3' };

/** Synthetic evidence documents. Names match the objects in EVIDENCE_LINKS. */
const EVIDENCE_DOCUMENTS = {
	'Access Control Policy': 'Sample policy. States who approves access, how often access is reviewed, and who owns this policy.',
	'Quarterly Account Review': 'Sample review record. Each quarter the system owner lists active production accounts and removes any that are no longer needed.',
	'Joiner Mover Leaver Runbook': 'Sample runbook. Steps for creating an account when someone joins, changing it when they move teams, and removing it when they leave.',
	'Role Matrix': 'Sample matrix. Lists each application role and the permissions it grants.',
	'Admin Access Review': 'Sample review record. Administrator group membership is checked each month and every change is recorded.',
};

/** The reviewer has approved these links; the rest still wait for review. */
const APPROVED_LINKS = ['jn-ac-1-access-control-policy.md', 'jn-ac-2-quarterly-account-review.md', 'jn-ac-3-role-matrix.md'];

function fail(message, code = 1) {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function parseArgs(argv) {
	const args = argv[0] === '--' ? argv.slice(1) : argv;
	let out;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--out') out = args[++i];
		else if (args[i].startsWith('--out=')) out = args[i].slice('--out='.length);
		else fail(`Unknown option "${args[i]}". Usage: bun run demo:build -- --out <folder>`);
	}
	if (!out) fail('Missing --out. Pass the folder to build the demo vault in, for example: bun run demo:build -- --out /tmp/crosswalker-demo');
	return { out: path.resolve(out) };
}

/** Start from an empty folder. Only a previous demo build is ever cleared. */
function prepareOut(out) {
	if (!fs.existsSync(out)) return fs.mkdirSync(out, { recursive: true });
	const entries = fs.readdirSync(out);
	if (entries.length === 0) return;
	if (!entries.includes(START_HERE)) {
		fail(`${out} is not empty and is not a previous demo build. Pick an empty or new folder for --out.`);
	}
	fs.rmSync(out, { recursive: true, force: true });
	fs.mkdirSync(out, { recursive: true });
}

function cw(out, args) {
	const result = spawnSync('bun', ['--preload', './cli/preload.ts', 'cli/main.ts', ...args, '--vault', out], {
		cwd: REPO,
		encoding: 'utf8',
	});
	if (result.error) fail(`Could not start bun: ${result.error.message}. Check bun is installed and on PATH, then run the build again.`);
	return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function step(out, label, args) {
	const result = cw(out, args);
	if (result.code !== 0) {
		process.stderr.write(result.stdout + result.stderr);
		fail(`Demo build stopped at "${label}" (exit ${result.code}). The lines above say why.`);
	}
	const setId = /Set id: (iset-[a-z0-9]+)\./.exec(result.stdout)?.[1];
	const summary = result.stdout.trim().split('\n').pop();
	process.stdout.write(`  ${label}: ${summary}\n`);
	return setId;
}

function checkSource(source) {
	if (RESTRICTED.test(source)) fail(`Refusing ${source}: the demo uses public-domain or synthetic content only.`);
	if (!fs.existsSync(path.join(REPO, source))) fail(`Missing fixture ${source}. Run the build from a full checkout of the repository.`);
}

function write(out, relative, text) {
	const target = path.join(out, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, text);
}

/** What a reviewer does by hand: record approval in the fields re-import keeps. */
function approve(out, file) {
	const target = path.join(out, 'Evidence/Junctions', file);
	const text = fs.readFileSync(target, 'utf8');
	// Written where a re-import would put them (first in the frontmatter), so
	// running the evidence import again reports these notes as up to date.
	const marked = text.replace(/^---\n/, '---\nstatus: approved\nreviewer: Demo reviewer\nreview_date: "2026-05-04T00:00:00.000Z"\n');
	if (marked === text) fail(`Could not record approval on ${file}: it has no frontmatter. The evidence link recipe may have changed.`);
	fs.writeFileSync(target, marked);
}

function queries(sets) {
	const out = [
		['Queries/CSF to 800-53 coverage.base', 'nist-csf-coverage-matrix', { mapping_set: sets.csfTo80053, confidence_threshold: 0.7 }],
		['Queries/CSF to ATT&CK coverage.base', 'nist-csf-to-mitre-coverage', { mapping_set: sets.csfToAttack, confidence_threshold: 0.7, tactic_filter: '' }],
		['Queries/Mappings by framework pair.base', 'crosswalk-density-by-framework', {}],
		['Queries/Approved evidence by control.base', 'evidence-junctions-by-control', {}],
		['Queries/ATT&CK hierarchy.base', 'skos-hierarchy-narrower', { framework_set: sets.attack }],
	];
	return out.map(([file, id, params]) => {
		const text = renderRecipeTemplate(id, params);
		if (text === null) fail(`The shipped query template "${id}" is missing. The query templates may have been renamed.`);
		return [file, `${text}\n`];
	});
}

function startHere(frameworks, mappings) {
	const lines = [
		'# Start here',
		'',
		'This vault was built by Crosswalker from public sample data. It shows several security frameworks side by side, the links between them, and evidence attached to controls.',
		'',
		'## What is in it',
		'',
		...frameworks.map((f) => `- **${f.label}** in \`${f.destination}\`. One note per control, with folders for each level.`),
		...mappings.map((m) => `- **${m.label} links** in \`${m.destination}\`. One note per link between two controls.`),
		'- **Evidence** in `Evidence`. Five sample documents and the links that say which control each one supports.',
		'- **Saved queries** in `Queries`. Open one to see a table built from the notes above.',
		'',
		'## Try this',
		'',
		'1. Open `Frameworks/NIST-SP-800-53-r5/AC/AC-2.md`. Its properties and links come straight from the source spreadsheet.',
		'2. Open `Queries/Approved evidence by control.base`. Three evidence links are approved; two are still waiting for review.',
		'3. Open an evidence link in `Evidence/Junctions` and set `status` to `approved`. The query picks it up. Importing the evidence spreadsheet again keeps your review fields.',
		'',
		'## What is only partly here',
		'',
		'The frameworks are small samples so the vault stays quick to open. The link files are complete, so many links point at controls that are not in this vault. Those links are kept and show up as unresolved until the full framework is imported.',
		'',
		'## How it was built',
		'',
		'Every framework, link and evidence note was written by the Crosswalker command line from files that ship with the project. Building again gives the same files byte for byte.',
		'',
	];
	return lines.join('\n');
}

function manifest(out) {
	const perFolder = new Map();
	let bytes = 0;
	let notes = 0;
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith('.')) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) { walk(full); continue; }
			bytes += fs.statSync(full).size;
			if (!entry.name.endsWith('.md')) continue;
			notes++;
			const folder = path.relative(out, dir).split(path.sep).join('/') || '(vault root)';
			perFolder.set(folder, (perFolder.get(folder) ?? 0) + 1);
		}
	};
	walk(out);
	return { perFolder, bytes, notes };
}

function main() {
	const { out } = parseArgs(process.argv.slice(2));
	prepareOut(out);
	process.stdout.write(`Building the demo vault in ${out}\n`);

	const frameworks = [...FRAMEWORKS];
	const sets = {};
	for (const f of FRAMEWORKS) {
		checkSource(f.source);
		sets[f.key] = step(out, f.label, ['import', '--source', f.source, '--ontology', f.ontology, '--destination', f.destination, '--deterministic']);
	}
	for (const m of MAPPINGS) {
		checkSource(m.source);
		sets[m.key] = step(out, `${m.label} links`, ['import', '--source', m.source, '--destination', m.destination, '--deterministic']);
	}

	for (const [name, body] of Object.entries(EVIDENCE_DOCUMENTS)) {
		write(out, `Evidence/Documents/${name}.md`, `---\ntitle: ${name}\nkind: evidence-document\n---\n\n${body}\n`);
	}
	checkSource(EVIDENCE_LINKS);
	// The evidence recipe's file template already names Evidence/Junctions, so the
	// destination is the vault root.
	sets.evidence = step(out, 'Evidence links', ['import', '--source', EVIDENCE_LINKS, '--recipe', 'evidence-junction-notes', '--destination', '.', '--deterministic']);
	for (const file of APPROVED_LINKS) approve(out, file);

	if (fs.existsSync(path.join(REPO, F3.source))) {
		checkSource(F3.source);
		sets[F3.key] = step(out, F3.label, ['import', '--source', F3.source, '--recipe', F3.recipe, '--destination', F3.destination, '--deterministic']);
		frameworks.push(F3);
	} else {
		process.stdout.write(`  ${F3.label}: skipped, this checkout does not ship ${F3.source}\n`);
	}

	for (const [file, text] of queries(sets)) write(out, file, text);
	write(out, START_HERE, startHere(frameworks, MAPPINGS));

	for (const folder of manifest(out).perFolder.keys()) {
		if (RESTRICTED.test(folder)) fail(`The demo vault has a folder named "${folder}", which looks like licensed content. Remove its source from the build.`);
	}

	const check = cw(out, ['validate']);
	process.stdout.write(check.stdout);
	if (check.code !== 0) {
		process.stderr.write(check.stderr);
		fail('The demo vault did not validate. The lines above name each failing note.', 2);
	}

	const { perFolder, bytes, notes } = manifest(out);
	process.stdout.write('\nManifest (notes per folder):\n');
	for (const [folder, count] of perFolder) process.stdout.write(`  ${String(count).padStart(5)}  ${folder}\n`);
	process.stdout.write(`  ${String(notes).padStart(5)}  notes in total, ${bytes} bytes on disk\n`);
	process.stdout.write(`Set ids: ${Object.entries(sets).map(([k, v]) => `${k}=${v ?? 'none'}`).join(', ')}\n`);
}

main();
