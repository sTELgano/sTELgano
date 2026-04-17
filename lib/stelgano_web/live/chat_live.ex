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

  @impl Phoenix.LiveView
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
      |> assign(:confirm_expire, false)
      |> assign_constants()

    {:ok, socket, layout: false}
  end

  # ---------------------------------------------------------------------------
  # Events
  # ---------------------------------------------------------------------------

  @impl Phoenix.LiveView
  def handle_event("entry_submit", %{"phone" => phone, "pin" => pin}, socket) do
    socket =
      socket
      |> assign(:state, :deriving)
      |> assign(:_pending_phone, phone)
      |> assign(:_pending_pin, pin)

    {:noreply, push_event(socket, "channel_join", %{action: "join", phone: phone, pin: pin})}
  end

  @impl Phoenix.LiveView
  def handle_event("entry_change", %{"phone" => phone, "pin" => pin}, socket) do
    {:noreply, socket |> assign(:_pending_phone, phone) |> assign(:_pending_pin, pin)}
  end

  @impl Phoenix.LiveView
  def handle_event("toggle_phone_visibility", _params, socket) do
    {:noreply, assign(socket, :phone_visible, !socket.assigns.phone_visible)}
  end

  @impl Phoenix.LiveView
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

      {:error, _reason} ->
        socket =
          socket
          |> assign(:state, :entry)
          |> assign(:error, "Could not open this room.")

        {:noreply, socket}
    end
  end

  @impl Phoenix.LiveView
  def handle_event("channel_join_error", _params, socket) do
    socket =
      socket
      |> assign(:state, :entry)
      |> assign(:error, "Could not connect. Please try again.")

    {:noreply, socket}
  end

  @impl Phoenix.LiveView
  def handle_event("key_derivation_start", _params, socket) do
    {:noreply, assign(socket, :state, :connecting)}
  end

  @impl Phoenix.LiveView
  def handle_event("key_derivation_complete", _params, socket) do
    {:noreply, socket}
  end

  @impl Phoenix.LiveView
  def handle_event("key_derivation_error", _params, socket) do
    socket =
      socket
      |> assign(:state, :entry)
      |> assign(:error, "Key derivation failed. Please try again.")

    {:noreply, socket}
  end

  @impl Phoenix.LiveView
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

  @impl Phoenix.LiveView
  def handle_event("join_empty", params, socket) do
    socket =
      socket
      |> assign(:state, :chat)
      |> assign(:message, nil)
      |> assign(:ttl_expires_at, params["ttl_expires_at"])

    {:noreply, socket}
  end

  @impl Phoenix.LiveView
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

  @impl Phoenix.LiveView
  def handle_event("message_read_confirmed", %{"message_id" => _mid}, socket) do
    msg = socket.assigns.message

    if msg do
      {:noreply,
       assign(socket, :message, %{msg | read_at: DateTime.to_iso8601(DateTime.utc_now())})}
    else
      {:noreply, socket}
    end
  end

  @impl Phoenix.LiveView
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

  @impl Phoenix.LiveView
  def handle_event("message_delete_received", _params, socket) do
    {:noreply, assign(socket, :message, nil)}
  end

  @impl Phoenix.LiveView
  def handle_event("edit_success", %{"message_id" => _mid}, socket) do
    msg = socket.assigns.message

    if msg,
      do: {:noreply, assign(socket, :message, %{msg | edited: true})},
      else: {:noreply, socket}
  end

  @impl Phoenix.LiveView
  def handle_event("typing_indicator", _params, socket) do
    Process.send_after(self(), :clear_typing, 3_000)
    {:noreply, assign(socket, :typing_visible, true)}
  end

  @impl Phoenix.LiveView
  def handle_event("room_expired_received", _params, socket) do
    {:noreply, socket |> assign(:state, :expired) |> assign(:message, nil)}
  end

  # No-ops for JS-handled events
  @impl Phoenix.LiveView
  def handle_event("send_error", _p, socket), do: {:noreply, socket}
  @impl Phoenix.LiveView
  def handle_event("edit_error", _p, socket), do: {:noreply, socket}
  @impl Phoenix.LiveView
  def handle_event("delete_error", _p, socket), do: {:noreply, socket}
  @impl Phoenix.LiveView
  def handle_event("decrypt_error", _p, socket), do: {:noreply, socket}
  @impl Phoenix.LiveView
  def handle_event("read_receipt_js", _p, socket), do: {:noreply, socket}

  @impl Phoenix.LiveView
  def handle_event("send_message", _params, socket) do
    {:noreply, push_event(socket, "send_encrypted", %{})}
  end

  @impl Phoenix.LiveView
  def handle_event("input_change", %{"value" => value}, socket) do
    {:noreply, assign(socket, :char_count, String.length(value || ""))}
  end

  @impl Phoenix.LiveView
  def handle_event("lock_chat", _params, socket) do
    {:noreply, assign(socket, :state, :locked)}
  end

  @impl Phoenix.LiveView
  def handle_event("unlock_chat", %{"pin" => pin}, socket) do
    {:noreply,
     push_event(socket, "rederive_key", %{
       room_id: socket.assigns.room_id,
       pin: pin
     })}
  end

  @impl Phoenix.LiveView
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

  @impl Phoenix.LiveView
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

  @impl Phoenix.LiveView
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

  @impl Phoenix.LiveView
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

  @impl Phoenix.LiveView
  def handle_event("confirm_expire", _params, socket) do
    {:noreply, assign(socket, :confirm_expire, true)}
  end

  @impl Phoenix.LiveView
  def handle_event("cancel_expire", _params, socket) do
    {:noreply, assign(socket, :confirm_expire, false)}
  end

  @impl Phoenix.LiveView
  def handle_event("expire_room", _params, socket) do
    {:noreply,
     socket
     |> assign(:confirm_expire, false)
     |> push_event("expire_room_js", %{})}
  end

  @impl Phoenix.LiveView
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

  @impl Phoenix.LiveView
  def handle_info(:clear_typing, socket) do
    {:noreply, assign(socket, :typing_visible, false)}
  end

  # ---------------------------------------------------------------------------
  # Render — delegates to state-specific renderers
  # ---------------------------------------------------------------------------

  @impl Phoenix.LiveView
  def render(assigns) do
    ~H"""
    <div
      id="chat-root"
      phx-hook="AnonChat"
      class="h-dvh w-screen overflow-hidden bg-slate-950 text-white"
    >
      <Layouts.flash_group flash={@flash} id="chat-flash" />
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
    <div class="flex flex-col items-center justify-center min-h-[calc(100vh-120px)] animate-in">
      <div class="w-full max-w-xl space-y-12">
        <%!-- Branding --%>
        <div class="text-center space-y-4">
          <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-bold uppercase tracking-[0.2em] mb-4 shadow-[0_0_15px_rgba(0,255,163,0.1)]">
            <.icon name="ban" class="size-3" /> Secure Chat Session
          </div>
          <h1 class="text-5xl sm:text-6xl font-extrabold tracking-tighter text-white font-display">
            Open <span class="text-gradient">Chat.</span>
          </h1>
          <p class="text-slate-500 font-medium text-lg leading-relaxed">
            Enter your details below to secure your connection.
          </p>
        </div>

        <.premium_card class="p-1 sm:p-1 overflow-hidden shadow-primary-glow/20">
          <div class="p-8 sm:p-12 space-y-10">
            <%= if @error do %>
              <div class="p-5 rounded-2xl bg-danger/5 border border-danger/20 flex gap-4 animate-in">
                <.icon name="alert_circle" class="size-6 text-danger shrink-0" />
                <div class="space-y-1">
                  <p class="text-sm font-bold text-danger">{@error}</p>
                  <%= if @attempts_remaining do %>
                    <p class="text-[10px] text-danger/60 font-mono uppercase tracking-widest font-black">
                      Security Lock: {@attempts_remaining} {if @attempts_remaining == 1,
                        do: "attempt",
                        else: "attempts"} remaining
                    </p>
                  <% end %>
                </div>
              </div>
            <% end %>

            <%= cond do %>
              <% @_pending_phone == "" -> %>
                <div class="text-center py-12 space-y-10 animate-in">
                  <div class="size-24 mx-auto relative group">
                    <div class="absolute inset-0 bg-primary/20 blur-2xl rounded-full group-hover:bg-primary/30 transition-all">
                    </div>
                    <div class="relative size-24 rounded-4xl bg-slate-900 border border-white/10 flex items-center justify-center">
                      <.icon name="ban" class="size-12 text-slate-500" />
                    </div>
                  </div>

                  <div class="space-y-4">
                    <h3 class="text-4xl font-extrabold text-white font-display">Start a Chat.</h3>
                    <p class="text-slate-500 font-medium leading-relaxed max-w-sm mx-auto">
                      A chat session requires a secret number to start a secure connection.
                    </p>
                  </div>

                  <div class="pt-6">
                    <.link
                      navigate={~p"/steg-number"}
                      class="btn-primary inline-flex items-center gap-4 px-10 py-5 text-lg shadow-[0_20px_40px_-10px_rgba(0,255,163,0.3)] transition-all"
                    >
                      Create Number <.icon name="sparkles" class="size-6" />
                    </.link>
                  </div>
                </div>
              <% @phone_locked -> %>
                <form
                  id="entry-form"
                  phx-submit="entry_submit"
                  phx-change="entry_change"
                  class="space-y-10"
                >
                  <%!-- Phone Vector --%>
                  <div class="space-y-4">
                    <div class="flex items-center justify-between px-1">
                      <label class="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500">
                        Secret Number
                      </label>
                      <span class="text-[10px] font-mono text-primary font-bold">LOCKED</span>
                    </div>
                    <div class="relative group">
                      <input
                        id="entry-phone"
                        name="phone"
                        type={if @phone_visible, do: "text", else: "password"}
                        class="glass-input w-full pr-14 font-mono text-xl font-bold tracking-widest bg-slate-950/40"
                        value={@_pending_phone}
                        readonly
                      />
                      <button
                        type="button"
                        id="phone-toggle-btn"
                        phx-click="toggle_phone_visibility"
                        class="absolute right-4 top-1/2 -translate-y-1/2 p-2 rounded-xl text-slate-500 hover:text-white hover:bg-white/5 transition-all"
                        tabindex="-1"
                      >
                        <.icon
                          name={if @phone_visible, do: "eye_off", else: "eye"}
                          class="size-6"
                        />
                      </button>
                    </div>
                  </div>

                  <%!-- PIN Input --%>
                  <div class="space-y-4">
                    <div class="flex items-center justify-between px-1">
                      <label class="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500">
                        Private PIN
                      </label>
                      <span class="text-[10px] font-mono text-slate-500 font-bold">
                        SECURED LOCALLY
                      </span>
                    </div>
                    <.input
                      id="entry-pin"
                      name="pin"
                      type="password"
                      inputmode="numeric"
                      pattern="[0-9]*"
                      placeholder="••••"
                      autocomplete="current-password"
                      autofocus
                      class="text-center text-3xl sm:text-4xl tracking-[0.6em] font-mono py-6 bg-slate-950/40 border-white/10"
                    />
                  </div>

                  <button
                    id="entry-submit"
                    type="submit"
                    class="btn-primary w-full py-5 text-xl group shadow-[0_20px_40px_-10px_rgba(0,255,163,0.3)]"
                  >
                    Open Chat
                    <.icon
                      name="zap"
                      class="size-6 group-hover:scale-125 transition-transform"
                    />
                  </button>
                </form>
              <% true -> %>
                <%!-- Fallback for manual entry if needed, but current app flow favors prefilled params --%>
                <div class="text-center py-6 space-y-8">
                  <div class="relative size-32 mx-auto">
                    <div class="absolute inset-0 rounded-full border-4 border-primary/10 border-t-primary animate-spin">
                    </div>
                    <div class="absolute inset-4 rounded-full border-2 border-primary/5 border-b-primary animate-spin-slow">
                    </div>
                    <div class="absolute inset-0 flex items-center justify-center">
                      <.icon
                        name="fingerprint"
                        class="size-12 text-primary drop-shadow-[0_0_10px_rgba(0,255,163,0.5)]"
                      />
                    </div>
                  </div>

                  <div class="space-y-3">
                    <h3 class="text-2xl font-bold text-white font-display">Authorizing</h3>
                    <p class="text-slate-400 font-medium">
                      Verifying your PIN...
                    </p>
                  </div>
                </div>
            <% end %>
          </div>
        </.premium_card>
      </div>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # :deriving
  # ---------------------------------------------------------------------------

  defp render_deriving(assigns) do
    ~H"""
    <div class="flex flex-col items-center justify-center min-h-[calc(100vh-120px)] p-6 animate-in">
      <div class="w-full max-w-sm text-center space-y-16">
        <div class="relative size-48 mx-auto">
          <div class="absolute inset-0 rounded-full border-2 border-primary/5 border-t-primary animate-spin duration-1000">
          </div>
          <div class="absolute inset-4 rounded-full border-2 border-primary/5 border-r-primary animate-spin-reverse duration-2000">
          </div>
          <div class="absolute inset-8 rounded-full border-2 border-primary/5 border-l-primary animate-spin duration-3000">
          </div>
          <div class="absolute inset-0 flex items-center justify-center">
            <div class="size-24 rounded-full bg-slate-900 border border-white/5 flex items-center justify-center shadow-2xl">
              <.icon
                name="cpu"
                class="size-12 text-primary animate-pulse drop-shadow-[0_0_15px_var(--color-primary-glow)]"
              />
            </div>
          </div>
        </div>

        <div class="space-y-6">
          <h3 class="text-4xl font-extrabold text-white font-display tracking-tight uppercase">
            Securing <span class="text-gradient">Chat.</span>
          </h3>
          <p class="text-slate-500 font-medium leading-relaxed">
            Your browser is {if @confirm_expire,
              do: "safely erasing all data",
              else: "securing your private connection"}.
          </p>
        </div>

        <div class="flex justify-center items-center gap-3">
          <div class="size-1.5 rounded-full bg-primary animate-ping"></div>
          <div class="size-1.5 rounded-full bg-primary animate-ping [animation-delay:0.3s]"></div>
          <div class="size-1.5 rounded-full bg-primary animate-ping [animation-delay:0.6s]"></div>
        </div>
      </div>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # :connecting
  # ---------------------------------------------------------------------------

  defp render_connecting(assigns) do
    ~H"""
    <div class="flex flex-col items-center justify-center min-h-[calc(100vh-120px)] p-6">
      <div class="w-full max-w-sm text-center space-y-10 animate-in">
        <div class="size-24 rounded-[2.5rem] bg-primary/5 flex items-center justify-center mx-auto shadow-inner ring-1 ring-primary/20 animate-pulse">
          <.icon name="globe" class="size-12 text-primary" />
        </div>

        <div class="space-y-3">
          <h3 class="text-2xl font-bold text-white font-display">Connecting</h3>
          <p class="text-slate-400 font-medium">Linking with your private chat space…</p>
        </div>

        <div class="px-6 py-3 rounded-2xl bg-slate-950/60 border border-white/5 font-mono text-[10px] text-slate-500 font-bold uppercase tracking-[0.3em]">
          Status: Opening Secure Link
        </div>
      </div>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # :chat
  # ---------------------------------------------------------------------------

  defp render_chat(assigns) do
    ~H"""
    <div class="h-full w-full flex flex-col relative overflow-hidden">
      <%!-- Navigation Header --%>
      <div class="px-6 py-5 flex items-center justify-between border-b border-white/10 bg-slate-900/80 backdrop-blur-3xl sticky top-0 z-50">
        <div class="flex items-center gap-4">
          <.link navigate={~p"/"} class="wordmark text-2xl leading-tight group">
            <span class="wm-symbol">s</span><span class="wm-accent">TEL</span><span class="text-white">gano</span>
          </.link>
          <div class="hidden sm:block h-6 w-px bg-white/20"></div>
          <span class="hidden sm:inline text-xs font-bold uppercase tracking-[0.3em] text-primary">
            WORKSPACE SECURED
          </span>
        </div>

        <%!-- Session Controls --%>
        <div class="flex items-center gap-1 sm:gap-4">
          <button
            class="p-3 rounded-2xl bg-white/5 hover:bg-white/10 text-white transition-all flex items-center justify-center border border-white/5 shadow-lg"
            phx-click="lock_chat"
            title="Lock session"
          >
            <.icon name="lock" class="size-6" />
          </button>
          <button
            class="p-3 rounded-2xl bg-danger/10 hover:bg-danger/20 text-danger transition-all flex items-center justify-center border border-danger/20 shadow-lg shadow-danger/5"
            phx-click="confirm_expire"
            title="Erase all"
          >
            <.icon name="flame" class="size-6" />
          </button>
          <div class="w-px h-6 bg-white/20 mx-1"></div>
          <button
            class="p-3 rounded-2xl bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white transition-all flex items-center justify-center border border-white/5 shadow-lg"
            phx-click="leave_chat"
            title="Exit Chat"
          >
            <.icon name="power" class="size-6 text-danger" />
          </button>
        </div>
      </div>

      <%!-- TTL (Session Entropy) Bar --%>
      <div class="h-1 w-full bg-slate-900 border-b border-white/5 overflow-hidden">
        <div
          class="h-full bg-linear-to-r from-primary via-emerald-400 to-primary/40 transition-all duration-1000 ease-linear shadow-[0_0_10px_rgba(0,255,163,0.5)]"
          id="ttl-bar-fill"
          style="width: 100%;"
        >
        </div>
      </div>

      <%!-- Workspace Message Area --%>
      <div
        class="flex-1 overflow-y-auto px-6 py-10 space-y-10 scrollbar-hide"
        role="log"
        aria-live="polite"
        id="message-list"
      >
        <%= if @message do %>
          <.render_message_bubble msg={@message} />
        <% else %>
          <div class="flex flex-col items-center justify-center h-full text-center max-w-sm mx-auto animate-in space-y-8">
            <div class="relative size-24">
              <div class="absolute inset-0 rounded-3xl bg-white/2 border border-white/5 rotate-6">
              </div>
              <div class="absolute inset-0 rounded-3xl bg-white/2 border border-white/5 -rotate-3">
              </div>
              <div class="absolute inset-0 rounded-3xl bg-slate-900 border border-white/10 flex items-center justify-center">
                <.icon name="shield_check" class="size-12 text-slate-700" />
              </div>
            </div>
            <div class="space-y-3">
              <h4 class="text-2xl font-bold text-white font-display">Zero Trace Channel</h4>
              <p class="text-slate-500 font-medium leading-relaxed">
                The buffer is currently empty. This workspace adheres to a strict single-message protocol for maximum plausible deniability.
              </p>
            </div>
          </div>
        <% end %>

        <%!-- Async Indicator --%>
        <%= if @typing_visible do %>
          <div class="flex items-center gap-4 text-primary ml-2 animate-in py-4">
            <div class="flex gap-1.5">
              <div class="size-2 bg-primary/80 rounded-full animate-bounce"></div>
              <div class="size-2 bg-primary/80 rounded-full animate-bounce [animation-delay:0.2s]">
              </div>
              <div class="size-2 bg-primary/80 rounded-full animate-bounce [animation-delay:0.4s]">
              </div>
            </div>
            <span class="text-[10px] font-black uppercase tracking-[0.4em] animate-pulse">
              The other node is typing...
            </span>
          </div>
        <% end %>
      </div>

      <%!-- User Interaction Zone --%>
      <div class="p-8 pb-10">
        <%= if can_type?(assigns) do %>
          <.render_input_area
            char_count={@char_count}
            max_chars={@max_chars}
            counter_warn_at={@counter_warn_at}
            counter_danger_at={@counter_danger_at}
          />
        <% else %>
          <div class="glass-card flex items-center justify-center gap-4 py-6 border-white/5 select-none opacity-60 backdrop-grayscale">
            <div class="flex gap-2 items-center">
              <div class="size-1.5 rounded-full bg-primary/40 animate-bounce"></div>
              <div class="size-1.5 rounded-full bg-primary/40 animate-bounce [animation-delay:0.2s]">
              </div>
              <div class="size-1.5 rounded-full bg-primary/40 animate-bounce [animation-delay:0.4s]">
              </div>
            </div>
            <span class="text-xs font-bold text-slate-400 uppercase tracking-[0.3em] animate-pulse">
              Waiting for reply...
            </span>
          </div>
        <% end %>
      </div>

      <%!-- Destruction Modal --%>
      <%= if @confirm_expire do %>
        <div class="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-950/80 backdrop-blur-3xl animate-in duration-300">
          <div class="w-full max-w-sm glass-card p-10 border-danger/40 shadow-danger-glow relative overflow-hidden">
            <div class="absolute -right-10 -bottom-10 size-40 bg-danger/5 rounded-full blur-3xl">
            </div>

            <div class="size-20 rounded-4xl bg-danger/10 flex items-center justify-center mb-8 border border-danger/20">
              <.icon name="flame" class="size-10 text-danger" />
            </div>

            <h3 class="text-3xl font-extrabold text-white mb-4 font-display">Nuclear Wipe?</h3>
            <p class="text-slate-400 mb-10 leading-relaxed font-medium">
              This will permanently purge the current artifact and end the sequence for both nodes. This action is
              <span class="text-white">irreversible.</span>
            </p>

            <div class="flex flex-col gap-3">
              <button
                class="w-full py-4 rounded-2xl bg-danger text-white font-black uppercase tracking-widest shadow-xl shadow-danger/20 hover:scale-[1.02] active:scale-95 transition-all"
                phx-click="expire_room"
              >
                Initialize Purge
              </button>
              <button
                class="w-full py-4 rounded-2xl bg-white/5 text-slate-400 font-bold uppercase tracking-widest hover:bg-white/10 transition-all border border-white/5"
                phx-click="cancel_expire"
              >
                Abort
              </button>
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
    ~H"""
    <div
      id={"bubble-wrapper-#{@msg.id}"}
      class={["flex w-full animate-in", if(@msg.is_mine, do: "justify-end", else: "justify-start")]}
      phx-hook={unless @msg.is_mine || @msg.read_at, do: "IntersectionReader"}
      data-message-id={@msg.id}
    >
      <div class={[
        "max-w-[80%] group space-y-3",
        if(@msg.is_mine, do: "flex flex-col items-end", else: "flex flex-col items-start")
      ]}>
        <div class={[
          "relative p-6 sm:p-8 rounded-4xl transition-all duration-500 border overflow-hidden",
          if(@msg.is_mine,
            do:
              "bg-linear-to-br from-primary/10 to-emerald-500/5 border-primary/20 rounded-tr-none text-white shadow-[0_10px_30px_-10px_rgba(0,255,163,0.1)]",
            else:
              "bg-slate-900/50 backdrop-blur-xl border-white/5 rounded-tl-none text-slate-200 shadow-inner"
          )
        ]}>
          <p class="relative z-10 whitespace-pre-wrap text-base sm:text-lg leading-relaxed font-medium tracking-tight">
            {@msg.plaintext}
          </p>
        </div>

        <div class="flex items-center gap-4 px-2 mt-1">
          <%= if @msg.edited do %>
            <span class="text-[9px] font-black uppercase tracking-[0.2em] text-slate-600">
              Edited
            </span>
          <% end %>
          <%= if @msg.is_mine do %>
            <div class="flex items-center gap-2">
              <%= if @msg.read_at do %>
                <span class="flex items-center gap-1 py-0.5 px-1.5 rounded-md bg-primary/5 border border-primary/10">
                  <.icon name="badge_check" class="size-2.5 text-primary" />
                  <span class="text-[8px] font-black uppercase tracking-[0.1em] text-primary/80">
                    Read
                  </span>
                </span>
              <% else %>
                <span class="flex items-center gap-1 py-0.5 px-1.5 rounded-md bg-white/5 border border-white/5">
                  <div class="size-1 rounded-full bg-slate-600 animate-pulse"></div>
                  <span class="text-[8px] font-black uppercase tracking-[0.1em] text-slate-500">
                    Delivered
                  </span>
                </span>
              <% end %>
            </div>
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
  attr :max_chars, :integer, required: true
  attr :counter_warn_at, :integer, required: true
  attr :counter_danger_at, :integer, required: true

  defp render_input_area(assigns) do
    ~H"""
    <div class="relative group">
      <%!-- Glow focus effect --%>
      <div class="absolute -inset-1 bg-linear-to-r from-primary/20 via-emerald-400/20 to-primary/20 rounded-[2.5rem] blur-xl opacity-0 group-focus-within:opacity-100 transition-opacity duration-700">
      </div>

      <div class="relative flex items-end gap-3 p-3 sm:p-5 rounded-4xl bg-slate-900 border-2 border-white/10 group-focus-within:border-primary/50 group-focus-within:bg-slate-950 transition-all duration-300 shadow-2xl z-50">
        <textarea
          id="chat-textarea"
          class="flex-1 bg-transparent border-none text-white placeholder-slate-500 focus:ring-0 py-4 px-2 resize-none max-h-60 min-h-[3.5rem] scrollbar-hide text-lg leading-relaxed font-medium"
          placeholder="Construct secure message…"
          rows="1"
          maxlength={@max_chars}
          phx-hook="AutoResize"
          phx-keyup="input_change"
          phx-update="ignore"
        ></textarea>

        <div class="flex items-center gap-4 pr-1 pb-1">
          <%= if @char_count >= @counter_warn_at do %>
            <div class="flex flex-col items-end mr-2">
              <span class={[
                "text-[10px] font-mono font-bold tracking-widest",
                if(@char_count >= @counter_danger_at, do: "text-danger", else: "text-warning")
              ]}>
                {@char_count}<span class="text-slate-600">/</span>{@max_chars}
              </span>
            </div>
          <% end %>

          <button
            id="btn-send"
            class="size-16 rounded-[1.75rem] bg-primary text-slate-950 flex items-center justify-center shadow-[0_0_30px_rgba(0,255,163,0.3)] hover:scale-110 active:scale-95 transition-all group disabled:grayscale disabled:opacity-50"
            phx-click="send_message"
            aria-label="Encrypt & Broadcast"
          >
            <.icon
              name="send"
              class="size-8 -rotate-12 group-hover:rotate-0 transition-transform"
            />
          </button>
        </div>
      </div>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # :locked
  # ---------------------------------------------------------------------------

  defp render_locked(assigns) do
    ~H"""
    <div class="fixed inset-0 z-100 flex items-center justify-center p-6 bg-slate-950/95 backdrop-blur-3xl animate-in">
      <div class="w-full max-w-sm text-center space-y-12">
        <div class="relative size-24 mx-auto">
          <div class="absolute -inset-4 bg-primary/10 rounded-full blur-2xl animate-pulse"></div>
          <div class="relative size-24 rounded-4xl bg-slate-900 border border-primary/20 flex items-center justify-center shadow-inner group">
            <.icon
              name="lock"
              class="size-12 text-primary drop-shadow-[0_0_10px_var(--color-primary-glow)]"
            />
          </div>
        </div>

        <div class="space-y-4">
          <h1 class="text-4xl font-extrabold text-white font-display tracking-tight uppercase">
            Workspace <span class="text-gradient">Locked.</span>
          </h1>
          <p class="text-slate-500 font-medium text-sm leading-relaxed max-w-[280px] mx-auto">
            Encryption artifacts are suspended. Re-derive the key matrix to restore the link.
          </p>
        </div>

        <form id="unlock-form" phx-submit="unlock_chat" class="space-y-8">
          <div class="space-y-4">
            <div class="flex items-center justify-between px-1">
              <label class="text-[10px] font-black uppercase tracking-[0.4em] text-slate-500">
                Local PIN Verification
              </label>
              <div class="flex gap-1">
                <div :for={_ <- 1..@lock_attempts} class="size-1 rounded-full bg-primary/40"></div>
              </div>
            </div>
            <.input
              name="pin"
              type="password"
              inputmode="numeric"
              pattern="[0-9]*"
              placeholder="••••"
              class="text-center text-4xl tracking-[0.6em] font-mono py-6 bg-slate-950/40 border-white/10 focus:border-primary/40"
              autofocus
            />
            <%= if @lock_error do %>
              <div class="p-3 rounded-xl bg-danger/10 border border-danger/20 text-xs font-bold text-danger animate-bounce uppercase tracking-widest">
                {@lock_error}
              </div>
            <% end %>
          </div>

          <button
            type="submit"
            class="btn-primary w-full py-5 text-xl shadow-[0_20px_40px_-10px_rgba(0,255,163,0.3)]"
          >
            Reconnect Chat
          </button>
        </form>

        <button
          phx-click="clear_session"
          class="text-[10px] font-black uppercase tracking-[0.4em] text-slate-600 hover:text-white transition-colors flex items-center gap-2 mx-auto py-2 px-4 rounded-xl hover:bg-white/5"
        >
          <.icon name="trash_2" class="size-3" /> Erase All Session Data
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
    <div class="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-950/80 backdrop-blur-2xl">
      <.premium_card class="max-w-md w-full text-center border-danger/20 shadow-danger-glow animate-in">
        <div class="size-20 rounded-3xl bg-danger/10 flex items-center justify-center mx-auto mb-8 border border-danger/20">
          <.icon name="trash_2" class="size-10 text-danger" />
        </div>

        <h3 class="text-3xl font-extrabold text-white font-display mb-4">Chat Ended</h3>

        <p class="text-slate-400 font-medium leading-relaxed mb-10">
          The chat session has been permanently closed.
          All messages have been erased and cannot be recovered.
        </p>

        <button
          phx-click="back_to_entry"
          class="btn-primary w-full py-4 text-lg"
        >
          Start New Chat
        </button>
      </.premium_card>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp can_type?(%{state: :chat, message: nil}), do: true
  defp can_type?(%{state: :chat, message: %{is_mine: false}}), do: true
  defp can_type?(%{state: :chat, message: %{is_mine: true, read_at: nil}}), do: true
  defp can_type?(%{state: :chat, message: %{is_mine: true}}), do: false
  defp can_type?(_assigns), do: false
end
