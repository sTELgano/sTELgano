# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Monetization.ExtensionTokenTest do
  @moduledoc "Tests for the ExtensionToken schema and changesets."

  use Stelgano.DataCase, async: true

  alias Stelgano.Monetization.ExtensionToken

  defp hex64(seed) do
    "token-schema-#{seed}"
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.encode16(case: :lower)
  end

  defp valid_attrs(seed \\ 1) do
    %{
      token_hash: hex64(seed),
      amount_cents: 200,
      currency: "USD",
      expires_at:
        DateTime.utc_now() |> DateTime.add(86_400, :second) |> DateTime.truncate(:second)
    }
  end

  describe "create_changeset/1" do
    test "valid attributes produce a valid changeset" do
      changeset = ExtensionToken.create_changeset(valid_attrs())
      assert changeset.valid?
    end

    test "requires token_hash" do
      attrs = Map.delete(valid_attrs(), :token_hash)
      changeset = ExtensionToken.create_changeset(attrs)
      refute changeset.valid?
      assert errors_on(changeset).token_hash != []
    end

    test "requires amount_cents" do
      attrs = Map.delete(valid_attrs(), :amount_cents)
      changeset = ExtensionToken.create_changeset(attrs)
      refute changeset.valid?
    end

    test "requires expires_at" do
      attrs = Map.delete(valid_attrs(), :expires_at)
      changeset = ExtensionToken.create_changeset(attrs)
      refute changeset.valid?
    end

    test "validates token_hash is exactly 64 chars" do
      attrs = %{valid_attrs() | token_hash: "tooshort"}
      changeset = ExtensionToken.create_changeset(attrs)
      refute changeset.valid?
    end

    test "validates token_hash is lowercase hex" do
      attrs = %{valid_attrs() | token_hash: String.duplicate("G", 64)}
      changeset = ExtensionToken.create_changeset(attrs)
      refute changeset.valid?
    end

    test "validates currency is in allowed list" do
      attrs = %{valid_attrs() | currency: "XYZ"}
      changeset = ExtensionToken.create_changeset(attrs)
      refute changeset.valid?
    end

    test "validates amount_cents is positive" do
      attrs = %{valid_attrs() | amount_cents: 0}
      changeset = ExtensionToken.create_changeset(attrs)
      refute changeset.valid?
    end

    test "default status is pending" do
      changeset = ExtensionToken.create_changeset(valid_attrs())
      assert Ecto.Changeset.get_field(changeset, :status) == "pending"
    end
  end

  describe "paid_changeset/2" do
    test "sets status to paid and paid_at" do
      attrs = valid_attrs(10)

      {:ok, token} =
        attrs
        |> ExtensionToken.create_changeset()
        |> Repo.insert()

      changeset = ExtensionToken.paid_changeset(token, %{provider_ref: "ref-abc"})
      assert changeset.valid?

      {:ok, paid} = Repo.update(changeset)
      assert paid.status == "paid"
      assert paid.paid_at != nil
      assert paid.provider_ref == "ref-abc"
    end
  end

  describe "redeemed_changeset/1" do
    test "sets status to redeemed and redeemed_at" do
      attrs = valid_attrs(20)

      {:ok, token} =
        attrs
        |> ExtensionToken.create_changeset()
        |> Repo.insert()

      paid =
        token
        |> ExtensionToken.paid_changeset(%{})
        |> Repo.update!()

      changeset = ExtensionToken.redeemed_changeset(paid)
      assert changeset.valid?

      {:ok, redeemed} = Repo.update(changeset)
      assert redeemed.status == "redeemed"
      assert redeemed.redeemed_at != nil
    end
  end
end
