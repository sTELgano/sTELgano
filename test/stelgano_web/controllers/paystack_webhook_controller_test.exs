# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.PaystackWebhookControllerTest do
  @moduledoc "Tests for the Paystack webhook controller."

  use StelganoWeb.ConnCase, async: true

  describe "POST /api/webhooks/paystack" do
    test "returns 404 when monetization is disabled", %{conn: conn} do
      # Default config has monetization disabled
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/api/webhooks/paystack", %{})

      assert json_response(conn, 404)["error"] == "not_found"
    end
  end
end
