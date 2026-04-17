# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.PaymentCallbackControllerTest do
  @moduledoc "Tests for the payment callback controller."

  use StelganoWeb.ConnCase, async: true

  describe "GET /payment/callback" do
    test "redirects to home when monetization is disabled", %{conn: conn} do
      conn = get(conn, ~p"/payment/callback?reference=test-ref")
      assert redirected_to(conn) == "/"
    end

    test "redirects to home when no reference param", %{conn: conn} do
      conn = get(conn, ~p"/payment/callback")
      assert redirected_to(conn) == "/"
    end
  end
end
