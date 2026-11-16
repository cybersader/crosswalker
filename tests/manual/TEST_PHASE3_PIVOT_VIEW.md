# Phase 3 manual test guide — `crosswalkerPivot` custom Bases view

**What shipped**: Phase 3 of v0.1.6. The single `registerBasesView` registration per Settled #2 + Ch 30. The launch-market Coverage Matrix recipe instance now has a renderer.

**What's NOT in Phase 3** (Phases 4-5 pending):
- Recipe-picker UX + embedded `\`\`\`base` block insertion (Phase 4)
- Opt-in materialization command + sparse-pivot guard with `COUNT(*)` pre-execution estimate (Phase 5)

**Prerequisite**: Obsidian 1.10.0 or later (the public `registerBasesView` API). On older versions, the plugin loads but shows a Notice; everything else works.

---

## Pre-flight — reload after every rebuild

The test-vault ships with the [Hot Reload](https://github.com/pjeby/hot-reload) community plugin installed and Crosswalker registered for auto-reload (`.hotreload` marker file in the plugin directory). When the dev workflow rebuilds `main.js`, Hot Reload will pick it up automatically — no manual reload needed.

If Hot Reload isn't running (you disabled it, fresh vault, etc.), you MUST manually reload after every rebuild:

- Settings → Community plugins → toggle Crosswalker **off**, then **on**, OR
- Ctrl+R inside the dev console (Ctrl+Shift+I → Console → Ctrl+R)

Without a reload, Obsidian keeps the OLD plugin code in memory regardless of what's on disk. Bugs that have been fixed will still appear to be present.

---

## Pre-flight checks (automated)

- [x] `bun run test` → 201/201 pass (added 37 new for Phase 3: 31 pivot-grid + 6 reference-base-files)
- [x] `bun run build` → clean
- [x] `bun run check:fixtures-drift` → no drift

---

## Manual test scenarios

### Scenario 1: First-run .base file write

**Setup**: fresh test vault (or delete `_crosswalker/views/coverage-matrix.base` if it exists).

**Steps:**
1. Reload the plugin (or start Obsidian fresh)
2. Wait for `onLayoutReady` (a few seconds after vault opens)
3. Open `_crosswalker/views/coverage-matrix.base` — should exist
4. Open `_crosswalker/views/` folder — verify it was auto-created

**Expected**: file exists with the reference content (filters + formulas + 2 views: `crosswalker-pivot` + Bases-native `table` fallback).

### Scenario 2: Pivot view renders against SSSOM-imported data

**Prerequisite**: complete Phase 2 Scenario 1 (import the SSSOM fixture so `_crosswalker/mappings/csf-to-iso27001/` has 11 junction notes).

**Steps:**
1. Open `_crosswalker/views/coverage-matrix.base` in Obsidian (the `.base` file from Scenario 1)
2. The view picker should show `Coverage matrix` (the `crosswalker-pivot` custom view) AND `Mappings table` (Bases-native fallback)
3. Switch to `Coverage matrix`

**Expected:**
- 11 rows × 1 col grid (subject_id × object_id) — but ISO 27001 has 9 distinct objects so it'll be ~11 × 9 with mostly-empty cells
- Cells show `1` where a mapping exists, `—` (em-dash) where empty
- Footer shows `11 rows × 9 cols · 11 entries · range 1–1`

**If you don't see the custom view in the picker:**
- Settings → Core plugins → verify Bases is enabled
- Check Obsidian version is 1.10.0+
- Check dev console for Notice text (`Crosswalker: pivot view requires Obsidian 1.10.0...` or `Crosswalker: enable the Bases core plugin...`)

### Scenario 3: View options panel works

**Steps:**
1. With the Coverage matrix view active, open the right-rail view options
2. Should see 8 controls:
   - **Rows by** (property picker; default `subject_id`)
   - **Cols by** (property picker; default `object_id`)
   - **Cell aggregation** (dropdown: count / count_distinct / sum / avg / min / max / first / last)
   - **Cell value (for non-count ops)** (property picker)
   - **Empty cells** (dropdown: gap / blank / zero)
   - **Heatmap shading** (toggle)
   - **Row sort** (asc / desc / none)
   - **Col sort** (asc / desc / none)
3. Change **Empty cells** to `zero` → verify empty cells now show `0` instead of `—`
4. Change **Cell aggregation** to `count_distinct` → verify cell count is the same (each (subject, object) pair has 1 row)
5. Change **Rows by** to `predicate_id` and **Cols by** to `source_framework` → verify 5 rows (STRM predicates) × 1 col (`csf`)
6. Toggle **Heatmap shading** → verify cells get color shading proportional to value

### Scenario 4: Idempotent first-run write

**Steps:**
1. Edit `_crosswalker/views/coverage-matrix.base` — change one of the formulas or add a comment
2. Save the file
3. Reload the plugin (`Ctrl+R` in dev console, or disable + re-enable in settings)
4. Re-open `_crosswalker/views/coverage-matrix.base`

**Expected**: your edit is preserved. The plugin's first-run writer skips files that already exist (per Settled #3 — preserves user edits).

### Scenario 5: Bases-disabled fallback

**Steps:**
1. Settings → Core plugins → disable **Bases**
2. Reload Crosswalker plugin (disable + re-enable in Settings → Community plugins)
3. Watch for a Notice

**Expected**: a Notice appears: `Crosswalker: enable the Bases core plugin (Settings → Core plugins → Bases) to use the pivot view. Other features still work.`

The plugin still loads; everything else (import, queryCrosswalk, etc.) still works. Re-enable Bases to restore the pivot view.

### Scenario 6: Sparse-pivot soft warning

**Steps**: this is harder to trigger with the small fixture. Skip unless you have a large SSSOM dataset (>250K mappings).

**Expected when triggered**: a warning callout above the pivot table reading `Sparse pivot: NxM = X cells. Consider narrowing...`. Hard guard with `COUNT(*)` pre-estimate is Phase 5 work.

### Scenario 7: Pivot view deterministic across reloads

**Steps:**
1. Open the Coverage matrix view; note the cell counts
2. Reload Obsidian
3. Re-open the same `.base` file

**Expected**: identical pivot output. The view is pure-function over Bases entries; no hidden state.

---

## Edge cases worth checking

- [ ] Empty Bases filter (no entries match) → "No entries match the Bases filter" empty-state message
- [ ] Missing rowsBy or colsBy in view options → "Configure the pivot view: set ..." empty-state
- [ ] Cells with non-numeric values + numeric agg op (sum/avg) → returns null (filtered NaN)
- [ ] CSS adapts to dark mode + community themes (uses Obsidian theme variables)
- [ ] Mobile (Obsidian iOS/Android via Capacitor) → view renders but be mindful of horizontal-scroll on wide pivots

---

## Things that should explicitly NOT work yet (deferred to Phase 4-5)

- ❌ Recipe-picker modal that inserts an embedded `\`\`\`base` block from a recipe template (Phase 4)
- ❌ `Crosswalker: Materialize this recipe` command writing to `_crosswalker/audit/<recipe>/<timestamp>.md` (Phase 5)
- ❌ Sparse-pivot HARD guard (pre-execution `COUNT(*)` estimate) — soft warning only in Phase 3
- ❌ `crosswalkerHierarchy` second custom view (graduates to v0.1.7-v0.1.8 per Ch 30)
- ❌ `crosswalkerGraph` (Cytoscape.js) — v0.2

---

## Sign-off checklist

- [ ] Scenario 1: reference `.base` file created on first run in `_crosswalker/views/`
- [ ] Scenario 2: pivot view renders against SSSOM-imported junction notes
- [ ] Scenario 3: all 8 view options work; empty / cellOp / heatmap toggles change rendering
- [ ] Scenario 4: idempotent re-write preserves user edits
- [ ] Scenario 5: Bases-disabled fallback Notice appears with helpful text
- [ ] Scenario 7: deterministic reload — identical output

If all green: ready to start Phase 4 (recipe-picker UX).

---

## Files changed in Phase 3

| Change | Path |
|---|---|
| CREATED | `src/views/bases-api.ts` (registerBasesView wrapper; gated on Obsidian 1.10+) |
| CREATED | `src/views/pivot-grid.ts` (pure data-shaping helper; 31 unit tests) |
| CREATED | `src/views/crosswalker-pivot-view.ts` (Component subclass; DOM renderer) |
| CREATED | `src/views/reference-base-files.ts` (idempotent first-run writer; 6 unit tests) |
| CREATED | `templates/coverage-matrix.base` (source-of-truth reference template) |
| CREATED | `tests/pivot-grid.test.ts` (31 unit tests) |
| CREATED | `tests/reference-base-files.test.ts` (6 unit tests) |
| MODIFIED | `tests/e2e/crosswalker-pivot-view.spec.ts` (filled in pending tests with documentation) |
| MODIFIED | `src/main.ts` (registerCrosswalkerPivotView() + onLayoutReady writeReferenceBaseFiles call) |
| MODIFIED | `styles.css` (pivot grid styling) |
