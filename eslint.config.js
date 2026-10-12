import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const BROWSER_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  location: 'readonly',
  history: 'readonly',
  navigator: 'readonly',
  console: 'readonly',
  alert: 'readonly',
  setTimeout: 'readonly',
  File: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  fetch: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  btoa: 'readonly',
  atob: 'readonly',
  localStorage: 'readonly',
  IntersectionObserver: 'readonly',
  /** The IIFE bundle (dist/f6502.min.js) loaded by the pages. */
  F6502: 'readonly',
};

export default tseslint.config(
  { ignores: ['dist', '.testdata', 'node_modules', 'scripts', '.superpowers', '.playwright-mcp'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.browser.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  { files: ['**/*.js', '**/*.mjs'], ...tseslint.configs.disableTypeChecked },
  { files: ['test/scripts/**/*.ts'], ...tseslint.configs.disableTypeChecked },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/machine', '**/machine/*', '**/browser', '**/browser/*'],
              message: 'core/ must not import from machine/ or browser/',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/machine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/browser', '**/browser/*'],
              message: 'machine/ must not import from browser/',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['website/js/*.js'],
    languageOptions: { sourceType: 'module', globals: BROWSER_GLOBALS },
  },
  {
    // Classic (non-module) scripts.
    files: ['website/js/app.js', 'website/js/demo.js'],
    languageOptions: { sourceType: 'script' },
  },
);
