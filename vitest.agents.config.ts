import { defineConfig } from 'vitest/config';

// Real-agent evals: they call `claude -p` and cost money, so they are never part of `npm run eval` or CI.
// Run by hand:  npm run eval:agents
export default defineConfig({
  test: {
    include: ['evals/agents/**/*.eval.ts'],
    exclude: ['**/node_modules/**', '.claude/**', 'tmp/**'],
    environment: 'node',
    testTimeout: 600_000,
    fileParallelism: false,
    passWithNoTests: true,
  },
});
