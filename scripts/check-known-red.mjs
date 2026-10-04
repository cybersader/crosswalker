#!/usr/bin/env node
/**
 * Red-ledger gate for the nightly end-to-end run.
 *
 * Reads the JSON results the nightly wdio run writes (one file per spec, from
 * tests/e2e/helpers/json-results-reporter.ts) and compares every failed case
 * against tests/e2e/KNOWN_RED.md, the list of cases allowed to be red.
 *
 * Fails (exit 1) when:
 *   - a case is red and not in the ledger (a new red has no owner)
 *   - a ledger entry of kind `red` passed (the entry is stale: delete it)
 *   - a ledger entry is older than 30 days (fix it, or re-date it with a new
 *     reason; a red is a dated obligation, not a permanent exemption)
 *   - a ledger entry has no tracked link, or its link does not resolve
 *   - the results directories hold no results at all (silence is not success)
 *
 * tests/e2e/QUARANTINE.md is read too: each quarantined spec is a whole-spec
 * entry of kind `red`, dated by its "Date added" column and named by its
 * "Verdict", under the same rules (any red case in it is covered; it is stale
 * when every case in it passed; it expires after 30 days). KNOWN_RED.md lists
 * individual cases; QUARANTINE.md lists whole specs.
 *
 * A ledger entry of kind `flaky` tolerates both green and red: it is for a case
 * that passes alone and fails only in some runs. It still expires after 30 days.
 * A listed case that did not run is reported as a warning.
 *
 * Why this exists (2026-10-03, knowledge-ops gates spec K6): CI ran only the
 * smoke spec, so a spec that was red on main for ten days had no owner and
 * nobody saw it.
 *
 * Usage:
 *   node scripts/check-known-red.mjs <results-dir> [<results-dir> ...]
 *     [--ledger tests/e2e/KNOWN_RED.md] [--today YYYY-MM-DD]
 */

import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { c, parseCommonArgs, todayDate, daysBetween, anchorsOf, printGrouped, printSummary } from './lib/doc-pages.mjs';

export const MAX_AGE_DAYS = 30;

const HELP = `check-known-red: every red e2e case is listed in tests/e2e/KNOWN_RED.md, and every listed case is still red.

Usage: node scripts/check-known-red.mjs <results-dir> [<results-dir> ...] [--ledger <path>] [--today YYYY-MM-DD] [--help]

Results are the JSON files written when CW_E2E_RESULTS_DIR is set for a wdio run.
Ledger kinds: "red" (must stay red) and "flaky" (may be either). Entries expire
after ${MAX_AGE_DAYS} days. Exit 0 when the run matches the ledger, 1 otherwise.`;

/**
 * Parse the ledger table. Columns, in order: Spec | Case | Kind | Since |
 * Reason | Tracked. Backticks and surrounding quotes are stripped from Spec
 * and Case; Tracked keeps its Markdown link.
 */
export function parseLedger(source) {
  const entries = [];
  let header = null;
  source.split('\n').forEach((line, i) => {
    if (!/^\s*\|/.test(line)) {
      header = null;
      return;
    }
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
    if (!header) {
      header = cells.map((h) => h.toLowerCase());
      return;
    }
    if (cells.every((x) => /^:?-+:?$/.test(x))) return;
    const get = (name) => cells[header.indexOf(name)] ?? '';
    const unquote = (s) => s.replace(/^`|`$/g, '').replace(/^"|"$/g, '');
    entries.push({
      line: i + 1,
      spec: basename(unquote(get('spec'))),
      title: unquote(get('case')),
      kind: get('kind').toLowerCase(),
      since: get('since'),
      reason: get('reason'),
      tracked: get('tracked'),
    });
  });
  return entries;
}

/**
 * Whole-spec entries from QUARANTINE.md: columns Spec | Verdict | ... | Date
 * added | ... . Each becomes {spec, title: null, kind: 'red', since, reason}.
 */
export function parseQuarantine(source) {
  return parseTable(source).map(({ line, get }) => ({
    line,
    spec: basename(get('spec').replace(/^`|`$/g, '')),
    title: null,
    kind: 'red',
    since: get('date added'),
    reason: get('verdict'),
    tracked: null,
  }));
}

function parseTable(source) {
  const rows = [];
  let header = null;
  source.split('\n').forEach((line, i) => {
    if (!/^\s*\|/.test(line)) {
      header = null;
      return;
    }
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => x.trim());
    if (!header) {
      header = cells.map((h) => h.toLowerCase());
      return;
    }
    if (cells.every((x) => /^:?-+:?$/.test(x))) return;
    const cols = header;
    rows.push({ line: i + 1, get: (name) => cells[cols.indexOf(name)] ?? "" });
  });
  return rows;
}

