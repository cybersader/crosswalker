#!/usr/bin/env bun
/** Private-room-only enrichment. Code and bindings only; no licensed rows. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import * as yaml from 'js-yaml';
import { FRAMEWORK_GROUPS, demoGraphGroups, demoGraphJson } from '../tools/lib/demo-graph.ts';
import { readCtidJson, readOlirWorkbook, mappingRowsToTsv } from '../src/import/stack/mapping-readers.ts';
import { workbookTable, tabularMappings, subjectTags, resolveMappings, compareMappings } from '../src/import/stack/licensed-workbook-readers.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const START_HERE = 'Start here.md';
const GRAPH = '.obsidian/graph.json';
const CRI_DOWNLOAD = 'https://cyberriskinstitute.org/the-profile/';
const CIS_DOWNLOAD = 'https://www.cisecurity.org/controls';
const CATALOG = 'wp-contentuploads202604CRI-Profile-ver.-2.2-Mappings-Catalog.2026-04-27.xlsx';
// Catalog rows describe the relation from the counterpart to CRI. Other sheets
// are reported absent, not guessed to be aliases of frameworks in this vault.
const CATALOG_PAIRS = [
	{ sheet: 'CIS v8.1', column: 'CIS Id', ontology: 'cis-v8' },
	{ sheet: 'MITRE ATT&CK', column: 'ATT&CK Id', ontology: 'mitre-attack' },
	{ sheet: 'NIST 800-53r5', column: 'Control Id', ontology: 'nist-800-53' },
	{ sheet: 'NIST CSF v2', column: 'CSF / Profile Id', ontology: 'nist-csf-2' },
];
const LICENSED = [
	{
		key: 'cri', label: 'CRI Profile 2.2', sources: ['Frameworks/CRI-Profile-ver.-2.2.2026-04-27.xlsx', 'Frameworks/wp-contentuploads202604CRI-Profile-ver.-2.2.2026-04-27.xlsx'], get: CRI_DOWNLOAD,
		import: { recipe: 'recipes/import/cri-profile-v2-2-nested.json', sheet: 'CRI Profile v2.2 Structure', headerRow: 3 }, destination: 'Frameworks/CRI-Profile-2.2',
		mappings: [
			{ key: 'cri-catalog', label: 'CRI 2.2 mappings catalog', sources: [`Frameworks/${CATALOG}`], get: CRI_DOWNLOAD, kind: 'catalog', release: '2.2' },
			{ key: 'cri-21-80053', label: 'CRI 2.1 to SP 800-53', sources: ['Frameworks/wp-contentuploads202509CRI-Profile-v2.1-to-SP-800-53-Rev-5.1.1.Final_.2025.xlsx'], get: CRI_DOWNLOAD, kind: 'olir', release: '2.1-5.1.1', ontology: 'nist-800-53' },
			{ key: 'cri-21-attack', label: 'CRI 2.1 to ATT&CK 16.1 workbook', sources: ['Frameworks/wp-contentuploads202509MITRE-ATTACK-v16.1-to-CRI-Profile-v2.1-Mapping.2025.xlsx', 'Frameworks/cri_profile-v2.1_attack-16.1-enterprise.xlsx'], get: CRI_DOWNLOAD, kind: 'ctid-workbook', release: '2.1-16.1', ontology: 'mitre-attack' },
			{ key: 'cri-21-attack-json', label: 'CRI 2.1 to ATT&CK 16.1 JSON', sources: ['Frameworks/cri_profile-v2.1_attack-16.1-enterprise_json.json'], get: 'https://center-for-threat-informed-defense.github.io/mappings-explorer/', kind: 'ctid-json', release: '2.1-16.1', ontology: 'mitre-attack' },
		],
	},
	{
		key: 'cis', label: 'CIS Controls 8.1', sources: ['Frameworks/_licensed/CIS_Controls_Version_8.1_6_24_2024.xlsx', '_licensed/CIS_Controls_Version_8.1_6_24_2024.xlsx'], get: CIS_DOWNLOAD,
		import: { recipe: 'recipes/import/cis-controls-v8-controls.json', sheet: 'Controls V8', headerRow: 1 }, destination: 'Frameworks/CIS-Controls-8.1',
		// Both tiers are needed: the publisher mappings reference safeguards too.
		companions: [{ recipe: 'recipes/import/cis-controls-v8-1-safeguards.json', sheet: 'Controls V8', headerRow: 1 }],
		mappings: [{ key: 'cis-csf', label: 'CIS v8 to NIST CSF 2.0', sources: ['Frameworks/_licensed/CIS_Controls_v8_Mapping_to_NIST_CSF_2_2023.xlsx', '_licensed/CIS_Controls_v8_Mapping_to_NIST_CSF_2_2023.xlsx'], get: CIS_DOWNLOAD, kind: 'cis', release: 'v8-csf2-2023', ontology: 'nist-csf-2' }],
	},
];
const USAGE = 'Usage: bun run demo:add-licensed -- --private-room-only --vault <dir> [--only cri,cis] [--sources-dir <dir>] [--source <workbook> (single --only required)]';

function parseArgs(argv) {
	const args = argv[0] === '--' ? argv.slice(1) : argv;
	const opts = { privateRoomOnly: false, sourcesDir: REPO };
	const values = { '--vault': 'vault', '--source': 'source', '--sources-dir': 'sourcesDir', '--only': 'only' };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--private-room-only') opts.privateRoomOnly = true;
		else if (values[arg]) {
			if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}. ${USAGE}`);
			opts[values[arg]] = args[++i];
		} else throw new Error(`Unknown option ${arg}. ${USAGE}`);
	}
	const selected = opts.only === undefined ? LICENSED.map((entry) => entry.key) : opts.only.split(',');
	if (selected.some((key) => !LICENSED.some((entry) => entry.key === key))) throw new Error(`Unknown framework key. Choose cri or cis. ${USAGE}`);
	if (opts.source && (opts.only === undefined || selected.length !== 1)) throw new Error(`--source requires a single --only key. ${USAGE}`);
	return { ...opts, selected };
}

function inside(parent, child) {
	const rel = path.relative(parent, child);
	return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Resolve symlinks even when the last path component does not exist yet. */
