# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Jobs.ExpireTtlRooms do
  @moduledoc """
  Oban job that expires rooms whose `ttl_expires_at` has passed.

  Runs hourly. For each expired room it:
  1. Sets `is_active = false` and soft-deletes all messages.
  2. Broadcasts `room_expired` to the room's Phoenix Channel topic so any
     connected clients redirect to the entry screen immediately.

  ## Schedule

  Configured in `config/config.exs` as `{"0 * * * *", Stelgano.Jobs.ExpireTtlRooms}`.
  """

  use Oban.Worker, queue: :maintenance, max_attempts: 3

  require Logger

  import Ecto.Query, warn: false

  alias Stelgano.Repo
  alias Stelgano.Rooms
  alias Stelgano.Rooms.Room
  alias StelganoWeb.Endpoint

  @impl Oban.Worker
  def perform(%Oban.Job{}) do
    # Fetch rooms BEFORE expiring so we have the room_hash for PubSub
    now = DateTime.utc_now()

    rooms_to_expire =
      Repo.all(
        from r in Room,
          where:
            r.is_active == true and
              not is_nil(r.ttl_expires_at) and
              r.ttl_expires_at <= ^now,
          select: %{id: r.id, room_hash: r.room_hash}
      )

    Enum.each(rooms_to_expire, fn %{id: room_id, room_hash: room_hash} ->
      case Rooms.expire_room(room_id) do
        {:ok, _room} ->
          Endpoint.broadcast("anon_room:#{room_hash}", "room_expired", %{})

        {:error, reason} ->
          Logger.warning("ExpireTtlRooms: failed to expire room #{room_id}: #{inspect(reason)}")
      end
    end)

    count = length(rooms_to_expire)
    Logger.info("ExpireTtlRooms: expired #{count} room(s)")

    :ok
  end
end
