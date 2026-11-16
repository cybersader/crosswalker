---
title: Framework adoption — what does adopting a framework actually ask of you?
tags: [crosswalker, framework-adoption, cis, scf]
---

# Framework adoption — what does adopting a framework actually ask of you?

> [!note] These views need local data
> The `.base` files here are pure query configs (commit-safe), but they read `Frameworks/_licensed/` — which is **gitignored** (CIS is CC BY-NC-SA, SCF is CC BY-ND). On a fresh clone the views render empty until you regenerate the licensed imports locally; see `tests/manual/TEST_CROSSWALK_PIVOT.md` step 1 + the CIS/SCF recipes in `recipes/import/`.

A second analysis lens on the live corpus (companion to [[Control lens]]): instead of asking how frameworks overlap, this asks what one framework demands at each maturity tier — the **scoping** question every GRC program starts with.

## The corpus (added 2026-06-12)

| Source | Concepts | Shape |
|---|---:|---|
| `Frameworks/_licensed/CIS-v8` | 153 safeguards | flat, IG1–3 tier flags + asset class + NIST function |
| `Frameworks/_licensed/SCF` | 1,468 controls | flat, 33 domains |

## CIS — the maturity staircase

CIS encodes adoption tiers directly: **IG1 (56)** is "essential cyber hygiene," **IG2 (+74 = 130)** adds operational depth, **IG3 (+23 = 153)** completes the mature program. The views slice exactly those deltas:

![[1 - CIS safeguards by IG tier.base]]

- **IG1 view** — the 56-safeguard starting line, grouped by control
- **IG2 additions** — the 74 safeguards you take on when stepping up
- **IG3-only** — the final 23 (mostly Devices/Network specialization)
- **By NIST function** — the same 153 re-shaped onto Identify/Protect/Detect/Respond/Recover

## SCF — the meta-framework by domain

SCF is the widest single catalog in the corpus: 1,468 controls across 33 domains. The largest domain is now **Artificial Intelligence & Autonomous Technologies (156 controls)** — bigger than Identification & Authentication (114), Data Privacy (102), or Network Security (98). The 2026 SCF is, by raw control count, an AI-governance framework first.

![[2 - SCF domain browser.base]]

## The hub matrix — adopt SCF once, satisfy many

The melted mapping columns make the meta-framework claim queryable: each row an SCF family, each column a framework, each cell how many of that framework's requirements the family touches.

![[3 - SCF hub - adopt once satisfy many.base]]

## Findings from building these

- **Empty-string flags, not booleans.** CIS IG flags arrive as `x` / `""` from the workbook; views filter `ig1 == "x"` rather than truthiness. A future recipe filter could coerce to booleans at ingest.
- ~~**SCF's mapping columns are the real prize.**~~ **Melted 2026-06-12** — `tools/crosswalk-from-melt.ts` unpivots the per-framework mapping columns into crosswalk edges: **5,675 edges across 7 frameworks** in one pass (CIS 429 · CSF 611 · 800-53 1,117 · ISO 27001 316 · ISO 27002 506 · SOC 2/TSC 1,478 · PCI DSS 1,218). The ISO/SOC 2/PCI edges are the **STRM proxy** — mappings into copyrighted frameworks without carrying any of their text. See [[3 - SCF hub - adopt once satisfy many]].
- **SCF writes CIS control-level refs as `N.0`** (`1.0` = CIS Control 1). The melt normalizes them (`--object-id-sub`), and CIS control-level notes were back-filled (18 controls alongside the 153 safeguards), so every SCF→CIS edge click-throughs on both ends.

## Related

- [[Control lens]] — overlap/reuse across frameworks
- `Crosswalk Coverage/` — heatmaps + the AC-2 concept-360 lookup