function canonical(file) {
	if (fs.existsSync(file)) return fs.realpathSync(file);
	const parent = path.dirname(file);
	return parent === file ? file : path.join(canonical(parent), path.basename(file));
}

function assertSafeVault(vault) {
	const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO, encoding: 'utf8' });
	if (common.status !== 0) throw new Error('Cannot verify repository boundaries. Run from a full git checkout.');
	const roots = [REPO, path.dirname(common.stdout.trim())].map(canonical);
	if (roots.some((root) => inside(root, vault))) throw new Error('Refusing a vault inside the repository, where licensed notes could be committed. Use an external folder.');
	if (!fs.existsSync(path.join(vault, START_HERE)) || !fs.existsSync(path.join(vault, GRAPH))) throw new Error(`Not a demo vault. Build one first with bun run demo:build -- --out <dir>. ${USAGE}`);
	// A nested symlink could redirect an import or welcome-note write into git.
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) throw new Error('Demo vault contains a symbolic link. Use a fresh demo build without links.');
			if (entry.isDirectory()) walk(path.join(dir, entry.name));
		}
	};
	walk(vault);
}

function locate(entry, sourcesDir, override) {
	const candidates = override ? [override] : entry.sources;
	const found = candidates.map((file) => path.resolve(sourcesDir, file)).find((file) => fs.existsSync(file));
	if (!found) process.stdout.write(`Skip ${entry.label}: missing ${candidates.join(' or ')}. Obtain the licensed file from ${entry.get}.\n`);
	return found;
}

