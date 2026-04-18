# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.RateLimiter do
  @moduledoc """
  IP-based rate limiter using PlugAttack.

  Provides a second layer of brute-force protection on top of the per-record
  `failed_attempts` lockout in `Stelgano.Rooms.RoomAccess`.

  ## Rules

  - **Admin paths (`/admin/*`)** — 20 per IP per minute.
    Tighter budget so a brute-force attempt on HTTP Basic Auth is
    locked out long before a realistic dictionary attack can complete.
    Credentials change infrequently and legitimate admin use is bursty
    but well under this ceiling.
  - **WebSocket upgrade requests** — 30 per IP per minute.
    Prevents rapid socket cycling to enumerate access hashes.
  - **All HTTP requests** — 200 per IP per minute.
    Blocks simple scripted DoS without affecting legitimate users.

  ## Storage

  Uses an ETS table (in-memory). Resets on node restart — acceptable.
  For multi-node Fly.io deployments, replace with a Redis-backed store
  (Hammer + hammer_backend_redis). See compliance_and_recommendations.md.

  ## Response

  Returns HTTP 429 with a plain-text body and `Retry-After` header.
  Does not reveal any application state.
  """

  use PlugAttack

  # ---------------------------------------------------------------------------
  # Rules
  # ---------------------------------------------------------------------------

  # Throttle admin dashboard requests aggressively — HTTP Basic Auth
  # otherwise has no built-in rate limit, and 20/min + 10-attempt lock in
  # AdminAuth effectively caps dictionary attacks at ~20 guesses/min.
  rule "throttle admin by IP", conn do
    if String.starts_with?(conn.request_path, "/admin") do
      throttle({:admin, conn.remote_ip},
        period: 60_000,
        limit: 20,
        storage: {PlugAttack.Storage.Ets, :stelgano_rate_limiter}
      )
    end
  end

  # Throttle WebSocket upgrade requests at 30 per IP per minute.
  rule "throttle websocket by IP", conn do
    if conn.method == "GET" and
         conn.request_path in ["/anon_socket/websocket", "/live/websocket"] do
      throttle(conn.remote_ip,
        period: 60_000,
        limit: 30,
        storage: {PlugAttack.Storage.Ets, :stelgano_rate_limiter}
      )
    end
  end

  # Throttle all requests at 200 per IP per minute.
  rule "throttle all requests by IP", conn do
    throttle(conn.remote_ip,
      period: 60_000,
      limit: 200,
      storage: {PlugAttack.Storage.Ets, :stelgano_rate_limiter}
    )
  end

  # ---------------------------------------------------------------------------
  # Response callbacks
  # ---------------------------------------------------------------------------

  @impl PlugAttack
  def allow_action(conn, {:throttle, data}, _opts) do
    conn
    |> Plug.Conn.put_resp_header("x-ratelimit-limit", to_string(data[:limit]))
    |> Plug.Conn.put_resp_header("x-ratelimit-remaining", to_string(data[:remaining]))
    |> Plug.Conn.put_resp_header("x-ratelimit-reset", reset_timestamp(data[:reset_at]))
  end

  @impl PlugAttack
  def block_action(conn, {:throttle, data}, _opts) do
    retry_after = compute_retry_after(data[:reset_at])

    conn
    |> Plug.Conn.put_resp_header("retry-after", to_string(retry_after))
    |> Plug.Conn.put_resp_header("content-type", "text/plain")
    |> Plug.Conn.send_resp(429, "Too many requests. Please try again later.")
    |> Plug.Conn.halt()
  end

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  # Converts a PlugAttack reset_at millisecond timestamp to a Unix second string.
  @spec reset_timestamp(integer() | nil) :: String.t()
  defp reset_timestamp(nil), do: "0"

  defp reset_timestamp(reset_at_ms) when is_integer(reset_at_ms) do
    reset_at_ms
    |> div(1_000)
    |> to_string()
  end

  # Computes seconds until rate limit resets, minimum 1.
  @spec compute_retry_after(integer() | nil) :: non_neg_integer()
  defp compute_retry_after(nil), do: 60

  defp compute_retry_after(reset_at_ms) when is_integer(reset_at_ms) do
    now_ms = System.system_time(:millisecond)
    remaining_ms = reset_at_ms - now_ms
    max(1, ceil(remaining_ms / 1_000))
  end
end
