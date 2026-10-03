/**
 * sssom-exporter.ts — v0.1.7 exporters: crosswalk-edge notes → SSSOM TSV.
 *
 * The write half of the round-trip whose read half is src/import/
 * sssom-importer.ts + src/import/sssom-parser.ts. Column set and header-block
 * shape mirror what `parseSssomTsv` consumes (required subject_id/predicate_id/
 * object_id; optional subject_label/object_label/mapping_justification/
 * confidence) and what `detectOntologyPair` reads back out of the header
 * (`subject_source`/`object_source`) — see tools/fixtures/realistic/*.sssom.tsv
 * for the canonical shape this mirrors.
 *
 * User-facing surfaces call this the "crosswalk mapping file" (ui-lexicon
 * convention, .claude/CLAUDE.md operational rules) — "SSSOM" is internal
 * vocabulary and must not leak into command names or notices.
 *
 * Known lossy fields (round-trip is NOT byte-identical — documented per the
 * v0.1.7 milestone's "document any legitimately-lossy fields loudly" note):
 *
 *   - `mapping_date`: importSssom's synthetic recipe (src/import/
 *     sssom-importer.ts's buildSyntheticRecipe) never writes mapping_date
 *     into the note's managed frontmatter, even though it flows through the
 *     row scope as a set-level default. A folder populated by an SSSOM
 *     import therefore has NO mapping_date to read back — this exporter
 *     omits the `# mapping_date:` header line unless the caller supplies one
 *     explicitly via `options.mappingDate`. tools/crosswalk-from-olir.ts's
 *     notes don't carry it either. Fixing this is an importer change, not an
 *     exporter one — flagged here rather than silently fabricating a date.
 *
 *   - `match_type` (the legacy exact/close/broad/narrow/related qualifier
 *     column): also never written to note frontmatter by importSssom's
 *     synthetic recipe (the template has no `match_type` field), so it is
 *     unrecoverable from the vault. `vault-reader.ts`'s `CrosswalkEdgeRow`
 *     surfaces `match_type` when a note DOES carry it (Tier 1 schema allows
 *     it via `additionalProperties`), but nothing in the current import path
 *     ever populates it.
 *
 *   - `predicate_id` (SSSOM/SKOS): the note's own `predicate_id` field is
 *     STRM, not SSSOM (see spec/tier1.schema.json's `crosswalk_edge_
 *     frontmatter.predicate_id` enum + sssom-importer.ts's SKOS_TO_STRM
 *     normalization). This exporter prefers the note's `sssom_predicate`
 *     field (both importSssom's synthetic recipe AND tools/crosswalk-
 *     from-olir.ts write it — the one field name both producers agree on)
 *     to recover the exact original predicate. When a note has no
 *     `sssom_predicate` (e.g. a hand-authored crosswalk-edge note), the STRM
 *     value is reverse-mapped via STRM_TO_SKOS — LOSSY for `is_approximate_to`
 *     and `no_relationship`, which have no exact SKOS/STRM round-trip
 *     partner (see the map's comment).
 *
 *   - Release lineage (`superseded_by` / `supersedes`) is REFUSED, not
 *     translated. SKOS has no replacement property, and the fallback path here
 *     would have labelled a withdrawal record `skos:relatedMatch`. Those rows
 *     are excluded and counted in `skipped`.
 *
 *   - `mapping_provider` / `mapping_set_id`: these ARE written per-row (the
 *     synthetic recipe's `also_emit.frontmatter.managed` includes both), but
 *     SSSOM models them as mapping-SET-level metadata (header lines, not
 *     columns). This exporter promotes the most common (mode) value across
 *     the exported rows into the header. A folder that mixes multiple
 *     providers/set-ids on individual edges loses that per-edge variation —
 *     acceptable for the common case (one crosswalk file per folder) but
 *     worth knowing if you've hand-edited individual edges.
 *
 *   - Release record (v0.1.7 Track 3, 2026-10-03). When the exported import
 *     set holds a release record (src/mappings/mapping-set.ts), the header is
 *     written from that record on the standard SSSOM header keys only (M3):
 *     nothing is inferred from rows, and the mode() promotion above applies
 *     only to sets without a record, with `release_record: 'derived'` in the
 *     result so the caller can say so. Digests are not exported; a re-import
 *     recomputes them, and equality is the round-trip proof
 *     (tests/mapping-set-roundtrip.test.ts).
 */

