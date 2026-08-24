import conventionalPreset from 'conventional-changelog-conventionalcommits';

// conventional-changelog-conventionalcommits types the commit type as `\w*` in
// both of its header patterns, which cannot match the hyphen in `deps-dev`.
// Without widening, `type-enum` below lists `deps-dev` but the parser never
// produces it, so a `deps-dev:` commit fails the commit-msg hook with a
// misleading "type may not be empty". The same class is widened in
// .github/workflows/pr-title.yml, which gates the squash subject server-side.
//
// The preset's own options are spread in rather than retyped, because
// commitlint REPLACES parserOpts instead of merging it: listing only the
// patterns silently drops noteKeywords, revertPattern, revertCorrespondence
// and issuePrefixes, and a dropped breakingHeaderPattern costs every type its
// BREAKING CHANGE note without failing anything.
const { parser } = await conventionalPreset();

export default {
  extends: ['@commitlint/config-conventional'],
  parserPreset: {
    parserOpts: {
      ...parser,
      headerPattern: /^([\w-]*)(?:\((.*)\))?!?: (.*)$/,
      breakingHeaderPattern: /^([\w-]*)(?:\((.*)\))?!: (.*)$/,
    },
  },
  rules: {
    // Conventional Commits keeps header tight, but bodies and footers are
    // prose. The default 100-char per-line cap encouraged ragged hard-wraps
    // that GitHub's web view then re-wrapped into narrow paragraphs. Disable
    // the per-line caps so authors can write paragraphs as long lines and
    // let the renderer soft-wrap.
    'body-max-line-length': [0],
    'footer-max-line-length': [0],

    // Extend Conventional Commits' default type list with `deps` and
    // `deps-dev` so Dependabot's PRs land in the CHANGELOG under a
    // "Dependencies" section instead of a generic "Changed" bucket.
    'type-enum': [
      2,
      'always',
      [
        'build',
        'chore',
        'ci',
        'deps',
        'deps-dev',
        'docs',
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'style',
        'test',
      ],
    ],
  },
};
