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
      <div class="max-w-3xl mx-auto px-4 py-12">
        <div class="flex items-center justify-between mb-8">
          <div>
            <h1 class="text-xl font-medium" style="color: var(--text-primary);">
              Admin dashboard
            </h1>
            <p class="text-xs mt-1" style="color: var(--text-muted);">
              Server-side aggregates only. No user data.
              Last updated: {Calendar.strftime(@last_updated, "%H:%M:%S UTC")}
            </p>
          </div>
          <button
            phx-click="refresh_now"
            class="px-4 py-2 rounded-lg text-sm font-medium transition-opacity hover:opacity-70"
            style="background: var(--bg-raised); color: var(--text-secondary);
                   border: 1px solid var(--border);"
          >
            Refresh
          </button>
        </div>

        <%!-- Metric cards --%>
        <div class="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
          <.metric_card
            label="Active rooms"
            value={@metrics.active_rooms}
            note="currently live"
          />
          <.metric_card
            label="Rooms today"
            value={@metrics.rooms_today}
            note="created in last 24h"
          />
          <.metric_card
            label="Messages today"
            value={@metrics.messages_today}
            note="sent in last 24h"
          />
          <.metric_card
            label="Rooms (90 days)"
            value={@metrics.rooms_last_90_days}
            note="created in last 90 days"
          />
        </div>

        <%!-- Notes --%>
        <div
          class="rounded-xl p-4 text-xs"
          style="background: var(--bg-raised); color: var(--text-muted);
                 border: 1px solid var(--border);"
        >
          <p class="font-medium mb-2" style="color: var(--text-secondary);">
            What these metrics are
          </p>
          <ul class="space-y-1">
            <li>• All values are counts derived from server operational data</li>
            <li>• No individual room contents, hashes, or user identifiers are shown</li>
            <li>• "Active rooms" = rooms with is_active = true</li>
            <li>• "Messages today" = rows inserted in messages table in the last 24h</li>
            <li>• Metrics are retained for 90 days then discarded</li>
          </ul>
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

  defp metric_card(assigns) do
    ~H"""
    <div
      class="rounded-xl p-5"
      style="background: var(--bg-surface); border: 1px solid var(--border);"
    >
      <p class="text-2xl font-medium mb-1" style="color: var(--text-primary);">
        {@value}
      </p>
      <p class="text-sm font-medium mb-0.5" style="color: var(--text-secondary);">
        {@label}
      </p>
      <p class="text-xs" style="color: var(--text-muted);">
        {@note}
      </p>
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
