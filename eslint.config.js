import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'dist/**',
      '.planning/**',
      '.claude/**',
      'docs-site/**',
      '.stryker-tmp/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { sonarjs },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-definitions': 'off',
      'no-console': 'off',
      'sonarjs/cognitive-complexity': ['error', 15],
      'max-lines': ['warn', { max: 220, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['eslint.config.js', '*.config.js', '*.config.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // CommonJS scripts (e.g. scripts/verify-tarball.cjs) live outside the
    // tsconfig project graph; disable the typescript-eslint project service
    // for them, and opt them into the CommonJS globals (require, module,
    // __dirname, exports). Without projectService:false the parser rejects
    // any .cjs file the tsconfig does not enumerate.
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
      parserOptions: {
        projectService: false,
      },
    },
  },
  // Type-aware rules require the project service; .cjs files have it
  // turned off above, so disable the type-checked rule sets for them.
  // The require() ban from the stylistic type-checked preset is the whole
  // point a .cjs file is here, so it is turned off explicitly.
  {
    files: ['**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // ESM helper scripts (e.g. scripts/build.mjs) live outside the tsconfig
    // project graph; disable the typescript-eslint project service for them so
    // the parser does not reject a .mjs file the tsconfig does not enumerate.
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        projectService: false,
      },
    },
  },
  {
    // TypeScript files under scripts/ import from .mjs files which have no
    // TypeScript declarations; disable type-checked rules and project service
    // so the parser accepts files outside the tsconfig include set.
    files: ['scripts/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        projectService: false,
      },
    },
  },
  {
    files: ['src/**/*.test.ts'],
    rules: { 'max-lines': 'off' },
  },
  eslintConfigPrettier,
);
