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
      assert html_response(conn, 200) =~ "Open Private Chat"
    end

    test "homepage explains what the server stores", %{conn: conn} do
      conn = get(conn, ~p"/")
      html = html_response(conn, 200)
      assert html =~ "What is logged"
      assert html =~ "What is never stored"
      assert html =~ "Our Security Model"
    end

    test "homepage is honest about limitations", %{conn: conn} do
      conn = get(conn, ~p"/")
      assert html_response(conn, 200) =~ "Our Security Model"
    end
  end

  describe "GET /security" do
    test "renders security page", %{conn: conn} do
      conn = get(conn, ~p"/security")
      assert html_response(conn, 200) =~ "Security Guide"
    end

    test "security page shows derivation chain", %{conn: conn} do
      conn = get(conn, ~p"/security")
      html = html_response(conn, 200)
      assert html =~ "Chat ID"
      assert html =~ "Secure"
    end

    test "security page mentions AES-256-GCM", %{conn: conn} do
      conn = get(conn, ~p"/security")
      assert html_response(conn, 200) =~ "AES-256-GCM"
    end
  end

  describe "GET /privacy" do
    test "renders privacy page", %{conn: conn} do
      conn = get(conn, ~p"/privacy")
      html = html_response(conn, 200)
      assert html =~ "Privacy"
      assert html =~ "Policy"
    end

    test "states no third-party analytics", %{conn: conn} do
      conn = get(conn, ~p"/privacy")
      assert html_response(conn, 200) =~ "Zero third-party analytics"
    end
  end

  describe "GET /terms" do
    test "renders terms page", %{conn: conn} do
      conn = get(conn, ~p"/terms")
      html = html_response(conn, 200)
      assert html =~ "Terms"
      assert html =~ "Service."
    end

    test "states license information", %{conn: conn} do
      conn = get(conn, ~p"/terms")

      assert html_response(conn, 200) =~
               "licensed under the AGPL-3.0"
    end
  end

  describe "GET /about" do
    test "renders about page", %{conn: conn} do
      conn = get(conn, ~p"/about")
      assert html_response(conn, 200) =~ "About sTELgano"
    end
  end
end
