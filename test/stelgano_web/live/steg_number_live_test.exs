# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.StegNumberLiveTest do
  @moduledoc "Tests for the steg number generator LiveView."

  use StelganoWeb.ConnCase, async: true

  import Phoenix.LiveViewTest

  alias Stelgano.Rooms

  describe "GET /steg-number" do
    test "renders the generator page", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/steg-number")
      assert html =~ "Steg number generator"
    end

    test "shows setup guide steps", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/steg-number")
      assert html =~ "Open your contacts app"
      assert html =~ "Add the steg number"
    end

    test "has generate button", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/steg-number")
      assert has_element?(view, "#generate-btn")
    end

    test "has check availability button", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/steg-number")
      assert has_element?(view, "#check-availability-btn")
    end
  end

  describe "number_generated event" do
    test "displays the generated number", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/steg-number")

      render_hook(view, "number_generated", %{
        "number" => "+447700900123",
        "display" => "+44 7700 900 123"
      })

      html = render(view)
      assert html =~ "+44 7700 900 123"
      assert html =~ "+447700900123"
    end

    test "shows copy button after generation", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/steg-number")

      render_hook(view, "number_generated", %{
        "number" => "+447700900456",
        "display" => "+44 7700 900 456"
      })

      assert has_element?(view, "#copy-btn")
    end
  end

  describe "check_availability event" do
    test "shows available message for unused room_hash", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/steg-number")

      fresh_hash = :crypto.hash(:sha256, "unused-steg-number") |> Base.encode16(case: :lower)
      render_hook(view, "check_availability", %{"room_hash" => fresh_hash})

      html = render(view)
      assert html =~ "available"
    end

    test "shows taken message for existing active room", %{conn: conn} do
      # Create an active room
      existing_hash = :crypto.hash(:sha256, "taken-steg-number") |> Base.encode16(case: :lower)
      Rooms.find_or_create_room(existing_hash)

      {:ok, view, _html} = live(conn, ~p"/steg-number")
      render_hook(view, "check_availability", %{"room_hash" => existing_hash})

      html = render(view)
      assert html =~ "active room"
    end
  end

  describe "copied event" do
    test "shows Copied confirmation for 2 seconds", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/steg-number")

      render_hook(view, "number_generated", %{
        "number" => "+447700900789",
        "display" => "+44 7700 900 789"
      })

      view |> element("#copy-btn") |> render_click()

      html = render(view)
      assert html =~ "Copied"
    end
  end
end
