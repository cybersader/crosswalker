# Crosswalker Roadmap

Crosswalker is a meta-system for ontology lifecycle management. Architecture decisions come first, features are built on that foundation. Full docs roadmap with linked rationale: https://cybersader.github.io/crosswalker/reference/roadmap/

## Done (0.1.0 MVP)

- [x] Import wizard (CSV parsing, column config, preview, generation)
- [x] Config save/load/match system with fingerprinting
- [x] Generation engine with `_crosswalker` metadata
- [x] Documentation site (112+ pages)
- [x] Unit tests + CI/CD

## Foundation — "Get the architecture right"

- [ ] Structural diff engine spec — 9 atomic operations + 4 recognized composites (provably complete)
- [ ] EvolutionPattern taxonomy — prediction/defaults layer on top of diff engine
- [ ] FrameworkConfig v2 schema — evolution metadata, config-as-code format
- [ ] _crosswalker metadata v2 — version tracking, source hash, migration history
- [ ] Migration strategy matrix — evolution pattern → SCD type → handling
- [ ] As-code data format research — primitives for configs, evolution profiles, migration rules
- [ ] Layered architecture design — spec → library/SDK → integrations
- [ ] Progressive tier architecture — Tier 1 (files) → Tier 2 (sidecar SQLite) → Tier 3 (server)
- [ ] Distribution architecture — monorepo: @crosswalker/core + plugin + CLI
- [ ] Graph scope decision — directed graphs now, DAGs/hypergraphs later
- [ ] Obsidian Bases direction research — viewing/querying layer on native capabilities
- [ ] Transform engine — custom build, 24 transform types
- [ ] PII scanning in CI/CD

## Formats — "Import anything, transform it properly"

- [ ] Complete import wizard UI (redesigned around v2 schema)
- [ ] XLSX parser + JSON/JSONL parser
- [ ] Transform system (20+ types)
- [ ] E2E test suite (built from spec)

## Crosswalks — "Link frameworks to each other and to evidence"

- [ ] Cross-framework linking engine
- [ ] Link insertion commands with search modal
- [ ] Batch re-import with version awareness
- [ ] CLI implementation (headless operations)

## Evolution — "The meta-system"

- [ ] Entity-aligned migration UX — guided form → migration plan YAML → CLI
- [ ] Version registry standard — pluggable detection interface
- [ ] Per-framework decisioning format — taxonomy over taxonomies
- [ ] Progressive classification UX (community → wizard → auto-detect)
- [ ] Evolution profile registry
- [ ] Migration strategy engine (built on structural diff engine)
- [ ] Stale crosswalk detection

## Community — "Share and scale"

- [ ] Community config registry
- [ ] OSCAL export
- [ ] Compliance dashboards
- [ ] Custom migration transforms (inline → named → custom scripts)
- [ ] AI-assisted transforms (LLM property mapping, like Obsidian web clipper AI templates)
- [ ] Extended graph support (DAGs, hypergraphs)
- [ ] Community plugin submission
- [ ] Spec publication (EvolutionPattern taxonomy + structural diff engine)
