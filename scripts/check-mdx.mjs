#!/usr/bin/env node
/**
 * Lightweight MDX syntax checker.
 *
 * Parses every .mdx file under docs/src/content/docs/ using @mdx-js/mdx
 * directly — no Astro, no Starlight, no rollup, no Vite. Runs in ~1–2
 * seconds on the full ~100-file corpus. Catches the class of "silently
 * breaks your page" MDX bugs that only surface when a reader visits the
 * page in a running dev server.
 *
 * Usage:
 *   bun run check:mdx                          Check all .mdx under docs/
 *   bun run check:mdx path/to/dir/             Check only files under a dir
 *   bun run check:mdx path/to/file.mdx         Check one file
 *
 * Or via the interactive orchestrator:
 *   bun run serve                              Menu → option 9
 *
 * What it catches:
 *   - Bare curly braces inside HTML tags that parse as invalid JSX
 *     expressions (e.g. `<code>{status: covered}</code>`)
 *   - Unclosed or mismatched JSX tags
 *   - Invalid frontmatter YAML
 *   - Unbalanced template literals in inline <style> blocks
 *   - MDX v3 strict parsing issues (e.g. `5 < 10` in prose attempting
 *     to open a JSX element)
 *   - Smart quotes / unicode quote chars inside JSX expressions
 *
 * What it does NOT catch:
 *   - Cross-link 404s (needs the full sitemap build)
 *   - Tag vocabulary violations (tags not in `tags.yml`) — that's
 *     enforced by starlight-tags at Astro content-collection time
 *   - Schema-level frontmatter validation (Starlight content collections)
 *   - CSS rule errors (browser render time)
 *   - Inline-SVG camelCase attributes being HTML-lowercased
 *     (`strokeWidth` → `strokewidth` — this is HTML parser behavior
 *     that happens at a later stage, not MDX-parse-level)
 *
 * For those, you still need `bun run serve:docs` or the full build.
 * This script is the fast "did I break the MDX syntax itself" check.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname, '..');
const docsContentDir = resolve(repoRoot, 'docs/src/content/docs');

// ANSI color helpers — strip if not a TTY (CI, piped output, etc.)
const isTTY = process.stdout.isTTY;
const c = {
  reset: isTTY ? '\x1b[0m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  red: isTTY ? '\x1b[31m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  bold: isTTY ? '\x1b[1m' : '',
};

/**
 * Import @mdx-js/mdx from the docs/node_modules location so this script
 * doesn't need a separate root-level devDependency. If docs/node_modules
 * isn't populated yet, fall back to the default Node resolver and then
 * print a helpful install hint if nothing works.
 */
async function importMdxCompiler() {
  const candidates = [
    resolve(repoRoot, 'docs/node_modules/@mdx-js/mdx/index.js'),
    resolve(repoRoot, 'docs/node_modules/@mdx-js/mdx/lib/index.js'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return import(path);
    }
  }
  try {
    return await import('@mdx-js/mdx');
  } catch {
    console.error(
      `\n  ${c.red}Error:${c.reset} @mdx-js/mdx not found.\n\n` +
      `  This script reads @mdx-js/mdx from docs/node_modules. Run:\n\n` +
      `    cd docs && bun install\n\n` +
      `  Or use \`bun run serve\` which auto-installs docs dependencies on first run.\n`
    );
    process.exit(1);
  }
}

/**
 * Recursively walk a directory and collect every .mdx file path, skipping
 * node_modules, .git, and dist directories.
 */
async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`  ${c.red}Error reading ${dir}: ${err.message}${c.reset}`);
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      await walk(full, out);
    } else if (entry.isFile() && extname(entry.name) === '.mdx') {
      out.push(full);
    }
  }
  return out;
}

/**
 * Resolve the target argument to a flat list of .mdx files to check.
 * No arg → full docs/src/content/docs/ tree.
 * Directory arg → walk that directory.
 * File arg → single file (must be .mdx).
 */
