# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.Layouts do
  @moduledoc """
  Application layout components.

  The `app/1` component provides the site shell with navigation and footer.
  The `/chat` route's LiveView manages its own full-screen layout directly
  and does not use the app shell's nav/footer.
  """

  use StelganoWeb, :html

  embed_templates "layouts/*"

  @doc """
  Renders the app layout shell with navigation and footer.
  """
  attr :flash, :map, required: true

  slot :inner_block, required: true

  def app(assigns) do
    ~H"""
    <nav class="site-nav">
      <a href="/" class="wordmark" style="font-size: 1.4rem;">
        <span class="wm-s">s</span><span class="wm-tel">TEL</span><span class="wm-gano">gano</span>
      </a>
      <ul class="nav-links">
        <li><a href="/security">Security</a></li>
        <li><a href="/about">About</a></li>
        <li><.theme_toggle /></li>
        <li>
          <a
            href="/chat"
            class="glass-button"
            style="padding: 0.5rem 1rem; font-size: 0.875rem; min-height: auto; width: auto;"
          >
            Open chat
          </a>
        </li>
      </ul>
    </nav>

    <main style="flex: 1;">
      {render_slot(@inner_block)}
    </main>

    <footer class="site-footer">
      <p>
        <a href="/" class="wordmark wordmark-small">
          <span class="wm-s">s</span><span class="wm-tel">TEL</span><span class="wm-gano">gano</span>
        </a>
      </p>
      <div class="footer-links">
        <a href="/privacy" class="footer-link">Privacy</a>
        <a href="/terms" class="footer-link">Terms</a>
        <a href="/security" class="footer-link">Security</a>
      </div>
      <p class="footer-note">
        AGPL-3.0 · Hidden in the contact layer.
      </p>
    </footer>

    <.flash_group flash={@flash} />
    """
  end

  @doc """
  Flash group — displays info and error flash messages.
  """
  attr :flash, :map, required: true
  attr :id, :string, default: "flash-group"

  def flash_group(assigns) do
    ~H"""
    <div
      id={@id}
      aria-live="polite"
      class="flash-group"
      style="position: fixed; top: 1rem; right: 1rem; z-index: 1000; max-width: 400px;"
    >
      <.flash kind={:info} flash={@flash} />
      <.flash kind={:error} flash={@flash} />

      <.flash
        id="client-error"
        kind={:error}
        title={gettext("Connection lost")}
        phx-disconnected={show(".phx-client-error #client-error") |> JS.remove_attribute("hidden")}
        phx-connected={hide("#client-error") |> JS.set_attribute({"hidden", ""})}
        hidden
      >
        {gettext("Attempting to reconnect")}
        <.icon name="hero-arrow-path" class="ml-1 size-3 animate-spin" />
      </.flash>

      <.flash
        id="server-error"
        kind={:error}
        title={gettext("Something went wrong")}
        phx-disconnected={show(".phx-server-error #server-error") |> JS.remove_attribute("hidden")}
        phx-connected={hide("#server-error") |> JS.set_attribute({"hidden", ""})}
        hidden
      >
        {gettext("Attempting to reconnect")}
        <.icon name="hero-arrow-path" class="ml-1 size-3 animate-spin" />
      </.flash>
    </div>
    """
  end

  @doc """
  Three-way theme toggle: system / light / dark.
  """
  def theme_toggle(assigns) do
    ~H"""
    <div class="theme-toggle" role="group" aria-label="Theme">
      <button
        class="btn-icon theme-toggle-button"
        style="padding: 0.25rem;"
        phx-click={JS.dispatch("phx:set-theme")}
        data-phx-theme="system"
        title="System"
      >
        <.icon name="hero-computer-desktop-micro" class="size-4" />
      </button>
      <button
        class="btn-icon theme-toggle-button"
        style="padding: 0.25rem;"
        phx-click={JS.dispatch("phx:set-theme")}
        data-phx-theme="light"
        title="Light"
      >
        <.icon name="hero-sun-micro" class="size-4" />
      </button>
      <button
        class="btn-icon theme-toggle-button"
        style="padding: 0.25rem;"
        phx-click={JS.dispatch("phx:set-theme")}
        data-phx-theme="dark"
        title="Dark"
      >
        <.icon name="hero-moon-micro" class="size-4" />
      </button>
    </div>
    """
  end
end
