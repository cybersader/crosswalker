/**
 * Shared helpers for the documentation gates (check-links, check-freshness,
 * check-unverified-claims, check-roadmap-sync, check-repo-paths).
 *
 * Everything here is pure filesystem and string work: no build, no browser,
 * no network. Each gate stays a single readable script; this module only holds
 * the pieces two or more of them need, so the gates cannot disagree about what
 * a page, a route, or an anchor is.
 */

import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, relative, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Must match `base` in docs/astro.config.mjs. */
export const BASE = '/crosswalker';
/** Must match `site` in docs/astro.config.mjs. */
export const SITE = 'https://cybersader.github.io';

export const PAGE_EXTS = new Set(['.md', '.mdx']);

/**
 * Routes that exist at build time but have no file on disk, because a
 * Starlight plugin generates them. Source of truth is `plugins:` in
 * docs/astro.config.mjs:
 *   - starlightBlog({ prefix: 'blog' })  → /blog (index) and /blog/tags/<tag>
 *   - starlightTagsPlugin()              → /tags and /tags/<tag>
 * If a plugin is added, removed, or re-prefixed, update this list in the same
 * change.
 */
export const GENERATED_ROUTE_PREFIXES = [`${BASE}/blog`, `${BASE}/tags`];

export function isGeneratedRoute(route) {
  return GENERATED_ROUTE_PREFIXES.some(
    (prefix) => route === prefix || route.startsWith(`${prefix}/`),
  );
}

const isTTY = process.stdout.isTTY;
export const c = {
  reset: isTTY ? '\x1b[0m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  red: isTTY ? '\x1b[31m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  bold: isTTY ? '\x1b[1m' : '',
};

/**
 * Parse the flags every gate shares. `--repo-root <dir>` points a gate at a
 * throwaway tree (the unit tests use it); `--today YYYY-MM-DD` pins "now" for
 * the date-based gates. Unknown arguments are returned in `rest`.
 */
export function parseCommonArgs(argv) {
  const scriptDir = fileURLToPath(new URL('..', import.meta.url));
  const out = { repoRoot: resolve(scriptDir, '..'), today: null, help: false, rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--repo-root') out.repoRoot = resolve(argv[++i]);
    else if (arg === '--today') out.today = argv[++i];
    else out.rest.push(arg);
  }
  return out;
}

/**
 * "Today" as a UTC-midnight Date, from `--today` or the local calendar date
 * (CI runners use UTC, so the two agree there).
 */
export function todayDate(todayArg) {
  const now = new Date();
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const iso = todayArg ?? local;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`--today must be YYYY-MM-DD, got "${iso}"`);
  return new Date(`${iso}T00:00:00Z`);
}

/** Whole days from `iso` to `today` (positive when `iso` is in the past). */
export function daysBetween(iso, today) {
  return Math.round((today.getTime() - new Date(`${iso}T00:00:00Z`).getTime()) / 86_400_000);
}

export function docsRootOf(repoRoot) {
  return resolve(repoRoot, 'docs/src/content/docs');
}

/** Recursively collect files, skipping `.ck/` snapshot dirs and dotfiles. */
export async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Every page file (.md/.mdx) under the docs content root. */
export async function listPages(repoRoot) {
  return (await walk(docsRootOf(repoRoot))).filter((f) => PAGE_EXTS.has(extname(f)));
}

/** Repo-relative POSIX path, for reports. */
export function rel(repoRoot, file) {
  return relative(repoRoot, file).split(/[\\/]/).join('/');
}

/**
 * The route a page file is published at. Mirrors Astro content-collection
 * routing: path minus extension, with `index` collapsing to its directory.
 * Verified safe for this repo because no page sets a `slug:` override and no
 * filename contains uppercase.
 */
export function routeForPage(docsRoot, absPath) {
  const r = relative(docsRoot, absPath).split(/[\\/]/).join('/');
  let withoutExt = r.slice(0, r.length - extname(r).length);
  if (basename(withoutExt) === 'index') {
    withoutExt = withoutExt.slice(0, Math.max(0, withoutExt.length - 'index'.length - 1));
  }
  return withoutExt ? `${BASE}/${withoutExt}` : BASE;
}

