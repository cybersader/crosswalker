# Crosswalker Roadmap

Crosswalker is a meta-system for ontology lifecycle management. Architecture decisions come first, features are built on that foundation. Full docs roadmap with linked rationale: https://cybersader.github.io/crosswalker/reference/roadmap/

## Done (0.1.0 MVP)

- [x] Import wizard (CSV parsing, column config, preview, generation)
- [x] Config save/load/match system with fingerprinting
- [x] Generation engine with `_crosswalker` metadata
- [x] Documentation site
- [x] Unit tests + CI/CD

## ✅ Design phase complete (2026-05-04)

The 0.1 design phase concluded with all named architectural questions resolved. Five fresh-agent research challenges (Ch 20–24) settled the import primitive's shape, build-vs-buy posture, target-structure grammar, engine implementation language, and Tier 2 substrate. Concrete implementation work begins next.

**Architectural commitments:**

- [x] **Schema-as-primitive reframe** — Tier 1 schema is the load-bearing contract; engine + ETL are convenience. Anyone (plugin, external Python, AI agent, MCP server) emitting valid Tier 1 is a first-class producer
- [x] **Closed 5-mechanism recipe grammar** — `folder | file | heading | tag | wikilink` × ordered layout × also_emit cross-cutting × graph_edges. Single coupling point: `render(Recipe, ConceptIdentity) → Address` modeled on RML/R2RML. Pass 1 vault-independent (deterministic, hashable); Pass 2 optional vault-state-aware link minimizer (deferred to v0.3)
- [x] **TypeScript in-plugin engine for v0.1**, hybrid (optional Python producer) reserved for v0.5+. Path B/D/E/F rejected after adversarial evaluation. Mobile-Obsidian portability + small-OSS contributor pool are the two irreversible constraints
- [x] **Tier 2 substrate stays on `@sqlite.org/sqlite-wasm` + `sqlite-vec`** — libSQL-WASM, Turso Cloud Tier 3 listing, Limbo near-term adoption all rejected. Five explicit migration triggers locked for re-evaluation
- [x] **Runtime-agnostic recipe schema** as load-bearing modularity commitment — recipe contract is JSON Schema + AJV + JSONata; engine implementation is swappable; vector layer (`sqlite-vec`) decoupled from substrate
- [x] **Output query layer**: Bases (Dataview removed from the v0.1 commitment)
- [x] **Long-horizon watch register pattern** established for substrates and adjacent file-based tools considered and not adopted today (Limbo, kuzu, LanceDB, DuckDB-PGQ, Stoolap, Datalevin, jj/jujutsu, IPLD, Unison)

**Machine-readable contracts shipped:**

- [x] `spec/tier1.schema.json` — canonical Tier 1 vault frontmatter (concept_note, junction_note, crosswalk_edge), JSON Schema 2020-12
- [x] `spec/recipe.schema.json` — full Ch 22 grammar; 3 worked NIST 800-53 examples
- [x] `spec/primitives/` — stub for per-primitive schemas (populates as engine ships)

**Dev infrastructure shipped:**

- [x] `tools/generate-fixtures.ts` + `tools/fixtures/synthetic/nist-mini.csv` — bootstraps reproducible test data via `bun run fixtures` without waiting for `render()`

## v0.1 implementation status

