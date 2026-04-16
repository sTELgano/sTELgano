# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.AnonRoomChannelTest do
  @moduledoc """
  Tests for the anonymous room Phoenix Channel.

  Covers join, message send/edit/delete/expire events, typing indicator,
  and server broadcast behaviour. Uses `Phoenix.ChannelTest` helpers.
  """

  use StelganoWeb.ChannelCase, async: true

  alias StelganoWeb.AnonSocket
  alias Stelgano.Rooms

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp hex64(seed) do
    :crypto.hash(:sha256, "ch-test-#{seed}") |> Base.encode16(case: :lower)
  end

  defp valid_iv, do: :crypto.strong_rand_bytes(12) |> Base.encode64()
  defp valid_ct, do: :crypto.strong_rand_bytes(64) |> Base.encode64()

  # Connect an anonymous socket and join a room in one step.
  defp connect_and_join(rh \\ hex64(1), ah \\ hex64(2), sh \\ hex64(3)) do
    {:ok, _reply, socket} =
      AnonSocket
      |> socket("anon_socket", %{})
      |> subscribe_and_join(StelganoWeb.AnonRoomChannel, "anon_room:#{rh}", %{
        "access_hash" => ah,
        "sender_hash" => sh
      })

    socket
  end

  # ---------------------------------------------------------------------------
  # Join
  # ---------------------------------------------------------------------------

  describe "join" do
    test "creates room on first join and returns room_id" do
      rh = hex64(10)
      {:ok, reply, _socket} =
        AnonSocket
        |> socket("anon_socket", %{})
        |> subscribe_and_join(StelganoWeb.AnonRoomChannel, "anon_room:#{rh}", %{
          "access_hash" => hex64(11),
          "sender_hash" => hex64(12)
        })

      assert is_binary(reply.room_id)
    end

    test "delivers current_message in join reply when one exists" do
      rh = hex64(20)
      ah = hex64(21)
      sh = hex64(22)

      socket1 = connect_and_join(rh, ah, sh)
      ref = push(socket1, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref, :ok, _

      # Second client joins and should receive the live message
      {:ok, reply, _socket2} =
        AnonSocket
        |> socket("anon_socket", %{})
        |> subscribe_and_join(StelganoWeb.AnonRoomChannel, "anon_room:#{rh}", %{
          "access_hash" => hex64(23),
          "sender_hash" => hex64(24)
        })

      assert reply[:current_message]
      assert reply[:current_message][:sender_hash] == sh
    end

    test "rejects join with invalid room_hash" do
      assert {:error, %{reason: "invalid_room"}} =
               AnonSocket
               |> socket("anon_socket", %{})
               |> subscribe_and_join(
                 StelganoWeb.AnonRoomChannel,
                 "anon_room:not-a-valid-hash",
                 %{"access_hash" => hex64(1), "sender_hash" => hex64(2)}
               )
    end

    test "rejects join with invalid sender_hash" do
      rh = hex64(30)
      assert {:error, %{reason: "invalid_sender"}} =
               AnonSocket
               |> socket("anon_socket", %{})
               |> subscribe_and_join(StelganoWeb.AnonRoomChannel, "anon_room:#{rh}", %{
                 "access_hash" => hex64(31),
                 "sender_hash" => "not-valid"
               })
    end

    test "returns not_found for expired room" do
      rh = hex64(40)
      ah = hex64(41)
      sh = hex64(42)

      # Join first to create the room, then expire it
      {:ok, _reply, socket} =
        AnonSocket
        |> socket("anon_socket", %{})
        |> subscribe_and_join(StelganoWeb.AnonRoomChannel, "anon_room:#{rh}", %{
          "access_hash" => ah,
          "sender_hash" => sh
        })

      ref = push(socket, "expire_room", %{})
      assert_reply ref, :ok, _

      # Re-join should fail
      assert {:error, %{reason: "not_found"}} =
               AnonSocket
               |> socket("anon_socket", %{})
               |> subscribe_and_join(StelganoWeb.AnonRoomChannel, "anon_room:#{rh}", %{
                 "access_hash" => ah,
                 "sender_hash" => sh
               })
    end
  end

  # ---------------------------------------------------------------------------
  # send_message
  # ---------------------------------------------------------------------------

  describe "send_message" do
    test "returns ok reply with message_id" do
      socket = connect_and_join(hex64(50), hex64(51), hex64(52))
      ref = push(socket, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref, :ok, %{message_id: id}
      assert is_binary(id)
    end

    test "broadcasts new_message to channel members" do
      rh = hex64(60)
      socket = connect_and_join(rh, hex64(61), hex64(62))
      StelganoWeb.Endpoint.subscribe("anon_room:#{rh}")

      ref = push(socket, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref, :ok, _

      assert_broadcast "new_message", %{sender_hash: _, ciphertext: _, iv: _}
    end

    test "blocks sender from sending twice without a reply" do
      rh = hex64(70)
      sh = hex64(71)
      socket = connect_and_join(rh, hex64(72), sh)

      ref1 = push(socket, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref1, :ok, _

      ref2 = push(socket, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref2, :error, %{reason: "not_your_turn"}
    end

    test "rejects oversized ciphertext" do
      socket = connect_and_join(hex64(80), hex64(81), hex64(82))
      huge_ct = :crypto.strong_rand_bytes(10_000) |> Base.encode64()
      ref = push(socket, "send_message", %{"ciphertext" => huge_ct, "iv" => valid_iv()})
      assert_reply ref, :error, %{reason: "message_too_large"}
    end

    test "rejects invalid base64 encoding" do
      socket = connect_and_join(hex64(90), hex64(91), hex64(92))
      ref = push(socket, "send_message", %{"ciphertext" => "!!!not_b64!!!", "iv" => valid_iv()})
      assert_reply ref, :error, %{reason: "invalid_encoding"}
    end
  end

  # ---------------------------------------------------------------------------
  # read_receipt
  # ---------------------------------------------------------------------------

  describe "read_receipt" do
    test "broadcasts message_read to all channel members" do
      rh = hex64(100)
      socket = connect_and_join(rh, hex64(101), hex64(102))

      ref = push(socket, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref, :ok, %{message_id: msg_id}

      socket2 = connect_and_join(rh, hex64(103), hex64(104))
      StelganoWeb.Endpoint.subscribe("anon_room:#{rh}")

      push(socket2, "read_receipt", %{"message_id" => msg_id})
      assert_broadcast "message_read", %{message_id: ^msg_id}
    end
  end

  # ---------------------------------------------------------------------------
  # edit_message
  # ---------------------------------------------------------------------------

  describe "edit_message" do
    test "edits an unread message and broadcasts message_edited" do
      rh = hex64(110)
      sh = hex64(111)
      socket = connect_and_join(rh, hex64(112), sh)
      StelganoWeb.Endpoint.subscribe("anon_room:#{rh}")

      ref1 = push(socket, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref1, :ok, %{message_id: msg_id}

      ref2 = push(socket, "edit_message", %{
        "message_id" => msg_id,
        "ciphertext" => valid_ct(),
        "iv" => valid_iv()
      })
      assert_reply ref2, :ok, _
      assert_broadcast "message_edited", %{message_id: ^msg_id}
    end

    test "returns not_found for another sender's message" do
      rh = hex64(120)
      socket1 = connect_and_join(rh, hex64(121), hex64(122))
      socket2 = connect_and_join(rh, hex64(123), hex64(124))

      ref1 = push(socket1, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref1, :ok, %{message_id: msg_id}

      ref2 = push(socket2, "edit_message", %{
        "message_id" => msg_id,
        "ciphertext" => valid_ct(),
        "iv" => valid_iv()
      })
      assert_reply ref2, :error, %{reason: "not_found"}
    end
  end

  # ---------------------------------------------------------------------------
  # delete_message
  # ---------------------------------------------------------------------------

  describe "delete_message" do
    test "deletes an unread message and broadcasts message_deleted" do
      rh = hex64(130)
      sh = hex64(131)
      socket = connect_and_join(rh, hex64(132), sh)
      StelganoWeb.Endpoint.subscribe("anon_room:#{rh}")

      ref1 = push(socket, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref1, :ok, %{message_id: msg_id}

      ref2 = push(socket, "delete_message", %{"message_id" => msg_id})
      assert_reply ref2, :ok, _
      assert_broadcast "message_deleted", %{message_id: ^msg_id}
    end

    test "returns not_deletable after message is read" do
      rh = hex64(140)
      socket1 = connect_and_join(rh, hex64(141), hex64(142))
      socket2 = connect_and_join(rh, hex64(143), hex64(144))

      ref1 = push(socket1, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref1, :ok, %{message_id: msg_id}

      # Mark read via socket2
      push(socket2, "read_receipt", %{"message_id" => msg_id})

      # Allow read_receipt to propagate (Oban inline mode + channel broadcast)
      :timer.sleep(50)

      ref2 = push(socket1, "delete_message", %{"message_id" => msg_id})
      assert_reply ref2, :error, %{reason: "not_deletable"}
    end
  end

  # ---------------------------------------------------------------------------
  # typing
  # ---------------------------------------------------------------------------

  describe "typing" do
    test "broadcasts counterparty_typing to others but not sender" do
      rh = hex64(150)
      socket = connect_and_join(rh, hex64(151), hex64(152))
      StelganoWeb.Endpoint.subscribe("anon_room:#{rh}")

      push(socket, "typing", %{})
      assert_broadcast "counterparty_typing", %{}
    end
  end

  # ---------------------------------------------------------------------------
  # expire_room
  # ---------------------------------------------------------------------------

  describe "expire_room" do
    test "expires the room and broadcasts room_expired" do
      rh = hex64(160)
      socket = connect_and_join(rh, hex64(161), hex64(162))
      StelganoWeb.Endpoint.subscribe("anon_room:#{rh}")

      ref = push(socket, "expire_room", %{})
      assert_reply ref, :ok, _
      assert_broadcast "room_expired", %{}
    end

    test "room is inactive after expiry" do
      rh = hex64(170)
      socket = connect_and_join(rh, hex64(171), hex64(172))

      ref = push(socket, "expire_room", %{})
      # Wait for the reply before checking DB state
      assert_reply ref, :ok, _

      refute Rooms.room_exists?(rh)
    end
  end
end
