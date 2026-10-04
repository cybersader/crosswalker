#!/usr/bin/env node
/**
 * Roadmap sync gate.
 *
 * Milestone status lives in four places that must agree:
 *   1. each milestone page's own status line (the first line under `## Status`)
 *      in docs/src/content/docs/reference/roadmap/milestones/v0-1-*.mdx
 *   2. the status snapshot table in milestones/index.mdx (the milestone hub)
 *   3. the "Where we are" table in reference/roadmap/index.mdx
 *   4. the same table in ROADMAP.md at the repo root (the GitHub mirror)
 *
 * The status of a milestone in each source is the first status glyph found:
 * ✅ Done, 🚧 In progress, 📋 Planning, ⏸ Blocked.
 *
 * Fails (exit 1) when:
 *   - a milestone's glyph differs between any two sources that list it
 *     (every disagreement is reported with file:line)
 *   - a milestone page has no status glyph, or the hub does not list it
 *   - a milestone is listed in the roadmap index but not in ROADMAP.md, or
 *     the reverse (the two are mirrors; archiving removes from both)
 *   - a ✅ milestone is linked from an "Active" section of either roadmap
 *
 * A roadmap row may cover a range ("v0.1.1 to v0.1.5"): every milestone
 * between the two linked ones, in version order, takes that row's glyph.
 *
 * Why this exists (2026-10-03, knowledge-ops gates spec K5): dual-source
 * drift between the roadmap and the milestone pages bit three times before
 * the 2026-07-11 anti-duplication convention, and again on 2026-10-03.
 *
 * Usage:
 *   bun run check:roadmap-sync [--repo-root <dir>]
 */

import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { c, parseCommonArgs, printGrouped, printSummary } from './lib/doc-pages.mjs';

const GLYPHS = ['✅', '🚧', '📋', '⏸'];
const GLYPH_NAME = { '✅': 'Done', '🚧': 'In progress', '📋': 'Planning', '⏸': 'Blocked' };

const HELP = `check-roadmap-sync: milestone status glyphs agree across the four roadmap sources.

Usage: node scripts/check-roadmap-sync.mjs [--repo-root <dir>] [--help]

Sources: milestone pages (first line under "## Status"), the milestone hub
table, the "Where we are" table in the roadmap index, and ROADMAP.md.
Exit 0 when they agree, 1 otherwise.`;

/** First status glyph in a string, or null. */
export function firstGlyph(text) {
  let best = null;
  let bestAt = Infinity;
  for (const g of GLYPHS) {
    const at = text.indexOf(g);
    if (at >= 0 && at < bestAt) {
      best = g;
      bestAt = at;
    }
  }
  return best;
}

/** Version-order key for a milestone slug: v0-1-4-5-streaming → [0,1,4,5]; rc sorts last. */
export function versionKey(slug) {
  if (/^v0-1-rc\b/.test(slug)) return [0, 1, Infinity];
  const parts = [];
  for (const p of slug.slice(1).split('-')) {
    if (/^\d+$/.test(p)) parts.push(Number(p));
    else break;
  }
  return parts;
}

