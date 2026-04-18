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
    test "pads fast path (room exists) to at least the configured floor" do
      rh = hex64(1)
      {:ok, _room} = Rooms.find_or_create_room(rh)

      {us, {:ok, _room}} = :timer.tc(fn -> Rooms.join_room(rh, hex64(2)) end)
      assert div(us, 1000) >= 30
    end

    test "pads slow path (creates room) to at least the configured floor" do
      rh = hex64(3)
      {us, {:ok, _room}} = :timer.tc(fn -> Rooms.join_room(rh, hex64(4)) end)
      assert div(us, 1000) >= 30
    end

    test "no pad when floor is 0" do
      Application.put_env(:stelgano, :join_time_floor_ms, 0)
      rh = hex64(5)
      {us, {:ok, _room}} = :timer.tc(fn -> Rooms.join_room(rh, hex64(6)) end)
      # Without a floor, a local query+insert is well under 30ms.
      assert div(us, 1000) < 30
    end
  end
end
