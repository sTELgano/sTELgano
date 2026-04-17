# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Monetization.PaymentProvider do
  @moduledoc """
  Behaviour for payment provider adapters.

  Implement this behaviour to add support for a new payment gateway.
  sTELgano ships with a Paystack adapter; self-hosters can implement
  their own for Stripe, Flutterwave, M-Pesa, or any other provider.

  ## Example

      defmodule MyApp.Monetization.Providers.Stripe do
        @behaviour Stelgano.Monetization.PaymentProvider

        @impl true
        def initialize(token_hash, amount_cents, currency) do
          # Create a Stripe Checkout session...
          {:ok, checkout_url}
        end

        @impl true
        def verify_webhook(conn) do
          # Verify Stripe webhook signature...
          {:ok, token_hash}
        end
      end

  Then configure it:

      config :stelgano, Stelgano.Monetization,
        enabled: true,
        provider: MyApp.Monetization.Providers.Stripe
  """

  @doc """
  Initializes a payment session with the provider.

  The `token_hash` is used as the payment reference. The provider
  should redirect the user to their hosted checkout page.

  Returns `{:ok, checkout_url}` on success.
  """
  @callback initialize(
              token_hash :: String.t(),
              amount_cents :: pos_integer(),
              currency :: String.t()
            ) ::
              {:ok, checkout_url :: String.t()} | {:error, term()}

  @doc """
  Verifies a webhook request from the payment provider.

  Should validate the signature/authenticity of the webhook and
  extract the `token_hash` (payment reference) from the payload.

  Returns `{:ok, token_hash}` if valid.
  """
  @callback verify_webhook(conn :: Plug.Conn.t()) ::
              {:ok, token_hash :: String.t()} | {:error, term()}
end
