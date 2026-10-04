#!/usr/bin/env node
/**
 * Unverified-claims gate.
 *
 * Every sentence in `CHANGELOG.md` `[Unreleased]` or on a living page (any
 * docs page with a `Status last verified` marker) that says something was
 * "not observed", "not verified", "not yet verified", "unverified", "not
 * tested" or "could not test" must carry a tracked link:
 *
 *     ... persistence was not observed in either run (tracked: #follow-ups).
 *     ... (tracked: /crosswalker/reference/roadmap/milestones/v0-1-7-exporters/#status)
 *
 * The link must resolve, using the same resolution as check:links: a
 * `/crosswalker/...` route (and its #anchor) for any file, or a bare `#anchor`
 * on the same file (a CHANGELOG heading such as "### Follow-ups", or a
 * heading or id on the living page).
 *
 * Why this exists (2026-10-03, knowledge-ops gates spec K4): the 2026-09-13
 * CHANGELOG said Tier 2 persistence "was not observed in either run", nothing
 * tracked it, and the index went unpersisted on every host for five months.
 * Writing a gap down must create an obligation someone can find.
 *
 * A "sentence" is the text between the previous and the next period that is
 * followed by whitespace (or the line's start and end). Code spans and fenced
 * blocks are ignored.
 *
 * Usage:
 *   bun run check:unverified-claims [--repo-root <dir>]
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  c,
  parseCommonArgs,
  buildRouteIndex,
  stripCode,
  findMarkers,
  anchorsOf,
  resolveLink,
  printGrouped,
  printSummary,
  rel,
} from './lib/doc-pages.mjs';

export const PHRASES = /not observed|not yet verified|not verified|unverified|not tested|could not test/gi;
const TRACKED = /\(tracked:\s*([^)\s]+)\s*\)/;

const HELP = `check-unverified-claims: an unverified claim must carry a resolving (tracked: <link>).

Usage: node scripts/check-unverified-claims.mjs [--repo-root <dir>] [--help]

Scans CHANGELOG.md [Unreleased] and every living docs page for the phrases
"not observed", "not verified", "not yet verified", "unverified", "not tested",
"could not test". Each sentence containing one needs "(tracked: /crosswalker/...)"
or "(tracked: #anchor)" that resolves. Exit 0 when all are tracked, 1 otherwise.`;

/** The [start, end) bounds of the sentence around `index` on `line`. */
export function sentenceBounds(line, index) {
  let start = 0;
  const before = line.slice(0, index);
  const re = /\.\s/g;
  let m;
  while ((m = re.exec(before)) !== null) start = m.index + 1;
  const after = /\.(\s|$)/.exec(line.slice(index));
  let end = after ? index + after.index + 1 : line.length;
  // A tracked tag written just after the full stop still belongs to it.
  const trailing = /^\s*\(tracked:[^)]*\)/.exec(line.slice(end));
  if (trailing) end += trailing[0].length;
  return [start, end];
}

/** The lines of the `[Unreleased]` section, with their 1-based numbers. */
export function unreleasedLines(source) {
  const lines = source.split('\n');
  const out = [];
  let inside = false;
  lines.forEach((line, i) => {
    if (/^##\s/.test(line)) inside = /^##\s+\[Unreleased\]/i.test(line);
    if (inside) out.push({ n: i + 1, text: line });
  });
  return out;
}

async function main() {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  const repoRoot = args.repoRoot;
  const index = await buildRouteIndex(repoRoot);
  console.log(`\n  ${c.bold}Unverified claims are tracked${c.reset} ${c.dim}CHANGELOG [Unreleased] + living pages${c.reset}\n`);

  const errors = [];
  let claims = 0;
  let scanned = 0;

  /**
   * Check one file. `lines` are {n, text} with code already stripped;
   * `resolveSelf` resolves a bare #anchor for this file.
   */
  const check = async (file, lines, resolveSelf) => {
    scanned += 1;
    for (const { n, text } of lines) {
      const seen = new Set();
      PHRASES.lastIndex = 0;
      let m;
      while ((m = PHRASES.exec(text)) !== null) {
        const [start, end] = sentenceBounds(text, m.index);
        if (seen.has(start)) continue;
        seen.add(start);
        claims += 1;
        const sentence = text.slice(start, end).trim();
        const tracked = TRACKED.exec(sentence);
        const excerpt = sentence.length > 110 ? `${sentence.slice(0, 107)}...` : sentence;
        if (!tracked) {
          errors.push({ file: rel(repoRoot, file), line: n, text: `untracked "${m[0]}": ${excerpt}` });
          continue;
        }
        const target = tracked[1];
        let ok;
        if (target.startsWith('#')) ok = await resolveSelf(target);
        else if (/^(https:\/\/cybersader\.github\.io)?\/crosswalker\//.test(target)) ok = (await resolveLink(index, target)) === null;
        else ok = false;
        if (!ok) {
          errors.push({ file: rel(repoRoot, file), line: n, text: `tracked link does not resolve: ${target}` });
        }
      }
    }
  };

  // CHANGELOG [Unreleased]: GitHub renders it, and GitHub's heading slugs
  // follow the same github-slugger rules as the docs site.
  const changelogPath = resolve(repoRoot, 'CHANGELOG.md');
  let changelog = null;
  try {
    changelog = await readFile(changelogPath, 'utf8');
  } catch {
    /* no changelog in this tree */
  }
  if (changelog !== null) {
    const stripped = stripCode(changelog);
    const lines = unreleasedLines(changelog).map(({ n }) => ({ n, text: stripped[n - 1] }));
    const anchors = anchorsOf(changelog);
    await check(changelogPath, lines, async (frag) => anchors.has(decodeURIComponent(frag.slice(1))));
  }

  for (const file of index.pages) {
    const source = await readFile(file, 'utf8');
    if (findMarkers(source).length === 0) continue;
    const lines = stripCode(source).map((text, i) => ({ n: i + 1, text }));
    await check(file, lines, async (frag) => (await resolveLink(index, frag, file)) === null);
  }

  printGrouped('Untracked or unresolvable unverified claims:', errors);
  if (errors.length > 0) {
    console.log(
      `  ${c.dim}Add "(tracked: #anchor)" or "(tracked: /crosswalker/...)" inside the sentence,\n`
      + `  pointing at the follow-up that owns closing the gap (CHANGELOG "Follow-ups",\n`
      + `  a milestone task, or a challenge brief). If the claim has since been verified,\n`
      + `  say so and drop the phrase.${c.reset}\n`,
    );
  }
  printSummary(claims - errors.length, errors.length, `${claims} unverified-claim sentences in ${scanned} files`);
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n  ${c.red}Fatal:${c.reset} ${err.message}\n`);
  process.exit(1);
});
