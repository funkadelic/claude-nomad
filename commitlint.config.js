export default {
  extends: ['@commitlint/config-conventional'],
  // conventional-changelog-conventionalcommits types the type as `\w*`, which
  // cannot match the hyphen in `deps-dev`. Without this, `type-enum` below
  // lists `deps-dev` but the parser never produces it, so a `deps-dev:`
  // commit fails with a misleading "type may not be empty". This is the
  // preset's own pattern with that one class widened to `[\w-]*`; the rest,
  // including the `!?` breaking-change marker, is copied verbatim, since
  // replacing parserOpts wholesale would otherwise drop `feat!:` support.
  // .github/workflows/pr-title.yml widens the same class for the same reason
  // on the squash subject, and is the server-side half of this gate.
  parserPreset: {
    parserOpts: {
      headerPattern: /^([\w-]*)(?:\((.*)\))?!?: (.*)$/,
      headerCorrespondence: ['type', 'scope', 'subject'],
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
