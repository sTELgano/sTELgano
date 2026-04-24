# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.PricingControllerTest do
  @moduledoc "Tests for the pricing page."

  use StelganoWeb.ConnCase, async: true

  describe "GET /pricing" do
    test "renders the pricing page", %{conn: conn} do
      conn = get(conn, ~p"/pricing")
      html = html_response(conn, 200)
      assert html =~ "Privacy is"
      assert html =~ "never"
      assert html =~ "gated"
    end

    test "shows free tier", %{conn: conn} do
      conn = get(conn, ~p"/pricing")
      html = html_response(conn, 200)
      assert html =~ "Temporary"
      assert html =~ "Free"
    end

    test "shows paid tier with configured price", %{conn: conn} do
      conn = get(conn, ~p"/pricing")
      html = html_response(conn, 200)
      assert html =~ "Dedicated"
      assert html =~ "/year"
    end

    test "shows honesty commitment", %{conn: conn} do
      conn = get(conn, ~p"/pricing")
      html = html_response(conn, 200)
      assert html =~ "paywall"
    end

    test "shows payment privacy section", %{conn: conn} do
      conn = get(conn, ~p"/pricing")
      html = html_response(conn, 200)
      assert html =~ "Blind Token Protocol"
      assert html =~ "Same Encryption"
    end
  end
end
