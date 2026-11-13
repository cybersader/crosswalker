import { test, expect } from '@playwright/test';

const ORIGIN = 'https://crosswalker.io';
const DEEP = '/getting-started/installation/';

for (const route of ['/', DEEP, '/blog/', '/tags/']) {
  test(`canonical metadata and assets: ${route}`, async ({ page }, testInfo) => {
    const failures: string[] = [];
    page.on('response', response => {
      if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
    });
    page.on('requestfailed', request => failures.push(request.url()));
    expect((await page.goto(route))?.status()).toBe(200);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', ORIGIN + route);
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', ORIGIN + route);
    const legacyUrls = await page.locator('[href], [src], [srcset]').evaluateAll(elements =>
      elements.filter(el => !el.closest('pre, code')).flatMap(el => ['href', 'src', 'srcset'].flatMap(name => {
        const value = el.getAttribute(name) || '';
        return /(?:^|[,\s])(?:https:\/\/cybersader\.github\.io)?\/[cC]rosswalker(?:\/|$)/.test(value) ? [value] : [];
      })));
    expect(legacyUrls).toEqual([]);
    expect(failures).toEqual([]);
    if (route === '/') {
      for (const theme of ['light', 'dark']) {
        await page.locator('html').evaluate((html, value) => html.setAttribute('data-theme', value), theme);
        await page.screenshot({ path: testInfo.outputPath(`canonical-${theme}.png`) });
      }
    }
  });
}

for (const prefix of ['/crosswalker', '/Crosswalker']) {
  for (const route of ['/', DEEP, '/blog/', '/tags/']) {
    test(`legacy navigation preserves suffix: ${prefix}${route}`, async ({ page, request }) => {
      const incoming = prefix + route + '?from=old%2Flink#_top';
      const alias = await request.get(incoming);
      expect(alias.status()).toBe(200); // static HTML compatibility, not HTTP 301
      expect(await alias.text()).toContain(`rel="canonical" href="${ORIGIN}${route}"`);
      await page.goto(incoming);
      await page.waitForURL(url => url.pathname === route && url.search === '?from=old%2Flink' && url.hash === '#_top');
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', ORIGIN + route);
    });
  }
  test(`legacy SVG assets stay assets: ${prefix}`, async ({ request }) => {
    for (const asset of ['logo.svg', 'obsidian-icon.svg', 'notion-icon.svg', 'favicon.svg']) {
      const canonical = await request.get('/' + asset);
      const legacy = await request.get(prefix + '/' + asset);
      expect(canonical.status()).toBe(200);
      expect(legacy.status()).toBe(200);
      expect(legacy.headers()['content-type']).toContain('image/svg+xml');
      expect(await legacy.body()).toEqual(await canonical.body());
    }
  });
}

test('navigation and recent updates point directly to root routes', async ({ page }) => {
  await page.goto('/');
  const docsLink = page.locator('header nav').getByRole('link', { name: 'Docs', exact: true }).first();
  await expect(docsLink).toHaveAttribute('href', DEEP);
  await docsLink.click();
  await expect(page).toHaveURL(new RegExp(DEEP + '$'));
  await page.goto('/');
  const update = page.locator('.cw-recent-updates-body a').first();
  const href = await update.getAttribute('href');
  expect(href).toMatch(/^\/(?![cC]rosswalker\/)/);
  await update.click();
  await expect(page).toHaveURL(new RegExp(href!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
});

test('search results target canonical pages and navigate successfully', async ({ page, request }) => {
  await page.goto('/');
  // Exercise the same built Pagefind index the Starlight search UI imports.
  const urls = await page.evaluate(async () => {
    const modulePath = '/pagefind/pagefind.js';
    const pagefind = await import(/* @vite-ignore */ modulePath);
    const search = await pagefind.search('installation');
    return Promise.all(search.results.slice(0, 5).map(async (result: { data: () => Promise<{ url: string }> }) => (await result.data()).url));
  });
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) {
    expect(url).not.toMatch(/\/[cC]rosswalker(?:\/|$)/);
    expect((await request.get(url)).status()).toBe(200);
  }
  await page.goto(urls[0]);
  await expect(page.locator('h1')).toBeVisible();
});

test('graph, sitemap and generated tag routes contain no legacy pages', async ({ request }) => {
  const graphResponse = await request.get('/sitegraph/sitemap.json');
  expect(graphResponse.status()).toBe(200);
  const graph = await graphResponse.json();
  const paths = Object.entries(graph).flatMap(([key, entry]: [string, any]) => [key, ...(entry.links || []), ...(entry.backlinks || [])]);
  expect(paths).not.toContain('');
  expect(graph['/']).toMatchObject({ exists: true, title: 'Crosswalker' });
  expect(graph['/'].backlinks.length).toBeGreaterThan(0);
  for (const backlink of graph['/'].backlinks) expect(graph[backlink].links).toContain('/');
  expect(paths.filter(path => /^(?:\/|https:\/\/cybersader.github.io\/)?[cC]rosswalker(?:\/|$)/.test(path))).toEqual([]);
  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain('Sitemap: https://crosswalker.io/sitemap-index.xml');
  const index = await request.get('/sitemap-index.xml');
  expect(index.status()).toBe(200);
  const sitemapLocations = [...(await index.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
  expect(sitemapLocations.length).toBeGreaterThan(0);
  let generatedTag: string | undefined;
  for (const location of sitemapLocations) {
    expect(location).toMatch(/^https:\/\/crosswalker\.io\//);
    const sitemap = await request.get(new URL(location).pathname);
    expect(sitemap.status()).toBe(200);
    const xml = await sitemap.text();
    expect(xml).not.toMatch(/https:\/\/crosswalker\.io\/[cC]rosswalker\//);
    expect(xml).not.toContain('cybersader.github.io');
    generatedTag ||= [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => new URL(match[1]).pathname).find(path => path.startsWith('/tags/') && path !== '/tags/');
  }
  expect(generatedTag).toBeTruthy();
  for (const prefix of ['', '/crosswalker', '/Crosswalker']) {
    const result = await request.get(prefix + generatedTag!);
    expect(result.status()).toBe(200);
  }
});
