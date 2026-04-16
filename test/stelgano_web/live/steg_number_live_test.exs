# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.StegNumberLiveTest do
  @moduledoc "Tests for the steg number generator LiveView."

  use StelganoWeb.ConnCase, async: true

  import Phoenix.LiveViewTest

  describe "GET /steg-number" do
    test "renders the generator page", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/steg-number")
      assert html =~ "Secret Number Generator"
    end

    test "shows setup guide steps", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/steg-number")
      assert html =~ "Save the number"
      assert html =~ "Add this number"
    end

    test "has generate button", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/steg-number")
      assert has_element?(view, "#generate-btn")
    end

    test "has availability indicator", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/steg-number")
      assert has_element?(view, "#generator-card")
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
    end

    test "shows copy button and availability after generation", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/steg-number")

      render_hook(view, "number_generated", %{
        "number" => "+447700900456",
        "display" => "+44 7700 900 456"
      })

      assert has_element?(view, "#copy-btn")
      assert has_element?(view, "#availability-check")
    end
  end

  describe "check_availability event" do
    test "shows available message for unused room_hash", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/steg-number")

      render_hook(view, "number_generated", %{
        "number" => "+447700900000",
        "display" => "+44 7700 900 000"
      })

      hash = :crypto.hash(:sha256, "unused-steg-number")
      fresh_hash = Base.encode16(hash, case: :lower)
      render_hook(view, "check_availability", %{"room_hash" => fresh_hash})

      html = render(view)
      assert html =~ "Number Available"
    end

    test "shows taken message for existing active room", %{conn: conn} do
      # Create an active room
      hash = :crypto.hash(:sha256, "taken-steg-number")
      existing_hash = Base.encode16(hash, case: :lower)
      Stelgano.Rooms.find_or_create_room(existing_hash)

      {:ok, view, _html} = live(conn, ~p"/steg-number")

      render_hook(view, "number_generated", %{
        "number" => "+447700900111",
        "display" => "+44 7700 900 111"
      })

      render_hook(view, "check_availability", %{"room_hash" => existing_hash})

      html = render(view)
      assert html =~ "Active Room Detected"
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
      assert html =~ "Copied to Clipboard"
    end
  end
end
