# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Crosswalker is an Obsidian plugin for importing structured ontologies (frameworks, taxonomies, any hierarchical data) into Obsidian with folder structures, typed links, and metadata. Primary use cases include compliance frameworks (NIST, CIS, MITRE) but designed for any domain.

**GitHub**: https://github.com/cybersader/Crosswalker

## Build Commands

```bash
# Install dependencies
bun install

# Plugin — development mode (watch, outputs to test-vault)
bun run dev

# Plugin — production build (type-check + bundle)
bun run build

# Lint (required for community plugin submission)
bun run lint
bun run lint:fix

# Unit tests
bun run test
bun run test:watch
```

## Local dev orchestrator — `bun run serve`

`scripts/serve.mjs` is an interactive menu wrapping every local workflow (plugin watch, docs dev, docs build, tunnel sharing, docs E2E). Prefer this over raw commands — it handles cross-OS `node_modules` contamination (e.g. rollup native-binary mismatches when bouncing between WSL and Windows) automatically and cleans up all spawned children on `Ctrl+C`.

```bash
# Interactive menu (8 options)
bun run serve

# Non-interactive shortcuts (skip the menu)
bun run serve:docs       # Docs dev server (Astro HMR) → http://localhost:14321
bun run serve:plugin     # Plugin watch build → test-vault
bun run serve:both       # Docs dev + plugin watch in parallel
bun run serve:share      # Docs dev + Tailscale tunnel (tailnet only)

# Advanced (use the menu, or pass as argv)
bun scripts/serve.mjs preview      # Build docs + serve dist
bun scripts/serve.mjs build        # Build docs only → docs/dist
bun scripts/serve.mjs cloudflare   # Docs dev + Cloudflare Tunnel (public URL)
bun scripts/serve.mjs test         # Docs E2E (Playwright test:local)
```

**Interactive menu options** (what you see running `bun run serve`):

| # | Option | What it does |
|---|--------|--------------|
| 1 | Docs dev server | `bun x astro dev` in `docs/` on port 14321 with HMR — use this for KB editing |
| 2 | Docs preview (built) | `bun x astro build` + `bun x astro preview` — test the production render |
| 3 | Docs build only | `bun x astro build` → `docs/dist`, then exits |
| 4 | Plugin dev (watch) | `bun run dev` at repo root — rebuilds plugin into `test-vault/.obsidian/plugins/crosswalker/` on save |
| 5 | Docs + plugin dev | Runs options 1 + 4 in parallel. Single `Ctrl+C` kills both |
| 6 | Share docs (Tailscale) | Docs dev + `tailscale serve 14321`, prints tailnet URL |
| 7 | Share docs (Cloudflare) | Docs dev + `bun x cloudflared tunnel --url http://localhost:14321`, prints public URL |
| 8 | Docs E2E tests | `bun run test:local` in `docs/` (Playwright smoke + deployment suites) |

**Cross-platform notes:**
- First run in `docs/` auto-installs dependencies if `node_modules/` is missing
- If you bounce between WSL and Windows, the script detects a rollup native-binary mismatch (e.g. `@rollup/rollup-win32-x64-msvc` missing when Linux binaries are present) and nukes + reinstalls `docs/node_modules` automatically
- Tailscale detection handles both `tailscale` (Linux/WSL) and `tailscale.exe` (Windows)

## Testing Workflows

Three separate test surfaces. Know which you're working on before picking commands.

### 1. Plugin unit tests (Jest)

```bash
bun run test              # one shot
bun run test:watch        # watch mode
```

Covers parsers, config manager, generation engine logic. Fully headless — no Obsidian runtime required.

### 2. Plugin manual testing (Obsidian)

The plugin build outputs directly to `test-vault/.obsidian/plugins/crosswalker/` (configured in `esbuild.config.mjs`). Obsidian UI **can** be driven and screenshotted here — real Obsidian runs via the WebdriverIO harness over WSLg (`DISPLAY=:0 bun run e2e -- --spec tests/e2e/visual-*.spec.ts` → PNGs in `test-screenshots/`, which agents can Read). **Visual-verify rendering yourself with a screenshot before asking the user to eyeball.** Manual testing is reserved only for deep interactive UX (focus/drag/multi-step flows). See the `testing-patterns` skill.

