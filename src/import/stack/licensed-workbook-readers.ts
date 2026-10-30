import * as XLSX from 'xlsx';
import type { SssomRow } from '../sssom-parser';
import { depad80053, olirRowsToSssom } from './mapping-readers';

type Row = Record<string, string>;
const clean = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();

/** A selected publisher table. Read displayed cell values, never numeric ids. */
export function workbookTable(workbook: XLSX.WorkBook, name: string, required: readonly string[], preserveCellLines = false): Row[] {
	const original = workbook.Sheets[name];
	if (!original?.['!ref']) throw new Error(`Missing worksheet ${name}. Check the selected workbook release.`);
	// Merged endpoint cells repeat a declared value, unlike genuinely blank
	// endpoints. Expand only explicit merges; never guess a fill-down rule.
	const sheet = { ...original };
	for (const merge of original['!merges'] ?? []) {
		const cell = original[XLSX.utils.encode_cell(merge.s)];
		if (!cell) continue;
		for (let r = merge.s.r; r <= merge.e.r; r++) for (let c = merge.s.c; c <= merge.e.c; c++) {
			const address = XLSX.utils.encode_cell({ r, c });
			if (!sheet[address] || sheet[address].v === '' || sheet[address].v == null) sheet[address] = cell;
		}
	}
	const area = XLSX.utils.decode_range(sheet['!ref']!);
	const preview = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '', blankrows: true,
		range: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.min(area.e.r, 49), c: area.e.c } }) });
	const index = preview.findIndex((row) => required.every((key) => row.some((cell) => clean(cell) === key)));
	if (index < 0) throw new Error(`Missing header columns in ${name}. Check the documented workbook binding.`);
	return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { range: index, raw: false, defval: '', blankrows: false })
		.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [clean(key), preserveCellLines ? String(value ?? '').replace(/\r\n?/g, '\n').trim() : clean(value)])));
}

/** Catalog tables put the other framework first; reuse OLIR predicate direction. */
export function tabularMappings(rows: readonly Row[], otherColumn: string, otherOntology: string, subjectColumn = 'Profile Id', subjectOntology = 'cri-profile'): SssomRow[] {
	return olirRowsToSssom(rows, {
		subjectOntology, objectOntology: otherOntology, subjectColumn: otherColumn, objectColumn: subjectColumn,
		reverse: true, ...(otherOntology === 'nist-800-53' ? { depad: 'subject' as const } : {}),
	});
}

/** Cross-sheet enrichment is a join, not a change to the recipe grammar. */
export function subjectTags(rows: readonly Row[], list: readonly Row[]): { tags: Map<string, string[]>; unknown: number } {
	const allowed = new Set(list.map((row) => clean(row['CRI Profile Subject Tag']).replace(/^#/, '')));
	const tags = new Map<string, Set<string>>();
	let current = '';
	let unknown = 0;
	for (const row of rows) {
		if (row['CRI Profile Subject Tags']) current = clean(row['CRI Profile Subject Tags']).replace(/^#/, '');
		const id = row['Profile Id'];
		if (!id || !current) continue;
		// The per-statement sheet is authoritative. A stale tag-list sheet
		// must not silently strip tags that the publisher assigned to a note.
		if (!allowed.has(current)) unknown++;
		const slug = current.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
			.replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
		if (!slug) { unknown++; continue; }
		const found = tags.get(id) ?? new Set<string>();
		found.add(`cri/subject/${slug}`);
		tags.set(id, found);
	}
	return { tags: new Map(Array.from(tags, ([id, values]) => [id, Array.from(values).sort()])), unknown };
}

/** Formatting only. Never infer an identifier migration between releases. */
export function normalizeMappingId(curie: string): string {
	const index = curie.indexOf(':');
	const prefix = curie.slice(0, index);
	const local = curie.slice(index + 1).trim();
	const normalized = prefix === 'nist-800-53' ? depad80053(local.toUpperCase().replace(/\s+/g, ''))
		: prefix === 'nist-csf-2' ? local.replace(/-([0-9])$/, '-0$1') : local;
	return `${prefix}:${normalized}`;
}

/** Each dropped assertion is counted once, including the both-missing case. */
export function resolveMappings(rows: readonly SssomRow[], present: ReadonlySet<string>): { rows: SssomRow[]; dropped: { subject: number; object: number; both: number } } {
	const dropped = { subject: 0, object: 0, both: 0 };
	const resolved = rows.flatMap((row): SssomRow[] => {
		const subject_id = normalizeMappingId(row.subject_id);
		const object_id = normalizeMappingId(row.object_id);
		const subject = present.has(subject_id);
		const object = present.has(object_id);
		if (subject && object) return [{ ...row, subject_id, object_id }];
		dropped[!subject && !object ? 'both' : !subject ? 'subject' : 'object']++;
		return [];
	});
	return { rows: resolved, dropped };
}

/** Compare semantic assertions before endpoint filtering, not just file sizes. */
export function compareMappings(left: readonly SssomRow[], right: readonly SssomRow[]): { identical: boolean; overlap: number; unique: SssomRow[] } {
	const key = (row: SssomRow): string => JSON.stringify([normalizeMappingId(row.subject_id), row.predicate_id, normalizeMappingId(row.object_id), row.mapping_justification, row.confidence ?? null]);
	const a = new Set(left.map(key));
	const b = new Set(right.map(key));
	return { identical: a.size === b.size && Array.from(a).every((id) => b.has(id)), overlap: Array.from(b).filter((id) => a.has(id)).length,
		unique: right.filter((row) => !a.has(key(row))) };
}
