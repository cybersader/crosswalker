# Roadmap — moved

> **This file is no longer the canonical roadmap.**
>
> The live, authoritative roadmap lives in the docs site:
>
> **`docs/src/content/docs/reference/roadmap/index.mdx`**
>
> Rendered at **https://cybersader.github.io/crosswalker/reference/roadmap/**
>
> There is also a plain-Markdown mirror at the repo root: **`ROADMAP.md`**

## Why this file exists as a pointer

The original `.claude/20-ROADMAP.md` was written in the pre-MVP planning phase ("Phase 0: Foundation — Weeks 1-2") with tasks like "Initialize Obsidian plugin project" and "Create basic plugin scaffold" as checklist items. The project has moved well past that — MVP shipped, 100+ docs pages live, Foundation-phase research is in progress with multiple completed log entries, the registry and challenges systems are operational, and there are named Foundation commitments in the live roadmap.

Rather than try to keep two roadmap documents in sync (or let this one drift into ghost-guidance), agents and contributors are directed to the single source of truth in `docs/`.

## Current roadmap structure

The live roadmap is organized into phases:

- **Foundation** — architectural commitments and open research items (pillars, terminology lockdown, edge semantics, synthetic spine, evidence edge model, progressive tiers, distribution architecture)
- **Import & Generation** — the core import pipeline, parsers, transforms
- **Community** — config registry, OSCAL export, dashboards, spec publication

See the live roadmap page for the full breakdown, each item linked to its rationale log.

## Other `.claude/` files

The rest of `.claude/` (01-PROBLEM.md, 02-ECOSYSTEM.md, 10-VISION-SHORT.md, etc.) is still useful as **historical project knowledge** — the original problem framing, ecosystem survey, early vision documents. When those conflict with current docs-site content, the docs-site wins.

For current state:

| What | Where |
|---|---|
| Roadmap | `docs/src/content/docs/reference/roadmap/index.mdx` |
| Foundation decisions and research | `docs/src/content/docs/agent-context/zz-log/` |
| Open research challenges | `docs/src/content/docs/agent-context/zz-challenges/` |
| Terminology and canonical definitions | `docs/src/content/docs/concepts/terminology.mdx` |
| External orgs, specs, methodologies | `docs/src/content/docs/reference/registry/` |
| Concepts and architecture | `docs/src/content/docs/concepts/` |
