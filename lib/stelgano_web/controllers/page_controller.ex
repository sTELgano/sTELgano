# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.PageController do
  @moduledoc "Handles public static pages and the security.txt well-known endpoint."

  use StelganoWeb, :controller

  @spec home(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def home(conn, _params) do
    render(conn, :home, page_title: "sTELgano — Hidden in the contact layer")
  end

  @spec security(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def security(conn, _params) do
    render(conn, :security, page_title: "Security — sTELgano")
  end

  @spec privacy(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def privacy(conn, _params) do
    render(conn, :privacy, page_title: "Privacy — sTELgano")
  end

  @spec terms(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def terms(conn, _params) do
    render(conn, :terms, page_title: "Terms — sTELgano")
  end

  @spec about(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def about(conn, _params) do
    render(conn, :about, page_title: "About — sTELgano")
  end

  @spec spec(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def spec(conn, _params) do
    render(conn, :spec, page_title: "Spec — sTELgano")
  end

  @doc """
  Serves the .well-known/security.txt file as a text response.
  Also served as a static file from priv/static/.well-known/security.txt
  but this route ensures correct content-type and no-cache headers.
  """
  @spec security_txt(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def security_txt(conn, _params) do
    content = """
    Contact: mailto:security@stelgano.com
    Contact: https://github.com/stelgano/stelgano/security/advisories/new
    Expires: 2027-01-01T00:00:00.000Z
    Encryption: https://stelgano.com/.well-known/security-pgp.asc
    Preferred-Languages: en
    Policy: https://stelgano.com/security#disclosure
    Canonical: https://stelgano.com/.well-known/security.txt
    """

    conn
    |> put_resp_content_type("text/plain")
    |> put_resp_header("cache-control", "no-cache")
    |> send_resp(200, content)
  end
end
