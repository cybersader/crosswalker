# Hands-on tour — test every surface (2026-07-11 state)

The master checklist for a full manual pass over the plugin + corpus. Each
section is independent; do them in order for the full story, or Ctrl+F the
surface you care about. Automated coverage is noted per section so you know
what's already machine-verified (800+ unit tests + 25+ visual/E2E specs) vs
what only your hands can judge.

**2026-07-11 additions** (the [shape-workbench side-arc](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-07-11-shape-workbench-architecture-synthesis/), tracked as [v0.1.6 Phase 7](https://cybersader.github.io/crosswalker/reference/roadmap/milestones/v0-1-6-bases-query-layer/) — full delivery detail in `CHANGELOG.md` `[Unreleased]`): §0.5 workspace tab, §1 vault file picker, §1a recognized-source fast path, §1.7 shape workbench + review screen (Connections card, the numeric plan) + §1.7 folder-note-as-default placement, §1.9 draft resume, §6.5 connected-output checks (children lists, facet hubs, edge stats, per-import home/hub notes, Waypoint opt-in — includes the known §7o gap). §8 settings tour rewritten for the new settings hub.

> **Older per-feature guides** (deeper steps for one surface):
> `TEST_CROSSWALK_PIVOT.md` (corpus regen + pivot), `TEST_PHASE_4_5.md` (query
> notes), `TEST_PHASE1_QUERY_SCHEMA.md`, `TEST_PHASE2_SSSOM_IMPORT.md`,
> `TEST_PHASE3_PIVOT_VIEW.md`.

## 0. Setup

- [ ] **Lazy path (double-click, no terminal):** `dev.bat` at the repo root starts the watch build via WSL; `serve.bat` opens the full interactive menu via Windows bun. Both **self-heal** the WSL↔Windows `node_modules` mismatch (the orchestrator detects the wrong-platform esbuild/rollup binary and reinstalls) — so the first launch after switching sides pauses ~30–60s for a reinstall, then runs. That ping-pong is inherent to sharing the repo across both OSes
- [ ] Terminal equivalent: `bun run build` (or `bun run dev` for watch) — outputs to `test-vault/.obsidian/plugins/crosswalker/`
- [ ] Open `test-vault/` in Obsidian; enable **Crosswalker** + the **Bases** core plugin
- [ ] First open after corpus regen: wait for the "Indexing vault..." toast to finish (~10k notes) — pivots render "No data" pre-index
- [ ] Regenerate the local licensed corpus: run every block in `TEST_CROSSWALK_PIVOT.md` § 1 + § 5 (concepts, hierarchy back-fills, OLIR edges, SCF melt). Expect: **~7.4k concept notes + ~7.9k edge notes**, all gitignored
- [ ] **Reset between test runs** — after doing ad-hoc imports, clear them for a clean slate: **in Obsidian** run the command **"Crosswalker: Reset imported notes (dev)"** (groups generated notes by folder, protects the corpus, per-folder + delete-all buttons), or **outside Obsidian** double-click `reset.bat` (preview then keypress-to-delete) / run `bun run reset` (dry-run) / `bun run reset -- --yes` (delete). It removes only Crosswalker-generated notes **outside** the protected corpus — `Frameworks/_licensed/`, `Frameworks/NIST-mini/`, `_crosswalker/`, `GRC analysis/`, and `PROVENANCE.md` are never touched. Hand-written notes are never touched

## 0.5 Crosswalker workspace tab (NEW 2026-07-11)

*Automated: `tests/workspace-view-helpers.test.ts` (pure helper). Manual value:
the view actually opens, hosts the real flow, and counts stay live.*

The whole import experience (`ImportFlow`) is host-agnostic — it renders into
either this view or the settings-launched modal via the same
`ImportFlowHost` interface. This tab is the primary, wide surface; the modal
is a thin back-compat host of the identical flow.

- [ ] Click the **Crosswalker ribbon icon** (left sidebar, network glyph) — a new workspace tab opens (an `ItemView`, not a modal), titled "Crosswalker"
- [ ] Command palette → **Crosswalker: Open workspace** does the same; re-running it re-uses the existing leaf instead of opening a duplicate
- [ ] **Home screen**: a launchpad (Import structured data · Manage saved configs · Resume a draft, the last only when draft auto-save is on) above an **Installed ontologies** list derived from your output folder's subfolders
- [ ] Empty vault: the installed-ontologies section shows "Nothing imported yet. Run 'Import structured data' to bring in your first framework."
- [ ] **Generated-only list** (2026-07-11): the list only shows folders Crosswalker actually generated (producer-frontmatter gated) — hand-created folders under the output path never appear as a false "installed" row, and a just-finished import appears immediately without a metadata-cache race
- [ ] With **per-import root folders** (§6.5), each row corresponds to one import's own root, not one row per top-level technique/category folder inside it
- [ ] Click **Import structured data** — the flow (file select → recognized card or detection → workbench/classic Step 2 → review screen → generate) renders **in the tab itself**, wide, not in a modal
- [ ] After generating, the flow calls "done" and the tab returns to the home screen with **fresh counts** — no manual refresh needed
- [ ] Each installed-ontology row shows a live `N notes · N links` count and, when the folder name matches a bundled recipe, an **"Import again"** button (title: "Import again using the [recipe] recipe") that jumps straight into the flow preset to that recipe — skips fingerprint detection entirely
- [ ] Import via the **modal** instead (command palette → **Crosswalker: Import structured data**, or the settings launchpad) — confirm it is the same flow/behavior, just windowed differently

## 1. Import wizard — CSV (the guided happy path)

*Automated: unit tests + streaming + full-loop E2E. Manual value: does it feel
magical? Reload the plugin first (toggle off/on) to pick up the 2026-06-12 UX.*

- [ ] Command palette → **Crosswalker: Import structured data**
- [ ] **Step 1 leads with a fuzzy vault picker** (NEW 2026-07-11) — a search box lists every importable CSV/XLSX/JSON file already in the vault, even ones Obsidian's file explorer hides (no "detect all file extensions" setting required); an OS file dialog remains available for files outside the vault
- [ ] Pick `tools/fixtures/synthetic/nist-mini.csv` via the OS file dialog (it's outside `test-vault/`, so it won't appear in the vault picker). **All file paths in this guide are repo-relative, not vault-relative** — browse up out of `test-vault/` into the repo folder; Obsidian's sidebar will never show `tools/` or `Frameworks/`
- [ ] To exercise the vault picker itself, copy any of `test-vault/Crosswalker Test Data/*.csv` into the vault first, then start a new import and confirm it appears in the fuzzy search results
- [ ] **Step 2 arrives pre-configured (smart defaults)** — you should see ✨ badges: `name` → **Note title**, `family` → **Hierarchy level**, `description` → **Body content**; everything else stays frontmatter. You configure *nothing* for the happy path — just review
- [ ] The intro line answers the standard questions up front: all columns imported as frontmatter by default, nothing dropped unless Skip
- [ ] The **"In the vault" column** live-previews each role (`📁 AC/`, `📄 Policy and Procedures.md`, `key: value`, `[[link]]`) — change a dropdown and watch the preview update in place
- [ ] **Filter box** narrows by name/key/sample; on wide sources (>25 cols) the all-default tail collapses behind "Show all columns" with special-role columns pinned on top — the SCF workbook (369 columns) shows the full effect
- [ ] **Step 3 is now a visual preview**: stat cards (📄 notes · 📁 folders · 🔗 links), a real folder tree built from your data (📁 AC/ → 📄 sample notes), and a mock note card (filename + properties block + body snippet). "Raw markdown" sits collapsed underneath
- [ ] Step 4 generate → notes land at the output path, nested under family folders; re-run with overwrite mode `skip` and confirm nothing clobbers
- [ ] **Config sharing (already built, easy to miss):** the saved-config JSON includes ALL column mappings — config browser → per-config **Export** + top-level **Import**. That JSON is the shareable unit for "here's how to import this framework's spreadsheet"
- [ ] **Suggestions yield correctly**: apply a saved config → ✨ suggestions are replaced by the config's ⚙️ mappings (config always wins)

## 1a. Recognized-source fast path (NEW 2026-07-11)

*Automated: `tests/recipe-registry.test.ts` (149 tests) + `tests/e2e/visual-workbench.spec.ts`.
Manual value: does the trust-forward card actually feel calmer than detection?*

Six of the corpus sources match a bundled, vetted recipe closely enough
(≥75% of the recipe's column signature) to skip the ordinary detection flow.
`tools/fixtures/synthetic/nist-mini.csv` from §1 is a synthetic fixture and
deliberately does **not** match — confirms unrecognized sources stay quiet on
the classic flow.

- [ ] Re-select `Frameworks/CIS_Controls_Version_8.1.2___March_2025.xlsx` (sheet `Controls v8.1.2`, header row `0`, from §2) — instead of landing straight on Step 2, a **"Recognized source"** card appears: badge-check icon, `CIS Controls v8.1.2` title, **Built-in** + **Recommended** badges, a one-line description, a row/shape/destination summary (`171 rows to 171 notes`, shape list, `into <output path>`)
- [ ] Same for `Frameworks/cprt_CSF_2_0_0_06-01-2026.json` (§3 iterator/filter) — recognizes as NIST CSF 2.0 (CPRT export)
- [ ] Three actions on the card: **Import with this recipe** (primary, `mod-cta`) jumps straight to the review screen; **Customize** opens the workbench pre-loaded from the recipe via `fromRecipe` (no re-detection — the round-trip law); **Start from scratch** dismisses the card for this session and falls back to ordinary detection
- [ ] Click **Import with this recipe** → review screen's provenance line reads **Built-in** (unedited)
- [ ] Click **Customize** instead, change one mapping in the workbench, then reach the review screen → provenance downgrades honestly to **Custom (based on `<recipe>`)**
- [ ] From the workspace tab's Installed ontologies list (§0.5), click **Import again** on a previously-imported recognized source — jumps directly into the flow preset to that recipe, skipping fingerprint detection

## 1.7 Shape workbench (beta) — live mapping screen + review screen (NEW 2026-07-05 → 2026-07-11)

*Automated: +72 unit tests (detection, mapping, view-model, workbench recipe
assembly) + `tests/e2e/visual-workbench.spec.ts` (four-zone screenshots, dark
theme, a no-horizontal-overflow invariant across seven pane widths — NEW
2026-07-11). Manual value: does editing feel live, and does the review screen
actually earn trust before Generate?*

Off by default — **Settings → Import behavior → Live mapping workbench**
(§8). Turn it on before this section; it replaces Step 2's column table with
one live three-zone screen for every source (CSV/XLSX/JSON alike).

- [ ] Toggle the setting on, reload the plugin, then re-run §1's CSV happy path (or continue from §1a's "Customize")
- [ ] **Source rail** (left): the file's columns with **detection badges** (e.g. packed-id hierarchy with a depth histogram, level-per-column chain, facet, parent link, long-text body candidate, crosswalk-shaped file) and evidence cards explaining *why* each badge fired
- [ ] **Mapping canvas** (center): a **preset dropdown** at the top (provenance badges: Built-in / Yours / Custom (based on X); the detection's own default is tagged **Recommended**, never silently preselected) → per-detection **mapping cards** → **six shape toggles** (Folders · File names · Tags · Headings · Links · Properties) with a combined "your mix on one row" preview → an editable per-level **matrix** (merge/split levels, naming incl. `lookup`, per-level missing-value policy, a grouped two-stage "add destination" menu)
- [ ] **Live vault preview rail** (right): a real folder tree, one fully-rendered sample note, and a **deviation banner** — all three re-render on every change (debounced), driven by the actual `render()` pipeline, not a mock
- [ ] Open the matrix directly (skip the cards) — confirm it shows **exactly** what the preset + cards already wrote (the view-coherence law: every view reads/writes the same `StructureMapping`, no hidden state)
- [ ] Pick a source with a ragged id (e.g. a mix of parent and child ids at different depths) — confirm the matrix's **tail rule** / variadic option nests rows to their own natural depth instead of flattening them all to one level
- [ ] **Connections card** (NEW 2026-07-11): a dedicated card in the mapping canvas surfaces the enrichment block directly — a **link parents and children** toggle, a **hub notes** control (with an honest "unlock" hint when a prerequisite mapping is missing), and a **sibling vs. folder-note placement chooser** showing side-by-side mini folder-trees for each option
- [ ] **Folder-note is the default placement** (NEW 2026-07-11, flipped from sibling) — a fresh import with no saved config or draft defaults the placement chooser to **folder-note** (`X/X.md`, the parent lives inside its own folder) rather than sibling (`X.md` beside `X/`); if the vault has a folder-notes-style plugin enabled (folder-notes, Waypoint, fuzzy folder note IDs), the reason line under the chooser names it — but folder-note is now the default either way, plugin or not
- [ ] Click into the placement chooser and switch options — confirm the **connected pair highlights together** in purple (the file and its folder, so it's obvious which mini-tree you're choosing) rather than only the clicked control
- [ ] Proceed to the **review screen** (old Step 4, now a true review not a pushed-down workbench): destination block (breadcrumb path, inline edit, **"Show in file explorer"** without closing the modal/tab), the shape-map recap (e.g. `technique_id → folders · 823 notes`), **the numeric plan** (NEW 2026-07-11 — exact note and hub counts computed from the whole file, plus honest estimates for folders and links, not guesses), stat chips including a **link-count guardrail** (a link-dead import announces itself before you can generate), the deviation banner, and the provenance line
- [ ] Generate → confirm output matches the preview exactly (byte-for-byte on re-run with the same mapping)
- [ ] Toggle the setting back off, reload — confirm §1's classic column table still works unchanged (legacy path untouched)
- [ ] **Layout invariant** (NEW 2026-07-11): open the workbench in a split pane / narrow sidebar and resize across several widths — confirm no horizontal scrollbar appears at any width (the workbench sizes itself by its own pane, not the window)

## 1.9 Draft resume (workbench-aware) (NEW 2026-07-11)

*Automated: `tests/workbench-recipe.test.ts` (86 tests). Manual value: does
resuming actually restore the live mapping, not just the file selection?*

- [ ] With **Live mapping workbench** on (§1.7) and **Auto-save import drafts** on (default, §8 Drafts), start an import, make a few edits in the matrix, then close the modal (or switch away from the workspace tab) without generating
- [ ] Reopen via **Resume a draft** (settings launchpad, workspace-tab launchpad, or the wizard's Step 1 drafts list) — the source file re-reads and re-parses automatically (no forced re-selection) and the **workbench mapping is restored**, not reset to smart defaults
- [ ] Known gap (unchanged from 2026-06-12): a draft started via the **XLSX or JSON** iterator/sheet-picker paths only persists CSV-era fields — the sheet choice / iterator path resets on resume. CSV-sourced workbench drafts are the fully-covered case

## 2. Import wizard — XLSX (NEW 2026-06-12)

*Automated: `visual-wizard-formats.spec.ts` drives parse AND full generation.
Manual value: sheet picker UX, real corpus files.*

- [ ] Wizard → select `Frameworks/CIS_Controls_Version_8.1.2___March_2025.xlsx`
- [ ] **Sheet dropdown appears** listing all 5 sheets → pick `Controls v8.1.2`
- [ ] Leave header row at `0` → Next
- [ ] Step 2: expect **171 rows**, columns `CIS Control / CIS Safeguard / Asset Class / Security Function / Title / Description / IG1 / IG2 / IG3`
- [ ] Smart defaults here: `Title` → Note title ✨, `Security Function` → Hierarchy ✨ (5 unique values), `Description` → Body ✨
- [ ] **The 4.10 check** (the trap this build cures): step 2 sample values for `CIS Safeguard` must show `4.10` as text — never `4.1` twice
- [ ] Try a workbook with banner rows (`Frameworks/csf2.xlsx`, sheet `CSF 2.0`, header row `1`) — columns resolve only when header row is right
- [ ] Wrong sheet name path: can't happen (dropdown), but header row `5` on csf2 should produce junk columns — confirm the failure is visible, not silent

## 3. Import wizard — JSON (NEW 2026-06-12)

*Automated: parse + full generation E2E. Manual value: iterator ergonomics,
error quality.*

- [ ] Wizard → select `Frameworks/cprt_CSF_2_0_0_06-01-2026.json`
- [ ] **Iterator path** input appears → enter `$.response.elements.elements[*]`
- [ ] **Row filter** → `element_type=subcategory` → Next
- [ ] Step 2: expect **185 rows** (and the parse toast reports how many were filtered out)
- [ ] Smart defaults here (2026-06-13): `element_identifier` → **Folder tree (from id) ✨** — NOT flat. The wizard detects the `.`/`-` delimiters and the "In the vault" preview shows `📁 DE/DE.AE/DE.AE-02.md`; `text` → Body ✨. Generate → notes nest by function/category automatically (the §3.5 showcase, now point-and-click)
- [ ] To see it flat instead, change that column's role from "Folder tree (from id)" to "Note title" 
- [ ] **JSON record picker (UX iteration 2):** instead of typing `$.…` paths, Step 1 shows "Where are your records?" with the nested lists as **selectable cards** — radio dot, bold list name + path breadcrumb, a purple record-count badge, and field-name chips. The primary-record list is pre-selected even when a relationship/mapping list is larger (CPRT: `elements` selected, not the bigger `relationships`). Path syntax is under "Advanced." Root-array files show one "this whole file is your list" card
- [ ] **If it looks like an unstyled wall of text:** the CSS didn't deploy — reload the plugin; if still plain, the watch predates the styles.css-copy fix, so re-run `dev.bat`/`serve.bat` (or `cp styles.css test-vault/.obsidian/plugins/crosswalker/`)
- [ ] **Loud failures:** a generation that creates 0 notes (or has row errors) now raises a warning notice with the first cause — never a silent zero
- [ ] **Error-quality check**: re-select the file, enter iterator `$.objects[*]` → the error must **list the keys that DO exist** (`response`, …), not just "not found"
- [ ] Empty iterator on a root-array file: make a tiny `[{"a":1}]` .json and confirm it parses with no iterator
- [ ] Big-file feel: `Frameworks/enterprise-attack.json` (~25k objects) with `$.objects[*]` + `type=attack-pattern,revoked!=true,x_mitre_deprecated!=true` → 697 rows; note the parse time feels acceptable

## 3.5 ⭐ The showcase — taxonomy id → vault structure (id-driven hierarchy)

*This is the "magic": the structure is **parsed out of the id itself**, not from
separate columns. A CSF subcategory id like `DE.AE-02` decomposes into
`DE` (function) → `DE.AE` (category) → `DE.AE-02` (subcategory), and the recipe
turns that into a folder tree.*

The recipe `recipes/import/nist-csf-2-cprt-hierarchical.json` uses the engine's
template filters on the **single id field**:

```
function folder = {element_identifier|split(.,0)}   → DE
category folder = {element_identifier|split(-,0)}   → DE.AE
subcategory file = {element_identifier}.md          → DE.AE-02.md
```

Regenerate + open it:

```bash
bun tools/generate-fixtures.ts   --source "Frameworks/cprt_CSF_2_0_0_06-01-2026.json"   --iterator '$.response.elements.elements[*]' --where 'element_type=subcategory'   --recipe recipes/import/nist-csf-2-cprt-hierarchical.json --id '{element_identifier}'   --target "test-vault/Frameworks/_demo/NIST-CSF-2-tree" --clean
```

- [ ] Open `Frameworks/_demo/NIST-CSF-2-tree/` in Obsidian → **6 function folders → 34 category folders → 185 subcategory notes**, e.g. `DE/DE.AE/DE.AE-02.md`
- [ ] Open a leaf note → frontmatter carries `function: DE`, `category: DE.AE`, `level: subcategory`, and a proper `curie: "nist-csf-2:DE.AE-02"` (the recipe sets the ontology prefix — no more `unknown:`)
- [ ] Contrast with the flat wizard run (§3): same 185 concepts, but here the **id parsing builds the tree**. This is what [hierarchy primitives](https://cybersader.github.io/crosswalker/concepts/hierarchy-primitives/) + the [5-mechanism recipe grammar](https://cybersader.github.io/crosswalker/concepts/etl-and-import/) deliver

> **Update 2026-06-13 — now in the wizard too:** the **"Folder tree (from id)"** column role does exactly this id-parsing point-and-click (smart-defaults auto-pick it for structured ids), so §3's wizard run nests by default. This recipe remains the headless/automation equivalent.

## 4. SSSOM import modal

*Automated: unit + e2e specs. Manual value: the one-click fixture path.*

- [ ] Command palette → **Crosswalker: Import SSSOM crosswalk**
- [ ] Import the bundled fixture → 11 junction notes under `_crosswalker/mappings/csf-to-iso27001/`
- [ ] Spot-check one note: `predicate_id` direction sane (broadMatch → `is_narrower_than` — the 2026-06-12 direction fix)

## 4.5 Export commands (v0.1.7 portability)

*Measured 2026-09-06: lint and production build passed; 18 focused tests passed; the full unit suite passed 2,979 tests with 2 skipped; and both targeted isolated-vault real-Obsidian tests passed. The runtime walkthrough invoked the exact manifest-prefixed command, used the real picker for a nested folder and Obsidian's actual `/` root, verified deterministic typed output and byte preservation, cancelled replacement with Escape, and completed confirmed replacement. Root runtime evidence applies only to this typed command, not to the older CSV or crosswalk exports. All four captured screenshots were reviewed; screenshot 03 caught a notice mid-animation, and screenshot 04 confirmed its fully visible settled position.*

*Scoped root-export closeout 2026-09-06: the original source-identical verification wave passed 27 focused tests, the full unit suite with 2,988 passed and 2 skipped, lint, and production build. Those checks were not rerun after the later test-only fixture simplification. The final targeted real-Obsidian run passed both export specs, all four command scenarios, and teardown. Both older commands selected the exact friendly `/ (vault root)` choice on Obsidian's actual `/` root, produced the corrected filenames and expected unique rows, and preserved source and hidden-style export bytes. This remains scoped export coverage, not a full-E2E or quarantine-clearance claim.*

- [x] Command palette → **Crosswalker: Import and export: export folder as a typed mapping table** → the real folder picker opens
- [x] Pick a nested folder containing canonical `kind: crosswalk-edge` notes → a sibling `<folder>.export.typed-mappings.tsv` appears; picking the vault root instead uses `vault.export.typed-mappings.tsv`
- [x] Confirm the typed table has the expected ordered mapping columns and deterministic rows, while source-note bytes and the distinct `<folder>.export.tsv` crosswalk mapping file remain unchanged
- [x] Run the command again → replacement confirmation opens; press **Escape** or close it and confirm the prior output bytes remain unchanged
- [x] Run it a third time, choose **Replace file**, and confirm the unchanged source produces the same destination and bytes
- [ ] Pick a folder with no exportable mappings (including one with skipped notes) → no file is created or replaced; skipped-note counts use correct singular/plural wording
- [ ] Put a folder or other non-file item at the destination → the command refuses it and names the rename/choose-another-folder action
- [x] Confirm `vault.export.csv` does not already exist through the vault adapter; run **Crosswalker: Import and export: export folder as CSV**, choose **/ (vault root)**, and verify the unique synthetic row lands in `vault.export.csv` while source bytes and any pre-existing hidden-style `.export.csv` / `.export.tsv` bytes remain unchanged
- [x] Confirm `vault.export.tsv` does not already exist through the vault adapter; run **Crosswalker: Import and export: export folder as a crosswalk mapping file**, choose **/ (vault root)**, and verify the unique synthetic mapping lands in `vault.export.tsv` while source bytes and both hidden-style dotfiles remain unchanged

**Sprint handoff:** this slice exposes the existing typed mapping serializer only. Persistent reusable-configuration storage/UI, the separate source/run binding, and full-source save → reopen → exact-replay proofs remain unresolved v0.1.7 work; do not read this command as closing those decisions or the milestone.

## 5. Query commands (v0.1.6 Phases 4.5–4.7 — manual smokes still pending)

*These have pending "⏸ manual smoke" notes on the milestone page — your pass
closes them. Deep steps: `TEST_PHASE_4_5.md`.*

- [ ] **Crosswalker: Insert query into note** → picker → Configure → Apply → `_crosswalker/queries/SLUG/` folder created with `index.md` + `view.base`, `![[SLUG/view.base]]` embedded at cursor
- [ ] **Crosswalker: Embed existing query into note** → lightweight picker, embeds without re-creating
- [ ] **Crosswalker: Browse my queries** → list with Open / Embed here / Delete per row
- [ ] **Crosswalker: Refresh query views** → regenerates `.base` files from frontmatter
- [ ] **Crosswalker: Materialize this query (snapshot)** → writes `SLUG/materialized/result.json`
- [ ] **Crosswalker: Migrate queries to folder layout** → no-op message when nothing to migrate (one-shot 4.6 migration)
- [ ] Slug collision: create the same query twice → refuse-and-prompt behavior

## 6. GRC analysis suite (the output layer)

*Automated: `visual-grc-analysis.spec.ts` (7 screenshots). Manual value:
interactivity the screenshots can't show.*

Open each, in `GRC analysis/`:

- [ ] `Crosswalk Coverage/1` — CSF×800-53 heatmap: shading visible, not a flat grid
- [ ] `Crosswalk Coverage/4` — CSF×CRI triangle heatmap (7×7, GV×GV darkest at 44)
- [ ] `Crosswalk Coverage/5` — **AC-2 concept 360**: every row's From/To cells are **clickable internal links** (not dead `nist-800-53:AC-2↗` external arrows) → click through to the control note and back
- [ ] `Framework adoption/1` — CIS IG views: IG1=56, IG2-additions=74, IG3-only=23 (check the view tab counts)
- [ ] `Framework adoption/2` — SCF domain browser: AI & Autonomous Technologies is the biggest group (156)
- [ ] `Framework adoption/3` — **SCF hub matrix**: rows=SCF families, cols=7 frameworks, ~5.6k entries; click a hot cell (GOV×iso-27001=125) and confirm the underlying edge notes open
- [ ] Both index notes (`Control lens.md`, `Framework adoption.md`) render embedded views inline in reading mode
- [ ] **Pivot interactivity**: in any heatmap, switch the view dropdown to the table view and back; resize the pane; close/reopen the tab — no errors, state survives

## 6.5 Connected-output checks — children lists, facet hubs, hub/home notes, edge stats (NEW 2026-07-11)

*Automated: `tests/enrich.test.ts` + `tests/enrichment-reimport.test.ts` (Pass
1.5 unit coverage) + `tests/e2e/visual-graph.spec.ts` (the "connectedness
money shot" — a clean graph of a single import, not the accumulated
`Frameworks/` backlog). Manual value: does a real vault actually come out
connected, and does the known gap below still reproduce?*

Pass 1.5 batch enrichment (`src/generation/enrich.ts`) runs after every row
renders — but **only when the effective recipe declares `target.enrichment`**
(`generation-engine.ts`: `enrichmentEnabled = !!recipe.target.enrichment`).
That's true for the **shape workbench** path (its assembled recipe carries
the chosen preset's enrichment block) and the **native recipe / headless
harness** path (the recipe file declares it directly) — but the **classic
Step-2 column-table wizard path** (Live mapping workbench **off**) goes
through `legacyConfigToRecipe`, which never sets `target.enrichment` at all.
So: **with the workbench off, no import gets children lists, facet hubs, or
an edge count — not "sometimes," always.** This is a sharper, code-confirmed
version of what CHANGELOG.md's "applies uniformly to every import path" line
claims; verify it yourself rather than trusting that line.

- [ ] With **Live mapping workbench ON** (§1.7), import a source with a clear parent/child id relationship (e.g. `Frameworks/enterprise-attack.json` from §3) using the default `browsable-framework` preset (keeps enrichment on — `single-reference-file` deliberately turns it off)
- [ ] Open a **parent note** (e.g. a technique with a sub-technique) — frontmatter carries a managed **`children`** array, wikilinks, **sorted by curie**
- [ ] Open a note with a **multi-value facet column** (e.g. a technique with 2 tactics) — confirm a **facet hub note** exists for each tactic value with ≥2 members: `kind: facet` frontmatter, a managed **`members`** list, and an H1 body
- [ ] Add prose below the H1 in a facet hub note, then re-import the same source — confirm your prose **survives** (only the H1 + members list are managed) and `children`/`members` union-merge rather than clobber
- [ ] Check `GenerationResult.edgeCount` (workbench review screen's stat chips, §1.7, or the debug log's `generation` category) — should be > 0 and roughly `parent links + children entries + member entries`
- [ ] **Every import gets a home** (NEW 2026-07-11): the import's own root folder gets a hub note named after the folder — open it and confirm it reads as the framework's "home" note (managed **Contents** section listing the folder's direct children as wikilinks, sorted by curie)
- [ ] **Per-import root folders** (NEW 2026-07-11): re-run the import against a different source and confirm each import nests under its own root folder inside the output path (e.g. `Frameworks/<source>/...`) instead of flattening into a shared root — the workspace tab's Installed ontologies list (§0.5) should show one row per import, not one row per top-level technique folder
- [ ] **Hierarchy hub notes at every level** (NEW 2026-07-11, default on): open a mid-tree folder note (not the root, not a leaf) — confirm it also carries a managed **Contents** section listing its direct children; for a folder with no concept note of its own (a pure structural grouping folder), confirm a synthetic hub note (`kind: hub`) was generated at `<folder>/<folder>.md`
- [ ] Add prose below a hub note's Contents section, then re-import the same source — confirm your prose **survives** (only the Contents section is managed) and the section itself regenerates instead of duplicating
- [ ] **Waypoint opt-in** (NEW 2026-07-11, only visible with a Waypoint-style plugin enabled): with Waypoint installed and enabled, toggle the Waypoint marker option in the Connections card (§1.7), generate, and confirm generated folder-note/hub notes carry a `%% Waypoint %%` trigger comment — re-import and confirm it's never duplicated or stripped
- [ ] **Confirm the classic-path gap above**: with **Live mapping workbench OFF**, run the same source through §1's happy path → confirm parent notes get **no** `children` field and **no** facet hub notes materialize, regardless of preset. If you see enrichment fire on the classic path, that's a change worth logging (it would mean the shim gained enrichment wiring)
- [ ] **Known open gap (§7o, filed 2026-07-11, unresolved as of this writing):** separately from the classic-path gap above, `tests/e2e/visual-graph.spec.ts` found a run where facet hub notes did **not** materialize (`hubCount: 0`) even **on the workbench path** with the default preset and no manual customization — the spec logs this as a non-fatal "FINDING" (not a hard test failure) so the graph screenshot still captures whatever state resulted. If you hit `hubCount: 0` **with the workbench on**, that's this bug — report exactly what you touched (or didn't) before Generate, since the repro conditions aren't fully pinned down yet

## 7. Edge notes + graph

- [ ] Open any note in `_crosswalker/mappings/nist-csf-to-800-53/` — frontmatter has `subject_note`/`object_note` as live wikilinks AND the body line is linked
- [ ] Click `object_note` → lands on the 800-53 control; its **backlinks pane** shows the edge notes pointing at it
- [ ] Local graph on a control note: edges visible as connections
- [ ] Known-dangling links (deliberate, not bugs): `IA-13` (r5.1.1, newer than our source), `PT`/`CP`/`IR` family-level, CRI-extension ids (`EX`, `GV.AU-*`) — these render as unresolved (creates-on-click) by design

## 8. Settings tour (rewritten 2026-07-11 for the settings hub)

*Automated: `tests/e2e/visual-settings.spec.ts`. Manual value: does the hub
actually feel navigable, and do the live previews track your edits?*

Settings → Crosswalker no longer opens on a flat field list — it opens on a
**hub**: a launchpad, then a grid of section cards.

- [ ] **Launchpad** at the top: **Import structured data** (opens the wizard), **Manage saved configs** (opens the config browser), and — only when draft auto-save is on — **Resume a draft**
- [ ] **Section cards** below: Output · Naming · Cell values · Links between notes · Import behavior · Suggestions · Drafts · Advanced (collapsed) · Diagnostics · Saved configurations — each card shows a one-line glimpse of its current values (e.g. Naming shows `Snake case keys, flat`)
- [ ] Click any card → opens that section's page with a **← All sections** back button; confirm sentence-case headings and no plugin name in headings (lint requirement, not just style)
- [ ] Change a value with a **live preview** underneath it (Output's folder tree, Naming's sample property/frontmatter, Cell values' sample frontmatter, Links' sample frontmatter, Drafts'/Advanced's path chips) — confirm the preview updates **immediately**, without leaving the page
- [ ] **Output** → change the default output folder (autocompletes against real vault folders) → the workspace tab's Installed ontologies list (§0.5) and the wizard's Step 4/review-screen default both follow it
- [ ] **Import behavior** → toggle **Live mapping workbench** on/off → confirm §1.7's workbench vs. §1's classic table switches accordingly on the next import
- [ ] **Diagnostics** → toggle **Write a debug log** on → `crosswalker-debug.log` appears in vault root; events carry `trace_id` (generate something to see a trace); expand **Log categories** and toggle one off, confirm its events stop appearing
- [ ] **Advanced** (collapsed by default) → confirm **Fast query index** and **Query index file** are here, not in a separate "Debug" section (renamed/relocated from earlier releases)
- [ ] Confirm **no "Custom transforms" setting appears anywhere** — it was vestigial and removed 2026-07-11 (see the [settings reference](https://cybersader.github.io/crosswalker/reference/settings/) for the full current field list)

## 9. Known caveats (don't file these as bugs)

| Caveat | Why |
|---|---|
| Bases grouped tables can't collapse groups | native Bases 1.12.7 limitation; our pivot is the additive answer |
| Bases can't rank groups by aggregate count | precompute or external chart; documented in Control lens findings |
| Pivot shows "No data" right after vault open | indexing race; wait for the toast, then re-open the view |
| SCF→ISO/SOC2/PCI edges have no object wikilinks | by design — STRM proxy carries ids only, we hold no notes for those frameworks |
| All SCF melt edges are `intersects_with` | flat mapping columns carry no relationship type (SCF's STRM detail = 185 PDFs, below the input floor) |
| CRI is financial-sector scoped | never treat CRI-derived views as general-purpose |
| Wizard JSON/XLSX state isn't draft-persisted | iterator/sheet choices reset if you close mid-flow (draft persists CSV-era fields only) — known small gap |
| Facet hub notes sometimes don't materialize (`hubCount: 0`) | open bug, §7o (2026-07-11), see §6.5 — not fully pinned down yet, report the path you took |
| Live mapping workbench is off by default | it's still labeled beta — turn it on in Settings → Import behavior before §1.7 |
| Workbench-driven wizard state resets on draft resume for XLSX/JSON | same underlying gap as the JSON/XLSX draft caveat above — CSV-sourced drafts are the fully-covered case (§1.9) |

## 10. Report back

- Screenshot + `crosswalker-debug.log` lines (filter `jq 'select(.trace_id == "<id>")'`) for anything that errors
- The UI-parity audit (`zz-log/2026-06-12-ui-parity-audit`, + its 2026-07-11 addendum) lists the *known* missing UI surfaces (crosswalk-extraction UI, recipe editor residual gap, enrichment-knobs-are-recipe-only, diff UI, share buttons) — gaps beyond that list are findings
