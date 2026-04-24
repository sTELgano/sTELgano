# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Repo.Migrations.AddUniqueIndexOnMessagesRoomId do
  @moduledoc """
  Enforces the N=1 invariant at the DB level.

  `Rooms.send_message/4` is a delete-then-insert transaction. Under
  PostgreSQL's default READ COMMITTED isolation, two concurrent sends
  from two different senders could both observe `current_message = nil`
  and both insert — leaving two live messages in one room and silently
  violating N=1.

  A UNIQUE constraint on `messages(room_id)` makes the second concurrent
  insert raise a unique-constraint error; `send_message/4` catches the
  Ecto.ConstraintError and returns `{:error, :sender_blocked}` (the
  existing semantics for the race case).

  The previous non-unique index on `room_id` is dropped — a unique
  index serves both the constraint and the lookup.

  Safe on an empty or well-behaved table (≤1 row per room). If any
  pre-existing duplicates exist they must be cleaned up before this
  migration runs.
  """

  use Ecto.Migration

  def up do
    # If the table already carries duplicate rows per room (possible from
    # pre-constraint versions of the app), keep only the most recently
    # inserted message for each room and hard-delete the rest. The goal is
    # a consistent N=1 DB going forward; discarding stale ciphertext blobs
    # here is correct behaviour — they would have been deleted on the next
    # reply anyway.
    execute("""
    DELETE FROM messages m
    USING messages m2
    WHERE m.room_id = m2.room_id
      AND (m.inserted_at < m2.inserted_at
           OR (m.inserted_at = m2.inserted_at AND m.id < m2.id))
    """)

    drop_if_exists index(:messages, [:room_id])
    create unique_index(:messages, [:room_id])
  end

  def down do
    drop_if_exists index(:messages, [:room_id])
    create index(:messages, [:room_id])
  end
end
