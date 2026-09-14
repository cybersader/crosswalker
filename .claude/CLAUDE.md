# Claude Agent Instructions — Crosswalker

## Project context

You are working on **Crosswalker** — an Obsidian plugin for importing structured ontologies (frameworks, taxonomies, hierarchical or graph-shaped concept sets) into Obsidian as canonical Markdown with frontmatter, folders, headings, tags, and typed wikilinks. Compliance frameworks (NIST, MITRE, CIS, ISO) are the primary launch use case; the architecture is general-domain.

**GitHub**: https://github.com/cybersader/Crosswalker

## v0.1 architectural commitments (settled 2026-05-04)

The 2026-05-04 design phase concluded with five fresh-agent research challenges (Ch 20–24) resolved. **These are settled commitments**; reference the linked synthesis logs for rationale before proposing changes.

| # | Commitment | Source |
|---|---|---|
| 1 | **Schema-as-primitive** — Tier 1 schema is the load-bearing contract; engine + ETL are convenience. Anyone (plugin, external Python, agent, MCP server) emitting valid Tier 1 is a first-class producer | [ETL pillar](https://cybersader.github.io/crosswalker/concepts/etl-and-import/) |
| 2 | **Closed 5-mechanism recipe grammar** — `folder \| file \| heading \| tag \| wikilink` × ordered layout × also_emit × graph_edges. `render(Recipe, ConceptIdentity) → Address` as single coupling point | [Ch 22 synthesis](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-04-target-structure-synthesis/) |
| 3 | **TypeScript in-plugin engine for v0.1** — Path C (optional Python producer) reserved for v0.5+. Mobile-Obsidian portability + small-OSS contributor pool are the irreversible constraints | [Ch 23 synthesis](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-04-bundle-engine-language-synthesis/) |
| 4 | **Tier 2 substrate stays on `@sqlite.org/sqlite-wasm` + `sqlite-vec`** — libSQL/Turso Cloud/Limbo all rejected. Five explicit migration triggers locked | [Ch 24 synthesis](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-04-tier-2-substrate-synthesis/) |
| 5 | **Runtime-agnostic recipe schema** — JSON Schema + AJV + JSONata; engine implementation is swappable; vector layer (`sqlite-vec`) decoupled from substrate. The single most important modularity commitment | [Ch 23 synthesis §4](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-04-bundle-engine-language-synthesis/#4-the-most-important-commitment-runtime-agnostic-recipe-schema) |
| 6 | **Output query layer = Bases** (Dataview removed) | Project memory: `project_query_layer_bases_not_dataview.md` |

**Machine-readable contracts**: [`spec/tier1.schema.json`](https://github.com/cybersader/crosswalker/blob/main/spec/tier1.schema.json) + [`spec/recipe.schema.json`](https://github.com/cybersader/crosswalker/blob/main/spec/recipe.schema.json).

## `.claude/` folder structure

```
.claude/
├── CLAUDE.md              # This file — main agent instructions (committed)
├── skills/                # Reusable agent capabilities (committed)
│   ├── docs-site/         # Astro/Starlight site authoring patterns
│   ├── docs-testing/      # Playwright docs E2E testing
│   ├── edit-history/      # Parse obsidian-edit-history .edtz files
│   ├── json-canvas/       # Obsidian JSON Canvas spec
│   ├── obsidian-bases/    # Obsidian Bases query authoring
│   ├── obsidian-markdown/ # Obsidian-flavor Markdown patterns
│   ├── session-log/       # Generic dated-doc creator (workspace-shared)
│   ├── synthesis-log/     # Crosswalker zz-log discipline — architectural decisions
│   ├── delivery-log/      # Per-milestone delivery-log discipline — what shipped + integration diagram
│   ├── wikilink-crawl/    # Pre-design 2-hop crawl of linked docs (READ skill; pairs with WRITE skills)
│   └── testing-patterns/  # Test pattern library
├── agents/                # Project-specific subagent definitions (committed)
│   ├── pre-commit-reviewer.md  # Audits staged diff for alignment-with-conventions; flags CHANGELOG drift / missing logs / personal data / etc.
│   └── milestone-starter.md    # Pre-work context briefing — crawls milestone page + dependencies + cited Ch NN sections; produces 1-page briefing before code starts
├── settings.local.json    # User-specific Claude Code settings (GITIGNORED)
└── plans/                 # Plan-mode files (GITIGNORED)
```

**Commit policy**:
- ✅ `CLAUDE.md` and `skills/` are committed — active agent context
- ❌ `settings.local.json` is gitignored — user-specific paths/permissions
- ❌ `plans/` is gitignored — ephemeral plan-mode state

The `.claude/` folder is intentionally lean: just active agent instructions plus reusable skills. **Project knowledge lives in the docs site at `docs/src/content/docs/`** (published to https://cybersader.github.io/crosswalker/), not here. Earlier numbered docs (`00-INDEX` through `45-FRAMEWORK-MAINTENANCE-LANDSCAPE`) were superseded by the docs site and removed in the 2026-05-04 cleanup.

## Knowledge base — recommended reading order

The canonical project KB is the docs site. For an agent new to the project:

| Topic | Page |
|---|---|
| **Read first — system architecture overview** (3 tiers, 6 layers, component-to-tier matrix) | [concepts/system-architecture](https://cybersader.github.io/crosswalker/concepts/system-architecture/) |
| The core problem | [concepts/problem](https://cybersader.github.io/crosswalker/concepts/problem/) |
| What makes Crosswalker unique | [concepts/what-makes-crosswalker-unique](https://cybersader.github.io/crosswalker/concepts/what-makes-crosswalker-unique/) |
| Vault hierarchy primitives | [concepts/hierarchy-primitives](https://cybersader.github.io/crosswalker/concepts/hierarchy-primitives/) |
| ETL and import (the schema-as-primitive pillar) | [concepts/etl-and-import](https://cybersader.github.io/crosswalker/concepts/etl-and-import/) |
| Embedded vs server substrates | [concepts/embedded-vs-server-substrates](https://cybersader.github.io/crosswalker/concepts/embedded-vs-server-substrates/) |
| Terminology | [concepts/terminology](https://cybersader.github.io/crosswalker/concepts/terminology/) |
| Tradeoffs | [agent-context/tradeoffs](https://cybersader.github.io/crosswalker/agent-context/tradeoffs/) |
| Vision | [agent-context/vision](https://cybersader.github.io/crosswalker/agent-context/vision/) |
| v0.1 schema spec (the build target) | [agent-context/v0-1-schema-spec](https://cybersader.github.io/crosswalker/agent-context/v0-1-schema-spec/) |
| Roadmap | [reference/roadmap](https://cybersader.github.io/crosswalker/reference/roadmap/) (mirrored at `ROADMAP.md` repo root) |
| **v0.1 implementation milestones** | [reference/roadmap/milestones](https://cybersader.github.io/crosswalker/reference/roadmap/milestones/) — current active work |
| Decision log | [agent-context/zz-log](https://cybersader.github.io/crosswalker/agent-context/zz-log/) |
| Research deliverables | [agent-context/zz-research](https://cybersader.github.io/crosswalker/agent-context/zz-research/) |
| Open research challenges | [agent-context/zz-challenges](https://cybersader.github.io/crosswalker/agent-context/zz-challenges/) |
| Agent-tooling progressive-disclosure space | [agent-context/agent-tooling](https://cybersader.github.io/crosswalker/agent-context/agent-tooling/) |

## v0.1 implementation status (as of 2026-09-04)

| Milestone | Status |
|---|---|
| [v0.1.1](https://cybersader.github.io/crosswalker/reference/roadmap/milestones/v0-1-1-types-and-validation/) — Type system + validation foundation | ✅ Done (2026-05-04) |
| [v0.1.2](https://cybersader.github.io/crosswalker/reference/roadmap/milestones/v0-1-2-render/) — render() v1 | ✅ Done (2026-05-05) |
| [v0.1.3](https://cybersader.github.io/crosswalker/reference/roadmap/milestones/v0-1-3-generation-engine-integration/) — Generation engine integration | ✅ Done (2026-05-05) |
| [v0.1.4](https://cybersader.github.io/crosswalker/reference/roadmap/milestones/v0-1-4-junction-notes-and-crosswalks/) — Junction notes + crosswalk edges | ✅ Done (2026-05-05) |
| [v0.1.4.5](https://cybersader.github.io/crosswalker/reference/roadmap/milestones/v0-1-4-5-streaming-refactor/) — Streaming refactor | ✅ Done (2026-05-05) |
| [v0.1.5](https://cybersader.github.io/crosswalker/reference/roadmap/milestones/v0-1-5-tier-2-sidecar/) — Tier 2 sqlite-wasm sidecar | ✅ Done (2026-05-06) |
| [v0.1.6](https://cybersader.github.io/crosswalker/reference/roadmap/milestones/v0-1-6-bases-query-layer/) — Bases query layer + SSSOM + recipe UX | 🚧 Phases 1–7 ✅ through 2026-07-11; delivery detail in `CHANGELOG.md` |
| **[v0.1.7](https://cybersader.github.io/crosswalker/reference/roadmap/milestones/v0-1-7-exporters/) — Portability (exporters + ImportRecipe fidelity)** | 🚧 Exporter first slice ✅ 2026-07-12; canonical RecipeDocument/body/fidelity foundation ✅ 2026-07-21; recipe library + full-source proofs remain. Separately, `fix/d1-per-import-root` is unmerged and does not change this milestone's status; see the 2026-09-04 entry in [CHANGELOG.md — Unreleased](../CHANGELOG.md) for delivery detail |
| [v0.1.8](https://cybersader.github.io/crosswalker/reference/roadmap/milestones/v0-1-8-audit-trail/) — Audit trail T1 default | 📋 Planning |
| [v0.1-RC](https://cybersader.github.io/crosswalker/reference/roadmap/milestones/v0-1-rc-bundle-and-ship/) — Ship | 📋 Planning |

**Date-anchored revisit checkpoints:**
- **2026-11-06** — sqlite-vec packaging revisit (per [WASM-A pivot synthesis](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-06-wasm-a-pivot-synthesis/) + [Ch 24 §5 Q4](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-05-04-tier-2-substrate-synthesis/#5-migration-triggers--when-to-revisit))

## Operational rules (load-bearing for agents)

| Rule | Source / why |
|---|---|
| **Brevity + Ctrl+F-able format** — terse tables/bullets over prose; long artifacts OK but summarize briefly in chat | Memory: `feedback_brevity_and_format.md` |
| **Funnel reporting after substantial work** — open at the altitude of someone who has not seen the project in months, then narrow: 30-second summary (standalone) -> plain-language explanation with a concrete example -> why it matters for real org use -> what changed -> the decision they own with trade-offs -> wider state. Write the funnel as a KB page; keep the chat message short and point at it | Memory: `feedback_funnel_reporting.md`; worked example: [2026-08-20 closure-cache fix](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-08-20-closure-cache-fix-and-what-it-means/) |
| **Formal term + plain gloss** — every defined term carries a plain-language gloss on first use (`Projection (the mapping from notes into the query database)`); prefer names that are formal *and* self-describing (`layout mechanism`, `query verb`) over bare ones (`primitive`). Two audiences are served by grouping within one page, never by splitting into competing glossaries | Memory: `feedback_formal_plus_intuitive_terminology.md`; [2026-08-19 primitives review](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-08-19-primitives-vocabulary-adversarial-review/) |
| **Link everything** — every term/concept/decision in KB pages should link to its definition; every log/concept page has a `## Related` section | Memory: `feedback_link_everything.md` |
| **Log all decisions** — significant decisions get dated `zz-log/` entries; capture user's perspective and intent | Memory: `feedback_log_decisions.md` |
| **General-ontology vocabulary in docs/KB; compliance-first in user-facing surfaces** — internal vocabulary uses ontology/concept; README + settings stay GRC-first | Memories: `feedback_general_ontology_positioning.md`, `feedback_readme_user_facing_surfaces.md` |
| **Never surface internal architecture vocabulary in README** — STRM/SSSOM/Tier 2/sqlite-wasm/Polars+DuckDB/runtime-agnostic-recipe-schema alienates evaluators. Plain language only in user-facing surfaces | Memory: `feedback_readme_user_facing_surfaces.md` |
| **Bases not Dataview** — v0.1 query layer commitment; do NOT reference Dataview in user-facing surfaces or new code | Memory: `project_query_layer_bases_not_dataview.md` |
| **Portable recipes patch the canonical original** — `RecipeDocument` is the preservation boundary; never rebuild a canonical ImportRecipe from the smaller workbench model. Unsupported lossy edits block. Durable recipe storage/UI is not complete yet | Memory: `project_portable_recipe_fidelity.md`; [2026-07-21 synthesis](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-07-21-portable-import-recipe-fidelity-synthesis/) |
| **Prevent artifact-noun proliferation** — authority follows ontological role, not storage, format, lifecycle phase, or UI model. Start with Schema Contract / Knowledge Set / Recipe; keep Execution Record and Package Manifest separate; Tier 1 is a canonical managed representation, not a root artifact. Add a new noun only for independent identity, lifecycle, authority, and consumers; Blueprint/lifecycle-manifest remains rejected without new semantics | [Concept](https://cybersader.github.io/crosswalker/concepts/artifact-roles-and-authority/) · [2026-07-21 synthesis](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-07-21-artifact-roles-and-authority-synthesis/) · Memory: `project_artifact_roles_and_authority.md` |
| **Freshness discipline on living pages** — pages describing *current* behavior carry `Status last verified: YYYY-MM-DD`; a session that changes `src/` behavior or `spec/` must update the affected living pages or log why not; counts/enums in docs cite their source file | § Documentation update reminders — freshness discipline (below); `pre-commit-reviewer` checks 12–16 |
| **Pattern A test-vault structure** — repo root has src/ + docs/ + spec/ + test-vault/ as siblings; build outputs into `test-vault/.obsidian/plugins/crosswalker/` | Confirmed 2026-05-04 |
| **Plugin ships only `main.js + manifest.json + styles.css`** — `tools/`, `spec/`, KB don't bloat releases | Confirmed 2026-05-04 |
| **Manual testing entry point** — `TEST_HANDS_ON_TOUR.md` at repo root is the master surface-coverage checklist (supersedes per-phase TEST_*.md guides for full passes) | Added 2026-06-12 |
| **Screenshot Obsidian UI yourself — it IS automatable here** — real Obsidian runs via wdio + X11 (`DISPLAY=:0 bun run e2e -- --spec tests/e2e/visual-*.spec.ts` → PNGs in `test-screenshots/`, readable by agents; native Xwayland on Fedora since 2026-08-19, formerly WSLg). Visual-verify rendering with a screenshot before claiming "can't render headlessly" or asking the user to eyeball. Never conclude Obsidian can't be screenshotted. | Memory: `reference_obsidian_screenshots_via_wdio.md`; `testing-patterns` skill |

## Model tiering & delegation (how to spend the main session)

Three-tier scheme, refined 2026-08-19 per user direction. The owner selects the session model explicitly (`/model`); each tier does the work of its altitude and pushes the rest down. **Spend every session at the highest level of abstraction its task allows.**

| Tier | Model | Session role | Work |
|---|---|---|---|
| **Architect** | Fable 5 | Occasional, owner-driven sessions | The hard ontological/data-model problems; sprint layout (dated `.workspace/` sprint plans); specs + schema deltas; design decisions (→ `zz-log/`); owner review-queue sittings; ratifying merges. Does NOT do ground engineering — if it catches itself editing `src/`, it should be writing a spec instead |
| **Orchestrator** | Opus 5 (or Opus 4.8) | The default implementation session | Executes the current sprint plan from `.workspace/`; decomposes specs into delegable tasks; reviews delegated diffs; runs gates; commits |
| **Workers** (subagents) | **Sol 5.6** for spec-exact implementation, surveys, sweeps, batch mechanics; **Sonnet** as fallback (Sol lane down/metered) or for the cheapest mechanical work; Opus only when a subagent task genuinely needs judgment (design-adjacent integration, KB writing) | Spawned by the orchestrator | Implementation against a written spec; test authoring; themed commit batches; corpus/code surveys; doc sweeps |

**The loop:** architect writes the sprint plan + specs (dated `.workspace/` docs: exact semantics, worked examples, acceptance cases) → orchestrator session delegates to workers, who implement exactly to spec, **no commits** → orchestrator reviews the diff, runs the gates, commits. (Exception: pure git-chunking tasks may commit on a side branch; nothing is ever pushed by a subagent.)

**Where the current sprint plan lives:** the newest `.workspace/*-sprint-plan.md` (local, gitignored). An orchestrator session starting cold should read it before anything else; if none exists or it's exhausted, that's a signal to ask the owner for an architect session.

Rules:
- Always set an explicit `model` on Agent calls — never inherit the session model into fully-specified mechanical work.
- Sol 5.6 rides a weekly-metered proxy lane (see global CLAUDE.md delegation budget rules) — small sequential batches (3–5 workers), never wide fan-outs on that lane.
- Hand subagents the repo commit rules (no AI attribution, no personal data) and current env notes (§ Environment below).
- If any session catches itself doing >~15 min of work below its tier, delegate it (or, for the architect, spec it for the next orchestrator session).
- Worked example of the loop: 2026-07-05 variadic folder expansion (`.workspace/2026-07-05-variadic-split-and-folder-note-design.md` → Sonnet implementation → architect review + commit).

## Resource discipline (HARD — this host is shared)

This workstation runs several Claude sessions plus other projects against a shared
cgroup. Tools that size themselves to the machine are hostile here: each assumes it
is alone. Three separate incidents on 2026-08-21 traced to exactly that, including a
desktop lockup at load ~39 with 12 GiB spilled to swap.

**Caps already in place — do not raise them, do not override them per-invocation:**

| Cap | Where | Why |
|---|---|---|
| Jest `maxWorkers: 2` | `jest.config.js` | Default is ~1 worker/core; three verification agents running the suite at once spawned ~21 workers on 8 cores |
| Playwright `workers: 2` | `docs/playwright.config.ts` | Default saturated the single-threaded `astro preview`, making every spec fail on `page.goto` timeout — which reads like a site regression, not a load problem |
| Astro image service `noop` | `docs/astro.config.mjs` | `sharp` was loaded for a site with one 12 KB logo. Peak build memory 3 GB -> 1.35 GB (measured) |

**Rules for any session or agent:**

1. **Never run heavy commands concurrently.** One build, test wave, or lint at a time.
   A workflow's parallel verify agents each invoking the full suite is the classic way
   to violate this — prefer having them assert against one shared run where possible.
2. **Exit code 143 is a SIGTERM, not a failure and not a hang.** A resource guard on
   this machine terminates offending process groups. Treat that run as INTERRUPTED
   WITH NO RESULT. Do not claim pass or fail from it, and do not immediately retry.
3. **NEVER wrap a retry in `git stash` / `stash pop`.** Under pressure that risks the
   working tree for no benefit. This was attempted once and was the wrong instinct.
4. **Use `build-contained -- <cmd>`** for lint or docs builds when pressure is elevated.
5. **Check before measuring:** `uptime` and `cat /proc/pressure/memory`. Instantaneous
   `some avg10` near zero means a window is open even if the 5-minute average is high.
6. **Measure, then cap — and record the number.** Every cap above cites a real
   before/after figure. An unmeasured "seems better" is how these regress.
7. **Prefer the cheap gate.** `check:mdx` catches MDX errors far cheaper than a full
   site build, and CI builds the site authoritatively on every push.

**When adding any new tool invoked from an agent workflow, give it an explicit
resource ceiling rather than accepting its default.** That is the whole lesson: three
independent tools, three defaults, three incidents.

## Environment (current dev machine)

**Native Fedora Linux since 2026-08-19** — the repo moved off a Windows drive mounted into WSL and onto a native Linux home directory. Audited 2026-08-19:

| Fact | Status |
|---|---|
| bun / node / git / gh (authed) / tailscale / zellij | ✅ all installed and working |
| **WSL jest workaround is RETIRED** — `bun run test` and bare `jest` work natively; do not tell subagents to use `node node_modules/jest/bin/jest.js` anymore | Confirmed 2026-08-19 |
| e2e screenshots run against native Xwayland `DISPLAY=:0` (no WSLg anymore); Obsidian + chromedriver already cached linux-x64 in `.obsidian-cache/` | Confirmed 2026-08-19 |
| `docs/astro.config.mjs` polling watcher removed (was a WSL-inotify workaround; native ext4 inotify is reliable) | ✅ done 2026-08-19 |
| `docs/node_modules` clean-reinstalled from the lockfile; win32 optional-dep leftovers gone | ✅ done 2026-08-19 |
| `portagenty` IS installed — the binary is `pa` (built from source, symlinked in `~/.local/bin`), not `portagenty`. Workspace file: `crosswalker-obsidian-plugin.portagenty.toml` (sessions: shell, plugin-dev, docs-dev, docs-share, test-watch) | ✅ verified 2026-08-19 |

## Roadmap conventions

The roadmap lives in two places that must stay in sync:

- **Docs**: `docs/src/content/docs/reference/roadmap/index.mdx` — the living roadmap (active + future phases only)
- **Repo root**: `ROADMAP.md` — plain-markdown mirror for GitHub

**Active milestone work** lives at `docs/src/content/docs/reference/roadmap/milestones/` (hub-and-spoke pattern adopted 2026-05-04).

**When a phase completes:**
1. Move its checklist to a new archive page: `reference/roadmap/vX-Y-name.mdx`
2. Add a "What carried forward" section noting items that moved to later phases
3. Update `ROADMAP.md` at the repo root to match
4. Flip phase status in roadmap index hub

**Every significant decision** gets a dated log entry in `docs/src/content/docs/agent-context/zz-log/` linked from the roadmap item.

## Documentation update reminders — freshness discipline

Path-keyed reminders ("when you touch X, also update Y") live in the root [`CLAUDE.md` § Documentation update reminders](../CLAUDE.md). This subsection covers the **other** failure mode: pages nobody touches, that keep getting read, and go stale silently. Added 2026-07-27 after a KB audit found five contradictory primitive counts across live pages, a quick-start documenting a removed UI, Dataview recommended on the GRC page months after commitment 6, a glossary teaching a retired query vocabulary, and a schema-spec page promising fields the machine schema never shipped.

### Living pages carry a freshness marker

A **living page** describes *current* behavior (vs a `zz-log/` entry, which describes a dated decision and is immutable). Every living page carries one line directly under its intro:

`**Status last verified:** YYYY-MM-DD — verified against <source of truth>`

| Living page | Source of truth it must be verified against |
|---|---|
| `getting-started/quick-start.mdx` | The shipped UI — a wdio screenshot or e2e run, not memory |
| `getting-started/*.mdx` (GRC teams, install, features) | Shipped UI + the 6 architectural commitments above |
| `reference/roadmap/milestones/index.mdx` + `v0-1-N-*.mdx` | `CHANGELOG.md` `[Unreleased]` + actual `src/` state |
| `agent-context/v0-1-schema-spec.mdx` | `spec/tier1.schema.json` + `spec/recipe.schema.json` (field-by-field) |
| `concepts/terminology.mdx` | Current code vocabulary; retired terms move to a "Retired" table, they are not silently kept |
| `concepts/system-model.mdx`, `concepts/system-architecture.mdx` | `src/` module layout + the commitments table |

### Rules

| Rule | Detail |
|---|---|
| **Behavior change ⇒ touch the living pages** | Any session that materially changes `src/` behavior, UI flow, or `spec/*.schema.json` MUST update the affected living pages **or** state in the commit body / `zz-log/` entry why not. "Docs later" is the failure mode; an explicit deferral note is acceptable, silence is not |
| **Marker bump is not free** | Only bump `Status last verified` after actually re-checking against the source of truth. Bumping without checking is worse than a stale date |
| **Counts and enums cite their source** | Never write a bare count ("the 5 primitives", "8 query verbs") or an inline enum in docs. Write it as `5 primitives (source: spec/recipe.schema.json § mechanisms)` so drift is greppable and a reviewer can diff it. Un-sourced counts are how five contradictory primitive counts coexisted |
| **Retired commitments get a purge sweep, not an edit** | When a commitment is replaced (Dataview → Bases, a removed UI flow), grep the whole `docs/` tree + `README.md` in the same session. Fixing only the page you happened to open is what left Dataview on the GRC page for months |
| **Stale > 30 days on a living page is a review flag** | The `pre-commit-reviewer` agent's checks 12–16 operationalize this section. It flags, it does not block |

**Where new pages go**: if a page describes current behavior, it is living — add the marker and a row above. If it describes a dated decision, it belongs in `zz-log/` and must NOT carry a freshness marker (logs are historical record; see § Research artifact lifecycle).

## Cross-linking convention

Every page should aggressively cross-link to related concepts, decisions, and definitions.

- Link terms to their [terminology](https://cybersader.github.io/crosswalker/concepts/terminology/) definitions on first mention
- Link concepts to the pages that explore them deeper
- Every log page must have a `## Related` section
- Roadmap items should link to log entries, research pages, and concept pages
- Link to philosophical pillars where design decisions connect to them

**Goal**: any reader follows any concept from any page to its definition, rationale, and related decisions without dead ends.

## Research artifact lifecycle

- **Challenge brief** (`agent-context/zz-challenges/NN-name.mdx`) — adversarial assignment for fresh agents; includes anti-patterns and success criteria
- **Deliverable** (`agent-context/zz-research/YYYY-MM-DD-challenge-NN-slug.md`) — verbatim agent output; preserved as historical record (`.md` not `.mdx`; frontmatter only for sidebar)
- **Synthesis log** (`agent-context/zz-log/YYYY-MM-DD-name-synthesis.mdx`) — what's adopted/rejected from the deliverable; cascade-unblocks; updates the design log §6 Still-open table
- **Archived brief** — moved to `zz-challenges/archive/` with a resolution callout pointing at the deliverable + synthesis log

Workspace drafts live at `.workspace/` (gitignored). Lifecycle: working draft → decision in `zz-log/` → published deliverable in `zz-research/` (when applicable) → concept crystallizes into `concepts/` pillar.

## Build / test commands

See `docs/src/content/docs/development/setup.mdx` for the full `bun run` reference table. Most-used during development:

| Command | What it does |
|---|---|
| `bun run serve` | Interactive menu — docs dev, plugin watch, parallel both, tunnel sharing, tests |
| `bun run dev` | Plugin watch build → `test-vault/.obsidian/plugins/crosswalker/` |
| `bun run fixtures` | Regenerate Tier 1 markdown test fixtures |
| `bun run build` | Plugin production build (type-check + bundle) |
| `bun run lint` | ESLint (community-plugin rules — required for submission) |
| `cd docs && bun run build` | Docs site build (must pass before deploy) |

## Spec evolution

`spec/tier1.schema.json` and `spec/recipe.schema.json` are JSON Schema 2020-12. URIs (`https://crosswalker.dev/spec/...`) are stable; breaking changes bump major version in URI. Validate with AJV (planned for milestone v0.1.1). When schemas change, regenerate fixtures (`bun run fixtures`) and update [`v0-1-schema-spec`](https://cybersader.github.io/crosswalker/agent-context/v0-1-schema-spec/) doc page.

## When you get stuck

- Check the docs site KB first
- Search the decision log (`zz-log/`) — most architectural questions are already answered
- For research-heavy questions, check `zz-research/` deliverables
- For Obsidian API questions, check the [Obsidian Plugin API](https://docs.obsidian.md/) directly
- For Crosswalker-specific conventions, check this file's "Operational rules" + "Roadmap conventions" sections

---

**Last Updated**: 2026-09-04 (Status table refreshed: v0.1.7 row now notes the separate, unmerged `fix/d1-per-import-root` branch work and its 2026-09-04 scoped acceptance measurement; header date bumped. Earlier note preserved: § Documentation update reminders — freshness discipline: living-page `Status last verified` markers, sourced counts/enums, retired-commitment purge sweeps; operationalized as `pre-commit-reviewer` checks 12–16. v0.1.7 portability still in progress — canonical ImportRecipe fidelity uses `RecipeDocument`; body renders through pure `render()`; persistent recipe library/UI and full NIST proofs remain.)
**For**: Crosswalker Obsidian Plugin Development (v0.1 implementation phase)
**Agent Role**: Architect & Delegation Orchestrator (specs, decisions, reviews — implementation delegated to subagents)
