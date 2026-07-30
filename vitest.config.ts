import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals:     true,
    environment: 'node',
    include:     ['src/tests/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include:  ['src/**/*.ts'],
      exclude:  ['src/tests/**'],
    },
  },
});
