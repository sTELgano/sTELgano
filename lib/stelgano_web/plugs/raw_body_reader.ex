# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.Plugs.RawBodyReader do
  @moduledoc """
  Custom body reader that caches the raw request body in `conn.assigns.raw_body`.

  Used by webhook controllers that need to verify HMAC signatures against
  the exact bytes received from the payment provider.

  Only caches the body for paths starting with `/api/webhooks/` to avoid
  unnecessary memory usage on other routes.
  """

  @spec read_body(Plug.Conn.t(), keyword()) :: {:ok, binary(), Plug.Conn.t()}
  def read_body(%Plug.Conn{request_path: "/api/webhooks/" <> _rest} = conn, opts) do
    {:ok, body, conn_after_read} = Plug.Conn.read_body(conn, opts)
    conn_with_body = Plug.Conn.assign(conn_after_read, :raw_body, body)
    {:ok, body, conn_with_body}
  end

  def read_body(conn, opts) do
    Plug.Conn.read_body(conn, opts)
  end
end
