import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aliasHtml, legacyAliases, normalizeHtml, sitePath, siteUrl } from '../site-urls.mjs';
import { normalizeGraph } from '../website-compat.mjs';

test('website URL boundaries and byte-preserved suffixes', () => {
  for (const prefix of ['/crosswalker', '/Crosswalker', 'https://cybersader.github.io/crosswalker', 'https://cybersader.github.io/Crosswalker']) {
    assert.equal(sitePath(prefix + '/concepts/problem/?q=a%2Fb#why'), '/concepts/problem/?q=a%2Fb#why');
    assert.equal(sitePath(prefix), '/');
    assert.equal(sitePath(prefix + '?x=1#intro'), '/?x=1#intro');
  }
  assert.equal(siteUrl('/Crosswalker/blog/'), 'https://crosswalker.io/blog/');
  for (const value of ['https://github.com/cybersader/crosswalker/', 'https://cybersader.github.io/other/', 'https://crosswalker.io.evil/path', '/crosswalker-extra/page', '//example.com/crosswalker/', 'https://crosswalker.dev/spec/tier1/v1', 'urn:crosswalker:source', '#anchor', 'relative/path']) {
    assert.equal(sitePath(value), value);
  }
  assert.equal(sitePath('https://crosswalker.io/concepts/problem/'), '/concepts/problem/');
});

test('rendered Markdown, raw MDX HTML/SVG, CSS and image sources normalize, not examples', () => {
  const html = `<a href="/crosswalker/a/?x=1#b" title="a > b">link</a><image href='/Crosswalker/logo.svg'/><img src=/crosswalker/logo.png srcset="/crosswalker/logo.png 1x, /Crosswalker/logo.svg 2x"><div style="background:url('/crosswalker/logo.svg')"></div><style>.logo{background:url(/Crosswalker/logo.svg)}</style>`;
  const normalized = normalizeHtml(html);
  assert.ok(normalized.includes('href="/a/?x=1#b"'));
  assert.ok(normalized.includes("href='/logo.svg'"));
  assert.ok(normalized.includes('src=/logo.png srcset="/logo.png 1x, /logo.svg 2x"'));
  assert.ok(normalized.includes("url('/logo.svg')"));
  assert.ok(normalized.includes('url(/logo.svg)'));
  const preserved = `<pre><code>&lt;a href="/crosswalker/example/"&gt;</code></pre><script>const href="/crosswalker/not-a-link/";</script><!-- href="/crosswalker/comment/" --><p>/crosswalker/prose/</p><a href="https://github.com/cybersader/crosswalker/">GitHub</a>`;
  assert.equal(normalizeHtml(preserved), preserved);
  assert.equal(normalizeHtml(normalized), normalized);
});

test('canonical metadata stays absolute and non-URL attribute/CSS strings stay verbatim', () => {
  assert.equal(normalizeHtml('<link rel="canonical" href="https://crosswalker.io/blog/">'), '<link rel="canonical" href="https://crosswalker.io/blog/">');
  assert.equal(normalizeHtml('<link href="https://cybersader.github.io/Crosswalker/blog/" rel="canonical">'), '<link href="https://crosswalker.io/blog/" rel="canonical">');
  const arbitrary = `<a title="try href='/crosswalker/example/'" data-example="src='/Crosswalker/no.svg'" href="/crosswalker/blog/">link</a>`;
  assert.equal(normalizeHtml(arbitrary), arbitrary.replace('href="/crosswalker/blog/"', 'href="/blog/"'));
  const css = `<style>/* url(/crosswalker/comment.svg) */ .sample::after{content:"url(/Crosswalker/example.svg)"}.real{background:url('/crosswalker/logo.svg')}</style>`;
  assert.equal(normalizeHtml(css), css.replace("url('/crosswalker/logo.svg')", "url('/logo.svg')"));
});

test('aliases are finite, canonical, generated-route agnostic and loop-free', () => {
  const aliases = legacyAliases(['/', '/blog/', '/tags/import/', '/blog/tags/releases/', '/blog/']);
  assert.equal(aliases.length, 8);
  assert.deepEqual(aliases[0], { from: '/crosswalker/', to: '/' });
  assert.ok(aliases.some(a => a.from === '/Crosswalker/blog/tags/releases/'));
  assert.throws(() => legacyAliases(['/crosswalker/blog/']));
  assert.throws(() => aliasHtml('//external.test/'));
  const html = aliasHtml('/concepts/problem/');
  assert.ok(html.includes('href="https://crosswalker.io/concepts/problem/"'));
  assert.ok(html.includes('location.search + location.hash'));
  assert.ok(html.includes('noindex,follow'));
  assert.ok(!html.includes('http-equiv="refresh"')); // no competing redirect drops query/hash
});

test('graph canonical entries absorb unresolved old-prefix links without losing metadata', () => {
  const graph = normalizeGraph({
    'crosswalker/concepts/problem/': { exists: false, title: 'Old', links: ['Crosswalker/blog/'] },
    'concepts/problem/': { exists: true, title: 'Problem', backlinks: ['crosswalker/'] },
  });
  assert.deepEqual(Object.keys(graph), ['concepts/problem/']);
  assert.equal(graph['concepts/problem/'].title, 'Problem');
  assert.deepEqual(graph['concepts/problem/'].links, ['blog/']);
  assert.deepEqual(graph['concepts/problem/'].backlinks, ['/']);
});

test('graph homepage aliases merge into the real root identity and retain backlinks', () => {
  const graph = normalizeGraph({
    'crosswalker/': { exists: false, title: 'hero visual', backlinks: ['log/one/'] },
    '/': { exists: true, title: 'Crosswalker', links: ['concepts/problem/'] },
    'log/one/': { exists: true, title: 'Log', links: ['crosswalker/'] },
  });
  assert.equal(graph['/'].exists, true);
  assert.equal(graph['/'].title, 'Crosswalker');
  assert.deepEqual(graph['/'].backlinks, ['log/one/']);
  assert.deepEqual(graph['/'].links, ['concepts/problem/']);
  assert.deepEqual(graph['log/one/'].links, ['/']);
  assert.ok(!Object.hasOwn(graph, ''));
  for (const entry of Object.values(graph)) {
    assert.ok(!entry.links.includes('') && !entry.backlinks.includes(''));
  }
});
