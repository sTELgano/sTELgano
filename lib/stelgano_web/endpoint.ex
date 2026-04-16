# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.Endpoint do
  @moduledoc """
  Phoenix Endpoint.

  ## Plugs (in order)

  1. Plug.Static — serves compiled assets from priv/static
  2. Phoenix.LiveReloader — dev-only live code reloading
  3. StelganoWeb.RateLimiter — IP-based rate limiting (PlugAttack)
  4. Plug.RequestId — attaches a unique request ID to every request
  5. Plug.Telemetry — emits Phoenix telemetry events
  6. Plug.Parsers — parses request bodies
  7. Plug.MethodOverride / Plug.Head
  8. Plug.Session — session cookie
  9. StelganoWeb.Router

  ## Sockets

  - `/anon_socket` — unauthenticated WebSocket for anonymous room channels
  - `/live` — Phoenix LiveView socket (uses session cookie)
  """

  use Phoenix.Endpoint, otp_app: :stelgano

  @session_options [
    store: :cookie,
    key: "_stelgano_key",
    signing_salt: "2/X06Z0e",
    same_site: "Lax",
    # Prevent JavaScript from accessing the session cookie
    http_only: true,
    # HTTPS-only in production (set via secure: true in runtime.exs)
    secure: Application.compile_env(:stelgano, :env, :dev) == :prod
  ]

  # Anonymous WebSocket — no session, no auth token
  # Access control lives entirely in AnonRoomChannel.join/3
  socket "/anon_socket", StelganoWeb.AnonSocket,
    websocket: [connect_info: []],
    longpoll: false

  # LiveView socket — uses the browser session cookie
  socket "/live", Phoenix.LiveView.Socket,
    websocket: [connect_info: [session: @session_options]],
    longpoll: [connect_info: [session: @session_options]]

  # Serve static files from priv/static
  plug Plug.Static,
    at: "/",
    from: :stelgano,
    gzip: not code_reloading?,
    only: StelganoWeb.static_paths(),
    raise_on_missing_only: code_reloading?,
    headers: %{"cache-control" => "public, max-age=31536000, immutable"}

  if code_reloading? do
    socket "/phoenix/live_reload/socket", Phoenix.LiveReloader.Socket
    plug Phoenix.LiveReloader
    plug Phoenix.CodeReloader
    plug Phoenix.Ecto.CheckRepoStatus, otp_app: :stelgano
  end

  plug Phoenix.LiveDashboard.RequestLogger,
    param_key: "request_logger",
    cookie_key: "request_logger"

  # IP-based rate limiting — must come before the router
  plug StelganoWeb.RateLimiter

  plug Plug.RequestId
  plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]

  plug Plug.Parsers,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Phoenix.json_library()

  plug Plug.MethodOverride
  plug Plug.Head
  plug Plug.Session, @session_options
  plug StelganoWeb.Router
end
