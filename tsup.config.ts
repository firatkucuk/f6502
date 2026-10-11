import { defineConfig } from 'tsup';

// tsup's declaration build still passes `baseUrl` to the compiler, which TypeScript 6 reports as
// a deprecation error; the override silences it for that build only.
const dts = { compilerOptions: { ignoreDeprecations: '6.0' } };

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts,
    clean: true,
    target: 'es2022',
    outDir: 'dist',
    tsconfig: 'tsconfig.browser.json',
  },
  {
    entry: { 'f6502.min': 'src/index.ts' },
    format: ['iife'],
    globalName: 'F6502',
    minify: true,
    target: 'es2022',
    outDir: 'dist',
    tsconfig: 'tsconfig.browser.json',
    outExtension: () => ({ js: '.js' }),
  },
]);