/**
 * Blank out fenced code blocks and inline code spans, preserving line numbers
 * so reported positions stay accurate. A link inside a code sample documents
 * syntax; it is not a link the reader can follow.
 */
export function stripCode(source) {
  let inFence = false;
  return source.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return '';
    }
    if (inFence) return '';
    return line.replace(/`[^`]*`/g, '');
  });
}

/** Blank only fenced blocks (keep inline code): for gates that read backticks. */
export function stripFences(source) {
  let inFence = false;
  return source.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return '';
    }
    return inFence ? '' : line;
  });
}

/** Every link target on a line, as {target, line}. */
export function extractLinks(lines) {
  const found = [];
  const patterns = [
    /\]\(\s*([^)\s]+)/g,          // [text](target): stops at space so titles are excluded
    /^\s*\[[^\]]+\]:\s*(\S+)/g,   // [ref]: target
    /href\s*=\s*"([^"]+)"/g,      // <a href="target">
    /href\s*=\s*'([^']+)'/g,
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
 * Split a raw link into {route, fragment} when it points into the docs site,
 * or null when it is not an internal page link a gate is responsible for.
 */
export function toInternalTarget(raw) {
  let target = raw.trim();
  if (target.startsWith(SITE)) target = target.slice(SITE.length);
  // Anything still absolute is a genuinely external host: not ours to verify.
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null;
  if (!target.startsWith(BASE)) return null;              // relative/other: out of scope
  const hashAt = target.indexOf('#');
  let fragment = hashAt >= 0 ? target.slice(hashAt + 1) : '';
  target = (hashAt >= 0 ? target.slice(0, hashAt) : target).split('?')[0];
  if (target.length > BASE.length && target.endsWith('/')) target = target.slice(0, -1);
  try {
    target = decodeURIComponent(target);
  } catch {
    /* leave as-is; a malformed escape will simply fail to resolve */
  }
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    /* leave as-is */
  }
  return { route: target, fragment };
}

/** Just the route part of an internal link, or null. */
export function toInternalRoute(raw) {
  const t = toInternalTarget(raw);
  return t === null ? null : t.route;
}

/**
 * Heading slug, following github-slugger (which Starlight and GitHub use):
 * lowercase, drop everything that is not a letter, digit, underscore, hyphen
 * or space, then each space becomes a hyphen. Markdown decoration is removed
 * first so the slug is computed from the rendered text, as the site does.
 */
export function slugify(headingText) {
  const text = headingText
    .replace(/<[^>]+>/g, '')                       // inline HTML tags
    .replace(/:[a-z][\w-]*\[[^\]]*\](\{[^}]*\})?/gi, '') // :badge[...] directives render outside the heading text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')     // links and images: their text
    .replace(/`([^`]*)`/g, '$1')                    // inline code: its content
    .replace(/(^|\s)_+([^_\s][^_]*?)_+(?=\s|$|[.,:;!?)])/g, '$1$2') // _emphasis_
    .trim();
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{Nd}\p{Nl}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/**
 * Every anchor a page exposes: heading slugs (with the -1, -2 suffixes
 * github-slugger gives duplicates), explicit `id="..."` attributes on any
 * element (a browser scrolls to any element with that id; the docs put them on
 * span, div and heading elements, and inline SVG uses them for its own
 * same-page references), and Starlight's `_top`.
 */
export function anchorsOf(source) {
  const anchors = new Set(['_top']);
  const counts = new Map();
  let inFence = false;
  let inFrontmatter = false;
  source.split('\n').forEach((line, i) => {
    if (i === 0 && line.trim() === '---') {
      inFrontmatter = true;
      return;
    }
    if (inFrontmatter) {
      if (line.trim() === '---') inFrontmatter = false;
      return;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const base = slugify(h[1]);
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
    }
    const idRe = /<[A-Za-z][\w:-]*\b[^>]*?\sid\s*=\s*["']([^"']+)["']/g;
    let m;
    while ((m = idRe.exec(line)) !== null) anchors.add(m[1]);
  });
  return anchors;
}

