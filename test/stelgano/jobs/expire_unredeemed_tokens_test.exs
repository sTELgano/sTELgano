# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Jobs.ExpireUnredeemedTokensTest do
  @moduledoc """
  Tests for the ExpireUnredeemedTokens Oban job.

  Since the job checks `Monetization.enabled?()` at runtime and test
  config has monetization disabled, we test the underlying
  `Monetization.expire_stale_tokens/0` directly and verify the job
  completes without error.
  """

  use Stelgano.DataCase, async: true

  alias Stelgano.Jobs.ExpireUnredeemedTokens
  alias Stelgano.Monetization
  alias Stelgano.Monetization.ExtensionToken

  defp hex64(seed) do
    :crypto.hash(:sha256, "expire-tokens-#{seed}")
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

  describe "perform/1" do
    test "job completes successfully even when monetization is disabled" do
      assert :ok = ExpireUnredeemedTokens.perform(%Oban.Job{args: %{}})
    end
  end

  describe "expire_stale_tokens/0 (underlying function)" do
    test "expires stale pending tokens" do
      token = create_token("stale-1", expires_in: -86_400)

      count = Monetization.expire_stale_tokens()
      assert count >= 1

      updated = Repo.get!(ExtensionToken, token.id)
      assert updated.status == "expired"
    end

    test "expires stale paid tokens" do
      token = create_token("stale-2", status: "paid", expires_in: -86_400)

      count = Monetization.expire_stale_tokens()
      assert count >= 1

      updated = Repo.get!(ExtensionToken, token.id)
      assert updated.status == "expired"
    end

    test "does not expire tokens with future deadline" do
      token = create_token("future-1", expires_in: 86_400)

      Monetization.expire_stale_tokens()

      updated = Repo.get!(ExtensionToken, token.id)
      assert updated.status == "pending"
    end
  end
end
