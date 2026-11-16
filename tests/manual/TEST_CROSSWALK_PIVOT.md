# Manual test — end-to-end crosswalk coverage pivot

Drives the depth-first slice **NIST CSF 2.0 ↔ 800-53 ↔ CRI** all the way to a
rendered Bases coverage matrix. The headless stages (concept notes + crosswalk
edges) are automated; this guide covers the parts only Obsidian can do.

> The slice output (concept + edge notes) is **gitignored** — CRI is copyrighted
> (Cyber Risk Institute) and financial-sector-specific. So a fresh clone won't
> have the notes; Step 1 regenerates them locally from your `Frameworks/` files.

## 1. Regenerate the slice (headless, seconds)

From the repo root, with the source workbooks in `Frameworks/`:

```bash
SLICE=test-vault/Frameworks/_licensed

# Concept notes (Tier 1) — the pivot's rows/cols resolve to these
bun tools/generate-fixtures.ts --source "Frameworks/NIST_SP-800-53_rev5_catalog_load.csv" \
  --recipe recipes/import/nist-800-53-flat.json --id "{identifier}" \
  --target "$SLICE/NIST-800-53" --clean --deterministic

bun tools/generate-fixtures.ts --source "Frameworks/csf2.xlsx" --sheet "CSF 2.0" --header-row 1 \
  --recipe recipes/import/nist-csf-2.json --id "{Subcategory|split(:,0)}" \
  --target "$SLICE/NIST-CSF-2" --clean --deterministic

bun tools/generate-fixtures.ts --source "Frameworks/CRI-Profile-ver.-2.2.2026-04-27.xlsx" \
  --sheet "CRI Profile v2.2 Structure" --header-row 2 \
  --recipe recipes/import/cri-profile-v2-2.json --id "{Profile Id}" \
  --target "$SLICE/CRI-Profile" --clean --deterministic

# CSF function + category hierarchy notes (from the CPRT JSON) — targets of the
# group-level OLIR mappings; without these ~40 edge wikilinks dangle
for lvl in function category; do
  bun tools/generate-fixtures.ts --source "Frameworks/cprt_CSF_2_0_0_06-01-2026.json" \
    --iterator '$.response.elements.elements[*]' --where "element_type=$lvl" \
    --recipe recipes/import/nist-csf-2-cprt.json --id "{element_identifier}" \
    --target "$SLICE/NIST-CSF-2" --deterministic
done

# CIS v8.1.2 — safeguards (153) + control-level notes (18; SCF references these as "N.0")
bun tools/generate-fixtures.ts --source "Frameworks/CIS_Controls_Version_8.1.2___March_2025.xlsx" \
  --sheet "Controls v8.1.2" --recipe recipes/import/cis-controls-v8.json \
  --id "{CIS Safeguard}" --target "$SLICE/CIS-v8" --clean --deterministic
bun tools/generate-fixtures.ts --source "Frameworks/CIS_Controls_Version_8.1.2___March_2025.xlsx" \
  --sheet "Controls v8.1.2" --recipe recipes/import/cis-controls-v8-controls.json \
  --id "{CIS Control|trim}" --where 'CIS Safeguard=' --target "$SLICE/CIS-v8" --deterministic

# SCF 2026.1.1 — controls (1,468)
bun tools/generate-fixtures.ts --source "Frameworks/Secure.Controls.Framework.SCF.-.2026.1.1.xlsx" \
  --sheet "SCF 2026.1" --recipe recipes/import/scf-2026-flat.json \
  --id "{SCF #}" --target "$SLICE/SCF" --clean --deterministic

# SCF hub melt — 5,675 crosswalk edges into 7 frameworks (the STRM proxy)
bun tools/crosswalk-from-melt.ts \
  --source "Frameworks/Secure.Controls.Framework.SCF.-.2026.1.1.xlsx" --sheet "SCF 2026.1" \
  --subject-col 'SCF #' --subject-prefix scf \
  --melt 'CIS CSC 8.1=cis-v8;NIST CSF 2.0=nist-csf-2;NIST 800-53 R5=nist-800-53;ISO 27001 2022=iso-27001;ISO 27002 2022=iso-27002;AICPA TSC 2017:2022 (used for SOC 2)=aicpa-tsc;PCI DSS 4.0.1=pci-dss-4' \
  --target-root "test-vault/_crosswalker/mappings" \
  --depad-prefixes nist-800-53 \
  --object-id-sub 'cis-v8=\.0$=' \
  --subject-note-folder "Frameworks/_licensed/SCF" \
  --object-note-folders 'cis-v8=Frameworks/_licensed/CIS-v8;nist-csf-2=Frameworks/_licensed/NIST-CSF-2;nist-800-53=Frameworks/_licensed/NIST-800-53' \
  --provider "Secure Controls Framework" --clean --deterministic

# Crosswalk-edge notes (the mappings the pivot counts)
bun tools/crosswalk-from-olir.ts \
  --source "Frameworks/Cybersecurity_Framework_v2-0_Concept_Crosswalk_800-53_final.xlsx" \
  --sheets "Relationships" --subject-prefix nist-csf-2 --object-prefix nist-800-53 \
  --provider "NIST OLIR" --target "test-vault/_crosswalker/mappings/nist-csf-to-800-53" \
  --depad object \
  --subject-note-folder "Frameworks/_licensed/NIST-CSF-2" \
  --object-note-folder "Frameworks/_licensed/NIST-800-53" \
  --clean --deterministic
```

