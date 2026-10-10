import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    target: 'es2022',
    outDir: 'dist',
  },
  {
    entry: { 'f6502.min': 'src/index.ts' },
    format: ['iife'],
    globalName: 'F6502',
    minify: true,
    target: 'es2022',
    outDir: 'dist',
    outExtension: () => ({ js: '.js' }),
  },
]);
