# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Repo.Migrations.CreateMessages do
  use Ecto.Migration

  def change do
    create table(:messages, primary_key: false) do
      add :id, :binary_id, primary_key: true
      # Foreign key to rooms; cascade delete keeps DB clean
      add :room_id, references(:rooms, type: :binary_id, on_delete: :delete_all), null: false
      # SHA-256 hex of normalised(phone) + ":" + room_hash + ":" + SENDER_SALT
      # Lets clients know which bubble side to render; NOT reversible to identity
      add :sender_hash, :string, size: 64, null: false
      # AES-256-GCM ciphertext (binary); server is blind to plaintext
      add :ciphertext, :binary, null: false
      # 96-bit GCM nonce; stored separately for clarity
      add :iv, :binary, null: false
      # Soft-delete fields for N=1 invariant and audit
      add :read_at, :utc_datetime
      add :deleted_at, :utc_datetime

      timestamps(type: :utc_datetime)
    end

    create index(:messages, [:room_id])
    create index(:messages, [:deleted_at])
  end
end
