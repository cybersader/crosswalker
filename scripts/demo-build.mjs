#!/usr/bin/env bun
/**
 * demo-build.mjs: build the multi-framework demo vault.
 *
 *   bun run demo:build -- --out <dir> [--sources-dir <checkout>]
 *
 * --sources-dir defaults to the repository root. Held Frameworks/ files are
 * read there, never modified; generated mapping TSVs live in a temporary folder.
 *
 * Every Crosswalker note is written by the command line (`bun run cw`), never
 * by calling the engine from here, so the demo is exactly what a user running
 * the same commands would get. Every step runs with --deterministic and reads
 * pinned public sources and committed fixtures, so builds with the same source
 * bytes write byte-identical trees and work offline.
 *
 * The script itself writes only the non-Crosswalker files a person would add
 * by hand: the evidence documents, the reviewer's approval on some evidence
 * links, the saved queries (rendered from the shipped query templates), the
 * "Start here" note and the graph view settings (.obsidian/graph.json, the only
 * file written under .obsidian; see tools/lib/demo-graph.ts).
 *
 * Content rule: public-domain, openly licensed or synthetic only. Nothing from
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
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import { readCtidJson, readOlirWorkbook, mappingRowsToTsv } from '../src/import/stack/mapping-readers.ts';
import { parseSssomTsv } from '../src/import/sssom-parser.ts';
import { publicCsv, d3fendNames, d3fendControlMappings, d3fendAttackMappings, mappingPairDiff, mappingResolution } from '../tools/lib/demo-public-sources.ts';
import { renderRecipeTemplate } from '../src/views/recipe-templates.ts';
import { demoGraphGroups, demoGraphJson } from '../tools/lib/demo-graph.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const START_HERE = 'Start here.md';
const DEMO_RECIPES = 'tools/fixtures/demo/recipes';

/** Names that must never appear in a demo source path or a demo folder name. */
export const RESTRICTED = /(_licensed|\bcri\b|cri-profile|iso[-_ ]?27|\biso\b|soc[-_ ]?2|\bpci\b|\bcis\b|cis-controls|\bscf\b)/i;

const FRAMEWORKS = [
	// The full public NIST catalogs, so every CSF to 800-53 link lands on two real notes.
	// Demo-only recipes (tools/fixtures/demo/recipes) make every level a note
	// and tag every row note by level. Identities match the shipped recipes, so
	// mapping links resolve exactly as they do against the flat imports.
	{ key: 'csf', label: 'NIST CSF 2.0', source: 'Frameworks/csf2.xlsx', how: ['--recipe', `${DEMO_RECIPES}/nist-csf-2-demo-hierarchical.json`, '--sheet', 'CSF 2.0', '--header-row', '2'], destination: 'Frameworks/NIST-CSF-2.0', levels: 'one folder per function and category' },
	{ key: 'sp80053', label: 'NIST SP 800-53 Rev. 5', source: 'Frameworks/NIST_SP-800-53_rev5_catalog_load.csv', how: ['--recipe', `${DEMO_RECIPES}/nist-800-53-demo-nested.json`], destination: 'Frameworks/NIST-SP-800-53-r5', levels: 'one folder per family and control, with enhancements inside their control' },
	{ key: 'attack', label: 'MITRE ATT&CK Enterprise v16.1', source: 'Frameworks/enterprise-attack-v16.1.xlsx', how: ['--recipe', `${DEMO_RECIPES}/mitre-attack-demo-full.json`, '--sheet', 'techniques'], destination: 'Frameworks/MITRE-ATT&CK', levels: 'the full techniques sheet, one note per technique and sub-technique with parent links' },
];

const MAPPINGS = [
	{ key: 'csfTo80053', label: 'NIST CSF 2.0 to SP 800-53', source: 'recipes/import/crosswalks/nist-csf-2-to-nist-800-53.sssom.tsv', destination: '_crosswalker/mappings/csf-to-800-53' },
	{ key: 'csfToAttack', label: 'NIST CSF 2.0 to MITRE ATT&CK', source: 'tools/fixtures/demo/nist-csf-2-to-mitre-attack.sssom.tsv', destination: '_crosswalker/mappings/csf-to-mitre' },
];

const EVIDENCE_LINKS = 'tools/fixtures/demo/evidence-links.csv';

