/**
 * Tier 2 schema migrations.
 *
 * Tier 2 currently ships `tier2-sqlite-v6`. If a sidecar reports a different
 * schema_version (or no version at all), the simplest correct response
 * is to drop all tables and recreate from canonical Tier 1. The Tier 1
 * vault is the source of truth; the sidecar is a deletable projection.
 *
 * Per spec/tier1.schema.json + v0.1 schema spec §7. Per the Ch 24
 * substrate synthesis recovery property (§2): "if .crosswalker.sqlite
 * is missing, corrupted, or stale, the projector rebuilds it from
 * canonical Tier 1 on next vault load. This is what makes Tier 2
 * risk-free to bundle in v0.1."
 */

import { asTier2Db, type Tier2DbLike } from './db';

export const TIER2_SCHEMA_VERSION = 'tier2-sqlite-v6';

/**
 * Bundled DDL for tier2-sqlite-v6. The canonical authoring surface is
 * src/tier2/schema.sql, but the plugin does not load .sql at runtime, so the
 * executable SQL is duplicated here. tests/tier2-schema-consistency.test.ts
 * compares both surfaces after removing comments and formatting.
 */
export const TIER2_DDL_V6 = `
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ontologies (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  version         TEXT NOT NULL DEFAULT '',
  base_path       TEXT NOT NULL,
  upstream_url    TEXT,
  recipe_id       TEXT NOT NULL,
  imported_at     TEXT NOT NULL,
  control_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS concepts (
  ontology_id    TEXT NOT NULL,
  curie          TEXT NOT NULL,
  vault_path     TEXT NOT NULL UNIQUE,
  source_hash    TEXT NOT NULL,
  import_set_id  TEXT,
  title          TEXT NOT NULL DEFAULT '',
  review_cid     TEXT,
  review_wording_cid      TEXT,
  review_scope_cid        TEXT,
  review_housekeeping_cid TEXT,
  parent_curie   TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  imported_at    TEXT NOT NULL,
  modified_at    TEXT NOT NULL,
  PRIMARY KEY (ontology_id, curie),
  FOREIGN KEY (ontology_id) REFERENCES ontologies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_concepts_curie ON concepts(curie);
CREATE INDEX IF NOT EXISTS idx_concepts_parent ON concepts(parent_curie);

CREATE TABLE IF NOT EXISTS mappings (
  import_set_id         TEXT,
  mapping_set_id        TEXT NOT NULL DEFAULT '',
  subject_id            TEXT NOT NULL,
  predicate_id          TEXT NOT NULL,
  predicate_modifier    TEXT NOT NULL DEFAULT ''
                          CHECK (predicate_modifier IN ('', 'NOT')),
  object_id             TEXT NOT NULL,
  match_type            TEXT,
  match_confidence      REAL,
  mapping_justification TEXT,
  mapping_provider      TEXT,
  mapping_date          TEXT,
  creator_id            TEXT,
  review_status         TEXT,
  source_path           TEXT NOT NULL UNIQUE,
  source_hash           TEXT NOT NULL,
  PRIMARY KEY (
    mapping_set_id,
    subject_id,
    predicate_id,
    predicate_modifier,
    object_id,
    source_path
  )
);

CREATE INDEX IF NOT EXISTS idx_mappings_assertion
  ON mappings(mapping_set_id, subject_id, predicate_id, predicate_modifier, object_id);
CREATE INDEX IF NOT EXISTS idx_mappings_pred_subj ON mappings(predicate_id, subject_id);
CREATE INDEX IF NOT EXISTS idx_mappings_pred_obj  ON mappings(predicate_id, object_id);
CREATE INDEX IF NOT EXISTS idx_mappings_subj      ON mappings(subject_id);
CREATE INDEX IF NOT EXISTS idx_mappings_obj       ON mappings(object_id);

CREATE TABLE IF NOT EXISTS junction_notes (
  vault_path      TEXT PRIMARY KEY,
  curie           TEXT NOT NULL,
  subject         TEXT NOT NULL,
  subject_curie   TEXT,
  predicate       TEXT NOT NULL,
  object          TEXT NOT NULL,
  object_curie    TEXT,
  coverage        TEXT,
  reviewer        TEXT,
  review_date     TEXT,
  status          TEXT,
  confidence      REAL,
  scope           TEXT,
  expires_at      TEXT,
  notes           TEXT,
  reviewed_against_curie TEXT,
  reviewed_against_cid   TEXT,
  reviewed_wording_cid   TEXT,
  reviewed_scope_cid     TEXT,
  reviewed_housekeeping_cid TEXT,
  import_set_id   TEXT,
  source_hash     TEXT NOT NULL,
  modified_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_junction_subject ON junction_notes(subject);
CREATE INDEX IF NOT EXISTS idx_junction_object  ON junction_notes(object);
CREATE INDEX IF NOT EXISTS idx_junction_subject_curie ON junction_notes(subject_curie);
CREATE INDEX IF NOT EXISTS idx_junction_object_curie  ON junction_notes(object_curie);
CREATE INDEX IF NOT EXISTS idx_junction_status  ON junction_notes(status);

CREATE VIEW IF NOT EXISTS junction_notes_with_freshness AS
SELECT
  jn.*,
  CASE
    WHEN jn.expires_at IS NOT NULL
         AND jn.expires_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      THEN 'expired'
    WHEN jn.review_date IS NOT NULL
         AND jn.review_date < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-180 days')
      THEN 'stale'
    WHEN jn.reviewed_against_cid IS NOT NULL
         AND c.review_cid IS NOT NULL
         AND c.review_cid <> jn.reviewed_against_cid
      THEN 'subject-changed'
    WHEN jn.expires_at IS NULL AND jn.review_date IS NULL
      THEN 'not-set'
    ELSE 'fresh'
  END AS freshness,
  CASE
    WHEN jn.reviewed_against_cid IS NULL         THEN 'unrecorded'
    WHEN c.curie IS NULL                         THEN 'subject-absent'
    WHEN c.review_cid IS NULL                    THEN 'subject-unhashed'
    WHEN c.review_cid <> jn.reviewed_against_cid THEN 'changed'
    ELSE 'match'
  END AS subject_baseline,
  CASE
    WHEN jn.reviewed_against_cid IS NULL
         OR c.review_cid IS NULL
         OR c.review_cid = jn.reviewed_against_cid
      THEN NULL
    WHEN jn.reviewed_wording_cid IS NULL
         OR jn.reviewed_scope_cid IS NULL
         OR jn.reviewed_housekeeping_cid IS NULL
         OR c.review_wording_cid IS NULL
         OR c.review_scope_cid IS NULL
         OR c.review_housekeeping_cid IS NULL
      THEN 'wording'
    WHEN c.review_wording_cid <> jn.reviewed_wording_cid
      THEN 'wording'
    WHEN c.review_scope_cid <> jn.reviewed_scope_cid
      THEN 'scope'
    ELSE 'housekeeping'
  END AS change_kind
FROM junction_notes jn
LEFT JOIN concepts c
  ON c.rowid = (
    SELECT c2.rowid FROM concepts c2
    WHERE c2.curie = COALESCE(jn.reviewed_against_curie, jn.subject_curie)
    ORDER BY c2.ontology_id
    LIMIT 1
  );

CREATE TABLE IF NOT EXISTS closure_cache (
  subject_id      TEXT NOT NULL,
  predicate_id    TEXT NOT NULL,
  object_id       TEXT NOT NULL,
  shortest_depth  INTEGER NOT NULL,
  computed_at     TEXT NOT NULL,
  PRIMARY KEY (subject_id, predicate_id, object_id)
);

CREATE INDEX IF NOT EXISTS idx_closure_obj_pred ON closure_cache(object_id, predicate_id);

CREATE TABLE IF NOT EXISTS closure_cache_state (
  subject_id         TEXT NOT NULL,
  predicate_id       TEXT NOT NULL,
  computed_max_depth INTEGER NOT NULL CHECK (computed_max_depth >= 0),
  computed_at        TEXT NOT NULL,
  PRIMARY KEY (subject_id, predicate_id)
);
`.trim();

