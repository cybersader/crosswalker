# Changelog

All notable changes to Crosswalker will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — v0.1 implementation in progress (2026-05-04 → present)

The 0.1 design phase concluded 2026-05-04 and implementation began the same day. As of 2026-07-21, milestones v0.1.1 through v0.1.5 are ✅ shipped; v0.1.6 has delivered its Bases/query, SSSOM, primitives, ingestion, and shape-workbench phases; v0.1.7 is active with the exporter first slice and canonical ImportRecipe fidelity foundation delivered.

### Fixed: nested JSON import follows the real child level, so OSCAL catalogs nest as groups, controls, and enhancements (2026-09-23)

- `nestedChain` in `src/import/parsers/json-parser.ts` picked the first record list, in key order, of the first sampled record. On the NIST SP 800-53 Rev 5 OSCAL catalog that meant descending into `params` instead of `controls`, and a first control with no enhancements (AC-1) hid the enhancement level entirely. It now gathers candidate lists across all sampled records and prefers the one whose items look like their parent (key-set overlap), then one with ids, then the larger. Checked against the real catalog: groups (20), controls, enhancements, then parts. Shipped in 0.1.2 with the bug; the fix lands in the next prerelease.
- Tests: three cases in `tests/json-parser-nested-iterators.test.ts` on a synthetic OSCAL-shaped file.

### Third prerelease preparation, 0.1.2 (2026-09-23)

- Prepared version `0.1.2` as the third BRAT prerelease, carrying the nested records, sections, crosswalk, vault scan, and split-into-levels work below on top of `0.1.1`. `minAppVersion` stays `1.10.0`; `versions.json` gains the `0.1.2` entry. The user-facing notes live under `## [0.1.2]` near the end of this file, which is where the release job reads them.

### Added: nested levels can become sections inside their parent note, and the Depth dial is where you choose it (2026-09-23)

