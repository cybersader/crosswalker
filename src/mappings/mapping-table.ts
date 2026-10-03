/**
 * Crosswalker mapping-table ledger. Its predicate_id is STRM, not the SKOS
 * predicate a generic SSSOM reader expects; standards exports use the SSSOM
 * exporter instead. This codec does no vault I/O or provenance stamping.
 */
import Papa from 'papaparse';
import { sha256Hex } from '../generation/hash';
import { crosswalkEdgeCuriePrefix, sssomEdgeCurie } from '../generation/crosswalk-identity';
import {
	validateImportSetBlock,
	type CrosswalkerProvenance,
	type ImportSetDerivation,
	type ImportSetScheme,
} from '../generation/import-set-block';
import { mappingOccurrenceContentKey, normalizeMappingSetId } from '../utils/mapping-provenance';

export const MAPPING_TABLE_FORMAT = 'crosswalker-mapping-table-v1';

/**
 * The review statuses a mapping can carry (source: spec/tier1.schema.json,
 * crosswalk edge `review_status` enum). The one code copy: the conversion job
 * and the review view both read it here. Failure mode prevented: a second
 * hand-kept list drifting from the schema, so the view offers a status the
 * notes form then refuses to store.
 */
export const REVIEW_STATUSES = ['proposed', 'in_review', 'approved', 'deprecated'] as const;
export type ReviewStatus = typeof REVIEW_STATUSES[number];

export interface MappingTableHeader {
	mapping_set_id?: string;
	mapping_provider?: string;
	mapping_date?: string;
	subject_source?: string;
	object_source?: string;
	license?: string;
	crosswalker_format: typeof MAPPING_TABLE_FORMAT;
	import_set?: string;
	source_framework?: string;
	target_framework?: string;
	tags?: string[];
	/**
	 * Slice 2 (2026-09-30). The set's whole `_crosswalker` block, once. A table
	 * set has no notes, so without this nothing in the vault records that the
	 * set exists: discovery, projection and export read it here.
	 */
	crosswalker_provenance?: CrosswalkerProvenance;
	/**
	 * The set's release record (spec/tier1.schema.json
	 * `mapping_set_frontmatter` without `_crosswalker`), once. Read through
	 * `mapping-set.ts`; absent on tables written before records existed.
	 */
	mapping_set?: Record<string, unknown>;
}

export interface MappingTableRow {
	row_id: string;
	subject_id: string;
	predicate_id: string;
	object_id: string;
	sssom_predicate?: string;
	predicate_modifier?: 'NOT';
	mapping_justification?: string;
	confidence?: string;
	subject_label?: string;
	object_label?: string;
	subject_note?: string;
	object_note?: string;
	mapping_provider?: string;
	mapping_set_id?: string;
	review_status?: string;
	reviewer?: string;
	notes?: Record<string, string>;
	extra?: Record<string, unknown>;
}

const HEADER_KEYS = [
	'mapping_set_id', 'mapping_provider', 'mapping_date', 'subject_source',
	'object_source', 'license', 'crosswalker_format', 'import_set',
	'source_framework', 'target_framework', 'tags', 'crosswalker_provenance',
	'mapping_set',
] as const;
/** Header values carried as JSON inside the JSON-quoted string. */
const JSON_HEADER_KEYS = new Set<string>(['tags', 'crosswalker_provenance', 'mapping_set']);
const COLUMNS = [
	'row_id', 'subject_id', 'predicate_id', 'object_id', 'sssom_predicate',
	'predicate_modifier', 'mapping_justification', 'confidence', 'subject_label',
	'object_label', 'subject_note', 'object_note', 'mapping_provider',
	'mapping_set_id', 'review_status', 'reviewer', 'crosswalker_notes',
	'crosswalker_extra',
] as const;
const REQUIRED = ['row_id', 'subject_id', 'predicate_id', 'object_id'] as const;
const STRINGS = COLUMNS.filter((column) => column !== 'crosswalker_notes' && column !== 'crosswalker_extra') as Exclude<typeof COLUMNS[number], 'crosswalker_notes' | 'crosswalker_extra'>[];

export type MappingTableRowFacts = Omit<MappingTableRow, 'row_id'>;

