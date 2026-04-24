# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Repo.Migrations.CreateRoomAccess do
  use Ecto.Migration

  def change do
    create table(:room_access, primary_key: false) do
      add :id, :binary_id, primary_key: true
      # References rooms.room_hash (logical FK — not FK constraint for performance)
      add :room_hash, :string, size: 64, null: false
      # SHA-256 hex of normalised(phone) + ":" + PIN + ":" + ACCESS_SALT
      add :access_hash, :string, size: 64, null: false
      # Brute-force protection counters
      add :failed_attempts, :integer, null: false, default: 0
      add :locked_until, :utc_datetime

      timestamps(type: :utc_datetime)
    end

    # A given room can have at most two access records (one per party)
    # The (room_hash, access_hash) pair must be unique
    create unique_index(:room_access, [:room_hash, :access_hash])
    create index(:room_access, [:room_hash])
  end
end