/** Both F3 sheets follow the established demo sets, so the set ids above never shift. */
const F3 = { key: 'f3', label: 'MITRE Fight Fraud Framework (F3)', source: 'Frameworks/f3-excel-v1.2.xlsx', recipe: `${DEMO_RECIPES}/mitre-f3-demo-linked.json`, destination: 'Frameworks/MITRE-F3', levels: 'the full v1.2 catalog, with one note per tactic and technique, links to tactics, and parent links on sub-techniques' };

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

/** Resolve symlink ancestors even when the final output folder does not exist. */
function canonicalPath(value) {
	const resolved = path.resolve(value);
	if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
	const parent = path.dirname(resolved);
	return path.join(canonicalPath(parent), path.basename(resolved));
}

function parseArgs(argv) {
	const args = argv[0] === '--' ? argv.slice(1) : argv;
	let out;
	let sourcesDir = REPO;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--out') out = args[++i];
		else if (args[i].startsWith('--out=')) out = args[i].slice('--out='.length);
		else if (args[i] === '--sources-dir') sourcesDir = args[++i];
		else if (args[i].startsWith('--sources-dir=')) sourcesDir = args[i].slice('--sources-dir='.length);
		else fail(`Unknown option "${args[i]}". Usage: bun run demo:build -- --out <folder>`);
	}
	if (!out) fail('Missing --out. Pass the folder to build the demo vault in, for example: bun run demo:build -- --out /tmp/crosswalker-demo');
	if (!sourcesDir) fail('Missing --sources-dir value. Pass the checkout containing Frameworks/.');
	const resolvedOut = canonicalPath(out);
	const resolvedSources = canonicalPath(sourcesDir);
	for (const root of [canonicalPath(REPO), resolvedSources]) {
		const relative = path.relative(root, resolvedOut);
		if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
			fail('The demo output must be outside the repository and the sources checkout. Choose a separate empty folder.');
		}
	}
	return { out: resolvedOut, sourcesDir: resolvedSources };
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

function checkSource(source, sourcesDir = REPO) {
	if (RESTRICTED.test(source)) fail(`Refusing ${source}: the demo uses public-domain, openly licensed or synthetic content only.`);
	const file = path.resolve(source.startsWith('Frameworks/') ? sourcesDir : REPO, source);
	if (!fs.existsSync(file)) fail(`Missing fixture ${source}. Use --sources-dir to select the checkout holding the public Frameworks/ files.`);
	return file;
}

function write(out, relative, text) {
	const target = path.join(out, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, text);
}

