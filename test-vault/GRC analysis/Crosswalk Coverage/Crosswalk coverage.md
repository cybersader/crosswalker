---
title: Crosswalk coverage — where do frameworks overlap, and how densely?
tags: [crosswalker, crosswalk-coverage, heatmap]
---

# Crosswalk coverage — where do frameworks overlap, and how densely?

> [!note] These views need local data
> The `.base` files here are pure query configs (commit-safe), but they read edge notes under `_crosswalker/mappings/` and concept notes under `Frameworks/_licensed/` — both **gitignored** (CRI/CIS/SCF are licensed). On a fresh clone the views render empty until you regenerate per `tests/manual/TEST_CROSSWALK_PIVOT.md` step 1 + step 5.

The coverage lens reads the **crosswalk subgraph** (concept ↔ concept edges across frameworks) and asks density questions: which functions/families overlap, how much, and what does one concept touch everywhere?

## The views

1. [[1 - CSF function x 800-53 family (heatmap)]] — the original coverage matrix (740 NIST OLIR edges)
2. [[2 - CSF coverage density by function]] — rollup by CSF function
3. [[3 - Lookup - ID.IM-02 maps to]] — single-concept lookup (one subcategory → its 800-53 controls)
4. [[4 - CSF function x CRI group (heatmap)]] — the triangle's third edge (154 edges, CSF ⊂ CRI directions corrected 2026-06-12)
5. [[5 - Concept 360 - AC-2 across all crosswalks]] — one control, every requirement it touches in **every** mapping set, with click-through `subject_note`/`object_note` links

## Related

- [[Control lens]] — the "implement once, satisfy many" reuse analysis
- [[Framework adoption]] — maturity tiers + the SCF hub matrix
