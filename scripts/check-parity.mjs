#!/usr/bin/env bun
/** Check source coverage and reference drift; --write updates only the generated region. */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES } from '../tools/parity/capabilities.ts';
import { PAGE_PATH, extractCommands, extractVerbs, validateRegistry, renderTable, replaceGenerated, checkPage } from '../tools/parity/check.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}
try {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--write') || args.length > 1) throw new Error('Usage: bun run check:parity or bun run parity:write.');
  const commands = sources(join(root, 'src')).flatMap((path) => extractCommands(readFileSync(path, 'utf8'), relative(root, path).replaceAll('\\', '/')));
  // main.ts is deliberately a thin process entry. Do not import it or run the CLI.
  const cliPath = 'cli/crosswalker.ts';
  const verbs = extractVerbs(readFileSync(join(root, cliPath), 'utf8'), cliPath);
  const errors = validateRegistry(CAPABILITIES, { commands, verbs });
  if (errors.length) throw new Error(errors.join('\n'));
  const path = join(root, PAGE_PATH);
  const page = readFileSync(path, 'utf8');
  if (args.includes('--write')) {
    writeFileSync(path, replaceGenerated(page, renderTable(CAPABILITIES)));
    console.log(`Updated ${PAGE_PATH}. Run bun run check:parity to verify.`);
  } else {
    const drift = checkPage(page, CAPABILITIES);
    if (drift.length) throw new Error(drift.join('\n'));
    console.log(`Parity OK: ${CAPABILITIES.length} capabilities, ${commands.length} command ids, ${verbs.length} cw verbs. Tracked gaps are allowed; untracked actions are not.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
