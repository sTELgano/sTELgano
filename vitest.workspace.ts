// SPDX-License-Identifier: AGPL-3.0-only
//
// Vitest workspace — two parallel projects.
//   1. Pure-function tests (crypto, paystack helpers, state
//      machine). Node env. Fast.
//   2. Worker/DO runtime tests. workerd via
//      @cloudflare/vitest-pool-workers.
//
// `npm test` runs both. For a tight inner loop, target one via
//   npx vitest --project unit     (crypto + paystack)
//   npx vitest --project workers  (routes + DO + D1 lib)

export default ["./vitest.config.ts", "./vitest.workers.config.ts"];
