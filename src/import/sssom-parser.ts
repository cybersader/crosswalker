/**
 * sssom-parser.ts — Phase 2 v0.1.6 (per Ch 35)
 *
 * Parser for SSSOM TSV files (Simple Standard for Sharing Ontological Mappings).
 * SSSOM is the canonical TSV interchange format used by BioPortal, OxO/OxO2,
 * OBO Foundry, Biomappings, and (per the v0.1.6 commitment) Crosswalker.
 *
 * Spec: https://w3id.org/sssom/ (0.15+)
 *
 * File format:
 *   - TSV (tab-separated values), UTF-8
 *   - Optional header lines starting with `# ` carry YAML-shaped metadata
 *     (curie_map, mapping_set_id, license, mapping_provider, etc.)
 *   - First non-comment line = column headers
 *   - Each subsequent row = one mapping
 *
 * Required columns (per SSSOM 0.15+):
 *   - subject_id    (CURIE; the source concept)
 *   - predicate_id  (CURIE; typically a SKOS predicate)
 *   - object_id     (CURIE; the target concept)
 *
 * Common optional columns:
 *   - subject_label, object_label
 *   - mapping_justification (semapv: vocab; e.g. ManualMappingCuration, LexicalMatching)
 *   - confidence (numeric 0-1)
 *   - mapping_set_id, mapping_provider, mapping_date
 *   - subject_source, object_source
 *   - match_type, match_confidence (legacy column names; aliased to predicate_id/confidence)
 *
 * The parser preserves all columns it finds; only `subject_id` / `predicate_id`
 * / `object_id` are required for downstream import. Extra columns flow into
 * the junction-note frontmatter as-is per Ch 35 SSSOM-shape preservation.
 */

import Papa, { type ParseError } from 'papaparse';
import { normalizePredicateModifierInput } from '../utils/mapping-provenance';

/** A single parsed SSSOM mapping row. SSSOM-shape; all standard cols + extras. */
export interface SssomRow {
	subject_id: string;
	predicate_id: string;
	object_id: string;
	subject_label?: string;
	object_label?: string;
	mapping_justification?: string;
	confidence?: number;
	mapping_set_id?: string;
	predicate_modifier?: 'NOT';
	mapping_provider?: string;
	mapping_date?: string;
	subject_source?: string;
	object_source?: string;
	match_type?: string;
	/** Any additional columns from the TSV are preserved as strings. */
	[key: string]: string | number | undefined;
}

/** SSSOM mapping-set-level metadata extracted from the `# `-prefixed header lines. */
export interface SssomHeader {
	/** CURIE-prefix → URI map declared via `curie_map:` */
	curie_map?: Record<string, string>;
	mapping_set_id?: string;
	mapping_set_version?: string;
	mapping_set_title?: string;
	mapping_set_description?: string;
	subject_source?: string;
	subject_source_version?: string;
	object_source?: string;
	object_source_version?: string;
	mapping_provider?: string;
	mapping_date?: string;
	/** SSSOM declares creator_id as a list; a single value parses as a string. */
	creator_id?: string | string[];
	license?: string;
	/** Any additional metadata keys are preserved as strings, nested maps or lists. */
	[key: string]: string | string[] | Record<string, string> | undefined;
}

/** Result of parsing a SSSOM TSV file. */
export interface SssomParseResult {
	header: SssomHeader;
	rows: SssomRow[];
	/** Any parse warnings (malformed rows, missing required columns, etc.). */
	warnings: string[];
	/** Hard errors that prevented parsing. Empty when parse succeeds. */
	errors: string[];
}

/** Required columns per SSSOM 0.15+ spec. Parsing fails if any are missing. */
const REQUIRED_COLUMNS = ['subject_id', 'predicate_id', 'object_id'] as const;

/**
 * Parse SSSOM TSV content from a string. Returns a structured result with
 * header metadata, rows, warnings, and errors. Does NOT throw — call sites
 * inspect `errors.length === 0` to determine success.
 */
