/**
 * CSV Parser with Streaming Support
 *
 * Uses PapaParse for memory-efficient parsing of large CSV files.
 * Streaming mode processes rows one at a time without loading entire file into memory.
 */

import * as Papa from 'papaparse';
import { computeSourceByteDigest } from '../../generation/hash';
import { ParsedData, ColumnInfo } from '../../types/config';

export interface CSVParserOptions {
	delimiter?: string;       // Auto-detect if not specified
	headerRow?: number;       // Row number containing headers (1-based, default 1)
	encoding?: string;        // File encoding
	skipEmptyRows?: boolean;  // Skip rows that are entirely empty
	streaming?: boolean;      // Use streaming mode for large files
	chunkSize?: number;       // Rows per chunk in streaming mode
	onProgress?: (progress: ParseProgress) => void;  // Progress callback
}

export interface ParseProgress {
	rowsProcessed: number;
	bytesProcessed: number;
	estimatedTotal?: number;
	percentComplete?: number;
}

const DEFAULT_OPTIONS: CSVParserOptions = {
	headerRow: 1,
	encoding: 'utf-8',
	skipEmptyRows: true,
	streaming: false,
	chunkSize: 1000
};

/**
 * Parse CSV content into structured data
 *
 * For large files, use streaming: true to avoid memory issues.
 * The step callback will be called for each row.
 */
export async function parseCSV(
	content: string,
	options: CSVParserOptions = {}
): Promise<ParsedData> {
	const opts = { ...DEFAULT_OPTIONS, ...options };

	return new Promise((resolve, reject) => {
		const rows: Record<string, unknown>[] = [];
		let headers: string[] = [];
		let rowCount = 0;

		// PapaParse config - use type assertion due to complex overload types
		const config = {
			delimiter: opts.delimiter || '', // Auto-detect if empty
			header: true,
			skipEmptyLines: opts.skipEmptyRows,
			dynamicTyping: false, // Keep as strings, we handle type conversion
			transformHeader: (header: string) => header.trim(),

			step: opts.streaming ? (results: { data: unknown; meta: { cursor?: number } }) => {
				rowCount++;
				if (results.data) {
					rows.push(results.data as Record<string, unknown>);
				}

				// Report progress
				if (opts.onProgress && rowCount % (opts.chunkSize || 1000) === 0) {
					opts.onProgress({
						rowsProcessed: rowCount,
						bytesProcessed: 0, // Not available in string mode
					});
				}
			} : undefined,

			complete: (results: { data: unknown[]; meta: { fields?: string[] } }) => {
				// In non-streaming mode, results.data contains all rows
				if (!opts.streaming && results.data) {
					rows.push(...(results.data as Record<string, unknown>[]));
				}

				// Extract headers from first row's keys
				if (rows.length > 0) {
					headers = Object.keys(rows[0]);
				} else if (results.meta?.fields) {
					headers = results.meta.fields;
				}

				resolve({
					columns: headers,
					rows: rows,
					rowCount: rows.length,
					// A CSV file IS one collection: there is no second thing for
					// `source.joins` to name. Declared, not omitted, so the source
					// stage refuses a join with the format reason rather than a
					// vague "no container" (Ch 46 source contract 4.2).
					container: { kind: 'flat' },
				});
			},

			error: (error: { message: string }) => {
				reject(new Error(`CSV parsing error: ${error.message}`));
			}
		};

		Papa.parse(content, config as Papa.ParseConfig);
	});
}

/**
 * Parse a CSV file from one captured byte snapshot.
 *
 * `streaming: true` keeps PapaParse's row delivery step-driven, but the full
 * source snapshot is retained so parsing and provenance hash the same bytes.
 */