Expected: ~1,189 + 185 + 472 concept notes, and **740** CSF→800-53 edge notes
(each validated against `spec/tier1.schema.json` as it's written).

## 2. Build + open the plugin

```bash
bun run build      # or: bun run dev  (watch)
```

Open `test-vault/` in Obsidian → enable **Crosswalker** (Settings → Community
plugins). Make sure **Bases** (core plugin) is enabled.

## 3. Render the coverage pivot

**Easy path:** Command palette → **Crosswalker: Insert query into note** → pick
**Coverage matrix** → confirm. It writes a `.base` embed into the note.

**Manual path:** create `Coverage.base` anywhere in the vault with:

```yaml
filters:
  and:
    - file.inFolder("_crosswalker/mappings/nist-csf-to-800-53")
views:
  - type: crosswalker-pivot
    name: "NIST CSF 2.0 → 800-53 coverage"
    rowsBy: subject_id
    colsBy: object_id
    cellOp: count
    heatmap: true
```

Then embed it in a note: `![[Coverage.base]]`.

## 4. What you should see (✅ pass criteria)

- A grid: **rows = CSF elements** (`nist-csf-2:GV.OC-01`, …), **columns =
  800-53 controls** (`nist-800-53:AC-2`, …), **cells = mapping counts**, heatmap
  shaded.
- Clicking a populated cell / row resolves to the crosswalk-edge notes.
- No "0 results" empty state (that means the folder filter is wrong, or the edge
  notes weren't generated — recheck Step 1).

## 5. (Optional) Add the CRI dimension

Regenerate CRI→800-53 edges (1,039 edges, local-only), then point a second
`.base` at that folder:

```bash
bun tools/crosswalk-from-olir.ts \
  --source "Frameworks/wp-contentuploads202509CRI-Profile-v2.1-to-SP-800-53-Rev-5.1.1.Final_.2025.xlsx" \
  --subject-prefix nist-800-53 --object-prefix cri-profile \
  --provider "Cyber Risk Institute" \
  --depad subject \
  --subject-note-folder "Frameworks/_licensed/NIST-800-53" \
  --object-note-folder "Frameworks/_licensed/CRI-Profile" \
  --target "test-vault/_crosswalker/mappings/cri-to-800-53" --clean --deterministic
```

And the third triangle edge — CSF→CRI (154 edges, local-only), from the CRI
workbook's own mapping sheet (OLIR-shaped; headers sit under 3 banner rows):

```bash
bun tools/crosswalk-from-olir.ts \
  --source "Frameworks/CRI-Profile-ver.-2.2.2026-04-27.xlsx" \
  --sheets '^NIST CSF v2 Mapping$' --header-row 3 \
  --subject-col 'CSF / Profile Id' --object-col 'Profile Id' \
  --subject-prefix nist-csf-2 --object-prefix cri-profile \
  --provider "Cyber Risk Institute" \
  --subject-note-folder "Frameworks/_licensed/NIST-CSF-2" \
  --object-note-folder "Frameworks/_licensed/CRI-Profile" \
  --target "test-vault/_crosswalker/mappings/nist-csf-to-cri" --clean --deterministic
```

> **Directional edges (resolved 2026-06-12):** the `SKOS_TO_STRM` map used to
> invert standard SKOS for `broadMatch`/`narrowMatch`; it's fixed (broadMatch →
> `is_narrower_than`, per SKOS semantics) and pinned by a unit test. Directional
> STRM predicates on regenerated edges are now trustworthy.

## Report back

- Screenshot of the rendered matrix (or the empty state + which step failed).
- `crosswalker-debug.log` lines with `category=="view"` if the pivot errors.
