# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.PageControllerTest do
  @moduledoc "Tests for public page routes."

  use StelganoWeb.ConnCase, async: true

  describe "GET /" do
    test "renders homepage", %{conn: conn} do
      conn = get(conn, ~p"/")
      assert html_response(conn, 200) =~ "TEL"
    end

    test "homepage includes call to action", %{conn: conn} do
      conn = get(conn, ~p"/")
      assert html_response(conn, 200) =~ "Open a channel"
    end

    test "homepage explains what the server stores", %{conn: conn} do
      conn = get(conn, ~p"/")
      html = html_response(conn, 200)
      assert html =~ "Stores"
      assert html =~ "Never stores"
    end

    test "homepage is honest about limitations", %{conn: conn} do
      conn = get(conn, ~p"/")
      assert html_response(conn, 200) =~ "Not protected against"
    end
  end

  describe "GET /security" do
    test "renders security page", %{conn: conn} do
      conn = get(conn, ~p"/security")
      assert html_response(conn, 200) =~ "Cryptographic specification"
    end

    test "security page shows derivation chain", %{conn: conn} do
      conn = get(conn, ~p"/security")
      html = html_response(conn, 200)
      assert html =~ "room_hash"
      assert html =~ "PBKDF2"
    end

    test "security page mentions AES-256-GCM", %{conn: conn} do
      conn = get(conn, ~p"/security")
      assert html_response(conn, 200) =~ "AES-256-GCM"
    end
  end

  describe "GET /privacy" do
    test "renders privacy page", %{conn: conn} do
      conn = get(conn, ~p"/privacy")
      assert html_response(conn, 200) =~ "Privacy policy"
    end

    test "states no third-party analytics", %{conn: conn} do
      conn = get(conn, ~p"/privacy")
      assert html_response(conn, 200) =~ "No Google Analytics"
    end
  end

  describe "GET /terms" do
    test "renders terms page", %{conn: conn} do
      conn = get(conn, ~p"/terms")
      assert html_response(conn, 200) =~ "Terms of service"
    end

    test "states server cannot read messages", %{conn: conn} do
      conn = get(conn, ~p"/terms")
      assert html_response(conn, 200) =~ "cannot read your messages"
    end
  end

  describe "GET /about" do
    test "renders about page", %{conn: conn} do
      conn = get(conn, ~p"/about")
      assert html_response(conn, 200) =~ "About sTELgano"
    end
  end
end
