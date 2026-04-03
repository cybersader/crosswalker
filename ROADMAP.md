# Crosswalker Roadmap

## Current (0.1.x) — Stabilizing the MVP

- [x] Import wizard — 4-step flow: file select, column config, preview, generate
- [x] CSV parsing — PapaParse with streaming for large files
- [x] Column type detection — auto-detect hierarchy, ID, text, numeric, date, tags, URL
- [x] Config system — save, load, and auto-match import configurations
- [x] Generation engine — create folders and notes with `_crosswalker` metadata
- [x] Debug logging — toggle-able logging to vault file
- [x] Documentation site — 46-page knowledge base
- [x] Unit tests — Jest + mocked Obsidian API
- [x] CI/CD — GitHub Actions for releases, tests, and docs deployment
- [ ] Bug fixes and UI polish
- [ ] Improve error handling and user feedback

## Near-term — File format support and config sharing

- [ ] **XLSX parser** — Excel file support (`xlsx` package installed, needs integration)
- [ ] **JSON parser** — import from JSON/JSONL files
- [ ] **Config export/import** — share configurations as `.crosswalker.json` files
- [ ] **Improved preview** — expandable folder tree and full note preview in Step 3

## Medium-term — Evidence mapping and cross-framework linking

This is the core value proposition for GRC teams: linking frameworks to each other and to your evidence.

- [ ] **Cross-framework linking** — generate typed WikiLinks between imported frameworks using crosswalk data
- [ ] **Link insertion commands** — "Insert framework link" command with search modal and metadata form
- [ ] **Autocomplete** — suggestions for framework references as you type
- [ ] **Batch re-import** — update existing framework folders with version awareness and diff preview
- [ ] **FrameworkConfig presets** — per-framework configurations with sheet selection, custom transforms, and column overrides

## Long-term — Interoperability and community

- [ ] **OSCAL export** — export to Open Security Controls Assessment Language
- [ ] **Community config templates** — shareable configs for common frameworks
- [ ] **Framework update/sync** — detect upstream framework changes, apply updates
- [ ] **Compliance dashboards** — gap analysis and coverage views using Obsidian Bases
- [ ] **Report generation** — exportable compliance reports for auditors

## Infrastructure

- [ ] E2E testing in CI with wdio-obsidian-service
- [ ] Community plugin submission
- [ ] Automated changelog generation
- [ ] Docs CI tests with Playwright
