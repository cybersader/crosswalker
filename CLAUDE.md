# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Crosswalker is an Obsidian plugin for importing structured ontologies (frameworks, taxonomies, any hierarchical data) into Obsidian with folder structures, typed links, and metadata. Primary use cases include compliance frameworks (NIST, CIS, MITRE) but designed for any domain.

**GitHub**: https://github.com/cybersader/Crosswalker

## Build Commands

```bash
# Install dependencies
bun install

# Development mode (watch mode, outputs to test-vault)
bun run dev

# Production build (type-check + bundle)
bun run build

# Run linter (required for community plugin submission)
bun run lint

# Fix lint issues automatically
bun run lint:fix

# Run tests
bun run test

# Run tests in watch mode
bun run test:watch
```

## Testing Workflow

The build outputs directly to `test-vault/.obsidian/plugins/crosswalker/` (configured in `esbuild.config.mjs`). To test:

1. Run `bun run dev` (watch mode)
2. Open `test-vault/` in Obsidian
3. Enable the Crosswalker plugin in Settings > Community Plugins
4. Test via command palette: "Crosswalker: Import structured data"

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

## Research Challenges (`agent-context/challenges/`)

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

## Extended Documentation

For detailed project knowledge, architecture decisions, and roadmap, see `.claude/` folder:
- `00-INDEX.md` - Navigation and reading order
- `01-PROBLEM.md` - Core problem definition
- `10-VISION-SHORT.md` - MVP definition
- `41-QUESTIONS-RESOLVED.md` - Key decisions made

Also see `PROJECT_BRIEF.md` for full project specification.
