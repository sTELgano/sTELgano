# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.AnonSocket do
  @moduledoc """
  Unauthenticated Phoenix Socket for the anonymous room channel.

  No session, no cookie, no user identity.  The only credential exchanged is the
  `(room_hash, access_hash)` pair provided in the channel `join` payload.

  This socket is intentionally free of any Phoenix authentication scaffolding —
  the security model lives entirely in the channel's `join/3` callback and the
  Rooms context.
  """

  use Phoenix.Socket

  channel "anon_room:*", StelganoWeb.AnonRoomChannel

  @impl true
  def connect(_params, socket, _connect_info) do
    {:ok, socket}
  end

  @impl true
  def id(_socket), do: nil
end