/** Wraps an upstream licence file, unchanged, in a Markdown note. */
function licenseMarkdown(name, shortName, license, text) {
	return [
		`# ${name} license`,
		'',
		`The ${shortName} data in this folder is published by MITRE under the ${license}. The text below is the upstream LICENSE file, unchanged.`,
		'',
		'```text',
		text.replace(/\n$/, ''),
		'```',
		'',
	].join('\n');
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
		['Queries/800-53 to ATT&CK mappings.base', 'nist-csf-coverage-matrix', { mapping_set: sets.sp80053ToAttack, confidence_threshold: 0 }],
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
		'This vault was built by Crosswalker from public data. It holds the full NIST CSF 2.0 and NIST SP 800-53 Rev. 5 catalogs, the full MITRE Fight Fraud Framework (F3), MITRE ATT&CK Enterprise v16.1 techniques and mitigations, MITRE D3FEND, the links between them, and evidence attached to controls.',
		'',
		'## What is in it',
		'',
		...frameworks.map((f) => `- **${f.label}** in \`${f.destination}\`: ${f.levels}. ${f.noteCount} notes; ${f.parentResolved} resolved parent links.`),
		...mappings.map((m) => `- **${m.label} links** in \`${m.destination}\`. ${m.noteCount} link notes; ${m.subjectResolved} resolved subject links and ${m.objectResolved} resolved object links.`),
		'- **Evidence** in `Evidence`. Five sample documents and the links that say which control each one supports.',
		'- **Saved queries** in `Queries`. Open one to see a table built from the notes above.',
		'',
		'## Try this',
		'',
		'1. Open the graph view. Each framework is a tree in its own color, and the link notes between them are the bridges. The colors are listed below.',
		'2. Open `Frameworks/NIST-CSF-2.0/PR/PR.AA/PR.AA-01.md` and look at its backlinks. Each one is a link note to a SP 800-53 control or a MITRE technique, and both ends open a real note. Its `parent` property opens the PR.AA category.',
		'3. Open `Frameworks/NIST-SP-800-53-r5/AC/AC-2/AC-2.md`. Its properties come straight from the NIST catalog spreadsheet, and its enhancements sit next to it in the same folder.',
		'4. Open `Queries/Approved evidence by control.base`. Three evidence links are approved; two are still waiting for review.',
		'5. Open `Frameworks/MITRE-F3/F1002.001.md`. Its `parent` opens `F1002`, and its `tactic_notes` open the real tactics from the same workbook.',
		'6. Open an evidence link in `Evidence/Junctions` and set `status` to `approved`. The query picks it up. Importing the evidence spreadsheet again keeps your review fields.',
		'',
		'## Graph colors',
		'',
		...demoGraphGroups(frameworks.map((f) => f.key)).map((g) => `- **${g.name}**: ${g.label}`),
		'',
		'Tags stay in the notes, but tag nodes and native file-link arrows start hidden for a quieter overview. Arrows do not describe mapping meaning. Turn tag nodes back on in the graph controls if you want to browse categories. Focused connections and readable mapping filenames are not included yet.',
		'',
		'## What is only partly here',
		'',
		'Only the CSF to ATT&CK links and evidence are synthetic examples, not coverage claims. ATT&CK is the full Enterprise v16.1 technique catalog; the CTID mappings target that release. The separate technique and mitigation sets share the publisher namespace without overlapping identifiers, so all mitigation links resolve. The D3FEND mitigation table retains exact M ids, never substitutes technique ids, and blank source cells assert no mapping. D3FEND semantic-table relation direction is unverified, so those links use an unspecified related mapping. Raw publisher relation words are passed to import as comments but are not yet projected into link notes. The wide d3fend-full-mappings.csv is not imported and awaits a reshaping decision. The held SP 800-53 catalog lacks IA-13, a control added in release 5.1.1, so 17 CTID subject links and two CSF object links stay unresolved. One CTID object is T1521.003, a Mobile ATT&CK identifier absent from this Enterprise catalog. These mapping rows are kept without inventing missing concepts.',
		'',
		'## How it was built',
		'',
		'Every framework, link and evidence note was written by the Crosswalker command line from public source files held with the project. Use --sources-dir to read Frameworks/ from another checkout. The same source bytes produce the same output files byte for byte.',
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


/** Derived sources are staged outside the checkout; notes still come only from cw import. */
function publicMappings(sourcesDir, temporary) {
	const read = (file) => fs.readFileSync(checkSource(`Frameworks/${file}`, sourcesDir));
	const ctidText = read('nist_800_53-rev5_attack-16.1-enterprise_json.json').toString('utf8');
	const ctidObjects = JSON.parse(ctidText).mapping_objects;
	const ctid = readCtidJson(ctidText);
	if (ctid.attackVersion !== '16.1') fail('The CTID mapping bundle must target ATT&CK 16.1. Select the pinned source release.');
	const olir = readOlirWorkbook(read('Cybersecurity_Framework_v2-0_Concept_Crosswalk_800-53_final.xlsx'),
		{ subjectOntology: 'nist-csf-2', objectOntology: 'nist-800-53', depad: 'object' }, ['Relationships'], 0);
	const existing = parseSssomTsv(fs.readFileSync(path.join(REPO, MAPPINGS[0].source), 'utf8')).rows;
	const diff = mappingPairDiff(existing, olir);
	process.stdout.write(`CSF concept crosswalk pair diff: ${JSON.stringify(diff)}\n`);
	const catalog = publicCsv(read('d3fend.csv').toString('utf8'));
	const controlCsv = publicCsv(read('d3fend_to_nist80053.csv').toString('utf8'));
	const attackCsv = publicCsv(read('att&ck_to_d3fend.csv').toString('utf8'));
	const controls = d3fendControlMappings(controlCsv, d3fendNames(catalog));
	const mitigations = d3fendAttackMappings(attackCsv);
	const entries = [
		{ key: 'sp80053ToAttack', label: 'CTID NIST SP 800-53 Rev. 5 to ATT&CK 16.1', rows: ctid.rows,
			rowsRead: ctidObjects.length, duplicatesSkipped: ctid.duplicateRowsSkipped,
			filteredRows: ctidObjects.length - ctid.duplicateRowsSkipped - ctid.rows.length,
			nonMappableRows: ctidObjects.filter((row) => row.capability_id == null && row.mapping_type === 'non_mappable').length,
			provider: 'CTID Mappings Explorer', from: 'nist-800-53', to: 'mitre-attack', release: '16.1', destination: '_crosswalker/mappings/800-53-to-attack' },
		{ key: 'sp80053ToD3fend', label: 'NIST SP 800-53 to D3FEND (publisher semantic table)', rows: controls,
			rowsRead: controlCsv.length, provider: 'MITRE D3FEND', from: 'nist-800-53', to: 'mitre-d3fend', release: 'held-semantic-table', destination: '_crosswalker/mappings/800-53-to-d3fend' },
		{ key: 'attackToD3fend', label: 'ATT&CK mitigations to D3FEND', rows: mitigations.rows,
			rowsRead: attackCsv.length, emptyRows: mitigations.emptyRows, provider: 'MITRE D3FEND', from: 'mitre-attack', to: 'mitre-d3fend', release: 'held-mitigation-table', destination: '_crosswalker/mappings/attack-mitigations-to-d3fend' },
	];
	if (diff.added || diff.strengthRows) entries.push({ key: 'csfConceptTo80053', label: 'NIST CSF 2.0 concept crosswalk to SP 800-53', rows: olir,
		rowsRead: olir.length, provider: 'NIST concept crosswalk', from: 'nist-csf-2', to: 'nist-800-53', release: 'csf-2-concept-crosswalk', destination: '_crosswalker/mappings/csf-concept-to-800-53' });
	else process.stdout.write('CSF concept crosswalk skipped: no additional endpoint pairs or strength values.\n');
	for (const entry of entries) {
		let tsv = mappingRowsToTsv(entry.rows, entry.provider, entry.from, entry.to, entry.release);
		// Keep the undecided publisher relation in SSSOM comment, ready for the
		// general field-projection follow-up. The encoder has fixed columns.
		if (entry.key === 'sp80053ToD3fend') {
			let index = 0;
			tsv = tsv.trimEnd().split('\n').map((line) => line.startsWith('#') ? line :
				line.startsWith('subject_id\t') ? `${line}\tsource_relation\tcomment` : (() => {
					const relation = String(entry.rows[index++].source_relation).replace(/[\t\r\n]/g, ' ');
					return `${line}\t${relation}\trelation=${relation}`;
				})()).join('\n') + '\n';
		}
		entry.source = path.join(temporary, `${entry.key}.sssom.tsv`);
		fs.writeFileSync(entry.source, tsv);
	}
	return { entries, diff, catalog };
}

function readNotes(out, relative = '') {
	const notes = [];
	for (const entry of fs.readdirSync(path.join(out, relative), { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		const file = path.posix.join(relative, entry.name);
		if (entry.isDirectory()) notes.push(...readNotes(out, file));
		else if (entry.name.endsWith('.md')) {
			const text = fs.readFileSync(path.join(out, file), 'utf8');
			const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
			if (match) notes.push({ file, frontmatter: yaml.load(match[1]) });
		}
	}
	return notes;
}

function reportSources(out, frameworks, mappings, prepared) {
	const notes = readNotes(out);
	const concepts = notes.filter((note) => typeof note.frontmatter.curie === 'string' && !['crosswalk-edge', 'mapping-set', 'junction-note'].includes(note.frontmatter.kind));
	const identities = new Set(concepts.flatMap(({ frontmatter: fm }) => {
		const curie = fm.curie;
		const ontology = fm._crosswalker?.import_set?.ontology;
		return typeof curie === 'string' ? [curie, ...(ontology ? [`${ontology}:${curie.slice(curie.indexOf(':') + 1)}`] : [])] : [];
	}));
	for (const framework of frameworks) {
		const own = concepts.filter((note) => note.file.startsWith(`${framework.destination}/`));
		framework.noteCount = own.length;
		const links = own.filter((note) => note.frontmatter.parent);
		const parentResolved = links.filter((note) => {
			const fm = note.frontmatter;
			if (fm.parent_curie && identities.has(fm.parent_curie)) return true;
			const target = typeof fm.parent === 'string' && /^\[\[([^|\]]+)/.exec(fm.parent)?.[1];
			if (!target) return false;
			return fs.existsSync(path.join(out, `${target}.md`)) ||
				fs.existsSync(path.join(out, path.dirname(note.file), `${target}.md`));
		}).length;
		framework.parentResolved = parentResolved;
		process.stdout.write(`Source report ${framework.key}: ${JSON.stringify({ notesCreated: own.length, parents: links.length, parentResolved,
			...(framework.key === 'attack' ? { techniques: own.filter((note) => !String(note.frontmatter.technique_id).includes('.')).length,
				subTechniques: own.filter((note) => String(note.frontmatter.technique_id).includes('.')).length } : {}),
			...(framework.key === 'd3fend' ? { depths: ['D3FEND Technique', 'D3FEND Technique Level 0', 'D3FEND Technique Level 1'].map((key) => prepared.catalog.filter((row) => row[key]?.trim()).length) } : {}) })}\n`);
	}
	for (const mapping of mappings) {
		const rows = mapping.rows ?? parseSssomTsv(fs.readFileSync(path.join(REPO, mapping.source), 'utf8')).rows;
		const own = notes.filter((note) => note.file.startsWith(`${mapping.destination}/`) && note.frontmatter.kind === 'crosswalk-edge');
		const resolves = (value) => typeof value === 'string' && /^\[\[([^|\]]+)/.exec(value)?.[1];
		const resolved = (key) => own.filter((note) => {
			const target = resolves(note.frontmatter[key]);
			return target && fs.existsSync(path.join(out, `${target}.md`));
		}).length;
		mapping.noteCount = own.length;
		mapping.subjectResolved = resolved('subject_note');
		mapping.objectResolved = resolved('object_note');
		process.stdout.write(`Source report ${mapping.key}: ${JSON.stringify({ rowsRead: mapping.rowsRead ?? rows.length, duplicatesSkipped: mapping.duplicatesSkipped ?? 0,
			emptyRows: mapping.emptyRows ?? 0, filteredRows: mapping.filteredRows ?? 0, nonMappableRows: mapping.nonMappableRows ?? 0,
			importerRowsCollapsed: rows.length - own.length, notesCreated: own.length, subjectLinksResolved: mapping.subjectResolved, objectLinksResolved: mapping.objectResolved,
			...mappingResolution(rows, identities) })}\n`);
	}
}

function publicLicenses(out, sourcesDir, mappings) {
	const entries = [
		['Frameworks/MITRE-ATT&CK', 'MITRE', 'https://attack.mitre.org/resources/legal-and-branding/terms-of-use/', 'mitre-attack-LICENSE.txt'],
		['Frameworks/MITRE-ATT&CK-Mitigations', 'MITRE', 'https://attack.mitre.org/resources/legal-and-branding/terms-of-use/', 'mitre-attack-LICENSE.txt'],
		['Frameworks/MITRE-D3FEND', 'MITRE', 'https://d3fend.mitre.org/about/terms-of-use/', 'mitre-d3fend-LICENSE.txt'],
		...mappings.filter((mapping) => mapping.key === 'sp80053ToAttack').map((mapping) => [mapping.destination, 'MITRE Center for Threat-Informed Defense', 'https://github.com/center-for-threat-informed-defense/mappings-explorer/blob/main/LICENSE', 'ctid-mappings-LICENSE.txt']),
	];
	for (const [folder, publisher, url, filename] of entries) {
		const local = path.join(sourcesDir, 'Frameworks/LICENSES', filename);
		if (fs.existsSync(local)) {
			const text = fs.readFileSync(local, 'utf8');
			write(out, `${folder}/LICENSE.txt`, text);
			write(out, `${folder}/LICENSE.md`, `# ${publisher}\n\n[Official terms](${url})\n\n\`\`\`text\n${text.replace(/\n$/, '')}\n\`\`\`\n`);
		} else {
			write(out, `${folder}/LICENSE.md`, `${publisher}\n\n[Official terms](${url})\n`);
			process.stdout.write(`License link only: ${folder}/LICENSE.md\n`);
		}
	}
}

function main() {
	const { out, sourcesDir } = parseArgs(process.argv.slice(2));
	for (const source of [...FRAMEWORKS.map((f) => f.source), ...MAPPINGS.map((m) => m.source), EVIDENCE_LINKS, F3.source,
		'Frameworks/LICENSES/mitre-f3-LICENSE.txt', 'Frameworks/d3fend.csv', 'Frameworks/d3fend_to_nist80053.csv',
		'Frameworks/att&ck_to_d3fend.csv', 'Frameworks/nist_800_53-rev5_attack-16.1-enterprise_json.json',
		'Frameworks/Cybersecurity_Framework_v2-0_Concept_Crosswalk_800-53_final.xlsx']) checkSource(source, sourcesDir);
	prepareOut(out);
	process.stdout.write(`Building the demo vault in ${out}\n`);

	const frameworks = [...FRAMEWORKS];
	const sets = {};
	for (const f of FRAMEWORKS) {
		const source = checkSource(f.source, sourcesDir);
		sets[f.key] = step(out, f.label, ['import', '--source', source, ...f.how, '--destination', f.destination, '--deterministic']);
	}
	for (const m of MAPPINGS) {
		checkSource(m.source);
		sets[m.key] = step(out, `${m.label} links`, ['import', '--source', m.source, '--destination', m.destination, '--deterministic']);
	}

	for (const [name, body] of Object.entries(EVIDENCE_DOCUMENTS)) {
		write(out, `Evidence/Documents/${name}.md`, `---\ntitle: ${name}\nkind: evidence-document\n---\n\n${body}\n`);
	}
	checkSource(EVIDENCE_LINKS);
	// No destination: the evidence recipe's own default is Evidence/Junctions.
	sets.evidence = step(out, 'Evidence links', ['import', '--source', EVIDENCE_LINKS, '--recipe', 'evidence-junction-notes', '--deterministic']);
	for (const file of APPROVED_LINKS) approve(out, file);

	const f3Source = checkSource(F3.source, sourcesDir);
	sets[F3.key] = step(out, F3.label, ['import', '--source', f3Source, '--recipe', F3.recipe, '--sheet', 'Techniques', '--destination', F3.destination, '--deterministic']);
	sets.f3Tactics = step(out, 'F3 tactics', ['import', '--source', f3Source, '--recipe', `${DEMO_RECIPES}/mitre-f3-demo-tactics.json`, '--sheet', 'Tactics', '--destination', F3.destination, '--deterministic']);
	frameworks.push(F3);

	// The Apache licence travels with the openly licensed F3 source and output.
	// LICENSE.md carries the same text for hosts that accept only Markdown
	// (OpenClast rooms refuse .txt); LICENSE.txt stays for desktop and git users.
	const f3License = fs.readFileSync(checkSource('Frameworks/LICENSES/mitre-f3-LICENSE.txt', sourcesDir), 'utf8');
	write(out, 'Frameworks/MITRE-F3/LICENSE.txt', f3License);
	write(out, 'Frameworks/MITRE-F3/LICENSE.md', licenseMarkdown('MITRE Fight Fraud Framework (F3)', 'F3', 'Apache License 2.0', f3License));

	// New sets come after the established imports: their deterministic ids stay stable.
	for (const f of [
		{ key: 'attack-mitigations', label: 'MITRE ATT&CK Enterprise v16.1 mitigations', source: 'Frameworks/enterprise-attack-v16.1.xlsx', how: ['--recipe', 'recipes/import/mitre-attack-mitigation.json', '--sheet', 'mitigations'], destination: 'Frameworks/MITRE-ATT&CK-Mitigations', levels: 'one note per mitigation, separate from the technique set' },
		{ key: 'd3fend', label: 'MITRE D3FEND', source: 'Frameworks/d3fend.csv', how: ['--recipe', 'recipes/import/mitre-d3fend.json'], destination: 'Frameworks/MITRE-D3FEND', levels: 'one note per defensive technique, tagged by tactic, with the sparse source depth fields preserved' },
	]) {
		sets[f.key] = step(out, f.label, ['import', '--source', checkSource(f.source, sourcesDir), ...f.how, '--destination', f.destination, '--deterministic']);
		frameworks.push(f);
	}
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-public-mappings-'));
	const cleanup = () => fs.rmSync(temporary, { recursive: true, force: true });
	process.once('exit', cleanup);
	const prepared = publicMappings(sourcesDir, temporary);
	const mappings = [...MAPPINGS, ...prepared.entries];
	try {
		for (const mapping of prepared.entries) sets[mapping.key] = step(out, mapping.label,
			['import', '--source', mapping.source, '--destination', mapping.destination, '--deterministic']);
		reportSources(out, frameworks, mappings, prepared);
	} finally { cleanup(); }
	publicLicenses(out, sourcesDir, mappings);
	process.stdout.write('Fidelity gap: the current notes-form SSSOM recipe does not project source_relation or comment. Publisher words are passed to the importer, not asserted as hierarchy.\n');

	for (const [file, text] of queries(sets)) write(out, file, text);
	write(out, START_HERE, startHere(frameworks, mappings));
	write(out, '.obsidian/graph.json', demoGraphJson(frameworks.map((f) => f.key)));

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
