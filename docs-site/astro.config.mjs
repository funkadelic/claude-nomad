// Source: starlight.astro.build/manual-setup + docs.astro.build/en/guides/deploy/github
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://funkadelic.github.io',
  base: '/claude-nomad', // NO trailing slash
  integrations: [
    starlight({
      title: 'claude-nomad',
      customCss: ['./src/styles/theme.css'],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/funkadelic/claude-nomad',
        },
      ],
      sidebar: [
        { label: 'Overview', link: '/' },
        { label: 'Who is this for', link: '/who-is-this-for/' },
        { label: 'Quickstart', link: '/quickstart/' },
        { label: 'How it works', link: '/how-it-works/' },
        { label: 'Usage', link: '/usage/' },
        { label: 'Commands', link: '/commands/' },
        { label: 'Recovery flows', link: '/recovery/' },
        { label: 'Contributing', link: '/contributing/' },
        { label: 'Security', link: '/security/' },
        { label: 'Changelog', link: '/changelog/' },
      ],
    }),
  ],
});