function cw(vault, args) {
	const result = spawnSync('bun', ['--preload', './cli/preload.ts', 'cli/main.ts', ...args, '--vault', vault], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
	if (result.status !== 0) {
		// Do not echo errors containing licensed source cells into a shared log.
		if (result.signal === 'SIGTERM' || result.status === 143) throw new Error('Import interrupted by SIGTERM. No result; do not retry until resource pressure is checked.');
		throw new Error('The licensed import failed. Check the documented worksheet, header row and recipe binding against your local workbook, then use a fresh demo build. Source values are withheld.');
	}
	return result.stdout;
}

function importFramework(vault, source, binding, destination, setId) {
	return cw(vault, ['import', '--source', source, '--recipe', binding.recipe, '--sheet', binding.sheet, '--header-row', String(binding.headerRow), '--destination', destination, ...(setId ? ['--set', setId] : []), '--deterministic']);
}

/** Identity lookup includes notes anywhere; never derive endpoints from paths. */
function noteIndex(vault) {
	const index = new Map();
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith('.')) continue;
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (entry.name.endsWith('.md')) {
				const text = fs.readFileSync(file, 'utf8');
				const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
				if (!match) continue;
				const fm = yaml.load(match[1]);
				if (typeof fm?.curie === 'string' && fm.kind !== 'crosswalk-edge' && fm.kind !== 'mapping-set') index.set(fm.curie, { file, fm, text });
			}
		}
	};
	walk(vault);
	return index;
}

function enrichTags(workbook, index) {
	const rows = workbookTable(workbook, 'Diagnostic Statements by Tag', ['CRI Profile Subject Tags', 'Profile Id']);
	const list = workbookTable(workbook, 'Subject Tag LIst', ['CRI Profile Subject Tag']);
	const joined = subjectTags(rows, list);
	let notes = 0, links = 0, missing = 0;
	for (const [id, tags] of joined.tags) {
		const note = index.get(`cri-profile:${id}`);
		if (!note || note.fm.level !== 'DS') { missing++; continue; }
		const existing = Array.isArray(note.fm.tags) ? note.fm.tags : typeof note.fm.tags === 'string' ? [note.fm.tags] : [];
		note.fm.tags = [...new Set([...existing, ...tags])].sort();
		fs.writeFileSync(note.file, note.text.replace(/^---\r?\n[\s\S]*?\r?\n---/, `---\n${yaml.dump(note.fm, { lineWidth: -1, noRefs: true, sortKeys: false }).trimEnd()}\n---`));
		notes++; links += tags.length;
	}
	process.stdout.write(`CRI subject tags: ${rows.length} rows read; ${notes} notes tagged; ${links} tags attached; ${missing} missing statements; ${joined.unknown} unlisted tags.\n`);
	return { notes, links };
}

function readMappings(mapping, file, present) {
	if (mapping.kind === 'ctid-json') return [{ ...mapping, rows: readCtidJson(fs.readFileSync(file, 'utf8'), 'cri-profile').rows }];
	if (mapping.kind === 'olir') return [{ ...mapping, rows: readOlirWorkbook(fs.readFileSync(file), { subjectOntology: 'cri-profile', objectOntology: 'nist-800-53', reverse: true, depad: 'subject' }) }];
	const workbook = XLSX.readFile(file);
	if (mapping.kind === 'catalog') {
		const metadata = new Set(['ListValues', 'Catalog of Mapped Documents', 'Mapping Relationships']);
		for (const sheet of workbook.SheetNames) if (!metadata.has(sheet) && !CATALOG_PAIRS.some((pair) => pair.sheet === sheet)) process.stdout.write(`Skip catalog pair ${sheet}: counterpart framework absent from the demo.\n`);
		return CATALOG_PAIRS.flatMap((pair) => {
			if (![...present].some((id) => id.startsWith(`${pair.ontology}:`))) { process.stdout.write(`Skip catalog pair ${pair.sheet}: counterpart framework absent from the vault.\n`); return []; }
			const rows = workbookTable(workbook, pair.sheet, [pair.column, 'Profile Id']);
			return [{ ...mapping, key: `${mapping.key}-${pair.ontology}`, label: `${mapping.label}: ${pair.sheet}`, ontology: pair.ontology, rows: tabularMappings(rows, pair.column, pair.ontology), tableRows: rows.length }];
		});
	}
	if (mapping.kind === 'ctid-workbook') {
		const sheet = workbook.SheetNames.includes('Mappings Explorer Download') ? 'Mappings Explorer Download' : 'Sheet1';
		const rows = workbookTable(workbook, sheet, ['capability_id', 'attack_object_id']);
		return [{ ...mapping, rows: readCtidJson(JSON.stringify({ mapping_objects: rows }), 'cri-profile').rows, tableRows: rows.length }];
	}
	const rows = workbookTable(workbook, 'All CIS Controls & Safeguards', ['CIS Control', 'CIS Sub-Control', 'Subcategory']);
	return [{ ...mapping, rows: tabularMappings(rows.map((row) => ({ ...row, endpoint: row['CIS Sub-Control'] || row['CIS Control'] })), 'Subcategory', 'nist-csf-2', 'endpoint', 'cis-v8'), tableRows: rows.length }];
}

