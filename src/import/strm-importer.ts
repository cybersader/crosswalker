/**
 * strm-importer.ts — typed mapping table import (v0.1.7 Track 3 slice 2, S2 to S4).
 *
 * The read half of `src/export/strm-tsv-exporter.ts`. It is an adapter, not a
 * second importer (S2): it parses the seven template columns, reads the release
 * file beside the table when there is one, builds the equivalent crosswalk
 * mapping file in memory, and hands that to `importSssom`. One write path, one
 * refresh rule (M6, M6b), one record builder.
 *
 * Inverse of the exporter, column by column:
 *
 *   Focal Document Element      local part of `subject_id`; the prefix comes
 *                               from the release file's declared
 *                               `subject_source`, else the row's Focal
 *                               Document, whichever forms a valid curie
 *   Reference Document Element  the same for `object_id`
 *   Relationship                the OLIR label, inverted through the
 *                               exporter's STRM_TO_OLIR table to the STRM
 *                               predicate, then to the SKOS predicate through
 *                               `strmToSkos` (the one SKOS to STRM table, whose
 *                               direction the 2026-06-12 convention fixed:
 *                               `subset of` = is_narrower_than = skos:broadMatch).
 *                               `not related` has no SKOS partner, so the
 *                               document carries no_relationship itself and the
 *                               importer passes it through (ruling S7)
 *   Strength (0 to 10)          confidence = strength / 10, the inverse of the
 *                               exporter's round(confidence * 10)
 *   Rationale                   mapping_justification
 *
 * What the table cannot carry (documented, not coerced):
 *   - `is_approximate_to` exports as `intersects with` and comes back as
 *     intersects_with.
 *   - Explicit negations (`predicate_modifier: NOT`) and release lineage are
 *     never exported, so they cannot come back.
 *   - A confidence that is not a multiple of 0.1 comes back rounded.
 *   - Labels, review columns and per-row providers are not in the table.
 *
 * Release file (S1, S3, S4): without one, the set declares nothing and its id
 * is minted (or pinned on refresh, M6b). With one, identity, version and every
 * declared field come from it, and its digests are checked, never trusted: the
 * importer recomputes them over the rows read, the new record carries the
 * recomputed values, and the result warns when they differ.
 */

import Papa from 'papaparse';
import type { App } from 'obsidian';
import type { DebugLog } from '../utils/debug';
import type { GenerationResult } from '../types/config';
import { importSssom, strmToSkos, type SssomImportOptions, type SssomImportResult } from './sssom-importer';
import { CROSSWALK_PREDICATES, type CrosswalkPredicate } from './mapping/types';
import {
	STRM_COLUMNS,
	STRM_RELEASE_FILE_FORMAT,
	STRM_TO_OLIR,
} from '../export/strm-tsv-exporter';
import { recordHeaderLines } from '../export/sssom-exporter';
import {
	computeMappingSetDigests,
	mappingSetFromStored,
	type MappingSetAssertionFacts,
	type MappingSetRecord,
} from '../mappings/mapping-set';
import { extractTier1Curie } from '../validation/validator';
import { plural } from '../utils/plural';

/** Whether the release file beside the table was read. */
export type StrmReleaseFileState = 'read' | 'missing';

export interface StrmImportOptions extends SssomImportOptions {
	/** The release file's name, used in messages. Default `release file`. */
	releaseFileName?: string;
}

export interface StrmImportResult extends SssomImportResult {
	release_file: StrmReleaseFileState;
	/** S4: the release file's counts or fingerprints differ from the rows read. */
	release_warning?: string;
}

/** The release file a typed mapping table may sit beside. */
export interface StrmReleaseFile {
	name: string;
	text: string;
}

/** The in-memory crosswalk mapping file a typed mapping table converts to, or why not. */
export type StrmConversion =
	| {
		ok: true;
		sssomTsv: string;
		rowCount: number;
		release_file: StrmReleaseFileState;
		release_warning?: string;
	}
	| { ok: false; message: string; release_file: StrmReleaseFileState };

