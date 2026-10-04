import { asTier2Db, type ExecInput, type Tier2Db, type Tier2DbLike } from './db';
import {
	PREDICATE_CHARACTERISTICS,
	getPredicateCharacteristics,
} from './predicate-characteristics';

/**
 * Tier 2 query API — typed SQL helpers for the v0.1.6 Bases query layer
 * + v0.1.7 exporters to consume.
 *
 * Per the [system architecture page Layer 4](https://cybersader.github.io/crosswalker/concepts/system-architecture/#layer-4--query-t1--t2--user):
 * Tier 2 is for queries that need joins, multi-ontology aggregation, or
 * transitive closure. Flat per-frontmatter-field queries route through
 * Bases over Tier 1 directly (no plugin needed).
 *
 * Three core helpers in v0.1.5 Phase 3:
 *   - getConceptsByOntology(db, ontologyId)
 *   - crosswalkBetween(db, subjectOntology, objectOntology, predicateId?)
 *   - closureFromConcept(db, startCurie, predicateId?, maxDepth?)
 *
 * Closure-cache materialization (Ch 18 §2.5): each (start, predicate)
 * partition records the maximum depth fully computed. Equal or shallower
 * requests reuse it; deeper requests atomically replace and advance it.
 * Invalidation happens in the projector after any mappings change.
 */

/**
 * A concept-note row (subset of Tier 2 `concepts` table).
 */
export interface ConceptRow {
	ontology_id: string;
	curie: string;
	vault_path: string;
	title: string;
	parent_curie: string | null;
	status: string;
	imported_at: string;
	modified_at: string;
}

/**
 * A crosswalk-edge row (subset of Tier 2 `mappings` table).
 */
export interface MappingRow {
	mapping_set_id: string | null;
	subject_id: string;
	predicate_id: string;
	predicate_modifier: 'NOT' | null;
	object_id: string;
	match_type: string | null;
	match_confidence: number | null;
	mapping_justification: string | null;
	mapping_provider: string | null;
	source_path: string;
}

/**
 * A closure entry — a concept reachable from a starting concept via N
 * crosswalk hops. `depth` is the shortest path length (1 = direct edge).
 *
 * Semantic interpretation of the closure_cache schema columns
 * (subject_id, predicate_id, object_id):
 *   - subject_id = the START of the chain (the starting concept the
 *                  closure was queried from)
 *   - object_id  = the REACHABLE TARGET (a concept reachable from start)
 *   - predicate_id = the versioned physical cache-partition key
 *   - shortest_depth = number of edges in the shortest chain start → target
 */
export interface ClosureEntry {
	/** Starting CURIE (constant across rows produced by one query). */
	start_curie: string;
	/** Predicate filter applied (or the reserved '*' cache marker for no filter). */
	predicate_filter: string;
	/** A concept reachable from start_curie. */
	target_curie: string;
	/** Number of edges in the shortest path start → target. */
	shortest_depth: number;
}

const WILDCARD_PREDICATE_FILTER = '*';
// Physical cache-partition prefix. The predicate-characteristics table is an
// INPUT to every cached closure result, so this must move whenever that table
// changes — a cache key that does not cover its own inputs is exactly the bug
// class fixed on 2026-08-20. v2 (2026-08-28, Ch 43): added the transitive
// lineage pair superseded_by / supersedes. Cost of the bump is one recompute
// of a rebuildable cache.
const CLOSURE_SEMANTICS_VERSION = 'predicate-characteristics-v2';

interface PredicateCharacteristicsSqlPlan {
	cte: string;
	bind: Record<string, unknown>;
}

function assertPredicateFilterIsValid(predicateId?: string): void {
	if (predicateId === WILDCARD_PREDICATE_FILTER) {
		throw new RangeError(
			`predicateId '${WILDCARD_PREDICATE_FILTER}' is reserved for unfiltered closure queries`,
		);
	}
	if (predicateId !== undefined && getPredicateCharacteristics(predicateId) === null) {
		throw new RangeError(`Unknown Crosswalker predicate: ${predicateId}`);
	}
}

