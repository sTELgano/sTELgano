# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.Router do
  @moduledoc """
  Router for the sTELgano web application.

  ## Route structure

  - `/` — public homepage and static pages (no auth)
  - `/chat` — anonymous chat LiveView (no auth; access control is in the channel)
  - `/steg-number` — steg number generator LiveView (no auth)
  - `/admin` — aggregate metrics dashboard (HTTP Basic Auth)
  - `/dev/*` — development-only tools (not compiled in production)

  ## Security

  All browser responses go through `put_secure_browser_headers/2` with a strict
  Content-Security-Policy. Additional per-path headers (HSTS, X-Robots-Tag,
  Cache-Control: no-store) are applied by `StelganoWeb.Plugs.SecurityHeaders`.

  The rate limiter (`StelganoWeb.RateLimiter`) runs before the router in
  `endpoint.ex` and applies IP-based throttling.

  The anonymous room channel has no router involvement — it is handled entirely
  by `StelganoWeb.AnonSocket` and `StelganoWeb.AnonRoomChannel`.
  """

  use StelganoWeb, :router

  # ---------------------------------------------------------------------------
  # Pipelines
  # ---------------------------------------------------------------------------

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {StelganoWeb.Layouts, :root}
    plug :protect_from_forgery

    plug :put_secure_browser_headers, %{
      "content-security-policy" =>
        "default-src 'self'; " <>
          "script-src 'self' 'unsafe-inline'; " <>
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " <>
          "font-src 'self' https://fonts.gstatic.com data:; " <>
          "connect-src 'self' wss: ws:; " <>
          "img-src 'self' data:; " <>
          "object-src 'none'; " <>
          "frame-ancestors 'none'; " <>
          "base-uri 'self'; " <>
          "form-action 'self'",
      "x-frame-options" => "DENY",
      "x-content-type-options" => "nosniff",
      "referrer-policy" => "no-referrer",
      "permissions-policy" => "camera=(), microphone=(), geolocation=(), payment=()",
      "cross-origin-opener-policy" => "same-origin",
      "cross-origin-embedder-policy" => "same-origin",
      "cross-origin-resource-policy" => "same-origin"
    }

    plug StelganoWeb.Plugs.SecurityHeaders
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  # Standalone admin auth pipeline — always used together with :browser
  # via pipe_through [:browser, :admin_auth] on the scope
  pipeline :admin_auth do
    plug StelganoWeb.Plugs.AdminAuth
  end

  # ---------------------------------------------------------------------------
  # Public routes
  # ---------------------------------------------------------------------------

  scope "/", StelganoWeb do
    pipe_through :browser

    get "/", PageController, :home
    get "/security", PageController, :security
    get "/privacy", PageController, :privacy
    get "/terms", PageController, :terms
    get "/about", PageController, :about

    # Serve the .well-known/security.txt file
    get "/.well-known/security.txt", PageController, :security_txt

    # Anonymous chat and number generator (no current_scope — anonymous app)
    live "/chat", ChatLive
    live "/steg-number", StegNumberLive

    # Panic route — instant session clear, no confirmation, GET only
    get "/x", PanicController, :clear
  end

  # ---------------------------------------------------------------------------
  # Admin dashboard (HTTP Basic Auth)
  # ---------------------------------------------------------------------------

  scope "/admin", StelganoWeb do
    pipe_through [:browser, :admin_auth]

    live "/", AdminDashboardLive
  end

  # ---------------------------------------------------------------------------
  # Development tools
  # ---------------------------------------------------------------------------

  if Application.compile_env(:stelgano, :dev_routes) do
    import Phoenix.LiveDashboard.Router

    scope "/dev" do
      pipe_through :browser

      live_dashboard "/dashboard", metrics: StelganoWeb.Telemetry
      forward "/mailbox", Plug.Swoosh.MailboxPreview
    end
  end
end
