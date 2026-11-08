import { configDefaults, defineConfig } from "vitest/config";

// Tests that boot a real D1 in Miniflare (workerd). They run as their own
// project, one file at a time, after the rest of the suite (engram#605).
// Several workerd instances at once on a busy CI runner can preempt
// miniflare's synchronous binding proxy, which then desynchronises and
// fails every later call in that file (`AssertionError: false == true` in
// fetch-sync.ts). Fixed upstream in cloudflare/workers-sdk#15552, which no
// stable miniflare release carries yet; once one does, bump miniflare and
// wrangler together and this split can go.
const MINIFLARE_TESTS = "src/**/*.d1.test.ts";

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          exclude: [...configDefaults.exclude, MINIFLARE_TESTS],
        },
      },
      {
        extends: true,
        test: {
          name: "d1",
          include: [MINIFLARE_TESTS],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
