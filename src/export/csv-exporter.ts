/**
 * csv-exporter.ts — v0.1.7 exporters: concept notes → plain CSV.
 *
 * The humble universal export: no framework-specific vocabulary, just the
 * managed fields (curie, title, parent, children, aliases, tags) plus every
 * other domain-specific frontmatter key the recipe wrote (control_id,
 * control_family, taxon_id, ... — spec/tier1.schema.json's concept-note
 * shape is `additionalProperties: true` precisely so recipes can add these).
 * Reuses `Papa.unparse` (papaparse is already a dependency, per the
 * "NO new dependencies" constraint) so quoting/escaping of commas, quotes,
 * and embedded newlines is handled by the same battle-tested code the CSV
 * import path (src/import/parsers/csv-parser.ts) parses with.
 */

import Papa from 'papaparse';
import type { App } from 'obsidian';
import { readVaultTree, type ConceptRow, type SkippedNote } from './vault-reader';

/** Fixed leading columns, always present in this order regardless of what a given vault contains. */
const LEADING_COLUMNS = ['curie', 'title', 'parent', 'children', 'aliases', 'tags'] as const;

/** Keys already surfaced via the leading columns (or not appropriate as a flat CSV cell) — excluded from auto-detected extra columns. */
const RESERVED_KEYS = new Set<string>([...LEADING_COLUMNS, '_crosswalker', 'kind']);

export interface CsvExportOptions {
	/** Explicit column list/order. Default: LEADING_COLUMNS + every other frontmatter key seen, sorted alphabetically. */
	columns?: string[];
}

export interface CsvExportResult {
	csv: string;
	rowCount: number;
	columns: string[];
	skipped: SkippedNote[];
}

/** Array values join with `|` (readable, and distinct from CSV's own `,` delimiter so Papa's quoting stays predictable). Scalars stringify as-is. */
function joinValue(v: unknown): string {
	if (v === undefined || v === null) return '';
	if (Array.isArray(v)) return v.map((x) => String(x)).join('|');
	return String(v);
}

/**
 * AM-34 (2026-09-01). The BASE form of a note's curie — set-qualification undone.
 *
 * Set-qualification (`endpoint-v1` -> `set-qualified-v1`, AM-13) puts the import
 * set's id inside the prefix so two releases of one framework occupy different
 * identity spaces. It is a uniform re-prefixing, and every note it touched
 * records the scheme and the id that produced it, so it inverts exactly.
 *
 * Export inverts it. Failure mode prevented: Crosswalker's own export becoming
 * un-importable. The exported `curie` column is what a re-import reads as a
 * declared identity, and a declared identity carrying a set id is (a) not
 * something the source ever asserted and (b) meaningless in any other vault,
 * where that set does not exist. Writing the base form back is what makes
 * export -> import a round-trip identity rather than a refusal.
 *
 * Anything that does not match the recorded transform is returned untouched: a
 * guess about someone else's identifier is worse than leaving it alone.
 */
export function baseFormCurie(curie: string, frontmatter: Record<string, unknown>): string {
	const provenance = frontmatter._crosswalker;
	if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return curie;
	const block = (provenance as Record<string, unknown>).import_set;
	if (!block || typeof block !== 'object' || Array.isArray(block)) return curie;
	const set = block as Record<string, unknown>;
	if (set.scheme !== 'set-qualified-v1') return curie;
	const id = typeof set.id === 'string' ? set.id.trim() : '';
	if (id === '') return curie;
	const colon = curie.indexOf(':');
	if (colon <= 0) return curie;
	const prefix = curie.slice(0, colon);
	const suffix = `-${id}`;
	if (!prefix.endsWith(suffix) || prefix.length === suffix.length) return curie;
	return `${prefix.slice(0, prefix.length - suffix.length)}${curie.slice(colon)}`;
}

function cellValue(col: string, row: ConceptRow): string {
	switch (col) {
		case 'curie':
			// AM-34: the base form, so a re-import of this file is accepted verbatim.
			return baseFormCurie(row.curie, row.frontmatter);
		case 'title':
			return row.title ?? '';
		case 'parent':
			return joinValue(row.parent);
		case 'children':
			return row.children.join('|');
		case 'aliases':
			return row.aliases.join('|');
		case 'tags':
			return row.tags.join('|');
		default:
			return joinValue(row.frontmatter[col]);
	}
}

/**
 * Serialize a set of concept rows (already read from the vault, or
 * hand-assembled for a test) into a CSV string. Pure — no vault I/O. Rows are
 * re-sorted by path first so output is deterministic regardless of caller-
 * supplied order; column order is deterministic (LEADING_COLUMNS first, then
 * every other key seen, alphabetically) unless `options.columns` is given.
 */
export function conceptsToCsv(concepts: ConceptRow[], options: CsvExportOptions = {}): CsvExportResult {
	const sorted = [...concepts].sort((a, b) => a.path.localeCompare(b.path));

	let columns = options.columns;
	if (!columns) {
		const extra = new Set<string>();
		for (const row of sorted) {
			for (const key of Object.keys(row.frontmatter)) {
				if (!RESERVED_KEYS.has(key)) extra.add(key);
			}
		}
		columns = [...LEADING_COLUMNS, ...Array.from(extra).sort((a, b) => a.localeCompare(b))];
	}
	const finalColumns = columns;

	const rows = sorted.map((row) => {
		const record: Record<string, string> = {};
		for (const col of finalColumns) record[col] = cellValue(col, row);
		return record;
	});

	const csv = Papa.unparse(rows, { columns: finalColumns, newline: '\n' });
	return { csv, rowCount: rows.length, columns: finalColumns, skipped: [] };
}

/** Walk `rootPath` and export every concept note found under it as a CSV. */
export async function exportFolderAsCsv(
	app: App,
	rootPath: string,
	options: CsvExportOptions = {},
): Promise<CsvExportResult> {
	const tree = await readVaultTree(app, rootPath);
	const result = conceptsToCsv(tree.concepts, options);
	result.skipped.push(...tree.skipped);
	return result;
}
