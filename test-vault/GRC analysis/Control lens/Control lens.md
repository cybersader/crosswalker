---
title: Control lens — implement once, satisfy many
tags: [crosswalker, control-lens, coverage]
---

# Control lens — "implement once, satisfy many"

> [!note] These views need local data
> The `.base` files are pure query configs (commit-safe), but they read gitignored local data: edge notes under `_crosswalker/mappings/` and concept notes under `Frameworks/_licensed/` (CRI is copyrighted). On a fresh clone the views render empty until you regenerate per `tests/manual/TEST_CROSSWALK_PIVOT.md` step 1.

The first of the Unified Risk Model's three lenses, realized on the live crosswalk corpus. The Control lens reads one slice of the graph — the **crosswalk subgraph** (concept ↔ concept across frameworks) — and asks: *if I implement one control, how many separate framework requirements does it satisfy?*

Each view is one question decomposed into the same moves — **traverse → summarize → reshape → draw** — from the [URM × data morphology bridge](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-06-04-urm-questions-data-morphology/). The three views are deliberately **three different shapes**, not three count grids.

## The corpus

| Mapping set | Edges | Direction |
|---|---|---|
| `nist-csf-to-800-53` | 740 | CSF → 800-53 |
| `cri-to-800-53` | 1,039 | 800-53 → CRI |
| `nist-csf-to-cri` | 154 | CSF → CRI *(added 2026-06-12 — closes the triangle)* |

**800-53 is the convergence hub** — both frameworks crosswalk to it, so a single 800-53 control can carry both a CSF outcome and a CRI obligation.

> CRI is a financial-sector (FI) profile / authority-of-record, not a universal spine — the CRI views are scoped to FI.

## The headline — most-reused 800-53 controls

"Implement once, satisfy many," made concrete: these controls each satisfy the most distinct requirements across **both** frameworks. (Precomputed — Bases can group + count but can't sort groups by an aggregate, so a live ranked bar isn't expressible yet; see findings below.)

| 800-53 control | from CSF | from CRI | total requirements |
|---|---:|---:|---:|
| **IR-4** Incident handling | 25 | 29 | **54** |
| **PM-9** Risk management strategy | 17 | 37 | **54** |
| **SI-4** System monitoring | 12 | 22 | 34 |
| **CA-7** Continuous monitoring | 12 | 19 | 31 |
| **RA-3** Risk assessment | 15 | 16 | 31 |
| **CP-2** Contingency plan | 7 | 24 | 31 |
| **SR-3** Supply chain controls | 12 | 18 | 30 |

*(Ids shown unpadded — as of 2026-06-12 the extractor canonicalizes OLIR's zero-padded `IR-04` to NIST's `IR-4`, so edges link straight to the concept notes.)*

275 distinct 800-53 controls are touched in total. Implement IR-04 well and you've moved the needle on 54 separate CSF + CRI requirements.

## The three views (each a different draw)

1. **Overlap — where do CRI & 800-53 overlap?** → traverse + count by group → **heatmap (density)**.
   → [[1 - Overlap - CRI Profile x 800-53 (heatmap)]] (800-53 family × CRI group, 20 × 7).
   CSF-side companion: `Crosswalk Coverage/1 - CSF function x 800-53 family (heatmap)`.
2. **Strongest crosswalks — where is it an exact match?** → filter to `is_equivalent_to` → **slice (filtered table)**.
   → [[2 - Strongest crosswalks - exact equivalences (CRI)]] — the **71 exact 1:1** mappings where an 800-53 control *is* a CRI obligation. These are the "you already comply" hits.
3. **Reuse by 800-53 family — the convergence rollup** → normalize edge direction + count per family → **rollup (grouped table)**.
   → [[3 - Control reuse - 800-53 families across CSF and CRI]] — PM leads at 103 mappings, then IR (70), SR (65).

## Embedded views

![[1 - Overlap - CRI Profile x 800-53 (heatmap).base]]

![[2 - Strongest crosswalks - exact equivalences (CRI).base]]

![[3 - Control reuse - 800-53 families across CSF and CRI.base]]

## Findings from building these

- **Direction normalization needed.** 800-53 is the *object* in CSF mappings but the *subject* in CRI mappings, so the reuse view normalizes both onto one axis with a Bases `if()` formula. ~~The cleaner fix is normalizing predicate direction at ingest (the SKOS→STRM direction snag).~~ **Resolved 2026-06-12**: the SKOS→STRM map was inverted and is now fixed (broadMatch → `is_narrower_than`, per SKOS semantics) + pinned by a unit test; all three edge sets regenerated. Edges also now carry `subject_note`/`object_note` wikilinks, so tables click through to the actual control notes.
- **Bases can't rank by aggregate.** Heatmaps (pivot) and grouped counts work, but "top-N controls by reuse" — a bar chart in the [data-morphology](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-06-04-data-morphology/) sense — can't be sorted by the aggregate in Bases today. That `draw` currently needs a precomputed table (above) or an external chart.

## Not yet — the Assurance & Risk lenses

These need **evidence / risk / finding** nodes, which the crosswalk corpus doesn't carry yet. Once those land, the same pattern produces an `Assurance lens/` and `Risk lens/` folder. See the [URM bridge catalog](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-06-04-urm-questions-data-morphology/).
