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

  @spec app(map()) :: Phoenix.LiveView.Rendered.t()
  def app(assigns) do
    ~H"""
    <nav class="fixed top-0 left-0 right-0 z-50 border-b border-white/5 backdrop-blur-2xl bg-slate-950/40">
      <div class="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <.link navigate={~p"/"} class="wordmark group text-xl">
          <span class="wm-symbol">s</span><span class="wm-accent">TEL</span><span class="text-white">gano</span>
        </.link>

        <div class="flex items-center gap-6">
          <div class="hidden sm:flex items-center gap-8 mr-4">
            <.link
              navigate={~p"/security"}
              class="text-xs font-bold uppercase tracking-[0.2em] text-slate-500 hover:text-white transition-all"
            >
              Spec
            </.link>
            <.link
              navigate={~p"/about"}
              class="text-xs font-bold uppercase tracking-[0.2em] text-slate-500 hover:text-white transition-all"
            >
              About
            </.link>
          </div>
          <div class="h-4 w-px bg-white/10 mx-2"></div>
          <.theme_toggle />
          <.link navigate={~p"/steg-number"} class="btn-primary py-2 px-6 text-xs">
            Start Channel
          </.link>
        </div>
      </div>
    </nav>

    <main class="flex-1 flex flex-col pt-16 h-screen overflow-y-auto">
      <.flash_group flash={@flash} />
      <div class="max-w-5xl mx-auto w-full px-6 py-12 flex-1 flex flex-col">
        {render_slot(@inner_block)}
      </div>
    </main>
    """
  end

  @doc """
  Flash group — displays info and error flash messages.
  """
  attr :flash, :map, required: true
  attr :id, :string, default: "flash-group"

  @spec flash_group(map()) :: Phoenix.LiveView.Rendered.t()
  def flash_group(assigns) do
    ~H"""
    <div
      id={@id}
      aria-live="polite"
      class="fixed top-6 right-6 z-100 flex flex-col gap-3 w-full max-w-sm pointer-events-none"
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
  @spec theme_toggle(map()) :: Phoenix.LiveView.Rendered.t()
  def theme_toggle(assigns) do
    ~H"""
    <div class="flex items-center gap-1 p-1 bg-white/5 rounded-full border border-white/5 shadow-inner">
      <button
        phx-click={JS.dispatch("phx:set-theme", detail: %{theme: "system"})}
        class="p-1.5 rounded-full hover:bg-white/10 transition-colors text-slate-400 hover:text-white"
        title="System"
      >
        <.icon name="hero-computer-desktop-micro" class="size-4" />
      </button>
      <button
        phx-click={JS.dispatch("phx:set-theme", detail: %{theme: "light"})}
        class="p-1.5 rounded-full hover:bg-white/10 transition-colors text-slate-400 hover:text-white"
        title="Light"
      >
        <.icon name="hero-sun-micro" class="size-4" />
      </button>
      <button
        phx-click={JS.dispatch("phx:set-theme", detail: %{theme: "dark"})}
        class="p-1.5 rounded-full hover:bg-white/10 transition-colors text-slate-400 hover:text-white"
        title="Dark"
      >
        <.icon name="hero-moon-micro" class="size-4" />
      </button>
    </div>
    """
  end
end
