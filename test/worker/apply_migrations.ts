// SPDX-License-Identifier: AGPL-3.0-only
//
// Vitest setup file for the Workers pool — applies all D1 migrations
// from ./migrations/ to the ephemeral test DB before any test runs.
//
// The migrations list is built by readD1Migrations() in
// vitest.workers.config.ts and injected as a TEST_MIGRATIONS binding;
// this file consumes that binding via `cloudflare:test`.
//
// Uses beforeAll at the top level so the schema is prepared exactly
// once per isolated storage realm (vitest-pool-workers creates one
// realm per test file in singleWorker mode).

import { beforeAll } from "vitest";
// @ts-expect-error — see healthz.test.ts for why this expect-error lives here.
import { applyD1Migrations, env } from "cloudflare:test";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