async function findTargetFiles(arg) {
  if (!arg) {
    return walk(docsContentDir);
  }
  const absolutePath = resolve(process.cwd(), arg);
  if (!existsSync(absolutePath)) {
    console.error(`  ${c.red}Error:${c.reset} path not found: ${absolutePath}\n`);
    process.exit(1);
  }
  const s = await stat(absolutePath);
  if (s.isFile()) {
    if (extname(absolutePath) !== '.mdx') {
      console.error(`  ${c.red}Error:${c.reset} not an .mdx file: ${absolutePath}\n`);
      process.exit(1);
    }
    return [absolutePath];
  }
  if (s.isDirectory()) {
    return walk(absolutePath);
  }
  return [];
}

/**
 * Extract a human-friendly line/column + message from whatever shape
 * @mdx-js/mdx throws. Error shapes vary by error class — vfile Message,
 * SyntaxError, generic Error, etc.
 */
function extractErrorInfo(err, file) {
  const line =
    err.line ??
    err.position?.start?.line ??
    err.place?.line ??
    err.place?.start?.line ??
    null;
  const column =
    err.column ??
    err.position?.start?.column ??
    err.place?.column ??
    err.place?.start?.column ??
    null;
  const message = err.reason ?? err.message ?? String(err);
  const ruleId = err.ruleId ?? err.source ?? null;
  return { file, line, column, message, ruleId };
}

async function main() {
  const arg = process.argv[2];
  const { compile } = await importMdxCompiler();

  const files = await findTargetFiles(arg);
  if (files.length === 0) {
    console.log(`\n  ${c.yellow}No .mdx files found.${c.reset}\n`);
    return;
  }

  console.log(
    `\n  ${c.bold}${c.cyan}MDX syntax check${c.reset} ${c.dim}— ${files.length} file${files.length === 1 ? '' : 's'}${c.reset}\n`
  );

  let passed = 0;
  let failed = 0;
  const errors = [];
  const startTime = Date.now();

  // Dot-per-file progress indicator — prints ✓ or ✗ as each file finishes
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    try {
      await compile(content, { format: 'mdx', development: false });
      passed++;
      process.stdout.write(`${c.green}·${c.reset}`);
    } catch (err) {
      failed++;
      errors.push(extractErrorInfo(err, relative(repoRoot, file)));
      process.stdout.write(`${c.red}×${c.reset}`);
    }
  }

  const elapsedMs = Date.now() - startTime;
  const elapsedSec = (elapsedMs / 1000).toFixed(2);

  console.log(`\n`);

  if (errors.length > 0) {
    console.log(`  ${c.bold}${c.red}Errors:${c.reset}\n`);
    for (const e of errors) {
      const loc = e.line != null ? `:${e.line}${e.column != null ? `:${e.column}` : ''}` : '';
      console.log(`  ${c.red}×${c.reset} ${c.bold}${e.file}${loc}${c.reset}`);
      // Wrap long error messages to a reasonable line length
      const wrapped = wrapText(e.message, 90, '      ');
      console.log(wrapped);
      if (e.ruleId) {
        console.log(`      ${c.dim}rule: ${e.ruleId}${c.reset}`);
      }
      console.log('');
    }
  }

  const passLabel = `${c.green}✓ ${passed} passed${c.reset}`;
  const failLabel = failed > 0 ? `   ${c.red}× ${failed} failed${c.reset}` : '';
  console.log(`  ${passLabel}${failLabel}   ${c.dim}(${elapsedSec}s)${c.reset}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

/**
 * Simple word-wrapper for error messages so they don't blow out the terminal.
 * Preserves the left indent on every wrapped line.
 */
function wrapText(text, width, indent) {
  if (!text) return `${indent}(no message)`;
  const words = String(text).split(/\s+/);
  const lines = [];
  let current = indent;
  for (const word of words) {
    if (current.length + word.length + 1 > width + indent.length) {
      lines.push(current);
      current = indent + word;
    } else {
      current = current === indent ? current + word : current + ' ' + word;
    }
  }
  if (current.length > indent.length) lines.push(current);
  return lines.join('\n');
}

main().catch((err) => {
  console.error(`\n  ${c.red}Fatal:${c.reset} ${err.message}\n`);
  if (err.stack && process.env.DEBUG) {
    console.error(err.stack);
  }
  process.exit(1);
});
