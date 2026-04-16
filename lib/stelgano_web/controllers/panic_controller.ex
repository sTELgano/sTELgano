# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.PanicController do
  @moduledoc """
  Panic route — instant session clear with no confirmation.

  Available at `/x`. A single tap redirects to the homepage and clears the
  server-side session. The JS hook also clears sessionStorage client-side via
  a `phx:clear-session` event dispatched on redirect.

  ## Why this exists

  The lock screen has a "Clear session" link, but it is only reachable when the
  chat screen is visible. The panic route provides a direct URL that can be:

  - Saved as a bookmark on the home screen
  - Typed quickly in the address bar
  - Activated by anyone with device access who finds an open tab

  It is intentionally at a short, neutral path `/x` — easy to type, reveals
  nothing about the service.

  ## What it does

  - Clears the Plug session (server-side cookie)
  - Redirects to `/` (the homepage)
  - The page load at `/` will clear sessionStorage via the app.js bootstrap

  ## What it does NOT do

  - It does not expire the room (the conversation remains on the server)
  - It does not require authentication
  - It does not show any confirmation dialog

  ## Security note

  This route must NOT be CSRF-protected. It is a GET request by design —
  a POST would require a form submission which takes too long in an emergency.
  The only thing it does is clear state on the user's own device.
  """

  use StelganoWeb, :controller

  def clear(conn, _params) do
    conn
    |> clear_session()
    |> put_resp_header("cache-control", "no-store, no-cache")
    |> redirect(to: ~p"/")
  end
end