export interface MappingRowIdBase {
	subject_id: string;
	predicate_id: string;
	object_id: string;
	predicate_modifier?: string;
	mapping_set_id?: string;
}

/**
 * Identity follows the edge's own facts, never its mutable vault address.
 * `ordinal` 0 means the row is the only occurrence of its base facts and gets
 * no suffix; 1..N number the occurrences of a shared base.
 */
export function mappingRowId(base: MappingRowIdBase, ordinal: number): string {
	const hex = sha256Hex([
		base.subject_id, base.predicate_id, base.object_id,
		base.predicate_modifier ?? '', normalizeMappingSetId(base.mapping_set_id),
	].join('\u0000')).slice(0, 16);
	return ordinal > 0 ? `m-${hex}-${String(ordinal).padStart(2, '0')}` : `m-${hex}`;
}

/**
 * The assertion facts an occurrence is ordered by: the fields a source SSSOM
 * record supplies. Review columns (`review_status`, `reviewer`), user notes,
 * user-owned `extra` fields and the path-bearing `subject_note`/`object_note`
 * wikilinks are deliberately left out. Failure mode prevented: a review edit or
 * a moved endpoint note on one occurrence re-ordering its siblings, which would
 * swap row_ids and silently re-point every `<path>#<row_id>` address.
 * Limitation: occurrences that differ only in excluded fields tie, and a tie is
 * broken by input order (the same rule as truly identical rows).
 */
const OCCURRENCE_KEY_FIELDS = [
	'subject_id', 'predicate_id', 'object_id', 'sssom_predicate', 'predicate_modifier',
	'mapping_justification', 'confidence', 'subject_label', 'object_label', 'mapping_provider',
] as const;

/**
 * Assign every row of one table its id, as a batch. Failure mode prevented:
 * occurrence-distinct mappings (same subject, predicate and object, different
 * justification) collapsing onto one id, so a parser keeps the first and drops
 * the rest. Mirrors the SSSOM importer: `mapping_set_id` is trimmed and falls
 * back to the header's set id (`defaultMappingSetId`), and occurrences of a
 * shared base are ordered by their assertion-fact key, not input order, so
 * reordering the input never renumbers a row. Any `row_id` already on an input
 * row is ignored: ids are always recomputed from the facts.
 */
export function assignMappingRowIds(rows: MappingTableRowFacts[], defaultMappingSetId?: string): MappingTableRow[] {
	const fallbackSetId = normalizeMappingSetId(defaultMappingSetId);
	const prepared = rows.map((input, index) => {
		const { row_id: _ignored, ...row } = input as MappingTableRowFacts & { row_id?: unknown };
		const mappingSetId = normalizeMappingSetId(row.mapping_set_id) || fallbackSetId;
		const idBase: MappingRowIdBase = { ...row, mapping_set_id: mappingSetId };
		const key: Record<string, unknown> = { mapping_set_id: mappingSetId };
		for (const field of OCCURRENCE_KEY_FIELDS) key[field] = row[field];
		return { row, index, idBase, base: mappingRowId(idBase, 0), contentKey: mappingOccurrenceContentKey(key) };
	});
	const groups = new Map<string, typeof prepared>();
	for (const entry of prepared) {
		const group = groups.get(entry.base);
		if (group) group.push(entry);
		else groups.set(entry.base, [entry]);
	}
	const ids = new Map<number, string>();
	for (const group of groups.values()) {
		if (group.length === 1) {
			ids.set(group[0].index, group[0].base);
			continue;
		}
		group.sort((a, b) => a.contentKey.localeCompare(b.contentKey) || a.index - b.index);
		group.forEach((entry, position) => ids.set(entry.index, mappingRowId(entry.idBase, position + 1)));
	}
	return prepared.map(({ row, index }) => ({ ...row, row_id: ids.get(index)! }));
}

