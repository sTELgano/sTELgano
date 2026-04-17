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

        <div class="flex items-center gap-3 sm:gap-6">
          <div class="hidden md:flex items-center gap-8 mr-4">
            <.link
              navigate={~p"/spec"}
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
            <.link
              navigate={~p"/blog"}
              class="text-xs font-bold uppercase tracking-[0.2em] text-slate-500 hover:text-white transition-all"
            >
              Blog
            </.link>
          </div>
          <div class="hidden sm:block h-4 w-px bg-white/10 mx-2"></div>
          <%= if assigns[:view_module] not in [StelganoWeb.ChatLive, StelganoWeb.StegNumberLive] do %>
            <.link navigate={~p"/steg-number"} class="btn-primary py-2.5 px-5 text-[10px] sm:text-xs">
              Start Chat
            </.link>
          <% end %>
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
        <.icon name="refresh_cw" class="ml-1 size-3 animate-spin" />
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
end
