# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Rooms do
  @moduledoc """
  The Rooms context — all business logic for room creation, access control,
  and the N=1 messaging invariant.

  ## Design principles

  - **Server blindness** — no function here accepts or stores a plaintext phone
    number or PIN. All inputs are opaque hashes derived client-side.
  - **Atomic N=1 enforcement** — `send_message/4` hard-deletes the previous
    message and inserts the new one in a single DB transaction.
  - **Enumeration resistance** — `join_room/2` returns the same public error
    regardless of whether the room doesn't exist, the hash is wrong, or the
    account is locked out. Distinct atoms are used internally for logging.
  """

  import Ecto.Query, warn: false

  alias Stelgano.Monetization
  alias Stelgano.Repo
  alias Stelgano.Rooms.Message
  alias Stelgano.Rooms.Room
  alias Stelgano.Rooms.RoomAccess

  # ---------------------------------------------------------------------------
  # Room lifecycle
  # ---------------------------------------------------------------------------

  @doc """
  Finds an active room by `room_hash`. Returns `{:ok, room}` or `{:error, :not_found}`.
  """
  @spec get_active_room(String.t()) :: {:ok, Room.t()} | {:error, :not_found}
  def get_active_room(room_hash) when is_binary(room_hash) do
    case Repo.get_by(Room, room_hash: room_hash, is_active: true) do
      %Room{} = room -> {:ok, room}
      nil -> {:error, :not_found}
    end
  end

  @doc """
  Explicitly creates a new room with a given tier.
  """
  @spec create_room(String.t(), String.t(), DateTime.t() | nil) ::
          {:ok, Room.t()} | {:error, Ecto.Changeset.t()}
  def create_room(room_hash, tier, ttl_expires_at \\ nil) do
    # Default TTL if not provided
    ttl = ttl_expires_at || Monetization.default_ttl()

    %{room_hash: room_hash, tier: tier, ttl_expires_at: ttl}
    |> Room.create_changeset()
    |> Repo.insert()
  end

  @doc """
  Attempts to join a room using a `(room_hash, access_hash)` credential pair.

  On first join with a new `access_hash` (and fewer than 2 existing accesses),
  the access record is created and the join succeeds. On subsequent joins, the
  existing record is verified. This function never creates the `Room` itself —
  that is an explicit step via `create_room/3` from the plan-selection flow.

  ## Timing-side-channel pad

  Every call is padded to a floor of `config :stelgano, :join_time_floor_ms`
  (default 40ms, disabled in tests via 0). Without this, an attacker could
  time the reply and classify arbitrary `room_hash` values as "room exists"
  (slow path — SELECT on `rooms` then SELECT/INSERT/UPDATE on `room_access`)
  vs. "room does not exist" (fast path — single SELECT on `rooms`),
  enumerating live rooms despite the opaque `:not_found` error. The floor
  is comfortably larger than the inter-path delta so the branches become
  indistinguishable over any real network.

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
    with_time_floor(fn ->
      case get_active_room(room_hash) do
        {:ok, room} -> handle_access(room, access_hash)
        {:error, :not_found} -> {:error, :not_found}
      end
    end)
  end

  # Runs `fun` and pads total elapsed time to at least `:join_time_floor_ms`
  # (plus a small random jitter) before returning. Hides which of the
  # internal branches was taken from an external timer.
  @spec with_time_floor((-> result)) :: result when result: term()
  defp with_time_floor(fun) do
    floor_ms = Application.get_env(:stelgano, :join_time_floor_ms, 40)
    started = System.monotonic_time(:millisecond)
    result = fun.()

    if floor_ms > 0 do
      target = floor_ms + :rand.uniform(div(floor_ms, 4) + 1) - 1
      elapsed = System.monotonic_time(:millisecond) - started
      if elapsed < target, do: Process.sleep(target - elapsed)
    end

    result
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
      RoomAccess
      |> where([a], a.room_hash == ^room_hash)
      |> Repo.aggregate(:count)

    if existing_count < 2 do
      %{room_hash: room_hash, access_hash: access_hash}
      |> RoomAccess.create_changeset()
      |> Repo.insert!()

      {:ok, room}
    else
      # Wrong PIN — increment the counter on the record with the most failures
      # so we don't reveal which access_hash is "yours".
      access =
        RoomAccess
        |> where([a], a.room_hash == ^room_hash)
        |> order_by([a], desc: a.failed_attempts)
        |> limit(1)
        |> Repo.one!()

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

  Used by the in-drawer generator's availability check. Does not reveal room details.
  """
  @spec room_exists?(String.t()) :: boolean()
  def room_exists?(room_hash) when is_binary(room_hash) do
    Room
    |> where([r], r.room_hash == ^room_hash and r.is_active == true)
    |> Repo.exists?()
  end

  @doc """
  Permanently expires a room in a single atomic transaction:

    * sets `is_active = false` on the room
    * hard-deletes every `Message` for that room
    * hard-deletes every `RoomAccess` row for that `room_hash`

  `RoomAccess` rows carry `(room_hash, access_hash, failed_attempts,
  locked_until, inserted_at)` tuples. Leaving them behind would preserve
  long-term linkability — a DB dump taken months after expiry could still
  answer "which PIN-hashes attempted this room" and "when". Hard-deleting
  them keeps the server-blindness guarantee valid for expired rooms.

  Returns `{:ok, room}` on success, `{:error, reason}` on failure.
  """
  @spec expire_room(Ecto.UUID.t()) :: {:ok, Room.t()} | {:error, term()}
  def expire_room(room_id) when is_binary(room_id) do
    Repo.transaction(fn ->
      room = Repo.get!(Room, room_id)

      Repo.delete_all(from(m in Message, where: m.room_id == ^room_id))

      Repo.delete_all(from(a in RoomAccess, where: a.room_hash == ^room.room_hash))

      room
      |> Room.expire_changeset()
      |> Repo.update!()
    end)
  end

  # ---------------------------------------------------------------------------
  # Message operations (N=1 invariant)
  # ---------------------------------------------------------------------------

  @doc """
  Returns the current message for a room, or `nil` if none.
  """
  @spec current_message(Ecto.UUID.t()) :: Message.t() | nil
  def current_message(room_id) when is_binary(room_id) do
    Message
    |> where([m], m.room_id == ^room_id)
    |> limit(1)
    |> Repo.one()
  end

  @doc """
  Sends a message, atomically enforcing the N=1 invariant.

  Within a single transaction:
  1. If the sender already has the live message → rollback with `:sender_blocked`.
  2. Hard-delete any existing message (the other party's previous message).
  3. Insert the new encrypted message.

  N=1 is enforced both at the application level (the delete-then-insert
  sequence above) and at the DB level (a UNIQUE index on `messages.room_id`).
  Under concurrent inserts from two different senders both seeing
  `current_message = nil`, the second insert hits the unique constraint
  and this function returns `{:error, :sender_blocked}` — the loser of
  the race experiences the same UX as a same-sender re-send attempt.

  Returns `{:ok, message}`, `{:error, :sender_blocked}`, or
  `{:error, Ecto.Changeset.t()}` for validation failures.
  """
  @spec send_message(Ecto.UUID.t(), String.t(), binary(), binary()) ::
          {:ok, Message.t()} | {:error, :sender_blocked} | {:error, Ecto.Changeset.t()}
  def send_message(room_id, sender_hash, ciphertext, iv)
      when is_binary(room_id) and is_binary(sender_hash) do
    result =
      Repo.transaction(fn ->
        existing = current_message(room_id)

        if existing && existing.sender_hash == sender_hash do
          Repo.rollback(:sender_blocked)
        end

        if existing do
          Repo.delete!(existing)
        end

        changeset =
          %{sender_hash: sender_hash, ciphertext: ciphertext, iv: iv}
          |> Message.create_changeset()
          |> Ecto.Changeset.put_change(:room_id, room_id)

        case Repo.insert(changeset) do
          {:ok, message} ->
            message

          {:error, %Ecto.Changeset{errors: errors}} ->
            if Keyword.has_key?(errors, :room_id) do
              Repo.rollback(:sender_blocked)
            else
              Repo.rollback(errors)
            end
        end
      end)

    normalize_transaction_result(result)
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

  Editing is only permitted when `read_at` is nil and the `sender_hash` matches
  the caller. Deleted messages no longer exist in the database and will return
  `:not_found`.
  """
  @spec edit_message(Ecto.UUID.t(), Ecto.UUID.t(), String.t(), binary(), binary()) ::
          {:ok, Message.t()} | {:error, :not_editable | :not_found}
  def edit_message(message_id, room_id, sender_hash, ciphertext, iv) do
    case get_owned_message(message_id, room_id, sender_hash) do
      nil ->
        {:error, :not_found}

      %Message{read_at: read_at} when not is_nil(read_at) ->
        {:error, :not_editable}

      %Message{} = message ->
        message
        |> Message.edit_changeset(%{ciphertext: ciphertext, iv: iv})
        |> Repo.update()
        |> normalize_update_result()
    end
  end

  @doc """
  Hard-deletes a sent message before the recipient reads it.

  Deletion is only permitted when `read_at` is nil and the `sender_hash`
  matches the caller. The message row is permanently removed from the database.
  """
  @spec delete_message(Ecto.UUID.t(), Ecto.UUID.t(), String.t()) ::
          {:ok, Message.t()} | {:error, :not_deletable | :not_found}
  def delete_message(message_id, room_id, sender_hash) do
    case get_owned_message(message_id, room_id, sender_hash) do
      nil ->
        {:error, :not_found}

      %Message{read_at: read_at} when not is_nil(read_at) ->
        {:error, :not_deletable}

      %Message{} = message ->
        Repo.delete!(message)
        {:ok, message}
    end
  end

  # Returns a message that belongs to `room_id` and was sent by `sender_hash`.
  @spec get_owned_message(Ecto.UUID.t(), Ecto.UUID.t(), String.t()) :: Message.t() | nil
  defp get_owned_message(message_id, room_id, sender_hash) do
    Message
    |> where(
      [m],
      m.id == ^message_id and
        m.room_id == ^room_id and
        m.sender_hash == ^sender_hash
    )
    |> Repo.one()
  end

  # Normalises Repo.update/1 result to the types in the edit_message typespec.
  @spec normalize_update_result({:ok, Message.t()} | {:error, Ecto.Changeset.t()}) ::
          {:ok, Message.t()} | {:error, Ecto.Changeset.t()}
  defp normalize_update_result({:ok, _msg} = ok), do: ok
  defp normalize_update_result({:error, _changeset} = err), do: err

  # Normalises Repo.transaction/1 result for send_message.
  defp normalize_transaction_result({:ok, message}), do: {:ok, message}
  defp normalize_transaction_result({:error, :sender_blocked}), do: {:error, :sender_blocked}
  defp normalize_transaction_result({:error, changeset}), do: {:error, changeset}

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
      active_rooms: Room |> where([r], r.is_active == true) |> Repo.aggregate(:count),
      rooms_today: Room |> where([r], r.inserted_at >= ^day_ago) |> Repo.aggregate(:count),
      messages_today: Message |> where([m], m.inserted_at >= ^day_ago) |> Repo.aggregate(:count),
      rooms_last_90_days:
        Room |> where([r], r.inserted_at >= ^ninety_days_ago) |> Repo.aggregate(:count)
    }
  end

  # ---------------------------------------------------------------------------
  # Cleanup — called by Oban jobs
  # ---------------------------------------------------------------------------

  @doc """
  Finds and expires all rooms whose `ttl_expires_at` is in the past.
  Returns the list of expired room IDs for PubSub broadcast by the job.
  """
  @spec expire_ttl_rooms() :: [Ecto.UUID.t()]
  def expire_ttl_rooms do
    now = DateTime.utc_now()

    expired =
      Room
      |> where(
        [r],
        r.is_active == true and
          not is_nil(r.ttl_expires_at) and
          r.ttl_expires_at <= ^now
      )
      |> select([r], r.id)
      |> Repo.all()

    Enum.each(expired, &expire_room/1)
    expired
  end
end
