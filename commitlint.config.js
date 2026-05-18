export default {
  extends: ['@commitlint/config-conventional'],
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
