/**
 * sssom-importer.ts — Phase 2 v0.1.6 (per Ch 35)
 *
 * Orchestrates SSSOM TSV import: reads file → parses → builds a synthetic
 * crosswalk-edge recipe → calls generateFromRecipe → triggers eager closure
 * precomputation in the Tier 2 sidecar.
 *
 * Architecture:
 *   Phase 1 (this importer):  TSV → SssomParseResult
 *   Phase 2 (synthetic recipe): SssomParseResult → Recipe (crosswalk-edge layout)
 *   Phase 3 (generation):     generateFromRecipe writes one .md per row to
 *                             _crosswalker/mappings/<source>-to-<target>/
 *   Phase 4 (Tier 2):         The plugin's auto-projection (per v0.1.5 P4)
 *                             picks up new junction-edge files on next run;
 *                             we ALSO trigger an immediate projection pass
 *                             so the user can query the imported data right
 *                             after import without waiting for layout-ready.
 *   Phase 5 (closure):        After mappings populate, eagerly precompute
 *                             closure for the imported (source, target)
 *                             ontology pair (per Ch 35 — "every production
 *                             ontology-web system materializes precomputed
 *                             pairwise crosswalks").
 *
 * Engine-neutrality: this importer composes existing primitives (parser,
 * recipe-driven generation, sidecar projector, closure helper). No SSSOM
 * logic leaks into Tier 2 schema or query helpers — `mappings` table is
 * already SSSOM-shaped per v0.1.5 P3.
 */

import type { App } from 'obsidian';
import type { ParsedData, GenerationResult } from '../types/config';
import { generateFromRecipe } from '../generation/generation-engine';
import { edgeEndpointIndex, resolveEdgeEndpoints, summarizeUnresolvedEndpoints, type UnresolvedEndpoint } from '../generation/edge-endpoints';
import type { Recipe } from '../render';
import type { CrosswalkPredicate } from './mapping/types';
import type { DebugLog } from '../utils/debug';
import {
	parseSssomTsv,
	detectOntologyPair,
	type SssomParseResult,
	type SssomRow,
} from './sssom-parser';
import { sha256Hex, computeRecipeHash } from '../generation/hash';
import { readNoteFrontmatterState } from '../export/vault-reader';
import {
	discoverImportSets,
	mappingFormOf,
	resolveImportSet,
	settleVaultIndex,
	type ImportSetOption,
	type ImportSetReference,
	type MappingForm,
} from '../generation/import-set';
import { buildProvenance } from '../generation/provenance';
import type { CrosswalkerProvenance } from '../generation/import-set-block';
import {
	MAPPING_TABLE_FORMAT,
	assignMappingRowIds,
	type MappingTableHeader,
	type MappingTableRow,
	type MappingTableRowFacts,
} from '../mappings/mapping-table';
import { readMappingTables } from '../mappings/mapping-table-reader';
import { mappingTablePath, mergeReviewColumns, writeMappingTable } from '../mappings/mapping-table-writer';
import manifest from '../../manifest.json';
import { SSSOM_CURIE_PREFIX, sssomEdgeCurie } from '../generation/crosswalk-identity';
export { SSSOM_CURIE_PREFIX, sssomEdgeCurie } from '../generation/crosswalk-identity';
import {
	assertionBaseKey,
	mappingOccurrenceContentKey,
	mappingSetPathKey,
	normalizeMappingSetId,
	normalizePredicateModifierInput,
} from '../utils/mapping-provenance';

/** Options accepted by importSssom(). */
export interface SssomImportOptions {
	/** Vault-relative folder for generated junction-edge notes.
	 *  Default: `_crosswalker/mappings/<source>-to-<target>/`. */
	outputFolder?: string;
	/** Override the source ontology id (default: detected from TSV header or first-row prefix). */
	sourceOntology?: string;
	/** Override the target ontology id. */
	targetOntology?: string;
	/** How to handle existing files. Default: 'replace' (idempotent re-imports). */
	overwriteMode?: 'skip' | 'replace' | 'error';
	/** Refresh an existing import set or deliberately mint a new one. */
	importSet?: ImportSetOption;
	/**
	 * Slice 3 of the mapping table form. How a NEW set stores its mappings:
	 * one note per mapping (default) or one `*.mapping-table.tsv`. A refresh must
	 * request the form its set was minted with; a mismatch is refused, because
	 * switching forms is a conversion job, never a refresh.
	 */
	mappingForm?: MappingForm;
	/** Whether to trigger Tier 2 projection + closure precompute after generation.
	 *  Default: true. Pass false in tests that don't have a sidecar handle. */
	runTier2Projection?: boolean;
	/** Optional progress callback. */
	onProgress?: (current: number, total: number, message: string) => void;
}

