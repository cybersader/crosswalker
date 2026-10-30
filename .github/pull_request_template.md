<!--
  Crosswalker PR template
  Mirror of the "Documentation update reminders" section in root CLAUDE.md so human contributors
  see the same checklist that agents see. This template intentionally has zero CI-side logic;
  mechanical checks live in CI gates (lint, MDX build, schema validation, fixture drift).
-->

## What changed

<!-- Brief summary of the changes in this PR. -->

## Documentation update checklist

When you touched certain paths, also update related docs / state. Tick what applies:

- [ ] **Touched `spec/*.schema.json`** → updated `docs/.../v0-1-schema-spec.mdx`; bumped `$id` major version if breaking; regenerated fixtures (`bun run fixtures`)
- [ ] **Touched `tools/generate-fixtures.ts` or `tools/fixtures/synthetic/*.csv`** → ran `bun run fixtures`; generated markdown still validates against `spec/tier1.schema.json`
- [ ] **Touched `src/render/**`** → round-trip determinism test passes (milestone v0.1.2 success criteria)
- [ ] **Touched `src/generation/generation-engine.ts`** → re-import safety test passes (managed/user_preserve frontmatter merge)
- [ ] **Updated `ROADMAP.md`** → mirrored to `docs/src/content/docs/reference/roadmap/index.mdx`
- [ ] **Updated `docs/.../reference/roadmap/index.mdx`** → mirrored to root `ROADMAP.md`
- [ ] **Touched a `roadmap/milestones/v0-1-N-*.mdx` page** → flipped status in `milestones/index.mdx` status table
- [ ] **Resolved a research challenge** → archived brief to `zz-challenges/archive/` with resolution callout; wrote synthesis log to `zz-log/`; updated `zz-research/index.md`; updated design log §6 + §8
- [ ] **New architectural commitment** → memory file added; `CHANGELOG.md` `[Unreleased]` entry; design log updated
- [ ] **Touched `package.json` scripts** → documented in `docs/.../development/setup.mdx` build-commands table
- [ ] **New `.claude/skills/*`** → has YAML frontmatter; referenced in `.claude/CLAUDE.md` skills list
- [ ] **Created a `concepts/*.mdx` pillar** → cross-linked from related pages; added to relevant indexes

## Tests + checks run

- [ ] `bun run lint` (when `src/**` changed)
- [ ] `bun run test` (when `src/**` or `tests/**` changed)
- [ ] `cd docs && bun run build` (when `docs/**` changed)
- [ ] `bun run fixtures` (when `tools/fixtures/synthetic/**` changed)
- [ ] All seven Static Checks gates (source: `.github/workflows/static-checks.yml`): `check:personal-data`, `check:mdx`, `check:frontmatter`, `check:not-content`, `check:log-labels`, `check:links`, `check:parity`
- [ ] New UI or CLI outcomes recorded in `tools/parity/capabilities.ts`, with a tracked gap when a side is missing; ran `bun run parity:write`

<!--
  CI handles mechanical gates (lint, MDX build, schema validation, fixture drift) separately.
  This checklist captures judgment-required cross-doc updates that CI can't detect.
-->

## Notes / context

<!-- Any context reviewers should know — design tradeoffs, follow-up work, links to related decisions. -->
