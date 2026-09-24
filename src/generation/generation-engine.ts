/**
 * Generation Engine
 *
 * Creates folders and notes in the vault based on parsed data and configuration.
 *
 * Key design decisions (see https://cybersader.github.io/crosswalker/concepts/ontology-evolution/):
 * - Include `_crosswalker` metadata block in generated notes
 * - Track `importedProperties` for safe reimport
 * - Use `sourceId` as canonical identifier
 * - Default to "skip existing" behavior
 * - Store `frameworkId` for future cross-framework features
 */

import { App, TFile, TFolder, normalizePath, Notice } from 'obsidian';
import {
	ParsedData,
	ImportRecipe,
	GenerationResult,
	GenerationError,
	MappingConfig,
	HierarchyMapping,
	FrontmatterMapping,
	BodyMapping,
	LinkMapping
} from '../types/config';
import { DebugLog } from '../utils/debug';
import {
	render,
	RenderError,
	renderTemplate,
	type Recipe,
	type RenderedBodyRegion,
	type RenderReport,
	type SourceScope,
} from '../render';
import { legacyConfigToRecipe, LEGACY_ONTOLOGY_SENTINEL } from './legacy-recipe-shim';
// AM-28. `DeclaredCurieCharsetError` / `DeclaredCuriePrefixError` are thrown by
// `declaredCurieLocalPart` and are deliberately NOT caught by name here: both row
// loops already catch per row and push the message into `result.errors`, which is
// the actionable refusal the amendment asks for. Naming them would add a second
// place for the refusal wording to drift.
import {
	declaredCurieLocalPart,
	declaredIdentity,
	edgeIdentityLocalPart,
	injectiveCurieLocalPart,
	injectiveDeclaredIdLocalPart,
	pathIdentityLocalPart,
	slugifyForCurie,
} from './curie';
import { mergeFrontmatter, computeDeclaredManagedKeys, computeManagedKeys } from './frontmatter-merge';
import { buildIdentityIndex, type IdentityIndex } from './identity-index';
// S12 (2026-09-04). The AM-45 mirror, so a recorded layout value and the
// directory segment it produced are compared after the SAME four mutations the
// path itself received. Comparing raw would call an honest hub misplaced.
import { normalizedPathPieces } from '../render/vault-path';
// S16: the ONE spelling of a folder a person typed. See `normalizeBasePath`.
import { normalizeFolderSetting } from '../settings/folder-settings';
// AM-33: the tri-state note read, for the hub value index's cache-cold fallback.
import { readNoteFrontmatterState, type NoteFrontmatterRead } from '../export/vault-reader';
import { buildProvenance } from './provenance';
import { derivationOf, resolveImportSet, type ImportSetDerivation, type ImportSetOption, type ImportSetReference } from './import-set';
import { SSSOM_CURIE_PREFIX, sssomEdgeCurie } from './crosswalk-identity';
import {
	computeConceptCid,
	computeRecipeHash,
	computeReviewCid,
	computeReviewGroupCids,
	identityScopeForNoteKind,
	readReviewGroupCids,
	type ReviewGroupCids,
} from './hash';
import { reviewedAgainstFor } from '../views/evidence-link';
import { prepareSourceStage, SourceStageError, type SourceStage } from '../source';
import { SourceOrderStamper, stripBasePath, shouldStampSourceOrder } from './source-order';
import { validateTier1Frontmatter } from '../validation/validator';
import {
	enrich,
	folderNoteCandidatePath,
	buildManagedChildrenSection,
	mergeManagedChildrenSection,
	ensureWaypointMarker,
	// AM-73. The ONE shape test for "is this recorded curie this import's". Shared
	// with the derivation so the two cannot disagree.
	isCurieOfOntology,
	type EnrichNote,
	type HubNote,
	type LayoutValue,
	type OwnedHubAtFolder,
	type OwnedHubsByFolder,
} from './enrich';
import { wrapManagedBody, scanRegions, findSpan, replaceRegion } from './managed-body';
// AM-75. `splitNoteText` is THE one reader that knows where a note's frontmatter
// ends. The held-host writer works on raw bytes and must agree with it exactly,
// so it asks that reader rather than carrying a second copy of the fence rule.
import { mergeExistingNote, readExistingNote, splitNoteText, ExistingNoteReadError } from './existing-note';
import type { FacetMembership } from '../import/mapping/facets';
import type { CrosswalkColumnEntry, NestedRecordLevel } from '../types/generated/recipe';
import { normalizeMappingSetId, normalizePredicateModifierInput } from '../utils/mapping-provenance';
import {
	runCrosswalkEdgePass,
	type CrosswalkEdgeInput,
} from './crosswalk-edge-pass';

// ============================================================================
// Types
// ============================================================================

/**
 * Crosswalker metadata stored in each generated note.
 * Enables safe reimport, tracking, and future cross-framework features.
 */
export interface CrosswalkerMetadata {
	/** ID from source data - canonical identifier */
	sourceId: string;

	/** Framework identifier (from config) */
	frameworkId?: string;

	/** Framework version if specified */
	frameworkVersion?: string;

	/** Unique ID for this import operation */
	importId: string;

	/** Config ID used for this import */
	configId?: string;

	/** Schema version of this metadata structure */
	schemaVersion: number;

	/** ISO timestamp when note was created/updated */
	importedAt: string;

	/** List of property keys that were imported (vs user-added) */
	importedProperties: string[];

	/** Source file this data came from */
	sourceFile?: string;

	/** Row number in source (for debugging) */
	sourceRow?: number;
}

export interface GenerationTier2Hooks {
	runProjection: (() => Promise<unknown>) | null;
	precomputeClosure: ((source: string, target: string) => Promise<number>) | null;
}

export interface GenerationOptions {
	/** Base path for output (e.g., "Ontologies/MyFramework") */
	basePath: string;

	/** Import-set selection from the review step. Absent applies destination discovery. */
	importSet?: ImportSetOption;

	/** How to handle existing files */
	overwriteMode: 'skip' | 'replace' | 'error';

	/** Whether to create folders that don't exist */
	createFolders: boolean;

	/** Framework name for _crosswalker metadata */
	frameworkId?: string;

	/** Framework version */
	frameworkVersion?: string;

	/** Config ID (if using saved config) */
	configId?: string;

	/** Source file name */
	sourceFileName?: string;

	/** Tier 2 handles used after a declared crosswalk edge pass. */
	tier2?: GenerationTier2Hooks;

	/**
	 * Already-translated source predicate for this run. A nonblank value replaces
	 * the resolved recipe's source.where without mutating the caller's recipe;
	 * blank leaves a canonical predicate untouched.
	 */
	sourceWhere?: string;

	/** Progress callback */
	onProgress?: (current: number, total: number, message: string) => void;

	/** Max note writes in flight at once (default DEFAULT_CONCURRENCY). 1 = sequential. */
	concurrency?: number;

	/**
	 * A pre-built Recipe to render with, bypassing the legacy column-role shim.
	 * The shape workbench (a first-class Tier 1 producer, commitment #1) emits a
	 * real recipe via `toRecipeRegions`; folders / files / headings / variadic /
	 * managed frontmatter / managed wikilinks all flow through render() faithfully
	 * rather than being squeezed through `legacyConfigToRecipe`, which cannot
	 * express variadic folders or nested tags. When set, `config.mapping` is still
	 * used for legacy body content only.
	 */
	recipeOverride?: import('../render').Recipe;

	/**
	 * Mapping-driven facet memberships for a row (spec §7k) — used by the Pass 1.5
	 * enrichment pass to materialize facet hub notes with their ORIGINAL-case display
	 * names. When omitted, memberships are derived from the rendered (tagsafe) facet
	 * tags, which lose original casing. The workbench supplies this from its live
	 * mapping via `deriveFacetMemberships(mapping, row)`. Consumed on the enrichment
	 * path (when the recipe declares `target.enrichment`).
	 */
	facetsForRow?: (row: Record<string, unknown>, rowNum: number) => import('../import/mapping/facets').FacetMembership[];

	/**
	 * If true, abort on the first row whose rendered frontmatter fails Tier 1
	 * schema validation. Mirrors `RecipeImportOptions.strictValidation`
	 * (`generateFromRecipe`) — see M1, 2026-07-12 pre-merge review:
	 * `generateNotes` (the wizard/workbench entry point) never ran Tier 1
	 * validation at all before this option was added. Default: true, matching
	 * `generateFromRecipe` exactly so both entry points enforce the
	 * architectural commitment "schema-as-primitive" identically.
	 */
	strictValidation?: boolean;
}

interface GeneratedNoteData {
	path: string;
	frontmatter: Record<string, any>;
	body: string;
	sourceRow: number;
}

// ============================================================================
// Pass 1.5 batch enrichment — shared between generateNotes and
// generateFromRecipe (v0.1.6.1 — 2026-07-11)
// ============================================================================

/**
 * One lightweight record per written note, collected during EITHER write loop
 * (`generateNotes`'s legacy/workbench path or `generateFromRecipe`'s native
 * path) so the shared post-stream enrichment phase (`applyEnrichment` below)
 * can derive parent→children lists + facet hub notes without re-reading the
 * vault. Only collected when the effective recipe declares `target.enrichment`.
 */
interface EnrichRecord extends EnrichNote {
	body: string;
}

/**
 * Minimal shape `applyEnrichment` needs to place facet hub notes and stamp
 * provenance — a structural subset both `GenerationOptions` and
 * `RecipeImportOptions` satisfy, so the same enrichment phase can run after
 * either write loop without those two option shapes needing to unify.
 */
interface EnrichmentWriteOptions {
	basePath: string;
	sourceFileName?: string;
	sourceVersion?: string;
	/** Complete pre-parse source-byte digest associated with this ParsedData. */
	sourceHash?: string;
	/**
	 * Carried in so the enrichment phase can honour `skip` on its own. A hub
	 * relocation is a change to the vault, and `skip` means leave existing notes
	 * alone; the row loops already gate their moves on this, and the enrichment
	 * phase must not be the one place whose safety depends on the caller having
	 * chosen a destination that never asks for a move.
	 */
	overwriteMode?: 'skip' | 'replace' | 'error';
}

function declaredCrosswalks(recipe: Recipe): CrosswalkColumnEntry[] {
	return (recipe.target as Recipe['target'] & { crosswalks?: CrosswalkColumnEntry[] }).crosswalks ?? [];
}

async function applyDeclaredCrosswalks(
	app: App,
	recipe: Recipe,
	sourceOntology: string,
	inputs: CrosswalkEdgeInput[],
	producerSetId: string,
	options: Pick<GenerationOptions, 'sourceFileName' | 'overwriteMode' | 'onProgress' | 'tier2'>,
	result: GenerationResult,
	debug?: DebugLog,
): Promise<void> {
	const entries = declaredCrosswalks(recipe);
	if (entries.length === 0) return;

	result.crosswalkEdges = { created: 0, sets: [] };
	if (!result.success || result.errors.length > 0) {
		const failedRows = new Set(result.errors.filter((error) => error.row >= 0).map((error) => error.row)).size
			|| result.errors.length;
		result.warnings ??= [];
		result.warnings.push({
			row: -1,
			message: `Crosswalk edges were not written because ${failedRows} rows failed. Fix the rows and run the import again.`,
		});
		return;
	}

	const pass = await runCrosswalkEdgePass(app, {
		entries,
		sourceOntology,
		recipeId: recipe.recipe,
		producerSetId,
		sourceFileName: options.sourceFileName,
		inputs,
		overwriteMode: options.overwriteMode,
		runProjection: options.tier2?.runProjection,
		precomputeClosure: options.tier2?.precomputeClosure,
		onProgress: options.onProgress,
	}, debug);
	result.crosswalkEdges = {
		created: pass.totalCreated,
		sets: pass.perEntry
			.map((entry) => entry.importSetId)
			.filter((id): id is string => id !== null),
		summary: pass.summary,
	};
	if (pass.errors.length > 0) {
		result.errors.push(...pass.errors.map((error) => ({ row: -1, message: error.message })));
		result.success = false;
	}
}

// Current schema version for _crosswalker metadata
const CROSSWALKER_METADATA_VERSION = 1;

// ============================================================================
// Concurrency infrastructure (v0.1.6 — 2026-06-13)
// ============================================================================

/** Default number of note writes kept in flight at once. Vault writes are
 *  I/O-bound, so a moderate pool gives a large wall-clock win over awaiting
 *  one at a time, without overwhelming Obsidian's metadata cache. */
export const DEFAULT_CONCURRENCY = 8;

/**
 * Drive a worker over a sync OR async iterable with a bounded number of
 * concurrent invocations (a sliding window). Items are PULLED in order and
 * each worker's synchronous prefix runs in order (JS is single-threaded), so
 * any in-prefix bookkeeping — e.g. path-collision reservation — stays
 * deterministic by item order even though the async tails overlap.
 */
export async function forEachConcurrent<T>(
	source: Iterable<T> | AsyncIterable<T>,
	limit: number,
	worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
	const asyncFactory = (source as AsyncIterable<T>)[Symbol.asyncIterator];
	const it: Iterator<T> | AsyncIterator<T> = asyncFactory
		? asyncFactory.call(source)
		: (source as Iterable<T>)[Symbol.iterator]();
	let index = 0;
	let drained = false;
	const active = new Set<Promise<void>>();

	const fill = async () => {
		while (active.size < limit && !drained) {
			const next = await it.next(); // works for sync + async iterators
			if (next.done) { drained = true; break; }
			const idx = index++;
			const p = Promise.resolve(worker(next.value, idx)).finally(() => active.delete(p));
			active.add(p);
		}
	};

	await fill();
	while (active.size > 0) {
		await Promise.race(active);
		await fill();
	}
}

/**
 * Folder-creation de-duplicator for concurrent writes. Without this, two notes
 * destined for the same new folder would both see "doesn't exist" and both call
 * createFolder → one throws "already exists". Each path (and its ancestors) is
 * created exactly once; concurrent callers await the same promise.
 */
export function createFolderEnsurer(app: App): (path: string) => Promise<void> {
	const cache = new Map<string, Promise<void>>();
	const ensure = (path: string): Promise<void> => {
		if (!path) return Promise.resolve();
		const cached = cache.get(path);
		if (cached) return cached;
		const promise = (async () => {
			const parent = getParentPath(path);
			if (parent) await ensure(parent);
			const normalized = normalizePath(path);
			if (!app.vault.getAbstractFileByPath(normalized)) {
				try {
					await app.vault.createFolder(normalized);
				} catch {
					// A concurrent create won the race — the folder now exists,
					// which is exactly what we wanted. Swallow.
				}
			}
		})();
		cache.set(path, promise);
		return promise;
	};
	return ensure;
}

// ============================================================================
// Main Generation Function
// ============================================================================

/**
 * AM-49 (2026-09-04). THE IMPORT ROOT, NORMALIZED ONCE, AT THE ENGINE BOUNDARY.
 *
 * `options.basePath` is a raw user string: the wizard hands over the text of an
 * input field, and a recorded destination is whatever was typed the first time.
 * Every note path this engine writes goes through the host's `normalizePath`,
 * which collapses separators and backslashes, strips edge separators, folds
 * `U+00A0`/`U+202F` to an ordinary space, and normalizes to NFC. The root did
 * not, and the root is what the enrichment pass compares those paths AGAINST.
 *
 * Failure mode prevented: an output folder pasted with a non-breaking space (or
 * carrying a decomposed accent, a backslash, or an internal `//`) made the root
 * a different string from the prefix of every note path. `rootIsTrackedAncestor`
 * then went false, the root stopped being stripped, every layout value
 * disagreed with its segment at index 0, AM-44 refused EVERY level hub in the
 * import, and because a refused hub's curie never reaches `producedCuries` the
 * orphan pass reported every hub the set owns as an orphan. The deviation
 * blamed the recipe and the source row; the character was in the destination
 * folder the user typed.
 *
 * The rule this exists to keep, in one sentence: a normalization applied to
 * what you record must be applied to what you compare it against, and the
 * boundary is ONE CALL SITE, not one sweep. So the value returned here is the
 * one string every consumer sees: `fullPath` composition, `rootFolder:` at both
 * enrichment call sites, ownership resolution, folder creation, and the
 * orphan/refresh scans all read `options.basePath` and all now read this.
 *
 * Emptiness is preserved rather than normalized away: `normalizePath('')` is
 * `'/'` on the host, which is truthy, and every `options.basePath ? ...` branch
 * in this engine reads a falsy base as "write at the vault root". Both
 * spellings of the root ('' and '/') therefore come back as ''.
 */
function normalizeBasePath(basePath: string): string {
	// S16 (2026-09-04). ONE SPELLING, not a third copy of its body. This function
	// reproduced `normalizeFolderSetting` line for line, on the host instead of the
	// mirror, and a copy is a second answer waiting to drift from the first: the
	// destination the wizard compares against the vault and the destination the
	// engine writes to would then be two different strings for one folder. AM-58
	// made the mirror host-free, so the parity risk is removed rather than pinned.
	// The host's own `normalizePath` stays only where the engine hands a path to
	// the vault, applied to an already-normalized string.
	return normalizeFolderSetting(basePath);
}

/**
 * Generate notes from parsed data using the provided configuration.
 */
