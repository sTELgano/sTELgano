# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.Plugs.AdminAuth do
  @moduledoc """
  HTTP Basic Auth plug protecting the admin dashboard.

  Reads credentials at runtime from Application config so they can be set
  via environment variables (ADMIN_USERNAME / ADMIN_PASSWORD) without
  requiring a recompile.

  Uses constant-time comparison (`:crypto.hash` equality check) to avoid
  timing attacks on credential verification.

  ## Configuration

      # config/runtime.exs
      config :stelgano, :admin_credentials,
        username: System.get_env("ADMIN_USERNAME", "admin"),
        password: System.get_env("ADMIN_PASSWORD") || raise("ADMIN_PASSWORD required")
  """

  import Plug.Conn

  @realm "sTELgano Admin"

  @spec init(keyword()) :: keyword()
  def init(opts), do: opts

  @spec call(Plug.Conn.t(), keyword()) :: Plug.Conn.t()
  def call(conn, _opts) do
    with {:ok, supplied_user, supplied_pass} <- parse_basic_auth(conn),
         creds <- Application.get_env(:stelgano, :admin_credentials, []),
         expected_user <- Keyword.get(creds, :username, "admin"),
         expected_pass <- Keyword.get(creds, :password, ""),
         true <- secure_compare(supplied_user, expected_user),
         true <- secure_compare(supplied_pass, expected_pass) do
      conn
    else
      _error -> request_credentials(conn)
    end
  end

  # Parses the Authorization: Basic <base64> header.
  # Returns {:ok, username, password} or :error.
  @spec parse_basic_auth(Plug.Conn.t()) :: {:ok, String.t(), String.t()} | :error
  defp parse_basic_auth(conn) do
    with [header] <- get_req_header(conn, "authorization"),
         "Basic " <> encoded <- header,
         {:ok, decoded} <- Base.decode64(encoded),
         [user, pass] <- String.split(decoded, ":", parts: 2) do
      {:ok, user, pass}
    else
      _error -> :error
    end
  end

  # Sends a 401 response with WWW-Authenticate header.
  @spec request_credentials(Plug.Conn.t()) :: Plug.Conn.t()
  defp request_credentials(conn) do
    conn
    |> put_resp_header("www-authenticate", ~s(Basic realm="#{@realm}", charset="UTF-8"))
    |> put_resp_header("content-type", "text/plain")
    |> send_resp(401, "Unauthorized")
    |> halt()
  end

  # Constant-time string comparison to prevent timing attacks.
  # Compares SHA-256 digests so the comparison time is fixed regardless
  # of where the strings diverge.
  @spec secure_compare(String.t(), String.t()) :: boolean()
  defp secure_compare(a, b) when is_binary(a) and is_binary(b) do
    ha = :crypto.hash(:sha256, a)
    hb = :crypto.hash(:sha256, b)
    ha == hb
  end

  defp secure_compare(_a, _b), do: false
end