export function serializeMappingTable(header: MappingTableHeader, rows: MappingTableRow[]): string {
	const lines = HEADER_KEYS.flatMap((key) => {
		const value = header[key];
		return value === undefined ? [] : [`# ${key}: ${JSON.stringify(JSON_HEADER_KEYS.has(key) ? JSON.stringify(value) : value)}`];
	});
	const records = [...rows].sort((a, b) => a.row_id.localeCompare(b.row_id)).map((row) =>
		Object.fromEntries(COLUMNS.map((column) => {
			const value = column === 'crosswalker_notes' ? row.notes
				: column === 'crosswalker_extra' ? row.extra
				: row[column];
			return [column, value === undefined || value === null
				|| (typeof value === 'object' && Object.keys(value).length === 0)
				? '' : typeof value === 'object' ? JSON.stringify(value) : value];
		})),
	);
	return `${lines.join('\n')}\n${Papa.unparse(records, { columns: [...COLUMNS], delimiter: '\t', newline: '\n' })}\n`;
}

const NOT_TABLE_FORM = "This mapping table's import set is not pinned to table form. Convert the set instead of editing the file.";

/**
 * The header is the set's only provenance record, so it is held to the rules a
 * note's block is held to (one shared validator), plus the two a table adds: it
 * must agree with its own `import_set` line, and it must be pinned to table form.
 * Failure mode prevented: a stray or hand-edited table quietly adopting a notes
 * set, which would give one set two storage forms and two row populations.
 */
function provenanceErrors(header: MappingTableHeader): string[] {
	const block = header.crosswalker_provenance?.import_set;
	// A provenance block without an import_set is not a table pin.
	if (block === undefined) return [NOT_TABLE_FORM];
	let facts: ReturnType<typeof validateImportSetBlock>;
	try {
		facts = validateImportSetBlock(block, 'mapping table header');
	} catch (error) {
		return [error instanceof Error ? error.message : String(error)];
	}
	const errors: string[] = [];
	if (header.import_set !== undefined && header.import_set.trim() !== facts.id) {
		errors.push('Mapping table header import_set does not match its provenance block. Fix one of them before importing.');
	}
	if (facts.mappingForm !== 'table') errors.push(NOT_TABLE_FORM);
	return errors;
}

/**
 * State of a table's provenance header: no line at all, a line or block that
 * would not parse or validate, or a usable pin. Callers branch on this instead
 * of matching error text. Failure mode prevented: a reworded message silently
 * changing which tables fail closed.
 */
export type MappingTableProvenanceState = 'absent' | 'invalid' | 'valid';

export interface ParsedMappingTable {
	header: MappingTableHeader;
	/** Surviving rows. Empty whenever `errors` is non-empty. */
	rows: MappingTableRow[];
	/** Header or structural problems. When non-empty, no row was read. */
	errors: string[];
	/**
	 * Per-row problems (missing required value, duplicate row_id, malformed JSON
	 * cell). The offending rows are dropped; every other row is still returned,
	 * so one bad row does not hide the rest of the set from its owner.
	 */
	rowErrors: string[];
	warnings: string[];
	provenance: MappingTableProvenanceState;
}

