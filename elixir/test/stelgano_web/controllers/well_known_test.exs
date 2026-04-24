# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.WellKnownTest do
  @moduledoc "Tests for .well-known endpoints."

  use StelganoWeb.ConnCase, async: true

  describe "GET /.well-known/security.txt" do
    test "returns 200 with correct content-type", %{conn: conn} do
      conn = get(conn, ~p"/.well-known/security.txt")
      assert conn.status == 200
      content_type = get_resp_header(conn, "content-type")
      assert Enum.join(content_type) =~ "text/plain"
    end

    test "contains required security.txt fields", %{conn: conn} do
      conn = get(conn, ~p"/.well-known/security.txt")
      body = conn.resp_body
      assert body =~ "Contact:"
      assert body =~ "security@stelgano.com"
      assert body =~ "Expires:"
      assert body =~ "Policy:"
    end

    test "has no-cache header", %{conn: conn} do
      conn = get(conn, ~p"/.well-known/security.txt")
      headers = get_resp_header(conn, "cache-control")
      cache = Enum.join(headers)
      assert cache =~ "no-cache"
    end
  end
end
