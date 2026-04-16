# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.Jobs.ExpireTtlRoomsTest do
  @moduledoc "Tests for the ExpireTtlRooms Oban job."

  use Stelgano.DataCase, async: true

  alias Stelgano.Jobs.ExpireTtlRooms
  alias Stelgano.Rooms
  alias Stelgano.Rooms.Room

  defp hex64(seed), do: :crypto.hash(:sha256, "ttl-test-#{seed}") |> Base.encode16(case: :lower)

  describe "perform/1" do
    test "expires rooms whose TTL has passed" do
      rh = hex64(1)

      # Create a room with a TTL in the past
      {:ok, room} =
        %{room_hash: rh, ttl_expires_at: DateTime.add(DateTime.utc_now(), -3600, :second)}
        |> Room.create_changeset()
        |> Repo.insert()

      assert :ok = ExpireTtlRooms.perform(%Oban.Job{args: %{}})

      reloaded = Repo.get!(Room, room.id)
      refute reloaded.is_active
    end

    test "does not expire rooms whose TTL is in the future" do
      rh = hex64(10)

      {:ok, room} =
        %{room_hash: rh, ttl_expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)}
        |> Room.create_changeset()
        |> Repo.insert()

      assert :ok = ExpireTtlRooms.perform(%Oban.Job{args: %{}})

      reloaded = Repo.get!(Room, room.id)
      assert reloaded.is_active
    end

    test "does not expire rooms with no TTL" do
      rh = hex64(20)
      {:ok, room} = Rooms.find_or_create_room(rh)

      assert :ok = ExpireTtlRooms.perform(%Oban.Job{args: %{}})

      reloaded = Repo.get!(Room, room.id)
      assert reloaded.is_active
    end
  end
end