/** Composite result of an SSSOM import: parse result + generation result. */
export interface SssomImportResult {
	parse: SssomParseResult;
	generation: GenerationResult | null;
	source: string | null;
	target: string | null;
	folder: string | null;
	skipped?: 'parse-error' | 'no-rows';
	unresolved: UnresolvedEndpoint[];
	summary: string[];
	/** The storage form this run wrote (or would have written). */
	mappingForm?: MappingForm;
	/** Table runs only: the one file written. */
	tablePath?: string;
	/** Table runs only: rows in the written table. */
	rowsWritten?: number;
	/** Table refresh only: rows whose review columns were carried from the old file. */
	reviewCarried?: number;
	/** Table refresh only: rows in the old file the new source no longer produces. */
	rowsDropped?: number;
}

/**
 * Run an end-to-end SSSOM import: parse → generate → project → precompute closure.
 *
 * Errors flow through SssomImportResult; this function does NOT throw on
 * parse errors or generation errors (it returns them in the result so the
 * UI layer can render structured feedback).
 */
export async function importSssom(
	app: App,
	tsvContent: string,
	pluginRunProjection: (() => Promise<unknown>) | null,
	pluginPrecomputeClosure: ((sourceOnt: string, targetOnt: string) => Promise<number>) | null,
	options: SssomImportOptions = {},
	debug?: DebugLog,
): Promise<SssomImportResult> {
	// Phase 3.5c: thread a trace_id through the SSSOM import flow so the whole
	// pipeline (parse → ontology detection → synthetic recipe → generateFromRecipe
	// → Tier 2 projection → closure precompute) is correlatable via one grep.
	// If the caller already set a trace (e.g. via plugin.runImport), we reuse it.
	const existingTrace = debug?.currentTraceId();
	if (existingTrace) {
		return runImportSssom(app, tsvContent, pluginRunProjection, pluginPrecomputeClosure, options, debug);
	}
	const traceId = debug?.newTraceId();
	if (!debug || !traceId) {
		return runImportSssom(app, tsvContent, pluginRunProjection, pluginPrecomputeClosure, options, debug);
	}
	return debug.withTrace(traceId, () =>
		runImportSssom(app, tsvContent, pluginRunProjection, pluginPrecomputeClosure, options, debug),
	);
}

