<p align="center">
  <img src="docs/public/logo.png" alt="Crosswalker" width="200" />
</p>

<h1 align="center">Crosswalker</h1>

<p align="center">
  <strong>Turn your Obsidian vault into an operational GRC knowledge graph.</strong>
</p>

<p align="center">
  <a href="https://github.com/cybersader/crosswalker/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cybersader/Crosswalker?style=flat-square" alt="License" /></a>
  <a href="https://cybersader.github.io/crosswalker/"><img src="https://img.shields.io/badge/docs-live-00d4aa?style=flat-square" alt="Docs" /></a>
  <a href="https://github.com/cybersader/crosswalker/releases"><img src="https://img.shields.io/github/v/release/cybersader/crosswalker?style=flat-square&include_prereleases&label=version" alt="Version" /></a>
  <a href="https://obsidian.md"><img src="https://img.shields.io/badge/Obsidian-plugin-7c3aed?style=flat-square" alt="Obsidian" /></a>
</p>

---

Crosswalker helps GRC teams bring frameworks into [Obsidian](https://obsidian.md), shape them into useful notes, connect controls and evidence, and understand coverage in plain Markdown. Portable import rules, crosswalk mappings, and saved queries keep the work reusable by people and automation. It's built for GRC first and works for any structured framework or taxonomy: the one-click imports that ship today are all compliance sources, but nothing in the note format is compliance-specific, so a standards catalog, skills matrix, or product hierarchy goes through the same guided import ([why the core stays domain-neutral](https://cybersader.github.io/crosswalker/concepts/what-makes-crosswalker-unique/#5-domain-neutral-core-grc-first-launch-surfaces)).

> Today, Crosswalker focuses on guided import, flexible note layouts, connected controls, and queryable output. Comprehensive community sharing and long-term framework update workflows are [roadmap direction](https://cybersader.github.io/crosswalker/reference/roadmap/), not shipped features.

## How it works

```
  ┌─ 1. IMPORT ───────────────────────────────────────────┐
  │                                                       │
  │   CSV, XLSX, JSON, and structured framework exports   │
  │   from NIST, ISO, CIS, MITRE, or your own sources.    │
  │                                                       │
  │     ▼                                                 │
  │   Import workspace: choose which columns become       │
  │   folders / headings / tags / wikilinks / properties. │
  │   Save the setup and reuse it with similar files.     │
  └────────────────────────┬──────────────────────────────┘
                           ▼
  ┌─ 2. VAULT ────────────────────────────────────────────┐
  │                                                       │
  │   Ontologies/Frameworks/                              │
  │     NIST 800-53 r5/                                   │
  │       AC/                                             │
  │         AC-2.md  ─── crosswalk ───┐                   │
  │     ISO 27001/                    │ typed link        │
  │       A.9.2.1.md  ◄───────────────┘ + edge metadata   │
  │                                     (predicate,       │
  │   Evidence/                          coverage,        │
  │     MFA-Policy.md ─ covers ──► AC-2, A.9.2.1, …       │
  │                                                       │
  │   Plain markdown · YAML frontmatter · git-friendly    │
  └────────────────────────┬──────────────────────────────┘
                           ▼
  ┌─ 3. USE ──────────────────────────────────────────────┐
  │                                                       │
  │   Bases, Obsidian search, AI agents:                  │
  │                                                       │
  │     "Show all evidence covering AC-2"                 │
  │     "Which ISO controls map to NIST AC family?"       │
  │     "Coverage gaps across our frameworks"             │
  │                                                       │
  └───────────────────────────────────────────────────────┘
```

The same source can land as a deep folder tree, a single document with nested headings, a flat tag-indexed collection, or a hybrid. Pick the shape your team works in. Each note gets YAML properties, WikiLinks for cross-references, and, where configured, typed relationships for crosswalks and evidence.

## Features

| | Feature | Details |
|---|---|---|
| :zap: | **Import workspace** | A dedicated workspace tab walks you from file to review screen; recognized sources get a one-click fast path — NIST CSF 2.0, NIST SP 800-53 Rev 5, CIS Controls v8, MITRE ATT&CK techniques, MITRE Fight Fraud Framework (F3) techniques, CRI Profile 2.2, SCF 2026, and OLIR-style crosswalk files — and everything else goes through guided column mapping or a live shape-mapping workbench (beta) |
| :bar_chart: | **Smart parsing** | CSV, XLSX, and JSON sources — CSV streaming for files over 5 MB, column type auto-detection |
| :file_folder: | **Flexible layouts** | Combine folders, headings, tags, and WikiLinks in one set of import rules. The same source can produce a deep folder tree, a flat tag-indexed collection, or a hybrid |
| :link: | **Typed links** | WikiLinks with metadata for crosswalk relationships and evidence links. Capture not just "AC-2 maps to ISO A.9.2.1" but how, by whom, and how complete |
| :gear: | **Saved setups** | Save, load, and auto-match source-bound setups for similar files |
| :mag: | **Queryable output** | Works with [Obsidian Bases](https://cybersader.github.io/crosswalker/concepts/metadata-ecosystem/) or plain search — plain-text frontmatter means no lock-in |
| :test_tube: | **Debug logging** | Toggle logging to a vault file for troubleshooting |

## Quick start

### Install (manual — community plugins coming soon)

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/cybersader/crosswalker/releases)
2. Create `your-vault/.obsidian/plugins/crosswalker/`
3. Copy the three files in
4. Enable in **Settings > Community plugins**

### Import a framework

1. Open the **Crosswalker workspace tab** (ribbon icon, status bar, or `Ctrl/Cmd + P` > **Crosswalker: Start here: open workspace**)
2. Select your CSV, XLSX, or JSON file — recognized sources offer a one-click fast path
3. Map columns: hierarchy levels, frontmatter properties, links, body
4. Review the destination, shape map, and stats
5. Generate

### What you get

A note like `AC-2.md`:

```yaml
---
curie: "nist-800-53:AC-2"
title: Account Management
aliases:
  - AC-2
tags:
  - framework/nist-800-53/ac
family: AC
family_name: Access Control
control_id: AC-2
parent: "[[AC]]"
_crosswalker:
  spec_version: "https://crosswalker.dev/spec/tier1.schema.json"
  source_ref:
    file: nist-800-53.csv
  produced_at: "2026-07-25T00:00:00.000Z"
  producer:
    kind: plugin-engine
    name: crosswalker
---
```

All configuration (output path, key naming, array handling, link syntax, matching sensitivity) lives in **Settings > Crosswalker**.

## Framework files and recipes

Need a NIST, CIS, MITRE, CRI, or SCF source file? Start with the [framework data sources guide](https://cybersader.github.io/crosswalker/reference/framework-data-sources/) for publisher links, licence cautions, and import gotchas. The [Crosswalker recipes repository](https://github.com/cybersader/crosswalker-recipes) is where contributors can propose recipes for additional structured sources; the recipes shipped with the plugin remain in [`recipes/import/`](https://github.com/cybersader/crosswalker/tree/main/recipes/import).

## Roadmap

Architecture decisions come first, features are built on that foundation. Full roadmap with linked rationale: **[docs/roadmap](https://cybersader.github.io/crosswalker/reference/roadmap/)**

| Phase | Focus | Status |
|---|---|---|
| **v0.1** | Import wizard (CSV/XLSX/JSON), config system, generation engine, fast embedded-SQLite query cache, docs site | 🚧 In progress |
| **v0.2** | Additional starter configurations, tag-based and wikilink-based layouts | Planned |
| **v0.5** | Optional external Python helper for messy spreadsheets and large datasets (desktop only) | Planned |
| **v1.0** | Shareable framework registry, OSCAL export, crosswalk dashboards, framework version tracking | Planned |

## Python tool

The original Python CLI (`frameworks_to_obsidian.py`) is also included for batch-importing cybersecurity frameworks (NIST 800-53, CSF v2, CIS v8, MITRE ATT&CK/D3FEND/ENGAGE, CRI Profile) with crosswalk linking.

```bash
pip install -r requirements.txt
python frameworks_to_obsidian.py
```

## Related projects

Crosswalker fits alongside a few other tools that all aim at making Obsidian a serious knowledge platform:

| Project | Role | Link |
|---|---|---|
| **SEACOW** | Meta-framework for organizing knowledge inside Obsidian — folder + parallel tag hierarchies, naming conventions, and curation patterns. Crosswalker import rules can default to the SEACOW dual-emit pattern (folders for canonical path, tags for cross-cutting facets). | [cybersader/seacowr-knowledge-platform-meta-framework](https://github.com/cybersader/seacowr-knowledge-platform-meta-framework) |
| **folder-tag-sync** | Obsidian plugin that bidirectionally synchronizes folder hierarchy with tag hierarchy via regex rules. Pairs naturally with Crosswalker's dual-output import rules. Crosswalker generates the initial folder + tag layout; folder-tag-sync keeps them in sync as you refactor by hand. | [cybersader/obsidian-folder-tag-sync](https://github.com/cybersader/obsidian-folder-tag-sync) |

## Documentation

**https://cybersader.github.io/crosswalker/** — 100+ pages covering features, GRC use cases, design decisions, reference material, and development logs.

Found an error? Click **Edit page** on any docs page, or see the [contributing guide](https://cybersader.github.io/crosswalker/development/contributing/).

```bash
# Run docs locally
cd docs && bun install && bun run dev
```

## Development

From the repo root, use the **local dev orchestrator** — an interactive menu wrapping every workflow (docs dev, plugin watch, Tailscale/Cloudflare sharing, Playwright tests):

```bash
bun install              # Install plugin dependencies
bun run serve            # Interactive menu (docs dev, plugin watch, etc.)
bun run serve:docs       # Docs dev server on :14321
bun run serve:plugin     # Plugin watch build → test-vault
bun run serve:both       # Both in parallel
```

Or raw commands:

```bash
bun run dev              # Plugin watch mode (outputs to test-vault)
bun run build            # Plugin production build (type-check + bundle)
bun run test             # Plugin unit tests
bun run lint             # Plugin lint (required for community plugin submission)

cd docs && bun run test:local   # Docs Playwright E2E tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions (including the MDX inline-SVG kebab-case gotcha) and the [docs contributing page](https://cybersader.github.io/crosswalker/development/contributing/) for the log / challenge / roadmap / decision lifecycle that new research follows.

## License

MIT — see [LICENSE](LICENSE) for details.
