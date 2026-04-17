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

    req = build_req()

    case Req.post(req, url: "/transaction/initialize", json: body) do
      {:ok, %{status: 200, body: %{"status" => true, "data" => %{"authorization_url" => url}}}} ->
        {:ok, url}

      {:ok, %{body: resp_body}} ->
        Logger.error("Paystack initialize failed: #{inspect(resp_body)}")
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
      handle_verified_webhook(raw_body)
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
    req = build_req()

    case Req.get(req, url: "/transaction/verify/#{reference}") do
      {:ok, %{status: 200, body: %{"status" => true, "data" => %{"status" => "success"}}}} ->
        :ok

      {:ok, %{body: resp_body}} ->
        Logger.warning("Paystack verification failed for #{reference}: #{inspect(resp_body)}")
        {:error, :verification_failed}

      {:error, reason} ->
        Logger.error("Paystack verify request failed: #{inspect(reason)}")
        {:error, :provider_unavailable}
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  defp handle_verified_webhook(raw_body) do
    case Jason.decode(raw_body) do
      {:ok, %{"event" => "charge.success", "data" => %{"reference" => ref}}} ->
        case verify_transaction(ref) do
          :ok -> {:ok, ref}
          {:error, _reason} = err -> err
        end

      {:ok, _other_event} ->
        {:error, :ignored_event}

      {:error, _decode_error} ->
        {:error, :invalid_json}
    end
  end

  defp build_req do
    req =
      Req.new(
        base_url: "https://api.paystack.co",
        headers: [{"authorization", "Bearer #{paystack_config(:secret_key)}"}],
        retry: :transient
      )

    if Application.get_env(:stelgano, :req_test_enabled, false) do
      Req.merge(req, plug: {Req.Test, __MODULE__}, retry: false)
    else
      req
    end
  end

  defp paystack_config(key) do
    :stelgano
    |> Application.get_env(__MODULE__, [])
    |> Keyword.fetch!(key)
  end
end