export async function parseCSVFile(
	file: File,
	options: CSVParserOptions = {}
): Promise<ParsedData> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	// Capture once so provenance hashes the exact bytes that are decoded and
	// parsed. The step-driven branch still bounds PapaParse's result handling,
	// but intentionally shares this one complete source snapshot.
	const sourceBytes = new Uint8Array(await file.arrayBuffer());
	const sourceByteDigest = computeSourceByteDigest(sourceBytes);
	const content = new TextDecoder(opts.encoding).decode(sourceBytes);

	return new Promise((resolve, reject) => {
		const rows: Record<string, unknown>[] = [];
		let headers: string[] = [];
		let rowCount = 0;
		const fileSize = sourceBytes.byteLength;

		// PapaParse config - use type assertion due to complex overload types
		// Note: Can't use worker: true with transformHeader (functions can't be cloned to workers)
		// So we trim headers manually after parsing instead
		const config = {
			delimiter: opts.delimiter || '',
			header: true,
			skipEmptyLines: opts.skipEmptyRows,
			dynamicTyping: false,

			step: opts.streaming ? (results: { data: unknown; meta: { cursor?: number } }) => {
				rowCount++;
				if (results.data) {
					rows.push(results.data as Record<string, unknown>);
				}

				// Report progress periodically
				if (opts.onProgress && rowCount % (opts.chunkSize || 1000) === 0) {
					const bytesProcessed = results.meta?.cursor || 0;
					opts.onProgress({
						rowsProcessed: rowCount,
						bytesProcessed: bytesProcessed,
						estimatedTotal: fileSize,
						percentComplete: fileSize > 0 ? Math.round((bytesProcessed / fileSize) * 100) : undefined
					});
				}
			} : undefined,

			complete: (results: { data: unknown[]; meta: { fields?: string[] } }) => {
				if (!opts.streaming && results.data) {
					rows.push(...(results.data as Record<string, unknown>[]));
					rowCount = rows.length;
				}

				if (rows.length > 0) {
					// Get headers and trim whitespace
					headers = Object.keys(rows[0]).map(h => h.trim());

					// Rename keys in all rows to trimmed versions
					const trimmedRows = rows.map(row => {
						const newRow: Record<string, unknown> = {};
						for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
							newRow[key.trim()] = value;
						}
						return newRow;
					});
					rows.length = 0;
					rows.push(...trimmedRows);
				} else if (results.meta?.fields) {
					headers = results.meta.fields.map(h => h.trim());
				}

				// Final progress update
				if (opts.onProgress) {
					opts.onProgress({
						rowsProcessed: rowCount,
						bytesProcessed: fileSize,
						estimatedTotal: fileSize,
						percentComplete: 100
					});
				}

				resolve({
					columns: headers,
					rows: rows,
					rowCount: rows.length,
					sourceByteDigest,
					// A CSV file IS one collection: there is no second thing for
					// `source.joins` to name. Declared, not omitted, so the source
					// stage refuses a join with the format reason rather than a
					// vague "no container" (Ch 46 source contract 4.2).
					container: { kind: 'flat' },
				});
			},

			error: (error: { message: string }) => {
				reject(new Error(`CSV parsing error: ${error.message}`));
			}
		};

		// Parse the decoded form of the same captured bytes that were hashed.
		(Papa.parse as (input: string, config: object) => void)(content, config);
	});
}

/**
 * Analyze columns to detect types and gather info.
 * Only meaningful for eager-array ParsedData. Streaming sources need a
 * separate sample-collect step before column analysis.
 */
export function analyzeColumns(data: ParsedData): ColumnInfo[] {
	if (!Array.isArray(data.rows)) {
		// Streaming source — return shape-only column info; type detection
		// requires materializing rows which defeats streaming.
		return data.columns.map(colName => ({
			name: colName,
			sampleValues: [],
			detectedType: 'string' as const,
			hasEmptyValues: false,
			uniqueCount: 0,
		}));
	}
	const eagerRows = data.rows;
	return data.columns.map(colName => {
		const values = eagerRows.map((row: Record<string, any>) => row[colName]);
		const nonEmptyValues = values.filter((v: any) => v !== '' && v !== null && v !== undefined);

		return {
			name: colName,
			sampleValues: nonEmptyValues.slice(0, 5),
			detectedType: detectColumnType(nonEmptyValues),
			hasEmptyValues: nonEmptyValues.length < values.length,
			uniqueCount: new Set(nonEmptyValues).size
		};
	});
}

/**
 * Detect the most likely type for a column
 */
function detectColumnType(values: any[]): ColumnInfo['detectedType'] {
	if (values.length === 0) return 'string';

	let numberCount = 0;
	let booleanCount = 0;
	let arrayCount = 0;

	for (const value of values) {
		const str = String(value).trim();

		// Check for number
		if (!isNaN(Number(str)) && str !== '') {
			numberCount++;
		}

		// Check for boolean
		if (['true', 'false', 'yes', 'no', '1', '0'].includes(str.toLowerCase())) {
			booleanCount++;
		}

		// Check for array (comma-separated, multiple values)
		if (str.includes(',') && str.split(',').length > 1) {
			arrayCount++;
		}
	}

	const total = values.length;
	const threshold = 0.8; // 80% of values must match

	if (numberCount / total >= threshold) return 'number';
	if (booleanCount / total >= threshold) return 'boolean';
	if (arrayCount / total >= threshold) return 'array';

	return 'string';
}

/**
 * Parse a CSV File as a true streaming source — returns a ParsedData where
 * `rows` is an AsyncIterable that pulls one row at a time from PapaParse via
 * the step callback. The full dataset never lives in RAM.
 *
 * Backpressure: PapaParse pauses when the internal buffer reaches HIGH_WATER
 * rows; resumes when the consumer drains it below LOW_WATER. Memory ceiling
 * is roughly HIGH_WATER × avg-row-bytes.
 *
 * Per the [2026-05-05 two-mode architecture decision](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-05-two-mode-architecture/),
 * this is the path the wizard uses for files larger than the 5 MB threshold
 * (`shouldUseStreaming(file)`). External producers (ChunkyCSV, JSONaut, dbt)
 * can also build their own AsyncIterable<Row> and hand it to the engine via
 * `plugin.runImportFromRecipe()`.
 */
