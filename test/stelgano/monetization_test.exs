# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.MonetizationTest do
  @moduledoc """
  Tests for the Monetization module.

  Covers configuration accessors, token lifecycle (create → pay → redeem),
  default TTL computation, stale token expiry, and the privacy invariant
  that extension_tokens has no room_id column.
  """

  use Stelgano.DataCase, async: true

  alias Stelgano.Monetization
  alias Stelgano.Monetization.ExtensionToken
  alias Stelgano.Rooms.Room

  defp hex64(seed) do
    "monetization-test-#{seed}"
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.encode16(case: :lower)
  end

  defp room_hash(seed), do: hex64("room-#{seed}")

  defp create_room(seed) do
    rh = room_hash(seed)

    {:ok, room} =
      %{room_hash: rh}
      |> Room.create_changeset()
      |> Repo.insert()

    room
  end

  defp generate_secret do
    32
    |> :crypto.strong_rand_bytes()
    |> Base.encode16(case: :lower)
  end

  defp hash_secret(secret) do
    secret
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.encode16(case: :lower)
  end

  # ---------------------------------------------------------------------------
  # Configuration accessors
  # ---------------------------------------------------------------------------

  describe "configuration" do
    test "enabled?/0 returns false by default" do
      refute Monetization.enabled?()
    end

    test "free_ttl_days/0 returns configured value" do
      assert is_integer(Monetization.free_ttl_days()) or
               Monetization.free_ttl_days() == :unlimited
    end

    test "paid_ttl_days/0 returns configured value" do
      assert is_integer(Monetization.paid_ttl_days())
    end

    test "price_cents/0 returns configured value" do
      assert is_integer(Monetization.price_cents())
      assert Monetization.price_cents() > 0
    end

    test "currency/0 returns configured value" do
      assert is_binary(Monetization.currency())
    end
  end

  # ---------------------------------------------------------------------------
  # Default TTL
  # ---------------------------------------------------------------------------

  describe "default_ttl/0" do
    test "returns nil when monetization is disabled" do
      # Default config has enabled: false
      assert is_nil(Monetization.default_ttl())
    end
  end

  # ---------------------------------------------------------------------------
  # Token lifecycle
  # ---------------------------------------------------------------------------

  describe "create_token/1" do
    test "creates a pending token with valid hash" do
      token_hash = hex64("token-1")
      assert {:ok, %ExtensionToken{} = token} = Monetization.create_token(token_hash)
      assert token.token_hash == token_hash
      assert token.status == "pending"
      assert token.amount_cents > 0
      assert token.expires_at != nil
    end

    test "rejects invalid token hash" do
      assert {:error, changeset} = Monetization.create_token("too-short")
      assert errors_on(changeset).token_hash != []
    end

    test "rejects duplicate token hash" do
      token_hash = hex64("token-dup")
      assert {:ok, _token} = Monetization.create_token(token_hash)
      assert {:error, changeset} = Monetization.create_token(token_hash)
      assert errors_on(changeset).token_hash != []
    end
  end

  describe "mark_paid/2" do
    test "marks a pending token as paid" do
      token_hash = hex64("paid-1")
      {:ok, _token} = Monetization.create_token(token_hash)

      assert {:ok, %ExtensionToken{status: "paid"}} =
               Monetization.mark_paid(token_hash, "ref-123")
    end

    test "returns already_processed for already-paid token" do
      token_hash = hex64("paid-2")
      {:ok, _token} = Monetization.create_token(token_hash)
      {:ok, _paid} = Monetization.mark_paid(token_hash)

      assert {:error, :already_processed} = Monetization.mark_paid(token_hash)
    end

    test "returns not_found for unknown token" do
      unknown = hex64("nonexistent")
      assert {:error, :not_found} = Monetization.mark_paid(unknown)
    end

    test "stores provider_ref" do
      token_hash = hex64("paid-ref")
      {:ok, _token} = Monetization.create_token(token_hash)
      {:ok, paid} = Monetization.mark_paid(token_hash, "paystack-ref-456")

      assert paid.provider_ref == "paystack-ref-456"
      assert paid.paid_at != nil
    end
  end

  describe "redeem_token/2" do
    test "redeems a paid token and extends room TTL" do
      room = create_room(1)
      secret = generate_secret()
      token_hash = hash_secret(secret)

      {:ok, _token} = Monetization.create_token(token_hash)
      {:ok, _paid} = Monetization.mark_paid(token_hash)

      assert {:ok, new_ttl} = Monetization.redeem_token(secret, room.id)
      assert DateTime.compare(new_ttl, DateTime.utc_now()) == :gt

      # Room should be updated
      updated_room = Repo.get!(Room, room.id)
      assert updated_room.tier == "paid"
      assert updated_room.ttl_expires_at != nil

      # Token should be redeemed
      updated_token = Repo.get_by!(ExtensionToken, token_hash: token_hash)
      assert updated_token.status == "redeemed"
      assert updated_token.redeemed_at != nil
    end

    test "returns error for unpaid token" do
      room = create_room(2)
      secret = generate_secret()
      token_hash = hash_secret(secret)

      {:ok, _token} = Monetization.create_token(token_hash)

      assert {:error, :invalid_token} = Monetization.redeem_token(secret, room.id)
    end

    test "returns error for already-redeemed token" do
      room = create_room(3)
      secret = generate_secret()
      token_hash = hash_secret(secret)

      {:ok, _token} = Monetization.create_token(token_hash)
      {:ok, _paid} = Monetization.mark_paid(token_hash)
      {:ok, _ttl} = Monetization.redeem_token(secret, room.id)

      # Second redemption should fail
      assert {:error, :invalid_token} = Monetization.redeem_token(secret, room.id)
    end

    test "returns error for unknown secret" do
      room = create_room(4)
      assert {:error, :invalid_token} = Monetization.redeem_token("unknown-secret", room.id)
    end
  end

  # ---------------------------------------------------------------------------
  # Stale token expiry
  # ---------------------------------------------------------------------------

  describe "expire_stale_tokens/0" do
    test "expires pending tokens past their deadline" do
      token_hash = hex64("stale-pending")
      past = DateTime.add(DateTime.utc_now(), -86_400, :second)

      %{
        token_hash: token_hash,
        amount_cents: 200,
        currency: "USD",
        expires_at: DateTime.truncate(past, :second)
      }
      |> ExtensionToken.create_changeset()
      |> Repo.insert!()

      count = Monetization.expire_stale_tokens()
      assert count >= 1

      token = Repo.get_by!(ExtensionToken, token_hash: token_hash)
      assert token.status == "expired"
    end

    test "expires paid but unredeemed tokens past their deadline" do
      token_hash = hex64("stale-paid")
      past = DateTime.add(DateTime.utc_now(), -86_400, :second)

      token =
        %{
          token_hash: token_hash,
          amount_cents: 200,
          currency: "USD",
          expires_at: DateTime.truncate(past, :second)
        }
        |> ExtensionToken.create_changeset()
        |> Repo.insert!()

      token
      |> ExtensionToken.paid_changeset(%{})
      |> Repo.update!()

      count = Monetization.expire_stale_tokens()
      assert count >= 1

      updated = Repo.get_by!(ExtensionToken, token_hash: token_hash)
      assert updated.status == "expired"
    end

    test "does not expire tokens with future deadline" do
      token_hash = hex64("stale-future")
      future = DateTime.add(DateTime.utc_now(), 86_400, :second)

      %{
        token_hash: token_hash,
        amount_cents: 200,
        currency: "USD",
        expires_at: DateTime.truncate(future, :second)
      }
      |> ExtensionToken.create_changeset()
      |> Repo.insert!()

      Monetization.expire_stale_tokens()

      token = Repo.get_by!(ExtensionToken, token_hash: token_hash)
      assert token.status == "pending"
    end
  end

  # ---------------------------------------------------------------------------
  # Privacy invariant
  # ---------------------------------------------------------------------------

  describe "privacy invariant" do
    test "extension_tokens table has no room_id column" do
      fields = ExtensionToken.__schema__(:fields)
      refute :room_id in fields
      refute :room_hash in fields
      refute :access_hash in fields
    end

    test "after full payment cycle, no DB row links token to room" do
      room = create_room(10)
      secret = generate_secret()
      token_hash = hash_secret(secret)

      {:ok, _token} = Monetization.create_token(token_hash)
      {:ok, _paid} = Monetization.mark_paid(token_hash)
      {:ok, _ttl} = Monetization.redeem_token(secret, room.id)

      # The token row should have no room reference
      redeemed = Repo.get_by!(ExtensionToken, token_hash: token_hash)
      fields = Map.keys(redeemed) -- [:__meta__, :__struct__]
      refute Enum.any?(fields, &(&1 in [:room_id, :room_hash]))
    end
  end

  # ---------------------------------------------------------------------------
  # initialize_payment/1
  # ---------------------------------------------------------------------------

  describe "initialize_payment/1" do
    test "returns error when no provider configured" do
      token_hash = hex64("no-provider")
      assert {:error, :no_provider_configured} = Monetization.initialize_payment(token_hash)
    end
  end
end
