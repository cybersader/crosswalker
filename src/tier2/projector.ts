/**
 * Tier 2 projector — reads Tier 1 Markdown frontmatter, populates the
 * SQLite sidecar tables.
 *
 * Per the [v0.1 schema spec §7 projection rules](https://cybersader.github.io/crosswalker/agent-context/v0-1-schema-spec/#7-tier-2-sidecar-sql-schema-sqlite-wasm-projection)
 * + the [system architecture page Layer 3](https://cybersader.github.io/crosswalker/concepts/system-architecture/#layer-3--projection-t1--t2):
 *
 *   1. Walks the vault's `.md` files via Obsidian's metadataCache (no
 *      filesystem reads — frontmatter parsed once at vault load)
 *   2. Skips files without `_crosswalker` (not produced by Crosswalker)
 *   3. Dispatches by `kind`:
 *        - default / 'concept' → upsert into `concepts`
 *        - 'junction-note'     → upsert into `junction_notes`
 *        - 'crosswalk-edge'    → upsert into `mappings`
 *   4. Cooperative yielding every N files (default 50) so UI doesn't freeze
 *
 * Recovery property (Ch 24 §2): if Tier 2 is missing/corrupted/stale, the
 * projector rebuilds it from canonical Tier 1. This module is what makes
 * that property real.
 *
 * Idempotent: re-running on an unchanged vault is a no-op (INSERT OR REPLACE
 * keyed on vault_path / curie).
 */

import { App, TFile } from 'obsidian';
import { DebugLog } from '../utils/debug';
import { extractTier1Curie } from '../validation/validator';
import { normalizeMappingSetId, readStoredPredicateModifier } from '../utils/mapping-provenance';
import { readReviewGroupCids } from '../generation/hash';
import { readMappingTables, tableRowsAsEdgeRecords } from '../mappings/mapping-table-reader';
import { conversionReadRule, importSetIdOf, readConversionReadState, unusableMarkerMessage, type ConversionReadRule } from '../mappings/conversion-marker';
import { asTier2Db, Tier2DbError, type ExecInput, type Tier2Db, type Tier2DbLike } from './db';

/**
 * Result of a projection pass. Counts per Tier 2 table + skipped (files
 * without `_crosswalker`) + errors.
 */
export interface ProjectionResult {
	success: boolean;
	counts: {
		concepts: number;
		mappings: number;
		junction_notes: number;
		ontologies: number;
		/** Mapping table files read (slice 2); their rows count in `mappings`. */
		mapping_tables: number;
		skipped: number;
		errors: number;
	};
	errors: Array<{ vault_path: string; message: string }>;
	durationMs: number;
	/**
	 * True when the run stopped early because `shouldAbort` asked it to.
	 *
	 * An abort is not a failure, so `success` stays true and `errors` stays
	 * empty: nothing went wrong, the work was simply called off. It IS however
	 * an incomplete pass, so callers must not read its counts as a statement
	 * about the whole vault, and this run deliberately prunes nothing and
	 * records itself as `partial` coverage.
	 */
	aborted?: boolean;
}

export interface ProjectionOptions {
	/** Cooperative-yield interval in files. Default 50. */
	yieldEvery?: number;
	/** Optional debug logger. */
	debug?: DebugLog;
	/**
	 * Restrict projection to files matching this path-prefix predicate.
	 * Default: all .md files in the vault.
	 */
	pathFilter?: (path: string) => boolean;
	/**
	 * Whether this pass has complete-vault coverage. Default: 'partial'.
	 * Pruning is allowed only when callers explicitly declare 'full'; a path
	 * filter is never compatible with a full projection.
	 */
	projectionMode?: 'full' | 'partial';
	/**
	 * Cooperative cancellation, polled at each yield point.
	 *
	 * A projection holds the sidecar `db` across many yields, so anything that
	 * closes or deletes that database mid-run leaves this loop executing
	 * against a dead handle. Returning `true` here makes the loop stop at a
	 * known-safe boundary and report `aborted`, instead of the caller having to
	 * race it and then explain the resulting exception to a user who did
	 * nothing wrong.
	 */
	shouldAbort?: () => boolean;
}

/** Where per-row statements go. The projection writer is the only sink. */
interface StatementSink {
	push(statement: ExecInput): void;
}

type RowCounter = 'concepts' | 'mappings' | 'junction_notes';

/** The statements one vault file (or one mapping-table row) produced. */
interface PendingGroup {
	path: string;
	statements: ExecInput[];
	/** The count this row incremented, undone if its SQL later fails. */
	counter: RowCounter | null;
	/** Index in `result.errors` of this row's own JS error, when it had one. */
	errorIndex: number | null;
}

/**
 * W4 (2026-10-03). Accumulates the projection's per-row statements and writes
 * them as one `execBatch` per yield window, instead of one Worker round trip
 * per statement.
 *
 * Per-row error attribution is preserved exactly. Before batching, a failing
 * statement threw inside that row's `try`, the statements before it in the row
 * had already run, and the row was recorded as an error with sqlite's message.
 * A batch is all-or-nothing, so on failure the writer finds the row that owns
 * the failing statement, records that row's error the same way, keeps only the
 * statements that row ran before the failure, and resends the window.
 */
class ProjectionWriter implements StatementSink {
	private groups: PendingGroup[] = [];
	private current: PendingGroup | null = null;

	constructor(
		private readonly db: Tier2Db,
		private readonly result: ProjectionResult,
		private readonly debug?: DebugLog,
	) {}

