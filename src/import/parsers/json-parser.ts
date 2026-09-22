/**
 * json-parser.ts — nested-JSON parsing for the import wizard.
 *
 * UI counterpart of the harness's `--iterator` / `--where` flags, wrapping the
 * shared core (json-source-core.ts) into the wizard's ParsedData contract.
 * One reader, two doors: the wizard form and the CLI flags drive the exact
 * same logic, so a working wizard config IS a working harness invocation.
 *
 * Iterator examples (closed grammar; errors list the available keys):
 *   $.objects[*]                          MITRE ATT&CK STIX bundle
 *   $.response.elements.elements[*]       NIST CPRT exports
 *   $.catalog.groups[*].controls[*]       OSCAL catalogs (multi-fan flattens)
 *   (leave empty)                         document root is itself an array
 *
 * ROW FILTERING LIVES IN `source.where`, NOT HERE (2026-08-27 contract §11).
 * The parser used to carry its own silent predicate whose documented behaviour
 * was "a missing field never `=`-matches, and always `!=`-matches" — so a typo'd
 * column returned zero rows or every row with no diagnostic. That implementation
 * is deleted. The wizard field keeps its comma shorthand and now translates it
 * through `src/source/shorthand.ts` into `source.where`, which is guarded by G1
 * (strict boolean), G2 (referenced names must exist) and G3 (a predicate that
 * admits nothing is an error) and travels with the recipe.
 */

import { computeSourceByteDigest } from '../../generation/hash';
import { ParsedData } from '../../types/config';
import { assertNoReservedSourceColumn } from '../../source/joins';
import { jsonToRows } from './json-source-core';

export interface JSONParseOptions {
	/** Iterator path locating the row array (e.g. "$.objects[*]"). Empty → root array. */
	iterator?: string;
}

export interface JSONParseResult extends ParsedData {
	/** Non-object items the iterator yielded and skipped. */
	skippedNonObjects: number;
}

/**
 * Parse a JSON file into ParsedData (eager rows). Top-level scalars are
 * coerced to trimmed strings (the CSV/XLSX contract); nested objects/arrays
 * survive so recipe templates can reach into them via dotted paths.
 */
export async function parseJSONFile(file: File, options: JSONParseOptions = {}): Promise<JSONParseResult> {
	// Capture once so row parsing, lazy join reads, and provenance all describe
	// the same immutable source payload.
	const sourceBytes = new Uint8Array(await file.arrayBuffer());
	const sourceByteDigest = computeSourceByteDigest(sourceBytes);
	const text = new TextDecoder().decode(sourceBytes);
	const result = jsonToRows(text, options.iterator || undefined);

	// Column order = first appearance across rows (JSON objects can be sparse).
	const columns: string[] = [];
	const seen = new Set<string>();
	for (const row of result.rows) {
		for (const k of Object.keys(row)) {
			if (!seen.has(k)) {
				seen.add(k);
				columns.push(k);
			}
		}
	}
	assertNoReservedSourceColumn(columns);

	return {
		columns,
		rows: result.rows,
		rowCount: result.rows.length,
		skippedNonObjects: result.skippedNonObjects,
		sourceByteDigest,
		// Ch 46 source contract 4.2: `source.joins` locates a secondary
		// collection in a SIBLING ARRAY OF THIS SAME DOCUMENT. Lazy on purpose,
		// so an import declaring no join never retains the parsed document.
		container: {
			kind: 'json',
			readDocument: async () => JSON.parse(text) as unknown,
		},
	};
}

export interface IteratorCandidate {
	/** Iterator path in harness syntax (what parseJSONFile consumes). */
	iterator: string;
	/** Human-friendly breadcrumb, e.g. "response → elements → elements". */
	label: string;
	/** Just the final segment, e.g. "elements" — the picker's headline. */
	name: string;
	count: number;
	/** First record's keys (capped at 6) — lets the picker show the shape. */
	sampleKeys: string[];
	/** Total field count of the first record (sampleKeys may be truncated). */
	fieldCount: number;
	/** A concrete example record: the first item's populated fields (value
	 *  trimmed + truncated), so the picker can show what a record actually looks
	 *  like rather than just a JSON path. Empty-valued fields are skipped. */
	sample: Array<{ key: string; value: string }>;
	/** Heuristic: the list name reads like edges/mappings, not primary records. */
	looksLikeEdges: boolean;
}

