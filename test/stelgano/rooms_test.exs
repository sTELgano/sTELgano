# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.RoomsTest do
  @moduledoc """
  Tests for the Rooms context.

  Covers room creation, join/access control, N=1 messaging invariant,
  edit/delete before read, and expiry.
  """

  use Stelgano.DataCase, async: true

  alias Stelgano.Rooms
  alias Stelgano.Rooms.{Message, Room, RoomAccess}

  # ---------------------------------------------------------------------------
  # Fixtures
  # ---------------------------------------------------------------------------

  # Valid SHA-256 hex strings (64 chars)
  defp hex64(seed \\ 0) do
    :crypto.hash(:sha256, "test-seed-#{seed}")
    |> Base.encode16(case: :lower)
  end

  defp room_hash, do: hex64(1)
  defp access_hash, do: hex64(2)
  defp other_access_hash, do: hex64(3)
  defp sender_hash, do: hex64(4)

  # 12-byte IV (96-bit AES-GCM nonce)
  defp iv, do: :crypto.strong_rand_bytes(12)

  # Small ciphertext blob
  defp ciphertext, do: :crypto.strong_rand_bytes(64)

  # ---------------------------------------------------------------------------
  # Room creation via find_or_create_room/1
  # ---------------------------------------------------------------------------

  describe "find_or_create_room/1" do
    test "creates a new room for a fresh hash" do
      rh = hex64(10)
      assert {:ok, %Room{room_hash: ^rh, is_active: true}} = Rooms.find_or_create_room(rh)
    end

    test "returns the same room on second call with same hash" do
      rh = hex64(11)
      {:ok, room1} = Rooms.find_or_create_room(rh)
      {:ok, room2} = Rooms.find_or_create_room(rh)
      assert room1.id == room2.id
    end

    test "returns error for invalid hash format" do
      assert {:error, changeset} = Rooms.find_or_create_room("not-valid")
      assert changeset.errors[:room_hash]
    end
  end

  # ---------------------------------------------------------------------------
  # room_exists?/1
  # ---------------------------------------------------------------------------

  describe "room_exists?/1" do
    test "returns false for unknown room" do
      refute Rooms.room_exists?(hex64(20))
    end

    test "returns true for an active room" do
      rh = hex64(21)
      Rooms.find_or_create_room(rh)
      assert Rooms.room_exists?(rh)
    end

    test "returns false for an expired room" do
      rh = hex64(22)
      {:ok, room} = Rooms.find_or_create_room(rh)
      Rooms.expire_room(room.id)
      refute Rooms.room_exists?(rh)
    end
  end

  # ---------------------------------------------------------------------------
  # join_room/2 — happy path
  # ---------------------------------------------------------------------------

  describe "join_room/2 — happy path" do
    test "first join creates room + access record and returns room" do
      rh = hex64(30)
      ah = hex64(31)
      assert {:ok, %Room{room_hash: ^rh}} = Rooms.join_room(rh, ah)
      # Access record should now exist
      assert Repo.get_by(RoomAccess, room_hash: rh, access_hash: ah)
    end

    test "second join with same credentials succeeds" do
      rh = hex64(32)
      ah = hex64(33)
      Rooms.join_room(rh, ah)
      assert {:ok, %Room{}} = Rooms.join_room(rh, ah)
    end

    test "second user joins same room with different access_hash" do
      rh = hex64(34)
      ah1 = hex64(35)
      ah2 = hex64(36)
      {:ok, room1} = Rooms.join_room(rh, ah1)
      {:ok, room2} = Rooms.join_room(rh, ah2)
      assert room1.id == room2.id
    end
  end

  # ---------------------------------------------------------------------------
  # join_room/2 — failure and lockout
  # ---------------------------------------------------------------------------

  describe "join_room/2 — failure" do
    test "returns :not_found for unknown room_hash with no access records" do
      rh = hex64(40)
      ah = hex64(41)
      # Room was never created via find_or_create_room
      # But join_room auto-creates rooms on first join; test not_found needs:
      # a room_hash that doesn't have an active room — we test after expire
      Rooms.join_room(rh, ah)
      {:ok, room} = Rooms.find_or_create_room(rh)
      Rooms.expire_room(room.id)
      # Now room is inactive
      result = Rooms.join_room(rh, hex64(42))
      assert result == {:error, :not_found}
    end

    test "returns :unauthorized with remaining count on wrong hash after first join" do
      rh = hex64(50)
      ah_correct = hex64(51)
      ah_wrong = hex64(52)
      Rooms.join_room(rh, ah_correct)

      assert {:error, :unauthorized, remaining} = Rooms.join_room(rh, ah_wrong)
      assert remaining == RoomAccess.max_attempts() - 1
    end

    test "locks out after max attempts" do
      rh = hex64(60)
      ah_correct = hex64(61)
      ah_wrong = hex64(62)
      Rooms.join_room(rh, ah_correct)

      for _ <- 1..RoomAccess.max_attempts() do
        Rooms.join_room(rh, ah_wrong)
      end

      assert {:error, :locked, _remaining} = Rooms.join_room(rh, ah_wrong)
    end

    test "correct credentials reset failed attempt counter" do
      rh = hex64(70)
      ah = hex64(71)
      ah_wrong = hex64(72)
      Rooms.join_room(rh, ah)

      # A few failed attempts
      Rooms.join_room(rh, ah_wrong)
      Rooms.join_room(rh, ah_wrong)

      # Correct credentials reset counter
      assert {:ok, _} = Rooms.join_room(rh, ah)

      access = Repo.get_by(RoomAccess, room_hash: rh, access_hash: ah)
      assert access.failed_attempts == 0
    end
  end

  # ---------------------------------------------------------------------------
  # N=1 messaging — send_message/4
  # ---------------------------------------------------------------------------

  describe "send_message/4" do
    setup do
      rh = room_hash()
      {:ok, room} = Rooms.find_or_create_room(rh)
      %{room: room, room_hash: rh}
    end

    test "sends a message and returns it", %{room: room} do
      assert {:ok, %Message{}} =
               Rooms.send_message(room.id, sender_hash(), ciphertext(), iv())
    end

    test "new message soft-deletes the previous one atomically", %{room: room} do
      sh1 = hex64(80)
      sh2 = hex64(81)

      {:ok, msg1} = Rooms.send_message(room.id, sh1, ciphertext(), iv())
      assert is_nil(msg1.deleted_at)

      # sh2 replies — this should delete msg1
      {:ok, _msg2} = Rooms.send_message(room.id, sh2, ciphertext(), iv())

      # msg1 should now be soft-deleted
      reloaded = Repo.get!(Message, msg1.id)
      assert reloaded.deleted_at != nil
    end

    test "at most one live message exists after multiple sends", %{room: room} do
      sh1 = hex64(82)
      sh2 = hex64(83)

      Rooms.send_message(room.id, sh1, ciphertext(), iv())
      Rooms.send_message(room.id, sh2, ciphertext(), iv())

      live_count =
        Repo.aggregate(
          from(m in Message,
            where: m.room_id == ^room.id and is_nil(m.deleted_at)
          ),
          :count
        )

      assert live_count == 1
    end

    test "blocks sender if they already have the live message", %{room: room} do
      sh = sender_hash()

      {:ok, _} = Rooms.send_message(room.id, sh, ciphertext(), iv())

      assert {:error, :sender_blocked} =
               Rooms.send_message(room.id, sh, ciphertext(), iv())
    end
  end

  # ---------------------------------------------------------------------------
  # current_message/1
  # ---------------------------------------------------------------------------

  describe "current_message/1" do
    setup do
      {:ok, room} = Rooms.find_or_create_room(hex64(90))
      %{room: room}
    end

    test "returns nil for empty room", %{room: room} do
      assert is_nil(Rooms.current_message(room.id))
    end

    test "returns the live message after send", %{room: room} do
      {:ok, msg} = Rooms.send_message(room.id, sender_hash(), ciphertext(), iv())
      current = Rooms.current_message(room.id)
      assert current.id == msg.id
    end
  end

  # ---------------------------------------------------------------------------
  # mark_read/1
  # ---------------------------------------------------------------------------

  describe "mark_read/1" do
    setup do
      {:ok, room} = Rooms.find_or_create_room(hex64(100))
      {:ok, msg} = Rooms.send_message(room.id, sender_hash(), ciphertext(), iv())
      %{room: room, msg: msg}
    end

    test "marks a message as read", %{msg: msg} do
      assert {:ok, updated} = Rooms.mark_read(msg.id)
      assert updated.read_at != nil
    end

    test "returns :already_read on second call", %{msg: msg} do
      Rooms.mark_read(msg.id)
      assert {:error, :already_read} = Rooms.mark_read(msg.id)
    end

    test "returns :not_found for unknown id" do
      assert {:error, :not_found} = Rooms.mark_read(Ecto.UUID.generate())
    end
  end

  # ---------------------------------------------------------------------------
  # edit_message/5
  # ---------------------------------------------------------------------------

  describe "edit_message/5" do
    setup do
      rh = hex64(110)
      {:ok, room} = Rooms.find_or_create_room(rh)
      sh = sender_hash()
      {:ok, msg} = Rooms.send_message(room.id, sh, ciphertext(), iv())
      %{room: room, msg: msg, sh: sh}
    end

    test "edits an unread message", %{room: room, msg: msg, sh: sh} do
      new_ct = :crypto.strong_rand_bytes(32)
      new_iv = iv()
      assert {:ok, updated} = Rooms.edit_message(msg.id, room.id, sh, new_ct, new_iv)
      assert updated.ciphertext == new_ct
    end

    test "returns :not_editable after the message is read", %{room: room, msg: msg, sh: sh} do
      Rooms.mark_read(msg.id)
      assert {:error, :not_editable} = Rooms.edit_message(msg.id, room.id, sh, ciphertext(), iv())
    end

    test "returns :not_found for wrong sender", %{room: room, msg: msg} do
      wrong_sh = hex64(111)

      assert {:error, :not_found} =
               Rooms.edit_message(msg.id, room.id, wrong_sh, ciphertext(), iv())
    end
  end

  # ---------------------------------------------------------------------------
  # delete_message/3
  # ---------------------------------------------------------------------------

  describe "delete_message/3" do
    setup do
      {:ok, room} = Rooms.find_or_create_room(hex64(120))
      sh = sender_hash()
      {:ok, msg} = Rooms.send_message(room.id, sh, ciphertext(), iv())
      %{room: room, msg: msg, sh: sh}
    end

    test "deletes an unread message", %{room: room, msg: msg, sh: sh} do
      assert {:ok, deleted} = Rooms.delete_message(msg.id, room.id, sh)
      assert deleted.deleted_at != nil
    end

    test "returns :not_deletable after the message is read", %{room: room, msg: msg, sh: sh} do
      Rooms.mark_read(msg.id)
      assert {:error, :not_deletable} = Rooms.delete_message(msg.id, room.id, sh)
    end

    test "room returns to empty state after delete", %{room: room, msg: msg, sh: sh} do
      Rooms.delete_message(msg.id, room.id, sh)
      assert is_nil(Rooms.current_message(room.id))
    end
  end

  # ---------------------------------------------------------------------------
  # expire_room/1
  # ---------------------------------------------------------------------------

  describe "expire_room/1" do
    test "sets is_active = false and soft-deletes messages" do
      {:ok, room} = Rooms.find_or_create_room(hex64(130))
      {:ok, msg} = Rooms.send_message(room.id, sender_hash(), ciphertext(), iv())

      assert {:ok, expired} = Rooms.expire_room(room.id)
      assert expired.is_active == false

      # Message should be soft-deleted
      reloaded = Repo.get!(Message, msg.id)
      assert reloaded.deleted_at != nil
    end

    test "room_exists? returns false for expired room" do
      rh = hex64(131)
      {:ok, room} = Rooms.find_or_create_room(rh)
      Rooms.expire_room(room.id)
      refute Rooms.room_exists?(rh)
    end
  end

  # ---------------------------------------------------------------------------
  # aggregate_metrics/0
  # ---------------------------------------------------------------------------

  describe "aggregate_metrics/0" do
    test "returns a map with expected keys" do
      metrics = Rooms.aggregate_metrics()
      assert is_map(metrics)
      assert Map.has_key?(metrics, :active_rooms)
      assert Map.has_key?(metrics, :rooms_today)
      assert Map.has_key?(metrics, :messages_today)
    end

    test "active_rooms count increments on room creation" do
      before = Rooms.aggregate_metrics().active_rooms
      Rooms.find_or_create_room(hex64(140))
      after_ = Rooms.aggregate_metrics().active_rooms
      assert after_ == before + 1
    end
  end
end