async function runImportSssom(
	app: App,
	tsvContent: string,
	pluginRunProjection: (() => Promise<unknown>) | null,
	pluginPrecomputeClosure: ((sourceOnt: string, targetOnt: string) => Promise<number>) | null,
	options: SssomImportOptions = {},
	debug?: DebugLog,
): Promise<SssomImportResult> {
	const result: SssomImportResult = {
		parse: { header: {}, rows: [], warnings: [], errors: [] },
		generation: null,
		source: null,
		target: null,
		folder: null,
		unresolved: [],
		summary: [],
		mappingForm: options.mappingForm ?? 'notes',
	};

	// ----- Phase 1: Parse -----
	const parsed = parseSssomTsv(tsvContent);
	result.parse = parsed;
	if (parsed.errors.length > 0) {
		result.skipped = 'parse-error';
		debug?.error('sssom-import', 'parse-aborted', 'SSSOM import aborted: parse errors', { errors: parsed.errors });
		return result;
	}
	if (parsed.rows.length === 0) {
		result.skipped = 'no-rows';
		debug?.warn('sssom-import', 'no-rows', 'SSSOM import aborted: no rows');
		return result;
	}

	// ----- Phase 2: Detect ontology pair -----
	const detected = detectOntologyPair(parsed);
	const source = options.sourceOntology ?? detected?.source;
	const target = options.targetOntology ?? detected?.target;
	if (!source || !target) {
		parsed.errors.push(
			'Could not detect SSSOM ontology pair. Add subject_source/object_source to the header or use CURIE prefixes.',
		);
		result.skipped = 'parse-error';
		return result;
	}
	result.source = source;
	result.target = target;

	// ----- Phase 3: Preflight + build synthetic recipe + generate -----
	const pairRoot = `_crosswalker/mappings/${source}-to-${target}`;
	const folder = options.outputFolder ?? pairRoot;
	result.folder = folder;
	const normalizedHeaderId = normalizeMappingSetId(parsed.header.mapping_set_id);
	const fallbackId = `urn:crosswalker:mapping-set:sha256:${sha256Hex(tsvContent)}`;
	const destinationSets = new Map<string, string>();

	const preparedRows = parsed.rows.map((row, index) => {
		const record = rowToRecord(row);
		const sssomPred = String(record.predicate_id ?? '');
		const { strm, warning } = normalizePredicate(sssomPred);
		if (warning) parsed.warnings.push(warning);
		const mappingSetId = normalizeMappingSetId(record.mapping_set_id) || normalizedHeaderId || fallbackId;
		const predicateModifier = normalizePredicateModifierInput(record.predicate_modifier);
		const baseKey = assertionBaseKey({
			subject_id: String(record.subject_id),
			predicate_id: strm,
			predicate_modifier: predicateModifier,
			object_id: String(record.object_id),
		});
		return {
			index,
			record,
			sssomPred,
			strm,
			mappingSetId,
			setPathKey: mappingSetPathKey(mappingSetId),
			predicateModifier,
			baseKey,
			occurrenceGroup: JSON.stringify([mappingSetId, baseKey]),
			contentKey: mappingOccurrenceContentKey(record),
		};
	});

	// Assign duplicate ordinals by canonical row content rather than input order.
	// Paths therefore stay stable when metadata-distinct assertions are reordered;
	// truly identical duplicates remain the indistinguishable 0001..N set.
	const occurrenceByIndex = new Map<number, number>();
	const groups = new Map<string, typeof preparedRows>();
	for (const prepared of preparedRows) {
		const group = groups.get(prepared.occurrenceGroup) ?? [];
		group.push(prepared);
		groups.set(prepared.occurrenceGroup, group);
	}
	for (const group of groups.values()) {
		group.sort((a, b) => a.contentKey.localeCompare(b.contentKey) || a.index - b.index);
		group.forEach((prepared, index) => occurrenceByIndex.set(prepared.index, index + 1));
	}

	const { index: endpointIndex, unreadable } = await edgeEndpointIndex(app);
	const rowsForRecipe = preparedRows.map((prepared) => {
		const resolved = resolveEdgeEndpoints(endpointIndex, { ...prepared.record, predicate_id: prepared.strm });
		result.unresolved.push(...resolved.unresolved);
		const occurrence = occurrenceByIndex.get(prepared.index)!;
		// Shared pair root, as before P3. A per-mapping-set subfolder would change
		// where existing notes live, and relocating them is only safe while their
		// identity is unchanged — which release isolation deliberately breaks.
		// Every mapping set shares the pair root while release isolation is held, so
		// several sets in one import is expected rather than a collision.
		return {
			...prepared.record,
			// Publisher crosswalks often carry identifiers only; optional labels must
			// still render as identifiers instead of aborting the entire import.
			subject_label: prepared.record.subject_label || prepared.record.subject_id,
			object_label: prepared.record.object_label || prepared.record.object_id,
			confidence: prepared.record.confidence ?? '',
			subject_note: resolved.subject_note,
			object_note: resolved.object_note,
			edge_body: resolved.edge_body,
			sssom_predicate: prepared.sssomPred,
			predicate_id: prepared.strm,
			mapping_provider: normalizeOptionalString(prepared.record.mapping_provider)
				|| normalizeOptionalString(parsed.header.mapping_provider),
			mapping_set_id: prepared.mappingSetId,
			predicate_modifier: prepared.predicateModifier,
		};
	});

	if (parsed.errors.length === 0) {
		await preflightMappingSetDestinations(app, destinationSets, parsed.errors);
	}
	if (parsed.errors.length > 0) {
		result.skipped = 'parse-error';
		return result;
	}

	debug?.info('sssom-import', 'pair-detected', `SSSOM ontology pair: ${source} → ${target}`, {
		source,
		target,
		folder,
		rowCount: parsed.rows.length,
	});

	result.summary = summarizeUnresolvedEndpoints(result.unresolved, unreadable);
	const recipe = buildSyntheticRecipe(source, target);

	if ((options.mappingForm ?? 'notes') === 'table') {
		const gen = await writeTableSet(app, {
			folder,
			source,
			target,
			parsed,
			rows: rowsForRecipe,
			recipe,
			sourceFileName: normalizedHeaderId || fallbackId,
			mappingSetId: normalizedHeaderId || fallbackId,
			importSet: options.importSet,
			result,
		}, debug);
		result.generation = gen;
		if (!gen.success) {
			debug?.error('sssom-import', 'table-write-failed', 'SSSOM import: mapping table write failed', { errors: gen.errors });
			return result;
		}
		await projectAndPrecompute(app, result, gen, source, target, pluginRunProjection, pluginPrecomputeClosure, options, debug);
		options.onProgress?.(parsed.rows.length, parsed.rows.length, 'SSSOM import complete');
		return result;
	}

	// The mirror guard of the table branch: a table-form set refreshed as notes
	// would gain a second storage form and a second row population.
	if (options.importSet && typeof options.importSet === 'object') {
		const existing = await resolveImportSet(app, folder, options.importSet, SSSOM_CURIE_PREFIX, undefined);
		if (mappingFormOf(existing) === 'table') {
			result.generation = failedGeneration(existing.id, `Import set ${existing.id} stores its mappings as a table. Convert the set instead of refreshing it as notes.`);
			return result;
		}
	}
	const generatedColumns = [
		'sssom_predicate',
		'mapping_set_id',
		'predicate_modifier',
	];
	const parsedData: ParsedData = {
		columns: Array.from(new Set([...collectAllColumns(parsed.rows), ...generatedColumns])),
		rows: rowsForRecipe,
		rowCount: parsed.rows.length,
	};

	options.onProgress?.(0, parsed.rows.length, `Generating ${parsed.rows.length} junction notes...`);

	const gen = await generateFromRecipe(
		app,
		parsedData,
		recipe,
		{
			basePath: folder,
			overwriteMode: options.overwriteMode ?? 'replace',
			createFolders: true,
			importSet: options.importSet,
			sourceFileName: normalizedHeaderId || fallbackId,
			strictValidation: true,
			curieLocalPart: (row, _rowNum, importSet) => sssomEdgeCurie(row, importSet),
			curiePrefix: SSSOM_CURIE_PREFIX,
			onProgress: options.onProgress,
		},
		debug,
	);
	result.generation = gen;

	if (!gen.success) {
		debug?.error('sssom-import', 'generation-failed', 'SSSOM import: generation failed', {
			errors: gen.errors,
		});
		return result;
	}

	await projectAndPrecompute(app, result, gen, source, target, pluginRunProjection, pluginPrecomputeClosure, options, debug);

	options.onProgress?.(parsed.rows.length, parsed.rows.length, 'SSSOM import complete');
	return result;
}

