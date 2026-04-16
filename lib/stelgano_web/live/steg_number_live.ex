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

  @impl true
  def mount(_params, _session, socket) do
    socket =
      socket
      |> assign(:page_title, "Steg Number — sTELgano")
      |> assign(:generated_number, nil)
      |> assign(:copied, false)
      |> assign(:availability, :idle)

    {:ok, socket}
  end

  @impl true
  def handle_event("number_generated", %{"number" => number, "display" => display}, socket) do
    socket =
      socket
      |> assign(:generated_number, %{e164: number, display: display})
      |> assign(:copied, false)
      |> assign(:availability, :idle)

    {:noreply, socket}
  end

  @impl true
  def handle_event("check_availability", %{"room_hash" => room_hash}, socket) do
    availability = if Stelgano.Rooms.room_exists?(room_hash), do: :taken, else: :available
    {:noreply, assign(socket, :availability, availability)}
  end

  @impl true
  def handle_event("copied", _params, socket) do
    socket = assign(socket, :copied, true)
    Process.send_after(self(), :clear_copied, 2_000)
    {:noreply, socket}
  end

  @impl true
  def handle_info(:clear_copied, socket) do
    {:noreply, assign(socket, :copied, false)}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash}>
      <div class="max-w-4xl mx-auto space-y-16 animate-in">
        <%!-- Hero Header --%>
        <div class="text-center space-y-8 pt-12">
          <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-bold uppercase tracking-[0.2em] animate-in stagger-1 shadow-[0_0_20px_rgba(0,255,163,0.1)]">
            <.icon name="hero-sparkles-mini" class="size-3" /> Artifact Generation Engine
          </div>

          <h1 class="text-6xl sm:text-8xl md:text-9xl font-extrabold tracking-tighter text-white font-display animate-in stagger-2">
            Secret <span class="text-gradient">Identity.</span>
          </h1>

          <p class="text-slate-400 text-lg sm:text-2xl font-medium leading-tight max-w-2xl mx-auto animate-in stagger-3">
            Your identity artifact is the derivation seed for your channel. Use it to establish an invisible link within your native contact layer.
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
                      Region Vector
                    </label>
                    <span class="text-[10px] font-mono text-primary font-bold">
                      SHA-256 SALT ACTIVE
                    </span>
                  </div>
                  <div class="relative group">
                    <select
                      id="country-select"
                      class="glass-input w-full appearance-none pr-12 cursor-pointer bg-slate-950/50 text-base font-bold tracking-wide"
                    >
                      <option value="">Global Anonymity Matrix (Random)</option>
                    </select>
                    <div class="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-slate-500 group-hover:text-primary transition-colors">
                      <.icon name="hero-chevron-down-mini" class="size-5" />
                    </div>
                  </div>
                </div>

                <%!-- High-Impact Number Display --%>
                <div class="relative py-12 px-8 rounded-3xl bg-slate-950/50 border border-white/5 shadow-inner overflow-hidden group">
                  <div class="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700">
                  </div>

                  <%= if @generated_number do %>
                    <div class="relative z-10 text-center space-y-6">
                      <div class="text-[10px] font-bold uppercase tracking-[0.4em] text-primary/60">
                        Assigned Number
                      </div>
                      <div
                        id="generated-display"
                        class="text-4xl sm:text-5xl md:text-6xl font-mono font-black text-white tracking-[0.1em] drop-shadow-[0_0_20px_rgba(0,255,163,0.3)]"
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
                              do: "bg-emerald-500 text-slate-950",
                              else: "bg-white/5 text-white hover:bg-white/10 border border-white/10"
                            )
                          ]}
                        >
                          <%= if @copied do %>
                            <.icon name="hero-check-circle-mini" class="size-4" /> Copied to Clipboard
                          <% else %>
                            <.icon name="hero-clipboard-document-mini" class="size-4" />
                            Copy Key Artifact
                          <% end %>
                        </button>

                        <div
                          id="availability-check"
                          class="flex items-center gap-2 px-4 py-2 rounded-full bg-slate-900 border border-white/5 animate-in"
                        >
                          <%= cond do %>
                            <% @availability == :available -> %>
                              <div class="size-1.5 rounded-full bg-emerald-500"></div>
                              <span class="text-[9px] font-black uppercase tracking-widest text-emerald-500">
                                Vector Available
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
                    <div class="relative z-10 py-10 text-center">
                      <div class="size-20 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mx-auto mb-6">
                        <.icon name="hero-phone-mini" class="size-10 text-slate-700" />
                      </div>
                      <p class="text-slate-500 font-bold uppercase tracking-[0.2em] text-sm">
                        Vector Pending Initialization
                      </p>
                    </div>
                  <% end %>
                </div>

                <button
                  type="button"
                  id="generate-btn"
                  phx-click="generate"
                  class="btn-primary w-full py-5 text-lg group shadow-[0_20px_40px_-10px_rgba(0,255,163,0.3)]"
                >
                  <span class="relative z-10 flex items-center gap-3">
                    {if(@generated_number, do: "Re-roll Identity", else: "Initialize Artifact")}
                    <.icon
                      name="hero-arrow-path-mini"
                      class="size-6 group-hover:rotate-180 transition-transform duration-700"
                    />
                  </span>
                </button>
              </div>
            </.premium_card>
          </div>

          <div class="lg:col-span-2 space-y-8 animate-in stagger-4">
            <div class="p-8 rounded-3xl bg-danger/5 border border-danger/20 space-y-4">
              <div class="flex items-center gap-3 text-danger">
                <.icon name="hero-exclamation-triangle-mini" class="size-6" />
                <h3 class="font-bold uppercase tracking-widest text-sm">Persistence Warning</h3>
              </div>
              <p class="text-slate-400 text-sm leading-relaxed font-medium">
                This identity is transient. Once you close this session, the linkage data is purged from memory.
                <span class="text-white">
                  Coordinate with your partner to save this exact value immediately.
                </span>
              </p>
            </div>

            <div class="space-y-4 pt-4">
              <label class="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500 ml-1">
                Establish Channel
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
                Enter Workspace <.icon name="hero-shield-check-mini" class="size-5" />
              </.link>
            </div>
          </div>
        </div>

        <%!-- Step Guide --%>
        <div class="space-y-8 pb-20 animate-in stagger-5">
          <div class="flex items-center gap-4">
            <div class="h-px flex-1 bg-white/5"></div>
            <h2 class="text-[10px] font-bold uppercase tracking-[0.4em] text-slate-500">
              Integration Sequence
            </h2>
            <div class="h-px flex-1 bg-white/5"></div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div
              :for={
                {step, title, desc} <- [
                  {1, "Identity Storage",
                   "Append this number to your partner's profile as a secondary phone entry."},
                  {2, "Cross-Vector Sync",
                   "Verify both devices harbor the exact same sequence for successful link."},
                  {3, "Workspace Entry",
                   "Use the saved number along with your private PIN to initialize the channel."}
                ]
              }
              class="glass-card p-8 group relative overflow-hidden transition-all hover:border-primary/30"
            >
              <div class="absolute -right-4 -bottom-4 text-7xl font-black text-white/[0.03] group-hover:text-primary/[0.05] transition-colors italic">
                {step}
              </div>
              <h4 class="text-white font-bold mb-3 flex items-center gap-2">
                <span class="size-6 rounded-lg bg-primary/10 text-primary flex items-center justify-center text-xs font-mono">
                  {step}
                </span>
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
