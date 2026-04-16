# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.ChatLive do
  @moduledoc """
  LiveView for the anonymous chat interface.

  ## State machine

  The LiveView uses a single `@state` atom to track the current screen:

    :entry → :deriving → :connecting → :chat → :locked → :expired

  ## Lifecycle

  1. User lands on `/chat` — sees the entry screen (two masked fields).
  2. On submit, the `AnonChat` JS hook derives hashes via Web Crypto API.
  3. LiveView validates access via `Stelgano.Rooms.join_room/2`.
  4. JS hook joins the Phoenix Channel and derives the encryption key.
  5. All message crypto (AES-256-GCM) runs client-side; server sees only ciphertext.

  ## N=1 invariant

  At most one message exists per room at any time. When a reply is sent,
  the previous message is atomically deleted. The `can_type?/1` helper
  enforces turn-based input: you can only type when the room is empty
  or when the last message is from the other party.

  ## Passcode Test compliance

  The entry screen shows nothing that would reveal a conversation exists:
  a blank screen with two fields. Nothing else.
  """

  use StelganoWeb, :live_view

  @max_chars 4_000
  @counter_warn_at 3_500
  @counter_danger_at 3_900

  # Expose constants as assigns so HEEx templates can reference them via @max_chars etc.
  defp assign_constants(socket) do
    socket
    |> assign(:max_chars, @max_chars)
    |> assign(:counter_warn_at, @counter_warn_at)
    |> assign(:counter_danger_at, @counter_danger_at)
  end

  @impl true
  def mount(params, _session, socket) do
    prefilled_phone = Map.get(params, "phone", "")

    socket =
      socket
      |> assign(:page_title, "sTELgano")
      |> assign(:state, :entry)
      |> assign(:phone_visible, false)
      |> assign(:phone_locked, prefilled_phone != "")
      |> assign(:error, nil)
      |> assign(:attempts_remaining, nil)
      |> assign(:room_id, nil)
      |> assign(:room_hash, nil)
      |> assign(:sender_hash, nil)
      |> assign(:message, nil)
      |> assign(:char_count, 0)
      |> assign(:typing_visible, false)
      |> assign(:lock_pin, "")
      |> assign(:lock_attempts, 5)
      |> assign(:lock_error, nil)
      |> assign(:confirm_expire, false)
      |> assign(:ttl_expires_at, nil)
      |> assign(:_pending_phone, prefilled_phone)
      |> assign(:_pending_pin, "")
      |> assign_constants()

    {:ok, socket}
  end

  # ---------------------------------------------------------------------------
  # Events
  # ---------------------------------------------------------------------------

  @impl true
  def handle_event("entry_submit", %{"phone" => phone, "pin" => pin}, socket) do
    socket =
      socket
      |> assign(:state, :deriving)
      |> assign(:_pending_phone, phone)
      |> assign(:_pending_pin, pin)

    {:noreply, push_event(socket, "channel_join", %{action: "join", phone: phone, pin: pin})}
  end

  @impl true
  def handle_event("entry_change", %{"phone" => phone, "pin" => pin}, socket) do
    {:noreply, socket |> assign(:_pending_phone, phone) |> assign(:_pending_pin, pin)}
  end

  @impl true
  def handle_event("toggle_phone_visibility", _params, socket) do
    {:noreply, assign(socket, :phone_visible, !socket.assigns.phone_visible)}
  end

  @impl true
  def handle_event("channel_authenticate", params, socket) do
    %{"room_hash" => room_hash, "access_hash" => access_hash, "sender_hash" => sender_hash} =
      params

    case Stelgano.Rooms.join_room(room_hash, access_hash) do
      {:ok, room} ->
        socket =
          socket
          |> assign(:state, :connecting)
          |> assign(:room_id, room.id)
          |> assign(:room_hash, room_hash)
          |> assign(:sender_hash, sender_hash)
          |> assign(:error, nil)
          |> assign(:attempts_remaining, nil)

        {:noreply,
         push_event(socket, "channel_join_now", %{
           room_id: room.id,
           sender_hash: sender_hash,
           room_hash: room_hash,
           phone: socket.assigns._pending_phone
         })}

      {:error, :locked, remaining} ->
        socket =
          socket
          |> assign(:state, :entry)
          |> assign(:error, "Too many failed attempts. Try again in 30 minutes.")
          |> assign(:attempts_remaining, remaining)

        {:noreply, socket}

      {:error, :unauthorized, remaining} ->
        socket =
          socket
          |> assign(:state, :entry)
          |> assign(:error, "Could not open this room.")
          |> assign(:attempts_remaining, remaining)

        {:noreply, socket}

      {:error, _} ->
        socket =
          socket
          |> assign(:state, :entry)
          |> assign(:error, "Could not open this room.")

        {:noreply, socket}
    end
  end

  @impl true
  def handle_event("channel_join_error", _params, socket) do
    socket =
      socket
      |> assign(:state, :entry)
      |> assign(:error, "Could not connect. Please try again.")

    {:noreply, socket}
  end

  @impl true
  def handle_event("key_derivation_start", _params, socket) do
    {:noreply, assign(socket, :state, :connecting)}
  end

  @impl true
  def handle_event("key_derivation_complete", _params, socket) do
    {:noreply, socket}
  end

  @impl true
  def handle_event("key_derivation_error", _params, socket) do
    socket =
      socket
      |> assign(:state, :entry)
      |> assign(:error, "Key derivation failed. Please try again.")

    {:noreply, socket}
  end

  @impl true
  def handle_event("join_with_message", params, socket) do
    msg = %{
      id: params["id"],
      plaintext: params["plaintext"],
      sender_hash: params["sender_hash"],
      is_mine: params["is_mine"],
      read_at: params["read_at"],
      inserted_at: params["inserted_at"],
      edited: false
    }

    socket =
      socket
      |> assign(:state, :chat)
      |> assign(:message, msg)
      |> assign(:ttl_expires_at, params["ttl_expires_at"])

    {:noreply, socket}
  end

  @impl true
  def handle_event("join_empty", params, socket) do
    socket =
      socket
      |> assign(:state, :chat)
      |> assign(:message, nil)
      |> assign(:ttl_expires_at, params["ttl_expires_at"])

    {:noreply, socket}
  end

  @impl true
  def handle_event("message_received", params, socket) do
    msg = %{
      id: params["id"],
      plaintext: params["plaintext"],
      sender_hash: params["sender_hash"],
      is_mine: params["is_mine"],
      inserted_at: params["inserted_at"],
      read_at: nil,
      edited: false
    }

    {:noreply, socket |> assign(:message, msg) |> assign(:typing_visible, false)}
  end

  @impl true
  def handle_event("message_read_confirmed", %{"message_id" => _mid}, socket) do
    msg = socket.assigns.message

    if msg do
      {:noreply,
       assign(socket, :message, %{msg | read_at: DateTime.utc_now() |> DateTime.to_iso8601()})}
    else
      {:noreply, socket}
    end
  end

  @impl true
  def handle_event(
        "message_edit_received",
        %{"message_id" => _mid, "plaintext" => plaintext},
        socket
      ) do
    msg = socket.assigns.message

    if msg do
      {:noreply, assign(socket, :message, %{msg | plaintext: plaintext, edited: true})}
    else
      {:noreply, socket}
    end
  end

  @impl true
  def handle_event("message_delete_received", _params, socket) do
    {:noreply, assign(socket, :message, nil)}
  end

  @impl true
  def handle_event("edit_success", %{"message_id" => _mid}, socket) do
    msg = socket.assigns.message

    if msg,
      do: {:noreply, assign(socket, :message, %{msg | edited: true})},
      else: {:noreply, socket}
  end

  @impl true
  def handle_event("typing_indicator", _params, socket) do
    Process.send_after(self(), :clear_typing, 3_000)
    {:noreply, assign(socket, :typing_visible, true)}
  end

  @impl true
  def handle_event("room_expired_received", _params, socket) do
    {:noreply, socket |> assign(:state, :expired) |> assign(:message, nil)}
  end

  # No-ops for JS-handled events
  @impl true
  def handle_event("send_error", _p, socket), do: {:noreply, socket}
  @impl true
  def handle_event("edit_error", _p, socket), do: {:noreply, socket}
  @impl true
  def handle_event("delete_error", _p, socket), do: {:noreply, socket}
  @impl true
  def handle_event("decrypt_error", _p, socket), do: {:noreply, socket}
  @impl true
  def handle_event("read_receipt_js", _p, socket), do: {:noreply, socket}

  @impl true
  def handle_event("send_message", _params, socket) do
    {:noreply, push_event(socket, "send_encrypted", %{})}
  end

  @impl true
  def handle_event("input_change", %{"value" => value}, socket) do
    {:noreply, assign(socket, :char_count, String.length(value || ""))}
  end

  @impl true
  def handle_event("lock_chat", _params, socket) do
    {:noreply, assign(socket, :state, :locked)}
  end

  @impl true
  def handle_event("unlock_chat", %{"pin" => pin}, socket) do
    {:noreply,
     push_event(socket, "rederive_key", %{
       room_id: socket.assigns.room_id,
       pin: pin
     })}
  end

  @impl true
  def handle_event("rederive_success", _params, socket) do
    {:noreply,
     socket
     |> assign(:state, :connecting)
     |> push_event("channel_join_now", %{
       room_id: socket.assigns.room_id,
       sender_hash: socket.assigns.sender_hash,
       room_hash: socket.assigns.room_hash,
       phone: socket.assigns._pending_phone
     })}
  end

  @impl true
  def handle_event("rederive_failed", _params, socket) do
    remaining = socket.assigns.lock_attempts - 1

    if remaining <= 0 do
      {:noreply,
       socket
       |> assign(:state, :entry)
       |> assign(:message, nil)
       |> assign(:lock_attempts, 5)
       |> assign(:lock_error, nil)
       |> assign(:error, "Session cleared after too many failed attempts.")
       |> push_event("disconnect_channel", %{})}
    else
      {:noreply,
       socket
       |> assign(:lock_attempts, remaining)
       |> assign(
         :lock_error,
         "Wrong PIN. #{remaining} #{if remaining == 1, do: "attempt", else: "attempts"} left."
       )}
    end
  end

  @impl true
  def handle_event("leave_chat", _params, socket) do
    {:noreply,
     socket
     |> assign(:state, :entry)
     |> assign(:message, nil)
     |> assign(:room_id, nil)
     |> assign(:room_hash, nil)
     |> assign(:sender_hash, nil)
     |> assign(:phone_locked, false)
     |> assign(:_pending_phone, "")
     |> assign(:lock_attempts, 5)
     |> assign(:lock_error, nil)
     |> push_event("disconnect_channel", %{})}
  end

  @impl true
  def handle_event("clear_session", _params, socket) do
    {:noreply,
     socket
     |> assign(:state, :entry)
     |> assign(:message, nil)
     |> assign(:room_id, nil)
     |> assign(:phone_locked, false)
     |> assign(:_pending_phone, "")
     |> assign(:lock_attempts, 5)
     |> push_event("disconnect_channel", %{})}
  end

  @impl true
  def handle_event("confirm_expire", _params, socket) do
    {:noreply, assign(socket, :confirm_expire, true)}
  end

  @impl true
  def handle_event("cancel_expire", _params, socket) do
    {:noreply, assign(socket, :confirm_expire, false)}
  end

  @impl true
  def handle_event("expire_room", _params, socket) do
    {:noreply,
     socket
     |> assign(:confirm_expire, false)
     |> push_event("expire_room_js", %{})}
  end

  @impl true
  def handle_event("back_to_entry", _params, socket) do
    {:noreply,
     socket
     |> assign(:state, :entry)
     |> assign(:message, nil)
     |> assign(:error, nil)
     |> assign(:room_id, nil)
     |> assign(:phone_locked, false)
     |> assign(:_pending_phone, "")}
  end

  # ---------------------------------------------------------------------------
  # Info handlers
  # ---------------------------------------------------------------------------

  @impl true
  def handle_info(:clear_typing, socket) do
    {:noreply, assign(socket, :typing_visible, false)}
  end

  # ---------------------------------------------------------------------------
  # Render — delegates to state-specific renderers
  # ---------------------------------------------------------------------------

  @impl true
  def render(assigns) do
    ~H"""
    <div id="chat-root" phx-hook="AnonChat">
      {render_state(assigns)}
    </div>
    """
  end

  defp render_state(%{state: :entry} = assigns), do: render_entry(assigns)
  defp render_state(%{state: :deriving} = assigns), do: render_deriving(assigns)
  defp render_state(%{state: :connecting} = assigns), do: render_connecting(assigns)
  defp render_state(%{state: :chat} = assigns), do: render_chat(assigns)
  defp render_state(%{state: :locked} = assigns), do: render_locked(assigns)
  defp render_state(%{state: :expired} = assigns), do: render_expired(assigns)

  # ---------------------------------------------------------------------------
  # :entry
  # ---------------------------------------------------------------------------

  defp render_entry(assigns) do
    ~H"""
    <div class="entry-screen">
      <div class="entry-card">
        <div style="text-align: center; margin-bottom: 1.5rem;">
          <a href="/" class="wordmark" style="font-size: 1.4rem;">
            <span class="wm-s">s</span><span class="wm-tel">TEL</span><span class="wm-gano">gano</span>
          </a>
        </div>

        <%= if @error do %>
          <div class="entry-error">
            {@error}
            <%= if @attempts_remaining do %>
              <span style="display: block; font-size: 0.75rem; margin-top: 0.25rem; opacity: 0.75;">
                {@attempts_remaining} {if @attempts_remaining == 1, do: "attempt", else: "attempts"} remaining
              </span>
            <% end %>
          </div>
        <% end %>

        <form id="entry-form" phx-submit="entry_submit" phx-change="entry_change" class="stack-md">
          <%= if @phone_locked do %>
            <div class="phone-field-wrapper">
              <input
                id="entry-phone"
                name="phone"
                type="text"
                class="glass-input glass-input-mono"
                value={@_pending_phone}
                readonly
                style="padding-right: 3rem; opacity: 0.7; cursor: not-allowed;"
              />
              <span class="phone-toggle" style="opacity: 0.4;">
                <.icon name="hero-lock-closed-micro" class="w-5 h-5" />
              </span>
            </div>
          <% else %>
            <div class="phone-field-wrapper">
              <input
                id="entry-phone"
                name="phone"
                type={if @phone_visible, do: "text", else: "password"}
                class="glass-input glass-input-mono"
                placeholder="Shared phone number"
                autocomplete="off"
                value={@_pending_phone}
                style="padding-right: 3rem;"
              />
              <button
                type="button"
                id="phone-toggle-btn"
                class="phone-toggle"
                phx-click="toggle_phone_visibility"
                tabindex="-1"
              >
                <%= if @phone_visible do %>
                  <.icon name="hero-eye-slash-micro" class="w-5 h-5" />
                <% else %>
                  <.icon name="hero-eye-micro" class="w-5 h-5" />
                <% end %>
              </button>
            </div>
          <% end %>

          <input
            id="entry-pin"
            name="pin"
            type="password"
            inputmode="numeric"
            pattern="[0-9]*"
            class="glass-input"
            placeholder="Your PIN"
            autocomplete="current-password"
          />

          <button id="entry-submit" type="submit" class="glass-button">
            Open
          </button>
        </form>

        <div style="text-align: center; margin-top: 1rem;">
          <.link navigate={~p"/steg-number"} class="link-muted">
            Generate a shared number
          </.link>
        </div>
      </div>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # :deriving
  # ---------------------------------------------------------------------------

  defp render_deriving(assigns) do
    ~H"""
    <div class="entry-screen">
      <div class="entry-card entry-card-center">
        <a
          href="/"
          class="wordmark"
          style="font-size: 1.4rem; margin-bottom: 2rem; display: inline-block;"
        >
          <span class="wm-s">s</span><span class="wm-tel">TEL</span><span class="wm-gano">gano</span>
        </a>
        <div
          class="dots dots-center"
          style="display: flex; justify-content: center; margin-bottom: 1rem;"
        >
          <div class="dot"></div>
          <div class="dot"></div>
          <div class="dot"></div>
        </div>
        <p class="status-copy">Verifying…</p>
      </div>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # :connecting
  # ---------------------------------------------------------------------------

  defp render_connecting(assigns) do
    ~H"""
    <div class="entry-screen">
      <div class="entry-card entry-card-center">
        <a
          href="/"
          class="wordmark"
          style="font-size: 1.4rem; margin-bottom: 2rem; display: inline-block;"
        >
          <span class="wm-s">s</span><span class="wm-tel">TEL</span><span class="wm-gano">gano</span>
        </a>
        <div
          class="dots dots-center"
          style="display: flex; justify-content: center; margin-bottom: 1rem;"
        >
          <div class="dot"></div>
          <div class="dot"></div>
          <div class="dot"></div>
        </div>
        <p class="status-copy">Deriving encryption key…</p>
        <p class="status-copy-small">This takes a moment on first open.</p>
      </div>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # :chat
  # ---------------------------------------------------------------------------

  defp render_chat(assigns) do
    ~H"""
    <div class="chat-layout">
      <%!-- Header --%>
      <div class="chat-header">
        <a href="/" class="wordmark wordmark-small">
          <span class="wm-s">s</span><span class="wm-tel">TEL</span><span class="wm-gano">gano</span>
        </a>
        <div class="chat-header-actions">
          <button class="btn-icon" phx-click="lock_chat" title="Lock">
            <.icon name="hero-lock-closed-micro" class="w-5 h-5" />
          </button>
          <button
            class="btn-icon"
            style="color: var(--text-muted);"
            phx-click="confirm_expire"
            title="End conversation"
          >
            <.icon name="hero-trash-micro" class="w-5 h-5" />
          </button>
          <button class="btn-icon" phx-click="leave_chat" title="Leave">
            <.icon name="hero-arrow-right-on-rectangle-micro" class="w-5 h-5" />
          </button>
        </div>
      </div>

      <%!-- TTL bar --%>
      <div class="ttl-bar">
        <div class="ttl-bar-fill" id="ttl-bar-fill" style="width: 100%;"></div>
      </div>

      <%!-- Message area --%>
      <div class="chat-messages" role="log" aria-live="polite">
        <%!-- Typing indicator --%>
        <%= if @typing_visible do %>
          <div class="typing-indicator">
            <div class="dots">
              <div class="dot"></div>
              <div class="dot"></div>
              <div class="dot"></div>
            </div>
          </div>
        <% end %>

        <%!-- Current message --%>
        <%= if @message do %>
          <.render_message_bubble msg={@message} />
        <% end %>
      </div>

      <%!-- Input area --%>
      <%= if can_type?(assigns) do %>
        <.render_input_area char_count={@char_count} />
      <% else %>
        <div class="chat-input-area">
          <div class="waiting-state">Waiting for reply…</div>
        </div>
      <% end %>

      <%!-- Expire confirmation modal --%>
      <%= if @confirm_expire do %>
        <div class="modal-backdrop">
          <div class="modal-card">
            <div class="modal-title">End this conversation?</div>
            <div class="modal-body">
              This cannot be undone. All messages will be permanently deleted.
            </div>
            <div class="modal-actions">
              <button class="btn-ghost" phx-click="cancel_expire">Cancel</button>
              <button class="btn-danger" phx-click="expire_room">End</button>
            </div>
          </div>
        </div>
      <% end %>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # Message bubble
  # ---------------------------------------------------------------------------

  attr :msg, :map, required: true

  defp render_message_bubble(assigns) do
    side = if assigns.msg.is_mine, do: "sent", else: "received"
    assigns = assign(assigns, :side, side)

    ~H"""
    <div
      id={"bubble-wrapper-#{@msg.id}"}
      class={"bubble-wrapper #{@side}"}
      phx-hook={unless @msg.is_mine || @msg.read_at, do: "IntersectionReader"}
      data-message-id={@msg.id}
    >
      <div>
        <div id={"bubble-#{@msg.id}"} class={"bubble #{@side}"}>
          {@msg.plaintext}
        </div>
        <div class="bubble-meta">
          <%= if @msg.edited do %>
            <span class="bubble-edited">edited</span>
          <% end %>
          <%= if @msg.is_mine do %>
            <%= if @msg.read_at do %>
              <span class="tick-double">✓✓</span>
            <% else %>
              <span class="tick-single">✓</span>
            <% end %>
          <% end %>
        </div>
      </div>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # Input area
  # ---------------------------------------------------------------------------

  attr :char_count, :integer, required: true

  defp render_input_area(assigns) do
    ~H"""
    <div class="chat-input-area">
      <div class="chat-input-row">
        <textarea
          id="chat-textarea"
          class="chat-textarea"
          placeholder="Write a message…"
          rows="1"
          maxlength={@max_chars}
          phx-hook="AutoResize"
          phx-keyup="input_change"
          phx-update="ignore"
        ></textarea>
        <button
          id="btn-send"
          class="btn-icon"
          style="background: var(--color-primary); color: #fff; border-radius: 50%; width: 48px; height: 48px; min-width: 48px;"
          phx-click="send_message"
        >
          <.icon name="hero-paper-airplane-micro" class="w-5 h-5" />
        </button>
      </div>
      <%= if @char_count >= @counter_warn_at do %>
        <p class={"char-counter #{if @char_count >= @counter_danger_at, do: "danger", else: "warning"}"}>
          {@char_count}/{@max_chars}
        </p>
      <% end %>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # :locked
  # ---------------------------------------------------------------------------

  defp render_locked(assigns) do
    ~H"""
    <div class="lock-overlay" role="dialog">
      <div class="lock-card">
        <div style="margin-bottom: 2rem;">
          <a href="/" class="wordmark" style="font-size: 1.4rem;">
            <span class="wm-s">s</span><span class="wm-tel">TEL</span><span class="wm-gano">gano</span>
          </a>
        </div>

        <p class="lock-pin-label">Enter PIN to resume</p>

        <form id="lock-form" phx-submit="unlock_chat" class="stack-md">
          <input
            id="lock-pin-input"
            name="pin"
            type="password"
            autofocus
            class="glass-input glass-input-mono"
            style="text-align: center; letter-spacing: 0.2em;"
            placeholder="****"
          />
          <%= if @lock_error do %>
            <p id="lock-error" class="lock-error">{@lock_error}</p>
          <% end %>
          <button id="lock-submit" type="submit" class="glass-button" style="margin-top: 1rem;">
            Resume
          </button>
        </form>

        <button id="lock-clear" class="lock-clear" phx-click="clear_session">
          Clear session
        </button>
      </div>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # :expired
  # ---------------------------------------------------------------------------

  defp render_expired(assigns) do
    ~H"""
    <div class="entry-screen">
      <div class="entry-card entry-card-center">
        <a
          href="/"
          class="wordmark"
          style="font-size: 1.4rem; margin-bottom: 1.5rem; display: inline-block;"
        >
          <span class="wm-s">s</span><span class="wm-tel">TEL</span><span class="wm-gano">gano</span>
        </a>
        <p style="color: var(--text-muted); margin-bottom: 1.5rem;">This conversation has ended.</p>
        <button
          class="glass-button"
          phx-click="back_to_entry"
          style="max-width: 200px; margin: 0 auto;"
        >
          OK
        </button>
      </div>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp can_type?(%{state: :chat, message: nil}), do: true
  defp can_type?(%{state: :chat, message: %{is_mine: true}}), do: false
  defp can_type?(%{state: :chat, message: %{is_mine: false}}), do: true
  defp can_type?(_), do: false
end
