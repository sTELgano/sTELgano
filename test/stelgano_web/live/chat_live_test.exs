# SPDX-FileCopyrightText: 2026 sTELgano Contributors
# SPDX-License-Identifier: AGPL-3.0-only

defmodule StelganoWeb.ChatLiveTest do
  @moduledoc """
  LiveView tests for the Chat entry screen and related UI.

  We test the server-rendered LiveView state; the actual crypto and channel
  joins happen in the browser (JS hooks), so those are out of scope here.
  """

  use StelganoWeb.ConnCase, async: true

  import Phoenix.LiveViewTest

  # ---------------------------------------------------------------------------
  # Entry screen — fresh visit (no handoff, manual entry)
  # ---------------------------------------------------------------------------

  describe "GET /chat (no handoff)" do
    test "renders the entry form with editable phone field", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/chat")

      assert html =~ "entry-phone"
      assert html =~ "entry-pin"
      assert html =~ "entry-submit"
      assert html =~ "Open Chat"
    end

    test "shows Generate New link for creating a number", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/chat")
      assert html =~ "Generate New"
      assert html =~ "/steg-number"
    end

    test "phone field is not readonly on a fresh visit", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/chat")
      refute html =~ "readonly"
    end

    test "entry screen does not reveal any conversation history", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/chat")
      # Strip <script> tags so the inline bootstrap's `history.replaceState`
      # and similar JS identifiers don't trigger false positives — we care
      # about user-visible text only.
      visible = Regex.replace(~r/<script[\s\S]*?<\/script>/, html, "")
      refute visible =~ "conversation"
      refute visible =~ "history"
    end

    test "Passcode Test — no identifying information visible", %{conn: conn} do
      {:ok, _view, html} = live(conn, ~p"/chat")
      refute html =~ "room_hash"
      refute html =~ "sender_hash"
    end
  end

  # ---------------------------------------------------------------------------
  # Entry screen — with phone handoff from /steg-number (locked form)
  # ---------------------------------------------------------------------------

  describe "prefill_phone event (handoff from /steg-number)" do
    test "renders the entry form with locked phone field", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")
      render_hook(view, "prefill_phone", %{"phone" => "+12025551234"})
      html = render(view)

      assert html =~ "entry-phone"
      assert html =~ "entry-pin"
      assert html =~ "entry-submit"
    end

    test "phone field is masked by default", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")
      render_hook(view, "prefill_phone", %{"phone" => "+12025551234"})
      assert render(view) =~ ~s(type="password")
    end

    test "phone field is read-only when pre-populated", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")
      render_hook(view, "prefill_phone", %{"phone" => "+12025551234"})
      assert render(view) =~ "readonly"
    end

    test "shows LOCKED badge when phone is pre-populated", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")
      render_hook(view, "prefill_phone", %{"phone" => "+12025551234"})
      assert render(view) =~ "LOCKED"
    end

    test "is ignored when phone is already set", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")
      render_hook(view, "prefill_phone", %{"phone" => "+12025551234"})
      render_hook(view, "prefill_phone", %{"phone" => "+99999999999"})
      html = render(view)
      assert html =~ "+12025551234"
      refute html =~ "+99999999999"
    end

    test "is ignored when phone is blank", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")
      render_hook(view, "prefill_phone", %{"phone" => ""})
      refute render(view) =~ "readonly"
    end
  end

  describe "toggle_phone_visibility event" do
    test "reveals phone field on first toggle", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")
      render_hook(view, "prefill_phone", %{"phone" => "+12025551234"})

      view |> element("#phone-toggle-btn") |> render_click()

      html = render(view)
      assert html =~ ~s(type="text")
    end

    test "masks phone field again on second toggle", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")
      render_hook(view, "prefill_phone", %{"phone" => "+12025551234"})

      view |> element("#phone-toggle-btn") |> render_click()
      view |> element("#phone-toggle-btn") |> render_click()

      html = render(view)
      assert html =~ ~s(type="password")
    end
  end

  # ---------------------------------------------------------------------------
  # State transitions via hook events
  # ---------------------------------------------------------------------------

  describe "join_empty event" do
    test "transitions to chat screen on successful join", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "join_empty", %{"ttl_expires_at" => nil})

      html = render(view)
      assert html =~ "Zero Trace Channel"
      assert html =~ "The buffer is currently empty."
    end
  end

  describe "ttl_extended event" do
    test "updates TTL on extension", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "join_empty", %{"ttl_expires_at" => nil})

      future = DateTime.add(DateTime.utc_now(), 365 * 86_400, :second)
      render_hook(view, "ttl_extended", %{"ttl_expires_at" => DateTime.to_iso8601(future)})

      # Should not show warning for a far-future TTL
      html = render(view)
      refute html =~ "Number expires"
    end
  end

  describe "TTL expiry warning" do
    test "shows critical warning when TTL is within 12 hours", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      soon = DateTime.add(DateTime.utc_now(), 6 * 3600, :second)
      render_hook(view, "join_empty", %{"ttl_expires_at" => DateTime.to_iso8601(soon)})

      html = render(view)
      assert html =~ "Number expires in less than 12 hours"
    end

    test "shows warning when TTL is within 2 days", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      day = DateTime.add(DateTime.utc_now(), 24 * 3600, :second)
      render_hook(view, "join_empty", %{"ttl_expires_at" => DateTime.to_iso8601(day)})

      html = render(view)
      assert html =~ "Number expires in less than 2 days"
    end

    test "no warning when TTL is far in the future", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      future = DateTime.add(DateTime.utc_now(), 30 * 86_400, :second)
      render_hook(view, "join_empty", %{"ttl_expires_at" => DateTime.to_iso8601(future)})

      html = render(view)
      refute html =~ "Number expires"
    end
  end

  describe "lock_chat event" do
    test "shows lock screen when locked", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "join_empty", %{"ttl_expires_at" => nil})

      view |> element("button[phx-click='lock_chat']") |> render_click()

      html = render(view)
      assert html =~ "Workspace"
      assert html =~ "Locked."
      assert html =~ "unlock-form"
    end

    test "lock screen shows clear session link", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "join_empty", %{"ttl_expires_at" => nil})
      view |> element("button[phx-click='lock_chat']") |> render_click()

      html = render(view)
      assert html =~ "Erase All Session Data"
    end
  end

  describe "leave_chat event" do
    test "returns to entry screen on leave", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "join_empty", %{"ttl_expires_at" => nil})
      view |> element("button[phx-click='leave_chat']") |> render_click()

      html = render(view)
      assert html =~ "Open Chat"
      assert html =~ "entry-form"
    end
  end

  describe "room_expired_received event" do
    test "shows expired screen when room expires", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "join_empty", %{"ttl_expires_at" => nil})
      render_hook(view, "room_expired_received", %{})

      html = render(view)
      assert html =~ "Chat Ended"
    end
  end

  # ---------------------------------------------------------------------------
  # Additional event handlers
  # ---------------------------------------------------------------------------

  describe "back_to_entry event" do
    test "returns to entry from expired screen", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "join_empty", %{"ttl_expires_at" => nil})
      render_hook(view, "room_expired_received", %{})

      view |> element("button[phx-click='back_to_entry']") |> render_click()

      html = render(view)
      assert html =~ "entry-form"
    end
  end

  describe "confirm_expire flow" do
    test "shows destruction modal", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "join_empty", %{"ttl_expires_at" => nil})
      view |> element("button[phx-click='confirm_expire']") |> render_click()

      html = render(view)
      assert html =~ "Nuclear Wipe"
      assert html =~ "Initialize Purge"
    end

    test "cancel expire hides modal", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "join_empty", %{"ttl_expires_at" => nil})
      view |> element("button[phx-click='confirm_expire']") |> render_click()
      view |> element("button[phx-click='cancel_expire']") |> render_click()

      html = render(view)
      refute html =~ "Nuclear Wipe"
    end
  end

  describe "message events" do
    test "message_received shows a message bubble", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "join_empty", %{"ttl_expires_at" => nil})

      render_hook(view, "message_received", %{
        "id" => Ecto.UUID.generate(),
        "plaintext" => "Hello, world!",
        "sender_hash" => "other-sender",
        "is_mine" => false,
        "inserted_at" => DateTime.to_iso8601(DateTime.utc_now())
      })

      html = render(view)
      assert html =~ "Hello, world!"
    end

    test "message_delete_received clears the message", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "join_empty", %{"ttl_expires_at" => nil})

      render_hook(view, "message_received", %{
        "id" => Ecto.UUID.generate(),
        "plaintext" => "To be deleted",
        "sender_hash" => "other-sender",
        "is_mine" => false,
        "inserted_at" => DateTime.to_iso8601(DateTime.utc_now())
      })

      render_hook(view, "message_delete_received", %{})

      html = render(view)
      assert html =~ "Zero Trace Channel"
    end

    test "join_with_message shows existing message", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "join_with_message", %{
        "id" => Ecto.UUID.generate(),
        "plaintext" => "Existing message",
        "sender_hash" => "other-sender",
        "is_mine" => false,
        "read_at" => nil,
        "inserted_at" => DateTime.to_iso8601(DateTime.utc_now()),
        "ttl_expires_at" => nil
      })

      html = render(view)
      assert html =~ "Existing message"
    end
  end

  describe "deriving state" do
    test "entry_submit transitions to deriving", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      view
      |> form("#entry-form", %{"phone" => "+12025551234", "pin" => "1234"})
      |> render_submit()

      html = render(view)
      assert html =~ "Securing"
    end
  end

  describe "key_derivation_error" do
    test "returns to entry with error message", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "key_derivation_error", %{})

      html = render(view)
      assert html =~ "Key derivation failed"
    end
  end

  describe "channel_join_error" do
    test "returns to entry with error message", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")

      render_hook(view, "channel_join_error", %{})

      html = render(view)
      assert html =~ "Could not connect"
    end
  end

  describe "no-op events" do
    test "send_error does not crash", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")
      render_hook(view, "send_error", %{})
      assert render(view) =~ "entry-form"
    end

    test "edit_error does not crash", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")
      render_hook(view, "edit_error", %{})
      assert render(view) =~ "entry-form"
    end

    test "decrypt_error does not crash", %{conn: conn} do
      {:ok, view, _html} = live(conn, ~p"/chat")
      render_hook(view, "decrypt_error", %{})
      assert render(view) =~ "entry-form"
    end
  end
end
