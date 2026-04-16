# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Jobs.PurgeMessagesTest do
  @moduledoc "Tests for the PurgeMessages Oban job."

  use Stelgano.DataCase, async: true

  alias Stelgano.Jobs.PurgeMessages
  alias Stelgano.Rooms
  alias Stelgano.Rooms.Message

  defp hex64(seed) do
    hash = :crypto.hash(:sha256, "job-test-#{seed}")
    Base.encode16(hash, case: :lower)
  end

  defp iv, do: :crypto.strong_rand_bytes(12)
  defp ciphertext, do: :crypto.strong_rand_bytes(32)

  describe "perform/1" do
    test "hard-deletes soft-deleted messages older than 24 hours" do
      {:ok, room} = 1 |> hex64() |> Rooms.find_or_create_room()
      {:ok, msg} = Rooms.send_message(room.id, hex64(2), ciphertext(), iv())

      # Soft-delete the message
      Rooms.delete_message(msg.id, room.id, hex64(2))

      # Backdate deleted_at to 25 hours ago
      now = DateTime.utc_now()
      now_minus_25h = DateTime.add(now, -25 * 3600, :second)

      query = from(m in Message, where: m.id == ^msg.id)
      Repo.update_all(query, set: [deleted_at: now_minus_25h])

      # Job should purge it
      assert :ok = PurgeMessages.perform(%Oban.Job{args: %{}})

      # Message should be hard-deleted
      assert is_nil(Repo.get(Message, msg.id))
    end

    test "does not purge recently soft-deleted messages" do
      {:ok, room} = 10 |> hex64() |> Rooms.find_or_create_room()
      {:ok, msg} = Rooms.send_message(room.id, hex64(11), ciphertext(), iv())
      Rooms.delete_message(msg.id, room.id, hex64(11))

      # deleted_at is recent (just now) — should NOT be purged
      assert :ok = PurgeMessages.perform(%Oban.Job{args: %{}})

      # Message should still exist (soft-deleted but not hard-deleted)
      assert Repo.get(Message, msg.id)
    end

    test "does not purge live (non-deleted) messages" do
      {:ok, room} = 20 |> hex64() |> Rooms.find_or_create_room()
      {:ok, msg} = Rooms.send_message(room.id, hex64(21), ciphertext(), iv())

      assert :ok = PurgeMessages.perform(%Oban.Job{args: %{}})

      # Live message must not be touched
      assert Repo.get(Message, msg.id)
    end
  end
end
