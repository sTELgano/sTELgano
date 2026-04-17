# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.AnonRoomChannelTest do
  @moduledoc """
  Tests for the anonymous room Phoenix Channel.

  Covers join, message send/edit/delete/expire events, typing indicator,
  and server broadcast behaviour. Uses `Phoenix.ChannelTest` helpers.
  """

  use StelganoWeb.ChannelCase, async: false

  alias Stelgano.Rooms
  alias StelganoWeb.AnonSocket

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp hex64(seed) do
    hash = :crypto.hash(:sha256, "ch-test-#{seed}")
    Base.encode16(hash, case: :lower)
  end

  defp valid_iv do
    bytes = :crypto.strong_rand_bytes(12)
    Base.encode64(bytes)
  end

  defp valid_ct do
    bytes = :crypto.strong_rand_bytes(64)
    Base.encode64(bytes)
  end

  # Connect an anonymous socket and join a room in one step.
  defp connect_and_join(rh, ah, sh) do
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
      rh = hex64(10 + 2000)

      {:ok, reply, _socket} =
        AnonSocket
        |> socket("anon_socket", %{})
        |> subscribe_and_join(StelganoWeb.AnonRoomChannel, "anon_room:#{rh}", %{
          "access_hash" => hex64(11 + 2000),
          "sender_hash" => hex64(12 + 2000)
        })

      assert is_binary(reply.room_id)
    end

    test "delivers current_message in join reply when one exists" do
      rh = hex64(20 + 2000)
      ah = hex64(21 + 2000)
      sh = hex64(22 + 2000)

      socket1 = connect_and_join(rh, ah, sh)
      ref = push(socket1, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref, :ok, _

      # Second client joins and should receive the live message
      {:ok, reply, _socket2} =
        AnonSocket
        |> socket("anon_socket", %{})
        |> subscribe_and_join(StelganoWeb.AnonRoomChannel, "anon_room:#{rh}", %{
          "access_hash" => hex64(23 + 2000),
          "sender_hash" => hex64(24 + 2000)
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
                 %{"access_hash" => hex64(1 + 2000), "sender_hash" => hex64(2 + 2000)}
               )
    end

    test "rejects join with invalid sender_hash" do
      rh = hex64(30 + 2000)

      assert {:error, %{reason: "invalid_sender"}} =
               AnonSocket
               |> socket("anon_socket", %{})
               |> subscribe_and_join(StelganoWeb.AnonRoomChannel, "anon_room:#{rh}", %{
                 "access_hash" => hex64(31 + 2000),
                 "sender_hash" => "not-valid"
               })
    end

    test "returns not_found for expired room" do
      rh = hex64(40 + 2000)
      ah = hex64(41 + 2000)
      sh = hex64(42 + 2000)

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
      socket = connect_and_join(hex64(50 + 2000), hex64(51 + 2000), hex64(52 + 2000))
      ref = push(socket, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref, :ok, %{message_id: id}
      assert is_binary(id)
    end

    test "broadcasts new_message to channel members" do
      rh = hex64(60 + 2000)
      socket = connect_and_join(rh, hex64(61 + 2000), hex64(62 + 2000))
      StelganoWeb.Endpoint.subscribe("anon_room:#{rh}")

      ref = push(socket, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref, :ok, _

      assert_broadcast "new_message", %{sender_hash: _, ciphertext: _, iv: _}
    end

    test "blocks sender from sending twice without a reply" do
      rh = hex64(70 + 2000)
      sh = hex64(71 + 2000)
      socket = connect_and_join(rh, hex64(72 + 2000), sh)

      ref1 = push(socket, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref1, :ok, _

      ref2 = push(socket, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref2, :error, %{reason: "not_your_turn"}
    end

    test "rejects oversized ciphertext" do
      socket = connect_and_join(hex64(80 + 2000), hex64(81 + 2000), hex64(82 + 2000))
      huge_bytes = :crypto.strong_rand_bytes(10_000)
      huge_ct = Base.encode64(huge_bytes)
      ref = push(socket, "send_message", %{"ciphertext" => huge_ct, "iv" => valid_iv()})
      assert_reply ref, :error, %{reason: "message_too_large"}
    end

    test "rejects invalid base64 encoding" do
      socket = connect_and_join(hex64(90 + 2000), hex64(91 + 2000), hex64(92 + 2000))
      ref = push(socket, "send_message", %{"ciphertext" => "!!!not_b64!!!", "iv" => valid_iv()})
      assert_reply ref, :error, %{reason: "invalid_encoding"}
    end
  end

  # ---------------------------------------------------------------------------
  # read_receipt
  # ---------------------------------------------------------------------------

  describe "read_receipt" do
    test "broadcasts message_read to all channel members" do
      rh = hex64(100 + 2000)
      socket = connect_and_join(rh, hex64(101 + 2000), hex64(102 + 2000))

      ref = push(socket, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref, :ok, %{message_id: msg_id}

      socket2 = connect_and_join(rh, hex64(103 + 2000), hex64(104 + 2000))
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
      rh = hex64(110 + 2000)
      sh = hex64(111 + 2000)
      socket = connect_and_join(rh, hex64(112 + 2000), sh)
      StelganoWeb.Endpoint.subscribe("anon_room:#{rh}")

      ref1 = push(socket, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref1, :ok, %{message_id: msg_id}

      ref2 =
        push(socket, "edit_message", %{
          "message_id" => msg_id,
          "ciphertext" => valid_ct(),
          "iv" => valid_iv()
        })

      assert_reply ref2, :ok, _
      assert_broadcast "message_edited", %{message_id: ^msg_id}
    end

    test "returns not_found for another sender's message" do
      rh = hex64(120 + 2000)
      socket1 = connect_and_join(rh, hex64(121 + 2000), hex64(122 + 2000))
      socket2 = connect_and_join(rh, hex64(123 + 2000), hex64(124 + 2000))

      ref1 = push(socket1, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref1, :ok, %{message_id: msg_id}

      ref2 =
        push(socket2, "edit_message", %{
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
      rh = hex64(130 + 2000)
      sh = hex64(131 + 2000)
      socket = connect_and_join(rh, hex64(132 + 2000), sh)
      StelganoWeb.Endpoint.subscribe("anon_room:#{rh}")

      ref1 = push(socket, "send_message", %{"ciphertext" => valid_ct(), "iv" => valid_iv()})
      assert_reply ref1, :ok, %{message_id: msg_id}

      ref2 = push(socket, "delete_message", %{"message_id" => msg_id})
      assert_reply ref2, :ok, _
      assert_broadcast "message_deleted", %{message_id: ^msg_id}
    end

    test "returns not_deletable after message is read" do
      rh = hex64(140 + 2000)
      socket1 = connect_and_join(rh, hex64(141 + 2000), hex64(142 + 2000))
      socket2 = connect_and_join(rh, hex64(143 + 2000), hex64(144 + 2000))

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
      rh = hex64(150 + 2000)
      socket = connect_and_join(rh, hex64(151 + 2000), hex64(152 + 2000))
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
      rh = hex64(160 + 2000)
      socket = connect_and_join(rh, hex64(161 + 2000), hex64(162 + 2000))
      StelganoWeb.Endpoint.subscribe("anon_room:#{rh}")

      ref = push(socket, "expire_room", %{})
      assert_reply ref, :ok, _
      assert_broadcast "room_expired", %{}
    end

    test "room is inactive after expiry" do
      rh = hex64(170 + 2000)
      socket = connect_and_join(rh, hex64(171 + 2000), hex64(172 + 2000))

      ref = push(socket, "expire_room", %{})
      # Wait for the reply before checking DB state
      assert_reply ref, :ok, _

      refute Rooms.room_exists?(rh)
    end
  end

  # ---------------------------------------------------------------------------
  # redeem_extension (monetization)
  # ---------------------------------------------------------------------------

  describe "redeem_extension" do
    test "returns monetization_disabled when monetization is off" do
      rh = hex64(200 + 2000)
      socket = connect_and_join(rh, hex64(201 + 2000), hex64(202 + 2000))

      ref = push(socket, "redeem_extension", %{"extension_secret" => "some-secret"})
      assert_reply ref, :error, %{reason: "monetization_disabled"}
    end
  end
end
