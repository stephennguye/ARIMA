import { defineConfig } from 'vitest/config';

// The live tier: runs against REAL Notion (and later GitHub). Never part of `npm test` or CI.
// Run by hand:  ARIMA_LIVE=1 ARIMA_NOTION_TOKEN=... ARIMA_LIVE_PROJECT=<dev project dir> npm run test:live
export default defineConfig({
  test: {
    include: ['plugins/arima/scripts/test-live/**/*.live.test.ts'],
    exclude: ['**/node_modules/**', '.claude/**', 'tmp/**'],
    environment: 'node',
    testTimeout: 120_000,
    fileParallelism: false,
  },
});
