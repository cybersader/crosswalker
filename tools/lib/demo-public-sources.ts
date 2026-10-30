import Papa from 'papaparse';
import type { SssomRow } from '../../src/import/sssom-parser';
import { depad80053 } from '../../src/import/stack/mapping-readers';

export function publicCsv(text: string): Record<string, string>[] {
	const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: 'greedy' });
	if (parsed.errors.length) throw new Error(`Invalid public demo CSV: ${parsed.errors[0].message}`);
	return parsed.data;
}

/** Each source row names exactly one technique at one of the sparse levels. */
export function d3fendNames(catalog: readonly Record<string, string>[]): Map<string, string> {
	const names = new Map<string, string>();
	const ids = new Set<string>();
	for (const row of catalog) {
		const cells = ['D3FEND Technique', 'D3FEND Technique Level 0', 'D3FEND Technique Level 1']
			.map((key) => row[key]?.trim()).filter(Boolean);
		const name = cells.join('');
		const id = row.ID?.trim();
		if (!id || cells.length !== 1 || names.has(name) || ids.has(id)) throw new Error('D3FEND catalog needs unique technique names and ids, with one name per row.');
		names.set(name, id);
		ids.add(id);
	}
	return names;
}

const curated = (subject: string, predicate: string, object: string): SssomRow => ({
	subject_id: subject, predicate_id: predicate, object_id: object,
	mapping_justification: 'semapv:ManualMappingCuration',
});

/** The table reads Control -> Relation -> Defensive Technique. Keep that direction. */
export function d3fendControlMappings(rows: readonly Record<string, string>[], names: ReadonlyMap<string, string>): SssomRow[] {
	return rows.map((row) => {
		const id = names.get(row.Technique?.trim());
		if (!id || !row.Control?.trim()) throw new Error('D3FEND control mapping names an unknown technique or an empty control.');
		// The publisher's table does not define which endpoint broader/narrower
		// describes. Do not assert a direction; retain the exact source word.
		return { ...curated(`nist-800-53:${depad80053(row.Control)}`, 'skos:relatedMatch', `mitre-d3fend:${id}`),
			source_relation: row.Relation?.trim() ?? '' };
	});
}

/** ATT&CK mitigation ids stay M ids. A blank cell is explicitly no published mapping. */
export function d3fendAttackMappings(rows: readonly Record<string, string>[]): { rows: SssomRow[]; emptyRows: number } {
	let emptyRows = 0;
	const mapped = rows.flatMap((row) => {
		const ids = [...(row['Related D3FEND Techniques'] ?? '').matchAll(/\bD3-[A-Z0-9]+\b/g)].map((match) => match[0]);
		if (!ids.length) { emptyRows++; return []; }
		const attack = row['ATT&CK ID']?.trim();
		if (!/^M\d{4}$/.test(attack)) throw new Error('Expected an ATT&CK mitigation id in the D3FEND mapping table.');
		return [...new Set(ids)].map((id) => curated(`mitre-attack:${attack}`, 'skos:relatedMatch', `mitre-d3fend:${id}`));
	});
	return { rows: mapped, emptyRows };
}

export function mappingPairDiff(existing: readonly SssomRow[], incoming: readonly SssomRow[]): { existingPairs: number; incomingPairs: number; added: number; removed: number; strengthRows: number } {
	const pairs = (rows: readonly SssomRow[]) => new Set(rows.map((row) => JSON.stringify([row.subject_id, row.object_id])));
	const before = pairs(existing);
	const after = pairs(incoming);
	return { existingPairs: before.size, incomingPairs: after.size, added: [...after].filter((p) => !before.has(p)).length,
		removed: [...before].filter((p) => !after.has(p)).length, strengthRows: incoming.filter((row) => row.confidence !== undefined).length };
}

/** Source-row accounting, separate from importer deduplication and generated note counts. */
export function mappingResolution(rows: readonly SssomRow[], identities: ReadonlySet<string>) {
	const missing = (key: 'subject_id' | 'object_id') => [...new Set(rows.filter((r) => !identities.has(r[key])).map((r) => r[key]))].sort();
	return { rows: rows.length, subjectResolved: rows.filter((r) => identities.has(r.subject_id)).length,
		objectResolved: rows.filter((r) => identities.has(r.object_id)).length,
		bothResolved: rows.filter((r) => identities.has(r.subject_id) && identities.has(r.object_id)).length,
		missingSubjects: missing('subject_id'), missingObjects: missing('object_id') };
}
