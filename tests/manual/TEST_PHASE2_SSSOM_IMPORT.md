# Phase 2 manual test guide — SSSOM TSV import

**What shipped**: Phase 2 of v0.1.6. SSSOM TSV import + Tier 2 mappings table population + eager closure precompute. Per Ch 35.

**What's NOT in Phase 2** (Phases 3-5 pending):
- `crosswalkerPivot` Bases view (Phase 3) — you can import SSSOM but can't yet render a pivot from it via Bases
- Recipe-picker UX (Phase 4)
- Opt-in materialization command (Phase 5)

You can verify Phase 2 by importing an SSSOM file and querying the resulting junction notes via the existing Tier 2 SQL helpers (`plugin.queryCrosswalk`, `plugin.queryClosure`).

---

## Pre-flight — reload after every rebuild

The test-vault ships with the [Hot Reload](https://github.com/pjeby/hot-reload) community plugin installed and Crosswalker registered for auto-reload (`.hotreload` marker file in the plugin directory). When the dev workflow rebuilds `main.js`, Hot Reload will pick it up automatically — no manual reload needed.

If Hot Reload isn't running (you disabled it, fresh vault, etc.), you MUST manually reload after every rebuild:

- Settings → Community plugins → toggle Crosswalker **off**, then **on**, OR
- Ctrl+R inside the dev console (Ctrl+Shift+I → Console → Ctrl+R)

Without a reload, Obsidian keeps the OLD plugin code in memory regardless of what's on disk. Bugs that have been fixed will still appear to be present.

---

## Pre-flight checks (automated)

- [x] `bun run test` → 164/164 pass (added 25 new for SSSOM)
- [x] `bun run build` → clean
- [x] `bun run check:fixtures-drift` → no drift
- [x] `bun run lint` → no NEW lint failures (7 pre-existing on main remain)

---

## Manual test scenarios

### Scenario 1: Import the test SSSOM fixture

A test SSSOM file ships at `tools/fixtures/synthetic/nist-csf-to-iso27001.sssom.tsv` — 11 mappings between NIST CSF and ISO 27001 covering all 5 SKOS predicates.

**Steps:**
1. Build + reload plugin in test vault
2. Copy `tools/fixtures/synthetic/nist-csf-to-iso27001.sssom.tsv` into your test vault root (or anywhere)
3. Command palette → `Crosswalker: Import SSSOM mapping file`
4. Click `Pick from vault` → select the `.sssom.tsv` file
5. Verify the preview shows:
   - **Mapping rows**: 11
   - **Source ontology**: csf
   - **Target ontology**: iso27001
   - **Output folder**: `_crosswalker/mappings/csf-to-iso27001/`
6. Click `Import`
7. Verify a Notice appears: "SSSOM import: 11 junction notes created in _crosswalker/mappings/csf-to-iso27001"

**Expected vault state after import:**
- `_crosswalker/mappings/csf-to-iso27001/cw-csf-gv-oc-01-iso27001-a-5-1.md` (and 10 more)
- Each note has frontmatter with `predicate_id` (STRM-normalized: `is_equivalent_to`/`is_approximate_to`/etc.) + `sssom_predicate` (original SKOS) + `subject_id`, `object_id`, `subject_label`, `object_label`, `mapping_justification`, `mapping_provider`, `mapping_set_id`, `source_framework: csf`, `target_framework: iso27001`, `tags: [crosswalk/csf-to-iso27001]`

### Scenario 2: Verify Tier 2 mappings table populated

After Scenario 1's import:

**Steps (dev console — Ctrl+Shift+I or Cmd+Opt+I):**
```js
const rows = await app.plugins.plugins.crosswalker.queryCrosswalk('csf', 'iso27001')
console.log(rows.length, rows[0])
```

**Expected**: 11 rows with `subject_id`, `predicate_id`, `object_id`, `mapping_justification` from the SSSOM source. The `predicate_id` is the STRM-normalized form (e.g., `is_approximate_to`).

### Scenario 3: Verify eager closure precompute ran

```js
// Should return cached closure rows from the precompute, not recompute
const closure = await app.plugins.plugins.crosswalker.queryClosure('csf:GV.OC-01')
console.log(closure)
// expect: rows showing csf:GV.OC-01 → iso27001:A.5.1 (depth 1)
```

The lazy `closureFromConcept` would also produce this — but Phase 2's `precomputeClosure` ran during import so the cache was already populated. You can verify by checking the closure_cache table directly:

```js
const handle = await app.plugins.plugins.crosswalker.openTier2()
const cached = handle.db.exec({
  sql: `SELECT COUNT(*) FROM closure_cache WHERE subject_id LIKE 'csf:%'`,
  rowMode: 'array',
  returnValue: 'resultRows',
})
console.log('cached closure rows for csf:', cached[0][0])
```

**Expected**: count > 0 (the 11 imported mappings produce ~11 closure rows since each csf concept maps to exactly one iso27001 concept).

### Scenario 4: Idempotent re-import

**Steps:**
1. Run Scenario 1 again on the SAME `.sssom.tsv` file
2. Verify the same 11 junction notes are produced (no duplicates)
3. Verify the import succeeds with no error

**Expected**: idempotent. `overwriteMode: 'replace'` (default) overwrites the existing junction notes; `overwriteMode: 'skip'` would skip them.

### Scenario 5: Paste TSV instead of file picker

**Steps:**
1. `Crosswalker: Import SSSOM mapping file`
2. Click `Paste TSV` instead of `Pick from vault`
3. Paste this minimal SSSOM:
   ```
   # subject_source: "test"
   # object_source: "demo"
   subject_id	predicate_id	object_id
   test:A	skos:exactMatch	demo:1
   test:B	skos:closeMatch	demo:2
   ```
4. Click `Use this TSV`
5. Verify preview shows 2 rows + source `test` + target `demo`
6. Click `Import`

**Expected**: 2 junction notes created in `_crosswalker/mappings/test-to-demo/`.

### Scenario 6: Error handling — malformed TSV

**Steps:**
1. Paste a TSV missing `predicate_id`:
   ```
   subject_id	object_id
   test:A	demo:1
   ```
2. Verify preview shows "Parse errors:" with message about missing `predicate_id`
3. Verify the `Import` button is disabled

### Scenario 7: SSSOM with non-SKOS predicate

If the TSV uses an unknown predicate (e.g., `oboInOwl:hasDbXref`):

**Expected**: import succeeds; the predicate is normalized to `intersects_with` (the most-permissive STRM fallback) with a warning logged. The original predicate is preserved as `sssom_predicate` in the junction-note frontmatter.

---

## Edge cases to verify

- [ ] SSSOM with curie_map header → header parsed correctly (no errors)
- [ ] Confidence value as `0.85` parses to number; non-numeric `high` produces a warning
- [ ] Two consecutive imports of different files → both ontology pairs in their own folders
- [ ] Import + then run `app.plugins.plugins.crosswalker.runProjection()` manually → no double-counting

---

## Things that should explicitly NOT work yet (deferred to Phase 3+)

- ❌ Bases view of the imported pivot (Phase 3 — `crosswalkerPivot` view doesn't exist yet)
- ❌ Recipe-picker UX inserting embedded `base` block (Phase 4)
- ❌ Materialization to `_crosswalker/audit/` (Phase 5)
- ❌ Sparse-pivot guard (Phase 5)
- ❌ `match_confidence` as a typed number (deferred — render template engine emits strings; SSSOM `confidence` is preserved as `sssom_confidence` string instead)

---

## Sign-off checklist

- [ ] Scenario 1: 11 junction notes created in `_crosswalker/mappings/csf-to-iso27001/`
- [ ] Scenario 2: `queryCrosswalk('csf', 'iso27001')` returns 11 rows with STRM predicates
- [ ] Scenario 3: closure_cache populated after import
- [ ] Scenario 4: idempotent re-import works
- [ ] Scenario 5: paste-TSV path works
- [ ] Scenario 6: error feedback on malformed TSV
- [ ] No regressions in v0.1.5 sidecar / v0.1.6 Phase 1 functionality

If all green: ready to start Phase 3 (`crosswalkerPivot` Bases view).

---

## Files changed in Phase 2

| Change | Path |
|---|---|
| CREATED | `src/import/sssom-parser.ts` (TSV parser; 19 unit tests) |
| CREATED | `src/import/sssom-importer.ts` (orchestrator) |
| CREATED | `src/import/sssom-import-modal.ts` (UX) |
| CREATED | `tools/fixtures/synthetic/nist-csf-to-iso27001.sssom.tsv` |
| CREATED | `tests/sssom-parser.test.ts` (19 unit tests) |
| CREATED | `tests/sssom-importer.test.ts` (6 integration tests with mock vault) |
| EDITED | `src/main.ts` (new command + plugin.precomputeClosure handle) |
| EDITED | `src/tier2/queries.ts` (added precomputeClosureForOntologyPair) |
