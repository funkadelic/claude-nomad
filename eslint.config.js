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
  sonarjs.configs.recommended,
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
      // sonarjs.configs.recommended is enabled above so local lint mirrors the
      // ESLint-equivalent SonarCloud rules and bugs like S2871 (a comparator-less
      // sort) are caught pre-push instead of only server-side. The rules below are
      // turned back off as accepted-risk or false-positive for this codebase:
      // S4036 exec-from-PATH: this is a single-user CLI wrapping the user's own
      // git/gitleaks binaries and is Marked Safe in SonarCloud (see the standing
      // hotspot policy); flagging every execFileSync locally is pure noise.
      'sonarjs/no-os-command-from-path': 'off',
      // Temp-dir use (os.tmpdir, ~/.cache) is legitimate and intentional here.
      'sonarjs/publicly-writable-directories': 'off',
      // False-positive on the intentional defensive runtime-null guards this code
      // uses on parsed JSON (e.g. `parsed === null` where the static type omits
      // null but JSON.parse can still yield it). SonarCloud does not flag these.
      'sonarjs/different-types-comparison': 'off',
      // Stylistic: this codebase intentionally returns union types from several
      // helpers; "always return the same type" is not a defect signal here.
      'sonarjs/function-return-type': 'off',
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
    files: ['**/*.test.ts'],
    // These sonarjs rules stay ON for production src; they are low-value or
    // deliberately-ignored noise in test files (intentional helper duplication,
    // fixture unions, `void` on floating promises, comparator-less sorts whose
    // order is asserted directly). The bug-catching value is in src. Our tests
    // are deliberately behavior-focused with explicit per-case assertions, so
    // parameterized-tests (added in eslint-plugin-sonarjs 4.2.0) stays off too.
    rules: {
      'max-lines': 'off',
      'sonarjs/no-alphabetical-sort': 'off',
      'sonarjs/void-use': 'off',
      'sonarjs/no-identical-functions': 'off',
      'sonarjs/use-type-alias': 'off',
      'sonarjs/super-linear-regex': 'off',
      'sonarjs/no-misleading-array-reverse': 'off',
      'sonarjs/no-unused-collection': 'off',
      'sonarjs/parameterized-tests': 'off',
    },
  },
  eslintConfigPrettier,
);
