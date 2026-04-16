# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.AdminDashboardLive do
  @moduledoc """
  Admin-only LiveView for server-side aggregate metrics.

  ## Access control

  Protected by `StelganoWeb.Plugs.AdminAuth` (HTTP Basic Auth) in the router.
  Credentials are set via environment variables:
    - `ADMIN_USERNAME` (default: "admin")
    - `ADMIN_PASSWORD` (required in production — no default)

  ## What is shown

  Only aggregate, non-identifying server-side metrics:
  - Active rooms count (real-time DB query)
  - Messages sent today / this week / last 30 days
  - Rooms created today / this week / last 30 days
  - Current connected WebSocket count (via Telemetry)

  No room contents. No hashes. No user data of any kind.

  ## Auto-refresh

  Metrics refresh every 30 seconds via a `Process.send_after/3` timer.
  """

  use StelganoWeb, :live_view

  alias Stelgano.Rooms

  @refresh_ms 30_000

  @impl true
  def mount(_params, _session, socket) do
    if connected?(socket) do
      schedule_refresh()
    end

    socket =
      socket
      |> assign(:page_title, "Admin — sTELgano")
      |> assign(:metrics, Rooms.aggregate_metrics())
      |> assign(:last_updated, DateTime.utc_now())

    {:ok, socket}
  end

  @impl true
  def handle_info(:refresh, socket) do
    schedule_refresh()

    socket =
      socket
      |> assign(:metrics, Rooms.aggregate_metrics())
      |> assign(:last_updated, DateTime.utc_now())

    {:noreply, socket}
  end

  @impl true
  def handle_event("refresh_now", _params, socket) do
    socket =
      socket
      |> assign(:metrics, Rooms.aggregate_metrics())
      |> assign(:last_updated, DateTime.utc_now())

    {:noreply, socket}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash}>
      <div class="max-w-4xl mx-auto space-y-12 py-12 animate-in lg:pb-40">
        <%!-- Header --%>
        <div class="flex flex-col sm:flex-row items-center justify-between gap-6">
          <div class="text-center sm:text-left space-y-2">
            <div class="inline-flex items-center gap-2 px-2 py-0.5 rounded-full bg-primary/10 border border-primary/20 text-primary text-[9px] font-bold uppercase tracking-[0.2em] mb-2 shadow-[0_0_15px_rgba(0,255,163,0.1)]">
              <.icon name="hero-command-line-mini" class="size-3" /> System Oversight Matrix
            </div>
            <h1 class="text-4xl sm:text-5xl font-extrabold text-white font-display tracking-tight uppercase">
              Admin <span class="text-gradient">Dashboard.</span>
            </h1>
            <p class="text-xs font-medium text-slate-500 uppercase tracking-widest leading-relaxed">
              Aggregate Metrics Only · No Handshake Data ·
              <span class="text-slate-400">
                Synced {Calendar.strftime(@last_updated, "%H:%M:%S UTC")}
              </span>
            </p>
          </div>

          <button
            phx-click="refresh_now"
            class="btn-secondary py-3 px-8 text-xs flex items-center gap-2 group border-white/10"
          >
            <.icon
              name="hero-arrow-path-mini"
              class="size-4 group-hover:rotate-180 transition-transform duration-700"
            /> Synchronize Now
          </button>
        </div>

        <%!-- Metric cards --%>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-6">
          <.metric_panel
            label="Active rooms"
            value={@metrics.active_rooms}
            note="Live handover"
            icon="hero-radio-mini"
          />
          <.metric_panel
            label="Rooms today"
            value={@metrics.rooms_today}
            note="Last 24h"
            icon="hero-plus-circle-mini"
          />
          <.metric_panel
            label="Messages"
            value={@metrics.messages_today}
            note="Encrypted flow"
            icon="hero-chat-bubble-left-right-mini"
          />
          <.metric_panel
            label="90-Day Range"
            value={@metrics.rooms_last_90_days}
            note="Historical load"
            icon="hero-calendar-days-mini"
          />
        </div>

        <%!-- Operational Guidelines --%>
        <div class="glass-card p-10 space-y-8 border-white/5 bg-slate-950/40 relative overflow-hidden group">
          <div class="absolute -right-20 -bottom-20 size-64 bg-primary/5 rounded-full blur-3xl group-hover:bg-primary/10 transition-colors">
          </div>

          <div class="flex items-center gap-3 text-slate-300 relative z-10">
            <.icon name="hero-information-circle-mini" class="size-5 text-primary" />
            <h4 class="text-[10px] font-black uppercase tracking-[0.4em]">Operational Disclosure</h4>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6 relative z-10">
            <div
              :for={
                note <- [
                  "All values are counts derived from server operational data.",
                  "No individual room contents, hashes, or user identifiers are shown.",
                  "Active rooms represent nodes with verified persistence.",
                  "Messages today counts rows inserted in last 24h interval.",
                  "Metrics are retained for 90 days then discarded.",
                  "Real-time sync occurs automatically every 30 seconds."
                ]
              }
              class="flex items-start gap-4 group/item"
            >
              <div class="size-1 rounded-full bg-primary/40 mt-1.5 group-hover/item:scale-150 transition-transform">
              </div>
              <span class="text-xs text-slate-500 font-medium leading-relaxed group-hover/item:text-slate-300 transition-colors">
                {note}
              </span>
            </div>
          </div>
        </div>
      </div>
    </Layouts.app>
    """
  end

  # ---------------------------------------------------------------------------
  # Components
  # ---------------------------------------------------------------------------

  attr :label, :string, required: true
  attr :value, :integer, required: true
  attr :note, :string, required: true
  attr :icon, :string, required: true

  defp metric_panel(assigns) do
    ~H"""
    <div class="glass-card p-8 sm:p-10 space-y-8 group hover:border-primary/30 transition-all duration-500 bg-slate-950/20 backdrop-blur-md">
      <div class="flex items-center justify-between">
        <div class="size-12 rounded-2xl bg-white/5 flex items-center justify-center border border-white/10 group-hover:bg-primary/10 group-hover:border-primary/20 transition-all shadow-inner">
          <.icon
            name={@icon}
            class="size-6 text-slate-500 group-hover:text-primary transition-colors"
          />
        </div>
        <span class="text-[9px] font-black uppercase tracking-widest text-slate-600 group-hover:text-primary/60 transition-colors">
          {@note}
        </span>
      </div>
      <div class="space-y-2">
        <div class="text-4xl sm:text-5xl font-mono font-black text-white group-hover:scale-105 transition-transform origin-left tracking-tighter">
          {@value}
        </div>
        <div class="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500">
          {@label}
        </div>
      </div>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp schedule_refresh do
    Process.send_after(self(), :refresh, @refresh_ms)
  end
end
