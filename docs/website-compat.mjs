import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aliasHtml, legacyAliases, LEGACY_PREFIXES, normalizeHtml, sitePath } from './site-urls.mjs';

async function filesUnder(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Graph plugin reads preserved Markdown as well as rendered HTML. Normalize URL
 * slots only, merging the old unresolved entries with actual canonical pages. */
export function normalizeGraph(graph) {
  const path = value => value.startsWith('/') || /^https?:/.test(value)
    ? sitePath(value) : (sitePath('/' + value).slice(1) || '/');
  const result = {};
  for (const [key, entry] of Object.entries(graph)) {
    const canonical = path(key);
    const previous = result[canonical];
    const preferred = previous?.exists && !entry.exists ? previous : entry;
    result[canonical] = { ...preferred };
    for (const field of ['links', 'backlinks']) {
      result[canonical][field] = [...new Set([...(previous?.[field] || []), ...(entry[field] || [])].map(path))];
    }
  }
  return result;
}

/** First integration: normalize output before Starlight search/graph build:done hooks. */
export function canonicalWebsite() {
  return {
    name: 'crosswalker-canonical-website',
    hooks: {
      'astro:config:setup': ({ addMiddleware }) => {
        addMiddleware({ entrypoint: new URL('./src/website-middleware.ts', import.meta.url), order: 'post' });
      },
      // Also handles any integration-generated HTML that bypasses middleware.
      'astro:build:generated': async ({ dir }) => {
        const root = fileURLToPath(dir);
        for (const file of await filesUnder(root)) {
          if (!file.endsWith('.html')) continue;
          const path = join(root, file);
          const html = await readFile(path, 'utf8');
          const normalized = normalizeHtml(html);
          if (html !== normalized) await writeFile(path, normalized);
        }
      },
    },
  };
}

/** Last integration: indexes see canonical pages only, never the compatibility copies. */
export function legacyWebsite() {
  return {
    name: 'crosswalker-legacy-website',
    hooks: {
      'astro:build:done': async ({ dir, pages, logger }) => {
        const root = fileURLToPath(dir);
        const routes = pages.map(({ pathname }) => '/' + pathname.replace(/^\/+/, ''))
          .filter(path => path !== '/404.html' && path !== '/404/');
        const aliases = legacyAliases(routes);
        for (const { from, to } of aliases) {
          const file = join(root, from, 'index.html');
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, aliasHtml(to));
        }
        // An image cannot use an HTML redirect. Copy public assets byte-for-byte;
        // current hashed bundles always appear at canonical /_astro URLs in HTML.
        const publicRoot = fileURLToPath(new URL('./public/', import.meta.url));
        for (const asset of await filesUnder(publicRoot)) {
          if (asset === 'CNAME' || asset.endsWith('.html')) continue;
          for (const prefix of LEGACY_PREFIXES) {
            const target = join(root, prefix, asset);
            await mkdir(dirname(target), { recursive: true });
            await copyFile(join(root, asset), target);
          }
        }
        const graphFile = join(root, 'sitegraph/sitemap.json');
        const graph = JSON.parse(await readFile(graphFile, 'utf8'));
        await writeFile(graphFile, JSON.stringify(normalizeGraph(graph)));
        logger.info(`Created ${aliases.length} legacy HTML aliases after search/sitemap/graph indexing.`);
      },
    },
  };
}
