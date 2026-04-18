# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

import Config

# config/runtime.exs is executed for all environments, including
# during releases. It is executed after compilation and before the
# system starts, so it is typically used to load production configuration
# and secrets from environment variables or elsewhere. Do not define
# any compile-time configuration in here, as it won't be applied.
# The block below contains prod specific runtime configuration.

# ## Using releases
#
# If you use `mix release`, you need to explicitly enable the server
# by passing the PHX_SERVER=true when you start it:
#
#     PHX_SERVER=true bin/stelgano start
#
# Alternatively, you can use `mix phx.gen.release` to generate a `bin/server`
# script that automatically sets the env var above.
if System.get_env("PHX_SERVER") do
  config :stelgano, StelganoWeb.Endpoint, server: true
end

config :stelgano, StelganoWeb.Endpoint,
  http: [port: String.to_integer(System.get_env("PORT", "4000"))]

if config_env() == :prod do
  database_url =
    System.get_env("DATABASE_URL") ||
      raise """
      environment variable DATABASE_URL is missing.
      For example: ecto://USER:PASS@HOST/DATABASE
      """

  # Strip any ?sslmode=/&sslmode= directive from the URL so the `ssl:`
  # option below is the single source of truth. Stacking both causes
  # Postgrex to complain or silently drop one of them.
  database_url =
    database_url
    |> String.replace(~r/\?sslmode=[^&]+/, "")
    |> String.replace(~r/&sslmode=[^&]+/, "")

  maybe_ipv6 = if System.get_env("ECTO_IPV6") in ~w(true 1), do: [:inet6], else: []

  config :stelgano, Stelgano.Repo,
    url: database_url,
    pool_size: String.to_integer(System.get_env("POOL_SIZE") || "10"),
    # For machines with several cores, consider starting multiple pools of `pool_size`
    # pool_count: 4,
    socket_options: maybe_ipv6,
    # DigitalOcean managed Postgres requires SSL. Its cert is signed by
    # DO's internal CA, so :verify_peer would need that CA bundle shipped
    # inside the release; :verify_none keeps the connection fully encrypted
    # but skips certificate-identity verification. Acceptable because both
    # endpoints live inside DO's infrastructure.
    ssl: [verify: :verify_none]

  # The secret key base is used to sign/encrypt cookies and other secrets.
  # A default value is used in config/dev.exs and config/test.exs but you
  # want to use a different value for prod and you most likely don't want
  # to check this value into version control, so we use an environment
  # variable instead.
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      You can generate one by calling: mix phx.gen.secret
      """

  host = System.get_env("PHX_HOST") || "example.com"

  config :stelgano, :dns_cluster_query, System.get_env("DNS_CLUSTER_QUERY")

  config :stelgano, StelganoWeb.Endpoint,
    url: [host: host, port: 443, scheme: "https"],
    http: [
      # Enable IPv6 and bind on all interfaces.
      # Set it to  {0, 0, 0, 0, 0, 0, 0, 1} for local network only access.
      # See the documentation on https://hexdocs.pm/bandit/Bandit.html#t:options/0
      # for details about using IPv6 vs IPv4 and loopback vs public addresses.
      ip: {0, 0, 0, 0, 0, 0, 0, 0}
    ],
    secret_key_base: secret_key_base

  # ## SSL Support
  #
  # To get SSL working, you will need to add the `https` key
  # to your endpoint configuration:
  #
  #     config :stelgano, StelganoWeb.Endpoint,
  #       https: [
  #         ...,
  #         port: 443,
  #         cipher_suite: :strong,
  #         keyfile: System.get_env("SOME_APP_SSL_KEY_PATH"),
  #         certfile: System.get_env("SOME_APP_SSL_CERT_PATH")
  #       ]
  #
  # The `cipher_suite` is set to `:strong` to support only the
  # latest and more secure SSL ciphers. This means old browsers
  # and clients may not be supported. You can set it to
  # `:compatible` for wider support.
  #
  # `:keyfile` and `:certfile` expect an absolute path to the key
  # and cert in disk or a relative path inside priv, for example
  # "priv/ssl/server.key". For all supported SSL configuration
  # options, see https://hexdocs.pm/plug/Plug.SSL.html#configure/1
  #
  # We also recommend setting `force_ssl` in your config/prod.exs,
  # ensuring no data is ever sent via http, always redirecting to https:
  #
  #     config :stelgano, StelganoWeb.Endpoint,
  #       force_ssl: [hsts: true]
  #
  # Check `Plug.SSL` for all available options in `force_ssl`.

  # ## Configuring the mailer
  #
  # In production you need to configure the mailer to use a different adapter.
  # Here is an example configuration for Mailgun:
  #
  #     config :stelgano, Stelgano.Mailer,
  #       adapter: Swoosh.Adapters.Mailgun,
  #       api_key: System.get_env("MAILGUN_API_KEY"),
  #       domain: System.get_env("MAILGUN_DOMAIN")
  #
  # Most non-SMTP adapters require an API client. Swoosh supports Req, Hackney,
  # and Finch out-of-the-box. This configuration is typically done at
  # compile-time in your config/prod.exs:
  #
  #     config :swoosh, :api_client, Swoosh.ApiClient.Req
  #
  # See https://hexdocs.pm/swoosh/Swoosh.html#module-installation for details.
end

# ---------------------------------------------------------------------------
# Admin credentials (production)
# ---------------------------------------------------------------------------
if config_env() == :prod do
  admin_username = System.get_env("ADMIN_USERNAME", "admin")

  admin_password =
    System.get_env("ADMIN_PASSWORD") ||
      raise """
      environment variable ADMIN_PASSWORD is missing.
      Set a strong password for the admin dashboard.
      """

  config :stelgano, :admin_credentials,
    username: admin_username,
    password: admin_password
end

# ---------------------------------------------------------------------------
# Monetization — Paystack credentials (production)
# ---------------------------------------------------------------------------
if config_env() == :prod do
  monetization_enabled =
    System.get_env("MONETIZATION_ENABLED", "false") in ~w(true 1 yes)

  if monetization_enabled do
    paystack_secret =
      System.get_env("PAYSTACK_SECRET_KEY") ||
        raise """
        environment variable PAYSTACK_SECRET_KEY is missing.
        Required when MONETIZATION_ENABLED=true.
        """

    paystack_public =
      System.get_env("PAYSTACK_PUBLIC_KEY") ||
        raise """
        environment variable PAYSTACK_PUBLIC_KEY is missing.
        Required when MONETIZATION_ENABLED=true.
        """

    callback_url =
      System.get_env("PAYSTACK_CALLBACK_URL") ||
        raise """
        environment variable PAYSTACK_CALLBACK_URL is missing.
        Example: https://stelgano.com/payment/callback
        """

    config :stelgano, Stelgano.Monetization,
      enabled: true,
      provider: Stelgano.Monetization.Providers.Paystack,
      free_ttl_days: String.to_integer(System.get_env("FREE_TTL_DAYS", "7")),
      paid_ttl_days: String.to_integer(System.get_env("PAID_TTL_DAYS", "365")),
      price_cents: String.to_integer(System.get_env("PRICE_CENTS", "200")),
      currency: System.get_env("PAYMENT_CURRENCY", "USD")

    config :stelgano, Stelgano.Monetization.Providers.Paystack,
      secret_key: paystack_secret,
      public_key: paystack_public,
      callback_url: callback_url
  end
end

# ---------------------------------------------------------------------------
# Oban — production queue configuration
# ---------------------------------------------------------------------------
if config_env() == :prod do
  config :stelgano, Oban,
    repo: Stelgano.Repo,
    plugins: [
      {Oban.Plugins.Pruner, max_age: 7 * 24 * 60 * 60},
      {Oban.Plugins.Cron,
       crontab: [
         {"0 * * * *", Stelgano.Jobs.ExpireTtlRooms},
         {"0 3 * * *", Stelgano.Jobs.ExpireUnredeemedTokens}
       ]}
    ],
    queues: [maintenance: 2]
end