function updateStartHere(vault, keys, frameworks, mappings) {
	const file = path.join(vault, START_HERE);
	let text = fs.readFileSync(file, 'utf8');
	text = text.replace('This vault was built by Crosswalker from public data.', 'This private vault combines public demo data with locally held licensed frameworks listed under Licensed additions.');
	text = text.replace('Every framework, link and evidence note was written by the Crosswalker command line from files that ship with the project.', 'Frameworks and mappings were imported through the Crosswalker command line. Licensed sources were supplied locally; subject tags were joined from their workbook after import.');
	text = text.replace(/(## Graph colors\n)[\s\S]*?(?=\nTags show|\n## |$)/, `$1\n${demoGraphGroups(keys).map((group) => `- **${group.name}**: ${group.label}`).join('\n')}\n`);
	text = text.replace(/\n## Licensed additions[\s\S]*?(?=\n## |$)/, '');
	text += ['\n## Licensed additions', '', '**Private room only. Do not publish or share this vault.** The licensed source terms apply to these generated notes and mappings.', '',
		...frameworks.map((entry) => `- **${entry.label}**: ${entry.notes} framework notes in \`${entry.destination}\`${entry.tags ? `; ${entry.tags.notes} diagnostic statements with ${entry.tags.links} subject tags` : ''}.`),
		...mappings.filter((entry) => entry.resolved > 0).map((entry) => `- **${entry.label}**: ${entry.resolved} resolved links in \`${entry.destination}\`.`), '',
		'Mapping rows with missing endpoints were excluded. The public ATT&CK sample is not the full release; matching CRI 2.1 identifiers were used as written, without guessing a migration to 2.2.', '',
	].join('\n');
	fs.writeFileSync(file, text);
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (!opts.privateRoomOnly) throw new Error(`Refusing licensed additions without --private-room-only. These sources have restrictive terms; keep the vault on your machine or in a private room, never public. ${USAGE}`);
	if (!opts.vault) throw new Error(`Missing --vault. ${USAGE}`);
	const vault = canonical(path.resolve(opts.vault));
	assertSafeVault(vault);
	const selected = LICENSED.filter((entry) => opts.selected.includes(entry.key));
	const sourcesDir = path.resolve(opts.sourcesDir);
	const available = selected.map((entry) => ({ ...entry, source: locate(entry, sourcesDir, opts.source) })).filter((entry) => entry.source);
	if (!available.length) return;
	let index = noteIndex(vault);
	for (const entry of available) {
		const prefix = entry.key === 'cri' ? 'cri-profile' : 'cis-v8';
		if ([...index.keys()].some((id) => id.startsWith(`${prefix}:`)) || fs.existsSync(path.join(vault, entry.destination))) throw new Error(`${entry.label} is already present. Use a fresh demo build to add it again.`);
	}
	const frameworks = [];
	for (const entry of available) {
		const imported = importFramework(vault, entry.source, entry.import, entry.destination);
		const setId = /Set id: (iset-[a-z0-9]+)\./.exec(imported)?.[1];
		if (entry.companions?.length && !setId) throw new Error('Cannot identify the framework set just created. Use a fresh demo build.');
		// Both row kinds belong to this one publisher release, not two isolated
		// ontologies. Select only the exact set this invocation just minted.
		for (const companion of entry.companions ?? []) importFramework(vault, entry.source, companion, entry.destination, setId);
		index = noteIndex(vault);
		const prefix = entry.key === 'cri' ? 'cri-profile' : 'cis-v8';
		const notes = [...index.keys()].filter((id) => id.startsWith(`${prefix}:`)).length;
		const tags = entry.key === 'cri' ? enrichTags(XLSX.readFile(entry.source), index) : undefined;
		const rowsRead = Number(/Imported (\d+) rows/.exec(imported)?.[1] ?? notes);
		frameworks.push({ ...entry, notes, tags, rowsRead });
		process.stdout.write(`${entry.label}: ${rowsRead} rows read; ${notes} framework notes added.\n`);
	}
	const present = new Set(index.keys());
	const reports = [];
	let workbookAttack;
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-private-mappings-'));
	try {
		for (const framework of available) for (const mapping of framework.mappings) {
			const file = locate(mapping, sourcesDir);
			if (!file) continue;
			for (const pair of readMappings(mapping, file, present)) {
				const total = pair.rows.length;
				let duplicate = 0;
				if (pair.kind === 'ctid-workbook') workbookAttack = pair.rows;
				if (pair.kind === 'ctid-json' && workbookAttack) {
					const compared = compareMappings(workbookAttack, pair.rows);
					duplicate = total - compared.unique.length;
					process.stdout.write(`ATT&CK workbook / JSON comparison: ${compared.identical ? 'identical assertion sets' : 'different assertion sets'}; ${compared.overlap} shared assertions; ${compared.unique.length} JSON rows not in workbook.\n`);
					pair.rows = compared.unique;
				}
				const resolved = resolveMappings(pair.rows, present);
				const destination = `_crosswalker/mappings/private-${pair.key}`;
				if (resolved.rows.length) {
					const tsv = path.join(temp, `${pair.key}.sssom.tsv`);
					fs.writeFileSync(tsv, mappingRowsToTsv(resolved.rows, framework.key === 'cri' ? 'CRI' : 'CIS', framework.key === 'cri' ? 'cri-profile' : 'cis-v8', pair.ontology, pair.key + '-' + pair.release));
					cw(vault, ['import', '--source', tsv, '--destination', destination, '--set', 'new-set-qualified', '--deterministic']);
				}
				const report = { label: pair.label, rowsRead: pair.tableRows ?? total, assertions: total, blankEndpoints: (pair.tableRows ?? total) - total, resolved: resolved.rows.length, dropped: resolved.dropped, duplicate, destination };
				reports.push(report);
				process.stdout.write(`${pair.label}: ${report.rowsRead} rows read; ${total} assertions; ${report.resolved} resolved; dropped subject=${resolved.dropped.subject}, object=${resolved.dropped.object}, both=${resolved.dropped.both}, blank endpoint=${report.blankEndpoints}, duplicate=${duplicate}.\n`);
			}
		}
	} finally { fs.rmSync(temp, { recursive: true, force: true }); }
	// Built-in CRI to CSF mappings remain owned by the unchanged shipped recipe.
	if (frameworks.some((entry) => entry.key === 'cri')) {
		const folder = '_crosswalker/mappings/cri-profile-to-nist-csf-2';
		let total = 0, resolved = 0;
		for (const name of fs.existsSync(path.join(vault, folder)) ? fs.readdirSync(path.join(vault, folder)) : []) {
			if (!name.endsWith('.md')) continue;
			const text = fs.readFileSync(path.join(vault, folder, name), 'utf8');
			const fm = yaml.load(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '');
			if (fm?.kind !== 'crosswalk-edge') continue;
			total++;
			if (present.has(fm.subject_id) && present.has(fm.object_id)) resolved++;
		}
		reports.unshift({ label: 'CRI 2.2 built-in CSF links', resolved, destination: folder });
		process.stdout.write(`CRI 2.2 built-in CSF links: ${total} rows; ${resolved} resolved.\n`);
	}
	const graph = JSON.parse(fs.readFileSync(path.join(vault, GRAPH), 'utf8'));
	const queries = new Set((graph.colorGroups ?? []).map((group) => group.query));
	const keys = [...FRAMEWORK_GROUPS.filter((group) => queries.has(group.query)).map((group) => group.key), ...frameworks.map((entry) => entry.key)];
	fs.writeFileSync(path.join(vault, GRAPH), demoGraphJson(keys));
	updateStartHere(vault, keys, frameworks, reports);
	const checked = cw(vault, ['validate']);
	process.stdout.write(checked);
	process.stdout.write(`Added ${frameworks.length} licensed frameworks and ${reports.filter((entry) => entry.resolved > 0).length} mapping sets. Keep this vault private.\n`);
}

try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