1. `bun run serve:plugin` (or `bun run dev`) — starts the watch build
2. Open `test-vault/` in Obsidian
3. Enable the Crosswalker plugin in Settings → Community Plugins
4. Test via command palette: "Crosswalker: Import structured data"
5. Edits to `src/` auto-rebuild; reload the plugin in Obsidian (Ctrl+R in dev console, or toggle in settings) to pick up changes

### 3. Docs E2E tests (Playwright)

The docs site has a Playwright suite in `docs/tests/` that runs against a built + previewed site. Two suites:

- **`smoke.spec.ts`** (10 tests) — homepage loads, Nova top nav, sidebar, search, content pages (installation, features, agent-context, blog, architecture)
- **`deployment.spec.ts`** (4 tests) — HTTP 200, no console errors, no failed asset requests, meta tags present

**Running docs tests:**

```bash
cd docs

# All tests — builds + starts preview server + runs Chromium
bun run test:local

# Deployment-only tests (faster, subset)
bun run test:deploy

# Headed mode — watch the browser run the tests
bun run test:e2e

# Playwright UI mode — interactive debugging
bun run test:e2e:ui

# Against live site (instead of local preview)
TEST_URL=https://cybersader.github.io bun run test:deploy
```

**Or from the repo root, through the orchestrator:**
```bash
bun run serve            # interactive menu → pick option 8
# or:
bun scripts/serve.mjs test
```

**Prerequisites (first time only):**
```bash
cd docs
bun install
bun x playwright install chromium    # or: npx playwright install chromium
bun run build                          # preview server serves from dist/
```

**Configuration:**
- `docs/playwright.config.ts` — Playwright config
- Base path: `/crosswalker` (Astro base, lowercase) — all `page.goto()` calls must prefix this
- Preview server auto-starts on its own test port 14325 (the dev server owns 14321)
- Browser: Chromium only (sufficient for docs coverage)

**Screenshots on failure:** automatically captured to `docs/test-results/`. Can be read by agents directly.

**Common docs testing issues:**

| Issue | Fix |
|-------|-----|
| 404 on every page | Forgot `bun run build` — preview serves from `dist/` |
| Chromium not found | `bun x playwright install chromium` |
| Tailwind classes missing | Check `docs/src/styles/global.css` has `@source` directives |
| Base path 404s in custom tests | Prefix every `page.goto()` with `${BASE}/` where `const BASE = '/Crosswalker'` |

For the full docs testing reference, see `.claude/skills/docs-testing/SKILL.md`. For docs site architecture (Astro config, plugins, theming), see `.claude/skills/docs-site/SKILL.md`.

## Architecture

```
src/
├── main.ts                    # Plugin entry point, registers commands
├── settings/
│   ├── settings-data.ts       # Settings interface + DEFAULT_SETTINGS
│   └── settings-tab.ts        # Settings UI (PluginSettingTab)
├── import/
│   ├── import-wizard.ts       # Multi-step import modal (4 steps)
│   └── parsers/
│       └── csv-parser.ts      # PapaParse-based CSV parsing with streaming
├── generation/
│   └── generation-engine.ts   # Creates folders and notes with _crosswalker metadata
├── config/
│   ├── config-manager.ts      # Save/load/match import configurations
│   └── config-browser-modal.ts # Browse/select/delete saved configs
├── types/
│   └── config.ts              # TypeScript interfaces for all config types
└── utils/
    └── debug.ts               # Debug logging to crosswalker-debug.log
```

### Key Components

**Import Wizard** (`import-wizard.ts`): 4-step modal workflow
- Step 1: Select file (CSV/XLSX/JSON)
- Step 2: Configure columns (hierarchy, frontmatter, links, body)
- Step 3: Preview output structure
- Step 4: Generate notes

**CSV Parser** (`csv-parser.ts`): Uses PapaParse with streaming for large files (>5MB). Key exports:
- `parseCSVFile(file, options)` - Parse File object
- `parseCSV(content, options)` - Parse string content
- `analyzeColumns(data)` - Detect column types
- `shouldUseStreaming(file)` - Check if streaming recommended

**Config Manager** (`config-manager.ts`): Smart config matching
- `createFingerprint()` - Generate fingerprint from parsed data
- `findMatchingConfigs()` - Score and rank saved configs
- `exportConfig()` / `importConfig()` - JSON import/export

