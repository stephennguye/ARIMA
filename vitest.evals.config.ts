import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
    exclude: ['**/node_modules/**', '.claude/**', 'tmp/**'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
