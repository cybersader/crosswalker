#!/usr/bin/env node
/**
 * Internal documentation link checker.
 *
 * Every page under docs/src/content/docs/ is routed by its file path, so an
 * internal link is resolvable purely from the filesystem — no build, no
 * browser, no network. This gate resolves each one and fails on the misses.
 *
 * Why this exists: on 2026-08-28 a sweep found 68 files' worth of links
 * pointing at challenge briefs that had been archived out from under them,
 * across eighteen briefs and months of archiving. Starlight does not validate
 * internal links, and Astro will happily build and deploy a page full of
 * them, so every one was a silent 404 for anyone who followed it. Nothing in
 * CI could see it: the site built green the entire time.
 *
 * This is deliberately a MECHANICAL check in the sense of the repo's
 * detection-profile rule (root CLAUDE.md § "Why this lives here"): a link
 * either resolves to a file or it does not. It does not judge whether a link
 * is a GOOD link.
 *
 * Anchors (added 2026-10-03, ruling K11 of the knowledge-ops gates spec): a
 * link with a `#fragment` must match a heading slug or an explicit `id` on the
 * target page. Two heading renames had broken anchors this gate could not
 * see, and a third was already dead. Slugs follow github-slugger, which
 * Starlight uses: lowercase, punctuation dropped, spaces to hyphens.
 *
 * What it checks:
 *   - Markdown links            [text](/crosswalker/...)
 *   - Reference definitions     [ref]: /crosswalker/...
 *   - Inline HTML hrefs         href="/crosswalker/..."   (the docs use
 *                               hand-written HTML/SVG diagrams extensively)
 *   - Both internal spellings: root-absolute `/crosswalker/...` and
 *     site-absolute `https://cybersader.github.io/crosswalker/...`
 *
 * What it skips:
 *   - Fenced and inline code (a link inside an example is not a link)
 *   - External URLs (no network calls — this gate stays offline and fast)
 *   - Query strings (stripped before resolution)
 *   - Anchors on generated routes and public assets (no page source to read)
 *
 * Usage:
 *   bun run check:links [--repo-root <dir>]
 *
 * Pass: every internal link resolves to a page file or a public asset.
 * Fail: one or more do not (missing page or missing anchor), reported as
 *       file:line with the offending target.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  c,
  parseCommonArgs,
  buildRouteIndex,
  stripCode,
  extractLinks,
  resolveLink,
  printGrouped,
  printSummary,
  rel,
} from './lib/doc-pages.mjs';

/**
 * Repo-root files that link INTO the docs site and are read by people or
 * agents who cannot see a 404 coming. README is the public front door on
 * GitHub; the CLAUDE.md pair is the first thing an agent reads and routes
 * nearly all of its knowledge-base navigation through site URLs. A rotted
 * link here misdirects exactly the reader with the least context.
 *
 * These are scanned for the site-absolute spelling only, since a root-relative
 * `/crosswalker/...` path is meaningless in a file rendered on GitHub; their
 * own same-page `#anchors` follow GitHub rules and are not checked here.
 */
const ROOT_FILES = ['README.md', 'ROADMAP.md', 'CLAUDE.md', '.claude/CLAUDE.md', 'CHANGELOG.md'];

const HELP = `check-links: every internal docs link resolves to a page, and every #anchor to a heading or id.

Usage: node scripts/check-links.mjs [--repo-root <dir>] [--help]

Scans docs/src/content/docs/**/*.md(x) plus ${ROOT_FILES.join(', ')}.
Exit 0 when every internal link resolves, 1 otherwise.`;

async function main() {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  const repoRoot = args.repoRoot;
  const index = await buildRouteIndex(repoRoot);
  console.log(`\n  ${c.bold}Internal doc links${c.reset} ${c.dim}${rel(repoRoot, index.docsRoot)}${c.reset}\n`);

  const errors = [];
  let checked = 0;

  const scan = async (file, isPage) => {
    let source;
    try {
      source = await readFile(file, 'utf8');
    } catch {
      return; // an optional root file that does not exist is not a failure
    }
    const lines = stripCode(source);
    for (const { target, line } of extractLinks(lines)) {
      const t = target.trim();
      const samePage = t.startsWith('#') && t.length > 1;
      if (samePage && !isPage) continue;
      if (!samePage && !t.includes('/crosswalker')) continue;
      const verdict = await resolveLink(index, t, isPage ? file : null);
      if (verdict === null && !samePage && !/^(https:\/\/cybersader\.github\.io)?\/crosswalker/.test(t)) continue;
      checked += 1;
      if (verdict !== null) {
        errors.push({
          file: rel(repoRoot, file),
          line,
          text: verdict === 'anchor' ? `${t}  (no such heading or id on the target page)` : t,
        });
      }
    }
  };

  for (const file of index.pages) await scan(file, true);
  for (const rootFile of ROOT_FILES) await scan(resolve(repoRoot, rootFile), false);

  if (errors.length > 0) {
    printGrouped('Broken internal links:', errors);
    console.log(
      `  ${c.dim}A link resolves when a page file exists at that path and, for a #fragment,\n`
      + `  when the target page has a heading with that slug or an element with that id.\n`
      + `  If the target moved (archived briefs are the usual cause) or a heading was\n`
      + `  renamed, update the link; if it never existed, the link is a typo.${c.reset}\n`,
    );
  }

  printSummary(
    checked - errors.length,
    errors.length,
    `${checked} internal links across ${index.pages.length} pages + ${ROOT_FILES.length} root files`,
  );
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n  ${c.red}Fatal:${c.reset} ${err.message}\n`);
  process.exit(1);
});
