# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule Stelgano.RoomsTimingTest do
  @moduledoc """
  Timing-side-channel tests for `Rooms.join_room/2`.

  These tests temporarily raise the global `:join_time_floor_ms` config
  via `Application.put_env`, which is process-global. They are in a
  separate `async: false` file to avoid affecting other tests that
  exercise `join_room` for functional behaviour.
  """

  use Stelgano.DataCase, async: false

  alias Stelgano.Rooms

  defp hex64(seed) do
    "timing-#{seed}" |> then(&:crypto.hash(:sha256, &1)) |> Base.encode16(case: :lower)
  end

  setup do
    prev = Application.get_env(:stelgano, :join_time_floor_ms, 40)
    Application.put_env(:stelgano, :join_time_floor_ms, 30)
    on_exit(fn -> Application.put_env(:stelgano, :join_time_floor_ms, prev) end)
    :ok
  end

  describe "timing pad" do
    test "pads the fast :not_found branch (single SELECT) to at least the configured floor" do
      # Probe for a room that was never materialised — the attacker's enumeration
      # attempt. Without the pad this returns almost immediately.
      {us, {:error, :not_found}} =
        :timer.tc(fn -> Rooms.join_room(hex64(1), hex64(2)) end)

      assert div(us, 1000) >= 30
    end

    test "pads the slow :ok branch (SELECT + SELECT + INSERT into room_access) to the floor" do
      rh = hex64(3)
      {:ok, _room} = Rooms.create_room(rh, "free")

      {us, {:ok, _room}} = :timer.tc(fn -> Rooms.join_room(rh, hex64(4)) end)
      assert div(us, 1000) >= 30
    end

    test "no pad when floor is 0" do
      Application.put_env(:stelgano, :join_time_floor_ms, 0)

      {us, {:error, :not_found}} =
        :timer.tc(fn -> Rooms.join_room(hex64(5), hex64(6)) end)

      # Without a floor, a local SELECT is well under 30ms.
      assert div(us, 1000) < 30
    end
  end
end
