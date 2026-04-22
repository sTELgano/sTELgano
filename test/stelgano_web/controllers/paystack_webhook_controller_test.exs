# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.PaystackWebhookControllerTest do
  @moduledoc """
  Tests for the Paystack webhook controller.

  Tests both the disabled (default) and enabled monetization paths.
  When enabled, uses a mock provider to simulate verify_webhook results.
  """

  use StelganoWeb.ConnCase, async: false

  alias Stelgano.Monetization

  # A mock provider module for testing the enabled path
  defmodule MockProvider do
    @behaviour Stelgano.Monetization.PaymentProvider

    @impl Stelgano.Monetization.PaymentProvider
    def initialize(_token_hash, _amount, _currency), do: {:ok, "https://mock.checkout/test"}

    @impl Stelgano.Monetization.PaymentProvider
    def verify_webhook(conn) do
      # Use a header to control behavior in tests
      case Plug.Conn.get_req_header(conn, "x-mock-result") do
        ["ok:" <> token_hash] -> {:ok, token_hash}
        ["ignored"] -> {:error, :ignored_event}
        ["invalid_sig"] -> {:error, :invalid_signature}
        ["error"] -> {:error, :some_error}
        _other -> {:error, :invalid_signature}
      end
    end
  end

  defp sha256_hex(input) do
    input
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.encode16(case: :lower)
  end

  describe "POST /api/webhooks/paystack (monetization disabled)" do
    setup do
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

      :ok
    end

    test "returns 404 when monetization is disabled", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post("/api/webhooks/paystack", %{})

      assert json_response(conn, 404)["error"] == "not_found"
    end
  end

  describe "POST /api/webhooks/paystack (monetization enabled)" do
    setup do
      original = Application.get_env(:stelgano, Stelgano.Monetization)

      Application.put_env(:stelgano, Stelgano.Monetization,
        enabled: true,
        provider: MockProvider,
        free_ttl_days: 7,
        paid_ttl_days: 365,
        price_cents: 200,
        currency: "USD"
      )

      on_exit(fn ->
        if original do
          Application.put_env(:stelgano, Stelgano.Monetization, original)
        else
          Application.delete_env(:stelgano, Stelgano.Monetization)
        end
      end)

      :ok
    end

    test "returns ok for valid webhook with known token", %{conn: conn} do
      # Create a pending token first
      token_hash = sha256_hex("webhook-test-1")
      {:ok, _token} = Monetization.create_token(token_hash)

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> put_req_header("x-mock-result", "ok:#{token_hash}")
        |> post("/api/webhooks/paystack", %{})

      assert json_response(conn, 200)["status"] == "ok"
    end

    test "returns ok for ignored events", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> put_req_header("x-mock-result", "ignored")
        |> post("/api/webhooks/paystack", %{})

      assert json_response(conn, 200)["status"] == "ok"
    end

    test "returns 401 for invalid signature", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> put_req_header("x-mock-result", "invalid_sig")
        |> post("/api/webhooks/paystack", %{})

      assert json_response(conn, 401)["error"] == "invalid_signature"
    end

    test "returns ok for other errors (does not leak info)", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> put_req_header("x-mock-result", "error")
        |> post("/api/webhooks/paystack", %{})

      assert json_response(conn, 200)["status"] == "ok"
    end

    test "handles unknown token gracefully", %{conn: conn} do
      unknown_hash = sha256_hex("unknown")

      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> put_req_header("x-mock-result", "ok:#{unknown_hash}")
        |> post("/api/webhooks/paystack", %{})

      # Should still return 200 OK (don't leak whether token exists)
      assert json_response(conn, 200)["status"] == "ok"
    end

    test "handles duplicate webhook idempotently", %{conn: conn} do
      token_hash = sha256_hex("webhook-dup")
      {:ok, _token} = Monetization.create_token(token_hash)

      # First webhook
      conn
      |> put_req_header("content-type", "application/json")
      |> put_req_header("x-mock-result", "ok:#{token_hash}")
      |> post("/api/webhooks/paystack", %{})

      # Second webhook (duplicate) — should still return ok
      conn2 =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> put_req_header("x-mock-result", "ok:#{token_hash}")
        |> post("/api/webhooks/paystack", %{})

      assert json_response(conn2, 200)["status"] == "ok"
    end
  end
end