**Settings** (`settings-data.ts`): Comprehensive settings for:
- Output paths and naming styles
- Array/empty value handling
- Link syntax presets
- Config matching thresholds
- Wizard behavior toggles
- Debug logging

### Data Flow

```
File (CSV/XLSX/JSON)
    ↓
Parser (PapaParse/xlsx)
    ↓
ParsedData { columns, rows, rowCount }
    ↓
Column Analysis (type detection, samples)
    ↓
User Configuration (wizard steps 2-3)
    ↓
CrosswalkerConfig (full import config)
    ↓
Generation Engine (creates folders + notes)
```

## Linting Requirements

Uses `eslint-plugin-obsidianmd` for community plugin submission. Key rules:

- **Sentence case**: All UI text must use sentence case (capitalize first letter only)
- **No manual HTML headings**: Use `Setting.setHeading()` not `createEl('h3')`
- **No problematic headings**: Don't include plugin name in settings headings

Use `// eslint-disable-next-line obsidianmd/ui/sentence-case` for intentional exceptions (e.g., code examples).

## Type System

Core types in `src/types/config.ts`:

- `CrosswalkerConfig` - Full import configuration
- `ParsedData` - Output from file parsers
- `ColumnInfo` - Column analysis results
- `SavedConfig` - Persisted configuration with fingerprint
- `GeneratedNote` - Output note structure

Settings types in `src/settings/settings-data.ts`:

- `CrosswalkerSettings` - Plugin settings interface
- `KeyNamingStyle`, `ArrayHandling`, `EmptyHandling`, etc.

## Current State

**Implemented (MVP Complete!)**:
- Plugin scaffold with settings
- Import wizard UI (all 4 steps fully functional)
- CSV parsing with streaming for large files
- Column type detection and analysis
- Config save/load/match/browse system
- Generation engine with `_crosswalker` metadata
- Real folder tree and sample note preview (Step 3)
- Debug logging

**TODO (Future Enhancements)**:
- XLSX parser (xlsx package installed but not integrated)
- JSON parser
- Cross-framework linking
- Config export/import for sharing
- OSCAL export

## Documentation update reminders

Static checklist — when you touch certain paths, also update related docs/state. **This is judgment-required cross-doc reminders.** Mechanical patterns (lint must pass, MDX must build, schema must validate, fixtures must match canonical regen) live in CI gates instead, not here.

### Path-keyed reminders