export interface JsonStructure {
	/** The document root is itself the list — no iterator needed. */
	rootIsArray: boolean;
	rootCount: number;
	candidates: IteratorCandidate[];
	parseError?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** Lists named like relationships/mappings/edges are usually secondary (the
 *  links between primary records), so we rank them below the primary lists when
 *  choosing a default — e.g. NIST CPRT's `elements` (concepts) over its larger
 *  `relationships` list. Domain-general: in most nested data the items are the
 *  primary records and the relationship lists describe how they connect. */
const looksLikeEdgeName = (name: string): boolean =>
	/relationship|mapping|crosswalk|edge|link|reference|xref/i.test(name);

/** A short, human-readable value for a record field — the concrete-example
 *  preview. Nested objects/arrays collapse to a shape hint; empty → ''. */
const previewValue = (v: unknown): string => {
	if (v === null || v === undefined) return '';
	if (Array.isArray(v)) return v.length ? `[${v.length} items]` : '';
	if (typeof v === 'object') return '{…}';
	const s = String(v).trim();
	return s.length > 40 ? s.slice(0, 39) + '…' : s;
};

/** Build the concrete-example preview for a record: its first few POPULATED
 *  fields as key/value pairs (so a 100%-empty `title` is skipped in favour of
 *  fields that actually carry data). */
const buildSample = (record: Record<string, unknown>): Array<{ key: string; value: string }> => {
	const out: Array<{ key: string; value: string }> = [];
	for (const [key, raw] of Object.entries(record)) {
		const value = previewValue(raw);
		if (value) out.push({ key, value });
		if (out.length >= 4) break;
	}
	return out;
};

/**
 * Inspect a JSON document and suggest where the records live, so the wizard
 * can offer a click-to-pick list instead of asking users to write `$.a.b[*]`
 * syntax by hand. Walks object keys (and one level INTO each found array, for
 * multi-fan shapes like OSCAL's catalog.groups[*].controls[*]) up to depth 4;
 * an array counts as a candidate when its first element is an object.
 */
export function suggestIterators(text: string): JsonStructure {
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch (err) {
		return { rootIsArray: false, rootCount: 0, candidates: [], parseError: err instanceof Error ? err.message : String(err) };
	}

	if (Array.isArray(root)) {
		const first = root.find(isRecord);
		const keys = first ? Object.keys(first) : [];
		return {
			rootIsArray: true,
			rootCount: root.length,
			candidates: [{
				iterator: '',
				label: 'whole file',
				name: 'whole file',
				count: root.length,
				sampleKeys: keys.slice(0, 6),
				fieldCount: keys.length,
				sample: first ? buildSample(first) : [],
				looksLikeEdges: false,
			}],
		};
	}

	const candidates: IteratorCandidate[] = [];
	const walk = (node: unknown, path: string[], depth: number) => {
		if (candidates.length >= 8 || depth > 4 || !isRecord(node)) return;
		for (const [key, value] of Object.entries(node)) {
			if (Array.isArray(value)) {
				const first = value.find(isRecord);
				if (first) {
					const segs = [...path, key];
					const keys = Object.keys(first);
					candidates.push({
						iterator: '$.' + segs.join('.').replace(/\.(?=\[)/g, ''),
						label: segs.join(' → '),
						name: key,
						count: value.length,
						sampleKeys: keys.slice(0, 6),
						fieldCount: keys.length,
						sample: buildSample(first),
						looksLikeEdges: looksLikeEdgeName(key),
					});
					// continue INTO the first record for multi-fan shapes
					walk(first, [...path, key + '[*]'], depth + 1);
				}
			} else if (isRecord(value)) {
				walk(value, [...path, key], depth + 1);
			}
		}
	};
	walk(root, [], 0);

	// Iterator syntax: every plain segment is dotted; array segments already
	// carry [*]; the FINAL segment needs its fan-out marker appended.
	for (const c of candidates) {
		if (c.iterator && !c.iterator.endsWith('[*]')) c.iterator += '[*]';
	}

	// Primary-record lists before edge/mapping lists; within each, biggest first.
	// (So NIST CPRT's `elements` outranks its larger `relationships` list.)
	candidates.sort((a, b) => {
		if (a.looksLikeEdges !== b.looksLikeEdges) return a.looksLikeEdges ? 1 : -1;
		return b.count - a.count;
	});
	return { rootIsArray: false, rootCount: 0, candidates };
}
