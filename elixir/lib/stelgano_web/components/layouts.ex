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

  alias Stelgano.Monetization

  embed_templates "layouts/*"

  @doc """
  Renders the app layout shell with navigation and footer.

  ## Attributes

  * `active_chat` - Boolean flag to hide header and footer (default: false).
  """
  attr :flash, :map, required: true
  attr :active_chat, :boolean, default: false
  slot :inner_block, required: true
  @spec app(map()) :: Phoenix.LiveView.Rendered.t()
  def app(assigns) do
    ~H"""
    <nav
      :if={!@active_chat}
      class="fixed top-0 left-0 right-0 z-50 border-b border-white/5 backdrop-blur-2xl bg-slate-950/40"
    >
      <div class="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <.link navigate={~p"/"} class="wordmark group text-xl">
          <span class="wm-symbol">s</span><span class="wm-accent">TEL</span><span class="text-white">gano</span>
        </.link>

        <div class="flex items-center gap-2 sm:gap-6">
          <div class="hidden md:flex items-center gap-8 mr-4">
            <.link
              navigate={~p"/spec"}
              class="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 hover:text-white transition-all"
            >
              Spec
            </.link>
            <.link
              navigate={~p"/about"}
              class="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 hover:text-white transition-all"
            >
              About
            </.link>
            <.link
              navigate={~p"/blog"}
              class="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 hover:text-white transition-all"
            >
              Blog
            </.link>
            <%= if Monetization.enabled?() do %>
              <.link
                navigate={~p"/pricing"}
                class="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 hover:text-white transition-all"
              >
                Pricing
              </.link>
            <% end %>
          </div>

          <div class="hidden sm:block h-4 w-px bg-white/10 mx-2"></div>

          <div class="flex items-center gap-3">
            <%= if assigns[:view_module] != StelganoWeb.ChatLive do %>
              <.link navigate={~p"/chat"} class="btn-primary py-2 px-4 text-[10px] sm:text-xs">
                Open Chat
              </.link>
            <% end %>

            <button
              type="button"
              class="md:hidden flex flex-col gap-1.5 p-2"
              phx-click={
                JS.show(
                  to: "#mobile-menu",
                  transition:
                    {"transition ease-out duration-200", "opacity-0 translate-x-full",
                     "opacity-100 translate-x-0"}
                )
              }
            >
              <span class="w-5 h-0.5 bg-white/70 rounded-full"></span>
              <span class="w-3 h-0.5 bg-white/70 rounded-full ml-auto"></span>
              <span class="w-5 h-0.5 bg-white/70 rounded-full"></span>
            </button>
          </div>
        </div>
      </div>
      
    <!-- Mobile Menu Overlay -->
      <div
        id="mobile-menu"
        class="fixed inset-0 z-[60] hidden"
        phx-window-keydown={JS.hide(to: "#mobile-menu")}
        phx-key="Escape"
      >
        <div
          class="absolute inset-0 bg-slate-950/80 backdrop-blur-xl"
          phx-click={JS.hide(to: "#mobile-menu")}
        >
        </div>
        <nav class="absolute top-0 right-0 bottom-0 w-64 bg-slate-950 border-l border-white/10 p-8 flex flex-col gap-8 shadow-2xl">
          <div class="flex items-center justify-between mb-4">
            <span class="wordmark text-lg">
              <span class="wm-symbol">s</span><span class="wm-accent">TEL</span>
            </span>
            <button
              type="button"
              phx-click={JS.hide(to: "#mobile-menu")}
              class="p-2 text-slate-400 hover:text-white"
            >
              <.icon name="hero-x-mark" class="size-6" />
            </button>
          </div>

          <div class="flex flex-col gap-6">
            <.link
              navigate={~p"/spec"}
              class="text-sm font-bold uppercase tracking-widest text-slate-400 hover:text-white transition-all px-2 py-1 border-l-2 border-transparent hover:border-primary"
              phx-click={JS.hide(to: "#mobile-menu")}
            >
              Spec
            </.link>
            <.link
              navigate={~p"/about"}
              class="text-sm font-bold uppercase tracking-widest text-slate-400 hover:text-white transition-all px-2 py-1 border-l-2 border-transparent hover:border-primary"
              phx-click={JS.hide(to: "#mobile-menu")}
            >
              About
            </.link>
            <.link
              navigate={~p"/blog"}
              class="text-sm font-bold uppercase tracking-widest text-slate-400 hover:text-white transition-all px-2 py-1 border-l-2 border-transparent hover:border-primary"
              phx-click={JS.hide(to: "#mobile-menu")}
            >
              Blog
            </.link>
            <%= if Monetization.enabled?() do %>
              <.link
                navigate={~p"/pricing"}
                class="text-sm font-bold uppercase tracking-widest text-slate-400 hover:text-white transition-all px-2 py-1 border-l-2 border-transparent hover:border-primary"
                phx-click={JS.hide(to: "#mobile-menu")}
              >
                Pricing
              </.link>
            <% end %>
          </div>

          <div class="mt-auto">
            <.link
              navigate={~p"/chat"}
              class="btn-primary w-full py-3 text-xs"
              phx-click={JS.hide(to: "#mobile-menu")}
            >
              Open Chat
            </.link>
          </div>
        </nav>
      </div>
    </nav>

    <main class={[
      "flex-1 flex flex-col",
      @active_chat && "h-dvh overflow-y-auto overflow-x-hidden",
      !@active_chat && "h-screen overflow-y-auto pt-16"
    ]}>
      <.flash_group flash={@flash} />
      <div class={[
        "w-full flex-1 flex flex-col",
        !@active_chat && "max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12"
      ]}>
        {render_slot(@inner_block)}
      </div>

      <footer
        :if={!@active_chat}
        class="px-6 py-20 border-t border-white/5 bg-slate-950/40 relative"
      >
        <div class="max-w-6xl mx-auto flex flex-col items-center md:items-start md:flex-row justify-between gap-12">
          <div class="flex flex-col items-center md:items-start gap-4 text-center md:text-left">
            <.link navigate={~p"/"} class="wordmark text-2xl">
              <span class="wm-symbol">s</span><span class="wm-accent">TEL</span><span>gano</span>
            </.link>
            <p class="text-slate-500 text-sm font-medium max-w-xs">
              The messaging app hidden in your contacts.
            </p>
            <p class="text-slate-600 text-[10px] font-mono uppercase tracking-[0.25em]">
              stel<span class="text-slate-400">·GAH·</span>no &mdash; steganography + TEL
            </p>
          </div>

          <div class="flex flex-wrap justify-center gap-x-8 gap-y-4 max-w-sm">
            <a
              :for={link <- ["Security", "Privacy", "Terms", "About", "Spec", "Blog"]}
              href={"/#{String.downcase(link)}"}
              class="text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-white transition-colors"
            >
              {link}
            </a>
          </div>

          <div class="flex flex-col items-center md:items-end gap-4">
            <div class="flex items-center gap-3">
              <div class="px-2 py-1 rounded bg-white/5 border border-white/10 text-[10px] font-mono font-bold text-slate-500 uppercase">
                AGPL-3.0
              </div>
              <div class="px-2 py-1 rounded bg-white/5 border border-white/10 text-[10px] font-mono font-bold text-slate-500 uppercase">
                Build 2026.04
              </div>
            </div>
            <p class="text-[9px] text-slate-700 font-mono italic">
              &copy; 2026 sTELgano Contributors
            </p>
          </div>
        </div>
      </footer>
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
