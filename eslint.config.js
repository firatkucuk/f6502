import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', '.testdata', 'node_modules', 'scripts', '.superpowers', '.playwright-mcp'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
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
    files: [
      'website/js/{c64script-grammar,code-hash,editor-render,home-slideshow,playground,playground-examples,showcase,showcase-list,try-now}.js',
    ],
    languageOptions: {
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        history: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        File: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
      },
    },
  },
);
