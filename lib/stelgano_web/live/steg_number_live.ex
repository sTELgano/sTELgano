# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.StegNumberLive do
  @moduledoc """
  LiveView for the `/steg-number` page.

  Provides:
  - Country selector for targeted number generation
  - A generated steg number (via client-side JS hook using phone-number-generator-js)
  - Copy-to-clipboard with 2-second confirmation
  - "Open Channel" button that navigates to `/chat` with the number pre-populated
  - The "hidden in plain sight" setup guide

  ## Passcode Test

  This page is publicly accessible and reveals nothing beyond its stated purpose.
  A casual observer learns only that it is a number generator.
  """

  use StelganoWeb, :live_view

  @impl Phoenix.LiveView
  def mount(_params, _session, socket) do
    socket =
      socket
      |> assign(:page_title, "Steg Number — sTELgano")
      |> assign(:generated_number, nil)
      |> assign(:copied, false)
      |> assign(:availability, :idle)
      |> assign(:generating, false)
      |> assign(:selected_country, "Kenya")
      |> assign(:show_countries, false)
      |> assign(:countries, [
        {"Kenya", "Kenya"}, {"United States", "United_States"}, {"United Kingdom", "United_Kingdom"},
        {"Germany", "Germany"}, {"France", "France"}, {"Canada", "Canada"}, {"Japan", "Japan"},
        {"Australia", "Australia"}, {"India", "India"}, {"Brazil", "Brazil"}, {"South Africa", "South_Africa"},
        {"Nigeria", "Nigeria"}, {"Egypt", "Egypt"}, {"Morocco", "Morocco"}, {"Ethiopia", "Ethiopia"},
        {"Ghana", "Ghana"}, {"Tanzania", "Tanzania"}, {"Uganda", "Uganda"}, {"Rwanda", "Rwanda"}
      ])

    {:ok, socket}
  end

  @impl Phoenix.LiveView
  def handle_event("number_generated", %{"number" => number, "display" => display}, socket) do
    socket =
      socket
      |> assign(:generated_number, %{e164: number, display: display})
      |> assign(:copied, false)
      |> assign(:availability, :idle)
      |> assign(:generating, false)

    {:noreply, socket}
  end

  @impl Phoenix.LiveView
  def handle_event("start_generation", _params, socket) do
    {:noreply, assign(socket, :generating, true)}
  end

  @impl Phoenix.LiveView
  def handle_event("set_countries", %{"countries" => countries}, socket) do
    # Convert list of maps to list of tuples for HEEx
    country_tuples = Enum.map(countries, fn %{"name" => name, "value" => val} -> {name, val} end)
    {:noreply, assign(socket, :countries, country_tuples)}
  end

  @impl Phoenix.LiveView
  def handle_event("update_country", %{"country" => country}, socket) do
    {:noreply, assign(socket, selected_country: country, show_countries: false)}
  end

  @impl Phoenix.LiveView
  def handle_event("toggle_countries", _params, socket) do
    {:noreply, assign(socket, :show_countries, !socket.assigns.show_countries)}
  end

  @impl Phoenix.LiveView
  def handle_event("close_countries", _params, socket) do
    {:noreply, assign(socket, :show_countries, false)}
  end

  @impl Phoenix.LiveView
  def handle_event("check_availability", %{"room_hash" => room_hash}, socket) do
    availability = if Stelgano.Rooms.room_exists?(room_hash), do: :taken, else: :available
    {:noreply, assign(socket, :availability, availability)}
  end

  @impl Phoenix.LiveView
  def handle_event("copied", _params, socket) do
    socket = assign(socket, :copied, true)
    Process.send_after(self(), :clear_copied, 2_000)
    {:noreply, socket}
  end

  @impl Phoenix.LiveView
  def handle_info(:clear_copied, socket) do
    {:noreply, assign(socket, :copied, false)}
  end

  @impl Phoenix.LiveView
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash}>
      <div class="max-w-4xl mx-auto space-y-16 animate-in">
        <%!-- Hero Header --%>
        <div class="text-center space-y-8 pt-12">
          <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-bold uppercase tracking-[0.2em] animate-in stagger-1 shadow-[0_0_20px_rgba(0,255,163,0.1)]">
            <.icon name="sparkles" class="size-3" /> Secret Number Generator
          </div>

          <h1 class="text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tighter text-white font-display mb-8">
          Secret Number <span class="text-gradient">Generator</span>
        </h1>

          <p class="text-slate-400 text-lg sm:text-2xl font-medium leading-tight max-w-2xl mx-auto animate-in stagger-3">
            Generate a secret number to create your private channel. Use it to establish an invisible link with your partner.
          </p>
        </div>

        <%!-- Generator Section --%>
        <div class="grid grid-cols-1 lg:grid-cols-5 gap-10 items-start">
          <div class="lg:col-span-3 space-y-6 animate-in stagger-3">
            <.premium_card
              id="generator-card"
              phx-hook="PhoneGenerator"
              class="p-1 sm:p-1 overflow-hidden"
            >
              <div class="p-8 sm:p-10 space-y-10">
                <%!-- Identity Selector --%>
                  <div class="space-y-4">
                    <div class="flex items-center justify-between px-1">
                      <label class="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500">
                        Select Country
                      </label>
                    </div>
                    <div class="relative group">
                      <div class="absolute inset-0 bg-primary/5 rounded-2xl blur-xl opacity-0 group-hover:opacity-100 transition-opacity">
                      </div>
                      
                      <%!-- Custom Premium Dropdown --%>
                      <div class="relative z-20">
                        <h4 class="text-white font-bold mb-4 flex items-center gap-2">
                          <.icon name="badge_check" class="size-5 text-primary" />
                          Secure your number
                        </h4>
                        <button
                          type="button"
                          phx-click="toggle_countries"
                          class="glass-input w-full flex items-center justify-between gap-4 text-left group/btn"
                        >
                          <span class="flex items-center gap-3">
                            <.icon name="globe" class="size-5 text-primary/60" />
                            <span class="font-bold text-white">
                              {Enum.find_value(@countries, "Select Matrix", fn {name, val} ->
                                if val == @selected_country, do: name
                              end)}
                            </span>
                          </span>
                          <.icon
                            name="chevron_down"
                            class={[
                              "size-5 text-slate-500 transition-transform duration-300",
                              @show_countries && "rotate-180 text-primary"
                            ]}
                          />
                        </button>


                        <%= if @show_countries do %>
                          <div
                            class="absolute top-full left-0 right-0 mt-3 p-2 glass-card-premium z-50 max-h-64 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 animate-in"
                            phx-click-away="close_countries"
                          >
                            <div class="grid grid-cols-1 gap-1">
                              <button
                                :for={{name, val} <- @countries}
                                type="button"
                                phx-click="update_country"
                                phx-value-country={val}
                                class={[
                                  "w-full px-4 py-3 rounded-xl text-left text-sm font-bold transition-all flex items-center justify-between group/item",
                                  if(@selected_country == val,
                                    do: "bg-primary text-slate-950 shadow-[0_0_15px_rgba(0,255,163,0.3)]",
                                    else: "text-slate-400 hover:bg-white/5 hover:text-white"
                                  )
                                ]}
                              >
                                <span class="flex items-center gap-3">
                                  <.icon name="map_pin" class="size-4 opacity-40 group-hover/item:opacity-100 transition-opacity" />
                                  {name}
                                </span>
                                <%= if @selected_country == val do %>
                                  <.icon name="check_circle" class="size-4" />
                                <% end %>
                              </button>
                            </div>
                          </div>
                        <% end %>
                      </div>

                      <input type="hidden" name="country" id="country-select" value={@selected_country} />
                    </div>
                  </div>

                <%!-- High-Impact Number Display --%>
                <div class="relative py-12 px-8 rounded-3xl bg-slate-950/50 border border-white/5 shadow-inner overflow-hidden group">
                  <div class="absolute inset-0 bg-linear-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700">
                  </div>

                  <%= if @generating do %>
                    <div class="relative z-10 py-12 text-center space-y-8 animate-in">
                      <div class="relative size-20 mx-auto">
                        <div class="absolute inset-0 rounded-full border-2 border-primary/20 border-t-primary animate-spin">
                        </div>
                        <div class="absolute inset-0 flex items-center justify-center">
                          <.icon name="cpu" class="size-10 text-primary animate-pulse" />
                        </div>
                      </div>
                      <div class="space-y-2">
                        <h3 class="text-white font-black uppercase tracking-[0.2em] text-[10px] mb-4 flex items-center gap-2">
                          <.icon name="shield_check" class="size-4" /> Security Setup
                        </h3>
                        <p class="text-xs text-slate-500 font-mono">Randomizing identity seed...</p>
                      </div>
                    </div>
                  <% else %>
                    <%= if @generated_number do %>
                      <div class="relative z-10 text-center space-y-6 animate-in">
                        <div class="text-[10px] font-bold uppercase tracking-[0.4em] text-primary/60">
                          Your Secret Number
                        </div>
                        <div
                          id="generated-display"
                          class={[
                            "font-mono font-black text-white tracking-widest drop-shadow-[0_0_20px_rgba(0,255,163,0.3)] transition-all break-all overflow-hidden",
                            if(String.length(@generated_number.display) > 15,
                              do: "text-2xl sm:text-3xl md:text-4xl",
                              else: "text-4xl sm:text-5xl md:text-6xl"
                            )
                          ]}
                        >
                          {@generated_number && @generated_number.display}
                        </div>
                        <div class="flex flex-col items-center gap-6 pt-2">
                          <button
                            id="copy-btn"
                            type="button"
                            phx-click="copied"
                            data-number={@generated_number && @generated_number.e164}
                            class={[
                              "inline-flex items-center gap-3 px-8 py-3 rounded-2xl text-xs font-bold uppercase tracking-widest transition-all active:scale-95",
                              if(@copied,
                                do:
                                  "bg-emerald-500 text-slate-950 shadow-[0_0_15px_rgba(16,185,129,0.4)]",
                                else: "bg-white/5 text-white hover:bg-white/10 border border-white/10"
                              )
                            ]}
                          >
                            <%= if @copied do %>
                              <.icon name="check_circle" class="size-4" />
                              Copied to Clipboard
                            <% else %>
                              <.icon name="clipboard" class="size-4" /> Copy Number
                            <% end %>
                          </button>

                          <div
                            id="availability-check"
                            class="flex items-center gap-2 px-4 py-2 rounded-full bg-slate-900 border border-white/5"
                          >
                            <%= cond do %>
                              <% @availability == :available -> %>
                                <div class="size-1.5 rounded-full bg-emerald-500"></div>
                                <span class="text-[9px] font-black uppercase tracking-widest text-emerald-500">
                                  Number Available
                                </span>
                              <% @availability == :taken -> %>
                                <div class="size-1.5 rounded-full bg-danger animate-pulse"></div>
                                <span class="text-[9px] font-black uppercase tracking-widest text-danger">
                                  Active Room Detected
                                </span>
                              <% true -> %>
                                <div class="size-1.5 rounded-full bg-slate-700"></div>
                                <span class="text-[9px] font-black uppercase tracking-widest text-slate-500">
                                  Awaiting Analysis
                                </span>
                            <% end %>
                          </div>
                        </div>
                      </div>
                    <% else %>
                      <div class="relative z-10 py-10 text-center animate-in">
                        <div class="size-20 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mx-auto mb-6 group-hover:border-primary/20 transition-colors">
                          <.icon
                            name="phone"
                            class="size-10 text-slate-700 group-hover:text-slate-500 transition-colors"
                          />
                        </div>
                        <p class="text-slate-500 font-bold uppercase tracking-[0.2em] text-sm group-hover:text-slate-400 transition-colors">
                          Waiting to create number
                        </p>
                      </div>
                    <% end %>
                  <% end %>
                </div>

                <button
                  type="button"
                  id="generate-btn"
                  disabled={@generating}
                  class={[
                    "btn-primary w-full py-5 text-lg group shadow-[0_20px_40px_-10px_rgba(0,255,163,0.3)]",
                    @generating && "opacity-50 grayscale cursor-not-allowed shadow-none"
                  ]}
                >
                  <span class="relative z-10 flex items-center gap-3">
                    {if(@generated_number, do: "Generate New Number", else: "Generate Secret Number")}
                    <.icon
                      name="refresh_cw"
                      class={[
                        "size-6 transition-transform duration-700",
                        if(@generating, do: "animate-spin", else: "group-hover:rotate-180")
                      ]}
                    />
                  </span>
                </button>
              </div>
            </.premium_card>
          </div>

          <div class="lg:col-span-2 space-y-8 animate-in stagger-4">
            <div class="p-8 rounded-3xl bg-danger/5 border border-danger/20 space-y-4">
              <div class="flex items-center gap-3 text-danger">
                <.icon name="alert_triangle" class="size-6" />
                <h3 class="font-bold uppercase tracking-widest text-sm">Privacy Note</h3>
              </div>
              <p class="text-slate-400 text-sm leading-relaxed font-medium">
                This number is not permanent. Once you close this session, it is deleted from memory.
                <span class="text-white">
                  Coordinate with your partner to save this exact value immediately.
                </span>
              </p>
            </div>

            <div class="space-y-4 pt-4">
              <label class="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500 ml-1">
                Establish Session
              </label>
              <.link
                navigate={
                  ~p"/chat?#{if @generated_number, do: [phone: @generated_number.e164], else: []}"
                }
                id="open-channel-btn"
                class={[
                  "w-full py-5 rounded-2xl flex items-center justify-center gap-3 font-bold uppercase tracking-widest transition-all",
                  if(@generated_number,
                    do: "bg-white text-slate-950 shadow-xl hover:scale-[1.02]",
                    else: "bg-white/5 text-slate-600 cursor-not-allowed pointer-events-none"
                  )
                ]}
              >
                Enter Chat Workspace <.icon name="shield_check" class="size-5" />
              </.link>
            </div>
          </div>
        </div>

        <%!-- Step Guide --%>
        <div class="space-y-8 pb-20 animate-in stagger-5">
          <div class="flex items-center gap-4">
            <div class="h-px flex-1 bg-white/5"></div>
            <h2 class="text-[10px] font-bold uppercase tracking-[0.4em] text-slate-500">
              How to use this number
            </h2>
            <div class="h-px flex-1 bg-white/5"></div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div
              :for={
                {step, title, desc, icon} <- [
                  {1, "Save the number",
                   "Add this number to your partner's profile in your phone's contact list.", "user_plus"},
                  {2, "Match Number",
                   "Check that both you and your partner have the exact same number.", "arrow_left_right"},
                  {3, "Open Chat",
                   "Use the saved number plus your private PIN to open the chat room.", "messages_square"}
                ]
              }
              class="glass-card p-8 group relative overflow-hidden transition-all hover:border-primary/30"
            >
              <div class="absolute -right-4 -bottom-4 text-7xl font-black text-white/3 group-hover:text-primary/5 transition-colors italic">
                {step}
              </div>
              <div class="size-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary mb-6 ring-1 ring-primary/20">
                <.icon name={icon} class="size-6" />
              </div>
              <h4 class="text-white font-bold mb-3 flex items-center gap-2">
                {title}
              </h4>
              <p class="text-sm text-slate-400 leading-relaxed font-medium">
                {desc}
              </p>
            </div>
          </div>
        </div>
      </div>
    </Layouts.app>
    """
  end
end