function cachePredicateKey(logicalPredicateFilter: string): string {
	return `${CLOSURE_SEMANTICS_VERSION}|${logicalPredicateFilter}`;
}

function buildPredicateCharacteristicsSqlPlan(): PredicateCharacteristicsSqlPlan {
	const bind: Record<string, unknown> = {};
	const values = Object.values(PREDICATE_CHARACTERISTICS).map((characteristics, index) => {
		const predicateKey = `$characteristicPredicate${index}`;
		const inverseKey = `$characteristicInverse${index}`;
		const symmetricKey = `$characteristicSymmetric${index}`;
		const transitiveKey = `$characteristicTransitive${index}`;
		bind[predicateKey] = characteristics.predicate_id;
		bind[inverseKey] = characteristics.inverse_predicate_id;
		bind[symmetricKey] = characteristics.symmetric ? 1 : 0;
		bind[transitiveKey] = characteristics.transitive ? 1 : 0;
		return `(${predicateKey}, ${inverseKey}, ${symmetricKey}, ${transitiveKey})`;
	});

	return {
		cte: `predicate_characteristics(
			predicate_id, inverse_predicate_id, symmetric, transitive
		) AS (VALUES ${values.join(', ')})`,
		bind,
	};
}

// Effective traversal contains positive assertions only. Keep this predicate in
// both branches: the stored direction and every symmetric/inverse direction
// synthesized from predicate characteristics. Direct stored-assertion queries
// remain separate and continue to return exact `predicate_modifier: NOT` rows.
//
// The exact empty-string comparison is intentional. The v3 schema stores an
// absent positive modifier as '', rejects every value except '' or 'NOT', and
// the projector refuses malformed explicit modifiers rather than coercing them.
const EFFECTIVE_EDGES_CTE = `effective_edges(subject_id, predicate_id, object_id) AS (
	SELECT m.subject_id, m.predicate_id, m.object_id
	FROM mappings m
	JOIN predicate_characteristics pc ON pc.predicate_id = m.predicate_id
	WHERE m.predicate_modifier = ''

	UNION

	SELECT
		m.object_id,
		CASE
			WHEN pc.symmetric = 1 THEN pc.predicate_id
			ELSE pc.inverse_predicate_id
		END,
		m.subject_id
	FROM mappings m
	JOIN predicate_characteristics pc ON pc.predicate_id = m.predicate_id
	WHERE m.predicate_modifier = ''
)`;

// ============================================================================
// 1. List concepts in an ontology
// ============================================================================

/**
 * All concepts in the given ontology. Returns rows ordered by curie.
 *
 * Use case: "show me all NIST 800-53 controls" — flat list. For the Bases
 * query layer (v0.1.6), this is the SQL fallback when Bases over Tier 1
 * frontmatter isn't sufficient.
 */
export async function getConceptsByOntology(dbLike: Tier2DbLike, ontologyId: string): Promise<ConceptRow[]> {
	const db = asTier2Db(dbLike);
	const rows = await db.exec({
		sql: `
			SELECT ontology_id, curie, vault_path, title, parent_curie, status, imported_at, modified_at
			FROM concepts
			WHERE ontology_id = $ontology_id
			ORDER BY curie
		`,
		bind: { $ontology_id: ontologyId },
		rowMode: 'array',
		returnValue: 'resultRows',
	});

	return rows.map((r) => ({
		ontology_id: String(r[0]),
		curie: String(r[1]),
		vault_path: String(r[2]),
		title: String(r[3]),
		parent_curie: r[4] === null || r[4] === undefined ? null : String(r[4]),
		status: String(r[5]),
		imported_at: String(r[6]),
		modified_at: String(r[7]),
	}));
}

// ============================================================================
// 2. Crosswalks between two ontologies (direct edges only)
// ============================================================================

/**
 * Direct crosswalk edges between two ontologies, optionally filtered by
 * STRM predicate. Does NOT compute transitive closure — for chains, use
 * closureFromConcept.
 *
 * Use case: "show me all CSF→800-53 mappings labeled is_equivalent_to."
 *
 * Subject prefix matches the ontology id (the part before ':' in the
 * subject_id CURIE). Same for object.
 */
