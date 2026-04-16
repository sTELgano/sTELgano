# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

import Config

# Configure your database
#
# The MIX_TEST_PARTITION environment variable can be used
# to provide built-in test partitioning in CI environment.
# Run `mix help test` for more information.
config :stelgano, Stelgano.Repo,
  username: "postgres",
  password: "postgres",
  hostname: "localhost",
  database: "stelgano_test#{System.get_env("MIX_TEST_PARTITION")}",
  pool: Ecto.Adapters.SQL.Sandbox,
  pool_size: System.schedulers_online() * 2

# We don't run a server during test. If one is required,
# you can enable the server option below.
config :stelgano, StelganoWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "lSPz0kGZEV/33AzaLxD4+JEY5EMi0rQseOq6TVBtH9sT9y2vTnpIT2hw1mWGswRU",
  server: false

# In test we don't send emails
config :stelgano, Stelgano.Mailer, adapter: Swoosh.Adapters.Test

# Disable swoosh api client as it is only required for production adapters
config :swoosh, :api_client, false

# Print only warnings and errors during test
config :logger, level: :warning

# Initialize plugs at runtime for faster test compilation
config :phoenix, :plug_init_mode, :runtime

# Enable helpful, but potentially expensive runtime checks
config :phoenix_live_view,
  enable_expensive_runtime_checks: true

# Sort query params output of verified routes for robust url comparisons
config :phoenix,
  sort_verified_routes_query_params: true

# Oban — inline mode for tests (jobs run synchronously)
config :stelgano, Oban, testing: :inline

# Rate limiter — disabled in test
config :plug_attack, :storage, {PlugAttack.Storage.Ets, :stelgano_rate_limiter_test}

# Admin dashboard credentials for tests
config :stelgano, :admin_credentials,
  username: "test_admin",
  password: "test_password"