/** Refuse unknown ledgers instead of treating STRM predicate_id as SKOS. */
export function parseMappingTable(tsv: string): ParsedMappingTable {
	const errors: string[] = [];
	const rowErrors: string[] = [];
	const warnings: string[] = [];
	let provenanceLineInvalid = false;
	const header: MappingTableHeader = { crosswalker_format: MAPPING_TABLE_FORMAT };
	let offset = 0;
	let lineNumber = 0;
	let formatSeen = false;
	while (tsv.startsWith('# ', offset)) {
		const end = tsv.indexOf('\n', offset);
		const line = tsv.slice(offset, end === -1 ? undefined : end).replace(/\r$/, '');
		lineNumber++;
		const match = /^# ([a-z_]+): (.*)$/.exec(line);
		if (match && (HEADER_KEYS as readonly string[]).includes(match[1])) {
			try {
				const value: unknown = JSON.parse(match[2]);
				if (typeof value !== 'string') throw new Error('expected a JSON-quoted string');
				if (match[1] === 'tags') {
					const tags: unknown = JSON.parse(value);
					if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) throw new Error('expected a JSON array of strings');
					header.tags = tags;
				} else if (match[1] === 'crosswalker_provenance') {
					const block: unknown = JSON.parse(value);
					if (!block || typeof block !== 'object' || Array.isArray(block)) throw new Error('expected a JSON object');
					header.crosswalker_provenance = block as CrosswalkerProvenance;
				} else if (match[1] === 'mapping_set') {
					const record: unknown = JSON.parse(value);
					if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('expected a JSON object');
					header.mapping_set = record as Record<string, unknown>;
				} else if (match[1] === 'crosswalker_format') {
					formatSeen = value === MAPPING_TABLE_FORMAT;
				} else {
					(header as unknown as Record<string, unknown>)[match[1]] = value;
				}
			} catch {
				if (match[1] === 'crosswalker_provenance') provenanceLineInvalid = true;
				errors.push(`Invalid mapping table header ${match[1]} on line ${lineNumber}. Fix its JSON-quoted value.`);
			}
		}
		offset = end === -1 ? tsv.length : end + 1;
	}
	if (!formatSeen) errors.push('This file is not a Crosswalker mapping table. Import it as a crosswalk mapping file instead.');
	const blockErrors = header.crosswalker_provenance ? provenanceErrors(header) : [];
	errors.push(...blockErrors);
	const provenance: MappingTableProvenanceState = provenanceLineInvalid || blockErrors.length ? 'invalid'
		: header.crosswalker_provenance ? 'valid' : 'absent';
	// Do not split/rejoin the body: quoted cell data may contain literal CRLF.
	const parsed = Papa.parse<Record<string, string>>(tsv.slice(offset), { header: true, delimiter: '\t', newline: '\n', skipEmptyLines: true });
	const columns = parsed.meta.fields ?? [];
	for (const key of REQUIRED) if (!columns.includes(key)) errors.push(`Missing required mapping table column: ${key}.`);
	for (const problem of parsed.errors) errors.push(`Invalid mapping table TSV near row ${(problem.row ?? 0) + 1}: ${problem.message}`);
	if (errors.length) return { header, rows: [], errors, rowErrors, warnings, provenance };
	const rows: MappingTableRow[] = [];
	const seen = new Set<string>();
	let skipped = 0;
	for (const [index, record] of parsed.data.entries()) {
		const rowNumber = index + 1;
		const missing = REQUIRED.filter((key) => typeof record[key] !== 'string' || !record[key]);
		if (missing.length) {
			rowErrors.push(`Missing required mapping table value ${missing.join(', ')} on row ${rowNumber}. Fill these cells before importing that row.`);
			skipped++;
			continue;
		}
		const id = record.row_id;
		if (seen.has(id)) {
			rowErrors.push(`Duplicate mapping table row_id: ${id}. Give each mapping a distinct row identity.`);
			continue;
		}
		seen.add(id);
		const result: Record<string, unknown> = {};
		for (const column of STRINGS) if (record[column] !== undefined && record[column] !== '') result[column] = record[column];
		let malformed = false;
		for (const [column, key] of [['crosswalker_notes', 'notes'], ['crosswalker_extra', 'extra']] as const) {
			if (!record[column]) continue;
			try {
				const value: unknown = JSON.parse(record[column]);
				if (!value || typeof value !== 'object' || Array.isArray(value)
					|| (key === 'notes' && Object.values(value).some((v) => typeof v !== 'string'))) throw new Error('expected a JSON object');
				result[key] = value;
			} catch {
				rowErrors.push(`Invalid JSON in ${column} on row ${rowNumber}. Fix this cell before importing that row.`);
				malformed = true;
			}
		}
		if (malformed) { skipped++; continue; }
		rows.push(result as unknown as MappingTableRow);
	}
	if (skipped) warnings.push(`Skipped ${skipped} mapping table row${skipped === 1 ? '' : 's'} with missing required values or malformed JSON.`);
	return { header, rows, errors, rowErrors, warnings, provenance };
}

/**
 * The curie a table row's edge note would carry, derived from the set's pinned
 * identity rules, or undefined when the header records no usable pin. It is the
 * full prefixed curie (`sssom:<local part>`) the notes path stamps, composed the
 * same way: the set's edge prefix, a colon, then `sssomEdgeCurie`.
 */
