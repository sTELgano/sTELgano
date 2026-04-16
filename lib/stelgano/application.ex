# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Application do
  @moduledoc """
  OTP Application entry point.

  Supervision tree:
  - Telemetry supervisor (Phoenix metrics)
  - Ecto Repo (PostgreSQL)
  - DNSCluster (Fly.io multi-node discovery)
  - Phoenix PubSub (real-time channel broadcasts)
  - Oban (background jobs: message purge, TTL expiry)
  - PlugAttack ETS storage (IP-based rate limiting)
  - Phoenix Endpoint (HTTP server)
  """

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      StelganoWeb.Telemetry,
      Stelgano.Repo,
      {DNSCluster, query: Application.get_env(:stelgano, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: Stelgano.PubSub},
      # Oban — background jobs for cleanup and TTL expiry
      {Oban, Application.fetch_env!(:stelgano, Oban)},
      # PlugAttack ETS table for IP-based rate limiting
      {PlugAttack.Storage.Ets, name: :stelgano_rate_limiter, clean_period: 60_000},
      StelganoWeb.Endpoint
    ]

    opts = [strategy: :one_for_one, name: Stelgano.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @impl true
  def config_change(changed, _new, removed) do
    StelganoWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
