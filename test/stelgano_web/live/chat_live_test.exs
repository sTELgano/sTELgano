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
  # Entry screen
  # ---------------------------------------------------------------------------

  describe "GET /chat" do
    test "renders the entry screen with two masked fields", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      # Entry screen elements
      assert has_element?(view, "#entry-screen")
      assert has_element?(view, "#steg-number-input")
      assert has_element?(view, "#pin-input")
      assert has_element?(view, "#entry-submit")
    end

    test "shows sTELgano wordmark", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/chat")
      # Wordmark components
      assert html =~ "TEL"
      assert html =~ "gano"
    end

    test "phone field is masked by default", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/chat")
      # type=password makes it masked
      assert html =~ ~s(type="password")
    end

    test "entry screen does not reveal any conversation history", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/chat")
      refute html =~ "conversation"
      refute html =~ "message"
      refute html =~ "history"
    end

    test "Passcode Test — no identifying information visible", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/chat")
      # Should show nothing about rooms, users, or messages
      refute html =~ "room_hash"
      refute html =~ "sender_hash"
    end
  end

  describe "toggle_number_visibility event" do
    test "reveals phone field on first toggle", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")
      assert has_element?(view, "#steg-number-input[type='password']")

      view |> element("button[phx-click='toggle_number_visibility']") |> render_click()

      assert has_element?(view, "#steg-number-input[type='text']")
    end

    test "masks phone field again on second toggle", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      view |> element("button[phx-click='toggle_number_visibility']") |> render_click()
      view |> element("button[phx-click='toggle_number_visibility']") |> render_click()

      assert has_element?(view, "#steg-number-input[type='password']")
    end
  end

  describe "channel_error event" do
    test "displays neutral error message on failure", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      # Simulate what JS hook does when channel join fails
      render_hook(view, "channel_error", %{"reason" => "unauthorized"})

      assert has_element?(view, "#entry-error")
      html = render(view)
      assert html =~ "Could not open this room"
    end

    test "shows lockout message on locked reason", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "channel_error", %{"reason" => "locked"})

      html = render(view)
      assert html =~ "Too many failed attempts"
    end

    test "shows attempts remaining when provided", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "channel_error", %{
        "reason" => "unauthorized",
        "attempts_remaining" => 7
      })

      html = render(view)
      assert html =~ "7"
    end
  end

  describe "channel_joined event" do
    test "transitions to chat screen on successful join", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "channel_joined", %{"room_id" => Ecto.UUID.generate()})

      assert has_element?(view, "#chat-screen")
      refute has_element?(view, "#entry-screen")
    end

    test "clears any previous entry error on join", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "channel_error", %{"reason" => "unauthorized"})
      render_hook(view, "channel_joined", %{"room_id" => Ecto.UUID.generate()})

      refute has_element?(view, "#entry-error")
    end
  end

  describe "lock_session event" do
    test "shows lock screen when locked", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "channel_joined", %{"room_id" => Ecto.UUID.generate()})
      view |> element("#lock-btn") |> render_click()

      assert has_element?(view, "#lock-screen")
      assert has_element?(view, "#lock-pin-input")
    end

    test "lock screen shows clear session link", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "channel_joined", %{"room_id" => Ecto.UUID.generate()})
      view |> element("#lock-btn") |> render_click()

      html = render(view)
      assert html =~ "Clear session"
    end
  end

  describe "leave_session event" do
    test "returns to entry screen on leave", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "channel_joined", %{"room_id" => Ecto.UUID.generate()})
      view |> element("#leave-btn") |> render_click()

      assert has_element?(view, "#entry-screen")
      refute has_element?(view, "#chat-screen")
    end
  end

  describe "room_expired event" do
    test "shows expired screen when room expires", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "channel_joined", %{"room_id" => Ecto.UUID.generate()})
      render_hook(view, "room_expired", %{})

      html = render(view)
      assert html =~ "Conversation ended"
    end
  end
end