export function derivedEdgeCurie(row: { subject_id: string; object_id: string }, header?: MappingTableHeader): string | undefined {
	const block = header?.crosswalker_provenance?.import_set;
	if (block === undefined) return undefined;
	// The same validated, trimmed facts the parser checked, so the curie matches
	// the one the note form mints from the trimmed id.
	let facts: ReturnType<typeof validateImportSetBlock>;
	try {
		facts = validateImportSetBlock(block, 'mapping table header');
	} catch {
		return undefined;
	}
	const localPart = sssomEdgeCurie(
		{ subject_id: row.subject_id, object_id: row.object_id },
		{
			id: facts.id,
			scheme: facts.scheme as ImportSetScheme,
			...(facts.derivation !== null ? { derivation: facts.derivation as ImportSetDerivation } : {}),
		},
	);
	return `${crosswalkEdgeCuriePrefix(facts.ontology)}:${localPart}`;
}

/**
 * Separate managed columns from user-owned fields without dropping unknown keys.
 * The row has no `row_id`: identity is a property of the batch (see
 * `assignMappingRowIds`), so a caller that converts notes one at a time cannot
 * hand out colliding ids. A `curie` equal to what `header` derives is dropped
 * (it is recomputed on read); any other curie is kept verbatim in `extra`.
 */
export function edgeFrontmatterToTableRow(
	frontmatter: Record<string, unknown>,
	header?: MappingTableHeader,
): { row?: MappingTableRowFacts; error?: string } {
	for (const key of ['subject_id', 'predicate_id', 'object_id']) {
		if (typeof frontmatter[key] !== 'string' || !frontmatter[key]) return { error: `Mapping note is missing ${key}. Add it before converting to a table.` };
	}
	const fm = frontmatter as Record<string, unknown> & { subject_id: string; predicate_id: string; object_id: string };
	const row: MappingTableRowFacts = {
		subject_id: fm.subject_id, predicate_id: fm.predicate_id, object_id: fm.object_id,
	};
	const routed = new Set(['subject_id', 'predicate_id', 'object_id']);
	if (fm.curie !== undefined && fm.curie === derivedEdgeCurie(row, header)) routed.add('curie');
	for (const key of STRINGS) {
		if (key === 'row_id' || key === 'subject_id' || key === 'predicate_id' || key === 'object_id' || key === 'confidence') continue;
		// Empty or non-string YAML values cannot survive a TSV string cell.
		if (typeof fm[key] === 'string' && fm[key] !== '') {
			(row as unknown as Record<string, unknown>)[key] = fm[key];
			routed.add(key);
		}
	}
	if (typeof fm.sssom_confidence === 'string' && fm.sssom_confidence !== '') {
		row.confidence = fm.sssom_confidence;
		routed.add('sssom_confidence');
	}
	const notes: Record<string, string> = {};
	const extra: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fm)) {
		if (key === '_crosswalker' || key === 'title' || key === 'tags' || routed.has(key)) continue;
		if (key.includes('notes') && typeof value === 'string' && value !== '') notes[key] = value;
		else extra[key] = value;
	}
	if (Object.keys(notes).length) row.notes = notes;
	if (Object.keys(extra).length) row.extra = extra;
	return { row };
}

/**
 * Engine-owned _crosswalker stamp is deliberately not reconstructed here; the
 * reader adds the header's block. The edge `curie` is: a kept `extra.curie`
 * wins, else it is derived from the header's pinned import set, so a table row
 * answers to the same identity its note form would.
 */
export function tableRowToEdgeFrontmatter(row: MappingTableRow, header: MappingTableHeader): Record<string, unknown> {
	const fm: Record<string, unknown> = {
		title: `${row.subject_id} -> ${row.object_id}`,
		...(header.tags !== undefined ? { tags: header.tags } : {}),
	};
	for (const key of STRINGS) {
		if (key === 'row_id' || key === 'confidence') continue;
		const value = row[key];
		if (value !== undefined) fm[key] = value;
	}
	if (row.confidence !== undefined) fm.sssom_confidence = row.confidence;
	if (header.source_framework !== undefined) fm.source_framework = header.source_framework;
	if (header.target_framework !== undefined) fm.target_framework = header.target_framework;
	const curie = derivedEdgeCurie(row, header);
	if (curie !== undefined) fm.curie = curie;
	return { ...fm, ...row.notes, ...row.extra };
}