/**
 * Tier 2 projection, then eager closure. Shared by the note and table branches
 * so a table run settles the index and projects exactly as a note run does.
 */
async function projectAndPrecompute(
	app: App,
	result: SssomImportResult,
	gen: GenerationResult,
	source: string,
	target: string,
	pluginRunProjection: (() => Promise<unknown>) | null,
	pluginPrecomputeClosure: ((sourceOnt: string, targetOnt: string) => Promise<number>) | null,
	options: SssomImportOptions,
	debug?: DebugLog,
): Promise<void> {
	// Full projection must not read a partially indexed import. A failed or
	// deferred projection must never feed eager closure from partial data.
	let projectionReady = true;
	if (options.runTier2Projection !== false && pluginRunProjection) {
		const cold = await settleVaultIndex(app, 30_000);
		if (cold > 0) {
			projectionReady = false;
			result.summary.push(`${cold} notes are still indexing. Query results may be stale. Wait for indexing, then refresh the query database before using mapping chains.`);
			debug?.warn('sssom-import', 'projection-deferred', 'Mapping projection deferred until notes are indexed', { cold });
		} else {
			debug?.info('sssom-import', 'projection-start', 'SSSOM import: running Tier 2 projection');
			try {
				const outcome = await pluginRunProjection();
				if (outcome && typeof outcome === 'object' && 'success' in outcome && outcome.success === false) {
					projectionReady = false;
					result.summary.push('Query database projection was incomplete. Refresh the query database after indexing before using mapping chains.');
					debug?.warn('sssom-import', 'projection-incomplete', 'Mapping projection incomplete; closure was not precomputed');
				}
			} catch (err) {
				projectionReady = false;
				const msg = err instanceof Error ? err.message : String(err);
				result.summary.push('Query database projection failed. Refresh the query database after indexing before using mapping chains.');
				debug?.warn('sssom-import', 'projection-failed', 'SSSOM import: projection failed', { error: msg });
			}
		}
	}

	// ----- Phase 5: Eager closure precomputation per Ch 35 -----
	if (pluginPrecomputeClosure && projectionReady) {
		debug?.info('sssom-import', 'closure-precompute-start', 'SSSOM import: precomputing closure', { source, target });
		try {
			const cachedRows = await pluginPrecomputeClosure(source, target);
			debug?.info('sssom-import', 'closure-precomputed', `SSSOM import: closure precomputed (${cachedRows} rows)`, { cachedRows });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			gen.errors.push({ row: -1, message: `Closure precompute failed: ${msg}` });
			debug?.warn('sssom-import', 'precompute-failed', 'SSSOM import: precompute failed', { error: msg });
		}
	}
}