const [FOCAL_DOCUMENT, FOCAL_ELEMENT, REFERENCE_DOCUMENT, REFERENCE_ELEMENT, RELATIONSHIP, STRENGTH, RATIONALE] = STRM_COLUMNS;
const REQUIRED_COLUMNS = [FOCAL_ELEMENT, REFERENCE_ELEMENT, RELATIONSHIP] as const;

/**
 * OLIR label to STRM predicate: the exporter's table read backwards, first
 * entry wins, kept only where the crosswalk mapping file can carry the
 * predicate. `intersects with` therefore reads back as intersects_with (the
 * exporter writes it for is_approximate_to too, documented lossy), and
 * `not related` reads back as no_relationship (S7).
 */
const OLIR_TO_STRM: ReadonlyMap<string, string> = (() => {
	const importable = new Set<string>([...CROSSWALK_PREDICATES, 'no_relationship']);
	const map = new Map<string, string>();
	const seen = new Set<string>();
	for (const [strm, label] of Object.entries(STRM_TO_OLIR)) {
		if (seen.has(label)) continue;
		seen.add(label);
		if (importable.has(strm)) map.set(label, strm);
	}
	return map;
})();

/** The relationship values a typed mapping table may hold, as a user reads them. */
export const IMPORTABLE_RELATIONSHIPS: readonly string[] = [...OLIR_TO_STRM.keys()];

/** The predicate the in-memory document states: SKOS where one exists, else the Crosswalker id itself (S7). */
function documentPredicate(predicate: string): string {
	return (CROSSWALK_PREDICATES as readonly string[]).includes(predicate) ? strmToSkos(predicate as CrosswalkPredicate) : predicate;
}

function cell(row: Record<string, string | undefined>, column: string): string {
	return (row[column] ?? '').trim();
}

/** `prefix:local` when it is a valid curie, else undefined. */
function curieOf(prefix: string | undefined, local: string): string | undefined {
	if (!prefix || !local) return undefined;
	const curie = `${prefix}:${local}`;
	return extractTier1Curie(curie) === curie ? curie : undefined;
}

/** "rows 2, 5 and 9" style, first three rows, with a count of the rest. */
function rowList(rows: number[]): string {
	const shown = rows.slice(0, 3).join(', ');
	const more = rows.length > 3 ? ` and ${rows.length - 3} more` : '';
	return `${rows.length === 1 ? 'row' : 'rows'} ${shown}${more}`;
}

