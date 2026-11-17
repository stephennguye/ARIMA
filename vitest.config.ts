import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['plugins/arima/scripts/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
