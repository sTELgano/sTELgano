# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Rooms.SchemaTest do
  @moduledoc "Unit tests for Ecto schema changesets."

  use Stelgano.DataCase, async: true

  alias Stelgano.Rooms.{Message, Room, RoomAccess}

  defp valid_hex64, do: :crypto.hash(:sha256, "schema-test") |> Base.encode16(case: :lower)
  defp valid_iv, do: :crypto.strong_rand_bytes(12)

  # ---------------------------------------------------------------------------
  # Room changeset
  # ---------------------------------------------------------------------------

  describe "Room.create_changeset/1" do
    test "valid with 64-char lowercase hex room_hash" do
      cs = Room.create_changeset(%{room_hash: valid_hex64()})
      assert cs.valid?
    end

    test "invalid with empty room_hash" do
      cs = Room.create_changeset(%{room_hash: ""})
      refute cs.valid?
      assert cs.errors[:room_hash]
    end

    test "invalid with wrong length" do
      cs = Room.create_changeset(%{room_hash: "abc123"})
      refute cs.valid?
    end

    test "invalid with uppercase hex" do
      h = :crypto.hash(:sha256, "test") |> Base.encode16(case: :upper)
      cs = Room.create_changeset(%{room_hash: h})
      refute cs.valid?
    end
  end

  # ---------------------------------------------------------------------------
  # RoomAccess changeset
  # ---------------------------------------------------------------------------

  describe "RoomAccess.create_changeset/1" do
    test "valid with correct hashes" do
      cs = RoomAccess.create_changeset(%{room_hash: valid_hex64(), access_hash: valid_hex64()})
      assert cs.valid?
    end

    test "invalid when room_hash missing" do
      cs = RoomAccess.create_changeset(%{access_hash: valid_hex64()})
      refute cs.valid?
    end
  end

  describe "RoomAccess.locked?/1" do
    test "returns false when locked_until is nil" do
      access = %RoomAccess{failed_attempts: 0, locked_until: nil}
      refute RoomAccess.locked?(access)
    end

    test "returns true when locked_until is in the future" do
      future = DateTime.add(DateTime.utc_now(), 600, :second)
      access = %RoomAccess{failed_attempts: 10, locked_until: future}
      assert RoomAccess.locked?(access)
    end

    test "returns false when locked_until is in the past" do
      past = DateTime.add(DateTime.utc_now(), -600, :second)
      access = %RoomAccess{failed_attempts: 10, locked_until: past}
      refute RoomAccess.locked?(access)
    end
  end

  describe "RoomAccess.failed_attempt_changeset/1" do
    test "increments failed_attempts" do
      access = %RoomAccess{failed_attempts: 2, locked_until: nil}
      cs = RoomAccess.failed_attempt_changeset(access)
      assert Ecto.Changeset.get_field(cs, :failed_attempts) == 3
    end

    test "sets locked_until after max_attempts" do
      access = %RoomAccess{failed_attempts: RoomAccess.max_attempts() - 1, locked_until: nil}
      cs = RoomAccess.failed_attempt_changeset(access)
      assert Ecto.Changeset.get_field(cs, :locked_until) != nil
    end
  end

  # ---------------------------------------------------------------------------
  # Message changeset
  # ---------------------------------------------------------------------------

  describe "Message.create_changeset/1" do
    test "valid with correct fields" do
      cs =
        Message.create_changeset(%{
          sender_hash: valid_hex64(),
          ciphertext: :crypto.strong_rand_bytes(32),
          iv: valid_iv()
        })

      assert cs.valid?
    end

    test "invalid with wrong IV length" do
      cs =
        Message.create_changeset(%{
          sender_hash: valid_hex64(),
          ciphertext: :crypto.strong_rand_bytes(32),
          # must be 12
          iv: :crypto.strong_rand_bytes(8)
        })

      refute cs.valid?
      assert cs.errors[:iv]
    end

    test "invalid when ciphertext missing" do
      cs =
        Message.create_changeset(%{
          sender_hash: valid_hex64(),
          iv: valid_iv()
        })

      refute cs.valid?
    end
  end
end
