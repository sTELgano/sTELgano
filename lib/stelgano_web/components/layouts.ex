# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.Layouts do
  @moduledoc """
  Application layout components.

  The `app/1` component is a minimal shell — no navbar, no branding beyond
  what individual pages add. The `/chat` route's LiveView manages its own
  full-screen layout directly.
  """

  use StelganoWeb, :html

  embed_templates "layouts/*"

  @doc """
  Renders the app layout shell.

  Used by public pages and LiveViews. Does not render a global navbar —
  each page/LiveView is responsible for its own header if needed.

  ## Examples

      <Layouts.app flash={@flash}>
        <h1>Content</h1>
      </Layouts.app>
  """
  attr :flash, :map, required: true

  slot :inner_block, required: true

  def app(assigns) do
    ~H"""
    <div style="background: var(--bg-base); min-height: 100dvh;">
      {render_slot(@inner_block)}
    </div>
    <.flash_group flash={@flash} />
    """
  end

  @doc """
  Flash group — displays info and error flash messages.

  Per Phoenix v1.8 guidelines, this is the only place `<.flash_group>` is called.
  """
  attr :flash, :map, required: true
  attr :id, :string, default: "flash-group"

  def flash_group(assigns) do
    ~H"""
    <div id={@id} aria-live="polite">
      <.flash kind={:info} flash={@flash} />
      <.flash kind={:error} flash={@flash} />

      <.flash
        id="client-error"
        kind={:error}
        title={gettext("We can't find the internet")}
        phx-disconnected={show(".phx-client-error #client-error") |> JS.remove_attribute("hidden")}
        phx-connected={hide("#client-error") |> JS.set_attribute({"hidden", ""})}
        hidden
      >
        {gettext("Attempting to reconnect")}
        <.icon name="hero-arrow-path" class="ml-1 size-3 motion-safe:animate-spin" />
      </.flash>

      <.flash
        id="server-error"
        kind={:error}
        title={gettext("Something went wrong!")}
        phx-disconnected={show(".phx-server-error #server-error") |> JS.remove_attribute("hidden")}
        phx-connected={hide("#server-error") |> JS.set_attribute({"hidden", ""})}
        hidden
      >
        {gettext("Attempting to reconnect")}
        <.icon name="hero-arrow-path" class="ml-1 size-3 motion-safe:animate-spin" />
      </.flash>
    </div>
    """
  end

  @doc """
  Light / dark / system theme toggle widget.
  """
  def theme_toggle(assigns) do
    ~H"""
    <div class="relative flex flex-row items-center rounded-full"
      style="border: 2px solid var(--border); background: var(--bg-raised);">
      <div class="absolute w-1/3 h-full rounded-full transition-[left] duration-150"
        style="background: var(--bg-surface); border: 1px solid var(--border);
               left: 0;
               [[data-theme=light]_&]:left-1/3;
               [[data-theme=dark]_&]:left-2/3;" />

      <button class="flex p-2 cursor-pointer w-1/3"
        phx-click={JS.dispatch("phx:set-theme")} data-phx-theme="system">
        <span class="text-muted-icon"><.icon name="hero-computer-desktop-micro" class="size-4" /></span>
      </button>

      <button class="flex p-2 cursor-pointer w-1/3"
        phx-click={JS.dispatch("phx:set-theme")} data-phx-theme="light">
        <span class="text-muted-icon"><.icon name="hero-sun-micro" class="size-4" /></span>
      </button>

      <button class="flex p-2 cursor-pointer w-1/3"
        phx-click={JS.dispatch("phx:set-theme")} data-phx-theme="dark">
        <span class="text-muted-icon"><.icon name="hero-moon-micro" class="size-4" /></span>
      </button>
    </div>
    """
  end
end
