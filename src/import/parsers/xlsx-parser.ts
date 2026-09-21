/**
 * xlsx-parser.ts — Excel workbook parsing for the import wizard.
 *
 * UI counterpart of the headless harness's XLSX reader (tools/generate-fixtures.ts)
 * — same contracts, one behavior:
 *   - `raw: false` formatted-text fidelity: Excel stores CIS safeguard "4.10" as
 *     the NUMBER 4.1 with display text "4.10"; String(4.1) silently collides it
 *     with safeguard 4.1. Cells read as what Excel displays.
 *   - header-key normalization: workbooks bake `\r\n` into header cells
 *     ("Secure Controls Framework (SCF)\r\nControl Description") — collapse
 *     internal whitespace + trim so columns are addressable.
 *   - `headerRow` skips banner/preamble rows above the real headers.
 */

import * as XLSX from 'xlsx';
import { computeSourceByteDigest } from '../../generation/hash';
import { ParsedData } from '../../types/config';
import { PEEK_ROWS, type TablePeek } from './table-peek';

export interface XLSXParseOptions {
	/** Sheet to parse — name, or 0-based index. Defaults to the first sheet. */
	sheet?: string | number;
	/** 0-based row index to treat as the header row (skips banner rows above). */
	headerRow?: number;
}

/** Collapse internal whitespace + trim — the shared header-key normalization. */
const normKey = (k: string): string => k.replace(/\s+/g, ' ').trim();

/** Decode from a disposable copy so the XLSX library never receives owned bytes. */
function readWorkbookBytes(sourceBytes: Uint8Array): XLSX.WorkBook {
	return XLSX.read(sourceBytes.slice(), { type: 'array' });
}

/** Read the first rows of every sheet without assigning a header. */
export function peekXLSXBytes(bytes: Uint8Array, rows = PEEK_ROWS): TablePeek[] {
	const workbook = readWorkbookBytes(bytes);
	const limit = Math.max(0, Math.floor(rows));
	return workbook.SheetNames.map((table) => {
		const sheet = workbook.Sheets[table];
		const reference = sheet?.['!ref'];
		if (!sheet || !reference || limit === 0) return { table, rows: [] };
		const used = XLSX.utils.decode_range(reference);
		const range = {
			s: { r: 0, c: used.s.c },
			e: { r: Math.min(used.e.r, limit - 1), c: used.e.c },
		};
		const peeked = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
			header: 1,
			range,
			defval: '',
			raw: false,
			blankrows: true,
		});
		return {
			table,
			rows: peeked.map((row) => row.map((cell) => String(cell ?? '').trim())),
		};
	});
}

async function readWorkbook(file: File): Promise<XLSX.WorkBook> {
	const captured = new Uint8Array(await file.arrayBuffer());
	return readWorkbookBytes(captured);
}

/** List sheet names so the wizard can offer a picker before parsing. */
export async function listXLSXSheets(file: File): Promise<string[]> {
	const wb = await readWorkbook(file);
	return wb.SheetNames;
}

/**
 * Parse one sheet of an Excel workbook into ParsedData (eager rows).
 * Cells arrive as display text (strings); empty cells as ''.
 */
export async function parseXLSXFile(file: File, options: XLSXParseOptions = {}): Promise<ParsedData> {
	// One source read per parse. Own a private copy for the life of the returned
	// join accessor: File bytes can change between reads even when size/mtime do
	// not, and a decoder may mutate the input it receives.
	const sourceBytes = Uint8Array.from(new Uint8Array(await file.arrayBuffer()));
	const sourceByteDigest = computeSourceByteDigest(sourceBytes);
	const wb = readWorkbookBytes(sourceBytes);

	let sheetName: string;
	if (typeof options.sheet === 'number') {
		sheetName = wb.SheetNames[options.sheet];
		if (!sheetName) {
			throw new Error(`Sheet index ${options.sheet} out of range — workbook has ${wb.SheetNames.length} sheet(s): ${wb.SheetNames.join(', ')}`);
		}
	} else if (typeof options.sheet === 'string' && options.sheet !== '') {
		if (!wb.SheetNames.includes(options.sheet)) {
			throw new Error(`Sheet "${options.sheet}" not found. Available sheets: ${wb.SheetNames.join(', ')}`);
		}
		sheetName = options.sheet;
	} else {
		sheetName = wb.SheetNames[0];
	}
	if (!sheetName) throw new Error('Workbook contains no sheets.');

	const rows = readSheetRows(wb, sheetName, options.headerRow ?? 0);

	// Column order from the first row's keys; union in any stragglers (sparse
	// sheets can omit trailing empty cells per row).
	const columns: string[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		for (const k of Object.keys(row)) {
			if (!seen.has(k)) {
				seen.add(k);
				columns.push(k);
			}
		}
	}

	return {
		columns,
		rows,
		rowCount: rows.length,
		sheetName,
		sourceByteDigest,
		// Ch 46 source contract 4.2: `source.joins` locates a secondary
		// collection in ANOTHER SHEET OF THESE SAME CAPTURED WORKBOOK BYTES. The
		// handle re-decodes only when a join is declared; it retains the private
		// source snapshot, not the decoded workbook or an externally mutable File.
		container: {
			kind: 'workbook',
			sheetNames: [...wb.SheetNames],
			readSheet: async (sheet: string, headerRow: number) => {
				const secondaryWorkbook = readWorkbookBytes(sourceBytes);
				return readSheetRows(secondaryWorkbook, sheet, headerRow);
			},
		},
	};
}

/**
 * One sheet to rows, with the workbook contract this file exists to hold:
 * `raw: false` formatted-text fidelity and header-key normalization. Shared by
 * the primary parse and by a `source.joins` secondary read so both sides of a
 * join see cells the same way.
 */
function readSheetRows(wb: XLSX.WorkBook, sheetName: string, headerRow: number): Record<string, string>[] {
	const ws = wb.Sheets[sheetName];
	if (!ws) throw new Error(`Sheet "${sheetName}" not found. Available sheets: ${wb.SheetNames.join(', ')}`);
	const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
		range: headerRow,
		defval: '',
		blankrows: false,
		raw: false, // formatted text — see header comment
	});
	return rawRows.map((r) => {
		const row: Record<string, string> = {};
		for (const [k, val] of Object.entries(r)) {
			row[normKey(k)] = val === null || val === undefined ? '' : String(val).trim();
		}
		return row;
	});
}
