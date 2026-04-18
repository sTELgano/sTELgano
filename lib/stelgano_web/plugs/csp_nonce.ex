# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.Plugs.CspNonce do
  @moduledoc """
  Generates a fresh random nonce for every request, assigns it to the conn
  as `@csp_nonce`, and writes the Content-Security-Policy response header
  using that nonce.

  ## Why

  A blanket `script-src 'unsafe-inline'` allows any inline `<script>` tag
  on the page to execute — including attacker-injected ones. In a privacy
  product, an XSS that runs before `crypto.subtle.encrypt` can exfiltrate
  the plaintext message. Nonce-based CSP (CSP-2) closes this by only
  allowing inline scripts that carry the per-request `nonce` attribute —
  which attackers cannot predict because it is regenerated per response.

  ## What the nonce allows

  We only have one legitimate inline script in the root layout — the
  service-worker cleanup snippet that unregisters stale SWs from historical
  deployments. It receives the nonce via `nonce={@csp_nonce}`.

  ## Style-src stays 'unsafe-inline'

  LiveView's JS commands (`JS.show/hide/...`) emit inline `style` attributes
  for animations. Inline style attributes require `'unsafe-inline'` on
  `style-src` (or `'unsafe-hashes'` + every hash, which is impractical).
  This is acceptable: the attack surface of inline styles is vastly smaller
  than inline scripts — no JS execution, only CSS.
  """

  import Plug.Conn

  @nonce_bytes 18

  @spec init(keyword()) :: keyword()
  def init(opts), do: opts

  @spec call(Plug.Conn.t(), keyword()) :: Plug.Conn.t()
  def call(conn, _opts) do
    nonce = generate_nonce()

    conn
    |> assign(:csp_nonce, nonce)
    |> put_resp_header("content-security-policy", csp_header(nonce))
  end

  @spec generate_nonce() :: String.t()
  defp generate_nonce do
    @nonce_bytes
    |> :crypto.strong_rand_bytes()
    |> Base.url_encode64(padding: false)
  end

  @spec csp_header(String.t()) :: String.t()
  defp csp_header(nonce) do
    "default-src 'self'; " <>
      "script-src 'self' 'nonce-#{nonce}'; " <>
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " <>
      "font-src 'self' https://fonts.gstatic.com data:; " <>
      "connect-src 'self' wss: ws:; " <>
      "img-src 'self' data:; " <>
      "object-src 'none'; " <>
      "frame-ancestors 'none'; " <>
      "base-uri 'self'; " <>
      "form-action 'self'"
  end
end
