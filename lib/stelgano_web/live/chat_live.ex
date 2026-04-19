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

  import StelganoWeb.Helpers.PriceFormatter, only: [format_price: 2]

  alias Stelgano.Monetization

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
  def mount(_params, _session, socket) do
    socket =
      socket
      |> assign(:page_title, "sTELgano")
      |> assign(:state, :entry)
      |> assign(:phone_visible, false)
      |> assign(:phone_locked, false)
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
      |> assign(:is_new_channel, false)
      |> assign(:monetization_enabled, Monetization.enabled?())
      |> assign(:free_ttl_days, Monetization.free_ttl_days())
      |> assign(:paid_ttl_days, Monetization.paid_ttl_days())
      |> assign(:price_cents, Monetization.price_cents())
      |> assign(:currency, Monetization.currency())
      |> assign(:preselected_tier, nil)
      |> assign(:_pending_phone, "")
      |> assign(:_pending_pin, "")
      |> assign(:editing, false)
      |> assign(:edit_value, "")
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

  # Phone handoff from /steg-number via sessionStorage (keeps phone out of the URL).
  @impl Phoenix.LiveView
  def handle_event("prefill_phone", %{"phone" => phone} = params, socket)
      when is_binary(phone) and phone != "" and byte_size(phone) <= 32 do
    if socket.assigns.state == :entry and socket.assigns._pending_phone == "" do
      # The handoff ships through client-controlled sessionStorage; only accept
      # a known tier token, anything else collapses to nil (=> no auto-advance).
      tier =
        case Map.get(params, "tier") do
          t when t in ["free", "paid"] -> t
          _other -> nil
        end

      {:noreply,
       socket
       |> assign(:_pending_phone, phone)
       |> assign(:preselected_tier, tier)
       |> assign(:phone_locked, true)}
    else
      {:noreply, socket}
    end
  end

  def handle_event("prefill_phone", _params, socket), do: {:noreply, socket}

  @impl Phoenix.LiveView
  def handle_event("toggle_phone_visibility", _params, socket) do
    {:noreply, assign(socket, :phone_visible, !socket.assigns.phone_visible)}
  end

  @impl Phoenix.LiveView
  def handle_event("channel_authenticate", params, socket) do
    %{"room_hash" => room_hash, "access_hash" => access_hash, "sender_hash" => sender_hash} =
      params

    # Optional ISO-3166 alpha-2 country code, derived client-side from the
    # E.164 phone prefix via libphonenumber-js. Used **only** for the
    # aggregate-counter CountryMetrics bump on new-room creation — never
    # stored alongside the room_hash.
    country_iso = Map.get(params, "country_iso")

    case Stelgano.Rooms.join_room(room_hash, access_hash) do
      {:ok, room} ->
        join_existing_room(socket, room, room_hash, sender_hash)

      {:error, :not_found} ->
        start_new_channel_flow(socket, room_hash, access_hash, sender_hash, country_iso)

      {:error, :locked, remaining} ->
        entry_error(socket, "Too many failed attempts. Try again in 30 minutes.", remaining)

      {:error, :unauthorized, remaining} ->
        entry_error(socket, "Could not open this room.", remaining)
    end
  end

  # Client-side phone validation failed. The JS hook calls libphonenumber-js
  # before hashing; anything that doesn't parse as a valid E.164 number is
  # bounced here so the user never reaches the plan-selection screen with a
  # junk input. The server has no plaintext phone to validate itself.
  @impl Phoenix.LiveView
  def handle_event("entry_invalid_phone", _params, socket) do
    entry_error(
      socket,
      "That doesn't look like a valid steg number. Generate one from the steg-number page.",
      nil
    )
  end

  # User chose free tier or skipped — continue to chat.
  # Only valid from :new_channel state; any other state means the room_hash /
  # access_hash assigns are not populated yet (or belong to a different flow).
  @impl Phoenix.LiveView
  def handle_event("continue_free", _params, %{assigns: %{state: :new_channel}} = socket) do
    case Stelgano.Rooms.create_room(socket.assigns.room_hash, "free") do
      {:ok, _room} ->
        # Bump telemetry counters exactly once per new room: the per-country
        # lifetime total (if the client supplied a valid ISO) and the
        # per-day global count.
        if socket.assigns.country_iso,
          do: Stelgano.CountryMetrics.increment_free(socket.assigns.country_iso)

        Stelgano.DailyMetrics.increment_free_new()

        # Now join the newly created room
        case Stelgano.Rooms.join_room(socket.assigns.room_hash, socket.assigns.access_hash) do
          {:ok, room} ->
            socket =
              socket
              |> assign(:state, :connecting)
              |> assign(:room_id, room.id)

            {:noreply,
             push_event(socket, "channel_join_now", %{
               room_id: room.id,
               sender_hash: socket.assigns.sender_hash,
               room_hash: socket.assigns.room_hash,
               phone: socket.assigns._pending_phone
             })}

          {:error, _reason} ->
            {:noreply, assign(socket, :error, "Internal error: Could not join new channel.")}
        end

      {:error, _changeset} ->
        {:noreply, assign(socket, :error, "Internal error: Could not create channel.")}
    end
  end

  def handle_event("continue_free", _params, socket), do: {:noreply, socket}

  # User chose paid tier from the plan-selection screen (new channel).
  @impl Phoenix.LiveView
  def handle_event("choose_paid", _params, %{assigns: %{state: :new_channel}} = socket) do
    {:noreply,
     push_event(socket, "reverse_handoff", %{
       phone: socket.assigns._pending_phone,
       tier: "paid"
     })}
  end

  def handle_event("choose_paid", _params, socket), do: {:noreply, socket}

  # "Extend" button from the chat header — only meaningful once in :chat.
  @impl Phoenix.LiveView
  def handle_event("go_to_upgrade", _params, %{assigns: %{state: :chat}} = socket) do
    {:noreply,
     push_event(socket, "reverse_handoff", %{
       phone: socket.assigns._pending_phone,
       tier: "paid"
     })}
  end

  def handle_event("go_to_upgrade", _params, socket), do: {:noreply, socket}

  # Handle TTL extension from channel redemption
  @impl Phoenix.LiveView
  def handle_event("ttl_extended", %{"ttl_expires_at" => ttl}, socket) do
    {:noreply, assign(socket, :ttl_expires_at, ttl)}
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
      do:
        {:noreply, socket |> assign(:message, %{msg | edited: true}) |> assign(:editing, false)},
      else: {:noreply, assign(socket, :editing, false)}
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
  def handle_event("read_receipt_js", %{"message_id" => mid}, socket) do
    {:noreply, push_event(socket, "read_receipt_js", %{message_id: mid})}
  end

  @impl Phoenix.LiveView
  def handle_event("send_message", _params, socket) do
    {:noreply, push_event(socket, "send_encrypted", %{})}
  end

  @impl Phoenix.LiveView
  def handle_event("start_edit", _params, socket) do
    msg = socket.assigns.message

    if msg && msg.is_mine && !msg.read_at do
      {:noreply,
       socket
       |> assign(:editing, true)
       |> assign(:edit_value, msg.plaintext)
       |> assign(:char_count, String.length(msg.plaintext))
       |> push_event("set_textarea_value", %{value: msg.plaintext})}
    else
      {:noreply, socket}
    end
  end

  @impl Phoenix.LiveView
  def handle_event("cancel_edit", _params, socket) do
    {:noreply, assign(socket, :editing, false)}
  end

  @impl Phoenix.LiveView
  def handle_event("save_edit", _params, socket) do
    msg = socket.assigns.message

    if msg && socket.assigns.editing do
      {:noreply,
       push_event(socket, "edit_message_js", %{
         message_id: msg.id,
         plaintext: socket.assigns.edit_value
       })}
    else
      {:noreply, assign(socket, :editing, false)}
    end
  end

  @impl Phoenix.LiveView
  def handle_event("delete_mine", _params, socket) do
    msg = socket.assigns.message

    if msg && msg.is_mine && !msg.read_at do
      {:noreply, push_event(socket, "delete_message_js", %{message_id: msg.id})}
    else
      {:noreply, socket}
    end
  end

  @impl Phoenix.LiveView
  def handle_event("delete_success", _params, socket) do
    {:noreply, assign(socket, :message, nil)}
  end

  @impl Phoenix.LiveView
  def handle_event("input_change", %{"value" => value}, socket) do
    socket =
      if socket.assigns.editing do
        assign(socket, :edit_value, value)
      else
        socket
      end

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
    <Layouts.app flash={@flash} active_chat={true}>
      <div
        id="chat-root"
        phx-hook="AnonChat"
        class="h-dvh w-screen overflow-hidden bg-slate-950 text-white"
      >
        {render_state(assigns)}
      </div>
    </Layouts.app>
    """
  end

  defp render_state(%{state: :entry} = assigns), do: render_entry(assigns)
  defp render_state(%{state: :deriving} = assigns), do: render_deriving(assigns)
  defp render_state(%{state: :new_channel} = assigns), do: render_new_channel(assigns)
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
          <h1 class="text-4xl sm:text-6xl font-extrabold tracking-tighter text-white font-display leading-[0.9]">
            Open <span class="text-gradient">Chat.</span>
          </h1>
          <p class="text-slate-500 font-medium text-base sm:text-lg leading-relaxed px-4">
            Enter your details below to secure your connection.
          </p>
        </div>

        <.premium_card class="p-1 sm:p-1 overflow-hidden shadow-primary-glow/20">
          <div class="p-5 sm:p-10 space-y-10">
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

            <form
              id="entry-form"
              phx-submit="entry_submit"
              phx-change="entry_change"
              class="space-y-8 sm:space-y-10"
            >
              <%!-- Phone Field --%>
              <div class="space-y-4">
                <div class="flex items-center justify-between px-1">
                  <label class="text-[9px] sm:text-[10px] font-bold uppercase tracking-widest sm:tracking-[0.3em] text-slate-500">
                    Secret Number
                  </label>
                  <%= if @phone_locked do %>
                    <span class="text-[10px] font-mono text-primary font-bold">LOCKED</span>
                  <% end %>
                </div>
                <div class="relative group">
                  <input
                    id="entry-phone"
                    name="phone"
                    type={if @phone_visible or @phone_locked, do: "text", else: "password"}
                    class={[
                      "glass-input w-full pr-14 font-mono text-lg sm:text-xl font-bold bg-slate-950/40",
                      @phone_locked && "opacity-80",
                      if(@phone_visible or @phone_locked,
                        do: "tracking-wider",
                        else: "tracking-widest"
                      )
                    ]}
                    value={@_pending_phone}
                    readonly={@phone_locked}
                    placeholder="Enter number"
                    inputmode="tel"
                    autocomplete="off"
                    autofocus={not @phone_locked}
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
                      class="size-5 sm:size-6"
                    />
                  </button>
                </div>
              </div>

              <%!-- PIN Input --%>
              <div class="space-y-4">
                <div class="flex items-center justify-between px-1">
                  <label class="text-[9px] sm:text-[10px] font-bold uppercase tracking-widest sm:tracking-[0.3em] text-slate-500">
                    Private PIN
                  </label>
                  <span class="text-[9px] sm:text-[10px] font-mono text-slate-500 font-bold whitespace-nowrap">
                    SECURED LOCALLY
                  </span>
                </div>
                <.input
                  id="entry-pin"
                  name="pin"
                  type="password"
                  inputmode="numeric"
                  pattern="[0-9]*"
                  placeholder="Secret PIN"
                  autocomplete="current-password"
                  autofocus={@phone_locked}
                  class="text-center text-xl sm:text-4xl tracking-[0.2em] sm:tracking-[0.6em] font-mono py-4 sm:py-6 bg-slate-950/40 border-white/10"
                />
              </div>

              <button
                id="entry-submit"
                type="submit"
                class="btn-primary w-full py-4 sm:py-5 text-lg sm:text-xl group shadow-[0_20px_40px_-10px_rgba(0,255,163,0.3)]"
              >
                Open Chat
                <.icon
                  name="zap"
                  class="size-5 sm:size-6 group-hover:scale-125 transition-transform"
                />
              </button>
            </form>

            <div class="pt-8 border-t border-white/5 flex flex-col items-center gap-5 text-center">
              <p class="text-slate-400 text-sm font-medium">
                Don't have a secret number yet?
              </p>
              <.link
                navigate={~p"/steg-number"}
                class="btn-secondary w-full py-4 sm:py-5 text-lg sm:text-xl inline-flex items-center justify-center gap-2 group"
              >
                <.icon name="sparkles" class="size-5 text-primary group-hover:rotate-12 transition-transform" />
                Generate New Number
              </.link>
            </div>
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
  # :new_channel — plan selection for new channels (monetization enabled)
  # ---------------------------------------------------------------------------

  defp render_new_channel(assigns) do
    ~H"""
    <div class="flex flex-col items-center justify-center min-h-[calc(100vh-120px)] p-6 animate-in">
      <div class="w-full max-w-lg space-y-10">
        <div class="text-center space-y-4">
          <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-bold uppercase tracking-[0.2em] shadow-[0_0_15px_rgba(0,255,163,0.1)]">
            <.icon name="sparkles" class="size-3" /> New Channel Detected
          </div>
          <h2 class="text-3xl sm:text-4xl font-extrabold text-white font-display tracking-tight">
            This is a new channel.
          </h2>
          <p class="text-slate-400 font-medium leading-relaxed max-w-sm mx-auto">
            Choose how long you want to keep this number active.
          </p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <%!-- Free tier --%>
          <button
            phx-click="continue_free"
            class="glass-card p-8 text-left space-y-4 group hover:border-primary/30 transition-all duration-300 cursor-pointer"
          >
            <div class="size-12 rounded-2xl bg-white/5 flex items-center justify-center border border-white/10 group-hover:bg-primary/10 group-hover:border-primary/20 transition-all">
              <.icon
                name="clock"
                class="size-6 text-slate-400 group-hover:text-primary transition-colors"
              />
            </div>
            <div>
              <h3 class="text-white font-bold text-lg font-display">Temporary</h3>
              <p class="text-slate-500 text-sm font-medium mt-1">
                {@free_ttl_days} days, then recycled
              </p>
            </div>
            <div class="text-2xl font-extrabold text-white font-display">Free</div>
          </button>

          <%!-- Paid tier --%>
          <button
            phx-click="choose_paid"
            class="glass-card p-8 text-left space-y-4 group hover:border-primary/30 transition-all duration-300 cursor-pointer border-primary/10 bg-primary/2"
          >
            <div class="size-12 rounded-2xl bg-primary/10 flex items-center justify-center border border-primary/20 group-hover:scale-110 transition-transform">
              <.icon name="shield_check" class="size-6 text-primary" />
            </div>
            <div>
              <h3 class="text-white font-bold text-lg font-display">Dedicated</h3>
              <p class="text-slate-500 text-sm font-medium mt-1">
                {@paid_ttl_days} days, your number
              </p>
            </div>
            <div class="text-2xl font-extrabold text-primary font-display">
              {format_price(@price_cents, @currency)}<span class="text-sm text-slate-500">/year</span>
            </div>
          </button>
        </div>

        <p class="text-center text-slate-600 text-xs font-medium">
          You can upgrade to a dedicated number at any time from the number generator page.
        </p>
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
    <div class="h-full w-full flex flex-col">
      <%!-- Navigation Header --%>
      <div class="px-4 sm:px-6 py-3 sm:py-5 flex items-center justify-between border-b border-white/10 bg-slate-900/80 backdrop-blur-3xl sticky top-0 z-50">
        <div class="flex items-center gap-3 sm:gap-4">
          <.link navigate={~p"/"} class="wordmark text-lg sm:text-2xl leading-tight group">
            <span class="wm-symbol">s</span><span class="wm-accent">TEL</span><span class="text-white">gano</span>
          </.link>
          <div class="hidden sm:block h-6 w-px bg-white/20"></div>
          <span class="hidden lg:inline text-[9px] font-bold uppercase tracking-[0.3em] text-primary">
            WORKSPACE SECURED
          </span>
        </div>

        <%!-- Session Controls --%>
        <div class="flex items-center gap-1.5 sm:gap-4">
          <button
            class="p-2 sm:p-3 rounded-xl sm:rounded-2xl bg-white/5 hover:bg-white/10 text-white transition-all flex items-center justify-center border border-white/5 shadow-lg"
            phx-click="lock_chat"
            title="Lock session"
          >
            <.icon name="lock" class="size-5 sm:size-6" />
          </button>
          <button
            class="p-2 sm:p-3 rounded-xl sm:rounded-2xl bg-danger/10 hover:bg-danger/20 text-danger transition-all flex items-center justify-center border border-danger/20 shadow-lg shadow-danger/5"
            phx-click="confirm_expire"
            title="Erase all"
          >
            <.icon name="flame" class="size-5 sm:size-6" />
          </button>
          <div class="w-px h-6 bg-white/20 mx-0.5 sm:mx-1"></div>
          <button
            class="p-2 sm:p-3 rounded-xl sm:rounded-2xl bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white transition-all flex items-center justify-center border border-white/5 shadow-lg"
            phx-click="leave_chat"
            title="Exit Chat"
          >
            <.icon name="power" class="size-5 sm:size-6 text-danger" />
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

      <%!-- TTL Expiry Warning --%>
      <%= if @ttl_expires_at && ttl_warning_level(@ttl_expires_at) do %>
        <div class={[
          "px-4 py-2 flex items-center justify-between text-xs font-bold uppercase tracking-widest border-b",
          case ttl_warning_level(@ttl_expires_at) do
            :critical -> "bg-danger/10 border-danger/20 text-danger"
            :warning -> "bg-amber-500/10 border-amber-500/20 text-amber-400"
            _other -> ""
          end
        ]}>
          <span class="flex items-center gap-2">
            <.icon name="alert_triangle" class="size-3" />
            <%= case ttl_warning_level(@ttl_expires_at) do %>
              <% :critical -> %>
                Number expires in less than 12 hours
              <% :warning -> %>
                Number expires in less than 2 days
            <% end %>
          </span>
          <%= if @monetization_enabled do %>
            <button
              type="button"
              phx-click="go_to_upgrade"
              class="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/20 transition-colors text-[10px]"
            >
              Extend
            </button>
          <% end %>
        </div>
      <% end %>

      <%!-- Workspace Message Area --%>
      <div
        class="flex-1 overflow-y-auto px-4 sm:px-6 py-6 sm:py-10 space-y-6 sm:space-y-10 scrollbar-hide"
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
      </div>

      <%!-- User Interaction Zone --%>
      <div class="p-4 sm:p-8 pb-10">
        <%= cond do %>
          <% @editing -> %>
            <.render_input_area
              char_count={@char_count}
              max_chars={@max_chars}
              counter_warn_at={@counter_warn_at}
              counter_danger_at={@counter_danger_at}
              editing={true}
              value={@edit_value}
            />
          <% can_type?(assigns) -> %>
            <.render_input_area
              char_count={@char_count}
              max_chars={@max_chars}
              counter_warn_at={@counter_warn_at}
              counter_danger_at={@counter_danger_at}
              editing={false}
              value=""
            />
          <% true -> %>
            <.render_waiting_area message={@message} typing={@typing_visible} />
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
        "max-w-[85%] sm:max-w-[80%] group space-y-3",
        if(@msg.is_mine, do: "flex flex-col items-end", else: "flex flex-col items-start")
      ]}>
        <div class={[
          "relative p-4 sm:p-8 rounded-2xl sm:rounded-4xl transition-all duration-500 border overflow-hidden",
          if(@msg.is_mine,
            do:
              "bg-linear-to-br from-primary/10 to-emerald-500/5 border-primary/20 rounded-tr-none text-white shadow-[0_10px_30px_-10px_rgba(0,255,163,0.1)]",
            else:
              "bg-slate-900/50 backdrop-blur-xl border-white/5 rounded-tl-none text-slate-200 shadow-inner"
          )
        ]}>
          <p class="relative z-10 whitespace-pre-wrap text-sm sm:text-lg leading-relaxed font-medium tracking-tight">
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
  attr :editing, :boolean, default: false
  attr :value, :string, default: ""

  defp render_input_area(assigns) do
    ~H"""
    <div class="relative group">
      <%!-- Glow focus effect --%>
      <div class={[
        "absolute -inset-1 rounded-[2.5rem] blur-xl opacity-0 group-focus-within:opacity-100 transition-opacity duration-700",
        if(@editing,
          do: "bg-linear-to-r from-amber-500/20 via-orange-400/20 to-amber-500/20",
          else: "bg-linear-to-r from-primary/20 via-emerald-400/20 to-primary/20"
        )
      ]}>
      </div>

      <div class={[
        "relative flex items-end gap-2 sm:gap-3 p-2 sm:p-5 rounded-2xl sm:rounded-4xl bg-slate-900 border-2 transition-all duration-300 shadow-2xl z-50",
        if(@editing,
          do: "border-amber-500/30 group-focus-within:border-amber-500/50",
          else: "border-white/10 group-focus-within:border-primary/50 group-focus-within:bg-slate-950"
        )
      ]}>
        <textarea
          id="chat-textarea"
          class="flex-1 bg-transparent border-none text-white placeholder-slate-500 focus:ring-0 focus:outline-none py-2 sm:py-4 px-2 resize-none max-h-60 min-h-[3rem] sm:min-h-[3.5rem] scrollbar-hide text-base sm:text-lg leading-relaxed font-medium"
          placeholder={if @editing, do: "Revise message...", else: "Construct secure message…"}
          rows="1"
          maxlength={@max_chars}
          phx-hook="AutoResize"
          phx-keyup="input_change"
          phx-update="ignore"
        >{@value}</textarea>

        <div class="flex items-center gap-2 sm:gap-4 pr-1 pb-1">
          <%= if @char_count >= @counter_warn_at do %>
            <div class="hidden sm:flex flex-col items-end mr-2">
              <span class={[
                "text-[10px] font-mono font-bold tracking-widest",
                if(@char_count >= @counter_danger_at, do: "text-danger", else: "text-warning")
              ]}>
                {@char_count}<span class="text-slate-600">/</span>{@max_chars}
              </span>
            </div>
          <% end %>

          <%= if @editing do %>
            <button
              phx-click="cancel_edit"
              class="size-12 sm:size-16 rounded-xl sm:rounded-[1.75rem] bg-white/5 text-slate-400 flex items-center justify-center hover:bg-white/10 transition-all border border-white/10"
              aria-label="Cancel Edit"
            >
              <.icon name="x" class="size-5 sm:size-6" />
            </button>
            <button
              id="btn-save"
              class="size-12 sm:size-16 rounded-xl sm:rounded-[1.75rem] bg-amber-500 text-slate-950 flex items-center justify-center shadow-[0_0_30px_rgba(245,158,11,0.3)] hover:scale-110 active:scale-95 transition-all group"
              phx-click="save_edit"
              aria-label="Update Message"
            >
              <.icon name="check" class="size-6 sm:size-8 transition-transform text-slate-950" />
            </button>
          <% else %>
            <button
              id="btn-send"
              class="size-12 sm:size-16 rounded-xl sm:rounded-[1.75rem] bg-primary text-slate-950 flex items-center justify-center shadow-[0_0_30px_rgba(0,255,163,0.3)] hover:scale-110 active:scale-95 transition-all group disabled:grayscale disabled:opacity-50"
              phx-click="send_message"
              aria-label="Encrypt & Broadcast"
            >
              <.icon
                name="send"
                class="size-6 sm:size-8 -rotate-12 group-hover:rotate-0 transition-transform text-slate-950"
              />
            </button>
          <% end %>
        </div>
      </div>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # Waiting area
  # ---------------------------------------------------------------------------

  attr :message, :map, required: true
  attr :typing, :boolean, default: false

  defp render_waiting_area(assigns) do
    ~H"""
    <div class={[
      "glass-card p-4 sm:p-6 flex flex-col sm:flex-row items-center justify-between gap-6 transition-all duration-700 animate-in relative overflow-hidden group",
      if(@typing,
        do: "border-primary/40 shadow-[0_0_40px_-5px_var(--color-primary-glow)]",
        else: "border-white/5"
      )
    ]}>
      <%!-- Sublte Background Animation --%>
      <div class="absolute inset-0 bg-linear-to-r from-primary/0 via-primary/5 to-primary/0 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-2000 ease-in-out pointer-events-none">
      </div>

      <div class="flex items-center gap-4 sm:gap-6 z-10 w-full sm:w-auto">
        <div class="relative flex items-center justify-center size-10 sm:size-12 shrink-0">
          <div class={[
            "absolute inset-0 rounded-xl blur-lg animate-pulse transition-colors duration-500",
            if(@typing, do: "bg-primary/40", else: "bg-primary/20")
          ]}>
          </div>
          <div class="relative flex gap-1.5 items-center">
            <div class={[
              "size-1.5 sm:size-2 rounded-full animate-bounce transition-colors duration-500",
              if(@typing, do: "bg-primary", else: "bg-primary/60")
            ]}>
            </div>
            <div class={[
              "size-1.5 sm:size-2 rounded-full animate-bounce [animation-delay:0.2s] transition-colors duration-500",
              if(@typing, do: "bg-primary", else: "bg-primary/60")
            ]}>
            </div>
            <div class={[
              "size-1.5 sm:size-2 rounded-full animate-bounce [animation-delay:0.4s] transition-colors duration-500",
              if(@typing, do: "bg-primary", else: "bg-primary/60")
            ]}>
            </div>
          </div>
        </div>
        <div class="space-y-1">
          <p class={[
            "text-[10px] sm:text-xs font-black uppercase tracking-[0.25em] sm:tracking-[0.3em] transition-all duration-500",
            if(@typing,
              do: "text-primary scale-105 origin-left",
              else: "text-slate-400 group-hover:text-primary"
            )
          ]}>
            {if @typing, do: "Node is typing...", else: "Waiting for Reply"}
          </p>
          <p class="text-[8px] sm:text-[10px] text-slate-500 font-medium uppercase tracking-widest transition-opacity duration-500">
            {if @typing,
              do: "Processing incoming sequence...",
              else: "Identity artifacts are locked"}
          </p>
        </div>
      </div>

      <div
        :if={@message && @message.is_mine && is_nil(@message.read_at)}
        class="flex items-center gap-2 sm:gap-3 z-10 w-full sm:w-auto"
      >
        <button
          phx-click="start_edit"
          class="flex-1 sm:flex-none px-4 sm:px-5 py-2 sm:py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white text-[9px] sm:text-[10px] font-bold uppercase tracking-widest transition-all border border-white/5 flex items-center justify-center gap-2"
        >
          <.icon name="edit_3" class="size-3" /> Edit
        </button>
        <button
          phx-click="delete_mine"
          class="flex-1 sm:flex-none px-4 sm:px-5 py-2 sm:py-2.5 rounded-xl bg-danger/10 hover:bg-danger/20 text-danger text-[9px] sm:text-[10px] font-bold uppercase tracking-widest transition-all border border-danger/20 flex items-center justify-center gap-2"
        >
          <.icon name="trash_2" class="size-3" /> Delete
        </button>
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

  defp ttl_warning_level(nil), do: nil

  defp ttl_warning_level(ttl_string) when is_binary(ttl_string) do
    case DateTime.from_iso8601(ttl_string) do
      {:ok, ttl_dt, _offset} ->
        seconds_remaining = DateTime.diff(ttl_dt, DateTime.utc_now(), :second)

        cond do
          seconds_remaining <= 12 * 3600 -> :critical
          seconds_remaining <= 2 * 86_400 -> :warning
          true -> nil
        end

      _error ->
        nil
    end
  end

  defp ttl_warning_level(_other), do: nil

  defp can_type?(%{state: :chat, message: nil}), do: true
  defp can_type?(%{state: :chat, message: %{is_mine: false}}), do: true
  defp can_type?(%{state: :chat, message: %{is_mine: true}}), do: false
  defp can_type?(_assigns), do: false

  # ---------------------------------------------------------------------------
  # channel_authenticate branch helpers
  # ---------------------------------------------------------------------------

  # Room already exists → transition straight to :connecting and push the
  # join event that kicks off the channel handshake client-side.
  defp join_existing_room(socket, room, room_hash, sender_hash) do
    socket =
      socket
      |> assign(:state, :connecting)
      |> assign(:room_id, room.id)
      |> assign(:room_hash, room_hash)
      |> assign(:sender_hash, sender_hash)
      |> assign(:is_new_channel, false)
      |> assign(:error, nil)
      |> assign(:attempts_remaining, nil)

    {:noreply,
     push_event(socket, "channel_join_now", %{
       room_id: room.id,
       sender_hash: sender_hash,
       room_hash: room_hash,
       phone: socket.assigns._pending_phone
     })}
  end

  # Room does not exist → transition to :new_channel and either auto-create
  # (free path / monetization disabled) or wait for the user to pick a tier.
  defp start_new_channel_flow(socket, room_hash, access_hash, sender_hash, country_iso) do
    socket =
      socket
      |> assign(:state, :new_channel)
      |> assign(:room_hash, room_hash)
      |> assign(:access_hash, access_hash)
      |> assign(:sender_hash, sender_hash)
      |> assign(:country_iso, country_iso)
      |> assign(:is_new_channel, true)
      |> assign(:error, nil)
      |> assign(:attempts_remaining, nil)

    if auto_free_new_channel?(socket) do
      handle_event("continue_free", %{}, socket)
    else
      {:noreply, socket}
    end
  end

  defp auto_free_new_channel?(socket) do
    not Monetization.enabled?() or socket.assigns.preselected_tier == "free"
  end

  defp entry_error(socket, message, remaining) do
    socket =
      socket
      |> assign(:state, :entry)
      |> assign(:error, message)
      |> assign(:attempts_remaining, remaining)

    {:noreply, socket}
  end
end