export async function crosswalkBetween(
	dbLike: Tier2DbLike,
	subjectOntology: string,
	objectOntology: string,
	predicateId?: string,
): Promise<MappingRow[]> {
	const db = asTier2Db(dbLike);
	// SQLite has no native CURIE-prefix function; use LIKE with the
	// 'prefix:' pattern. Indexed via idx_mappings_subj / idx_mappings_obj.
	const subjectLike = `${subjectOntology}:%`;
	const objectLike = `${objectOntology}:%`;

	const sql = predicateId
		? `
			SELECT mapping_set_id, subject_id, predicate_id, predicate_modifier, object_id,
			       match_type, match_confidence, mapping_justification, mapping_provider, source_path
			FROM mappings
			WHERE subject_id LIKE $subj
			  AND object_id LIKE $obj
			  AND predicate_id = $pred
			ORDER BY subject_id, object_id, predicate_id,
			         mapping_set_id COLLATE BINARY, predicate_modifier COLLATE BINARY, source_path
		`
		: `
			SELECT mapping_set_id, subject_id, predicate_id, predicate_modifier, object_id,
			       match_type, match_confidence, mapping_justification, mapping_provider, source_path
			FROM mappings
			WHERE subject_id LIKE $subj
			  AND object_id LIKE $obj
			ORDER BY subject_id, object_id, predicate_id,
			         mapping_set_id COLLATE BINARY, predicate_modifier COLLATE BINARY, source_path
		`;

	const bind: Record<string, unknown> = { $subj: subjectLike, $obj: objectLike };
	if (predicateId) bind.$pred = predicateId;

	const rows = await db.exec({
		sql,
		bind,
		rowMode: 'array',
		returnValue: 'resultRows',
	});

	return rows.map((r) => ({
		mapping_set_id: r[0] === null || r[0] === undefined || r[0] === '' ? null : String(r[0]),
		subject_id: String(r[1]),
		predicate_id: String(r[2]),
		predicate_modifier: r[3] === 'NOT' ? 'NOT' : null,
		object_id: String(r[4]),
		match_type: r[5] === null || r[5] === undefined ? null : String(r[5]),
		match_confidence:
			r[6] === null || r[6] === undefined || r[6] === '' ? null : Number(r[6]),
		mapping_justification: r[7] === null || r[7] === undefined ? null : String(r[7]),
		mapping_provider: r[8] === null || r[8] === undefined ? null : String(r[8]),
		source_path: String(r[9]),
	}));
}

// ============================================================================
// 3. Transitive closure from a concept (recursive CTE + lazy cache)
// ============================================================================

/**
 * All concepts reachable from `startCurie` via a chain of crosswalk
 * edges, optionally filtered by predicate. Computed via recursive CTE.
 *
 * Use case: "all NIST controls that NIST CSF Identify maps to via any
 * chain of crosswalks" — the canonical Tier 2 query that's awkward over
 * raw Markdown frontmatter.
 *
 * **Lazy closure-cache behavior (Ch 18 §2.5):**
 *
 * 1. A cache-state row records the maximum depth fully computed for each
 *    (start, predicate) partition. Cached rows are authoritative only when
 *    that watermark covers the requested depth.
 * 2. A deeper request replaces that partition atomically, then advances the
 *    watermark. Shallower requests reuse the deeper rows with a SQL depth filter.
 * 3. The separate state row makes a computed empty closure distinguishable
 *    from a cache miss.
 *
 * **Cache invalidation**: the projector (`src/tier2/projector.ts`)
 * deletes from both cache tables after any mappings rows change. So a
 * fresh projection invalidates all cached closures globally — simple
 * and correct (mtime-based per-row invalidation is a future
 * optimization).
 *
 * @param dbLike the Tier 2 database (`Tier2Db`, or a raw handle wrapped in `LocalDb`)
 * @param startCurie e.g. 'nist-csf:Identify' — the starting concept
 * @param predicateId e.g. 'is_equivalent_to' — optional Crosswalker predicate filter
 * @param maxDepth max chain length (default 10; prevents runaway recursion)
 */
