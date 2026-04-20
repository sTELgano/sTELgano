# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.StegNumberLiveTest do
  @moduledoc "Tests for the redesigned Channel Identity (steg-number) LiveView."

  use StelganoWeb.ConnCase, async: true

  import Phoenix.LiveViewTest

  alias Stelgano.Repo
  alias Stelgano.Rooms.Room

  describe "GET /steg-number" do
    test "renders the identity page", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/steg-number")
      assert html =~ "Channel"
      assert html =~ "Identity"
    end

    test "shows redesigned setup guide", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/steg-number")
      assert html =~ "Save in Phonebook"
    end

    test "has mode selectors", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/steg-number")
      assert has_element?(view, "button", "Generate New")
      assert has_element?(view, "button", "Check / Upgrade Number")
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

    test "shows copy button in generator mode", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/steg-number")

      render_hook(view, "number_generated", %{
        "number" => "+447700900456",
        "display" => "+44 7700 900 456"
      })

      assert has_element?(view, "#copy-generated-btn")
    end
  end

  describe "manual entry flow" do
    test "switches to manual mode", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/steg-number")
      view |> element("button", "Check / Upgrade Number") |> render_click()
      assert has_element?(view, "#manual-number-input")
    end

    test "checks manual number availability (available)", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/steg-number")
      view |> element("button", "Check / Upgrade Number") |> render_click()

      render_hook(view, "check_manual_number", %{
        "number" => "+447700900000",
        "room_hash" => "0000000000000000000000000000000000000000000000000000000000000000"
      })

      assert render(view) =~ "New Identity Detected"
    end

    test "checks manual number availability (taken)", %{conn: conn} do
      room_hash = String.duplicate("a", 64)

      Repo.insert!(%Room{
        room_hash: room_hash,
        tier: "free",
        ttl_expires_at: DateTime.truncate(DateTime.utc_now(), :second)
      })

      {:ok, view, _html} = live(conn, ~p"/steg-number")
      view |> element("button", "Check / Upgrade Number") |> render_click()

      render_hook(view, "check_manual_number", %{
        "number" => "+447700900111",
        "room_hash" => room_hash
      })

      assert render(view) =~ "Existing Channel Linked"
    end

    test "rate-limits availability probes after 10 lookups per window", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/steg-number")
      view |> element("button", "Check / Upgrade Number") |> render_click()

      hash = fn i ->
        "probe-#{i}" |> then(&:crypto.hash(:sha256, &1)) |> Base.encode16(case: :lower)
      end

      # 10 probes within the window succeed
      for i <- 1..10 do
        render_hook(view, "check_manual_number", %{
          "number" => "+1555000#{String.pad_leading("#{i}", 4, "0")}",
          "room_hash" => hash.(i)
        })
      end

      # 11th probe is throttled — no DB hit, no availability revealed
      render_hook(view, "check_manual_number", %{
        "number" => "+15550009999",
        "room_hash" => hash.(11)
      })

      html = render(view)
      assert html =~ "Too many lookups"
      refute html =~ "New Identity Detected"
    end
  end

  describe "copied confirmation" do
    test "shows feedback after copy click", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/steg-number")

      render_hook(view, "number_generated", %{
        "number" => "+447700900789",
        "display" => "+44 7700 900 789"
      })

      view |> element("#copy-generated-btn") |> render_click()
      assert render(view) =~ "Copied"
    end
  end
end
