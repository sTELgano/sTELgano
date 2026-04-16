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

    {:ok, socket}
  end

  @impl true
  def handle_event("number_generated", %{"number" => number, "display" => display}, socket) do
    socket =
      socket
      |> assign(:generated_number, %{e164: number, display: display})
      |> assign(:copied, false)

    {:noreply, socket}
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
      <div class="min-h-screen px-4 py-12 max-w-lg mx-auto">
        <%!-- Header --%>
        <div class="mb-10">
          <.link
            navigate={~p"/"}
            class="text-sm hover:underline mb-6 inline-block"
            style="color: var(--text-muted);"
          >
            ← Back
          </.link>
          <h1 class="text-2xl font-medium mt-4 mb-2" style="color: var(--text-primary);">
            Steg number generator
          </h1>
          <p class="text-sm" style="color: var(--text-secondary);">
            Generate a random phone number to use as your shared channel key.
            It'll live in your contacts app, hidden in plain sight.
          </p>
        </div>

        <%!-- Generator card --%>
        <div
          id="generator-card"
          phx-hook="PhoneGenerator"
          class="rounded-2xl p-6 mb-6"
          style="background: var(--bg-surface); border: 1px solid var(--border);"
        >
          <%!-- Country selector --%>
          <div class="mb-4">
            <label
              for="country-select"
              class="block text-xs uppercase tracking-wider mb-2"
              style="color: var(--text-muted);"
            >
              Country
            </label>
            <select
              id="country-select"
              class="w-full px-4 py-3 rounded-lg text-base focus:outline-none focus:ring-2 transition-colors appearance-none"
              style="background: var(--bg-raised); border: 1px solid var(--border);
                     color: var(--text-primary); --tw-ring-color: var(--accent);"
            >
              <option value="">Any country (random)</option>
            </select>
          </div>

          <%= if @generated_number do %>
            <%!-- Display generated number --%>
            <div class="mb-4">
              <p class="text-xs uppercase tracking-wider mb-2" style="color: var(--text-muted);">
                Your steg number
              </p>
              <div class="flex items-center gap-3">
                <code
                  id="generated-display"
                  class="text-2xl font-mono flex-1"
                  style="color: var(--text-primary); letter-spacing: 0.02em;"
                >
                  {@generated_number.display}
                </code>
                <button
                  id="copy-btn"
                  type="button"
                  phx-click="copied"
                  class="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium
                         transition-all duration-150 hover:opacity-80 active:scale-95"
                  style="background: var(--bg-raised); color: var(--text-secondary);
                         border: 1px solid var(--border);"
                  data-number={@generated_number.e164}
                >
                  <%= if @copied do %>
                    <span class="text-accent-icon"><.icon name="hero-check" class="w-4 h-4" /></span>
                    <span style="color: var(--accent);">Copied</span>
                  <% else %>
                    <.icon name="hero-clipboard" class="w-4 h-4" /> Copy
                  <% end %>
                </button>
              </div>
              <p class="text-xs mt-1 font-mono" style="color: var(--text-muted);">
                {@generated_number.e164}
              </p>
            </div>
          <% else %>
            <div class="text-center py-6" style="color: var(--text-muted);">
              <.icon name="hero-phone" class="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p class="text-sm">Select a country and click generate</p>
            </div>
          <% end %>

          <button
            id="generate-btn"
            type="button"
            class="w-full py-3 rounded-xl font-medium text-sm transition-all duration-150
                   hover:opacity-90 active:scale-95 mt-2"
            style="background: var(--accent); color: var(--accent-fg);"
          >
            {if @generated_number, do: "Generate another", else: "Generate"}
          </button>
        </div>

        <%= if @generated_number do %>
          <%!-- Save warning + Open Channel --%>
          <div
            class="rounded-2xl p-6 mb-6"
            style="background: var(--bg-surface); border: 1px solid var(--border);"
          >
            <div class="flex gap-3 mb-4">
              <span style="color: var(--warning); flex-shrink: 0; margin-top: 0.125rem;">
                <.icon name="hero-exclamation-triangle" class="w-5 h-5" />
              </span>
              <p class="text-sm" style="color: var(--text-secondary);">
                <strong style="color: var(--text-primary);">
                  Save this number in your contacts before proceeding.
                </strong>
                Once you leave this page, the number cannot be recovered.
                Both you and the other person must save the same number.
              </p>
            </div>

            <.link
              navigate={~p"/chat?phone=#{@generated_number.e164}"}
              id="open-channel-btn"
              class="block w-full text-center py-4 rounded-xl font-medium text-sm
                     hover:opacity-90 active:scale-95 transition-all duration-150"
              style="background: var(--accent); color: var(--accent-fg);"
            >
              Open channel with this number
            </.link>
          </div>
        <% end %>

        <%!-- Setup guide --%>
        <div
          class="rounded-2xl p-6 mb-8"
          style="background: var(--bg-surface); border: 1px solid var(--border);"
        >
          <h2 class="text-sm font-medium mb-4" style="color: var(--text-primary);">
            How to save it — hidden in plain sight
          </h2>

          <ol class="space-y-4">
            <li class="flex gap-3">
              <span
                class="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium"
                style="background: var(--accent-soft); color: var(--accent);"
              >
                1
              </span>
              <p class="text-sm pt-0.5" style="color: var(--text-secondary);">
                Open your contacts app and find the other person's contact.
              </p>
            </li>
            <li class="flex gap-3">
              <span
                class="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium"
                style="background: var(--accent-soft); color: var(--accent);"
              >
                2
              </span>
              <p class="text-sm pt-0.5" style="color: var(--text-secondary);">
                Add the steg number as an additional phone number entry on their contact.
                That number is your key — it looks like every other number in the app.
              </p>
            </li>
            <li class="flex gap-3">
              <span
                class="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium"
                style="background: var(--accent-soft); color: var(--accent);"
              >
                3
              </span>
              <p class="text-sm pt-0.5" style="color: var(--text-secondary);">
                Both of you do this — each person saves it in the other's contact.
                Now the key lives where no one would think to look.
              </p>
            </li>
          </ol>
        </div>
      </div>
    </Layouts.app>
    """
  end
end
