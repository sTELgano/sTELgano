# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.ChatLive do
  @moduledoc """
  LiveView for the chat entry screen and authenticated chat interface.

  ## Lifecycle

  1. User lands on `/chat` — sees the entry screen (two masked fields).
  2. On submit, the browser-side JS (`assets/js/hooks/chat.js`) derives
     `room_hash` and `access_hash` via the Web Crypto API and joins the
     Phoenix Channel directly.
  3. All crypto (PBKDF2, AES-GCM) runs in the browser; the LiveView
     serves only the shell and session-state coordination.
  4. The LiveView tracks whether the user has joined (`@joined`), whether
     a message is waiting (`@waiting`), the current lock state, and the
     inactivity timer preference.

  ## Session storage (browser-side)

  The following values live in `sessionStorage` (cleared on tab close):
  - `phone` — normalised phone number
  - `room_id` — server-generated UUID returned on channel join
  - `sender_hash` — SHA-256(phone + room_hash + SENDER_SALT)
  - `enc_key` — CryptoKey object (JS memory only; never serialised)

  The LiveView does **not** hold any of these values server-side.

  ## Passcode Test compliance

  The entry screen shows nothing that would reveal a conversation exists:
  - No recent conversation history
  - No contact names or identifiers
  - No "conversation with X" or timestamp information
  - Neutral error message on failure ("Could not open this room")
  """

  use StelganoWeb, :live_view

  @impl true
  def mount(_params, _session, socket) do
    socket =
      socket
      |> assign(:page_title, "sTELgano")
      |> assign(:joined, false)
      |> assign(:locked, false)
      |> assign(:room_expired, false)
      |> assign(:entry_error, nil)
      |> assign(:attempts_remaining, nil)
      |> assign(:lock_attempts, 0)
      |> assign(:inactivity_timeout, "5min")
      |> assign(:show_number, false)
      |> assign(:deriving, false)

    {:ok, socket}
  end

  @impl true
  def handle_event("toggle_number_visibility", _params, socket) do
    {:noreply, assign(socket, :show_number, !socket.assigns.show_number)}
  end

  @impl true
  def handle_event("set_deriving", %{"value" => value}, socket) do
    {:noreply, assign(socket, :deriving, value == "true")}
  end

  @impl true
  def handle_event("channel_joined", %{"room_id" => _room_id}, socket) do
    socket =
      socket
      |> assign(:joined, true)
      |> assign(:entry_error, nil)
      |> assign(:attempts_remaining, nil)

    {:noreply, socket}
  end

  @impl true
  def handle_event("channel_error", %{"reason" => reason} = payload, socket) do
    {error_msg, remaining} =
      case reason do
        "locked" ->
          {"Too many failed attempts. Try again in 30 minutes.", nil}

        "unauthorized" ->
          remaining = Map.get(payload, "attempts_remaining", nil)
          {"Could not open this room.", remaining}

        _ ->
          {"Could not open this room.", nil}
      end

    socket =
      socket
      |> assign(:entry_error, error_msg)
      |> assign(:attempts_remaining, remaining)
      |> assign(:deriving, false)

    {:noreply, socket}
  end

  @impl true
  def handle_event("lock_session", _params, socket) do
    {:noreply, assign(socket, :locked, true)}
  end

  @impl true
  def handle_event("unlock_attempt", %{"correct" => "true"}, socket) do
    socket =
      socket
      |> assign(:locked, false)
      |> assign(:lock_attempts, 0)

    {:noreply, socket}
  end

  @impl true
  def handle_event("unlock_attempt", %{"correct" => "false"}, socket) do
    new_attempts = socket.assigns.lock_attempts + 1

    socket =
      if new_attempts >= 5 do
        # Force full logout after 5 failed lock-screen attempts
        socket
        |> assign(:joined, false)
        |> assign(:locked, false)
        |> assign(:lock_attempts, 0)
        |> assign(:entry_error, "Session cleared after too many failed unlock attempts.")
      else
        assign(socket, :lock_attempts, new_attempts)
      end

    {:noreply, socket}
  end

  @impl true
  def handle_event("leave_session", _params, socket) do
    socket =
      socket
      |> assign(:joined, false)
      |> assign(:locked, false)
      |> assign(:lock_attempts, 0)
      |> assign(:room_expired, false)

    {:noreply, socket}
  end

  @impl true
  def handle_event("room_expired", _params, socket) do
    {:noreply, assign(socket, :room_expired, true)}
  end

  @impl true
  def handle_event("set_inactivity_timeout", %{"value" => value}, socket) do
    {:noreply, assign(socket, :inactivity_timeout, value)}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash}>
      <div class="min-h-screen flex flex-col" id="chat-root" phx-hook="ChatRoot">
        <%= if @joined do %>
          <%= if @locked do %>
            <.lock_screen lock_attempts={@lock_attempts} />
          <% else %>
            <%= if @room_expired do %>
              <.room_expired_screen />
            <% else %>
              <.chat_screen inactivity_timeout={@inactivity_timeout} />
            <% end %>
          <% end %>
        <% else %>
          <.entry_screen
            show_number={@show_number}
            deriving={@deriving}
            entry_error={@entry_error}
            attempts_remaining={@attempts_remaining}
          />
        <% end %>
      </div>
    </Layouts.app>
    """
  end

  # ---------------------------------------------------------------------------
  # Entry screen component
  # ---------------------------------------------------------------------------

  attr :show_number, :boolean, required: true
  attr :deriving, :boolean, required: true
  attr :entry_error, :string, default: nil
  attr :attempts_remaining, :integer, default: nil

  defp entry_screen(assigns) do
    ~H"""
    <div
      id="entry-screen"
      class="flex flex-col items-center justify-center min-h-screen px-4 py-12"
    >
      <%!-- Wordmark --%>
      <div class="mb-10 select-none">
        <span class="text-4xl font-light tracking-tight" style="color: var(--text-secondary)">
          s
        </span><span
          class="text-4xl font-semibold tracking-widest"
          style="color: var(--accent); letter-spacing: 0.04em"
        >
          TEL
        </span><span class="text-4xl font-light tracking-tight" style="color: var(--text-secondary)">
          gano
        </span>
      </div>

      <%!-- Entry form — all crypto happens in the ChatEntry JS hook --%>
      <div
        id="entry-form-wrapper"
        phx-hook="ChatEntry"
        class="w-full max-w-sm space-y-4"
      >
        <%!-- Phone / steg number field --%>
        <div class="relative">
          <input
            id="steg-number-input"
            name="steg_number"
            type={if @show_number, do: "text", else: "password"}
            inputmode="tel"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
            placeholder="Steg number"
            class="w-full px-4 py-3 rounded-lg text-base transition-colors duration-150
                   focus:outline-none focus:ring-2"
            style="background: var(--bg-raised); border: 1px solid var(--border);
                   color: var(--text-primary);
                   --tw-ring-color: var(--accent);"
          />
          <button
            type="button"
            phx-click="toggle_number_visibility"
            class="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded
                   transition-opacity duration-150 hover:opacity-70"
            style="color: var(--text-muted);"
            aria-label={if @show_number, do: "Hide number", else: "Show number"}
          >
            <%= if @show_number do %>
              <.icon name="hero-eye-slash" class="w-5 h-5" />
            <% else %>
              <.icon name="hero-eye" class="w-5 h-5" />
            <% end %>
          </button>
        </div>

        <%!-- PIN field --%>
        <div>
          <input
            id="pin-input"
            name="pin"
            type="password"
            inputmode="numeric"
            maxlength="12"
            autocomplete="off"
            placeholder="PIN"
            class="w-full px-4 py-3 rounded-lg text-base transition-colors duration-150
                   focus:outline-none focus:ring-2"
            style="background: var(--bg-raised); border: 1px solid var(--border);
                   color: var(--text-primary);
                   --tw-ring-color: var(--accent);"
          />
        </div>

        <%!-- Error message --%>
        <%= if @entry_error do %>
          <div
            id="entry-error"
            class="text-sm rounded-lg px-4 py-3"
            style="background: color-mix(in srgb, var(--danger) 10%, transparent);
                   color: var(--danger); border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);"
          >
            {@entry_error}
            <%= if @attempts_remaining do %>
              <span class="block text-xs mt-1 opacity-75">
                {@attempts_remaining} {if @attempts_remaining == 1, do: "attempt", else: "attempts"} remaining
              </span>
            <% end %>
          </div>
        <% end %>

        <%!-- Submit button --%>
        <button
          id="entry-submit"
          type="button"
          disabled={@deriving}
          class={[
            "w-full py-3 px-4 rounded-lg font-medium text-base transition-all duration-150",
            "focus:outline-none focus:ring-2",
            if(@deriving, do: "opacity-60 cursor-not-allowed", else: "hover:opacity-90 active:scale-95")
          ]}
          style="background: var(--accent); color: var(--accent-fg);
                 --tw-ring-color: var(--accent);"
        >
          <%= if @deriving do %>
            <span class="flex items-center justify-center gap-2">
              <.icon name="hero-arrow-path" class="w-4 h-4 animate-spin" />
              Verifying…
            </span>
          <% else %>
            Enter
          <% end %>
        </button>

        <%!-- Navigation links --%>
        <div class="flex justify-between text-sm pt-2" style="color: var(--text-muted);">
          <.link navigate={~p"/steg-number"} class="hover:underline underline-offset-2">
            Need a steg number?
          </.link>
          <.link navigate={~p"/security"} class="hover:underline underline-offset-2">
            How it works
          </.link>
        </div>
      </div>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # Chat screen component (rendered once joined)
  # ---------------------------------------------------------------------------

  attr :inactivity_timeout, :string, required: true

  defp chat_screen(assigns) do
    ~H"""
    <div
      id="chat-screen"
      phx-hook="ChatSession"
      data-inactivity-timeout={@inactivity_timeout}
      class="flex flex-col h-screen"
      style="background: var(--bg-base);"
    >
      <%!-- Session header --%>
      <header
        id="chat-header"
        class="flex items-center justify-between px-4 py-3 border-b"
        style="background: var(--bg-surface); border-color: var(--border);"
      >
        <div class="flex items-center gap-1">
          <span class="text-lg font-light select-none" style="color: var(--text-secondary);">
            s
          </span><span
            class="text-lg font-semibold"
            style="color: var(--accent); letter-spacing: 0.04em"
          >
            TEL
          </span><span class="text-lg font-light select-none" style="color: var(--text-secondary);">
            gano
          </span>
        </div>

        <div class="flex items-center gap-2">
          <%!-- Inactivity timeout selector --%>
          <select
            id="inactivity-timeout-select"
            phx-change="set_inactivity_timeout"
            name="value"
            class="text-xs px-2 py-1 rounded border focus:outline-none"
            style="background: var(--bg-raised); border-color: var(--border);
                   color: var(--text-secondary);"
            title="Auto-lock after"
          >
            <option value="30s">Lock: 30s</option>
            <option value="1min">Lock: 1min</option>
            <option value="5min" selected>Lock: 5min</option>
            <option value="15min">Lock: 15min</option>
            <option value="30min">Lock: 30min</option>
            <option value="never">Lock: Never</option>
          </select>

          <%!-- Lock --%>
          <button
            id="lock-btn"
            type="button"
            phx-click="lock_session"
            class="p-2 rounded-lg transition-opacity duration-150 hover:opacity-70"
            style="color: var(--text-secondary);"
            title="Lock session"
          >
            <.icon name="hero-lock-closed" class="w-5 h-5" />
          </button>

          <%!-- Theme toggle --%>
          <button
            id="theme-toggle-btn"
            type="button"
            phx-hook="ThemeToggle"
            class="p-2 rounded-lg transition-opacity duration-150 hover:opacity-70"
            style="color: var(--text-secondary);"
            title="Toggle theme"
          >
            <.icon name="hero-sun" class="w-5 h-5 dark-hidden" />
            <.icon name="hero-moon" class="w-5 h-5 light-hidden" />
          </button>

          <%!-- Expire room --%>
          <button
            id="expire-room-btn"
            type="button"
            phx-hook="ExpireRoom"
            class="p-2 rounded-lg transition-opacity duration-150 hover:opacity-70"
            style="color: var(--danger);"
            title="End this conversation"
          >
            <.icon name="hero-trash" class="w-5 h-5" />
          </button>

          <%!-- Leave --%>
          <button
            id="leave-btn"
            type="button"
            phx-click="leave_session"
            class="p-2 rounded-lg transition-opacity duration-150 hover:opacity-70 text-sm font-medium"
            style="color: var(--text-secondary);"
            title="Leave (does not expire room)"
          >
            Leave
          </button>
        </div>
      </header>

      <%!-- Message area — controlled entirely by JS hook --%>
      <div
        id="message-area"
        class="flex-1 overflow-y-auto px-4 py-4 space-y-3"
        style="background: var(--bg-base);"
      >
        <%!-- Empty state — shown by JS when no message exists --%>
        <div id="empty-state" class="hidden flex flex-col items-center justify-center h-full py-16 text-center">
          <p class="text-sm" style="color: var(--text-muted);">
            No messages yet. Send the first one.
          </p>
        </div>

        <%!-- Counterparty typing indicator — shown by JS --%>
        <div id="typing-indicator" class="hidden flex items-center gap-1 px-4 py-2">
          <span class="typing-dot" style="background: var(--text-muted);"></span>
          <span class="typing-dot" style="background: var(--text-muted);"></span>
          <span class="typing-dot" style="background: var(--text-muted);"></span>
        </div>

        <%!-- Messages rendered by JS into this container --%>
        <div id="messages-container"></div>
      </div>

      <%!-- Input area — sticky at bottom --%>
      <div
        id="input-area"
        class="border-t px-4 py-3"
        style="background: var(--bg-surface); border-color: var(--border);"
      >
        <%!-- Waiting state — shown by JS when it's not user's turn --%>
        <div id="waiting-state" class="hidden items-center gap-3 py-2">
          <div class="flex gap-1">
            <span class="waiting-dot"></span>
            <span class="waiting-dot"></span>
            <span class="waiting-dot"></span>
          </div>
          <span class="text-sm" style="color: var(--text-muted);">Waiting for reply…</span>
        </div>

        <%!-- Active input — shown by JS when it's user's turn --%>
        <div id="active-input" class="flex items-end gap-2">
          <textarea
            id="message-input"
            rows="1"
            maxlength="4000"
            placeholder="Write a message…"
            class="flex-1 resize-none overflow-hidden rounded-xl px-4 py-3 text-sm
                   transition-colors duration-150 focus:outline-none focus:ring-2"
            style="background: var(--bg-raised); border: 1px solid var(--border);
                   color: var(--text-primary); max-height: 140px;
                   --tw-ring-color: var(--accent);"
          ></textarea>
          <button
            id="send-btn"
            type="button"
            class="flex-shrink-0 p-3 rounded-xl transition-all duration-150
                   hover:opacity-90 active:scale-95"
            style="background: var(--accent); color: var(--accent-fg);"
            title="Send (Enter)"
          >
            <.icon name="hero-paper-airplane" class="w-5 h-5" />
          </button>
        </div>

        <%!-- Character counter — shown by JS at 3500+ chars --%>
        <div id="char-counter" class="hidden text-xs text-right mt-1" style="color: var(--text-muted);">
          <span id="char-count">0</span>/4000
        </div>
      </div>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # Lock screen component
  # ---------------------------------------------------------------------------

  attr :lock_attempts, :integer, required: true

  defp lock_screen(assigns) do
    ~H"""
    <div
      id="lock-screen"
      phx-hook="LockScreen"
      class="fixed inset-0 z-50 flex flex-col items-center justify-center px-4"
      style="background: var(--bg-base);"
    >
      <%!-- Wordmark --%>
      <div class="mb-10 select-none">
        <span class="text-3xl font-light" style="color: var(--text-secondary)">s</span><span
          class="text-3xl font-semibold"
          style="color: var(--accent); letter-spacing: 0.04em"
        >
          TEL
        </span><span class="text-3xl font-light" style="color: var(--text-secondary)">gano</span>
      </div>

      <div class="w-full max-w-xs space-y-4">
        <p class="text-center text-sm" style="color: var(--text-secondary);">
          Enter PIN to resume
        </p>

        <input
          id="lock-pin-input"
          type="password"
          inputmode="numeric"
          maxlength="12"
          autocomplete="off"
          placeholder="PIN"
          class="w-full px-4 py-3 rounded-lg text-base text-center
                 focus:outline-none focus:ring-2 transition-colors duration-150"
          style="background: var(--bg-raised); border: 1px solid var(--border);
                 color: var(--text-primary); --tw-ring-color: var(--accent);"
        />

        <%= if @lock_attempts > 0 do %>
          <p class="text-center text-xs" style="color: var(--danger);">
            Wrong PIN. {5 - @lock_attempts} {if 5 - @lock_attempts == 1, do: "attempt", else: "attempts"} remaining.
          </p>
        <% end %>

        <button
          id="lock-unlock-btn"
          type="button"
          class="w-full py-3 rounded-lg font-medium text-base
                 hover:opacity-90 active:scale-95 transition-all duration-150"
          style="background: var(--accent); color: var(--accent-fg);"
        >
          Unlock
        </button>

        <div class="text-center">
          <button
            type="button"
            phx-click="leave_session"
            class="text-xs hover:underline underline-offset-2 transition-opacity duration-150 hover:opacity-70"
            style="color: var(--text-muted);"
          >
            Clear session
          </button>
        </div>
      </div>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # Room expired screen
  # ---------------------------------------------------------------------------

  defp room_expired_screen(assigns) do
    ~H"""
    <div class="flex flex-col items-center justify-center min-h-screen px-4 text-center">
      <div class="mb-6">
        <span class="text-muted-icon"><.icon name="hero-lock-closed" class="w-12 h-12 mx-auto" /></span>
      </div>
      <p class="text-lg font-medium mb-2" style="color: var(--text-primary);">
        Conversation ended
      </p>
      <p class="text-sm mb-8" style="color: var(--text-secondary);">
        This room has been permanently deleted.
      </p>
      <button
        type="button"
        phx-click="leave_session"
        class="px-6 py-3 rounded-lg font-medium text-sm
               hover:opacity-90 active:scale-95 transition-all duration-150"
        style="background: var(--accent); color: var(--accent-fg);"
      >
        Start fresh
      </button>
    </div>
    """
  end
end