const PLUGIN_VERSION: string = manifest.version;

function failedGeneration(importSetId: string | undefined, message: string): GenerationResult {
	return {
		success: false,
		...(importSetId ? { importSetId } : {}),
		created: [],
		upToDate: [],
		skipped: [],
		errors: [{ row: -1, message }],
		duration: 0,
		orphansChecked: false,
	};
}

interface TableSetInput {
	folder: string;
	source: string;
	target: string;
	parsed: SssomParseResult;
	rows: Array<Record<string, unknown>>;
	recipe: Recipe;
	sourceFileName: string;
	mappingSetId: string;
	importSet?: ImportSetOption;
	result: SssomImportResult;
}

function optionalCell(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const text = String(value);
	return text === '' ? undefined : text;
}

/**
 * Slice 3 of the mapping table form. Write the whole set as one table instead of
 * one note per mapping. Never throws for an expected refusal: every refusal and
 * write failure comes back as a failed `GenerationResult`, the same channel the
 * note branch uses, so every caller keeps one success check.
 *
 * Failure modes prevented:
 * - a refresh changing a set's storage form (notes to table or back), which
 *   would leave one set with two row populations. Refused; conversion is its
 *   own job.
 * - a refresh wiping the review columns a person typed into the file. They are
 *   carried by `row_id` (`mergeReviewColumns`).
 * - a new set overwriting a different set's table that happens to sit at the
 *   same path. The new set takes a set-qualified name instead
 *   (`<stem>.<import-set-id>.mapping-table.tsv`); only a taken qualified path
 *   is refused.
 */
