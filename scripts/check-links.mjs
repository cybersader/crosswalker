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
 * is a GOOD link, and it does not check anchors — heading slugs involve
 * enough Starlight-specific normalization that a false positive is likely,
 * and a gate that cries wolf gets ignored.
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
 *   - Anchors and query strings (stripped before resolution)
 *
 * Usage:
 *   bun run check:links
 *
 * Pass: every internal link resolves to a page file or a public asset.
 * Fail: one or more do not, reported as file:line with the offending target.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join, relative, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname, '..');
const docsRoot = resolve(repoRoot, 'docs/src/content/docs');
const publicRoot = resolve(repoRoot, 'docs/public');

// Shared website normalization recognizes root routes and both legacy prefixes.
import { sitePath } from '../docs/site-urls.mjs';
const BASE = '';

/**
 * Routes that exist at build time but have no file on disk, because a
 * Starlight plugin generates them. Without these the gate reports false
 * positives on links that work perfectly in production — and a checker that
 * cries wolf is worse than no checker, because the next real breakage gets
 * waved through with the noise.
 *
 * Source of truth is `plugins:` in docs/astro.config.mjs:
 *   - starlightBlog({ prefix: 'blog' })  → /blog (index) and /blog/tags/<tag>
 *   - starlightTagsPlugin()              → /tags and /tags/<tag>
 *
 * Individual blog POSTS are ordinary files under docs/blog/ and still resolve
 * normally, so a typo in a post link is still caught. Only the generated
 * index and tag listings are exempt. If a plugin is added, removed, or
 * re-prefixed, update this list in the same change.
 */
const GENERATED_ROUTE_PREFIXES = [`${BASE}/blog`, `${BASE}/tags`];

function isGeneratedRoute(route) {
  return GENERATED_ROUTE_PREFIXES.some(
    (prefix) => route === prefix || route.startsWith(`${prefix}/`),
  );
}

