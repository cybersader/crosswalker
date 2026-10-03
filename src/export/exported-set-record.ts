/**
 * exported-set-record.ts — the release record an export carries, shared by the
 * crosswalk mapping file exporter and the typed mapping table exporter
 * (v0.1.7 Track 3, slices 1 and 2).
 *
 * Two questions, one answer for both exporters:
 *
 *   1. Which release record do the exported rows belong to? The record of the
 *      one import set every exported row is stamped with, or none.
 *   2. Does the export hold the whole release? The membership fingerprint is
 *      recomputed over the rows actually exported and compared with the
 *      record's (S6). A subfolder export, or rows a format cannot carry, give a
 *      partial export: the record is still written (its identity is right) but
 *      the result says `recorded-partial` and the notice says how many of the
 *      recorded mappings went out. Nothing is refused: partial exports are
 *      legitimate.
 */

import type { App } from 'obsidian';
import type { CrosswalkEdgeRow } from './vault-reader';
import { discoverImportSet } from '../generation/import-set';
import {
	computeMappingSetDigests,
	readMappingSet,
	type MappingSetAssertionFacts,
	type MappingSetRecord,
} from '../mappings/mapping-set';
import { plural } from '../utils/plural';

/** Where an export's release metadata came from (M5, S6). */
export type ReleaseRecordState = 'recorded' | 'recorded-partial' | 'derived';

/**
 * The import set that owns this note, read from its `_crosswalker` provenance stamp.
 * Undefined for notes written before import sets shipped.
 */
export function readImportSetId(fm: Record<string, unknown>): string | undefined {
	const provenance = fm._crosswalker as { import_set?: { id?: unknown } } | undefined;
	const id = provenance?.import_set?.id;
	return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * The release record of the one import set every exported row belongs to, or
 * undefined: rows from no set, from several sets, or from a set imported
 * before records existed. Throws the reader's actionable error when the set's
 * record is malformed.
 */
export async function recordOfExportedSet(app: App, edges: CrosswalkEdgeRow[]): Promise<MappingSetRecord | undefined> {
	const ids = new Set(edges.map((edge) => readImportSetId(edge.frontmatter) ?? ''));
	if (ids.size !== 1) return undefined;
	const [id] = [...ids];
	if (!id) return undefined;
	const set = await discoverImportSet(app, id);
	return set ? readMappingSet(app, set) : undefined;
}

/**
 * The membership facts of one exported edge, as the importer digested them:
 * the STRM predicate as stored, and the explicit negation flag.
 */
export function edgeMembershipFacts(edge: CrosswalkEdgeRow, predicateModifier: '' | 'NOT'): MappingSetAssertionFacts {
	return {
		subject_id: edge.subject_id,
		predicate_id: edge.predicate_id,
		object_id: edge.object_id,
		predicate_modifier: predicateModifier,
	};
}

/**
 * `recorded` when the exported rows are exactly the record's membership,
 * `recorded-partial` when they are not, `derived` without a record (S6).
 */
export function releaseRecordState(
	record: MappingSetRecord | undefined,
	exported: Iterable<MappingSetAssertionFacts>,
): ReleaseRecordState {
	if (!record) return 'derived';
	return computeMappingSetDigests(exported).membership_digest === record.membership_digest ? 'recorded' : 'recorded-partial';
}

/**
 * An edge's confidence, whichever field stored it: the typed `match_confidence`,
 * else `sssom_confidence` (the crosswalk mapping file importer stores it there,
 * as a string, because its template emits text), else `confidence`. Shared by
 * both exporters, so a typed mapping table carries the strength a crosswalk
 * mapping file export carries.
 */
export function edgeConfidence(edge: CrosswalkEdgeRow): number | undefined {
	if (typeof edge.match_confidence === 'number') return edge.match_confidence;
	const raw = edge.frontmatter.sssom_confidence ?? edge.frontmatter.confidence;
	if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
	if (typeof raw === 'string' && raw.trim() !== '') {
		const n = Number.parseFloat(raw);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

/** The partial-export line (S6). Plain words only. */
export function partialExportLine(exported: number, recorded: number): string {
	return `Exported ${exported.toLocaleString()} of ${plural(recorded, 'recorded mapping')}. The release record describes the whole set.`;
}
