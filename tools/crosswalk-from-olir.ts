/**
 * crosswalk-from-olir.ts — turn a NIST-OLIR mapping workbook into Tier 1
 * crosswalk-edge notes (and, optionally, a standard SSSOM TSV).
 *
 * The headless companion to generate-fixtures.ts: that tool renders *concept*
 * notes; this one renders *crosswalk edges* — the between-ontology mappings that
 * the `crosswalkerPivot` Bases view turns into a coverage matrix.
 *
 * The whole point is reuse of the implemented constructs, not new ad-hoc logic:
 *   - the real, pure `render()` engine produces each edge's Address
 *     (`kind: 'crosswalk-edge'` is wired in v0.1.6)
 *   - `recipes/import/crosswalk-edge.json` is the (generic) Recipe it consumes
 *   - `validateTier1Frontmatter` / `validateRecipe` (the SAME AJV validator the
 *     plugin uses) gate every note + the recipe against spec/tier1.schema.json
 *
 * The principled predicate chain is OLIR → SKOS → STRM:
 *   OLIR "Relationship" (subset of / superset of / equal / intersects with)
 *     → a standard SKOS mapping predicate (skos:broadMatch / narrowMatch /
 *       exactMatch / relatedMatch) — this is what lands in the SSSOM TSV
 *     → STRM predicate_id (is_broader_than / … / intersects_with) for the note,
 *       via SKOS_TO_STRM mirrored from src/import/sssom-importer.ts.
 *
 * The OLIR layout is shared across crosswalks (NIST's official CSF→800-53, CRI's
 * CRI→800-53, and many more in the corpus all use Focal/Reference Document
 * Element columns), so one reader serves them all.
 *
 * Usage:
 *   bun tools/crosswalk-from-olir.ts \
 *     --source <olir.xlsx> --sheets <regex> \
 *     --subject-prefix nist-csf-2 --object-prefix nist-800-53 \
 *     --target test-vault/_crosswalker/mappings/nist-csf-to-800-53 \
 *     [--sssom-out recipes/import/crosswalks/<name>.sssom.tsv] \
 *     [--provider "NIST OLIR"] [--clean] [--deterministic] \
 *     [--header-row 3] [--subject-col <name>] [--object-col <name>] \
 *     [--depad subject|object|both] \
 *     [--subject-note-folder Frameworks/_licensed/NIST-CSF-2] \
 *     [--object-note-folder Frameworks/_licensed/NIST-800-53]
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

const DETERMINISTIC_IMPORT_SET_ID = 'iset-b3c4d5';
const IMPORT_SET_SCHEME = 'endpoint-v1';

function importSetIdForRun(deterministic: boolean): string {
	return deterministic ? DETERMINISTIC_IMPORT_SET_ID : `iset-${randomBytes(3).toString('hex')}`;
}

import {
	SPEC_VERSION,
	DETERMINISTIC_TIMESTAMP,
	skosToStrm,
	slug,
	localOf,
	groupOf,
	depadId,
	noteLink,
	frontmatterToYaml,
	writeSssomTsv,
	type SssomRow,
} from './lib/crosswalk-shared';

/** Standard SKOS mapping predicate for each OLIR relationship label.
 *  Standard SKOS semantics: `A skos:broadMatch B` ⇒ B is broader than A. */
const OLIR_TO_SKOS: Record<string, string> = {
	'equal': 'skos:exactMatch',
	'subset of': 'skos:broadMatch', // focal ⊂ reference → focal has a broader match
	'superset of': 'skos:narrowMatch', // focal ⊃ reference → focal has a narrower match
	'intersects with': 'skos:relatedMatch',
};
const DEFAULT_SKOS = 'skos:relatedMatch'; // OLIR with no relationship type → related


interface Args {
	source: string;
	sheets?: RegExp;
	subjectPrefix: string;
	objectPrefix: string;
	subjectCol: string;
	objectCol: string;
	/** 0-based header-row index — skips banner/preamble rows above the headers (default 0). */
	headerRow: number;
	/** Strip leading zeros from numeric id segments on one/both sides (AC-01 → AC-1,
	 *  IR-04(02) → IR-4(2)). NIST 800-53's canonical ids are unpadded; OLIR workbooks pad. */
	depad?: 'subject' | 'object' | 'both';
	/** Vault-relative folder of the subject-side concept notes. When set, edge notes
	 *  emit a `subject_note` wikilink + a linked body. Folder-qualified to dodge
	 *  basename ambiguity (NIST-mini fixtures share basenames with _licensed sets). */
	subjectNoteFolder?: string;
	/** Same for the object side → `object_note`. */
	objectNoteFolder?: string;
	target: string;
	sssomOut?: string;
	provider: string;
	clean: boolean;
	deterministic: boolean;
}

