/**
 * mapping-table-reader.ts — find and read table-form mapping sets in a vault.
 *
 * Every edge consumer walks markdown files, and a table-form set has none, so
 * without one shared reader each consumer would either miss table sets entirely
 * or rebuild edge frontmatter its own way and drift from the note form. This is
 * the one adapter: consumers call `tableRowsAsEdgeRecords` and never assemble
 * frontmatter from table rows themselves.
 *
 * Discovery is by suffix only, never by folder. A set's recorded destination is
 * a hint, not authority: a user can move the file, and a folder rule would then
 * silently lose the set.
 */

import type { App, TFile } from 'obsidian';
import { normalizeFolderSetting } from '../settings/folder-settings';
import {
	MAPPING_TABLE_FORMAT,
	parseMappingTable,
	tableRowToEdgeFrontmatter,
	type MappingTableHeader,
	type MappingTableRow,
} from './mapping-table';

/** The one file suffix that marks a Crosswalker mapping table. */
export const MAPPING_TABLE_SUFFIX = '.mapping-table.tsv';

export interface MappingTableFile {
	path: string;
	header: MappingTableHeader;
	rows: MappingTableRow[];
	errors: string[];
	warnings: string[];
}

function isWithinBase(path: string, basePath?: string): boolean {
	if (basePath === undefined) return true;
	const base = normalizeFolderSetting(basePath);
	if (!base) return true;
	return path.startsWith(`${base}/`);
}

/**
 * Read every mapping table under `basePath` (the whole vault when omitted),
 * sorted by path. Never throws for one bad file: an unreadable or malformed
 * table comes back with `rows: []` and its errors, and the caller decides.
 * Failure mode prevented: one hand-edited table hiding every other set.
 */
export async function readMappingTables(app: App, basePath?: string): Promise<MappingTableFile[]> {
	const files = app.vault.getFiles()
		.filter((file: TFile) => file.path.endsWith(MAPPING_TABLE_SUFFIX) && isWithinBase(file.path, basePath))
		.sort((a: TFile, b: TFile) => a.path.localeCompare(b.path));
	const tables: MappingTableFile[] = [];
	for (const file of files) {
		let content: string;
		try {
			content = await app.vault.read(file);
		} catch {
			tables.push({
				path: file.path,
				header: { crosswalker_format: MAPPING_TABLE_FORMAT },
				rows: [],
				errors: [`Could not read mapping table ${file.path}. Check the file still exists and is not open in another program, then try again.`],
				warnings: [],
			});
			continue;
		}
		const parsed = parseMappingTable(content);
		// The header is a table set's only provenance record. Without it the rows
		// would reach consumers as edges owned by no import set, so refuse here.
		// The codec still parses such a file; only the vault reader refuses it.
		if (!parsed.errors.length && parsed.header.crosswalker_provenance === undefined) {
			parsed.errors.push(`Mapping table ${file.path} has no Crosswalker provenance header, so its import set is unknown. Convert the set again instead of creating the table by hand.`);
		}
		tables.push({
			path: file.path,
			header: parsed.header,
			// A file with errors contributes no rows: a partly read set is worse
			// than a set the caller knows it could not read.
			rows: parsed.errors.length ? [] : parsed.rows,
			errors: parsed.errors,
			warnings: parsed.warnings,
		});
	}
	return tables;
}

/**
 * Each row as the edge record a note would give a consumer: the address is
 * `<table path>#<row_id>` (stable while the file stays put, and never a real
 * note path) and the frontmatter carries the header's provenance block as its
 * `_crosswalker`.
 */
export function tableRowsAsEdgeRecords(table: MappingTableFile): Array<{ source_path: string; frontmatter: Record<string, unknown> }> {
	return table.rows.map((row) => ({
		source_path: `${table.path}#${row.row_id}`,
		frontmatter: {
			...tableRowToEdgeFrontmatter(row, table.header),
			_crosswalker: table.header.crosswalker_provenance,
		},
	}));
}
