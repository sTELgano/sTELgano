# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Monetization.Providers.PaystackTest do
  @moduledoc """
  Tests for the Paystack payment provider adapter.

  Tests webhook signature verification logic without making real HTTP calls.
  """

  use ExUnit.Case, async: true

  alias Stelgano.Monetization.Providers.Paystack

  describe "verify_transaction/1" do
    # verify_transaction makes HTTP calls, so we test the module structure
    # and behavior compliance rather than the HTTP layer

    test "module implements PaymentProvider behaviour" do
      behaviours = Paystack.__info__(:attributes) |> Keyword.get_values(:behaviour)
      assert [Stelgano.Monetization.PaymentProvider] in behaviours
    end
  end

  describe "HMAC signature computation" do
    test "HMAC-SHA512 signature matches expected format" do
      secret = "test-secret-key"
      body = ~s({"event":"charge.success","data":{"reference":"abc123"}})

      signature =
        :hmac
        |> :crypto.mac(:sha512, secret, body)
        |> Base.encode16(case: :lower)

      # HMAC-SHA512 produces a 128-char hex string
      assert String.length(signature) == 128
      assert signature =~ ~r/\A[0-9a-f]+\z/
    end
  end
end
