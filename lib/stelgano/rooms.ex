# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Rooms do
  @moduledoc """
  The Rooms context — all business logic for room creation, access control,
  and the N=1 messaging invariant.

  ## Design principles

  - **Server blindness** — no function here accepts or stores a plaintext phone
    number or PIN. All inputs are opaque hashes derived client-side.
  - **Atomic N=1 enforcement** — `send_message/4` soft-deletes the previous
    message and inserts the new one in a single DB transaction.
  - **Enumeration resistance** — `join_room/2` returns the same public error
    regardless of whether the room doesn't exist, the hash is wrong, or the
    account is locked out. Distinct atoms are used internally for logging.
  """

  import Ecto.Query, warn: false

  alias Stelgano.Repo
  alias Stelgano.Rooms.{Message, Room, RoomAccess}

  # ---------------------------------------------------------------------------
  # Room lifecycle
  # ---------------------------------------------------------------------------

  @doc """
  Finds an active room by `room_hash`, or creates it if none exists.

  Returns `{:ok, room}` on success, `{:error, changeset}` on validation failure.
  """
  @spec find_or_create_room(String.t()) :: {:ok, Room.t()} | {:error, Ecto.Changeset.t()}
  def find_or_create_room(room_hash) when is_binary(room_hash) do
    case Repo.get_by(Room, room_hash: room_hash, is_active: true) do
      %Room{} = room ->
        {:ok, room}

      nil ->
        %{room_hash: room_hash}
        |> Room.create_changeset()
        |> Repo.insert()
    end
  end

  @doc """
  Attempts to join a room using a `(room_hash, access_hash)` credential pair.

  On first join with a new `access_hash`, the access record is created and the
  join succeeds. On subsequent joins, the existing record is verified.

  ## Returns

  - `{:ok, room}` — success; `room.id` is used client-side for PBKDF2 derivation.
  - `{:error, :not_found}` — no active room for this `room_hash`.
  - `{:error, :locked, remaining}` — account locked after too many failures.
  - `{:error, :unauthorized, remaining}` — wrong hash; counter incremented.
  """
  @spec join_room(String.t(), String.t()) ::
          {:ok, Room.t()}
          | {:error, :locked, non_neg_integer()}
          | {:error, :unauthorized, non_neg_integer()}
          | {:error, :not_found}
  def join_room(room_hash, access_hash)
      when is_binary(room_hash) and is_binary(access_hash) do
    case find_or_create_room(room_hash) do
      {:ok, room} -> handle_access(room, access_hash)
      {:error, _} -> {:error, :not_found}
    end
  end

  @spec handle_access(Room.t(), String.t()) ::
          {:ok, Room.t()}
          | {:error, :locked, non_neg_integer()}
          | {:error, :unauthorized, non_neg_integer()}
  defp handle_access(%Room{room_hash: room_hash} = room, access_hash) do
    case Repo.get_by(RoomAccess, room_hash: room_hash, access_hash: access_hash) do
      %RoomAccess{} = access ->
        if RoomAccess.locked?(access) do
          remaining = max(0, RoomAccess.max_attempts() - access.failed_attempts)
          {:error, :locked, remaining}
        else
          access
          |> RoomAccess.reset_attempts_changeset()
          |> Repo.update!()

          {:ok, room}
        end

      nil ->
        handle_access_miss(room, access_hash)
    end
  end

  # Called when (room_hash, access_hash) has no matching record.
  # If no access records exist at all → first join, create and succeed.
  # If records exist but none match → wrong PIN, increment counter.
  @spec handle_access_miss(Room.t(), String.t()) ::
          {:ok, Room.t()}
          | {:error, :unauthorized, non_neg_integer()}
  defp handle_access_miss(%Room{room_hash: room_hash} = room, access_hash) do
    existing_count =
      Repo.aggregate(
        from(a in RoomAccess, where: a.room_hash == ^room_hash),
        :count
      )

    if existing_count < 2 do
      %{room_hash: room_hash, access_hash: access_hash}
      |> RoomAccess.create_changeset()
      |> Repo.insert!()

      {:ok, room}
    else
      # Wrong PIN — increment the counter on the record with the most failures
      # so we don't reveal which access_hash is "yours".
      access =
        Repo.one!(
          from a in RoomAccess,
            where: a.room_hash == ^room_hash,
            order_by: [desc: a.failed_attempts],
            limit: 1
        )

      if RoomAccess.locked?(access) do
        {:error, :locked, 0}
      else
        updated =
          access
          |> RoomAccess.failed_attempt_changeset()
          |> Repo.update!()

        if updated.failed_attempts >= RoomAccess.max_attempts() do
          {:error, :locked, 0}
        else
          remaining = max(0, RoomAccess.max_attempts() - updated.failed_attempts)
          {:error, :unauthorized, remaining}
        end
      end
    end
  end

  @doc """
  Returns `true` if an active room exists for `room_hash`.

  Used by the steg-number availability check. Does not reveal room details.
  """
  @spec room_exists?(String.t()) :: boolean()
  def room_exists?(room_hash) when is_binary(room_hash) do
    Repo.exists?(
      from r in Room,
        where: r.room_hash == ^room_hash and r.is_active == true
    )
  end

  @doc """
  Permanently expires a room: sets `is_active = false` and soft-deletes all
  messages in a single atomic transaction. Access records are retained.

  Returns `{:ok, room}` on success, `{:error, reason}` on failure.
  """
  @spec expire_room(Ecto.UUID.t()) :: {:ok, Room.t()} | {:error, term()}
  def expire_room(room_id) when is_binary(room_id) do
    Repo.transaction(fn ->
      room = Repo.get!(Room, room_id)
      now = DateTime.truncate(DateTime.utc_now(), :second)

      Repo.update_all(
        from(m in Message, where: m.room_id == ^room_id and is_nil(m.deleted_at)),
        set: [deleted_at: now, updated_at: now]
      )

      room
      |> Room.expire_changeset()
      |> Repo.update!()
    end)
  end

  # ---------------------------------------------------------------------------
  # Message operations (N=1 invariant)
  # ---------------------------------------------------------------------------

  @doc """
  Returns the current non-deleted message for a room, or `nil` if none.
  """
  @spec current_message(Ecto.UUID.t()) :: Message.t() | nil
  def current_message(room_id) when is_binary(room_id) do
    Repo.one(
      from m in Message,
        where: m.room_id == ^room_id and is_nil(m.deleted_at),
        limit: 1
    )
  end

  @doc """
  Sends a message, atomically enforcing the N=1 invariant.

  Within a single transaction:
  1. If the sender already has the live message → rollback with `:sender_blocked`.
  2. Soft-delete any existing message (the other party's reply).
  3. Insert the new encrypted message.

  Returns `{:ok, message}` or `{:error, :sender_blocked}`.
  """
  @spec send_message(Ecto.UUID.t(), String.t(), binary(), binary()) ::
          {:ok, Message.t()} | {:error, :sender_blocked} | {:error, Ecto.Changeset.t()}
  def send_message(room_id, sender_hash, ciphertext, iv)
      when is_binary(room_id) and is_binary(sender_hash) do
    Repo.transaction(fn ->
      existing = current_message(room_id)

      if existing && existing.sender_hash == sender_hash do
        Repo.rollback(:sender_blocked)
      end

      if existing do
        existing
        |> Message.soft_delete_changeset()
        |> Repo.update!()
      end

      %{sender_hash: sender_hash, ciphertext: ciphertext, iv: iv}
      |> Message.create_changeset()
      |> Ecto.Changeset.put_change(:room_id, room_id)
      |> Repo.insert!()
    end)
    |> case do
      {:ok, message} -> {:ok, message}
      {:error, :sender_blocked} -> {:error, :sender_blocked}
      {:error, changeset} -> {:error, changeset}
    end
  end

  @doc """
  Marks a message as read. Sets `read_at` timestamp. Idempotent — already-read
  messages return `{:error, :already_read}`.
  """
  @spec mark_read(Ecto.UUID.t()) :: {:ok, Message.t()} | {:error, :already_read | :not_found}
  def mark_read(message_id) when is_binary(message_id) do
    case Repo.get(Message, message_id) do
      nil ->
        {:error, :not_found}

      %Message{read_at: read_at} when not is_nil(read_at) ->
        {:error, :already_read}

      %Message{} = message ->
        updated =
          message
          |> Message.mark_read_changeset()
          |> Repo.update!()

        {:ok, updated}
    end
  end

  @doc """
  Replaces the ciphertext + IV of a sent message before the recipient reads it.

  Editing is only permitted when `read_at` and `deleted_at` are both nil and
  the `sender_hash` matches the caller.
  """
  @spec edit_message(Ecto.UUID.t(), Ecto.UUID.t(), String.t(), binary(), binary()) ::
          {:ok, Message.t()} | {:error, :not_editable | :not_found}
  def edit_message(message_id, room_id, sender_hash, ciphertext, iv) do
    case get_owned_message(message_id, room_id, sender_hash) do
      nil ->
        {:error, :not_found}

      %Message{read_at: read_at, deleted_at: deleted_at}
      when not is_nil(read_at) or not is_nil(deleted_at) ->
        {:error, :not_editable}

      %Message{} = message ->
        message
        |> Message.edit_changeset(%{ciphertext: ciphertext, iv: iv})
        |> Repo.update()
        |> normalize_update_result()
    end
  end

  @doc """
  Soft-deletes a sent message before the recipient reads it.

  Deletion is only permitted when `read_at` and `deleted_at` are both nil
  and the `sender_hash` matches the caller.
  """
  @spec delete_message(Ecto.UUID.t(), Ecto.UUID.t(), String.t()) ::
          {:ok, Message.t()} | {:error, :not_deletable | :not_found}
  def delete_message(message_id, room_id, sender_hash) do
    case get_owned_message(message_id, room_id, sender_hash) do
      nil ->
        {:error, :not_found}

      %Message{read_at: read_at, deleted_at: deleted_at}
      when not is_nil(read_at) or not is_nil(deleted_at) ->
        {:error, :not_deletable}

      %Message{} = message ->
        updated =
          message
          |> Message.soft_delete_changeset()
          |> Repo.update!()

        {:ok, updated}
    end
  end

  # Returns a message that belongs to `room_id` and was sent by `sender_hash`.
  @spec get_owned_message(Ecto.UUID.t(), Ecto.UUID.t(), String.t()) :: Message.t() | nil
  defp get_owned_message(message_id, room_id, sender_hash) do
    Repo.one(
      from m in Message,
        where:
          m.id == ^message_id and
            m.room_id == ^room_id and
            m.sender_hash == ^sender_hash
    )
  end

  # Normalises Repo.update/1 result to the types in the edit_message typespec.
  @spec normalize_update_result({:ok, Message.t()} | {:error, Ecto.Changeset.t()}) ::
          {:ok, Message.t()} | {:error, Ecto.Changeset.t()}
  defp normalize_update_result({:ok, _} = ok), do: ok
  defp normalize_update_result({:error, _} = err), do: err

  # ---------------------------------------------------------------------------
  # Analytics — server-side aggregate metrics only
  # ---------------------------------------------------------------------------

  @doc """
  Returns aggregate metrics for the admin dashboard.

  All values are counts derived from operational data.
  No user identifiers, room hashes, or message content is included.
  """
  @spec aggregate_metrics() :: %{
          active_rooms: non_neg_integer(),
          rooms_today: non_neg_integer(),
          messages_today: non_neg_integer(),
          rooms_last_90_days: non_neg_integer()
        }
  def aggregate_metrics do
    now = DateTime.utc_now()
    day_ago = DateTime.add(now, -86_400, :second)
    ninety_days_ago = DateTime.add(now, -90 * 86_400, :second)

    %{
      active_rooms: Repo.aggregate(from(r in Room, where: r.is_active == true), :count),
      rooms_today: Repo.aggregate(from(r in Room, where: r.inserted_at >= ^day_ago), :count),
      messages_today:
        Repo.aggregate(from(m in Message, where: m.inserted_at >= ^day_ago), :count),
      rooms_last_90_days:
        Repo.aggregate(from(r in Room, where: r.inserted_at >= ^ninety_days_ago), :count)
    }
  end

  # ---------------------------------------------------------------------------
  # Cleanup — called by Oban jobs
  # ---------------------------------------------------------------------------

  @doc """
  Hard-deletes soft-deleted messages older than `older_than_seconds`.
  Returns the count of rows deleted.
  """
  @spec purge_deleted_messages(non_neg_integer()) :: non_neg_integer()
  def purge_deleted_messages(older_than_seconds \\ 86_400) do
    cutoff = DateTime.add(DateTime.utc_now(), -older_than_seconds, :second)

    {count, _} =
      Repo.delete_all(
        from m in Message,
          where: not is_nil(m.deleted_at) and m.deleted_at < ^cutoff
      )

    count
  end

  @doc """
  Finds and expires all rooms whose `ttl_expires_at` is in the past.
  Returns the list of expired room IDs for PubSub broadcast by the job.
  """
  @spec expire_ttl_rooms() :: [Ecto.UUID.t()]
  def expire_ttl_rooms do
    now = DateTime.utc_now()

    expired =
      Repo.all(
        from r in Room,
          where:
            r.is_active == true and
              not is_nil(r.ttl_expires_at) and
              r.ttl_expires_at <= ^now,
          select: r.id
      )

    Enum.each(expired, &expire_room/1)
    expired
  end
end