/**
 * Index of every docs route to its file, plus public assets. Shared by the
 * link, anchor and tracked-link checks so they agree on what resolves.
 */
export async function buildRouteIndex(repoRoot) {
  const docsRoot = docsRootOf(repoRoot);
  const pages = await listPages(repoRoot);
  const pageByRoute = new Map(pages.map((p) => [routeForPage(docsRoot, p), p]));
  const assets = new Set();
  const publicRoot = resolve(repoRoot, 'docs/public');
  for (const f of await walk(publicRoot)) {
    assets.add(`${BASE}/${relative(publicRoot, f).split(/[\\/]/).join('/')}`);
  }
  const anchorCache = new Map();
  const anchorsForFile = async (file) => {
    if (!anchorCache.has(file)) {
      let src = '';
      try {
        src = await readFile(file, 'utf8');
      } catch {
        /* unreadable: no anchors */
      }
      anchorCache.set(file, anchorsOf(src));
    }
    return anchorCache.get(file);
  };
  return { docsRoot, pages, pageByRoute, assets, anchorsForFile };
}

/**
 * Resolve one internal link. Returns null when it resolves (or is not ours to
 * check), otherwise 'page' (no such route) or 'anchor' (the route exists, the
 * fragment does not). `selfFile` lets a bare `#fragment` resolve against the
 * page it appears on.
 */
export async function resolveLink(index, raw, selfFile = null) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('#')) {
    if (!selfFile) return null;
    let frag = trimmed.slice(1);
    try {
      frag = decodeURIComponent(frag);
    } catch {
      /* keep */
    }
    if (frag === '') return null;
    return (await index.anchorsForFile(selfFile)).has(frag) ? null : 'anchor';
  }
  const t = toInternalTarget(trimmed);
  if (t === null) return null;
  if (isGeneratedRoute(t.route) || index.assets.has(t.route)) return null;
  const file = index.pageByRoute.get(t.route);
  if (!file) return 'page';
  if (t.fragment && !(await index.anchorsForFile(file)).has(t.fragment)) return 'anchor';
  return null;
}

/** Print a grouped file: [{line, text}] failure list, check-links style. */
export function printGrouped(title, errors, color = c.red, mark = '×') {
  if (errors.length === 0) return;
  console.log(`  ${c.bold}${color}${title}${c.reset}\n`);
  const byFile = new Map();
  for (const e of errors) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }
  for (const [file, list] of byFile) {
    console.log(`  ${color}${mark}${c.reset} ${c.bold}${file}${c.reset}`);
    for (const e of list) {
      const where = e.line ? `line ${e.line}` : '';
      console.log(`      ${c.dim}${where}${c.reset}  ${c.cyan}${e.text}${c.reset}`);
    }
    console.log('');
  }
}

/** The one-line summary every gate ends with. */
export function printSummary(pass, fail, detail, warn = 0) {
  const passLabel = `${c.green}✓ ${pass} passed${c.reset}`;
  const failLabel = fail > 0 ? `   ${c.red}× ${fail} failed${c.reset}` : '';
  const warnLabel = warn > 0 ? `   ${c.yellow}! ${warn} warning${warn === 1 ? '' : 's'}${c.reset}` : '';
  console.log(`  ${passLabel}${failLabel}${warnLabel} ${c.dim}(${detail})${c.reset}\n`);
}

/**
 * The canonical living-page marker: `**Status last verified:** YYYY-MM-DD`.
 * The colon may sit inside or outside the bold.
 */
export const MARKER_RE = /\*\*Status last verified:?\*\*:?\s*(\d{4}-\d{2}-\d{2})/;

/**
 * Every line (outside fenced code) that STARTS a freshness marker, well formed
 * or not, as {line, text}. A page with at least one is a living page; there is
 * no separate registry to drift. A mention of the phrase mid-sentence or in a
 * table cell (a log describing the convention) is not a marker.
 */
export function findMarkers(source) {
  const out = [];
  stripFences(source).forEach((text, i) => {
    if (/^\s*(?:>\s*)?(?:\*\*)?Status last verified/i.test(text)) out.push({ line: i + 1, text });
  });
  return out;
}

/** Read a file, or null when it does not exist. */
export async function readOptional(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}