async function writeTableSet(app: App, input: TableSetInput, debug?: DebugLog): Promise<GenerationResult> {
	const startTime = Date.now();
	const { result } = input;
	const refresh = !!input.importSet && typeof input.importSet === 'object';
	let importSet: ImportSetReference = await resolveImportSet(
		app, input.folder, input.importSet, SSSOM_CURIE_PREFIX, undefined, 'table',
	);
	if (refresh && mappingFormOf(importSet) !== 'table') {
		// No table pin has two causes. Discovery found the set's notes: it really
		// is a notes-form set. Discovery found nothing: the set's table was
		// deleted or moved, so the owned-table lookup below names that instead of
		// telling the user to convert a set that has no notes.
		const discovered = (await discoverImportSets(app)).find((set) => set.id === importSet.id);
		if (discovered && discovered.noteCount > 0) {
			return failedGeneration(importSet.id, `Import set ${importSet.id} stores its mappings as notes. Convert the set instead of refreshing it as a table.`);
		}
		// Only reached with no notes seen; a table this set still owns (found by
		// its header below) is the table form, so the rewrite keeps the pin.
		importSet = { ...importSet, mapping_form: 'table' };
	}

	const provenance = buildProvenance(
		{
			sourceFile: input.sourceFileName,
			recipeId: input.recipe.recipe,
			recipeHash: computeRecipeHash(input.recipe.target, input.recipe.source),
			importSet,
		},
		PLUGIN_VERSION,
	) as CrosswalkerProvenance;
	const sssomHeader = input.parsed.header;
	const headerString = (key: 'mapping_provider' | 'mapping_date' | 'subject_source' | 'object_source' | 'license'): string | undefined => {
		const value = sssomHeader[key];
		return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
	};
	const header: MappingTableHeader = {
		mapping_set_id: input.mappingSetId,
		...(headerString('mapping_provider') ? { mapping_provider: headerString('mapping_provider') } : {}),
		...(headerString('mapping_date') ? { mapping_date: headerString('mapping_date') } : {}),
		...(headerString('subject_source') ? { subject_source: headerString('subject_source') } : {}),
		...(headerString('object_source') ? { object_source: headerString('object_source') } : {}),
		...(headerString('license') ? { license: headerString('license') } : {}),
		crosswalker_format: MAPPING_TABLE_FORMAT,
		import_set: importSet.id,
		source_framework: input.source,
		target_framework: input.target,
		tags: [`crosswalk/${input.source}-to-${input.target}`],
		crosswalker_provenance: provenance,
	};

	// The fields an edge note carries, from the same prepared rows the note
	// recipe would render. review_status is left unset: the note recipe stamps
	// none either (it is user_preserve only).
	const facts: MappingTableRowFacts[] = input.rows.map((row) => {
		const fact: MappingTableRowFacts = {
			subject_id: String(row.subject_id),
			predicate_id: String(row.predicate_id),
			object_id: String(row.object_id),
		};
		const cells: Array<[keyof MappingTableRowFacts, unknown]> = [
			['sssom_predicate', row.sssom_predicate],
			['mapping_justification', row.mapping_justification],
			['confidence', row.confidence],
			['subject_label', row.subject_label],
			['object_label', row.object_label],
			['subject_note', row.subject_note],
			['object_note', row.object_note],
			['mapping_provider', row.mapping_provider],
			['mapping_set_id', row.mapping_set_id],
		];
		for (const [key, value] of cells) {
			const text = optionalCell(value);
			if (text !== undefined) (fact as unknown as Record<string, unknown>)[key] = text;
		}
		if (row.predicate_modifier === 'NOT') fact.predicate_modifier = 'NOT';
		return fact;
	});
	let rows: MappingTableRow[] = assignMappingRowIds(facts, header.mapping_set_id);

	let path = mappingTablePath(input.folder, input.source, input.target);
	if (refresh) {
		const owned = (await readMappingTables(app)).filter((table) => {
			const block = table.header.crosswalker_provenance?.import_set;
			return !!block && typeof block === 'object' && (block as Record<string, unknown>).id === importSet.id;
		});
		if (owned.length !== 1) {
			return failedGeneration(importSet.id, owned.length === 0
				? `Import set ${importSet.id} has no mapping table in the vault. Import the source as a new set instead.`
				: `Import set ${importSet.id} has ${owned.length} mapping tables: ${owned.map((table) => table.path).join(', ')}. Delete or move all but one, then run the import again.`);
		}
		const [existing] = owned;
		if (existing.errors.length || existing.rowErrors.length) {
			// Rewriting would silently drop the reviews on rows that could not be read.
			const problems = [...existing.errors, ...existing.rowErrors];
			const detail = problems.length === 1 ? problems[0] : `${problems[0]} (and ${problems.length - 1} more)`;
			return failedGeneration(importSet.id, `Mapping table ${existing.path} has rows Crosswalker could not read, so refreshing it would lose their reviews. Fix or remove those rows in the file, then run the import again. Detail: ${detail}`);
		}
		const merged = mergeReviewColumns(rows, existing.rows);
		rows = merged.rows;
		result.reviewCarried = merged.carried;
		result.rowsDropped = merged.dropped;
		path = existing.path;
	} else if (app.vault.getAbstractFileByPath(path)) {
		// Two sets for the same framework pair are legitimate (release isolation is
		// a new set), so a taken default path means a set-qualified name, not a
		// refusal. A freshly minted set owns no file yet, so whatever sits at
		// either path is never this set's own table.
		path = mappingTablePath(input.folder, input.source, input.target, importSet.id);
		if (app.vault.getAbstractFileByPath(path)) {
			return failedGeneration(importSet.id, `A file already exists at ${path}, so a new mapping table cannot be written there. Rename or move that file, or choose a different folder, then run the import again.`);
		}
	}

	try {
		const written = await writeMappingTable(app, { path, header, rows });
		debug?.info('sssom-import', 'table-written', `SSSOM import: wrote mapping table ${path}`, {
			path, rows: rows.length, bytes: written.bytes, created: written.created,
		});
	} catch (error) {
		return failedGeneration(importSet.id, error instanceof Error ? error.message : String(error));
	}
	result.tablePath = path;
	result.rowsWritten = rows.length;
	return {
		success: true,
		importSetId: importSet.id,
		created: [],
		upToDate: [],
		skipped: [],
		errors: [],
		duration: Date.now() - startTime,
		orphansChecked: false,
	};
}

