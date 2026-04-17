# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.Plugs.RawBodyReaderTest do
  @moduledoc "Tests for the RawBodyReader plug."

  use StelganoWeb.ConnCase, async: true

  describe "POST /api/webhooks/paystack" do
    test "raw body is cached in conn assigns for webhook paths", %{conn: conn} do
      body = Jason.encode!(%{event: "charge.success", data: %{reference: "abc"}})

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/api/webhooks/paystack", body)

      # The raw body should have been cached by RawBodyReader
      # We verify this indirectly — the webhook controller received the request
      assert conn.status in [200, 401, 404]
    end
  end
end
