import * as XLSX from 'xlsx';
import type { SssomRow } from '../sssom-parser';

/** Canonical NIST 800-53 local identifier, including enhancements and family ids. */
export function depad80053(id: string): string {
	return id.trim().replace(/(^|[^0-9])0+([0-9])/g, '$1$2');
}

const OLIR_PREDICATES: Record<string, string> = {
	equal: 'skos:exactMatch',
	'subset of': 'skos:broadMatch',
	'superset of': 'skos:narrowMatch',
	'intersects with': 'skos:relatedMatch',
};

export interface OlirOptions {
	subjectOntology: string;
	objectOntology: string;
	subjectColumn?: string;
	objectColumn?: string;
	depad?: 'subject' | 'object' | 'both';
	/** Publisher workbook focal direction is opposite the selected slot. */
	reverse?: boolean;
}

/** Convert normalized OLIR rows into the same SSSOM contract used by the mapping importer. */
export function olirRowsToSssom(rows: readonly Record<string, string>[], options: OlirOptions): SssomRow[] {
	const subjectColumn = options.subjectColumn ?? 'Focal Document Element';
	const objectColumn = options.objectColumn ?? 'Reference Document Element';
	return rows.flatMap((row): SssomRow[] => {
		const focal = row[subjectColumn]?.trim();
		const reference = row[objectColumn]?.trim();
		if (!focal || !reference) return [];
		const subject = options.depad === 'subject' || options.depad === 'both' ? depad80053(focal) : focal;
		const object = options.depad === 'object' || options.depad === 'both' ? depad80053(reference) : reference;
		const strength = row['Strength of Relationship (Optional)'] ?? row['Strength of Relationship'];
		const number = strength?.trim() ? Number(strength) : NaN;
		const predicate = OLIR_PREDICATES[row.Relationship?.trim().toLowerCase() ?? ''] ?? 'skos:relatedMatch';
		return [{
			subject_id: `${options.subjectOntology}:${options.reverse ? object : subject}`,
			predicate_id: options.reverse ? predicate === 'skos:broadMatch' ? 'skos:narrowMatch' :
				predicate === 'skos:narrowMatch' ? 'skos:broadMatch' : predicate : predicate,
			object_id: `${options.objectOntology}:${options.reverse ? subject : object}`,
			mapping_justification: 'semapv:ManualMappingCuration',
			...(Number.isFinite(number) ? { confidence: Math.max(0, Math.min(1, number / 10)) } : {}),
		}];
	});
}

export interface WorkbookMappingResult { rows: SssomRow[]; skipped: { sheet: string; reason: string }[]; included: string[] }

const MAX_MAPPING_HEADER_ROWS = 50;

/** A matching mapping table is defined by its endpoint headers, not a sheet name. */
export function readOlirWorkbookDetails(bytes: Uint8Array, options: OlirOptions, sheetNames?: readonly string[], headerRow = 0): WorkbookMappingResult {
	const workbook = XLSX.read(bytes.slice(), { type: 'array' });
	const rows: Record<string, string>[] = [];
	const skipped: WorkbookMappingResult['skipped'] = [];
	const included: string[] = [];
	const required = [options.subjectColumn ?? 'Focal Document Element', options.objectColumn ?? 'Reference Document Element'];
	const normalize = (header: unknown): string => String(header ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
	for (const name of workbook.SheetNames) {
		const sheet = workbook.Sheets[name];
		const area = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
		const preview = area ? XLSX.utils.sheet_to_json<unknown[]>(sheet, {
			header: 1, defval: '', blankrows: true, raw: false,
			range: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.min(area.e.r, MAX_MAPPING_HEADER_ROWS - 1), c: area.e.c } }),
		}) : [];
		const hinted = sheetNames?.includes(name) && headerRow >= 0 && headerRow < preview.length ? [headerRow] : [];
		const positions = [...hinted, ...Array.from({ length: preview.length }, (_, i) => i)];
		const rowIndex = positions.find((index) => required.every((key) => (preview[index] ?? []).some((column) => normalize(column) === normalize(key))));
		if (rowIndex === undefined) { skipped.push({ sheet: name, reason: `Missing ${required.join(' / ')} header columns` }); continue; }
		included.push(name);
		const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
			range: rowIndex, defval: '', blankrows: false, raw: false,
		});
		for (const item of raw) {
			const row: Record<string, string> = {};
			for (const [key, value] of Object.entries(item)) row[key.replace(/\s+/g, ' ').trim()] = String(value ?? '').trim();
			rows.push(row);
		}
	}
	return { rows: olirRowsToSssom(rows, options), skipped, included };
}

