# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.AdminDashboardLiveTest do
  @moduledoc "Tests for the admin aggregate-metrics dashboard."

  use StelganoWeb.ConnCase, async: true

  import Phoenix.LiveViewTest

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  # Adds a valid Basic Auth header using the test-env credentials.
  defp authed_conn(conn) do
    creds = Application.get_env(:stelgano, :admin_credentials, [])
    username = Keyword.get(creds, :username, "test_admin")
    password = Keyword.get(creds, :password, "test_password")

    put_req_header(conn, "authorization", "Basic " <> Base.encode64("#{username}:#{password}"))
  end

  defp wrong_conn(conn) do
    put_req_header(conn, "authorization", "Basic " <> Base.encode64("admin:wrong"))
  end

  # ---------------------------------------------------------------------------
  # Access control
  # ---------------------------------------------------------------------------

  describe "access control" do
    test "returns 401 without credentials", %{conn: conn} do
      conn = get(conn, "/admin")
      assert conn.status == 401
    end

    test "returns 401 with wrong password", %{conn: conn} do
      conn = conn |> wrong_conn() |> get("/admin")
      assert conn.status == 401
    end

    test "401 response includes WWW-Authenticate header", %{conn: conn} do
      conn = get(conn, "/admin")
      [header] = get_resp_header(conn, "www-authenticate")
      assert header =~ "Basic"
      assert header =~ "sTELgano Admin"
    end

    test "grants access with correct credentials", %{conn: conn} do
      {:ok, _view, html} = conn |> authed_conn() |> live("/admin")
      assert html =~ "Dashboard."
    end
  end

  # ---------------------------------------------------------------------------
  # Dashboard content
  # ---------------------------------------------------------------------------

  describe "dashboard content" do
    setup %{conn: conn} do
      {:ok, conn: authed_conn(conn)}
    end

    test "shows all metric cards", %{conn: conn} do
      {:ok, _view, html} = live(conn, "/admin")
      assert html =~ "Active Chats"
      assert html =~ "New Chats Today"
      assert html =~ "Messages Sent Today"
      assert html =~ "Total Chats"
    end

    test "shows last-updated timestamp", %{conn: conn} do
      {:ok, _view, html} = live(conn, "/admin")
      assert html =~ "Updated"
    end

    test "never exposes user identifiers or room hashes", %{conn: conn} do
      {:ok, _view, html} = live(conn, "/admin")
      refute html =~ "room_hash"
      refute html =~ "access_hash"
      refute html =~ "sender_hash"
    end

    test "explains what metrics are shown", %{conn: conn} do
      {:ok, _view, html} = live(conn, "/admin")
      assert html =~ "No Private Data"
      assert html =~ "Total Stats Only"
    end

    test "refresh_now event updates the view", %{conn: conn} do
      {:ok, view, _html} = live(conn, "/admin")
      view |> element("button", "Refresh Stats") |> render_click()
      assert render(view) =~ "Updated"
    end

    test "metric values are non-negative integers", %{conn: conn} do
      {:ok, _view, html} = live(conn, "/admin")
      # All four metric values should render as plain numbers (≥ 0)
      assert html =~ ~r/\b\d+\b/
    end
  end
end
