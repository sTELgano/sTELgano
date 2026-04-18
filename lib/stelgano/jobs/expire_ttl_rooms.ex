# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Jobs.ExpireTtlRooms do
  @moduledoc """
  Oban job that expires rooms whose `ttl_expires_at` has passed.

  Runs hourly. For each expired room it:
  1. Sets `is_active = false` and hard-deletes all messages.
  2. Broadcasts `room_expired` to the room's Phoenix Channel topic so any
     connected clients redirect to the entry screen immediately.

  ## Schedule

  Configured in `config/config.exs` as `{"0 * * * *", Stelgano.Jobs.ExpireTtlRooms}`.
  """

  use Oban.Worker, queue: :maintenance, max_attempts: 3

  import Ecto.Query, warn: false

  alias Stelgano.DailyMetrics
  alias Stelgano.Repo
  alias Stelgano.Rooms
  alias Stelgano.Rooms.Room
  alias StelganoWeb.Endpoint

  require Logger

  @impl Oban.Worker
  def perform(%Oban.Job{}) do
    # Fetch rooms BEFORE expiring so we have the room_hash for PubSub.
    # Also carry the tier so we can bump the correct DailyMetrics counter.
    now = DateTime.utc_now()

    rooms_to_expire =
      Room
      |> where(
        [r],
        r.is_active == true and
          not is_nil(r.ttl_expires_at) and
          r.ttl_expires_at <= ^now
      )
      |> select([r], %{id: r.id, room_hash: r.room_hash, tier: r.tier})
      |> Repo.all()

    {free_expired, paid_expired} =
      Enum.reduce(rooms_to_expire, {0, 0}, fn %{id: room_id, room_hash: room_hash, tier: tier},
                                              {free, paid} ->
        case Rooms.expire_room(room_id) do
          {:ok, _room} ->
            Endpoint.broadcast("anon_room:#{room_hash}", "room_expired", %{})
            if tier == "paid", do: {free, paid + 1}, else: {free + 1, paid}

          {:error, reason} ->
            Logger.warning(
              "ExpireTtlRooms: failed to expire room #{room_id}: #{inspect(reason)}"
            )

            {free, paid}
        end
      end)

    DailyMetrics.increment_free_expired(free_expired)
    DailyMetrics.increment_paid_expired(paid_expired)

    count = free_expired + paid_expired
    Logger.info("ExpireTtlRooms: expired #{count} room(s)")

    :ok
  end
end
