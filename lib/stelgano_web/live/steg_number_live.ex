# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.StegNumberLive do
  @moduledoc """
  LiveView for the `/steg-number` page.

  Provides:
  - Country selector for targeted number generation
  - A generated steg number (via client-side JS hook using phone-number-generator-js)
  - Copy-to-clipboard with 2-second confirmation
  - "Open Channel" button that hands the number to `/chat` via a one-shot
    `sessionStorage` key (`stelegano_handoff_phone`) — the URL stays clean
  - The "hidden in plain sight" setup guide

  ## Passcode Test

  This page is publicly accessible and reveals nothing beyond its stated purpose.
  A casual observer learns only that it is a number generator.
  """

  use StelganoWeb, :live_view

  import StelganoWeb.Helpers.PriceFormatter, only: [format_price: 2]

  alias Stelgano.Monetization
  alias Stelgano.Repo
  alias Stelgano.Rooms.Room
  alias StelganoWeb.Data.Countries

  @impl Phoenix.LiveView
  def mount(_params, _session, socket) do
    socket =
      socket
      |> assign(:page_title, "Steg Number — sTELgano")
      |> assign(:generated_number, nil)
      |> assign(:copied, false)
      |> assign(:availability, :idle)
      |> assign(:generating, false)
      |> assign(:payment_loading, false)
      |> assign(:monetization_enabled, Monetization.enabled?())
      |> assign(:price_cents, Monetization.price_cents())
      |> assign(:currency, Monetization.currency())
      |> assign(:free_ttl_days, Monetization.free_ttl_days())
      |> assign(:paid_ttl_days, Monetization.paid_ttl_days())
      |> assign(:entry_mode, :generate)
      |> assign(:manual_number, "")
      |> assign(:room_details, nil)
      |> assign(:selected_country, nil)
      |> assign(:selected_iso, nil)
      |> assign(:search_query, "")
      |> assign(:show_countries, false)
      |> assign(:all_countries, Countries.list())
      # Will be populated on select/search
      |> assign(:countries, [])
      |> assign(:selected_tier, nil)
      |> assign(:manual_error, nil)
      # Per-LV-session ring buffer of availability-check timestamps (ms).
      # Limits manual-entry probing to `@check_limit` per
      # `@check_window_ms` — see `check_manual_number` handler.
      |> assign(:check_timestamps, [])

    {:ok, socket}
  end

  # Maximum `check_manual_number` events per `@check_window_ms` per LV session.
  # Combined with the IP-wide rate limiter and the Rooms.join_room timing pad,
  # this closes the manual-entry availability check as an enumeration oracle
  # against `room_hash` existence.
  @check_limit 10
  @check_window_ms 60_000

  @impl Phoenix.LiveView
  def handle_event(
        "number_generated",
        %{"number" => number, "display" => display} = params,
        socket
      ) do
    room_hash = Map.get(params, "room_hash")

    availability =
      if room_hash,
        do: if(Stelgano.Rooms.room_exists?(room_hash), do: :taken, else: :available),
        else: :idle

    socket =
      socket
      |> assign(:generated_number, %{e164: number, display: display})
      |> assign(:copied, false)
      |> assign(:availability, availability)
      |> assign(:generating, false)
      |> assign(:selected_tier, nil)

    {:noreply, socket}
  end

  @impl Phoenix.LiveView
  def handle_event("start_generation", _params, socket) do
    {:noreply, assign(socket, :generating, true)}
  end

  @impl Phoenix.LiveView
  def handle_event("search_country", %{"value" => query}, socket) do
    filtered =
      if query == "" do
        []
      else
        Enum.filter(socket.assigns.all_countries, fn {name, _val, _iso} ->
          String.contains?(String.downcase(name), String.downcase(query))
        end)
      end

    {:noreply,
     assign(socket, search_query: query, countries: filtered, show_countries: query != "")}
  end

  @impl Phoenix.LiveView
  def handle_event("update_country", %{"country" => country, "iso" => iso}, socket) do
    socket =
      socket
      |> assign(
        selected_country: country,
        selected_iso: iso,
        show_countries: false,
        search_query: ""
      )
      |> push_event("country_selected", %{country: country, iso: String.upcase(iso)})

    {:noreply, socket}
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
  def handle_event("switch_mode", %{"mode" => mode}, socket) do
    mode = String.to_existing_atom(mode)

    socket =
      socket
      |> assign(:entry_mode, mode)
      |> assign(:generated_number, nil)
      |> assign(:manual_number, "")
      |> assign(:room_details, nil)
      |> assign(:availability, :idle)
      |> assign(:selected_tier, nil)

    {:noreply, socket}
  end

  @impl Phoenix.LiveView
  def handle_event("manual_number_change", %{"value" => number} = params, socket) do
    is_valid = Map.get(params, "is_valid", true)

    # If the number is identical to what we already have (after normalization), ignore the reset logic.
    # This prevents the blur event or redundant updates from resetting the availability/tier state.
    if normalize(socket.assigns.manual_number) == normalize(number) do
      {:noreply, socket}
    else
      error =
        if not is_valid and number != "",
          do: "Invalid format for #{socket.assigns.selected_country}",
          else: nil

      {:noreply,
       assign(socket,
         manual_number: number,
         manual_error: error,
         availability: :idle,
         selected_tier: nil
       )}
    end
  end

  @impl Phoenix.LiveView
  def handle_event("check_manual_number", %{"number" => number, "room_hash" => room_hash}, socket) do
    now = System.monotonic_time(:millisecond)
    window_start = now - @check_window_ms
    recent = Enum.filter(socket.assigns.check_timestamps, &(&1 >= window_start))

    if length(recent) >= @check_limit do
      # Over the per-session budget — do not hit the DB and do not reveal
      # whether this number is taken. Surface a throttle state to the UI.
      {:noreply,
       assign(socket,
         manual_number: number,
         manual_error: "Too many lookups. Wait a minute before trying another number.",
         availability: :idle,
         room_details: nil,
         check_timestamps: recent
       )}
    else
      room = Repo.get_by(Room, room_hash: room_hash, is_active: true)

      {availability, room_details} =
        if room do
          {:taken, %{tier: room.tier, ttl_expires_at: room.ttl_expires_at}}
        else
          {:available, nil}
        end

      {:noreply,
       assign(socket,
         manual_number: number,
         manual_error: nil,
         availability: availability,
         room_details: room_details,
         check_timestamps: [now | recent]
       )}
    end
  end

  @impl Phoenix.LiveView
  def handle_event("select_tier", %{"tier" => tier}, socket) do
    # Selection of tier for a new manual number
    # This will be handled when they click "Enter Chat Workspace"
    # or we could store it in assigns
    {:noreply, assign(socket, :selected_tier, tier)}
  end

  @impl Phoenix.LiveView
  def handle_event("initiate_payment", %{"token_hash" => token_hash}, socket) do
    if Monetization.enabled?() do
      handle_payment_initiation(socket, token_hash)
    else
      {:noreply, put_flash(socket, :error, "Payments are not enabled")}
    end
  end

  @impl Phoenix.LiveView
  def handle_event("restore_country", %{"country" => country}, socket) do
    # Validate country against available list
    found = Enum.find(socket.assigns.all_countries, fn {_name, v, _iso} -> v == country end)

    socket =
      if found do
        {_display, name, iso} = found

        socket
        |> assign(selected_country: name, selected_iso: iso)
        |> push_event("country_selected", %{country: name, iso: String.upcase(iso)})
      else
        socket
      end

    {:noreply, socket}
  end

  defp handle_payment_initiation(socket, token_hash) do
    socket = assign(socket, :payment_loading, true)

    case Monetization.create_token(token_hash) do
      {:ok, _token} ->
        case Monetization.initialize_payment(token_hash) do
          {:ok, checkout_url} ->
            {:noreply, redirect(socket, external: checkout_url)}

          {:error, _reason} ->
            {:noreply,
             socket
             |> assign(:payment_loading, false)
             |> put_flash(:error, "Payment initialization failed. Please try again.")}
        end

      {:error, _changeset} ->
        {:noreply,
         socket
         |> assign(:payment_loading, false)
         |> put_flash(:error, "Could not create payment token. Please try again.")}
    end
  end

  @impl Phoenix.LiveView
  def handle_info(:clear_copied, socket) do
    {:noreply, assign(socket, :copied, false)}
  end

  defp normalize(num) when is_binary(num), do: String.replace(num, ~r/[^0-9]/, "")
  defp normalize(_other), do: ""

  @impl Phoenix.LiveView
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash}>
      <div class="max-w-2xl mx-auto space-y-12 animate-in pb-20 px-4">
        <%!-- High Priority Warning --%>
        <div class="warning-card animate-in stagger-1">
          <.icon name="alert_triangle" class="icon size-6" />
          <div class="space-y-1">
            <h3 class="font-bold uppercase tracking-widest text-[10px]">
              Privacy & Persistence Notice
            </h3>
            <p class="text-sm leading-relaxed">
              These numbers are temporary.
              <span class="text-white">
                Coordinate with your partner to save this value immediately.
              </span>
              Once this session is closed, the un-saved number cannot be recovered.
            </p>
          </div>
        </div>

        <%!-- Header --%>
        <div class="text-center space-y-6 pt-6">
          <h1 class="text-4xl sm:text-6xl font-black tracking-tighter text-white font-display">
            Channel <span class="text-gradient">Identity</span>
          </h1>
          <p class="text-slate-400 text-lg font-medium max-w-xl mx-auto">
            Generate a new identity or join using an existing secret number.
          </p>
        </div>

        <%!-- Main selection and action area --%>
        <div class="space-y-10">
          <div class="glass-card p-1">
            <div class="p-8 sm:p-10 space-y-10">
              <%!-- Global Country Context --%>
              <div class="space-y-6">
                <div class="space-y-4">
                  <label class="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500 ml-1">
                    Channel Destination (Country)
                  </label>

                  <div
                    class="relative group"
                    id="country-search-container"
                    phx-click-away="close_countries"
                  >
                    <div class="relative">
                      <input
                        type="text"
                        name="country_search"
                        id="country-search-input"
                        placeholder={
                          if(@selected_country,
                            do: String.replace(@selected_country, "_", " "),
                            else: "Search or select country..."
                          )
                        }
                        class="bg-slate-900/80 border-2 border-white/5 text-white font-bold focus:ring-2 focus:ring-primary/40 focus:outline-none w-full py-4 px-6 rounded-2xl pr-14 transition-all hover:bg-slate-800"
                        phx-keyup="search_country"
                        phx-focus="search_country"
                        phx-value-value={@search_query}
                        autocomplete="off"
                      />
                      <div class="absolute right-6 top-1/2 -translate-y-1/2 text-slate-500">
                        <%= if @selected_country do %>
                          <.icon name="hero-check-badge" class="size-5 text-emerald-400" />
                        <% else %>
                          <.icon name="hero-magnifying-glass" class="size-5" />
                        <% end %>
                      </div>
                    </div>

                    <%!-- Dropdown list --%>
                    <%= if @show_countries and @countries != [] do %>
                      <div class="absolute z-50 w-full mt-2 bg-slate-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden max-h-64 overflow-y-auto animate-in fade-in slide-in-from-top-2">
                        <button
                          :for={{name, val, iso} <- @countries}
                          phx-click="update_country"
                          phx-value-country={val}
                          phx-value-iso={iso}
                          class="w-full px-6 py-4 text-left hover:bg-white/5 text-slate-300 hover:text-white transition-all border-b border-white/5 last:border-0 flex items-center justify-between group"
                        >
                          <span class="font-bold tracking-wide">{name}</span>
                          <.icon
                            name="hero-chevron-right"
                            class="size-4 opacity-0 group-hover:opacity-100 transition-opacity"
                          />
                        </button>
                      </div>
                    <% end %>

                    <%= if @show_countries and @countries == [] and @search_query != "" do %>
                      <div class="absolute z-50 w-full mt-2 bg-slate-900 border border-white/10 rounded-2xl p-6 text-center text-slate-500 text-xs uppercase tracking-widest font-bold">
                        No matching countries
                      </div>
                    <% end %>
                  </div>

                  <div phx-hook="CountryPersistence" id="persistence-hook" class="hidden"></div>
                </div>
              </div>

              <%!-- Mode Toggle --%>
              <div class="flex p-1 bg-slate-900/50 rounded-2xl border border-white/5">
                <button
                  phx-click="switch_mode"
                  phx-value-mode="generate"
                  class={[
                    "flex-1 py-3 px-4 rounded-xl text-xs font-bold uppercase tracking-widest transition-all",
                    if(@entry_mode == :generate,
                      do: "bg-white text-slate-950 shadow-lg",
                      else: "text-slate-500 hover:text-slate-300"
                    )
                  ]}
                >
                  Generate New
                </button>
                <button
                  phx-click="switch_mode"
                  phx-value-mode="manual"
                  class={[
                    "flex-1 py-3 px-4 rounded-xl text-xs font-bold uppercase tracking-widest transition-all",
                    if(@entry_mode == :manual,
                      do: "bg-white text-slate-950 shadow-lg",
                      else: "text-slate-500 hover:text-slate-300"
                    )
                  ]}
                >
                  Manual Entry
                </button>
              </div>

              <%= if @entry_mode == :generate do %>
                <%!-- Generator Layout --%>
                <div
                  class="space-y-8 animate-in"
                  phx-hook="PhoneGenerator"
                  id="generator-hook"
                  data-country={@selected_country}
                  data-iso={@selected_iso}
                >
                  <div class="relative py-12 px-8 rounded-3xl bg-slate-950/50 border border-white/5 text-center overflow-hidden group">
                    <div class="absolute inset-0 bg-linear-to-br from-primary/5 to-transparent"></div>

                    <%= if @generated_number do %>
                      <div class="relative z-10 space-y-6">
                        <div class="font-mono font-black text-white tracking-widest text-4xl sm:text-5xl drop-shadow-[0_0_20px_rgba(0,255,163,0.3)]">
                          {@generated_number.display}
                        </div>

                        <%= if @availability == :available do %>
                          <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[10px] font-bold uppercase tracking-widest text-emerald-400">
                            <.icon name="sparkles" class="size-3" /> New Identity Available
                          </div>
                        <% end %>

                        <div class="flex flex-wrap items-center justify-center gap-4">
                          <button
                            type="button"
                            phx-click="copied"
                            data-number={@generated_number.e164}
                            id="copy-generated-btn"
                            class={[
                              "inline-flex items-center gap-3 px-8 py-3 rounded-2xl text-xs font-bold uppercase tracking-widest transition-all",
                              if(@copied,
                                do: "bg-emerald-500 text-white shadow-lg shadow-emerald-500/20",
                                else: "bg-white/5 text-white hover:bg-white/10 border border-white/10"
                              )
                            ]}
                          >
                            <%= if @copied do %>
                              <.icon name="check_circle" class="size-5" /> Copied
                            <% else %>
                              <.icon name="clipboard" class="size-5" /> Copy Number
                            <% end %>
                          </button>

                          <button
                            type="button"
                            id="regen-btn"
                            class={[
                              "inline-flex items-center gap-3 px-8 py-3 rounded-2xl text-xs font-bold uppercase tracking-widest transition-all",
                              "bg-white/5 text-white hover:bg-white/10 border border-white/10",
                              !@selected_country &&
                                "opacity-20 cursor-not-allowed grayscale pointer-events-none"
                            ]}
                            title="Regenerate"
                            disabled={is_nil(@selected_country)}
                          >
                            <.icon
                              name="refresh_cw"
                              class={["size-5 text-primary", @generating && "animate-spin"]}
                            />
                            {if @generating, do: "Generating...", else: "Refresh"}
                          </button>
                        </div>
                      </div>
                    <% else %>
                      <div class="relative z-10 py-6 text-slate-600 font-bold uppercase tracking-widest text-xs">
                        {if @generating, do: "Generating...", else: "Select country to generate"}
                      </div>
                    <% end %>
                  </div>
                </div>
              <% else %>
                <%!-- Manual Entry Layout --%>
                <div
                  class="space-y-8 animate-in"
                  phx-hook="PhoneGenerator"
                  id="manual-hook"
                  data-iso={@selected_iso}
                >
                  <div class="space-y-4">
                    <label class="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500 ml-1">
                      Enter Secret Number
                    </label>
                    <div class="relative">
                      <input
                        type="tel"
                        id="manual-number-input"
                        value={@manual_number}
                        placeholder="Enter phone number..."
                        class={[
                          "glass-input w-full font-mono text-xl text-center pl-12",
                          @manual_error && "border-red-500/50"
                        ]}
                      />
                      <div class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500">
                        <.icon name="phone" class="size-5" />
                      </div>

                      <%= if @manual_error do %>
                        <div class="mt-2 text-[10px] font-bold uppercase tracking-wider text-red-500 animate-in">
                          <.icon name="alert-circle" class="size-3 inline mr-1" /> {@manual_error}
                        </div>
                      <% end %>
                    </div>
                  </div>

                  <%= if @availability != :idle do %>
                    <div class={[
                      "p-6 rounded-2xl border animate-in",
                      if(@availability == :available,
                        do: "bg-emerald-500/5 border-emerald-500/20",
                        else: "bg-primary/5 border-primary/20"
                      )
                    ]}>
                      <div class="flex items-center gap-3">
                        <%= if @availability == :available do %>
                          <.icon name="sparkles" class="size-5 text-emerald-500" />
                          <div class="space-y-1">
                            <h4 class="text-emerald-500 font-bold text-sm">
                              New Identity Detected
                            </h4>
                            <p class="text-xs text-slate-400">
                              Choose a tier to establish this channel.
                            </p>
                          </div>
                        <% else %>
                          <.icon name="shield_check" class="size-5 text-primary" />
                          <div class="space-y-1">
                            <h4 class="text-primary font-bold text-sm">Existing Channel Linked</h4>
                            <div
                              :if={@room_details}
                              class="text-xs text-slate-400 flex items-center gap-2"
                            >
                              <span class="uppercase tracking-widest">
                                {@room_details.tier} Tier
                              </span>
                              <span class="size-1 rounded-full bg-slate-700"></span>
                              <span>
                                <%= if @room_details.ttl_expires_at do %>
                                  Expires {Calendar.strftime(
                                    @room_details.ttl_expires_at,
                                    "%b %d, %Y"
                                  )}
                                <% else %>
                                  Permanent Identity
                                <% end %>
                              </span>
                            </div>
                          </div>
                        <% end %>
                      </div>
                    </div>
                  <% end %>
                </div>
              <% end %>

              <%!-- Promotion / Tier Selection --%>
              <%= if (@entry_mode == :manual and @availability == :available and @monetization_enabled) or
                     (@entry_mode == :generate and not is_nil(@generated_number) and @availability == :available and @monetization_enabled) do %>
                <div class="glass-card p-6 space-y-6 border-emerald-500/20 shadow-emerald-500/5 animate-in">
                  <h3 class="text-xs font-bold uppercase tracking-widest text-emerald-500">
                    Tier Selection
                  </h3>
                  <div class="space-y-3">
                    <button
                      phx-click="select_tier"
                      phx-value-tier="free"
                      class={[
                        "w-full p-4 rounded-xl border text-left transition-all",
                        if(@selected_tier == "free",
                          do: "bg-white/10 border-white/20 ring-2 ring-white/20",
                          else: "bg-white/5 border-white/5 hover:border-white/20"
                        )
                      ]}
                    >
                      <div class="flex justify-between items-center mb-1">
                        <span class="font-bold text-white text-sm">Free Tier</span>
                        <span class="text-[10px] font-black uppercase text-slate-500">Default</span>
                      </div>
                      <p class="text-[10px] text-slate-400 uppercase tracking-widest">
                        Expires in {@free_ttl_days} Days
                      </p>
                    </button>

                    <button
                      phx-click="select_tier"
                      phx-value-tier="paid"
                      class={[
                        "w-full p-4 rounded-xl border text-left transition-all group",
                        if(@selected_tier == "paid",
                          do: "bg-primary/10 border-primary/20 ring-2 ring-primary/20",
                          else: "bg-white/5 border-white/5 hover:border-primary/20"
                        )
                      ]}
                    >
                      <div class="flex justify-between items-center mb-1">
                        <span class="font-bold text-primary text-sm">Dedicated Tier</span>
                        <span class="text-[10px] font-black uppercase text-primary/60">
                          Best Value
                        </span>
                      </div>
                      <p class="text-[10px] text-slate-400 uppercase tracking-widest">
                        1 Year &mdash; {format_price(@price_cents, @currency)}
                      </p>
                    </button>
                  </div>
                </div>
              <% end %>

              <%!-- Action Button area --%>
              <div class="space-y-4">
                <%!-- 
                  Logic: 
                  1. If number is TAKEN (existing), show the standard "Enter Chat" button.
                  2. If number is AVAILABLE (new):
                     - If no tier selected: Show disabled button.
                     - If FREE selected: Show "Enter Chat (Free)" button.
                     - If PAID selected: The "Pay & Secure" button below becomes the primary action.
                --%>

                <%= if @availability == :taken or
                       (@availability == :available and (not @monetization_enabled or @selected_tier == "free")) do %>
                  <button
                    id="enter-chat-btn"
                    type="button"
                    phx-hook="ChannelHandoff"
                    data-phone={
                      case {@entry_mode, @generated_number} do
                        {:generate, %{e164: e164}} -> e164
                        {:manual, _} when @manual_number != "" -> @manual_number
                        _ -> ""
                      end
                    }
                    class={[
                      "w-full py-5 rounded-2xl flex items-center justify-center gap-3 font-bold uppercase tracking-widest transition-all",
                      "bg-white text-slate-950 shadow-xl hover:scale-[1.02] hover:shadow-white/10"
                    ]}
                  >
                    Enter Chat Workspace
                    <%= if @monetization_enabled and @availability == :available do %>
                      (Free)
                    <% end %>
                    <.icon name="shield_check" class="size-5" />
                  </button>
                  <p
                    :if={@monetization_enabled and @availability == :available}
                    class="mt-3 text-[10px] text-slate-500 text-center uppercase tracking-widest"
                  >
                    Your identity expires in {@free_ttl_days} days
                  </p>
                <% end %>

                <%= if @availability == :available and @selected_tier == "paid" do %>
                  <button
                    id="checkout-btn"
                    phx-hook="PaymentInitiator"
                    disabled={@payment_loading}
                    class={[
                      "w-full py-5 rounded-2xl flex items-center justify-center gap-3 bg-primary text-slate-950 font-black uppercase tracking-widest text-xs shadow-xl transition-all",
                      if(@payment_loading,
                        do: "opacity-50 cursor-not-allowed",
                        else: "hover:scale-[1.02] hover:shadow-primary/40 shadow-primary/20"
                      )
                    ]}
                  >
                    <%= if @payment_loading do %>
                      <.icon name="refresh_cw" class="size-5 animate-spin" /> Initializing...
                    <% else %>
                      Pay & Secure Identity <.icon name="credit_card" class="size-5 text-slate-950" />
                    <% end %>
                  </button>
                  <p class="mt-3 text-[10px] text-slate-400 text-center uppercase tracking-widest">
                    Secures identity for 1 Year &bull; {format_price(@price_cents, @currency)}
                  </p>
                <% end %>

                <%= if @monetization_enabled and @availability == :available and is_nil(@selected_tier) do %>
                  <div class="w-full py-5 rounded-2xl bg-white/5 border border-white/10 text-slate-500 flex flex-col items-center justify-center gap-1 font-bold uppercase tracking-widest cursor-not-allowed group">
                    <span class="text-xs flex items-center gap-2">
                      Select Tier to Continue <.icon name="hero-lock-closed" class="size-4" />
                    </span>
                    <span class="text-[8px] text-slate-600 lowercase tracking-normal font-medium">
                      Choose Free or Paid above
                    </span>
                  </div>
                <% end %>

                <%!-- Initial state (no number yet) --%>
                <%= if @availability == :idle do %>
                  <div class="w-full py-5 rounded-2xl bg-white/5 border border-white/5 text-slate-600 flex items-center justify-center gap-3 font-bold uppercase tracking-widest cursor-not-allowed italic">
                    {if @entry_mode == :generate,
                      do: "Generate identity first",
                      else: "Enter number first"}
                  </div>
                <% end %>
              </div>
            </div>
          </div>

          <%!-- Instructions --%>
          <div class="space-y-8 pt-10">
            <h3 class="text-[10px] font-black uppercase tracking-[0.4em] text-slate-600 text-center mb-6">
              Protocol Onboarding & Guidance
            </h3>

            <div class="space-y-6">
              <div
                :for={
                  {step, icon, title, text, guidance} <- [
                    {1, "hero-user-plus", "1. Save in Phonebook",
                     "Add this number to your partner's actual contact list.",
                     "This camouflages the channel as a regular contact in your native address book."},
                    {2, "hero-share", "2. Share Channel ID", "Give this number to your partner.",
                     "Communicate this number securely. Your PIN is personal and stays on your device."},
                    {3, "hero-shield-check", "3. Establishment",
                     "Once both parties connect, a zero-trace link is armed.",
                     "All messages are locally encrypted and wiped atomically upon reply."}
                  ]
                }
                class="glass-card p-8 flex flex-col md:flex-row gap-8 items-start relative group hover:border-white/10 transition-all duration-500"
              >
                <div class="size-16 rounded-2xl bg-white/5 flex items-center justify-center text-primary border border-white/5 shadow-inner group-hover:scale-110 transition-transform duration-500">
                  <.icon name={icon} class="size-8" />
                </div>
                <div class="flex-1 space-y-4">
                  <div class="space-y-1">
                    <h4 class="font-bold text-white text-xl font-display tracking-tight">{title}</h4>
                    <p class="text-slate-400 leading-relaxed font-medium">{text}</p>
                  </div>
                  <div class="p-4 rounded-xl bg-slate-900/50 border border-white/5 text-xs text-slate-500 leading-relaxed italic">
                    {guidance}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Layouts.app>
    """
  end
end
