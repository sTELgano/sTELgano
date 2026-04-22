# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.Plugs.SecurityHeaders do
  @moduledoc """
  Applies additional security and privacy headers on a per-path basis.

  ## X-Robots-Tag

  The `/chat` route is set to `noindex, nofollow`. A person searching for
  sTELgano should find the homepage, not the chat entry screen. Indexed
  chat URLs would also leak partial browser history to search engine
  crawlers in some browser extensions.

  ## Strict-Transport-Security

  Applied to all responses in production. Instructs browsers to use HTTPS
  for the next two years and include subdomains.

  ## Cache-Control for sensitive routes

  `/chat` sets `no-store` to prevent the browser from caching the page
  content in the disk or memory cache. This is an additional Passcode Test
  compliance measure — a cached page could be found via Ctrl+H or browser
  cache inspection.
  """

  import Plug.Conn

  @sensitive_paths ["/chat"]

  @spec init(keyword()) :: keyword()
  def init(opts), do: opts

  @spec call(Plug.Conn.t(), keyword()) :: Plug.Conn.t()
  def call(conn, _opts) do
    conn
    |> put_hsts()
    |> put_robots_tag()
    |> put_cache_control()
  end

  # HSTS: 2 years, includeSubDomains, preload
  # Only applied in production — dev doesn't have HTTPS
  @spec put_hsts(Plug.Conn.t()) :: Plug.Conn.t()
  defp put_hsts(conn) do
    if Application.get_env(:stelgano, :env) == :prod do
      put_resp_header(
        conn,
        "strict-transport-security",
        "max-age=63072000; includeSubDomains; preload"
      )
    else
      conn
    end
  end

  # Noindex on sensitive paths; allow indexing on public pages
  @spec put_robots_tag(Plug.Conn.t()) :: Plug.Conn.t()
  defp put_robots_tag(conn) do
    if conn.request_path in @sensitive_paths do
      put_resp_header(conn, "x-robots-tag", "noindex, nofollow")
    else
      conn
    end
  end

  # no-store cache on sensitive routes; normal cache on public content
  @spec put_cache_control(Plug.Conn.t()) :: Plug.Conn.t()
  defp put_cache_control(conn) do
    if conn.request_path in @sensitive_paths do
      put_resp_header(conn, "cache-control", "no-store, no-cache, must-revalidate, private")
    else
      conn
    end
  end
end
