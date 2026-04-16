# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.Plugs.SecurityHeadersTest do
  @moduledoc "Tests for the SecurityHeaders plug."

  use StelganoWeb.ConnCase, async: true

  describe "X-Robots-Tag" do
    test "sets noindex on /chat", %{conn: conn} do
      conn = get(conn, ~p"/chat")
      assert get_resp_header(conn, "x-robots-tag") == ["noindex, nofollow"]
    end

    test "sets noindex on /steg-number", %{conn: conn} do
      conn = get(conn, ~p"/steg-number")
      assert get_resp_header(conn, "x-robots-tag") == ["noindex, nofollow"]
    end

    test "does not set noindex on homepage", %{conn: conn} do
      conn = get(conn, ~p"/")
      assert get_resp_header(conn, "x-robots-tag") == []
    end

    test "does not set noindex on /security", %{conn: conn} do
      conn = get(conn, ~p"/security")
      assert get_resp_header(conn, "x-robots-tag") == []
    end
  end

  describe "Cache-Control on sensitive routes" do
    test "sets no-store on /chat", %{conn: conn} do
      conn = get(conn, ~p"/chat")
      headers = get_resp_header(conn, "cache-control")
      cache = Enum.join(headers, ", ")
      assert cache =~ "no-store"
    end

    test "sets no-store on /steg-number", %{conn: conn} do
      conn = get(conn, ~p"/steg-number")
      headers = get_resp_header(conn, "cache-control")
      cache = Enum.join(headers, ", ")
      assert cache =~ "no-store"
    end
  end

  describe "Standard security headers on all routes" do
    test "X-Frame-Options is DENY", %{conn: conn} do
      conn = get(conn, ~p"/")
      assert get_resp_header(conn, "x-frame-options") == ["DENY"]
    end

    test "X-Content-Type-Options is nosniff", %{conn: conn} do
      conn = get(conn, ~p"/")
      assert get_resp_header(conn, "x-content-type-options") == ["nosniff"]
    end

    test "Referrer-Policy is no-referrer", %{conn: conn} do
      conn = get(conn, ~p"/")
      assert get_resp_header(conn, "referrer-policy") == ["no-referrer"]
    end

    test "Content-Security-Policy is set", %{conn: conn} do
      conn = get(conn, ~p"/")
      [csp] = get_resp_header(conn, "content-security-policy")
      assert csp =~ "default-src 'self'"
      assert csp =~ "frame-ancestors 'none'"
      assert csp =~ "object-src 'none'"
    end
  end

  describe "panic route /x" do
    test "redirects to homepage", %{conn: conn} do
      conn = get(conn, ~p"/x")
      assert redirected_to(conn) == "/"
    end

    test "clears the session", %{conn: conn} do
      # Panic route clears server-side session and redirects
      conn = get(conn, ~p"/x")
      assert redirected_to(conn) == "/"
    end

    test "returns no-store cache header", %{conn: conn} do
      conn = get(conn, ~p"/x")
      headers = get_resp_header(conn, "cache-control")
      cache = Enum.join(headers, ", ")
      assert cache =~ "no-store"
    end
  end
end
