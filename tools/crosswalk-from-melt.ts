/**
 * crosswalk-from-melt.ts — unpivot a wide mapping-column sheet into Tier 1
 * crosswalk-edge notes (one per subject × column × cell-listed id).
 *
 * The third headless extractor (after generate-fixtures.ts → concepts and
 * crosswalk-from-olir.ts → OLIR-layout edges). Built for the SCF workbook,
 * whose `SCF 2026.1` sheet carries ~250 per-framework mapping columns — each
 * cell a `\r\n`-separated list of that framework's control ids. Melting those
 * columns is the **STRM proxy**: edges into copyrighted frameworks (ISO, SOC 2,
 * PCI, COBIT) without carrying any of their text.
 *
 * Same construct-reuse contract as the OLIR tool: the real `render()` engine
 * produces each edge Address from `recipes/import/crosswalk-edge.json`, and the
 * same AJV validator gates every note.
 *
 * Predicates: the flat mapping columns carry NO per-pair relationship type
 * (SCF publishes those only in per-framework STRM PDFs — below the input
 * floor), so every edge is `skos:relatedMatch` → `intersects_with`. If a
 * structured STRM source lands later, regenerate with real predicates.
 *
 * Usage:
 *   bun tools/crosswalk-from-melt.ts \
 *     --source <wide.xlsx> --sheet 'SCF 2026.1' \
 *     --subject-col 'SCF #' --subject-prefix scf \
 *     --melt 'CIS CSC 8.1=cis-v8;NIST CSF 2.0=nist-csf-2;ISO 27001 2022=iso-27001' \
 *     --target-root test-vault/_crosswalker/mappings \
 *     [--depad-prefixes nist-800-53] \
 *     [--object-id-sub 'cis-v8=\.0$='] \
 *     [--subject-note-folder Frameworks/_licensed/SCF] \
 *     [--object-note-folders 'cis-v8=Frameworks/_licensed/CIS-v8;nist-csf-2=…'] \
 *     [--provider "Secure Controls Framework"] [--clean] [--deterministic]
 *
 * Each melted column writes to `<target-root>/<subject-prefix>-to-<obj-prefix>/`
 * plus an SSSOM TSV artifact (`_<subject>-to-<object>.sssom.tsv`) inside it.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';
import { render, type Recipe } from '../src/render';
import { validateTier1Frontmatter, validateRecipe } from '../src/validation/validator';
import {
	CURRENT_CROSSWALK_DERIVATION,
	SSSOM_CURIE_PREFIX,
	sssomEdgeCurie,
	type CrosswalkIdentitySetReference,
} from '../src/generation/crosswalk-identity';

const DETERMINISTIC_IMPORT_SET_ID = 'iset-c6d7e8';
const IMPORT_SET_SCHEME = 'endpoint-v1';

function importSetIdForRun(deterministic: boolean): string {
	return deterministic ? DETERMINISTIC_IMPORT_SET_ID : `iset-${randomBytes(3).toString('hex')}`;
}

import {
	SPEC_VERSION,
	DETERMINISTIC_TIMESTAMP,
	skosToStrm,
	slug,
	groupOf,
	depadId,
	noteLink,
	frontmatterToYaml,
	writeSssomTsv,
	type SssomRow,
} from './lib/crosswalk-shared';

interface MeltSpec {
	column: string; // normalized header of the mapping column
	objectPrefix: string; // CURIE prefix for ids found in that column
}

interface Args {
	source: string;
	sheet: string;
	subjectCol: string;
	subjectPrefix: string;
	headerRow: number;
	melt: MeltSpec[];
	targetRoot: string;
	/** Object prefixes whose ids get leading-zero stripping (e.g. nist-800-53). */
	depadPrefixes: Set<string>;
	/** Per-object-prefix regex substitution applied to each id before everything
	 *  else — '<prefix>=<pattern>=<replacement>' triples. Built for SCF's CIS
	 *  notation, where '1.0' means CIS Control 1 (canonical id '1'). */
	objectIdSubs: Map<string, { pattern: RegExp; replacement: string }>;
	subjectNoteFolder?: string;
	/** Per-object-prefix concept-note folder → emit object_note wikilinks. */
	objectNoteFolders: Map<string, string>;
	provider: string;
	clean: boolean;
	deterministic: boolean;
}

/** Parse 'k1=v1;k2=v2' lists. `=` splits on the LAST occurrence so column
 *  names containing '=' would still break — none do in the corpus; ';' is the
 *  pair separator because column names contain commas. */
function parsePairs(spec: string): Array<[string, string]> {
	return spec
		.split(';')
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => {
			const i = p.lastIndexOf('=');
			if (i < 1) {
				console.error(`Bad pair "${p}" — expected <key>=<value>`);
				process.exit(1);
			}
			return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
		});
}