function compareKeys(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Display id: v0-1-4-5-streaming-refactor → v0.1.4.5; v0-1-rc-bundle → v0.1-RC. */
function displayId(slug) {
  if (/^v0-1-rc\b/.test(slug)) return 'v0.1-RC';
  return `v${versionKey(slug).join('.')}`;
}

/** The milestone slugs linked on a line, in order of appearance. */
function linkedSlugs(line, known) {
  const out = [];
  for (const m of line.matchAll(/milestones\/(v0-1-[a-z0-9-]+?)\/?(?=[)#"'\s])/g)) {
    if (known.has(m[1])) out.push(m[1]);
  }
  return out;
}

/** The cells of a Markdown table row, or null when the line is not one. */
function cells(line) {
  if (!/^\s*\|/.test(line) || /^\s*\|\s*-/.test(line)) return null;
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
}

/**
 * Rows of milestone tables in a roadmap-shaped file: {slug, glyph, line}, and
 * the slugs linked from each "Active" section. The status glyph is read from
 * the cell after the milestone cell (the roadmap) or the last cell (the hub).
 */
function readTable(source, known, ordered, statusCell) {
  const rows = [];
  const active = [];
  let heading = '';
  source.split('\n').forEach((line, i) => {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) heading = h[1];
    if (/^active\b/i.test(heading)) {
      for (const slug of linkedSlugs(line, known)) active.push({ slug, line: i + 1 });
    }
    const cs = cells(line);
    if (!cs) return;
    const slugs = linkedSlugs(cs[0], known);
    if (slugs.length === 0) return;
    const glyph = firstGlyph(statusCell === 'last' ? cs[cs.length - 1] : (cs[1] ?? ''));
    let covered = slugs;
    if (slugs.length === 2 && /\bto\b|–|—/.test(cs[0])) {
      const [a, b] = slugs.map(versionKey);
      covered = ordered.filter((s) => compareKeys(versionKey(s), a) >= 0 && compareKeys(versionKey(s), b) <= 0);
    }
    for (const slug of covered) rows.push({ slug, glyph, line: i + 1 });
  });
  return { rows, active };
}

async function main() {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  const repoRoot = args.repoRoot;
  const roadmapDir = resolve(repoRoot, 'docs/src/content/docs/reference/roadmap');
  const milestoneDir = join(roadmapDir, 'milestones');
  console.log(`\n  ${c.bold}Roadmap sync${c.reset} ${c.dim}milestone pages, hub, roadmap index, ROADMAP.md${c.reset}\n`);

  const files = (await readdir(milestoneDir)).filter((f) => /^v0-1-.*\.mdx?$/.test(f));
  const ordered = files.map((f) => f.replace(/\.mdx?$/, '')).sort((a, b) => compareKeys(versionKey(a), versionKey(b)));
  const known = new Set(ordered);
  const errors = [];

  // status[slug] = [{source, file, line, glyph}]
  const status = new Map(ordered.map((s) => [s, []]));
  const add = (source, file, row) => status.get(row.slug)?.push({ source, file, line: row.line, glyph: row.glyph });

  // 1. Milestone pages.
  for (const f of files) {
    const slug = f.replace(/\.mdx?$/, '');
    const rel = `docs/src/content/docs/reference/roadmap/milestones/${f}`;
    const lines = (await readFile(join(milestoneDir, f), 'utf8')).split('\n');
    const at = lines.findIndex((l) => /^##\s+Status\s*$/.test(l));
    let found = null;
    if (at >= 0) {
      for (let i = at + 1; i < lines.length; i += 1) {
        if (/^#{1,2}\s/.test(lines[i])) break;
        if (lines[i].trim()) {
          found = { line: i + 1, glyph: firstGlyph(lines[i]) };
          break;
        }
      }
    }
    if (!found || !found.glyph) {
      errors.push({ file: rel, line: found?.line ?? 0, text: 'no status glyph on the first line under "## Status"' });
      continue;
    }
    add('page', rel, { slug, ...found });
  }

  // 2. Hub, 3. roadmap index, 4. ROADMAP.md.
  const sources = [
    { name: 'hub', rel: 'docs/src/content/docs/reference/roadmap/milestones/index.mdx', cell: 'last' },
    { name: 'roadmap', rel: 'docs/src/content/docs/reference/roadmap/index.mdx', cell: 'second' },
    { name: 'ROADMAP.md', rel: 'ROADMAP.md', cell: 'second' },
  ];
  const listed = {};
  for (const src of sources) {
    let text = '';
    try {
      text = await readFile(resolve(repoRoot, src.rel), 'utf8');
    } catch {
      errors.push({ file: src.rel, line: 0, text: 'file is missing' });
      continue;
    }
    const { rows, active } = readTable(text, known, ordered, src.cell);
    listed[src.name] = new Set(rows.map((r) => r.slug));
    for (const row of rows) {
      if (!row.glyph) errors.push({ file: src.rel, line: row.line, text: `${displayId(row.slug)}: no status glyph in the status cell` });
      else add(src.name, src.rel, row);
    }
    src.active = active;
  }

  // Disagreements: compare every source against the milestone page (the
  // milestone's own record), or against the hub when the page has none.
  let compared = 0;
  for (const slug of ordered) {
    const entries = status.get(slug);
    const ref = entries.find((e) => e.source === 'page') ?? entries.find((e) => e.source === 'hub');
    if (!ref) continue;
    for (const e of entries) {
      if (e === ref) continue;
      compared += 1;
      if (e.glyph !== ref.glyph) {
        errors.push({
          file: e.file,
          line: e.line,
          text: `${displayId(slug)} is ${e.glyph} ${GLYPH_NAME[e.glyph]} here but ${ref.glyph} ${GLYPH_NAME[ref.glyph]} in ${ref.file}:${ref.line}`,
        });
      }
    }
    if (listed.hub && !listed.hub.has(slug)) {
      errors.push({ file: sources[0].rel, line: 0, text: `${displayId(slug)} has a milestone page but no row in the hub` });
    }
    const inRoadmap = listed.roadmap?.has(slug);
    const inMirror = listed['ROADMAP.md']?.has(slug);
    if (listed.roadmap && listed['ROADMAP.md'] && inRoadmap !== inMirror) {
      errors.push({
        file: inRoadmap ? 'ROADMAP.md' : sources[1].rel,
        line: 0,
        text: `${displayId(slug)} is listed in ${inRoadmap ? 'the roadmap index' : 'ROADMAP.md'} but not here; the two are mirrors`,
      });
    }
    if (ref.glyph === '✅') {
      for (const src of sources.slice(1)) {
        for (const a of src.active ?? []) {
          if (a.slug === slug) {
            errors.push({ file: src.rel, line: a.line, text: `${displayId(slug)} is ✅ Done but linked under an "Active" heading` });
          }
        }
      }
    }
  }

  printGrouped('Roadmap sources disagree:', errors);
  if (errors.length > 0) {
    console.log(
      `  ${c.dim}The milestone page is the record; flip the hub, the roadmap index and\n`
      + `  ROADMAP.md to match it in the same change.${c.reset}\n`,
    );
  }
  printSummary(compared - errors.filter((e) => e.text.includes(' here but ')).length, errors.length,
    `${ordered.length} milestones, ${compared} cross-source comparisons`);
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n  ${c.red}Fatal:${c.reset} ${err.message}\n`);
  process.exit(1);
});
