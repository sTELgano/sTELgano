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

  @impl Phoenix.LiveView
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

  @impl Phoenix.LiveView
  def handle_info(:refresh, socket) do
    schedule_refresh()

    socket =
      socket
      |> assign(:metrics, Rooms.aggregate_metrics())
      |> assign(:last_updated, DateTime.utc_now())

    {:noreply, socket}
  end

  @impl Phoenix.LiveView
  def handle_event("refresh_now", _params, socket) do
    socket =
      socket
      |> assign(:metrics, Rooms.aggregate_metrics())
      |> assign(:last_updated, DateTime.utc_now())

    {:noreply, socket}
  end

  @impl Phoenix.LiveView
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash}>
      <div class="max-w-4xl mx-auto space-y-12 py-12 animate-in lg:pb-40">
        <%!-- Header --%>
        <div class="flex flex-col md:flex-row items-center justify-between gap-8 pb-8 border-b border-white/5">
          <div class="text-center md:text-left space-y-4">
            <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-bold uppercase tracking-[0.3em] mb-2 shadow-[0_0_20px_var(--color-primary-glow)]">
              <.icon name="terminal" class="size-3" /> System Status
            </div>
            <h1 class="text-5xl sm:text-6xl font-extrabold text-white font-display tracking-tighter uppercase leading-none">
              Admin <span class="text-gradient">Dashboard.</span>
            </h1>
            <p class="text-[10px] font-black text-slate-500 uppercase tracking-[0.5em] leading-relaxed">
              Total Stats Only · No Private Data ·
              <span class="text-primary italic">
                Updated {Calendar.strftime(@last_updated, "%H:%M:%S UTC")}
              </span>
            </p>
          </div>

          <button
            phx-click="refresh_now"
            class="btn-primary py-4 px-10 text-sm flex items-center gap-3 group"
          >
            <.icon
              name="refresh_cw"
              class="size-5 group-hover:rotate-180 transition-transform duration-700"
            /> Refresh Stats
          </button>
        </div>

        <%!-- Metric cards --%>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
          <.metric_panel
            label="Active Chats"
            value={@metrics.active_rooms}
            note="Currently open"
            icon="radio"
            trend="active"
          />
          <.metric_panel
            label="New Chats Today"
            value={@metrics.rooms_today}
            note="Last 24 hours"
            icon="plus_circle"
          />
          <.metric_panel
            label="Messages Sent Today"
            value={@metrics.messages_today}
            note="Encrypted messages"
            icon="messages_square"
          />
          <.metric_panel
            label="Total Chats"
            value={@metrics.rooms_last_90_days}
            note="Past 3 months"
            icon="calendar"
          />
        </div>

        <%!-- Operational Guidelines --%>
        <div class="glass-card p-10 space-y-8 border-white/5 bg-slate-950/40 relative overflow-hidden group">
          <div class="absolute -right-20 -bottom-20 size-64 bg-primary/5 rounded-full blur-3xl group-hover:bg-primary/10 transition-colors">
          </div>

          <div class="flex items-center gap-3 text-slate-300 relative z-10">
            <.icon name="info" class="size-5 text-primary" />
            <h4 class="text-[10px] font-black uppercase tracking-[0.4em]">Admin Information</h4>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6 relative z-10">
            <div
              :for={
                note <- [
                  "All values are counts derived from server data.",
                  "No private chat contents, keys, or IDs are shown.",
                  "Active rooms represent open chat sessions.",
                  "Messages today counts encrypted items sent in last 24h.",
                  "Stats are kept for 90 days then removed.",
                  "Dashboard updates automatically every 30 seconds."
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
  attr :trend, :string, default: nil

  defp metric_panel(assigns) do
    ~H"""
    <div class="glass-card-premium p-10 space-y-8 group hover:border-primary/50 transition-all duration-500">
      <div class="flex items-center justify-between">
        <div class="size-14 rounded-2xl bg-primary/5 flex items-center justify-center border border-primary/20 group-hover:border-primary/40 group-hover:bg-primary/10 transition-all shadow-inner">
          <.icon
            name={@icon}
            class="size-7 text-primary/40 group-hover:text-primary transition-colors"
          />
        </div>
        <div class="flex flex-col items-end gap-1">
          <span class="text-[10px] font-black uppercase tracking-widest text-slate-600">
            {@note}
          </span>
          <div
            :if={assigns[:trend] == "active"}
            class="size-2 rounded-full bg-primary animate-pulse shadow-[0_0_8px_var(--color-primary)]"
          >
          </div>
        </div>
      </div>
      <div class="space-y-3">
        <div class="text-5xl sm:text-6xl font-mono font-black text-white group-hover:scale-110 transition-transform origin-left tracking-tighter drop-shadow-[0_0_15px_rgba(255,255,255,0.1)]">
          {@value}
        </div>
        <div class="text-[11px] font-black uppercase tracking-[0.4em] text-slate-500 group-hover:text-slate-400 transition-colors">
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