/** The release record a release file holds, or a refusal naming the file. */
function readReleaseFile(file: StrmReleaseFile): { record: Omit<MappingSetRecord, 'importSetId'> } | { message: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(file.text);
	} catch {
		return { message: `The release file ${file.name} could not be read. Replace it with the file exported beside this table, or delete it to import the table without one.` };
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { message: `The release file ${file.name} could not be read. Replace it with the file exported beside this table, or delete it to import the table without one.` };
	}
	const { format, typed_table: _table, ...stored } = parsed as Record<string, unknown>;
	if (format !== STRM_RELEASE_FILE_FORMAT) {
		return { message: `The release file ${file.name} is not a Crosswalker release file (property format must be ${STRM_RELEASE_FILE_FORMAT}). Replace it with the file exported beside this table, or delete it to import the table without one.` };
	}
	try {
		const { importSetId: _none, ...record } = mappingSetFromStored(stored, '', file.name);
		return { record };
	} catch (error) {
		return { message: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Convert a typed mapping table (and its release file, when there is one) to
 * the crosswalk mapping file the importer reads. Pure. Refuses, writing
 * nothing, on a missing column, an unknown relationship, a strength that is
 * not 0 to 10, an id that cannot be rebuilt, or an unreadable release file.
 */
export function strmToSssomDocument(tsvContent: string, releaseFile?: StrmReleaseFile): StrmConversion {
	const release_file: StrmReleaseFileState = releaseFile ? 'read' : 'missing';
	const refuse = (message: string): StrmConversion => ({ ok: false, message, release_file });

	let record: Omit<MappingSetRecord, 'importSetId'> | undefined;
	if (releaseFile) {
		const read = readReleaseFile(releaseFile);
		if ('message' in read) return refuse(read.message);
		record = read.record;
	}

	const parsed = Papa.parse<Record<string, string>>(tsvContent.replace(/^﻿/, ''), {
		header: true,
		delimiter: '\t',
		skipEmptyLines: 'greedy',
		dynamicTyping: false,
		transformHeader: (header) => header.trim(),
	});
	const columns = parsed.meta.fields ?? [];
	const missing = REQUIRED_COLUMNS.filter((column) => !columns.includes(column));
	if (missing.length > 0) {
		return refuse(`This typed mapping table has no ${missing.join(', ')} column. Its first row must name the columns ${STRM_COLUMNS.join(', ')}. Export the table again, or fix its first row, then import again.`);
	}

	const unknownRelationship: number[] = [];
	const badStrength: number[] = [];
	const missingElement: number[] = [];
	const noPrefix: Array<{ row: number; document: string; element: string }> = [];
	const rows: Array<Record<string, string>> = [];
	const facts: MappingSetAssertionFacts[] = [];

	parsed.data.forEach((raw, index) => {
		const rowNumber = index + 1;
		const focalElement = cell(raw, FOCAL_ELEMENT);
		const referenceElement = cell(raw, REFERENCE_ELEMENT);
		if (!focalElement || !referenceElement) {
			missingElement.push(rowNumber);
			return;
		}
		const predicate = OLIR_TO_STRM.get(cell(raw, RELATIONSHIP).toLowerCase());
		if (!predicate) unknownRelationship.push(rowNumber);

		const strengthText = cell(raw, STRENGTH);
		let confidence: number | undefined;
		if (strengthText !== '') {
			const strength = /^\d+$/.test(strengthText) ? Number(strengthText) : NaN;
			if (!Number.isInteger(strength) || strength < 0 || strength > 10) badStrength.push(rowNumber);
			else confidence = strength / 10;
		}

		const subject = curieOf(record?.subject_source, focalElement) ?? curieOf(cell(raw, FOCAL_DOCUMENT), focalElement);
		const object = curieOf(record?.object_source, referenceElement) ?? curieOf(cell(raw, REFERENCE_DOCUMENT), referenceElement);
		if (!subject) noPrefix.push({ row: rowNumber, document: cell(raw, FOCAL_DOCUMENT), element: focalElement });
		if (!object) noPrefix.push({ row: rowNumber, document: cell(raw, REFERENCE_DOCUMENT), element: referenceElement });
		if (!predicate || !subject || !object || badStrength.includes(rowNumber)) return;

		const rationale = cell(raw, RATIONALE);
		rows.push({
			subject_id: subject,
			predicate_id: documentPredicate(predicate),
			object_id: object,
			mapping_justification: rationale,
			confidence: confidence === undefined ? '' : String(confidence),
		});
		facts.push({
			subject_id: subject,
			predicate_id: predicate,
			object_id: object,
			predicate_modifier: '',
			mapping_justification: rationale || undefined,
			confidence,
			mapping_provider: record?.mapping_provider,
		});
	});

	const problems: string[] = [];
	if (missingElement.length) {
		problems.push(`${plural(missingElement.length, 'mapping row')} ${missingElement.length === 1 ? 'has' : 'have'} an empty ${FOCAL_ELEMENT} or ${REFERENCE_ELEMENT} (${rowList(missingElement)}).`);
	}
	if (unknownRelationship.length) {
		problems.push(`${plural(unknownRelationship.length, 'mapping row')} ${unknownRelationship.length === 1 ? 'has' : 'have'} a relationship Crosswalker cannot import (${rowList(unknownRelationship)}). Allowed values: ${IMPORTABLE_RELATIONSHIPS.join(', ')}.`);
	}
	if (badStrength.length) {
		problems.push(`${plural(badStrength.length, 'mapping row')} ${badStrength.length === 1 ? 'has' : 'have'} a strength that is not a whole number from 0 to 10 (${rowList(badStrength)}).`);
	}
	if (noPrefix.length) {
		const first = noPrefix[0];
		const where = first.document ? `"${first.document}" and "${first.element}" do not form an id` : `no document is named for "${first.element}"`;
		problems.push(`${plural(new Set(noPrefix.map((entry) => entry.row)).size, 'mapping row')} cannot be given an id (${rowList([...new Set(noPrefix.map((entry) => entry.row))])}): in row ${first.row}, ${where}. Put the framework's short id (lowercase, like demo-a) in the document columns, or keep the release file exported beside this table.`);
	}
	if (problems.length) return refuse(`${problems.join(' ')} Fix the table, then import again.`);
	if (rows.length === 0) return refuse('This typed mapping table has no mapping rows. Export the table again, then import again.');

	let release_warning: string | undefined;
	if (record) {
		const recomputed = computeMappingSetDigests(facts);
		if (recomputed.assertion_count !== record.assertion_count) {
			release_warning = `The file holds ${plural(recomputed.assertion_count, 'mapping')}; its release file says ${record.assertion_count.toLocaleString()}. The record now matches the file.`;
		} else if (recomputed.membership_digest !== record.membership_digest || recomputed.content_digest !== record.content_digest) {
			release_warning = `The file's ${plural(recomputed.assertion_count, 'mapping')} differ from what its release file describes. The record now matches the file.`;
		}
	}

	const header = record ? recordHeaderLines(record) : [];
	const body = Papa.unparse(rows, {
		columns: ['subject_id', 'predicate_id', 'object_id', 'mapping_justification', 'confidence'],
		delimiter: '\t',
		newline: '\n',
	});
	return {
		ok: true,
		sssomTsv: `${header.length ? `${header.join('\n')}\n` : ''}${body}\n`,
		rowCount: rows.length,
		release_file,
		...(release_warning ? { release_warning } : {}),
	};
}

function refusedGeneration(message: string): GenerationResult {
	return {
		success: false,
		created: [],
		upToDate: [],
		skipped: [],
		errors: [{ row: -1, message }],
		duration: 0,
		orphansChecked: false,
	};
}

/**
 * Import a typed mapping table: convert, then run the crosswalk mapping file
 * importer with the same options (destination, form, import set for refresh).
 * A refusal returns a failed generation and writes nothing. Never throws for
 * an expected refusal.
 */
export async function runImportStrm(
	app: App,
	tsvContent: string,
	companionJson: string | undefined,
	runProjection: (() => Promise<unknown>) | null,
	precomputeClosure: ((sourceOnt: string, targetOnt: string) => Promise<number>) | null,
	options: StrmImportOptions = {},
	debug?: DebugLog,
): Promise<StrmImportResult> {
	const { releaseFileName, ...sssomOptions } = options;
	const releaseFile = companionJson === undefined ? undefined : { name: releaseFileName ?? 'release file', text: companionJson };
	const conversion = strmToSssomDocument(tsvContent, releaseFile);
	if (!conversion.ok) {
		debug?.warn('strm-import', 'refused', 'Typed mapping table import refused', { message: conversion.message });
		return {
			parse: { header: {}, rows: [], warnings: [], errors: [] },
			generation: refusedGeneration(conversion.message),
			source: null,
			target: null,
			folder: null,
			unresolved: [],
			summary: [],
			mappingForm: options.mappingForm ?? 'notes',
			release_file: conversion.release_file,
		};
	}
	const result = await importSssom(app, conversion.sssomTsv, runProjection, precomputeClosure, sssomOptions, debug);
	if (conversion.release_warning && result.generation?.success) result.summary.push(conversion.release_warning);
	return {
		...result,
		release_file: conversion.release_file,
		...(conversion.release_warning ? { release_warning: conversion.release_warning } : {}),
	};
}
