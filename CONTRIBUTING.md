# Contributing to Crosswalker

Welcome! Crosswalker is an Obsidian plugin that turns your vault into an operational compliance knowledge graph — and philosophically, an ontology lifecycle management engine. The project lives across three surfaces:

- **Plugin** (TypeScript / Bun, this repo root) — the Obsidian plugin itself
- **Docs site** (`docs/`, Astro Starlight) — concepts, architecture, research logs, terminology, registry, roadmap
- **Python CLI** (`frameworks_to_obsidian.py`) — the original batch importer, still shipped as a secondary tool

The **authoritative current-state reference is the [docs site](https://cybersader.github.io/crosswalker/)**, not this file. If anything here contradicts the docs, the docs win.

## Where to start

- **First time on this repo?** Read the [vision](https://cybersader.github.io/crosswalker/agent-context/vision/), [the problem](https://cybersader.github.io/crosswalker/concepts/problem/), and [what makes Crosswalker unique](https://cybersader.github.io/crosswalker/concepts/what-makes-crosswalker-unique/) before touching code
- **Building features?** Read the [roadmap](https://cybersader.github.io/crosswalker/reference/roadmap/) for Foundation-phase commitments and active research items
- **Writing docs?** See the [contributing to docs](https://cybersader.github.io/crosswalker/development/contributing/) page for the docs-site-specific conventions
- **Running tests?** See the [testing page](https://cybersader.github.io/crosswalker/development/testing/) for the three test surfaces (plugin Jest, plugin WebdriverIO E2E, docs Playwright)

## Prerequisites

- [Bun](https://bun.sh/) — primary package manager and runtime
- [Node.js](https://nodejs.org/) 18+ (used by some sub-tools)
- [Obsidian](https://obsidian.md/) — for plugin testing
- [Git](https://git-scm.com/) — with the working tree on `main`

## Local development

```bash
git clone https://github.com/cybersader/crosswalker.git
cd crosswalker
bun install
```

From the repo root, use the **local dev orchestrator** — an interactive menu that wraps every workflow (docs dev, plugin watch, Tailscale/Cloudflare sharing, Playwright tests):

```bash
bun run serve            # Interactive menu (8 options)
bun run serve:docs       # Docs dev server (Astro HMR) → http://localhost:4321
bun run serve:plugin     # Plugin watch build → test-vault
bun run serve:both       # Docs + plugin watch in parallel
bun run serve:share      # Docs dev + Tailscale tunnel (tailnet only)
```

The orchestrator auto-heals cross-OS `node_modules` contamination (e.g. rollup native binaries when bouncing between WSL and Windows) and auto-installs `docs/node_modules` on first run. Raw commands still work:

```bash
bun run dev              # Plugin watch build, outputs to test-vault
bun run build            # Plugin production build (type-check + bundle)
bun run test             # Plugin Jest unit tests
bun run lint             # ESLint with eslint-plugin-obsidianmd
bun run lint:fix         # Auto-fix lint issues
```

## The three test surfaces

Before opening a PR, run the test suites relevant to your change:

```bash
# Plugin unit tests (always)
bun run test

# Plugin lint (required for community plugin submission)
bun run lint

# Docs E2E tests (if you touched docs/ or added visual content)
cd docs && bun run test:local
# or via the orchestrator:
bun run serve         # → option 8
```

See [the testing page](https://cybersader.github.io/crosswalker/development/testing/) for the full breakdown.

## Making a change

1. **Fork the repo** on GitHub
2. **Clone your fork** and set up the local environment above
3. **Create a feature branch**: `git checkout -b feature/your-feature-name`
4. **Make your changes**
5. **Run the relevant test surfaces** (at minimum `bun run test` + `bun run lint` for plugin changes)
6. **Commit** with a descriptive message focused on the "why"
7. **Push** and **open a pull request** against `main`

### Commit message style

Match the project convention from recent commits. First line is a short summary. Body explains the why and non-obvious context. Example:

```
Add local dev orchestrator (bun run serve) + testing docs

scripts/serve.mjs wraps every local workflow in an interactive menu.
Handles cross-OS node_modules contamination automatically. CLAUDE.md
testing section rewritten to cover three test surfaces.
```

**Do not include AI attribution** (`Co-Authored-By: Claude ...` or similar). Commit as the human contributor only — this is a hard rule per the project's `CLAUDE.md`.

## Code style

### Plugin TypeScript

- Strict types. Prefer explicit over inferred where it documents intent
- ESLint with `eslint-plugin-obsidianmd` — required for community plugin submission
- **Sentence case** for all user-facing UI text — e.g. "Add new rule" not "Add New Rule"
- Use `Setting.setHeading()` instead of `createEl('h3')` for settings section headings
- Don't include the plugin name in settings headings (Obsidian provides it)

### Docs (`.mdx`)

- One H1 per page (provided by the frontmatter `title`; don't add another)
- `date: YYYY-MM-DD` in frontmatter for log entries, challenges, registry entries, and any page where creation date matters — the `PageTitle` override displays a `CREATED` label from this field. Log files parse the date from their `YYYY-MM-DD-*` filename prefix by convention
- Use kebab-case tag names from `docs/tags.yml` — unknown tags are rejected by `starlight-tags`
- Link liberally to terminology, concepts, other logs, and roadmap items — cross-linking is a project convention, not optional
- Every log page should have a `## Related` section at the bottom

### MDX silent-breakage gotchas — two rules you will hit if you write diagrams

Both of these bite agents and humans alike. Both produce cryptic errors (or worse, a page that visually looks wrong with no error at all). Internalize the rules before writing any inline SVG or HTML in an `.mdx` file.

#### Rule 1: Inline SVG attributes — kebab-case only

MDX parses inline `<svg>` subtrees in HTML mode, not JSX mode. The HTML5 parser silently lowercases all attribute names except a small whitelist (`viewBox`, `preserveAspectRatio`, `baseProfile`). So `strokeWidth="2"` becomes `strokewidth="2"` — an invalid SVG attribute that browsers ignore, leaving your diagram with default 1px strokes, broken text alignment, and **no error message anywhere**.

```mdx
{/* Correct: */}
<circle cx="30" cy="50" r="32" stroke-width="2" />
<text font-size="11" text-anchor="middle" font-weight="600">Label</text>
<line stroke-dasharray="4 3" />

{/* Wrong — silently broken at render time, no error: */}
<circle cx="30" cy="50" r="32" strokeWidth="2" />
<text fontSize="11" textAnchor="middle" fontWeight="600">Label</text>
<line strokeDasharray="4 3" />
```

Exceptions that **do** preserve case (HTML whitelist): `viewBox`, `preserveAspectRatio`, `baseProfile`, `attributeName`, `xlink:href`. Everything else: kebab-case.

CSS properties inside `style={{...}}` JSX object props **should** use camelCase — those are JavaScript object keys, not HTML attributes. `style={{fontSize: '11px'}}` is correct in that context.

#### Rule 2: Curly braces inside HTML tags — escape with HTML entities

MDX parses `{...}` inside JSX context (including inside HTML elements like `<td>`, `<code>`, `<span>`) as a JSX expression. If you write a code example containing literal braces — say, a YAML example or a TypeScript object literal — the parser tries to evaluate them as JavaScript and crashes at build time with a loud but confusing error:

```
MDXError: Could not parse expression with acorn
Unexpected content after expression
```

```mdx
{/* Wrong — parser tries to evaluate `{status: covered}` as a JS expression: */}
<td><code>[[AC-2]] {status: covered}</code></td>
<td><code>implements: [{target, status, reviewer}]</code></td>

{/* Correct — escape curly braces with HTML entities: */}
<td><code>[[AC-2]] &#123;status: covered&#125;</code></td>
<td><code>implements: [&#123;target, status, reviewer&#125;]</code></td>
```

**Braces inside markdown backticks are safe** — MDX protects inline code from JSX parsing. Only braces inside HTML element content (`<code>...</code>`, `<td>...</td>`, etc.) need escaping. Rule of thumb: if the braces are inside an HTML tag, use `&#123;` / `&#125;`.

For comparison operators like `<` and `>` inside HTML `<code>` blocks (e.g., a Bases formula), use `&lt;` / `&gt;`.

#### The validation loop — `bun run check:mdx`

A lightweight MDX syntax checker lives at `scripts/check-mdx.mjs` that parses every `.mdx` file under `docs/src/content/docs/` using `@mdx-js/mdx` directly — no Astro, no Starlight, no build. Runs in ~2 seconds on ~100 files.

```bash
bun run check:mdx                          # Check everything
bun run check:mdx path/to/file.mdx         # Check one file
bun run serve                              # → option 9
```

**Run this after any MDX edit before committing.** It catches Rule 2 (curly brace parse errors) reliably. It does NOT catch Rule 1 (SVG attribute lowercasing) — that's HTML parsing that happens later in the pipeline, not at MDX parse time. For Rule 1 you still need to mentally review inline SVG attributes or run the full dev server.

## Writing conventions — the log / challenge / roadmap / decision lifecycle

The docs site follows a specific lifecycle for new research, decisions, and design work:

1. **Log** (`docs/src/content/docs/agent-context/zz-log/YYYY-MM-DD-topic-slug.mdx`) — dated notes, research synthesis, working ideas, decision records. Write these freely; they're chronological and permanent. Every significant architectural decision gets a log entry with rationale
2. **Challenge** (`docs/src/content/docs/agent-context/zz-challenges/NN-topic-slug.mdx`) — fresh-agent research briefs. When you want an independent perspective on an architectural assumption, write a challenge brief and hand it to a new agent with no prior context. Findings flow back as dated log entries, not edits to the challenge itself
3. **Roadmap** (`docs/src/content/docs/reference/roadmap/index.mdx`) — roadmap items point at the log entries and challenges they depend on. Every significant roadmap item should have a log link for rationale
4. **Concept page** (`docs/src/content/docs/concepts/*.mdx`) — once a decision crystallizes, the stable version lives as a concept page. Concept pages are "here's how it is now," not "here's how we got here"
5. **Terminology** (`docs/src/content/docs/concepts/terminology.mdx`) — new terms get entries with aliases in the term column. Alias every concept with multiple common names so readers searching any term land on the canonical entry
6. **Registry** (`docs/src/content/docs/reference/registry/*.mdx`) — canonical facts about external orgs, standards, methodologies, and publications (NIST, SCF, SKOS, SSSOM, STRM, etc.) that the KB cites in multiple places. Each entry is a compact reference card (~40 lines). See existing entries for format

## Adding a new parser

To add support for a new file format in the plugin:

1. Create `src/import/parsers/<format>-parser.ts`
2. Export a `parse<Format>(content, options)` function returning `ParsedData`
3. Add the format to the file picker in `import-wizard.ts`
4. Add unit tests in `tests/<format>-parser.test.ts`
5. Update the docs page `docs/src/content/docs/features/import-wizard.mdx` to mention the new format

## Reporting issues

File issues at [github.com/cybersader/crosswalker/issues](https://github.com/cybersader/crosswalker/issues) with:

- Clear title and description
- Steps to reproduce
- Expected vs. actual behavior
- Sample data if relevant (anonymized if sensitive)
- Obsidian version and OS

## License

By contributing, you agree that your contributions are licensed under the project's [MIT license](LICENSE).