function parseArgs(argv: string[]): Args {
	const a: Partial<Args> = {
		subjectCol: 'Focal Document Element',
		objectCol: 'Reference Document Element',
		headerRow: 0,
		provider: 'OLIR crosswalk',
		clean: false,
		deterministic: process.env.CW_DETERMINISTIC === '1',
	};
	for (let i = 0; i < argv.length; i++) {
		const v = argv[i];
		if (v === '--source') a.source = argv[++i];
		else if (v === '--sheets') a.sheets = new RegExp(argv[++i]);
		else if (v === '--subject-prefix') a.subjectPrefix = argv[++i];
		else if (v === '--object-prefix') a.objectPrefix = argv[++i];
		else if (v === '--subject-col') a.subjectCol = argv[++i];
		else if (v === '--object-col') a.objectCol = argv[++i];
		else if (v === '--header-row') a.headerRow = parseInt(argv[++i], 10) || 0;
		else if (v === '--depad') a.depad = argv[++i] as Args['depad'];
		else if (v === '--subject-note-folder') a.subjectNoteFolder = argv[++i];
		else if (v === '--object-note-folder') a.objectNoteFolder = argv[++i];
		else if (v === '--target') a.target = argv[++i];
		else if (v === '--sssom-out') a.sssomOut = argv[++i];
		else if (v === '--provider') a.provider = argv[++i];
		else if (v === '--clean') a.clean = true;
		else if (v === '--deterministic') a.deterministic = true;
	}
	if (!a.source || !a.target || !a.subjectPrefix || !a.objectPrefix) {
		console.error(
			'Required: --source <xlsx> --target <dir> --subject-prefix <p> --object-prefix <p>',
		);
		process.exit(1);
	}
	return a as Args;
}

/** Collapse internal whitespace + trim — mirrors the header-key normalization in
 *  generate-fixtures.ts (NIST/CRI workbooks bake \r\n into header cells). */
const normKey = (k: string) => k.replace(/\s+/g, ' ').trim();

interface OlirRow {
	[key: string]: string;
}

/** Read every matching sheet of an OLIR workbook into normalized-key rows. */
function readOlir(absPath: string, sheets: RegExp | undefined, headerRow: number): OlirRow[] {
	if (!existsSync(absPath)) {
		console.error(`Source workbook not found: ${absPath}`);
		process.exit(1);
	}
	const wb = XLSX.readFile(absPath);
	const names = wb.SheetNames.filter((s) => (sheets ? sheets.test(s) : true));
	const out: OlirRow[] = [];
	for (const sn of names) {
		const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sn], {
			range: headerRow, // start at this row; treat it as the header (skips banner rows)
			defval: '',
			blankrows: false,
			// Formatted text, not raw values — same fix as generate-fixtures.ts:
			// Excel can store an id like "4.10" as the NUMBER 4.1, and String(4.1)
			// silently collides it with id 4.1. Read what Excel displays.
			raw: false,
		});
		for (const r of raw) {
			const row: OlirRow = {};
			for (const [k, val] of Object.entries(r)) {
				row[normKey(k)] = val === null || val === undefined ? '' : String(val).trim();
			}
			out.push(row);
		}
	}
	return out;
}







/** Map one OLIR row to an SSSOM row. Returns null for rows missing either end. */
function olirToSssom(row: OlirRow, a: Args): SssomRow | null {
	const focal = (row[a.subjectCol] ?? '').trim();
	const reference = (row[a.objectCol] ?? '').trim();
	if (!focal || !reference) return null;

	const rel = (row['Relationship'] ?? '').trim().toLowerCase();
	const skos = OLIR_TO_SKOS[rel] ?? DEFAULT_SKOS;

	const strengthRaw = (row['Strength of Relationship (Optional)'] ?? row['Strength of Relationship'] ?? '')
		.toString()
		.trim();
	let confidence: number | undefined;
	if (strengthRaw !== '') {
		const n = Number(strengthRaw);
		// OLIR strength is a 0–10 integer; normalize to a 0–1 confidence.
		if (!Number.isNaN(n)) confidence = Math.max(0, Math.min(1, n / 10));
	}

	const subjLocal = a.depad === 'subject' || a.depad === 'both' ? depadId(focal) : focal;
	const objLocal = a.depad === 'object' || a.depad === 'both' ? depadId(reference) : reference;
	return {
		subject_id: `${a.subjectPrefix}:${subjLocal}`,
		predicate_id: skos,
		object_id: `${a.objectPrefix}:${objLocal}`,
		mapping_justification: 'semapv:ManualMappingCuration',
		confidence,
	};
}




