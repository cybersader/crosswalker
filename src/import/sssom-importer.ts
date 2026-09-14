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
import type { Recipe } from '../render';
import type { DebugLog } from '../utils/debug';
import {
	parseSssomTsv,
	detectOntologyPair,
	type SssomParseResult,
	type SssomRow,
} from './sssom-parser';
import { sha256Hex } from '../generation/hash';
import { readNoteFrontmatterState } from '../export/vault-reader';
import { derivationOf, type ImportSetOption, type ImportSetReference } from '../generation/import-set';
import { injectiveEndpointToken } from '../generation/curie';
import {
	assertionBaseKey,
	mappingOccurrenceContentKey,
	mappingSetPathKey,
	normalizeMappingSetId,
	normalizePredicateModifierInput,
} from '../utils/mapping-provenance';

/**
 * The curie prefix every SSSOM crosswalk edge is minted under, whatever the
 * ontology pair. Named once (AM-18, 2026-08-31) because it is what any caller
 * asking "would a new set here collide" has to compare against: the SSSOM path
 * overrides the engine's ontology-derived prefix with this literal, so the
 * ontology pair is NOT the identity space these edges occupy.
 */
export const SSSOM_CURIE_PREFIX = 'sssom';

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

	const rowsForRecipe = preparedRows.map((prepared) => {
		const occurrence = occurrenceByIndex.get(prepared.index)!;
		// Shared pair root, as before P3. A per-mapping-set subfolder would change
		// where existing notes live, and relocating them is only safe while their
		// identity is unchanged — which release isolation deliberately breaks.
		// Every mapping set shares the pair root while release isolation is held, so
		// several sets in one import is expected rather than a collision.
		return {
			...prepared.record,
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

	const recipe = buildSyntheticRecipe(source, target);
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

	// ----- Phase 4: Trigger Tier 2 projection -----
	// Re-projects newly-written junction-edge .md files into the `mappings` table.
	// pluginRunProjection is the plugin.runProjection handle; null in tests.
	if (options.runTier2Projection !== false && pluginRunProjection) {
		debug?.info('sssom-import', 'projection-start', 'SSSOM import: running Tier 2 projection');
		try {
			await pluginRunProjection();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			gen.errors.push({ row: -1, message: `Tier 2 projection failed: ${msg}` });
			debug?.warn('sssom-import', 'projection-failed', 'SSSOM import: projection failed', { error: msg });
		}
	}

	// ----- Phase 5: Eager closure precomputation per Ch 35 -----
	if (pluginPrecomputeClosure) {
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

	options.onProgress?.(parsed.rows.length, parsed.rows.length, 'SSSOM import complete');
	return result;
}

/**
 * Build a synthetic crosswalk-edge recipe that maps SSSOM rows to
 * junction-edge .md files. The recipe is constructed in-memory; not
 * persisted to disk. Reuses Crosswalker's existing crosswalk-edge layout
 * mechanism so render() + frontmatter-merge + Tier 1 validation all
 * work unchanged.
 */
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
const SKOS_TO_STRM: Record<string, string> = {
	'skos:exactMatch': 'is_equivalent_to',
	'skos:closeMatch': 'is_approximate_to',
	'skos:broadMatch': 'is_narrower_than',
	'skos:narrowMatch': 'is_broader_than',
	'skos:relatedMatch': 'intersects_with',
};

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

/**
 * Stable CURIE local-part for one SSSOM edge, dispatched by the active set's
 * scheme. endpoint-v1 remains byte-for-byte `cw-<subject>-<object>`.
 * set-qualified-v1 is exactly
 * `cwset-<import-set-id>-<sanitized-subject>-<sanitized-object>`: the `cwset-`
 * marker makes it visibly distinct, the minted set id isolates releases, and
 * endpoint sanitization keeps the deterministic result filesystem-safe.
 */
export function sssomEdgeCurie(
	row: Record<string, unknown>,
	importSet: ImportSetReference,
): string {
	// AM-27. The endpoint sanitizer is part of the identity, so which one runs is
	// the SET's pinned derivation, not this version's preference. Under the legacy
	// pin the collapsing form below is reproduced byte-for-byte, because it is what
	// every junction note already in a vault carries.
	const sanitize = derivationOf(importSet) === 'declared-facts-v1'
		? injectiveEndpointToken
		: legacySanitizeCuriePart;
	const subj = sanitize(String(row.subject_id ?? 'unknown'));
	const obj = sanitize(String(row.object_id ?? 'unknown'));
	if (importSet.scheme === 'endpoint-v1') return `cw-${subj}-${obj}`;
	if (importSet.scheme === 'set-qualified-v1') return `cwset-${importSet.id}-${subj}-${obj}`;
	const exhaustive: never = importSet.scheme;
	throw new Error(`Unsupported import set scheme: ${String(exhaustive)}.`);
}

/**
 * AM-27. `filename-stem-v1` only. FROZEN.
 *
 * Many-to-one: `NIST:AC-2` and `NIST/AC-2` and `NIST AC 2` all become
 * `NIST-AC-2`, so two SSSOM rows mapping different endpoints produce one edge
 * identity, and the second row silently replaces the first's assertion. Kept
 * unchanged anyway - it is a record of what is in people's vaults, and changing
 * it would re-identify every junction note ever imported. New sets get
 * `injectiveEndpointToken`, which keeps the same readable shape and appends a
 * digest of the exact endpoint whenever a character had to be replaced.
 */
function legacySanitizeCuriePart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]+/g, '-');
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
