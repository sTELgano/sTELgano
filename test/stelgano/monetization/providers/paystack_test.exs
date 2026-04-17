# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Monetization.Providers.PaystackTest do
  @moduledoc """
  Tests for the Paystack payment provider adapter.

  Uses Req.Test to mock HTTP calls to the Paystack API.
  """

  use ExUnit.Case, async: true

  alias Stelgano.Monetization.Providers.Paystack

  setup do
    Application.put_env(:stelgano, Paystack,
      secret_key: "sk_test_secret",
      public_key: "pk_test_public",
      callback_url: "https://test.stelgano.com/payment/callback"
    )

    Application.put_env(:stelgano, :req_test_enabled, true)

    on_exit(fn ->
      Application.delete_env(:stelgano, Paystack)
      Application.delete_env(:stelgano, :req_test_enabled)
    end)

    :ok
  end

  # Helper to build a webhook conn with signature and raw body
  defp webhook_conn(payload, signature) do
    conn = Plug.Test.conn(:post, "/api/webhooks/paystack", payload)

    conn
    |> Plug.Conn.put_req_header("x-paystack-signature", signature)
    |> Plug.Conn.assign(:raw_body, payload)
  end

  defp webhook_conn_no_sig(payload) do
    payload
    |> then(&Plug.Test.conn(:post, "/api/webhooks/paystack", &1))
    |> Plug.Conn.assign(:raw_body, payload)
  end

  defp sign_payload(payload) do
    :hmac
    |> :crypto.mac(:sha512, "sk_test_secret", payload)
    |> Base.encode16(case: :lower)
  end

  defp dummy_hash do
    String.duplicate("a", 64)
  end

  # ---------------------------------------------------------------------------
  # initialize/3
  # ---------------------------------------------------------------------------

  describe "initialize/3" do
    test "returns checkout URL on success" do
      Req.Test.stub(Paystack, fn conn ->
        assert conn.request_path == "/transaction/initialize"
        assert conn.method == "POST"

        Req.Test.json(conn, %{
          "status" => true,
          "data" => %{"authorization_url" => "https://checkout.paystack.com/test123"}
        })
      end)

      assert {:ok, "https://checkout.paystack.com/test123"} =
               Paystack.initialize(dummy_hash(), 200, "USD")
    end

    test "returns provider_error on non-success response" do
      Req.Test.stub(Paystack, fn conn ->
        Req.Test.json(conn, %{"status" => false, "message" => "Invalid key"})
      end)

      assert {:error, :provider_error} = Paystack.initialize(dummy_hash(), 200, "USD")
    end

    test "returns provider_unavailable on transport error" do
      Req.Test.stub(Paystack, fn conn ->
        Req.Test.transport_error(conn, :econnrefused)
      end)

      assert {:error, :provider_unavailable} = Paystack.initialize(dummy_hash(), 200, "USD")
    end

    test "sends correct payload" do
      token_hash = dummy_hash()

      Req.Test.stub(Paystack, fn conn ->
        {:ok, body, _conn} = Plug.Conn.read_body(conn)
        decoded = Jason.decode!(body)

        assert decoded["reference"] == token_hash
        assert decoded["amount"] == 500
        assert decoded["currency"] == "KES"
        assert decoded["callback_url"] == "https://test.stelgano.com/payment/callback"
        assert is_list(decoded["channels"])

        Req.Test.json(conn, %{
          "status" => true,
          "data" => %{"authorization_url" => "https://checkout.paystack.com/ok"}
        })
      end)

      assert {:ok, _url} = Paystack.initialize(token_hash, 500, "KES")
    end
  end

  # ---------------------------------------------------------------------------
  # verify_transaction/1
  # ---------------------------------------------------------------------------

  describe "verify_transaction/1" do
    test "returns :ok on successful verification" do
      Req.Test.stub(Paystack, fn conn ->
        assert conn.request_path == "/transaction/verify/ref-123"
        assert conn.method == "GET"

        Req.Test.json(conn, %{
          "status" => true,
          "data" => %{"status" => "success"}
        })
      end)

      assert :ok = Paystack.verify_transaction("ref-123")
    end

    test "returns verification_failed on non-success status" do
      Req.Test.stub(Paystack, fn conn ->
        Req.Test.json(conn, %{
          "status" => true,
          "data" => %{"status" => "failed"}
        })
      end)

      assert {:error, :verification_failed} = Paystack.verify_transaction("ref-fail")
    end

    test "returns verification_failed on API error" do
      Req.Test.stub(Paystack, fn conn ->
        Req.Test.json(conn, %{"status" => false, "message" => "not found"})
      end)

      assert {:error, :verification_failed} = Paystack.verify_transaction("ref-missing")
    end

    test "returns provider_unavailable on transport error" do
      Req.Test.stub(Paystack, fn conn ->
        Req.Test.transport_error(conn, :timeout)
      end)

      assert {:error, :provider_unavailable} = Paystack.verify_transaction("ref-timeout")
    end
  end

  # ---------------------------------------------------------------------------
  # verify_webhook/1
  # ---------------------------------------------------------------------------

  describe "verify_webhook/1" do
    test "returns token_hash for valid signature and charge.success event" do
      ref = String.duplicate("b", 64)

      payload =
        Jason.encode!(%{
          "event" => "charge.success",
          "data" => %{"reference" => ref}
        })

      signature = sign_payload(payload)

      Req.Test.stub(Paystack, fn conn ->
        Req.Test.json(conn, %{
          "status" => true,
          "data" => %{"status" => "success"}
        })
      end)

      conn = webhook_conn(payload, signature)
      assert {:ok, ^ref} = Paystack.verify_webhook(conn)
    end

    test "returns invalid_signature for wrong signature" do
      payload = Jason.encode!(%{"event" => "charge.success", "data" => %{"reference" => "x"}})
      conn = webhook_conn(payload, "wrong-signature")

      assert {:error, :invalid_signature} = Paystack.verify_webhook(conn)
    end

    test "returns ignored_event for non-charge events" do
      payload = Jason.encode!(%{"event" => "transfer.success", "data" => %{}})
      conn = webhook_conn(payload, sign_payload(payload))

      assert {:error, :ignored_event} = Paystack.verify_webhook(conn)
    end

    test "returns invalid_json for malformed body" do
      payload = "not-json"
      conn = webhook_conn(payload, sign_payload(payload))

      assert {:error, :invalid_json} = Paystack.verify_webhook(conn)
    end

    test "returns invalid_signature when signature header is missing" do
      payload = Jason.encode!(%{"event" => "charge.success"})
      conn = webhook_conn_no_sig(payload)

      assert {:error, :invalid_signature} = Paystack.verify_webhook(conn)
    end
  end

  # ---------------------------------------------------------------------------
  # Behaviour compliance
  # ---------------------------------------------------------------------------

  describe "behaviour" do
    test "implements PaymentProvider behaviour" do
      attrs = Paystack.__info__(:attributes)

      behaviours =
        attrs
        |> Keyword.get_values(:behaviour)
        |> List.flatten()

      assert Stelgano.Monetization.PaymentProvider in behaviours
    end
  end
end