	/** Start the statements of one row. */
	begin(path: string): void {
		this.current = { path, statements: [], counter: null, errorIndex: null };
		this.groups.push(this.current);
	}

	push(statement: ExecInput): void {
		if (!this.current) this.begin('<tier2-write>');
		(this.current as PendingGroup).statements.push(statement);
	}

	/** The current row's statements are complete and it counted toward `key`. */
	counted(key: RowCounter): void {
		this.result.counts[key] += 1;
		if (this.current) this.current.counter = key;
	}

	/** The current row failed in JS; remember where its error was recorded. */
	failed(errorIndex: number): void {
		if (this.current) this.current.errorIndex = errorIndex;
	}

	async flush(): Promise<void> {
		let groups = this.groups.filter((group) => group.statements.length > 0);
		this.groups = [];
		this.current = null;
		// Each failure removes at least one statement, so this terminates.
		while (groups.length > 0) {
			const statements: ExecInput[] = [];
			const owners: Array<[number, number]> = [];
			groups.forEach((group, groupIndex) => {
				group.statements.forEach((statement, localIndex) => {
					statements.push(statement);
					owners.push([groupIndex, localIndex]);
				});
			});
			try {
				await this.db.execBatch(statements);
				return;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const index = err instanceof Tier2DbError ? err.statementIndex : null;
				if (index === null || index < 0 || index >= owners.length) {
					// Not a statement failure (the database went away). Nothing in
					// this window was written; say so once and stop.
					this.result.errors.push({ vault_path: '<tier2-write>', message });
					this.result.counts.errors += 1;
					this.debug?.warn('tier2', 'projection-write-error', 'Tier 2 write failed', { error: message });
					return;
				}
				const [groupIndex, localIndex] = owners[index];
				const group = groups[groupIndex];
				this.recordRowError(group, message);
				group.statements = group.statements.slice(0, localIndex);
				groups = groups.filter((candidate) => candidate.statements.length > 0);
			}
		}
	}

	private recordRowError(group: PendingGroup, message: string): void {
		if (group.counter) {
			this.result.counts[group.counter] -= 1;
			group.counter = null;
		}
		if (group.errorIndex !== null) {
			// The SQL failure happened first in the original order, so it is the
			// error this row reports.
			this.result.errors[group.errorIndex].message = message;
		} else {
			this.result.errors.push({ vault_path: group.path, message });
			this.result.counts.errors += 1;
			group.errorIndex = this.result.errors.length - 1;
		}
		this.debug?.warn('tier2', 'projection-row-error', `Projection row error at ${group.path}`, { path: group.path, error: message });
	}
}

/**
 * Project Tier 1 frontmatter into the Tier 2 SQLite sidecar.
 *
 * - `db` is the `Tier2Db` from `openSidecar()` (a raw OO1-shaped handle is
 *   wrapped in `LocalDb`).
 * - Walks `app.vault.getMarkdownFiles()` lazily (one file at a time;
 *   never accumulates the full vault state in RAM).
 * - Per-file frontmatter via `app.metadataCache.getFileCache(file)?.frontmatter`.
 *
 * Returns counts + errors for the caller to surface (Notice / debug log).
 */