/**
 * Build a synthetic crosswalk-edge recipe that maps SSSOM rows to
 * junction-edge .md files. The recipe is constructed in-memory; not
 * persisted to disk. Reuses Crosswalker's existing crosswalk-edge layout
 * mechanism so render() + frontmatter-merge + Tier 1 validation all
 * work unchanged.
 */
/** The provenance hash of the effective SSSOM recipe used by importSssom. */
export function sssomRecipeDigest(source: string, target: string): string {
	const recipe = buildSyntheticRecipe(source, target);
	return computeRecipeHash(recipe.target, recipe.source);
}

function buildSyntheticRecipe(source: string, target: string): Recipe {
	// Note: template is RELATIVE to options.basePath (which is `folder`); the
	// generation engine joins them. Don't repeat `folder` here or paths
	// double-prefix.
	return {
		recipe: `sssom-${source}-to-${target}`,
		source: { ontology: source, levels: ['mapping'] },
		target: {
			layout: [
				{
					level: 'mapping',
					mechanism: 'file',
					template: '{_crosswalker_curie_local_part|slug}.md',
					kind: 'crosswalk-edge',
				},
			],
			also_emit: {
				tags: [`crosswalk/${source}-to-${target}`],
				frontmatter: {
					managed: {
						title: '{subject_id} -> {object_id}',
						// STRM predicate (Tier 1 schema-compliant; required field)
						predicate_id: '{predicate_id}',
						subject_id: '{subject_id}',
						object_id: '{object_id}',
						subject_note: '{subject_note|optional}',
						object_note: '{object_note|optional}',
						subject_label: '{subject_label}',
						object_label: '{object_label}',
						mapping_justification: '{mapping_justification}',
						mapping_provider: '{mapping_provider}',
						mapping_set_id: '{mapping_set_id}',
						predicate_modifier: '{predicate_modifier}',
						source_framework: source,
						target_framework: target,
						// Preserve the original SSSOM predicate before STRM normalization
						sssom_predicate: '{sssom_predicate}',
						// SSSOM confidence preserved as a string (Tier 1's typed
						// match_confidence requires a number; render engine emits
						// strings — leave the strictly-typed field for a follow-up
						// that adds numeric template coercion).
						sssom_confidence: '{confidence}',
					},
					user_preserve: ['review_status', 'reviewer', '*notes*'],
				},
				body: [{ template: '{edge_body}', position: 'append', format: 'text' }],
			},
		},
	};
}

/**
 * Map SSSOM/SKOS mapping predicates to Tier 1 STRM predicates per v0.1 schema.
 * STRM (NIST IR 8477) is the v0.1 crosswalk-edge predicate vocabulary; SSSOM
 * is the wire format. This normalization lets SSSOM imports populate STRM
 * frontmatter while preserving the original predicate as `sssom_predicate`.
 *
 * Direction convention (fixed 2026-06-12 — the original map inverted SKOS):
 * per the SKOS spec, `A skos:broadMatch B` states that B is the BROADER
 * concept (A "has a broader match"), i.e. A ⊂ B. STRM predicates read
 * subject-verb-object, so that edge is `A is_narrower_than B`.
 *
 * Mapping table (per SKOS Mapping Properties spec + NIST IR 8477 set theory):
 *   skos:exactMatch    → is_equivalent_to    (perfect synonym)
 *   skos:closeMatch    → is_approximate_to   (near-synonym; exchangeable in many contexts)
 *   skos:broadMatch    → is_narrower_than    (object is broader ⇒ subject ⊂ object)
 *   skos:narrowMatch   → is_broader_than     (object is narrower ⇒ subject ⊃ object)
 *   skos:relatedMatch  → intersects_with     (overlapping concepts)
 *
 * Unknown predicates fall back to `intersects_with` with a warning logged.
 */