function parseArgs(argv: string[]): Args {
	const a: Partial<Args> & { melt: MeltSpec[]; objectNoteFolders: Map<string, string>; depadPrefixes: Set<string>; objectIdSubs: Map<string, { pattern: RegExp; replacement: string }> } = {
		headerRow: 0,
		melt: [],
		objectNoteFolders: new Map(),
		depadPrefixes: new Set(),
		objectIdSubs: new Map(),
		provider: 'mapping-column melt',
		clean: false,
		deterministic: process.env.CW_DETERMINISTIC === '1',
	};
	for (let i = 0; i < argv.length; i++) {
		const v = argv[i];
		if (v === '--source') a.source = argv[++i];
		else if (v === '--sheet') a.sheet = argv[++i];
		else if (v === '--subject-col') a.subjectCol = argv[++i];
		else if (v === '--subject-prefix') a.subjectPrefix = argv[++i];
		else if (v === '--header-row') a.headerRow = parseInt(argv[++i], 10) || 0;
		else if (v === '--melt')
			a.melt = parsePairs(argv[++i]).map(([column, objectPrefix]) => ({ column, objectPrefix }));
		else if (v === '--target-root') a.targetRoot = argv[++i];
		else if (v === '--depad-prefixes') a.depadPrefixes = new Set(argv[++i].split(',').map((s) => s.trim()));
		else if (v === '--object-id-sub') {
			// '<prefix>=<pattern>=<replacement>' triples, ';'-separated. Split on the
			// FIRST and LAST '=' so the pattern may not contain '=' (corpus ids don't).
			for (const trip of argv[++i].split(';').map((t) => t.trim()).filter(Boolean)) {
				const first = trip.indexOf('=');
				const last = trip.lastIndexOf('=');
				if (first < 1 || last <= first) {
					console.error(`Bad --object-id-sub "${trip}" — expected <prefix>=<pattern>=<replacement>`);
					process.exit(1);
				}
				a.objectIdSubs!.set(trip.slice(0, first), {
					pattern: new RegExp(trip.slice(first + 1, last)),
					replacement: trip.slice(last + 1),
				});
			}
		}
		else if (v === '--subject-note-folder') a.subjectNoteFolder = argv[++i];
		else if (v === '--object-note-folders')
			a.objectNoteFolders = new Map(parsePairs(argv[++i]));
		else if (v === '--provider') a.provider = argv[++i];
		else if (v === '--clean') a.clean = true;
		else if (v === '--deterministic') a.deterministic = true;
	}
	if (!a.source || !a.sheet || !a.subjectCol || !a.subjectPrefix || !a.targetRoot || a.melt.length === 0) {
		console.error(
			'Required: --source <xlsx> --sheet <name> --subject-col <name> --subject-prefix <p> --melt <col=prefix;…> --target-root <dir>',
		);
		process.exit(1);
	}
	return a as Args;
}

/** Collapse internal whitespace + trim — same header-key normalization as the
 *  other extractors (workbooks bake \r\n into header cells). */
const normKey = (k: string) => k.replace(/\s+/g, ' ').trim();