/**
 * Read the current sidecar's schema_version; null if schema_meta
 * doesn't exist (fresh DB) or no version row.
 */
export async function getCurrentSchemaVersion(dbLike: Tier2DbLike): Promise<string | null> {
	const db = asTier2Db(dbLike);
	try {
		const result = await db.exec({
			sql: "SELECT value FROM schema_meta WHERE key = 'schema_version' LIMIT 1",
			rowMode: 'array',
			returnValue: 'resultRows',
		});
		if (result.length === 0) return null;
		return String(result[0][0]);
	} catch {
		// schema_meta table doesn't exist
		return null;
	}
}

/**
 * Apply the migration to bring the database to TIER2_SCHEMA_VERSION.
 *
 * Migration strategy: any version mismatch (or no version) → drop all
 * tables + recreate. This is correct because Tier 2 is purely a
 * projection of canonical Tier 1; nothing is lost on rebuild beyond
 * the cached closure (which gets recomputed on demand).
 */
export async function applyMigrations(dbLike: Tier2DbLike): Promise<boolean> {
	const db = asTier2Db(dbLike);
	const current = await getCurrentSchemaVersion(db);

	if (current === TIER2_SCHEMA_VERSION) {
		// Already at target version; nothing to do
		return false;
	}

	// Tier 2 is fully derived, so every non-current state is rebuilt. This
	// deliberately includes unversioned databases: CREATE TABLE IF NOT EXISTS
	// must not preserve an old cache shape and then stamp it as current.
	//
	// Deliberately three separate calls rather than one batch: the DDL opens with
	// PRAGMA foreign_keys, which SQLite ignores inside a transaction.
	await db.exec(`
		DROP VIEW IF EXISTS junction_notes_with_freshness;
		DROP TABLE IF EXISTS closure_cache_state;
		DROP TABLE IF EXISTS closure_cache;
		DROP TABLE IF EXISTS junction_notes;
		DROP TABLE IF EXISTS mappings;
		DROP TABLE IF EXISTS concepts;
		DROP TABLE IF EXISTS ontologies;
		DROP TABLE IF EXISTS schema_meta;
	`);

	// Apply the current DDL. The constant is version-named on purpose: a stale
	// reference must fail to compile rather than silently apply an old shape.
	await db.exec(TIER2_DDL_V6);

	// Stamp the version. Deliberately NOT `projected_at`: the tables were just
	// emptied, so nothing has been projected. Recording a projection timestamp
	// here would assert the opposite of what is true. The caller is responsible
	// for reprojecting — see openTier2() in main.ts, which does so unconditionally
	// when this function reports a rebuild.
	await db.exec({
		sql: `INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', $sv)`,
		bind: { $sv: TIER2_SCHEMA_VERSION },
	});

	// Signals to the caller that every derived table is now empty and MUST be
	// reprojected before any query result can be trusted.
	return true;
}