export async function generateNotes(
	app: App,
	parsedData: ParsedData,
	config: Partial<ImportRecipe>,
	rawOptions: GenerationOptions,
	debug?: DebugLog
): Promise<GenerationResult> {
	// AM-49. The boundary. Everything below reads `options`, so the normalized
	// root is the only root this run has; there is no second spelling to diverge.
	const options: GenerationOptions = { ...rawOptions, basePath: normalizeBasePath(rawOptions.basePath) };
	const startTime = Date.now();
	const result: GenerationResult = {
		success: true,
		created: [],
		skipped: [],
		errors: [],
		duration: 0,
		// AM-7. Starts FALSE, not absent. A run that throws before the orphan pass
		// checked nothing, and a reader must not read that silence as `no orphans`.
		// The orphan pass below sets it true only when it actually ran.
		orphansChecked: false,
	};

	const importId = generateImportId();
	// M1 (2026-07-12 pre-merge review): mirrors generateFromRecipe's `strict`
	// default exactly (RecipeImportOptions.strictValidation ?? true).
	const strict = options.strictValidation ?? true;

	debug?.info('generation', 'start', `Starting generation of ${parsedData.rowCount} rows`, {
		rowCount: parsedData.rowCount,
		basePath: options.basePath,
		overwriteMode: options.overwriteMode,
		configId: options.configId
	});

	try {
		// Validate configuration
		const mapping = config.mapping;
		if (!mapping) {
			throw new Error('No mapping configuration provided');
		}

		// v0.1.3: translate the legacy v0.1.0 config shape into a Ch 22 Recipe
		// once before the per-row loop. The recipe is what render() consumes.
		// The shape workbench passes a pre-built recipe (recipeOverride) so its
		// full mechanism set survives; otherwise the legacy shim translates.
		// AM-1: the source file name reaches the shim so a nameless classic import
		// stamps its file stem as the ontology instead of the `unknown` sentinel.
		// Failure mode prevented: every nameless classic import sharing one
		// placeholder identity, which makes two unrelated frameworks look like
		// the same source.
		//
		// AM-6 moved this ABOVE ownership resolution: the ontology this source
		// proposes is an input to resolving the set, because a set that already
		// exists overrides the proposal with the ontology it is pinned to.
		const resolvedRecipe = options.recipeOverride
			?? legacyConfigToRecipe(config as ImportRecipe, { sourceFileName: options.sourceFileName });
		// A wizard filter is a RUN override, not a second recipe entry path. Apply
		// it only after the canonical-or-legacy recipe choice so recipeOverride still
		// controls provenance ownership below. Copy both objects so joins and any
		// source fields this engine does not interpret survive without mutating the
		// caller's canonical recipe. Blank means no override at all.
		const recipe = options.sourceWhere?.trim()
			? {
				...resolvedRecipe,
				source: { ...resolvedRecipe.source, where: options.sourceWhere },
			}
			: resolvedRecipe;
		// Compute recipe ownership once and reuse the exact value written to
		// `_crosswalker.recipe.id`; orphan detection must never invent a different
		// ownership key from the provenance stored on notes.
		const provenanceRecipeId = options.recipeOverride
			? recipe.recipe
			: (options.configId ?? recipe.recipe);
		// Crosswalk identity belongs to the note kind, not to the source label. A
		// refresh still wins through the import set's pinned ontology below.
		const recipeNoteKind = noteKindOf(recipe);
		const proposedOntologyId = recipeNoteKind === 'crosswalk-edge'
			? SSSOM_CURIE_PREFIX
			: recipe.source?.ontology ?? (config.name ?? LEGACY_ONTOLOGY_SENTINEL);

		// Ownership is minted or selected once per run, before any note is written.
		// Never derive this id from recipe/source/path: all are allowed to change on
		// a legitimate refresh, while the import set must remain the same.
		const importSet = await resolveImportSet(app, options.basePath, options.importSet, proposedOntologyId, recipe.source?.nest);
		if (recipe.source?.nest && derivationOf(importSet) !== 'declared-facts-v1') {
			result.errors.push({
				row: 0,
				message: 'Nested records need the declared-facts identity rule. This import set was minted under filename-stem-v1; import into a new set.',
				declaration: 'source.nest',
			});
			result.success = false;
			result.duration = Date.now() - startTime;
			return result;
		}

		const impliedPinError = impliedIdentityPinError(recipe, importSet);
		if (impliedPinError) {
			result.errors.push({ row: 0, message: impliedPinError, declaration: 'target.layout' });
			result.success = false;
			result.duration = Date.now() - startTime;
			return result;
		}
		const nestIdentityMismatch = nestedIdentityPinMismatch(recipe.source?.nest, importSet);
		if (nestIdentityMismatch) {
			result.errors.push({
				row: 0,
				message: nestIdentityMismatch.message,
				declaration: nestIdentityMismatch.declaration,
			});
			result.success = false;
			result.duration = Date.now() - startTime;
			return result;
		}

		// Snapshot this set's PRE-RUN membership. Metadata-cache updates are not
		// guaranteed to land before generation completes, and orphan reporting asks
		// what the set owned before this run, not what the cache happens to expose
		// after writes. recipeId stays as the deprecated grace parameter; the
		// import-set filter takes precedence, so unstamped legacy notes stay outside.
		const ownedIdentityIndex = await buildIdentityIndex(app, {
			importSetId: importSet.id,
			recipeId: provenanceRecipeId,
		});
		// Authority for which frontmatter keys this run OWNS comes from the recipe's
		// declaration, not from which keys happened to render non-empty for a row.
		// Without this, a declared field that renders empty is absent from managedKeys,
		// so the merge below mistakes the stale previous value for user content and
		// keeps it forever - which silently inverts a predicate_modifier of NOT.
		const declaredManagedKeys = computeDeclaredManagedKeys(recipe.target.also_emit?.frontmatter);
		// One pass over the vault's markdown list, reading Obsidian's existing metadata
		// cache. Lets every row below find its note by identity instead of by address.
		const identityIndex = await buildIdentityIndex(app);
		if (identityIndex.collisions.length > 0) {
			// Two notes claiming one concept is ambiguous. Choosing a winner silently is
			// how a duplicate becomes permanent, so report and let the caller decide.
			for (const c of identityIndex.collisions) {
				result.errors.push({ row: 0, message: `Ambiguous identity ${c.curie} claimed by: ${c.paths.join(', ')}` });
			}
		}

		// _crosswalker.recipe.hash: computed ONCE per generation run (the
		// recipe's target doesn't change per-row) and threaded through every
		// buildProvenance call this run makes — see src/generation/hash.ts.
		// `recipe.source` is passed at every call site so one recipe hashes to
		// one value no matter which code path computed it.
		const recipeHash = computeRecipeHash(recipe.target, recipe.source);

		// Track paths emitted in THIS generation pass to detect collisions
		// (two source rows rendering to the same vault path).
		const emittedPaths = new Set<string>();
		const producedCuries = new Set<string>();
		// AM-27. Which ROW produced each curie, so the duplicate refusal can name
		// both claimants. `producedCuries` alone cannot: it also carries the hub
		// identities enrichment implies, which have no row.
		const curieOrigins = new Map<string, ProducedCurieOrigin>();
		const rowTakenOverImplied = new Map<string, string>();
		const sourceOrderStamper = new SourceOrderStamper();

		// Pass 1.5 enrichment (v0.1.6.1): the wizard/workbench path shares the
		// SAME enrichment phase generateFromRecipe uses (see applyEnrichment
		// below) — children lists, facet hub notes, and edgeCount are no longer
		// exclusive to the native-recipe path. `ontologyId` mirrors
		// generateFromRecipe's `recipe.source?.ontology ?? recipe.recipe`
		// priority, falling back to the legacy config name (what buildNoteData
		// ViaRender already used before this change, so per-row curies are
		// unaffected when the recipe carries no `source.ontology`, e.g. the
		// workbench recipe today).
		const enrichmentEnabled = recipeNeedsEnrichment(recipe);
		// AM-6. The SET decides the ontology, not the run. A refresh that
		// recomputed this from its own recipe could land on a different answer
		// (a renamed config, a differently named export file), and every curie it
		// then wrote would match none of the notes the set already owns: a second
		// copy of the whole framework, with every original reported as an orphan.
		// A set with no pin (legacy, or genuinely new) falls back to the proposal.
		const ontologyId = importSet.ontology ?? proposedOntologyId;
		// AM-13. The SET's scheme decides the identity space, not just the ontology.
		// A set minted set-qualified writes qualified curies for its concepts and
		// for every hub enrichment derives from this prefix, which is what lets a
		// second release of the same framework exist beside the first.
		const curiePrefix = recipeNoteKind === 'crosswalk-edge'
			? slugifyForCurie(ontologyId)
			: curiePrefixFor(importSet, ontologyId);
		// Crosswalk release isolation lives in the edge local-part (`cwset-...`),
		// while other note kinds qualify the prefix itself.
		const basePrefix = recipeNoteKind === 'crosswalk-edge'
			? slugifyForCurie(ontologyId)
			: baseCuriePrefixFor(importSet, ontologyId);
		const crosswalkInputs: CrosswalkEdgeInput[] | null = declaredCrosswalks(recipe).length > 0 ? [] : null;
		const enrichRecords: EnrichRecord[] = [];
		// AM-2. Rows this run KEPT rather than wrote (overwriteMode 'skip').
		//
		// Failure mode prevented: a skip refresh orphaning every hub the set owns.
		// A skipped row is still a row this run vouches for, but the skip branch
		// returns above the enrichment bookkeeping, so an unchanged set produced no
		// enrichRecords at all, `applyEnrichment` never ran, no hub curie was ever
		// marked produced, and orphan detection then reported every hub as gone.
		// These records are used for BOOKKEEPING ONLY -- never written, never
		// merged, never relocated -- so hub prose is untouched.
		const keptRecords: EnrichRecord[] = [];
		// parent_note: 'folder-note' needs the whole batch's shape up front —
		// a streamed (AsyncIterable) source can't provide that (design §3 step 2
		// v1 restriction). applyEnrichment falls back to sibling + a deviation.
		const isStreamed = !Array.isArray(parsedData.rows);

		// v0.1.4.5: iterate so streaming-row sources (AsyncIterable) work alongside
		// the eager array case. v0.1.6 (2026-06-13): writes run in a bounded
		// concurrency pool — the per-row SYNC prefix (render + collision reserve)
		// runs in order, only the async I/O tail (folder ensure + write) overlaps.
		let total = parsedData.rowCount > 0 ? parsedData.rowCount : -1;
		const ensureFolderOnce = createFolderEnsurer(app);
		const limit = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
		let completed = 0;

		// SOURCE STAGE, same spec-owned position as in generateFromRecipe. The
		// wizard/workbench path accepts a full recipe through `recipeOverride`,
		// so a declared predicate reaches here too. Ignoring it on this path
		// would be exactly the silent, shape-dependent degradation the whole
		// loudness contract exists to prevent. A legacy config carries no canonical
		// source shaping, but this run may add the wizard's sourceWhere override above.
		let sourceStage: SourceStage;
		try {
			sourceStage = await prepareSourceStage(parsedData, recipe.source);
		} catch (stageErr) {
			if (!(stageErr instanceof SourceStageError)) throw stageErr;
			result.errors.push({ row: stageErr.row ?? 0, message: stageErr.message, declaration: stageErr.declaration });
			result.success = false;
			result.duration = Date.now() - startTime;
			debug?.error('generation', 'source-stage-preflight-failed', stageErr.message, {
				declaration: stageErr.declaration,
				expression: stageErr.expression,
			});
			return result;
		}
		addUnparentedWarnings(result, sourceStage);
		let rowsForGeneration: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>> = sourceStage.rows;
		if (recipe.source?.nest) {
			let nestedRows: Record<string, unknown>[];
			try {
				nestedRows = await materializeNestedStageRows(sourceStage);
			} catch (stageErr) {
				if (!(stageErr instanceof SourceStageError)) throw stageErr;
				result.errors.push({ row: stageErr.row ?? 0, message: stageErr.message, declaration: stageErr.declaration });
				result.success = false;
				result.duration = Date.now() - startTime;
				return result;
			}
			const collision = nestedIdentityCollision(nestedRows, (row, rowIndex) => {
				const rowNum = sourceStage.sourceRowNumber(row, rowIndex);
				const filenameStem = deriveFilenameStem(row, mapping, rowNum);
				return deriveRowCurie(
					row,
					curiePrefix,
					basePrefix,
					importSet,
					recipe.source?.nest,
					() => deriveRawFilenameStem(row, mapping, rowNum),
					() => derivationOf(importSet) === 'declared-facts-v1'
						? declaredFactsLocalPart(row, () => deriveRawFilenameStem(row, mapping, rowNum), basePrefix)
						: filenameStem,
				);
			});
			if (collision) {
				result.errors.push({ row: 0, message: collision, declaration: 'source.nest' });
				result.success = false;
				result.duration = Date.now() - startTime;
				return result;
			}
			rowsForGeneration = nestedRows;
		}

		// Folder creation follows all nested identity preflight, so a duplicate
		// identity leaves the vault unchanged.
		if (options.createFolders) {
			await ensureFolderExists(app, options.basePath);
		}

		total = sourceStage.expectedRowCount ?? total;
		let sourceStageFailure: SourceStageError | null = null;
		const captureSourceStageFailure = (stageErr: unknown): void => {
			if (!(stageErr instanceof SourceStageError)) throw stageErr;
			sourceStageFailure = stageErr;
			result.errors.push({ row: stageErr.row ?? 0, message: stageErr.message, declaration: stageErr.declaration });
			result.success = false;
			debug?.error('generation', 'source-stage-failed', stageErr.message, {
				declaration: stageErr.declaration,
				expression: stageErr.expression,
				row: stageErr.row,
			});
		};

		await forEachConcurrent(
			rowsForGeneration as Iterable<Record<string, any>> | AsyncIterable<Record<string, any>>,
			limit,
			async (row, idx) => {
				// The SOURCE row number, identical to `idx + 1` whenever no
				// source shaping is declared.
				const rowNum = sourceStage.sourceRowNumber(row, idx); // 1-indexed for user display
				try {
					// v0.1.3: build path + base frontmatter via render(); body/link
					// content still comes from the existing column-role logic for
					// backward-compat.
					const renderReport: RenderReport = { notes: [] };
					let noteData = buildNoteDataViaRender(
						row,
						rowNum,
						mapping,
						options,
						recipe,
						curiePrefix,
						basePrefix,
						renderReport,
						recipeHash,
						provenanceRecipeId,
						importSet,
						parsedData.sourceByteDigest,
					);
					let legacyAdoption: LegacyCrosswalkAdoption | null = null;
					if (recipeNoteKind === 'crosswalk-edge') {
						const match = legacyCrosswalkAdoption(identityIndex, row, importSet.id, noteData.curie);
						if (match.error) {
							result.errors.push({ row: rowNum, message: match.error });
							return;
						}
						legacyAdoption = match.adoption;
						if (legacyAdoption) {
							renderReport.notes.length = 0;
							noteData = buildNoteDataViaRender(
								row,
								rowNum,
								mapping,
								options,
								recipe,
								curiePrefix,
								basePrefix,
								renderReport,
								recipeHash,
								provenanceRecipeId,
								importSet,
								parsedData.sourceByteDigest,
								legacyAdoption.curie,
							);
						}
					}
					if (renderReport.notes.length > 0) {
						result.warnings ??= [];
						for (const note of renderReport.notes) {
							result.warnings.push({ row: rowNum, message: note.detail, code: note.code, level: note.level, template: note.template });
						}
					}

					// Skip if no valid path generated
					if (!noteData.path) {
						result.errors.push({
							row: rowNum,
							message: 'Could not generate file path - missing hierarchy or title data'
						});
						return;
					}

					// AM-12. A write never crosses a set boundary. The vault-wide index is
					// consulted for DETECTION only: a note elsewhere in the vault already
					// holding this curie, under a different set, is reported by name and the
					// row is dropped - not adopted, not moved, not restamped, and with no
					// fall back to its address. A refused row naming its owner beats an
					// annexed framework.
					//
					// Refused the moment the curie is known rather than at the write itself:
					// a row this run declines to write must not be counted as produced, must
					// not reserve its rendered path against a later row, and must not be
					// recorded anywhere as a note that is going to exist.
					const foreign = legacyAdoption
						? null
						: foreignSetClaim(ownedIdentityIndex, identityIndex, noteData.curie);
					if (foreign) {
						result.errors.push({ row: rowNum, message: crossSetCollisionMessage(noteData.curie, foreign) });
						return;
					}

					// AM-27. Within-run injectivity. Sits beside the cross-set refusal
					// because both are answers about identity alone: a row refused here
					// must not reserve its rendered path against a later row, must not be
					// counted as produced, and must not cost a render or a folder.
					const firstClaim = curieOrigins.get(noteData.curie);
					if (firstClaim) {
						result.errors.push({ row: rowNum, message: duplicateCurieMessage(noteData.curie, firstClaim) });
						return;
					}

					// Path collision detection — fail loud rather than silently
					// overwriting one row's output with another's. (Runs in the sync
					// prefix, so it's deterministic by row order under concurrency.)
					if (emittedPaths.has(noteData.path)) {
						result.errors.push({
							row: rowNum,
							message: `Path collision: ${noteData.path} already produced by an earlier row in this import. Two source rows resolve to the same target file. Adjust your filename template or hierarchy mappings to disambiguate.`,
						});
						return;
					}

					// AM-14. The ADDRESS is the last route into a note, so write resolution
					// runs HERE, above every record this row would otherwise leave behind. A
					// row refused at its address must not reserve its rendered path against a
					// later row, must not be counted as produced, and must not be stamped with
					// a source order, exactly as AM-12's identity refusal must not. Resolution
					// is a pure set of lookups; only the point at which it runs moved.
					//
					// Deliberately BELOW the path-collision check: two rows rendering one
					// address are that check's answer, and letting the second row race the
					// first row's freshly written file into an address refusal would report a
					// source problem as a vault problem.
					const fullPath = normalizePath(noteData.path);
					// AM-12: the OWNED index resolves. Every row whose identity is held
					// outside this set was refused above, so a hit here is always a note this
					// run owns. AM-14: the vault-wide index plus the set id are what the
					// ADDRESS branches judge with, and they report rather than adopt.
					const target = resolveWriteTarget(
						app,
						fullPath,
						noteData.curie,
						enrichmentEnabled,
						ownedIdentityIndex,
						identityIndex,
						importSet.id,
						legacyAdoption?.file,
					);
					if (target.refusal) {
						reportAddressRefusal(result, debug, target.refusal, rowNum, noteData.curie);
						return;
					}
					let takingOverImplied = false;
					if (target.existingFile instanceof TFile && ownedIdentityIndex.get(noteData.curie)?.path === target.existingFile.path) {
						const observed = await readFrontmatterForRun(app, target.existingFile);
						takingOverImplied = observed.state === 'ok' && observed.frontmatter.implied_level !== undefined;
						if (takingOverImplied && target.existingFile.path !== fullPath) {
							result.errors.push({ row: rowNum, message: `Duplicate identity in this import: ${noteData.curie} is an implied concept at ${target.existingFile.path}, but the population row would write it at ${fullPath}. Keep the existing address or resolve the collision before refreshing.` });
							return;
						}
					}

					emittedPaths.add(noteData.path);

					// P1 (2026-07-27): stamp source publication order onto concept
					// notes. Sync prefix — see SourceOrderStamper's determinism note.
					if (shouldStampSourceOrder(noteData.frontmatter)) {
						noteData.frontmatter.source_order = sourceOrderStamper.stamp(
							stripBasePath(noteData.path, options.basePath),
							rowNum,
						);
					}

					// M1 (2026-07-12 pre-merge review): validate against Tier 1 schema
					// BEFORE writing — mirrors generateFromRecipe's step 6 (~line 1692)
					// exactly. Previously this entry point (the wizard/workbench's ONLY
					// generation path) never validated at all, contradicting
					// architectural commitment #1 ("schema-as-primitive... the
					// load-bearing contract").
					{
						const validation = validateTier1Frontmatter(noteData.frontmatter);
						if (!validation.valid) {
							const errMsg = `Tier 1 validation failed for row ${rowNum} (${noteData.path}): ${
								validation.errors.length > 0 ? validation.errors.join('; ') : 'unknown'
							}`;
							if (strict) {
								result.errors.push({ row: rowNum, message: errMsg });
								return;
							} else {
								debug?.warn('generation', 'validation-warning', `Validation warning at ${noteData.path} (non-strict mode)`, { path: noteData.path, error: errMsg });
							}
						}
					}

					// This identity belongs to the current source set even when the note is
					// skipped or merged rather than newly created.
					// AM-27. Recorded only once the row is past every refusal above: a row
					// this run declines to write has claimed nothing, so a later row with
					// the same identity is the FIRST claimant, not a duplicate.
					// AM-31: through the one claim function, so the produced set and the
					// origin map cannot record different things.
					claimProducedCurie(producedCuries, curieOrigins, noteData.curie, {
						row: rowNum, path: noteData.path, kind: 'row',
					});
					if (crosswalkInputs) {
						crosswalkInputs.push({
							curie: noteData.curie,
							row: row as Record<string, unknown>,
							title: typeof noteData.frontmatter.title === 'string' ? noteData.frontmatter.title : undefined,
						});
					}

					// The write target was resolved above (AM-14), before this row reserved
					// anything. Consults BOTH the sibling path AND (when enrichment is on) the
					// folder-note-relocated path by curie — see resolveWriteTarget's docstring
					// (re-import identity, design §4).
					const existingFile = target.existingFile;
					const writePath = target.writePath;

					// The vault holds this concept at a stale address. Move it, so links
					// pointing at it follow, rather than leaving a second copy behind.
					// Skipped when overwriteMode is 'skip': that mode means leave existing
					// notes entirely alone, and a move is still a change to the vault.
					if (existingFile instanceof TFile && target.moveFrom && options.overwriteMode !== 'skip') {
						const parent = getParentPath(writePath);
						if (parent && options.createFolders) await ensureFolderOnce(parent);
						await app.fileManager.renameFile(existingFile, writePath);
						(result.moved ??= []).push({ curie: noteData.curie, from: target.moveFrom, to: writePath });
						debug?.info('generation', 'identity-move', `Moved ${target.moveFrom} -> ${writePath}`, {
							curie: noteData.curie, from: target.moveFrom, to: writePath,
						});
					}

					if (existingFile instanceof TFile) {
						if (options.overwriteMode === 'skip') {
							// The path that EXISTS, never the one the move was going to use.
							// Reporting the desired path names a file the run deliberately did
							// not create, so "every reported path exists" stops holding and a
							// user following the report lands on nothing.
							const skippedPath = existingFile.path;
							result.skipped.push(skippedPath);
							debug?.info('generation', 'skipped-existing', `Skipped existing file ${skippedPath}`, { path: skippedPath });
							// AM-2. Record what was kept so the post-stream bookkeeping pass
							// can derive the hubs these rows imply. `path` is the note that
							// ACTUALLY exists, not the desired one: a bookkeeping pass keyed
							// on a path the run declined to create would derive hubs for a
							// shape the vault is not in.
							if (enrichmentEnabled) {
								keptRecords.push({
									path: skippedPath,
									renderedPath: fullPath,
									// AM-33: a kept row still describes the folders it implies.
									layoutValues: noteData.layoutValues,
									curie: noteData.curie,
									frontmatter: { ...noteData.frontmatter },
									facets: options.facetsForRow
										? options.facetsForRow(row as Record<string, unknown>, rowNum)
										: facetMembershipsFromTags(noteData.tags),
									// Never read: this record is never written back. Kept empty
									// rather than carrying a fresh render, which is exactly the
									// content a skip promised not to write.
									body: '',
								});
							}
							return;
						} else if (options.overwriteMode === 'error') {
							result.errors.push({
								row: rowNum,
								message: `File already exists: ${writePath}`
							});
							result.success = false;
							return;
						}
					}

					// 'replace' mode — ONE shared reader and merger decides what an
					// existing note becomes (src/generation/existing-note.ts). It merges
					// frontmatter on the managed/user_preserve split (Ch 22 §8.4) AND
					// rebuilds only the managed body region, so anything the user typed
					// outside it survives byte-for-byte. A note it cannot understand is a
					// per-note conflict: the file is not modified at all, and the run
					// continues. `generateFromRecipe` calls the same function; a fix that
					// lands on one path only is how a "removed" behaviour comes back.
					let bodyToWrite: string;
					if (existingFile instanceof TFile) {
						const userPreserve = recipe.target.also_emit?.frontmatter?.user_preserve ?? [];
						const managedKeys = computeManagedKeys(noteData.frontmatter, userPreserve, declaredManagedKeys);
						const previous = await readFrontmatterForRun(app, existingFile);
						if (previous.state === 'ok') {
							const owned = recordedEngineParentKeys(previous.frontmatter);
							if (owned.length > 0) managedKeys.add(ENGINE_MANAGED_KEYS);
							for (const key of owned) managedKeys.add(key);
						}
						if (takingOverImplied) {
							for (const key of ['implied_level', 'implied_levels', 'implied_values']) managedKeys.add(key);
						}
						const outcome = await mergeExistingNote({
							app,
							file: existingFile,
							freshFrontmatter: noteData.frontmatter,
							managedKeys,
							freshManagedBody: noteData.body,
							kind: takingOverImplied ? 'implied-to-row' : 'note',
						});
						if (!outcome.ok) {
							recordConflict(result, debug, writePath, noteData.curie, outcome.code, outcome.detail);
							return;
						}
						noteData.frontmatter = outcome.frontmatter;
						bodyToWrite = outcome.body;
					} else {
						bodyToWrite = wrapManagedBody(noteData.body);
					}

					// Ensure parent folder exists (de-duplicated across concurrent rows)
					const parentPath = getParentPath(writePath);
					if (parentPath && options.createFolders) {
						await ensureFolderOnce(parentPath);
					}

					// Build file content
					const content = buildNoteContent(noteData.frontmatter, bodyToWrite);

					// Create or update file
					if (existingFile instanceof TFile) {
						const changed = await writeMergedNote(app, existingFile, noteData.frontmatter, bodyToWrite);
						debug?.info(
							'generation',
							changed ? 'file-replaced' : 'file-unchanged',
							changed ? `Replaced existing file ${writePath}` : `Left existing file ${writePath} unchanged`,
							{ path: writePath },
						);
					} else {
						await app.vault.create(writePath, content);
						debug?.info('generation', 'file-created', `Created new file ${writePath}`, { path: writePath });
					}

					result.created.push(writePath);
					if (takingOverImplied) rowTakenOverImplied.set(noteData.curie, writePath);

					// Collect a record for Pass 1.5 enrichment (parent→children +
					// facet hubs) — same collection generateFromRecipe performs.
					if (enrichmentEnabled) {
						const facets = options.facetsForRow
							? options.facetsForRow(row as Record<string, unknown>, rowNum)
							: facetMembershipsFromTags(noteData.tags);
						enrichRecords.push({
							path: writePath,
							renderedPath: fullPath,
							// AM-33: the folder values this row rendered, so hub identity is
							// derived from facts rather than recovered from `dirname(path)`.
							layoutValues: noteData.layoutValues,
							curie: noteData.curie,
							frontmatter: { ...noteData.frontmatter },
							facets,
							// The body AS ACTUALLY WRITTEN, never the fresh render. Pass 1.5
							// writes this back (applyEnrichment step 1); pushing the unmerged
							// render here would destroy exactly the prose the row write just
							// preserved, silently undoing this whole slice.
							body: bodyToWrite,
						});
					}
				} catch (rowError) {
					const errorMessage = rowError instanceof Error ? rowError.message : String(rowError);
					result.errors.push({
						row: rowNum,
						message: errorMessage
					});
					debug?.error('generation', 'row-error', `Row ${rowNum} failed`, { row: rowNum, error: errorMessage });
				} finally {
					completed += 1;
					if (options.onProgress && (completed % 10 === 0 || completed === total)) {
						options.onProgress(completed, total, `${recipe.source?.nest ? 'Processing record' : 'Processing row'} ${completed}`);
					}
				}
			},
		).catch(captureSourceStageFailure);

		// G3 — a predicate that admits nothing from a non-empty collection is an
		// error, checked at end of stream, after zero writes have happened.
		if (!sourceStageFailure) {
			try {
				sourceStage.finalize();
			} catch (stageErr) {
				captureSourceStageFailure(stageErr);
			}
		}

		// Pass 1.5 — batch enrichment patch phase (post-stream), same phase
		// generateFromRecipe runs. See applyEnrichment for the exact semantics
		// (children lists + facet hub notes + edgeCount, re-import-safe merge).
		let enrichmentComplete = true;

		// AM-52/AM-55. Read once per run, and only when the run kept something: this is
		// the only state that consults it, and a run that moved everything asks the
		// vault nothing extra.
		const ownedHubs = enrichmentEnabled && keptRecords.length > 0 && !sourceStageFailure
			? await readOwnedHubsByFolder(app, ownedIdentityIndex)
			: undefined;
		// AM-55. One deviation ledger per run.
		const deviationsSeen = new Set<string>();
		/**
		 * AM-70 (2026-09-04). INDEX NOTES THIS RUN READ AND CANNOT JUDGE.
		 *
		 * A `kind: 'hub'` note of this import sitting in a folder no note of the
		 * population reaches - a user tidied it into an archive folder - is read by
		 * `readOwnedHubsByFolder` and accounted for by nothing: `keptFolders` is gated
		 * on the population's own ancestor folders. It then landed in the orphan diff
		 * below with `orphansChecked: true`, so the run told the user a note was no
		 * longer in the source while holding the record that it had just read it.
		 *
		 * Neither produced nor kept nor orphan: named in a refusal and left alone.
		 * `orphansChecked` stays true, because the population WAS checked - this note
		 * was named, not judged.
		 */
		const observedUnjudgedCuries = new Set<string>();
		// AM-60/S12. What could not be read, and what records a folder it does not
		// sit in. Both mean the run's picture is incomplete, so it does not publish
		// an orphan list derived from it.
		enrichmentComplete = reportOwnedHubReadProblems(result, ownedHubs, debug) && enrichmentComplete;

		// AM-60. ONE POPULATION, ONE PASS. The rows this run wrote and the rows it
		// kept are one list, and the paths it may write are the first half of it. The
		// two-pass shape - one pass accounting over both, one pass writing from half -
		// is what rewrote a hub's Contents from a batch that had never seen the rows
		// the list names.
		//
		// AM-64 (2026-09-04). THERE IS NO GATE. ACCOUNTING IS A READ; THE GATE
		// GOVERNED WRITES AND WAS GOVERNING ACCOUNTING TOO.
		//
		// AM-61 put the gate back at `enrichRecords.length > 0` to stop an all-skip
		// refresh restamping every index note. It stopped the restamp and it also
		// stopped the one derivation that accounts for the hubs the kept rows imply,
		// so the same refresh reported three notes sitting in the vault as no longer
		// in the source - with `orphansChecked: true`, which is a clean report of a
		// false fact and worse than the restamp it removed.
		//
		// The orphan question is a read over the whole population. So this runs
		// whenever the run HAS a population, and every writer downstream asks the
		// write set for itself (see `applyEnrichment`'s hub loops). A run with no
		// population at all derives nothing.
		if (enrichmentEnabled && enrichRecords.length + keptRecords.length > 0 && !sourceStageFailure) {
			try {
				await applyEnrichment(
					app,
					recipe,
					{
						basePath: options.basePath,
						sourceFileName: options.sourceFileName,
						sourceVersion: options.frameworkVersion ?? recipe.source?.version,
						sourceHash: parsedData.sourceByteDigest,
						overwriteMode: options.overwriteMode,
					},
					curiePrefix,
					[...enrichRecords, ...keptRecords],
					new Set(enrichRecords.map((r) => r.path)),
					result,
					importSet,
					producedCuries,
					curieOrigins,
					isStreamed,
					{ owned: ownedIdentityIndex, vaultWide: identityIndex },
					ownedHubs?.byFolder,
					ownedHubs?.observed,
					rowTakenOverImplied,
					observedUnjudgedCuries,
					deviationsSeen,
					debug,
				);
			} catch (enrichErr) {
				enrichmentComplete = false;
				const msg = enrichErr instanceof Error ? enrichErr.message : String(enrichErr);
				result.warnings ??= [];
				result.warnings.push({ row: 0, message: `Enrichment pass failed: ${msg}` });
				debug?.error('generation', 'enrichment-failed', 'Enrichment pass failed', { error: msg });
			}
		}

		// Orphan detection is safe only after every expected row was visited and no
		// row failed. A partial source would make every unvisited identity look gone.
		// Membership is import-set-only: legacy unstamped notes are outside the set,
		// and enrichment hubs are included because applyEnrichment records their
		// curies at the same point that it stamps their ownership provenance.
		// Rows the source stage excluded were still seen and decided, so they count
		// toward "the whole source was processed". `excludedCount` is 0 whenever no
		// source shaping is declared.
		// Report what the predicate dropped. The wizard used to show this at parse
		// time; `source.where` runs at generation now, so the count travels here.
		if (sourceStage.active) result.filteredOut = sourceStage.excludedCount;

		const rowCountComplete =
			parsedData.rowCount < 0 || completed + sourceStage.excludedCount === (sourceStage.expectedRowCount ?? parsedData.rowCount);
		// AM-7. Record WHETHER detection ran, not just what it found. Absent
		// `orphans` means both `a complete run found none` and `nobody could
		// check`, and a caller that cannot tell them apart tells the user their
		// framework is intact when the run never looked.
		result.orphansChecked = result.success && result.errors.length === 0 && rowCountComplete && enrichmentComplete;
		if (result.orphansChecked) {
			const orphans = ownedIdentityIndex.curies()
				// AM-70. Excluded BY NAME: an index note this pass READ, in a folder the
				// population does not reach, is not evidence that anything left the
				// source. Excluding it here rather than marking it produced keeps the two
				// facts apart - the run vouches for what it wrote, and names what it read
				// and could not describe.
				.filter((curie) => !producedCuries.has(curie) && !observedUnjudgedCuries.has(curie))
				.map((curie) => ({ curie, path: ownedIdentityIndex.get(curie)!.path }))
				.sort((a, b) => a.curie.localeCompare(b.curie) || a.path.localeCompare(b.path));
			if (orphans.length > 0) result.orphans = orphans;
		}

		await applyDeclaredCrosswalks(
			app,
			recipe,
			basePrefix,
			crosswalkInputs ?? [],
			importSet.id,
			options,
			result,
			debug,
		);

		// Final progress update
		if (options.onProgress) {
			options.onProgress(completed, total, 'Complete');
		}

	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		result.success = false;
		result.errors.push({
			row: 0,
			message: `Generation failed: ${errorMessage}`
		});
		debug?.error('generation', 'failed', 'Generation failed', { error: errorMessage });
	}

	result.duration = Date.now() - startTime;

	debug?.info('generation', 'complete', `Generation complete: ${result.created.length} created, ${result.errors.length} errors, ${result.warnings?.length ?? 0} warnings`, {
		success: result.success,
		created: result.created.length,
		skipped: result.skipped.length,
		errors: result.errors.length,
		warnings: result.warnings?.length ?? 0,
		duration: result.duration
	});

	return result;
}

// ============================================================================
// Note Building (v0.1.3 — render() + legacy column-role logic)
// ============================================================================

/**
 * Record a per-note conflict: a good note was produced and DELIBERATELY not
 * written, because the engine could not prove what modifying the file would do.
 *
 * Never `result.success = false`, never an abort. Aborting a 1,200-row import at
 * row 900 leaves a half-written tree, which Ch 45 §4.4 step 5 already names as
 * the bad shape. "Fail closed" means the FILE, not the RUN; the run-level abort
 * is `overwriteMode: 'error'` and always was.
 */
function recordConflict(
	result: GenerationResult,
	debug: DebugLog | undefined,
	path: string,
	curie: string | undefined,
	code: string,
	detail: string,
): void {
	(result.conflicts ??= []).push({ path, curie, code, detail });
	debug?.warn('generation', 'note-conflict', `Left ${path} unchanged: ${code}`, { path, curie, code, detail });
}

/**
 * AM-19 (2026-08-31). Surface ONE address refusal at the altitude that fits it.
 *
 * Three of the four reasons are ownership verdicts about a note the engine could
 * read: they are run errors, because the user has to decide something about the
 * vault (refresh the other set, move the stranger's note, pick another folder).
 * `unreadable` is not a verdict at all - it is a note the engine could not read -
 * and it is the same outcome `mergeExistingNote` produced before AM-14 closed the
 * address route: the file is left exactly as it stands and a per-note conflict
 * says why. Reporting it as an ownership error is what made a damaged note the
 * set genuinely owns read as "a note that is not Crosswalker's. Move or rename
 * that note", which is a false cause carrying a destructive instruction.
 *
 * One function so the four write sites cannot disagree about which surface a
 * given reason lands on.
 */
function reportAddressRefusal(
	result: GenerationResult,
	debug: DebugLog | undefined,
	refusal: AddressRefusal,
	row: number,
	curie?: string,
): void {
	if (refusal.reason === 'unreadable') {
		recordConflict(
			result,
			debug,
			refusal.path,
			curie,
			'frontmatter-unreadable',
			'Its properties block did not parse, so Crosswalker could not tell whether the note is one of its own. '
			+ 'Fix that block, then import again.',
		);
		return;
	}
	result.errors.push({ row, message: crossSetAddressMessage(refusal) });
}

/**
 * AM-13 (2026-08-30). The curie prefix one import set mints under.
 *
 * `endpoint-v1` is the ontology slug and nothing else, so every set minted
 * before this existed keeps the exact identities it already wrote.
 * `set-qualified-v1` appends the set id, which is what makes two releases of one
 * framework - or two crosswalks over one pair - occupy DIFFERENT identity spaces
 * instead of fighting over one. Applied at the prefix rather than at the leaf so
 * concept notes, facet hubs and level hubs are all qualified by the same rule:
 * enrichment builds hub curies from this prefix alone, so qualifying only the
 * concept leaf would leave every hub colliding and AM-12 refusing them.
 *
 * Idempotent on purpose. A legacy set-qualified set carrying no ontology pin
 * recovers its ontology from the prefix its own notes show, and that prefix is
 * already qualified; re-appending the id there would rename every note the set
 * owns, which is the exact failure AM-6 exists to prevent.
 */
export function curiePrefixFor(importSet: ImportSetReference, ontologyId: string): string {
	const base = slugifyForCurie(ontologyId);
	if (importSet.scheme !== 'set-qualified-v1') return base;
	const suffix = `-${importSet.id}`;
	return base.endsWith(suffix) ? base : `${base}${suffix}`;
}

/**
 * AM-34 (2026-09-01). The BASE ontology prefix behind `curiePrefixFor` - the
 * exact inverse of the set-qualification it applies.
 *
 * Set-qualification is a uniform re-prefixing recorded on every note it touches
 * (`_crosswalker.import_set` carries the scheme and the id that produced it), so
 * it is invertible: strip the id suffix and the identity the source declared is
 * back, byte-for-byte.
 *
 * Failure mode prevented: Crosswalker's own export becoming un-importable. A CSV
 * export writes `curie` as its first column; a second release of that framework
 * auto-mints set-qualified and writes `nist-iset-<id>:`; checking a declared
 * curie against THAT refused every row and told the user to rewrite their source
 * using a set id that does not exist until the import runs. The source states
 * `nist:AC-2` and always will; the qualification is the vault's business, not the
 * source's, and it is applied after the check rather than demanded before it.
 */
export function baseCuriePrefixFor(importSet: ImportSetReference, ontologyId: string): string {
	const base = slugifyForCurie(ontologyId);
	if (importSet.scheme !== 'set-qualified-v1') return base;
	const suffix = `-${importSet.id}`;
	return base.endsWith(suffix) ? base.slice(0, base.length - suffix.length) : base;
}

/**
 * AM-12 (2026-08-30). A note in the vault that already claims this identity and
 * is NOT owned by the set this run writes, or null.
 *
 * R3 settled in August that reconciliation only touches notes carrying matching
 * import-set provenance. The orphan pass has used the owned index since; the
 * write path never did, and resolved every row through a vault-wide index. A new
 * set whose curies collide with an existing set's - which `endpoint-v1` permits,
 * because two releases of one framework mint the same curies - therefore took the
 * other set's notes as `existingFile`, moved them, merged into them, and
 * restamped them with the new set's id. This is the detection half of applying
 * the ratified rule to the write path: the owned index resolves, the vault-wide
 * index only reports.
 */
function foreignSetClaim(
	owned: IdentityIndex | undefined,
	vaultWide: IdentityIndex | undefined,
	curie: string,
): ForeignClaim | null {
	if (!vaultWide) return null;
	// Owned wins outright. A note this run owns is this run's to reconcile, and
	// the vault-wide index holds it too.
	if (owned?.get(curie)) return null;
	const claimant = vaultWide.get(curie);
	if (!claimant) return null;
	// A null owner is a real and different case, not a missing string: a note
	// written before import sets existed carries provenance but no ownership, so
	// there is no set to send the user to. Naming a fabricated owner there would
	// point them at something they cannot find.
	return { path: claimant.path, setId: vaultWide.owner(curie) };
}

/** A note outside the set this run writes that already holds one of its identities. */
interface ForeignClaim {
	path: string;
	setId: string | null;
}

function noteKindOf(recipe: Recipe): string {
	return recipe.target.layout.find((entry) => entry.mechanism === 'file')?.kind ?? 'concept';
}

interface LegacyCrosswalkAdoption {
	file: TFile;
	curie: string;
}

/**
 * A legacy xwalk edge is named by the endpoint pair it records, not by
 * recomputing its superseded local-part. One match is adoptable when it is
 * unstamped or already belongs to this set; more than one is ambiguous.
 */
function legacyCrosswalkAdoption(
	index: IdentityIndex,
	row: Record<string, unknown>,
	importSetId: string,
	mintedCurie: string,
): { adoption: LegacyCrosswalkAdoption | null; error: string | null } {
	const subjectId = typeof row.subject_id === 'string' ? row.subject_id.trim() : '';
	const objectId = typeof row.object_id === 'string' ? row.object_id.trim() : '';
	if (!subjectId || !objectId) return { adoption: null, error: null };
	const matches = index.legacyCrosswalkEdges(subjectId, objectId);
	if (matches.length > 1) {
		return {
			adoption: null,
			error: `${matches.length} legacy crosswalk notes already record ${subjectId} -> ${objectId}: `
				+ `${matches.map((match) => match.file.path).sort().join(', ')}. Fix the duplicates, then import again.`,
		};
	}
	const adoption = matches[0] ?? null;
	if (!adoption) return { adoption: null, error: null };

	const current = index.get(mintedCurie);
	if (current && current.path !== adoption.file.path) {
		return {
			adoption: null,
			error: `Both ${current.path} and ${adoption.file.path} record ${subjectId} -> ${objectId}. `
				+ 'Fix the duplicate crosswalk edge, then import again.',
		};
	}
	const owner = index.owner(adoption.curie);
	if (owner && owner !== importSetId) {
		return {
			adoption: null,
			error: crossSetCollisionMessage(adoption.curie, { path: adoption.file.path, setId: owner }),
		};
	}
	return { adoption, error: null };
}

/**
 * The error a refused row reports. Names the identity, the owner, and the file,
 * because "something is in the way" is not something a user can act on, and ends
 * with the action that fits the case that actually occurred.
 */
function crossSetCollisionMessage(curie: string, claim: ForeignClaim): string {
	return claim.setId
		? `Cross-set identity collision: ${curie} is claimed by import set ${claim.setId} at ${claim.path}. `
			+ 'Nothing was written for it. Refresh that set instead, or rename this source so it uses its own identities.'
		: `Cross-set identity collision: ${curie} is claimed by ${claim.path}, a note from an earlier import that carries no import set. `
			+ 'Nothing was written for it. Move or delete that note, or rename this source so it uses its own identities.';
}

/**
 * AM-27 (2026-08-31). What one run has already claimed, so it cannot claim it twice.
 *
 * Failure mode prevented: one import writing two rows onto one identity. Two
 * source rows whose identities collapse together (any derivation can do this -
 * the legacy one collapses on characters, an injective one still collapses when
 * the source itself repeats a code) either overwrite each other at one address,
 * or land at two addresses and leave the vault holding one curie twice. The
 * second is permanent: the identity index reports it as `Ambiguous identity` and
 * every later import in that vault fails, from a cause the user cannot connect to
 * the import that caused it.
 *
 * Deliberately identity-NEUTRAL, so it applies to legacy sets too. It changes no
 * curie and re-identifies nothing; it only refuses to write the second claimant,
 * by name, naming the first as well so the user can see which two rows disagree.
 *
 * AM-31 (2026-08-31). ONE RULE, ALL WRITERS. Until this amendment only the two
 * row loops consulted the guard; every hub and facet writer added to
 * `producedCuries` and checked nothing, so a hub identity equal to a row identity
 * this run produced, or two hubs whose slugged values collapse, were written
 * anyway. Hubs run after rows, so the row could not see the hub and the hub did
 * not look. `row: 0` marks a claimant that is not a source row, and the message
 * says so rather than pointing a user at a row number that does not exist.
 */
type ProducedCurieOrigin = { row: number; path: string; kind: 'row' | 'hub' | 'implied' };

/** Present only when enrichment, rather than the recipe, wrote parent fields. */
const ENGINE_MANAGED_KEYS = '_crosswalker_managed_keys';
const ENGINE_PARENT_KEYS = ['parent', 'parent_curie'] as const;
function recordedEngineParentKeys(frontmatter: Record<string, unknown>): Array<'parent' | 'parent_curie'> {
	const keys = frontmatter[ENGINE_MANAGED_KEYS];
	return Array.isArray(keys) ? ENGINE_PARENT_KEYS.filter((key) => keys.includes(key)) : [];
}

function recipeNeedsEnrichment(recipe: Recipe): boolean {
	return !!recipe.target.enrichment || recipe.target.layout.some((entry) => !!entry.implied_concept);
}

function impliedIdentityPinError(recipe: Recipe, importSet: ImportSetReference): string | null {
	return recipe.target.layout.some((entry) => !!entry.implied_concept)
		&& derivationOf(importSet) !== 'declared-facts-v1'
		? 'This recipe declares implied concept levels, which need the current identity derivation; this import set was created under the legacy rule. Import it as a new set.'
		: null;
}

/**
 * Claim one identity for this run, or say who claimed it first.
 *
 * The single place a produced curie is recorded, so `producedCuries` (which
 * orphan detection reads) and `curieOrigins` (which the refusal reads) cannot
 * drift apart - the split between them is exactly what left hubs unguarded.
 */
function claimProducedCurie(
	producedCuries: Set<string>,
	curieOrigins: Map<string, ProducedCurieOrigin>,
	curie: string,
	origin: ProducedCurieOrigin,
): ProducedCurieOrigin | null {
	const first = curieOrigins.get(curie);
	if (first) return first;
	producedCuries.add(curie);
	curieOrigins.set(curie, origin);
	return null;
}

/** Who already holds this identity in this run, phrased for whatever it was. */
function firstClaimantOf(first: ProducedCurieOrigin): string {
	return first.kind === 'hub'
		? `a hub note this import produced (${first.path})`
		: `row ${first.row} (${first.path})`;
}

function duplicateCurieMessage(curie: string, first: ProducedCurieOrigin): string {
	return `Duplicate identity in this import: ${curie} was already produced by ${firstClaimantOf(first)}. `
		+ 'Nothing was written for this row. Two rows resolve to one identity, so one of them would overwrite the other. '
		+ 'Give them distinct values in the column your import uses for identity.';
}

/**
 * AM-31. The same refusal for a hub, whose cause and cure are different: a user
 * cannot fix a hub by editing an identity column, so the message names the
 * grouping value instead.
 */
function duplicateHubCurieMessage(curie: string, hubPath: string, first: ProducedCurieOrigin): string {
	return `Duplicate identity in this import: the note ${hubPath} would be written as ${curie}, `
		+ `which was already produced by ${firstClaimantOf(first)}. Nothing was written for it. `
		+ 'Two groups of notes resolve to one identity, so one would overwrite the other. '
		+ 'Give them values that differ by more than punctuation or capitalisation.';
}

/**
 * AM-14 (2026-08-30). Why a note sitting at a rendered address may not be adopted.
 *
 * Three cases, kept apart because they are three different things for a user to
 * do something about:
 *   `foreign-set`   another import set owns it. Refresh that set instead.
 *   `not-crosswalker` a person's own note. Crosswalker never merges into one.
 *   `unstamped`     provenance from an import predating import sets. Same answer
 *                   the identity route already gives such a note: move or delete.
 *
 * AM-19 (2026-08-31) adds a fourth, which is the one that is NOT about ownership:
 *   `unreadable`    the note was seen and nothing could be read off it. Who owns
 *                   it is unknown, so nothing may be claimed about it and the
 *                   only honest instruction is "fix this note, then import again".
 */
