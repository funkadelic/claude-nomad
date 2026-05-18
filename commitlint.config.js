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
  },
};
