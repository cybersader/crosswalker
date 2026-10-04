#!/usr/bin/env node
/**
 * Repo-path claims gate.
 *
 * In docs/src/content/docs/** and CHANGELOG.md, every inline-code token that
 * looks like a repo path must name something tracked in git:
 *
 *   `src/...`  `tests/...`  `scripts/...`  `spec/...`  `tools/...`
 *   `.github/...`  `docs/...`  `package.json`
 *
 * A file token must be in `git ls-files --cached --others --exclude-standard`
 * (tracked, or new and not ignored, so a file created in the same change
 * passes before it is staged); a directory token (ending in `/`) must contain
 * at least one such file. Gitignored files therefore fail, which is the point:
 * a doc that says "the repo gains X" about an ignored file is wrong for every
 * other reader.
 *
 * Opt-outs:
 *   - `(local, gitignored)` within 40 characters after the token, for a doc
 *     that deliberately names a local-only file
 *   - `(planned)` within 40 characters after the token, for a file a plan or
 *     milestone page names before it exists (a "Files to touch" list)
 *   - placeholders and elisions are not claims: a token containing `YYYY`,
 *     `-NN-` or a `/.../` segment is skipped
 *   - CHANGELOG lines under a heading dated before 2026-09-01, and zz-log /
 *     zz-research / zz-challenges pages whose filename date is before
 *     2026-09-01 (historical record of files that have since moved or were
 *     never built; that record is not rewritten)
 *   - fenced code blocks (examples, not claims)
 *
 * Why this exists (2026-10-03, knowledge-ops gates spec K8): a log claimed
 * "the repo gains an `openclast-smoke` portagenty session" for a gitignored
 * file, caught only by luck in review; renamed files left stale references.
 *
 * Usage:
 *   bun run check:repo-paths [--repo-root <dir>]
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { c, parseCommonArgs, listPages, stripFences, printGrouped, printSummary, rel } from './lib/doc-pages.mjs';

export const PATH_TOKEN = /^(src|tests|scripts|spec|tools|\.github|docs)\/[\w./-]+$/;
export const HISTORICAL_BEFORE = '2026-09-01';
const OPT_OUT = /\(local, gitignored\)|\(planned\)/;
const PLACEHOLDER = /YYYY|-NN-|\/\.\.\.\//;
const DATED_RECORD = /\/(zz-log|zz-research|zz-challenges)\/(?:archive\/)?(20\d\d-\d\d-\d\d)-/;

const HELP = `check-repo-paths: repo paths named in docs and CHANGELOG exist in git.

Usage: node scripts/check-repo-paths.mjs [--repo-root <dir>] [--help]

Checks inline-code tokens matching ${PATH_TOKEN} or \`package.json\` in
docs/src/content/docs/** and CHANGELOG.md against \`git ls-files\`. Opt out
with "(local, gitignored)" or "(planned)" within 40 characters after the token.
Placeholders (YYYY, -NN-, /.../) are skipped. CHANGELOG lines under headings,
and zz-log/zz-research/zz-challenges pages, dated before ${HISTORICAL_BEFORE}
are skipped as historical.
Exit 0 when every path resolves, 1 otherwise.`;

/** Every inline-code token on a line that names a repo path: {token, end}. */
export function pathTokens(line) {
  const out = [];
  for (const m of line.matchAll(/`([^`\n]+)`/g)) {
    const token = m[1].trim();
    if (PLACEHOLDER.test(token)) continue;
    if (token === 'package.json' || PATH_TOKEN.test(token)) out.push({ token, end: m.index + m[0].length });
  }
  return out;
}

/** Line numbers (1-based) of CHANGELOG lines under a heading dated before the cutoff. */
export function historicalLines(source) {
  const skip = new Set();
  const stack = []; // [{level, date}]
  source.split('\n').forEach((line, i) => {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const d = /\b(20\d\d-\d\d-\d\d)\b/.exec(h[2]);
      stack.push({ level, date: d ? d[1] : null });
    }
    const dated = [...stack].reverse().find((s) => s.date);
    if (dated && dated.date < HISTORICAL_BEFORE) skip.add(i + 1);
  });
  return skip;
}

async function main() {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  const repoRoot = args.repoRoot;
  console.log(`\n  ${c.bold}Repo paths named in docs exist in git${c.reset} ${c.dim}docs + CHANGELOG.md${c.reset}\n`);

  const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
  const files = new Set(tracked);
  const dirs = new Set();
  for (const f of tracked) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(`${parts.slice(0, i).join('/')}/`);
  }
  const exists = (token) => (token.endsWith('/') ? dirs.has(token) : files.has(token) || dirs.has(`${token}/`));

  const errors = [];
  let checked = 0;
  const scan = async (file, skip) => {
    let source;
    try {
      source = await readFile(file, 'utf8');
    } catch {
      return;
    }
    stripFences(source).forEach((line, i) => {
      if (skip?.has(i + 1)) return;
      for (const { token, end } of pathTokens(line)) {
        if (OPT_OUT.test(line.slice(end, end + 40))) continue;
        checked += 1;
        if (!exists(token)) errors.push({ file: rel(repoRoot, file), line: i + 1, text: token });
      }
    });
  };

  for (const page of await listPages(repoRoot)) {
    const dated = DATED_RECORD.exec(rel(repoRoot, page));
    if (dated && dated[2] < HISTORICAL_BEFORE) continue;
    await scan(page, null);
  }
  const changelog = resolve(repoRoot, 'CHANGELOG.md');
  let changelogSource = '';
  try {
    changelogSource = await readFile(changelog, 'utf8');
  } catch {
    /* none */
  }
  await scan(changelog, historicalLines(changelogSource));

  printGrouped('Repo paths not tracked in git:', errors);
  if (errors.length > 0) {
    console.log(
      `  ${c.dim}Correct the path if the file moved; if the file is deliberately local, add\n`
      + `  "(local, gitignored)" right after the token; if it never existed, drop the claim.${c.reset}\n`,
    );
  }
  printSummary(checked - errors.length, errors.length, `${checked} path references`);
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n  ${c.red}Fatal:${c.reset} ${err.message}\n`);
  process.exit(1);
});
