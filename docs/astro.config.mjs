import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';
import nova from 'starlight-theme-nova';
import starlightSiteGraph from 'starlight-site-graph';
import starlightBlog from 'starlight-blog';
import starlightAnnouncement from 'starlight-announcement';
import starlightImageZoom from 'starlight-image-zoom';
import starlightHeadingBadges from 'starlight-heading-badges';
import starlightClientMermaid from '@pasqal-io/starlight-client-mermaid';
import remarkObsidianCallout from 'remark-obsidian-callout';
import remarkWikiLink from 'remark-wiki-link';
import rehypeExternalLinks from 'rehype-external-links';

export default defineConfig({
  site: 'https://cybersader.github.io',
  base: '/Crosswalker',
  vite: {
    plugins: [tailwindcss()],
  },
  markdown: {
    remarkPlugins: [
      remarkObsidianCallout,
      [remarkWikiLink, { aliasDivider: '|' }],
    ],
    rehypePlugins: [
      [rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }],
    ],
  },
  integrations: [
    starlight({
      title: 'Crosswalker',
      description: 'Import structured ontologies into Obsidian with folder structures, typed links, and metadata',
      plugins: [
        nova({
          nav: [
            { label: 'Docs', href: '/Crosswalker/getting-started/installation/' },
            { label: 'GitHub', href: 'https://github.com/cybersader/Crosswalker' },
          ],
        }),
        // starlightClientMermaid(),
      ],
      customCss: [
        './src/styles/global.css',
        './src/styles/brand.css',
      ],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/cybersader/Crosswalker' },
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
          label: 'Concepts',
          autogenerate: { directory: 'concepts' },
        },
        {
          label: 'Design',
          autogenerate: { directory: 'design' },
        },
        {
          label: 'Agent context & exploration',
          autogenerate: { directory: 'agent-context' },
        },
        {
          label: 'Development',
          autogenerate: { directory: 'development' },
        },
        {
          label: 'Reference',
          autogenerate: { directory: 'reference' },
        },
      ],
    }),
  ],
});