export async function closureFromConcept(
	dbLike: Tier2DbLike,
	startCurie: string,
	predicateId?: string,
	maxDepth: number = 10,
): Promise<ClosureEntry[]> {
	const db = asTier2Db(dbLike);
	if (!Number.isInteger(maxDepth) || maxDepth < 0) {
		throw new RangeError('maxDepth must be a non-negative integer');
	}
	assertPredicateFilterIsValid(predicateId);

	const logicalPredicateFilter = predicateId ?? WILDCARD_PREDICATE_FILTER;
	const physicalCacheKey = cachePredicateKey(logicalPredicateFilter);

	// The watermark, not row count, proves cache completeness. A valid cache
	// partition may contain zero rows when the start concept has no outbound edges.
	const cached = await readCache(
		db,
		startCurie,
		physicalCacheKey,
		logicalPredicateFilter,
		maxDepth,
	);
	if (cached !== null) {
		return cached;
	}

	let entries: ClosureEntry[] = [];
	if (maxDepth > 0) {
		const closure = closureCte(startCurie, predicateId, maxDepth);
		const rows = await db.exec({
			sql: `
				${closure.sql}
				SELECT start_curie, target, MIN(depth) AS shortest_depth
				FROM closure
				GROUP BY start_curie, target
				ORDER BY shortest_depth, target
			`,
			bind: closure.bind,
			rowMode: 'array',
			returnValue: 'resultRows',
		});

		entries = rows.map((r) => ({
			start_curie: String(r[0]),
			predicate_filter: logicalPredicateFilter,
			target_curie: String(r[1]),
			shortest_depth: Number(r[2]),
		}));
	}

	await replaceCache(db, startCurie, physicalCacheKey, maxDepth, entries);
	return entries;
}

/**
 * The recursive closure CTE for one start concept, ending in a `closure`
 * relation of (start_curie, target, predicate_id, depth, path). The reader
 * selects from it; the precompute inserts from it. One definition, so both can
 * never compute different closures.
 */
function closureCte(
	startCurie: string,
	predicateId: string | undefined,
	maxDepth: number,
): { sql: string; bind: Record<string, unknown> } {
	const hasPredicateFilter = typeof predicateId === 'string';
	const characteristicsPlan = buildPredicateCharacteristicsSqlPlan();
	return {
		sql: `
			WITH RECURSIVE
			  ${characteristicsPlan.cte},
			  ${EFFECTIVE_EDGES_CTE},
			  closure(start_curie, target, predicate_id, depth, path) AS (
			    SELECT
			      $start,
			      edge.object_id,
			      edge.predicate_id,
			      1 AS depth,
			      '|' || $start || '|' || edge.object_id || '|' AS path
			    FROM effective_edges edge
			    WHERE edge.subject_id = $start
			      ${hasPredicateFilter ? 'AND edge.predicate_id = $pred' : ''}

			    UNION ALL

			    SELECT
			      closure.start_curie,
			      edge.object_id,
			      closure.predicate_id,
			      closure.depth + 1,
			      closure.path || edge.object_id || '|'
			    FROM closure
			    JOIN effective_edges edge
			      ON edge.subject_id = closure.target
			     AND edge.predicate_id = closure.predicate_id
			    JOIN predicate_characteristics pc
			      ON pc.predicate_id = closure.predicate_id
			     AND pc.transitive = 1
			    WHERE closure.depth < $max
			      AND instr(closure.path, '|' || edge.object_id || '|') = 0
			  )
		`,
		bind: {
			...characteristicsPlan.bind,
			$start: startCurie,
			$max: maxDepth,
			...(hasPredicateFilter ? { $pred: predicateId } : {}),
		},
	};
}

/**
 * Read a cache partition only when its coverage watermark proves it was
 * completely computed through maxDepth. Returns null for a cache miss;
 * an empty array is a valid cached empty closure.
 *
 * One query, one Worker round trip: the watermark row LEFT JOINs the cached
 * rows, so a partition with a watermark and no rows still yields exactly one
 * (all-null) row, which is how a computed empty closure is told from a miss.
 */