function main() {
	const a = parseArgs(process.argv.slice(2));
	const importSetId = importSetIdForRun(a.deterministic);
	const importSet: CrosswalkIdentitySetReference & { ontology: string } = {
		id: importSetId,
		scheme: IMPORT_SET_SCHEME,
		derivation: CURRENT_CROSSWALK_DERIVATION,
		ontology: SSSOM_CURIE_PREFIX,
	};
	const absSource = resolve(a.source);
	if (!existsSync(absSource)) {
		console.error(`Source workbook not found: ${absSource}`);
		process.exit(1);
	}

	// Recipe — same generic crosswalk-edge recipe the OLIR tool uses.
	const recipePath = resolve('recipes/import/crosswalk-edge.json');
	const recipe = JSON.parse(readFileSync(recipePath, 'utf8')) as Recipe;
	const recipeCheck = validateRecipe(recipe);
	if (!recipeCheck.valid) {
		console.error('Recipe failed validation:', JSON.stringify(recipeCheck.errors, null, 2));
		process.exit(1);
	}

	const sourceHash = 'sha256-' + createHash('sha256').update(readFileSync(absSource)).digest('hex');
	const sourceName = a.source.split('/').pop();

	const wb = XLSX.readFile(absSource);
	const ws = wb.Sheets[a.sheet];
	if (!ws) {
		console.error(`Sheet "${a.sheet}" not found. Sheets: ${JSON.stringify(wb.SheetNames)}`);
		process.exit(1);
	}
	const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
		range: a.headerRow,
		defval: '',
		blankrows: false,
		raw: false, // formatted text — the 4.10-stored-as-4.1 guard
	});
	const rows = raw.map((r) => {
		const row: Record<string, string> = {};
		for (const [k, val] of Object.entries(r)) {
			// Values keep internal newlines (they delimit multi-id cells); keys normalize.
			row[normKey(k)] = val === null || val === undefined ? '' : String(val);
		}
		return row;
	});

	console.log(`  source:   ${sourceName} · sheet "${a.sheet}" · ${rows.length} rows`);

	for (const spec of a.melt) {
		const col = normKey(spec.column);
		const objPrefix = spec.objectPrefix;
		const mappingSetId = `urn:crosswalker:mapping-set:${a.subjectPrefix}:${objPrefix}:${sourceHash}`;
		const target = resolve(a.targetRoot, `${a.subjectPrefix}-to-${objPrefix}`);
		if (a.clean && existsSync(target)) rmSync(target, { recursive: true });
		mkdirSync(target, { recursive: true });

		const seen = new Set<string>();
		const sssomRows: SssomRow[] = [];
		let wrote = 0;
		let invalid = 0;
		const objFolder = a.objectNoteFolders.get(objPrefix);
		const depadObj = a.depadPrefixes.has(objPrefix);

		for (const row of rows) {
			const subjLocal = (row[a.subjectCol] ?? '').trim();
			if (!subjLocal) continue;
			const cell = row[col];
			if (cell === undefined) {
				console.error(`  column not found: "${col}" — check --melt spelling against normalized headers`);
				process.exit(1);
			}
			const ids = cell
				.split(/\r?\n/)
				.map((s) => s.trim())
				.filter(Boolean);
			const idSub = a.objectIdSubs.get(objPrefix);
			for (let objLocal of ids) {
				if (idSub) objLocal = objLocal.replace(idSub.pattern, idSub.replacement);
				if (depadObj) objLocal = depadId(objLocal);
				const subject_id = `${a.subjectPrefix}:${subjLocal}`;
				const object_id = `${objPrefix}:${objLocal}`;
				const dedupe = `${subject_id}|${object_id}`;
				if (seen.has(dedupe)) continue;
				seen.add(dedupe);

				const skos = 'skos:relatedMatch'; // flat columns carry no relationship type
				const sssom: SssomRow = {
					subject_id,
					predicate_id: skos,
					object_id,
					mapping_justification: 'semapv:ManualMappingCuration',
				};
				sssomRows.push(sssom);

				const scope: Record<string, unknown> = {
					subject_id,
					object_id,
					subject_group: groupOf(subject_id),
					object_group: groupOf(object_id),
					source_framework: a.subjectPrefix,
					target_framework: objPrefix,
					strm_predicate: skosToStrm(skos),
					sssom_predicate: skos,
					mapping_justification: sssom.mapping_justification,
					mapping_provider: a.provider,
					match_confidence: '',
					mapping_set_id: mappingSetId,
					predicate_modifier: '',
				};
				const curie = `${SSSOM_CURIE_PREFIX}:${sssomEdgeCurie(scope, importSet)}`;
				const address = render(recipe, { curie, scope });

				const fm: Record<string, unknown> = { ...address.frontmatter };
				for (const k of Object.keys(fm)) {
					if (fm[k] === '') delete fm[k];
				}
				if (a.subjectNoteFolder) fm.subject_note = noteLink(a.subjectNoteFolder, subjLocal);
				if (objFolder) fm.object_note = noteLink(objFolder, objLocal);
				fm._crosswalker = {
					spec_version: SPEC_VERSION,
					source_ref: {
						file: sourceName,
						curie: `${a.subjectPrefix}:_`,
						source_hash: sourceHash,
					},
					produced_at: a.deterministic ? DETERMINISTIC_TIMESTAMP : new Date().toISOString(),
					import_set: { ...importSet },
			recipe: { id: recipe.recipe },
				};

				const check = validateTier1Frontmatter(fm);
				if (!check.valid) {
					invalid++;
					if (invalid <= 3) console.error(`  invalid edge ${curie}:`, JSON.stringify(check.errors?.slice(0, 2)));
					continue;
				}

				const subjRef = a.subjectNoteFolder
					? noteLink(a.subjectNoteFolder, subjLocal)
					: `\`${subject_id}\``;
				const objRef = objFolder ? noteLink(objFolder, objLocal) : `\`${object_id}\``;
				const body = `${subjRef} ${scope.strm_predicate} ${objRef}\n`;
				const fileName = `cw-${slug(subject_id)}--${slug(object_id)}.md`;
				writeFileSync(resolve(target, fileName), frontmatterToYaml(fm) + body);
				wrote++;
			}
		}

		writeSssomTsv(
			sssomRows,
			{ subjectPrefix: a.subjectPrefix, objectPrefix: objPrefix, provider: a.provider, deterministic: a.deterministic, mappingSetId },
			resolve(target, `_${a.subjectPrefix}-to-${objPrefix}.sssom.tsv`),
		);
		const inv = invalid ? ` · invalid ${invalid} (NOT written)` : '';
		console.log(`  ${col} → ${objPrefix}: ${wrote} edges${inv} → ${target}`);
	}
	console.log('  done.');
}

main();
