#!/usr/bin/env node
/**
 * Living-page freshness gate.
 *
 * A living page describes CURRENT behavior and carries one line under its
 * intro: `**Status last verified:** YYYY-MM-DD — verified against <source>`.
 * The marker is the only registry: any docs page with one is a living page.
 *
 * Why this exists (2026-10-03, knowledge-ops gates spec K1 to K3): the roadmap
 * carried a fresh marker while its body was April and May prose, because the
 * convention allowed a SCOPED bump ("v0.1.7 row only") that every reader took
 * for a page-level verification. A marker is read as a whole-page claim, so it
 * must be one, and an old one must stop the build instead of flagging politely.
 *
 * Fails (exit 1):
 *   - K1 malformed: a line that starts a marker but is not the canonical
 *     `**Status last verified:** YYYY-MM-DD` shape
 *   - K1 more than one marker on a page (two markers are two contradictory
 *     page-level claims)
 *   - K1 scoped: the marker text, up to end of line, contains "only", "row",
 *     "cell", "scoped", "paragraph", or more than one "Earlier". Scoped
 *     re-checks go in a note BELOW the marker, never in it
 *   - K2 stale: the marker date is more than 30 days before today. The fix is
 *     a real re-verification and a bump, or demoting the page to a dated log
 *
 * Warns (exit unaffected):
 *   - K3 date drift: more than 70% of the page's YYYY-MM-DD mentions are older
 *     than 90 days (pages with fewer than 5 mentions are not judged). A hint
 *     that the body may be older than the marker claims, not a verdict
 *
 * Usage:
 *   bun run check:freshness [--today YYYY-MM-DD] [--repo-root <dir>]
 */

import { readFile } from 'node:fs/promises';
import {
  c,
  parseCommonArgs,
  todayDate,
  daysBetween,
  listPages,
  stripFences,
  findMarkers,
  MARKER_RE,
  printGrouped,
  printSummary,
  rel,
} from './lib/doc-pages.mjs';

export const MAX_AGE_DAYS = 30;
const DRIFT_AGE_DAYS = 90;
const DRIFT_RATIO = 0.7;
const DRIFT_MIN_MENTIONS = 5;
const SCOPE_WORDS = /\bonly\b|\brow\b|\bcell\b|\bscoped\b|paragraph/i;

const HELP = `check-freshness: every living page (one with a "Status last verified" marker) carries
one unscoped, well-formed marker no older than ${MAX_AGE_DAYS} days.

Usage: node scripts/check-freshness.mjs [--today YYYY-MM-DD] [--repo-root <dir>] [--help]

Fails on: malformed marker, more than one marker, scope words in the marker
(only, row, cell, scoped, paragraph, or two or more "Earlier"), marker older
than ${MAX_AGE_DAYS} days. Warns when over ${DRIFT_RATIO * 100}% of a page's dates are older than
${DRIFT_AGE_DAYS} days. Exit 0 when nothing fails, 1 otherwise.`;

async function main() {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  const today = todayDate(args.today);
  const repoRoot = args.repoRoot;
  console.log(`\n  ${c.bold}Living-page freshness${c.reset} ${c.dim}as of ${today.toISOString().slice(0, 10)}${c.reset}\n`);

  const errors = [];
  const warnings = [];
  let living = 0;

  for (const file of await listPages(repoRoot)) {
    const source = await readFile(file, 'utf8');
    const markers = findMarkers(source);
    if (markers.length === 0) continue;
    living += 1;
    const where = rel(repoRoot, file);


    if (markers.length > 1) {
      errors.push({
        file: where,
        line: markers[1].line,
        text: `${markers.length} markers on one page (lines ${markers.map((m) => m.line).join(', ')}); keep one page-level marker`,
      });
    }
    for (const marker of markers) {
      const m = MARKER_RE.exec(marker.text);
      if (!m) {
        errors.push({ file: where, line: marker.line, text: 'malformed marker; use **Status last verified:** YYYY-MM-DD' });
        continue;
      }
      const markerText = marker.text.slice(m.index);
      const scope = SCOPE_WORDS.exec(markerText);
      if (scope) {
        errors.push({ file: where, line: marker.line, text: `scoped marker ("${scope[0]}"); a marker asserts the whole page, put scoped re-checks in a note below it` });
      }
      const earlier = markerText.match(/\bearlier\b/gi) ?? [];
      if (earlier.length >= 2) {
        errors.push({ file: where, line: marker.line, text: `marker carries an "Earlier" chain (${earlier.length}); move history below the marker` });
      }
      const age = daysBetween(m[1], today);
      if (age > MAX_AGE_DAYS) {
        errors.push({ file: where, line: marker.line, text: `marker ${m[1]} is ${age} days old (limit ${MAX_AGE_DAYS}); re-verify and bump, or demote the page to a dated log` });
      }
    }

    // K3: date drift across the whole page body.
    const dates = [];
    for (const line of stripFences(source)) {
      for (const d of line.matchAll(/\b(20\d\d-[01]\d-[0-3]\d)\b/g)) dates.push(d[1]);
    }
    if (dates.length >= DRIFT_MIN_MENTIONS) {
      const old = dates.filter((d) => daysBetween(d, today) > DRIFT_AGE_DAYS).length;
      const ratio = old / dates.length;
      if (ratio > DRIFT_RATIO) {
        warnings.push({
          file: where,
          line: 0,
          text: `${old}/${dates.length} dates (${Math.round(ratio * 100)}%) are older than ${DRIFT_AGE_DAYS} days; is the body as fresh as the marker?`,
        });
      }
    }
  }

  printGrouped('Freshness failures:', errors);
  printGrouped('Date drift (warning only):', warnings, c.yellow, '!');
  if (errors.length > 0) {
    console.log(
      `  ${c.dim}A marker is a page-level claim: re-verify the page against its source of truth\n`
      + `  and bump it, or demote the page to a dated zz-log entry. Scoped re-checks go in\n`
      + `  a note below the marker ("2026-10-03: v0.1.7 row re-checked").${c.reset}\n`,
    );
  }
  const failedPages = new Set(errors.map((e) => e.file)).size;
  printSummary(living - failedPages, errors.length, `${living} living pages`, warnings.length);
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n  ${c.red}Fatal:${c.reset} ${err.message}\n`);
  process.exit(1);
});
