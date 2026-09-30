/**
 * mapping-table-writer.ts — write one table-form mapping set to the vault.
 *
 * Slice 3 of the mapping table form (2026-09-30). The only writer of a
 * `*.mapping-table.tsv`: the SSSOM importer's table branch builds a plan and
 * hands it here. A refresh keeps the review columns a reviewer typed into the
 * file by carrying them forward by `row_id` (`mergeReviewColumns`).
 *
 * Durability: a write is `vault.create` or `vault.modify`, then a read-back
 * compared byte for byte. Temp-and-rename is deliberately not used here: it is
 * reserved for the conversion job, where interruption is the normal case. A
 * table that fails verification is still discovered (slice 2) and is repaired
 * by the next refresh, and the thrown error tells the user so.
 */

import { TFile, normalizePath, type App } from 'obsidian';
import { createFolderEnsurer } from '../generation/generation-engine';
import { serializeMappingTable, type MappingTableHeader, type MappingTableRow } from './mapping-table';
import { MAPPING_TABLE_SUFFIX } from './mapping-table-reader';

export interface MappingTableWritePlan {
	/** `<folder>/<stem>.mapping-table.tsv` */
	path: string;
	/** `crosswalker_provenance` set, `import_set` equal to its block's id. */
	header: MappingTableHeader;
	/** Ids already assigned (`assignMappingRowIds`). */
	rows: MappingTableRow[];
}

/** The review columns a person owns. Everything else is rebuilt from the source. */
const REVIEW_COLUMNS = ['review_status', 'reviewer', 'notes'] as const;

function slugStem(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Where a new set's table goes: the same folder its notes would have used, so
 * the set's recorded `destination` still names where it lives. The stem is the
 * slug of `<source>-to-<target>` when both frameworks are known, else
 * `mappings`.
 *
 * `importSetId` qualifies the stem (`<stem>.<import-set-id>`). The caller asks
 * for it only when the default path is already taken by a file that is not
 * this set's table.
 */
export function mappingTablePath(folder: string, sourceFramework?: string, targetFramework?: string, importSetId?: string): string {
	const source = sourceFramework?.trim();
	const target = targetFramework?.trim();
	const pairStem = (source && target ? slugStem(`${source}-to-${target}`) : '') || 'mappings';
	const qualifier = importSetId?.trim() ? slugStem(importSetId) : '';
	const stem = qualifier ? `${pairStem}.${qualifier}` : pairStem;
	const base = (folder ?? '').trim() ? normalizePath(folder) : '';
	return base ? `${base}/${stem}${MAPPING_TABLE_SUFFIX}` : `${stem}${MAPPING_TABLE_SUFFIX}`;
}

/**
 * Carry the review columns of `existing` onto the matching `next` rows, by
 * `row_id`. Existing wins for `review_status`, `reviewer` and `notes` only;
 * every managed column comes from `next`, because the source is the authority
 * for what a mapping asserts.
 *
 * Failure mode prevented: a refresh wiping every review a person recorded in
 * the file, the table-form version of dropping `user_preserve` fields.
 *
 * `carried` counts `next` rows that took at least one review value from an
 * existing row; a matched row with no review recorded is not counted. `dropped`
 * counts existing row ids the new source no longer produces; those rows, and
 * any review on them, leave the file.
 */
export function mergeReviewColumns(
	next: MappingTableRow[],
	existing: MappingTableRow[],
): { rows: MappingTableRow[]; carried: number; dropped: number } {
	const byId = new Map(existing.map((row) => [row.row_id, row]));
	const nextIds = new Set(next.map((row) => row.row_id));
	let carried = 0;
	const rows = next.map((row) => {
		const previous = byId.get(row.row_id);
		if (!previous) return row;
		const merged: MappingTableRow = { ...row };
		for (const column of REVIEW_COLUMNS) delete merged[column];
		if (previous.review_status !== undefined) merged.review_status = previous.review_status;
		if (previous.reviewer !== undefined) merged.reviewer = previous.reviewer;
		if (previous.notes !== undefined) merged.notes = { ...previous.notes };
		if (REVIEW_COLUMNS.some((column) => previous[column] !== undefined)) carried++;
		return merged;
	});
	let dropped = 0;
	for (const id of byId.keys()) if (!nextIds.has(id)) dropped++;
	return { rows, carried, dropped };
}

/** UTF-8 byte length without TextEncoder, which some test runtimes lack. */
function utf8Length(text: string): number {
	let bytes = 0;
	for (const char of text) {
		const code = char.codePointAt(0)!;
		bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
	}
	return bytes;
}

function parentOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * Serialize and write one mapping table, then read it back and compare.
 *
 * Failure mode prevented: a sync tool (or any other writer) rewriting the file
 * while Crosswalker writes it, leaving a table that does not hold what the
 * import reported. The read-back mismatch is thrown, never swallowed, so a
 * half-written file is never reported as a success.
 */
export async function writeMappingTable(app: App, plan: MappingTableWritePlan): Promise<{ bytes: number; created: boolean }> {
	const path = normalizePath(plan.path);
	const content = serializeMappingTable(plan.header, plan.rows);
	const parent = parentOf(path);
	if (parent) await createFolderEnsurer(app)(parent);
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing && !(existing instanceof TFile)) {
		throw new Error(`Could not write the mapping table because a folder already exists at ${path}. Rename or move that folder, then run the import again.`);
	}
	let file: TFile;
	let created: boolean;
	if (existing) {
		await app.vault.modify(existing, content);
		file = existing;
		created = false;
	} else {
		file = await app.vault.create(path, content);
		created = true;
	}
	let readBack: string | undefined;
	try {
		readBack = await app.vault.read(file);
	} catch {
		readBack = undefined;
	}
	if (readBack !== content) {
		throw new Error(`Could not verify the mapping table after writing ${path}. Check the folder is writable and not synced by another tool, then run the import again.`);
	}
	return { bytes: utf8Length(content), created };
}
