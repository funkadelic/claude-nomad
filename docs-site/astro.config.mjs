// Source: starlight.astro.build/manual-setup + docs.astro.build/en/guides/deploy/github
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';

// Absolute URL of the social-card image (served from public/og.png under base).
const OG_IMAGE = 'https://funkadelic.github.io/claude-nomad/og.png';

export default defineConfig({
  site: 'https://funkadelic.github.io',
  base: '/claude-nomad', // NO trailing slash
  // GFM (tables, etc.) is on by default in Astro 7's Markdown processor for
  // both .md and .mdx, so no explicit opt-in is needed. The former
  // `markdown.gfm` flag is deprecated in v7.
  integrations: [
    starlight({
      title: 'claude-nomad',
      components: {
        // Renders the header brand as the hero's ">_ nomad" wordmark; the
        // config title above stays the plain string used in page metadata.
        SiteTitle: './src/components/SiteTitle.astro',
        // Dark mode only: force the theme and drop the light/dark picker.
        ThemeProvider: './src/components/ThemeProvider.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
      },
      customCss: ['./src/styles/theme.css'],
      favicon: '/favicon.svg',
      lastUpdated: true,
      editLink: {
        baseUrl: 'https://github.com/funkadelic/claude-nomad/edit/main/docs-site/',
      },
      plugins: [starlightLinksValidator(), starlightLlmsTxt()],
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: OG_IMAGE } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: OG_IMAGE } },
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/funkadelic/claude-nomad',
        },
        {
          icon: 'npm',
          label: 'npm',
          href: 'https://www.npmjs.com/package/claude-nomad',
        },
      ],
      sidebar: [
        { label: 'Overview', link: '/' },
        { label: 'Who is this for', link: '/who-is-this-for/' },
        { label: 'Features', link: '/features/' },
        { label: 'Quickstart', link: '/quickstart/' },
        { label: 'How it works', link: '/how-it-works/' },
        { label: 'GSD-aware sync', link: '/gsd-aware-sync/' },
        { label: 'Usage', link: '/usage/' },
        { label: 'Recipes', link: '/recipes/' },
        { label: 'Commands', link: '/commands/' },
        { label: 'Claude Code plugin', link: '/plugin/' },
        { label: 'Recovery flows', link: '/recovery/' },
        { label: 'FAQ', link: '/faq/' },
        { label: 'Contributing', link: '/contributing/' },
        { label: 'Security', link: '/security/' },
        { label: 'Privacy', link: '/privacy/' },
        { label: 'Changelog', link: '/changelog/' },
      ],
    }),
    // Do NOT add @astrojs/mdx here: Starlight bundles its own MDX integration
    // with its remark pipeline (asides, GFM). A second mdx() instance takes
    // over .mdx rendering without that pipeline, so :::note directives render
    // as literal text.
  ],
});
