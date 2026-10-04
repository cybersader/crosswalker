#!/usr/bin/env node
/**
 * Run every documentation and repository gate, in sequence, and print one
 * summary table. This is `bun run check`, the single pre-commit command.
 *
 * Why this exists (2026-10-03, knowledge-ops gates spec K9): the run-list in
 * the root CLAUDE.md said "run all six, not a subset", and partial passes kept
 * reading as green while CI failed. One command removes the choice.
 *
 * The gate list is read from package.json: every `check:*` script, in the
 * order they appear, except the ones in EXCLUDED below. Adding a `check:*`
 * script therefore adds it here with no second list to keep in sync.
 *
 * Gates run one at a time on purpose (the host is shared; see the resource
 * discipline section of .claude/CLAUDE.md). Every gate runs even after one
 * fails, so a single invocation shows the whole picture.
 *
 * Usage:
 *   bun run check [--list]
 *
 * Exit 0 when every gate passes, 1 when any fails.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * `check:*` scripts that are not part of the pre-commit set, with the reason.
 * check:fixtures-drift regenerates the Tier 1 fixtures into the working tree
 * (and restores them); it belongs with fixture and spec changes, per the
 * pre-commit run-list, not with every commit.
 */
export const EXCLUDED = new Set(['check:fixtures-drift']);

const isTTY = process.stdout.isTTY;
const c = {
  reset: isTTY ? '\x1b[0m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  red: isTTY ? '\x1b[31m' : '',
  green: isTTY ? '\x1b[32m' : '',
  bold: isTTY ? '\x1b[1m' : '',
};

export function gateNames(pkg) {
  return Object.keys(pkg.scripts ?? {}).filter((name) => name.startsWith('check:') && !EXCLUDED.has(name));
}

const HELP = `check-all: run every check:* gate from package.json in sequence and summarize.

Usage: node scripts/check-all.mjs [--list] [--help]

Excluded: ${[...EXCLUDED].join(', ')} (see the script header for why).
Exit 0 when every gate passes, 1 when any fails.`;

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  const gates = gateNames(pkg);
  if (argv.includes('--list')) {
    for (const g of gates) console.log(g);
    process.exit(0);
  }

  const results = [];
  for (const gate of gates) {
    console.log(`\n${c.bold}── ${gate}${c.reset} ${c.dim}${pkg.scripts[gate]}${c.reset}`);
    const started = Date.now();
    const run = spawnSync('bun', ['run', gate], { cwd: repoRoot, stdio: 'inherit' });
    const code = run.status ?? (run.signal ? 143 : 1);
    results.push({ gate, code, ms: Date.now() - started });
  }

  const width = Math.max(...results.map((r) => r.gate.length));
  console.log(`\n${c.bold}  Gate summary${c.reset}\n`);
  console.log(`  ${'gate'.padEnd(width)}  result  exit  time`);
  console.log(`  ${'-'.repeat(width)}  ------  ----  -----`);
  for (const r of results) {
    const label = r.code === 0 ? `${c.green}pass${c.reset}  ` : `${c.red}FAIL${c.reset}  `;
    console.log(`  ${r.gate.padEnd(width)}  ${label}  ${String(r.code).padStart(4)}  ${(r.ms / 1000).toFixed(1)}s`);
  }
  const failed = results.filter((r) => r.code !== 0);
  console.log(
    `\n  ${failed.length === 0 ? `${c.green}✓ all ${results.length} gates passed` : `${c.red}× ${failed.length} of ${results.length} gates failed`}${c.reset}\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