export type AddressRefusalReason = 'foreign-set' | 'not-crosswalker' | 'unstamped' | 'unreadable';

export interface AddressRefusal {
	reason: AddressRefusalReason;
	path: string;
	/** The owning set, for `foreign-set` only. Never fabricated for the others. */
	setId: string | null;
}

/**
 * AM-14. The last route into a note is its ADDRESS, and until now it was the one
 * route with no ownership check: `resolveWriteTarget` consulted
 * `getAbstractFileByPath` FIRST and adopted whatever it found, without ever
 * reading the `_crosswalker.import_set` stamp off it.
 *
 * Failure mode prevented: two notes with different curies and one rendered
 * address. AM-12 closed the identity route (same curie, other owner); this closes
 * the case where the curies differ, the addresses collide, and the foreign note is
 * merged into and restamped with this run's set. A framework annexed one note at a
 * time is the single worst thing this product can do.
 *
 * Returns null when the address may be adopted: the note is stamped with the set
 * this run writes (the ORDINARY same-set re-import, which must keep working), or
 * this run produced the note itself and the index simply predates it, or there is
 * no index to judge with (a caller that passes none keeps its old behaviour rather
 * than refusing everything).
 *
 * AM-17 (2026-08-31): exported, because the engine is not the only writer of a
 * Crosswalker artifact. A window that writes one asks the same question here
 * rather than carrying a second copy of the answer. `ownedSetId` is `null` for a
 * writer that owns no set at all: every note it finds at the address is then
 * someone's but not its own, which is exactly the refusal it needs.
 */
export function addressRefusal(
	vaultWide: IdentityIndex | undefined,
	path: string,
	ownedSetId: string | null,
	producedThisRun?: ReadonlySet<string>,
): AddressRefusal | null {
	if (!vaultWide) return null;
	// A note this run wrote minutes ago is this run's, and the index was built
	// before it existed. Without this, a hub landing on a path an earlier row of
	// the same run created would refuse itself as "not Crosswalker's".
	if (producedThisRun?.has(path)) return null;
	const stamp = vaultWide.provenanceAt(path);
	// AM-19. Checked FIRST and answered on its own terms. Nothing below this line
	// knows anything about a note whose properties would not parse, so every
	// answer below would be an invention.
	if (stamp === 'unreadable') return { reason: 'unreadable', path, setId: null };
	if (!stamp) return { reason: 'not-crosswalker', path, setId: null };
	if (stamp.importSetId === null) return { reason: 'unstamped', path, setId: null };
	if (stamp.importSetId === ownedSetId) return null;
	return { reason: 'foreign-set', path, setId: stamp.importSetId };
}

/**
 * The error a row refused at its address reports. Names the file and the owner,
 * and ends with the action that fits the case that actually occurred, because
 * "something is in the way" is not something a user can act on.
 */
export function crossSetAddressMessage(refusal: AddressRefusal): string {
	if (refusal.reason === 'unreadable') {
		// AM-19. Names the ONE thing that is actually known, and asks for the one
		// action that fixes it. It must never say the note is not Crosswalker's
		// (nothing here established that) and must never invite move-or-delete
		// (this may be the user's own imported note, damaged by a hand edit).
		return `Crosswalker could not read the properties of ${refusal.path}, so it could not tell whether that note is one of its own. `
			+ 'Nothing was written for it. Fix that note\'s properties block, then import again.';
	}
	if (refusal.reason === 'foreign-set') {
		return `Cross-set address collision: ${refusal.path} is owned by import set ${refusal.setId}. `
			+ 'Nothing was written for it. Refresh that set instead, or choose a different destination folder for this import.';
	}
	if (refusal.reason === 'unstamped') {
		return `Address collision: ${refusal.path} is a note from an earlier import that carries no import set. `
			+ 'Nothing was written for it. Move or delete that note, or choose a different destination folder for this import.';
	}
	return `Address collision: a note that is not Crosswalker's sits at ${refusal.path}. `
		+ 'Nothing was written for it. Move or rename that note, or choose a different destination folder for this import.';
}

/**
 * AM-12 for hubs. A hub resolves through its own curie OR through an
 * address-derived legacy alias, so BOTH have to be checked: adopting a note via
 * an alias claimed by another set crosses the same boundary as adopting it
 * directly. Returns the first identity that is claimed elsewhere.
 */
function foreignHubClaim(
	owned: IdentityIndex | undefined,
	vaultWide: IdentityIndex | undefined,
	curie: string | null,
	legacyCuries: readonly string[] | undefined,
): { curie: string; claim: ForeignClaim } | null {
	for (const candidate of [...(curie ? [curie] : []), ...(legacyCuries ?? [])]) {
		const claim = foreignSetClaim(owned, vaultWide, candidate);
		if (claim) return { curie: candidate, claim };
	}
	return null;
}

/**
 * Resolve the actual write target for a row, accounting for a prior Pass 1.5
 * folder-note relocation (batch-enrichment design §4 — the "risky seam").
 * `render()` always computes the SIBLING-shaped path (Pass 1 knows nothing
 * about `parent_note`); a PRIOR import may have relocated this concept to its
 * folder-note-shaped path (`X/X.md`), or a prior import may have left it
 * folder-note-shaped when the CURRENT config has since flipped back to
 * sibling. Re-import must find the note by CURIE wherever it actually lives —
 * never assume the sibling path alone — or every re-import would create a
 * stray duplicate there (which Pass 1.5 would then have to clean up after the
 * fact instead of never creating it).
 *
 * Only consulted when the recipe declares `target.enrichment` at all — a
 * plain (non-enrichment) import behaves exactly as before (one lookup, one
 * path). The folder-note candidate check costs one extra synchronous vault
 * lookup per row when enrichment is on; Pass 1.5 (not this function) is what
 * actually DECIDES whether a concept should move — this only finds where it
 * currently sits so the row write lands there instead of an orphaned sibling.
 *
 * AM-14 (2026-08-30): every ADDRESS branch below now checks the stamp on the note
 * it found and returns a `refusal` rather than adopting it, unless the stamp names
 * the set this run writes. Identity, then address, then create fresh is the whole
 * set of routes into a note; identity was closed by AM-12 and this closes the
 * other. The caller must treat a `refusal` as a refused row: report it and write
 * nothing.
 */
function resolveWriteTarget(
	app: App,
	siblingPath: string,
	curie: string,
	enrichmentEnabled: boolean,
	ownedIndex?: IdentityIndex,
	vaultWideIndex?: IdentityIndex,
	ownedSetId?: string,
	adoptInPlace?: TFile,
): { existingFile: TFile | null; writePath: string; moveFrom?: string; refusal?: AddressRefusal } {
	// The pair lookup has already established that this is the one legacy xwalk
	// assertion being refreshed. Its recorded address and curie are facts, so keep
	// both rather than routing it through generic move/address adoption.
	if (adoptInPlace) return { existingFile: adoptInPlace, writePath: adoptInPlace.path };

	const direct = app.vault.getAbstractFileByPath(siblingPath);
	if (direct instanceof TFile) {
		// AM-14. The owned-stamp case is the ordinary same-set re-import and is
		// adopted exactly as before; anything else is refused rather than merged
		// into, moved, or restamped.
		const refusal = addressRefusal(vaultWideIndex, direct.path, ownedSetId ?? null);
		if (refusal) return { existingFile: null, writePath: siblingPath, refusal };
		return { existingFile: direct, writePath: siblingPath };
	}

	// Identity reconciliation (2026-08-21): the note is not at the address this
	// recipe renders, but the vault may still hold this concept SOMEWHERE — under a
	// previous layout, a renamed folder, or a destination the user chose. Finding it
	// by curie is what turns "write a second note" into "move the one that exists".
	// Checked before the folder-note guess below because it subsumes it: identity is
	// a fact about the note, whereas a candidate path is only a guess.
	// AM-12: the OWNED index, never the vault-wide one. Resolving a write through
	// every Crosswalker note in the vault is how a run annexed another set's notes.
	// The caller has already refused any row whose identity is claimed outside this
	// set, so a hit here is always a note this run owns.
	const byIdentity = ownedIndex?.get(curie) ?? null;
	if (byIdentity) {
		if (enrichmentEnabled) {
			// Enrichment relocates concepts to their folder-note shape on purpose, so a
			// note sitting there is where it belongs; moving it back would fight Pass 1.5.
			const folderNotePath = folderNoteCandidatePath(siblingPath);
			if (byIdentity.path === folderNotePath) {
				return { existingFile: byIdentity, writePath: folderNotePath };
			}
		}
		return { existingFile: byIdentity, writePath: siblingPath, moveFrom: byIdentity.path };
	}
	if (enrichmentEnabled) {
		const candidatePath = folderNoteCandidatePath(siblingPath);
		if (candidatePath !== siblingPath) {
			const relocated = app.vault.getAbstractFileByPath(candidatePath);
			if (relocated instanceof TFile) {
				const fm = app.metadataCache.getFileCache(relocated)?.frontmatter;
				if (fm && fm.curie === curie) {
					// AM-14. Also an address branch, and the one AM-12 cannot reach: a
					// note carrying this curie but NO `_crosswalker` block is invisible to
					// the vault-wide identity index, so the caller's identity refusal never
					// saw it and this branch would adopt a note that is not Crosswalker's.
					const refusal = addressRefusal(vaultWideIndex, relocated.path, ownedSetId ?? null);
					if (refusal) return { existingFile: null, writePath: siblingPath, refusal };
					return { existingFile: relocated, writePath: candidatePath };
				}
			}
		}
	}
	return { existingFile: null, writePath: siblingPath };
}

/**
 * Build note data from a single row using render() for path + base
 * frontmatter, then layering link + body content from the legacy column-role
 * logic.
 *
 * v0.1.3: this is the new code path that uses spec-driven Recipe + Address.
 * The body/link content building still uses the v0.1.0 buildNoteData internals
 * because body templates haven't migrated to spec yet (deferred to a later
 * milestone where body becomes a recipe-defined `also_emit.body` or similar).
 */
function buildNoteDataViaRender(
	row: Record<string, any>,
	rowNum: number,
	mapping: MappingConfig,
	options: GenerationOptions,
	recipe: ReturnType<typeof legacyConfigToRecipe>,
	/**
	 * The ALREADY-RESOLVED curie prefix (`curiePrefixFor`), not the raw ontology.
	 * AM-13: the prefix depends on the set's scheme as well as its ontology, and a
	 * second derivation here would silently write unqualified concept curies while
	 * enrichment wrote qualified hub curies for the same run.
	 */
	curiePrefix: string,
	/**
	 * AM-34. The set's BASE ontology prefix - the one a source's declared `curie`
	 * is checked against. Handed down beside the resolved prefix rather than
	 * re-derived here: a second derivation is a second place the two can disagree,
	 * and the disagreement would be an identity written under a prefix nothing
	 * else in the run uses.
	 */
	basePrefix: string,
	report?: RenderReport,
	recipeHash?: string,
	provenanceRecipeId?: string,
	importSet?: ImportSetReference,
	sourceHash?: string,
	curieOverride?: string,
): { path: string; frontmatter: Record<string, any>; body: string; sourceRow: number; curie: string; tags: string[]; layoutValues: LayoutValue[] } {
	// 1. Build a CURIE for this row, under the derivation THIS SET IS PINNED TO.
	//
	// AM-27. Why identity may not pass through a filename sanitizer: a filename
	// sanitizer exists to make a string safe for a filesystem, and it does that by
	// mapping many strings onto one (`AC 2`, `AC-2` and `AC/2` all become `AC-2`).
	// An identity built that way is not an identity: two source rows that differ
	// only in a collapsed character claim one CURIE, which is a permanent
	// `Ambiguous identity` collision failing every later import in the vault, and -
	// when they also share an address - one row silently overwriting the other.
	//
	// The legacy rule did exactly that, so it is kept byte-exact for the sets that
	// already carry it rather than corrected underneath them: correcting it would
	// change the curie of every note in every existing vault, and the next refresh
	// would match none of them.
	//
	// `filenameStem` stays on the legacy rule under BOTH derivations: it is only a
	// fallback for the note's H1 (step 5b), a display concern, and changing what a
	// heading says is not what this amendment is about.
	//
	// AM-28. `curiePrefix` is handed down rather than re-derived: a declared
	// `curie` is checked against the prefix this run will actually WRITE, and is
	// then kept verbatim, so the value in the vault is the value the source
	// stated. Stripping the declared prefix and substituting ours is the silent
	// rewrite the amendment forbids.
	const filenameStem = deriveFilenameStem(row, mapping, rowNum);
	const noteKind = noteKindOf(recipe);
	// Crosswalk edges share one pair identity form across every producer. Other
	// note kinds retain the set-pinned general derivation.
	const curie = curieOverride ?? deriveRowCurie(
		row,
		curiePrefix,
		basePrefix,
		importSet,
		recipe.source?.nest,
		() => deriveRawFilenameStem(row, mapping, rowNum),
		() => noteKind === 'crosswalk-edge'
			? sssomEdgeCurie(row, importSet!)
			: derivationOf(importSet) === 'declared-facts-v1'
				? declaredFactsLocalPart(row, () => deriveRawFilenameStem(row, mapping, rowNum), basePrefix)
				: filenameStem,
	);

	// 2. render() expects a SourceScope object — the row IS the scope (column
	//    names map to template variables).
	//
	// Mapping-provenance defaults are normalized in exactly the same way
	// generateFromRecipe does, and for the same reason: the bundled crosswalk
	// recipes reference {mapping_set_id} and {predicate_modifier}, and render()
	// throws on a variable it cannot resolve. Without this, importing a crosswalk
	// source that predates those columns fails on EVERY row through the wizard,
	// while the identical import succeeds through the recipe path. Supplying the
	// empty default lets render omit the key entirely, which is the correct
	// missing-value semantic for optional metadata.
	//
	// Scoped to crosswalk-edge recipes so nothing else gains fields it never had,
	// and deliberately NOT fed into concept identity: see identityScopeForNoteKind.
	const sourceScope = row as Record<string, unknown>;
	const renderScope: Record<string, unknown> = noteKind === 'crosswalk-edge'
		? {
			...sourceScope,
			mapping_set_id: normalizeMappingSetId(sourceScope.mapping_set_id),
			predicate_modifier: normalizePredicateModifierInput(sourceScope.predicate_modifier),
		}
		: sourceScope;

	// AM-33. The folder levels' VALUES, collected as render produces them. Handed
	// on to enrichment so hub identity never has to be recovered by parsing a
	// path back apart.
	const layoutValues: LayoutValue[] = [];
	let address;
	try {
		address = render(recipe, { curie, scope: renderScope }, report, layoutValues);
	} catch (err) {
		if (err instanceof RenderError) {
			throw new Error(`render() failed for row ${rowNum}: ${err.message}`);
		}
		throw err;
	}

	// 3. Combine basePath with the recipe-relative path render() produced.
	const fullPath = options.basePath
		? normalizePath(`${options.basePath}/${address.primary.path}`)
		: normalizePath(address.primary.path);

	// 4. Frontmatter starts from render's output (curie + managed keys).
	const frontmatter: Record<string, any> = { ...address.frontmatter };

	// 4b. Carry tags + aliases from the render Address (spec §7k item 3).
	//     buildNoteDataViaRender previously dropped both, so recipe-emitted
	//     facet tags and id↔name aliases never reached the vault and the graph
	//     stayed disconnected. Frontmatter tags are BARE (no leading '#'); we
	//     strip any '#' defensively, drop empties, and de-dupe. Emission flows
	//     through buildNoteContent's array branch (block-style YAML list).
	if (address.tags.length > 0) {
		const tags = normalizeTagList(address.tags);
		if (tags.length > 0) frontmatter.tags = tags;
	}
	if (address.aliases.length > 0) {
		const aliases = normalizeAliasList(address.aliases);
		if (aliases.length > 0) frontmatter.aliases = aliases;
	}

	// 5. Layer in link content plus the legacy MappingConfig.body fallback.
	// Canonical body declarations are evaluated only by render(); their presence
	// suppresses legacy body-column projection rather than double-emitting it.
	// Body-located link sections remain independent, preserving existing behavior.
	const hasCanonicalBody = (recipe.target.also_emit?.body?.length ?? 0) > 0;
	const legacy = buildNoteData(row, rowNum, mapping, options, '', [], !hasCanonicalBody);
	const declaredManagedKeys = computeDeclaredManagedKeys(recipe.target.also_emit?.frontmatter);
	for (const [k, v] of Object.entries(legacy.frontmatter)) {
		// Skip _crosswalker — we'll write a fresh provenance block below.
		// A recipe declaration owns its key even when render() omitted the value;
		// the supplemental legacy projection must not reintroduce it as empty.
		if (k === '_crosswalker' || declaredManagedKeys.has(k)) continue;
		if (!(k in frontmatter)) frontmatter[k] = v;
	}

	// 5b. Give the note a document shape (spec §7k item 2): an H1 title, a
	//     blank line, then the body content (link sections + body-column prose).
	//     Only when a title column drives the leaf filename AND there is body
	//     content — a frontmatter-only note gets no forced heading. The title
	//     text is the raw (unsanitized) leaf template value so an H1 reads
	//     `# AC-2: Account management` even though the file is `AC-2- ....md`.
	const titleText = mapping.filename?.template ? deriveTitleText(row, mapping, filenameStem) : '';
	const managedBody = renderedBodyRegionsToMarkdown(address.body);
	const bodyContent = [managedBody, legacy.body].filter((part) => part.trim() !== '').join('\n\n');
	//     `target.auto_heading` lets the recipe choose that heading's text or
	//     suppress it; absent, resolveAutoHeadingText returns titleText and the
	//     conditional below is byte-for-byte what it always was.
	let headingText: string | null;
	try {
		headingText = resolveAutoHeadingText(recipe, renderScope, titleText, report);
	} catch (err) {
		if (err instanceof RenderError) {
			throw new Error(`target.auto_heading failed for row ${rowNum}: ${err.message}`);
		}
		throw err;
	}
	const body = composeDocumentBody(headingText, bodyContent);

	// 6. Always write a fresh _crosswalker provenance block per
	//    spec/tier1.schema.json. Captures the source ref + producer +
	//    recipe-id at this generation time, plus the two hashes that let a
	//    future re-import distinguish source-content drift from recipe drift
	//    (concept_cid: pre-render identity hash of (curie, row); recipe.hash:
	//    hash of the effective recipe target — see src/generation/hash.ts's
	//    doc comments for the exact, load-bearing field-set definitions).
	frontmatter._crosswalker = buildProvenance(
		{
			sourceFile: options.sourceFileName,
			sourceVersion: options.frameworkVersion ?? recipe.source?.version,
			sourceHash,
			recipeId: provenanceRecipeId,
			recipeHash,
			importSet,
			// Raw source scope on purpose: mapping-only defaults must never enter
			// concept identity, or every concept's content hash shifts.
			conceptCid: computeConceptCid({ curie, scope: sourceScope }),
			// The same record, hashed with cosmetic differences folded away, so an
			// attestation can tell a rewritten control from a re-typeset one.
			// A SECOND hash: concept_cid is untouched, byte for byte.
			reviewCid: computeReviewCid({ curie, scope: sourceScope }),
			reviewGroups: computeReviewGroupCids({ curie, scope: sourceScope }, recipe),
		},
		PLUGIN_VERSION,
	);

	return {
		path: fullPath,
		frontmatter,
		body,
		sourceRow: rowNum,
		// Curie + raw (tagsafe) rendered tags — needed only by the Pass 1.5
		// enrichment collector in generateNotes (curie for deterministic sort /
		// hub-note curie namespace; tags for the facetsForRow fallback when the
		// caller doesn't supply mapping-driven facet memberships).
		curie,
		tags: address.tags,
		// AM-33: the folder levels' values, for the enrichment collector.
		layoutValues,
	};
}

/**
 * Normalize a list of rendered tag strings for a frontmatter `tags` array:
 * strip any leading '#' (frontmatter tags are bare), trim, drop empties, and
 * de-dupe preserving first-seen order. Deterministic. Exported for tests.
 */
export function normalizeTagList(tags: unknown[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const t of tags) {
		const clean = String(t).replace(/^#+/, '').trim();
		if (clean === '' || seen.has(clean)) continue;
		seen.add(clean);
		out.push(clean);
	}
	return out;
}

/**
 * Normalize a list of rendered alias strings: trim, drop empties, de-dupe.
 * Deterministic. Exported for tests.
 */
export function normalizeAliasList(aliases: unknown[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const a of aliases) {
		const clean = String(a).trim();
		if (clean === '' || seen.has(clean)) continue;
		seen.add(clean);
		out.push(clean);
	}
	return out;
}

/**
 * Resolve a human-readable title for a note's H1 heading. Uses the leaf
 * filename template resolved against the row (single-brace render syntax,
 * pre-sanitization) so the H1 keeps characters a filename can't (`:`), falling
 * back to the already-sanitized filename stem when the template can't resolve.
 */
function deriveTitleText(
	row: Record<string, any>,
	mapping: MappingConfig,
	fallbackStem: string,
): string {
	if (mapping.filename?.template) {
		try {
			const raw = renderTemplate(mapping.filename.template, row as Record<string, unknown>)
				.replace(/\.md$/i, '')
				.trim();
			if (raw) return raw;
		} catch {
			// Template variable missing — fall through to the sanitized stem.
		}
	}
	return fallbackStem;
}

/** Convert pure render() body regions to Markdown without evaluating templates. */
export function renderedBodyRegionsToMarkdown(regions: RenderedBodyRegion[]): string {
	return regions
		.map((region) => {
			if (region.position === 'append') return region.content;
			const heading = `${'#'.repeat(region.headingDepth ?? 2)} ${region.heading ?? ''}`;
			return region.content === '' ? heading : `${heading}\n\n${region.content}`;
		})
		.join('\n\n');
}

/**
 * Resolve the engine's automatic heading text for one row.
 *
 * `recipe.target.auto_heading` (schema SchemaVer 1.8.0) is the recipe's control
 * over the note's first line:
 *
 *   - a template string -> render it against the row scope (full template
 *                          grammar, so `{name}` / `{title|trim}` both work)
 *   - `false`           -> suppress the heading entirely; returns null
 *   - absent            -> the caller's `fallbackTitle`, i.e. today's behaviour
 *
 * BOTH generation paths call this and each keeps its own, deliberately
 * different, emission conditional: the wizard path (composeDocumentBody) emits
 * only when body content exists; the recipe path (buildDefaultBody) emits
 * unconditionally. Threading the option through one path only is how a
 * "removed" heading comes back from the other.
 *
 * Throws RenderError when the template references a missing variable without
 * `|optional`; callers record that as a per-row error and continue.
 *
 * Deterministic (no timestamps). Exported for tests.
 */
export function resolveAutoHeadingText(
	recipe: { target: { auto_heading?: string | false } },
	scope: SourceScope,
	fallbackTitle: string,
	report?: RenderReport,
): string | null {
	const cfg = recipe.target.auto_heading;
	if (cfg === false) return null;
	if (typeof cfg === 'string') return renderTemplate(cfg, scope, report).trim();
	return fallbackTitle;                       // absent -> today's behaviour
}

/**
 * Assemble a document-style note body: an H1 title, a blank line, then the
 * body content. Returns the body unchanged when there is no content OR no
 * title (a frontmatter-only note gets no forced heading), and when the heading
 * is null (the recipe set `auto_heading: false`, or its template rendered
 * empty). Deterministic (no timestamps). Exported for tests.
 */
export function composeDocumentBody(titleText: string | null, body: string): string {
	if (titleText === null) return body;
	if (body.trim() === '' || titleText.trim() === '') return body;
	return `# ${titleText}\n\n${body}`;
}

/**
 * Pulled from buildNoteData's filename logic — returns the stem (no .md) for
 * use in CURIE generation.
 *
 * AM-27. `filename-stem-v1` ONLY. Frozen: this must keep returning byte-for-byte
 * what it returned before, because it is the recorded derivation of every set
 * minted before the pin existed. `sanitizeFileName` at the end is the collapse
 * the amendment names - it is kept here deliberately, and kept OUT of
 * `deriveRawFilenameStem` below, which is what the injective rule sanitizes
 * itself.
 */
function deriveFilenameStem(
	row: Record<string, any>,
	mapping: MappingConfig,
	rowNum: number,
): string {
	return sanitizeFileName(deriveRawFilenameStem(row, mapping, rowNum));
}

/**
 * The filename stem BEFORE any sanitizer touches it.
 *
 * AM-27. Identity may not pass through a filename sanitizer, so the injective
 * derivation needs the exact source value: the hash that disambiguates a
 * collapsed value is taken over THIS string, not over the collapsed one. Taking
 * it after sanitization would hash two already-merged values to one digest and
 * disambiguate nothing.
 */
function deriveRawFilenameStem(
	row: Record<string, any>,
	mapping: MappingConfig,
	rowNum: number,
): string {
	let filename = '';
	if (mapping.filename?.template) {
		// Use the new render template engine ({var|filter} syntax). Legacy
		// configs that used `{{var}}` mustache-style won't interpolate via
		// renderTemplate — they get caught by the empty-result fallback
		// below and resolved to row-N.
		try {
			filename = renderTemplate(mapping.filename.template, row as Record<string, unknown>);
		} catch {
			// Template variable missing — fall through to first-frontmatter fallback
			filename = '';
		}
	}
	if (!filename && mapping.frontmatter && mapping.frontmatter.length > 0) {
		const firstValue = row[mapping.frontmatter[0].column];
		if (firstValue) filename = String(firstValue);
	}

	if (!filename) {
		filename = `row-${rowNum}`;
	}

	// Strip .md if the template included it; CURIE local part doesn't want it
	if (filename.endsWith('.md')) {
		filename = filename.slice(0, -3);
	}
	return filename;
}

// AM-18. `slugifyForCurie` now lives in `./curie` so `import-set.ts` can share
// it without importing the engine. Re-exported here because it has always been
// part of this module's surface, and a second normalization is exactly the kind
// of near-copy the amendment set exists to remove.
export { slugifyForCurie } from './curie';

// Plugin version constant — populated from manifest.json. esbuild bundles
// the import via the JSON loader.
import manifest from '../../manifest.json';
const PLUGIN_VERSION = manifest.version;

/**
 * Build note data from a single row (v0.1.0 column-role logic; preserved
 * for body/link content. v0.1.3 routes path + base frontmatter through
 * render() instead — see buildNoteDataViaRender above).
 */
export function buildNoteData(
	row: Record<string, any>,
	rowNum: number,
	mapping: MappingConfig,
	options: GenerationOptions,
	importId: string,
	allColumns: string[],
	includeBodyMappings = true,
): GeneratedNoteData {
	const frontmatter: Record<string, any> = {};
	const importedProperties: string[] = [];
	let bodyParts: string[] = [];
	let path = options.basePath;

	// 1. Process hierarchy columns (build folder path)
	const hierarchyValues: string[] = [];
	if (mapping.hierarchy && mapping.hierarchy.length > 0) {
		// Sort by level to ensure proper order
		const sortedHierarchy = [...mapping.hierarchy].sort((a, b) => a.level - b.level);

		for (const h of sortedHierarchy) {
			const value = row[h.column];
			if (value !== undefined && value !== null && value !== '') {
				const sanitized = sanitizePathSegment(String(value));
				if (sanitized) {
					hierarchyValues.push(sanitized);
				}
			}
		}
	}

	// 2. Determine filename from filename config or first non-hierarchy column with data
	let filename = '';
	if (mapping.filename?.template) {
		filename = resolveTemplate(mapping.filename.template, row);
	} else {
		// Fall back: use first frontmatter column value as filename
		if (mapping.frontmatter && mapping.frontmatter.length > 0) {
			const firstValue = row[mapping.frontmatter[0].column];
			if (firstValue) {
				filename = String(firstValue);
			}
		}
	}

	if (!filename) {
		// Last resort: use row number
		filename = `row-${rowNum}`;
	}

	// Sanitize filename
	filename = sanitizeFileName(filename);
	if (mapping.filename?.maxLength) {
		filename = filename.substring(0, mapping.filename.maxLength);
	}

	// Build full path
	if (hierarchyValues.length > 0) {
		path = normalizePath(`${path}/${hierarchyValues.join('/')}/${filename}.md`);
	} else {
		path = normalizePath(`${path}/${filename}.md`);
	}

	// 3. Process frontmatter columns
	if (mapping.frontmatter) {
		for (const fm of mapping.frontmatter) {
			const value = row[fm.column];

			// Handle empty values
			if (value === undefined || value === null || value === '') {
				if (!fm.omitIfEmpty) {
					frontmatter[fm.key] = formatValue(value, fm.format);
				}
			} else {
				frontmatter[fm.key] = formatValue(value, fm.format);
			}

			importedProperties.push(fm.key);
		}
	}

	// 4. Process link columns
	if (mapping.links) {
		for (const link of mapping.links) {
			const value = row[link.column];
			if (value !== undefined && value !== null && value !== '') {
				const linkValue = formatAsLink(value, link);

				if (link.location === 'frontmatter' || link.location === 'both') {
					const key = link.frontmatterKey || link.column;
					frontmatter[key] = linkValue;
					importedProperties.push(key);
				}

				if (link.location === 'body' || link.location === 'both') {
					const section = link.bodySection || 'Related';
					bodyParts.push(`## ${section}\n\n${linkValue}\n`);
				}
			}
		}
	}

	// 5. Process legacy body columns only when no canonical also_emit.body block
	// owns body output. Link sections above remain independent and still emit.
	if (includeBodyMappings && mapping.body) {
		for (const body of mapping.body) {
			const value = row[body.column];
			if (value !== undefined && value !== null && value !== '') {
				const formatted = formatBodyContent(value, body);
				if (body.heading) {
					bodyParts.push(`## ${body.heading}\n\n${formatted}\n`);
				} else {
					bodyParts.push(`${formatted}\n`);
				}
			}
		}
	}

	// 6. Add _crosswalker metadata
	const crosswalkerMetadata: CrosswalkerMetadata = {
		sourceId: determineSourceId(row, mapping, rowNum),
		frameworkId: options.frameworkId,
		frameworkVersion: options.frameworkVersion,
		importId: importId,
		configId: options.configId,
		schemaVersion: CROSSWALKER_METADATA_VERSION,
		importedAt: new Date().toISOString(),
		importedProperties: importedProperties,
		sourceFile: options.sourceFileName,
		sourceRow: rowNum
	};

	// Remove undefined values from crosswalker metadata
	const cleanedMetadata = Object.fromEntries(
		Object.entries(crosswalkerMetadata).filter(([_, v]) => v !== undefined)
	);

	frontmatter['_crosswalker'] = cleanedMetadata;

	return {
		path,
		frontmatter,
		body: bodyParts.join('\n'),
		sourceRow: rowNum
	};
}

/**
 * Determine the source ID for a row (canonical identifier)
 */
function determineSourceId(row: Record<string, any>, mapping: MappingConfig, rowNum: number): string {
	// Look for common ID column names
	const idColumnCandidates = [
		'id', 'ID', 'Id',
		'control_id', 'Control ID', 'ControlID',
		'identifier', 'Identifier',
		'code', 'Code',
		'key', 'Key'
	];

	// Check frontmatter mappings for an ID field
	if (mapping.frontmatter) {
		for (const fm of mapping.frontmatter) {
			if (idColumnCandidates.some(c => fm.column.toLowerCase() === c.toLowerCase())) {
				const value = row[fm.column];
				if (value) return String(value);
			}
			// Also check output key
			if (idColumnCandidates.some(c => fm.key.toLowerCase() === c.toLowerCase())) {
				const value = row[fm.column];
				if (value) return String(value);
			}
		}
	}

	// Check raw row data
	for (const candidate of idColumnCandidates) {
		if (row[candidate]) {
			return String(row[candidate]);
		}
	}

	// Fall back to row number
	return `row-${rowNum}`;
}

// ============================================================================
// Formatting Helpers
// ============================================================================

/**
 * Format a value for frontmatter based on format type
 */
function formatValue(value: any, format?: string): any {
	if (value === undefined || value === null) {
		return '';
	}

	switch (format) {
		case 'number':
			const num = Number(value);
			return isNaN(num) ? value : num;

		case 'boolean':
			if (typeof value === 'boolean') return value;
			const lower = String(value).toLowerCase();
			return lower === 'true' || lower === 'yes' || lower === '1';

		case 'array':
			if (Array.isArray(value)) return value;
			// Try to split by common delimiters
			if (typeof value === 'string') {
				if (value.includes(',')) return value.split(',').map(s => s.trim());
				if (value.includes(';')) return value.split(';').map(s => s.trim());
				if (value.includes('\n')) return value.split('\n').map(s => s.trim());
			}
			return [value];

		case 'date':
			// Return as-is for now, could parse/validate
			return String(value);

		default:
			return String(value);
	}
}

/**
 * Format a value as a link
 */
function formatAsLink(value: any, config: LinkMapping): string | string[] {
	const values = Array.isArray(value) ? value : [value];

	const links = values.map(v => {
		const linkText = String(v).trim();
		if (!linkText) return '';

		if (config.type === 'wikilink') {
			return `[[${linkText}]]`;
		} else {
			// Markdown link - would need path resolution
			return `[${linkText}](${linkText})`;
		}
	}).filter(l => l !== '');

	return links.length === 1 ? links[0] : links;
}

/**
 * Format body content
 */
function formatBodyContent(value: any, config: BodyMapping): string {
	const text = String(value);

	switch (config.format) {
		case 'code':
			return '```\n' + text + '\n```';
		case 'quote':
			return text.split('\n').map(line => '> ' + line).join('\n');
		case 'list':
			return text.split('\n').map(line => '- ' + line.trim()).join('\n');
		default:
			return text;
	}
}

/**
 * Resolve a template string with row values
 */
function resolveTemplate(template: string, row: Record<string, any>): string {
	return template.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
		const trimmedKey = key.trim();
		const value = row[trimmedKey];
		return value !== undefined && value !== null ? String(value) : '';
	});
}

