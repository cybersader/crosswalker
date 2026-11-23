import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateChangelogPosts, parseChangelog, renderPost, rewriteLinks } from '../changelog-posts.mjs';

const SAMPLE = `# Changelog

## [Unreleased] — v0.1 implementation in progress (2026-05-04 → present)

### Added: \`cw\` report (2026-11-21)

- **New.** See [the spec](docs/spec.mdx), [site](https://crosswalker.io/a/) and [above](#fixed-x).

### Fixed: one thing (2026-11-21, SchemaVer 1.2.0)

Second entry on the same day.

### Added: same title (2026-11-20)

One.

### Added: same title (2026-11-20)

Two.

### Major architectural decisions during implementation phase

Undated summary, not a post.

## [0.1.6] - 2026-10-02

### Added
- Release notes.

## [0.1.0-mvp-scaffold] - 2026-04-02

Covered by a hand-written post.
`;

test('dated entries and releases become posts, newest first within a day', () => {
  const { posts, undated } = parseChangelog(SAMPLE);
  assert.deepEqual(undated, []);
  assert.deepEqual(posts.map(p => p.slug), [
    '2026-11-21-added-cw-report',
    '2026-11-21-fixed-one-thing',
    '2026-11-20-added-same-title',
    '2026-11-20-added-same-title-2',
    '2026-10-02-prerelease-0-1-6',
  ]);
  assert.equal(posts[1].title, 'Fixed: one thing');
  assert.equal(posts[0].order, 0);
  assert.equal(posts[1].order, 1);
  assert.equal(posts[4].kind, 'release');
  assert.match(posts[4].body, /Release notes/);
  assert.ok(!posts.some(p => /Undated summary|hand-written/.test(p.body)));
});

test('rendered posts are valid frontmatter with plain titles and an ordering time', () => {
  const [first, second] = parseChangelog(SAMPLE).posts;
  const a = renderPost(first);
  assert.match(a, /^---\ntitle: "Added: cw report"\n/);
  assert.match(a, /date: 2026-11-21T23:59:59Z/);
  assert.match(renderPost(second), /date: 2026-11-21T23:59:58Z/);
  assert.match(a, /description: "New\. See the spec, site and above\."/);
});

test('repository links point at GitHub; web and anchor links are kept usable', () => {
  const out = rewriteLinks('[a](docs/x.mdx) [b](https://crosswalker.io/a/) [c](#y) [d](/concepts/z/) [e](../CHANGELOG.md)');
  assert.equal(out, '[a](https://github.com/cybersader/crosswalker/blob/main/docs/x.mdx) [b](https://crosswalker.io/a/) [c](https://github.com/cybersader/crosswalker/blob/main/CHANGELOG.md#y) [d](/concepts/z/) [e](https://github.com/cybersader/crosswalker/blob/main/CHANGELOG.md)');
});

test('a typed entry without a date stops generation and names the line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-changelog-'));
  const source = join(dir, 'CHANGELOG.md');
  writeFileSync(source, SAMPLE.replace('### Fixed: one thing (2026-11-21, SchemaVer 1.2.0)', '### Fixed: one thing'));
  assert.throws(() => generateChangelogPosts({ changelogPath: source, outputDir: join(dir, 'out') }), /line 9: ### Fixed: one thing/);
});

test('generation replaces the output folder with exactly the current posts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-changelog-'));
  const source = join(dir, 'CHANGELOG.md');
  const out = join(dir, 'out');
  writeFileSync(source, SAMPLE);
  assert.equal(generateChangelogPosts({ changelogPath: source, outputDir: out }), 5);
  writeFileSync(join(out, 'stale.md'), 'old');
  generateChangelogPosts({ changelogPath: source, outputDir: out });
  assert.deepEqual(readdirSync(out).sort(), parseChangelog(SAMPLE).posts.map(p => `${p.slug}.md`).sort());
  assert.match(readFileSync(join(out, '2026-10-02-prerelease-0-1-6.md'), 'utf8'), /title: "Prerelease 0\.1\.6"/);
});
