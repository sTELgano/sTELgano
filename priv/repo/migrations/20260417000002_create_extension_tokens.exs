# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Repo.Migrations.CreateExtensionTokens do
  @moduledoc """
  Creates the `extension_tokens` table for privacy-preserving payment tokens.

  ## Privacy guarantee

  This table intentionally has NO `room_id`, `room_hash`, or `access_hash`
  column. The server cannot link a payment to a specific room. The correlation
  between a token and a room exists only ephemerally in memory during the
  redemption channel event.
  """

  use Ecto.Migration

  def change do
    create table(:extension_tokens, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :token_hash, :string, size: 64, null: false
      add :status, :string, size: 16, null: false, default: "pending"
      add :amount_cents, :integer, null: false
      add :currency, :string, size: 3, null: false, default: "USD"
      add :provider_ref, :string, size: 255
      add :paid_at, :utc_datetime
      add :redeemed_at, :utc_datetime
      add :expires_at, :utc_datetime, null: false

      timestamps(type: :utc_datetime)
    end

    create unique_index(:extension_tokens, [:token_hash])
    create index(:extension_tokens, [:status])
    create index(:extension_tokens, [:expires_at])
  end
end
