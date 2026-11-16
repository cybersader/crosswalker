# Phase 4.5 manual test — frontmatter-driven query notes + `![[.base]]` embed

## Pre-flight

- [ ] Reload Crosswalker: Settings → Community plugins → toggle Crosswalker **off** then **on** (loads commit `cf9e83b`)
- [ ] Open `Test Query.md` (at vault root)
- [ ] Place cursor on the line after `(cursor here — ...)`

## Test 1 — CREATE flow

- [ ] Cmd/Ctrl+P → `Crosswalker: Insert query into note`
- [ ] Picker modal opens with 6 recipes
- [ ] Click **Configure** on **"NIST CSF → 800-53 coverage matrix"**
- [ ] (Optional) change `confidence_threshold` from `0.7` to `0.85`
- [ ] Click **Apply**
- [ ] Notice: `Created query: nist-csf-coverage-matrix`

**Verify in `Test Query.md`**:

- [ ] `crosswalker:` frontmatter block appears at top with `query_id`, `recipe`, `shape: pivot`, `params`, `view_file`, `generated_at`, `schema_version: 1`
- [ ] `![[_crosswalker/views/q-2026-05-16-<8hex>.base]]` embed appears at cursor
- [ ] Bases renders a pivot table inline below the embed (may be empty if you haven't run the SSSOM import; that's fine — verify the rendering harness is hooked up, not the data)

**Verify on disk** (Obsidian file browser, left sidebar):

- [ ] `_crosswalker/views/q-2026-05-16-<8hex>.base` exists
- [ ] Opening that file shows generated Bases YAML with comment header pointing back to `Test Query.md`

## Test 2 — UPDATE flow

- [ ] Cursor still in `Test Query.md`. Cmd/Ctrl+P → `Crosswalker: Insert query into note` again
- [ ] Picker opens — **the params from Test 1 are pre-filled** (UPDATE mode)
- [ ] Change `confidence_threshold` to `0.5`. Click Apply
- [ ] Notice: `Updated query: nist-csf-coverage-matrix`

**Verify**:

- [ ] Frontmatter `params.confidence_threshold` is now `0.5`
- [ ] `query_id` and `view_file` are **unchanged** (stable IDs)
- [ ] The `.base` file's filter line updated to `'confidence >= 0.5'`
- [ ] No duplicate `![[...]]` embed in the note (still exactly one)

## Test 3 — Hand-edit + refresh

- [ ] Manually edit the frontmatter `params.confidence_threshold` from `0.5` to `0.9` (just type in the YAML)
- [ ] Cmd/Ctrl+P → `Crosswalker: Refresh query views`
- [ ] Notice: `Refreshed 1 view`

**Verify**:

- [ ] Open the `.base` file at `_crosswalker/views/q-2026-05-16-<8hex>.base`
- [ ] Filter line now reads `'confidence >= 0.9'`

## Test 4 — Idempotent re-refresh

- [ ] Cmd/Ctrl+P → `Crosswalker: Refresh query views` again (without changing anything)
- [ ] Notice: `Refreshed 0 views; 1 up-to-date`

That's it. If anything's wrong, drop the failure here.
