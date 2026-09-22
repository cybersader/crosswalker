/**
 * table-peek.ts: the header-only view of one table that every source parser can
 * produce cheaply and the vault scan consumes (spec 2026-09-21 §3.4).
 *
 * A leaf module on purpose: parsers (csv, xlsx, json) import it to build peeks,
 * and `vault-source-scan.ts` imports it to score them, so neither layer depends
 * on the other.
 */

/** How many leading rows a peek reads. Header probing stays inside this window. */
export const PEEK_ROWS = 12;

/**
 * One table's first rows with the header left uninterpreted.
 * `table` is the sheet name for a workbook, '' for CSV/TSV, and the iterator
 * path (for example `$.objects[*]`) for a JSON record list.
 */
export interface TablePeek {
	table: string;
	rows: string[][];
}