const SKOS_TO_STRM: Record<string, CrosswalkPredicate> = {
	'skos:exactMatch': 'is_equivalent_to',
	'skos:closeMatch': 'is_approximate_to',
	'skos:broadMatch': 'is_narrower_than',
	'skos:narrowMatch': 'is_broader_than',
	'skos:relatedMatch': 'intersects_with',
};

/** The inverse of the single SKOS→STRM table used by SSSOM normalization. */
export function strmToSkos(predicate: CrosswalkPredicate): string {
	const match = Object.entries(SKOS_TO_STRM).find(([, strm]) => strm === predicate);
	if (!match) throw new Error(`No SSSOM predicate is registered for ${predicate}.`);
	return match[0];
}

function normalizePredicate(sssomPredicate: string): { strm: string; warning?: string } {
	const strm = SKOS_TO_STRM[sssomPredicate];
	if (strm) return { strm };
	// Unknown predicate — fall back to intersects_with (the most permissive STRM
	// predicate) and surface a warning so the user knows the mapping is approximate.
	return {
		strm: 'intersects_with',
		warning: `Unknown SSSOM predicate "${sssomPredicate}"; normalized to STRM "intersects_with". Add a SKOS→STRM mapping if this is wrong.`,
	};
}

function normalizeOptionalString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * Refuse to import into a destination already holding edges from a different
 * mapping set.
 *
 * Pass-9 secondary finding, closed 2026-08-31: this read the metadata cache and
 * nothing else, so a crosswalk note Obsidian had not reached yet answered "no
 * frontmatter", was skipped, and a guard whose entire purpose is to REFUSE a
 * mismatch passed silently. Absence read as fact, inside a guard - the failure
 * this project has now shipped fixes for six times.
 *
 * The raw read is bounded to files under the destination prefixes, exactly as
 * `collectObservations` bounds its own fallback, so a cold cache costs a read
 * per candidate note rather than a whole-vault content scan.
 */
async function preflightMappingSetDestinations(
	app: App,
	destinationSets: Map<string, string>,
	errors: string[],
): Promise<void> {
	const getMarkdownFiles = app.vault.getMarkdownFiles?.bind(app.vault);
	if (!getMarkdownFiles) return;
	const files = getMarkdownFiles();
	for (const [leaf, expectedId] of destinationSets) {
		const prefix = `${leaf.replace(/\/+$/, '')}/`;
		for (const file of files) {
			if (!file.path.startsWith(prefix)) continue;
			let fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
			if (!fm) {
				const read = await readNoteFrontmatterState(app, file);
				if (read.state === 'unreadable') {
					// Not "no mapping set id" and not "a different one": nothing is
					// known. A note in the destination that cannot be read is a reason
					// to stop, not a reason to proceed.
					errors.push(
						`Crosswalker could not read the properties of ${file.path} in destination ${leaf}, `
						+ 'so it could not confirm the destination is safe to import into. '
						+ "Fix that note's properties block, then import again.",
					);
					continue;
				}
				if (read.state === 'none') continue;
				fm = read.frontmatter;
			}
			if (fm.kind !== 'crosswalk-edge') continue;
			const storedId = normalizeMappingSetId(fm.mapping_set_id);
			if (storedId !== expectedId) {
				errors.push(
					`Destination ${leaf} contains crosswalk note ${file.path} with missing or different mapping_set_id.`,
				);
			}
		}
	}
}

/** Convert a SssomRow to a plain Record for the generation engine. */
function rowToRecord(row: SssomRow): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(row)) {
		if (v === undefined) continue;
		out[k] = v;
	}
	return out;
}

/** Collect the union of all column keys present across all rows. */
function collectAllColumns(rows: SssomRow[]): string[] {
	const cols = new Set<string>();
	for (const row of rows) {
		for (const k of Object.keys(row)) cols.add(k);
	}
	return Array.from(cols);
}