// ============================================================================
// File System Helpers
// ============================================================================

/**
 * Build the note content from frontmatter and body.
 * Exported for tests: the YAML quoting rules here are load-bearing (an
 * unquoted wikilink value silently breaks the whole graph).
 */
export function buildNoteContent(frontmatter: Record<string, any>, body: string): string {
	const yamlLines = ['---'];

	for (const [key, value] of Object.entries(frontmatter)) {
		yamlLines.push(formatYamlLine(key, value, 0));
	}

	yamlLines.push('---');

	if (body.trim()) {
		return yamlLines.join('\n') + '\n\n' + body;
	} else {
		return yamlLines.join('\n') + '\n';
	}
}

/**
 * Format a single YAML line (handles nested objects and arrays)
 */
function formatYamlLine(key: string, value: any, indent: number): string {
	const prefix = '  '.repeat(indent);

	if (value === null || value === undefined) {
		return `${prefix}${key}:`;
	}

	if (typeof value === 'object' && !Array.isArray(value)) {
		const lines = [`${prefix}${key}:`];
		for (const [k, v] of Object.entries(value)) {
			lines.push(formatYamlLine(k, v, indent + 1));
		}
		return lines.join('\n');
	}

	if (Array.isArray(value)) {
		if (value.length === 0) {
			return `${prefix}${key}: []`;
		}
		const lines = [`${prefix}${key}:`];
		for (const item of value) {
			if (typeof item === 'object') {
				lines.push(`${prefix}  -`);
				for (const [k, v] of Object.entries(item)) {
					lines.push(formatYamlLine(k, v, indent + 2));
				}
			} else {
				lines.push(`${prefix}  - ${formatYamlValue(item)}`);
			}
		}
		return lines.join('\n');
	}

	return `${prefix}${key}: ${formatYamlValue(value)}`;
}

/**
 * Format a YAML value (quote strings if needed)
 */
function formatYamlValue(value: any): string {
	if (typeof value === 'string') {
		// Quote if contains special characters or looks like a number/boolean.
		// Leading YAML-structural characters MUST be quoted: an unquoted
		// `[[T1078]]` parses as a nested array, so Obsidian indexes no link and
		// the graph shows nothing connected (found 2026-07-10, first graph test).
		if (
			/^[[\]{}\-*&!|>%@`,'" \t]/.test(value) ||
			value.includes(':') ||
			value.includes('#') ||
			value.includes('"') ||
			value.includes("'") ||
			value.includes('\n') ||
			value.match(/^[0-9]/) ||
			['true', 'false', 'yes', 'no', 'null'].includes(value.toLowerCase())
		) {
			// Use double quotes and escape internal quotes
			return `"${value.replace(/"/g, '\\"')}"`;
		}
		return value;
	}

	if (typeof value === 'boolean') {
		return value ? 'true' : 'false';
	}

	if (typeof value === 'number') {
		return String(value);
	}

	return String(value);
}

/**
 * Ensure a folder exists, creating it if necessary
 */
async function ensureFolderExists(app: App, path: string): Promise<void> {
	const normalizedPath = normalizePath(path);
	const existing = app.vault.getAbstractFileByPath(normalizedPath);

	if (existing instanceof TFolder) {
		return; // Already exists
	}

	if (existing instanceof TFile) {
		throw new Error(`Cannot create folder "${path}" - a file exists at that path`);
	}

	// Create folder (Obsidian API creates parent folders automatically)
	await app.vault.createFolder(normalizedPath);
}

/**
 * Get parent path from a file path
 */
function getParentPath(filePath: string): string | null {
	const lastSlash = filePath.lastIndexOf('/');
	if (lastSlash === -1) return null;
	return filePath.substring(0, lastSlash);
}

/**
 * Sanitize a string for use as a path segment (folder name)
 */