const isTTY = process.stdout.isTTY;
const c = {
  reset: isTTY ? '\x1b[0m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  red: isTTY ? '\x1b[31m' : '',
  green: isTTY ? '\x1b[32m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  bold: isTTY ? '\x1b[1m' : '',
};

const PAGE_EXTS = new Set(['.md', '.mdx']);

/**
 * Repo-root files that link INTO the docs site and are read by people or
 * agents who cannot see a 404 coming. README is the public front door on
 * GitHub; the CLAUDE.md pair is the first thing an agent reads and routes
 * nearly all of its knowledge-base navigation through site URLs. A rotted
 * link here misdirects exactly the reader with the least context.
 *
 * These are scanned for the site-absolute spelling only, since a root-relative
 * `/crosswalker/...` path is meaningless in a file rendered on GitHub.
 */
const ROOT_FILES = ['README.md', 'ROADMAP.md', 'CLAUDE.md', '.claude/CLAUDE.md', 'CHANGELOG.md'];

/** Recursively collect files, skipping `.ck/` snapshot dirs and dotfiles. */
async function walk(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * The route a page file is published at. Mirrors Astro content-collection
 * routing: path minus extension, with `index` collapsing to its directory.
 * Verified safe for this repo because no page sets a `slug:` override and no
 * filename contains uppercase (both asserted before this gate was written).
 */
function routeForPage(absPath) {
  const rel = relative(docsRoot, absPath).split(/[\\/]/).join('/');
  let withoutExt = rel.slice(0, rel.length - extname(rel).length);
  if (basename(withoutExt) === 'index') {
    withoutExt = withoutExt.slice(0, Math.max(0, withoutExt.length - 'index'.length - 1));
  }
  return withoutExt ? `${BASE}/${withoutExt}` : '/';
}

/**
 * Blank out fenced code blocks and inline code spans, preserving line numbers
 * so reported positions stay accurate. A link inside a code sample documents
 * syntax; it is not a link the reader can follow.
 */
function stripCode(source) {
  const lines = source.split('\n');
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return '';
    }
    if (inFence) return '';
    return line.replace(/`[^`]*`/g, '');
  });
}

/** Every internal link target on a line, as {target, line}. */
function extractLinks(lines) {
  const found = [];
  const patterns = [
    /\]\(\s*([^)\s]+)/g,          // [text](target) — stops at space so titles are excluded
    /^\s*\[[^\]]+\]:\s*(\S+)/g,   // [ref]: target
    /(?:href|src)\s*=\s*"([^"]+)"/g,      // <a href="target">
    /(?:href|src)\s*=\s*'([^']+)'/g,
  ];
  lines.forEach((line, i) => {
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) found.push({ target: m[1], line: i + 1 });
    }
  });
  return found;
}

/**
 * Normalize a raw link to a comparable route, or null when it is not an
 * internal page link this gate is responsible for.
 */
function toInternalRoute(raw) {
  let target = sitePath(raw.trim());
  if (!target.startsWith('/') || target.startsWith('//')) return null;
  target = target.split('#')[0].split('?')[0];
  if (target.length > 1 && target.endsWith('/')) target = target.slice(0, -1);
  try {
    target = decodeURIComponent(target);
  } catch {
    /* leave as-is; a malformed escape will simply fail to resolve */
  }
  return target;
}

async function main() {
  console.log(`\n  ${c.bold}Internal doc links${c.reset} ${c.dim}${relative(repoRoot, docsRoot)}${c.reset}\n`);

  const allFiles = await walk(docsRoot);
  const pages = allFiles.filter((f) => PAGE_EXTS.has(extname(f)));

  const routes = new Set(pages.map(routeForPage));

  // Public assets are served at BASE/<name>, so a link may legitimately point
  // at one even though it is not a page.
  let assets = [];
  try {
    assets = (await walk(publicRoot)).map(
      (f) => `${BASE}/${relative(publicRoot, f).split(/[\\/]/).join('/')}`,
    );
  } catch {
    /* no public dir is fine */
  }
  for (const asset of assets) routes.add(asset);

  const errors = [];
  let checked = 0;

  const scan = async (file) => {
    let source;
    try {
      source = await readFile(file, 'utf8');
    } catch {
      return; // an optional root file that does not exist is not a failure
    }
    const lines = stripCode(source);
    for (const { target, line } of extractLinks(lines)) {
      const route = toInternalRoute(target);
      if (route === null) continue;
      checked += 1;
      if (!routes.has(route) && !isGeneratedRoute(route)) {
        errors.push({ file: relative(repoRoot, file), line, target: target.trim() });
      }
    }
  };

  for (const file of pages) await scan(file);
  for (const rootFile of ROOT_FILES) await scan(resolve(repoRoot, rootFile));

  if (errors.length > 0) {
    console.log(`  ${c.bold}${c.red}Broken internal links:${c.reset}\n`);
    // Group by file so a page with many misses reads as one problem.
    const byFile = new Map();
    for (const e of errors) {
      if (!byFile.has(e.file)) byFile.set(e.file, []);
      byFile.get(e.file).push(e);
    }
    for (const [file, list] of byFile) {
      console.log(`  ${c.red}×${c.reset} ${c.bold}${file}${c.reset}`);
      for (const e of list) console.log(`      ${c.dim}line ${e.line}${c.reset}  ${c.cyan}${e.target}${c.reset}`);
      console.log('');
    }
    console.log(
      `  ${c.dim}A link resolves when a page file exists at that path.\n`
      + `  If the target moved (archived briefs are the usual cause), update the link;\n`
      + `  if it never existed, the link is a typo.${c.reset}\n`,
    );
  }

  const pass = checked - errors.length;
  const passLabel = `${c.green}✓ ${pass} passed${c.reset}`;
  const failLabel = errors.length > 0 ? `   ${c.red}× ${errors.length} broken${c.reset}` : '';
  console.log(
    `  ${passLabel}${failLabel} ${c.dim}(${checked} internal links across `
    + `${pages.length} pages + ${ROOT_FILES.length} root files)${c.reset}\n`,
  );

  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n  ${c.red}Fatal:${c.reset} ${err.message}\n`);
  process.exit(1);
});
