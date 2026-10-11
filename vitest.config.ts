import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The slowest unit test (a showcase booted 40 times) takes about 30 s; the conformance suite
  // overrides this on the command line (see `test:conformance` in package.json).
  test: { include: ['test/**/*.test.ts'], testTimeout: 120_000 },
});