| When you touch... | ...also update |
|---|---|
| `spec/*.schema.json` | `docs/src/content/docs/agent-context/v0-1-schema-spec.mdx`; bump `$id` major version if breaking; regenerate fixtures (`bun run fixtures`) |
| `tools/generate-fixtures.ts` or `tools/fixtures/synthetic/*.csv` | Run `bun run fixtures`; verify generated `test-vault/Frameworks/NIST-mini/*.md` validates against `spec/tier1.schema.json` |
| `src/render/**` | Round-trip determinism test (milestone v0.1.2 success criteria) |
| `src/generation/generation-engine.ts` | Re-import safety test (managed/user_preserve frontmatter merge semantics) |
| `ROADMAP.md` ↔ `docs/src/content/docs/reference/roadmap/index.mdx` | Mirror updates between root + KB (the dual-source convention) |
| `docs/src/content/docs/reference/roadmap/milestones/v0-1-N-*.mdx` | Flip status in the milestone hub status table at `milestones/index.mdx` |
| **Milestone shipped (status flipped to ✅)** | Write a delivery log via the `delivery-log` skill (`zz-log/YYYY-MM-DD-vX-Y-Z-<name>-shipped.mdx`) — must include the system-design integration diagram + cascade-unblock section + `## Related`; **AND update CHANGELOG.md `[Unreleased]`** with the milestone's user-visible/architecture-visible changes |
| Resolved a research challenge | Archive brief to `zz-challenges/archive/` with resolution callout; write synthesis log to `zz-log/`; update `zz-research/index.md`; update design log §6 "Still open" + §8 "Next steps" tables (use the `synthesis-log` skill) |
| **Publishing a fresh-agent research deliverable** to `zz-research/` | Follow `zz-research/index.md` § "Convention notes" exactly: (1) filename `YYYY-MM-DD-challenge-NN-(deliverable-[a-z]-)?<slug>.md` — multi-deliverable parallel runs MUST split into `deliverable-a-`/`deliverable-b-`/etc. (Ch 11/Ch 20 precedent); (2) plain `.md` not `.mdx`; (3) verbatim preservation — no editorial framing in the deliverable file; critical assessment goes in `zz-log/` synthesis log OR in gitignored `.workspace/` if pre-decision; (4) frontmatter shape mirrors existing deliverables (negative date-encoded `sidebar.order` for reverse-chronological); (5) update `zz-research/index.md` table with one row per deliverable. The `pre-commit-reviewer` agent's check 10 enforces this |
| New architectural commitment | Memory file (`project_*.md`); `CHANGELOG.md` `[Unreleased]` entry; design log update |
| **Any commit (mid-milestone or full milestone)** that ships user-visible or architecture-visible behavior | If the change is significant beyond the commit message, add a `CHANGELOG.md` `[Unreleased]` entry. CHANGELOG `[Unreleased]` is the single canonical "what's coming in the next release" log — implementation deliveries DO belong here, not just architectural commitments |
| **Landing a batch of shipped work inside an in-progress milestone** (mid-milestone commits, not a full milestone close) | Single-source rule — no duplication between CHANGELOG and milestone/roadmap prose: **milestone-status flips edit the milestone page** (status line, phase-row dates, checkboxes); **delivery detail lives ONLY in `CHANGELOG.md` `[Unreleased]`** (never restated as prose/tables on milestone or roadmap pages — link to the relevant `[Unreleased]` section instead); **batch landings update CHANGELOG + flip status cells, nothing else**. This exists because milestone/roadmap prose has gone stale three times from copy-drift against the habit-maintained CHANGELOG — see the [2026-07-11 docs anti-duplication convention log](https://cybersader.github.io/crosswalker/agent-context/zz-log/2026-07-11-docs-sync-and-anti-duplication-convention/) for the incident |
| `package.json` scripts | Document in `docs/src/content/docs/development/setup.mdx` build-commands table |
| New `.claude/skills/*` | Verify YAML frontmatter present (description triggers discovery); reference in `.claude/CLAUDE.md` skills list |
| `concepts/*.mdx` (new pillar) | Cross-link from related pages; add to relevant indexes |
| Substrate / engine choice changes | Verify still aligned with the 6 architectural commitments (see `.claude/CLAUDE.md` § v0.1 architectural commitments); if change is real, requires synthesis log + migration triggers |

### Pre-commit run-list

Before committing, run the matching commands:

| Files changed | Command |
|---|---|
| Any files | **`bun run check`**: all ten Static Checks gates (see below) |
| `src/**` | `bun run lint` + `bun run test` |
| `docs/**` (any `.mdx`) | `bun run check`. A full `cd docs && bun run build` is the expensive confirmation, and CI runs it authoritatively on every push |
| `tools/fixtures/synthetic/**` (CSV changes) | `bun run fixtures` |
| `spec/**` | `bun run fixtures` (regenerate) + verify `bun run build` |

**Run all ten, not a subset: `bun run check`.** It runs every `check:*` script in `package.json` in sequence (except `check:fixtures-drift`, which belongs with fixture changes) and prints one summary table (`scripts/check-all.mjs`). The `Static Checks` CI workflow runs exactly these, and a partial local pass reads as a green light while CI still fails:

```
bun run check:personal-data       # no paths, usernames, emails, secrets, AI attribution
bun run check:mdx                 # MDX parses
bun run check:frontmatter         # required frontmatter fields present and well-formed
bun run check:not-content         # inline HTML/SVG diagrams carry class="not-content"
bun run check:log-labels          # zz-log sidebar labels lead with "MM-DD · " from the filename
bun run check:links               # every internal doc link resolves to a real page and #anchor
bun run check:freshness           # living-page markers: one, unscoped, at most 30 days old
bun run check:unverified-claims   # "not observed"/"not verified"/... sentences carry (tracked: <link>)
bun run check:roadmap-sync        # milestone status glyphs agree across the four roadmap sources
bun run check:repo-paths          # repo paths named in docs and CHANGELOG exist in git
```

They cost a few seconds combined. Running three of five is how a docs publish failed CI on 2026-08-21 for a sidebar label.

### Gates (knowledge-ops, 2026-10-03)

Each gate exists because something slipped through a checklist. Mechanical rules live here as gates; the judgment rules above stay a checklist.

| What slipped | Gate | Rule it enforces |
|---|---|---|
| A living page carried a fresh `Status last verified` marker that only covered one row | `check:freshness` | A marker is a whole-page claim: one per page, canonical `**Status last verified:** YYYY-MM-DD`, no scope words (only, row, cell, scoped, paragraph, an "Earlier" chain), at most 30 days old. Scoped re-checks go in a note below the marker. Warns when most of a page's dates are older than 90 days |
| "Persistence was not observed" sat in the CHANGELOG for five months with no owner | `check:unverified-claims` | In `CHANGELOG.md` `[Unreleased]` and on living pages, a sentence saying not observed, not verified, not yet verified, unverified, not tested or could not test carries `(tracked: #anchor)` or `(tracked: /crosswalker/...)` that resolves, usually to `CHANGELOG.md` § Follow-ups |
| The roadmap index described May while the milestone pages said October | `check:roadmap-sync` | Milestone status glyphs agree across the milestone pages, the milestone hub, the roadmap index and `ROADMAP.md`; a Done milestone is not listed under "Active" |
| A log said the repo gains a file that is gitignored; renamed files left stale references | `check:repo-paths` | Backtick repo paths in docs and CHANGELOG exist in `git ls-files`. Opt out with `(local, gitignored)` or `(planned)` right after the token |
| Heading renames broke anchors the link gate could not see | `check:links` | `#fragment` links match a heading slug or an `id` on the target page |
| Spec reds on `main` nobody saw, because CI ran only the smoke spec | nightly `e2e-nightly.yml` + `tests/e2e/KNOWN_RED.md` | Every red case is listed with since-date, reason and tracked link; an unlisted red, a listed `red` case that passes, or an entry older than 30 days fails the run (`scripts/check-known-red.mjs`) |
| The search index never persisted on any host | `tier2-vfs-probe.spec.ts` in the CI smoke job | The stored-index mode is asserted on every plugin change |

`check:links` was added 2026-08-28 (anchors 2026-10-03) after a sweep found 68 files linking to challenge briefs that had been archived out from under them. Astro deploys broken internal links without complaint, so every one was a silent 404 and the site built green throughout. It knows about the routes `starlight-blog` and `starlight-tags` generate; if a route-generating plugin is added or re-prefixed in `docs/astro.config.mjs`, update `GENERATED_ROUTE_PREFIXES` in `scripts/lib/doc-pages.mjs` in the same change.

### Why this lives here (the design rule)

Patterns are encoded by **detection profile**:

- **Mechanical** (computer detects unambiguously) → CI gate (Wave 2 of the workflow audit). Examples: lint, MDX `<digit` patterns, schema well-formedness, fixture drift via diff.
- **Judgment** (requires human/agent context) → this checklist + `.github/pull_request_template.md`. Examples: "if you resolved a challenge, write a synthesis log"; "if you bumped a spec `$id` major, also update consumer pages."

Mixing them up creates two failure modes: judgment items in CI fail wrong (false positives erode trust); mechanical items in checklists slip through silently. Keep them separate.

## Roadmap Conventions

The roadmap lives in two places that must stay in sync:

- **Docs**: `docs/src/content/docs/reference/roadmap/index.mdx` — the living roadmap (active + future phases only)
- **Repo root**: `ROADMAP.md` — plain markdown mirror for GitHub

**When a phase completes:**
1. Move its checklist to a new archive page: `docs/src/content/docs/reference/roadmap/vX-Y-name.mdx`
2. Add a "What carried forward" section noting items that moved to later phases
3. Link the archive from the Archive section at the bottom of the roadmap index
4. Remove the completed phase from the living roadmap
5. Update `ROADMAP.md` at the repo root to match

**Every significant decision** gets a dated log entry in `docs/src/content/docs/agent-context/zz-log/`. Roadmap items should link to their log entries so the reasoning is always reachable.

## Cross-Linking Convention

**Links are critical in this knowledge base.** Every page should aggressively cross-link to related concepts, decisions, and definitions.

**When creating or editing any docs page:**
1. Link terms to their [terminology](/crosswalker/concepts/terminology/) definitions on first mention
2. Link concepts to the pages that explore them deeper (log entries, concept pages)
3. Every log page must have a `## Related` section at the bottom with links to related pages
4. Roadmap items should link to their log entries, research pages, and concept pages
5. When a term has aliases (e.g., "ontology diff primitives" = "graph change atoms"), mention the aliases and link to the terminology page
6. Link to the project's philosophical pillars ([vision](/crosswalker/agent-context/vision/), [problem](/crosswalker/concepts/problem/), [what makes CW unique](/crosswalker/concepts/what-makes-crosswalker-unique/)) where design decisions connect to them

**The goal:** A reader should be able to follow any concept from any page to its definition, rationale, and related decisions without dead ends.

## Research Challenges (`agent-context/zz-challenges/`)

One-off research briefs for fresh agents to critically assess the project. Each challenge is a focused assignment that stress-tests an assumption, explores a blind spot, or finds new paths not yet considered.

**How they work:**
- Challenges are pure assignments — the brief defines what to investigate
- Hand a challenge to a fresh agent with no prior context bias
- Point the agent at the KB for context
- Findings flow back through `zz-log/` as dated entries (not into the challenge file itself)
- Challenges stay clean for re-running with different agents

**When to create a new challenge:** When you suspect an architectural assumption hasn't been tested, when new research raises questions about existing decisions, or when you want an independent perspective on a design choice.

## Local Workspace (`.workspace/`)

The `.workspace/` folder at the repo root is **gitignored** — it holds local working documents for architecture exploration, research drafts, and back-and-forth thinking that isn't ready for the public knowledge base.

**When to use `.workspace/`:**
- Architecture exploration before decisions are made
- Draft schemas, data models, and design proposals
- Research synthesis from external agents or conversations
- Anything that needs iteration before committing to the KB

**File naming:** Same dated pattern as log files: `YYYY-MM-DD-<topic-slug>.md`

**Lifecycle:**
- Working docs start here
- When a decision is made → create a dated log entry in `docs/src/content/docs/agent-context/zz-log/` with the decision and rationale
- When a concept crystallizes → move relevant content to the docs KB
- Old workspace files can be deleted once their decisions are logged

**Key difference from `zz-log/`:** Workspace docs are messy, in-progress, and local. Log entries are clean, decided, and public.

## Research Deliverables (`agent-context/zz-research/`)

Long-form research deliverables produced by fresh-agent ("deep research") sessions in response to a [research challenge](#research-challenges-agent-contextzz-challenges). Once a deliverable is accepted as input to a decision log, it is moved out of `.workspace/` (gitignored, pre-decision) and into `docs/src/content/docs/agent-context/zz-research/` as a public, URL-shareable page.

**Why public**: external research-mode Claude sessions (and other readers) need to be able to reference the predecessor deliverable when running follow-on research. A gitignored copy is invisible to them.

**File naming**: `YYYY-MM-DD-challenge-NN-<slug>.md`. Date is the day the deliverable landed; challenge number matches the [brief](#research-challenges-agent-contextzz-challenges).

**Format**: plain markdown (`.md`) — these are dense long-form documents and we don't want MDX parsing edge cases for tables, code blocks, em-dashes, or special characters. Frontmatter just needs `title`, `description`, `tags`, `date`, `sidebar.label`, `sidebar.order` (negative date-encoded for reverse-chronological).

**Preservation**: deliverables are not edited after publication except for typo/formatting fixes that don't change content. Critical assessment and follow-on direction live in the corresponding `zz-log/` entry.

**Lifecycle:**
- Pre-publication drafts live in gitignored `.workspace/`
- When a deliverable is accepted as input to a decision log → publish to `zz-research/` with frontmatter
- Cite from the decision log via `/crosswalker/agent-context/zz-research/...` URL
- Hand external research sessions the URL plus the brief URL when spinning up follow-on work

## Extended Documentation

The canonical project knowledge base is the **docs site** at https://cybersader.github.io/crosswalker/. It contains:

- Concepts (problem framing, hierarchy primitives, ETL and import, embedded substrates, terminology)
- Architecture decisions and design pages
- The v0.1 schema spec
- The decision log (`zz-log/`), research deliverables (`zz-research/`), and open research challenges (`zz-challenges/`)
- The roadmap (mirrored at `ROADMAP.md` repo root)
- The agent-tooling progressive-disclosure space (`agent-context/agent-tooling/`)

The `.claude/` folder at the repo root contains only active agent context: `CLAUDE.md` (agent instructions) and `skills/` (reusable agent capabilities). Earlier numbered knowledge-base files were superseded by the docs site and removed in the 2026-05-04 cleanup.
