# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.ChatLiveTest do
  @moduledoc """
  LiveView tests for the Chat entry screen and related UI.

  We test the server-rendered LiveView state; the actual crypto and channel
  joins happen in the browser (JS hooks), so those are out of scope here.
  """

  use StelganoWeb.ConnCase, async: true

  import Phoenix.LiveViewTest

  # ---------------------------------------------------------------------------
  # Entry screen — without phone param (empty state)
  # ---------------------------------------------------------------------------

  describe "GET /chat (no phone)" do
    test "renders the empty state prompting to generate a number", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/chat")

      assert html =~ "No Active Vector"
      assert html =~ "Start Channel"
    end

    test "shows sTELgano wordmark", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/chat")
      assert html =~ "TEL"
      assert html =~ "gano"
    end

    test "entry screen does not reveal any conversation history", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/chat")
      refute html =~ "conversation"
      refute html =~ "history"
    end

    test "Passcode Test — no identifying information visible", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/chat")
      refute html =~ "room_hash"
      refute html =~ "sender_hash"
    end
  end

  # ---------------------------------------------------------------------------
  # Entry screen — with phone param (form visible)
  # ---------------------------------------------------------------------------

  describe "GET /chat?phone=+12025551234" do
    test "renders the entry form with locked phone field", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/chat?phone=+12025551234")

      assert html =~ "entry-phone"
      assert html =~ "entry-pin"
      assert html =~ "entry-submit"
    end

    test "phone field is masked by default", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/chat?phone=+12025551234")
      assert html =~ ~s(type="password")
    end

    test "phone field is read-only when pre-populated", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/chat?phone=+12025551234")
      assert html =~ "readonly"
    end
  end

  describe "toggle_phone_visibility event" do
    test "reveals phone field on first toggle", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat?phone=+12025551234")

      view |> element("#phone-toggle-btn") |> render_click()

      html = render(view)
      assert html =~ ~s(type="text")
    end

    test "masks phone field again on second toggle", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat?phone=+12025551234")

      view |> element("#phone-toggle-btn") |> render_click()
      view |> element("#phone-toggle-btn") |> render_click()

      html = render(view)
      assert html =~ ~s(type="password")
    end
  end

  # ---------------------------------------------------------------------------
  # State transitions via hook events
  # ---------------------------------------------------------------------------

  describe "join_empty event" do
    test "transitions to chat screen on successful join", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat?phone=+12025551234")

      render_hook(view, "join_empty", %{"ttl_expires_at" => nil})

      html = render(view)
      assert html =~ "Zero Trace Channel"
      assert html =~ "The buffer is currently empty."
    end
  end

  describe "lock_chat event" do
    test "shows lock screen when locked", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat?phone=+12025551234")

      render_hook(view, "join_empty", %{"ttl_expires_at" => nil})

      view |> element("button[phx-click='lock_chat']") |> render_click()

      html = render(view)
      assert html =~ "Workspace"
      assert html =~ "Locked."
      assert html =~ "unlock-form"
    end

    test "lock screen shows clear session link", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat?phone=+12025551234")

      render_hook(view, "join_empty", %{"ttl_expires_at" => nil})
      view |> element("button[phx-click='lock_chat']") |> render_click()

      html = render(view)
      assert html =~ "Terminate All Artifacts"
    end
  end

  describe "leave_chat event" do
    test "returns to entry screen on leave", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat?phone=+12025551234")

      render_hook(view, "join_empty", %{"ttl_expires_at" => nil})
      view |> element("button[phx-click='leave_chat']") |> render_click()

      html = render(view)
      assert html =~ "No Active Vector"
    end
  end

  describe "room_expired_received event" do
    test "shows expired screen when room expires", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat?phone=+12025551234")

      render_hook(view, "join_empty", %{"ttl_expires_at" => nil})
      render_hook(view, "room_expired_received", %{})

      html = render(view)
      assert html =~ "Sequence Ended"
    end
  end
end
