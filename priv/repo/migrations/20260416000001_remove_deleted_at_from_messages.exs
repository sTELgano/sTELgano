# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Repo.Migrations.RemoveDeletedAtFromMessages do
  @moduledoc """
  Removes the `deleted_at` column and its index from the `messages` table.

  Messages are now hard-deleted immediately when a reply arrives (N=1 invariant)
  or when the sender explicitly deletes before read. There is no longer a
  soft-delete → deferred-purge lifecycle, so the column is unnecessary.

  Any rows that still have `deleted_at IS NOT NULL` (leftover soft-deleted
  messages) are hard-deleted first to keep the table clean.
  """

  use Ecto.Migration

  def up do
    # Hard-delete any lingering soft-deleted messages before dropping the column
    execute("DELETE FROM messages WHERE deleted_at IS NOT NULL")

    drop_if_exists index(:messages, [:deleted_at])
    alter table(:messages) do
      remove :deleted_at
    end
  end

  def down do
    alter table(:messages) do
      add :deleted_at, :utc_datetime
    end

    create index(:messages, [:deleted_at])
  end
end
