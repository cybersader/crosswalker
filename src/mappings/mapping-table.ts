/**
 * Crosswalker mapping-table ledger. Its predicate_id is STRM, not the SKOS
 * predicate a generic SSSOM reader expects; standards exports use the SSSOM
 * exporter instead. This codec does no vault I/O or provenance stamping.
 */
import Papa from 'papaparse';
import { sha256Hex } from '../generation/hash';

export const MAPPING_TABLE_FORMAT = 'crosswalker-mapping-table-v1';

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
	'source_framework', 'target_framework', 'tags',
] as const;
const COLUMNS = [
	'row_id', 'subject_id', 'predicate_id', 'object_id', 'sssom_predicate',
	'predicate_modifier', 'mapping_justification', 'confidence', 'subject_label',
	'object_label', 'subject_note', 'object_note', 'mapping_provider',
	'mapping_set_id', 'review_status', 'reviewer', 'crosswalker_notes',
	'crosswalker_extra',
] as const;
const REQUIRED = ['row_id', 'subject_id', 'predicate_id', 'object_id'] as const;
const STRINGS = COLUMNS.filter((column) => column !== 'crosswalker_notes' && column !== 'crosswalker_extra') as Exclude<typeof COLUMNS[number], 'crosswalker_notes' | 'crosswalker_extra'>[];

/** Identity follows the edge's own facts, never its mutable vault address. */
export function mappingRowId(subject_id: string, predicate_id: string, object_id: string, predicate_modifier?: 'NOT'): string {
	return `m-${sha256Hex([subject_id, predicate_id, object_id, predicate_modifier ?? ''].join('\u0000')).slice(0, 16)}`;
}

export function serializeMappingTable(header: MappingTableHeader, rows: MappingTableRow[]): string {
	// A four-fact id cannot distinguish occurrence-distinct notes. Refuse the
	// conversion rather than emit a ledger whose parser would drop later notes.
	const seen = new Set<string>();
	for (const row of rows) {
		if (seen.has(row.row_id)) throw new Error(`Duplicate mapping table row_id: ${row.row_id}. Keep these mappings as notes until each occurrence has a distinct row identity.`);
		seen.add(row.row_id);
	}
	const lines = HEADER_KEYS.flatMap((key) => {
		const value = header[key];
		return value === undefined ? [] : [`# ${key}: ${JSON.stringify(key === 'tags' ? JSON.stringify(value) : value)}`];
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

/** Refuse unknown ledgers instead of treating STRM predicate_id as SKOS. */
export function parseMappingTable(tsv: string): { header: MappingTableHeader; rows: MappingTableRow[]; errors: string[]; warnings: string[] } {
	const errors: string[] = [];
	const warnings: string[] = [];
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
				} else if (match[1] === 'crosswalker_format') {
					formatSeen = value === MAPPING_TABLE_FORMAT;
				} else {
					(header as unknown as Record<string, unknown>)[match[1]] = value;
				}
			} catch {
				errors.push(`Invalid mapping table header ${match[1]} on line ${lineNumber}. Fix its JSON-quoted value.`);
			}
		}
		offset = end === -1 ? tsv.length : end + 1;
	}
	if (!formatSeen) errors.push('This file is not a Crosswalker mapping table. Import it as a crosswalk mapping file instead.');
	// Do not split/rejoin the body: quoted cell data may contain literal CRLF.
	const parsed = Papa.parse<Record<string, string>>(tsv.slice(offset), { header: true, delimiter: '\t', newline: '\n', skipEmptyLines: true });
	const columns = parsed.meta.fields ?? [];
	for (const key of REQUIRED) if (!columns.includes(key)) errors.push(`Missing required mapping table column: ${key}.`);
	for (const problem of parsed.errors) errors.push(`Invalid mapping table TSV near row ${(problem.row ?? 0) + 1}: ${problem.message}`);
	if (errors.length) return { header, rows: [], errors, warnings };
	const rows: MappingTableRow[] = [];
	const seen = new Set<string>();
	let skipped = 0;
	for (const [index, record] of parsed.data.entries()) {
		const rowNumber = index + 1;
		const missing = REQUIRED.filter((key) => typeof record[key] !== 'string' || !record[key]);
		if (missing.length) {
			errors.push(`Missing required mapping table value ${missing.join(', ')} on row ${rowNumber}. Fill these cells before importing that row.`);
			skipped++;
			continue;
		}
		const id = record.row_id;
		if (seen.has(id)) {
			errors.push(`Duplicate mapping table row_id: ${id}. Give each mapping a distinct row identity.`);
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
				errors.push(`Invalid JSON in ${column} on row ${rowNumber}. Fix this cell before importing that row.`);
				malformed = true;
			}
		}
		if (malformed) { skipped++; continue; }
		rows.push(result as unknown as MappingTableRow);
	}
	if (skipped) warnings.push(`Skipped ${skipped} mapping table row${skipped === 1 ? '' : 's'} with missing required values or malformed JSON.`);
	return { header, rows, errors, warnings };
}

/** Separate managed columns from user-owned fields without dropping unknown keys. */
export function edgeFrontmatterToTableRow(frontmatter: Record<string, unknown>): { row?: MappingTableRow; error?: string } {
	for (const key of ['subject_id', 'predicate_id', 'object_id']) {
		if (typeof frontmatter[key] !== 'string' || !frontmatter[key]) return { error: `Mapping note is missing ${key}. Add it before converting to a table.` };
	}
	const fm = frontmatter as Record<string, unknown> & { subject_id: string; predicate_id: string; object_id: string };
	const modifier = fm.predicate_modifier === 'NOT' ? 'NOT' : undefined;
	const row: MappingTableRow = {
		row_id: mappingRowId(fm.subject_id, fm.predicate_id, fm.object_id, modifier),
		subject_id: fm.subject_id, predicate_id: fm.predicate_id, object_id: fm.object_id,
	};
	const routed = new Set(['subject_id', 'predicate_id', 'object_id']);
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

/** Engine-owned _crosswalker stamp is deliberately not reconstructed here. */
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
	return { ...fm, ...row.notes, ...row.extra };
}