async function readCache(
	db: Tier2Db,
	startCurie: string,
	physicalCacheKey: string,
	logicalPredicateFilter: string,
	maxDepth: number,
): Promise<ClosureEntry[] | null> {
	const rows = await db.exec({
		sql: `
			SELECT s.computed_max_depth, c.subject_id, c.object_id, c.shortest_depth
			FROM closure_cache_state s
			LEFT JOIN closure_cache c
			  ON c.subject_id = s.subject_id
			 AND c.predicate_id = s.predicate_id
			 AND c.shortest_depth <= $max
			WHERE s.subject_id = $start AND s.predicate_id = $pred
			ORDER BY c.shortest_depth, c.object_id
		`,
		bind: { $start: startCurie, $pred: physicalCacheKey, $max: maxDepth },
		rowMode: 'array',
		returnValue: 'resultRows',
	});

	if (rows.length === 0 || Number(rows[0][0]) < maxDepth) {
		return null;
	}

	return rows
		.filter((r) => r[1] !== null && r[1] !== undefined)
		.map((r) => ({
			start_curie: String(r[1]),
			predicate_filter: logicalPredicateFilter,
			target_curie: String(r[2]),
			shortest_depth: Number(r[3]),
		}));
}

/** Clear one cache partition: the first two statements of every replacement. */
function clearPartitionStatements(startCurie: string, physicalCacheKey: string): ExecInput[] {
	return [
		{
			sql: 'DELETE FROM closure_cache_state WHERE subject_id = $start AND predicate_id = $pred',
			bind: { $start: startCurie, $pred: physicalCacheKey },
		},
		{
			sql: 'DELETE FROM closure_cache WHERE subject_id = $start AND predicate_id = $pred',
			bind: { $start: startCurie, $pred: physicalCacheKey },
		},
	];
}

/** Advance a partition's watermark: the last statement of every replacement. */
function watermarkStatement(startCurie: string, physicalCacheKey: string, maxDepth: number, computedAt: string): ExecInput {
	return {
		sql: `
			INSERT INTO closure_cache_state
				(subject_id, predicate_id, computed_max_depth, computed_at)
			VALUES ($subj, $pred, $max, $at)
		`,
		bind: {
			$subj: startCurie,
			$pred: physicalCacheKey,
			$max: maxDepth,
			$at: computedAt,
		},
	};
}

/**
 * Replace one cache partition and advance its coverage watermark atomically.
 * The watermark is written last so a failed row insert cannot advertise
 * completeness the cache does not contain. One batch, one SAVEPOINT (W4).
 */
async function replaceCache(
	db: Tier2Db,
	startCurie: string,
	physicalCacheKey: string,
	maxDepth: number,
	entries: ClosureEntry[],
): Promise<void> {
	const computedAt = new Date().toISOString();
	const statements: ExecInput[] = clearPartitionStatements(startCurie, physicalCacheKey);
	for (const entry of entries) {
		statements.push({
			sql: `
				INSERT INTO closure_cache
					(subject_id, predicate_id, object_id, shortest_depth, computed_at)
				VALUES ($subj, $pred, $obj, $depth, $at)
			`,
			bind: {
				$subj: entry.start_curie,
				$pred: physicalCacheKey,
				$obj: entry.target_curie,
				$depth: entry.shortest_depth,
				$at: computedAt,
			},
		});
	}
	statements.push(watermarkStatement(startCurie, physicalCacheKey, maxDepth, computedAt));
	await db.execBatch(statements);
}

/**
 * Fill one subject's cache partition for the precompute, in at most two Worker
 * round trips (W4): the cache read, and on a miss one batch that clears the
 * partition, inserts the closure straight from the recursive CTE, and writes
 * the watermark last. Same rows and same watermark as `closureFromConcept`.
 */
