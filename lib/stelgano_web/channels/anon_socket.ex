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

  ## Origin check

  The `ws` upgrade handshake is gated by `check_origin: true` on the socket
  declaration in [endpoint.ex](../endpoint.ex). This prevents a third-party
  site from opening a cross-origin WebSocket to `anon_socket` and speaking
  `anon_room:` topics from a tab the user didn't intend. Even though joining
  requires valid `(room_hash, access_hash)` pairs, eliminating the cross-origin
  path is a defense-in-depth win (no resource amplification, no CORS-bypassing
  probes, no XS-Leaks-style side channels).
  """

  use Phoenix.Socket

  channel "anon_room:*", StelganoWeb.AnonRoomChannel

  @impl Phoenix.Socket
  def connect(_params, socket, _connect_info) do
    {:ok, socket}
  end

  @impl Phoenix.Socket
  def id(_socket), do: nil
end