export function parseCSVFileStream(
	file: File,
	options: CSVParserOptions = {}
): ParsedData {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const HIGH_WATER = 100;
	const LOW_WATER = 10;

	const buffer: Record<string, any>[] = [];
	let columns: string[] = [];
	let parser: { pause: () => void; resume: () => void } | null = null;
	let parseError: Error | null = null;
	let parseDone = false;
	let waitingResolve: (() => void) | null = null;
	let rowCount = 0;
	const fileSize = file.size;

	const config = {
		delimiter: opts.delimiter || '',
		header: true,
		skipEmptyLines: opts.skipEmptyRows,
		dynamicTyping: false,

		step: (results: { data: unknown; meta?: { cursor?: number; fields?: string[] } }, p: { pause: () => void; resume: () => void }) => {
			parser = p;
			if (results.data) {
				const raw = results.data as Record<string, unknown>;
				// Trim whitespace from header keys lazily on first pull
				const trimmed: Record<string, any> = {};
				for (const [k, v] of Object.entries(raw)) {
					trimmed[k.trim()] = v;
				}
				buffer.push(trimmed);
				rowCount += 1;

				// Capture columns from the first row's keys
				if (columns.length === 0) {
					columns = Object.keys(trimmed);
				}
			}

			if (opts.onProgress && rowCount % (opts.chunkSize || 1000) === 0) {
				const bytesProcessed = results.meta?.cursor || 0;
				opts.onProgress({
					rowsProcessed: rowCount,
					bytesProcessed,
					estimatedTotal: fileSize,
					percentComplete: fileSize > 0 ? Math.round((bytesProcessed / fileSize) * 100) : undefined,
				});
			}

			// Wake any waiting consumer
			if (waitingResolve) {
				const r = waitingResolve;
				waitingResolve = null;
				r();
			}

			// Backpressure — pause parser when buffer fills
			if (buffer.length >= HIGH_WATER) {
				p.pause();
			}
		},

		complete: () => {
			parseDone = true;
			if (waitingResolve) {
				const r = waitingResolve;
				waitingResolve = null;
				r();
			}
		},

		error: (error: { message: string }) => {
			parseError = new Error(`CSV streaming parse error: ${error.message}`);
			parseDone = true;
			if (waitingResolve) {
				const r = waitingResolve;
				waitingResolve = null;
				r();
			}
		},
	};

	// Kick off parsing immediately. Step callback fills the buffer; consumer
	// pulls via the async iterator below.
	(Papa.parse as (input: File, config: object) => void)(file, config);

	const rows: AsyncIterable<Record<string, any>> = {
		[Symbol.asyncIterator]() {
			return {
				async next(): Promise<IteratorResult<Record<string, any>>> {
					// Loop until we have a row, the parse errors, or the parse completes
					 
					while (true) {
						if (parseError) throw parseError;

						if (buffer.length > 0) {
							const row = buffer.shift()!;
							// Resume parser if buffer drained below low-water mark
							if (parser && buffer.length < LOW_WATER && !parseDone) {
								parser.resume();
							}
							return { done: false, value: row };
						}

						if (parseDone) {
							return { done: true, value: undefined as never };
						}

						// Wait for parser to push more rows or signal completion
						await new Promise<void>((resolve) => {
							waitingResolve = resolve;
						});
					}
				},
			};
		},
	};

	return {
		columns,                  // populated lazily once first row arrives
		rows,                     // AsyncIterable
		rowCount: -1,             // unknown until parse completes
		container: { kind: 'flat' },
	};
}

/**
 * Estimate memory usage for a dataset
 */
export function estimateMemoryUsage(rowCount: number, columnCount: number, avgCellLength: number = 50): number {
	// Rough estimate: each cell is a string with overhead
	const bytesPerCell = avgCellLength * 2 + 50; // UTF-16 + object overhead
	return rowCount * columnCount * bytesPerCell;
}

/**
 * Byte size above which a source is treated as large: the wizard recommends
 * streaming, and the vault source scan skips the header peek with a note
 * instead of reading the file. One number, shared, so the two surfaces agree.
 */
export const STREAMING_THRESHOLD_BYTES = 5 * 1024 * 1024;

/**
 * Check if streaming should be recommended for a file
 */
export function shouldUseStreaming(file: File): boolean {
	return file.size > STREAMING_THRESHOLD_BYTES;
}
