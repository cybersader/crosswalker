import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';
import nova from 'starlight-theme-nova';
import starlightSiteGraph from 'starlight-site-graph';
import starlightBlog from 'starlight-blog';
import starlightAnnouncement from 'starlight-announcement';
import starlightImageZoom from 'starlight-image-zoom';
import starlightHeadingBadges from 'starlight-heading-badges';
import rehypeMermaid from 'rehype-mermaid';
import starlightTagsPlugin from 'starlight-tags';
import remarkObsidianCallout from 'remark-obsidian-callout';
import remarkWikiLink from 'remark-wiki-link';
import rehypeExternalLinks from 'rehype-external-links';

export default defineConfig({
  site: 'https://cybersader.github.io',
  base: '/crosswalker',
  vite: {
    plugins: [tailwindcss()],
    define: {
      'process.platform': '"browser"',
      'process.version': '"v0.0.0"',
      'process.env': '{}',
    },
  },
  markdown: {
    remarkPlugins: [
      remarkObsidianCallout,
      [remarkWikiLink, { aliasDivider: '|' }],
    ],
    rehypePlugins: [
      [rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }],
      rehypeMermaid,
    ],
  },
  integrations: [
    starlight({
      title: 'Crosswalker',
      logo: {
        src: './public/logo.svg',
      },
      description: 'Import structured ontologies into Obsidian with folder structures, typed links, and metadata',
      components: {
        MobileMenuFooter: './src/components/MobileMenuFooter.astro',
      },
      editLink: {
        baseUrl: 'https://github.com/cybersader/crosswalker/edit/main/docs/',
      },
      plugins: [
        nova({
          nav: [
            { label: 'Docs', href: '/crosswalker/getting-started/installation/' },
            { label: 'Blog', href: '/crosswalker/blog/' },
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
          autogenerate: { directory: 'reference' },
        },
      ],
    }),
  ],
});
