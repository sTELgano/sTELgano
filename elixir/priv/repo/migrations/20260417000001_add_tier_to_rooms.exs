# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Repo.Migrations.AddTierToRooms do
  use Ecto.Migration

  def change do
    alter table(:rooms) do
      add :tier, :string, null: false, default: "free"
    end
  end
end
