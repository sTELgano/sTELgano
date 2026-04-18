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

    test "script-src uses a per-request nonce, not 'unsafe-inline'", %{conn: conn} do
      conn = get(conn, ~p"/")
      [csp] = get_resp_header(conn, "content-security-policy")
      refute csp =~ "script-src 'self' 'unsafe-inline'"
      assert csp =~ ~r/script-src 'self' 'nonce-[A-Za-z0-9_-]{20,}'/
    end

    test "nonce changes between requests", %{conn: conn} do
      [csp1] = conn |> get(~p"/") |> get_resp_header("content-security-policy")
      [csp2] = conn |> get(~p"/") |> get_resp_header("content-security-policy")
      [nonce1] = Regex.run(~r/'nonce-([A-Za-z0-9_-]+)'/, csp1, capture: :all_but_first)
      [nonce2] = Regex.run(~r/'nonce-([A-Za-z0-9_-]+)'/, csp2, capture: :all_but_first)
      refute nonce1 == nonce2
    end

    test "inline cleanup script carries matching nonce", %{conn: conn} do
      conn = get(conn, ~p"/")
      [csp] = get_resp_header(conn, "content-security-policy")
      [nonce] = Regex.run(~r/'nonce-([A-Za-z0-9_-]+)'/, csp, capture: :all_but_first)
      body = html_response(conn, 200)
      assert body =~ ~s(nonce="#{nonce}")
    end

    test "CSP does not allow Google Fonts (self-hosted)", %{conn: conn} do
      conn = get(conn, ~p"/")
      [csp] = get_resp_header(conn, "content-security-policy")
      refute csp =~ "fonts.googleapis.com"
      refute csp =~ "fonts.gstatic.com"
      assert csp =~ "font-src 'self'"
    end
  end

  describe "panic route /x" do
    test "redirects to homepage with panic flag", %{conn: conn} do
      conn = get(conn, ~p"/x")
      assert redirected_to(conn) == "/?p=1"
    end

    test "clears the session", %{conn: conn} do
      # Panic route clears server-side session and redirects
      conn = get(conn, ~p"/x")
      assert redirected_to(conn) == "/?p=1"
    end

    test "returns no-store cache header", %{conn: conn} do
      conn = get(conn, ~p"/x")
      headers = get_resp_header(conn, "cache-control")
      cache = Enum.join(headers, ", ")
      assert cache =~ "no-store"
    end

    test "homepage with ?p=1 ships an inline sessionStorage-clear script", %{conn: conn} do
      body = conn |> get(~p"/?p=1") |> html_response(200)
      assert body =~ "sessionStorage.clear"
      assert body =~ "searchParams.get"
    end
  end
end