- **Deeper reification now reaches inside the note, and the wizard is where the user controls it.** A nested level's records (a control's statement and guidance parts, for example) can become headings with text inside the parent note instead of notes of their own or nothing. It is the fourth answer to "where does this level go": folder, note, left out, section. Design and rationale: [body projection decision log](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-09-23-body-projection-sections-inside-the-note/). Source: `src/source/nest.ts`, `src/render/index.ts`.
- **The Depth dial gains a second select, Below the note.** On a nested source with a level below the note it offers **Left out** or **Sections inside each &lt;note level&gt; note**; choosing **Left out** reproduces the previous result exactly. The hint names each placement, for example `Each group becomes a folder; each control becomes a note; each part becomes a section inside its control note.`, and adds `Sections are rebuilt on every refresh. Write your own notes below the managed region.` Source: `src/import/workbench.ts`, `setFolderDepth` in `src/import/mapping/view-model.ts`.
- **Each nested row below the note has Placement and Section text.** **Placement** offers **Left out** or **Sections inside each &lt;parent&gt; note** (disabled, with a title naming the cause, when the parent is left out). **Section text** picks the field written under each heading and defaults to a text-like field; with none chosen, the row says how to fix it. Section headings default to a human-readable field, trying title, then label, then name, then id (landing concurrently with this entry). Source: `src/import/workbench.ts`, `src/import/mapping/serialize.ts`.
- **The sample preview shows the sections.** It opens on the first note-level row instead of an empty parent folder note, so the headings are visible before Generate, and the counts read `<n> notes, <m> sections`. Source: `src/import/workbench.ts`.
- **Refresh keeps its promises.** Sections live inside the one managed body region, so prose written outside it survives byte for byte and a refresh that changes nothing leaves the note untouched, `produced_at` included. Switching a level from notes to sections keeps the old notes and reports them as orphans; the summary adds `Some may be <levels> notes that this recipe now folds into their parent notes as sections.` Switching back mints notes under the identity scheme pinned when the import set was minted. Source: `src/generation/generation-engine.ts`, `src/import/import-wizard.ts`.
- **A section is content, not a concept.** Section records get no note, CURIE, provenance, Tier 2 row, or orphan entry; their fields count toward the host note's `wording` review group, so a changed part flags its control for wording review. Source: `src/generation/generation-engine.ts`, `src/generation/hash.ts`.
- **SchemaVer 1.14.0 makes the shape portable for every producer.** `nest_level.leaf` gains `section`, and append body entries gain an optional `level` that scopes a projection to one section level. The producer contract adds rule (6): section records attach to their nearest emitted ancestor under `_cw.sections` and render after the host's own projections as one heading region each, depth-first. `render()` emits them from the level's existing `heading` layout entry; the five layout mechanisms are unchanged. Recipes without either key validate and hash byte-identically. Source: `spec/recipe.schema.json`, `src/render/index.ts § renderAttachedSections`.
- **Nine new recipe diagnostics say what is wrong and what to do** (eight blocking, one warning), such as `Level "<level>" becomes sections but target.layout has no heading entry for it. Add a heading entry for "<level>" below the note's file entry.` Full list: [schema spec §4.16](https://cybersader.github.io/crosswalker/agent-context/v0-1-schema-spec/#nest-section). Source: `src/import/recipe-document.ts`.
- **Also fixed in the same work:** a nested level with no layout entry is now declared in the recipe's `source.levels`, removing a false undeclared-level blocker, and nest controls stay inside the visible card when the level table scrolls. Source: `src/import/recipe-document.ts`, `src/import/workbench.ts`, `styles.css`.

### Added: nested records import as nested notes, and the wizard is where you choose which levels become notes (2026-09-22)

- **Deeper reification now reaches source depth, and the wizard is where the user controls it during import.** A source whose records own lists of sub-records now imports as nested notes: JSON records inside records, or rows from a second worksheet grouped under rows from the first. Source: `src/source/nest.ts`, `src/source/index.ts`, `src/source/joins.ts`.
- **The JSON picker makes nesting an explicit choice.** Under a detected record chain it shows `Records inside records: ...` once, on the top-level list, then offers **Nested: groups, controls, parts (21 notes)** and **Only groups (3 notes)** with the source's own names and counts; the flat choice remains the default until the user picks nesting. The parse notice counts the expanded records: `Parsed 21 records across 3 levels: groups (3), controls (6), parts (12).` Source: `src/import/import-wizard.ts`, `src/import/detection.ts`.
- **A Depth select on the mapping card is the first intent-level control over the reshape.** It sits above the shape cards, offers `No folders` through the source's full depth, and rewrites every level's destination at once; the hint reads, for example, `Each group becomes a folder; each control becomes a note; part is left out of this import.` On a nested source every level below the chosen note gets `leaf: none` and no destination, so those rows are not emitted; a Depth-1 import of the synthetic OSCAL fixture writes 9 notes with no part note and no path collision (`tests/nest-generation.test.ts`, N12). A hand edit no depth can express shows `Custom` and says how to reset. Source: `setFolderDepth` in `src/import/mapping/view-model.ts`, `src/import/workbench.ts`.
- **Previews come from the expanded records, not the flat top-level rows.** The workbench expands nested rows for its samples and the combined preview, so a groups, controls, parts source shows `ac`, `ac-1`, `ac-1_smt.md` and resolves `ac/ac-1/ac-1_smt.md`; levels joined from a second collection still preview from the top-level row. Source: `src/import/workbench.ts § refreshExpandedRows`.
- **Nested rows expose the two decisions that matter, in a sub-row that fits the card.** **Own note** offers **Yes, as a folder note** or **No, folder only**, and **Identified by** offers **Its own identifier** or **Its path from the top level**. The last nest level may declare `leaf: none`; `folder-note` there is refused with `The last nest level "<level>" is the note itself; folder-note applies only to levels that have children.` Merge and Split are absent because nested levels are record types declared by the source, and merging them into one name would collide rather than place children into a parent's body. Source: `src/import/workbench.ts`, `src/import/mapping/view-model.ts`.
- **Each child is named by its own id or by its place in the hierarchy, and that choice is fixed when the import set is minted.** Path identity escapes every lineage piece before joining it, so an id containing `/` cannot forge a parent-child boundary and a later refresh cannot rename existing notes just because a duplicate appeared elsewhere. Source: `src/generation/curie.ts § pathIdentityLocalPart`, `src/generation/generation-engine.ts § deriveRowCurie`.
- **Two rows cannot claim one identity.** Nested imports compute every emitted CURIE before the first folder is created and refuse the first collision with `Ambiguous identity <curie> claimed by rows at <path A> and <path B>. Set identity: path on level "<level>" so each row is named by its place in the hierarchy.` Source: `src/generation/generation-engine.ts § nestedIdentityCollision`.
- **Unparented rows from a second collection are reported, not dropped silently.** Crosswalker counts them once and warns `<n> <level> records name a parent that is not in the source and were not imported.` Source: `src/source/nest.ts`, `src/generation/generation-engine.ts § addUnparentedWarnings`.
- **SchemaVer 1.13.0 makes `source.nest[]` portable for every producer.** The producer contract requires depth-first parent-before-child emission; one `_cw` lineage object with `level`, `path`, `parent`, and `ancestors`; escaped path identity; declared folder-note addresses; and per-row, non-cascading `source.where`. Source: `spec/recipe.schema.json § $defs/nest_level` and `source.properties.nest`.
- **Recipes without `nest` keep their existing identity byte for byte.** `source.nest` participates in `recipeHashCanonicalInput()` because it changes which notes exist, while an absent key stays absent instead of becoming `null`; every shipped recipe without it retains the same canonical input and hash. Source: `src/generation/hash.ts`, `tests/source-hash-stability.test.ts`.
- **The limits are stated rather than hidden.** JSON-field nesting is eager only, a join-backed nested import previews the primary row count until generation computes the exact count, and parent notes absorbing children as body sections are not in this build. Source: `src/source/index.ts`, `src/generation/generation-engine.ts`, commit `e978da62`.

### Added: crosswalk columns reify to edge notes, and the Crosswalks card is where you choose the framework (2026-09-21)

- **A "maps to another framework" column now becomes first-class vault structure, and the Crosswalks card is where the user decides what becomes real.** Generation writes separate crosswalk-edge notes in their own import set under `_crosswalker/mappings/<source>-to-<target>` and writes no mapping frontmatter into the concept note. Source: `src/generation/crosswalk-edge-pass.ts`, `src/generation/generation-engine.ts`.
- **Recognition offers the crosswalk column role, then leaves the framework and predicate under user control.** Registry aliases and identifier shapes name the framework when they can, including the CRI case where CSF identifiers are byte-identical to the source's own Profile identifiers; the user confirms or changes the offer on the Crosswalks card. Source: `src/import/detection.ts`, `src/import/recipe-registry.ts`, `src/import/workbench.ts`.
- **The Crosswalks card provides the full choice.** Framework options come from the registry plus **Other**, and Predicate offers five values: approximately the same as, the same as, broader than, narrower than, and overlaps with (source: `spec/recipe.schema.json § $defs/crosswalk_entry.properties.predicate`). Source: `src/import/workbench.ts`.
- **An unnamed framework blocks Generate with an action.** The exact message is: `Column "<column>" is marked as a crosswalk but no framework is named. Pick the framework on the Crosswalks card, or turn the card off.` Source: `src/import/recipe-document.ts`.
- **SchemaVer 1.12.0 makes the choice portable for every producer.** `target.crosswalks[]` declares the source column, target ontology, predicate, splitting, dropped atoms, qualifier handling, and optional mapping-set id, so the plugin, an external producer, or a hand-written recipe can request the same output. Source: `spec/recipe.schema.json § $defs/crosswalk_entry` and `target.crosswalks`.
- **`source.detect` shipped in the same additive schema step but has no reader yet.** Its five offer-only hints are present for a later recognition consumer; the current worksheet suggestion still scores observed columns. Source: `spec/recipe.schema.json § source.properties.detect`, `src/import/workbook-suggestion.ts`.
- **The bundled CRI recipe now declares `NIST CSF v2 Mapping`, and its effective hash moved.** The declaration produces additional edge notes, so `target.crosswalks` correctly enters `recipeHashCanonicalInput()`; recipes without the key stay byte-identical. Source: `recipes/import/cri-profile-v2-2.json`, `src/generation/hash.ts`, `tests/fixtures/recipe-hash-golden.json`.
- **Generation reports the edge result in plain language.** The wizard line is `Wrote N crosswalk edges to M mapping sets under _crosswalker/mappings.` Source: `src/import/import-wizard.ts`.
- **The bundled identity-name divergence remains an owner decision.** `recipes/import/crosswalk-edge.json` declares `source.ontology: "xwalk"`, while the wired importer and the new column pass mint under `sssom`; this entry records the divergence and changes neither identity space nor legacy notes. Resolved 2026-09-22 (ratified): new edges mint `sssom`, legacy `xwalk` notes are kept and recognized, never rewritten; see the [xwalk identity space log](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-09-22-xwalk-legacy-identity-space/). Source: `recipes/import/crosswalk-edge.json`, `src/import/sssom-importer.ts`, `src/generation/crosswalk-edge-pass.ts`.
- **Every new crosswalk edge mints under `sssom`, and legacy `xwalk` edges are recognized, not duplicated (2026-09-22).** A set producing crosswalk-edge notes mints `sssom:` whatever its recipe's source label says, including the bundled OLIR recipe and the headless OLIR and MELT tools, which now share one identity helper (`src/generation/crosswalk-identity.ts`). An import that meets an existing `xwalk:` note recording the same subject and object updates that note where it lives and keeps its curie; two such notes, or one owned by another import set, is refused by name. An explicit refresh of a legacy `xwalk` set stays `xwalk` with zero orphans. Seven regression tests in `tests/generate-from-recipe-identity.test.ts`.

### Added: find framework sources already in the vault, and open them where you decide what becomes real (2026-09-21)

- **Crosswalker now turns more latent source structure into vault structure, and the vault scan opens each source in the wizard where the user decides, column by column, what becomes real.** **Find sources in this vault** is available from the workspace launchpad, the settings mirror, and the `Crosswalker: Find framework sources in this vault` command. Source: `src/views/workspace-view.ts`, `src/settings/settings-tab.ts`, `src/main.ts`.
- **Each recognized row shows the evidence needed to choose.** It shows the match and score, worksheet and header row when relevant, and a reconciliation state based on source-byte digest and index readiness: `Not imported`, `Imported <time>, unchanged`, `Imported <time>, source changed`, or `Checking vault index`. Source: `src/import/vault-source-scan-modal.ts`, `src/import/vault-source-scan-runner.ts`, `src/import/vault-source-scan.ts`.
- **Import selected creates one new import set per checked source and stops at the first failure.** Remaining checked rows stay available for the next run rather than continuing past an unknown result. Source: `src/import/vault-source-scan-modal.ts`, `src/import/run-recognized-import.ts`.
- **Create drafts for selected records the offer without choosing it.** Each draft carries the source, worksheet, and header row but no `presetRecipeId`, so resuming returns to the wizard's normal offer-and-confirm path. Source: `draftFromScanRow()` in `src/import/vault-source-scan-runner.ts`, `src/import/draft-store.ts`.
- **Open in wizard and Refresh prefill source controls only.** They pass the file, worksheet, and header row, remain on Step 1, and never preselect a recipe or refresh target; an unchanged set uses **Open** to activate the workspace. Source: `src/import/vault-source-scan-modal.ts`, `src/import/import-wizard.ts`.
- **Sets managed by another Tier 1 producer remain visible without becoming selectable scan rows.** They appear under **Managed by another producer** with an **Open** action and no tick. Source: `src/import/vault-source-scan-runner.ts`, `src/import/vault-source-scan-modal.ts`.
- **The scan is bounded and explains what it skips.** It stops at 500 importable files, and a file above the 5 MB header-scan limit is listed as `Skipped: larger than the header scan limit. Open it in the wizard instead.` Source: `MAX_FILES_PER_SCAN` in `src/import/vault-source-scan.ts`, `LARGE_FILE_BYTES` and `LARGE_FILE_NOTE` in `src/import/vault-source-scan-runner.ts`.
- **CSV and JSON imports now stamp a source byte digest, so every supported scanned format can reconcile unchanged and changed source bytes.** CSV parsing still delivers rows step by step, but the digest path keeps one complete byte snapshot in memory; revisit chunked hashing only if a measured source shows pressure. Source: `src/import/parsers/csv-parser.ts`, `src/import/parsers/json-parser.ts`, `src/generation/hash.ts`.
- **TSV is not scanned yet.** The frozen design named it, but `isImportableExtension()` does not admit it, so the current scan covers CSV, XLSX/XLS, and JSON only. Source: `src/ui/entry-points.ts`, `src/import/vault-source-scan-runner.ts`.

### Added: the wizard suggests the worksheet and header row; drafts remember the header row (2026-09-21)

- **Crosswalker turns a recognized workbook's table placement into an explicit suggestion, and the user keeps control of what becomes real.** Under the controls, the exact confident wording is `Suggested from <label>: sheet '<name>', header row <n>. Change either if this is not the file you expect.` Editing either control changes the line to `Using your choice: sheet '<name>', header row <n>.` and adds **Use suggestion** to restore the pair. Source: `src/import/import-wizard.ts`.
- **A suggestion never advances the wizard or chooses a recipe.** The worksheet and header row remain editable, and the normal recognized-source card still appears only after the user continues. Source: `src/import/import-wizard.ts`, `src/import/workbook-suggestion.ts`.
- **Vault-scan prefill carries both the worksheet and header row.** Opening a recognized workbook from the scan lands on Step 1 with the offered source binding visible. Source: `PrefillBinding` in `src/import/import-wizard.ts`, `openInWizard()` in `src/import/vault-source-scan-modal.ts`.
- **Drafts now persist `xlsxHeaderRow`.** Drafts written before this field existed hydrate it as `0`, preserving their prior behavior. Source: `WizardDraft.xlsxHeaderRow` in `src/import/draft-store.ts`, draft hydration in `src/import/import-wizard.ts`.
- **Choosing a second workbook no longer inherits the first workbook's header row.** New-source reset clears it to `0` together with the sheet. Source: `src/import/import-wizard.ts`, `tests/import-wizard-sheet-suggestion.test.ts`.
- **Workbook notices now state a cause and an action.** For example: `Could not read workbook sheets: <cause>. Choose another workbook or fix the file and try again.` Source: `src/import/import-wizard.ts`.

### Added: detection proposes separator-set levels, and the mapping model can split a row into levels (2026-09-15)

- **A packed id column with two or more separators is now detected as one set, not one separator at a time.** When at least two separators each qualify on their own and tokenizing on the set gives the same depth for at least 90% of sampled values (`UNIFORM_DEPTH_AGREEMENT`), detection proposes `{col|prefix(D,i)}` for every level but the last, with the untouched column as the leaf. NIST CSF 2.0 `GV.OC-01.01` therefore proposes `prefix(.-,0)` and `prefix(.-,1)` instead of `split(.,0)` and `split(-,0)`, so the second folder reads `GV.OC-01` rather than `01`. A column with a single qualifying separator, or a ragged depth over the set, produces byte-identical output to before. Source: `deriveFixedSplitTemplates` in `src/import/detection.ts`; the engine's `deriveIdSplitTemplates` is unchanged, so its parity with detection now holds for single-separator columns only (pinned in `tests/detection.test.ts`).
- **Instantiating a detected layout keeps the separator set.** A `prefix(D,i)` or `part(D,i)` template becomes a fixed `LevelRule` with `delimiters: D` and `naming: 'prefix'` (or `'part'`); `split(d,i)` still yields `delimiter: d`, `naming: 'part'`. Source: `instantiateStructural` in `src/import/mapping/instantiate.ts`.
- **Mapping model: `splitIntoLevels`.** Replaces one matrix row with `depth` rows over a separator set: `depth - 1` piece rows (`{column, part: i}` + `delimiters`, folder destination when the row placed folders, `naming` per row) and one leaf that is the untouched column carrying the original row's destinations. The leaf is the whole id so a short ragged row never renders an empty name, and the result equals what detection + instantiate produce for the same input. Re-splitting a row an earlier split produced replaces the whole run (piece rows plus their leaf), never appends; new level ids skip any id still in use. `mergeRows` now carries `delimiters` across a merge and, when neither row had a single `delimiter`, joins pieces with the set's first character. Source: `src/import/mapping/view-model.ts`; tests in `tests/mapping-view-model.test.ts`, `tests/mapping.test.ts`.
- The workbench "Split into levels" panel that drives `splitIntoLevels` is not in this entry; it follows separately.

### Added: `part` / `prefix` template filters that split on a set of separators (2026-09-15)

- **Ids like `GV.OC-01.01` can now be split into levels across mixed separators.** Two new recipe template filters, `part(D,n)` and `prefix(D,n)`, treat every character in `D` as a separator: `part(.-,2)` on `GV.OC-01.01` yields `01`, `part(.-)` yields the full list, and `prefix(.-,2)` yields `GV.OC-01` (the original text truncated after the selected part, separators kept). Empty pieces are dropped, so `A..B` splits the same as `A.B`. The existing `split(d,n)` filter is unchanged. Source: `FILTERS` in `src/render/template.ts`; render notes `part-no-delimiter`, `part-index-missing`, `prefix-index-missing` in `src/render/types.ts`.
- **Filter arguments can carry `,` `)` `|` and `\` when escaped with a backslash** (`part(\,;,0)` splits on comma or semicolon). Source: `unescapeFilterArg` in `src/render/template.ts`.
- **Mapping model.** `LevelRule` gains an optional `delimiters` (separator set). A level carrying `delimiters`, or `naming: 'prefix'`, serializes to `part`/`prefix`; a level carrying only the legacy `delimiter` still emits `split(d,n)` byte for byte, so existing recipes and their digests are untouched. `naming: 'prefix'` is now meaningful on fixed levels, not only the variadic tail. Templates using the new filters parse back into the same `LevelRule` (round-trip covered in `tests/mapping.test.ts`). Source: `src/import/mapping/types.ts`, `src/import/mapping/serialize.ts`.
- **Recipe schema SchemaVer 1.11.0** (additive). The `$defs/template` description in `spec/recipe.schema.json` documents both filters; the spec URI did not bump. Schema-spec page §4.12 added.
- Detection of separator sets from source values and the workbench "split into levels" control are not in this entry; they follow separately.

### Added: workbench "Split into levels" panel (2026-09-15)

- **One packed id column can now be split into one level per piece, by hand.** A "Split into levels" panel in the shape workbench replaces a row mapped to a packed id (e.g. `GV.OC-01.01`) with one level per piece over a set of delimiters: `.`, `-`, `_`, `/`, `:`, or one custom character. A depth preview shows how many levels each sampled value produces before anything is applied, each level's name is cumulative prefix (`GV`, `GV.OC`) or single part (`GV`, `OC`), and each level carries a missing-value policy. Re-splitting a run replaces that run rather than appending to it. Source: `src/import/workbench.ts` (panel) driving `splitIntoLevels` in `src/import/mapping/view-model.ts`.
- **Detection proposes the same shape automatically.** When a column's ids mix two or more delimiters (CRI-style `GV.OC-01`), detection proposes cumulative-prefix levels for the set, so the panel opens pre-filled with what detection found. Detail in the detection entry above.
- **Underlying filters.** The panel emits `part(D,n)` / `prefix(D,n)` templates (SchemaVer 1.11.0); detail in the filters entry above.

### Fixed: shape cards that did nothing, and a column left with nowhere to land (2026-09-14)

- **A shape card that cannot be turned on now says why.** Mapping a single id column produced a card set where ticking Folders, Tags, Properties, Links, or One file changed nothing at all and the card stayed Off. Those cards now read "Not available" and carry a short explanation under them: folders and the rest sit on levels above the note, this column has one level, and levels come from values that split on a separator, shown with an example built from the column's own first value.
- **A column can no longer be left with no place to land.** Turning off the last thing placing notes in the vault (folders, file names, and one file all off everywhere) is refused with a message naming what to turn on first, instead of being accepted and failing later. Resolving two columns that both shape the vault by unticking Folders and File names on one of them still works.
- **The unreadable generate error is gone.** "Can't generate: /source/levels: must NOT have fewer than 1 items; /target/layout: must NOT have fewer than 1 items" is replaced, in both the workbench preview and the review step, with "No column is set to place notes in the vault. Open a column's mapping and turn on File names, Folders, or One file, then try again."

### Fixed: changing the sheet or header row after going back now actually takes effect (2026-09-14)

- **Editing the header row and clicking Next re-reads the file.** Going back to the first step of the import, raising the header row to skip banner rows above the real column headers, and clicking Next silently kept the first reading of the file: header row 0, the wrong columns, placeholder names like `__EMPTY1`, and no recognition of the source. Found on a real CRI Profile v2.2 workbook, where the fix appeared to do nothing. Changing the sheet, and changing which record list to import from a JSON file, had the same problem.
- **What is kept.** The file, the sheet and header row you chose, and the column decisions you have already made all stay. Decisions naming a column the new reading does not have are dropped where they always were, the same way a resumed draft handles them. Going back by itself still keeps a good reading of the file; only changing one of the settings that decides how the file is read starts it over.
- **Clearer wording.** The header row help text now reads "0-based row index of the column headers. Raise it to skip banner rows above them."

### Fixed: adding a mapping by hand now keeps the column's levels (2026-09-14)

- **Picking an id column from "Add mapping from a column" no longer flattens it.** Choosing a column whose values split into levels, such as `GV.OC-01` and `GV.OC-01.01`, built a mapping with a single level, the note itself, so the Folder card on that card read "Not available" with nothing to turn on. The mapping now starts with the same levels Crosswalker already detected for that column: the folder levels plus the note. Found on a real CRI Profile v2.2 workbook.
- **Adding a second such column is still safe.** When another column is already shaping the vault, the hand-added column arrives with the same levels but nothing routed anywhere: the note keeps a frontmatter property, and the levels above it are left for you to turn on. Only one column shapes the vault at a time, which is unchanged.
- **The chooser says so before you click.** A column that splits into levels now shows "Splits into levels on" with its separator, and a column that is the deepest of a set of level columns shows how many columns that set has.
- **Columns with no levels are unchanged.** A plain column still arrives as one level, the note name when nothing else is placing notes yet and a frontmatter property otherwise.

### Release workflow hardening (2026-09-14)

`.github/workflows/release.yml` no longer decides anything inline. Every publication decision moved into `scripts/release-preflight.mjs`, a dependency-free Node script covered by `tests/release-preflight.test.ts` (12 cases), because none of the old YAML logic could be exercised without pushing to `main`.

- **An already published version is skipped, not republished.** The job reads whether the remote tag and the GitHub release already exist, and exits successfully with a `::notice::` when either does. The previous workflow deleted the remote tag and recreated it on the new commit every time it ran, which would have silently moved the published `0.1.0` and `0.1.1` prerelease tags.
- **Tags are only ever created.** `git tag -d` and the `:refs/tags/...` delete push are gone. A losing race on the tag push fails the job loudly instead of replacing published state.
- **`0.x` versions publish as prereleases.** The release is created with `--prerelease --latest=false` when the major version is `0` or the version carries a suffix, and `--latest=true` otherwise. The previous workflow marked every release latest, including `0.x`.
- **Release notes have no fallback.** Notes come from the first exact `## [x.y.z]` heading in `CHANGELOG.md`, stopping at the next `## ` heading or horizontal rule. A missing or empty section fails the job with a named cause and action, instead of publishing a body reading `Release x.y.z`. The `force_release` dispatch input does not bypass this; it only bypasses the cheap "version unchanged since the previous commit" early exit.
- **Version consistency is checked before anything is published.** `package.json`, `manifest.json`, and `versions.json` must agree, and the built `manifest.json` must carry the version being tagged. Exactly three assets are asserted before upload and re-read from the published release afterward, together with the prerelease flag.
- **The toolchain is pinned.** `oven-sh/setup-bun` uses `bun-version: 1.3.14` (the version `bun.lock` was resolved with) instead of `latest`, and installs run `--frozen-lockfile`. A `concurrency` group serializes release runs. The inline SQLite asset verification step is unchanged.
- **Historical heading renamed.** The 2026-04-02 MVP entry at the bottom of this file was `## [0.1.0] - 2026-04-02`, which the old extractor would have matched when publishing the real `0.1.0`. It is now `## [0.1.0-mvp-scaffold] - 2026-04-02`.

Operational consequence: merging the branch that carries the `0.1.1` bump will not republish `0.1.1`. The next version needs a `## [x.y.z]` heading in this file before its bump lands on `main`, or the release job fails with that instruction.

### Second prerelease preparation, 0.1.1 (2026-09-14)

- Prepared version `0.1.1` as the second BRAT prerelease, carrying the launchpad, wizard header, preset guide, and Escape changes below on top of `0.1.0`. `minAppVersion` stays `1.10.0`; `versions.json` gains the `0.1.1` entry. Publication is a separate step and is not claimed here.
- Installation page now points at the published `0.1.0` and the `0.1.1` candidate and explains updating through BRAT. A BRAT installation itself remains untested by the maintainer.

### Import launchpad and wizard header guidance (2026-09-14)

- Import wizard: the modal header no longer collides with Obsidian's close button, and the repeated "Import structured data" title is gone; the step indicator remains.
- New "Browse built-in import presets" guide on the settings launchpad, the Crosswalker workspace, and Step 1 of the import wizard: each preset links to where to download the publisher's file and to the matching import instructions.
- Import wizard: pressing Escape with no picker, menu, or popover open now closes the modal again. The wizard's own keyboard scope shadowed Obsidian's default Escape binding, so the key was silently swallowed.
- Internal: E2E helpers recognize Obsidian 1.13's renamed modal close button, and the E2E harness disables Obsidian 1.13's "open settings in a window" default so settings specs can see the modal.

### First public prerelease preparation and compatibility floor (2026-09-13)

- Prepared version `0.1.0` for its first public prerelease with the standard three plugin files: `main.js`, `manifest.json`, and `styles.css`. Publication is a separate step and is not claimed here.
- Corrected the minimum Obsidian version from `1.0.0` to `1.10.0`, based on APIs the plugin uses. The plugin version remains `0.1.0` and mobile support is not disabled. Runtime acceptance used Obsidian 1.13.7 on desktop Linux; mobile use and installation through BRAT remain unverified.

### Inline SQLite distribution and startup-readiness polling: the packaged plugin now starts Tier 2 reliably (2026-09-12; runtime acceptance 2026-09-13)

Two related fixes to the Tier 2 query-database startup path. Full decision record and plain-language explanation: [inline SQLite distribution synthesis](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-09-12-inline-sqlite-distribution-synthesis/); this entry is the canonical delivery detail the synthesis page links back to rather than repeating.

- **1. The plugin now embeds its own SQLite engine, instead of expecting two loose files beside `main.js`.** The Tier 2 loader previously read `sqlite3.wasm` and `sqlite3.mjs` from the vault adapter, but the documented three-file install path (`main.js`, `manifest.json`, `styles.css`) never places those files there. Two separate, real pieces of evidence exist for this failure mode: an isolated real-Obsidian WDIO startup probe on 2026-09-10 reproduced a literal `ENOENT` opening `sqlite3.wasm` (trace `3f8bf2a9`, `auto-projection-start`/`auto-projection-failed` at `2026-09-10T01:34:47.075Z`/`.076Z`), and a newer isolated Jest test (`tests/tier2-inline-loader.test.ts`) reproduces the same missing-file dependency against the pre-fix loader code in isolation. Neither is a real BRAT or release-artifact install failure; that has still not been captured. The plugin's existing startup-failure Notice was never silent — it already warned that Tier 2 queries may be stale and pointed to the debug log — and this delivery replaces that pointer with a reload option and a copy-diagnostics/report route: an improvement to the Notice's wording and options, not a description of what it already offered.
  - Build-time resolution reads the installed `@sqlite.org/sqlite-wasm` package's `dist/sqlite3.wasm` and `dist/index.mjs` and embeds both as literal string payloads inside `main.js` through two narrow esbuild virtual modules (`virtual:sqlite3-wasm-base64`, `virtual:sqlite3-mjs-text`), consumed solely by `src/tier2/sqlite-assets.ts`. The WASM payload is base64-decoded lazily via the browser's `atob`/`Uint8Array` (never Node's `Buffer`, unavailable specifically in Obsidian's mobile Capacitor renderer); the JS module payload is stored and used as plain text. `package.json`'s dependency declaration is an unchanged caret range (`^3.53.0-build1`); `bun.lock` is what resolved the exact `3.53.0-build1` build actually embedded — "pinned" means lockfile-resolved, not an exact-version declaration.
  - `src/tier2/sidecar.ts`'s `locateFile` now returns the plain filename for the one expected `sqlite3.wasm` request and throws a named `UnexpectedSqliteAssetRequestError` for anything else, before any fallback fetch.
  - A build-time verifier (`scripts/verify-inline-sqlite-assets.mjs`), using the TypeScript compiler API to parse — never execute — the emitted `main.js`, checks full byte/length/SHA-256 equality between the embedded payloads and the independently resolved package files, plus esbuild-metafile evidence that no loose SQLite output remains. This is a static, build-time proof that the build emitted the bytes it was supposed to; it is not itself a runtime test.
  - The WDIO harness workaround that had been masking this class of failure in E2E (staging hooks in `wdio.conf.mts`/`wdio.first-run.conf.mts` that copied the two loose files into the test vault after Obsidian launched) is removed; E2E now exercises the same three-asset shape the documented install path describes. The 2026-05-06 delivery log that recorded that workaround as shipped is preserved unchanged, with a dated supersession pointer added: see [v0.1.5 Tier 2 sidecar shipped](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-06-v0-1-5-tier-2-sidecar-shipped/).
  - Bundle facts at delivery time (before the startup-readiness fix below landed on top of it): embedded `sqlite3.wasm` 864,752 bytes, SHA-256 `02d7e48164395fa68f81c6ec33e9da5461be397dc57602ac0cd89b4bbba1d312`; embedded `dist/index.mjs` 578,559 bytes, SHA-256 `f80870f0fa03a39a3338d17ed3fbea04808d344c88e724d90d5f37b9b7b83154`; resulting `main.js` 4,296,326 bytes, SHA-256 `10eea58577b49d2b96ca6278d095701fdeb343a2e637dd2e5d11e03f4b4cda43`.
  - Deterministic evidence: focused red then green preceded a full suite of 192 suites passed / 1 skipped, 3,079 tests passed / 2 skipped; lint, production build, the standalone release verifier, and all six static documentation gates exited 0. A separate reviewer independently inspected the diff, hashes, and logs and cleared the source (no test execution performed as part of that review).
- **2. Startup readiness now polls the actual pending-metadata predicate, replacing a fixed-event-count heuristic that could settle before metadata actually finished parsing.** The prior startup barrier (`src/tier2/startup-readiness.ts`) waited for a fixed count of "resolved" metadata-cache events and treated that count as proof every file's frontmatter had arrived. An isolated test against a preserved snapshot of that old code proves the flaw directly: it settles (`Expected false; Received true`) after five irrelevant resolved events, before the genuinely scheduled readiness point at `t=800ms`. The corrected version instead re-checks the real pending-files predicate on a bounded poll: at most every 100 milliseconds, up to a monotonic-clock (a wall-clock-independent timer immune to the system clock changing mid-wait) 12,000-millisecond deadline, cancellation-checked before the first metadata read and after every awaited tick, with cancellation always taking precedence over a timeout. `settleVaultIndex` reverted to its original two-argument form (a third-argument callback added during the prior attempt was removed; confirmed zero remaining three-argument callers). This fix does not cover standalone early `openTier2`/schema-rebuild calls made outside the normal startup path — that remains out of scope. Existing error-handling and orphan-pruning safety behavior is unchanged.
  - Deterministic evidence at the source checkpoint: full suite 194 suites passed / 1 skipped, 3,102 tests passed / 2 skipped; lint, production build plus asset verifier, and all six static gates exited 0. An independent source-only review (no test execution) cleared the change against its written contract, with four non-blocking findings (a red-test ordering issue and cancellation-over-timeout precedence, both addressed below; a manual-read-only confirmation of the clock fallback; one line of unreachable defensive code).
  - A later, separate, narrower correction reordered one test assertion, added cancellation-at-deadline precedence coverage, and added the isolated old-helper proof above; that correction's own run is a focused, test-only pass — 3 suites, 36 tests passing — not an updated full-suite count, and did not itself re-run the full suite, lint, build, gates, or any browser harness.
- **3. Real-Obsidian runtime acceptance, dated 2026-09-13 UTC, covering the combined bundle of both fixes above.** Two earlier seeded runtime attempts each passed 28 of 29 checks but failed automatic startup acceptance. The second captured missing-cache errors; the first did not retain the exact per-file exception. After the deadline-based correction, the final seeded and empty-vault runs passed all 30 checks. Two isolated WDIO runner commands executed against real Obsidian: a seeded-vault run (29 of 29 declarations passed) and a new empty-vault first run (1 of 1 passed), both exercising fully automatic startup with no manual trigger — 30 of 30 total. The seeded run's startup witness recorded `checks: 2, elapsedMs: 100.3` (the vault was not ready at layout-ready; one 100ms poll cleared it — the class of scenario the prior fixed-count model failed on). The empty-vault run recorded `checks: 1, elapsedMs: 0` (a warm immediate return). The empty vault's installed plugin folder contained the standard three shipped assets (`main.js`, `manifest.json`, `styles.css`) plus two development-harness files (`.hotreload`, `data.json`, present because this is a test/dev install rather than a release archive downloaded via BRAT) — no loose SQLite files were present or needed in this tested shape. Combined bundle for this runtime pass: `main.js` 4,301,740 bytes, SHA-256 `0af4dc3d2c721a654584cc968521caaa3a321eabcbcdfd1afddf383bbf8848b5`.
  - Explicit limitations, none of which this pass resolves: no real BRAT/release-artifact install was exercised; no mobile execution; OPFS-versus-in-memory persistence mode was not observed in either run; no comparable load-timing or performance measurement was taken; the 12-second waiting budget is a bound, not a proof of sufficiency for larger or slower vaults (these two runs needed 100ms and 0ms); an unrelated Mocha/screenshot-capture hang observed on an earlier attempt did not recur here but was neither explained nor patched by this work.
- **4. `.github/workflows/release.yml` is changed by this delivery** — it gains an inline-asset verification step. Its trigger (push to `main` or manual `workflow_dispatch`, not a tag push), its existing tag delete-and-recreate behavior, and the absence of a `--prerelease` flag are all unchanged by this delivery and remain pre-publication safety gates that need explicit owner review before the next release runs, not a "reruns are safe" conclusion. See the embedded checklist in the synthesis log. Superseded 2026-09-14 by the release-workflow hardening entry above.

**Scope.** Unmerged, unreleased work on `fix/d1-per-import-root`. Not a v0.1.7 completion claim, not a Tier 2 substrate change (still `@sqlite.org/sqlite-wasm`, still no `sqlite-vec`), and not a change to how native Obsidian Bases views or Crosswalker's own SQLite-backed reporting are surfaced.

### Real-Obsidian acceptance rerun: the six targeted declarations passed (2026-09-09)

The acceptance case that two earlier runs never reached, and that a third run produced no captured output for, has now executed and passed. **This entry adds no product change**: no source, test, schema, config or dependency file was touched by the rerun, and the frozen 27-path population and its hashes were byte-identical before and after. It is a verification result for the [ordinary import repairs](#ordinary-import-repairs-the-filter-is-used-and-a-missing-field-is-left-off-2026-09-07) and [XLSX source-byte provenance](#xlsx-source-byte-provenance-2026-09-07) slices below.

- **One real invocation, six named declarations, all PASS.** A single targeted run of `tests/e2e/visual-wizard-formats.spec.ts` in real Obsidian: JSON record picker and ranking; XLSX sheet picker and parse to Step 2; JSON iterator, filter and parse to Step 2; the XLSX full loop through generation; the JSON full loop through generation; and the JSON unknown-filter negative case. The reporter read **6 passing, 3.9 s**, approximately 12 s wall clock after lock acquisition, including harness startup and the normal E2E `onPrepare` build. **Wrapper and child both exited 0, with 1 invocation and 0 runtime retries** — no SIGTERM, no exit 143, no resource-guard signal, and complete terminal mirroring (12,218 bytes, nothing truncated or suppressed).
- **The XLSX byte check held on real output.** Three notes were created (`AC/Account management.md`, `AC/Policy and procedures.md`, `AU/Audit policy.md`) and the note read back from disk carried a `_crosswalker.source_ref.source_hash` equal to a host-side SHA-256 over the same workbook payload the wizard was handed. **This is a same-payload digest comparison, not proof of external file authenticity** — it establishes that the engine hashed exactly the bytes it received, which is the scope the field claims.
- **The negative control finally executed, and the distinction it proves is narrower than "no provenance".** The filtered JSON import produced **exactly one note**, `Process Injection.md`. Its frontmatter carried **no top-level `revoked`, `source_ref` or `target_ref`** — the omission policy demonstrated on real written output rather than on a rendered string. The nested `_crosswalker.source_ref` was **present**, as `{ file: stix.json }`; only `source_hash` **inside** that block was absent. That is the intended contract: a JSON import still records which file it came from, and records no byte digest.
- **The wizard-to-engine filter connection is now proven at runtime.** An unknown filter field reached the results screen with **1 error and 0 created notes**, and the error named the field, stated that the source has no such column, printed the offending expression, and listed the available fields.
- **The unfiltered-preview sentence was read on screen, in both themes.** Fresh light and dark captures of Step 3 show "Preview uses unfiltered source samples. Your filter is applied during generation." legible in both, with no clipping or lost contrast. The preview's 3 notes against generation's 1 is the behavior that sentence exists to explain, not a discrepancy. The theme switch is a body-class toggle, which is sufficient for core light/dark rendering and is not a settings-level theme test.
- **What the evidence physically is.** Eight fresh screenshots were archived and independently hash-verified. **The final-note proof is frontmatter the spec read back from disk and printed to the terminal, not retained note files** — each declaration deletes its own uniquely named output folder in a `finally` block, by design.
- **Independently reviewed, with qualifications that are not cleared.** A separate read-only review recomputed every artifact hash, confirmed the log reporter against the spec's six `it()` blocks (no `.skip`, `xit` or `.only`), and confirmed the freeze. Its qualifications stand: **an unresolved "Tier 2 projection failed" warning is visible throughout the captures, so query data may be stale** — Tier 1 assertions passed, but Tier 2 projection health was not diagnosed or repaired; **the notice stack overlays part of the unknown-filter error text**, including the start of its available-field list, so the assertions passed while full visual readability did not; `wizard-xlsx-generated.png` does not show a results modal, so that declaration rests on the logged terminal state and assertions rather than on that image; two startup WebDriver bridge warnings recovered; and **sandbox removal is not positively recorded** — the named sandbox is absent at review time, which is absence, not a record of who removed it.
- **The earlier no-result run stands as recorded, and this pass explains nothing about it.** The 2026-09-07 run remains exactly as written below; its cause was never isolated and **is not established, fixed or superseded by this pass**. A capture wrapper whose repair had been validated separately is what actually ran here, and it worked. An earlier supervisor attempt on 2026-09-09 aborted **before** any wrapper, WDIO or Obsidian launch (0 invocations) because it treated an optional display utility as a prerequisite; removing that private preflight condition did not create a second runtime attempt.
- **Correction to the 2026-09-07 entry below: zero captured bytes is not evidence that the child was silent.** That entry states that "a stall during harness startup or before the first declaration screenshot is the only inference the empty output supports." **That inference is withdrawn.** What was recorded on 2026-09-07 is that the capture pipeline wrote 0 bytes — which is consistent with a silent child, but equally consistent with output the wrapper never captured, and the capture wrapper was subsequently repaired. **No startup, phase or pre-first-declaration conclusion follows from it.** The run remains a no-result outcome with an unknown cause; the wording below is preserved as the record of what was written at the time.
- **Scope, stated narrowly.** This clears the **targeted Tier 1 import declarations and the light/dark preview explanation**, on an unmerged working branch. It is **not** an overall visual verification, a full-E2E-suite run, a Tier 2 or query-health claim, a mobile, scale, performance, bundle-size or security claim, a quarantine clearance, or any part of v0.1.7 completion. **No standalone build or other verification suite was run for this result** — the normal E2E `onPrepare` build ran as part of the invocation, and no unit, golden, lint or static gate was re-run, so the static and core counts recorded in the entries below belong to the earlier exact-source verification of the unchanged 27-path population, not to this rerun. Nothing here is merged or released.

### Ordinary import repairs: the filter is used, and a missing field is left off (2026-09-07)

Repairs for two of the three gaps the XLSX acceptance run exposed on the ordinary (non-workbench) wizard path, plus the test-reporting gap that hid them. Rationale, the worked source row, and the accepted/rejected/deferred decisions are in the [ordinary import repairs log](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-09-07-ordinary-import-repairs-synthesis/); this entry is the delivery detail.

- **The wizard's row filter now reaches generation on both paths.** `GenerationOptions.sourceWhere?: string` is a narrowly typed, already-translated source predicate for one run. `src/import/import-wizard.ts` now calls the existing `shorthandToSourceExpression()` once for ordinary and workbench modes alike and sets the option when the result is nonblank; blank input supplies no override. Previously the translated expression was applied only under `if (where && options.recipeOverride)`, and `recipeOverride` is set only in workbench mode, so an ordinary import silently carried no filter. No second public helper was added to wrap the existing translator.
- **The override is applied after recipe resolution, not by changing which entry path owns the run.** In `generateNotes()` the existing `options.recipeOverride ?? legacyConfigToRecipe(...)` branch still decides provenance ownership — canonical recipe id versus `configId`. A nonblank `sourceWhere` is then applied to a **copy**, spreading both the recipe and its `source`, before recipe hashing and `prepareSourceStage()`. Joins, transforms, opaque fields and the caller's canonical original survive untouched, and an ordinary import does **not** become a `recipeOverride` import: recipe ids, minted import-set identity, ontology pinning, refresh selection and orphan ownership are unchanged. A nonblank filter replaces an existing `source.where`, matching workbench behavior; a blank field leaves a canonical predicate intact; there is no implicit combining of the two. `generateFromRecipe()` already ran the source stage and gained no new override surface.
- **Filter errors stay loud.** A nonblank but invalid expression fails through the existing error handling rather than disappearing. Unknown-field and all-filtered checks are the existing `prepareSourceStage()` ones, reached before note writes or deletes. **No filesystem-transaction guarantee is claimed** — existing setup may create folders before source preflight runs.
- **Auto-generated property templates are now optional by default.** In `src/generation/legacy-recipe-shim.ts` the managed-frontmatter loop emits `` `{${entry.column}|optional}` `` unless the mapping carries `omitIfEmpty: false`, which keeps the strict `` `{${entry.column}}` ``. This reuses the existing leading-`optional` semantics in `src/render/template.ts` and the omission behavior in `src/render/index.ts`; **the renderer is not weakened globally**, and this applies only to templates synthesized by `legacyConfigToRecipe()`. Absent keys, `undefined`, `null`, empty strings and empty list results omit the key; **false and zero are preserved** under the existing parser and renderer conversions, so no raw JSON type fidelity is promised where the parser already converts values to strings. A canonical recipe's required template, and a selected row missing a required file name, hierarchy or identity input, still error — a row is never silently skipped to make an import pass. The currently inactive global `EmptyHandling` setting and unrelated legacy formatting or transform flags were **not** wired.
- **Ownership of managed properties stays declaration-based.** `computeDeclaredManagedKeys()` / `computeManagedKeys()` in `src/generation/frontmatter-merge.ts` are unchanged, so an omitted declared managed key still removes a stale managed value on a permitted refresh while `user_preserve` still protects user-owned values. Merge authority and write decisions are untouched.
- **Ordinary effective recipe hashes legitimately change.** The generated template text differs, so `computeRecipeHash()` answers differently for classic wizard imports. That is the field's meaning working correctly. **No hash algorithm, hash meaning, canonical recipe digest, source-byte digest or stored identity was reinterpreted**, and no forced rewrite or hash backfill was added; existing skip, no-op and preservation write policies stay authoritative.
- **Preview says what it does instead of pretending to filter.** When a filter is set, both Step 3 preview surfaces in `src/import/import-wizard.ts` add one sentence-case line: "Preview uses unfiltered source samples. Your filter is applied during generation." No em dash, no predicted count, no new control, and no preview, source-stage or stream-consumption refactor. Preview already renders through the shim, so optional properties benefit it too; existing per-row preview failures still do not gate Generate, generation validation stays strict, and no preview/output parity is claimed.
- **The E2E helper now reports terminal outcomes instead of a timeout.** `finishWizard()` moved into `tests/e2e/helpers/wizard-generation-outcome.ts` as short browser calls with no embedded wait loops, polled from the host with explicit phase deadlines (15s per navigation phase, 30s for a generation terminal state, 10s for expected output visibility) and no change to the WebDriver script timeout. Each navigation action is clicked once per phase and Generate exactly once, never replayed after a timeout. It scrapes only the owned wizard surface (step, presence, `.crosswalker-results-summary`, `.crosswalker-error-list .crosswalker-error-item`, counts and summary text), returns a structured outcome in which errors and conflicts outrank any partial file count, and treats a vanished modal as a terminal candidate that still requires the expected owned output — zero files cannot satisfy a creation test. A deadline failure reports the last observed step, results, errors and notices rather than a generic `NO_NEXT`. No production test hook and no general harness rewrite.
- **One new isolated E2E declaration, and nothing removed.** An unknown-field JSON filter must reach the results screen with an actionable unknown-field error and zero created notes, proving the wizard-to-engine filter connection and the error reporting without inducing a script timeout. All five existing declarations, the original fixtures, the filtered population, the named JSON selectors, the same-payload XLSX oracle and the JSON absence assertion are preserved, as are the existing quarantines and both archived failed-run directories (19 and 24 files, verified unchanged).
- **A real defect was found by independent review, and corrected: the omission policy was being undone downstream.** The first implementation satisfied direct-render tests while the note actually written to the vault did not match the policy, because a supplemental legacy frontmatter merge downstream of the shim re-added the missing fields as empty strings. Direct-render coverage could not see this. The correction was implemented against new tests that assert the **written YAML of a real generated note** through `generateNotes()` with a populated classic mapping, covering both first import and refresh, alongside a corrected test setting and helper edge cases. This history is recorded rather than erased: the policy is now pinned by written-note evidence, not by rendered strings.
- **Core verification: green.** The corrected implementation's independent source and test review returned **no confirmed blockers**. The correction's own tests were observed red (4 failed / 18 passed) and then green at 22 of 22. Independent focused regressions passed **696 of 696** across 16 suites; the full unit suite passed **3,063 with 2 skipped** across 189 suites passed and 1 skipped; the golden suite passed **61 of 61** across 3 suites; and `bun run lint`, `bun run build` and `bun run codegen -- --check` all exited 0, with 2 generated files checked and no drift. No canonical golden expectation was edited, and the frozen 18-path source/test population and hashes matched before and after every command. Earlier builder-run figures (red 9 of 24, then 24 focused product tests plus 4 helper tests, then 691 of 691) are superseded by these independent numbers and are kept here only as the record of the pre-correction round.
- **Real-Obsidian acceptance: BLOCKED, NO RESULT — neither a pass nor a failure.** The single authorized targeted run of `tests/e2e/visual-wizard-formats.spec.ts` produced **no runner output at all** (0 bytes), **no verdict for any of its 6 declarations** (0 of 6), and **no fresh screenshot or failure capture** (0 changed, against 8 expected names). Obsidian and WDIO stayed alive and near-idle for about 12 minutes; the owned task was then stopped by hand to hold the one-run bound. **No SIGTERM/exit 143 was observed, and there was no retry** (1 invocation, 0 retries). The owned sandbox and launcher-config directories were manually inspected, the orphaned owned Obsidian process was terminated, both directories were removed, and the shared lock was released — no claim is made that a service cleaned them. **The root cause was not isolated.** A stall during harness startup or before the first declaration screenshot is the only inference the empty output supports, and it is labeled as inference. **Nothing here supports a claim that real Obsidian cannot be driven or screenshotted on this machine** — it routinely can; this run simply produced nothing to read.
- **Everything the run was supposed to observe is therefore unobserved.** For the current run that means: the JSON one-note filtered result; the nested `_crosswalker.source_ref` presence; **the `source_hash` absence negative control**; the absent top-level `revoked` / `source_ref` / `target_ref` keys that would have demonstrated the omission policy on real output; the three-note XLSX result and its same-payload Node SHA-256 oracle; and the unknown-field error case with zero created notes. The unfiltered-preview copy was not visually checked in either light or dark theme. **The two earlier XLSX runtime passes remain historical passes and are not withdrawn**, but they are not evidence for this run. No note path or digest was inferred where none was logged.
- **Status as recorded 2026-09-07 — consequently the [XLSX source-byte provenance](#xlsx-source-byte-provenance-2026-09-07) acceptance below stayed incomplete**, its recorded run outcomes stand as written, and both archived failed-run directories (19 and 24 files) are preserved unchanged. *(Everything from here to the end of this bullet is that date's status, not current status.)* **No claim is made that all formats or the whole wizard UI are proven:** the demonstrated path is the ordinary wizard's record filter, and the CSV and XLSX filter controls have no evidence of their own. No full-E2E, mobile, scale, quarantine-clearance, performance, bundle-size or security certification is claimed, nothing is staged, committed, pushed, merged or released, and the v0.1.7 milestone is unchanged.
- **Resolved 2026-09-09 — every item in the two bullets above was subsequently observed, on unchanged files.** A single real-Obsidian rerun passed all six declarations, including the `source_hash` absence negative control, the three-note XLSX result and same-payload oracle, the one-note filtered JSON result with its absent top-level keys and present nested `source_ref`, the unknown-field error with zero created notes, and the unfiltered-preview sentence in both themes. **The 2026-09-07 no-result outcome above is unchanged and its cause remains unisolated** — the later pass is not an explanation of it. Detail, qualifications and scope limits: [Real-Obsidian acceptance rerun](#real-obsidian-acceptance-rerun-the-six-targeted-declarations-passed-2026-09-09).

### XLSX source-byte provenance (2026-09-07)

- **A spreadsheet import now records which exact bytes produced each note.** A native `.xlsx` parse reads the file once, computes `sha256-` plus 64 lowercase hex characters over that complete pre-parse payload **before** anything decodes it, and the value is written to the existing `_crosswalker.source_ref.source_hash`. That field already meant "hash of the source file at import time"; this adds the first live runtime producer for it. **No schema changed** — `spec/tier1.schema.json` is untouched, no `$id` or SchemaVer moved, and the field's long-standing permissive string validation is deliberately left as it is so existing external producers keep validating.
- **Primary and joined worksheets now come from one snapshot.** The parse keeps its captured bytes privately for the life of the returned join handle, and `container.readSheet()` re-decodes from those kept bytes instead of re-reading the external file as it previously did. Every decode receives a disposable copy, so a decoder that writes into the buffer it is handed cannot change what a later join sees. This closes a real hazard rather than a theoretical one: a second read of the same file can return different bytes even when its reported size and modification time are unchanged, which means a control row and its joined owner could previously have come from two different revisions of one workbook with nothing recorded to say so.
- **XLSX only.** CSV, JSON and SSSOM runtime producers are unchanged and do **not** invent a byte digest from decoded text or parsed rows — a fingerprint of decoded output answers a different question than a fingerprint of source bytes. The external fixture generator keeps its own pre-existing raw-byte provenance, unchanged. **The guarantee is per parse, not per wizard session:** `listXLSXSheets()` stays metadata-only, computes no digest, and makes its own separate discovery read, so the snapshot covers the primary sheet and every joined sheet of one `parseXLSXFile()` call rather than every read the wizard performs.
- **Absence means unrecorded, never unchanged.** Native runtime imports without a recorded byte digest omit `source_hash`; existing notes or external-producer output may already contain it. An empty or absent input keeps the existing omission behavior in `src/generation/provenance.ts` (which is itself unmodified). A mixed vault is the expected state.
- **Nothing is rewritten to backfill it.** Existing skip, no-op, kept-host and user-owned-frontmatter preservation stay authoritative; this change adds no write solely to populate the new field. All five live `buildProvenance()` call sites in `src/generation/generation-engine.ts` receive the value — concept rows through both `generateNotes()` and `generateFromRecipe()`, enrichment, hubs, and facet hubs — including the enrichment entry path that spreads recipe options and would otherwise have dropped it silently.
- **Memory cost, stated plainly and unmeasured.** A parse now retains its captured payload — the snapshot's actual byte length, not an assumed file size — while the join handle is reachable, plus transient allocations for hashing and each defensive copy. The decoded workbook is *not* retained; a joined sheet is decoded on demand and released. **No peak-memory, corpus-scale, bundle-size, performance or mobile measurement was taken, so none is claimed.** This is an import-session parsing buffer: not written to disk, settings, a draft or a cache, and not an enumerable property of the parsed result. It is not the retained source copy that the ratified D4 decision gates behind explicit opt-in, and it implies no consent to one.
- **The shared SHA-256 core is now byte-oriented.** `sha256BytesHex(bytes)` in `src/generation/hash.ts` holds the compression body; `sha256Hex(text)` delegates to it through the same existing manual UTF-8 encoder, so every existing text hash, golden value, recipe/concept/review fingerprint and stored ancestry value is unchanged. Padding length is now computed with ordinary number arithmetic plus safe-integer guards instead of a 32-bit bitwise expression that would have wrapped on a very large byte input. `computeSourceByteDigest(bytes)` wraps it through the existing `toSha256Cid()`. No new dependency, no runtime Node crypto, and no async conversion of render hashes; Node crypto appears only as an independent test oracle.
- **What it does not do.** It does not store the source file, diagnose drift against a file selected later, record decode selectors (sheet, header row, filters — two imports of one workbook with different settings digest identically), authenticate anything, or execute replay. It adds no binding, storage, library or UI, satisfies no v0.1.7 Track 2 checkbox, and closes no milestone. Rationale, the worked two-sheet example, and the accepted/rejected/deferred decisions are in the [XLSX source snapshot log](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-09-07-xlsx-source-snapshot-synthesis/).
- **Status as recorded 2026-09-07: core verification passed, the XLSX runtime proof passed, and acceptance was nevertheless INCOMPLETE.** Independent verification passed 118 focused tests; the full unit suite at 3,032 passed / 2 skipped across 185 suites passed / 1 skipped; 61 golden tests; and `bun run lint`, `bun run build` and `bun run codegen -- --check` all clean. An independent read-only review of the source and test changes returned no confirmed blockers. **The real-Obsidian XLSX proof passed on both runs**: the note the real wizard wrote carried a `source_hash` equal to a host-side SHA-256 over the exact workbook bytes the wizard was handed. **Acceptance was incomplete on that date for one reason:** the companion negative control — that a JSON import records *no* `source_hash` — had not executed. On the first targeted run both JSON declarations stopped at Step 1; on the second, with a corrected selector, JSON Step 2 passed but the JSON full loop produced 0 notes and 3 render errors, so the omission assertion was again unreached (second run 4 passed / 1 failed, exit 1). First-run evidence is archived rather than discarded, no declaration was suppressed, and existing quarantines are unchanged. No full-E2E-suite, mobile, performance or bundle-size claim is made; nothing is merged or released, and the v0.1.7 milestone remains in progress.
- **Status update 2026-09-09: the negative control executed and passed, on unchanged files.** The filtered JSON import wrote exactly one note whose nested `_crosswalker.source_ref` was present as `{ file: stix.json }` with **no `source_hash` inside it** — the intended distinction, which is narrower than "no provenance". The XLSX same-payload digest comparison passed again in the same run. **This is a runtime acceptance result only:** no standalone build or other verification suite was run for it, and no unit, golden, lint or static gate was re-run, so the counts above remain the 2026-09-07 figures for this unchanged population. Both earlier failed runs stand as written. Scope limits, the unresolved Tier 2 projection warning and the other independent-review qualifications: [Real-Obsidian acceptance rerun](#real-obsidian-acceptance-rerun-the-six-targeted-declarations-passed-2026-09-09).
- **Historical findings from the two XLSX acceptance runs.** The failing JSON leg was not a `source_hash` regression and was not dismissed as quarantine. Diagnosis found two baseline product gaps and one test-reporting gap on the ordinary (non-workbench) wizard path. The following describes the code at those runs, **before the separately approved repairs above**, not the current implementation:
  - **The JSON row filter is workbench-only.** In `src/import/import-wizard.ts` the wizard's filter field is applied under `if (where && options.recipeOverride)`, and `recipeOverride` is set only in workbench mode — so an ordinary wizard import silently carries no filter. This is established from the code path; the actual `where` field value was not logged during the run, so no separate live-field witness is claimed. The adjacent source comment describing one predicate for CSV, XLSX and JSON alike describes the intent, not the reachable behavior. **Scope of what was demonstrated is the JSON ordinary-wizard path** — do not generalize it to the CSV or XLSX UI controls without its own evidence.
  - **Auto-generated frontmatter templates break on a heterogeneous JSON column union.** Fields present on only some objects fail to render for the objects that lack them; the observed render errors named `revoked`, `x_mitre_is_subtechnique` and `name`. **No fix policy is adopted here** — in particular, no blanket allow-missing behavior.
  - **A generation failure is reported as a timeout.** `finishWizard()` in `tests/e2e/visual-wizard-formats.spec.ts` runs as one long browser script, so a failure inside generation surfaces as a 30-second timeout rather than the underlying error, which is why the second run's driver message did not identify the underlying render errors. No repair to it was authorized in this slice.

  At that diagnosis, the implicated wizard, source-stage and template files were byte-identical to `285592cd`. The narrower statement about the XLSX slice was that **its new digest wiring was not the cause** — not that the changed runtime files were off the failure path, since `src/generation/generation-engine.ts` was on it. A scoped repair was subsequently approved and implemented; see [Ordinary import repairs](#ordinary-import-repairs-the-filter-is-used-and-a-missing-field-is-left-off-2026-09-07) above. Its core checks passed, and the Obsidian invocation on that date produced no result. **The acceptance case was reached and passed on 2026-09-09** — see [Real-Obsidian acceptance rerun](#real-obsidian-acceptance-rerun-the-six-targeted-declarations-passed-2026-09-09).

### Recipe-document digest — first implementation slice, locally verified and unmerged (2026-09-06)

- **A whole-recipe revision fingerprint now exists.** `computeRecipeDocumentDigest()` in `src/generation/hash.ts` returns `sha256-` plus the SHA-256 of the canonical serialization of a complete recipe. It is pure and synchronous, adds no dependency and no Node crypto at runtime, and performs no field stripping of its own. **It neither validates nor normalizes its input**, which matters for any external producer calling it: the caller must supply a recipe that has already been validated and put through `normalizeRecipe()`. The module graph stays acyclic — `recipe-document.ts` imports `hash.ts`, never the reverse.
- **Normalized defaults are part of the identified revision.** Because normalization runs first, an omitted default and an explicitly written equivalent default digest identically (`spec_version`, `target.linkStyle`, the folder `variadic` defaults, and the `also_emit.body` defaults). Object key order and file whitespace do not change the digest; array order does.
- **Two optional reference fields, both strict.** `metadata.based_on.recipe_document_digest` in `spec/recipe.schema.json` (SchemaVer 1.10.0) and `_crosswalker.recipe.recipe_document_digest` in `spec/tier1.schema.json` (SchemaVer 1.4.0), each `^sha256-[a-f0-9]{64}$`. Existing recipes and notes without them still validate and neither schema `$id` changed. **The older Tier 1 `recipe.hash` was deliberately left permissive** — strict validation applies only to the new field.
- **Existing hash meanings are untouched.** `computeRecipeHash()` still covers only its reduced effective-target slice and answers "did output-affecting behavior change?", so a changed recipe id or ancestry moves the document digest while leaving the effective-target hash fixed. No stored hash or ancestry value changes meaning. A recipe never carries its own digest, and nothing is stripped before hashing.
- **One emitter, and no note stamping.** Only the existing fork branch in `patchRecipeDocument()` writes the new ancestry digest, computed from the normalized original before the descendant's edits; fresh documents still get no ancestry and no-op patches mint nothing. The Tier 1 field is contract only — no generation path stamps it. This slice adds no recipe storage, recipe-library UI, source retention, or replay execution, and does not close any v0.1.7 track.
- **Status: locally verified, still unmerged and unreleased.** Independent verification passed: 140 focused tests across six suites; the full unit suite at 3,007 passed / 2 skipped across 184 suites passed / 1 skipped; 61 golden tests; `bun run lint`, `bun run build`, and `bun run codegen -- --check` all clean with no generated drift; a fixture-drift run reporting no drift, in which 8 regenerated Tier 1 notes were validated *before* restoration and all 11 known pre-existing files were verified byte-identical; and all six static documentation gates passing. **Not claimed:** no end-to-end, mobile-runtime, or UI verification was run, the fixture check proves the known bytes rather than the absence of additional files, and there is no replay, storage, retention, or revision-chain behavior to verify because none is implemented. Nothing here is merged or released.

### Save and exact replay — Gate 1 ratified (architecture decision only, no runtime delivery) (2026-09-06)

- **The four Gate 1 decisions are settled and recorded**, with rationale and non-commitments in the [Gate 1 ratification log](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-09-06-save-and-exact-replay-gate-1-ratification/): a separate recipe-revision digest that leaves every existing hash and ancestry meaning intact and accepts one wire syntax; a closed binding field set with no free-form parameters; managed-content equivalence as the only replay promise; and source retention that supports both verified reselection and optional retained copies, requiring explicit opt-in before any retained copy of a source file is stored.
- **Nothing was implemented.** No schema field, hashing, binding, storage, or UI code changed; `spec/` is untouched. This unblocks writing the design specification only. Gate 2 (lineage semantics, legacy saved-setup coexistence) and Gate 3 (audit manifest overlap, signing default) remain open, and the v0.1.7 milestone is not closed.

### Vault-root CSV and crosswalk exports passed scoped runtime verification and remain unreleased (2026-09-06)

- **The two older folder exporters now identify the vault root through Obsidian's root-folder API.** Both registered commands selected Obsidian's actual root (`path: /`, `isRoot(): true`) through the friendly `/ (vault root)` picker choice. CSV wrote `vault.export.csv`; the crosswalk mapping command wrote `vault.export.tsv`. Their expected headers and unique synthetic rows were present, source-note bytes were unchanged, and existing hidden-style `.export.csv` and `.export.tsv` bytes stayed untouched. Non-root sibling names are unchanged.
- **Replacement policy is unchanged.** These older commands still replace an existing corrected destination by default, without the typed mapping command's confirmation step. Existing hidden-style files are not migrated, deleted, or modified automatically.
- **Verification is scoped to this correction.** The original source-identical verification wave passed 27 focused tests, the full unit suite with 2,988 passed and 2 skipped, lint, and production build. Those checks were not rerun after the later test-only fixture simplification. The final targeted runtime run passed both export specs, all four real command scenarios, and teardown; all six static gates and diff checks also passed. This is not a full-E2E or quarantine-clearance claim, and the correction remains unmerged and unreleased.

### Typed mapping table export passed scoped runtime verification and remains unreleased (2026-09-06)

- **A new command exposes the existing typed mapping table exporter:** **Import and export: export folder as a typed mapping table**. It writes a sibling named `<folder>.export.typed-mappings.tsv`, or `vault.export.typed-mappings.tsv` for the vault root. The distinct name does not replace the existing crosswalk mapping file at `<folder>.export.tsv`.
- **Existing output is replaced only after explicit confirmation.** Cancelling or closing the confirmation writes nothing. A new destination is create-only, so a file that appears during the write race is refused rather than silently modified. A folder or other non-file item at the destination is also refused.
- **Result messages follow completed work.** Zero exportable rows never create or replace a file, even when notes were skipped. Success is shown only after the write settles; read and write failures provide a next action without exposing raw host errors or claiming that a failed write changed nothing.
- **Scoped verification is green.** Lint and production build passed; 18 focused tests passed; the full unit suite passed 2,979 tests with 2 skipped; and both targeted real-Obsidian tests passed. The registered command opened the real folder picker, exported deterministic nested-folder rows, preserved source notes and the distinct crosswalk TSV, preserved prior output when replacement was dismissed with Escape, and replaced it only after confirmation. The same command selected Obsidian's actual vault root (`path: /`, `isRoot(): true`) and wrote `vault.export.typed-mappings.tsv` without replacing a pre-existing root output. This root evidence applies only to the new typed mapping command, not the older CSV or crosswalk export commands. All six static documentation gates and diff checks passed, and eleven scoped file hashes remained stable through verification.
- **This is not a release claim.** The changes remain unmerged and unreleased. The verification does not establish Excel behavior, large-source performance, a byte-identical STRM round trip, or completion of v0.1.7.

### The safety work on that defect now passes every check that was run, and is still not released (2026-09-04)

This continues the section below. It does not restate it: read that one for what the original defect was and what to do if you already have imports sitting in your output folder.

**What is new is a measurement, not a release.** The work to make the per-import-folder fix safe for a vault that already holds imports was measured against the bar written down in advance, and it meets every check that was actually run: 2,961 unit tests passing with none failing, a clean build, a clean lint, and a full run of the Obsidian walkthroughs in which 175 checks pass, none that passed before now fails, and none that used to be checked has gone missing. **It is not a claim that everything is safe.** Seven long-standing quarantined visual walkthroughs still fail, four large-corpus walkthroughs did not run at all, and the branch is not merged. What follows is what changed for you, and what is still not covered.

**Your own notes are no longer rewritten by a refresh that changed nothing.** When a framework's folder has a note of yours sitting beside it, Crosswalker maintains a contents list on that note. It used to rebuild the whole note to do it, which quietly rewrote your properties even on a run that imported nothing new: a date-shaped value gained quotes, comments and blank lines disappeared, a value written across several lines was folded into one, and a file saved with Windows line endings came back with Unix ones. It now edits only the two blocks it owns and copies every other line through exactly as you wrote it, keeping the line endings the file already had. A refresh that changes nothing now leaves every note byte-for-byte identical, index notes and their timestamps included.

**A note it cannot read is reported, not half-written.** If the markers around that contents list are damaged, Crosswalker says so and writes nothing to the note, instead of quietly updating one half of it and leaving the other stale. Previously a damaged marker was treated the same as a note that simply had no contents list.

**A home note you renamed is named once, not reported missing.** A framework's home note whose identity you had edited by hand used to be refused and, on the same results screen, listed as gone from your source. The identity it carries is now recorded where the results are counted, so it is left alone and mentioned once.

**Older items in this arc that were listed as still-broken and are now closed:**

- **A crosswalk import no longer silently drops edges.** Several mappings that reduced to the same generated file name were written into one file and the last one won, with nothing said. A mapping is now identified by the pair of controls it connects rather than by the two file names it was built from, so mappings your source says are different stay different.
- **An identifier can be read back out of a vault and still mean what your source said.** When a second release of a framework is imported alongside the first, its identifiers are qualified so the two do not collide. That qualification is now reversible and recorded rather than applied silently, and a declared prefix is checked against the framework it claims to belong to, so exporting and re-importing returns what went in. Previously a set that had been qualified could not re-import its own export at all.
- **Updating an evidence link keeps your review fields exactly as they were.** The evidence window now updates a link through the same merge the importer uses, so the reviewer, review date, confidence, expiry, notes and scope you recorded survive an update byte-for-byte unless you changed them in the window yourself.

**What is still not covered, plainly:**

- **Not released.** This lives on an unmerged branch. Nothing here is in a version you can install.
- **Seven visual walkthroughs still fail** and are the same seven, in the same six files, that have failed throughout. None was fixed and none was removed from the quarantine list.
- **The large-corpus walkthroughs did not run.** Four of them, three release-blocking, have not been exercised since 2026-08-27.
- **The Windows-line-ending case and the damaged-marker case are covered by unit tests only.** No walkthrough inside real Obsidian exercises either shape.
  - **Follow-up recorded 2026-09-05:** the [new runtime tests](tests/e2e/kept-host-preservation.spec.ts) now cover a Windows-line-ending host on an unchanged refresh and a one-row addition, plus a duplicated end marker with and without a `children:` key. All four cases pass inside real Obsidian through the production importer, not a wizard click-through. The full default run adds exactly those four passing checks with no regression or missing check. This is additional test coverage, not new production behavior or proof of every damaged-marker shape. The existing quarantined failures remain.
- **One boundary is unresolved rather than proven safe.** If a note that Crosswalker does not record as its own were ever reached by the writer that appends a properties block, one line break on a Windows-line-ending file would be wrong. No route to it was found through the checks that exist today, and no route was proven impossible either. It is cosmetic if it ever happens.
- **Two behaviours are deferred**, not fixed: what a replace-mode run observes about grouping notes, and a grouping note dragged to the top of your vault, which is still not seen.

### Known defect, mostly closed: each import now gets its own folder, but an existing vault needs care (2026-08-28, amended 2026-08-29, five times on 2026-08-30, and three times on 2026-08-31)

The original defect is fixed and the fix is verified against a real run. It is recorded here rather than rewritten as a plain feature entry because it is not safe to apply blindly to a vault that already holds imports, and because one form of the original problem survives untouched.

**The work to make it safe for a vault that already holds imports has now been attempted nine times.** Each attempt was measured against a bar written down in advance rather than a checklist. Each has ended one level below the last, and at every level the thing that had to be removed was the same thing: something deciding a fact instead of reading one.

All nine attempts rest on the same rule, which is the durable result of the work and is not in question: **refreshing a collection you already have never changes where that collection lives.** Its folder is read from the notes it already owns and then remembered, so a refresh has nothing to move and nothing to leave behind, and moving a framework somewhere else becomes something you ask for rather than something that happens to you.

**Who owns an import is settled and end-to-end verified, and so is what a write is allowed to touch, on every window that imports.** The first four attempts each tried to work out which collection an import belongs to and were each defeated by a case the previous one had not thought of; the fifth found the one place underneath all four that was guessing and deleted it. The sixth and seventh went lower again, to the part of the importer that places each note, which never consulted collections at all: it searched the whole vault for the identifier it was about to write, and, failing that, used whatever happened to be sitting in the spot it was aiming at. Both are closed, and that was the end of the descent, because placing a note asks nothing else. The eighth carried the same rules out to the windows beside the importer, which had never had them: the window that links evidence, the one that writes coverage reports, and the two that create collections without asking the qualification question. The ninth gave those windows the last thing they were missing, which was an identity worth refusing on: an evidence link is now named after the control it is about rather than after two file names. What still blocks is not one level further out. It is at the beginning: **the name every one of these rules compares, refuses on, and stamps is itself computed from a file name**, in the importer, and has been since the importer was written. It is described below.

What is true today, verified by deliberately sabotaging each rule below in turn and watching its own tests fail. The rules in the first eleven bullets were also confirmed by a full end-to-end run of 47 walkthroughs in which seventeen previously failing checks turned green and none turned red; **the last four have their own tests and have not been through such a run**, for the reason given at the end of this section:

- **Each import gets its own folder** inside your configured output path, and your setting stays the parent.
- **A second framework always lands as its own collection.** Not usually, and not unless something matches: there is no longer any code path that can decide otherwise. Ownership is decided on screen, by you, and the importer carries out the decision.
- **Refreshing is something you choose from a list.** The ownership step shows every collection in your vault with its folder, how many notes it holds, and what produced it. When exactly one of them looks like the file you picked, a single line offers it: *"Looks like this one. Refresh it instead?"* Crosswalker may suggest; it never decides.
- **The same rule applies on every window that imports**, including the one used for mappings between two frameworks, which previously adopted whatever shared the folder and overwrote it. A new mapping is written without touching what is there, and only a refresh you chose replaces anything. The bundled-example command names its own collection too, so loading a sample can no longer replace a real import.
- **A refresh never moves your existing notes**, because a collection keeps the folder it already lives in.
- **An import never merges into, moves, relocates, or relabels a note it does not own, whether it finds that note by identifier or by landing on the same file path.** Both are how a note can be reached, and there is no third way. Placing a note looks only at the notes the collection doing the importing already owns, and then reads who owns whatever is sitting in the spot it is about to write. Refreshing your own collection's note in place is unchanged; anything else is refused and named. **You are told by name when it declined**: which note, and either the collection that owns it, or that the note is yours rather than Crosswalker's, or that it came from an import made before collections existed. Nothing is written for it. Grouping and home notes follow the same rule.
- **Two releases of one framework coexist.** A new collection whose identifiers would collide with an existing one is created with its identifiers qualified, and that now happens whether you confirm the choice on screen or never touch it. Previously, reading the screen and confirming the default was the one way to turn it off. **Every window that creates a collection now asks that question the same way**, from one place: the import window, the mapping window, and the bundled-example command. The mapping window used to answer it by looking at whether the destination folder was empty, so dragging that folder elsewhere in Obsidian was enough to make the next import of the same pair collide with the one you moved.
- **A note whose properties are damaged is asked to be fixed, not disowned.** If Crosswalker cannot read a note's properties, it now says so and asks you to repair the note and import again. It no longer tells you the note is not Crosswalker's, and no longer asks you to move or rename your own imported note. Nothing is written for it either way, and the run continues. The coverage-report writer now gives the same answer about a damaged report, where it previously said a note Crosswalker did not generate was in the way and asked you to move it.
- **The evidence-link window refuses instead of overwriting.** Linking a control to a piece of evidence used to replace whatever note was sitting at the location it picked, in full, while reporting that it had *updated the existing link*. It now checks that the note already there is the link being written, and refuses by name otherwise: another collection's note names its owner, your own note says it is not Crosswalker's, and an unreadable note is asked to be fixed. Regenerating a coverage report refuses in the same way when a note that is not a generated report shares its name and folder.
- **The finish message states what moved and what is missing**, on every run, and says *orphans not checked* rather than *no orphans* when the check could not run. **Errors are always shown**, on a screen, rather than counted and closed over. The bundled-example command was the last path that closed over its own errors and now states how many notes it wrote, how many it refused, and the first few reasons.
- **"We have not looked yet" is no longer read as "there is nothing there."** If your vault is still being indexed, the import waits, and refuses with an indexing message rather than acting on an unfinished answer.
- **An evidence link is named after the control it is about, not after two file names.** Two releases of one framework hold two controls with the same file name, and linking evidence against the second used to replace the first release's link in full while reporting that it had updated it: the approval, the reviewer, the date, the review baseline, and anything you had written. The two are now different links and both survive. Links written before this change are still recognised in their old form and updated where they sit, so nothing is duplicated by the change itself, and a link written under the old name is only adopted when the note itself says it is about this control and this evidence.
- **The evidence window looks for the link before it creates one.** Move a link note anywhere in your vault and the next link for that pair updates it where it now is, and says so. Previously it found nothing at the place it expected and wrote a second note carrying the same identifier, which made every later import report an ambiguity that no screen explained.
- **The rule that creates a collection will not answer while your vault is still being indexed.** It waits, counts again, and refuses with the indexing message rather than reporting fewer collections than you have. That refusal now lives inside the rule, so the mapping import and the bundled-example command cannot skip it.
- **Re-baselining a reviewed link checks that the note is that link.** The housekeeping re-baseline used to take its list out of a previously generated report and write the new review baseline to whatever note now sat at each of those locations. It now compares each note's own identifier first and refuses the whole selection by name if any one disagrees, saying which two links it saw or asking you to repair a note it could not read. It is the only place in the plugin that records an attestation fact, and it no longer records it by address.

**None of it is offered here, because the identifier of an imported control is itself computed from the name of the file it lands in. That is the same defect as the four just closed, one step earlier, at the point every rule above reads from.**

- **Two controls your source says are different can end up with one identifier.** The name of a control is worked out from its file name, and a file name cannot contain a slash, so `A.9.2/1` and `A.9.2-1` become the same name. Both notes are still written, because nothing checks within a single import, and from the next import onwards every run stops on an ambiguous identifier it will not resolve, naming two files and no cause. Whitespace, a leading dot, and a trailing `.md` collapse the same way. Sources whose identifiers are plain letters, digits, dots and hyphens are unaffected, which is why no bundled framework shows it. Supplying the identifier explicitly in your source does not help on the ordinary import path, which does not read it, and is still put through the file-name rule on the recipe path.
- **Two mappings between different pairs of controls can end up with one identifier.** A crosswalk mapping is named by joining its two endpoints with a hyphen after removing every character a file name dislikes, so `A.9.2.1` and `A-9-2-1` become the same endpoint, and there is no boundary between the two halves that cannot also occur inside one of them. Reconciling the same control written two ways is the ordinary reason to have a crosswalk at all, so this is reachable with one well-formed mapping file.
- **Two releases of one framework still land in one folder.** They no longer take each other's notes, because the second run refuses every note it would write over and names the collection that owns it. But the folder is still derived from the name of the file you imported, so the two still meet there, loudly, on every run.
- **"Stop on conflict" moves your notes and then refuses to write.** The setting that means *touch nothing when something is already there* is the one that relocates most, because the move happens before the refusal is raised.
- **The reset tool decides what to delete by looking for a word in a note's text.** *Reset imports* offers to remove imported notes. When a note's properties cannot be read it falls back to searching the whole note for a line beginning with Crosswalker's marker, so a note of your own that quotes or documents that marker anywhere in its text is offered for deletion, and a generated note with damaged properties is deleted rather than skipped. Deletions go to your configured trash, and the tool is a maintenance command rather than part of importing.
- **Neither suite was run against this change.** The last real measurement stands and is from before it: the unit suite green at 2,483, and the end-to-end suite at 167 passing with 8 failures, all of them the long-standing quarantined visual walkthroughs. Every unit test file touched by this change passes on its own and 59 new tests cover it, with all 33 sabotage checks killing at least one of them, but the whole unit suite and the end-to-end suite could not be run: the machine's disk filled to capacity during the run from an unrelated project, and a run started in that state produces failures shaped exactly like the ones this change would cause, which would have made the result unreadable rather than merely absent. **The change is therefore tested and not verified**, and that is part of what blocks it, alongside the items above.

So the guidance below still stands in full. If you have existing imports, the paragraph beginning "If you already have imports sitting directly in your output folder" is the thing to read.

**What was wrong**

- **Each import is supposed to nest under its own folder inside your output path. It did not; it wrote straight into the shared folder.** That rule was set deliberately and the code implementing it was correct and covered by tests, but the wizard filled the destination in before that code was ever consulted. The code ran only when the destination was empty, and the destination shipped with your configured output path already in it. It was never empty, so the rule never ran, for anyone, ever.
- **The visible consequence appeared on your second import, not your first.** Once the output folder held one imported collection, the wizard preselected "refresh that collection" for the next import. Importing a second, unrelated framework would attribute it to the first one and then report every control in the first framework as missing from the new source.
- **On a third import it stopped you.** Two collections in one folder is genuinely ambiguous, so the wizard required you to say which one you meant and would not continue until you did. The requirement was announced only by a brief notice when you pressed the button, which is easy to miss.
- **Nothing was ever deleted.** Controls that no longer appear in a source are listed for you to look at, never removed. This was a misattribution and a misleading change list, not a loss of your notes.

**What changed**

- **The wizard now remembers whether you chose a destination, instead of guessing from whether the box looked empty.** If you have not chosen one, your import gets its own folder inside your configured output path, named after the file you are importing. Your setting stays the parent folder, so a customised output path is still honoured.
- **What you are shown is what gets written.** The recognised-source card, the destination breadcrumb, the preview, the folder tree, and the final confirmation now all read the same answer from one place, so two screens can no longer name different folders. The destination is never displayed blank; if you have not chosen one, you see the folder your import will actually land in.
- **A recognised source now uses the folder curated for that framework, inside your output path.** Previously that curated folder was discarded in favour of the shared root. Crosswalk mappings and evidence junction notes keep their own homes outside the output path, because those are not framework output and relocating them would move the mapping and evidence surfaces that read them.
- **Verified in a real Obsidian run, not only in unit tests.** An import that previously wrote into the shared `Frameworks` folder now writes into `Frameworks/attack-mini`. One end-to-end test that had never once been able to finish an import now finishes it, because the ownership question it could not answer no longer arises. The full end-to-end suite finished at 167 passing, 26 skipped, and 8 failures that are the pre-existing quarantined visual specs, unchanged. The unit suite is green.

**What is still true, and what to watch for**

- **If you already have imports sitting directly in your output folder, your next import will not recognise them.** It resolves to the new per-source folder, finds nothing there, and treats the import as a brand-new collection. On the default *skip* setting your existing notes stay where they are and only new rows land in the new folder, leaving one collection split across two places. If you select *replace*, your notes are moved into the new folder instead. Neither case deletes anything. To keep everything where it is, type your existing folder into the destination box; a destination you type is remembered as your choice and is not overridden.
- **The "home" and grouping notes an import creates are matched by location rather than by what they are, so a change of destination copies them instead of moving them.** Two notes with the same name make any existing link to that name ambiguous, and Obsidian picks one. This affects only vaults imported before this change, and only on the first import after it.
- **When a note is skipped, the summary can name the folder the note would have moved to rather than the one it is in.** On the default *skip* setting your notes are left exactly where they are, which is the intended behaviour, but the "skipped" list on the results screen is written from where the import was aiming. If those two differ, the summary lists folders that do not exist. Nothing was written to them; the list is describing an intention rather than an outcome. This is longstanding and is not new with this change.
- **Two renderings of the same framework still share one folder.** The curated folders are per framework, not per source layout, so importing the hierarchical NIST CSF export and then the flat one both land in `NIST CSF 2.0`, and the second is offered as a refresh of the first. That is the original defect intact, in the recognised-source path only. The same holds for two unrelated files that happen to share a name, since the folder is named after the file.
- **Renaming your source file makes the next import look like a new collection**, because the folder is derived from the file name and a collection does not record where it lives.
- **Changing the source file after typing a destination keeps the destination you typed**, which would send the second source into the first one's folder. Clear or retype the destination after switching files.
- **A recognised crosswalk or junction import now writes outside your configured output path**, so it does not appear in the installed-frameworks list or the status-bar count, and the *Reset imports* tool will not offer to clear it.

### The empty-vault walkthrough now runs only where it makes sense (2026-08-28)

- **The first-run regression test was being run twice, and one of those runs tested the opposite of its purpose.** `tests/e2e/first-run.spec.ts` exists to observe what someone sees with nothing set up. The shared test configuration picked it up by filename pattern and ran it against the seeded test vault, which already contains the frameworks the spec asserts are absent, so it failed there for the one reason that is not a defect.
- **The shared configuration now excludes it; the configuration that owns it clears that exclusion.** Verified by three runs: the shared configuration finds no spec to run when pointed at it, its own configuration runs it green, and the exclusion does not over-match, with the continuous-integration smoke spec still discovered and passing.
- **Its stability is not claimed.** On two consecutive runs of the same command on an idle machine, one passed in seconds and one hung on the first screenshot with an unresponsive renderer. That is recorded as open rather than fixed.
- **The seeded test vault was writing to a folder nothing ever read.** The seed wrote its notes to `Frameworks/` while the configured output root shipped as `Ontologies`, and nothing overrode it, so installed-framework discovery, the status bar and orphan scanning were scanning an empty folder for the whole life of the suite. The seed now writes to the root the product actually reads. Verified with a full baseline run, the one-line fixture change, then a full re-run: spec-file verdicts were byte-identical (41 passed, 6 failed, both times, the six already in QUARANTINE.md), and the one declaration that moved went from a vacuous failure (an empty installed-frameworks list) to a real, substantive one.

### Resetting the search data now actually deletes it (2026-08-28)

- **The maintenance reset announced success over work it had not done.** *Maintenance: reset search data* exists to throw away Crosswalker's derived search data so it can be rebuilt from your notes. It was deleting nothing at all. It looked for the index in one place while the index was being kept in another, found nothing there, and still showed "Fast query index cleared." Every row the reset was meant to destroy survived, and the next query was answered out of it.
- **The reset now removes the index where it actually lives, plus any partial write left beside it.** It closes the live connection first, so nothing keeps answering out of data you asked to destroy, and it deletes only Crosswalker's own index rather than clearing everything stored alongside it.
- **It re-checks, and reports failure instead of claiming a success it cannot see.** After deleting, it looks again; if the index is still there the command fails and names what survived. The message now distinguishes three outcomes that are genuinely different: something was deleted, there was nothing to delete, or the index was only ever held in memory for this session. A reset that cannot prove it happened must never look like one that did.
- **Resetting while the index is being rebuilt no longer produces two contradictory messages.** Rebuilding walks every note and pauses regularly so the interface stays responsive, and a reset landing in one of those pauses used to pull the file out from under it: the reset reported success while the rebuild reported a failure, side by side, to someone who had done nothing wrong. The reset now asks the rebuild to stop and waits for it, which takes a moment at most. A rebuild that is called off is reported as stopped rather than failed, and a rebuild cannot start while a reset is underway.
- **Acknowledging housekeeping changes survives a reset happening underneath it.** That action asks you to confirm, and a confirmation box waits as long as you do. It used to keep hold of the search index across that wait, so resetting the index in another window left it writing into something that no longer existed. It now takes a fresh hold after you decide, because waiting for a dialog would mean a reset could hang indefinitely on one.
- **If only the index update fails, you are told your notes were updated.** Your notes are the record and the index is rebuilt from them, so those are different outcomes. Reporting the whole action as failed, when the baseline was in fact written to your notes, invites running an audit action a second time when it already took effect.
- **A rebuild that stops early never removes anything.** A complete rebuild also clears out entries for notes that no longer exist, which is only correct when it has actually seen every note. One that was called off has seen a fraction of them, so it now removes nothing and records itself as a partial pass. Without that rule, cancelling a rebuild would have quietly deleted entries for notes that were still there.
- **Losing this data is safe by design, and always was.** Your notes are canonical. The next query rebuilds the index from them, which is exactly why the silent failure was so easy to miss: nothing downstream ever complained.
- **It works for any path you can set, not just the default one.** The index is stored under a name derived from the *Query index file* setting, and characters like spaces are escaped in that name. A first version of this fix rebuilt that name by hand and got the escaping wrong, so a path such as `Vault Notes/.crosswalker.sqlite` matched nothing, deleted nothing, and reported that there was nothing to clear. Since the setting has a folder picker attached, a space in it is ordinary rather than exotic. The name is now derived by the same rule the storage layer itself uses, so the two cannot disagree.
- **A reset that cannot reach the index says so, rather than reporting it discarded.** The storage also refuses to open while another vault window is holding it, and it remembers that refusal for the rest of the session. Reading that as "there was nothing stored" would tell you your data was thrown away while every row survived on disk, so it is now reported as a failure that names the likely cause. The one case where "nothing was persisted" is claimed is when this session demonstrably ran in memory only, which is knowledge earned rather than inferred from a store we cannot see.

### Infrastructure: every internal documentation link now has to resolve (2026-08-28)

- **New `bun run check:links` gate.** It resolves every internal link in the documentation against the filesystem and fails on the misses. Astro builds and deploys a page full of broken internal links without complaint, and Starlight does not validate them either, so the failure was silent by construction: the site went green, deployed, and the only signal was a reader landing on a 404 nobody heard about. That is how 68 files came to point at challenge briefs archived out from under them, across eighteen briefs and months of archiving, with every existing gate passing the entire time.
- **The front doors are in scope, not just the site.** README, ROADMAP, and both agent-instruction files are scanned as well, on the grounds that the reader with the least context is the one following a link in from the front door. 4,947 internal links are checked in about a second, with no build, no browser, and no network, and it runs in CI beside the other static checks.
- **Two deliberate limits, documented where the exemptions live.** It does not check heading anchors: Starlight's slug normalization makes false positives likely, and a gate that cries wolf gets waved through when it is finally right. And it knows the routes the blog and tag plugins generate at build time, which have no file on disk. Without that second exemption it reported two links that work perfectly in production.

### A successful first import now becomes a usable product state (2026-08-28)

- **Installed frameworks are derived from generated-note identity, not folder shape.** A flat recipe can write notes directly into the configured output folder and still appear immediately in the workspace and status bar. Hierarchical layouts continue to work, notes are grouped by their CURIE prefix, and hand-authored folders without Crosswalker provenance stay excluded.
- **Evidence coverage refreshes its own report data before reading it.** The explicit command no longer depends on the one-time background refresh that ran when the vault opened, so a framework imported moments ago reaches a report without a hidden rebuild step. This explicit refresh also works when background refresh-on-load is disabled.
- **The command palette separates normal work from maintenance and developer tools.** Commands now lead with plain categories such as Start here, Evidence, Import and export, Maintenance, and Developer tools; internal storage vocabulary is removed from command names.
- **The empty-vault E2E walkthrough is now a regression test.** It imports a real 12-row NIST 800-53 slice through the visible wizard, then asserts that the workspace lists NIST, the status bar says one framework, and the coverage command opens the report.

### A changed-control queue now says what kind of review it needs (2026-08-28)

- **The release-change warning stays conservative, but the queue is now usable.** Crosswalker still compares the normalized whole source row and still flags every approved link whose row changed. It now explains each flagged link as one highest-priority kind: wording changed, recipe-managed scope changed, or only remaining source housekeeping changed. The recipe is the declaration: body projections mean wording; managed frontmatter and managed links mean scope; everything else means housekeeping.
- **The real ATT&CK 15.1 → 16.1 queue splits 427 changed attestations into 57 wording, 110 scope, and 260 housekeeping.** All 637 surviving techniques are accounted for: 210 are unchanged, no changed attestation disappears, and none appears twice. The 57 wording rows match the measured description changes. ATT&CK's publisher `version` column is managed as `technique_version`, so version-only movement is correctly a scope change under the recipe rule rather than a special-cased housekeeping change.
- **The evidence report presents wording, scope, then housekeeping, with a count on every heading.** The whole-row comparison remains the only gate that decides whether a control changed. The smaller fingerprints explain an already-detected change; they cannot make a changed row look unchanged.
- **Housekeeping changes can be acknowledged without inventing a review.** Select only the housekeeping rows you intend to dismiss and run **Record selected housekeeping changes as baseline**. Crosswalker validates the entire selection, asks for confirmation, writes the current whole-row and explanation fingerprints to the selected canonical link notes first, then updates the query index. It does not change link status, reviewer, review date, coverage, or any unselected row.
- **Older baselines remain valid and conservative.** A changed link that predates the explanation fingerprints is classified as wording, not housekeeping, so it can never enter the dismissal path without evidence. Links with no recorded baseline still count and remain named as `unrecorded`; vaults that use none of this keep their previous behavior.

### A control that was replaced now tells you what replaced it (2026-08-28)

- **When a framework restructures, your evidence stops pointing into thin air.** Import the new release alongside the old one and the old controls are left behind, which leaves every evidence link on them dangling. Until now the coverage report said only that those links pointed at something that is not an imported control. It now recognises when a later release says the control was replaced, reports the reason as `subject-superseded`, and lists the replacements in a new "Links whose control was superseded" section.
- **Crosswalker lists candidates. It never moves your evidence.** Re-pointing an approved claim at a different control would be manufacturing an attestation on somebody's behalf, in the one report whose reader is an auditor. You are shown what a replacement mapping asserts, how many links are affected, and whether each replacement is one hop away or several releases down a chain. Choosing among them is a review, and it stays a human act.
- **A replacement nobody asserted is never guessed.** A control that dangles with no lineage mapping at all keeps its old, blunter reason and the report says no successor is known. Crosswalker does not infer a replacement from a similar-looking identifier, and a mapping that explicitly says *"this did NOT replace that"* is never followed.
- **A replacement named by a mapping but not imported in your vault is still listed, by identifier.** Dropping it would print "no successor known" over an assertion your vault actually holds, which is the one wrong answer this section exists to prevent.
- **Version lineage is expressed as an ordinary crosswalk, so it is shareable, reviewable, and provenanced like any other mapping.** Two relationships were added to the closed crosswalk vocabulary: `superseded_by` and its inverse `supersedes`. A rename is one mapping row, a split is one row per replacement, and a merge is several old controls pointing at one new one. Splits and merges were the reason a simple "previous id" field was rejected: it cannot express either. Nothing about how mappings are imported, stored, queried, or provenanced changed to accommodate this; lineage travels the existing mapping-set path, and the successor walk is the existing transitive-closure query with a depth limit of 5.
- **Lineage is refused by the two standards exporters instead of being mistranslated.** OLIR/STRM and SSSOM are both vocabularies about how two concepts' scopes overlap, and neither has a word for replacement. Exporting a withdrawal record through either would previously have produced the auditor-facing claim that a withdrawn control and its replacement *intersect* or are *related* — silently, because the lookup tables involved could not be type-checked. Those rows are now excluded from both exports and reported as skipped, by name, with a test that asserts the fabricated strings are absent.
- **Existing vaults are unaffected.** Adding relationship values to a closed list only admits documents that were previously rejected: every crosswalk that validated before still validates, and the schema identifier is unchanged. A vault with no lineage mappings reports exactly as it did. The one internal consequence is that cached transitive-query results computed before this change are recomputed rather than reused, because the relationship table they were computed from has changed and a cache key that ignores its own inputs is a bug this project has already fixed once.

### Real published lineage: NIST CSF 2.0 withdrawals import as replacement mappings (2026-08-28)

- **The first shipped lineage mapping set is a real one, not a fixture.** NIST CSF 2.0 retains 79 withdrawn CSF v1.1 subcategories and, for each, says in prose which 2.0 subcategories replaced it: `ID.AM-06: [Withdrawn: Incorporated into GV.RR-02, GV.SC-02]`. A new bundled recipe, `nist-csf-2-withdrawal-lineage`, turns those 79 statements into 127 replacement mappings.
- **The splits are the point.** 45 of the 79 are simple renames; the other 34 name two to five replacements each. One "previous id" property could not have expressed a single one of them. As mappings each replacement is its own row, so the report can say which of the five successors is which, and a merge (three withdrawn subcategories all replaced by `PR.AT-02`) is three rows pointing at one control.
- **Nothing in the import path had to learn about lineage.** The recipe uses the same crosswalk note shape, the same row-selection predicate, the same rendering engine, and the same document schema as every other mapping import. That was the claim being tested when release lineage was modelled as an ordinary crosswalk, and on a real publisher source it held.
- **The lineage is attributed to NIST, and no review status is claimed.** Every mapping records NIST as the provider and preserves NIST's own wording — *incorporated into*, *moved to*, *moved into* — instead of flattening all three into one relationship. No approval or review state is stamped on an imported mapping; that remains something only a person does.
- **Four replacements name a category rather than a subcategory** (`GV.PO`, `GV.RR`, `ID.IM`, `DE.AE`), so a vault that imported only subcategories has nothing to link them to. They are imported anyway and shown by identifier as not present in the vault. Dropping them would have printed "no successor known" over an assertion the vault actually holds.
- **One preparation step is needed, and it is a supplied script.** The workbook packs up to five replacements into a single cell and a recipe produces one note per source row, so `tools/lineage-from-csf-workbook.ts` expands the file first. It expands and nothing else: it selects no rows, invents no identifiers, and refuses outright any withdrawal wording or replacement identifier it does not recognise rather than importing a partial lineage. Its output ships with the recipe, so importing the published CSF lineage needs no local tooling.

### An evidence link notices when the control underneath it changes (2026-08-28)

- **A framework release no longer quietly outlives your approvals.** When you approve an evidence link, Crosswalker now records a fingerprint of the control text you approved it against. Re-import a newer release of that framework and any link whose control changed is flagged for re-review and stops counting toward coverage, with the reason stated as `subject-changed`. The link is not broken and nothing is deleted: it still resolves, it still points at the right control, and re-approving it restores the count. What changed is that a claim about text that no longer exists stops being reported as evidence.
- **Cosmetic churn does not send anybody back through a review queue.** The fingerprint ignores citation markers, footnote markers, markdown link destinations, HTML tags, curly quotes and dashes, zero-width characters, and whitespace. It deliberately does NOT ignore ASCII punctuation or capitalization, because a green report over a control that really did change is a far worse outcome than one unnecessary five-second re-review. On the two measured release pairs, this suppresses 0.3% of ATT&CK 15.1 → 16.1 survivor descriptions and 8.8% of CIS 8.1 → 8.1.2 ones. It is a noise filter, not a review-load reduction: the flag rate is driven by real content and classification change, which is what it is supposed to be.
- **The fingerprint covers the whole source row, not one description column.** On ATT&CK 15.1 → 16.1, 98 of 637 surviving techniques changed platform or data-source membership with no description change at all. A description-only fingerprint would have reported every one of those as unchanged.
- **A link that never recorded a baseline counts, and is named.** Every evidence link written before this change, and every one written by hand, has no baseline. Those links keep counting exactly as they did, and the coverage report adds a "Links with no review baseline" section that says how many of the numbers above it rest on links whose control may have moved. The wording is pinned by test to say **cannot tell**, and can never say unchanged, verified, or up to date. Nothing is ever back-filled silently: recording that a human reviewed content they may never have seen would be manufacturing an audit fact in the one report whose reader is an auditor.
- **Your existing coverage numbers do not move.** A vault using none of this renders, hashes, projects, and reports identically. Generated concept notes gain one line, and no other byte changes; the existing content identifier is untouched, byte for byte, because an identity hash and a review fingerprint answer different questions and one value cannot be both.
- **Links are created with a baseline, or told why not.** The link command records one when the control has a fingerprint, and says so in the modal and in the note body when it cannot. A bulk import records one for every approved row whose control it can actually find, and reports the count it could not, rather than inventing them on a later pass.

### Architecture: release change is re-attestation first (2026-08-27)

- **Challenge 43's framing is settled; no runtime behavior ships in this entry.** Measured ATT&CK and CIS releases preserved every old identifier while changing content and classifications underneath them, so ordinary release handling is re-attestation first: an attestation retains the subject CID it was approved against and stops counting as valid when that CID changes. Structural transitions remain the derived case and reuse release-to-release crosswalks with `superseded_by`; no Tier 2 concept history, standalone diff artifact, or `previous_ids` field is added. See the [synthesis](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-08-27-release-change-is-reattestation-synthesis/).

### You can write in a generated note, and a re-import will not destroy it (2026-08-27)

- **Re-importing with Replace no longer rebuilds the whole note body.** Crosswalker now owns a marked-off region of the body and rebuilds only that. An implementation note, an evidence pointer, or an audit remark you typed below it survives byte for byte, including line endings and trailing whitespace. This is the single change that turns a framework you can browse into a framework you can annotate, and it retires the rollout guidance that told people to treat generated notes as read-only and keep their own writing in separate files.
- **The boundary is visible while you edit and invisible while you read.** Two HTML comment lines, `<!-- crosswalker:body:start v=1 -->` and `<!-- crosswalker:body:end -->`. Write below the end marker. Text inside the region is Crosswalker's to rebuild, and you can see that you are inside it. The same markers already shipped for generated contents lists, so notes in existing vaults need no migration at all.
- **Notes from before this change are adopted, but only when it is provably safe.** On the first re-import, a note whose body still matches what the import would generate gains the two marker lines and nothing else. A note whose body has been edited is **left completely alone** and reported. Crosswalker never partially adopts and never guesses which half of a body is yours.
- **A note Crosswalker cannot understand is never written.** Damaged markers, a note written by a newer version of Crosswalker, or properties that will not parse: in every case the file is not modified at all, not even its properties, and the import continues with the rest of the rows. A stale body carrying fresh provenance would read as current while being out of date, so refusing the body refuses the note. The results screen lists every note left unchanged, with the same weight as an error.
- **Two silent data-loss paths in the existing code are closed.** Reading a note's properties returned an empty result when Obsidian had not yet indexed the file, which then skipped the merge entirely and overwrote every user-preserved property on that note. And both write paths caught a failed properties merge, logged a warning, and continued with the fresh properties, discarding the preserved ones. Cache lag is not absence, and a failed merge is now a note left alone rather than a note quietly rewritten.
- **Both import paths go through one shared merger.** The wizard path and the recipe path, and the facet hub writer, all call the same function. An earlier attempt at this behaviour fixed one path and not the other, and the removed behaviour came back from the second call site.
- **Newly generated notes gain the two marker lines.** Strip them and the file is byte-identical to what the previous version produced. A note with no body at all now carries an empty region rather than nothing, because a note without a boundary could never be adopted later.

### The JSON row filter now fails loudly instead of quietly (2026-08-27)

- **BREAKING for anyone relying on a filter that silently matched nothing.** The import wizard's "Keep only matching records" field kept its `field=value` / `field!=value` comma syntax, but it now writes the recipe's row condition rather than running a second, unguarded predicate of its own. A filter naming a column the source does not have used to return zero rows (`=`) or every row (`!=`) with no diagnostic whatsoever. It now stops the import and names the column, before a single note is written.
- **Filters that work today keep working, including the sparse ones.** The documented MITRE ATT&CK filter tests a field most records do not have. The translated condition keeps exactly the old truth table, written out where a reader can see it, rather than leaving it implicit in code.
- **The filter now applies to spreadsheets too, and travels with the recipe.** It was JSON-only, and it was not saved anywhere. One predicate now covers CSV, XLSX and JSON, and is part of the recipe you can share.
- **The results screen says how many rows the filter dropped.** The wizard used to show that count when the file was parsed, and the filter has since moved to the point where notes are written, so the count moves with it. Without it, a filter that matched far less than you meant looks exactly like a source file that was simply smaller than you thought.
- **The old implementation is deleted, not deprecated.** A deprecated silent predicate is still a shipped silent predicate. The dev fixture generator's `--where` flag was repointed to the same translator, so there is exactly one contract. The tests that covered the old code went with it: one of them asserted the defect as expected behaviour.

### A recipe can say which rows become notes, and pull in a second sheet (2026-08-27)

- **A recipe can now be pointed at the file you actually download.** That is the whole point of this change. Five shipped recipes previously needed a person to open the workbook, delete the rows that were not theirs, and save a new file, which is not a product and was written down nowhere. All five now read their own unmodified source: the CSF 2.0 sheet gives 185 notes from 231 rows with its 46 banner rows left out, the one CIS sheet gives 153 safeguards to one recipe and 18 controls to the other from the same 171 rows, and the CPRT export gives 679 notes from 906 elements with its 227 ordering and party entries left out. Proved by deleting the manual pre-filtering step from the tests rather than by trusting the recipes.
- **A recipe can now declare which source rows become notes.** `source.where` takes a one-line condition over a source row, and a row that fails it never becomes a note. This closes the gap that made five shipped recipes, across three sources, need manual pre-filtering of the spreadsheet before import: the CSF 2.0 sheet interleaves 46 banner rows with its 185 subcategories, the CIS workbook holds controls and safeguards on one sheet distinguished only by a blank cell, and the CPRT export carries 227 machinery elements among its concepts.
- **One sheet can now feed two recipes with two different answers to "what is a row."** The CIS pair is the case in point: one recipe selects the 153 safeguards, the other the 18 controls, from the same bytes, with the selection written in the recipe rather than in an undocumented manual step.
- **A mistyped column name fails the import instead of quietly emptying it.** This was the hard part. In the expression language, comparing a column that does not exist returns a perfectly good `false`, for every row, so a typo would have admitted nothing and reported nothing. Three checks now stand between a typo and a silent empty vault: the condition must evaluate to true or false and nothing else, every column it names must exist in the source, and a condition that admits no rows at all fails the run. The first two run before a single file is written.
- **A failing row stops the import; it is never skipped.** A skipped row with a warning is still a vault that quietly lost data.
- **Conditions are deliberately small.** Field references, text and number comparisons, `and`/`or`, membership in a list, and seven helper functions. No regular expressions, no user-defined functions. The limit is not squeamishness: the same condition has to mean the same thing when a script in another language produces the same notes, and the constructs left out are exactly the ones that do not survive that trip. Anything larger belongs in whatever produced the spreadsheet.
- **Existing recipes are unaffected, byte for byte.** A recipe that declares no condition produces the same notes with the same provenance hash it produced before, so no already-generated note anywhere reads as changed. Thirteen shipped recipes are pinned against their pre-change hashes to keep it that way.
- **Cross-language behaviour is pinned as data, not prose.** `spec/conformance/source-expressions.json` records exactly what each permitted construct evaluates to, so a producer written in another language can be checked against the same file rather than against a description of it.
- **The five recipes that needed that manual step now declare it themselves, and can be pointed straight at their own source file.** The CSF 2.0 recipe keeps the rows that have a subcategory. The two CIS recipes take opposite halves of the one sheet they share: one the 153 safeguards, the other the 18 controls. Both CPRT recipes drop the 227 ordering and party elements and keep the 679 concepts. Nothing about what those notes contain changed, only which rows become notes at all, and the stale "this is impossible" notes in each recipe were replaced with what it now does. The MITRE recipe records the opposite outcome honestly: reaching mitigation names needs a two-hop lookup that is deliberately not offered, so that one stays producer work.
- **Those five recipes have a new provenance hash, and that is the one thing to know before re-importing them.** The hash covers the row selection because the selection decides which notes exist. Notes generated from an earlier version of one of these five will therefore read as recipe-changed on their next import, which is accurate: the import that produced them included rows this one does not. Every other shipped recipe is untouched, and all thirteen still hash exactly as they did before the feature existed once the new declaration is set aside.
- **A recipe can now pull matching rows in from a second sheet of the same workbook, or a second array of the same JSON file.** `source.joins` names the other collection, says which column to match on, and the matching rows become available to templates under a name the recipe chooses. The ATT&CK case is the one that motivated it: a technique note can now carry the identifiers of its mitigations, which previously required denormalizing the workbook by hand.
- **Nothing is merged into your data.** A matched row lands under its own name and nowhere else, so a column in the second sheet can never overwrite a column of the same name in the first. If the chosen name matches a column you already have, the import stops and says so rather than picking a winner.
- **You have to say whether you expect one match or many, and there is no "just take the first".** Declaring one match and finding three stops the import, because that is the assertion doing its job. Declaring many always produces a list, even when exactly one row matched, so the output shape never depends on how the data happened to fall.
- **Finding no match is normal; losing the key is not.** A row with no counterpart simply has nothing under that name, and templates already handle that. A row whose matching column is missing or blank stops the import, because every later row would then be looked up under nothing.
- **The second collection can be filtered before it is used.** ATT&CK keeps several kinds of relationship in one table, so a join can narrow to the one it means. Without that the mitigation lookup would silently return the wrong relationships, which is why it is part of the feature rather than a later addition.
- **Large lookups stay cheap.** The file being imported is still read row by row; only the second collection is held. Measured against ATT&CK's largest table (18,570 rows), the lookup builds in about 25 ms, and importing 200,000 rows against it never holds more than a single row of the file being imported.
- **Two-hop lookups are deliberately not offered.** Reaching mitigation names, rather than mitigation identifiers, means a second lookup keyed on the results of the first, which is a different and much larger feature. A technique note gets its mitigation identifiers; anything beyond that belongs in whatever produces the spreadsheet.
- **The download got bigger than intended, and that is recoverable.** Reading conditions needs an expression library, which was budgeted at about 24 KB compressed. It actually costs about 38 KB, because the build ships the library's readable source rather than its packed form; the whole plugin grew about 51 KB compressed. Turning packing on would bring the library back to about 26 KB, but it changes every byte of the build for every feature, so it is being taken as its own decision rather than smuggled in with this one.

[What shipped, what it proved, and what it deliberately does not solve](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-08-27-source-contract-delivered/).

### Re-import keeps its identity, and the docs site is tested before it ships (2026-08-24)

- **An immediate re-import no longer changes which import set owns the notes.** Discovery of the existing set read only Obsidian's metadata cache and treated a not-yet-indexed file as absent, so importing twice in quick succession minted a fresh set id and broke re-import idempotency. Discovery now reads cache-cold files inside the destination directly, and malformed frontmatter fails with the file path instead of silently reading as "no set here". Found as the single genuine product regression in a full triage of the E2E suite's 52 failing declarations.
- **The documentation site is now tested before every deploy.** The docs Playwright suite existed for months without any workflow invoking it; the deploy shipped untested builds. Deploys are now gated on the full suite passing against the exact build artifact being deployed, the suite runs on docs pull requests, and a nightly job checks the live published site for outages and asset drift.
- **The E2E strategy is decided and recorded.** Keep WebdriverIO for the plugin and Playwright for docs; adopt visual regression narrowly with explicit maintenance budgets; stay serial until the harness is isolated; stage plugin CI behind a get-to-green path led by a purpose-built minimal seed vault, since 42 of the 52 failures were harness contamination rather than product defects. See the [Ch 44 synthesis](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-08-24-e2e-testing-strategy-synthesis/).

### Evidence linking and coverage reporting are usable from the app (2026-08-21)

- **New command: link evidence to a control.** Records that a document evidences a control, as a note you can review and update later. It asks for "the control" and "the evidence" rather than for a subject and an object, so the direction cannot be entered backwards, and it never asks about the predicate. Run it from an open control note and that control is pre-selected.
- **New command: evidence coverage report.** Writes a note listing the controls with no valid evidence, the partially covered ones, and every link that was set aside with the reason why. Pick a framework when the vault holds more than one. The note is regenerated from scratch each run and says so.
- **Reports state how fresh they are.** The index now records when it was last rebuilt and how completely, and every report quotes it. A report built from a partial, errored, or unstamped index says so rather than presenting old numbers as current posture.
- **Every generated link explains whether it counts**, in the note itself, so the coverage rules are visible where the decision is made instead of only in documentation.
- **Two folder settings added:** where coverage reports are written, and where evidence links are stored.

### Evidence coverage now reports gaps truthfully (2026-08-21)

- **"Which controls have no evidence?" is answerable again, and the previous answers were wrong.** Three shipped surfaces claimed to answer it: a Bases view filtering a property no recipe emits (so it reported that nothing had evidence), a documented dashboard counting backlinks (so it reported that nearly everything did), and a reference recipe querying crosswalk fields that evidence links do not carry (so it matched nothing). All three produced confident, well-formatted output.
- **The gap query moved to the query index, because it is not expressible as a vault filter.** A filter selects among notes that exist; a control with no evidence has no note to select, so an empty result looks identical to full coverage. No property name fixes that. The recipe schema now accepts `tier2` as an output target for exactly this class of question.
- **The evidence link contract is fixed and documented.** `subject` is the control, `object` is the evidence, and the predicate is exactly `has_evidence`. The published example had it inverted, which yields zero coverage in every vault built from it. The bundled recipe now fixes the predicate rather than reading it from a spreadsheet column.
- **Evidence is matched by stable identifier, not note name**, so renaming a control does not silently detach its evidence.
- **A link counts only when approved, with coverage stated, and not expired or stale.** Partial coverage reports as partial, never as covered.
- **Every link that does not count is explained.** Reports carry a set-aside count and a per-link reason (wrong predicate, unresolved identity, not approved, no coverage asserted, expired, stale), so a low score sends you to the data instead of to a panic. Nothing is silently reinterpreted.
- **The evidence recipe is now registered**, so it is reachable from the import wizard instead of being an unused file.
- **Not yet shipped:** no UI for creating an evidence link, no report surface calling these queries, and no freshness indicator on results. A manually reconciled evidence pilot is viable; automated audit-defensible coverage is not. See the [evidence closeout log](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-08-21-evidence-closeout/).

### Two releases of one crosswalk can coexist without migration (2026-08-21)

- **Two releases of the same framework crosswalk can now live in one vault at once.** The choice appears in the existing SSSOM import preview; no extra modal was added.

| Choice | What it does |
|---|---|
| Refresh | Updates the selected import set (the notes owned by one import) using its existing identity scheme. Existing assertion identities and paths stay unchanged. |
| Keep both as a new set | Mints a separate import set whose assertions use `set-qualified-v1`, so equal endpoint pairs from the two releases become different notes. |

- **Adopting this requires no migration of existing notes.** Existing `endpoint-v1` sets keep the exact `cw-<subject>-<object>` assertion identities they already have. A coexisting set is born with `cwset-<import-set-id>-<sanitized-subject>-<sanitized-object>` identities; no old note is migrated, moved, or re-identified.
- **Validation fails closed.** Discovery accepts every known scheme, rejects unknown schemes and mixed schemes within one set, and prevents refresh from changing a set's stored scheme. Row reordering does not change set-qualified identities.
- **Exporting refuses to merge two coexisting releases into one file.** Because a release is a separate mapping set, exporting a folder that holds two of them would stamp one header over rows from both and silently misrepresent the file. The export now stops and names the import sets involved instead of guessing.
- **The refresh picker identifies a release by what it owns.** A minted set id is deliberately meaningless, which is right for identity but useless for choosing which release to overwrite, so the picker also shows the note count and the folder the notes live in.
- **Accepted pre-alpha limitation:** the picker still has no human-assigned source or release label (for example "NIST 800-53 r5"), so distinguishing two releases of the same framework in the same folder currently relies on note counts.

### Import-set ownership and orphan reporting everywhere (2026-08-21)

- **Crosswalker now records which import owns each note; orphan reporting works everywhere.** Every new concept, junction note, crosswalk edge, facet hub, and synthetic level hub carries one minted `_crosswalker.import_set` id plus its fixed `endpoint-v1` identity scheme. The id is deliberately meaningless and is never derived from recipe, source, destination, or note identity.
- **Refreshing is explicit and safe.** A destination with one set refreshes it by default; a destination with several sets requires a choice; choosing new mints a separate set. Headless imports follow the same rules and may explicitly refresh an empty set.
- **Missing identities are reported within one ownership boundary.** Wizard/workbench and native recipe imports now report only notes that the selected import set owned but the complete, error-free run did not produce. Enrichment hubs are stamped and counted as produced. Reports remain informational: no Markdown is deleted.
- **Legacy notes stay valid and untouched by ownership inference.** Notes without `import_set` are outside every set, never become orphans by inference, and project a null ownership value into the derived index.
- **The derived query index carries ownership without changing identity.** Tier 2 advances to `tier2-sqlite-v4` with nullable `import_set_id` on concepts, mappings, and junction notes. Import-set provenance does not enter `concept_cid`; stamped and unstamped representations of the same concept retain the same CID.

[Decision and rationale](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-08-21-import-set-ownership/).

### Stable relationship identities and release-aware mapping sets (2026-08-21)

- **Relationships now survive a note rename because identity is stored separately from the clickable link.** Concept notes can carry `parent_curie`; junction notes can carry `subject_curie` and `object_curie`. A CURIE (a compact stable identifier) says what the endpoint is, while `parent`, `subject`, and `object` remain Obsidian wikilinks that say where the note currently lives. Projection uses only the explicit identity fields and never guesses identity from wikilink text.
- **Crosswalk assertions now record which published mapping collection they came from.** `mapping_set_id` is valid Tier 1 data, is stored in the query index, and is generated deterministically when a source omits it.
- **Explicitly negated mappings remain visible without becoming graph edges.** `predicate_modifier: NOT` is now valid Tier 1 data and is stored in Tier 2. Direct crosswalk queries return the negated assertion with its mapping-set provenance; closure and inverse/symmetric edge expansion exclude it in both traversal directions. STRM export skips negated assertions because that format cannot represent them without changing their meaning.
- **The derived query index now carries the same identity and release facts as Markdown.** Tier 2 advances to `tier2-sqlite-v3`, stores mapping-set and modifier provenance, indexes explicit junction endpoints, and deterministically reconciles ontology versions. Vault, SSSOM, and STRM exporters were updated; canonical NIST-mini fixtures now include `parent_curie`.
- **Recipe templates can omit absent identity values safely.** First-position `optional` suppresses a missing or null variable, while `curie-prefix(prefix)` prefixes a present local identifier and leaves an empty value empty. Existing recipes remain valid.

**Accepted pre-alpha limitations from verification:**

| Limit | Practical effect |
|---|---|
| Pre-P3 SSSOM identities changed from endpoint-only to mapping-occurrence identities | An old endpoint-only SSSOM note cannot be matched to the new assertion identity by R1 reconciliation alone. The importer does not use forbidden path detection, so this one-time transition can leave the old note beside the new P3 note until an identity-alias or explicit migration policy is designed |
| Concept content-identity stability is pinned at the identity-scope helper boundary, not through a `generateFromRecipe()` integration assertion | Current generation keeps mapping-only defaults out of concept identity, but the regression test would not catch every future production call-site bypass |
| Raw-CURIE parent templates treat missing/null as optional but do not trim whitespace by themselves | A whitespace-only root parent can survive `{parent_id|optional}` and fail validation; `curie-prefix(prefix)` is empty-safe because it trims, but the raw-CURIE branch still needs an explicit trim/omit rule |
| The classic wizard/workbench route does not yet normalize absent P3 columns in every generation path | A recognized crosswalk recipe can still fail when an input omits `mapping_set_id` or `predicate_modifier`; the native recipe/SSSOM path supplies safe defaults, but the older route does not yet do so end to end |

[Decision foundation](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-08-21-reimport-is-identity-reconciliation/).

### Re-import correctness: notes now follow their identity (2026-08-21)

- **Changing an import's layout no longer creates a second copy of the same note.** Crosswalker now finds its own notes by their stable `curie` identity, moves an existing note through Obsidian's link-updating rename API when its destination changes, then merges the new managed content in place. Hand-written notes are structurally outside this lookup.
- **A source that stops producing an identity no longer leaves that disappearance invisible.** After a complete, error-free wizard, workbench, or native recipe run, the generation result reports import-set-owned notes that were not produced this time as orphans (Crosswalker notes kept in the vault but absent from the latest source). Enrichment hubs participate in the same ownership set. This is report-only: no Markdown note is deleted.
- **The query index no longer keeps rows for notes that are gone.** A full projection (a complete vault-to-index rebuild) records the identities it actually saw, then prunes stale concepts, mappings, junction notes, and ontology rows. Partial or filtered projections never prune; any projection error blocks all pruning; a moved concept is reconciled by identity at its new path. Successful pruning also clears cached transitive results so queries cannot reuse answers derived from removed rows.
- **Known pre-alpha limits:** kept orphans still remain in Tier 2 coverage, and a full projection can currently prune an existing indexed note when Obsidian returns a cache object without readable frontmatter. There is no review/delete interface yet. Legacy unstamped notes deliberately stay outside all import sets and are never inferred as orphans. These are explicit follow-ups, not deletion permissions: canonical Markdown remains untouched.

[Decision and rationale](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-08-21-reimport-is-identity-reconciliation/).

### Fixed: depth-safe Tier 2 closure caching (2026-08-20)

- **Transitive mapping queries no longer return silently truncated results after a shallower query runs first.** Each subject/predicate cache partition now records the depth through which it was fully computed; deeper requests recompute and atomically advance that coverage, while shallower requests safely reuse and filter deeper results.
- **Empty closures are cached deliberately.** A separate coverage-state row distinguishes a computed empty result from a cache miss, and mapping projection invalidates cached rows and coverage together.
- **Tier 2 schema upgraded to `tier2-sqlite-v2`.** Because the sidecar is fully derived from canonical Markdown, versioned and unversioned older schemas are deliberately rebuilt rather than preserving the ambiguous v1 cache shape.

### Coverage views no longer count "explicitly not equivalent" as coverage (2026-08-21)

- **A crosswalk row can say two concepts are explicitly NOT equivalent. The counting views were counting those rows as coverage** — reporting the opposite of what the data says, in exactly the reports a compliance reader trusts. The query engine already excluded negated assertions from relationship-chain results in both directions; the presentation layer is a separate code path and was missed when negation shipped. Three views are fixed: the two coverage matrices and the crosswalk-density table.
- **The guard explicitly admits rows that carry no modifier at all**, which is nearly all of them. A bare inequality would have depended on how a missing property compares, and getting that wrong would have silently emptied every coverage view rather than merely miscounting it.
- Pinned by a test written as a property over every counting view, so a fourth such view added later cannot quietly skip the guard.

### Re-import finds notes by identity, and stops counting things that are gone (2026-08-21)

- **A re-import now finds a generated note by what it is, not where it sits.** Every generated note carries a stable identifier in its frontmatter, but the importer looked notes up by file path. If a note's address changed — a renamed output folder, a different destination, a changed layout — the re-import could not see the note it had made and wrote a second one beside it. Notes are now matched by identifier, and a note whose address changed is **moved** through Obsidian's rename (so links pointing at it follow) rather than duplicated. Two notes claiming one identifier is reported as an error rather than silently resolved.
- **Notes the source stopped producing are reported.** A control that existed in a previous import but is absent from the current source is listed as an orphan. It is only ever **reported** — never deleted, never silently kept in coverage counts.
- **The query index drops rows whose note is gone,** so counts stop including things that no longer exist. Deletion is deliberately all-or-nothing on a clean, complete pass: a filtered projection cannot even request it, and a single error anywhere suppresses it entirely.

**Known limits, stated plainly rather than implied:**

| Limit | What it means |
|---|---|
| No user-facing orphan surface | Orphans are reported in the import result. There is no preview, no delete-after-confirm, and no coverage-exclusion UI yet — that is later work, not a missing safety control |
| Legacy notes have no inferred owner | Notes written before import-set stamping remain valid but sit outside every set. They are never reported as orphans until a later generation stamps them explicitly |
| Orphan detection remains fail-closed | A partial row count, any row error, or a failed enrichment phase suppresses the report. Reporting nothing beats reporting a note as missing when the run could not prove it |

### Re-import correctness: a field the tool manages can now be removed (2026-08-21)

- **A managed field whose source value disappears is now deleted from the note instead of lingering.** Previously it survived forever, and the tool would keep presenting a fact that had stopped being true. The worst case was a crosswalk assertion marked "explicitly NOT equivalent" whose source flipped to positive: the marker stayed, inverting the note into the opposite of the truth. A stale parent reference behaved the same way.
- **Why it happened is worth remembering.** Two individually-correct behaviors composed into a wrong one. Rendering omits a managed field that evaluates empty, which is right — otherwise every top-level note gets a literal broken link. The merge then preserves any key it does not consider managed, which is also right — that is what protects hand-written content. Together, an omitted field looked like user content and became permanent.
- **The rule that fixes it:** ownership of a frontmatter key comes from what the recipe **declares** it manages, not from which keys happened to render non-empty for a given row. A declared-but-empty key is removed; an undeclared key is still preserved untouched; `user_preserve` continues to win over both. Tests cover a parent reference disappearing, a negation marker disappearing, and list-valued links, each while an adjacent user-authored field survives.
- **The fixture-drift gate works again.** It shelled out to `git stash` against a path that is ignored by git while its files are tracked, so it failed on every run and left stray stashes behind. It no longer manipulates stash state at all.

### Tier 2 correctness: an emptied index no longer answers queries silently (2026-08-21)

- **A schema rebuild now forces a reprojection.** Changing the internal database format empties every derived table, and rebuilding it was a separate step that could be switched off in settings. With it off, queries were served from an empty index and returned "nothing matches" rather than an error, which is indistinguishable from a vault that genuinely contains nothing. `openTier2()` now reprojects unconditionally when the schema was rebuilt. That setting governs routine auto-projection on vault load, not whether the index may be left knowingly empty while still answering questions.
- **The migration stopped claiming a projection that never happened.** It stamped `projected_at` at the exact moment it emptied the tables. The value was read nowhere, so nothing was misled today, but recording the opposite of what is true is how a future reader gets misled. Removed, with the reason written down.
- **Index proliferation recorded as a first-class cost** against the calendar-anchored `sqlite-vec` revisit. Verified that Tier 2 does not crawl the vault: it reads Obsidian's shared metadata cache rather than files, and stores rows only for Crosswalker-generated notes. Vector search is where that would change, so any future adoption must state what gets embedded and justify being another indexer.

### Infrastructure: mechanical personal-data gate + static checks in CI (2026-08-19)

- **New `bun run check:personal-data` gate.** A regex scanner (no AI in the loop) that fails on machine-specific absolute paths, email addresses, and an optional local denylist of names/identifiers. Runs over the whole tracked tree by default, or `--staged` / `--range <gitrange>` for pre-commit and pre-merge use. Legitimate discussions of these patterns (PII-scrubbing decision logs, redaction tests, the reviewer agent's own detection rules) are allowlisted by path with a stated reason; well-known bot identities are allowlisted by address.
- **Static checks now actually run in CI.** None of the existing workflows executed any `check:*` script, so the gates only ever ran when someone remembered to. A new `Static Checks` workflow runs personal-data, MDX, frontmatter, not-content, and log-label checks on every push and PR, unfiltered by path — a leaked path can land in any file, not just the ones a change touches.
- **Retired the WSL-era workarounds.** The docs dev server dropped its polling file-watcher (it existed because inotify events were silently dropped on a Windows drive mounted into WSL) and the docs dependency tree was reinstalled clean, shedding stale win32 binaries. Agent instructions record the current environment and no longer prescribe the obsolete jest invocation.

### Positioning: dual domain-neutral/GRC-first statement on the front doors (2026-07-29)

- **The homepage, GRC-teams page, differentiators page, and README now state the settled dual positioning explicitly**: the note contract and engine are domain-neutral; the first-class part is the bundled one-click recognized-source recipes, which today are all compliance (NIST CSF 2.0, NIST SP 800-53 Rev 5, CIS Controls v8, MITRE ATT&CK, CRI Profile 2.2, SCF 2026, OLIR-style crosswalks). "What is privileged is the fast path, never the model."
- **Fixed a supported-frameworks drift** on the GRC page: it claimed MITRE D3FEND/ENGAGE pre-built support and CRI v2.0 — the plugin's actual recognized list replaces it, with the Python CLI's extra coverage attributed correctly.
- **Vocabulary register sweep**: seven definitional uses of "control" in domain-neutral concept pages became "concept" with the GRC example preserved as an example; glossary and review-queue glosses aligned.
- **Docs test suite moved to its own port (14325)** so Playwright never again latches onto a running dev server (14321) and times out against dev-mode rendering.

### Knowledge ops: readability, staleness repair, and durable freshness guardrails (2026-07-25)

- **Soft light theme.** Light mode moved from stark near-white to warm paper surfaces via the smallest set of Starlight variable overrides in `docs/src/styles/brand.css`; root cause was page and chrome collapsing onto one color token. AA contrast restored for link text; dark mode untouched.
- **Executive-decidable review queue.** Every open decision (P1-P14, D1-D8) is now a self-contained card (what this is / in practice / pros / cons / recommendation) with plain-English titles; Greek gate letters replaced with plain names; registers carry purpose parentheticals at each artifact mention.
- **Challenges section repaired.** Root cause of the broken ordering found (a date-encoded sidebar order pinning Ch 43 to the top; unordered pages sinking); index reconciled with the archive folder (Ch 25/26 were archived but unlisted); every open brief now carries an explicit status callout; open/resolved split with counts.
- **Freshness markers with verified drift lists.** The v0.1 schema spec page now declares what is verified-current and what it promises that the machine schemas do not ship (verified field-by-field); milestone and roadmap status tables carry "Status last verified" lines.
- **System model and terminology rewritten for humans.** Plain-first headers, the Ch-42 open-question wall collapsed to a verified status callout, theme-aware card styling, and the edge-model figure moved out of the glossary opening (evidence linking is one use, not the assumed one).
- **Durable guardrails.** `.claude/CLAUDE.md` gains a freshness-discipline section (living pages carry verified-as-of markers; counts/enums cite source files; retired commitments get tree-wide purge sweeps); the pre-commit-reviewer agent grows from 11 to 16 checks including staleness, count-drift, sidebar-order, challenge-index drift, and retired-commitment detection.

### Infrastructure: docs port pinned + owner review queue (2026-07-25)

- **Docs dev/preview/tests moved from Astro's 4321 default to port 14321** (`docs/astro.config.mjs` `server.port`, Playwright config, `scripts/serve.mjs`, launcher and doc references) to stop cross-project port collisions on multi-Astro machines.
- **Owner review queue log added** (`zz-log/2026-07-25-owner-review-queue.mdx`): the single checklist of the 22 open decisions across both registers in dependency order, the pages changed underneath them, and standing awareness items.

### Architecture: primitives reconciliation decision register (2026-07-25)

- **Adversarially re-audited the core primitives and published the open decision register.** Three independent audits (essence completeness, knowledge-representation formalism comparison, minimality), an independent verification pass that corrected two findings before publication, and a first-party corpus investigation (NIST CPRT, SP 800-53/53A, CSF 2.0, CRI Profile 2.2, SCF, CTID/D3FEND). Validated: reified edge notes, identity-before-render hashing, mandatory provenance, the managed/user_preserve split, and the two-digest orthogonality. Fourteen decisions registered across three gates: Tier 1 field completions (ordinal, identity-typed edge endpoints, mapping-set identity + negation modifier, facet/hub legalization, edge groups, predicate characteristics), subtractions (role-noun pruning, recipe-schema split, ShapeDispatchB deletion, recipe-model collapse, reserved-surface consolidation), and language (grammar re-basing on the true 9-primitive palette, "primitive" disambiguation to three families, terminology restructure). Corpus evidence resolved graph_edges: stays reserved for v0.2. Known correctness bug registered: multi-target `equal` rows materialize as logically false pairwise equivalences.
- **Decision-independent KB fixes shipped alongside:** concept-page sidebar ordering repaired, stale 7-verb query vocabulary replaced with pointers to the canonical 8-verb page, Dataview purged from the GRC landing page per commitment #6, quick-start rewritten against the shipped workspace-tab flow, new external-producer page for emitting valid notes from external tools, wrong source paths and a false `_crosswalker.type` claim corrected in architecture pages.

### Architecture: save-and-replay decision register (2026-07-25)

- **Published the open decision register for reusable configurations plus exact replay.** Three independent audits confirmed the direction fits the closed five-mechanism grammar, the `render()` coupling point, the `RecipeDocument` preservation boundary, and the artifact authority model. Eight decisions remain open across three gates, including the hash taxonomy (a full canonical recipe digest is additive to, not a replacement for, the existing effective-target hash), the closed binding parameter surface, the replay-equivalence profile, and the source-retention model. The linear source-to-package acceptance chain is restated as a join: source snapshot, recipe revision, parser selectors, and destination policy meet at a binding.

### Architecture: artifact roles and authority (2026-07-21)

- **Published the minimal internal artifact model.** Schema Contract governs validity; Knowledge Set names asserted content; Recipe names intended behavior; Execution Record and Package Manifest remain separate planned envelopes. Tier 1 is the canonical Crosswalker-managed representation rather than a root artifact, and new artifact nouns now require independent identity, lifecycle, authority, and consumers.

### Mapping workbench clarity + portable ImportRecipe fidelity (2026-07-21)

- **The mapping screen is easier to read and navigate.** “Add mapping from a column” is a top-level searchable chooser with source examples; evidence cards explain what Crosswalker noticed and what using or ignoring it changes; Escape, close, and click-away all behave normally. Mapping shapes use compact illustrations with details on demand.
- **Collapsed Source no longer becomes a vertical word strip.** Wide layouts hide it behind one “Show source” action; stacked layouts keep a compact row. The three-zone layout is regression-tested at 11 pane widths, including the exact 760/761 px boundary.
- **Connections choices are outcome-first.** Child lists, shared-value hubs, folder indexes, and parent-note placement use concise native controls, selected states, and optional “What this does” details instead of long checkbox paragraphs.
- **Canonical import instructions now survive editing.** Recognized and fresh imports carry a validated `RecipeDocument`; no-op editing retains canonical ID/semantics, while customization gets a deterministic `-custom` ID plus structured `based_on` ancestry. Output `kind`, managed links, protected properties, enrichment, query declarations, graph edges, link style, constants, variadic layout, and ordered projections no longer disappear during workbench reconstruction.
- **Note body output is part of pure rendering.** Ordered append/section body projections support text, code, quote, and list formatting. Generation assembles the rendered regions and falls back to the legacy body path only when no canonical body declaration exists.
- **Lossy states fail explicitly.** Portable patching blocks unsupported table-row bodies, legacy body transforms, row filters, lookup naming, materialized level notes, non-default missing policies, and unrepresentable link/list semantics rather than silently dropping them.
- **Real crosswalk E2E exposed and fixed scalar typing.** The bundled OLIR-style recipe now emits numeric `match_confidence` through the closed `number` filter; prefixed multi-column file templates retain exact bytes; recognized `crosswalk-edge` kind and recipe identity survive real Obsidian generation.
- **Deliberate boundary:** this is in-memory canonical fidelity, not the future user recipe library. Save/open/browse/export under `_crosswalker/recipes/import/` and the final public UI term remain open.

### Adversarial pre-merge review: every blocker fixed (2026-07-12)

An independent senior review of the whole branch (~75 commits) reproduced its findings with live probes before reporting. Verdict: the core generation engine is sound; every confirmed defect sat in the new UI-orchestration layer. All 7 blockers were fixed the same day, each with a pinning regression test:

- **Your choices now stick.** Dismissing a suggestion card or switching presets used to silently reset the parent-note placement you'd picked and drop any mappings you'd added by hand. Both now survive every workbench action.
- **No more silent dead ends.** It was possible to configure a mapping that could never generate, with a clean-looking preview and a Generate button that did nothing. Now the conflicting option isn't offered in the first place, the preview shows a blocking error banner if the state is ever reached, and Generate reports the reason instead of going quiet.
- **Drafts resume faithfully.** Resuming a draft through the standard flow restores the full mapping workbench, including per-column routing decisions and dismissed suggestions (previously all lost — the resumed screen quietly fell back to a stale configuration).
- **Protected properties stay protected.** Frontmatter keys marked as yours-to-edit now survive both the mapping round-trip and re-import through the wizard path (previously the protection list was silently dropped, so re-import could overwrite your edits).
- **Every import path validates before writing.** The wizard path now runs the same pre-write schema validation the recipe path always had — no more unvalidated output from the primary UI flow.
- **Shareable logs are actually scrubbed.** The older "Export debug log to clipboard" button now removes file names and vault paths, same as the newer Copy diagnostics command, so a pasted bug report can't leak sensitive framework or document names.
- **Folder-note default is real now.** Built-in presets no longer hardcode the sibling arrangement, so the documented folder-note default (and the new vault-level setting) actually applies.
- Remaining review findings (performance of the workspace home screen on very large vaults, concurrent import flows, and 11 minor notes) are explicitly triaged as post-merge follow-ups rather than silently dropped.

### Vault-wide connection defaults + export lands (2026-07-12)

- **Set your connection defaults once.** A new Connections settings section holds vault-wide defaults for the enrichment features (children lists, hub notes for shared values, folder index notes, Waypoint marking, parent-note placement) with the same live placement preview the workbench uses. Per-import choices and recognized built-in configurations still win; the precedence is documented right in the section.
- **Exact matches skip a click.** With the existing auto-apply setting on, a file that matches a built-in configuration 100% goes straight to the review screen instead of pausing on the recognition card. Review is still mandatory — nothing ever jumps straight to generate.
- **Export is here (first slice of v0.1.7).** Two new commands: "Export folder as crosswalk mapping file" writes a standards-shaped TSV of a generated crosswalk (verified by an import→export→import round-trip test — nothing lost), and "Export folder as CSV" turns any generated framework folder back into a spreadsheet. Files are written next to the folder, never outside the vault. (A STRM-shaped TSV exporter is built and tested awaiting its command; OSCAL export is scaffolded with its limits documented rather than faked.)
- **Provenance hashes wired.** Every generated note now carries a stable concept identity hash and the recipe hash that produced it — the groundwork for telling "the source changed" apart from "my import settings changed" when framework version updates arrive.

### Frameworks arrive furnished (2026-07-11, third batch)

- **Every import gets a home.** Each import nests under its own folder and its root becomes the framework's home note; every folder level can get an index note listing its contents (on by default), parents carry a Contents section in the note body, and your own writing on any of these survives re-import. Generated navigation comes from the data itself, not a folder scan.
- **Folder notes are the default.** A note that is also a parent now lives inside its folder (T1078/T1078); the sibling arrangement remains one click away, and the placement preview highlights the connected file-and-folder pair in purple.
- **Know before you generate**: the review screen states what will be created from the whole file (exact note and hub counts, honest estimates for folders and links).
- **Plays well with Waypoint**: vaults using the Waypoint plugin can opt to mark generated folder notes so Waypoint also tracks notes added by hand later.
- **Pick files from the vault**: import now leads with a fuzzy search across the vault's CSV/XLSX/JSON files, working even when Obsidian's file explorer hides them; layout no longer produces horizontal scrollbars at any pane width (split screens included).

### The workspace tab, everywhere entry points, and one vocabulary (2026-07-11, second batch)

- **Crosswalker has a home now.** A dedicated workspace tab (ribbon icon, or click the status bar) hosts the entire import experience full width: launchpad, installed frameworks with live note and link counts plus an "Import again" action, and the whole mapping flow with a collapsible source rail and side-by-side preview on wide screens. The modal remains for quick command-palette use.
- **Meet it where you work**: right-click any CSV, XLSX, or JSON file in the file explorer to import it (the file arrives pre-selected); a status-bar counter opens the workspace; a one-time notice after install points the way.
- **One vocabulary**: the interface now speaks a single consistent language (saved configuration, built-in configuration, preset, query template), with the full lexicon published in the knowledge base. Internal jargon is gone from commands and notices.
- **Fixed: enriched output was silently skipped on common paths.** Both the visual mapping flow and the classic wizard now actually produce children lists, category hub notes, and connection counts (two separate dropped-wiring bugs, both regression-pinned).
- **Recognition tuned on real data**: the built-in configuration matcher was calibrated against 370 real framework exports; near-miss files no longer claim confident recognition, and crosswalk-shaped files are recognized as crosswalks.
- **Diagnostics you can share**: a Copy diagnostics button produces a redacted report (never includes your file names, paths, or data) with session-correlated recent events; log levels and human-readable category names.
- **Test infrastructure**: generated-output hygiene between e2e runs, orphan-process guards, and calmer flake-resistant specs.

### Settings hub, recognized sources, and enrichment everywhere (2026-07-11)

- **Settings open on a hub, not a wall of fields.** A start-here launchpad (import, manage saved configs, resume a draft) plus section cards with a glimpse of their current values; every setting that shapes output carries a live, illustrated preview built from your actual values (folder tree, property samples, cell-value formatting, link style). Folder fields autocomplete. All copy uses plain language instead of internal terminology.
- **Recognized sources get a fast path.** When a selected file confidently matches one of the built-in, vetted import recipes (NIST CSF 2.0, MITRE ATT&CK, CIS Controls, NIST 800-53, CRI Profile, SCF), the wizard leads with a calm "Recognized: [source]" card instead of the full detection flow — plain-language summary of what will happen, one primary action to proceed straight to review, and a "Customize" option that opens the full mapping workbench if you want to adjust anything. An unedited recognized source is labeled Built-in; customizing it is labeled Custom, honestly.
- **Every import now gets the richer output, not just some.** Parent notes get an auto-maintained list of their children; shared facet values (like categories or tags) get their own hub note listing every note that carries them; and the review screen shows a connection count so a disconnected import is visible before you generate. This previously only applied to imports built through the visual mapping workbench — it now applies uniformly to every import path.
- **Visual polish pass on the mapping workbench**: consistent spacing, type, and shape across every card and badge; icons instead of emoji (so they render correctly everywhere, including screenshots); calmer evidence cards; and whole-card click targets.
- **Testing**: added coverage for the recognized-source matching logic, the settings previews, and expanded end-to-end screenshot coverage (including dark theme and post-generation views).

### Connected vaults, honest review, resumable drafts (2026-07-06 → 2026-07-10)

The first hands-on rounds of the shape workbench drove a fix-and-harden sweep:

- **Generated vaults are graphs now.** Wikilink property values are properly quoted (an unquoted `[[X]]` parses as a YAML array, so Obsidian indexed no links at all — a whole import could render zero graph edges); tags and aliases emit into frontmatter (union-merged with hand-added values on re-import); long-text columns become real note bodies (H1 plus prose) instead of properties on an empty note; one structural mapping owns the folder path per import (two structural detections used to interleave into garbage `.md/` paths on CIS and NIST CSF shaped sources).
- **Step 3 is a true review screen**: destination block (breadcrumb path, inline edit, "Show in file explorer" without closing the modal), the shape-map recap ("technique_id → folders · 823 notes"), stat chips including a **link-count guardrail** (a link-dead import announces itself before generate), deviation banner, and a provenance line — presets carry Built-in / Yours / Custom badges and the detection's default is explicitly tagged Recommended.
- **Drafts resume without data loss**: vault-path sources re-read and re-parse automatically (no forced re-selection) and the workbench mapping persists across sessions.
- **Workbench UX round 1**: sticky nav chrome, labeled detection chips, inline evidence accordion, clickable preview tree (pager removed), tightened header.
- **Testing doctrine (consumer's-view)**: every generated note round-trips through a real YAML parser; golden-vault snapshots + invariants (link resolution, orphan counts, clean paths, determinism) run over all four sample corpora with a drift gate (`bun run golden:regen`). The invariants caught the interleave bug on real corpora before any human did.

### Shape workbench (beta): shape-first import on one live screen (2026-07-05)

A new **Shape workbench** setting (default off) replaces the wizard's Step 2 column table with a live three-zone mapping screen: a **source rail** (columns with detection badges and evidence cards — packed-id hierarchies with depth histograms, level-per-column chains, facets, parent links, long-text body candidates, crosswalk-shaped files), a **mapping canvas** (preset dropdown → per-detection mapping cards → six Obsidian-primitive shape toggles with a combined "your mix on one row" preview → an editable per-level **matrix** with merge/split, naming, missing-value policy, and a grouped two-stage add-destination menu), and a **live vault preview rail** (folder tree, one rendered note, deviation banner) that re-renders on every change. Underneath: a level-agnostic **preset system** (`spec/preset.schema.json` + four built-ins), a `StructureMapping` model with cross-column and constant sources, preset-times-detection instantiation, and recipe-region projection — the workbench generates through the same `render()` pipeline as recipes and the headless harness. Durable canonical recipe fidelity was completed by the 2026-07-21 `RecipeDocument` slice above; standalone recipe-file storage/UI remains open. Legacy Step 2 is untouched when the setting is off. (+72 unit tests across detection, mapping, view-model, and workbench recipe assembly.)

### Variable-depth folder nesting for ragged ids (2026-07-05)

Ragged taxonomy ids — where some rows have more levels than others (ATT&CK `T1055` vs `T1055.011`, or any parent/child id family) — can now nest to their **own natural depth** instead of being dumped flat. A recipe folder level gains an optional **`variadic`** block that splits the level's rendered value and expands it into a variable number of folders per row:

- `T1055` lands at `Techniques/T1055.md` (no parent folder — it has none); `T1055.011` lands at `Techniques/T1055/T1055.011.md` (nested under its parent) — from the **same** recipe.
- Knobs: `delimiter` (required), `segment` (`prefix` → `X/X.Y/`, the default and CSF-style; or `part` → `X/Y/`), `drop_last` (default true — the leaf piece names the file, not a folder), `max_depth` (default 6 safety cap), `on_overflow` (`truncate` (default) records a deviation note and keeps the full id in the filename; or `error`).
- Deterministic and observational-safe: folders derive only from the row's own value, and every skipped/truncated level is recorded in the render report (empty pieces → `folder-level-skipped`; overflow → new `variadic-overflow-truncated`).
- Additive schema change (SchemaVer 1.2.0) — recipes without `variadic` validate and render **byte-identically** to before; `variadic` is schema-constrained to `mechanism: folder` only.
- **Recipe-only for now** — the import wizard doesn't yet propose or edit `variadic` (planned wizard follow-up: detect the ragged-id signature a delimiter appearing in ~20–79% of rows and offer variable-depth nesting). 17 new unit tests (`tests/render-variadic.test.ts` + recipe-validation cases).

### Render report: rows that don't fit the pattern are now visible (2026-07-05)

One visible rule replaces three silent behaviors: **every row imports; every deviation is recorded.** Previously a row that didn't fit the recipe's ID pattern either silently lost a folder level (empty segment skipped), silently produced garbage nesting (`split()` with no delimiter falls back to the whole value — `AC-2/AC/AC-2.md`), or silently emitted an empty piece (`regex()` no-match) — a "weird vault" with no explanation.

- `render()` gains an optional **observational `RenderReport`** — purely additive; output stays byte-identical with or without it (Pass-1 hashability unaffected).
- Recorded deviations: `folder-level-skipped`, `split-no-delimiter`, `split-index-missing`, `regex-no-match` — each with a plain-language `detail` safe to surface directly in UI.
- Both engine paths (wizard/legacy `generateNotes` and native `generateFromRecipe`) aggregate notes into **`GenerationResult.warnings`** (`{row, message}`) and the debug-log run summary now carries a warnings count.
- 9 new unit tests pin the three failure modes + the determinism invariant (`tests/render-report.test.ts`).
- **Wizard UX**: the Step 3 preview now runs the same `render()` the generation engine uses against a sample of the previewed rows (capped at 200) and shows a summary banner — a quiet "All 200 previewed rows match the recipe pattern." when clean, or "187 of 200 previewed rows match the pattern fully. 13 rows don't — expand to see where they'll land." with an expandable per-row details list (row number, plain-language reason, resulting path; capped at 50 visible rows) when not. Aggregation logic lives in `summarizeRenderNotes()` (`src/render/summarize-render-notes.ts`, unit-tested independent of Obsidian).

### Ingestion harness: JSON iterator reader — STIX / OSCAL / CPRT unlocked (2026-06-12)

The headless harness (`tools/generate-fixtures.ts`) now reads **nested JSON sources** via the RML logical-source + iterator pattern (`tools/lib/json-source.ts`, 19 unit tests), completing the dev-log plan and unblocking the ~39-file JSON corpus:

- `--iterator '$.objects[*]'` locates the row array inside a nested document — closed, fail-fast syntax (dotted keys + `[*]` fan-out, multi-fan flattens à la OSCAL's `$.catalog.groups[*].controls[*]`); a missing key errors **listing the keys that are available**; indices/filters are rejected, pointing at `--where`.
- `--where 'type=attack-pattern,revoked!=true'` filters rows with comma-ANDed `=`/`!=` clauses on dotted paths; a missing field never `=`-matches and always `!=`-matches.
- Top-level scalars coerce to trimmed strings (same contract as the CSV/XLSX readers, so `--map` behaves identically across formats); **nested objects/arrays survive** for the dotted template paths `render()` already resolves (`{external_references.0.external_id}`).
- Smoke-verified on the real corpus through the production `render()`: **MITRE ATT&CK STIX → 697 active techniques** (new `recipes/import/mitre-attack-technique.json`; clean `T1055.011.md` sub-technique filenames) and **NIST CPRT CSF 2.0 → 185 subcategories** (found cleaner than the XLSX path — pre-split id/text, no `[Withdrawn` artifact).
- Test hygiene: repaired two calendar-rotted `DraftStore` tests (hardcoded 2026-05 dates crossed the 30-day expiry window as real time passed; now relative via a `daysAgo()` helper).

### Ingestion harness: XLSX formatted-text fidelity + CIS & SCF ingested (2026-06-12)

- **`raw: false` in the XLSX reader** — CIS stores safeguard "4.10" as the *number* 4.1 with display text "4.10"; `String(4.1)` silently collided it with safeguard 4.1 (one note overwrote the other). Cells are now read as the text Excel displays. Regression-verified: CSF (185) + CRI (472) re-renders byte-identical.
- **CIS Controls v8.1.2** ingested via new `recipes/import/cis-controls-v8.json` → **153 safeguards** (the official count) with IG1-3, asset class, and security function in frontmatter; 18 control group-header rows skip cleanly. Local-only output (CC BY-NC-SA).
- **SCF 2026.1.1** ingested via new `recipes/import/scf-2026-flat.json` → **1,468 controls** (domain + description in frontmatter). Local-only output (CC BY-ND). The sheet's ~250 per-framework mapping columns are the named follow-on (mapping-column melt → crosswalk edges — the STRM proxy into ISO/SOC 2/PCI/COBIT without their text).

### Docs: illustrated "system model" page + Mermaid actually renders now (2026-06-13)

- **New `concepts/system-model.mdx`** — the picture-first, diagram-rich map of the whole system (the visual front door `system-architecture` lacked). Seven hand-authored **HTML/CSS** flow diagrams — the source→vault→answers spine, an explicit **"two doors, one engine" ingest** diagram (wizard *or* harness — pick one, identical Tier 1 either way), the three tiers, the producers (schema-as-primitive), the `render()` + 5-mechanism coupling, vault→query→views, and the two surfaces — every box a clickable cross-link to its deep page. Linked in from the homepage, `system-architecture` (an Aside to the visual version), and the ETL hub.
- **Dropped Mermaid for hand-authored HTML diagrams.** `rehype-mermaid` renders Mermaid via a headless browser at build time, which crashed anywhere Playwright browsers aren't installed — local Windows dev AND the deploy CI (which runs only `bun install` + `bun run build`). The HTML/CSS diagrams render everywhere with no build-time browser, match the dark theme exactly, and carry clickable links. (Bonus finding along the way: Mermaid had never actually rendered in this KB — Astro's Shiki was highlighting the ```mermaid fences into code blocks, so the existing `metadata-ecosystem` diagram was broken too; both are moot now.)
- **`render()` deep-dive + "Hierarchy is a choice" (2026-06-14).** Rebuilt the `render()` section into a **Concept-record + Recipe-rules → finished-note** "lab" (legible species example instead of an opaque taxonomy code; a `split()` transformation deriving folders from one packed key), and added a **"Hierarchy is a choice, not a default"** section — a *same-data-four-shapes* illustration (folder / tag / heading / wikilink) plus the design rationale (closed 5-mechanism grammar, `render()` as the single coupling point, `also_emit` parallelism). Added an honest **"Open question — variable-depth structure"** callout: v0.1 renders fixed/known depth well, but variadic/ragged depth, polyhierarchical tag *layout*, data-driven heading depth, and graph-edge hierarchy are **not** first-class — recorded in a new zz-log and filed as **[Challenge 42](docs/src/content/docs/agent-context/zz-challenges/42-variable-depth-hierarchy-generation.mdx)** (with the author's public prior art — Folder Tag Sync, SEACOW(r), Jsonaut — cited as inputs).

### Rapid-test loop: one-click reset (CLI + in-Obsidian) (2026-06-13)

Completes the test loop so you can clear ad-hoc imports and re-import fast, without nuking the curated corpus — agent-driven and click-driven halves that agree:

- **`bun run reset`** (`scripts/reset-test-vault.mjs`) — clears Crosswalker-generated notes from `test-vault/` outside a protected list (`Frameworks/_licensed/`, `NIST-mini/`, `_crosswalker/`, `GRC analysis/`, `PROVENANCE.md`); dry-run by default, `-- --yes` to delete, prunes empty folders. Double-click `reset.bat` for a preview-then-confirm one-click.
- **"Reset imported notes (dev)" command** in Obsidian — scans for generated notes, groups them by output folder, shows the curated corpus as protected (not deletable), and offers per-folder Delete + "Delete all test notes" buttons. Uses `app.fileManager.trashFile` (honors your trash setting). Pairs with the existing "Import bundled test fixture (dev)" command — load a fixture, reset, repeat. (`src/views/reset-imports.ts`, +4 tests.)

### Import wizard: id-driven folder hierarchy + clearer record picker (2026-06-13)

The headline value prop — turning a flat taxonomy id into a structured vault tree — is now in the **wizard**, not just hand-written recipes.

- **"Folder tree (from id)" column role** — set a taxonomy-id column (e.g. `element_identifier` = `DE.AE-02`) to this role and the wizard parses it into nested folders (`DE/ → DE.AE/ → DE.AE-02.md`) by detecting the id's delimiters (`deriveIdSplitTemplates`: finds the `. - _ / :` that appear in ≥80% of values, ordered by position, emits one `{col|split(d,0)}` folder level each). The "In the vault" preview shows the exact path the id produces. **Smart defaults auto-pick this role** when the title/id column is a structured id — so NIST CPRT now nests by function/category automatically instead of dumping flat. Plumbing: `HierarchyMapping.template` (an explicit folder template overriding `{column}`) threaded through the legacy-recipe shim. +8 tests including end-to-end `generateNotes` producing the nested tree.
- **Record picker shows a concrete example** — each JSON list card now leads with a real example record ("e.g. element_type: subcategory · element_identifier: GV.OC-01 · …", empty fields skipped) so you see *what a record is*, with the confusing raw JSON path (`response → elements → elements`) demoted to a tiny grey "found in the file at:" line.

### Generation engine: concurrent note writes (2026-06-13)

Note generation was fully sequential — one `await vault.create` per row — so large imports (the 906-row CPRT test) crawled. Writes now run in a **bounded concurrency pool** (`forEachConcurrent`, default 8 in flight) in both `generateNotes` (wizard) and `generateFromRecipe` (SSSOM import); the wizard gets it automatically via the default. Correctness is preserved by design: each row's **synchronous prefix** (render + path-collision reservation) runs in row order, so reservation stays deterministic; only the async I/O tail overlaps. A new folder-creation **de-duplicator** (`createFolderEnsurer`) makes each folder + ancestor created exactly once — fixing the race where many concurrent rows targeting the same new folder would otherwise collide on `createFolder`. 11 new tests pin parallelism, the limit, in-order sync prefixes, async-iterable support, folder de-dup, and an end-to-end concurrent-vs-sequential output parity check.

### Import wizard: Step-4 generation screen + id-driven hierarchy showcase (2026-06-13)

- **Generation progress redesigned** — was a tiny default progress bar floating at the top-left of an otherwise-empty modal with the "Generate" button still active. Now a centered card fills the step: spinner, large percentage, accent progress bar, live "N / M notes" count; the footer button greys to "Generating…". Progress updates **in place** instead of re-rendering the entire modal every batch (the old `renderStep()` per-20-rows was a real drag on large imports).
- **Showcase recipe: taxonomy id → vault structure** — `recipes/import/nist-csf-2-cprt-hierarchical.json` decomposes a CSF subcategory id (`DE.AE-02`) into a folder tree (`DE/ → DE.AE/ → DE.AE-02.md`) using the engine's `split`/`regex` template filters on the **single id field** — 6 functions → 34 categories → 185 subcategory leaves, with a proper `nist-csf-2:` curie prefix. Demonstrates [hierarchy primitives](https://cybersader.github.io/crosswalker/concepts/hierarchy-primitives/) + the 5-mechanism grammar; documented as §3.5 of the hands-on tour. Surfaced a named UI-parity gap: the wizard can't yet *derive* hierarchy by parsing an id (only whole-column-as-folder) — it's recipe/harness-only for now.

### Import wizard: guided UX pass — record picker, smart defaults, visual previews (2026-06-13)

A usability iteration after first hands-on testing, so the import "feels magical" instead of demanding config knowledge:

- **JSON record picker** — no more typing `$.objects[*]`. The wizard inspects the file, finds every list of records inside it, and offers them as selectable cards (radio + record count + field-name chips). Primary-record lists rank above relationship/mapping lists, so e.g. NIST CPRT's `elements` (concepts) is pre-selected over its larger `relationships` list. The path syntax moves to an "Advanced" disclosure as the escape hatch. Root-array files show "this whole file is your list." (`suggestIterators()` in `json-parser.ts`, +4 tests.)
- **Smart column defaults** — Step 2 arrives pre-configured with ✨-badged role suggestions (a real title/name column → Note title, a low-cardinality `family`/`category`/… → Hierarchy, a long-text `description`/`text` → Body). A matched saved config still supersedes them. Crucially, a title/name column is only suggested when it actually has distinct values — a fix for NIST CPRT, whose `title` column is 100% empty and silently produced 0-note generations.
- **Loud failures** — a generation that creates 0 notes (or hits row errors) now raises a warning notice naming the first cause, instead of a silent "success."
- **Visual previews** — Step 2 shows prominent row/column stat cards + a "what each column becomes in the vault" preview column; Step 3 replaced the ASCII tree + raw-markdown dump with stat cards, a real folder tree, and a mock note card (properties block + body), with raw markdown tucked into a disclosure.
- **Wide-source UX** — Step 2 column filter + collapse of the all-default tail (special-role columns pinned) for sources like SCF (369 columns).
- **Build fix** — `esbuild.config.mjs` watch now re-copies `styles.css` + `manifest.json` on change (previously copied once at startup, so mid-session CSS edits silently never deployed).

### Import wizard: XLSX + JSON parsing — UI-parity gap #1 closed (2026-06-12)

The wizard no longer stubs Excel and JSON ("not yet implemented" since the MVP) — both formats now parse through the same logic the headless harness proved on the real corpus ([UI parity audit](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-06-12-ui-parity-audit/): UI first, config as the escape hatch).

- **XLSX**: new `src/import/parsers/xlsx-parser.ts` — Step 1 gains a **sheet picker** (loaded on file select) and a **header-row offset** for banner rows. Carries the harness's hard-won contracts: formatted-text fidelity (`raw: false` — the CIS "4.10-stored-as-4.1" collision), header-key normalization (`\r\n` in header cells).
- **JSON**: new `src/import/parsers/json-parser.ts` — Step 1 gains **iterator path** (`$.objects[*]`; empty = root array; errors list the keys that exist) and **row filter** (`type=attack-pattern,revoked!=true`) inputs. The shared core moved to `src/import/parsers/json-source-core.ts`; the harness now imports it from there (one reader, two doors — a working wizard config IS a working harness invocation).
- +11 unit tests (`tests/wizard-parsers.test.ts`) pinning the 4.10 trap, banner-row skipping, sheet errors listing available names, and the STIX iterator+filter shape; new `visual-wizard-formats.spec.ts` drives the real wizard UI (DataTransfer file injection → Step-1 controls → parse → Step-2 columns).

### Ingestion: SCF mapping-column melt — the STRM proxy hub goes live (2026-06-12)

- **New extractor `tools/crosswalk-from-melt.ts`** unpivots wide mapping-column sheets into crosswalk edges (subject row × framework column × each id listed in the cell), through the same `render()` + AJV gate as the other extractors. Shared edge-emission helpers factored into `tools/lib/crosswalk-shared.ts` (one source of truth for the SKOS→STRM map, depad, wikilink, YAML, and SSSOM TSV emission — the OLIR tool now imports it, byte-identical output verified).
- **SCF hub melted in one pass: 5,675 edges into 7 frameworks** (CIS 429 / CSF 611 / 800-53 1,117 / ISO 27001 316 / ISO 27002 506 / SOC 2 TSC 1,478 / PCI DSS 1,218). The ISO/SOC 2/PCI sets are the STRM proxy — coverage into copyrighted frameworks carrying only their control ids, never their text. Flat columns carry no relationship types (SCF's STRM detail exists only as 185 PDFs), so melt edges are honest `intersects_with`.
- **`--where` is now format-agnostic** in the fixtures harness (was JSON-only) — e.g. `--where 'CIS Safeguard='` selects CIS's control-level group-header rows, which back-filled 18 CIS control notes (new `recipes/import/cis-controls-v8-controls.json`). With melt-side `--object-id-sub` normalizing SCF's `1.0`-style control refs, every SCF→CIS edge resolves on both ends.
- **Corpus link integrity: 23,396 wikilinks, 99.82% resolve** (42 dead, all genuinely-absent concepts). New GRC view: `Framework adoption/3 - SCF hub - adopt once satisfy many.base` — SCF family × framework coverage matrix.

### Crosswalks: SKOS→STRM direction fixed + navigable edges + GRC analysis views (2026-06-12)

- **SKOS→STRM direction bug fixed** — the map in `src/import/sssom-importer.ts` (and its mirror in the OLIR tool) inverted standard SKOS: `A skos:broadMatch B` means B is the broader concept (A ⊂ B), but we emitted `A is_broader_than B`. Now `broadMatch → is_narrower_than` / `narrowMatch → is_broader_than`, **pinned by a new unit test** so the two maps can't silently re-invert. All three edge sets regenerated; committed SSSOM TSVs unaffected (they store the SKOS wire format).
- **Edges are navigable** — `crosswalk-from-olir.ts` gains `--depad` (canonicalizes OLIR's zero-padded `AC-01` → NIST's `AC-1`) and `--subject-note-folder`/`--object-note-folder` (emit folder-qualified `subject_note`/`object_note` wikilinks + linked bodies). 7,732 links across the corpus, **99.5% resolve**; CSF function/category hierarchy notes back-filled from CPRT (`recipes/import/nist-csf-2-cprt.json`) to catch group-level mappings. Residual unresolved ids are genuinely-absent concepts (3 family-level 800-53 refs, IA-13 from r5.1.1, and ~11 CRI v2.2 extension ids that masquerade as CSF ids).
- **GRC analysis suite extended** (`test-vault/GRC analysis/`): CSF×CRI triangle heatmap, an AC-2 "concept 360" lookup across all crosswalks (click-through links), a `Framework adoption/` lens (CIS IG1/IG2/IG3 maturity slices — 56/130/153; SCF 33-domain browser — headline finding: AI & Autonomous Technologies is now SCF's largest domain at 156 controls), plus a narrative index note. New `visual-grc-analysis.spec.ts` screenshots the suite in real Obsidian.

### Crosswalks: CSF → CRI edges — the proving-ground triangle completes (2026-06-12)

- `tools/crosswalk-from-olir.ts` gains `--header-row` (skip banner rows above the headers — partial fix for the per-sheet banner-row snag) and the same `raw: false` formatted-text fidelity as the fixtures harness. Regression-verified byte-identical: CSF→800-53 (740 edges + committed SSSOM TSV) and CRI→800-53 (1,039 edges).
- **CSF 2.0 → CRI extracted** — the CRI workbook's "NIST CSF v2 Mapping" sheet turned out to be OLIR-shaped (just differently-labeled columns), so `--header-row 3` + `--subject-col`/`--object-col` aliases sufficed: **154 edges, 0 skipped** (49 exact / 92 broader / 13 related), local-only. All three proving-ground edges (CSF↔800-53, CRI↔800-53, CSF↔CRI) now exist; the SKOS→STRM direction snag now gates three directional edge sets and moves to the top of the queue.

### Fixtures: example `.base` generation + test-vault cleanup (2026-06-05)

- `bun run fixtures` now also emits committed reference `.base` files (from `tools/fixtures/examples/`) into the synthetic `NIST-mini/` fixture set via a new `--examples <dir>` flag — so the public, non-licensed fixture vault ships with ready-to-open native-Bases example views (grouped table / cards / flat) for testing feature alignment. `--clean` wipes + regenerates them, keeping the fixture vault self-cleaning and iterable.
- Removed stale `test-vault/Frameworks/{Access Control,Audit,Configuration Management}/` — leftover folder-per-control experiments from an old `sample-nist-controls.csv` run (the duplicate `AC-1.md` notes that made wikilink resolution ambiguous). The Frameworks folder is now just `_licensed/` (gitignored, real import) + `NIST-mini/` (synthetic, regenerable).

### Crosswalk pivot — reads per-view config + real heatmap shading (2026-06-05)

Screenshot verification (real Obsidian via the WebdriverIO + WSLg harness) caught two latent bugs that made every `crosswalkerPivot` heatmap render as a plain, identical-looking number grid:

- **Per-view config is read again**: current Obsidian Bases parses a view's options into `view.data` (top-level — where native views keep `order`/`groupBy`); `view.config` is reserved and `null` for custom views. The resolver now reads `view.data`, preferring top-level keys and falling back to a nested `data.config` block for older `.base` files. Before this, `rowsBy`/`colsBy`/`heatmap` were silently dropped and every pivot fell back to defaults — so two differently-configured views rendered identically.
- **Heatmap actually shades**: with `heatmap: true` now applied, cells fade transparent→accent by a **perceptual sqrt intensity** curve (coverage counts are long-tailed; a linear scale washed the mid-range out to near-white). Endpoints unchanged; mid-range cells now visible.
- **`.base` recipes**: pivot options now sit at the view's top level (canonical Bases shape); the nested `config:` block is still honored for back-compat.
- **Visual-test infra**: `tests/e2e/visual-control-lens.spec.ts` screenshots the pivot + views via the wdio harness so rendering regressions are caught in-loop, not by eyeballing.

### Crosswalk views — custom Bases pivot works on current Obsidian + rollup-by-default (2026-06-04)

Driving the real crosswalk corpus through Obsidian surfaced (and fixed) a cluster of Bases-lifecycle incompatibilities in the `crosswalkerPivot` custom view — it now renders, configures, and tears down cleanly on current Obsidian Bases.

- **Receives data + config again**: reads filtered entries from `controller.results` (a `Map` in current Bases, not the old `controller.entries` array), the per-view `config:` from `query.views[]`, and frontmatter from `entry.frontmatter` (not `.properties`). Handles Map / iterable / wrapped-value shapes.
- **Lifecycle no-ops** (`focus`, `getEphemeralState`/`setEphemeralState`, `getState`/`setState`, `onResize`) so leaf-switching + workspace-restore don't throw "x is not a function" and silently abort navigation.
- **Rollup by default**: pivot defaults to `subject_group × object_group` (compact function×family matrix) when edges carry group fields, else leaf `subject_id × object_id`. Removed the noisy "sparse pivot" warning bar (coverage matrices are inherently sparse).
- **Edges carry rollup axes**: `crosswalk-from-olir.ts` + `crosswalk-edge.json` emit `subject_group`/`object_group` (CSF function / 800-53 family) + `source_framework`/`target_framework`.
- **Decision log**: four dials — layout · join · shape · view-settings (a pivot is a *shape*, not a join; the join feeding it decides whether gaps show).
- **Roadmap**: parked incremental Tier 2 projection (kill the load-time reproject) + a "this will be heavy — load anyway?" confirm gate.
- Tests: 545 pass.

### Ingestion harness — recipe `split` / `regex` / `trim` template filters + zz-log label guard (2026-06-03)

Running the real GRC framework corpus through the headless ingestion harness (`tools/generate-fixtures.ts` → real `render()` + a `Recipe`) surfaced the first field-shape requirement and turned it into a first-class construct instead of harness glue.

- **Three new template filters** in the closed set (`src/render/template.ts`), usable from any recipe's `{var|filter}` expressions:
  - `split(<delim>,<index>)` — nth (0-based) delimiter segment, trimmed (e.g. CSF's `"DE.AE-01: Adverse events…"` → `split(:,0)` → `DE.AE-01`; `split(:,1)|trim` → the name)
  - `regex(<pattern>)` — first match, or first capture group if present
  - `trim` — strip surrounding whitespace
- **First per-framework import recipe using them:** `recipes/import/nist-csf-2.json` — NIST CSF 2.0 → 185 subcategory concepts with clean `DE.AE-01.md` ids + split-out titles, all through the production engine.
- **Regression test** pinning `fs-safe`'s hyphen/paren preservation (guards the latent control-byte bug fixed in the prior commit).
- **New guard** `bun run check:log-labels` — every `zz-log/*.mdx` must carry a `sidebar.label` prefixed with its filename's `MM-DD ·` date, so dev/decision logs can't drift undated in the sidebar again. Fixed 4 previously-undated labels (streaming-refactor, phase-5-scope, logging-infra, query-state).
- **Tests:** 34 suites / 545 tests / all pass (+3 filter tests).
- **Header-key normalization** in the XLSX reader — collapses the embedded `\r\n` that NIST/CRI workbooks bake into header cells (`Profile\r\nId`, `Focal Document\r\nElement`), so recipes reference clean single-space column names. CSV path unaffected (no fixture drift).
- **Depth-first end-to-end slice** — drive a small set (NIST CSF 2.0 ↔ 800-53 ↔ CRI Profile v2.2, the FI-sector hub) all the way to a rendered Bases coverage pivot, rather than accumulating import recipes that stop at Tier 1. **Stage A** (nodes → Tier 1): all three frameworks render to concept notes (1,189 + 185 + 472) through the production engine. New recipe `recipes/import/cri-profile-v2-2.json`.
- **`crosswalk-from-olir.ts`** — a reusable tool turning NIST-OLIR mapping workbooks into Tier 1 `crosswalk-edge` notes via the real `render()` engine + a generic `recipes/import/crosswalk-edge.json`, plus a standard SSSOM TSV artifact. OLIR→SKOS→STRM predicate chain; every note AJV-validated against `spec/tier1.schema.json` before write. **Stage B**: CSF→800-53 (740 edges, public — pivot-ready) + CRI→800-53 (1,039 edges, local). First committed crosswalk asset: `recipes/import/crosswalks/nist-csf-2-to-nist-800-53.sssom.tsv`. Manual pivot-render guide: `TEST_CROSSWALK_PIVOT.md`.
- CRI's copyrighted source, all slice concept/edge notes, and CRI mapping data stay gitignored; only constructs (recipes, tools, the public SSSOM TSV) are committed.

### v0.1.6 Phase 6.3 — Benchmark + bundled-fixture import (testable surface) (2026-05-19, ✅ Done)

User direction (2026-05-19): "keep moving forward to the point where I'll be able to start testing myself again. But also wire things into logging so we can test for speed, optimization, hardware usage." Two new commands give end-to-end visibility into the new primitive substrate without needing existing vault data.

**New modules:**
- `src/views/benchmark-primitives.ts` — synthesizes data at varying scales (default 100/1k/10k rows), times every primitive (array + streaming) with `performance.now()`, emits NDJSON `perf` events into the existing debug log. Functions: `runBenchmark(opts) → BenchmarkSummary`, `generateConcepts(n)`, `generateMappings(n, conceptCount)`, `formatBenchmarkSummary(summary)`. Deterministic synthetic data — reproducible numbers across runs.
- `src/views/bundled-fixtures.ts` — 2 realistic SSSOM crosswalks (ISO 27001→SOC 2 with 10 mappings; NIST CSF→MITRE ATT&CK with 13 mappings) bundled inline as TSV strings (~6KB total). One-click import via the new command below — no manual file copying.

**New commands:**
- `Crosswalker: Run primitives benchmark (perf)` — calls `runBenchmark()`, logs ~26 per-primitive timing events (category=`perf`, op=`<primitive>-<mode>`), copies formatted summary to clipboard, surfaces a Notice with total duration + result count. Runs in ~1-2s on typical desktop hardware.
- `Crosswalker: Import bundled test fixture (dev)` — modal lists the 2 bundled SSSOM crosswalks, user picks one, plugin runs `importSssom()` directly → junction notes land in `_crosswalker/mappings/<source>-to-<target>/`. Pivot views can now render with real data.

**Tests:** 33 suites / 530 tests / all pass (+6 from 524 baseline).
- `tests/benchmark-primitives.test.ts` (6 tests) — generator determinism, mapping coverage ~70%, benchmark produces results at every scale, array vs stream variants both run for streamable primitives, diff is array-only, formatBenchmarkSummary produces multi-line output.

**What this unblocks for user testing:**
- Run the benchmark → see speed numbers + per-primitive timings in `crosswalker-debug.log` (filter `category=='perf'`)
- Import the bundled crosswalk → pivot view renders with real junction notes instead of the diagnostic empty state
- Both commands work offline / without prior vault data → zero-config testing

**Sample benchmark log shape** (NDJSON, one event per timing):
```json
{"ts":"2026-05-19T...","level":"info","category":"perf","op":"inner-join-stream","msg":"inner-join (stream) over 10000 rows","trace_id":"a1b2c3d4","primitive":"inner-join","mode":"stream","inputSize":10000,"outputSize":4200,"durationMs":12.4,"rowsPerSec":806451}
```

### v0.1.6 Phase 6.2 — Streaming Layer A primitives (iterable-first) (2026-05-19, ✅ Done)

User direction (2026-05-19): "make sure the join logic on the back end is all optimized from the beginning... streaming approach... certain operations aren't optimized yet across tooling." Phase 5+6 shipped Layer A primitives as `Array → Array`, which would have locked every recipe-runtime consumer to materialized intermediate results. Decision: refactor to **iterable-first** shape NOW, before wiring the recipe-runtime composer. See [Streaming primitive refactor log](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-19-streaming-primitive-refactor/) for full reasoning + streamability matrix.

**Pattern**: hash-build the smaller (right) side; stream the larger (left). DuckDB / Polars / ChunkyCSV pattern. Memory bounded by smaller side.

**New module**:
- `src/views/filter-primitive.ts` — explicit Layer A filter (was previously implicit Bases-native). `filter()` array form + `filterStream()` generator + `filterStreamAsync()` for I/O-bound sources.

**New streaming variants** (alongside existing array forms — backward compat preserved):
- `bind-primitive.ts`: `bindStream()` + `bindManyStream()` — pure generators, single-pass, lazy
- `join-primitives.ts`: `innerJoinStream()` / `leftOuterJoinStream()` / `antiJoinStream()` (hash-build right; stream left). `rightOuterJoinStream` / `fullOuterJoinStream` materialize then delegate (callers should swap sides for true streaming when right side is large). `executeJoinStream()` dispatcher.
- `set-op-primitive.ts`: `intersectionStream()` / `differenceStream()` / `unionStream()` (right hashed; left streamed). `setOpStream()` dispatcher. Union with `right`/`merge` conflict strategies is documented as not pure single-pass (caller can dedup downstream).

**Streamability matrix** (locked):

| Primitive | Single-pass streamable? | Memory |
|---|---|---|
| filter / bind / project | ✅ Trivially (generators) | O(1) per row |
| aggregate (count/sum/min/max) | ✅ Accumulator | O(1) per group |
| aggregate (median/percentile) | ⚠️ Defer to Tier 2 SQL | — |
| inner / left-outer / anti-join | ✅ Hash right; stream left | O(right) |
| right-outer / full-outer join | ⚠️ Both sides indexed | Materialized |
| set-op (union/inter/diff) | ✅ Hash one; stream other | O(hashed-side) |
| diff | ❌ Both sides indexed (inherent) | Materialized — documented in module header |
| traverse(depth=*) / closure | ❌ Iterative fixpoint | Stays Tier 2 SQL |

**ChunkyCSV alignment**: same shape as user's prior chunked-iterable + hash-build-join pattern. IMPORT-side already aligned via v0.1.4.5 (PapaParse → `AsyncIterable<Row>` → generation engine); QUERY-side now matches. We don't write new *core* logic — borrowed standard CS (hash-build join, accumulator aggregate, generator filter). The novel piece deferred to v0.1.7+ is the spill-to-disk integration with Tier 2 sqlite-wasm when in-memory hash exceeds budget.

**Ch 34 — Streaming query execution** ([brief](https://cybersader.github.io/crosswalker/agent-context/zz-challenges/34-streaming-chunked-query-execution/)) — filed 2026-05-08, deliverable not yet run. Queued in parallel with this refactor for fresh-agent research session on DuckDB out-of-core / Polars streaming / DataFusion chunked execution patterns to inform the v0.1.7+ spill-to-disk work.

**Tests:** 32 suites / 524 tests / all pass (+15 from 509 baseline).
- `tests/integration/streaming-primitives.test.ts` (15 tests):
  - Array/stream parity per primitive over realistic fixtures (CSF, 800-53, ISO 27001, SOC 2, CIS v8, ATT&CK, 3 crosswalks)
  - Lazy evaluation probe (generator doesn't consume input until iteration)
  - "Hash-build is on the right side" memory-shape probe (right fully consumed before left starts producing matches)
  - Pipelined composition: `filterStream → bindStream → antiJoinStream` end-to-end

Backward-compat: every existing test continues to pass against the array overloads. No public API broken.

### v0.1.6 Phase 6.1 — Integration tests over realistic fixtures (2026-05-19, ✅ Done)

User audit (2026-05-19): "Did the tests actually use real data, or example files?" Honest answer was no — all unit tests through Phase 6 used hand-crafted toy data; the realistic fixtures under `tools/fixtures/realistic/` were sitting unused (zero `grep` hits across `tests/`). This phase closes that gap.

**New test helper**: `tests/helpers/fixture-loader.ts` — pure-function loaders for the 9 realistic fixtures:
- `loadConceptFixture(name)` returns typed concept rows (CSF, 800-53 AC, ISO 27001, SOC 2, CIS v8, MITRE ATT&CK Persistence subsets)
- `loadCrosswalkFixture(name)` returns typed crosswalk rows; coerces `confidence` to number; auto-strips SSSOM TSV header comments
- `REALISTIC_FIXTURES` const lists every fixture by category for parameterized "every fixture parses" sanity tests

**New integration suite**: `tests/integration/primitives-on-realistic-data.test.ts` — 30 tests in 8 describe blocks:
- Loader sanity (9 tests) — every fixture parses + has expected row shape
- `filter` over CSF function = "GOVERN" + 800-53 top-level controls
- `bind` derived CURIEs, title-length metrics, confidence-threshold flags over real SSSOM rows
- `aggregate` group-by-count over CSF concepts + crosswalk predicates
- `anti-join` "CSF concepts with NO mapping to ATT&CK" + "ISO concepts unmapped to SOC 2"
- Join modes — `innerJoin` CSF × 800-53 crosswalk (overlapping fixture data), `leftOuterJoin` preserves all CSF concepts, cross-fixture traversal back to AC controls
- `set-op` realistic comparisons — CIS ∩ SOC 2 empty (different id naming); CIS ∪ SOC 2 = sum (no key collisions); CSF concepts NOT subjects of CSF→800-53 mappings
- `diff` synthesized v1→v2 deltas over real concept rows: renamed title detection, audit-timestamp noise ignored via `ignoreFields`, fuzzy `confidence` comparison via custom `equalsFn`
- Cross-fixture composition — pipeline `filter → bind → executeJoin` for "AC controls referenced by high-strength CSF mappings"; framework-overlap-by-id query

**Realistic-data findings that the tests document via passing assertions**:
- CSF concepts fixture covers GOVERN+IDENTIFY; CSF→ATT&CK mapping targets PROTECT+DETECT — `inner-join over non-overlapping fixture subsets returns empty (realistic data shape)` test explicitly captures this
- Join field-merging: right-side `id` becomes `r_id` when both sides have `id` (default `rightPrefix='r_'`)
- Match-type → strength mapping (`exact: 1.0, close: 0.85, broad: 0.7`) used for confidence-style filters when source crosswalks use enum match_type instead of numeric confidence

**Tests:** 31 suites / 509 tests / all pass (+30 from 479 baseline). Build + lint clean.

This is the integration-test foundation v0.1.7+ work builds on — same loader powers future exporter tests, recipe-runtime tests, and Tier 2 SQL helper tests.

### v0.1.6 Phase 6 — Layer A primitive expansion (bind / set-op / diff) (2026-05-18, ✅ Done)

Closes the [Ch 29 8-primitive set](https://cybersader.github.io/crosswalker/agent-context/zz-research/2026-05-09-challenge-29-ontology-web-query-verbs-validation/). The locked Layer A vocabulary is now complete: `filter / traverse / bind / project / aggregate / anti-join / set-op / diff`. Ships the three additions from Ch 29's revision in pure-function form, engine-neutral, no Obsidian dependency.

**Concept page brought in sync**: [`query-primitives.mdx`](https://cybersader.github.io/crosswalker/concepts/query-primitives/) was stale (still showed the old 7-primitive candidate set with a "pending Ch 29 validation" callout). Rewritten to lock the 8-primitive set with: (a) the "Locked — Ch 29 outcome" tip, (b) the 8-primitive table, (c) net-changes list (drop closure, demote pivot, add bind/set-op/diff), (d) worked examples for the three additions ("Concepts in both NIST CSF and CIS" → set-op; "What changed in CSF v1.1 → v2.0?" → diff; "Evidence older than 1 year" → bind), (e) "What's NOT a primitive" table expanded with Ch 29's explicit rejects (rank, window functions, constraint-satisfy, federation), (f) algebraic-closure section, (g) engine-neutrality cross-link to Commitment #5.

**New modules** (pure-function Layer A primitives):
- `src/views/bind-primitive.ts` — `bind(rows, name, fn)` adds a derived column from a formula. `bindMany(rows, [...bindings])` chains them. Same shape as SPARQL `BIND`, SQL `AS`, pandas `assign`.
- `src/views/set-op-primitive.ts` — `setOp(left, right, {keyOf, mode, conflictStrategy?})` for union / intersection / difference. `conflictStrategy: 'left' | 'right' | 'merge'` controls field-merging on key collisions. Inexpressible without this primitive: "controls in BOTH NIST and CIS" (intersection) and any framework-overlap query.
- `src/views/diff-primitive.ts` — `diff(before, after, {keyOf, equalsFn?, ignoreFields?})` returns `{added, removed, changed}`. Each `changed` record includes `before`, `after`, and a per-field `changedFields` list. `ignoreFields` for audit-noise (e.g. `last_reviewed`, `generated_at`). Custom `equalsFn` for fuzzy comparison. The primitive required for v0.1.8 audit-trail attestations.

**Tests:** +47 net new (30 suites / 479 tests / all pass; 432 baseline).
- `tests/bind-primitive.test.ts` (12 tests) — numeric/string/boolean derivations, no-mutation, name-collision overwrite, empty input, chained bindMany.
- `tests/set-op-primitive.test.ts` (15 tests) — union/intersection/difference + 3 conflict strategies + function key extractors + empty inputs + dispatcher routing.
- `tests/diff-primitive.test.ts` (20 tests) — added/removed/changed detection, unchanged-on-request, ignoreFields, custom equalsFn, nested object + array comparison, function keyOf, worked example ("CSF v1.1 → v2.0").

**Algebraic shape (the 8 Layer A primitives — locked):**

| # | Primitive | Status |
|---|---|---|
| 1 | filter | Bases-native (since v0.1.1) |
| 2 | traverse (subsumes closure via depth=*) | Tier 2 SQL (v0.1.5) |
| 3 | bind | **Pure function (Phase 6)** |
| 4 | project | Bases-native (since v0.1.1) |
| 5 | aggregate | Bases summaries + Tier 2 SQL (v0.1.5) |
| 6 | anti-join | Pure function (Phase 5) + Tier 2 SQL |
| 7 | set-op | **Pure function (Phase 6)** |
| 8 | diff | **Pure function (Phase 6)** |

**What this unblocks:**
- v0.1.7 recipe schema can declare `bind` formulas + `set-op` mode + `diff` snapshot pairs at the recipe level
- v0.1.7 exporters consume diff output (delta logs between vault snapshots)
- v0.1.8 audit-trail uses `diff` as the load-bearing primitive for attesting "what changed since the last signed release"

**Deferred** (out of Phase 6 scope by design):
- Recipe-level YAML compilation of bind formulas (today the formula is a TS function; v0.1.7 adds string-formula → function compilation at recipe load time)
- Wiring set-op and diff into the recipe runtime (Phase 5's join-primitives integrated into the pivot view; Phase 6's three primitives are available as the substrate but not yet referenced by any shipped recipe)
- Tier 2 SQL implementations of set-op and diff (today they run in-memory over row-sets; for ontology-scale snapshots v0.1.7+ may move them to sidecar queries)



### v0.1.6 Phase 5 — Join primitive substrate + materialization + sparse-pivot HARD guard (2026-05-18, ✅ Done)

Reframed per [Phase 5 scope log](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-18-phase-5-scope-join-primitive-substrate/) from "outer-join pivot retrofit" to "Layer A join primitive substrate that powers all view shapes." Pivot is one consumer; table / list / hierarchy / timeline shapes (v0.1.7+) compose against the same primitives.

**New modules:**
- `src/views/join-primitives.ts` — 5 pure-function Layer A primitives matching the [query-primitives concept](https://cybersader.github.io/crosswalker/concepts/query-primitives/):
  - `innerJoin` — rows where both sides match (current default)
  - `leftOuterJoin` — preserve all left rows; null-pad right ("controls without evidence" gap analysis)
  - `rightOuterJoin` — mirror
  - `fullOuterJoin` — preserve both sides
  - `antiJoin` — Layer A primitive #5: LEFT rows with NO match in right ("X without Y")
  - `executeJoin(left, right, {mode})` dispatcher
- `src/views/materialize.ts` — shape-agnostic snapshot writer. Writes `<slug>/materialized/result.json` per Layout B+. Stable JSON key order (git-diff friendly). `lookupQuery(app, slug)` + `markStale(app, slug)` helpers. Reusable for v0.1.7 (table/list) + v0.1.8 (audit snapshots) without modification.

**Schema:** `spec/recipe.schema.json` `Join.kind` enum extended `["inner", "left", "right", "outer", "anti"]` with description aligned to runtime semantics.

**Pivot view updates** (`src/views/crosswalker-pivot-view.ts`):
- HARD guard at 250K cells — blocks render with explicit message instead of locking the UI
- Replaced silent empty grid with `renderDiagnosticEmpty()` — explains likely causes (missing SSSOM imports, filter scope, confidence threshold) and how to fix
- Sparse-pivot SOFT warning preserved (renders the table with a banner above)

**Commands added:**
- `Crosswalker: Materialize this query (snapshot)` — opt-in; runs on the active query's `index.md`; writes the JSON snapshot at `<slug>/materialized/`. Default browse remains live.

**Tests:** +28 net new (27 suites / 432 tests / all pass; 404 baseline). New files: `tests/join-primitives.test.ts` (20 tests covering all 5 modes + edge cases + dispatcher + function extractors), `tests/materialize.test.ts` (8 tests covering stable JSON serialization + idempotent overwrite + metadata + stale.flag + lookup).

**What this unblocks:**
- v0.1.7 table / list / hierarchy view shapes compose against the join primitives directly
- v0.1.7 exporters (OSCAL / SSSOM / STRM) consume materialized result.json
- v0.1.8 per-query audit snapshots use the same writer

**Deferred to v0.1.7+** (out of Phase 5 scope by design):
- Pivot view actually RENDERING outer-join axes from source ontology concepts (needs recipe-level `axis_sources` config — adds complexity to filter resolution; Phase 5.5 or v0.1.7)
- `bind` / `set-op` / `diff` Layer A primitives from Ch 29 revision
- Full SPARQL property-path traversal in Tier 2 sidecar



### v0.1.6 Phase 4.7 — 3-command UX split: Embed existing + Browse queries (2026-05-18, ✅ Done)

Completes the synthesis-log §3 "create / embed / browse" command split that Phase 4.6 deferred. Now the user has three distinct surfaces matching three distinct mental models:

| Command | Cost | Mental model |
|---|---|---|
| `Insert query into note` (existing, Phase 4.6) | Heavy — modal + params + folder write | "Create a new analysis" |
| **`Embed existing query into note`** (NEW) | Lightweight — pick from list, insert reference | "Show this query here" |
| **`Browse my queries`** (NEW) | Discovery surface | "What queries exist in my vault?" |

**New modules:**
- `src/views/query-scanner.ts` — pure read function. `scanQueries(app)` walks `_crosswalker/queries/**/index.md`, returns validated entries sorted by `generatedAt` DESC. `formatParamsSummary()` for display. Used by both pickers.
- `src/views/embed-existing-query-modal.ts` — minimal modal: cards listing each query with slug + recipe + shape badges + params summary + "Embed at cursor" button. Resolves with `{slug, viewFile}`.
- `src/views/browse-queries-modal.ts` — full discovery surface. Per-row actions: **Open canonical** (opens `index.md`), **Embed in active note** (only enabled when an editor is active), **Delete** (with confirmation prompt covering "embeds will become broken links").

**Tests:** +12 new (25 suites / 404 tests / all pass; 392 Phase 4.6 baseline). New file: `tests/query-scanner.test.ts`. Covers: empty vault, canonical-path filtering (ignores stray host-note frontmatter), sort order (DESC), malformed-frontmatter skip, full metadata roundtrip.

### v0.1.6 Phase 4.6 — Query-state-location refactor (Layout B+) (2026-05-18, ✅ Done)

Implementation of the Ch 38 synthesis decision. Re-homes the Phase 4.5 architecture from "frontmatter on host note + flat `.base` in views/" to "per-query folder under `_crosswalker/queries/<slug>/` with `index.md` as canonical state + `view.base` as generated sibling + reserved derivative subfolders."

**Schema bump 1 → 2:**
- New required `slug` field (kebab-case ASCII, max 48 chars)
- New `view_file` path pattern: `_crosswalker/queries/<slug>/view.base` (replaces flat `_crosswalker/views/<query_id>.base`)
- v1 backward-compat reader (`validateQueryFrontmatterV1`) preserved for one minor version; migration command converts on user trigger

**New modules:**
- `src/views/query-frontmatter-schema.ts` v2: + `slugify()` (kebab-case + reserved-names + max-length + fallback-to-`query-<id8>`); + `addCollisionSuffix()` (`-<4hex>` for programmatic); + `queryFolderFor()` / `indexFileFor()` / `viewFileFor()` / `legacyViewFileFor()` path helpers
- `src/views/migrate-query-layout.ts` (NEW): one-shot idempotent migration. For each host note with v1 `crosswalker_query:` frontmatter, creates `_crosswalker/queries/<slug>/{index.md, view.base}`, rewrites embeds in the host, optionally renames host frontmatter to `crosswalker_query_legacy:` (default) or strips it
- `src/views/apply-query-to-note.ts` rewritten: writes to canonical folder; supports `existingSlug` (UPDATE flow) + `collisionMode` (`refuse` / `auto-suffix` / `force-new`); host note gets only the embed at cursor — NO frontmatter

**Updated modules:**
- `src/views/regenerate-query-views.ts`: walks `_crosswalker/queries/**/index.md` only; counts legacy v1 host-note frontmatter for migration prompting via `legacyDetected`
- `src/views/insert-base-block.ts`: `buildEmbed()` strips `_crosswalker/queries/` prefix → emits short `![[<slug>/view.base]]` form; `noteContainsEmbed()` recognizes both forms
- `src/views/recipe-picker-modal.ts`: PickerAction includes `recipeName` (for slug derivation)
- `src/views/reference-base-files.ts`: SKILL.md rewritten to teach Layout B+
- `src/main.ts`: new `crosswalker:migrate-query-layout` command; `insert-query-into-note` checks for legacy v1 frontmatter on host and blocks with Notice "Migrate first"

**Commands added/changed:**
- NEW: `Crosswalker: Migrate queries to folder layout` — one-shot idempotent migration
- CHANGED: `Crosswalker: Insert query into note` — Layout B+ CREATE flow with `auto-suffix` collision mode (default in picker)

**Tests:** +33 net new (24 suites / 392 tests / all pass). New file: `tests/slug-derivation.test.ts` (21 tests). Updated: `tests/query-frontmatter-schema.test.ts`, `tests/query-frontmatter-io.test.ts`, `tests/apply-query-to-note.test.ts`, `tests/regenerate-query-views.test.ts`.

**Edge cases handled** (per synthesis log §4): slug derivation (kebab-case, reserved names, length, fallback), CREATE collision (refuse/auto-suffix), UPDATE preserves `query_id` + `slug`, idempotent regenerator, legacy v1 detection, malformed frontmatter graceful error.

### Ch 38 resolution + Phase 4.6 planning — Query state location synthesis (2026-05-18, ✅ Resolved)

Two convergent fresh-agent deliverables resolved [Challenge 38](https://cybersader.github.io/crosswalker/agent-context/zz-challenges/archive/38-query-state-location-and-folder-note-pattern/) (filed 2026-05-18, gating Phase 5). Both deliverables rejected the literal folder-note `index.md` magic-embed pattern (would require LostPaul Folder Notes community plugin, violating Commitment #3 mobile parity).

**Locked: Layout B+** (per [synthesis log 2026-05-18](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-18-query-state-location-synthesis/)):
- Per-query folders at `_crosswalker/queries/<slug>/` with `index.md` as canonical state + `view.base` as generated sibling
- Reserved derivative subfolders: `materialized/` (Phase 5), `exports/` (v0.1.7), `snapshots/` (v0.1.8)
- Embed format: explicit `![[<slug>/view.base]]` (no folder-note magic; vanilla Obsidian + Mobile)
- Slug-collision: refuse-and-prompt (interactive picker) + `-<4hex>` (programmatic)
- `query_id` is durable identity; slug is rename-safe (via Obsidian's auto-update-links)
- Schema bump 1 → 2 records the canonical-location change
- ~20-case edge-case policy table in synthesis log §4

**Phase 4.6 (next sub-phase, ~½–1 day)** ships:
- New `src/views/migrate-query-layout.ts` + `Crosswalker: Migrate queries to folder layout` command
- Edits to 5 source files (frontmatter-schema, apply-query, regenerate, insert-embed, reference-base-files)
- ~+40 new tests (slug derivation, collision policy, migration idempotency)
- Re-homes Phase 4.5 architecture (canonical state moves; not reverted)

This unblocks Phase 5 (materialization writes to `<slug>/materialized/`).

### v0.1.6 Phase 4.5 — Frontmatter-driven query notes + `.base` file generation + `![[embed]]` (2026-05-15, ✅ Done; re-homed by Phase 4.6)

User architecture call surfaced that Phase 4's inline ` ```base ` codeblock flow used the wrong embed syntax — Obsidian Bases' canonical embed is `![[file.base]]` (per [Bases docs](https://help.obsidian.md/Plugins/Bases)), and the query itself should live in **note frontmatter** (canonical, queryable by Bases itself, regenerable, plugin-uninstall-safe) rather than in an opaque inline codeblock. Phase 4.5 ships the corrected architecture. Phase 4's codeblock-only flow stays in git history; codeblocks already in user vaults keep working (Bases supports both syntaxes — no migration command).

**The corrected design** (3 artifacts make up a query):

1. **`crosswalker_query:` frontmatter on the user's note** — canonical query definition (recipe ID + shape + user-edited params). AJV-validated. Indexable by Bases itself. Survives plugin uninstall. Renamed from `crosswalker:` → `crosswalker_query:` on 2026-05-16 to distinguish from the existing `_crosswalker:` provenance block on imported concept/junction notes and to make the block's purpose explicit (it's a QUERY definition, not generic plugin metadata).
2. **`.base` file at `_crosswalker/views/q-<YYYY-MM-DD>-<8-hex>.base`** — plugin-generated rendering artifact. Regenerable from frontmatter. Stable filename keyed by `query_id`.
3. **`![[<view_file>]]` embed in the user's note** — Obsidian-native Bases embed syntax. Renders inline when the note is viewed.

**Flow** (single `Crosswalker: Insert query into note` command):
- Picker opens. Auto-detects existing `crosswalker_query:` frontmatter → UPDATE mode (preserves `query_id` + `view_file`; updates params only) OR CREATE mode (fresh `query_id`).
- On confirm: write `.base` file → write/update frontmatter via `app.fileManager.processFrontMatter()` → insert `![[<view_file>]]` at cursor (skipped if embed already present — idempotent).

**New modules** (all under `src/views/`):
- `query-frontmatter-schema.ts` — JSON Schema (draft 2020-12) + AJV validator + `newQueryId()` + `viewFileFor()`. Validates the `crosswalker:` block at every read + write boundary. Schema is forward-compat (`schema_version: 1`).
- `query-frontmatter-io.ts` — `readQueryFrontmatter()` / `writeQueryFrontmatter()` / `hasQueryFrontmatter()` helpers + pure builders (`buildFrontmatter`, `updateFrontmatterParams`). Uses Obsidian's canonical `app.fileManager.processFrontMatter(file, cb)` API — safer than manual YAML manipulation.
- `apply-query-to-note.ts` — single orchestrator: `applyQueryToNote({app, file, editor, recipeId, shape, params})`. Decides CREATE vs UPDATE; writes `.base` file (with comment header); writes/updates frontmatter; inserts embed at cursor; returns structured `ApplyResult` for caller.
- `regenerate-query-views.ts` — vault scanner. `regenerateAll(app)` walks all markdown files; for each one with `crosswalker_query:` frontmatter, regenerates the `.base` file. Idempotent — skips when YAML body matches (compares stripped of header timestamp comments).

**`insert-base-block.ts` extended**:
- `buildBaseBlock()` deprecated (kept for backward compat with Phase 4 codeblocks)
- New `buildEmbed(vaultPath)` builds canonical `![[path.base]]` syntax
- New `insertEmbedAtCursor(editor, viewPath)` uses Phase 4 cursor-position policy (after-frontmatter / after-codeblock / after-line); idempotent — skips when embed already present (UPDATE flow safety)
- New `noteContainsEmbed(content, vaultPath)` detection helper

**Picker modal updated** (`recipe-picker-modal.ts`):
- Resolves with `{recipeId, shape, params}` instead of pre-built block text (orchestrator handles writes)
- Apply button (was "Insert") — semantically more accurate
- Raw-YAML escape removed (users hand-edit the `.base` file at `_crosswalker/views/` directly OR write a JSON recipe — both documented in `SKILL.md`)
- Picker UI surface unchanged; only the resolve contract changed

**Commands**:
- `Crosswalker: Insert query into note` — REPURPOSED to call `applyQueryToNote()` orchestrator (was: insert raw codeblock). Auto-detects UPDATE vs CREATE mode.
- `Crosswalker: Refresh query views` — NEW. Scans all notes with `crosswalker_query:` frontmatter; regenerates their `.base` files. Idempotent. Surfaces a Notice with `N refreshed, M up-to-date, K errors`. Also runs on `onLayoutReady` for stale-state recovery (same pattern as Phase 3 reference file write + Phase 1.5 fixture drift check).

**Obsidian mock extended** (`tests/__mocks__/obsidian.ts`):
- `Platform` (mobile/desktop detection — already added in Phase 4a)
- `ButtonComponent` (already added in Phase 4a)
- `FileManager` class with `processFrontMatter` that captures writes to an in-memory store (`__frontmatter`) keyed by file path — tests can assert on resulting frontmatter without parsing YAML

**SKILL.md rewritten**: now teaches the frontmatter + `.base` + embed pattern as the primary workflow. Explains the 3 artifacts, how to author / edit queries, why the design honors the v0.1 architectural commitments. Existing codeblock examples preserved as backward-compat reference for users still on Phase 4 syntax.

**Tests**: 359/359 pass (was 310 before Phase 4.5; +49 new):
- `tests/query-frontmatter-schema.test.ts` — 15 tests (validation accept/reject + ID generation + view file naming)
- `tests/query-frontmatter-io.test.ts` — 13 tests (read/write + has/build/update; mocked `processFrontMatter`)
- `tests/apply-query-to-note.test.ts` — 7 tests (CREATE + UPDATE flows + `buildBaseFileContent`)
- `tests/regenerate-query-views.test.ts` — 14 tests (idempotency, scan-all aggregation, malformed handling, missing template, `yamlBodyMatches` purity)

**Files changed**: ~15 new/modified (4 new modules + 4 new test files + updates to recipe-picker-modal / insert-base-block / main / reference-base-files / obsidian mock / briefing log / milestone hub / CHANGELOG).

**Effort**: ~5h. Build clean. Manual smoke pending.

See [briefing log Phase 4.5 section](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-15-context-briefing/#phase-45--frontmatter-driven-query-notes-the-architectural-pivot) for the architecture diagrams + decision-chain cross-links to the 2026-05-04 / 2026-05-07 / 2026-05-08 / 2026-05-11 prior synthesis logs.

### v0.1.6 Phase 4 — Recipe-picker UX + SKILL.md + framework fixture expansion (2026-05-15, ✅ Done)

User-facing query authoring surface. New command `Crosswalker: Insert query into note` opens a modal listing 6 shipped recipes + any user-authored recipes from `_crosswalker/recipes/`; user picks one, optionally edits exposed parameters inline, and a `` ```base `` codeblock lands at the editor cursor with cursor-position-aware insertion (after-frontmatter / after-code-block / after-line policies). Phase 3 first-run writer extended to also ship `_crosswalker/SKILL.md` — an LLM authoring guide modeled on Steph Ango's `kepano/obsidian-skills` pattern.

Shipped in 3 sub-phases (4a foundation, 4b UI, 4c wire-up).

**New code (Phase 4a):**
- `src/views/recipe-loader.ts` — Static imports of 6 shipped recipes + runtime scan of `_crosswalker/recipes/` for user-authored. AJV validation on both. Dispatches on `query.shape` STRING value (architectural commitment #5 — runtime-agnostic recipe schema). New shapes (e.g. v0.2's `cards`) don't need loader code changes.
- `src/views/insert-base-block.ts` — Cursor-aware codeblock insertion helper. Policy: cursor inside frontmatter → insert after closing `---`; cursor inside another code block → insert after closing ```; otherwise insert after current line. Pure (chooseInsertionPoint exported separately for direct testing).
- `src/views/mobile-detection.ts` — Single source of truth for `Platform.isMobile` gate (commitment #3 mobile parity). Used by the picker to hide raw-YAML editor with "Edit on desktop" hint.

**New code (Phase 4b):**
- `src/views/recipe-picker-modal.ts` — Modal subclass. Reuses Phase 3 modal CSS for visual consistency. Card layout per recipe; "Configure" expands inline parameter editor; "Insert" CTA. `hierarchy` shape shows "renderer coming soon" badge; can still insert YAML (Bases falls back to native table view). Raw-YAML escape button at footer (desktop-only).
- `src/views/recipe-parameter-editor.ts` — Pure helper. Type-dispatched widgets: string → text input, number → number input with step inferred from default's precision, boolean → toggle, unknown → string fallback. Returns a handle (getValues / hasAnyParams / reset) the picker uses at Insert time.
- `src/views/recipe-templates.ts` — Inline `` ```base `` templates for the 6 shipped recipes. Each maps recipe ID to a Bases YAML template with Mustache-style placeholders + section conditionals (`{{#name}}...{{/name}}` drops when param is falsy).

**New code (Phase 4c):**
- `src/main.ts` — New command `crosswalker:insert-query-into-note` with `editorCallback` for cursor access. Creates a fresh `trace_id` per invocation; downstream picker-open / block-inserted / block-insert-failed events correlate via the Phase 3.5c logger.
- `src/views/reference-base-files.ts` — Extended to also write `_crosswalker/SKILL.md` on first run (idempotent — never overwrites user edits). The SKILL.md content (LLM authoring guide for Crosswalker recipes + ```base codeblocks) is inlined as a TS constant; pattern modeled on Steph Ango's `kepano/obsidian-skills`.

**Reference recipe additions (Phase 4a):**
- `recipes/v0-1/mitre-coverage.json` — NEW 6th recipe. NIST CSF (defensive) → MITRE ATT&CK (offensive) pivot. The cross-domain showcase — Crosswalker's distinguishing capability beyond what compliance-only tools can do.

**Framework fixture expansion (Phase 4a, tools/fixtures/realistic/):**
- `cis-controls-v8-subset.csv` — ~12 rows, Basic safeguards, 2-level hierarchy
- `soc2-trust-services-subset.csv` — ~10 rows, Common + Availability criteria
- `nist-csf-to-mitre-attack.sssom.tsv` — ~12 mappings, cross-domain defensive→offensive
- `iso27001-to-soc2.sssom.tsv` — ~10 mappings, mixed match types
- `README.md` — Updated with lifecycle coverage matrix (which fixture exercises which pipeline stage)

**Testing infrastructure (Phase 4a):**
- `tests/__mocks__/editor.ts` — Reusable mocked Obsidian Editor with captured-call assertions. Outlasts Phase 4; Phase 5 + v0.1.7 will reuse.
- `tests/__mocks__/obsidian.ts` — Extended with `Platform` (mobile gate) + `ButtonComponent`.
- `tests/helpers/recipe-fixtures.ts` — Shared memoized loader for `recipes/v0-1/*.json`. Tests don't re-read disk.
- `tests/helpers/visual-spec-runner.ts` — Boilerplate-elimination wrapper for the wdio screenshot pattern. Future visual specs become 5 lines instead of 40.

**CSS additions to `styles.css`:**
- `.crosswalker-recipe-picker-modal`, `.crosswalker-recipe-card`, `.crosswalker-recipe-description`, `.crosswalker-renderer-coming-soon` (orange/italic badge for reserved shapes), `.crosswalker-card-details`, `.crosswalker-param-editor`, `.crosswalker-insert-row`, `.crosswalker-recipe-load-errors`.

**Tests:** 310/310 pass (was 241 before Phase 4; +69 new across 5 new test files):
- `tests/recipe-loader.test.ts` — 19 tests (load+validate, buildLoadedRecipe, getRecipeParams)
- `tests/insert-base-block.test.ts` — 18 tests (cursor policy + full integration)
- `tests/recipe-templates.test.ts` — 14 tests (shipped catalog coverage + interpolation)
- `tests/recipe-parameter-editor.test.ts` — 14 tests (handle contract + type widgets + defaults)
- `tests/reference-base-files.test.ts` — extended with 4 new SKILL.md tests

**New E2E:**
- `tests/e2e/recipe-picker-flow.spec.ts` — verifies SKILL.md first-run write + command registration
- `tests/e2e/visual-recipe-picker.spec.ts` — 3 screenshots (picker open / configuring / closed)

Build clean. Tests clean. Manual smoke (`Crosswalker: Insert query into note` → picker → insert) is pending.

### v0.1.6 Phase 3.5c — Call-site sweep + trace correlation (2026-05-15, ✅ Done)

Pure-refactor completion of the Phase 3.5 observability layer. The Phase 3.5a backward-compat shim is removed; all 30+ remaining `.log(msg, data)` and `.error(msg, err)` call sites across the import / generation / SSSOM / Tier 2 / view subsystems migrated to the categorized severity API (`info / warn / error / trace` with `category + op` fields). Top-level entry points now create fresh `trace_id`s and wrap their work in `withTrace()` — so every downstream event for one operation carries the same trace_id, correlatable via a single `jq` filter.

**API removal (breaking, internal-only)**:
- `DebugLog.log(msg, data?)` — removed. All callers now use `debug.info('<category>', '<op>', msg, data?)`.
- `DebugLog.error(msg, err)` (2-arg form) — removed. The canonical signature is now `debug.error('<category>', '<op>', msg, data?)`.

**Trace correlation entry points** (the 4 places where a fresh trace_id is created):
- `wizard.parseSourceFile()` — wraps the CSV parse flow
- `wizard.generate()` — wraps the entire generation flow
- `importSssom()` — wraps the SSSOM TSV → junction-note pipeline (re-uses an active caller trace if present)
- `plugin.autoProjectOnLayoutReady()` — wraps the Tier 2 projection on vault load

**Categories now used** (all 9, after `legacy` removal):
- `wizard` — wizard state transitions, applied-config, generate-start/complete
- `csv-parser` — file parse config / progress / complete / error
- `generation` — per-row events (file-created / file-replaced / skipped / merge-failed / row-error), generation start/complete
- `sssom-import` — parse-aborted / pair-detected / projection-start / closure-precomputed / etc.
- `tier2` — projection-start / projection-row-error / projection-complete / closure-cache-invalidate-failed / clear-failed
- `config` — saved-config deleted / duplicated / exported / imported / import-failed
- `view` — Bases view register failures / reference .base file written
- `drafts` — wizard draft sessions (Phase 3.6: saved / deleted / cleared-all / purged-expired / cap-enforced / resumed)
- `lifecycle` — plugin loaded / unloaded

**Diagnostic payoff** (the real reason for 3.5c):
- Before: bug → read source → guess at code paths → grep log for fragments → reconstruct timeline → identify root cause (~20-30 min)
- After: bug → identify operation → `cat crosswalker-debug.log | jq 'select(.trace_id == "<id>")'` → causal chain returned in order → root cause obvious (~3-8 min)

**Files changed** (12 files, ~30+ call sites + shim removal + 3 shim tests removed + 1 new test):
- `src/utils/debug.ts` — shim removed
- `src/main.ts`, `src/import/import-wizard.ts`, `src/import/sssom-importer.ts`, `src/import/sssom-import-modal.ts`, `src/generation/generation-engine.ts`, `src/tier2/projector.ts`, `src/config/config-browser-modal.ts`, `src/views/reference-base-files.ts` — call sites migrated
- `src/settings/settings-tab.ts` — `legacy` category dropped, `drafts` added
- `tests/debug-log.test.ts` — 3 shim tests removed, 1 canonical `error()` signature test added

**Test coverage**: 241/241 unit tests pass (was 243; net -2 after shim-test cleanup). Build clean.

See `docs/.../zz-log/2026-05-15-v0-1-6-phase-3-5c-shipped.mdx` for the full delivery log with system-design integration diagrams.

### v0.1.6 Phase 3.6 — Import wizard draft sessions (2026-05-15, ✅ Done)

User-feedback-driven addition: the import wizard now auto-saves in-progress state so users can close the modal mid-flow (to check another note, refer to another framework, get a phone call) and resume exactly where they left off. Originally captured in `.workspace/2026-05-11-ux-feature-requests.md` as a deferred feature request; the user reaffirmed it after a 5/11 manual test session ("If you're going through an import process and you're configuring a bunch of columns, there might be times where you have to X out and go look for something..."). Built in three sub-phases over 2026-05-15.

**New surfaces:**
- Wizard Step 1 always shows a "Drafts from previous sessions" section (revised UX after initial stacked-modal approach proved undiscoverable for first-time users — see commit `1cbc4f6`). Empty state explains the feature: *"No drafts yet. As you configure your import, the wizard will auto-save your progress — close the modal anytime and your work will appear here so you can resume."*
- Per-draft card shows: name (auto-generated, e.g. "sample-nist-controls (Step 2)"), source file, step indicator (Step N/4), relative time ("just now" / "5 minutes ago" / "yesterday"), applied config name (looked up from settings)
- Per-card actions: Resume (CTA) + Delete (warning style)
- 3 new commands: `Crosswalker: Resume draft import`, `Crosswalker: Clear all import drafts`, `Crosswalker: Purge expired import drafts`
- 3 new settings (Wizard Behavior section): Auto-save toggle, Draft expiry slider (0-90 days, default 30; 0 = never), Max drafts slider (0-50, default 20; 0 = no cap)

**New code:**
- `src/import/draft-store.ts` — DraftStore class + serializer helpers (~250 lines + 17 unit tests). API: `list()` / `load(id)` / `save(draft)` / `delete(id)` / `clearAll()` / `purgeExpired()`. Auto-creates `_crosswalker/drafts/` folder (already gitignored). Schema-versioned WizardDraft type with first-class Map ↔ Record conversion helpers (JSON.stringify silently drops Map entries — tested + asserted).
- `src/import/import-wizard.ts` integration:
  - `loadAvailableDrafts()` on onOpen() — single fetch per wizard session
  - `renderDraftsSection(container)` + `renderDraftRow(list, draft)` — always-visible UI in Step 1
  - `scheduleDraftSave()` (500ms debounce) + `saveDraftNow()` (immediate, used on step advance + onClose flush)
  - `shouldPersistDraft()` gate — skip empty drafts (Step 1 with no file selected)
  - `snapshotDraft()` — pure serializer producing a WizardDraft from current wizard state
  - `hydrateFromDraft(draft)` — restores state on Resume; re-attaches applied config from settings; gracefully handles deleted applied config (Notice) + missing source file (forces Step 1 re-pick, preserves column configs)
  - Auto-delete on successful generation (`skipDraftDeleteOnClose` flag avoids the onClose-saves-deleted-file race)
- `styles.css` — `.crosswalker-drafts-section` + `-list` + `-row` + `-info` + `-name` + `-meta` + `-actions` classes. Theme-aware via Obsidian CSS variables. Responsive `flex-wrap: wrap` for narrow modals.

**Auto-save triggers:**
- 500ms debounce after column 'Use as' dropdown change in Step 2
- 500ms debounce after output-key text input in Step 2
- 500ms debounce after Output path / Framework ID / Overwrite mode edits in Step 4
- Immediate save on Next button click (before re-render)
- Final flush on modal onClose (X out, Escape key, click outside)
- Skipped when isParsing or isGenerating is true (no mid-operation writes)
- Skipped when feature disabled in settings

**Observability**: all DraftStore mutations emit wide events via DebugLog (`drafts` category — already in the Phase 3.5b filterable list). Visible operations: `drafts/saved`, `drafts/deleted`, `drafts/cleared-all`, `drafts/purged-expired`, `drafts/cap-enforced`, `drafts/resumed`, `drafts/schema-version-mismatch`, `drafts/parse-failed`.

**Test coverage**: 17 new unit tests in `tests/draft-store.test.ts` (round-trip, idempotent overwrite, sort order, expiry filter, purge count, max-drafts cap, schema version skip, corrupt JSON skip, Map↔Record helpers, ID format). 1 visual E2E test in `tests/e2e/visual-wizard-step1-drafts.spec.ts` (screenshots both empty + populated states). **243/243 unit tests pass.**

**Manual verification 2026-05-15**: full end-to-end flow walked — save state in Step 2, X out, reopen wizard (drafts section shows the saved draft), Resume → wizard hydrates with column configs preserved → re-pick file → continue through Steps 3+4 → Generate → draft auto-deleted on success → reopen wizard shows empty state again.

See `docs/.../zz-log/2026-05-15-v0-1-6-test-status-update.mdx` for the broader v0.1.6 test-status accounting.

### v0.1.6 Phase 3.5b — Debug log settings UI + 3 commands (2026-05-11, ✅ Done)

Wires the Phase 3.5a wide-event logger into the settings tab + command palette. Pure additions — no behavioral change to imports, generation, or query layer.

**New surfaces:**
- Settings → Debug → Category filters section with 9 known categories (wizard, csv-parser, generation, sssom-import, tier2, config, view, lifecycle, legacy). Each toggle opts that category OUT (default all on, sparse storage)
- Settings → Debug → Log file actions row: Open / Export to clipboard / Clear (warning) buttons
- 3 new commands: `Crosswalker: Open debug log` (opens in new pane), `Crosswalker: Export debug log to clipboard (last 1 MB, secrets redacted)`, `Crosswalker: Clear debug log`
- `verboseLogging` toggle now actually does something (was previously orphaned — defined in settings, surfaced in UI, but never read by DebugLog)

**New settings field**: `debugLogCategoryFilters: Record<string, boolean>` (default `{}`; sparse — only suppressed categories persist).

### v0.1.6 Phase 3.5a — Wide-event NDJSON logger + trace correlation (2026-05-11, ✅ Done)

User-feedback-driven observability upgrade. The 2026-05-11 wizard "0 pages generated" bug took 5 minutes to diagnose *because* there was a debug log; without it, ~30+ minutes of code reading. User invoked the loggingsucks.com framing (Charity Majors-style wide structured events with trace correlation) for the next-level upgrade. Slots in before Phase 4 so all subsequent UX phases ship against a debuggable substrate.

**Design lock**: pure NDJSON storage (one event per line); primary consumer is **agents** (Claude Code sessions reading the log via `cat | jq` to diagnose user-reported bugs), not humans squinting at Obsidian text-mode files. No in-app log viewer — agents read structured JSON natively; humans use shell or any editor.

**New API surface** (`src/utils/debug.ts` — 80% rewritten):
- Severity methods: `info(category, op, msg, data?)` / `warn(...)` / `error(...)` / `trace(...)`
- Span helper: `span(category, op, fn, data?)` auto-emits start + end events with `duration_ms`; nested spans propagate `parent_span_id`; thrown errors auto-recorded at error level
- Trace context: `newTraceId()` + `withTrace(id, fn)` for explicit propagation through async chains (no AsyncLocalStorage magic — Crosswalker has no concurrent imports)
- Category filters: per-subsystem opt-out via settings
- Verbose gate: `trace()` events only written when `setVerbose(true)`
- `readForExport(maxBytes)` — tail with secret redaction (regex sweep for `sk-` / `ghp_` / `AIza` / `AKIA` prefixes + long opaque tokens)
- Backward-compat shim: existing `.log()` and `.error()` 2-arg calls keep working (emit with `category: 'legacy'`) until Phase 3.5c sweeps the call sites

**Event schema** (every NDJSON line):
```ts
{ ts, level, category, op, msg, trace_id?, span_id?, parent_span_id?, duration_ms?, ...freeform context }
```

**Storage**: pure NDJSON at `crosswalker-debug.log` (vault root). Rotation at 5 MB cap with 3 keep-archives (`.1`, `.2`, `.3` = 20 MB max disk). Append via `vault.adapter.append()` for O(1) writes (previous read-modify pattern was O(n) per write — would have made the log unusable past ~100 KB).

**Test coverage**: 18 new tests in `tests/debug-log.test.ts`. **243/243 total pass.**

### v0.1.6 wizard fixes (2026-05-11, ✅ Done)

Three wizard UX/correctness fixes shipped 2026-05-11 alongside Phase 3.5a/3.5b:

- **`build: fix tsconfig.json TS 6+ deprecation errors`** (commit `5d458d7`) — removed unused `baseUrl` + `paths` (no `@/*` aliases imported anywhere); changed `moduleResolution: "node"` → `"bundler"` (semantically correct for esbuild). Unblocked `bun run build` under TypeScript 6+.
- **`fix(ui): config browser modal width and vertical space`** (commit `383d94f`) — applied width class to `modalEl` (not `contentEl` — the source of the bug); flex-wrap on toolbar + card-actions + footer; flex-column layout in `modal-content` so the list area grows. Visual test added at `tests/e2e/visual-config-browser.spec.ts`.
- **`fix(ui): wider import wizard modal + stat-card column statistics grid`** (commit `7dda997`) — same `modalEl` vs `contentEl` fix; column statistics rewritten as a responsive stat-card grid (label + numeric value + '% of rows' meta + 'has blanks' warning) instead of a flat grey paragraph box.
- **`fix(generation): wizard fallback no longer breaks every row with '{{row}}' template`** (commit `ceffb6a`) — the "0 notes generated" bug. Stale Mustache-syntax fallback in `buildConfigFromWizardState` (`template: '{{row}}'`) referenced a non-existent template variable. Render engine threw on every row. Fix: omit `filename` when no title column is picked → legacy-shim falls back to first frontmatter column. Made `MappingConfig.filename` optional (matches actual contract — all existing callers used `mapping.filename?.template`). 3 regression tests added.
- **`fix(wizard): 3-notes import bug + Phase 1 polish`** (commit `5dbdaf1`, 2026-05-11) — second-order wizard bug surfaced during Phase 1 manual testing. `buildColumnMappingLookup` unconditionally overrode hierarchy with frontmatter when a column appeared in both (common in seeded NIST 800-53 saved config). Fix: reordered loops by structural primacy (hierarchy first, then title-from-template, then links/body, then frontmatter LAST) with "first-write wins" `.has()` check. Plus: `buildConfigFromWizardState` now accepts the applied config's filename template + translates legacy Mustache `{{X}}` → single-brace `{X}` at the boundary. 4 new edge-case tests added. Settings copy de-jargoned (removed "per Ch 31"). TEST_PHASE1_QUERY_SCHEMA.md Scenario 3 corrected (recipes/v0-1/ is at REPO root, not vault root — ENOENT confusion explained).

Also 2026-05-11: **`dev: install Hot Reload in test-vault`** (commit `3133060`) — installed pjeby/hot-reload v0.3.0 into test-vault so future `bun run build` rebuilds auto-reload Crosswalker in Obsidian without manual toggle-off/on. Added a `Pre-flight — reload after every rebuild` section to all 3 TEST_PHASE*.md guides. Re-synced guides to `test-vault/_test-guides/`.

### v0.1.6 Phase 3 — `crosswalkerPivot` registered Bases view (2026-05-10, ✅ Done)

Per Settled #2 + Ch 30. The single `registerBasesView` registration v0.1.6 ships. Custom Bases view that renders pivot grids (rows × cols × cells) from Bases-filtered entries; pairs with the launch-market Coverage Matrix recipe. Reads filtered `controller.entries` directly; calls Phase 2's plugin handles for Tier 2 enrichment when needed.

**New surfaces:**
- Custom Bases view: `crosswalker-pivot` (registered via Obsidian 1.10.0+ public `registerBasesView` API)
- Reference `.base` file: `_crosswalker/views/coverage-matrix.base` (shipped on first plugin run; idempotent — never overwrites user edits per Settled #3)
- Bases-disabled fallback Notice with helpful text

**New code:**
- `src/views/bases-api.ts` — `registerCrosswalkerBasesView(plugin, viewId, registration)` wrapper. Gates on `requireApiVersion('1.10.0')`. Handles "already exists" errors as success (idempotent re-register). Returns structured `RegistrationResult` with `reason: 'no-public-api' | 'bases-disabled' | 'already-registered' | 'error'` so call sites can surface meaningful Notices. Adapted from the [TaskNotes v4 Bases pattern](https://github.com/callumalpass/tasknotes/tree/main/src/bases) (Settled #11 precedent).
- `src/views/pivot-grid.ts` — pure data-shaping helper. `computePivotGrid(entries, config)` consumes flat `PivotEntry[]` + axes/op/empty config; produces `{ rowKeys, colKeys, cells, totalEntries, sparsePivotWarning, range }`. Supports all 8 v0.1 aggregation ops (per Ch 29 vocabulary), 3 empty-cell modes (`gap`/`blank`/`zero`), sort directions, sparse-pivot threshold detection. Heatmap intensity normalization helper. **31 unit tests.**
- `src/views/crosswalker-pivot-view.ts` — `Component` subclass with `onDataUpdated` lifecycle. Reads `controller.entries`, calls `computePivotGrid`, renders DOM table. 100ms debounce on Bases data updates. Empty-state + error-state + sparse-warning rendering. `buildCrosswalkerPivotViewFactory` closure captures plugin handle for Tier 2 access.
- `src/views/reference-base-files.ts` — `writeReferenceBaseFiles(app, debug)` idempotent first-run writer. Skips files that already exist (preserves user edits per Settled #3). Reference content inlined as TS string (esbuild bundles cleanly). **6 unit tests.**
- `templates/coverage-matrix.base` — source-of-truth reference template (mirrored in `REFERENCE_COVERAGE_MATRIX_BASE` constant). Filters by `_crosswalker/mappings/`; declares 2 views (`crosswalker-pivot` custom + Bases-native `table` fallback).

**View options panel** (8 controls, per `CrosswalkerBasesViewOption[]`):

| Key | Type | Purpose |
|---|---|---|
| `rowsBy` | property | Row-axis property name |
| `colsBy` | property | Col-axis property name |
| `cellOp` | dropdown | Aggregation op (count/count_distinct/sum/avg/min/max/first/last) |
| `cellOf` | property | Cell-value source for non-count ops |
| `empty` | dropdown | Empty-cell mode (gap/blank/zero) |
| `heatmap` | toggle | Color shading proportional to value |
| `rowSort` | dropdown | asc/desc/none |
| `colSort` | dropdown | asc/desc/none |

**CSS** (`styles.css`): `.crosswalker-pivot-grid` + `-table` + `-cell` + `-empty` + `-error` + `-warning` + `-footer` classes. Heatmap variant uses `--crosswalker-pivot-cell-intensity` CSS custom property (0.0 → 1.0). Theme-aware via Obsidian CSS variables.

**Test coverage**: 37 new tests (31 pivot-grid + 6 reference-base-files). **201/201 tests pass.** Build clean. E2E suite at `tests/e2e/crosswalker-pivot-view.spec.ts` is a documentation scaffold — view DOM rendering covered manually via `TEST_PHASE3_PIVOT_VIEW.md` 7 scenarios.

**Phase 3 deferrals** (Phases 4-5 of v0.1.6 — pending):
- Phase 4: recipe-picker UX + embedded `\`\`\`base` block insertion + `crosswalker-bases` SKILL.md (per Ch 32)
- Phase 5: opt-in materialization command + sparse-pivot HARD guard with `COUNT(*)` pre-estimate + first-run `_crosswalker/views/` Excluded Files prompt

See `TEST_PHASE3_PIVOT_VIEW.md` for manual test scenarios.

### Phase 2 + 3 E2E backfill (2026-05-10, post-Phase 3, ✅ Done)

After shipping Phases 2 + 3, backfilled real WebdriverIO + wdio-obsidian-service E2E coverage that exercises the full path through the plugin runtime (not just unit-test mock-vault round-trips). Closes the "E2E pending — env-fragile" caveat from both phase logs:

- `tests/e2e/sssom-import.spec.ts` — 7 tests verifying SSSOM import end-to-end against real Obsidian + real SQLite + real metadataCache (command registration, plugin.precomputeClosure handle, TSV → 5 junction notes round-trip, STRM normalization in frontmatter, Tier 2 mappings table population, closure_cache eager-precompute).
- `tests/e2e/crosswalker-pivot-view.spec.ts` — 6 tests verifying `plugin.registerBasesView` API exposure, `crosswalker-pivot` view-type registration in Bases registrations map, reference `.base` file auto-creation on first run, content shape, and **idempotent first-run write preserves user edits across plugin disable/re-enable cycle** (the test that actually exercises Settled #3's user-edit-safety property).

`bun run e2e` confirms **17/17 spec files pass** in 18:04 (full sequential run; `maxInstances: 1`).



### v0.1.6 Phase 2 — SSSOM TSV import + materialized closure (2026-05-10, ✅ Done)

Per [Ch 35 (graph→tabular bridging)](https://cybersader.github.io/crosswalker/agent-context/zz-research/2026-05-09-challenge-35-graph-to-tabular-bridging-rerun/) + the locked D1 "Ch 35 nuance" scope expansion. SSSOM (Simple Standard for Sharing Ontological Mappings) is the canonical TSV interchange format used by BioPortal, OxO, OBO Foundry, and Biomappings. Phase 2 gives Crosswalker first-class on-ramp to that ecosystem.

**New surfaces:**
- Command: `Crosswalker: Import SSSOM mapping file`
- Modal flow: file picker (vault `.tsv` / `.sssom.tsv` files OR paste TSV content) → parse + preview (row count, detected ontology pair, warnings) → confirm → execute
- Output folder convention: `_crosswalker/mappings/<source>-to-<target>/` (one junction-edge `.md` per mapping)

**New code:**
- `src/import/sssom-parser.ts` — TSV parser per SSSOM 0.15+ spec. Handles `# `-prefixed YAML-shaped headers (curie_map, mapping_set_id, license, etc.), required columns (subject_id, predicate_id, object_id), optional columns (subject_label, object_label, mapping_justification, confidence, mapping_provider, mapping_set_id), CURIE-prefix-based ontology-pair detection.
- `src/import/sssom-importer.ts` — orchestrator: parse → SKOS→STRM predicate normalization → synthetic crosswalk-edge recipe → `generateFromRecipe` → Tier 2 projection → eager closure precompute. Idempotent re-imports.
- `src/import/sssom-import-modal.ts` — modal UX (file picker, paste editor, preview, progress notice).
- `src/tier2/queries.ts`: new `precomputeClosureForOntologyPair(db, source, target, predicate?)` — eagerly populates `closure_cache` for the imported pair (per Ch 35: "every production ontology-web system materializes precomputed pairwise crosswalks").
- `plugin.precomputeClosure(source, target, predicate?)` — exposed plugin handle for the eager precompute.

**SKOS → STRM predicate normalization** (preserves SSSOM original as `sssom_predicate` frontmatter):
| SSSOM/SKOS predicate | STRM `predicate_id` |
|---|---|
| `skos:exactMatch` | `is_equivalent_to` |
| `skos:closeMatch` | `is_approximate_to` |
| `skos:broadMatch` | `is_broader_than` |
| `skos:narrowMatch` | `is_narrower_than` |
| `skos:relatedMatch` | `intersects_with` |
| (unknown) | `intersects_with` (with warning) |

**Test fixture**: `tools/fixtures/synthetic/nist-csf-to-iso27001.sssom.tsv` (11 mappings; covers all 5 SKOS predicates + curie_map header + mapping_set_id).

**Test coverage**: 25 new tests (19 parser unit + 6 importer integration). **164/164 tests pass.**

**Phase 2 deferrals** (Phases 3-5 of v0.1.6 — pending):
- Phase 3: `crosswalkerPivot` registered Bases view (per Settled #2 + Ch 30)
- Phase 4: Recipe-picker UX + embedded `\`\`\`base` block insertion + `crosswalker-bases` SKILL.md (per Ch 32)
- Phase 5: Opt-in materialization command + `_crosswalker/` folder convention finalization

**Phase 2 known limitations** (tracked for follow-up):
- `match_confidence` (numeric per Tier 1 schema) is preserved as the SSSOM `sssom_confidence` frontmatter field (string) instead of `match_confidence` (number). Cause: render() template engine emits all values as strings; numeric coercion in templates is a v0.1.7+ concern.
- E2E suite for SSSOM import is scaffolded (`tests/e2e/sssom-import.spec.ts`) but pending — WebdriverIO env unavailable in current dev env.

See `TEST_PHASE2_SSSOM_IMPORT.md` for manual test scenarios.

### v0.1.6 Phase 1.5 — Test infrastructure (2026-05-09, ✅ Done)

Foundation pass before Phase 2. Three changes:
- **Deterministic fixtures**: `tools/generate-fixtures.ts` gains `--deterministic` flag (also `CROSSWALKER_FIXTURES_DETERMINISTIC=1` env var). When set, `produced_at` uses the stable `2026-05-04T00:00:00.000Z` timestamp instead of `Date.now()`. `bun run fixtures` now passes `--deterministic` so committed fixtures are byte-identical across regenerations.
- **Fixture-drift CI gate**: new `bun run check:fixtures-drift` script. Stashes existing fixtures, regenerates from canonical source, diffs against committed HEAD, fails if drift detected. Catches schema/recipe/source-CSV changes that silently invalidate test data.
- **Phase 2-5 E2E test scaffolds**: `tests/e2e/{sssom-import,crosswalker-pivot-view,recipe-picker-flow,materialize-command}.spec.ts` with Mocha pending-test patterns. Makes test-infra expectations visible to the implementation phases.



### v0.1.6 Phase 1 — recipe `query:` block schema (2026-05-09, ✅ Done)

Foundation phase of the v0.1.6 milestone: adds an optional `query:` block to `spec/recipe.schema.json` so recipes can declare what to query (axes, edges, aggregation) using the 8-verb Layer A vocabulary. Per [Ch 29 (8-primitive validation)](https://cybersader.github.io/crosswalker/agent-context/zz-research/2026-05-09-challenge-29-ontology-web-query-verbs-validation/) + [Ch 30 (5 v0.1 view shapes)](https://cybersader.github.io/crosswalker/agent-context/zz-research/2026-05-09-challenge-30-view-shape-taxonomy/) + [Ch 31 (schema design)](https://cybersader.github.io/crosswalker/agent-context/zz-research/2026-05-08-challenge-31-deliverable-a-shape-dispatched-data-only/) + [Ch 36 (compositional language stack)](https://cybersader.github.io/crosswalker/agent-context/zz-research/2026-05-09-challenge-36-query-language-rerun/).

**Schema bump (additive; SchemaVer 1.1.0)** — `spec/recipe.schema.json`:
- New top-level `query:` property; optional. Recipes WITHOUT `query:` continue to validate (additive, backward-compatible).
- 31 new `$defs`: `query_block`, `ShapeDispatchA`, `ShapeDispatchB`, six `*Primitives` (Table/List/Pivot/Graph/Hierarchy/Timeline), helper types (OntologyRef, ConceptRef, EdgePredicate, FieldSelector, AggregationOp, QueryFilter, QuerySort, Projection, Traversal, Aggregate, Join, GroupBy, QueryParam, QueryProvenance, QueryOutput, QueryViewOptions).
- `$schema` and `$comment` allowed at recipe top-level (editor autocomplete hint + free-text comment).
- 8 query verbs locked per Ch 29: `filter / traverse / bind / project / aggregate / anti-join / set-op / diff`. Closure folded into parameterized `traverse(depth=*, transitive=true)`; pivot demoted from Layer A to Layer B (presentation, not value-producing).

**Both schema discriminator styles ship** (per Ch 31a + Ch 31b). Settings `recipeSchemaStyle: 'A' | 'B'` selects which:
- Style A (default): `oneOf`+`const` discriminator. "Must match exactly one schema" errors.
- Style B (advanced): `if`/`then`/`else` cascading. Focused per-shape errors. Better IDE autocomplete.
- Both produce identical validity verdicts; differ in error-message UX. Settings toggle under "Recipe schema" section.

**Validator changes** (`src/validation/validator.ts`):
- New `RecipeSchemaStyle = 'A' | 'B'` type export.
- `validateRecipe(recipe, style?)` accepts optional style param; default `'A'`.
- Both validators compiled at init via `buildStyleBSchema()` which deep-clones the schema and patches `query_block.allOf[0]` to reference `ShapeDispatchB` (strips `$id` so AJV compiles as anonymous variant).
- `main.ts` wraps `validateRecipe` to inject the active style from settings — callers stay style-agnostic.

**5 reference recipes shipped** to `recipes/v0-1/`:
- `coverage-matrix.json` (pivot shape — launch-market Coverage Matrix; NIST CSF × ISO 27001)
- `crosswalk-density.json` (table shape — aggregates per framework pair)
- `orphan-controls.json` (list shape — demonstrates anti-join verb; controls without evidence)
- `hierarchy-view.json` (hierarchy shape — schema-declared; `crosswalkerHierarchy` renderer ships v0.1.7-v0.1.8 per Ch 30)
- `list-view.json` (list shape — minimal; Bases-native rendering)

**Test coverage**: 23 new unit tests in `tests/recipe-query-block.test.ts` cover backward-compat, all 5 reference recipes in both styles, schema enforcement (missing required fields, unknown shapes, additionalProperties:false, aggregate op validation), and A/B verdict equivalence. **139/139 tests pass.**

**Phase 1 deferrals** (Phases 2-5 of v0.1.6 — pending):
- Phase 1.5: deterministic fixtures + fixture-drift CI gate + property-based schema tests + E2E env diagnosis + Phase 2-5 test scaffolds (test infrastructure pass before Phase 2)
- Phase 2: SSSOM TSV import + materialized closure-table + sparse-pivot guard (per Ch 35)
- Phase 3: `crosswalkerPivot` registered Bases view (per Settled #2 + Ch 30)
- Phase 4: Recipe-picker UX + embedded `\`\`\`base` block insertion + `crosswalker-bases` SKILL.md (per Ch 32)
- Phase 5: Opt-in materialization command + `_crosswalker/` folder convention finalization

See `TEST_PHASE1_QUERY_SCHEMA.md` for manual test scenarios. See [v0.1.6 milestone](https://cybersader.github.io/crosswalker/reference/roadmap/milestones/v0-1-6-bases-query-layer/) for the full milestone scope and Phases 2-5 plan.


### v0.1.5 — Tier 2 sqlite-wasm sidecar projector (2026-05-06, ✅ Done — all 6 phases)

SQL projection layer of the Crosswalker pipeline now live: deletable-recoverable `.crosswalker.sqlite` sidecar, projector populates `concepts`/`mappings`/`junction_notes`/`ontologies` tables from canonical Tier 1, three typed query helpers + lazy closure cache via recursive CTE per Ch 18 §2, settings-toggleable auto-projection on vault load. WASM-A path (plain `@sqlite.org/sqlite-wasm`); sqlite-vec deferred with calendar-anchored 2026-11-06 revisit. Realistic-framework integration tests (NIST 800-53 / NIST CSF / ISO 27001 / MITRE ATT&CK) pass. See [delivery log](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-06-v0-1-5-tier-2-sidecar-shipped/).

**Phase 1 — substrate scaffolding** (`src/tier2/sidecar.ts` + `migrations.ts` + `schema.sql`)

- sqlite-wasm via Blob URL load (Obsidian app:// URL workaround)
- OPFS sahpool VFS (mobile-portable; no COOP/COEP)
- `tier2-sqlite-v1` schema; drop-and-recreate migration on version mismatch
- DDL per [v0.1 schema spec §7](https://cybersader.github.io/crosswalker/agent-context/v0-1-schema-spec/#7-tier-2-sidecar-sql-schema-sqlite-wasm-projection)
- `plugin.openTier2()` instance handle exposed
- esbuild target ES2018 → ES2020 (sqlite-wasm uses BigInt literals)
- wdio.conf.mts `before` hook copies tier-2 artifacts into temp test vault (obsidian-launcher only copies main.js + manifest.json + styles.css)

**Phase 2 — projector** (`src/tier2/projector.ts`)

- Walks `app.vault.getMarkdownFiles()` lazily via [streaming foundation](https://cybersader.github.io/crosswalker/reference/roadmap/milestones/v0-1-4-5-streaming-refactor/)
- Kind-aware dispatch: concept → concepts; junction-note → junction_notes; crosswalk-edge → mappings
- Idempotent INSERT OR REPLACE keyed on `vault_path` / `source_path UNIQUE`
- Cooperative yielding every 50 files
- Closure cache invalidation after any mappings change (`DELETE FROM closure_cache`)
- FNV-1a content hashing for change detection
- `plugin.runProjection()` exposed as instance handle

**Phase 3 — query API + closure cache** (`src/tier2/queries.ts`)

- `getConceptsByOntology(db, ontologyId)` — flat list ordered by curie
- `crosswalkBetween(db, subjOnt, objOnt, predicateId?)` — direct edges (CURIE-prefix LIKE on subject/object)
- `closureFromConcept(db, startCurie, predicateId?, maxDepth=10)` — transitive closure via recursive CTE per [Ch 18 §2 R2a](https://cybersader.github.io/crosswalker/agent-context/zz-research/2026-05-02-challenge-18-tier-2-lite-rule-subset/) patterns: path-string anti-join cycle detection (`instr(path, '|' || target || '|') = 0`); `MIN(depth)` aggregation; predicate filter in BOTH base + recursive arms
- Lazy closure-cache materialization: cache keyed on `(start_curie, predicate_filter, target_curie, shortest_depth)`; first call computes + populates; subsequent calls hit cache
- `plugin.queryConcepts/Crosswalk/Closure()` exposed
- Closure-cache row-shape bug caught on self-review (initial design had per-edge rows requiring recursive cache walks; fixed before shipping by reinterpreting cache columns as start/predicate-filter/target/shortest-depth)

**Phase 4 — plugin integration**

- `app.workspace.onLayoutReady()` triggers `autoProjectOnLayoutReady()` per Ch 24 §2 recovery property
- Settings: `enableTier2Projection` toggle (default true) + `tier2SidecarPath` text input (default `.crosswalker.sqlite`)
- Settings UI: new "Tier 2 sidecar" section in settings tab
- Palette command `crosswalker:clear-tier-2-sidecar` — closes handle, deletes file, next access reprojects
- `openSidecar` + `clearSidecar` respect `settings.tier2SidecarPath`

**WASM-A pivot (2026-05-05 → 2026-05-06)**

Originally chose WASM-B (vendor `sqlite-vec-wasm-demo` to ship vec from day 1). Integration hit a 5-issue emscripten env-detection chain in Obsidian's Electron renderer — the demo artifact is for plain web browsers, not Electron's hybrid `window`+`process` environment. Reverted to WASM-A (plain sqlite-wasm) with sqlite-vec deferred. Calendar-anchored revisit: **2026-11-06**. See [WASM-A pivot synthesis](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-06-wasm-a-pivot-synthesis/) + [Ch 24 §5 Q4](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-04-tier-2-substrate-synthesis/#5-migration-triggers--when-to-revisit).

**Realistic-framework integration tests** (`tests/e2e/realistic-frameworks.spec.ts` — 9 tests)

5 synthetic-but-structurally-correct fixtures modeled on real frameworks: NIST 800-53 r5 AC family (22 controls; parens in CURIEs); NIST CSF 2.0 GOVERN+IDENTIFY (25 entries; dotted IDs); ISO 27001:2022 subset (15 clauses; em-dashes; UTF-8); MITRE ATT&CK Persistence subset (19 techniques; dotted sub-technique IDs); CSF→800-53+ISO OLIR-shaped crosswalk (30 edges). Verifies multi-framework vault state + cross-ontology projection + cross-framework crosswalk queries + closure across the graph. See `tools/fixtures/realistic/README.md`.

**Workflow ecosystem** (built during this milestone)

- 3 new skills: `synthesis-log`, `delivery-log`, `wikilink-crawl`
- 2 new agents: `pre-commit-reviewer`, `milestone-starter`
- 4 CI gates ⏸ Calendar revisit 2026-08-06
- 5-agent + 3-skill + 4-CI-gate ecosystem designed in [workflow audit log](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-06-workflow-audit-and-agent-design/)

**Test counts**: 116 unit + ~64 E2E across 13 spec files = ~180 tests total, all green.

**v0.1-RC blockers carried forward** (per delivery log §"Realistic-fixture testing — gap audit"): full-catalog scale tests; real-source CSV stress; mobile sanity; OLIR-scale crosswalk; closure scale verification; `fs-safe` filter investigation; bundle size verification.

### v0.1.4.5 — Streaming refactor (2026-05-05, ✅ Done)

Bundled engine is now streaming-by-design. `ParsedData.rows` accepts either an eager array OR `AsyncIterable<Row>`. End-to-end streaming pipeline so multi-GB inputs work without OOM.

- `src/types/config.ts` — `ParsedData.rows: Row[] | AsyncIterable<Row>` union; `isEagerRows()` type guard; `rowCount: -1` signals streaming/unknown
- `src/import/parsers/csv-parser.ts` — new `parseCSVFileStream()` returns AsyncIterable rows directly via PapaParse step callback with backpressure (HIGH_WATER=100, LOW_WATER=10)
- `src/generation/generation-engine.ts` — `generateNotes` + `generateFromRecipe` per-row loops refactored to `for await ... of`; type-guarded callsites in `analyzeColumns`, `estimateOutput`, wizard preview
- E2E: `tests/e2e/streaming.spec.ts` (4/4 pass — AsyncIterable consumption + eager-array backwards-compat)

### v0.1.4 — Junction notes + crosswalk edges (2026-05-05, ✅ Done)

All 3 Tier 1 frontmatter shapes (concept-note / junction-note / crosswalk-edge) producible via the bundled engine. STRM predicate vocabulary enforced at pre-write validation.

- `spec/recipe.schema.json` — `layout_entry.kind: concept | junction-note | crosswalk-edge` discriminator, default `concept` (backwards-compat)
- `src/render/index.ts` — kind dispatch in render(); `Tier1Kind` type
- `src/generation/generation-engine.ts` — new `generateFromRecipe()` native Ch 22 entry point; bypasses v0.1.0 column-role legacy logic
- `plugin.runImportFromRecipe()` exposed for native-recipe imports
- Pre-write Tier 1 validation (`validateTier1Frontmatter`) wired with strictValidation default true
- 3 starter recipes shipped in `recipes/starter/`: `nist-csf-to-800-53-crosswalk.json`, `iso27001-to-800-53-crosswalk.json`, `evidence-junction-notes.json` — generic over framework pairs (CIS↔800-53, MITRE↔800-53, etc., all use the same template)
- E2E: `tests/e2e/crosswalks.spec.ts` (5/5 pass — milestone gate)

### v0.1.3 — Generation engine integration (2026-05-05, ✅ Done)

Generation engine refactored to call `render()` per row via Phase-0 legacy-recipe-shim. managed/user_preserve frontmatter merge wired into 'replace' mode. `_crosswalker` provenance block emitted per spec/tier1.schema.json. Path collision detection.

- `src/generation/legacy-recipe-shim.ts` — translates v0.1.0 column-role configs → Ch 22 layout Recipe (per Ch 22 §10.7 4-phase migration)
- `src/generation/frontmatter-merge.ts` — managed (recipe-owned) vs user_preserve (recipe-untouched) semantics; user_preserve glob support; always-overwrite specials (`_crosswalker`, `curie`)
- `src/generation/provenance.ts` — `_crosswalker` block writer per Tier 1 schema $defs/provenance_block
- `src/generation/generation-engine.ts` — `buildNoteDataViaRender()` + `readExistingFrontmatter()` via metadataCache + path collision detection
- `plugin.runImport()` exposed as E2E entry point
- E2E: `tests/e2e/full-import-flow.spec.ts` (4/4 pass — milestone gate; verifies real file I/O + re-import idempotency + user_preserve survival)

### v0.1.2 — render() v1 (2026-05-05, ✅ Done)

Pure `render(Recipe, ConceptIdentity) → Address` shipped — the single coupling point per Ch 22 §3. Folder/file/heading mechanisms wired; tag/wikilink reserved for v0.2.

- `src/render/{index,types,template}.ts` — pure function pipeline; closed 7-filter set (`lower`, `upper`, `title`, `slug`, `tagsafe`, `fs-safe`, `truncate(N)`)
- `src/render/mechanisms/{folder,file,heading,tag,wikilink}.ts` — folder/file/heading wired; tag/wikilink throw informative "deferred to v0.2" errors
- Determinism verified: 100 unit + 50 E2E iterations, byte-identical output

### v0.1.1 — Type system + validation foundation (2026-05-04, ✅ Done)

AJV (Ajv2020) + ajv-formats wired into plugin startup; `spec/*.schema.json` compiled at load with fail-fast on schema malformation; `CrosswalkerConfig` interface renamed to `ImportRecipe` across the codebase.

- `src/validation/validator.ts` — `validateRecipe(obj)` + `validateTier1Frontmatter(obj)` exposed
- Validator handles attached to plugin instance for E2E reachability
- Tier 1 schema discriminator switched from `oneOf` to `allOf` + `if/then` on `kind` field (better AJV error messages)
- TS types generated from `spec/*.schema.json` to `src/types/generated/`

### Major architectural decisions during implementation phase

- **WASM-A pivot (2026-05-06)** — sqlite-vec deferred after WASM-B integration revealed sqlite-vec-wasm-demo is incompatible with Obsidian's Electron renderer ([synthesis log](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-06-wasm-a-pivot-synthesis/))
- **Two-mode import architecture (2026-05-05)** — Mode 1 (bundled projector) + Mode 2 (direct Tier 1 emission) both first-class; ChunkyCSV/JSONaut compose naturally as Mode 1 feeders ([log](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-05-two-mode-architecture/))
- **Transform-engine depth + GUI line + input formats (2026-05-05)** — stop in-plugin transform engine at v0.3 (closed 7-filter set + JSONata sub-language); JSONL ships as v0.2 input format midway ([log](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-05-transform-engine-depth-and-input-formats/))
- **ETL pipeline clarification (2026-05-05)** — ParsedData is in-memory implementation detail of Mode 1; not a tier; not a persisted format ([log](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-05-etl-pipeline-clarification/))

### Added (concept pages during implementation phase)

- [System architecture](https://cybersader.github.io/crosswalker/concepts/system-architecture/) — single canonical view of 3 storage tiers + 6 logical layers + component-to-tier matrix + read/write data flow + codebase map. New entry-point page for fresh agents/contributors

### Added (research challenges resolved during implementation phase)

- Ch 25 — Two-mode architecture and streaming (resolved 2026-05-05)
- Ch 26 — Transform engine depth + input formats (resolved 2026-05-05)

---

## [0.1.2] - 2026-09-23

Third public prerelease. Still intended for early testing in backup or test vaults, not production-critical use.

### What changed since 0.1.1

- **Nested sources import as nested notes.** A JSON file whose records contain lists of sub-records (groups, then controls, then parts) now imports level by level, and the wizard lets you decide which levels become notes.
- **A Depth control sets how deep the folders go.** One select on the mapping card chooses how many levels become folders, instead of editing each level by hand.
- **Lower levels can become sections inside a note.** A second select, Below the note, turns a level such as a control's statement and guidance into headings inside the control's note rather than separate notes. The sample preview shows those headings before you generate, and refreshing rebuilds them without touching anything you wrote outside the managed part of the note.
- **Columns that point at another framework become links between frameworks.** When a column holds references to another framework, the new Crosswalks card lets you name that framework, and the import writes a note for each link.
- **Find framework files already in your vault.** A scan lists source files it recognizes and opens them straight into the wizard.
- **Split a packed id into levels.** A column like `AC-2(1)` can be split on separator characters into its levels, and the wizard suggests the split when it spots one.
- **The wizard suggests the worksheet and header row** for spreadsheets, and saved drafts remember the header row.
- **Fixes:** changing the sheet or header row after going back now takes effect; adding a mapping by hand keeps the column's levels; shape cards that could not apply now say why instead of doing nothing.

### Requirements

- Obsidian 1.10.0 or newer.
- Install through BRAT (add `cybersader/crosswalker`) or copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/crosswalker/`.

## [Design phase complete] — 2026-05-04

The 0.1 design phase concluded 2026-05-04 with all named architectural questions resolved. Concrete implementation work begins next. Five fresh-agent research challenges (Ch 20–24) settled the import primitive's shape, build-vs-buy posture, target-structure grammar, engine implementation language, and Tier 2 substrate.

### Decided (architectural commitments)

- **Schema-as-primitive reframe** — Tier 1 schema is the load-bearing contract; engine + ETL are convenience. Anyone (plugin, external Python, AI agent, MCP server) emitting valid Tier 1 is a first-class producer. ([ETL pillar](https://cybersader.github.io/crosswalker/concepts/etl-and-import/))
- **Closed 5-mechanism recipe grammar** for target structure — `folder | file | heading | tag | wikilink` × ordered layout × also_emit cross-cutting × graph_edges. Single coupling point: `render(Recipe, ConceptIdentity) → Address` modeled on RML/R2RML. ([Ch 22 synthesis](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-04-target-structure-synthesis/))
- **TypeScript in-plugin engine for v0.1**, hybrid (optional Python producer) reserved for v0.5+. Path B (Python-as-core), Path D (Rust→WASM), Path E (Go→WASM), Path F (JVM) rejected. Mobile-Obsidian portability + small-OSS contributor pool are the two irreversible constraints. ([Ch 23 synthesis](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-04-bundle-engine-language-synthesis/))
- **Tier 2 substrate stays on `@sqlite.org/sqlite-wasm` + `sqlite-vec`.** libSQL-WASM, Turso Cloud Tier 3 listing, and Limbo near-term adoption all rejected after adversarial evaluation. Vendor-trajectory signal — Turso publicly de-prioritized libSQL. Five explicit migration triggers locked. ([Ch 24 synthesis](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-04-tier-2-substrate-synthesis/))
- **Runtime-agnostic recipe schema** as load-bearing modularity commitment — recipe contract is JSON Schema + AJV + JSONata; engine implementation is swappable; vector layer (`sqlite-vec`) is decoupled from substrate. Per Ch 23 §4 + Ch 24 §5.
- **Output query layer**: Bases (Dataview removed from the v0.1 commitment).

### Added (machine-readable contracts + dev infrastructure)

- `spec/tier1.schema.json` — canonical Tier 1 vault frontmatter shapes (concept_note, junction_note, crosswalk_edge) with provenance block; CURIE/CID/wikilink/tag-path defs. JSON Schema 2020-12. `$id`: `https://crosswalker.dev/spec/tier1.schema.json`
- `spec/recipe.schema.json` — full Ch 22 grammar as JSON Schema; 3 worked NIST 800-53 examples (all-folders, mostly-headings, hybrid). `$id`: `https://crosswalker.dev/spec/recipe.schema.json`
- `spec/primitives/` — stub for per-primitive schemas; populates as engine ships
- `tools/generate-fixtures.ts` — CSV → Tier 1 markdown fixture generator. Bootstraps reproducible test data without waiting for the full `render()` engine. `bun run fixtures` regenerates from `tools/fixtures/synthetic/nist-mini.csv`
- `tools/fixtures/synthetic/nist-mini.csv` — 8-control sample fixture (AC + AU families, including parent-wikilink hierarchy)

### Added (concept pillars)

- [ETL and import](https://cybersader.github.io/crosswalker/concepts/etl-and-import/) — schema-as-primitive framing; 4 architectural pieces; 5-axis recipe selection; ~40-primitive transformation catalog; YARRRML explained simply
- [Vault hierarchy primitives](https://cybersader.github.io/crosswalker/concepts/hierarchy-primitives/) — folder/heading/tag/wikilink-graph; identity-vs-address separation
- [Embedded vs server substrates](https://cybersader.github.io/crosswalker/concepts/embedded-vs-server-substrates/) — file-IS-the-database pattern; embedded landscape across 8 data models; long-horizon watch register
- [Agent tooling](https://cybersader.github.io/crosswalker/agent-context/agent-tooling/) — progressive-disclosure space for AI agents helping users transform data into Tier 1

### Added (synthesis logs and research deliverables)

- 5 dated synthesis logs (`zz-log/2026-05-03-import-primitive-formal-foundation-synthesis`, `2026-05-04-import-engine-design`, `2026-05-04-bundle-engine-language-synthesis`, `2026-05-04-tier-2-substrate-synthesis`, `2026-05-04-target-structure-synthesis`)
- 6 verbatim research deliverables in `zz-research/` (Ch 20a/20b/20c/22/23/24)
- 4 research challenges archived with resolution callouts (Ch 20/22/23/24)

### Changed

- README polished — internal-architecture vocabulary stripped from user-facing surface (STRM/SSSOM/Tier 2/sqlite-wasm/Polars+DuckDB no longer in README). Plain-language descriptions throughout. New 3-step IMPORT → VAULT → USE ASCII diagram. Related projects section (SEACOW, folder-tag-sync). Pattern-A directory structure (embedded test-vault/) confirmed
- KB development docs updated with `tools/` + `spec/` + fixtures workflow

### Deprecated

- The `hierarchy` column-role in `ImportRecipe` is now legacy (4-phase non-breaking migration plan documented in Ch 22 synthesis §9). Old recipes import via Phase-0 syntactic-sugar compatibility through v0.5; Phase-3 removal post-v1.0.

### Long-horizon watch register established

Substrates and adjacent file-based tools evaluated and not adopted today, with falsifiable re-evaluation triggers per entry: Limbo / Turso Database, libSQL-WASM (rejected Q1), Turso Cloud (rejected Q2), kuzu, LanceDB, DuckDB-PGQ, Stoolap, Datalevin, PouchDB/RxDB; adjacent VCS — jj/jujutsu, Pijul, Sapling; content-addressed — IPLD, Unison.

---

## [0.1.0-mvp-scaffold] - 2026-04-02

*Historical scaffold entry. The public 0.1.0 prerelease is the 2026-09-13 tag; see the [Unreleased] release-preparation entries above. This heading is deliberately not `## [0.1.0]`, so the release workflow's notes extractor cannot match it.*

Initial MVP release — the import wizard ships.

### Added
- Import wizard with 4-step workflow (file select, column config, preview, generate)
- CSV parsing with PapaParse streaming for large files (over 5 MB)
- Column type detection and analysis (hierarchy, ID, text, numeric, date, tags, URL)
- Config save/load/match/browse system with fingerprint-based matching
- Generation engine creating folders and notes with `_crosswalker` metadata
- Real folder tree and sample note preview in Step 3
- Comprehensive settings tab (output path, key naming, array handling, link syntax)
- Debug logging system (toggle in settings, outputs to crosswalker-debug.log)
- ESLint setup with obsidian-plugin community rules
- Embedded test vault for development
