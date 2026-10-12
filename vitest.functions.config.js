import {defineConfig} from "vitest/config";

// Separate config from the rules suite: these tests need the functions emulator
// running and wait on async trigger execution, so they are slower and are kept
// out of the default `npm test` loop. Run with `npm run test:functions`.
export default defineConfig({
  test: {
    include: ["test/functions/**/*.test.js"],
    fileParallelism: false,
    sequence: {concurrent: false},
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
