# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

import Config

config :stelgano,
  ecto_repos: [Stelgano.Repo],
  generators: [timestamp_type: :utc_datetime, binary_id: true]

config :stelgano, StelganoWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [html: StelganoWeb.ErrorHTML, json: StelganoWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: Stelgano.PubSub,
  live_view: [signing_salt: "x577Gc2L"]

config :stelgano, Stelgano.Mailer, adapter: Swoosh.Adapters.Local

# Oban — background job configuration
# Queues:
#   :maintenance  — low-priority cleanup jobs (expire TTL rooms)
config :stelgano, Oban,
  repo: Stelgano.Repo,
  plugins: [
    Oban.Plugins.Pruner,
    {Oban.Plugins.Cron,
     crontab: [
       # Expire rooms whose TTL has passed — every hour
       {"0 * * * *", Stelgano.Jobs.ExpireTtlRooms},
       # Expire unredeemed extension tokens — daily at 03:00 UTC
       {"0 3 * * *", Stelgano.Jobs.ExpireUnredeemedTokens}
     ]}
  ],
  queues: [maintenance: 2]

# Monetization — disabled by default for self-hosters.
# Set `enabled: true` and configure a provider to enable paid tiers.
# See `Stelgano.Monetization` module docs for full configuration reference.
config :stelgano, Stelgano.Monetization,
  enabled: true,
  free_ttl_days: 7,
  paid_ttl_days: 365,
  price_cents: 200,
  currency: "USD"

config :esbuild,
  version: "0.25.4",
  stelgano: [
    args:
      ~w(js/app.js js/workers/pbkdf2_worker.js --bundle --target=es2022 --outdir=../priv/static/assets/js --external:/fonts/* --external:/images/* --alias:@=.),
    cd: Path.expand("../assets", __DIR__),
    env: %{"NODE_PATH" => [Path.expand("../deps", __DIR__), Mix.Project.build_path()]}
  ]

config :tailwind,
  version: "4.1.12",
  stelgano: [
    args: ~w(
      --input=assets/css/app.css
      --output=priv/static/assets/css/app.css
    ),
    cd: Path.expand("..", __DIR__)
  ]

config :logger, :default_formatter,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id, :oban_job]

config :phoenix, :json_library, Jason

# Environment tag for conditional logic (HSTS etc.)
config :stelgano, :env, config_env()

import_config "#{config_env()}.exs"
