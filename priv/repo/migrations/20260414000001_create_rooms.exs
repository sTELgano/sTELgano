# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Repo.Migrations.CreateRooms do
  use Ecto.Migration

  def change do
    create table(:rooms, primary_key: false) do
      add :id, :binary_id, primary_key: true
      # SHA-256 hex of normalised(phone) + ":" + ROOM_SALT
      # 64 hex characters — never reversible to the phone number
      add :room_hash, :string, size: 64, null: false
      add :is_active, :boolean, null: false, default: true
      # Optional TTL; nil means no expiry
      add :ttl_expires_at, :utc_datetime

      timestamps(type: :utc_datetime)
    end

    create unique_index(:rooms, [:room_hash])
    create index(:rooms, [:is_active])
    create index(:rooms, [:ttl_expires_at])
  end
end