/** Compatibility for existing callers; all matching sheets are combined. */
export function readOlirWorkbook(bytes: Uint8Array, options: OlirOptions, sheetNames?: readonly string[], headerRow = 0): SssomRow[] {
	return readOlirWorkbookDetails(bytes, options, sheetNames, headerRow).rows;
}

export interface CtidResult { rows: SssomRow[]; attackVersion: string | null; duplicateRowsSkipped: number }

/** CTID Mappings Explorer JSON is a mapping_objects bundle, not ATT&CK STIX. */
export function readCtidJson(text: string, capabilityOntology = 'nist-800-53'): CtidResult {
	const root: unknown = JSON.parse(text);
	if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('Expected a CTID mapping bundle. Choose the Mappings Explorer JSON export.');
	const bundle = root as Record<string, unknown>;
	if (!Array.isArray(bundle.mapping_objects)) throw new Error('No mapping_objects array found. Choose the CTID Mappings Explorer JSON export, not STIX or a Navigator layer.');
	const metadata = bundle.metadata && typeof bundle.metadata === 'object' ? bundle.metadata as Record<string, unknown> : {};
	const rows: SssomRow[] = [];
	const seen = new Set<string>();
	let duplicateRowsSkipped = 0;
	for (const item of bundle.mapping_objects) {
		if (!item || typeof item !== 'object') continue;
		const entry = item as Record<string, unknown>;
		const control = String(entry.capability_id ?? '').trim().replace(new RegExp(`^${capabilityOntology}:`, 'i'), '');
		const technique = String(entry.attack_object_id ?? '').trim().replace(/^mitre-attack:/i, '');
		// Only 800-53 has a fixed id shape here; other capability frameworks keep their own local ids.
		const controlShape = capabilityOntology === 'nist-800-53' ? /^[A-Z]{2}(?:-\d+(?:\(\d+\))?)?$/i : /^\S+$/;
		if (!controlShape.test(control) || !/^T\d{4}(?:\.\d{3})?$/i.test(technique)) continue;
		// Compare every publisher field, not just endpoints: distinct evidence or
		// predicates must still reach the importer for its conflict handling.
		const fingerprint = JSON.stringify(Object.keys(entry).sort().map((key) => [key, entry[key]]));
		if (seen.has(fingerprint)) { duplicateRowsSkipped++; continue; }
		seen.add(fingerprint);
		const type = String(entry.mapping_type ?? '').trim().toLowerCase();
		rows.push({
			subject_id: `${capabilityOntology}:${capabilityOntology === 'nist-800-53' ? depad80053(control.toUpperCase()) : control}`,
			predicate_id: type === 'equivalent' ? 'skos:exactMatch' : 'skos:relatedMatch',
			object_id: `mitre-attack:${technique.toUpperCase()}`,
			mapping_justification: 'semapv:ManualMappingCuration',
		});
	}
	if (!rows.length) throw new Error('No valid control-to-technique mappings found. Check that this is the CTID JSON mapping export and try again.');
	return { rows, attackVersion: typeof metadata.attack_version === 'string' ? metadata.attack_version : null, duplicateRowsSkipped };
}

/** Encode generated mapping rows for the existing SSSOM parser, never for direct note writes. */
export function mappingRowsToTsv(rows: readonly SssomRow[], provider: string, source: string, target: string, release: string): string {
	const clean = (value: unknown) => String(value ?? '').replace(/[\t\r\n]/g, ' ');
	return [
		`# mapping_set_id: "urn:crosswalker:stack:${clean(source)}-to-${clean(target)}:${clean(release)}"`,
		`# mapping_provider: "${clean(provider)}"`,
		`# subject_source: "${clean(source)}"`,
		`# object_source: "${clean(target)}"`,
		'subject_id\tpredicate_id\tobject_id\tmapping_justification\tconfidence',
		...rows.map((row) => [row.subject_id, row.predicate_id, row.object_id, row.mapping_justification, row.confidence].map(clean).join('\t')),
	].join('\n') + '\n';
}
