// SPDX-License-Identifier: AGPL-3.0-only
//
// Vitest config. Two-tier test runner:
//
//  - Pure-function tests (crypto, paystack helpers, state machine)
//    run in the default Node env. They're fast and don't need a
//    Worker runtime.
//
//  - Worker/DO tests (route handlers, RoomDO message dispatch, D1
//    modules) need the workerd runtime via
//    @cloudflare/vitest-pool-workers. Wired in Phase 9b when the
//    first test of that kind lands. Separated as a project so
//    `npm test` runs both but a tight inner loop can target one.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: false,
    // Most tests target web crypto / fetch / TextEncoder — all
    // available in Node 22. Explicitly pick jsdom only for
    // state-machine tests that touch sessionStorage.
    environment: "node",
    environmentMatchGlobs: [["test/client/**/*.test.ts", "jsdom"]],
  },
});
