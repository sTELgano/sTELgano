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
    name: "unit",
    // Only the pure-function tests. Worker/DO runtime tests live
    // under test/worker/** and are handled by
    // vitest.workers.config.ts via the workspace root.
    include: ["test/crypto/**/*.test.ts", "test/lib/**/*.test.ts", "test/client/**/*.test.ts"],
    globals: false,
    environment: "node",
  },
});
