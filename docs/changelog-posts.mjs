/**
 * The site's Changelog is generated from the repository's CHANGELOG.md, the one
 * place every change is recorded. Hand-written posts stopped after 2026-04-02
 * while CHANGELOG.md kept growing, so the posts are now derived, never authored.
 *
 * - Each dated `### …` entry under [Unreleased] becomes one post.
 * - Each dated `## [version] - date` release section becomes one post.
 * - An `### Added:` / `Changed:` / `Fixed:` (…) entry without a date fails the
 *   build with the line number, so a new entry cannot silently go unpublished.
 *
 * Output goes to docs/src/content/docs/blog/changelog/ (gitignored) and is
 * rewritten in full on every run. Called from astro.config.mjs.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const CHANGELOG_PATH = resolve(here, '../CHANGELOG.md');
export const OUTPUT_DIR = resolve(here, 'src/content/docs/blog/changelog');
const REPO_BLOB = 'https://github.com/cybersader/crosswalker/blob/main/';

/** Release sections already covered by a hand-written post in blog/. */
const RELEASES_WITH_OWN_POST = new Set(['0.1.0-mvp-scaffold']);
const TYPED_ENTRY = /^(Added|Changed|Fixed|Removed|Deprecated|Security|Docs):/;
const DATE = /\b(20\d\d-\d\d-\d\d)\b/;

/** Point repository-relative links at GitHub; leave web, site and mail links alone. */
export function rewriteLinks(markdown) {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) return whole;
    if (target.startsWith('#')) return `](${REPO_BLOB}CHANGELOG.md${target})`;
    const path = posix.normalize(target);
    return `](${REPO_BLOB}${path.startsWith('../') ? 'CHANGELOG.md' : path})`;
  });
}

/** First paragraph as plain text, for the post description. */
export function summarize(body, max = 180) {
  const para = body.trim().split(/\n\s*\n/)[0] ?? '';
  const text = para
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : text;
}

function slugify(text) {
  return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70).replace(/-$/, '');
}

/**
 * Parse CHANGELOG.md text into posts. Entries keep file order (newest first);
 * `order` breaks ties between posts that share a date.
 * @returns {{ posts: Array<{slug:string,title:string,date:string,order:number,description:string,body:string,kind:'entry'|'release'}>, undated: Array<{line:number,heading:string}> }}
 */
export function parseChangelog(text) {
  const lines = text.split(/\r?\n/);
  const posts = [];
  const undated = [];
  let section = null; // 'unreleased' | 'release' | null
  let current = null;
  const flush = () => {
    if (!current) return;
    const body = current.lines.join('\n').trim();
    if (body) posts.push({ ...current, body, description: summarize(body) || current.title });
    current = null;
  };
  lines.forEach((line, index) => {
    const release = /^## \[([^\]]+)\]\s*[-—]\s*(20\d\d-\d\d-\d\d)/.exec(line);
    if (line.startsWith('## ')) {
      flush();
      if (/^## \[Unreleased\]/.test(line)) section = 'unreleased';
      else if (release && !RELEASES_WITH_OWN_POST.has(release[1])) {
        section = 'release';
        const name = release[1];
        current = { kind: 'release', title: /^\d/.test(name) ? `Prerelease ${name}` : name, date: release[2], lines: [] };
      } else section = null;
      return;
    }
    if (section === 'unreleased' && line.startsWith('### ')) {
      flush();
      const heading = line.slice(4).trim();
      const date = DATE.exec(heading)?.[1];
      if (!date) {
        if (TYPED_ENTRY.test(heading)) undated.push({ line: index + 1, heading });
        return;
      }
      const title = heading.replace(/\s*\((?=[^()]*\b20\d\d-\d\d-\d\d\b)[^()]*\)\s*$/, '').replace(/\s*[—-]\s*20\d\d-\d\d-\d\d.*$/, '').trim();
      current = { kind: 'entry', title, date, lines: [] };
      return;
    }
    if (current) current.lines.push(line);
  });
  flush();
  const seen = new Map();
  const perDate = new Map();
  for (const post of posts) {
    const base = `${post.date}-${slugify(post.title) || 'update'}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    post.slug = n === 1 ? base : `${base}-${n}`;
    post.order = perDate.get(post.date) ?? 0;
    perDate.set(post.date, post.order + 1);
  }
  return { posts, undated };
}

/** Earlier in the file is newer, so later posts on the same date get an earlier time. */
function timestamp(date, order) {
  const seconds = 86399 - Math.min(order, 86399);
  const hh = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `${date}T${hh}:${mm}:${ss}Z`;
}

export function renderPost(post) {
  const anchor = post.kind === 'release' ? '' : '#unreleased--v01-implementation-in-progress-2026-05-04--present';
  return [
    '---',
    `title: ${JSON.stringify(post.title.replace(/`/g, ''))}`,
    `description: ${JSON.stringify(post.description)}`,
    `date: ${timestamp(post.date, post.order)}`,
    `editUrl: ${JSON.stringify(`${REPO_BLOB.replace('/blob/', '/edit/')}CHANGELOG.md`)}`,
    'lastUpdated: false',
    '---',
    '',
    rewriteLinks(post.body),
    '',
    `Generated from [CHANGELOG.md](${REPO_BLOB}CHANGELOG.md${anchor}).`,
    '',
  ].join('\n');
}

/** Rewrite the generated posts. Throws, naming the lines, if a typed entry has no date. */
export function generateChangelogPosts({ changelogPath = CHANGELOG_PATH, outputDir = OUTPUT_DIR } = {}) {
  const { posts, undated } = parseChangelog(readFileSync(changelogPath, 'utf8'));
  if (undated.length) {
    const list = undated.map(u => `  line ${u.line}: ### ${u.heading}`).join('\n');
    throw new Error(`CHANGELOG.md has entries without a date, so the site Changelog cannot publish them:\n${list}\nAdd the merge date at the end of each heading, for example "### Added: something (2026-11-23)".`);
  }
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  for (const post of posts) writeFileSync(join(outputDir, `${post.slug}.md`), renderPost(post));
  return posts.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Changelog posts written: ${generateChangelogPosts()}`);
}
