import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    // `test/functions/**` is NOT included by default — it needs the functions
    // emulator too, and is run by `npm run test:functions`. Keeping the rules
    // suite emulator-light means the thing you run after every rules edit stays
    // a 3-second feedback loop.
    include: ["test/rules/**/*.test.js"],
    // All suites share ONE emulator and each calls clearFirestore() in
    // beforeEach. Running files in parallel means one suite wipes the database
    // out from under another — which surfaces as "Transaction lock timeout" or
    // "no entity to update", i.e. failures that look like rules bugs and
    // aren't. Serialize the files; the whole suite still runs in seconds.
    fileParallelism: false,
    sequence: {concurrent: false},
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
