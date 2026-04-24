// SPDX-License-Identifier: AGPL-3.0-only
//
// Vitest project config for Worker/DO runtime tests. Separated from
// the top-level vitest.config.ts so the pure-function tests
// (test/crypto/**, test/lib/**) stay fast and don't spin up a
// workerd instance for every run.
//
// How it hangs together:
//   - defineWorkersConfig wraps defineConfig and installs the
//     vitest-pool-workers pool.
//   - poolOptions.workers.wrangler.configPath points at
//     ./wrangler.toml so the test pool inherits our [vars],
//     [[durable_objects.bindings]], and [[d1_databases]] blocks.
//   - Tests in test/worker/** get a real workerd instance with
//     those bindings. They can call the worker's fetch handler
//     via cloudflare:test's SELF binding (direct route hits) or
//     instantiate DOs via env.ROOM.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default defineWorkersConfig(async () => {
  // Pre-read the migrations directory at config load time so the
  // pool can ship it to the worker as a binding. The setup file in
  // test/worker/apply_migrations.ts runs applyD1Migrations() once
  // per isolated storage realm, giving every test file a clean
  // schema without re-running the SQL per test.
  const migrations = await readD1Migrations(path.join(HERE, "migrations"));

  return {
    test: {
      include: ["test/worker/**/*.test.ts"],
      setupFiles: ["./test/worker/apply_migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          // Pages Advanced Mode puts the entrypoint at `_worker.ts`.
          // The pool needs an explicit path — it does not infer it
          // from `pages_build_output_dir` in wrangler.toml.
          main: "./_worker.ts",
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            // Ephemeral D1 per test run — populated by the
            // migrations directory so the schema matches what the
            // production database has.
            d1Databases: ["DB"],
            d1Persist: false,
            // The setup file reads this via `env.TEST_MIGRATIONS` and
            // passes it to applyD1Migrations().
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