async function precomputeOneSubject(
	db: Tier2Db,
	subjectId: string,
	predicateId: string | undefined,
	maxDepth: number,
): Promise<void> {
	const logicalPredicateFilter = predicateId ?? WILDCARD_PREDICATE_FILTER;
	const physicalCacheKey = cachePredicateKey(logicalPredicateFilter);
	const cached = await readCache(db, subjectId, physicalCacheKey, logicalPredicateFilter, maxDepth);
	if (cached !== null) return;

	const computedAt = new Date().toISOString();
	const statements: ExecInput[] = clearPartitionStatements(subjectId, physicalCacheKey);
	if (maxDepth > 0) {
		const closure = closureCte(subjectId, predicateId, maxDepth);
		statements.push({
			sql: `
				${closure.sql}
				INSERT INTO closure_cache
					(subject_id, predicate_id, object_id, shortest_depth, computed_at)
				SELECT start_curie, $cache_pred, target, MIN(depth), $at
				FROM closure
				GROUP BY start_curie, target
			`,
			bind: { ...closure.bind, $cache_pred: physicalCacheKey, $at: computedAt },
		});
	}
	statements.push(watermarkStatement(subjectId, physicalCacheKey, maxDepth, computedAt));
	await db.execBatch(statements);
}

/**
 * Eagerly precompute closure for every subject in a (sourceOntology, targetOntology)
 * pair (per Ch 35 — "every production ontology-web system materializes precomputed
 * pairwise crosswalks"). Called by the SSSOM importer after junction-edge files land
 * + projection runs.
 *
 * Strategy:
 *   1. Find all distinct effective subject_ids, including characteristic-derived reverse
 *      directions, whose subject CURIE prefix matches sourceOntology.
 *   2. For each subject, fill its cache partition (at most two round trips) so
 *      future queries hit the cache without re-running the recursive CTE.
 *   3. Return the count of (subject_id, target_id) cache rows now populated.
 *
 * Idempotent: re-running on already-cached subjects is cheap (the cache read
 * proves the partition complete and nothing is written).
 *
 * @returns Total cached (subject, target) pairs after the precompute.
 */
export async function precomputeClosureForOntologyPair(
	dbLike: Tier2DbLike,
	sourceOntology: string,
	targetOntology: string,
	predicateId?: string,
	maxDepth = 10,
): Promise<number> {
	const db = asTier2Db(dbLike);
	if (!Number.isInteger(maxDepth) || maxDepth < 0) {
		throw new RangeError('maxDepth must be a non-negative integer');
	}
	assertPredicateFilterIsValid(predicateId);

	const sourcePrefix = `${sourceOntology}:`;
	const logicalPredicateFilter = predicateId ?? WILDCARD_PREDICATE_FILTER;
	const physicalCacheKey = cachePredicateKey(logicalPredicateFilter);
	const hasPredicateFilter = typeof predicateId === 'string';
	const characteristicsPlan = buildPredicateCharacteristicsSqlPlan();
	const subjects = await db.exec({
		sql: `
			WITH
			  ${characteristicsPlan.cte},
			  ${EFFECTIVE_EDGES_CTE}
			SELECT DISTINCT subject_id FROM effective_edges
			WHERE substr(subject_id, 1, length($prefix)) = $prefix
			${hasPredicateFilter ? 'AND predicate_id = $pred' : ''}
		`,
		bind: {
			...characteristicsPlan.bind,
			$prefix: sourcePrefix,
			...(hasPredicateFilter ? { $pred: predicateId } : {}),
		},
		rowMode: 'array',
		returnValue: 'resultRows',
	});

	for (const row of subjects) {
		await precomputeOneSubject(db, String(row[0]), predicateId, maxDepth);
	}

	const count = await db.exec({
		sql: `
			SELECT COUNT(*) FROM closure_cache cc
			WHERE substr(cc.subject_id, 1, length($sourcePrefix)) = $sourcePrefix
			  AND substr(cc.object_id, 1, length($targetPrefix)) = $targetPrefix
			  AND cc.predicate_id = $physicalCacheKey
			  AND cc.shortest_depth <= $max
		`,
		bind: {
			$sourcePrefix: sourcePrefix,
			$targetPrefix: `${targetOntology}:`,
			$physicalCacheKey: physicalCacheKey,
			$max: maxDepth,
		},
		rowMode: 'array',
		returnValue: 'resultRows',
	});

	return Number(count[0]?.[0] ?? 0);
}