export function parseSssomTsv(content: string): SssomParseResult {
	const result: SssomParseResult = {
		header: {},
		rows: [],
		warnings: [],
		errors: [],
	};

	if (!content || content.trim().length === 0) {
		result.errors.push('SSSOM file is empty');
		return result;
	}

	// Split header (lines starting with `# `) from data.
	const lines = content.split(/\r?\n/);
	const headerLines: string[] = [];
	const dataLines: string[] = [];
	let inHeader = true;
	for (const line of lines) {
		if (inHeader && line.startsWith('# ')) {
			headerLines.push(line);
		} else if (line.length === 0 && inHeader) {
			// Blank line between header and data; skip it.
			continue;
		} else {
			inHeader = false;
			dataLines.push(line);
		}
	}

	// Parse the header block (simple line-by-line YAML-ish key:value).
	result.header = parseHeader(headerLines, result.warnings);

	// Parse the TSV body via PapaParse with tab delimiter + header row.
	if (dataLines.length === 0) {
		result.errors.push('SSSOM file has no data rows');
		return result;
	}

	const tsvBody = dataLines.join('\n');
	const papaResult = Papa.parse<Record<string, string>>(tsvBody, {
		header: true,
		delimiter: '\t',
		skipEmptyLines: true,
		dynamicTyping: false, // Keep all values as strings; we cast confidence ourselves.
		transformHeader: (h) => h.trim(),
	});

	if (papaResult.errors.length > 0) {
		for (const err of papaResult.errors as ParseError[]) {
			result.warnings.push(`TSV parse warning at row ${err.row ?? '?'}: ${err.message}`);
		}
	}

	const headers = (papaResult.meta.fields ?? []).map((h) => h.trim());
	const missing = REQUIRED_COLUMNS.filter((col) => !headers.includes(col));
	if (missing.length > 0) {
		result.errors.push(
			`Missing required SSSOM column(s): ${missing.join(', ')}. ` +
				`Found columns: ${headers.join(', ')}`,
		);
		return result;
	}

	for (let i = 0; i < papaResult.data.length; i++) {
		const raw = papaResult.data[i];
		// Skip rows where ALL required cols are empty (PapaParse sometimes yields trailing junk).
		const subj = (raw.subject_id ?? '').trim();
		const pred = (raw.predicate_id ?? '').trim();
		const obj = (raw.object_id ?? '').trim();
		if (!subj && !pred && !obj) continue;

		// Validate required cols on this row.
		if (!subj || !pred || !obj) {
			result.warnings.push(
				`Row ${i + 1} missing required field(s); skipping. ` +
					`subject_id='${subj}' predicate_id='${pred}' object_id='${obj}'`,
			);
			continue;
		}

		const row: SssomRow = {
			subject_id: subj,
			predicate_id: pred,
			object_id: obj,
		};

		// Copy all known optional columns + any extras.
		for (const [key, value] of Object.entries(raw)) {
			if (key === 'subject_id' || key === 'predicate_id' || key === 'object_id') continue;
			if (key === 'predicate_modifier') {
				if (value === undefined || value === null || value === '') continue;
				try {
					row.predicate_modifier = normalizePredicateModifierInput(value) || undefined;
				} catch (error) {
					result.errors.push(
						`Row ${i + 1}: invalid predicate_modifier "${String(value)}": ${(error as Error).message}`,
					);
				}
				continue;
			}
			if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) continue;
			if (key === 'confidence' || key === 'match_confidence') {
				const num = Number.parseFloat(String(value));
				if (Number.isFinite(num)) {
					row.confidence = num;
				} else {
					result.warnings.push(`Row ${i + 1}: confidence "${value}" is not a number; skipping`);
				}
			} else {
				row[key] = String(value).trim();
			}
		}

		result.rows.push(row);
	}

	if (result.rows.length === 0 && result.errors.length === 0) {
		result.warnings.push('SSSOM file parsed but contains zero valid mapping rows');
	}

	return result;
}

/**
 * Parse SSSOM `# `-prefixed header lines into a structured header object.
 * Supports simple `key: value` and `key:` followed by indented `  child: value`
 * (one level of nesting, e.g. `curie_map:`).
 */
function parseHeader(lines: string[], warnings: string[]): SssomHeader {
	const header: SssomHeader = {};
	let currentParent: string | null = null;

	for (const raw of lines) {
		// Strip leading "# " marker.
		const line = raw.replace(/^# /, '');
		if (line.trim().length === 0) continue;

		// One-level list item under a `key:` line, as SSSOM writes creator_id:
		// "  - orcid:0000". The parent becomes a list on its first item.
		if (/^\s+/.test(line) && currentParent) {
			const itemMatch = line.match(/^\s+-\s+(.*)$/);
			if (itemMatch) {
				const existing = header[currentParent];
				const list = Array.isArray(existing) ? existing : [];
				list.push(stripQuotes(itemMatch[1]));
				header[currentParent] = list;
				continue;
			}
		}

		// One-level nested child: starts with whitespace + "key: value"
		if (/^\s+/.test(line) && currentParent) {
			const childMatch = line.match(/^\s+([A-Za-z_][\w-]*?):\s*(.*)$/);
			if (childMatch) {
				const [, ck, cv] = childMatch;
				if (!header[currentParent] || typeof header[currentParent] !== 'object' || Array.isArray(header[currentParent])) {
					header[currentParent] = {} as Record<string, string>;
				}
				(header[currentParent] as Record<string, string>)[ck] = stripQuotes(cv);
				continue;
			}
		}

		// Top-level key:
		const topMatch = line.match(/^([A-Za-z_][\w-]*?):\s*(.*)$/);
		if (topMatch) {
			const [, key, val] = topMatch;
			currentParent = null;
			if (val.trim() === '') {
				// `key:` with no value — start a nested-object section.
				header[key] = {} as Record<string, string>;
				currentParent = key;
			} else {
				header[key] = stripQuotes(val);
			}
		} else {
			warnings.push(`Unrecognized SSSOM header line: '${raw}'`);
		}
	}

	return header;
}

/** Strip surrounding double-quotes from a value (SSSOM headers often quote URLs). */
function stripQuotes(s: string): string {
	const trimmed = s.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/**
 * Derive the source/target ontology pair from a parse result. Tries (in order):
 *   1. header.subject_source / header.object_source (SSSOM mapping-set-level)
 *   2. The first row's subject CURIE prefix / object CURIE prefix
 *
 * Used by the importer to construct the junction-note folder path
 * (`_crosswalker/mappings/<source>-to-<target>/`).
 */
export function detectOntologyPair(result: SssomParseResult): { source: string; target: string } | null {
	if (typeof result.header.subject_source === 'string' && typeof result.header.object_source === 'string') {
		return { source: result.header.subject_source, target: result.header.object_source };
	}
	const firstRow = result.rows[0];
	if (!firstRow) return null;
	const subjPrefix = curiePrefix(firstRow.subject_id);
	const objPrefix = curiePrefix(firstRow.object_id);
	if (!subjPrefix || !objPrefix) return null;
	return { source: subjPrefix, target: objPrefix };
}

/** Extract the prefix from a CURIE (`csf:GV.OC-01` → `csf`). */
export function curiePrefix(curie: string): string | null {
	const idx = curie.indexOf(':');
	if (idx <= 0) return null;
	return curie.slice(0, idx);
}
