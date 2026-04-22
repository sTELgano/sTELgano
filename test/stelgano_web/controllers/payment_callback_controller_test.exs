# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.PaymentCallbackControllerTest do
  @moduledoc "Tests for the payment callback controller."

  # async: false because the disabled-path test mutates global Application
  # env (Stelgano.Monetization), which other tests read concurrently.
  use StelganoWeb.ConnCase, async: false

  describe "GET /payment/callback" do
    test "redirects to home when monetization is disabled", %{conn: conn} do
      original = Application.get_env(:stelgano, Stelgano.Monetization)

      Application.put_env(
        :stelgano,
        Stelgano.Monetization,
        Keyword.put(original || [], :enabled, false)
      )

      on_exit(fn ->
        if original do
          Application.put_env(:stelgano, Stelgano.Monetization, original)
        else
          Application.delete_env(:stelgano, Stelgano.Monetization)
        end
      end)

      conn = get(conn, ~p"/payment/callback?reference=test-ref")
      assert redirected_to(conn) == "/"
    end

    test "redirects to home when no reference param", %{conn: conn} do
      conn = get(conn, ~p"/payment/callback")
      assert redirected_to(conn) == "/"
    end
  end
end
