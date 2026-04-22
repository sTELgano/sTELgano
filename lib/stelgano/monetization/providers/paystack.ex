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
  - `PAYSTACK_RECEIPT_EMAIL_DOMAIN` — a domain the operator **controls**,
    used as the `@domain` part of the anonymous placeholder email sent
    to Paystack (Paystack requires an email on `/transaction/initialize`
    and mails receipts to it). The operator must own this domain — if
    it's owned by a third party, every transaction receipt is delivered
    to them. No MX record is fine; undeliverable is the desired outcome.
  - `PAYSTACK_SETTLEMENT_CURRENCY` — optional. Overrides the display
    currency (`PAYMENT_CURRENCY`) when submitting to Paystack. Useful
    when the merchant account only accepts a specific currency (e.g.
    show USD, settle in KES). When unset, no conversion happens.
  - `PAYSTACK_FX_BUFFER_PCT` — optional, default `5`. Percent added on
    top of the converted amount to absorb FX drift between the cached
    rate and the moment the charge settles. Ignored when no conversion.
  - `PAYMENT_FX_FALLBACK_RATE` — optional. Seeds `FxRate` so the first
    payment after a cold start still works if the rate API is down.

  ## Settlement-currency conversion

  When `settlement_currency` differs from the amount's currency,
  `initialize/3` fetches the current rate from `Stelgano.Monetization.FxRate`,
  multiplies by `(1 + fx_buffer_pct / 100)`, rounds to the nearest
  integer cent of the settlement currency, and sends that to Paystack.
  The `FxRate` GenServer is started conditionally from the supervision
  tree — see `child_specs/0`.

  ## Privacy

  The Paystack transaction contains only the `token_hash` as reference.
  Because Paystack's API requires an email on initialize, we supply a
  placeholder derived from the `token_hash` (see `initialize/3`) so the
  user is not prompted for a real one. The `token_hash` is already the
  transaction reference — the email prefix reveals no additional info
  to Paystack. No room_hash, steg number, or user identifier is sent.
  """

  @behaviour Stelgano.Monetization.PaymentProvider

  alias Stelgano.Monetization.FxRate

  require Logger

  @impl Stelgano.Monetization.PaymentProvider
  def initialize(token_hash, amount_cents, currency) do
    with {:ok, final_amount, final_currency} <- convert_if_needed(amount_cents, currency) do
      callback_url = paystack_config(:callback_url)

      body = %{
        email: placeholder_email(token_hash),
        reference: token_hash,
        amount: final_amount,
        currency: final_currency,
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
  end

  @doc """
  Settlement currency submitted to Paystack. Defaults to
  `Stelgano.Monetization.currency/0` (no conversion) when unset.
  """
  @spec settlement_currency() :: String.t()
  def settlement_currency do
    paystack_config_opt(:settlement_currency) || Stelgano.Monetization.currency()
  end

  @doc "Percent buffer added on top of converted amounts. Default 5."
  @spec fx_buffer_pct() :: non_neg_integer()
  def fx_buffer_pct do
    paystack_config_opt(:fx_buffer_pct, 5)
  end

  @doc "Seed rate for `FxRate`, or nil if not configured."
  @spec fx_fallback_rate() :: Decimal.t() | nil
  def fx_fallback_rate do
    paystack_config_opt(:fx_fallback_rate)
  end

  @doc """
  Returns `true` when the display currency differs from
  `settlement_currency/0` and conversion is required at payment time.
  """
  @spec fx_conversion_needed?() :: boolean()
  def fx_conversion_needed? do
    settlement_currency() != Stelgano.Monetization.currency()
  end

  @doc """
  Supervisor child specs needed by this adapter.

  Returns `[]` unless Paystack is the active provider and
  `fx_conversion_needed?/0` is `true`; in that case returns a single
  `FxRate` child spec wired to the configured currency pair and
  fallback rate.
  """
  @spec child_specs() :: [Supervisor.child_spec() | {module(), term()}]
  def child_specs do
    cond do
      not Stelgano.Monetization.enabled?() ->
        []

      Stelgano.Monetization.provider() != __MODULE__ ->
        []

      not fx_conversion_needed?() ->
        []

      true ->
        [
          {FxRate,
           base: Stelgano.Monetization.currency(),
           quote: settlement_currency(),
           fallback: fx_fallback_rate()}
        ]
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

  defp paystack_config_opt(key, default \\ nil) do
    :stelgano
    |> Application.get_env(__MODULE__, [])
    |> Keyword.get(key, default)
  end

  defp convert_if_needed(amount_cents, currency) do
    if fx_conversion_needed?() do
      settlement = settlement_currency()

      case FxRate.current() do
        {:ok, rate} ->
          converted = apply_conversion(amount_cents, rate, fx_buffer_pct())

          Logger.info(
            "Paystack: converted #{amount_cents} #{currency} -> #{converted} #{settlement} " <>
              "(rate=#{rate}, buffer=#{fx_buffer_pct()}%)"
          )

          {:ok, converted, settlement}

        {:error, :unavailable} ->
          Logger.error(
            "Paystack: FX rate #{currency}->#{settlement} unavailable; refusing to initialize"
          )

          {:error, :fx_rate_unavailable}
      end
    else
      {:ok, amount_cents, currency}
    end
  end

  defp apply_conversion(amount_cents, rate, buffer_pct) do
    buffer_mult =
      (100 + buffer_pct)
      |> Decimal.new()
      |> Decimal.div(Decimal.new(100))

    amount_cents
    |> Decimal.new()
    |> Decimal.mult(rate)
    |> Decimal.mult(buffer_mult)
    |> Decimal.round(0)
    |> Decimal.to_integer()
  end

  # Paystack's `/transaction/initialize` requires an email and mails a
  # receipt to it. The operator configures `receipt_email_domain` to a
  # domain they own so receipts land in (or bounce from) infrastructure
  # they control — never a third party's mailbox.
  defp placeholder_email(token_hash) do
    "anonymous+#{String.slice(token_hash, 0, 8)}@#{paystack_config(:receipt_email_domain)}"
  end
end