Mirrors the docs [milestone status snapshot](https://cybersader.github.io/crosswalker/reference/roadmap/milestones/) — that page is the live source; treat this as a snapshot.

**Status last verified: 2026-09-05** — every line below was re-checked against the milestone pages, `CHANGELOG.md` `[Unreleased]`, and the commit log. No milestone status changed in this documentation update; the `fix/d1-per-import-root` safety work remains unmerged branch work, not a shipped milestone. If today is far past this date and no newer verification line has replaced it, treat this list as unverified.

- [x] v0.1.1 — Type system + validation foundation (2026-05-04)
- [x] v0.1.2 — `render()` v1 (2026-05-05)
- [x] v0.1.3 — Generation engine integration (2026-05-05)
- [x] v0.1.4 — Junction notes + crosswalk edges (2026-05-05)
- [x] v0.1.4.5 — Iterator-ready engine boundary; wizard remains eager (2026-05-05)
- [x] v0.1.5 — Tier 2 sqlite-wasm sidecar projector (2026-05-06)
- [ ] **v0.1.6 — Bases query layer + SSSOM import + recipe UX** — 🚧 in progress. Phases 1–6.4 (Bases pivot view, SSSOM import, primitives, ingestion-corpus sprint) shipped through 2026-06-12. A concurrent **shape-workbench side-arc** (2026-07-05 → 2026-07-11, tracked as Phase 7) then landed inside this milestone's window. Full architectural record: [shape-workbench synthesis log](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-07-11-shape-workbench-architecture-synthesis/). Delivery detail for both Phase 6.4 and Phase 7 lives in `CHANGELOG.md` `[Unreleased]`, not restated here (per the [docs anti-duplication convention](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-07-11-docs-sync-and-anti-duplication-convention/)). v0.1.7 is active.
- [ ] v0.1.7 — Portability (exporters, reusable configurations, source bindings, MappingSets) — 🚧 in progress (exporter first slice landed 2026-07-12; canonical recipe-fidelity foundation landed 2026-07-21; configuration library, exact source-bound replay, minimal MappingSet envelope/UI, exporter completion, and explicit OSCAL target-shape decision remain, now gated on the [save-and-replay](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-07-25-save-and-exact-replay-decision-register/) and [primitives](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-07-25-primitives-reconciliation-decision-register/) decision registers of 2026-07-25; detail in `CHANGELOG.md` `[Unreleased]`)
- [ ] v0.1.8 — Execution records, audit, and package manifests — planning; depends on v0.1.7
- [ ] v0.1-RC — Artifact-chain acceptance, bundle, polish, ship — planning

Closing acceptance chain: **source bytes → reusable configuration → Knowledge Set/MappingSet → Execution Record → Package Manifest**. See [artifact roles and authority](https://cybersader.github.io/crosswalker/concepts/artifact-roles-and-authority/) and the [artifact-role synthesis](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-07-21-artifact-roles-and-authority-synthesis/).

**Delivery posture:** functional correctness and a usable, explicitly supported workflow come before optimizing every ingestion path. The eager in-memory wizard can remain the initial path where it works honestly; silent data loss, crashes on declared-supported inputs, and false completion are blockers. Advanced streaming, parser migration, and replay integrity for mutable multi-pass sources are staged, measured improvements, not automatic blockers for v0.1.7. See [ingestion safety and staged performance](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-09-05-ingestion-safety-and-staged-performance/).

## Foundation — earlier resolved decisions

Pre-Ch-20 architectural commitments. All settled and feeding v0.1 implementation.

- [x] Crosswalk edge semantics — STRM (predicate vocab) + SSSOM (validation envelope), hybrid; STRM-shaped TSV is user-facing wire format
- [x] Junction notes for evidence links (Ch 07) — 13-field flat-YAML schema, isomorphic to OSCAL `by-component`
- [x] Pairwise crosswalks + optional inheritable pivot (Ch 06); SCF available as inheritable spine
- [x] Progressive Tier Architecture — Tier 1 + Tier 2 sqlite-wasm sidecar bundled; Tier 1 standalone path preserved
- [x] Distribution architecture research — pnpm monorepo (@crosswalker/core + plugin + CLI) via VaultAdapter interface; implementation pending
- [x] StewardshipProfile rename + meta-schema lifecycle commitment (rename ripples deferred)
- [x] Audit trail floor: git + signed commits as v0.1 default; T2/T3 audit profiles as opt-in compliance-export mode in v1.0+
- [x] Identifier strategy (Ch 09) — UUIDv7 + sha256 CIDs + CURIEs (ORCID for SSSOM authors); CWUUID is display-only
- [x] **Unified v0.1 schema spec** — the four interconnected schemas (`_crosswalker` metadata, ImportRecipe, junction note, Tier 2 sidecar SQL) designed together; published at https://cybersader.github.io/crosswalker/agent-context/v0-1-schema-spec/
- [x] FrameworkConfig → ImportRecipe rename — type renamed for general-ontology positioning

## v0.1 implementation phase — what ships first

Concrete, shippable. ~1.2 MB plugin total. Tier 1 + Tier 2 sqlite-wasm sidecar bundled together. Begins now that design phase is closed.

**Implementation work (build against `spec/tier1.schema.json` + `spec/recipe.schema.json`):**

- [ ] Generate TypeScript types from `spec/*.schema.json` via `json-schema-to-typescript`; replace ad-hoc `src/types/config.ts` with generated types
- [ ] Wire AJV validator into the plugin — load both schemas at startup; validate recipes on save; validate generated frontmatter before write
- [ ] `render()` function implementation — folder + file + heading mechanisms (Ch 22 §10 v0.1 scope); tag + wikilink layout-mechanisms schema-reserved for v0.2
- [ ] `_crosswalker` metadata writer — extend `src/generation/generation-engine.ts` to emit the v2 fields per `spec/tier1.schema.json`; idempotent migration helper
- [ ] Junction note generation as new code path in the generation engine; non-destructive, git-history-preserving
- [ ] Tier 2 sqlite-wasm sidecar projector — new `packages/core/` module; auto-runs on vault load; lazy closure cache
- [ ] Bases-shaped query render layer (Dataview replaced)
- [ ] Portability chain: STRM/SSSOM/CSV export; explicit OSCAL target-shape decision; reusable ImportRecipe library under `_crosswalker/recipes/import/`; separate exact source/run binding; minimal MappingSet identity/membership/integrity/provenance/license envelope with inspect/export UI
- [ ] Execution records, audit, and package manifests: one terminal Execution Record per run; execution-linked provenance/log events; git + Ed25519 + FRE 902(13) consume it; a separate Package Manifest inventories and attests each distributed release
- [ ] Bundle target — under 500 KB plugin core + ~600 KB sqlite-wasm sidecar = ~1.2 MB compressed total

**Implementation infrastructure:**

- [ ] Monorepo restructure (extract ~50–60% into `packages/core`)
- [ ] Migration strategy matrix — StewardshipProfile + version delta → SCD type + handling
- [ ] Transform engine (custom build, ~40-primitive transformation catalog per ETL pillar §5)
- [ ] Ontology diff primitives implementation (9 atomic operations + 4 recognized composites)
- [ ] First starter recipes (`recipes/starter/`) — recipes (a)/(b)/(e) from Ch 22 §2.2 (NIST 800-53 r5 all-folders, mostly-headings, hybrid)

**Documentation tasks (non-blocking but valuable):**

- [ ] OSCAL ↔ Crosswalker mental-model documentation
- [ ] DB-choice architecture page (why Tier 1 + sqlite-wasm sidecar, not pure graph DB) — partly addressed by [embedded-vs-server-substrates](https://cybersader.github.io/crosswalker/concepts/embedded-vs-server-substrates/) pillar
- [ ] Comunica honest+practical assessment (conditional confirmation pending)
- [ ] StewardshipProfile rename ripples (~24 docs files)
- [ ] YARRRML ELI5 page (currently inline in ETL pillar; promote to dedicated page when recipe DSL choice firms up)

**Research items remaining (not v0.1-blocking):**

- [ ] SEACOW + folder-tag-sync prior-art integration decision (auto-generated folder-tag-sync rules from dual-emit recipes per Ch 22 §4.2)
- [ ] Graph scope decision (DAGs/hypergraphs deferred)
- [ ] StewardshipProfile vs transformation recipes investigation
- [ ] External-producer protocol surface (push-into-Crosswalker via MCP / agents) — likely picks up once Tier 1 schema lands as JSON Schema (now done; revisit)

**Infrastructure:**

- [ ] PII scanning in CI/CD
- [ ] Expand E2E smoke tests minimally
- [ ] Fluid layout scaling (clamp() CSS replacing rigid breakpoints)

## Formats / Acquire — "Import anything, transform it properly" (v0.2)

Expand source-format breadth and acquisition while preserving exact-source replay semantics.

- [ ] Complete import wizard UI (redesigned around recipe schema)
- [x] XLSX parser (sheet picker + header-row offset, shipped 2026-06-12) + JSON parser (iterator path + row filter + record picker, shipped 2026-06-12)
- [ ] JSONL (newline-delimited JSON) parser — not yet supported
- [ ] Source fetch automation — background acquisition helpers for known publisher files. Before this can ship, define a per-framework rights model because fetching a restricted workbook on a user's behalf is a different act from telling the user where it lives, and define a staleness/pinning story so automation does not silently replace the exact source version a recipe or replay expects
- [ ] Remote acquisition through explicit source references, kept separate from ImportRecipe transformation/layout policy
- [ ] Content-hash pinning with upstream source-drift diagnostics
- [ ] Verified source cache, deliberate refresh, and offline replay
- [ ] `mechanism: tag` and `mechanism: wikilink` layout-levels wired (schema-reserved at v0.1)
- [ ] `graph_edges` wired (schema-reserved at v0.1)
- [ ] Transform system implementation (~40 primitives across 9 categories)
- [ ] E2E test suite (built from spec)

### Recipe authoring with AI assistance

A canonical recipe is already plain JSON (bundled recipes use the closed 5-mechanism grammar), and an assistant can already read and propose edits to it directly. This is separate from the config browser's saved-config export/import, which round-trips wizard state (`SavedConfig`) — not a canonical recipe, and the config browser does not read Recipe JSON today. These items package a safe assistant round trip: full canonical RecipeDocument preservation (never a rebuild from a smaller fragment), plus an explicit preview and opt-in before any content leaves the vault.

- [ ] Paste-JSON entry alongside the existing file import
- [ ] Context-pack command — copy `spec/recipe.schema.json` + the current recipe + the source's column headers in one action
- [ ] Validate-on-paste — schema violations reported in-UI at paste time, naming the offending field, instead of failing during generation

## Crosswalks — "Link frameworks to each other and to evidence"

- [ ] Cross-framework linking engine
- [ ] Link insertion commands with search modal
- [ ] Batch re-import with version awareness
- [ ] CLI implementation (headless operations)

## v0.5 — "Optional external Python producer"

Per [Ch 23 synthesis §9](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-04-bundle-engine-language-synthesis/) — Path C (Hybrid) reserved for v0.5+. Opt-in only; desktop-only by design.

- [ ] Reference Python producer (Polars + DuckDB + openpyxl) in a sibling repo
- [ ] JSON-lines streaming protocol over stdin/stdout
- [ ] `producer` recipe field wired (schema-reserved at v0.1)
- [ ] Gate behind `Platform.isDesktopApp`; document explicitly that recipes using producers are non-portable to mobile

## Pass-2 link minimizer — "Shortest wikilink resolution" (v0.3)

- [ ] Pass-2 of `render()` — consult `VaultIndex` to downgrade unambiguous full-path wikilinks to bare basenames when `linkStyle: shortest`
- [ ] `linkStyle: shortest` wired in recipes (schema-reserved at v0.1)

## Performance — "v1.0+ companion plugins"

Performance enhancements + integration capabilities. Reframed by v0.1 stack-pivot as opt-in companion plugins after v0.1 lands.

- [ ] "Crosswalker Power Query" companion plugin — DuckDB-WASM + Oxigraph + Nemo layered Tier 2 stack (~5 MB). For users who outgrow Tier 2-Lite's ~100K mapping ceiling or need recursive SHACL / multi-stratum Datalog / SPARQL property paths
- [ ] Comunica federation companion plugin — Comunica + N3 + HDT for cross-vault, cross-org, external SPARQL endpoint queries (conditional — honest assessment needed)
- [ ] Compliance-export mode — opt-in profile picker exposing T2 OpenTimestamps and T3 audit options ("US litigation", "EU regulated", "Federal ATO", "Supply-chain")
- [ ] Migration trigger UX — status-bar + modal prompts when user outgrows Tier 2-Lite
- [ ] **Incremental Tier 2 projection** — auto-projection currently re-scans the whole vault on every load (~13s for ~1.9K concepts + 1.8K mappings, observed 2026-06-03). Persist the SQLite DB + skip unchanged notes (mtime/hash), or reproject on import only. Parked as future perf work; not blocking practical scoped views
- [ ] **"This will be heavy — load anyway?" confirm gate** — estimate cost before rendering (pivot cell-count = distinct rows × cols; result-set size) and, past a soft threshold, show a confirm prompt instead of rendering immediately. Softer companion to the existing hard 250K-cell cutoff in `crosswalker-pivot-view`; applies to pivots and any large Bases-backed view
- [ ] PQC dual-sign migration (2027+) — Ed25519 → ML-DSA-44 dual-sign per NIST IR 8547 timeline

## Deployment — "v2.0+ Tier 3 server guide"

Server-tier deployment options for users who genuinely need a shared multi-team server. Documented as a deployment guide rather than bundled into the plugin.

- [ ] Default recommendation: Postgres + JSONB + recursive CTE (boring tech, broadly operable)
- [ ] Apache Jena Fuseki + oxigraph-server — same-API SPARQL alternative (architectural symmetry with v0.1 Tier 2)
- [ ] Layered Fuseki + DuckDB-on-server — power-user upgrade path
- [ ] TerminusDB v12 — opt-in vault-mirror with git-style branch/diff (small-vendor risk flagged)
- [ ] Apache AGE on Postgres — supported fallback for Postgres-standardized environments
- [ ] Migration from AGE for early adopters (re-projection, not translation)
- [ ] Turso Cloud listing — REJECTED for v1.0 docs per Ch 24 Q2; revisit per migration triggers

## Evolution — "The meta-system"

- [ ] Version-transition loop — acquire/pin old + new versions → detect structural/semantic change → review mappings/migration decisions → apply → validate → record for replay/audit
- [ ] Later generalized Knowledge Set governance — expand beyond the v0.1 MappingSet envelope only after identity, membership, authority, versioning, licensing, and lifecycle semantics are proven across set types
- [ ] Entity-aligned migration UX — guided form → migration plan YAML → CLI
- [ ] Version registry standard — pluggable detection interface
- [ ] Per-framework decisioning format — taxonomy over taxonomies
- [ ] Progressive classification UX (community → wizard → auto-detect)
- [ ] Evolution profile registry (StewardshipProfile)
- [ ] Migration strategy engine (built on structural diff engine)
- [ ] Stale crosswalk detection

## Community — "Share and scale"

- [ ] Community marketplace — pre-transformed Tier 1 bundles. In-repo registry OR companion repo (deferrable). Once landed, the fixture generator gains `--from-bundle <id>` mode
- [ ] Package lifecycle — discover packages, resolve dependencies/compatibility, verify Package Manifest hashes/signatures/licenses, install, update, and uninstall
- [ ] Marketplace-driven fixtures — `bun run fixtures --from-bundle <id>` becomes the canonical "test against real published bundles" path
- [ ] Expanded OSCAL support — add catalog or other post-v0.1 models only after the v0.1 crosswalk target-shape decision is explicit and schema-valid
- [ ] Compliance dashboards
- [ ] Custom migration transforms (inline → named → custom scripts)
- [ ] AI-assisted transforms (LLM property mapping, like Obsidian web clipper AI templates)
- [ ] Extended graph support (DAGs, hypergraphs)
- [ ] Community plugin submission
- [ ] Spec publication (StewardshipProfile taxonomy + structural diff engine)

## Long-horizon watch register

Substrates and adjacent file-based tools evaluated and not adopted today, with falsifiable re-evaluation triggers per entry. See [embedded-vs-server-substrates](https://cybersader.github.io/crosswalker/concepts/embedded-vs-server-substrates/#long-horizon-watch-register) pillar for the full register.

- Substrates: Limbo / Turso Database, libSQL-WASM (rejected Q1), Turso Cloud (rejected Q2), kuzu, LanceDB, DuckDB-PGQ, Stoolap, Datalevin, PouchDB/RxDB
- Adjacent VCS: jj/jujutsu, Pijul, Sapling
- Content-addressed: IPLD, Unison

## Decision log highlights

Recent (2026-05-04 design-phase-complete):

- Target-structure synthesis (Ch 22) — https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-04-target-structure-synthesis/
- Tier 2 substrate synthesis (Ch 24) — https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-04-tier-2-substrate-synthesis/
- Bundle engine language synthesis (Ch 23) — https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-04-bundle-engine-language-synthesis/
- Import engine design — https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-04-import-engine-design/
- Import primitive formal foundation synthesis (Ch 20) — https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-03-import-primitive-formal-foundation-synthesis/

Earlier:

- v0.1 initial-stack pivot — https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-02-v0-1-initial-stack-pivot/
- Direction third-wave architectural shifts — https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-02-direction-third-wave-architectural-shifts/
- Direction commitments TL;DR — https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-02-direction-commitments-tldr/
- 05-01 Foundation commitments — https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-01-foundation-commitments-and-followon-research/
- Evidence-link edge model synthesis (junction notes) — https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-04-10-evidence-link-edge-model-synthesis/
- 04-10 Foundation research synthesis — https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-04-10-foundation-research-synthesis/

Full decision log: https://cybersader.github.io/crosswalker/agent-context/zz-log/

Research deliverables: https://cybersader.github.io/crosswalker/agent-context/zz-research/

Research challenges: https://cybersader.github.io/crosswalker/agent-context/zz-challenges/
