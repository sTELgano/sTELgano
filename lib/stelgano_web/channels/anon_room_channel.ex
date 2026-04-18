# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.AnonRoomChannel do
  @moduledoc """
  Phoenix Channel for anonymous room real-time communication.

  ## Security model

  - No authentication cookie or session is used for this socket.
  - The only credential required to join is a valid `(room_hash, access_hash)` pair
    verified against the database inside `join/3`.
  - The `sender_hash` is an opaque SHA-256 hex string; the server cannot derive
    the phone number or PIN from it.
  - All message content is opaque ciphertext — the server never decrypts.

  ## Channel topic

  `anon_room:{room_hash}` where `room_hash` is the 64-character lowercase hex
  SHA-256 of `normalise(phone) + ":" + ROOM_SALT`.

  ## Client → Server events

      join            %{"sender_hash" => hex64, "access_hash" => hex64}
      send_message    %{"ciphertext" => base64, "iv" => base64}
      read_receipt    %{"message_id" => uuid}
      edit_message    %{"message_id" => uuid, "ciphertext" => base64, "iv" => base64}
      delete_message  %{"message_id" => uuid}
      typing          %{}
      expire_room     %{}

  ## Server → Client broadcasts

      new_message         %{id, sender_hash, ciphertext, iv, read_at, inserted_at}
      message_read        %{message_id}
      message_edited      %{message_id, ciphertext, iv}
      message_deleted     %{message_id}
      counterparty_typing %{}
      room_expired        %{}
  """

  use StelganoWeb, :channel

  alias Stelgano.Monetization
  alias Stelgano.Rooms

  require Logger

  # Maximum base64-encoded ciphertext length accepted per message.
  # Covers up to 4,000 UTF-8 chars of plaintext + AES-GCM overhead.
  @max_ciphertext_bytes 8_192

  # ---------------------------------------------------------------------------
  # Join
  # ---------------------------------------------------------------------------

  @impl Phoenix.Channel
  def join("anon_room:" <> room_hash, payload, socket) do
    access_hash = Map.get(payload, "access_hash", "")
    raw_sender = Map.get(payload, "sender_hash", "")

    with :ok <- validate_hex64(room_hash, :invalid_room),
         {:ok, room} <- Rooms.join_room(room_hash, access_hash),
         :ok <- validate_hex64(raw_sender, :invalid_sender) do
      socket =
        socket
        |> assign(:room_id, room.id)
        |> assign(:room_hash, room_hash)
        |> assign(:sender_hash, raw_sender)

      current = Rooms.current_message(room.id)

      reply = maybe_put_current_message(%{room_id: room.id}, current)

      {:ok, reply, socket}
    else
      {:error, :invalid_room} ->
        {:error, %{reason: "invalid_room"}}

      {:error, :invalid_sender} ->
        {:error, %{reason: "invalid_sender"}}

      {:error, :not_found} ->
        {:error, %{reason: "not_found"}}

      {:error, :locked, _remaining} ->
        {:error, %{reason: "locked"}}

      {:error, :unauthorized, remaining} ->
        {:error, %{reason: "unauthorized", attempts_remaining: remaining}}
    end
  end

  def join(_topic, _payload, _socket), do: {:error, %{reason: "invalid_topic"}}

  # ---------------------------------------------------------------------------
  # handle_in — send_message
  # ---------------------------------------------------------------------------

  @impl Phoenix.Channel
  def handle_in("send_message", %{"ciphertext" => ct_b64, "iv" => iv_b64}, socket) do
    with {:ok, ciphertext} <- decode_base64(ct_b64),
         {:ok, iv} <- decode_base64(iv_b64),
         :ok <- check_size(ciphertext),
         {:ok, message} <-
           Rooms.send_message(
             socket.assigns.room_id,
             socket.assigns.sender_hash,
             ciphertext,
             iv
           ) do
      payload = message_payload(message)
      # Push to sender first so they see their own bubble immediately,
      # then broadcast to the other party.
      push(socket, "new_message", payload)
      broadcast_from!(socket, "new_message", payload)
      {:reply, {:ok, %{message_id: message.id}}, socket}
    else
      {:error, :sender_blocked} -> {:reply, {:error, %{reason: "not_your_turn"}}, socket}
      {:error, :too_large} -> {:reply, {:error, %{reason: "message_too_large"}}, socket}
      {:error, :bad_base64} -> {:reply, {:error, %{reason: "invalid_encoding"}}, socket}
      {:error, _reason} -> {:reply, {:error, %{reason: "send_failed"}}, socket}
    end
  end

  # ---------------------------------------------------------------------------
  # handle_in — read_receipt
  # ---------------------------------------------------------------------------

  @impl Phoenix.Channel
  def handle_in("read_receipt", %{"message_id" => message_id}, socket) do
    case Rooms.mark_read(message_id) do
      {:ok, _message} ->
        broadcast!(socket, "message_read", %{message_id: message_id})
        {:noreply, socket}

      {:error, reason} ->
        Logger.debug("read_receipt ignored: #{inspect(reason)} for message #{message_id}")
        {:noreply, socket}
    end
  end

  # ---------------------------------------------------------------------------
  # handle_in — edit_message
  # ---------------------------------------------------------------------------

  @impl Phoenix.Channel
  def handle_in(
        "edit_message",
        %{"message_id" => message_id, "ciphertext" => ct_b64, "iv" => iv_b64},
        socket
      ) do
    with {:ok, ciphertext} <- decode_base64(ct_b64),
         {:ok, iv} <- decode_base64(iv_b64),
         {:ok, _message} <-
           Rooms.edit_message(
             message_id,
             socket.assigns.room_id,
             socket.assigns.sender_hash,
             ciphertext,
             iv
           ) do
      broadcast!(socket, "message_edited", %{
        message_id: message_id,
        ciphertext: ct_b64,
        iv: iv_b64
      })

      {:reply, {:ok, %{}}, socket}
    else
      {:error, :not_found} -> {:reply, {:error, %{reason: "not_found"}}, socket}
      {:error, :not_editable} -> {:reply, {:error, %{reason: "not_editable"}}, socket}
      {:error, :bad_base64} -> {:reply, {:error, %{reason: "invalid_encoding"}}, socket}
    end
  end

  # ---------------------------------------------------------------------------
  # handle_in — delete_message
  # ---------------------------------------------------------------------------

  @impl Phoenix.Channel
  def handle_in("delete_message", %{"message_id" => message_id}, socket) do
    case Rooms.delete_message(message_id, socket.assigns.room_id, socket.assigns.sender_hash) do
      {:ok, _message} ->
        broadcast!(socket, "message_deleted", %{message_id: message_id})
        {:reply, {:ok, %{}}, socket}

      {:error, :not_found} ->
        {:reply, {:error, %{reason: "not_found"}}, socket}

      {:error, :not_deletable} ->
        {:reply, {:error, %{reason: "not_deletable"}}, socket}
    end
  end

  # ---------------------------------------------------------------------------
  # handle_in — typing
  # ---------------------------------------------------------------------------

  @impl Phoenix.Channel
  def handle_in("typing", _payload, socket) do
    broadcast_from!(socket, "counterparty_typing", %{})
    {:noreply, socket}
  end

  # ---------------------------------------------------------------------------
  # handle_in — expire_room
  # ---------------------------------------------------------------------------

  @impl Phoenix.Channel
  def handle_in("expire_room", _payload, socket) do
    case Rooms.expire_room(socket.assigns.room_id) do
      {:ok, _room} ->
        broadcast!(socket, "room_expired", %{})
        {:reply, {:ok, %{}}, socket}

      {:error, reason} ->
        Logger.warning(
          "expire_room failed for room #{socket.assigns.room_id}: #{inspect(reason)}"
        )

        {:reply, {:error, %{reason: "expire_failed"}}, socket}
    end
  end

  # ---------------------------------------------------------------------------
  # handle_in — redeem_extension (monetization)
  # ---------------------------------------------------------------------------

  @impl Phoenix.Channel
  def handle_in("redeem_extension", %{"extension_secret" => secret} = payload, socket)
      when is_binary(secret) do
    if Monetization.enabled?() do
      case Monetization.redeem_token(secret, socket.assigns.room_id) do
        {:ok, new_ttl} ->
          # Bump telemetry: per-country lifetime (if the client supplied a
          # valid ISO) and per-day global paid-new. country_iso is derived
          # client-side from the E.164 phone and passed optionally; it is
          # never stored alongside the room or the token.
          if iso = Map.get(payload, "country_iso") do
            Stelgano.CountryMetrics.increment_paid(iso)
          end

          Stelgano.DailyMetrics.increment_paid_new()

          broadcast!(socket, "ttl_extended", %{
            ttl_expires_at: DateTime.to_iso8601(new_ttl)
          })

          {:reply, {:ok, %{ttl_expires_at: DateTime.to_iso8601(new_ttl)}}, socket}

        {:error, :invalid_token} ->
          {:reply, {:error, %{reason: "invalid_token"}}, socket}
      end
    else
      {:reply, {:error, %{reason: "monetization_disabled"}}, socket}
    end
  end

  # Catch-all for unrecognised events — log and ignore
  @impl Phoenix.Channel
  def handle_in(event, _payload, socket) do
    Logger.warning("AnonRoomChannel: unrecognised event #{inspect(event)}")
    {:noreply, socket}
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  # Returns :ok if the string is exactly 64 lowercase hex characters,
  # {:error, tag} otherwise. `tag` is used in the with/else pattern.
  @spec validate_hex64(String.t(), atom()) :: :ok | {:error, atom()}
  defp validate_hex64(s, tag) when is_binary(s) do
    if byte_size(s) == 64 and s =~ ~r/\A[0-9a-f]{64}\z/ do
      :ok
    else
      {:error, tag}
    end
  end

  defp validate_hex64(_other, tag), do: {:error, tag}

  # Checks that the ciphertext binary is within the allowed size limit.
  @spec check_size(binary()) :: :ok | {:error, :too_large}
  defp check_size(bytes) when byte_size(bytes) <= @max_ciphertext_bytes, do: :ok
  defp check_size(_bytes), do: {:error, :too_large}

  # Decodes a base64 string. Returns {:ok, binary} or {:error, :bad_base64}.
  @spec decode_base64(String.t()) :: {:ok, binary()} | {:error, :bad_base64}
  defp decode_base64(b64) when is_binary(b64) do
    case Base.decode64(b64) do
      {:ok, binary} -> {:ok, binary}
      :error -> {:error, :bad_base64}
    end
  end

  defp decode_base64(_other), do: {:error, :bad_base64}

  # Merges current_message into the join reply map when one exists.
  @spec maybe_put_current_message(map(), Rooms.Message.t() | nil) :: map()
  defp maybe_put_current_message(reply, nil), do: reply

  defp maybe_put_current_message(reply, message) do
    Map.put(reply, :current_message, message_payload(message))
  end

  # Serialises a Message struct to the JSON-safe wire format.
  # Binary fields (ciphertext, iv) are base64-encoded for transport.
  @spec message_payload(Rooms.Message.t()) :: map()
  defp message_payload(message) do
    %{
      id: message.id,
      sender_hash: message.sender_hash,
      ciphertext: Base.encode64(message.ciphertext),
      iv: Base.encode64(message.iv),
      read_at: message.read_at,
      inserted_at: message.inserted_at
    }
  end
end
