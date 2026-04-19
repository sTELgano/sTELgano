# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Monetization.Providers.PaystackFxTest do
  @moduledoc """
  Tests the Paystack adapter's settlement-currency conversion path.

  Runs `async: false` because it uses the default-named `FxRate`
  GenServer, which is a single global registered name.
  """

  use ExUnit.Case, async: false

  alias Stelgano.Monetization.FxRate
  alias Stelgano.Monetization.Providers.Paystack

  @token_hash String.duplicate("c", 64)

  setup do
    Application.put_env(:stelgano, Paystack,
      secret_key: "sk_test_secret",
      public_key: "pk_test_public",
      callback_url: "https://test.stelgano.com/payment/callback",
      receipt_email_domain: "test.stelgano.com",
      settlement_currency: "KES",
      fx_buffer_pct: 5
    )

    Application.put_env(:stelgano, Stelgano.Monetization,
      enabled: true,
      provider: Paystack,
      price_cents: 500,
      currency: "USD"
    )

    start_supervised!(
      {FxRate, base: "USD", quote: "KES", fallback: Decimal.new("130"), autofetch: false}
    )

    on_exit(fn ->
      Application.delete_env(:stelgano, Paystack)
      Application.delete_env(:stelgano, Stelgano.Monetization)
    end)

    :ok
  end

  describe "settlement-currency conversion" do
    test "submits converted KES amount with buffer to Paystack" do
      # 500 USD cents * 130 rate * 1.05 buffer = 68250
      expected_amount = 68_250

      Req.Test.stub(Paystack, fn conn ->
        {:ok, body, _conn} = Plug.Conn.read_body(conn)
        decoded = Jason.decode!(body)

        assert decoded["amount"] == expected_amount
        assert decoded["currency"] == "KES"

        Req.Test.json(conn, %{
          "status" => true,
          "data" => %{"authorization_url" => "https://checkout.paystack.com/converted"}
        })
      end)

      assert {:ok, _url} = Paystack.initialize(@token_hash, 500, "USD")
    end
  end

  describe "helpers" do
    test "fx_conversion_needed?/0 reflects settlement vs display currency" do
      assert Paystack.fx_conversion_needed?()
    end

    test "settlement_currency/0 returns configured code" do
      assert Paystack.settlement_currency() == "KES"
    end

    test "fx_buffer_pct/0 returns configured value" do
      assert Paystack.fx_buffer_pct() == 5
    end

    test "child_specs/0 returns an FxRate spec when conversion is needed" do
      assert [{FxRate, opts}] = Paystack.child_specs()
      assert opts[:base] == "USD"
      assert opts[:quote] == "KES"
    end
  end

  describe "fx rate unavailable" do
    test "returns :fx_rate_unavailable when FxRate has no rate" do
      stop_supervised!(FxRate)

      start_supervised!({FxRate, base: "USD", quote: "KES", autofetch: false})

      assert {:error, :fx_rate_unavailable} = Paystack.initialize(@token_hash, 500, "USD")
    end
  end
end