async function linkResolves(ledgerPath, tracked) {
  const m = /\]\(([^)\s]+)\)/.exec(tracked);
  if (!m) return false;
  const [file, frag] = m[1].split('#');
  const target = resolve(dirname(ledgerPath), file);
  let source;
  try {
    source = await readFile(target, 'utf8');
  } catch {
    return false;
  }
  return !frag || anchorsOf(source).has(decodeURIComponent(frag));
}

async function main() {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  let ledgerPath = resolve(args.repoRoot, 'tests/e2e/KNOWN_RED.md');
  let quarantinePath = resolve(args.repoRoot, 'tests/e2e/QUARANTINE.md');
  const dirs = [];
  for (let i = 0; i < args.rest.length; i += 1) {
    if (args.rest[i] === '--ledger') ledgerPath = resolve(args.rest[++i]);
    else if (args.rest[i] === '--quarantine') quarantinePath = resolve(args.rest[++i]);
    else dirs.push(resolve(args.rest[i]));
  }
  if (dirs.length === 0) {
    console.error(HELP);
    process.exit(1);
  }
  const today = todayDate(args.today);
  console.log(`\n  ${c.bold}E2E red ledger${c.reset} ${c.dim}${basename(ledgerPath)} vs ${dirs.length} results dir(s)${c.reset}\n`);

  const ledger = parseLedger(await readFile(ledgerPath, 'utf8')).map((e) => ({ ...e, file: 'tests/e2e/KNOWN_RED.md' }));
  let quarantineSource = '';
  try {
    quarantineSource = await readFile(quarantinePath, 'utf8');
  } catch {
    /* no quarantine file: nothing quarantined */
  }
  const quarantined = parseQuarantine(quarantineSource).map((e) => ({ ...e, file: 'tests/e2e/QUARANTINE.md' }));
  const results = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
    } catch {
      /* missing dir counts as no results */
    }
    for (const n of names) {
      const r = JSON.parse(await readFile(resolve(dir, n), 'utf8'));
      for (const t of r.tests ?? []) results.push({ spec: basename(r.spec ?? ''), title: t.title, state: t.state });
    }
  }

  const errors = [];
  const warnings = [];
  if (results.length === 0) {
    errors.push({ file: dirs.join(', '), line: 0, text: 'no results found; the run produced nothing to check' });
  }
  const key = (spec, title) => `${spec}\u0000${title}`;
  const listed = new Map(ledger.map((e) => [key(e.spec, e.title), e]));

  for (const r of results) {
    if (r.state !== 'failed') continue;
    if (!listed.has(key(r.spec, r.title)) && !quarantined.some((q) => q.spec === r.spec)) {
      errors.push({ file: r.spec, line: 0, text: `red and not in the ledger: "${r.title}"` });
    }
  }
  for (const e of [...ledger, ...quarantined]) {
    const where = { file: e.file, line: e.line };
    const label = e.title ?? `${e.spec} (quarantined spec)`;
    if (!['red', 'flaky'].includes(e.kind)) errors.push({ ...where, text: `kind must be "red" or "flaky", got "${e.kind}"` });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.since)) errors.push({ ...where, text: `since must be YYYY-MM-DD, got "${e.since}"` });
    else if (daysBetween(e.since, today) > MAX_AGE_DAYS) {
      errors.push({ ...where, text: `"${label}" listed since ${e.since}, over ${MAX_AGE_DAYS} days; fix it or re-date it with a new reason` });
    }
    if (e.tracked !== null && !(await linkResolves(ledgerPath, e.tracked))) errors.push({ ...where, text: `tracked link missing or does not resolve: ${e.tracked || '(empty)'}` });
    const runs = results.filter((r) => r.spec === e.spec && (e.title === null || r.title === e.title));
    if (runs.length === 0) {
      warnings.push({ ...where, text: `"${label}" did not run in these results` });
    } else if (e.kind === 'red' && runs.every((r) => r.state === 'passed')) {
      errors.push({ ...where, text: `"${label}" passed; the entry is stale, remove it` });
    }
  }

  printGrouped('Ledger mismatches:', errors);
  printGrouped('Not run (warning only):', warnings, c.yellow, '!');
  const red = results.filter((r) => r.state === 'failed').length;
  printSummary(results.length - red, errors.length,
    `${results.length} cases, ${red} red, ${ledger.length} ledger entries, ${quarantined.length} quarantined specs`, warnings.length);
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n  ${c.red}Fatal:${c.reset} ${err.message}\n`);
  process.exit(1);
});
