import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';
import nova from 'starlight-theme-nova';
import starlightSiteGraph from 'starlight-site-graph';
import starlightBlog from 'starlight-blog';
import starlightAnnouncement from 'starlight-announcement';
import starlightImageZoom from 'starlight-image-zoom';
import starlightHeadingBadges from 'starlight-heading-badges';
// (Mermaid was dropped 2026-06-13: rehype-mermaid needs a headless browser at
//  build time — broke the Windows dev box AND the deploy CI — and the diagrams
//  read cleaner as hand-authored inline HTML/CSS anyway. Diagrams now live as
//  styled HTML in the .mdx pages; no build-time browser, renders everywhere.)
import starlightTagsPlugin from 'starlight-tags';
import remarkGfm from 'remark-gfm';
import remarkObsidianCallout from 'remark-obsidian-callout';
import remarkWikiLink from 'remark-wiki-link';
import rehypeExternalLinks from 'rehype-external-links';

import { BASE, SITE, sitePath } from './site-urls.mjs';
import { canonicalWebsite, legacyWebsite } from './website-compat.mjs';
import { CHANGELOG_PATH, generateChangelogPosts } from './changelog-posts.mjs';

/** The site Changelog is built from CHANGELOG.md on every dev start and build; see changelog-posts.mjs. */
const changelogPosts = {
  name: 'crosswalker-changelog-posts',
  hooks: {
    'astro:config:setup': ({ addWatchFile, logger }) => {
      logger.info(`${generateChangelogPosts()} changelog posts generated from CHANGELOG.md`);
      addWatchFile(CHANGELOG_PATH);
    },
  },
};

export default defineConfig({
  site: SITE,
  base: BASE,
  // Pinned off Astro's 4321 default to avoid cross-project port collisions
  // (multiple Astro sites on this machine). Applies to dev AND preview.
  server: { port: 14321 },

  // Image optimization is switched OFF because this site has no images to
  // optimize. Verified 2026-08-21: the entire docs source contains exactly one
  // image file, a 12 KB logo in public/, which Astro copies verbatim without
  // touching the image pipeline. Nothing anywhere imports `astro:assets` or the
  // <Image> component.
  //
  // Astro's default image service instantiates `sharp` regardless. sharp is a
  // native module that allocates large decode buffers, so the build was paying a
  // substantial memory cost to process nothing. That is invisible on an idle
  // machine and actively harmful here: this workstation runs several agent
  // sessions and another project against a shared cgroup, and the docs build was
  // reaching roughly 3 GB of a 5 GB limit, forcing local builds to be abandoned
  // and deferred to CI.
  //
  // If real images are ever added and need resizing or format conversion, delete
  // this block to restore the default sharp service — and re-measure peak RSS at
  // the same time, because that is the cost being reintroduced.
  image: {
    service: { entrypoint: 'astro/assets/services/noop' },
  },
  vite: {
    plugins: [tailwindcss()],
    define: {
      'process.platform': '"browser"',
      'process.version': '"v0.0.0"',
      'process.env': '{}',
    },
    server: {
      // Allow access from Docker / MCP browser / LAN / Tailscale / cross-machine previews.
      // Vite 6+ blocks non-localhost Host headers by default — this opens it back up.
      // Safe for local dev only; production builds are served as static files.
      allowedHosts: true,
      // NOTE: a polling watcher (usePolling/interval) used to live here because
      // the vault sat on a Windows drive mounted into WSL, where inotify events
      // were silently dropped and the dev server served stale content. The dev
      // machine moved to native Linux (ext4) on 2026-08-19, where inotify is
      // reliable, so polling was removed — it only cost CPU. Restore it if this
      // repo is ever edited over a network mount or a WSL drvfs path again.
    },
  },
  markdown: {
    // remark-gfm explicitly first: the @astrojs/mdx pipeline stopped
    // auto-applying GFM (tables, strikethrough, etc.) to .mdx files after a
    // dependency bump — plain .md kept it, .mdx lost it. Adding it here
    // restores GFM tables for both .md and .mdx.
    remarkPlugins: [
      remarkGfm,
      remarkObsidianCallout,
      [remarkWikiLink, { aliasDivider: '|' }],
    ],
    rehypePlugins: [
      [rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }],
    ],
  },
  integrations: [
    changelogPosts,
    canonicalWebsite(),
    starlight({
      title: 'Crosswalker',
      logo: {
        src: './public/logo.svg',
      },
      favicon: '/favicon.svg',
      description: 'Import structured ontologies into Obsidian with folder structures, typed links, and metadata',
      lastUpdated: true,
      components: {
        MobileMenuFooter: './src/components/MobileMenuFooter.astro',
        PageTitle: './src/components/PageTitle.astro',
      },
      editLink: {
        baseUrl: 'https://github.com/cybersader/crosswalker/edit/main/docs/',
      },
      plugins: [
        starlightAnnouncement({
          announcements: [{
            id: 'early-alpha',
            content: '🚧 Early alpha — building the foundation.',
            link: { text: 'See the roadmap →', href: sitePath('/reference/roadmap/') },
            variant: 'caution',
            dismissible: true,
          }],
        }),
        nova({
          nav: [
            { label: 'Docs', href: sitePath('/getting-started/installation/') },
            { label: 'Blog', href: sitePath('/blog/') },
          ],
        }),
        starlightSiteGraph(),
        starlightBlog({
          title: 'Changelog',
          prefix: 'blog',
        }),
        starlightImageZoom(),
        starlightHeadingBadges(),
        starlightTagsPlugin(),
      ],
      customCss: [
        './src/styles/global.css',
        './src/styles/brand.css',
      ],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/cybersader/crosswalker' },
      ],
      sidebar: [
        {
          label: 'Getting started',
          autogenerate: { directory: 'getting-started' },
        },
        {
          label: 'Features',
          autogenerate: { directory: 'features' },
        },
        {
          label: 'Examples',
          autogenerate: { directory: 'examples', collapsed: true },
        },
        {
          label: 'Concepts',
          autogenerate: { directory: 'concepts', collapsed: true },
        },
        {
          label: 'Design',
          autogenerate: { directory: 'design' },
        },
        {
          label: 'Agent context & exploration',
          autogenerate: { directory: 'agent-context', collapsed: true },
        },
        {
          label: 'Development',
          autogenerate: { directory: 'development' },
        },
        {
          label: 'Reference',
          autogenerate: { directory: 'reference', collapsed: true },
        },
      ],
    }),
    legacyWebsite(),
  ],
});
