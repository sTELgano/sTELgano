# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Jobs.ExpireUnredeemedTokensTest do
  @moduledoc """
  Tests for the ExpireUnredeemedTokens Oban job.

  Tests both the disabled path (job skips) and the enabled path
  (job calls expire_stale_tokens). Uses Application config overrides
  to toggle monetization for specific tests.
  """

  use Stelgano.DataCase, async: false

  alias Stelgano.Jobs.ExpireUnredeemedTokens
  alias Stelgano.Monetization
  alias Stelgano.Monetization.ExtensionToken

  defp hex64(seed) do
    "expire-tokens-#{seed}"
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.encode16(case: :lower)
  end

  defp create_token(seed, opts) do
    status = Keyword.get(opts, :status, "pending")
    expires_offset = Keyword.get(opts, :expires_in, -86_400)

    expires_at =
      DateTime.utc_now()
      |> DateTime.add(expires_offset, :second)
      |> DateTime.truncate(:second)

    token =
      %{
        token_hash: hex64(seed),
        amount_cents: 200,
        currency: "USD",
        expires_at: expires_at
      }
      |> ExtensionToken.create_changeset()
      |> Repo.insert!()

    if status == "paid" do
      token
      |> ExtensionToken.paid_changeset(%{})
      |> Repo.update!()
    else
      token
    end
  end

  describe "perform/1 (monetization disabled)" do
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

    test "completes successfully without expiring tokens" do
      token = create_token("disabled-1", expires_in: -86_400)

      assert :ok = ExpireUnredeemedTokens.perform(%Oban.Job{args: %{}})

      # Token should NOT be expired because monetization is disabled
      updated = Repo.get!(ExtensionToken, token.id)
      assert updated.status == "pending"
    end
  end

  describe "perform/1 (monetization enabled)" do
    setup do
      original = Application.get_env(:stelgano, Stelgano.Monetization)

      Application.put_env(:stelgano, Stelgano.Monetization,
        enabled: true,
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

    test "expires stale pending tokens" do
      token = create_token("enabled-1", expires_in: -86_400)

      assert :ok = ExpireUnredeemedTokens.perform(%Oban.Job{args: %{}})

      updated = Repo.get!(ExtensionToken, token.id)
      assert updated.status == "expired"
    end

    test "expires stale paid tokens" do
      token = create_token("enabled-2", status: "paid", expires_in: -86_400)

      assert :ok = ExpireUnredeemedTokens.perform(%Oban.Job{args: %{}})

      updated = Repo.get!(ExtensionToken, token.id)
      assert updated.status == "expired"
    end

    test "does not expire tokens with future deadline" do
      token = create_token("enabled-3", expires_in: 86_400)

      assert :ok = ExpireUnredeemedTokens.perform(%Oban.Job{args: %{}})

      updated = Repo.get!(ExtensionToken, token.id)
      assert updated.status == "pending"
    end
  end

  describe "expire_stale_tokens/0 (direct)" do
    test "expires stale pending tokens" do
      token = create_token("direct-1", expires_in: -86_400)

      count = Monetization.expire_stale_tokens()
      assert count >= 1

      updated = Repo.get!(ExtensionToken, token.id)
      assert updated.status == "expired"
    end

    test "does not expire tokens with future deadline" do
      token = create_token("direct-2", expires_in: 86_400)

      Monetization.expire_stale_tokens()

      updated = Repo.get!(ExtensionToken, token.id)
      assert updated.status == "pending"
    end
  end
end