function main(): void {
	const a = parseArgs(process.argv.slice(2));
	const importSetId = importSetIdForRun(a.deterministic);
	const importSet: CrosswalkIdentitySetReference & { ontology: string } = {
		id: importSetId,
		scheme: IMPORT_SET_SCHEME,
		derivation: CURRENT_CROSSWALK_DERIVATION,
		ontology: SSSOM_CURIE_PREFIX,
	};

	// Load + AJV-validate the generic crosswalk-edge recipe (same validator the plugin uses).
	const recipePath = resolve(import.meta.dir, '../recipes/import/crosswalk-edge.json');
	const recipe = JSON.parse(readFileSync(recipePath, 'utf8')) as Recipe;
	const recipeCheck = validateRecipe(recipe);
	if (!recipeCheck.valid) {
		console.error('crosswalk-edge.json failed recipe-schema validation:', recipeCheck.errors);
		process.exit(1);
	}

	const olirRows = readOlir(resolve(a.source), a.sheets, a.headerRow);
	const sourceHash = 'sha256-' + createHash('sha256').update(readFileSync(resolve(a.source))).digest('hex');
	const mappingSetId = `urn:crosswalker:mapping-set:${a.subjectPrefix}:${a.objectPrefix}:${sourceHash}`;

	if (a.clean && existsSync(a.target)) rmSync(a.target, { recursive: true, force: true });
	mkdirSync(a.target, { recursive: true });

	const sssomRows: SssomRow[] = [];
	const seen = new Set<string>();
	let wrote = 0;
	let skipped = 0;
	let invalid = 0;

	for (const row of olirRows) {
		const sssom = olirToSssom(row, a);
		if (!sssom) {
			skipped++;
			continue;
		}
		const dedupeKey = `${sssom.subject_id}|${sssom.object_id}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		sssomRows.push(sssom);

		// Build the render scope: SKOS in the TSV, STRM in the note.
		const scope: Record<string, unknown> = {
			subject_id: sssom.subject_id,
			object_id: sssom.object_id,
			subject_group: groupOf(sssom.subject_id), // roll-up axis (CSF function / 800-53 family)
			object_group: groupOf(sssom.object_id),
			source_framework: a.subjectPrefix,
			target_framework: a.objectPrefix,
			strm_predicate: skosToStrm(sssom.predicate_id),
			sssom_predicate: sssom.predicate_id,
			mapping_justification: sssom.mapping_justification,
			mapping_provider: a.provider,
			match_confidence: sssom.confidence ?? '',
			mapping_set_id: mappingSetId,
			predicate_modifier: '',
		};
		const curie = `${SSSOM_CURIE_PREFIX}:${sssomEdgeCurie(scope, importSet)}`;
		const address = render(recipe, { curie, scope });

		// Assemble the note frontmatter; drop empty optional fields; coerce number.
		const fm: Record<string, unknown> = { ...address.frontmatter };
		for (const k of Object.keys(fm)) {
			if (fm[k] === '') delete fm[k];
		}
		if (sssom.confidence !== undefined) fm.match_confidence = sssom.confidence;
		// Wikilinks to the concept notes (when folders are known) — makes edges
		// navigable in Bases/graph instead of dead bare-CURIE strings.
		const subjLocal = localOf(sssom.subject_id);
		const objLocal = localOf(sssom.object_id);
		if (a.subjectNoteFolder) fm.subject_note = noteLink(a.subjectNoteFolder, subjLocal);
		if (a.objectNoteFolder) fm.object_note = noteLink(a.objectNoteFolder, objLocal);
		fm._crosswalker = {
			spec_version: SPEC_VERSION,
			source_ref: {
				file: a.source.split('/').pop(),
				curie: `${a.subjectPrefix}:_`,
				source_hash: sourceHash,
			},
			produced_at: a.deterministic ? DETERMINISTIC_TIMESTAMP : new Date().toISOString(),
			import_set: { ...importSet },
			recipe: { id: recipe.recipe },
		};

		// Validate against the Tier 1 schema (the implemented validator) before writing.
		const check = validateTier1Frontmatter(fm);
		if (!check.valid) {
			invalid++;
			if (invalid <= 3) console.error(`  invalid edge ${curie}:`, JSON.stringify(check.errors?.slice(0, 2)));
			continue;
		}

		const subjRef = a.subjectNoteFolder
			? noteLink(a.subjectNoteFolder, subjLocal)
			: `\`${sssom.subject_id}\``;
		const objRef = a.objectNoteFolder
			? noteLink(a.objectNoteFolder, objLocal)
			: `\`${sssom.object_id}\``;
		const body = `${subjRef} ${scope.strm_predicate} ${objRef}\n`;
		const fileName = `cw-${slug(sssom.subject_id)}--${slug(sssom.object_id)}.md`;
		writeFileSync(resolve(a.target, fileName), frontmatterToYaml(fm) + body);
		wrote++;
	}

	if (a.sssomOut) writeSssomTsv(sssomRows, { subjectPrefix: a.subjectPrefix, objectPrefix: a.objectPrefix, provider: a.provider, deterministic: a.deterministic, mappingSetId }, resolve(a.sssomOut));

	console.log(`  source:   ${a.source.split('/').pop()}`);
	console.log(`  edges:    ${a.subjectPrefix} → ${a.objectPrefix}`);
	console.log(`  read:     ${olirRows.length} OLIR rows`);
	console.log(`  skipped:  ${skipped} (missing focal/reference)`);
	if (invalid) console.log(`  invalid:  ${invalid} (failed Tier 1 schema — NOT written)`);
	console.log(`  wrote:    ${wrote} crosswalk-edge notes → ${a.target}`);
	if (a.sssomOut) console.log(`  sssom:    ${sssomRows.length} rows → ${a.sssomOut}`);
	console.log('  done.');
}

main();
