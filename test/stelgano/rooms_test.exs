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
  alias Stelgano.Rooms.Message
  alias Stelgano.Rooms.Room
  alias Stelgano.Rooms.RoomAccess

  # ---------------------------------------------------------------------------
  # Fixtures
  # ---------------------------------------------------------------------------

  # Valid SHA-256 hex strings (64 chars)
  defp hex64(seed) do
    hash = :crypto.hash(:sha256, "test-seed-#{seed}")
    Base.encode16(hash, case: :lower)
  end

  defp room_hash, do: hex64(1)
  defp sender_hash, do: hex64(4)

  # 12-byte IV (96-bit AES-GCM nonce)
  defp iv, do: :crypto.strong_rand_bytes(12)

  # Small ciphertext blob
  defp ciphertext, do: :crypto.strong_rand_bytes(64)

  defp access_count(rh) do
    RoomAccess |> where([a], a.room_hash == ^rh) |> Repo.aggregate(:count)
  end

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
      refute 20 |> hex64() |> Rooms.room_exists?()
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

    test "returns :unauthorized with remaining count on wrong hash after room is full" do
      rh = hex64(50)
      ah_correct1 = hex64(51)
      ah_correct2 = hex64(52)
      ah_wrong = hex64(53)

      Rooms.join_room(rh, ah_correct1)
      Rooms.join_room(rh, ah_correct2)

      assert {:error, :unauthorized, remaining} = Rooms.join_room(rh, ah_wrong)
      assert remaining == RoomAccess.max_attempts() - 1
    end

    test "locks out after max attempts" do
      rh = hex64(60)
      ah_correct1 = hex64(61)
      ah_correct2 = hex64(62)
      ah_wrong = hex64(63)

      Rooms.join_room(rh, ah_correct1)
      Rooms.join_room(rh, ah_correct2)

      # Attempt many times with the 3rd (wrong) hash
      for _attempt <- 1..(RoomAccess.max_attempts() - 1) do
        assert {:error, :unauthorized, _remaining} = Rooms.join_room(rh, ah_wrong)
      end

      assert {:error, :locked, _remaining} = Rooms.join_room(rh, ah_wrong)
    end

    test "correct credentials reset failed attempt counter" do
      rh = hex64(70)
      ah1 = hex64(71)
      ah2 = hex64(72)
      ah_wrong = hex64(73)

      Rooms.join_room(rh, ah1)
      Rooms.join_room(rh, ah2)

      # Target the existing records with failures
      Rooms.join_room(rh, ah_wrong)
      Rooms.join_room(rh, ah_wrong)

      # One of the records should have failures now.
      # We check both and verify that at least one is non-zero,
      # or we just joining with both to ensure both are reset.
      assert {:ok, _room1} = Rooms.join_room(rh, ah1)
      assert {:ok, _room2} = Rooms.join_room(rh, ah2)

      access1 = Repo.get_by(RoomAccess, room_hash: rh, access_hash: ah1)
      access2 = Repo.get_by(RoomAccess, room_hash: rh, access_hash: ah2)
      assert access1.failed_attempts == 0
      assert access2.failed_attempts == 0
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

    test "new message hard-deletes the previous one atomically", %{room: room} do
      sh1 = hex64(80)
      sh2 = hex64(81)

      {:ok, msg1} = Rooms.send_message(room.id, sh1, ciphertext(), iv())

      # sh2 replies — this should hard-delete msg1
      {:ok, _msg2} = Rooms.send_message(room.id, sh2, ciphertext(), iv())

      # msg1 should be completely gone from the database
      assert is_nil(Repo.get(Message, msg1.id))
    end

    test "at most one message exists after multiple sends", %{room: room} do
      sh1 = hex64(82)
      sh2 = hex64(83)

      Rooms.send_message(room.id, sh1, ciphertext(), iv())
      Rooms.send_message(room.id, sh2, ciphertext(), iv())

      query = from(m in Message, where: m.room_id == ^room.id)

      live_count = Repo.aggregate(query, :count)

      assert live_count == 1
    end

    test "blocks sender if they already have the live message", %{room: room} do
      sh = sender_hash()

      {:ok, _msg} = Rooms.send_message(room.id, sh, ciphertext(), iv())

      assert {:error, :sender_blocked} =
               Rooms.send_message(room.id, sh, ciphertext(), iv())
    end
  end

  # ---------------------------------------------------------------------------
  # current_message/1
  # ---------------------------------------------------------------------------

  describe "current_message/1" do
    setup do
      {:ok, room} = 90 |> hex64() |> Rooms.find_or_create_room()
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
      {:ok, room} = 100 |> hex64() |> Rooms.find_or_create_room()
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
      {:ok, room} = 120 |> hex64() |> Rooms.find_or_create_room()
      sh = sender_hash()
      {:ok, msg} = Rooms.send_message(room.id, sh, ciphertext(), iv())
      %{room: room, msg: msg, sh: sh}
    end

    test "hard-deletes an unread message", %{room: room, msg: msg, sh: sh} do
      assert {:ok, _deleted} = Rooms.delete_message(msg.id, room.id, sh)
      assert is_nil(Repo.get(Message, msg.id))
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
    test "sets is_active = false and hard-deletes messages" do
      {:ok, room} = 130 |> hex64() |> Rooms.find_or_create_room()
      {:ok, msg} = Rooms.send_message(room.id, sender_hash(), ciphertext(), iv())

      assert {:ok, expired} = Rooms.expire_room(room.id)
      assert expired.is_active == false

      # Message should be completely gone from the database
      assert is_nil(Repo.get(Message, msg.id))
    end

    test "room_exists? returns false for expired room" do
      rh = hex64(131)
      {:ok, room} = Rooms.find_or_create_room(rh)
      Rooms.expire_room(room.id)
      refute Rooms.room_exists?(rh)
    end

    test "hard-deletes all RoomAccess rows for the expired room" do
      rh = hex64(132)
      {:ok, room} = Rooms.find_or_create_room(rh)

      # Register two access records (two parties)
      Rooms.join_room(rh, hex64(133))
      Rooms.join_room(rh, hex64(134))

      assert access_count(rh) == 2
      assert {:ok, _expired} = Rooms.expire_room(room.id)
      assert access_count(rh) == 0
    end

    test "does not touch RoomAccess rows for other rooms" do
      rh_a = hex64(135)
      rh_b = hex64(136)

      {:ok, room_a} = Rooms.find_or_create_room(rh_a)
      {:ok, _room_b} = Rooms.find_or_create_room(rh_b)

      Rooms.join_room(rh_a, hex64(137))
      Rooms.join_room(rh_b, hex64(138))

      {:ok, _expired} = Rooms.expire_room(room_a.id)

      assert access_count(rh_a) == 0
      assert access_count(rh_b) == 1
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
      140 |> hex64() |> Rooms.find_or_create_room()
      after_ = Rooms.aggregate_metrics().active_rooms
      assert after_ == before + 1
    end
  end
end
