# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Monetization.Providers.Paystack do
  @moduledoc """
  Paystack payment provider adapter.

  Uses Paystack's hosted checkout page — the user is redirected to
  Paystack's domain to enter payment details. No card data touches
  the sTELgano server.

  ## Configuration

  Set these environment variables when monetization is enabled:

  - `PAYSTACK_SECRET_KEY` — Paystack secret key (starts with `sk_`)
  - `PAYSTACK_PUBLIC_KEY` — Paystack public key (starts with `pk_`)
  - `PAYSTACK_CALLBACK_URL` — URL to redirect after payment (e.g.
    `https://stelgano.com/payment/callback`)

  ## Privacy

  The Paystack transaction contains only the `token_hash` as reference.
  The user provides their email directly to Paystack's hosted page.
  No room_hash, steg number, or user identifier is sent to Paystack.
  """

  @behaviour Stelgano.Monetization.PaymentProvider

  require Logger

  @paystack_api "https://api.paystack.co"

  @impl Stelgano.Monetization.PaymentProvider
  def initialize(token_hash, amount_cents, currency) do
    callback_url = paystack_config(:callback_url)

    body = %{
      reference: token_hash,
      amount: amount_cents,
      currency: currency,
      callback_url: callback_url,
      channels: ["card", "bank", "ussd", "mobile_money"]
    }

    case Req.post("#{@paystack_api}/transaction/initialize",
           json: body,
           headers: auth_headers()
         ) do
      {:ok, %{status: 200, body: %{"status" => true, "data" => %{"authorization_url" => url}}}} ->
        {:ok, url}

      {:ok, %{body: body}} ->
        Logger.error("Paystack initialize failed: #{inspect(body)}")
        {:error, :provider_error}

      {:error, reason} ->
        Logger.error("Paystack request failed: #{inspect(reason)}")
        {:error, :provider_unavailable}
    end
  end

  @impl Stelgano.Monetization.PaymentProvider
  def verify_webhook(conn) do
    secret = paystack_config(:secret_key)
    raw_body = conn.assigns[:raw_body] || ""

    signature =
      conn
      |> Plug.Conn.get_req_header("x-paystack-signature")
      |> List.first("")

    expected =
      :hmac
      |> :crypto.mac(:sha512, secret, raw_body)
      |> Base.encode16(case: :lower)

    if Plug.Crypto.secure_compare(signature, expected) do
      case Jason.decode(raw_body) do
        {:ok, %{"event" => "charge.success", "data" => %{"reference" => ref}}} ->
          # Double-verify with Paystack API
          case verify_transaction(ref) do
            :ok -> {:ok, ref}
            {:error, _reason} = err -> err
          end

        {:ok, _other_event} ->
          {:error, :ignored_event}

        {:error, _decode_error} ->
          {:error, :invalid_json}
      end
    else
      {:error, :invalid_signature}
    end
  end

  @doc """
  Verifies a transaction directly with Paystack's API.
  Used for double-verification in webhook handling and callback pages.
  """
  @spec verify_transaction(String.t()) :: :ok | {:error, term()}
  def verify_transaction(reference) do
    case Req.get("#{@paystack_api}/transaction/verify/#{reference}",
           headers: auth_headers()
         ) do
      {:ok, %{status: 200, body: %{"status" => true, "data" => %{"status" => "success"}}}} ->
        :ok

      {:ok, %{body: body}} ->
        Logger.warning("Paystack verification failed for #{reference}: #{inspect(body)}")
        {:error, :verification_failed}

      {:error, reason} ->
        Logger.error("Paystack verify request failed: #{inspect(reason)}")
        {:error, :provider_unavailable}
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  defp auth_headers do
    [{"authorization", "Bearer #{paystack_config(:secret_key)}"}]
  end

  defp paystack_config(key) do
    :stelgano
    |> Application.get_env(__MODULE__, [])
    |> Keyword.fetch!(key)
  end
end
