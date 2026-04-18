# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.PaystackWebhookController do
  @moduledoc """
  Handles Paystack webhook callbacks for payment verification.

  ## Security

  - Verifies the `x-paystack-signature` HMAC-SHA512 header.
  - Double-verifies the transaction via Paystack's Verify API.
  - Returns 200 for all requests to avoid leaking information about
    which references exist.

  ## Privacy

  The webhook payload contains only the `token_hash` as the transaction
  reference. No room_hash, steg number, or user identifier is present.
  """

  use StelganoWeb, :controller

  alias Stelgano.Monetization

  require Logger

  @doc """
  Handles incoming Paystack webhook events.

  Only processes `charge.success` events. All other events are
  acknowledged with 200 OK but ignored.
  """
  @spec handle(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def handle(conn, _params) do
    if Monetization.enabled?() do
      handle_webhook(conn)
    else
      conn
      |> put_status(404)
      |> json(%{error: "not_found"})
    end
  end

  defp handle_webhook(conn) do
    provider = Monetization.provider()

    case provider.verify_webhook(conn) do
      {:ok, token_hash} ->
        process_payment(token_hash)
        json(conn, %{status: "ok"})

      {:error, :ignored_event} ->
        json(conn, %{status: "ok"})

      {:error, :invalid_signature} ->
        Logger.warning("Paystack webhook: invalid signature")

        conn
        |> put_status(401)
        |> json(%{error: "invalid_signature"})

      {:error, reason} ->
        Logger.warning("Paystack webhook error: #{inspect(reason)}")
        json(conn, %{status: "ok"})
    end
  end

  # Logs deliberately carry **no token_hash material** (not even a prefix):
  # a server operator cross-referencing request_id + timestamp against
  # DB updated_at already has enough to temporally correlate a payment
  # to a room; adding token_hash prefixes is gratuitous leakage.
  # Request-id metadata (automatic via Plug.RequestId) is enough to trace
  # a specific request through the log without naming the token.
  defp process_payment(token_hash) do
    case Monetization.mark_paid(token_hash, token_hash) do
      {:ok, _token} ->
        Logger.info("Paystack webhook: payment verified")

      {:error, :already_processed} ->
        Logger.debug("Paystack webhook: duplicate (already processed)")

      {:error, :not_found} ->
        Logger.warning("Paystack webhook: unknown token")
    end
  end
end
