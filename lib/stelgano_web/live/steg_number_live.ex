# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.StegNumberLive do
  @moduledoc """
  LiveView for the `/steg-number` page.

  Provides:
  - A generated steg number (via client-side JS hook using `crypto.getRandomValues`)
  - Copy-to-clipboard with 2-second confirmation
  - Custom number entry with availability check
  - The "hidden in plain sight" setup guide

  ## Passcode Test

  This page is publicly accessible and reveals nothing beyond its stated purpose.
  A casual observer learns only that it is a number generator.
  """

  use StelganoWeb, :live_view

  alias Stelgano.Rooms

  @impl true
  def mount(_params, _session, socket) do
    socket =
      socket
      |> assign(:page_title, "Steg Number — sTELgano")
      |> assign(:generated_number, nil)
      |> assign(:custom_number, "")
      |> assign(:custom_error, nil)
      |> assign(:availability_result, nil)
      |> assign(:checking_availability, false)
      |> assign(:show_guide, false)
      |> assign(:copied, false)

    {:ok, socket}
  end

  @impl true
  def handle_event("number_generated", %{"number" => number, "display" => display}, socket) do
    socket =
      socket
      |> assign(:generated_number, %{e164: number, display: display})
      |> assign(:copied, false)
      |> assign(:availability_result, nil)

    {:noreply, socket}
  end

  @impl true
  def handle_event("copied", _params, socket) do
    socket = assign(socket, :copied, true)
    Process.send_after(self(), :clear_copied, 2_000)
    {:noreply, socket}
  end

  @impl true
  def handle_event("custom_number_change", %{"value" => value}, socket) do
    socket =
      socket
      |> assign(:custom_number, value)
      |> assign(:custom_error, nil)
      |> assign(:availability_result, nil)

    {:noreply, socket}
  end

  @impl true
  def handle_event("check_availability", %{"room_hash" => room_hash}, socket) do
    socket = assign(socket, :checking_availability, true)

    available = !Rooms.room_exists?(room_hash)

    socket =
      socket
      |> assign(:checking_availability, false)
      |> assign(:availability_result, if(available, do: :available, else: :taken))

    {:noreply, socket}
  end

  @impl true
  def handle_event("proceed_to_chat", _params, socket) do
    {:noreply, push_navigate(socket, to: ~p"/chat")}
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
          <.link navigate={~p"/"} class="text-sm hover:underline mb-6 inline-block" style="color: var(--text-muted);">
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
                    <.icon name="hero-clipboard" class="w-4 h-4" />
                    Copy
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
              <p class="text-sm">Click generate to get a steg number</p>
            </div>
          <% end %>

          <button
            id="generate-btn"
            type="button"
            class="w-full py-3 rounded-xl font-medium text-sm transition-all duration-150
                   hover:opacity-90 active:scale-95 mt-2"
            style="background: var(--accent); color: var(--accent-fg);"
          >
            <%= if @generated_number, do: "Generate another", else: "Generate" %>
          </button>
        </div>

        <%!-- Custom number entry --%>
        <div
          class="rounded-2xl p-6 mb-6"
          style="background: var(--bg-surface); border: 1px solid var(--border);"
        >
          <h2 class="text-sm font-medium mb-3" style="color: var(--text-primary);">
            Have a number in mind?
          </h2>

          <div
            id="custom-number-form"
            phx-hook="CustomNumberCheck"
            class="space-y-3"
          >
            <input
              id="custom-number-input"
              type="tel"
              placeholder="+1 555 0100"
              value={@custom_number}
              class="w-full px-4 py-3 rounded-lg text-base focus:outline-none focus:ring-2 transition-colors"
              style="background: var(--bg-raised); border: 1px solid var(--border);
                     color: var(--text-primary); --tw-ring-color: var(--accent);"
            />

            <%= if @custom_error do %>
              <p class="text-xs" style="color: var(--danger);">{@custom_error}</p>
            <% end %>

            <%= if @availability_result do %>
              <div class={[
                "text-sm rounded-lg px-4 py-3",
              ]}>
                <%= if @availability_result == :available do %>
                  <span style="color: var(--accent);">
                    <.icon name="hero-check-circle" class="w-4 h-4 inline mr-1" />
                    This number is available.
                  </span>
                <% else %>
                  <span style="color: var(--warning);">
                    <.icon name="hero-exclamation-circle" class="w-4 h-4 inline mr-1" />
                    This number has an active room. Please choose another.
                  </span>
                <% end %>
              </div>
            <% end %>

            <button
              id="check-availability-btn"
              type="button"
              disabled={@checking_availability}
              class={[
                "w-full py-3 rounded-xl font-medium text-sm transition-all duration-150",
                if(@checking_availability, do: "opacity-60 cursor-not-allowed", else: "hover:opacity-90 active:scale-95")
              ]}
              style="background: var(--bg-raised); color: var(--text-secondary);
                     border: 1px solid var(--border);"
            >
              <%= if @checking_availability, do: "Checking…", else: "Check availability" %>
            </button>
          </div>
        </div>

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
                class="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium"
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
                class="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium"
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
                class="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium"
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

        <%!-- Proceed CTA --%>
        <.link
          navigate={~p"/chat"}
          class="block w-full text-center py-4 rounded-2xl font-medium text-base
                 hover:opacity-90 active:scale-95 transition-all duration-150"
          style="background: var(--accent); color: var(--accent-fg);"
        >
          Done — go to chat
        </.link>
      </div>
    </Layouts.app>
    """
  end
end