import Papa from 'papaparse';
import type { App } from 'obsidian';
import { readVaultTree, type CrosswalkEdgeRow, type SkippedNote } from './vault-reader';
import { normalizeMappingSetId, readStoredPredicateModifier } from '../utils/mapping-provenance';
import { readMappingSet, type MappingSetRecord } from '../mappings/mapping-set';
import { discoverImportSet } from '../generation/import-set';
import {
	LINEAGE_NOT_REPRESENTABLE_REASON,
	isLineagePredicate,
} from '../tier2/predicate-characteristics';

/**
 * STRM predicate_id → SSSOM/SKOS predicate. Reverse of SKOS_TO_STRM in
 * src/import/sssom-importer.ts. Used only as a fallback when a note has no
 * `sssom_predicate` field to read directly (see module doc comment).
 * `is_approximate_to` has no exact SKOS/STRM round-trip partner (both
 * closeMatch and (rarely) relatedMatch can normalize to it) — closeMatch is
 * the more common source, so that's the fallback choice, documented lossy.
 * `no_relationship` has no SKOS equivalent at all; relatedMatch is the
 * closest "some relationship, unspecified" fallback.
 */
const STRM_TO_SKOS: Record<string, string> = {
	is_equivalent_to: 'skos:exactMatch',
	is_approximate_to: 'skos:closeMatch',
	is_narrower_than: 'skos:broadMatch',
	is_broader_than: 'skos:narrowMatch',
	intersects_with: 'skos:relatedMatch',
	no_relationship: 'skos:relatedMatch',
};

const SSSOM_COLUMNS = [
	'subject_id',
	'predicate_id',
	'object_id',
	'predicate_modifier',
	'mapping_justification',
	'confidence',
	'subject_label',
	'object_label',
] as const;

export interface SssomExportOptions {
	/** Override the header's `mapping_provider` (default: mode across exported rows). */
	mappingProvider?: string;
	/** Override the header's `mapping_set_id` (default: mode across exported rows). */
	mappingSetId?: string;
	/** Header's `mapping_date` — omitted entirely unless supplied (see module doc comment; not recoverable from the vault). */
	mappingDate?: string;
	/** Override the header's `subject_source` (default: mode of `source_framework` frontmatter field, else the subject CURIE prefix). */
	subjectSource?: string;
	/** Override the header's `object_source` (default: mode of `target_framework` frontmatter field, else the object CURIE prefix). */
	objectSource?: string;
	/**
	 * The exported set's release record. When present the header is written
	 * from it (M3 keys only) and nothing is inferred from rows; the explicit
	 * overrides above still win for the keys they name.
	 */
	record?: MappingSetRecord;
}

/** Where the header's release metadata came from: the set's release record, or inferred from rows (M5). */
export type ReleaseRecordSource = 'recorded' | 'derived';

export interface SssomExportResult {
	tsv: string;
	rowCount: number;
	skipped: SkippedNote[];
	release_record: ReleaseRecordSource;
}

/**
 * The export's one line about where its release metadata came from (M5),
 * shown in the export notice. Plain words only: "release record", never the
 * file format's own vocabulary.
 */
export function releaseRecordLine(source: ReleaseRecordSource): string {
	return source === 'recorded'
		? 'Release record: recorded.'
		: 'Release record: derived from rows (no release record). Import the set again to record one.';
}

/**
 * One header line. Values are written double-quoted and unescaped, which is
 * exactly what `parseSssomTsv` strips back off, so a value survives a round
 * trip unchanged. Line breaks would end the header line, so they become spaces.
 */
function headerLine(key: string, value: string): string {
	return `# ${key}: "${value.replace(/[\r\n]+/g, ' ')}"`;
}

/** The standard SSSOM header lines (M3) of a release record, in SSSOM's own order. */
function recordHeaderLines(record: MappingSetRecord, options: SssomExportOptions): string[] {
	const lines: string[] = [];
	const add = (key: string, value: string | undefined) => { if (value) lines.push(headerLine(key, value)); };
	add('mapping_set_id', options.mappingSetId === undefined ? record.mapping_set_id : normalizeMappingSetId(options.mappingSetId) || undefined);
	add('mapping_set_version', record.mapping_set_version);
	add('mapping_set_title', record.mapping_set_title);
	add('mapping_set_description', record.mapping_set_description);
	add('license', record.license);
	add('mapping_provider', options.mappingProvider ?? record.mapping_provider);
	add('mapping_date', options.mappingDate ?? record.mapping_date);
	if (record.creator_id?.length) {
		lines.push('# creator_id:');
		for (const creator of record.creator_id) lines.push(`#   - "${creator.replace(/[\r\n]+/g, ' ')}"`);
	}
	add('subject_source', options.subjectSource ?? record.subject_source);
	add('subject_source_version', record.subject_source_version);
	add('object_source', options.objectSource ?? record.object_source);
	add('object_source_version', record.object_source_version);
	return lines;
}