export async function projectFromTier1(
	app: App,
	dbLike: Tier2DbLike,
	options: ProjectionOptions = {},
): Promise<ProjectionResult> {
	const db = asTier2Db(dbLike);
	const startMs = Date.now();
	const yieldEvery = options.yieldEvery ?? 50;
	const fullProjection = options.projectionMode === 'full';
	if (fullProjection && options.pathFilter) {
		throw new Error(`A full Tier 2 projection cannot use pathFilter`);
	}
	const result: ProjectionResult = {
		success: true,
		counts: {
			concepts: 0,
			mappings: 0,
			junction_notes: 0,
			ontologies: 0,
			mapping_tables: 0,
			skipped: 0,
			errors: 0,
		},
		errors: [],
		durationMs: 0,
	};

	options.debug?.info('tier2', 'projection-start', 'projectFromTier1: starting');

	// Per-row statements are written one batch per yield window (W4).
	const writer = new ProjectionWriter(db, result, options.debug);

	// Track ontologies seen so we don't issue redundant upserts. Marked when the
	// upsert is queued, which is before it is written.
	const ontologiesSeen = new Set<string>();
	if (fullProjection) await initializeProjectionMarks(db);

	// Slice 4. A set mid-conversion is projected from one storage form only (see
	// `formToReadFor`); the other form's artifacts are skipped and, in a full
	// run, left unseen so the prune drops their stale rows. A set whose marker
	// cannot be read is projected in neither form, and the marker is reported
	// as an error: that fails the pass and so blocks the prune, leaving the
	// set's last good rows in place instead of doubling or dropping them.
	const conversionState = await readConversionReadState(app);
	const reads = conversionReadRule(conversionState.markers, conversionState.unusable);
	for (const entry of conversionState.unusable) {
		const message = unusableMarkerMessage(entry, 'the mappings of {sets} are left out of the query database.');
		result.errors.push({ vault_path: entry.path, message });
		result.counts.errors += 1;
		options.debug?.warn('tier2', 'projection-conversion-marker', message, { path: entry.path });
	}

	const files = app.vault.getMarkdownFiles();
	const filtered = options.pathFilter ? files.filter((f) => options.pathFilter!(f.path)) : files;

	let i = 0;
	for (const file of filtered) {
		i += 1;

		// Cooperative yield every N files, after writing the window so far.
		if (i % yieldEvery === 0) {
			await writer.flush();
			await new Promise<void>((r) => setTimeout(r, 0));
			// Checked immediately after the yield, because the yield is the only
			// point where anything else can run -- and therefore the only point
			// where the database under us can be closed or deleted.
			if (options.shouldAbort?.()) {
				result.aborted = true;
				break;
			}
		}

		writer.begin(file.path);
		try {
			const cacheEntry = app.metadataCache.getFileCache(file);
			if (fullProjection && !cacheEntry) {
				throw new Error(`metadata cache unavailable during full projection`);
			}
			const fm = readFrontmatter(app, file);
			if (!fm) {
				// Absence of evidence is not evidence of absence. `readFrontmatter`
				// returns null for BOTH an ordinary note with no frontmatter (safe to
				// skip) and a note whose frontmatter block exists but did not parse —
				// malformed YAML, or a cache entry populated before its frontmatter is
				// available. The second case may well be one of ours, and skipping it
				// silently leaves no seen-mark, so a pruning pass would delete the rows
				// of a note that is sitting right there.
				//
				// `frontmatterPosition` is the discriminator: Obsidian records it when a
				// note HAS a frontmatter block, whether or not the parse succeeded. So a
				// position with no parsed content means unknown, and during a pruning
				// pass unknown must fail closed.
				const hasUnparsedFrontmatter = Boolean(
					(cacheEntry as { frontmatterPosition?: unknown } | null)?.frontmatterPosition,
				);
				if (fullProjection && hasUnparsedFrontmatter) {
					throw new Error(`frontmatter present but unreadable; refusing to prune on an incomplete pass`);
				}
				result.counts.skipped += 1;
				continue;
			}
			if (!fm._crosswalker) {
				// Not produced by Crosswalker; skip silently
				result.counts.skipped += 1;
				continue;
			}

			// Dispatch by kind
			const kind = typeof fm.kind === 'string' ? fm.kind : 'concept';

			if (kind === 'junction-note') {
				upsertJunctionNote(writer, file, fm);
				if (fullProjection) markJunctionNoteSeen(writer, file.path);
				writer.counted('junction_notes');
			} else if (kind === 'mapping-set') {
				// A mapping set's release record (Tier 1 `kind: mapping-set`) is not a
				// concept and not a mapping; the query database has no row for it.
				result.counts.skipped += 1;
				continue;
			} else if (kind === 'crosswalk-edge' && !reads(importSetIdOf(fm._crosswalker), 'notes')) {
				result.counts.skipped += 1;
				continue;
			} else if (kind === 'crosswalk-edge') {
				// Crosswalk-edges span two ontologies — register both subject + object.
				ensureOntologyForKind(writer, fm, ontologiesSeen, file.path, 'crosswalk-edge');
				let predicateModifier: '' | 'NOT';
				try {
					predicateModifier = readStoredPredicateModifier(fm);
				} catch (error) {
					// Never retain a previously projected positive row after canonical
					// Markdown becomes explicitly malformed at the modifier boundary.
					writer.push({
						sql: 'DELETE FROM mappings WHERE source_path = $source_path',
						bind: { $source_path: file.path },
					});
					throw error;
				}
				upsertMapping(writer, file.path, fm, predicateModifier);
				if (fullProjection) markMappingSeen(writer, file.path);
				writer.counted('mappings');
			} else {
				// default / 'concept'
				ensureOntologyForKind(writer, fm, ontologiesSeen, file.path, 'concept');
				upsertConcept(writer, file, fm);
				if (fullProjection) {
					markConceptSeen(writer, deriveConceptOntologyId(fm), String(fm.curie).trim());
				}
				writer.counted('concepts');
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			result.errors.push({ vault_path: file.path, message: msg });
			result.counts.errors += 1;
			writer.failed(result.errors.length - 1);
			options.debug?.warn('tier2', 'projection-row-error', `Projection row error at ${file.path}`, { path: file.path, error: msg });
		}
	}
	// Rows processed before an abort were written before it, as they always were.
	await writer.flush();

	if (!result.aborted) {
		await projectMappingTables(app, writer, options, fullProjection, ontologiesSeen, result, reads);
	}

	let prunedRows = 0;
	// An aborted pass saw only some of the vault, so pruning "unseen" rows here
	// would delete rows for files it simply never reached. Coverage, not intent,
	// is what licenses a prune: a full run that stopped early is a partial run.
	if (fullProjection && !result.aborted) {
		try {
			if (result.errors.length === 0) {
				await db.execBatch([...ontologiesSeen].map((ontologyId) => markOntologySeenStatement(ontologyId)));
				prunedRows = await pruneUnseenRows(db);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			result.errors.push({ vault_path: '<tier2-prune>', message: msg });
			result.counts.errors += 1;
			options.debug?.warn('tier2', 'projection-prune-error', 'Tier 2 pruning failed', { error: msg });
		} finally {
			await dropProjectionMarks(db, options.debug);
		}
	}

	// Mapping changes and any successful prune invalidate both closure rows and
	// their coverage watermarks atomically (Ch 18 §2.5). A stale watermark with
	// no rows would otherwise turn an invalidated closure into a false empty hit.
	if (result.counts.mappings > 0 || prunedRows > 0) {
		await invalidateClosureCaches(db, options.debug);
	}

	// Final ontology count is from the seen-set
	result.counts.ontologies = ontologiesSeen.size;

	if (result.errors.length > 0) {
		result.success = false;
	}

	result.durationMs = Date.now() - startMs;

	// Stamp when the index was last rebuilt and how completely. A coverage
	// report that cannot say how old its index is will eventually present a
	// stale posture as the current one, which is the same silent-wrong-answer
	// class as the closure-cache and empty-sidecar bugs. `partial` is recorded
	// distinctly because a partial pass may legitimately not have seen every
	// note, so a reader must not treat it as a full-vault statement.
	// An aborted run is recorded as `partial` whatever it set out to be, for the
	// same reason it does not prune: it cannot speak for notes it never read,
	// and a stamp claiming full coverage is exactly how a stale posture gets
	// presented as the current one.
	await recordProjectionStamp(db, {
		mode: fullProjection && !result.aborted ? 'full' : 'partial',
		success: result.success,
	});

	options.debug?.info('tier2', 'projection-complete', 'projectFromTier1: complete', {
		success: result.success,
		counts: result.counts,
		duration_ms: result.durationMs,
		pruned_rows: prunedRows,
	});

	return result;
}

// ============================================================================
// Mapping tables (slice 2 of the mapping table form)
// ============================================================================

/**
 * Project every table-form mapping set. A table set has no notes, so the
 * markdown walk above never sees it; without this pass its mappings would be
 * missing from every query, and a full projection would prune them.
 *
 * Each row goes through the same `upsertMapping` as an edge note, addressed
 * `<table path>#<row_id>`, and is marked seen under that address, so a row
 * dropped from the file, or a whole deleted table, is pruned like a deleted
 * note. A table that would not read contributes an error per problem and marks
 * nothing seen, and any error refuses the prune for the run. Failure mode
 * prevented: one hand-edited table deleting every projected row of its set.
 */
async function projectMappingTables(
	app: App,
	writer: ProjectionWriter,
	options: ProjectionOptions,
	fullProjection: boolean,
	ontologiesSeen: Set<string>,
	result: ProjectionResult,
	reads: ConversionReadRule,
): Promise<void> {
	let tables: Awaited<ReturnType<typeof readMappingTables>>;
	try {
		tables = await readMappingTables(app);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		result.errors.push({ vault_path: '<mapping-tables>', message: msg });
		result.counts.errors += 1;
		return;
	}
	for (const table of tables) {
		if (options.pathFilter && !options.pathFilter(table.path)) continue;
		if (!reads(importSetIdOf(table.header.crosswalker_provenance), 'table')) continue;
		// Checked per table because a table read is a yield point: the database
		// under us can be closed while it is in flight.
		if (options.shouldAbort?.()) {
			result.aborted = true;
			return;
		}
		result.counts.mapping_tables += 1;
		// Row errors count as errors here: a partly read set projected as if whole
		// would let the prune delete the dropped rows' projections.
		const problems = [...table.errors, ...table.rowErrors];
		if (problems.length) {
			for (const message of problems) {
				result.errors.push({ vault_path: table.path, message });
				result.counts.errors += 1;
			}
			options.debug?.warn('tier2', 'projection-table-error', `Mapping table unreadable at ${table.path}`, { path: table.path, errors: problems });
			continue;
		}
		for (const record of tableRowsAsEdgeRecords(table)) {
			writer.begin(record.source_path);
			try {
				const fm = record.frontmatter as Record<string, any>;
				ensureOntologyForKind(writer, fm, ontologiesSeen, table.path, 'crosswalk-edge');
				upsertMapping(writer, record.source_path, fm, readStoredPredicateModifier(fm));
				if (fullProjection) markMappingSeen(writer, record.source_path);
				writer.counted('mappings');
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				result.errors.push({ vault_path: record.source_path, message: msg });
				result.counts.errors += 1;
				writer.failed(result.errors.length - 1);
			}
		}
		// One batch per table: a table read is the yield point here.
		await writer.flush();
	}
}

// ============================================================================
// Full-projection pruning helpers
// ============================================================================

async function initializeProjectionMarks(db: Tier2Db): Promise<void> {
	await db.exec(`
		DROP TABLE IF EXISTS temp.crosswalker_seen_concepts;
		DROP TABLE IF EXISTS temp.crosswalker_seen_mappings;
		DROP TABLE IF EXISTS temp.crosswalker_seen_junction_notes;
		DROP TABLE IF EXISTS temp.crosswalker_seen_ontologies;
		CREATE TEMP TABLE crosswalker_seen_concepts (
			ontology_id TEXT NOT NULL,
			curie TEXT NOT NULL,
			PRIMARY KEY (ontology_id, curie)
		);
		CREATE TEMP TABLE crosswalker_seen_mappings (source_path TEXT PRIMARY KEY);
		CREATE TEMP TABLE crosswalker_seen_junction_notes (vault_path TEXT PRIMARY KEY);
		CREATE TEMP TABLE crosswalker_seen_ontologies (id TEXT PRIMARY KEY);
	`);
}

function markConceptSeen(sink: StatementSink, ontologyId: string, curie: string): void {
	sink.push({
		sql: `INSERT OR IGNORE INTO temp.crosswalker_seen_concepts (ontology_id, curie)
			VALUES ($ontology_id, $curie)`,
		bind: { $ontology_id: ontologyId, $curie: curie },
	});
}

function markMappingSeen(sink: StatementSink, sourcePath: string): void {
	sink.push(markPathSeenStatement('crosswalker_seen_mappings', 'source_path', sourcePath));
}

function markJunctionNoteSeen(sink: StatementSink, vaultPath: string): void {
	sink.push(markPathSeenStatement('crosswalker_seen_junction_notes', 'vault_path', vaultPath));
}

function markOntologySeenStatement(ontologyId: string): ExecInput {
	return markPathSeenStatement('crosswalker_seen_ontologies', 'id', ontologyId);
}

function markPathSeenStatement(table: string, column: string, value: string): ExecInput {
	return {
		sql: `INSERT OR IGNORE INTO temp.${table} (${column}) VALUES ($value)`,
		bind: { $value: value },
	};
}

async function pruneUnseenRows(db: Tier2Db): Promise<number> {
	const countRows = await db.exec({
		sql: `
			SELECT
				(SELECT COUNT(*) FROM concepts AS c
				 WHERE NOT EXISTS (
					SELECT 1 FROM temp.crosswalker_seen_concepts AS seen
					WHERE seen.ontology_id = c.ontology_id AND seen.curie = c.curie
				 ))
				+
				(SELECT COUNT(*) FROM mappings AS m
				 WHERE NOT EXISTS (
					SELECT 1 FROM temp.crosswalker_seen_mappings AS seen
					WHERE seen.source_path = m.source_path
				 ))
				+
				(SELECT COUNT(*) FROM junction_notes AS j
				 WHERE NOT EXISTS (
					SELECT 1 FROM temp.crosswalker_seen_junction_notes AS seen
					WHERE seen.vault_path = j.vault_path
				 ))
				+
				(SELECT COUNT(*) FROM ontologies AS o
				 WHERE NOT EXISTS (
					SELECT 1 FROM temp.crosswalker_seen_ontologies AS seen
					WHERE seen.id = o.id
				 )) AS stale_count
		`,
		rowMode: 'array',
		returnValue: 'resultRows',
	});
	const staleCount = Number(countRows?.[0]?.[0] ?? 0);
	if (staleCount === 0) return 0;

	// One batch, one SAVEPOINT (W4): every delete lands or none does. The batch
	// rolls itself back on failure and rethrows.
	await db.execBatch([`
			DELETE FROM concepts
			WHERE NOT EXISTS (
				SELECT 1 FROM temp.crosswalker_seen_concepts AS seen
				WHERE seen.ontology_id = concepts.ontology_id AND seen.curie = concepts.curie
			)
	`, `
			DELETE FROM mappings
			WHERE NOT EXISTS (
				SELECT 1 FROM temp.crosswalker_seen_mappings AS seen
				WHERE seen.source_path = mappings.source_path
			)
	`, `
			DELETE FROM junction_notes
			WHERE NOT EXISTS (
				SELECT 1 FROM temp.crosswalker_seen_junction_notes AS seen
				WHERE seen.vault_path = junction_notes.vault_path
			)
	`, `
			DELETE FROM ontologies
			WHERE NOT EXISTS (
				SELECT 1 FROM temp.crosswalker_seen_ontologies AS seen
				WHERE seen.id = ontologies.id
			)
	`]);

	return staleCount;
}

async function dropProjectionMarks(db: Tier2Db, debug?: DebugLog): Promise<void> {
	try {
		await db.exec(`
			DROP TABLE IF EXISTS temp.crosswalker_seen_concepts;
			DROP TABLE IF EXISTS temp.crosswalker_seen_mappings;
			DROP TABLE IF EXISTS temp.crosswalker_seen_junction_notes;
			DROP TABLE IF EXISTS temp.crosswalker_seen_ontologies;
		`);
	} catch (err) {
		debug?.warn('tier2', 'projection-mark-cleanup-failed', 'Projection mark cleanup failed (non-fatal)', {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function invalidateClosureCaches(db: Tier2Db, debug?: DebugLog): Promise<void> {
	try {
		// One batch, one SAVEPOINT (W4): rows and watermarks go together.
		await db.execBatch([
			'DELETE FROM closure_cache_state',
			'DELETE FROM closure_cache',
		]);
	} catch (err) {
		// Non-fatal: cache tables may not exist if migrations have not run.
		debug?.warn('tier2', 'closure-cache-invalidate-failed', 'Closure cache invalidate failed (non-fatal)', {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ============================================================================
// Per-kind upsert helpers
// ============================================================================

function upsertConcept(sink: StatementSink, file: TFile, fm: Record<string, any>): void {
	const ontologyId = deriveConceptOntologyId(fm);
	const curie = String(fm.curie ?? '').trim();
	if (!curie) {
		throw new Error(`concept-note frontmatter missing required 'curie' field`);
	}

	const title = String(fm.title ?? '');
	const parentCurie = extractTier1Curie(fm.parent_curie);
	const status = typeof fm.status === 'string' ? fm.status : 'active';
	const sourceHash = hashFrontmatter(fm);
	const importSetId = extractImportSetId(fm);
	const importedAt = extractProducedAt(fm) ?? new Date().toISOString();
	const modifiedAt = new Date(file.stat.mtime).toISOString();
	const reviewGroups = readReviewGroupCids(fm._crosswalker?.review_groups);

	sink.push({
		sql: `
			INSERT OR REPLACE INTO concepts
				(ontology_id, curie, vault_path, source_hash, import_set_id, title, review_cid, review_wording_cid, review_scope_cid, review_housekeeping_cid, parent_curie, status, imported_at, modified_at)
			VALUES ($ontology_id, $curie, $vault_path, $source_hash, $import_set_id, $title, $review_cid, $review_wording_cid, $review_scope_cid, $review_housekeeping_cid, $parent_curie, $status, $imported_at, $modified_at)
		`,
		bind: {
			$ontology_id: ontologyId,
			$curie: curie,
			$vault_path: file.path,
			$source_hash: sourceHash,
			$import_set_id: importSetId,
			$title: title,
			$review_cid: stringOrNull(fm._crosswalker?.review_cid),
			$review_wording_cid: reviewGroups?.wording ?? null,
			$review_scope_cid: reviewGroups?.scope ?? null,
			$review_housekeeping_cid: reviewGroups?.housekeeping ?? null,
			$parent_curie: parentCurie,
			$status: status,
			$imported_at: importedAt,
			$modified_at: modifiedAt,
		},
	});
}

function upsertJunctionNote(sink: StatementSink, file: TFile, fm: Record<string, any>): void {
	const curie = String(fm.curie ?? '').trim();
	if (!curie) {
		throw new Error(`junction-note frontmatter missing required 'curie' field`);
	}
	const subject = String(fm.subject ?? '');
	const predicate = String(fm.predicate ?? '');
	const object = String(fm.object ?? '');
	if (!subject || !predicate || !object) {
		throw new Error(`junction-note missing required subject/predicate/object`);
	}
	const subjectCurie = extractTier1Curie(fm.subject_curie);
	const objectCurie = extractTier1Curie(fm.object_curie);

	const sourceHash = hashFrontmatter(fm);
	const importSetId = extractImportSetId(fm);
	const modifiedAt = new Date(file.stat.mtime).toISOString();

	// The review baseline is read as a PAIR (Ch 43 re-attestation §1.1). If
	// either half is missing, both columns bind NULL: a half-record in Tier 1 is
	// a half-fact, and a half-fact must never become a half-comparison here. The
	// result is the named `unrecorded` state, which still counts toward
	// coverage -- absence of a baseline is not evidence that the subject changed.
	const reviewedAgainst = fm.reviewed_against;
	const reviewedAgainstCurie = reviewedAgainst && typeof reviewedAgainst === 'object'
		? stringOrNull((reviewedAgainst as Record<string, unknown>).curie)
		: null;
	const reviewedAgainstCid = reviewedAgainst && typeof reviewedAgainst === 'object'
		? stringOrNull((reviewedAgainst as Record<string, unknown>).review_cid)
		: null;
	const baselineComplete = reviewedAgainstCurie !== null && reviewedAgainstCid !== null;
	const reviewedGroups = baselineComplete
		? readReviewGroupCids((reviewedAgainst as Record<string, unknown>).review_groups)
		: null;

	sink.push({
		sql: `
			INSERT OR REPLACE INTO junction_notes
				(vault_path, curie, subject, subject_curie, predicate, object, object_curie, coverage, reviewer, review_date, status, confidence, scope, expires_at, notes, reviewed_against_curie, reviewed_against_cid, reviewed_wording_cid, reviewed_scope_cid, reviewed_housekeeping_cid, import_set_id, source_hash, modified_at)
			VALUES ($vault_path, $curie, $subject, $subject_curie, $predicate, $object, $object_curie, $coverage, $reviewer, $review_date, $status, $confidence, $scope, $expires_at, $notes, $reviewed_against_curie, $reviewed_against_cid, $reviewed_wording_cid, $reviewed_scope_cid, $reviewed_housekeeping_cid, $import_set_id, $source_hash, $modified_at)
		`,
		bind: {
			$vault_path: file.path,
			$curie: curie,
			$subject: subject,
			$subject_curie: subjectCurie,
			$predicate: predicate,
			$object: object,
			$object_curie: objectCurie,
			$coverage: stringOrNull(fm.coverage),
			$reviewer: stringOrNull(fm.reviewer),
			$review_date: stringOrNull(fm.review_date),
			$status: stringOrNull(fm.status),
			$confidence: numberOrNull(fm.confidence),
			$scope: stringOrNull(fm.scope),
			$expires_at: stringOrNull(fm.expires_at),
			$notes: stringOrNull(fm.notes),
			$reviewed_against_curie: baselineComplete ? reviewedAgainstCurie : null,
			$reviewed_against_cid: baselineComplete ? reviewedAgainstCid : null,
			$reviewed_wording_cid: reviewedGroups?.wording ?? null,
			$reviewed_scope_cid: reviewedGroups?.scope ?? null,
			$reviewed_housekeeping_cid: reviewedGroups?.housekeeping ?? null,
			$import_set_id: importSetId,
			$source_hash: sourceHash,
			$modified_at: modifiedAt,
		},
	});
}

function upsertMapping(
	sink: StatementSink,
	sourcePath: string,
	fm: Record<string, any>,
	predicateModifier: '' | 'NOT',
): void {
	const subjectId = String(fm.subject_id ?? '').trim();
	const predicateId = String(fm.predicate_id ?? '').trim();
	const objectId = String(fm.object_id ?? '').trim();
	if (!subjectId || !predicateId || !objectId) {
		throw new Error(`crosswalk-edge missing required subject_id/predicate_id/object_id`);
	}

	const sourceHash = hashFrontmatter(fm);
	const importSetId = extractImportSetId(fm);

	const mappingSetId = normalizeMappingSetId(fm.mapping_set_id);
	sink.push({
		sql: `
			INSERT INTO mappings
				(import_set_id, mapping_set_id, subject_id, predicate_id, predicate_modifier, object_id, match_type, match_confidence, mapping_justification, mapping_provider, mapping_date, creator_id, review_status, source_path, source_hash)
			VALUES ($import_set_id, $mapping_set_id, $subject_id, $predicate_id, $predicate_modifier, $object_id, $match_type, $match_confidence, $mapping_justification, $mapping_provider, $mapping_date, $creator_id, $review_status, $source_path, $source_hash)
			ON CONFLICT(source_path) DO UPDATE SET
				import_set_id = excluded.import_set_id,
				mapping_set_id = excluded.mapping_set_id,
				subject_id = excluded.subject_id,
				predicate_id = excluded.predicate_id,
				predicate_modifier = excluded.predicate_modifier,
				object_id = excluded.object_id,
				match_type = excluded.match_type,
				match_confidence = excluded.match_confidence,
				mapping_justification = excluded.mapping_justification,
				mapping_provider = excluded.mapping_provider,
				mapping_date = excluded.mapping_date,
				creator_id = excluded.creator_id,
				review_status = excluded.review_status,
				source_hash = excluded.source_hash
		`,
		bind: {
			$import_set_id: importSetId,
			$mapping_set_id: mappingSetId,
			$subject_id: subjectId,
			$predicate_id: predicateId,
			$predicate_modifier: predicateModifier,
			$object_id: objectId,
			$match_type: stringOrNull(fm.match_type),
			$match_confidence: numberOrNull(fm.match_confidence),
			$mapping_justification: stringOrNull(fm.mapping_justification),
			$mapping_provider: stringOrNull(fm.mapping_provider),
			$mapping_date: stringOrNull(fm.mapping_date),
			$creator_id: stringOrNull(fm.creator_id),
			$review_status: stringOrNull(fm.review_status),
			$source_path: sourcePath,
			$source_hash: sourceHash,
		},
	});

}

/**
 * Ensure ontology row(s) exist for the given frontmatter, kind-aware:
 *   - 'concept' → register the concept's own ontology (from fm.curie prefix)
 *   - 'crosswalk-edge' → register BOTH subject + object ontologies
 *
 * Idempotent — INSERT OR IGNORE so existing ontologies aren't clobbered.
 * Placeholder name/version/base_path/recipe_id — fully populated in a
 * future milestone when the projector also walks ImportRecipe metadata.
 */
function ensureOntologyForKind(
	sink: StatementSink,
	fm: Record<string, any>,
	seen: Set<string>,
	vaultPath: string,
	kind: 'concept' | 'crosswalk-edge',
): void {
	const ids: string[] = [];
	if (kind === 'concept') {
		const id = deriveConceptOntologyId(fm);
		if (id) ids.push(id);
	} else if (kind === 'crosswalk-edge') {
		const subjectId = curiePrefix(fm.subject_id);
		const objectId = curiePrefix(fm.object_id);
		if (subjectId) ids.push(subjectId);
		if (objectId) ids.push(objectId);
	}

	const importedAt = extractProducedAt(fm) ?? new Date().toISOString();
	const basePath = derivePathPrefix(vaultPath);

	const version = kind === 'concept' ? extractSourceVersion(fm) : '';
	for (const id of ids) {
		if (kind === 'crosswalk-edge' && seen.has(id)) continue;
		sink.push({
			sql: `
				INSERT INTO ontologies
					(id, name, version, base_path, upstream_url, recipe_id, imported_at, control_count)
				VALUES ($id, $name, $version, $base_path, $upstream_url, $recipe_id, $imported_at, 0)
				ON CONFLICT(id) DO UPDATE SET
					version = CASE
						WHEN excluded.version = '' THEN ontologies.version
						WHEN ontologies.version = '' THEN excluded.version
						WHEN excluded.version COLLATE BINARY > ontologies.version COLLATE BINARY
							THEN excluded.version
						ELSE ontologies.version
					END
			`,
			bind: {
				$id: id,
				$name: id,
				$version: version,
				$base_path: basePath,
				$upstream_url: null,
				$recipe_id: id,
				$imported_at: importedAt,
			},
		});
		seen.add(id);
	}
}

// ============================================================================
// Frontmatter helpers
// ============================================================================

/**
 * Read frontmatter via Obsidian's metadataCache. Strips the internal
 * `position` key which is not part of the user-visible YAML.
 */
function readFrontmatter(app: App, file: TFile): Record<string, any> | null {
	const cache = app.metadataCache.getFileCache(file);
	const fm = cache?.frontmatter;
	if (!fm || typeof fm !== 'object') return null;
	const out: Record<string, any> = {};
	for (const [k, v] of Object.entries(fm)) {
		if (k !== 'position') out[k] = v;
	}
	return out;
}

/**
 * Derive the ontology_id for a concept-note. Prefers the concept's own
 * `fm.curie` prefix because the concept's identity is more authoritative
 * than `_crosswalker.source_ref.curie` (which can be the fallback
 * 'unknown:_' when no source-ref keys are present at write time).
 *
 * Strategy:
 *   1. `fm.curie` prefix (concept's identity) — e.g., 'nist:AC-2' → 'nist'
 *   2. `_crosswalker.source_ref.curie` prefix — provenance fallback
 *   3. 'unknown' if neither yields a CURIE
 */
function deriveConceptOntologyId(fm: Record<string, any>): string {
	const fromCurie = curiePrefix(fm.curie);
	if (fromCurie) return fromCurie;
	const sourceCurie = curiePrefix(fm._crosswalker?.source_ref?.curie);
	if (sourceCurie) return sourceCurie;
	return 'unknown';
}

/**
 * Extract the prefix from a CURIE-shaped string, or null if the input
 * doesn't have a colon-separated prefix.
 */
function curiePrefix(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const idx = value.indexOf(':');
	if (idx <= 0) return null;
	return value.slice(0, idx);
}

function extractSourceVersion(fm: Record<string, any>): string {
	const value = fm._crosswalker?.source_ref?.version;
	return typeof value === 'string' ? value.trim() : '';
}

/** Read the owning import set from provenance; legacy notes project null. */
function extractImportSetId(fm: Record<string, any>): string | null {
	return stringOrNull(fm._crosswalker?.import_set?.id);
}

/**
 * Extract the imported_at timestamp from `_crosswalker.produced_at`,
 * falling back to null if not present.
 */
function extractProducedAt(fm: Record<string, any>): string | null {
	const t = fm._crosswalker?.produced_at;
	return typeof t === 'string' ? t : null;
}

/**
 * Derive the path prefix (everything before the filename) for use as
 * an ontology base_path. Used as a placeholder until recipe metadata
 * is walked.
 */
function derivePathPrefix(vaultPath: string): string {
	const lastSlash = vaultPath.lastIndexOf('/');
	if (lastSlash === -1) return '';
	return vaultPath.slice(0, lastSlash);
}

/**
 * Compute a deterministic content hash of frontmatter. Excludes
 * `_crosswalker.produced_at` (varies per import) so re-imports of
 * unchanged source data produce stable hashes.
 *
 * Synchronous Web Crypto isn't available in the renderer, so we use
 * a non-cryptographic FNV-1a hash. Source-hash collisions are not
 * security-critical here — this is for change detection, not integrity.
 * (Cryptographic hashes for the audit trail are a v0.1.8 concern.)
 */
export function hashFrontmatter(fm: Record<string, any>): string {
	const stable = stripVolatile(fm);
	const json = canonicalJson(stable);
	return 'fnv1a-' + fnv1a32(json).toString(16).padStart(8, '0');
}

function stripVolatile(fm: Record<string, any>): Record<string, any> {
	const out: Record<string, any> = {};
	for (const [k, v] of Object.entries(fm)) {
		if (k === '_crosswalker' && v && typeof v === 'object') {
			const { produced_at: _omit, ...rest } = v as Record<string, any>;
			out[k] = rest;
		} else {
			out[k] = v;
		}
	}
	return out;
}

/**
 * Canonical JSON serialization with sorted keys at every nesting level.
 * Deterministic across runs.
 */
function canonicalJson(value: unknown): string {
	if (value === null || value === undefined) return JSON.stringify(value);
	if (typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
	const keys = Object.keys(value as Record<string, unknown>).sort();
	return (
		'{' +
		keys
			.map((k) => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k]))
			.join(',') +
		'}'
	);
}

/**
 * 32-bit FNV-1a hash. Non-cryptographic; used only for change detection.
 */
function fnv1a32(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

// ============================================================================
// Type coercion helpers
// ============================================================================

function stringOrNull(v: unknown): string | null {
	if (v === undefined || v === null || v === '') return null;
	return String(v);
}

function numberOrNull(v: unknown): number | null {
	if (v === undefined || v === null || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/** Keys written by `recordProjectionStamp`, read by `readProjectionStatus`. */
const PROJECTION_STAMP_KEYS = {
	at: 'last_projected_at',
	mode: 'last_projection_mode',
	ok: 'last_projection_success',
} as const;

/**
 * Record when this projection ran, how complete it was, and whether it
 * succeeded. Written to `schema_meta` rather than a new table because it is
 * exactly three singleton facts about the index as a whole.
 *
 * Best-effort by design: failing to write a status stamp must never fail a
 * projection that otherwise succeeded. A missing stamp is reported honestly as
 * "unknown" downstream, which is the correct thing for a reader to see.
 */
async function recordProjectionStamp(
	db: Tier2Db,
	stamp: { mode: 'full' | 'partial'; success: boolean },
): Promise<void> {
	try {
		const rows: Array<[string, string]> = [
			[PROJECTION_STAMP_KEYS.at, new Date().toISOString()],
			[PROJECTION_STAMP_KEYS.mode, stamp.mode],
			[PROJECTION_STAMP_KEYS.ok, stamp.success ? 'true' : 'false'],
		];
		await db.execBatch(rows.map(([key, value]) => ({
			sql: 'INSERT OR REPLACE INTO schema_meta(key, value) VALUES ($key, $value)',
			bind: { $key: key, $value: value },
		})));
	} catch {
		// Intentionally swallowed — see the doc comment above.
	}
}

/** What the index can say about its own freshness. */
export interface ProjectionStatus {
	/** ISO timestamp of the last projection, or null when never stamped. */
	lastProjectedAt: string | null;
	/** Whether that pass covered the whole vault. */
	mode: 'full' | 'partial' | 'unknown';
	/** Whether that pass completed without per-note errors. */
	succeeded: boolean | null;
}

/**
 * Read the projection stamp. Every field degrades to an explicit unknown
 * rather than a plausible default, because a report claiming a freshness it
 * cannot substantiate is worse than one admitting it does not know.
 */
export async function readProjectionStatus(dbLike: Tier2DbLike): Promise<ProjectionStatus> {
	const db = asTier2Db(dbLike);
	const read = async (key: string): Promise<string | null> => {
		try {
			const rows = await db.exec({
				sql: 'SELECT value FROM schema_meta WHERE key = $key LIMIT 1',
				bind: { $key: key },
				rowMode: 'array',
				returnValue: 'resultRows',
			});
			const value = rows?.[0]?.[0];
			return value === undefined || value === null ? null : String(value);
		} catch {
			return null;
		}
	};

	const mode = await read(PROJECTION_STAMP_KEYS.mode);
	const ok = await read(PROJECTION_STAMP_KEYS.ok);
	return {
		lastProjectedAt: await read(PROJECTION_STAMP_KEYS.at),
		mode: mode === 'full' || mode === 'partial' ? mode : 'unknown',
		succeeded: ok === null ? null : ok === 'true',
	};
}