function sanitizePathSegment(name: string): string {
	return name
		.replace(/[\\/:*?"<>|]/g, '-') // Replace illegal characters
		.replace(/\s+/g, ' ')          // Normalize whitespace
		.replace(/^\.+|\.+$/g, '')     // Remove leading/trailing dots
		.trim()
		.substring(0, 100);            // Limit length
}

/**
 * Sanitize a string for use as a filename
 */
function sanitizeFileName(name: string): string {
	return name
		.replace(/[\\/:*?"<>|]/g, '-') // Replace illegal characters
		.replace(/\s+/g, ' ')          // Normalize whitespace
		.replace(/^\.+/g, '')          // Remove leading dots
		.replace(/\.md$/i, '')         // Remove existing .md extension
		.trim();
}

/**
 * Generate a unique import ID
 */
function generateImportId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return `import_${timestamp}_${random}`;
}

// ============================================================================
// Export Helpers for Wizard
// ============================================================================

/**
 * Build a full config from wizard state for generation.
 *
 * The optional `appliedConfigFilename` is the filename block from a saved
 * config that was auto-applied via smart-match. When no column is marked as
 * "Note title" in the wizard, this template is used as the leaf filename so
 * the saved config's intent ("filename = Control ID") survives the wizard
 * round-trip. Without this fallback, the legacy-shim would default to the
 * first frontmatter column, which is often the wrong column.
 *
 * Legacy Mustache `{{X}}` syntax in `appliedConfigFilename.template` is
 * tolerated — translated to single-brace `{X}` at use site. The render
 * engine only understands single-brace.
 */
/**
 * Detect the delimiter structure of a taxonomy-id column and return the folder
 * templates that decompose it into a nested tree — the wizard equivalent of the
 * hand-written hierarchical recipe (id `DE.AE-02` → `DE/ → DE.AE/ → DE.AE-02.md`).
 *
 * Strategy: find the delimiter characters that appear in (nearly) every value,
 * ordered by where they first appear in a representative value, then emit one
 * folder template `{col|split(<delim>,0)}` per delimiter — the cumulative prefix
 * up to that delimiter. Domain-general: works for `AC-2` (→ `AC/`), `GV.OC-01`
 * (→ `GV/ → GV.OC/`), `T1055.011` (→ `T1055/`), etc. Returns [] when the values
 * have no consistent delimiter (nothing to split → caller falls back to flat).
 */
export function deriveIdSplitTemplates(column: string, values: string[]): string[] {
	const DELIMS = ['.', '-', '_', '/', ':'];
	const samples = values.map((v) => String(v ?? '').trim()).filter(Boolean).slice(0, 200);
	if (samples.length === 0) return [];

	// A delimiter qualifies if it appears (with content on both sides) in most
	// values — ≥80% — so one-off punctuation doesn't create spurious folders.
	const threshold = Math.max(1, Math.floor(samples.length * 0.8));
	const qualifying = DELIMS.filter((d) => {
		let hits = 0;
		for (const s of samples) {
			const i = s.indexOf(d);
			if (i > 0 && i < s.length - 1) hits++;
		}
		return hits >= threshold;
	});
	if (qualifying.length === 0) return [];

	// Order delimiters by their first position in a representative (longest) value,
	// so cumulative `split(d,0)` prefixes nest correctly (`.` before `-` in CSF ids).
	const rep = samples.reduce((a, b) => (b.length > a.length ? b : a), samples[0]);
	const ordered = qualifying
		.map((d) => ({ d, pos: rep.indexOf(d) }))
		.filter((x) => x.pos >= 0)
		.sort((a, b) => a.pos - b.pos)
		.map((x) => x.d);

	return ordered.map((d) => `{${column}|split(${d},0)}`);
}

export function buildConfigFromWizardState(
	columnConfigs: Map<string, { useAs: string; outputKey: string; folderTemplates?: string[] }>,
	parsedColumns: string[],
	appliedConfigFilename?: { template?: string; sanitize?: boolean; maxLength?: number }
): Partial<ImportRecipe> {
	const hierarchy: HierarchyMapping[] = [];
	const frontmatter: FrontmatterMapping[] = [];
	const links: LinkMapping[] = [];
	const body: BodyMapping[] = [];

	let hierarchyLevel = 1;

	for (const col of parsedColumns) {
		const config = columnConfigs.get(col);
		if (!config) continue;

		switch (config.useAs) {
			case 'hierarchy':
				hierarchy.push({
					column: col,
					level: hierarchyLevel++
				});
				break;

			case 'folder-tree':
				// Id-derived nested folders: one folder level per detected
				// delimiter (templates computed by the wizard from sample values).
				for (const template of config.folderTemplates ?? []) {
					hierarchy.push({ column: col, level: hierarchyLevel++, template });
				}
				break;

			case 'frontmatter':
				frontmatter.push({
					column: col,
					key: config.outputKey
				});
				break;

			case 'link':
				links.push({
					column: col,
					type: 'wikilink',
					location: 'frontmatter',
					frontmatterKey: config.outputKey
				});
				break;

			case 'body':
				body.push({
					column: col,
					heading: config.outputKey
				});
				break;

			case 'title':
				// Title column used in filename template
				break;

			case 'skip':
			default:
				// Skip this column
				break;
		}
	}

	// Filename template precedence (highest to lowest):
	//   1. A column explicitly marked as 'title' in the wizard → `{<col>}`
	//   2. An applied-saved-config filename template, translated from Mustache
	//      `{{X}}` to single-brace `{X}` if needed
	//   3. Omitted — the legacy-recipe-shim falls back to first frontmatter
	//      column → `{<column>}.md`
	const titleCol = parsedColumns.find(col => columnConfigs.get(col)?.useAs === 'title');
	// A folder-tree id column names the leaf file too (the full id), unless an
	// explicit title column is set — matching the hierarchical recipe where the
	// id is both the structure and the filename.
	const folderTreeCol = parsedColumns.find(col => columnConfigs.get(col)?.useAs === 'folder-tree');

	let resolvedFilename: { template: string; sanitize: boolean; maxLength?: number } | undefined;
	if (titleCol) {
		resolvedFilename = { template: `{${titleCol}}`, sanitize: true };
	} else if (folderTreeCol) {
		resolvedFilename = { template: `{${folderTreeCol}}`, sanitize: true };
	} else if (appliedConfigFilename?.template) {
		// Translate Mustache `{{X}}` → single-brace `{X}` for the new render
		// engine. Pre-existing single-brace templates pass through unchanged
		// (the regex matches both forms).
		const translated = appliedConfigFilename.template.replace(/\{\{([^{}]+)\}\}/g, '{$1}');
		resolvedFilename = {
			template: translated,
			sanitize: appliedConfigFilename.sanitize ?? true,
			...(appliedConfigFilename.maxLength !== undefined && { maxLength: appliedConfigFilename.maxLength }),
		};
	}

	return {
		mapping: {
			hierarchy,
			frontmatter,
			links,
			body,
			...(resolvedFilename && { filename: resolvedFilename })
		}
	};
}

function estimateJsonNestedRows(
	rows: Record<string, unknown>[],
	nest: readonly NestedRecordLevel[],
): { rows: Record<string, unknown>[]; countsByLevel: Record<string, number>; sectionCount: number } | null {
	if (nest.some((entry) => entry.children !== undefined && typeof entry.children !== 'string')) return null;
	const emitted: Record<string, unknown>[] = [];
	const countsByLevel: Record<string, number> = {};
	let sectionCount = 0;
	const walk = (row: Record<string, unknown>, levelIndex: number): void => {
		const entry = nest[levelIndex];
		if (!entry) return;
		countsByLevel[entry.level] = (countsByLevel[entry.level] ?? 0) + 1;
		if (entry.leaf === 'section') sectionCount += 1;
		else if (entry.leaf !== 'none') emitted.push(row);
		if (typeof entry.children !== 'string') return;
		const children = row[entry.children];
		if (!Array.isArray(children)) return;
		for (const child of children) {
			if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
				walk(child as Record<string, unknown>, levelIndex + 1);
			}
		}
	};
	for (const row of rows) walk(row, 0);
	return { rows: emitted, countsByLevel, sectionCount };
}

/**
 * Estimate the number of notes and folders that will be created
 */
export function estimateOutput(
	parsedData: ParsedData,
	config: Partial<ImportRecipe>
): { noteCount: number; sectionCount: number; folderCount: number; linkCount: number } {
	const nest = (config as unknown as { source?: { nest?: NestedRecordLevel[] } }).source?.nest;
	let estimateRows = Array.isArray(parsedData.rows) ? parsedData.rows : undefined;
	let noteCount = parsedData.rowCount;
	let sectionCount = 0;
	let folderCount = 1; // At least the base folder

	if (nest && estimateRows) {
		const expansion = estimateJsonNestedRows(estimateRows, nest);
		if (expansion) {
			const nonLeafLevels = new Set(nest.slice(0, -1).map((entry) => entry.level));
			noteCount = expansion.rows.length;
			sectionCount = expansion.sectionCount;
			folderCount = Object.entries(expansion.countsByLevel)
				.filter(([level]) => nonLeafLevels.has(level))
				.reduce((sum, [, count]) => sum + count, 0);
			estimateRows = expansion.rows;
		}
	} else if (config.mapping?.hierarchy && config.mapping.hierarchy.length > 0 && estimateRows) {
		// Count unique combinations at each level. estimateOutput is only
		// called on the eager-array form (wizard preview); streaming sources
		// don't have a known total ahead of generation.
		{
			const uniqueHierarchies = new Set<string>();
			for (const row of estimateRows) {
				let path = '';
				for (const h of config.mapping.hierarchy.sort((a, b) => a.level - b.level)) {
					const value = row[h.column];
					if (value) {
						path += '/' + String(value);
						uniqueHierarchies.add(path);
					}
				}
			}
			folderCount = uniqueHierarchies.size + 1;
		}
	}

	// Estimate link count — eager-array path only (wizard preview)
	let linkCount = 0;
	if (config.mapping?.links && config.mapping.links.length > 0 && estimateRows) {
		for (const row of estimateRows) {
			for (const link of config.mapping.links) {
				const value = row[link.column];
				if (value) {
					// Count array items or single value
					if (Array.isArray(value)) {
						linkCount += value.length;
					} else if (typeof value === 'string' && (value.includes(',') || value.includes(';'))) {
						linkCount += value.split(/[,;]/).length;
					} else {
						linkCount += 1;
					}
				}
			}
		}
	}

	return { noteCount, sectionCount, folderCount, linkCount };
}

// ============================================================================
// v0.1.4 — Native Ch 22 Recipe Path (kind dispatch + STRM enforcement)
// ============================================================================

/**
 * Options for generateFromRecipe — the native Ch 22 entry point. Skips the
 * v0.1.0 column-role legacy logic entirely and runs render() against the
 * recipe directly. Used by recipes that declare non-concept kinds
 * (junction-note, crosswalk-edge) where the frontmatter shape is fully
 * driven by recipe.target.also_emit.frontmatter.managed templates.
 */
export interface RecipeImportOptions {
	/** Vault-relative output base path. May be empty if the recipe's layout
	 *  templates already resolve to absolute paths. */
	basePath: string;
	/** Select an existing import set explicitly or force a freshly minted set. */
	importSet?: ImportSetOption;
	/** Producing framework set for a declared crosswalk edge run; stamped after resolution. */
	producerSetId?: string;
	/** How to handle existing files. */
	overwriteMode: 'skip' | 'replace' | 'error';
	/** Whether to create missing folders. Defaults to true. */
	createFolders?: boolean;
	/** Source file name for provenance. */
	sourceFileName?: string;
	/** Tier 2 handles used after a declared crosswalk edge pass. */
	tier2?: GenerationTier2Hooks;
	/** Source version for provenance. */
	sourceVersion?: string;
	/**
	 * If true, abort on the first row whose rendered frontmatter fails Tier 1
	 * schema validation. Required for v0.1.4 STRM predicate enforcement on
	 * crosswalk-edge layouts. Default: true.
	 */
	strictValidation?: boolean;
	/**
	 * Function returning the CURIE local-part for a row. Default: row.id (or
	 * row.curie if already pre-built; or `row-N` fallback). Recipes for
	 * non-concept kinds typically need a per-row identity (e.g., for a
	 * crosswalk-edge: `cw-{subject}-{object}`).
	 */
	curieLocalPart?: (row: Record<string, unknown>, rowNum: number, importSet: ImportSetReference) => string;
	/** CURIE prefix override. Default: recipe.source.ontology slug. */
	curiePrefix?: string;
	/** Progress callback. */
	onProgress?: (current: number, total: number, message: string) => void;
	/** Max note writes in flight at once (default DEFAULT_CONCURRENCY). 1 = sequential. */
	concurrency?: number;
	/**
	 * Facet memberships for a row — used by Pass 1.5 enrichment to materialize
	 * facet hub notes with their original-case display names. When omitted, the
	 * engine derives memberships from the rendered facet tags (which are tagsafe,
	 * so hub names lose original casing). Callers that hold the ImportMapping
	 * (the workbench) should pass a mapping-driven function via
	 * `deriveFacetMemberships(mapping, row)` for faithful display names.
	 */
	facetsForRow?: (row: Record<string, unknown>, rowNum: number) => FacetMembership[];
}

/**
 * Native Ch 22 recipe entry point. Renders one note per row, validates
 * against spec/tier1.schema.json, writes to vault. Idempotent re-imports
 * preserve user-edited frontmatter via the same managed/user_preserve merge
 * semantics as the legacy path.
 *
 * v0.1.4: this path is the one used by junction-note + crosswalk-edge
 * recipes. Concept-note recipes still flow through generateNotes (legacy
 * column-role) for back-compat with the wizard UI; native concept recipes
 * also work here.
 */
export async function generateFromRecipe(
	app: App,
	parsedData: ParsedData,
	recipe: Recipe,
	rawOptions: RecipeImportOptions,
	debug?: DebugLog,
): Promise<GenerationResult> {
	// AM-49. The other engine boundary, same rule (see `normalizeBasePath`): the
	// root is normalized once here and every consumer below reads `options`, so
	// the string the notes are written under and the string they are compared
	// against cannot be two different strings.
	const options: RecipeImportOptions = { ...rawOptions, basePath: normalizeBasePath(rawOptions.basePath) };
	const startTime = Date.now();
	const result: GenerationResult = {
		success: true,
		created: [],
		skipped: [],
		errors: [],
		duration: 0,
		// AM-7. Starts FALSE, not absent. A run that throws before the orphan pass
		// checked nothing, and a reader must not read that silence as `no orphans`.
		// The orphan pass below sets it true only when it actually ran.
		orphansChecked: false,
	};

	const strict = options.strictValidation ?? true;
	const createFolders = options.createFolders ?? true;
	const recipeNoteKind = noteKindOf(recipe);
	// Crosswalk identity belongs to the note kind, not to the source label. The
	// existing set's pin still wins below, including the frozen legacy xwalk space.
	const proposedOntologyId = recipeNoteKind === 'crosswalk-edge'
		? SSSOM_CURIE_PREFIX
		: recipe.source?.ontology ?? recipe.recipe;
	// Headless imports obey the same destination-discovery rules as the wizard.
	// Callers can name a wiped/empty set explicitly or force a new mint.
	const resolvedImportSet = await resolveImportSet(app, options.basePath, options.importSet, proposedOntologyId, recipe.source?.nest);
	const importSet = options.producerSetId
		? { ...resolvedImportSet, parent_set: options.producerSetId }
		: resolvedImportSet;
	result.importSetId = importSet.id;
	if (recipe.source?.nest && derivationOf(importSet) !== 'declared-facts-v1') {
		result.errors.push({
			row: 0,
			message: 'Nested records need the declared-facts identity rule. This import set was minted under filename-stem-v1; import into a new set.',
			declaration: 'source.nest',
		});
		result.success = false;
		result.duration = Date.now() - startTime;
		return result;
	}
	const impliedPinError = impliedIdentityPinError(recipe, importSet);
	if (impliedPinError) {
		result.errors.push({ row: 0, message: impliedPinError, declaration: 'target.layout' });
		result.success = false;
		result.duration = Date.now() - startTime;
		return result;
	}
	const nestIdentityMismatch = nestedIdentityPinMismatch(recipe.source?.nest, importSet);
	if (nestIdentityMismatch) {
		result.errors.push({
			row: 0,
			message: nestIdentityMismatch.message,
			declaration: nestIdentityMismatch.declaration,
		});
		result.success = false;
		result.duration = Date.now() - startTime;
		return result;
	}
	// AM-6. The set's pin wins over this run's proposal. A refresh whose curie
	// prefix disagrees with the notes it owns writes a second copy of the whole
	// import and orphans the first. An explicit `options.curiePrefix` still wins
	// over both: that caller is naming the identity space on purpose.
	const ontologyId = importSet.ontology ?? proposedOntologyId;
	// Crosswalk release isolation lives in `sssomEdgeCurie`'s local part, so its
	// prefix is the set-pinned ontology itself. Other note kinds keep the ordinary
	// scheme-aware prefix and caller override behavior.
	const curiePrefix = recipeNoteKind === 'crosswalk-edge'
		? slugifyForCurie(ontologyId)
		: options.curiePrefix ?? curiePrefixFor(importSet, ontologyId);
	const baseCuriePrefix = recipeNoteKind === 'crosswalk-edge'
		? slugifyForCurie(ontologyId)
		: options.curiePrefix ?? baseCuriePrefixFor(importSet, ontologyId);
	const ownedIdentityIndex = await buildIdentityIndex(app, { importSetId: importSet.id });

	// _crosswalker.recipe.hash: computed ONCE per generation run — see
	// src/generation/hash.ts's doc comments for the exact field-set definition.
	// `recipe.source` participates only through its shaping declarations; a
	// recipe declaring none hashes byte-identically to its pre-1.9.0 self.
	const recipeHash = computeRecipeHash(recipe.target, recipe.source);
	// See generateNotes above: recipe declaration, not row output, decides ownership.
	const declaredManagedKeys = computeDeclaredManagedKeys(recipe.target.also_emit?.frontmatter);
	// Resolve existing notes by canonical identity before considering their current
	// address. The index admits only notes with Crosswalker provenance, so a
	// hand-written note elsewhere in the vault is never a relocation candidate.
	const identityIndex = await buildIdentityIndex(app);
	const ambiguousCuries = new Set(identityIndex.collisions.map((collision) => collision.curie));
	for (const collision of identityIndex.collisions) {
		result.errors.push({
			row: 0,
			message: `Ambiguous identity ${collision.curie} claimed by: ${collision.paths.join(', ')}`,
		});
	}

	debug?.info('generation', 'recipe-start', `generateFromRecipe: starting (${recipe.recipe})`, {
		recipe: recipe.recipe,
		rowCount: parsedData.rowCount,
		strict,
		ontologyId,
	});

	// SOURCE STAGE (Ch 46 source contract §2). Spec-owned position: source
	// shaping runs BEFORE identity, curie minting, concept_cid and render(),
	// because it decides what a row IS and therefore which notes exist.
	//
	// Preflight (expression parse, permitted-subset walk, G2 reference check)
	// happens inside prepareSourceStage, deliberately BEFORE the first folder is
	// created, so the common typo produces zero writes and one clear error.
	//
	// A recipe declaring no source shaping gets its own `parsedData.rows`
	// reference back untouched and never enters the jsonata module at all.
	let sourceStage: SourceStage;
	try {
		sourceStage = await prepareSourceStage(parsedData, recipe.source);
	} catch (stageErr) {
		if (stageErr instanceof SourceStageError) {
			// Preflight failure. row 0 matches the existing `Ambiguous identity`
			// convention above.
			result.errors.push({ row: stageErr.row ?? 0, message: stageErr.message, declaration: stageErr.declaration });
			result.success = false;
			result.duration = Date.now() - startTime;
			debug?.error('generation', 'source-stage-preflight-failed', stageErr.message, {
				declaration: stageErr.declaration,
				expression: stageErr.expression,
			});
			return result;
		}
		throw stageErr;
	}

	addUnparentedWarnings(result, sourceStage);
	let rowsForGeneration: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>> = sourceStage.rows;
	if (recipe.source?.nest) {
		let nestedRows: Record<string, unknown>[];
		try {
			nestedRows = await materializeNestedStageRows(sourceStage);
		} catch (stageErr) {
			if (!(stageErr instanceof SourceStageError)) throw stageErr;
			result.errors.push({ row: stageErr.row ?? 0, message: stageErr.message, declaration: stageErr.declaration });
			result.success = false;
			result.duration = Date.now() - startTime;
			return result;
		}
		const collision = nestedIdentityCollision(nestedRows, (row, rowIndex) => {
				const rowNum = sourceStage.sourceRowNumber(row, rowIndex);
			const scope: Record<string, unknown> = recipeNoteKind === 'crosswalk-edge'
				? {
					...row,
					mapping_set_id: normalizeMappingSetId(row.mapping_set_id),
					predicate_modifier: normalizePredicateModifierInput(row.predicate_modifier),
				}
				: row;
			return deriveRowCurie(
				scope,
				curiePrefix,
				baseCuriePrefix,
				importSet,
				recipe.source?.nest,
				() => `row-${rowNum}`,
				() => recipeNoteKind === 'crosswalk-edge'
					? sssomEdgeCurie(scope, importSet)
					: options.curieLocalPart
						? options.curieLocalPart(scope, rowNum, importSet)
						: defaultCurieLocalPart(scope, rowNum, derivationOf(importSet), baseCuriePrefix),
			);
		});
		if (collision) {
			result.errors.push({ row: 0, message: collision, declaration: 'source.nest' });
			result.success = false;
			result.duration = Date.now() - startTime;
			return result;
		}
		rowsForGeneration = nestedRows;
	}

	if (createFolders && options.basePath) {
		await ensureFolderExists(app, options.basePath);
	}

	const emittedPaths = new Set<string>();
	const producedCuries = new Set<string>();
	// AM-27. Which row produced each curie, so the duplicate refusal can name both
	// claimants. Same guard, same reason, as the wizard path above.
	const curieOrigins = new Map<string, ProducedCurieOrigin>();
	// A row can supersede an observed implied note only at that note's address.
	const rowTakenOverImplied = new Map<string, string>();
	// Ch 43 re-attestation: review fingerprints of concepts produced by THIS run,
	// so a recipe that emits a concept and an evidence link for it in one pass can
	// stamp the link against the concept it just wrote.
	type ReviewBaseline = { reviewCid: string; reviewGroups: ReviewGroupCids | null };
	const producedReviewBaselines = new Map<string, ReviewBaseline>();
	// Approved junction rows written with no review baseline, because their
	// subject's fingerprint was not resolvable. Counted, never silently dropped.
	let unbaselinedJunctions = 0;
	/**
	 * The subject's current review fingerprint, or null when it cannot be had.
	 *
	 * DELIBERATELY VAULT-WIDE (AM-16). This is a READ, never a write: it resolves
	 * the subject through `identityIndex`, not the owned one, because a crosswalk
	 * legitimately spans sets - its subject is routinely a concept another import
	 * set owns, and refusing to read that would leave every cross-framework
	 * attestation unbaselined. AM-12's owned-index rule governs what a run may
	 * WRITE; nothing here modifies the subject.
	 *
	 * Null is a real answer here - a junction row generated before its subject
	 * concept exists, a subject that is not in this vault at all, a subject whose
	 * note carries no review fingerprint. There is deliberately NO second pass to
	 * fill these in later: a resolve pass would stamp a fingerprint the IMPORTER
	 * computed against content no human reviewed, which is fabricating an approval
	 * with extra steps.
	 *
	 * AM-39 (closing adversarial CONFIRMED 7). "Not indexed yet" is NOT one of
	 * those real answers, and this line used to accept it as one - a metadata-cache
	 * miss read as "this note carries no fingerprint". The asymmetry was provable
	 * one line above: `identityIndex` finds a cache-cold note by READING IT off
	 * disk, and then this asked the cache the same question and believed the
	 * silence. The consequence is permanent and invisible: a link imported while
	 * Obsidian was still indexing is written with no baseline, so no later upstream
	 * edit can ever invalidate it, and it is indistinguishable from a link that
	 * honestly had none. Cache lag is not absence (`project_cache_lag_is_not_absence`,
	 * ninth appearance). `ok` is read, `none` is the real null, and `unreadable`
	 * says so rather than passing for absence.
	 */
	const resolveSubjectReviewBaseline = async (
		subjectCurie: string,
		rowNum: number,
	): Promise<ReviewBaseline | null> => {
		const fromThisRun = producedReviewBaselines.get(subjectCurie);
		if (fromThisRun) return fromThisRun;
		const file = identityIndex.get(subjectCurie);
		if (!file) return null;
		// S8 (ruled 2026-09-02). ONE discriminator, shared with the hub-value index
		// below: an entry that carries no properties is not the cache answering,
		// so the note is read. This costs a disk read for a subject whose cache
		// entry is momentarily empty, which is bounded to edge-subject baselines
		// and is the price of never recording "no baseline" for a note that has
		// one. Absence is not a fact (`project_cache_lag_is_not_absence`).
		const read = await readFrontmatterForRun(app, file);
		if (read.state === 'unreadable') {
			result.warnings ??= [];
			result.warnings.push({
				row: rowNum,
				message: `The properties of ${file.path} could not be read, so this approved link was written with `
					+ 'no review baseline and Crosswalker cannot tell you later if that note changes. '
					+ 'Fix that note\'s properties, then re-import.',
			});
			return null;
		}
		if (read.state !== 'ok') return null;
		const provenance = read.frontmatter._crosswalker;
		if (!provenance || typeof provenance !== 'object') return null;
		const source = provenance as Record<string, unknown>;
		const value = source.review_cid;
		const reviewCid = typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
		return reviewCid
			? { reviewCid, reviewGroups: readReviewGroupCids(source.review_groups) }
			: null;
	};
	// Pass 1.5 enrichment (v0.1.6): records collected during the stream so the
	// post-stream patch phase can derive parent→children + facet hubs without
	// re-reading the vault. One lightweight record per written note. Only
	// populated when the recipe declares target.enrichment.
	const enrichmentEnabled = recipeNeedsEnrichment(recipe);
	const crosswalkInputs: CrosswalkEdgeInput[] | null = declaredCrosswalks(recipe).length > 0 ? [] : null;
	const enrichRecords: EnrichRecord[] = [];
	// AM-2. Rows this run KEPT rather than wrote (overwriteMode 'skip'). The same
	// hole generateNotes had: the skip branch returns above the enrichment
	// collection, so a skip refresh of an unchanged set marked no hub produced and
	// orphaned every hub the set owns. A fix that lands on one generation entry
	// point only is how a removed behaviour comes back on the other.
	const keptRecords: EnrichRecord[] = [];
	// parent_note: 'folder-note' needs the whole batch's shape up front — a
	// streamed (AsyncIterable) source can't provide that (design §3 step 2 v1
	// restriction). applyEnrichment falls back to sibling + a deviation.
	const isStreamed = !Array.isArray(parsedData.rows);
	// v0.1.4.5: streaming-friendly iteration (array OR AsyncIterable<Row>).
	// v0.1.6 (2026-06-13): writes run in a bounded concurrency pool; the sync
	// prefix (render + collision reserve) stays in row order.
	let total = parsedData.rowCount > 0 ? parsedData.rowCount : -1;
	const ensureFolderOnce = createFolderEnsurer(app);
	const limit = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
	let completed = 0;

	// A source-stage failure raised per row is thrown out of the ITERATOR, not
	// inside the worker's try/catch below. That is deliberate: it aborts the
	// run, which is the contract. Skipping a row is the banned behaviour, and a
	// "skip" that logs a warning is still a vault that quietly lost rows.
	//
	// Captured through `.catch` rather than by wrapping the row loop in a try
	// block, so the loop below keeps its indentation and its diff.
	total = sourceStage.expectedRowCount ?? total;
	let sourceStageFailure: SourceStageError | null = null;
	const captureSourceStageFailure = (stageErr: unknown): void => {
		if (!(stageErr instanceof SourceStageError)) throw stageErr;
		sourceStageFailure = stageErr;
		result.errors.push({ row: stageErr.row ?? 0, message: stageErr.message, declaration: stageErr.declaration });
		result.success = false;
		debug?.error('generation', 'source-stage-failed', stageErr.message, {
			declaration: stageErr.declaration,
			expression: stageErr.expression,
			row: stageErr.row,
		});
	};

	await forEachConcurrent(
		rowsForGeneration as Iterable<Record<string, any>> | AsyncIterable<Record<string, any>>,
		limit,
		async (row, idx) => {
		// The SOURCE row number, not the post-filter position: an error must
		// name the row the user can find in their spreadsheet. Identical to
		// `idx + 1` whenever no source shaping is declared.
		const rowNum = sourceStage.sourceRowNumber(row, idx);

		try {
			const sourceScope = row as Record<string, unknown>;
			const scope: Record<string, unknown> = recipeNoteKind === 'crosswalk-edge'
				? {
					...sourceScope,
					mapping_set_id: normalizeMappingSetId(sourceScope.mapping_set_id),
					predicate_modifier: normalizePredicateModifierInput(sourceScope.predicate_modifier),
				}
				: sourceScope;

			// 1. Build CURIE for this row
			// AM-27. The derivation is the SET's, not this version's. An override
			// (the SSSOM importer) reads the same pin off the reference it is handed.
			// AM-28. The prefix travels with the row: a declared `curie` is honoured
			// verbatim only when it already carries the prefix this run writes, and is
			// refused by name otherwise, never stripped and re-prefixed.
			const mintedCurie = deriveRowCurie(
				scope,
				curiePrefix,
				baseCuriePrefix,
				importSet,
				recipe.source?.nest,
				() => `row-${rowNum}`,
				() => recipeNoteKind === 'crosswalk-edge'
					? sssomEdgeCurie(scope, importSet)
					: options.curieLocalPart
						? options.curieLocalPart(scope, rowNum, importSet)
						: defaultCurieLocalPart(scope, rowNum, derivationOf(importSet), baseCuriePrefix),
			);
			let legacyAdoption: LegacyCrosswalkAdoption | null = null;
			if (recipeNoteKind === 'crosswalk-edge') {
				const match = legacyCrosswalkAdoption(identityIndex, sourceScope, importSet.id, mintedCurie);
				if (match.error) {
					result.errors.push({ row: rowNum, message: match.error });
					return;
				}
				legacyAdoption = match.adoption;
			}
			const curie = legacyAdoption?.curie ?? mintedCurie;
			const localPart = curie.slice(curie.indexOf(':') + 1);
			// The index deliberately does not return an arbitrary winner for a
			// collision. Refuse this row instead of making the duplicate permanent.
			if (ambiguousCuries.has(curie) || ambiguousCuries.has(mintedCurie)) return;

			// AM-12. A write never crosses a set boundary. Same rule as generateNotes,
			// refused at the same point: the vault-wide index only DETECTS, and a curie
			// another set already holds stops the row here - not adopted, not moved, not
			// restamped, with no fall back to its address. It sits beside the ambiguity
			// refusal because both are answers about identity alone, so neither should
			// cost a render, a folder, a produced curie, or a review baseline recorded
			// for a note this run will never write.
			const foreignClaim = legacyAdoption
				? null
				: foreignSetClaim(ownedIdentityIndex, identityIndex, curie);
			if (foreignClaim) {
				result.errors.push({ row: rowNum, message: crossSetCollisionMessage(curie, foreignClaim) });
				return;
			}

			// AM-27. Within-run injectivity, beside the other two identity-only
			// refusals and above every record this row would otherwise leave behind.
			const firstClaim = curieOrigins.get(curie);
			if (firstClaim) {
				result.errors.push({ row: rowNum, message: duplicateCurieMessage(curie, firstClaim) });
				return;
			}

			// 2. Render. Expose the already-derived local part as a reserved,
			//    render-only variable so a recipe can keep its file address aligned
			//    with scheme-aware identity. It is deliberately excluded from the
			//    source/identity scopes used for concept CID computation.
			const renderScope = { ...scope, _crosswalker_curie_local_part: localPart };
			const renderReport: RenderReport = { notes: [] };
			// AM-33. The folder levels' values, collected as render produces them —
			// same rule on both generation entry points, so hub identity cannot mean
			// one thing through the wizard and another through a recipe.
			const layoutValues: LayoutValue[] = [];
			let address;
			try {
				address = render(recipe, { curie, scope: renderScope }, renderReport, layoutValues);
			} catch (err) {
				if (err instanceof RenderError) {
					result.errors.push({ row: rowNum, message: `render() failed: ${err.message}` });
					return;
				}
				throw err;
			}
			if (renderReport.notes.length > 0) {
				result.warnings ??= [];
				for (const note of renderReport.notes) {
					result.warnings.push({ row: rowNum, message: note.detail, code: note.code, level: note.level, template: note.template });
				}
			}

			// 3. Build full path
			const recipePath = address.primary.path;
			const fullPath = options.basePath
				? normalizePath(`${options.basePath}/${recipePath}`)
				: normalizePath(recipePath);

			if (!fullPath || fullPath === '.md') {
				result.errors.push({
					row: rowNum,
					message: 'Empty or invalid path produced by render(); check recipe.target.layout templates.',
				});
				return;
			}

			// 4. Path collision detection
			if (emittedPaths.has(fullPath)) {
				result.errors.push({
					row: rowNum,
					message: `Path collision: ${fullPath} already produced earlier in this import. Two source rows resolve to the same target file.`,
				});
				return;
			}
			// AM-14. The ADDRESS is the last route into a note, so write resolution
			// runs HERE, above every record this row would otherwise leave behind: the
			// reserved path, the produced curie, the review baseline. A row refused at
			// its address is a row this run never vouched for, exactly as AM-12's
			// identity refusal is. Resolution is a pure set of lookups; only the point
			// at which it runs moved.
			//
			// Deliberately BELOW the path-collision check: two rows rendering one
			// address are that check's answer, and letting the second row race the
			// first row's freshly written file into an address refusal would report a
			// source problem as a vault problem.
			//
			// AM-12: the OWNED index resolves. Every row whose identity is held outside
			// this set was refused above, so a hit there is always a note this run owns.
			// AM-14: the vault-wide index plus the set id are what the ADDRESS branches
			// judge with, and they report rather than adopt.
			const target = resolveWriteTarget(
				app,
				fullPath,
				curie,
				enrichmentEnabled,
				ownedIdentityIndex,
				identityIndex,
				importSet.id,
				legacyAdoption?.file,
			);
			if (target.refusal) {
				reportAddressRefusal(result, debug, target.refusal, rowNum, curie);
				return;
			}
			// The existing note's recorded identity, not its filename, establishes
			// whether this is an implied-to-row transition. Moving that concept to
			// another address is a collision, never an implicit takeover.
			let takingOverImplied = false;
			if (target.existingFile instanceof TFile && ownedIdentityIndex.get(curie)?.path === target.existingFile.path) {
				const observed = await readFrontmatterForRun(app, target.existingFile);
				takingOverImplied = observed.state === 'ok' && observed.frontmatter.implied_level !== undefined;
				if (takingOverImplied && target.existingFile.path !== fullPath) {
					result.errors.push({ row: rowNum, message: `Duplicate identity in this import: ${curie} is an implied concept at ${target.existingFile.path}, but the population row would write it at ${fullPath}. Keep the existing address or resolve the collision before refreshing.` });
					return;
				}
			}

			emittedPaths.add(fullPath);

			// 5. Compose frontmatter
			const frontmatter: Record<string, any> = { ...address.frontmatter };
			if (address.tags.length > 0) {
				const tags = normalizeTagList(address.tags);
				if (tags.length > 0) frontmatter.tags = tags;
			}
			if (address.aliases.length > 0) {
				const aliases = normalizeAliasList(address.aliases);
				if (aliases.length > 0) frontmatter.aliases = aliases;
			}
			const identityScope = identityScopeForNoteKind(address.frontmatter.kind, sourceScope, scope);
			const reviewRecord = { curie, scope: identityScope };
			const reviewCid = computeReviewCid(reviewRecord);
			const reviewGroups = computeReviewGroupCids(reviewRecord, recipe);
			// An imported evidence link records what its subject looked like at
			// approval, exactly as the link modal does — but only when the row is
			// approved AND the subject's fingerprint is genuinely resolvable.
			// Never fabricated: an importer computing a baseline against content no
			// human read is an audit fact nobody asserted.
			if (address.frontmatter.kind === 'junction-note' && frontmatter.status === 'approved') {
				const subjectCurie = typeof frontmatter.subject_curie === 'string'
					? frontmatter.subject_curie
					: null;
				const subjectBaseline = subjectCurie ? await resolveSubjectReviewBaseline(subjectCurie, rowNum) : null;
				const reviewedAgainst = reviewedAgainstFor(
					subjectCurie,
					subjectBaseline?.reviewCid,
					subjectBaseline?.reviewGroups,
				);
				if (reviewedAgainst) {
					frontmatter.reviewed_against = reviewedAgainst;
				} else {
					// Counted, never silently dropped: "N links written without a
					// baseline" is the honest summary line.
					unbaselinedJunctions += 1;
				}
			}
			frontmatter._crosswalker = buildProvenance(
				{
					sourceFile: options.sourceFileName,
					sourceVersion: options.sourceVersion ?? recipe.source?.version,
					sourceHash: parsedData.sourceByteDigest,
					recipeId: recipe.recipe,
					recipeHash,
					importSet,
					conceptCid: computeConceptCid({ curie, scope: identityScope }),
					reviewCid,
					reviewGroups,
				},
				PLUGIN_VERSION,
			);

			// 6. Validate against Tier 1 schema BEFORE writing. STRM predicate
			//    enforcement happens inside the schema's crosswalk_edge_frontmatter
			//    enum constraint; AJV catches it here.
			const validation = validateTier1Frontmatter(frontmatter);
			if (!validation.valid) {
				const errMsg = `Tier 1 validation failed for row ${rowNum} (${fullPath}): ${
					validation.errors.length > 0 ? validation.errors.join('; ') : 'unknown'
				}`;
				if (strict) {
					result.errors.push({ row: rowNum, message: errMsg });
					return;
				} else {
					debug?.warn('generation', 'validation-warning', `Validation warning at ${fullPath} (non-strict mode)`, { path: fullPath, error: errMsg });
				}
			}

			// This identity belongs to the current source set even when overwrite mode
			// skips or merges the note rather than creating a new file.
			// AM-27. Only once the row is past every refusal above: a row this run
			// declined to write has claimed nothing.
			// AM-31: through the one claim function, so the produced set and the origin
			// map cannot record different things.
			claimProducedCurie(producedCuries, curieOrigins, curie, { row: rowNum, path: fullPath, kind: 'row' });
			if (crosswalkInputs) {
				crosswalkInputs.push({
					curie,
					row: sourceScope,
					title: typeof frontmatter.title === 'string' ? frontmatter.title : undefined,
				});
			}
			// Recorded only for a row that survived validation, so a junction row
			// later in the same run can never be stamped against a concept this run
			// refused to write.
			if (address.frontmatter.kind !== 'junction-note' && address.frontmatter.kind !== 'crosswalk-edge') {
				producedReviewBaselines.set(curie, { reviewCid, reviewGroups });
			}

			// 7. Existing-file handling + merge. The target was resolved above (AM-14),
			//    before this row reserved anything. Consults BOTH the sibling path AND
			//    (when enrichment is on) the folder-note-relocated path by curie —
			//    see resolveWriteTarget's docstring (re-import identity, design §4).
			const existingFile = target.existingFile;
			const writePath = target.writePath;

			// A move is part of replacement, never part of skip mode. Use Obsidian's
			// rename API so links to the canonical note follow its new address.
			if (existingFile instanceof TFile && target.moveFrom && options.overwriteMode !== 'skip') {
				const parentPath = getParentPath(writePath);
				if (parentPath && createFolders) await ensureFolderOnce(parentPath);
				await app.fileManager.renameFile(existingFile, writePath);
				(result.moved ??= []).push({ curie, from: target.moveFrom, to: writePath });
				debug?.info('generation', 'identity-move', `Moved ${target.moveFrom} -> ${writePath}`, {
					curie, from: target.moveFrom, to: writePath,
				});
			}

			if (existingFile instanceof TFile) {
				if (options.overwriteMode === 'skip') {
					// The path that EXISTS, never the desired one — see generateNotes.
					result.skipped.push(existingFile.path);
					// AM-2. Record what was kept so the post-stream bookkeeping pass can
					// derive the hubs these rows imply. Keyed on the note that ACTUALLY
					// exists, never the desired path: bookkeeping against a path the run
					// declined to create describes a vault shape that is not there.
					if (enrichmentEnabled) {
						keptRecords.push({
							path: existingFile.path,
							renderedPath: fullPath,
							// AM-33: a kept row still describes the folders it implies.
							layoutValues,
							curie,
							frontmatter: { ...frontmatter },
							facets: options.facetsForRow
								? options.facetsForRow(row as Record<string, unknown>, rowNum)
								: facetMembershipsFromTags(address.tags),
							// Never read: this record is never written back. Empty rather
							// than a fresh render, which is the content a skip promised not
							// to write.
							body: '',
						});
					}
					return;
				} else if (options.overwriteMode === 'error') {
					result.errors.push({ row: rowNum, message: `File already exists: ${writePath}` });
					result.success = false;
					return;
				}
			}

			// 8. Ensure parent folder
			const parentPath = getParentPath(writePath);
			if (parentPath && createFolders) {
				await ensureFolderOnce(parentPath);
			}

			// 9. Managed body — deterministic H1 plus the canonical regions already
			// evaluated by pure render(). Generation only assembles Markdown.
			// The H1 is `target.auto_heading`-controlled; absent, the historical
			// unconditional `# <title>` branch is preserved exactly. Built BEFORE the
			// existing-note merge (it is that merge's input), which is why step 9 now
			// precedes what used to be step 7's frontmatter merge.
			const headingReport: RenderReport = { notes: [] };
			let managedBody: string;
			try {
				managedBody = buildDefaultBody(frontmatter, address, recipe, renderScope, headingReport);
			} catch (bodyErr) {
				if (bodyErr instanceof RenderError) {
					result.errors.push({ row: rowNum, message: `target.auto_heading failed: ${bodyErr.message}` });
					return;
				}
				throw bodyErr;
			}
			if (headingReport.notes.length > 0) {
				result.warnings ??= [];
				for (const note of headingReport.notes) {
					result.warnings.push({ row: rowNum, message: note.detail, code: note.code, level: note.level, template: note.template });
				}
			}

			// 9b. 'replace' — THE SAME shared reader and merger `generateNotes` calls
			// (src/generation/existing-note.ts). Frontmatter merges on the
			// managed/user_preserve split; only the managed body region is rebuilt, so
			// user prose outside it survives byte-for-byte. A note whose markers or
			// properties cannot be understood is a per-note conflict: file untouched,
			// run continues.
			let body: string;
			if (existingFile instanceof TFile) {
				const userPreserve = recipe.target.also_emit?.frontmatter?.user_preserve ?? [];
				const managedKeys = computeManagedKeys(frontmatter, userPreserve, declaredManagedKeys);
				const previous = await readFrontmatterForRun(app, existingFile);
				if (previous.state === 'ok') {
					const owned = recordedEngineParentKeys(previous.frontmatter);
					if (owned.length > 0) managedKeys.add(ENGINE_MANAGED_KEYS);
					for (const key of owned) managedKeys.add(key);
				}
				// Implied-only properties are engine-owned even if the recipe does not
				// declare them. Deletion belongs to the managed merge, not a later edit.
				if (takingOverImplied) {
					for (const key of ['implied_level', 'implied_levels', 'implied_values']) managedKeys.add(key);
				}
				const outcome = await mergeExistingNote({
					app,
					file: existingFile,
					freshFrontmatter: frontmatter,
					managedKeys,
					freshManagedBody: managedBody,
					kind: takingOverImplied ? 'implied-to-row' : 'note',
				});
				if (!outcome.ok) {
					recordConflict(result, debug, writePath, curie, outcome.code, outcome.detail);
					return;
				}
				Object.keys(frontmatter).forEach((k) => delete frontmatter[k]);
				Object.assign(frontmatter, outcome.frontmatter);
				body = outcome.body;
			} else {
				body = wrapManagedBody(managedBody);
			}

			// 10. Write
			const content = buildNoteContent(frontmatter, body);
			if (existingFile instanceof TFile) {
				await writeMergedNote(app, existingFile, frontmatter, body);
			} else {
				await app.vault.create(writePath, content);
			}
			result.created.push(writePath);
			if (takingOverImplied) rowTakenOverImplied.set(curie, writePath);

			// Collect a record for Pass 1.5 enrichment (parent→children + facet hubs).
			if (enrichmentEnabled) {
				const facets = options.facetsForRow
					? options.facetsForRow(row as Record<string, unknown>, rowNum)
					: facetMembershipsFromTags(address.tags);
				// `body` is the body AS ACTUALLY WRITTEN (merged when the note existed),
				// never the fresh render — Pass 1.5 writes this back, so the unmerged
				// render here would destroy the prose the row write just preserved.
				// AM-33: `layoutValues` travels with the record so the hub pass derives
				// identity from the values, not from `dirname(writePath)`.
				enrichRecords.push({ path: writePath, renderedPath: fullPath, layoutValues, curie, frontmatter: { ...frontmatter }, facets, body });
			}
		} catch (rowError) {
			const errorMessage = rowError instanceof Error ? rowError.message : String(rowError);
			result.errors.push({ row: rowNum, message: errorMessage });
			debug?.error('generation', 'row-error', `Row ${rowNum} failed`, { row: rowNum, error: errorMessage });
		} finally {
			completed += 1;
			if (options.onProgress && (completed % 10 === 0 || completed === total)) {
				options.onProgress(completed, total, `${recipe.source?.nest ? 'Processing record' : 'Processing row'} ${completed}`);
			}
		}
		},
	).catch(captureSourceStageFailure);

	// G3 — a predicate that admits nothing from a non-empty collection is an
	// error, checked at end of stream. Safe there: zero admitted rows means zero
	// writes have happened, so no rollback is needed.
	if (!sourceStageFailure) {
		try {
			sourceStage.finalize();
		} catch (stageErr) {
			captureSourceStageFailure(stageErr);
		}
	}

	if (unbaselinedJunctions > 0) {
		// Undefined when zero, so a plain concept import says nothing about
		// baselines rather than claiming a zero it never measured.
		result.unbaselinedJunctions = unbaselinedJunctions;
	}

	if (sourceStage.active && !sourceStageFailure) {
		// Same reporting as the wizard path: what the predicate dropped is a
		// user-visible number, not a debug-log-only one.
		result.filteredOut = sourceStage.excludedCount;
		debug?.info('generation', 'source-stage-applied', `source stage admitted ${completed} of ${sourceStage.examinedCount} source rows`, {
			examined: sourceStage.examinedCount,
			excluded: sourceStage.excludedCount,
			joins: sourceStage.joins.map((join) => ({
				alias: join.alias,
				indexedRows: join.indexedRowCount,
				distinctKeys: join.distinctKeyCount,
			})),
		});
	}

	// Pass 1.5 — batch enrichment patch phase (post-stream). Derives parent→children
	// + facet hubs from the collected records (never re-reads the vault for the
	// derivation), then writes children onto parents and materializes hub notes via
	// the same managed-merge path so re-imports stay idempotent + user-safe.
	let enrichmentComplete = true;

	// AM-52/AM-55. Read once per run, and only when the run kept something: this is
	// the only state that consults it, and a run that moved everything asks the vault
	// nothing extra.
	const ownedHubs = enrichmentEnabled && keptRecords.length > 0 && !sourceStageFailure
		? await readOwnedHubsByFolder(app, ownedIdentityIndex)
		: undefined;
	// AM-55. One deviation ledger per run.
	const deviationsSeen = new Set<string>();
	// AM-70. Index notes this run READ whose folder no note of the population
	// reaches: named, not judged. See the wizard path's comment and
	// `EnrichmentResult.levelHubs.observedUnjudgedCuries`.
	const observedUnjudgedCuries = new Set<string>();
	// AM-60/S12. What could not be read, and what records a folder it does not sit
	// in. Both mean the run's picture is incomplete, so it does not publish an
	// orphan list derived from it.
	enrichmentComplete = reportOwnedHubReadProblems(result, ownedHubs, debug) && enrichmentComplete;

	// AM-60. ONE POPULATION, ONE PASS. See the matching comment on the wizard path
	// above, and `applyEnrichment`'s own header for the failure mode.
	//
	// AM-64. THERE IS NO GATE: accounting is a read over the whole population, and
	// every writer asks the write set for itself. Same reasoning as the wizard path
	// above, where the failure mode is written out in full.
	if (enrichmentEnabled && enrichRecords.length + keptRecords.length > 0 && !sourceStageFailure) {
		try {
			await applyEnrichment(
				app,
				recipe,
				{
					...options,
					sourceVersion: options.sourceVersion ?? recipe.source?.version,
					sourceHash: parsedData.sourceByteDigest,
				},
				curiePrefix,
				[...enrichRecords, ...keptRecords],
				new Set(enrichRecords.map((r) => r.path)),
				result,
				importSet,
				producedCuries,
				curieOrigins,
				isStreamed,
				{ owned: ownedIdentityIndex, vaultWide: identityIndex },
				ownedHubs?.byFolder,
				ownedHubs?.observed,
				rowTakenOverImplied,
				observedUnjudgedCuries,
				deviationsSeen,
				debug,
			);
		} catch (enrichErr) {
			enrichmentComplete = false;
			const msg = enrichErr instanceof Error ? enrichErr.message : String(enrichErr);
			result.warnings ??= [];
			result.warnings.push({ row: 0, message: `Enrichment pass failed: ${msg}` });
			debug?.error('generation', 'enrichment-failed', 'Enrichment pass failed', { error: msg });
		}
	}

	// Same fail-closed orphan guard as the wizard path: only a complete run with
	// zero errors can prove that a formerly-owned identity is absent from source.
	// Rows the source stage excluded were still seen and still decided. They
	// count toward "the whole source was processed", so orphan detection stays
	// available for a filtered import: a note whose row is now excluded is a
	// genuine orphan and must be reported as one. `excludedCount` is 0 whenever
	// no source shaping is declared, leaving this expression exactly as it was.
	const rowCountComplete =
		parsedData.rowCount < 0 || completed + sourceStage.excludedCount === (sourceStage.expectedRowCount ?? parsedData.rowCount);
	// AM-7. Record WHETHER detection ran. An uncomputed orphan count is not
	// zero, and a surface that renders it as zero says the import is intact
	// when nothing checked.
	result.orphansChecked = result.success && result.errors.length === 0 && rowCountComplete && enrichmentComplete;
	if (result.orphansChecked) {
		const orphans = ownedIdentityIndex.curies()
			// AM-70. Excluded BY NAME, not by a claim. See the wizard path's comment.
			.filter((curie) => !producedCuries.has(curie) && !observedUnjudgedCuries.has(curie))
			.map((curie) => ({ curie, path: ownedIdentityIndex.get(curie)!.path }))
			.sort((a, b) => a.curie.localeCompare(b.curie) || a.path.localeCompare(b.path));
		if (orphans.length > 0) result.orphans = orphans;
	}

	await applyDeclaredCrosswalks(
		app,
		recipe,
		baseCuriePrefix,
		crosswalkInputs ?? [],
		importSet.id,
		options,
		result,
		debug,
	);

	if (options.onProgress) options.onProgress(completed, total, 'Complete');
	if (result.errors.length > 0) result.success = false;
	result.duration = Date.now() - startTime;

	debug?.info('generation', 'recipe-complete', `generateFromRecipe: complete (${result.created.length} created, ${result.errors.length} errors, ${result.warnings?.length ?? 0} warnings, ${result.edgeCount ?? 0} edges)`, {
		success: result.success,
		created: result.created.length,
		skipped: result.skipped.length,
		errors: result.errors.length,
		warnings: result.warnings?.length ?? 0,
		duration: result.duration,
	});

	return result;
}

/**
 * Best-effort facet memberships from a note's rendered (tagsafe) facet tags.
 * Each `namespace/value` tag → one membership; nested tags (several slashes)
 * split on the LAST slash. Display value is the tagsafe token (lowercased) — the
 * mapping-driven `facetsForRow` callback preserves original casing when the
 * caller can supply it. Deterministic. Exported for tests.
 */
export function facetMembershipsFromTags(tags: string[]): FacetMembership[] {
	const out: FacetMembership[] = [];
	for (const tag of tags) {
		const clean = String(tag).replace(/^#+/, '').trim();
		const slash = clean.lastIndexOf('/');
		if (slash <= 0 || slash === clean.length - 1) continue; // need namespace + value
		out.push({ namespace: clean.slice(0, slash), value: clean.slice(slash + 1) });
	}
	return out;
}

/**
 * Where a hub note should be written, resolved by identity first and by address
 * only as a last resort.
 *
 * A hub used to be found with `getAbstractFileByPath` alone. That is a guess
 * about a note dressed up as a lookup: the moment an import's destination
 * changes, the guess misses, a second hub is created for a concept the vault
 * already holds, and the two files claim one curie forever — which surfaces as
 * "Ambiguous identity", which in turn suppresses orphan reporting for the whole
 * run. Concepts have gone through the identity index since 2026-08-21; hubs did
 * not, and this closes that gap.
 *
 * `legacyCuries` is the second half of the same problem: hub identity itself used
 * to be derived from the hub's full vault path (see `HubNote.legacyCuries`), so a
 * moved destination did not merely relocate a hub, it RENAMED it. Accepting the
 * old form as an alias is what keeps those hubs reconcilable instead of orphaned.
 * A hub can carry user prose and user frontmatter, so recreating one at the new
 * address and cleaning up the old is not available: it would destroy that content.
 *
 * AM-33 (2026-09-01). Three identity steps, values first and notes last, before
 * the address is consulted at all:
 *
 *   1. the VALUE-derived identity, through the owned index;
 *   2. the legacy PATH-derived forms — and these are computed from the CURRENT
 *      render, so they can only ever match a hub that has not moved. That is
 *      their whole and stated limitation: they reconcile a scheme upgrade at an
 *      unchanged address and nothing else. A form recomputed from a path is
 *      never trusted past this step;
 *   3. owned hub notes whose RECORDED values equal these values, found by
 *      reading the notes. This is the step that survives a moved destination, a
 *      changed layout above the hub, and a later improvement to the derivation:
 *      the note says what it is about, and a recorded fact does not move.
 *
 * Only then the address (AM-14), and only then a create.
 */
function resolveHubTarget(
	app: App,
	desiredPath: string,
	curie: string | null,
	legacyCuries: string[] | undefined,
	ownedIndex?: IdentityIndex,
	vaultWideIndex?: IdentityIndex,
	ownedSetId?: string,
	producedThisRun?: ReadonlySet<string>,
	/** AM-33 step 3: this hub's layout values, and the owned hubs that record theirs. */
	byValues?: { levelValues?: LayoutValue[]; index?: OwnedHubValueIndex },
): { existingFile: TFile | null; writePath: string; moveFrom?: string; adoptedAlias?: string; refusal?: AddressRefusal } {
	// AM-12: the OWNED index. A hub held by another set is refused by the caller
	// before this runs, so anything found here belongs to the set being written.
	const byIdentity = curie && ownedIndex ? ownedIndex.get(curie) : null;
	if (byIdentity) {
		return byIdentity.path === desiredPath
			? { existingFile: byIdentity, writePath: desiredPath }
			: { existingFile: byIdentity, writePath: desiredPath, moveFrom: byIdentity.path };
	}

	if (ownedIndex && legacyCuries) {
		for (const alias of legacyCuries) {
			const aliased = ownedIndex.get(alias);
			if (!aliased) continue;
			return aliased.path === desiredPath
				? { existingFile: aliased, writePath: desiredPath, adoptedAlias: alias }
				: { existingFile: aliased, writePath: desiredPath, moveFrom: aliased.path, adoptedAlias: alias };
		}
	}

	// AM-33 step 3. The notes, read. Steps 1 and 2 both ask an INDEX about a value
	// this run just computed; when the hub moved, or the layout above it changed,
	// or the derivation improved, every computed form misses and the hub that
	// plainly exists is found by nothing - which is how a second hub gets written
	// and the first is orphaned carrying the user's prose. A hub records what it
	// is about, and that record is matched here.
	//
	// The note's own recorded curie travels back as `adoptedAlias`, so the
	// identity this run supersedes is claimed rather than reported as a note that
	// vanished - the same treatment step 2's aliases already get.
	if (byValues?.index && byValues.levelValues && byValues.levelValues.length > 0) {
		const found = byValues.index.get(byValues.levelValues);
		if (found) {
			return found.file.path === desiredPath
				? { existingFile: found.file, writePath: desiredPath, adoptedAlias: found.curie }
				: { existingFile: found.file, writePath: desiredPath, moveFrom: found.file.path, adoptedAlias: found.curie };
		}
	}

	// Address is consulted last, and since AM-12 the index it could not be seen in
	// is the OWNED one, so this branch covers two cases: a note with no
	// `_crosswalker` block of its own, and a note some other set owns that happens
	// to sit at this address under a DIFFERENT identity. AM-12 refuses the first
	// kind of boundary crossing (same identity, other owner) at the caller.
	//
	// AM-14 closes the second, which was the last unguarded route into a note: a
	// hub whose rendered address happens to hold another set's note was merged
	// into and restamped, no matter whose it was. The owned-stamp case is the
	// ordinary same-set re-import and is adopted exactly as before.
	const direct = app.vault.getAbstractFileByPath(desiredPath);
	if (direct instanceof TFile) {
		const refusal = addressRefusal(vaultWideIndex, direct.path, ownedSetId ?? null, producedThisRun);
		if (refusal) return { existingFile: null, writePath: desiredPath, refusal };
		return { existingFile: direct, writePath: desiredPath };
	}
	return { existingFile: null, writePath: desiredPath };
}

/**
 * AM-33 (2026-09-01). Owned hub notes, looked up by the VALUES they record.
 *
 * The third and last identity step for a hub. Steps 1 and 2 ask an index about a
 * form this run just computed from the current render; this one asks the notes
 * what they say about themselves. A recorded fact survives a moved destination,
 * a changed layout above the hub, and any later improvement to the derivation -
 * none of which a recomputed form survives.
 *
 * Keyed on the VALUES alone, not on the level NAMES beside them: renaming a
 * layout level (`family` -> `control_family`) is a change to how the source is
 * described, not to which folder this hub is about, and re-minting every hub for
 * it would orphan them all. The level names are recorded on the note anyway, for
 * a reader and for diagnosis.
 *
 * Scoped to the notes the OWNED index already admitted, so it costs a
 * frontmatter read per owned note rather than a second whole-vault pass, and so
 * it cannot reach across a set boundary (AM-12).
 */
interface OwnedHubValueIndex {
	get(values: LayoutValue[]): { file: TFile; curie: string } | null;
	size: number;
}

/** Canonical key for a hub's value chain. Values only - see `OwnedHubValueIndex`. */
function hubValuesKey(values: readonly string[]): string {
	return JSON.stringify(values);
}

/**
 * AM-39. The keys that RECORD what a hub is about, declared managed on every hub
 * write whether or not this run computed them.
 *
 * Managed keys are otherwise derived from the fresh frontmatter, which means a
 * key the run could not compute is absent, and an absent key is preserved as
 * though the user had written it. For a record the product itself matches on,
 * that is a stale assertion nothing can retract: `buildOwnedHubValueIndex` keeps
 * offering the note as the hub for values it no longer covers, and a later run
 * whose folder genuinely has those values adopts it, moves it, and restamps it.
 * A record that cannot be cleared is not a record.
 */
const HUB_VALUE_RECORD_KEYS: readonly string[] = ['hub_levels', 'hub_values'];

/**
 * SUSPECTED 8, ruled 2026-09-02. THE ONE DISCRIMINATOR for "did the cache answer
 * about this note?", used by every read in this file that has a disk fallback.
 *
 * There were two readings of that question here, added in the same pass. One
 * asked whether a cache ENTRY existed (`!cached`) and treated an entry whose
 * `frontmatter` was momentarily absent as a fact about the note; the other asked
 * whether the FRONTMATTER was there (`!fm`) and re-read the file. The second is
 * the safe one, and coexisting readings of the same question is how this project
 * has accumulated nine recorded instances of absence read as fact.
 *
 * `readNoteFrontmatterState` IS that reading: it accepts a cache entry only when
 * it actually carries properties, reads the file otherwise, and answers with the
 * tri-state (`ok` / `none` / `unreadable`) so a caller can tell a note that has
 * no properties from a note nothing could be read from. This wrapper exists to
 * be the single seam: Part B's `readIndexed` accessor replaces its body, and
 * these are its first callers.
 */
function readFrontmatterForRun(app: App, file: TFile): Promise<NoteFrontmatterRead> {
	return readNoteFrontmatterState(app, file);
}

/** A frontmatter value that is a list of strings, or null. */
function readStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	if (!value.every((v) => typeof v === 'string')) return null;
	return value as string[];
}

async function buildOwnedHubValueIndex(app: App, owned: IdentityIndex | undefined): Promise<OwnedHubValueIndex> {
	const byKey = new Map<string, { file: TFile; curie: string }>();
	if (owned) {
		for (const curie of owned.curies()) {
			const file = owned.get(curie);
			if (!file) continue;
			// S8 (ruled 2026-09-02): the same discriminator the review-baseline read
			// uses. Cache lag is not absence (`project_cache_lag_is_not_absence`): a
			// note Obsidian has not reached yet, or whose entry carries no
			// properties, is read rather than assumed to record nothing.
			const read = await readFrontmatterForRun(app, file);
			if (read.state !== 'ok') continue;
			const fm = read.frontmatter;
			if (fm.kind !== 'hub') continue;
			const values = readStringArray(fm.hub_values);
			if (!values || values.length === 0) continue;
			const key = hubValuesKey(values);
			// First claimant wins, matching the identity index's own collision rule,
			// so the two cannot disagree about which note answers.
			if (!byKey.has(key)) byKey.set(key, { file, curie });
		}
	}
	return {
		get: (values: LayoutValue[]) => byKey.get(hubValuesKey(values.map((v) => v.value))) ?? null,
		size: byKey.size,
	};
}

/**
 * AM-52 (2026-09-04), reshaped by AM-55. WHAT THE VAULT HOLDS at each folder: the
 * index note sitting in it, keyed by that folder.
 *
 * `enrich()` is pure and reads no vault, so the one fact it cannot obtain for
 * itself is what the vault already says. This supplies it, for the single state
 * AM-52/AM-54 add: a folder on the chain of a row this refresh KEPT at an address
 * the layout no longer chooses (a source release that recategorises a row, imported
 * with Skip existing). Such a folder is described by no chain of this run, so
 * without what its index note already records its hub is refused, drops out of
 * `producedCuries`, and the orphan pass reports the index note of a folder that
 * still holds notes as vanished.
 *
 * AM-55, three changes, each of them a failure mode:
 *
 *   - KEYED BY PLACEMENT (`dirOf(hubPath)`), not by the `<folder>/<basename>.md`
 *     address. A hub describes the folder it SITS IN - the S4 rule - and requiring
 *     the address verbatim meant a hub `applyHubRelocation` had left at its old
 *     name answered for nothing, so its folder was refused and its own note
 *     reported as vanished.
 *   - TWO HUBS IN ONE FOLDER IS A REFUSAL BY NAME, not a pick. First-claimant-wins
 *     is right for an identity index, where the question is "which note answers to
 *     this curie"; here the question is "what is this folder about", and picking
 *     writes one note's identity over the other's meaning.
 *   - UNREADABLE IS REPORTED, NOT DROPPED. A note the host could not read is not a
 *     note that records nothing (`project_cache_lag_is_not_absence`, tenth recorded
 *     instance and the last one on this path). Dropping it collapsed the two into a
 *     false orphan on a note sitting in the vault; the caller suppresses orphan
 *     reporting for the run instead. AM-68: reported as a fact about the NOTE.
 *     This walk reads every owned note and the `kind: 'hub'` test is below the
 *     unreadable branch, so an unreadable note here is not shown to be an index
 *     note at all - the folder gets a qualifier, never a state.
 *
 * Fail-closed on a half-record: `hub_levels` and `hub_values` are written together
 * and are read together. Such a note is still PRESENT (AM-55's second row) - it is
 * left as it is and accounted for - it just carries no chain this run can act on.
 */
async function readOwnedHubsByFolder(
	app: App,
	owned: IdentityIndex | undefined,
): Promise<{
	byFolder: Map<string, OwnedHubAtFolder>;
	unreadable: string[];
	misplaced: string[];
	/** AM-70. Every owned index note this walk read, whatever folder it sat in. */
	observed: { curie: string; path: string; folder: string; hasRecordedChain: boolean; role: 'hub' | 'implied' }[];
}> {
	const byFolder = new Map<string, OwnedHubAtFolder>();
	const unreadable: string[] = [];
	const misplaced: string[] = [];
	const observed: { curie: string; path: string; folder: string; hasRecordedChain: boolean; role: 'hub' | 'implied' }[] = [];
	// AM-68. The folders in which SOME note could not be read - a note-level fact,
	// applied at the end as a qualifier rather than as the folder's own state.
	const unreadableFolders = new Set<string>();
	if (!owned) return { byFolder, unreadable, misplaced, observed };
	for (const curie of owned.curies()) {
		const file = owned.get(curie);
		if (!file) continue;
		const folder = getParentPath(file.path);
		if (!folder) continue;
		// S8 (ruled 2026-09-02): the same discriminator every read in this file uses.
		// Cache lag is not absence.
		const read = await readFrontmatterForRun(app, file);
		if (read.state === 'unreadable') {
			unreadable.push(file.path);
			// AM-68 (2026-09-04). A FACT ABOUT A NOTE IS NOT A FACT ABOUT ITS FOLDER.
			//
			// This walk iterates every OWNED note, and the `kind: 'hub'` filter is eight
			// lines below - it cannot be asked of a note nothing could be read from. So
			// residual ruling 4's folder-level `unreadable` state was set by any
			// cache-cold concept note, and the message it unlocked said the folder's
			// INDEX NOTE could not be read: a claim about a note the run may never have
			// seen, printed beside this function's own warning, which deliberately says
			// "notes" for exactly this reason.
			//
			// The observation is kept where it was observed: the note is in
			// `unreadable[]` (which drives that warning and suppresses orphan reporting
			// for the run), and its folder is noted so row 3 can widen its sentence
			// WITHOUT naming a note. The folder's state is still decided by its readable
			// index note if it has one.
			unreadableFolders.add(folder);
			continue;
		}
		if (read.state !== 'ok') continue;
		const fm = read.frontmatter;
		const role = fm.kind === 'hub' ? 'hub' : typeof fm.implied_level === 'string' ? 'implied' : null;
		if (!role) continue;
		const values = readStringArray(role === 'hub' ? fm.hub_values : fm.implied_values);
		const levels = readStringArray(role === 'hub' ? fm.hub_levels : fm.implied_levels);
		const usable = values && values.length > 0 && levels && levels.length === values.length
			? values.map((value, i) => ({ level: levels[i], value }))
			: undefined;
		// AM-70. Recorded before any refusal below, because this is the fact the
		// accounting needs: an index note of this import that THIS RUN READ. Whether
		// the population reaches its folder is not this walk's question.
		//
		// `hasRecordedChain` travels with it because it decides whether the run can
		// SAY WHAT THE NOTE IS ABOUT. A hub carrying a usable chain answers that from
		// its own record, so a population that no longer reaches its folder means its
		// subject left the source - the orphan this feature exists to report. A hub
		// carrying no usable chain in a folder nothing reaches is the one the run can
		// say nothing about, and it is the one AM-70 names instead of judging.
		observed.push({ curie, path: file.path, folder, hasRecordedChain: usable !== undefined, role });
		// S12 (2026-09-04). THE NOTE'S OWN RECORD MUST DESCRIBE THE FOLDER IT SITS IN.
		//
		// Failure mode prevented: adoption. AM-55 keyed this map by placement and
		// dropped the `<folder>/<basename>.md` address requirement, which is what
		// stops a relocated hub answering for nothing - but nothing then checked the
		// recorded chain against the folder the note was found in. A `kind: 'hub'`
		// note a person drags into a sibling folder becomes THAT folder's recorded
		// identity: `recordedValuesOf` returns the moved hub's chain, `identityOf`
		// adopts its curie, its `hub_values` are written back, and on the next Replace
		// the note is physically renamed into the new folder under a meaning it never
		// had. The old address rule blocked this by accident; this blocks it on
		// purpose. The engine never adopts.
		//
		// Compared on the rendered last segment, both sides through the same
		// normalization the path itself received (AM-45's mirror), because a value and
		// the directory it produced are the same string only after those mutations.
		if (usable && !recordedChainDescribesFolder(usable, folder)) {
			misplaced.push(file.path);
			// S18 (2026-09-04). ONE VOICE PER FOLDER. This note is named in the S12
			// warning below, and the folder it sits in is now marked withheld, so the
			// enrichment pass does not ALSO announce that this import has no index note
			// for that folder. It has one; this run declines to use it.
			markIncomplete(byFolder, folder, 'withheld');
			continue;
		}
		const existing = byFolder.get(folder);
		// S18. A folder whose picture is already incomplete stays incomplete: a
		// second, readable hub in the same folder does not restore what the first one
		// made unanswerable.
		//
		// AM-68 (2026-09-04). `withheld` ALONE. The `unreadable` arm this also tested
		// discarded a perfectly readable index note because some other note in the
		// same folder was cache-cold - and then said the index note could not be read.
		// A note the run CAN read is the folder's answer.
		if (existing && existing.state === 'withheld') continue;
		// `absent` is never set during the walk - it is the qualifier pass's state for
		// a folder no readable index note was found in - so a second readable hub here
		// can only be joining one this walk already recorded.
		if (existing && (existing.state === 'one' || existing.state === 'many')) {
			// AM-59. Paths AND curies, index for index, so the refusal can account for
			// every note it names. Sorted by path so the message and the accounting are
			// in the same deterministic order.
			const pairs = existing.state === 'many'
				? existing.paths.map((p, i) => ({ path: p, curie: existing.curies[i], role: existing.roles?.[i] ?? 'hub' as const }))
				: [{ path: existing.path, curie: existing.curie, role: existing.role ?? 'hub' as const }];
			pairs.push({ path: file.path, curie, role });
			pairs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
			byFolder.set(folder, {
				state: 'many',
				paths: pairs.map((p) => p.path),
				curies: pairs.map((p) => p.curie),
				roles: pairs.map((p) => p.role),
			});
			continue;
		}
		byFolder.set(folder, { state: 'one', path: file.path, curie, role, ...(usable ? { values: usable } : {}) });
	}
	// AM-68. The qualifier, applied AFTER every readable note has had its say, so a
	// folder with a readable index note keeps that note's state and only gains the
	// note-level observation. A folder whose only owned note was unreadable has no
	// readable index note at all: that is AM-55's third row, qualified.
	for (const folder of unreadableFolders) {
		const existing = byFolder.get(folder);
		byFolder.set(folder, existing
			? { ...existing, hasUnreadableNote: true }
			: { state: 'absent', hasUnreadableNote: true });
	}
	// Deterministic order for the messages that name them.
	unreadable.sort();
	misplaced.sort();
	observed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { byFolder, unreadable, misplaced, observed };
}

/**
 * S18 (2026-09-04). Mark a folder as holding an index note this run READ and
 * declines to act on: S12's note, whose recorded chain describes a different
 * folder. The caller's own warning names that note, so the enrichment pass says
 * nothing more about the folder.
 *
 * Sticky and fail-closed: once a folder's picture is incomplete, a later readable
 * hub in the same folder does not restore it, because the first note is still
 * sitting there and the run still cannot say which one describes the folder.
 *
 * AM-68 (2026-09-04). ONE STATE, NOT TWO. Residual ruling 4 added an
 * `unreadable` folder state here; a folder is never marked from a note the run
 * could not show to be its index note, so the unreadable observation stays on the
 * note (`unreadable[]`) and reaches the folder only as the `hasUnreadableNote`
 * qualifier.
 *
 * Failure mode prevented: two voices about one folder, or none. Without any state
 * the folder was simply absent from the map, so the enrichment pass took AM-55's
 * third row and printed "This import has no index note for the folder ..." beside
 * a warning naming a note in that very folder.
 */
function markIncomplete(
	byFolder: Map<string, OwnedHubAtFolder>,
	folder: string,
	state: 'withheld',
): void {
	const existing = byFolder.get(folder);
	if (existing && existing.state === 'withheld') return;
	byFolder.set(folder, { state });
}

/**
 * S12. Does this hub note's recorded chain describe the folder it was found in?
 *
 * The chain's LAST value is the folder the note claims to be about, and the
 * folder's own last segment is what it actually is. Both go through
 * `normalizedPathPieces`, which applies the four mutations a rendered segment
 * receives on its way into a vault path, so a decomposed accent or a
 * non-breaking space cannot make an honest hub look misplaced. A value that
 * spans separators contributes several directories, and the LAST piece is the
 * one that names this folder.
 *
 * A note with no usable chain records nothing to contradict, so it is not asked
 * this question at all - it is AM-55's second row and is left exactly as it is.
 */
function recordedChainDescribesFolder(values: { level: string; value: string }[], folder: string): boolean {
	const valuePieces = normalizedPathPieces(values[values.length - 1].value);
	const folderPieces = normalizedPathPieces(basenameOf(folder));
	if (valuePieces.length === 0 || folderPieces.length === 0) return false;
	return valuePieces[valuePieces.length - 1] === folderPieces[folderPieces.length - 1];
}

/**
 * AM-62 (2026-09-04). The provenance block for a hub whose folder this run HELD.
 *
 * Two forms of one thing, so the caller can decide with the first and write with
 * the second:
 *   - `preserved` — exactly what the note already carries. Compared against the
 *     bytes on disk to answer "does this run have anything new to say".
 *   - `stamped` — the same block with `produced_at` moved, used only when the
 *     answer is yes.
 *
 * Failure mode prevented: a run that kept a folder rewriting the record of where
 * that folder's index note came from. The fresh block carries this run's
 * timestamp, this run's recipe hash, and whatever provenance fields the current
 * version emits - including ones the existing note predates. Merged in
 * wholesale, that is a run asserting authorship of a note it did not write.
 *
 * A note carrying no `_crosswalker` block at all (or an unreadable one) has
 * nothing to preserve, so the fresh block is used for both: writing provenance
 * onto a note that has none is a gain, not an overwrite.
 */
function heldHubProvenance(
	existingFrontmatter: Record<string, unknown>,
	fresh: unknown,
): { preserved: unknown; stamped: unknown } {
	const recorded = existingFrontmatter._crosswalker;
	if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) {
		return { preserved: fresh, stamped: fresh };
	}
	const preserved = recorded as Record<string, unknown>;
	const freshProducedAt = fresh && typeof fresh === 'object' && !Array.isArray(fresh)
		? (fresh as Record<string, unknown>).produced_at
		: undefined;
	return {
		preserved,
		stamped: freshProducedAt === undefined
			? preserved
			: { ...preserved, produced_at: freshProducedAt },
	};
}

/** Write a merged generated note only when bytes other than `produced_at` changed. */
async function writeMergedNote(
	app: App,
	file: TFile,
	frontmatter: Record<string, any>,
	body: string,
): Promise<boolean> {
	let existingFrontmatter: Record<string, unknown>;
	let onDisk: string;
	try {
		const existing = await readExistingNote(app, file);
		existingFrontmatter = existing.frontmatter;
		onDisk = await app.vault.read(file);
	} catch {
		await app.vault.modify(file, buildNoteContent(frontmatter, body));
		return true;
	}

	const recorded = existingFrontmatter._crosswalker;
	const fresh = frontmatter._crosswalker;
	const recordedProducedAt = recorded && typeof recorded === 'object' && !Array.isArray(recorded)
		? (recorded as Record<string, unknown>).produced_at
		: undefined;
	frontmatter._crosswalker = (
		recordedProducedAt !== undefined
		&& fresh
		&& typeof fresh === 'object'
		&& !Array.isArray(fresh)
	)
		? { ...(fresh as Record<string, unknown>), produced_at: recordedProducedAt }
		: fresh;
	const unchangedCandidate = buildNoteContent(frontmatter, body);
	if (unchangedCandidate === onDisk) return false;

	frontmatter._crosswalker = fresh;
	await app.vault.modify(file, buildNoteContent(frontmatter, body));
	return true;
}

/**
 * AM-75 (2026-09-04). One top-level properties key and the raw lines that are
 * written for it, newline excluded and otherwise exactly as they sit on disk.
 */
interface FrontmatterKeyBlock { key: string; lines: string[] }

/**
 * AM-75 (2026-09-04). Split a raw properties block into its top-level keys,
 * keeping every line as it is written.
 *
 * Deliberately textual, and deliberately a copy rather than an import. The same
 * rule already exists at `src/views/evidence-link-modal.ts:224` and is the
 * precedent AM-75 cites; it lives in a VIEW, and generation must not depend on
 * the UI layer (AM-58: a pure module stays pure, and the direction of that rule
 * is that the writer never reaches up into the host's windows). The two are kept
 * behaviourally identical on purpose: a key's block runs until the next line that
 * starts a top-level key, so indented lines, block-sequence dashes, comments and
 * blank lines belong to the key above them and travel with it.
 *
 * A trailing CR is part of the line's bytes here and is preserved: this splitter
 * is fed text split on `\n` alone, so a CRLF note's lines carry their own CR and
 * a merge cannot silently fold the file to LF.
 */
function frontmatterKeyBlocks(lines: readonly string[]): FrontmatterKeyBlock[] {
	const out: FrontmatterKeyBlock[] = [];
	let current: FrontmatterKeyBlock | null = null;
	for (const line of lines) {
		const bare = line.replace(/\r$/, '');
		const startsTopLevel = bare !== ''
			&& !/^[\s-]/.test(bare)
			&& !bare.trimStart().startsWith('#')
			&& bare.includes(':');
		if (startsTopLevel) {
			current = { key: bare.slice(0, bare.indexOf(':')).trim().replace(/^["']|["']$/g, ''), lines: [line] };
			out.push(current);
		} else if (current) {
			current.lines.push(line);
		} else {
			// Anything before the first key (a leading comment, a blank line) is
			// nobody's value and is kept under a key no writer can own.
			current = { key: '', lines: [line] };
			out.push(current);
		}
	}
	return out;
}

/**
 * AM-75 (2026-09-04). Rewrite named keys of a properties block by TEXT, leaving
 * every other byte of the block exactly as it was.
 *
 * A key present on disk and named in `replacements` is replaced by the given
 * lines. A key named in `replacements` and absent from disk is APPENDED at the
 * end of the block. Every other line - quoting, comments, blank lines, key order,
 * multi-line scalars, a value this product does not understand - is copied
 * verbatim.
 *
 * Failure mode prevented: the whole reason this function exists. Rebuilding the
 * block from a PARSED object and re-serialising it rewrites a user's own note:
 * `formatYamlValue` quotes any digit-leading string (`created: 2024-01-05` ->
 * `created: "2024-01-05"`), quotes on an apostrophe, drops comments and blank
 * lines, and - because its double-quote branch escapes only `"` - leaves a raw
 * newline inside a quoted scalar, so a multi-line property folds to a space on
 * the next read. That last one is a changed VALUE, not changed formatting, and
 * the note it changes is the user's concept note.
 */
function mergeFrontmatterKeyText(
	existingText: string,
	replacements: ReadonlyMap<string, string[]>,
	eol: string,
): string {
	// Split on `\n` alone so a CRLF note's CR stays attached to its own line and
	// is written back with it. Fresh lines take the note's own ending.
	const lines = existingText.split('\n');
	const suffix = eol === '\r\n' ? '\r' : '';
	const withEnding = (fresh: string[]): string[] => fresh.map((l) => `${l}${suffix}`);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const block of frontmatterKeyBlocks(lines)) {
		const fresh = replacements.get(block.key);
		if (fresh !== undefined && block.key !== '' && !seen.has(block.key)) {
			seen.add(block.key);
			out.push(...withEnding(fresh));
			continue;
		}
		out.push(...block.lines);
	}
	for (const [key, fresh] of replacements) {
		if (seen.has(key)) continue;
		out.push(...withEnding(fresh));
	}
	// C2 (2026-09-04). `FRONTMATTER_RE` consumes the separator before the closing
	// fence, so the captured text's FINAL line carries no `\r` even on a CRLF note
	// while every interior line does. A fresh block that lands last would otherwise
	// gain one and the caller's untouched `\r\n---` would follow it, writing
	// `\r\r\n` before the fence. One post-pass on the final element only, so this
	// function stays the identity when every replacement equals what it replaced
	// and no interior line moves.
	if (out.length > 0 && lines.length > 0) {
		const last = out.length - 1;
		if (!lines[lines.length - 1].endsWith('\r') && out[last].endsWith('\r')) {
			out[last] = out[last].slice(0, -1);
		}
	}
	return out.join('\n');
}

/** AM-75. Two managed lists are the same list when they name the same links in the same order. */
function sameLinkList(a: unknown, b: unknown): boolean {
	if (!Array.isArray(a) || !Array.isArray(b)) return false;
	if (a.length !== b.length) return false;
	return a.every((v, i) => v === b[i]);
}

/**
 * AM-72 (2026-09-04). Maintain the managed regions of a HOST note this run KEPT.
 *
 * A hosted folder's index content lives inside an ordinary row's note (the
 * sibling folder-note shape, which this module's own docs call the production
 * shape). When that row is one the run held, the patch loop dropped it, so the
 * managed `## Contents` region and the managed `children:` array permanently
 * named N-1 of N children after a Skip-existing refresh added one row under it -
 * with no deviation and no warning. AM-64 answered the identical question for a
 * held folder's SYNTHETIC index note by writing it when its children list
 * differs; the answer cannot depend on whether the folder's index note happens
 * to be a row.
 *
 * Failure mode prevented: a stale list inside the one part of a note the user is
 * told not to edit, because the next run owns it - and then the next run does not
 * own it.
 *
 * Skip existing's promise is kept exactly: only the regions this run maintains
 * are rebuilt, every other byte of the note survives, the recorded provenance is
 * preserved rather than replaced (AM-62), and the note is written only on a real
 * difference - so a refresh that changed nothing writes nothing. `produced_at`
 * moves only on a write.
 *
 * Only a HOST is maintained here (`patch.hubChildren` present). A held row that
 * is merely a `children_lists` parent is left exactly as it was: that is the
 * pre-existing behaviour and AM-72 does not reach it.
 *
 * ---------------------------------------------------------------------------
 * AM-75 (2026-09-04). WHOSE BYTES THIS WRITER IS HOLDING.
 *
 * The subject here is the USER'S OWN CONCEPT NOTE - `T1078.md` beside `T1078/` -
 * annotated through Obsidian's property editor. Its bytes are the user's, its
 * identity is the row's, and the only list this writer owns is the hosted
 * children list. AM-72 extended AM-64's mechanism to this new subject without
 * restating that, and the mechanism it inherited was designed against notes
 * Crosswalker itself wrote:
 *
 *   - the candidate was re-serialised from the PARSED frontmatter through
 *     `buildNoteContent`, so every property that is not a fixed point of
 *     parse-then-format came back changed. `created: 2024-01-05` gained quotes,
 *     an apostrophe gained quotes, YAML comments and blank lines disappeared,
 *     CRLF folded to LF, and a multi-line property took the double-quote branch
 *     whose escape covers only `"` - so its raw newline survived inside a quoted
 *     scalar and folded to a space on the next read. A changed VALUE.
 *   - the write trigger was WHOLE-NOTE byte inequality, so each of those
 *     differences was itself the reason to write, and `produced_at` was restamped
 *     on a Skip run that put nothing into the folder.
 *
 * The pre-amendment behaviour at the call site was a bare `continue` - no write
 * at all - so this is the only write a kept host receives under Skip existing,
 * and its failure direction rewrites a note the run promised to leave alone.
 *
 * So: the candidate is built from the note's raw properties bytes - the value
 * `ExistingNote.frontmatterText` carries for exactly this purpose, re-derived
 * here through the same one reader from the same bytes the write is compared
 * against, so the two halves of the decision cannot come from two reads - by a
 * TEXT-LEVEL merge
 * (precedent `src/views/evidence-link-modal.ts:316`). Only the `children:` block
 * and the `_crosswalker:` block are rewritten; the body changes only between the
 * existing managed-region markers; the note's line ending is taken from its own
 * bytes and kept. The trigger is the region difference AM-72 names - the hosted
 * children list differs from the links in the managed region, or from the
 * recorded `children:` - and only then does the byte comparison decide.
 *
 * AM-76 (2026-09-04). REBUILD MEANS WHAT EXISTS. A `children:` block on disk is
 * rebuilt; a `## Contents` region on disk is rebuilt; a host with neither is not
 * written at all and is voiced once. `mergeManagedChildrenSection`'s
 * append-when-absent path is not reached from here, which is why this writer
 * calls `replaceRegion` on a span it has already found rather than the merger.
 */
async function maintainHeldHostRegions(
	app: App,
	path: string,
	patch: { children?: string[]; hubChildren?: string[] },
	freshProvenance: unknown,
	/**
	 * AM-76. The folder this note hosts, as the pass that decided the hosting
	 * recorded it. Never derived from the note's path here.
	 */
	hostedFolder: string | undefined,
	result: GenerationResult,
	deviationsSeen: Set<string>,
	debug?: DebugLog,
): Promise<void> {
	if (!patch.hubChildren) return;
	const file = app.vault.getAbstractFileByPath(normalizePath(path));
	if (!(file instanceof TFile)) return;
	let existingNote: { frontmatter: Record<string, unknown>; body: string; frontmatterText: string };
	try {
		existingNote = await readExistingNote(app, file);
	} catch {
		// Fail-closed and silent about the note itself: without the read there is no
		// candidate to compare, and leaving a kept note exactly as it is the safe
		// direction. The run's own unreadable-note warning already speaks for a note
		// whose properties could not be read.
		debug?.info('generation', 'held-host-unreadable', `Kept host ${path} left as it was (properties could not be read)`, { path });
		return;
	}
	// The raw bytes, read once. Everything below is decided against these, and the
	// note is rebuilt out of them rather than out of a parsed value.
	let onDisk: string;
	try {
		onDisk = await app.vault.read(file);
	} catch {
		// Unreadable is not evidence of anything, least of all of a difference worth
		// writing. A kept note stays as it is.
		debug?.info('generation', 'held-host-unreadable', `Kept host ${path} left as it was (the file could not be read)`, { path });
		return;
	}
	// AM-75. The note's own line ending, taken from its first line break. Fresh
	// lines are written with it, so a CRLF note stays a CRLF note.
	const firstBreak = /\r?\n/.exec(onDisk);
	const eol = firstBreak && firstBreak[0] === '\r\n' ? '\r\n' : '\n';

	const split = splitNoteText(onDisk);
	const body = split.body;
	const prefix = onDisk.slice(0, onDisk.length - body.length);
	const fmStart = prefix.indexOf('\n') + 1;
	const fmEnd = fmStart + split.frontmatterText.length;
	const hasPropertiesBlock = prefix !== '' && prefix.slice(fmStart, fmEnd) === split.frontmatterText;
	if (prefix !== '' && !hasPropertiesBlock) {
		// The one reader and this writer disagree about where the block sits. That is
		// not a state to guess through on someone else's note.
		debug?.warn('generation', 'held-host-unlocatable-properties', `Kept host ${path} left as it was (its properties block could not be located byte-exactly)`, { path });
		return;
	}

	// --- What exists (AM-76). Read from the BYTES, not from a parsed value. ---
	const fmBlocks = hasPropertiesBlock ? frontmatterKeyBlocks(split.frontmatterText.split('\n')) : [];
	const hasChildrenKey = fmBlocks.some((b) => b.key === 'children');
	const hasProvenanceKey = fmBlocks.some((b) => b.key === '_crosswalker');
	const scan = scanRegions(body);
	if (!scan.ok) {
		// C4 (2026-09-04). MALFORMED IS NOT ABSENT. A duplicated, nested or unclosed
		// marker set is a verdict the scanner already reached; discarding it and
		// falling into the arm below would tell the user this note "carries no
		// managed Contents region", which is false, and would silently update the
		// `children:` key of a note whose body this writer cannot locate. Report the
		// scan's own code and detail the way the sibling hub writer does, and leave
		// every byte alone.
		recordConflict(result, debug, path, undefined, scan.code, scan.detail);
		return;
	}
	const span = findSpan(scan.spans, 'children');

	if (!hasChildrenKey && !span) {
		// AM-76. Neither region is there. Nothing is rebuilt, nothing is appended, and
		// the note is named once so the stale list is not a silence.
		//
		// C5 (2026-09-04). The folder is the hosting OBSERVATION or nothing. Falling
		// back to the note's parent path was exactly the path inference this writer's
		// own contract says it never makes, and it would put a folder name the run
		// never decided inside a sentence that reads as a finding. Without the
		// observation the sentence claims no folder.
		const named = hostedFolder !== undefined
			? `The note "${path}" hosts the folder "${hostedFolder}" but carries no managed Contents region; `
				+ 'it was left as it was.'
			: `The note "${path}" hosts a folder but carries no managed Contents region; `
				+ 'it was left as it was.';
		if (!deviationsSeen.has(named)) {
			deviationsSeen.add(named);
			result.warnings ??= [];
			result.warnings.push({ row: 0, message: named });
		}
		debug?.info('generation', 'held-host-no-region', `Kept host ${path} carries no managed region; left as it was`, { path });
		return;
	}

	// --- Has anything this writer owns actually changed? (AM-75's trigger.) ---
	const freshRegion = buildManagedChildrenSection('Contents', patch.hubChildren)
		.replace(/\n+$/, '')
		.replace(/\n/g, eol);
	// C1 (2026-09-04). The scanner's span ends AT the `\n` of the end-marker line,
	// so on a CRLF note the captured text carries that line's own `\r` while
	// `freshRegion` never does. Comparing the two raw made `regionChanged` true for
	// every CRLF host on every run, including an all-skip refresh that changed
	// nothing. Compare without the span's terminal CR, and carry that CR back on
	// substitution so the untouched `\n` just past `outerEnd` stays paired. A span
	// that ends at EOF with no newline captures no CR and is unaffected. The shared
	// scanner's offset contract is not touched: this is the caller's business.
	const spanText = span !== undefined ? body.slice(span.outerStart, span.outerEnd) : undefined;
	const spanTerminalCr = spanText !== undefined && spanText.endsWith('\r') ? '\r' : '';
	const regionChanged = spanText !== undefined && spanText.replace(/\r$/, '') !== freshRegion;
	const childrenChanged = hasChildrenKey
		&& patch.children !== undefined
		&& !sameLinkList(patch.children, existingNote.frontmatter.children);
	if (!regionChanged && !childrenChanged) {
		debug?.info('generation', 'held-host-unchanged', `Kept host ${path} left exactly as it was`, { path });
		return;
	}

	// --- Rebuild ONLY what changed hands, out of the bytes on disk. ---
	const held = heldHubProvenance(existingNote.frontmatter, freshProvenance);
	// AM-69/AM-80 (2026-09-04). THE FREEZE IS UNCONDITIONAL HERE, AND THAT IS NOT A
	// SECOND FORM OF THE RULE. The facet and level writers freeze recorded
	// provenance only when the folder has no write-set member; a kept host cannot
	// have one. A row in the write set is rewritten whole by the row writer and
	// never reaches this function, so `!hasWriteSetMember` is vacuously true at this
	// site and stating it would only invite a reader to look for the branch that
	// makes it false. What the `_crosswalker` block on a host describes is the ROW's
	// rendered content, and Skip existing did not regenerate that; the only thing
	// this run made is the region. `produced_at` therefore moves - and it is the
	// only provenance field that moves - because the run is about to write.
	const replacements = new Map<string, string[]>();
	if (hasChildrenKey && patch.children !== undefined) {
		replacements.set('children', formatYamlLine('children', patch.children, 0).split('\n'));
	}
	if (hasPropertiesBlock && held.stamped !== undefined) {
		// Rewritten in place when the block is there; appended at the end of the
		// properties when it is not, which is the one key this writer adds. A host
		// that records no provenance gains one rather than having one overwritten -
		// the reading the caller's own fresh-provenance block already states - and it
		// happens only on a run that is writing the note anyway.
		replacements.set('_crosswalker', formatYamlLine('_crosswalker', held.stamped, 0).split('\n'));
	}
	const mergedFrontmatter = hasPropertiesBlock
		? mergeFrontmatterKeyText(split.frontmatterText, replacements, eol)
		: split.frontmatterText;
	const mergedBody = span !== undefined
		? replaceRegion(body, scan.spans, 'children', freshRegion + spanTerminalCr)
		: body;
	const candidate = hasPropertiesBlock
		? prefix.slice(0, fmStart) + mergedFrontmatter + prefix.slice(fmEnd) + mergedBody
		: prefix + mergedBody;

	// AM-75. Only NOW does the byte comparison decide. It is the last gate, never
	// the trigger: whole-note inequality on a note whose properties are the user's
	// is not evidence that this run has anything to say.
	if (onDisk === candidate) {
		debug?.info('generation', 'held-host-unchanged', `Kept host ${path} left exactly as it was`, { path });
		return;
	}
	await app.vault.modify(file, candidate);
	debug?.info('generation', 'held-host-regions-rebuilt', `Kept host ${path}: managed regions rebuilt`, {
		path,
		children: patch.hubChildren.length,
		region: regionChanged,
		childrenKey: childrenChanged,
		provenanceExisted: hasProvenanceKey,
	});
}

/** The last path segment of a vault-relative folder path. */
function basenameOf(path: string): string {
	const i = path.lastIndexOf('/');
	return i === -1 ? path : path.slice(i + 1);
}

/**
 * Physically apply a hub relocation decided by `resolveHubTarget`. Returns the
 * path to write at: the destination when the move succeeded, and the note's
 * CURRENT path when the destination is already occupied by something this batch
 * did not produce. Refusing to move is always safe; clobbering is not.
 */
async function applyHubRelocation(
	app: App,
	target: { existingFile: TFile | null; writePath: string; moveFrom?: string },
	curie: string | null,
	result: GenerationResult,
	overwriteMode: 'skip' | 'replace' | 'error' | undefined,
	/**
	 * AM-20 (2026-08-31). The addresses this run has already put a note at.
	 *
	 * Failure mode prevented: a hub this run RELOCATED being refused, by a later
	 * hub resolving onto its new address, as a note that is not Crosswalker's.
	 * The vault-wide index is a pre-run snapshot and knows the moved note only
	 * under its OLD path, so `provenanceAt(newPath)` answers null and
	 * `addressRefusal` reads that as `not-crosswalker`. A rename is a mutation
	 * this run made, exactly like a create, so it is recorded exactly like one.
	 * Reachable when `hub_note_folder` overlaps a layout folder: the facet-hub
	 * loop relocates first, the level-hub loop resolves second.
	 */
	producedThisRun: Set<string>,
	debug?: DebugLog,
): Promise<string> {
	if (!target.moveFrom || !target.existingFile) return target.writePath;
	if (overwriteMode === 'skip') {
		// Leave it exactly where it is, and do not create the folder it would have
		// moved into: a destination that will receive nothing must not be built.
		debug?.info('generation', 'hub-relocation-skipped', `Hub ${curie ?? target.existingFile.path} left at ${target.moveFrom} (skip mode)`, {
			curie, from: target.moveFrom, to: target.writePath,
		});
		return target.existingFile.path;
	}
	if (app.vault.getAbstractFileByPath(target.writePath)) {
		result.warnings ??= [];
		result.warnings.push({
			row: 0,
			message: `Hub ${curie ?? target.existingFile.path}: left at ${target.moveFrom} because ${target.writePath} is already occupied.`,
		});
		return target.existingFile.path;
	}
	const parentPath = getParentPath(target.writePath);
	if (parentPath) await ensureFolderExists(app, parentPath).catch(() => {});
	await app.vault.rename(target.existingFile, target.writePath);
	// AM-20. A hub this run relocated is a note this run produced.
	producedThisRun.add(normalizePath(target.writePath));
	result.moved ??= [];
	result.moved.push({ curie: curie ?? '', from: target.moveFrom, to: target.writePath });
	debug?.info('generation', 'hub-relocated', `Hub ${curie ?? ''} moved`, { from: target.moveFrom, to: target.writePath });
	return target.writePath;
}

/**
 * AM-60 (2026-09-04). ONE POPULATION, ONE PASS - so this function is what is LEFT
 * of `markKeptHubsProduced`: the part that reports what could not be read.
 *
 * The two-pass shape is deleted. `markKeptHubsProduced` derived hubs from
 * `[...enrichRecords, ...keptRecords]` and marked their curies; `applyEnrichment`
 * derived them again from `enrichRecords` alone and wrote them. Every list computed
 * from the second, smaller population was wrong for the folder it named: in the
 * default mode (Skip existing) a refresh that adds one row rewrote every ancestor
 * hub's managed Contents to name that one row and dropped every sibling the folder
 * still holds. Two derivations of one thing are two answers waiting to disagree,
 * and these did. `applyEnrichment` now takes the whole in-scope population plus the
 * set of paths it may write, and there is no second derivation to keep in step.
 *
 * What remains here is the one thing that is not a derivation at all: a note the
 * host could not read, and a note whose recorded identity describes a different
 * folder (S12). Both mean the run's picture of the vault is incomplete, so orphan
 * reporting is suppressed for the run rather than published from it.
 * `project_cache_lag_is_not_absence`.
 *
 * Returns false when the picture is incomplete.
 */
function reportOwnedHubReadProblems(
	result: GenerationResult,
	ownedHubs: { unreadable: readonly string[]; misplaced: readonly string[] } | undefined,
	debug?: DebugLog,
): boolean {
	if (!ownedHubs) return true;
	let complete = true;
	if (ownedHubs.unreadable.length > 0) {
		const named = ownedHubs.unreadable.slice(0, 5).join(', ');
		const rest = ownedHubs.unreadable.length > 5 ? `, and ${ownedHubs.unreadable.length - 5} more` : '';
		result.warnings ??= [];
		result.warnings.push({
			row: 0,
			// Named as "notes", not as "index notes": a note nothing could be read from
			// cannot be shown to be an index note either, and a message that asserts
			// what the run could not observe is the shape this arc exists to remove.
			message: `Could not read ${ownedHubs.unreadable.length === 1 ? 'a note' : `${ownedHubs.unreadable.length} notes`} `
				+ `in this collection, so notes no longer in the source were not reported: ${named}${rest}. Wait for `
				+ 'Obsidian to finish indexing the vault, or fix the properties in those notes, then run the import again.',
		});
		debug?.warn('generation', 'kept-hub-unreadable', 'Owned notes could not be read during the enrichment pass', {
			paths: ownedHubs.unreadable,
		});
		complete = false;
	}
	if (ownedHubs.misplaced.length > 0) {
		// S12. Refused BY NAME. The folder does not inherit this note's identity, and
		// because the note is then accounted for by nothing, orphan reporting is
		// suppressed for the run rather than naming a note that is sitting in the
		// vault. One message per note, capped, with the two actions that resolve it.
		const named = ownedHubs.misplaced.slice(0, 5).map((p) => `"${p}"`).join(', ');
		const rest = ownedHubs.misplaced.length > 5 ? `, and ${ownedHubs.misplaced.length - 5} more` : '';
		result.warnings ??= [];
		result.warnings.push({
			row: 0,
			message: ownedHubs.misplaced.length === 1
				? `The index note ${named} records the identity of a different folder, so notes no longer in the source `
					+ 'were not reported. Move it back to the folder it describes, or delete it and run the import again '
					+ 'to have the folder\'s index note rebuilt.'
				: `${ownedHubs.misplaced.length} index notes record the identity of a different folder than the one they `
					+ `sit in, so notes no longer in the source were not reported: ${named}${rest}. Move them back to the `
					+ 'folders they describe, or delete them and run the import again to have those index notes rebuilt.',
		});
		debug?.warn('generation', 'hub-folder-mismatch', 'Index notes record a different folder than they sit in', {
			paths: ownedHubs.misplaced,
		});
		complete = false;
	}
	return complete;
}/**
 * Pass 1.5 enrichment patch phase (post-stream). Derives parent→children +
 * facet hubs from the in-memory records, then writes `children` onto parents and
 * materializes facet hub notes — both via the managed-merge path so re-imports
 * are idempotent and user prose / user frontmatter survives.
 *
 * Shared between `generateFromRecipe` (native Ch 22 recipes) and `generateNotes`
 * (the legacy column-role / workbench path) — `options` only needs the
 * structural subset both callers' option shapes carry (see
 * `EnrichmentWriteOptions`), so this one phase runs identically after either
 * write loop.
 */
/**
 * AM-60 (2026-09-04). ONE POPULATION, ONE PASS.
 *
 * `records` is the WHOLE in-scope population - the rows this run wrote and the
 * rows it kept - and `writeSet` is the subset whose note bodies this pass may
 * touch. Every derived thing (folders, chains, kept folders, refusals, hub
 * identity, and every Contents list) is computed over the whole population;
 * every write of a ROW's own note is confined to the write set.
 *
 * Failure mode prevented: a list the run maintains, rewritten from a batch that
 * cannot see everything the list names. This function used to receive
 * `enrichRecords` alone while a second pass received both, so in the default
 * mode - Skip existing - adding one control to an existing framework rewrote the
 * managed Contents of every ancestor hub to name that single new note and
 * dropped every sibling the folder still holds. Twenty links vanished from the
 * one region the user is told not to edit, with no warning, zero orphans and
 * every counter green. AM-56 asked whether the fresh list was EMPTY; the
 * question it did not ask is whether the fresh list was COMPLETE.
 */
async function applyEnrichment(
	app: App,
	recipe: Recipe,
	options: EnrichmentWriteOptions,
	curiePrefix: string,
	/**
	 * AM-60. The WHOLE in-scope population: the rows this run wrote and the rows it
	 * kept, in that order. Every derivation below reads this list.
	 */
	records: EnrichRecord[],
	/**
	 * AM-60. The paths whose OWN note bodies this pass may write - the rows this run
	 * actually produced. Skip existing means "leave this note's bytes alone", and it
	 * still does: a kept row contributes to every list and receives no write.
	 * Managed index notes are a separate decision (AM-55's table), because the run
	 * maintains those regions and a kept row's folder still has to be described.
	 *
	 * AM-61. Handed to `enrich()` as well, not just used here. A batch widened for
	 * reading is not widened for acting: every decision taken over the wider batch -
	 * which folders this run DESCRIBES, which it HOLDS, and which notes it plans to
	 * move - is told which half it may act on. Used here for the same reason at the
	 * three sites that touch the vault (the rename, the step-1 patch, and the
	 * address bypass below).
	 */
	writeSet: ReadonlySet<string>,
	result: GenerationResult,
	importSet: ImportSetReference,
	producedCuries: Set<string>,
	/**
	 * AM-31. The run's claim ledger, shared with the row loops. A hub is a writer
	 * like any other: it must not take an identity this run already produced, and
	 * it must record the one it takes so nothing later can take it again.
	 */
	curieOrigins: Map<string, ProducedCurieOrigin>,
	streamed: boolean,
	/**
	 * AM-12. Two indexes, two jobs: `owned` RESOLVES a hub to the note this set
	 * already has, `vaultWide` only DETECTS one held by a different set. Passing a
	 * single vault-wide index here is what let hub writes cross a set boundary.
	 */
	indexes: { owned?: IdentityIndex; vaultWide?: IdentityIndex } | undefined,
	/**
	 * AM-52/AM-55. What the vault holds at each folder, read once per run by the
	 * caller. AM-60: there is now one pass, so this is consulted by the one
	 * derivation rather than shared between two that could disagree.
	 */
	ownedHubsByFolder: OwnedHubsByFolder | undefined,
	/**
	 * AM-70. Every index note of this import the caller READ this run. Handed over
	 * so the one derivation can say which of them no note of the population reaches.
	 */
	observedHubs: readonly { curie: string; path: string; folder: string; hasRecordedChain: boolean; role?: 'hub' | 'implied' }[] | undefined,
	/** Observed implied identities already written by a row at their original address. */
	rowTakenOverImplied: ReadonlyMap<string, string>,
	/**
	 * AM-70. Filled here, read by the caller's orphan diff: the curies of index
	 * notes the run read and cannot judge. Never merged into `producedCuries` - this
	 * run wrote nothing for them and cannot describe them, so it neither vouches for
	 * them nor calls them vanished.
	 */
	observedUnjudgedCuries: Set<string>,
	/**
	 * AM-55. The run's deviation ledger. AM-60 leaves one pass, so this is now a
	 * within-pass guarantee that one folder's refusal is reported once, rather than
	 * a handshake between two passes that saw different populations.
	 */
	deviationsSeen: Set<string>,
	debug?: DebugLog,
): Promise<void> {
	const config = recipe.target.enrichment ?? {};
	// Hub/facet notes are synthetic (no source row → no concept identity), so
	// they carry recipe.hash but never concept_cid — see the two buildProvenance
	// calls below. Computed once per applyEnrichment call (one per generation run).
	const recipeHash = computeRecipeHash(recipe.target, recipe.source);
	// AM-72. One fresh block per run for the held-host writer below. Only its
	// `produced_at` is ever taken (`heldHubProvenance`), except on a host that
	// records no provenance at all, where writing one is a gain and not an
	// overwrite.
	const freshProvenance = buildProvenance(
		{ sourceFile: options.sourceFileName, sourceVersion: options.sourceVersion, sourceHash: options.sourceHash, recipeId: recipe.recipe, recipeHash, importSet },
		PLUGIN_VERSION,
	);
	const enrichment = enrich(
		records.map((r) => ({
			path: r.path,
			curie: r.curie,
			frontmatter: r.frontmatter,
			facets: r.facets,
			renderedPath: r.renderedPath,
			// AM-33: the values this row's folder levels rendered, carried to the hub pass.
			layoutValues: r.layoutValues,
		})),
		{
			ontology: curiePrefix,
			config,
			streamed,
			rootFolder: options.basePath,
			ownedHubsByFolder,
			// AM-61. The derivation is TOLD which half of the population it may act
			// on. Without it a kept row described its own folder and outranked the
			// identity the note on disk already carries, and `computeRelocations`
			// planned moves this pass then refused - a plan the same run contradicts.
			writeSet,
			// AM-70. What the run READ, so the derivation that knows which folders the
			// population reaches can name the notes it cannot judge.
			observedHubs,
		},
	);
	result.edgeCount = enrichment.edgeCount;

	// AM-70. Read straight back out to the caller's orphan diff. Kept OUT of
	// `producedCuries`: a claim records the origin of something this run wrote, and
	// this run wrote nothing for these notes and cannot say what they are about.
	for (const curie of enrichment.levelHubs.observedUnjudgedCuries) observedUnjudgedCuries.add(curie);

	// AM-55. Through the run's one ledger, so one folder's refusal is reported once.
	if (enrichment.deviations.length > 0) {
		result.warnings ??= [];
		for (const d of enrichment.deviations) {
			if (deviationsSeen.has(d)) continue;
			deviationsSeen.add(d);
			result.warnings.push({ row: 0, message: d });
		}
	}

	// AM-55 rows 2 and 4. An index note this run LEFT EXACTLY AS IT IS still exists,
	// so reporting it as no longer in the source is a claim the run has evidence
	// against - it read the note this pass. Such a folder emits no hub note (there is
	// no identity to write, or two identities to choose between), which is precisely
	// why its curie has to be accounted for here rather than by a write.
	//
	// Added, not CLAIMED (AM-31): a claim records the origin of something this run
	// wrote, and this run wrote nothing for these. Their folders are refused, so no
	// hub note can arrive at the same identity later in this pass.
	for (const curie of enrichment.levelHubs.keptExistingCuries) producedCuries.add(curie);

	const recordsByPath = new Map(records.map((r) => [r.path, r]));

	// AM-60. The write set, mutable only for a relocation this pass performs: the
	// note moves, so the one address this pass may write moves with it.
	const writePaths = new Set(writeSet);

	// AM-14. Every address THIS run has already written or kept. Both identity
	// indexes were built before the run started, so a note this run created is
	// absent from them; without this a hub resolving onto an address an earlier
	// row of the SAME run wrote would refuse itself as `not Crosswalker's`.
	// Ownership is the stamp on the note, and that stamp names this set.
	//
	// S17 (2026-09-04). THE BYPASS IS THE WRITE SET, not the population. A kept
	// note is an OCCUPANT of its address, not something this run produced there.
	// With the population widened (AM-60) every kept path entered this set, so a
	// synthetic level hub whose address happens to hold a kept row's note skipped
	// the ownership check entirely and merged into that note under a hub identity -
	// a write outside the write set, in the mode that promises not to touch it. The
	// ordinary same-set re-import is unaffected: a note stamped with this set is
	// admitted by `addressRefusal` on its own stamp, with no bypass needed.
	const producedThisRun = new Set<string>([
		...records.filter((r) => writeSet.has(r.path)).map((r) => normalizePath(r.path)),
		...result.created.map((path) => normalizePath(path)),
	]);
	// The row writer observed the original implied CURIE before its managed merge
	// removed the marker. The post-stream hub walk can no longer see that marker.
	// Require all three facts: original identity, successful row claim, same path.
	const rowOwnsObservedImplied = (
		file: TFile | null, candidateCurie: string | null, aliases: readonly string[] = [],
	): boolean => file instanceof TFile
		&& [...rowTakenOverImplied].some(([curie, path]) => {
			const claim = curieOrigins.get(curie);
			return (candidateCurie === curie || aliases.includes(curie))
				&& path === file.path && claim?.kind === 'row' && claim.path === path;
		});

	// 0. Parent-note relocations (batch-enrichment design §3 step 2) — physically
	//    move each file BEFORE the children-list patch below, which writes to
	//    the FINAL (post-relocation) path — enrichment.childrenByPath is
	//    already keyed by it. Processed in the order enrich() produced them
	//    (sorted by curie, deterministic). By the time this runs, the row
	//    write loop's resolveWriteTarget has already resolved every note to
	//    wherever it CURRENTLY lives (curie-verified), so most relocations here
	//    are genuinely NEW transitions — a note already in its target shape
	//    never appears in `enrichment.relocations` (enrich()'s idempotency
	//    guard), so re-importing the same config twice is a no-op here.
	for (const reloc of enrichment.relocations) {
		// AM-60. A relocation is a WRITE - it renames a file - so it is confined to
		// the write set like every other write. The population now includes the rows
		// this run kept, and Skip existing means the note stays exactly where it is;
		// moving one because the layout would now place it elsewhere is the opposite
		// of what the mode promises, and it is not a move the user asked for.
		if (!writePaths.has(reloc.from)) continue;
		const record = recordsByPath.get(reloc.from);
		const file = app.vault.getAbstractFileByPath(normalizePath(reloc.from));
		if (!record || !(file instanceof TFile)) {
			debug?.warn('generation', 'relocation-source-missing', `Could not relocate ${reloc.curie}: ${reloc.from} not found`, {
				curie: reloc.curie,
				from: reloc.from,
			});
			continue;
		}
		const toPath = normalizePath(reloc.to);
		if (app.vault.getAbstractFileByPath(toPath)) {
			// Shouldn't happen — enrich() already guards against in-batch path
			// collisions. Something outside this batch occupies the target;
			// leave the note where it is rather than risk clobbering it.
			result.warnings ??= [];
			result.warnings.push({
				row: 0,
				message: `parent_note: could not relocate ${reloc.curie} — ${toPath} already exists in the vault (not produced by this import).`,
			});
			continue;
		}
		const relocParentPath = getParentPath(toPath);
		if (relocParentPath) await ensureFolderExists(app, relocParentPath).catch(() => {});
		await app.vault.rename(file, toPath);
		producedThisRun.add(toPath);
		// AM-60. The note this pass may write is the same note at its new address.
		writePaths.delete(reloc.from);
		writePaths.add(toPath);

		recordsByPath.delete(reloc.from);
		record.path = toPath;
		recordsByPath.set(toPath, record);

		const createdIdx = result.created.indexOf(reloc.from);
		if (createdIdx !== -1) {
			result.created[createdIdx] = toPath;
		} else {
			const skippedIdx = result.skipped.indexOf(reloc.from);
			if (skippedIdx !== -1) result.skipped[skippedIdx] = toPath;
		}
	}

	// 1. Children lists + level-hub "hosted" Contents sections — combined into
	//    ONE write per note, since a note can be both a children_lists parent
	//    AND a level-hub host (the common case: a folder-note-relocated
	//    concept). `patch.children` → managed `children` frontmatter array
	//    (children_lists); `patch.hubChildren` → the managed body "Contents"
	//    section (level_hubs='notes', hosted folders — module doc step 4.5).
	const patchByPath = new Map<string, { children?: string[]; hubChildren?: string[]; parent?: { curie: string; label: string } }>();
	for (const [path, parent] of enrichment.parentByPath) {
		patchByPath.set(path, { ...(patchByPath.get(path) ?? {}), parent });
	}
	for (const [path, children] of enrichment.childrenByPath) {
		patchByPath.set(path, { ...(patchByPath.get(path) ?? {}), children });
	}
	for (const [path, children] of enrichment.levelHubs.hostedChildrenByPath) {
		patchByPath.set(path, { ...(patchByPath.get(path) ?? {}), hubChildren: children });
	}
	for (const [path, patch] of patchByPath) {
		// AM-60. Derived over the whole population, WRITTEN only for the rows this
		// run produced. A kept row's own note keeps its bytes - that is what Skip
		// existing promises - while still counting toward every list computed above,
		// which is the half that was missing. (This loop already refused to touch a
		// note absent from its batch, via `recordsByPath`; the batch is now the whole
		// population, so the write set is what carries that guarantee.)
		//
		// AM-72 (2026-09-04). EXCEPT THE MANAGED REGIONS OF A KEPT HOST. Skip
		// existing's promise covers the user's own prose and properties, not the list
		// this run tells the user not to edit by hand.
		if (!writePaths.has(path)) {
			await maintainHeldHostRegions(
				app,
				path,
				patch,
				freshProvenance,
				// AM-76. The folder this note hosts, from the pass that decided it.
				enrichment.levelHubs.hostedFolderByPath.get(path),
				result,
				deviationsSeen,
				debug,
			);
			continue;
		}
		const record = recordsByPath.get(path);
		if (!record) continue;
		const file = app.vault.getAbstractFileByPath(normalizePath(path));
		if (!(file instanceof TFile)) continue;
		// Rebuild deterministically: drop any STALE `children` (a prior import's
		// merge may have preserved it at the front, since render() doesn't emit it),
		// then re-append the fresh list just before the provenance block so the key
		// order is identical on every re-import (matches the golden shape).
		const { _crosswalker, children: _stale, ...rest } = record.frontmatter as Record<string, unknown>;
		void _stale;
		// Only previously stamped engine fields can be removed here. Recipe-declared
		// fields and unstamped user fields are outside enrichment's ownership.
		const declared = computeDeclaredManagedKeys(recipe.target.also_emit?.frontmatter);
		for (const key of recordedEngineParentKeys(rest)) {
			if (!declared.has(key)) delete rest[key];
		}
		delete rest[ENGINE_MANAGED_KEYS];
		const projectedParentKeys = patch.parent
			? ENGINE_PARENT_KEYS.filter((key) => !declared.has(key))
			: [];
		const frontmatter = {
			...rest,
			...(patch.children ? { children: patch.children } : {}),
			...(projectedParentKeys.includes('parent') ? { parent: `[[${patch.parent!.label}]]` } : {}),
			...(projectedParentKeys.includes('parent_curie') ? { parent_curie: patch.parent!.curie } : {}),
			...(projectedParentKeys.length > 0 ? { [ENGINE_MANAGED_KEYS]: projectedParentKeys } : {}),
			...(_crosswalker !== undefined ? { _crosswalker } : {}),
		};
		let body = record.body;
		if (patch.hubChildren) {
			// AM-56. `[]` is truthy, so this branch ran for a host with nothing to
			// list and appended a visible `## Contents` / `*(nothing yet)*` block to a
			// note that never carried one. An empty list rewrites a region, it never
			// creates one.
			body = mergeManagedChildrenSection(
				body,
				buildManagedChildrenSection('Contents', patch.hubChildren),
				patch.hubChildren.length === 0,
			);
			if (config.waypoint_marker) body = ensureWaypointMarker(body);
		}
		await writeMergedNote(app, file, frontmatter, body);
	}

	// 2. Facet hub notes — create or merge, preserving user body prose + user keys.
	const userPreserve = recipe.target.also_emit?.frontmatter?.user_preserve ?? [];
	for (const hub of enrichment.hubs) {
		const fullPath = options.basePath ? normalizePath(`${options.basePath}/${hub.path}`) : normalizePath(hub.path);
		const frontmatter: Record<string, any> = { ...hub.frontmatter };
		frontmatter._crosswalker = buildProvenance(
			{ sourceFile: options.sourceFileName, sourceVersion: options.sourceVersion, sourceHash: options.sourceHash, recipeId: recipe.recipe, recipeHash, importSet },
			PLUGIN_VERSION,
		);
		// Hub ownership and produced membership are recorded together. Splitting
		// these operations is what previously made successful hubs look orphaned.
		const hubCurie = typeof frontmatter.curie === 'string' ? frontmatter.curie : null;
		// AM-12. Detection before ownership: a hub identity claimed by another set is
		// reported and this hub is left entirely alone. Recording it as produced
		// first would vouch for a note this run refused to write.
		const foreignHub = foreignHubClaim(indexes?.owned, indexes?.vaultWide, hubCurie, hub.legacyCuries);
		if (foreignHub) {
			result.errors.push({ row: 0, message: crossSetCollisionMessage(foreignHub.curie, foreignHub.claim) });
			continue;
		}
		// Identity first: a facet hub curie is already address-independent, but it
		// was resolved by path alone, so a changed destination created a duplicate
		// instead of finding the hub that exists.
		//
		// AM-14. Resolved BEFORE the hub is recorded as produced, for the same
		// reason AM-12's detection is: a hub refused at its address is a hub this
		// run never wrote, and marking it produced would both vouch for a note that
		// does not exist and hide a real orphan behind it.
		const target = resolveHubTarget(
			app,
			fullPath,
			hubCurie,
			hub.legacyCuries,
			indexes?.owned,
			indexes?.vaultWide,
			importSet.id,
			producedThisRun,
		);
		if (target.refusal) {
			reportAddressRefusal(result, debug, target.refusal, 0, hubCurie ?? undefined);
			continue;
		}
		// AM-31. The within-run duplicate guard, at a hub writer. A facet value and
		// a row identity, or two facet values whose slug collapses (`Access Control`
		// and `access-control`), can produce one curie; before this the second was
		// written anyway, leaving the vault holding one identity twice - permanent,
		// and fatal to every later import in that vault. Refused HERE, above every
		// write and above the relocation, so a refused hub is one this run never
		// touched.
		if (hubCurie) {
			const firstClaim = claimProducedCurie(producedCuries, curieOrigins, hubCurie, {
				row: 0, path: fullPath, kind: 'hub',
			});
			if (firstClaim) {
				result.errors.push({ row: 0, message: duplicateHubCurieMessage(hubCurie, fullPath, firstClaim) });
				continue;
			}
		}
		let body = hub.body;

		const existing = target.existingFile;
		// AM-64 (2026-09-04). THE FACET HUB'S PROVENANCE, AS RECORDED, read before the
		// merge replaces it. Used only to answer "does this run have anything new to
		// say about this note" - a candidate carrying THIS run's `produced_at` differs
		// from the note on disk every single time, so a comparison against the fresh
		// block could never answer anything. An unreadable note yields nothing to
		// preserve, which falls through to the write: the behaviour this writer had
		// before the amendment, and the safe direction.
		//
		// AM-69 (2026-09-04). READ ONLY FOR A RUN THAT WROTE NONE OF ITS MEMBERS. The
		// freeze exists for the run that did not write the note; a run that did earns
		// the fresh block. See the write below.
		let recordedFacetProvenance: unknown;
		if (!hub.hasWriteSetMember && existing instanceof TFile) {
			try {
				recordedFacetProvenance = (await readExistingNote(app, existing)).frontmatter._crosswalker;
			} catch {
				recordedFacetProvenance = undefined;
			}
		}
		const writePath = await applyHubRelocation(app, target, hubCurie, result, options.overwriteMode, producedThisRun, debug);
		if (existing instanceof TFile) {
			// Re-import through the SAME shared merger the row writes use. `kind:
			// 'facet-hub'` selects adopt-by-replay: `mergeHubBody` was already
			// non-destructive, so an equality rule would REGRESS a working path and
			// stop hubs updating. A facet hub therefore never conflicts on its body,
			// only on unreadable properties or corrupt markers.
			// AM-31. The superseded identity is claimed too, and by the same rule: if
			// something else in this run already produced it, two writers disagree
			// about one identity and neither may proceed silently.
			if (target.adoptedAlias) {
				const firstClaim = claimProducedCurie(producedCuries, curieOrigins, target.adoptedAlias, {
					row: 0, path: existing.path, kind: 'hub',
				});
				if (firstClaim) {
					result.errors.push({
						row: 0,
						message: duplicateHubCurieMessage(target.adoptedAlias, existing.path, firstClaim),
					});
					continue;
				}
			}
			const outcome = await mergeExistingNote({
				app,
				file: existing,
				freshFrontmatter: frontmatter,
				managedKeys: computeManagedKeys(frontmatter, userPreserve),
				freshManagedBody: hub.body,
				kind: 'facet-hub',
			});
			if (!outcome.ok) {
				recordConflict(result, debug, writePath, hubCurie ?? undefined, outcome.code, outcome.detail);
				continue;
			}
			Object.keys(frontmatter).forEach((k) => delete frontmatter[k]);
			Object.assign(frontmatter, outcome.frontmatter);
			body = outcome.body;
			// AM-64 (2026-09-04). THE AM-62 RULE, AT THE SECOND HUB WRITER. An existing
			// facet hub is written only when its managed region or its members list
			// actually differs, and `produced_at` moves only on a write.
			//
			// Failure mode prevented: a run that wrote no note touching every facet hub
			// in the vault. AM-62 closed this at the level-hub writer and left this one
			// open, which the gate hid; with the gate gone (AM-64) an all-skip refresh
			// reaches this loop, and without the rule it would restamp every facet hub -
			// new mtime, new `produced_at`, provenance fields the notes never carried -
			// on a pass that produced nothing.
			//
			// The comparison is against the bytes on disk, with the recorded provenance
			// put back, so everything else in the candidate is what the merge just
			// derived. A serialization difference therefore fails SAFE: the run writes,
			// which is what this writer did before.
			//
			// AM-69 (2026-09-04). PROVENANCE BELONGS TO THE RUN THAT WROTE THE NOTE;
			// THE FREEZE IS FOR THE RUN THAT DID NOT. Gated on `hasWriteSetMember`,
			// mirroring the level writer's `if (hub.heldFolder)` below.
			//
			// Failure mode prevented: one import set holding two answers to "which
			// recipe produced this", split by note kind. Pass 21 applied the freeze to
			// EVERY facet write, so a Replace re-import with a revised recipe wrote the
			// facet hub's new members list while recording the PREVIOUS recipe's hash,
			// source file and plugin version - and, because the preservation was
			// unconditional, no later run could ever restamp it. An `import_set`
			// sub-field added after the note was first written could never land on a
			// facet hub, and `agreedDerivation` refuses a partly-stamped set by name.
			//
			// A run that wrote one of this hub's members authored its current content
			// and says so: the fresh block from the managed-key merge, as before pass
			// 21. A run that wrote none of them keeps what the note records and moves
			// `produced_at` only if something else actually differs.
			if (!hub.hasWriteSetMember) {
				const facetProvenance = heldHubProvenance({ _crosswalker: recordedFacetProvenance }, frontmatter._crosswalker);
				frontmatter._crosswalker = facetProvenance.preserved;
				const facetCandidate = buildNoteContent(frontmatter, body);
				let facetOnDisk: string | null = null;
				try {
					facetOnDisk = await app.vault.read(existing);
				} catch {
					facetOnDisk = null;
				}
				if (facetOnDisk !== null && facetOnDisk === facetCandidate) {
					debug?.info('generation', 'facet-hub-unchanged', `Facet hub ${hubCurie ?? writePath} left exactly as it was`, {
						path: writePath,
					});
					continue;
				}
				frontmatter._crosswalker = facetProvenance.stamped;
			}
			await app.vault.modify(existing, buildNoteContent(frontmatter, body));
		} else {
			// AM-64. AN ABSENT FACET HUB IS CREATED ONLY FOR A RUN THAT WROTE ONE OF ITS
			// MEMBERS. Its curie is already claimed above, so the hub is ACCOUNTED FOR
			// and simply not written - the orphan pass will not call it vanished.
			//
			// Failure mode prevented: a run that wrote nothing inventing notes. Every
			// member of this hub is a row the run held, so the facet note describes
			// notes nobody touched; creating it also re-creates one the user deleted on
			// purpose, on the pass that was supposed to leave the vault alone.
			if (!hub.hasWriteSetMember) {
				debug?.info('generation', 'facet-hub-not-created', `Facet hub ${hubCurie ?? writePath} accounted for, not created`, {
					path: writePath,
				});
				continue;
			}
			body = wrapManagedBody(hub.body);
			const parentPath = getParentPath(writePath);
			if (parentPath) await ensureFolderExists(app, parentPath).catch(() => {});
			await app.vault.create(writePath, buildNoteContent(frontmatter, body));
			result.created.push(writePath);
			producedThisRun.add(normalizePath(writePath));
		}
	}

	// AM-33 step 3's index. Built once, and only when at least one level hub
	// actually carries recorded values, so an import with no level hubs (or one
	// whose hubs predate the values) pays nothing for it.
	const hubValueIndex = [...enrichment.impliedConcepts, ...enrichment.levelHubs.notes].some((h) => h.levelValues && h.levelValues.length > 0)
		? await buildOwnedHubValueIndex(app, indexes?.owned)
		: undefined;


	// Implied concepts are first-class notes, but share the index-note reconciliation
	// ladder. Each claim happens before a move or write; a legacy hub alias is also
	// claimed so adoption cannot create an orphan on the same refresh.
	for (const note of enrichment.impliedConcepts) {
		const fullPath = normalizePath(note.path);
		const curie = note.curie;
		const foreign = foreignHubClaim(indexes?.owned, indexes?.vaultWide, curie, note.legacyCuries);
		if (foreign) {
			result.errors.push({ row: 0, message: crossSetCollisionMessage(foreign.curie, foreign.claim) });
			continue;
		}
		const target = resolveHubTarget(app, fullPath, curie, note.legacyCuries,
			indexes?.owned, indexes?.vaultWide, importSet.id, producedThisRun,
			{ levelValues: note.levelValues, index: hubValueIndex });
		if (target.refusal) {
			reportAddressRefusal(result, debug, target.refusal, 0, curie);
			continue;
		}
		const existing = target.existingFile;
		if (rowOwnsObservedImplied(existing, curie, [...(note.legacyCuries ?? []), ...(target.adoptedAlias ? [target.adoptedAlias] : [])])) continue;
		if (existing instanceof TFile && target.adoptedAlias && options.overwriteMode === 'skip') {
			const first = claimProducedCurie(producedCuries, curieOrigins, target.adoptedAlias,
				{ row: 0, path: existing.path, kind: 'implied' });
			if (first) result.errors.push({ row: 0, message: duplicateHubCurieMessage(target.adoptedAlias, existing.path, first) });
			// The enrichment pass already names every skipped legacy folder in one deviation.
			continue;
		}
		const first = claimProducedCurie(producedCuries, curieOrigins, curie,
			{ row: 0, path: fullPath, kind: 'implied' });
		if (first) {
			result.errors.push({ row: 0, message: duplicateHubCurieMessage(curie, fullPath, first) });
			continue;
		}
		if (existing instanceof TFile && target.adoptedAlias && target.adoptedAlias !== curie) {
			const aliasClaim = claimProducedCurie(producedCuries, curieOrigins, target.adoptedAlias,
				{ row: 0, path: existing.path, kind: 'implied' });
			if (aliasClaim) {
				result.errors.push({ row: 0, message: duplicateHubCurieMessage(target.adoptedAlias, existing.path, aliasClaim) });
				continue;
			}
		}
		if (note.heldFolder && !(existing instanceof TFile)) continue;
		const frontmatter: Record<string, any> = { ...note.frontmatter,
			_crosswalker: buildProvenance({ sourceFile: options.sourceFileName,
				sourceVersion: options.sourceVersion, sourceHash: options.sourceHash,
				recipeId: recipe.recipe, recipeHash, importSet }, PLUGIN_VERSION) };
		const writePath = note.heldFolder && existing instanceof TFile ? existing.path
			: await applyHubRelocation(app, target, curie, result, options.overwriteMode, producedThisRun, debug);
		let body = note.body;
		if (existing instanceof TFile) {
			let old: { frontmatter: Record<string, unknown>; body: string };
			try { old = await readExistingNote(app, existing); }
			catch (error) {
				recordConflict(result, debug, writePath, curie, 'frontmatter-unreadable',
					error instanceof Error ? error.message : String(error));
				continue;
			}
			const scan = scanRegions(old.body);
			if (!scan.ok) {
				recordConflict(result, debug, writePath, curie, scan.code, scan.detail);
				continue;
			}
			try {
				const managed = computeManagedKeys(frontmatter, userPreserve,
					['kind', ...HUB_VALUE_RECORD_KEYS, 'implied_levels', 'implied_values', 'parent', 'parent_curie']);
				const merged = mergeFrontmatter(old.frontmatter, frontmatter, managed);
				Object.keys(frontmatter).forEach((key) => delete frontmatter[key]);
				Object.assign(frontmatter, merged);
			} catch (error) {
				recordConflict(result, debug, writePath, curie, 'frontmatter-merge-failed',
					error instanceof Error ? error.message : String(error));
				continue;
			}
			body = mergeManagedChildrenSection(old.body,
				buildManagedChildrenSection('Contents', note.childrenLinks ?? []),
				(note.childrenLinks ?? []).length === 0);
			if (config.waypoint_marker) body = ensureWaypointMarker(body);
			if (note.heldFolder) {
				const held = heldHubProvenance(old.frontmatter, frontmatter._crosswalker);
				frontmatter._crosswalker = held.preserved;
				const candidate = buildNoteContent(frontmatter, body);
				let onDisk: string | null = null;
				try { onDisk = await app.vault.read(existing); } catch { /* Fail closed on unreadable comparison. */ }
				if (onDisk === candidate) continue;
				frontmatter._crosswalker = held.stamped;
			}
			if (note.heldFolder) await app.vault.modify(existing, buildNoteContent(frontmatter, body));
			else await writeMergedNote(app, existing, frontmatter, body);
		} else {
			if (config.waypoint_marker) body = ensureWaypointMarker(body);
			const parent = getParentPath(writePath);
			if (parent) await ensureFolderExists(app, parent);
			await app.vault.create(writePath, buildNoteContent(frontmatter, body));
			result.created.push(writePath);
			producedThisRun.add(writePath);
		}
	}
	// 3. Synthetic level-hub notes (level_hubs='notes', pure structural folders
	//    with no hosting concept note — module doc step 4.5). `hub.path` here is
	//    ALREADY a full vault-relative path (it was built from `rootFolder`,
	//    i.e. `options.basePath`) — unlike facet `hub.path` above (relative to
	//    `hub_note_folder`), this one must NOT be re-prefixed with basePath.
	for (const hub of enrichment.levelHubs.notes) {
		const fullPath = normalizePath(hub.path);
		const frontmatter: Record<string, any> = { ...hub.frontmatter };
		frontmatter._crosswalker = buildProvenance(
			{ sourceFile: options.sourceFileName, sourceVersion: options.sourceVersion, sourceHash: options.sourceHash, recipeId: recipe.recipe, recipeHash, importSet },
			PLUGIN_VERSION,
		);
		// Hub ownership and produced membership are recorded together. Splitting
		// these operations is what previously made successful hubs look orphaned.
		const hubCurie = typeof frontmatter.curie === 'string' ? frontmatter.curie : null;
		// AM-12. Detection before ownership: a hub identity claimed by another set is
		// reported and this hub is left entirely alone. Recording it as produced
		// first would vouch for a note this run refused to write.
		const foreignHub = foreignHubClaim(indexes?.owned, indexes?.vaultWide, hubCurie, hub.legacyCuries);
		if (foreignHub) {
			result.errors.push({ row: 0, message: crossSetCollisionMessage(foreignHub.curie, foreignHub.claim) });
			continue;
		}
		// Identity first, with the address-derived legacy forms accepted as aliases.
		// A level hub whose curie moved with its folder is the silent case: no
		// collision, no error, just two files and a batch of new orphans. The alias
		// is what lets the existing note keep its content and be restamped instead.
		//
		// AM-14. Resolved BEFORE the hub is recorded as produced, for the same
		// reason AM-12's detection is: a hub refused at its address is a hub this
		// run never wrote, and marking it produced would vouch for a note that does
		// not exist.
		const target = resolveHubTarget(
			app,
			fullPath,
			hubCurie,
			hub.legacyCuries,
			indexes?.owned,
			indexes?.vaultWide,
			importSet.id,
			producedThisRun,
			// AM-33 step 3: the values this hub is about, and the owned hubs that
			// record theirs. Consulted only after both computed forms miss.
			{ levelValues: hub.levelValues, index: hubValueIndex },
		);
		if (target.refusal) {
			reportAddressRefusal(result, debug, target.refusal, 0, hubCurie ?? undefined);
			continue;
		}
		if (rowOwnsObservedImplied(target.existingFile, hubCurie, [...(hub.legacyCuries ?? []), ...(target.adoptedAlias ? [target.adoptedAlias] : [])])) continue;
		// An earlier implied concept is not a synthetic hub merely because the
		// current recipe no longer flags its folder. Never adopt or claim it here:
		// its recorded concept curie belongs in the orphan report instead.
		if (target.existingFile instanceof TFile) {
			let existingFrontmatter: Record<string, unknown>;
			try { existingFrontmatter = (await readExistingNote(app, target.existingFile)).frontmatter; }
			catch (error) {
				recordConflict(result, debug, target.existingFile.path, hubCurie ?? undefined,
					'frontmatter-unreadable', error instanceof Error ? error.message : String(error));
				continue;
			}
			if (existingFrontmatter.implied_level !== undefined) {
				const folder = getParentPath(fullPath) ?? fullPath;
				const message = `The folder "${folder}" holds a concept note from an earlier import, so no index note was written there. Turn the implied concept level back on for that level, or delete the note, then run again.`;
				if (!deviationsSeen.has(message)) {
					result.warnings ??= [];
					result.warnings.push({ row: 0, message });
					deviationsSeen.add(message);
				}
				continue;
			}
		}
		// AM-31. Same guard as the facet hubs above, at the other hub writer. One
		// rule, all writers: a level hub that would take an identity this run
		// already produced is refused by name rather than written into a collision.
		if (hubCurie) {
			const firstClaim = claimProducedCurie(producedCuries, curieOrigins, hubCurie, {
				row: 0, path: fullPath, kind: 'hub',
			});
			if (firstClaim) {
				result.errors.push({ row: 0, message: duplicateHubCurieMessage(hubCurie, fullPath, firstClaim) });
				continue;
			}
		}
		let body = hub.body;

		const existing = target.existingFile;
		// The adopted alias is recorded as produced so the identity this run
		// deliberately superseded is not then reported as a note that vanished.
		// AM-31: claimed, not merely added, so a second writer of that same
		// superseded identity is refused rather than silently agreed with.
		//
		// AM-39. Claimed ABOVE the relocation, exactly as the curie claim above is.
		// AM-31's invariant is "above every write and above the relocation", and
		// this was the one claim below it. It was unreachable until AM-33 step 3,
		// whose whole purpose is an alias on a note that has MOVED: a hub refused
		// here after the move had already run was physically renamed to the new
		// address and then abandoned by `continue` with nothing written into it, so
		// a refusal left the vault rearranged. A refusal must leave the vault
		// exactly as it found it.
		if (existing instanceof TFile && target.adoptedAlias) {
			const firstClaim = claimProducedCurie(producedCuries, curieOrigins, target.adoptedAlias, {
				row: 0, path: existing.path, kind: 'hub',
			});
			if (firstClaim) {
				result.errors.push({
					row: 0,
					message: duplicateHubCurieMessage(target.adoptedAlias, existing.path, firstClaim),
				});
				continue;
			}
		}
		// AM-64 (2026-09-04). A HELD-ONLY FOLDER'S ABSENT INDEX NOTE IS NEVER CREATED.
		//
		// Its curie is already claimed above, so the folder is ACCOUNTED FOR and
		// simply not written; the orphan pass will not call it vanished. Reached when
		// the user deleted the index note of a folder this run wrote nothing into -
		// AM-55's third row, refused by name in the deviation the derivation already
		// emitted. Restoring it here would be the run undoing a deletion on a pass
		// that was meant to leave the folder alone.
		//
		// AM-71 (2026-09-04). THE IMPORT ROOT IS EXEMPT. Its identity is the set's own
		// reserved local part, so an absent root note is not a folder whose recorded
		// meaning the run would be guessing at - there is nothing recorded. Refusing
		// it left an import with no home note and, because `refusalFor` exempts the
		// root, no message either: silence on a pre-fix flat vault or after the user
		// deleted the home note. Created with fresh provenance, since there is nothing
		// recorded to preserve; an EXISTING root on an all-skip run is untouched by
		// the byte rule below.
		if (hub.heldFolder && !hub.importRoot && !(existing instanceof TFile)) {
			debug?.info('generation', 'held-hub-not-created', `Hub ${hubCurie ?? fullPath} accounted for, not created`, {
				path: fullPath,
			});
			continue;
		}
		// AM-64. A held-only folder's index note is not MOVED either: a rename is a
		// write, and this run has nothing new to say about the folder. The relocation
		// exists for a hub whose address the run is actively re-deciding, which is a
		// described folder's hub. Without this, an all-skip refresh could still rename
		// an index note the user had renamed by hand.
		//
		// Ruling 2 (pass 21, ratified): A HELD-ONLY HUB IS NEVER RELOCATED, and a hub
		// the user renamed by hand keeps the name they gave it on any run that writes
		// nothing into its folder. Relocations are planned over the write set alone
		// (AM-61), and a rename is a write - so this is that rule reaching the one
		// writer that could still have performed one.
		const writePath = hub.heldFolder && existing instanceof TFile
			? existing.path
			: await applyHubRelocation(app, target, hubCurie, result, options.overwriteMode, producedThisRun, debug);
		if (existing instanceof TFile) {
			// Re-import: regenerate the managed Contents section, preserve user
			// frontmatter + any prose outside it (title, notes, etc.).
			//
			// A synthetic level hub gets NO `body` region in v1 (contract §2.3): it
			// has no row render, and its entire managed content IS `children`. So it
			// merges through the children region alone, not through mergeExistingNote.
			// The frontmatter read is still the fail-closed one: a cache miss must
			// never look like "this note has no properties".
			let existingNote: { frontmatter: Record<string, unknown>; body: string };
			try {
				existingNote = await readExistingNote(app, existing);
			} catch (readErr) {
				const detail = readErr instanceof ExistingNoteReadError ? readErr.detail : String(readErr);
				recordConflict(result, debug, writePath, hubCurie ?? undefined, 'frontmatter-unreadable', detail);
				continue;
			}
			const scan = scanRegions(existingNote.body);
			if (!scan.ok) {
				recordConflict(result, debug, writePath, hubCurie ?? undefined, scan.code, scan.detail);
				continue;
			}
			if (Object.keys(existingNote.frontmatter).length > 0) {
				try {
					// AM-39. `hub_levels`/`hub_values` are ALWAYS managed on a hub, even
					// in a run that computes none. Managed keys are otherwise the keys
					// the fresh frontmatter happens to carry, so a run that could not
					// compute values simply omitted them and the merge preserved the
					// note's OLD values as if they were a user annotation. A stale
					// record is worse than no record: the value index keeps offering
					// that note as the hub for values it no longer covers, and step 3
					// then moves it and restamps it into a folder that is about
					// something else. Declaring them managed makes "no values this run"
					// delete the claim instead of leaving it standing.
					const managedKeys = computeManagedKeys(frontmatter, userPreserve, HUB_VALUE_RECORD_KEYS);
					const merged = mergeFrontmatter(existingNote.frontmatter, frontmatter, managedKeys);
					Object.keys(frontmatter).forEach((k) => delete frontmatter[k]);
					Object.assign(frontmatter, merged);
				} catch (mergeErr) {
					recordConflict(result, debug, writePath, hubCurie ?? undefined, 'frontmatter-merge-failed',
						mergeErr instanceof Error ? mergeErr.message : String(mergeErr));
					continue;
				}
			}
			// hub.facetLinks: the ROOT hub only (enrich.ts's computeLevelHubs) —
			// re-derive the same "Facets" extraGroup a fresh import would build,
			// so a re-import doesn't silently drop it (the merge rebuilds the
			// managed section from these fields, never by re-parsing `body`).
			const facetGroup = hub.facetLinks ? [{ label: 'Facets', links: hub.facetLinks }] : [];
			const freshSection = buildManagedChildrenSection('Contents', hub.childrenLinks ?? [], facetGroup);
			// AM-56. An empty section never CREATES a managed region on a note that
			// has none; it only rewrites one this run already maintains.
			const freshIsEmpty = (hub.childrenLinks ?? []).length === 0
				&& facetGroup.every((g) => g.links.length === 0);
			body = mergeManagedChildrenSection(existingNote.body, freshSection, freshIsEmpty);
			if (config.waypoint_marker) body = ensureWaypointMarker(body);
			if (hub.heldFolder) {
				// AM-62 (2026-09-04). A RUN THAT HAS NOTHING NEW TO SAY DOES NOT SAY IT
				// AGAIN.
				//
				// This hub describes a folder the run HELD: no row it wrote reaches that
				// folder, and the hub's identity and recorded values were read back off
				// this very note. The only thing this run can legitimately change here is
				// the children list. Everything the note already records about where it
				// came from is kept as recorded - a run that wrote nothing for this
				// folder has no standing to restamp when the note was produced, which
				// plugin version produced it, or which recipe hash it came from, and
				// adding a provenance field the note never carried is a change made to a
				// note the user was told would be left alone.
				//
				// `produced_at` therefore moves only when the note is actually written,
				// and the comparison is against the bytes on disk: a byte-identical write
				// is not a write. Without this, every index note in an untouched part of
				// a collection took a new modification time on a refresh that changed one
				// row somewhere else.
				const held = heldHubProvenance(existingNote.frontmatter, frontmatter._crosswalker);
				frontmatter._crosswalker = held.preserved;
				// AM-64 (2026-09-04). IDENTITY IS PRESERVED TOO, not only provenance.
				//
				// For a folder held with a recorded identity the two already agree - the
				// derivation read the curie off this very note (AM-61). They part company
				// at the IMPORT ROOT, whose identity is the set's own reserved local part
				// and is therefore recomputed every run: on a vault whose root hub was
				// written under the older address-derived form, an all-skip refresh
				// rewrote that note purely to restamp its curie. A run that wrote nothing
				// into a folder does not re-identify its index note; a Replace run, which
				// writes rows into the folder, is not held and restamps as before.
				//
				// AM-73 (2026-09-04). THE SHAPE TEST, AND THE NAME WHEN IT FAILS. Residual
				// ruling 5 names a recorded identity that is not this import's and never
				// repairs it, but that naming lives in `refusalFor`, behind
				// `keptFolders` - which excludes the import root by construction. So the
				// root's recorded curie was the one recorded identity carried forward with
				// no test and no message: a hand edit, or a prefix from before an ontology
				// rename, was written back on every held run in silence.
				//
				// Carried either way (never repaired: the fact is what the note records,
				// and re-deriving it is what AM-61 removed) and NAMED when it is not a
				// curie of this import, through the one exported shape test so the engine
				// and the derivation cannot disagree about which identities are this
				// import's.
				// AM-77 (2026-09-04). A FACT CARRIED AT ONE SITE IS CLAIMED AT THE SITE
				// THAT ACCOUNTS FOR IT.
				//
				// AM-73 carried the recorded identity, shape-tested it and named it when
				// the test failed, and stopped there. The identity was therefore written
				// onto the note and absent from `producedCuries`: the root is excluded
				// from `keptFolders` by construction, and its folder IS reached, so it is
				// not in `observedUnjudgedCuries` either. It fell straight into the orphan
				// diff - and a Skip run over a hand-edited home note showed the refusal
				// and an orphan report about the same note on one screen, which is exactly
				// what AM-70 rules out in its own text (AM-59's third site). The quieter
				// half was worse to debug: a recorded curie that PASSES the shape test but
				// simply differs was preserved in silence and reported as gone.
				//
				// The root is the one folder where the preserved and the claimed identity
				// can diverge at all: `recordedHubCurieOf` (`enrich.ts:1480-1489`) hands
				// every other held folder's recorded string to Pass B as the hub's curie,
				// so there the writer already claims the string it preserves and the
				// condition below is false. Claimed the way `target.adoptedAlias` is - a
				// second identity this same note keeps - so a collision is a refusal by
				// name rather than two notes silently agreeing on one identity.
				const recordedCurie = existingNote.frontmatter.curie;
				if (typeof recordedCurie === 'string' && recordedCurie !== '') {
					frontmatter.curie = recordedCurie;
					if (recordedCurie !== hubCurie) {
						const firstClaim = claimProducedCurie(producedCuries, curieOrigins, recordedCurie, {
							row: 0, path: existing.path, kind: 'hub',
						});
						// A NOTE CANNOT COLLIDE WITH ITSELF. On a vault whose home note was
						// written under the older address-derived identity, the recorded
						// curie IS `target.adoptedAlias`, which this same hub claimed a few
						// lines above under this same note's path. Re-claiming it here is one
						// note keeping one identity - accounted, not ambiguous - and refusing
						// it would abandon the write and report an ambiguous-identity error on
						// an ordinary legacy refresh (`tests/legacy-vault-refresh.test.ts`,
						// "raises no ambiguous-identity error", measured red on this tree
						// before the check below existed). Only a claim held by a DIFFERENT
						// note is the two-claimants case AM-31 refuses.
						//
						// C3 (2026-09-04). The exemption is `existing.path` ALONE. A second
						// disjunct on `fullPath` was unsound: `fullPath` is the hub's RENDERED
						// address, and a held hub writes at `existing.path` precisely because
						// the two can differ (a hand-renamed held hub keeps its name). The
						// disjunct was therefore active only when `fullPath` could not denote
						// this note, and claims are recorded at PLANNED addresses before any
						// write, so it could silence a genuine second claimant. The measured
						// legacy red is covered by the `existing.path` comparison on its own.
						if (
							firstClaim
							&& normalizePath(firstClaim.path) !== normalizePath(existing.path)
						) {
							result.errors.push({
								row: 0,
								message: duplicateHubCurieMessage(recordedCurie, existing.path, firstClaim),
							});
							continue;
						}
					}
					// Scoped to the root, which is what AM-73 rules and the only hub this
					// branch can reach with a foreign recorded identity: for every other
					// held folder `refusalFor` has already named it (residual ruling 5) and
					// no `HubNote` is emitted at all, so this writer never sees it.
					//
					// AM-77. Two voices, never both, each said once per run. The identity is
					// carried either way and never repaired - the fact is what the note
					// records - but the run says which of the two it saw, because "not a
					// curie of this import" and "this import's, but not this one" send the
					// user to different places.
					if (hub.importRoot && !isCurieOfOntology(recordedCurie, curiePrefix)) {
						const named = `The home note's recorded identity "${recordedCurie}" is not a curie of this import; `
							+ 'it was left as it was.';
						if (!deviationsSeen.has(named)) {
							deviationsSeen.add(named);
							result.warnings ??= [];
							result.warnings.push({ row: 0, message: named });
						}
						debug?.warn('generation', 'root-hub-foreign-curie', 'The home note records an identity this import did not mint', {
							path: existing.path, recorded: recordedCurie,
						});
					} else if (hub.importRoot && hubCurie && recordedCurie !== hubCurie) {
						const named = `The home note's recorded identity "${recordedCurie}" is not this import's `
							+ `"${hubCurie}"; it was left as it was.`;
						if (!deviationsSeen.has(named)) {
							deviationsSeen.add(named);
							result.warnings ??= [];
							result.warnings.push({ row: 0, message: named });
						}
						debug?.warn('generation', 'root-hub-differing-curie', 'The home note records an identity of this import that is not this run', {
							path: existing.path, recorded: recordedCurie, expected: hubCurie,
						});
					}
				}
				const candidate = buildNoteContent(frontmatter, body);
				let onDisk: string | null = null;
				try {
					onDisk = await app.vault.read(existing);
				} catch {
					// Unreadable here is not evidence of "unchanged": fall through to the
					// write, which is exactly what this pass did before AM-62.
					onDisk = null;
				}
				if (onDisk !== null && onDisk === candidate) {
					debug?.info('generation', 'hub-unchanged', `Hub ${hubCurie ?? writePath} left exactly as it was`, {
						path: writePath,
					});
					continue;
				}
				// Something did change, so the note is written - and a note this run
				// writes records when this run wrote it.
				frontmatter._crosswalker = held.stamped;
			}
			await app.vault.modify(existing, buildNoteContent(frontmatter, body));
		} else {
			if (config.waypoint_marker) body = ensureWaypointMarker(body);
			const parentPath = getParentPath(writePath);
			if (parentPath) await ensureFolderExists(app, parentPath).catch(() => {});
			await app.vault.create(writePath, buildNoteContent(frontmatter, body));
			result.created.push(writePath);
			producedThisRun.add(normalizePath(writePath));
		}
	}
}

/**
 * Default body for native-recipe-rendered notes: H1 plus rendered regions.
 *
 * The H1 is `recipe.target.auto_heading`-controlled (SchemaVer 1.8.0). With the
 * key absent this is byte-for-byte the historical function: an UNCONDITIONAL
 * `# <title>`, emitted even when the body is empty — deliberately unlike the
 * wizard path's conditional. `false`, or a template that renders empty, drops
 * the heading and emits the managed body alone (never a bare `# `).
 *
 * Exported for tests (and used by tests/helpers/golden-vault.ts so the golden
 * harness cannot drift from the writer).
 */
export function buildDefaultBody(
	frontmatter: Record<string, any>,
	address: Pick<ReturnType<typeof render>, 'body'>,
	recipe: { target: { auto_heading?: string | false } },
	scope: SourceScope,
	report?: RenderReport,
): string {
	const fallbackTitle = String(frontmatter.title ?? frontmatter.curie ?? 'Untitled');
	const heading = resolveAutoHeadingText(recipe, scope, fallbackTitle, report);
	const managedBody = renderedBodyRegionsToMarkdown(address.body);
	// An empty render only suppresses when a template was actually configured.
	// The absent case keeps the historical branch even for a pathologically
	// empty fallback title, so no already-generated vault shifts.
	const configured = typeof recipe.target.auto_heading === 'string';
	if (heading === null || (configured && heading.trim() === '')) {
		return managedBody === '' ? '' : `${managedBody}\n`;
	}
	return managedBody === '' ? `# ${heading}\n` : `# ${heading}\n\n${managedBody}\n`;
}

/**
 * Default per-row CURIE local part, under the derivation the set is pinned to.
 *
 * AM-27. `filename-stem-v1` is frozen: row.curie's local part if present, else
 * row.id / row.subject_id / row.control_id / row.code, else row-N, all of it
 * through `sanitizeFileName`. That last step is the defect - it rewrites even a
 * DECLARED curie, so a source that states `nist:AC-2(1)/a` gets a different
 * identity written into the vault than the one it declared - but it is what every
 * set minted before the pin already carries, and it is kept for exactly those.
 */
interface NestedLineage {
	level: string;
	path: string[];
}

function nestedLineageOf(row: Record<string, unknown>): NestedLineage | null {
	const raw = row._cw;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const lineage = raw as Record<string, unknown>;
	if (typeof lineage.level !== 'string' || !Array.isArray(lineage.path)
		|| !lineage.path.every((piece) => typeof piece === 'string')) return null;
	return { level: lineage.level, path: lineage.path as string[] };
}

function nestedIdentityPinMismatch(
	nest: readonly NestedRecordLevel[] | undefined,
	importSet: ImportSetReference,
): SourceStageError | null {
	if (!nest) return null;
	for (let index = 0; index < nest.length; index++) {
		const entry = nest[index];
		const recipeIdentity = entry.identity ?? 'global';
		const pinnedIdentity = importSet.nest_identity?.[entry.level] ?? 'global';
		if (recipeIdentity !== pinnedIdentity) {
			return new SourceStageError(
				`Level "${entry.level}" is named by its place in this set; import into a new set to change it.`,
				{ declaration: `source.nest.${index}.identity` },
			);
		}
	}
	return null;
}

/** One CURIE derivation used by nested preflight and the row-writing loops. */
function deriveRowCurie(
	row: Record<string, unknown>,
	curiePrefix: string,
	basePrefix: string,
	importSet: ImportSetReference | undefined,
	nest: readonly NestedRecordLevel[] | undefined,
	lastResort: () => string,
	defaultLocalPart: () => string,
): string {
	const lineage = nestedLineageOf(row);
	const entry = lineage ? nest?.find((candidate) => candidate.level === lineage.level) : undefined;
	if (!lineage || !entry) return `${curiePrefix}:${defaultLocalPart()}`;
	if (derivationOf(importSet) !== 'declared-facts-v1') {
		throw new SourceStageError(
			'Nested records need the declared-facts identity rule. This import set was minted under filename-stem-v1; import into a new set.',
			{ declaration: 'source.nest' },
		);
	}
	const recipeIdentity = entry.identity ?? 'global';
	const pinnedIdentity = importSet?.nest_identity?.[lineage.level] ?? entry.identity ?? 'global';
	if (recipeIdentity !== pinnedIdentity) {
		throw new SourceStageError(
			`Level "${lineage.level}" is named by its place in this set; import into a new set to change it.`,
			{ declaration: `source.nest.${nest?.indexOf(entry) ?? 0}.identity` },
		);
	}
	const localPart = pinnedIdentity === 'path'
		? pathIdentityLocalPart(lineage.path)
		// A nested level declares identity through its id template. The rendered
		// value is the last lineage piece, even when the source column is named
		// something domain-specific such as "Control ID" rather than `id`.
		: declaredFactsLocalPart({ id: lineage.path[lineage.path.length - 1] }, lastResort, basePrefix);
	return `${curiePrefix}:${localPart}`;
}

interface NestedCurieClaim {
	path: string;
	level: string;
}

function nestedIdentityCollision(
	rows: readonly Record<string, unknown>[],
	deriveCurie: (row: Record<string, unknown>, rowIndex: number) => string,
): string | null {
	const claims = new Map<string, NestedCurieClaim>();
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		const lineage = nestedLineageOf(row);
		if (!lineage) continue;
		const curie = deriveCurie(row, index);
		const path = lineage.path.join('/');
		const first = claims.get(curie);
		if (first) {
			return `Ambiguous identity ${curie} claimed by rows at ${first.path} and ${path}. `
				+ `Set identity: path on level "${lineage.level}" so each row is named by its place in the hierarchy.`;
		}
		claims.set(curie, { path, level: lineage.level });
	}
	return null;
}

function addUnparentedWarnings(result: GenerationResult, stage: SourceStage): void {
	for (const [level, count] of Object.entries(stage.unparented ?? {})) {
		if (count < 1) continue;
		result.warnings ??= [];
		result.warnings.push({
			row: 0,
			message: `${count} ${level} records name a parent that is not in the source and were not imported.`,
		});
	}
}

async function materializeNestedStageRows(stage: SourceStage): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for await (const row of stage.rows as Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>) {
		rows.push(row);
	}
	stage.finalize();
	return rows;
}

function defaultCurieLocalPart(
	row: Record<string, unknown>,
	rowNum: number,
	derivation: ImportSetDerivation,
	/**
	 * AM-28/AM-34. The set's BASE ontology prefix - the one a source may state.
	 * A declared `curie` is checked against it rather than being stripped and
	 * re-prefixed, so a value that passes is reproduced verbatim; the caller then
	 * puts the set's resolved prefix in front, uniformly and invertibly.
	 */
	basePrefix: string,
): string {
	if (derivation === 'declared-facts-v1') {
		return declaredFactsLocalPart(row, () => `row-${rowNum}`, basePrefix);
	}
	const candidate = row.curie ?? row.id ?? row.subject_id ?? row.control_id ?? row.code;
	if (typeof candidate === 'string' && candidate.length > 0) {
		// If it's already a full CURIE, take the local part
		const colonIdx = candidate.indexOf(':');
		const local = colonIdx > 0 ? candidate.slice(colonIdx + 1) : candidate;
		return sanitizeFileName(local);
	}
	return `row-${rowNum}`;
}

/**
 * AM-27. `declared-facts-v1`: one rule, shared by both generation entry points.
 *
 * Declared facts first. The source's own identity columns are consulted before
 * anything derived from an address, because an identity a source STATES is the
 * only one that can be joined back to the source system; a stem read off a
 * filename template is a fact about where the note went, not about what it is.
 *
 * Four behaviours, in order:
 *   - a declared `curie` column is honoured VERBATIM, prefix included, or REFUSED
 *     BY NAME (AM-28). Never sanitized and never re-prefixed: silently rewriting
 *     a declared identity puts a value in the vault that the source never
 *     asserted, and merges rows whose declared curies differ only in a rejected
 *     character or in whose prefix they carry.
 *   - a declared `id` is an identifier, not a declared CURIE, so it may be made
 *     charset-safe - but injectively over the EXACT raw value (AM-28), so no two
 *     of them collapse together.
 *   - an EDGE-shaped row (AM-29: the run declares both a subject and an object)
 *     is identified by its three endpoints together. `subject_id` used to sit in
 *     the chain above, which gave every edge leaving one control that control's
 *     identity - one identity for many edges. A relationship is never identified
 *     by one of its ends. Concept-only identifiers (`control_id`, `code`) are
 *     consulted only for a row that is not edge-shaped, for the same reason.
 *   - `lastResort` supplies the caller's fallback (the filename stem for the
 *     wizard path, `row-N` for the recipe path), also injectively.
 */
function declaredFactsLocalPart(
	row: Record<string, unknown>,
	lastResort: () => string,
	/**
	 * AM-34. The set's BASE ontology prefix - what a source is entitled to state.
	 * The caller re-prefixes with the set's resolved (possibly set-qualified)
	 * prefix, uniformly, and the set stamp records what it takes to invert that.
	 */
	basePrefix: string,
): string {
	const declared = declaredIdentity(row);
	if (declared?.kind === 'edge') {
		return edgeIdentityLocalPart(declared.subject, declared.predicate, declared.object);
	}
	if (declared) {
		if (declared.column === 'curie') return declaredCurieLocalPart(declared.raw, basePrefix);
		return injectiveDeclaredIdLocalPart(declared.raw);
	}
	return injectiveCurieLocalPart(lastResort());
}