function asOptionalString(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function curiePrefix(curie: string): string {
	const idx = curie.indexOf(':');
	return idx === -1 ? curie : curie.slice(0, idx);
}

function resolveConfidence(fm: Record<string, unknown>, matchConfidence: number | undefined): number | undefined {
	if (typeof matchConfidence === 'number') return matchConfidence;
	// sssom-importer's synthetic recipe stores confidence as `sssom_confidence`,
	// and (per its own doc comment) as a STRING — Tier 1's typed match_confidence
	// requires a number and the recipe template only emits raw strings. Parse it
	// here rather than fixing it upstream (out of this milestone's surface).
	const raw = fm.sssom_confidence ?? fm.confidence;
	if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
	if (typeof raw === 'string' && raw.trim() !== '') {
		const n = Number.parseFloat(raw);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

/** Most frequent non-empty value across a multiset; undefined if none. Ties break on first-seen (stable, deterministic given sorted input). */
function mode(counts: Map<string, number>): string | undefined {
	let best: string | undefined;
	let bestCount = 0;
	for (const [value, count] of counts) {
		if (count > bestCount) {
			best = value;
			bestCount = count;
		}
	}
	return best;
}

function tally(counts: Map<string, number>, value: string | undefined): void {
	if (!value) return;
	counts.set(value, (counts.get(value) ?? 0) + 1);
}

/**
 * The import set that owns this note, read from its `_crosswalker` provenance stamp.
 * Returns undefined for notes written before import sets shipped — those are treated
 * as one unlabelled group rather than as a distinct release, so an all-legacy export
 * still works unchanged.
 */
function readImportSetId(fm: Record<string, unknown>): string | undefined {
	const provenance = fm._crosswalker as { import_set?: { id?: unknown } } | undefined;
	const id = provenance?.import_set?.id;
	return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * Serialize a set of crosswalk-edge rows (already read from the vault, or
 * hand-assembled for a test) into an SSSOM TSV string. Pure — no vault I/O.
 * Rows are re-sorted by path first so output is deterministic regardless of
 * caller-supplied order.
 */
export function crosswalkEdgesToSssomTsv(
	edges: CrosswalkEdgeRow[],
	options: SssomExportOptions = {},
): SssomExportResult {
	const skipped: SkippedNote[] = [];
	const rows: Record<string, string>[] = [];
	const providerCounts = new Map<string, number>();
	const setIdCounts = new Map<string, number>();
	/** Distinct import sets seen across the exported rows; >1 means coexisting releases. */
	const importSetCounts = new Map<string, number>();
	const subjectSourceCounts = new Map<string, number>();
	const objectSourceCounts = new Map<string, number>();

	const sorted = [...edges].sort((a, b) => a.path.localeCompare(b.path));
	for (const edge of sorted) {
		if (!edge.subject_id || !edge.object_id) {
			skipped.push({ path: edge.path, reason: 'missing subject_id/object_id' });
			continue;
		}
		const fm = edge.frontmatter;
		let predicateModifier: '' | 'NOT';
		try {
			predicateModifier = Object.prototype.hasOwnProperty.call(fm, 'predicate_modifier')
				? readStoredPredicateModifier(fm)
				: edge.predicate_modifier ?? '';
		} catch (error) {
			skipped.push({
				path: edge.path,
				reason: error instanceof Error ? error.message : 'invalid explicit predicate_modifier',
			});
			continue;
		}
		if (isLineagePredicate(edge.predicate_id)) {
			// Release lineage is not a SKOS mapping property. Checked BEFORE the
			// lookup because STRM_TO_SKOS is a `Record<string, string>` whose `??`
			// fallback compiles cleanly and would emit `skos:relatedMatch` — the
			// claim that a withdrawn control and its replacement are merely
			// "related", with nothing in the type checker to flag it.
			//
			// The per-note `sssom_predicate` override does NOT rescue the row: a
			// vault where lineage is mixed into a mapping-set export is exactly the
			// case where a silently-included row would be trusted. Exporting lineage
			// is a separate artifact, not a column value.
			skipped.push({ path: edge.path, reason: LINEAGE_NOT_REPRESENTABLE_REASON });
			continue;
		}
		const sssomPredicate = asOptionalString(fm.sssom_predicate) ?? STRM_TO_SKOS[edge.predicate_id] ?? 'skos:relatedMatch';
		const confidence = resolveConfidence(fm, edge.match_confidence);

		rows.push({
			subject_id: edge.subject_id,
			predicate_id: sssomPredicate,
			object_id: edge.object_id,
			predicate_modifier: predicateModifier,
			mapping_justification: edge.mapping_justification ?? '',
			confidence: confidence !== undefined ? String(confidence) : '',
			subject_label: asOptionalString(fm.subject_label) ?? '',
			object_label: asOptionalString(fm.object_label) ?? '',
		});

		tally(providerCounts, edge.mapping_provider);
		tally(importSetCounts, readImportSetId(fm));
		const mappingSetId = normalizeMappingSetId(edge.mapping_set_id ?? fm.mapping_set_id);
		tally(setIdCounts, mappingSetId || undefined);
		tally(subjectSourceCounts, asOptionalString(fm.source_framework) ?? curiePrefix(edge.subject_id));
		tally(objectSourceCounts, asOptionalString(fm.target_framework) ?? curiePrefix(edge.object_id));
	}

	// Refuse to conflate coexisting releases. Release isolation lets two versions of
	// the same framework live side by side in one folder tree; exporting both into a
	// single file stamps one header over rows that came from two different releases,
	// producing an artifact that misrepresents its own contents while looking correct.
	// The header would silently take whichever release contributed more rows.
	//
	// Keyed on the import set, not mapping_set_id: mapping_set_id describes the source
	// labelling and one release can legitimately span several, so guarding on it would
	// refuse valid exports. Two import sets are two releases by definition.
	const distinctImportSets = [...importSetCounts.keys()].sort();
	if (distinctImportSets.length > 1) {
		throw new Error(
			`Refusing to export ${distinctImportSets.length} coexisting releases into one SSSOM `
			+ `file (import sets: ${distinctImportSets.join(', ')}). Each release is a separate `
			+ `mapping set. Export one at a time by scoping to a single import set.`,
		);
	}

	let headerLines: string[];
	if (options.record) {
		headerLines = recordHeaderLines(options.record, options);
	} else {
		// No release record (a set imported before records existed, or rows that
		// belong to no import set): infer from rows, and say so in the result.
		const subjectSource = options.subjectSource ?? mode(subjectSourceCounts);
		const objectSource = options.objectSource ?? mode(objectSourceCounts);
		const mappingProvider = options.mappingProvider ?? mode(providerCounts);
		const mappingSetId = options.mappingSetId === undefined
			? mode(setIdCounts)
			: normalizeMappingSetId(options.mappingSetId) || undefined;
		headerLines = [];
		if (subjectSource) headerLines.push(`# subject_source: "${subjectSource}"`);
		if (objectSource) headerLines.push(`# object_source: "${objectSource}"`);
		if (mappingSetId) headerLines.push(`# mapping_set_id: "${mappingSetId}"`);
		if (mappingProvider) headerLines.push(`# mapping_provider: "${mappingProvider}"`);
		if (options.mappingDate) headerLines.push(`# mapping_date: "${options.mappingDate}"`);
	}

	const body = Papa.unparse(rows, { columns: [...SSSOM_COLUMNS], delimiter: '\t', newline: '\n' });
	const tsv = headerLines.length > 0 ? `${headerLines.join('\n')}\n${body}\n` : `${body}\n`;

	return { tsv, rowCount: rows.length, skipped, release_record: options.record ? 'recorded' : 'derived' };
}

/**
 * The release record of the one import set every exported row belongs to, or
 * undefined: rows from no set, from several sets (the exporter refuses those),
 * or from a set imported before records existed. Throws the reader's
 * actionable error when the set's record is malformed.
 */
async function recordOfExportedSet(app: App, edges: CrosswalkEdgeRow[]): Promise<MappingSetRecord | undefined> {
	const ids = new Set(edges.map((edge) => readImportSetId(edge.frontmatter) ?? ''));
	if (ids.size !== 1) return undefined;
	const [id] = [...ids];
	if (!id) return undefined;
	const set = await discoverImportSet(app, id);
	return set ? readMappingSet(app, set) : undefined;
}

/**
 * Walk `rootPath` and export every crosswalk-edge note found under it as an
 * SSSOM TSV. The header comes from the exported set's release record when it
 * has one (M5), else from the rows.
 */
export async function exportFolderAsSssomTsv(
	app: App,
	rootPath: string,
	options: SssomExportOptions = {},
): Promise<SssomExportResult> {
	const tree = await readVaultTree(app, rootPath);
	const record = options.record ?? await recordOfExportedSet(app, tree.crosswalkEdges);
	const result = crosswalkEdgesToSssomTsv(tree.crosswalkEdges, record ? { ...options, record } : options);
	result.skipped.push(...tree.skipped);
	return result;
}
