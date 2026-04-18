# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

sTELgano is a privacy-focused anonymous messaging app and open protocol (sTELgano-std-1) built with Elixir/Phoenix 1.8. It implements *contact-layer steganography* — two people share a "steg number" (a random phone number saved in each other's contacts) and each picks a PIN. All cryptography happens client-side via the Web Crypto API. The server only sees SHA-256 hashes and AES-256-GCM ciphertext.

**Core invariant (N=1):** At most one message exists per room at any time. Replies atomically delete the previous message in a single DB transaction. No history exists anywhere.

**Threat model:** Protects against intimate-access attackers (partner, family member with device access). Explicitly does NOT protect against governments or law enforcement. This honesty is stated throughout the product.

**Passcode test:** Every design decision must pass: "A suspicious partner unlocks your phone and opens sTELgano. What do they see?" Answer: a blank entry screen with two fields. Nothing else.

## Common commands

```bash
mix setup              # deps + DB create/migrate + seed + assets
mix phx.server         # dev server at http://localhost:4000
mix test               # run all tests (auto-creates/migrates DB)
mix test path/to/test.exs           # single test file
mix test path/to/test.exs:42        # single test at line
mix test --failed                   # re-run previously failed tests
mix precommit          # compile (warnings-as-errors) + unlock unused deps + format + credo --strict + test
mix credo --strict     # static analysis
mix dialyzer           # type checking (PLTs in priv/plts/)
mix sobelow --config   # Phoenix security scanning
mix format             # code formatting
mix ecto.migrate       # run pending migrations
mix ecto.reset         # drop + create + migrate + seed
mix ecto.gen.migration migration_name  # generate migration with correct timestamp
```

## Architecture

### Domain layer: `Stelgano.Rooms` context

Single context module ([rooms.ex](lib/stelgano/rooms.ex)) owns all business logic. Server-blindness: no function accepts plaintext phone numbers or PINs — only opaque hashes.

Schemas in [lib/stelgano/rooms/](lib/stelgano/rooms/):
- `Room` — identified by `room_hash` (SHA-256 hex), has `is_active` flag, `tier` ("free"/"paid"), and optional `ttl_expires_at`
- `RoomAccess` — `(room_hash, access_hash)` pairs with failed-attempt lockout (10 attempts → 30min lock). Hard-deleted when the room expires so the DB carries no long-term linkability of past attempts. See [rooms.ex](lib/stelgano/rooms.ex) `expire_room/1`.
- `Message` — opaque `ciphertext` + `iv` (binary), `sender_hash`; hard-deleted immediately on reply (N=1). Enforced both at the application layer (delete-then-insert in `Rooms.send_message/4`) and at the DB layer (`UNIQUE` index on `messages.room_id`) — the second guard catches concurrent inserts from two different senders under READ COMMITTED.

### Real-time: Phoenix Channels (not LiveView sockets)

Chat uses a raw Phoenix Channel ([anon_room_channel.ex](lib/stelgano_web/channels/anon_room_channel.ex)), not LiveView. Socket ([anon_socket.ex](lib/stelgano_web/channels/anon_socket.ex)) is fully anonymous — no session, no auth cookie.

- Topic: `anon_room:{room_hash}` (64-char lowercase hex)
- Join requires `(room_hash, access_hash, sender_hash)` — all validated as 64-char hex
- Events: `send_message`, `read_receipt`, `edit_message`, `delete_message`, `typing`, `expire_room`, `redeem_extension`
- Max ciphertext: 8,192 bytes (base64-encoded)

### Client-side crypto

[assets/js/crypto/anon.js](assets/js/crypto/anon.js) — **single source of truth** for all cryptographic constants and operations. Zero external libraries. Changing any constant is a breaking change (all existing rooms become inaccessible).

```
room_hash   = SHA-256(normalise(phone) + ":" + ROOM_SALT)
access_hash = SHA-256(normalise(phone) + ":" + PIN + ":" + ACCESS_SALT)
enc_key     = PBKDF2(phone, room_id + ENC_SALT, 600_000 iter, SHA-256, 256-bit)
sender_hash = SHA-256(normalise(phone) + ":" + access_hash + ":" + room_hash + ":" + SENDER_SALT)
```

PIN is NOT part of enc_key (both users need the same key but have different PINs). The access_hash IS part of sender_hash so that two users with the same phone but different PINs produce different sender identities. 600,000 PBKDF2 iterations = OWASP 2023 recommendation.

`phone-number-generator-js` npm package — steg number generator (E.164 format, 227 countries supported via `CountryNames` enum). Installed in `assets/package.json`. Replaces the former custom `phone-gen.js`.

[assets/js/hooks/chat.js](assets/js/hooks/chat.js) — LiveView hooks: `AnonChat` (main orchestrator; also reads `stelegano_handoff_phone` on mount), `AutoResize` (textarea), `IntersectionReader` (read receipts), `PaymentInitiator` (extension token generation + payment initiation), `PhoneGenerator` (country selector + number generation on `/steg-number` page), `CountryPersistence` (remembers last-picked country in sessionStorage), `ChannelHandoff` (phone handoff from `/steg-number` → `/chat` without touching the URL).

### ChatLive state machine

`ChatLive` uses a single `@state` atom to track the current screen:

```
:entry → :deriving → :new_channel (if monetization) → :connecting → :chat → :locked → :expired
```

- `:entry` — form with phone + PIN fields. Phone is pre-populated and read-only when handed off from `/steg-number` (via the `stelegano_handoff_phone` sessionStorage key → `prefill_phone` hook event), otherwise editable for returning to existing channels. Passcode test compliant.
- `:deriving` — three-dot loading while hashes are computed
- `:new_channel` — plan selection screen (free/paid) shown when monetization is enabled and a new room was just created. Helps detect mistyped numbers.
- `:connecting` — three-dot loading while PBKDF2 derives the encryption key
- `:chat` — active chat with message area, input, and header controls
- `:locked` — PIN re-entry screen (re-derives key without re-joining channel)
- `:expired` — terminal state after room expiry

The `can_type?/1` helper enforces turn-based input: you can type when the room is empty or when the last message is from the other party.

### LiveViews

- `ChatLive` — chat UI; crypto + channel interaction happen in JS hooks, not server-side
- `StegNumberLive` — steg number generator at `/steg-number` with country selector dropdown and "Open channel" flow (copies number to clipboard, writes it to `sessionStorage.stelegano_handoff_phone`, then navigates to `/chat`). The phone **never** appears in the URL — see the `ChannelHandoff` hook.
- `AdminDashboardLive` — aggregate metrics at `/admin` (HTTP Basic Auth via `AdminAuth` plug)

### Monetization layer: `Stelgano.Monetization`

Fully optional (disabled by default). When enabled, steg numbers have a free TTL (default 7 days). Users can purchase a dedicated number (default 1 year, $2.00) via a blind token protocol.

**Privacy guarantee:** The `extension_tokens` table has **no `room_id` column**. The server cannot link a payment to a specific room. Correlation exists only ephemerally in memory during the channel `redeem_extension` event.

Key modules:
- `Stelgano.Monetization` — config accessors, token lifecycle, redemption logic
- `Stelgano.Monetization.ExtensionToken` — Ecto schema for payment tokens (pending → paid → redeemed)
- `Stelgano.Monetization.PaymentProvider` — behaviour for payment gateway adapters
- `Stelgano.Monetization.Providers.Paystack` — Paystack adapter (hosted checkout + webhook verification)

Payment flow:
1. Client generates random `extension_secret`, computes `token_hash = SHA-256(secret)`
2. Server stores `token_hash` in `extension_tokens` (no room link), redirects to Paystack
3. Paystack webhook marks token as `paid`
4. Client sends `extension_secret` via channel `redeem_extension` event
5. Server hashes it, finds matching paid token, extends room TTL — token table still has no room_id

### Background jobs (Oban)

- `ExpireTtlRooms` — expires rooms past their TTL and hard-deletes all their messages (hourly)
- `ExpireUnredeemedTokens` — expires stale payment tokens (daily at 03:00 UTC)
- Queue: `:maintenance` with 2 workers

### Security plugs

- `SecurityHeaders` — HSTS, X-Robots-Tag, Cache-Control: no-store
- `RateLimiter` — IP-based throttling via PlugAttack (ETS-backed, runs in endpoint before router)
- `AdminAuth` — HTTP Basic Auth for `/admin` scope
- CSP in router: strict `default-src 'self'` with specific allowances for fonts.googleapis.com/gstatic.com. `script-src` uses a **per-request nonce** ([CspNonce plug](lib/stelgano_web/plugs/csp_nonce.ex)) — *not* `'unsafe-inline'` — so attacker-injected inline scripts cannot execute. The only legitimate inline script (service-worker cleanup in `root.html.heex`) carries `nonce={@csp_nonce}`. `style-src` keeps `'unsafe-inline'` because LiveView emits inline `style` attributes for animations — acceptable since inline styles cannot execute JS.
- Panic route: `GET /x` — instant session clear, no confirmation

### Routes

- `/` — homepage; `/security`, `/privacy`, `/terms`, `/about` — static pages
- `/spec` — sTELgano-std-1 protocol specification
- `/blog` — blog index; `/blog/:slug` — individual blog posts
- `/chat` — anonymous chat LiveView. No URL parameters accepted. Phone may be pre-populated only via the `stelegano_handoff_phone` sessionStorage key (set by `/steg-number` just before navigation, read & cleared once by the `AnonChat` hook on mount).
- `/steg-number` — steg number generator
- `/admin` — admin dashboard (behind `:admin_auth` pipeline)
- `/payment/callback` — post-payment redirect from Paystack
- `/api/webhooks/paystack` — Paystack webhook endpoint (HMAC-SHA512 verified)
- `/.well-known/security.txt` — security disclosure info
- `/dev/dashboard`, `/dev/mailbox` — dev-only tools (not compiled in prod)

## Key conventions

- All IDs are binary UUIDs (`binary_id: true`); all timestamps are `utc_datetime`
- Use `Req` for HTTP requests (already included), not HTTPoison/Tesla/httpc
- Tailwind CSS v4 — no `tailwind.config.js`; uses `@import "tailwindcss"` syntax in `app.css`
- Write Tailwind-based components manually — do NOT use daisyUI components
- No inline `<script>` tags in templates (except theme bootstrap in root layout) — use colocated JS hooks or external hooks in `assets/js/`
- No third-party analytics, tracking pixels, or external scripts — CSP enforces this
- **No PWA. sTELgano is a pure web app.** No `manifest.json`, no `<link rel="manifest">`, no `theme-color` meta, no service worker, no installable app icon. Rationale: every PWA surface (install banners, app drawers, `chrome://apps`, iOS home-screen long-press menus) is a passcode-test failure — an intimate-access attacker inspecting the device sees the app's name, description, and category, which breaks the "blank entry screen" invariant. Anyone shipping a PWA variant would need to ship a separate fork with neutral branding.
- AGPL-3.0 licence; all source files need SPDX header: `# SPDX-License-Identifier: AGPL-3.0-only`
- UI terminology: "steg number" (technical), "the number in your contacts" (user-facing); "channel" not "conversation"
- "Room" is used only in internal code/DB, not user-facing copy

## Database

PostgreSQL with binary UUIDs. Migrations in [priv/repo/migrations/](priv/repo/migrations/). Oban jobs table migrated alongside app tables.

## Environment variables (production)

| Variable | Required | Purpose |
|----------|----------|---------|
| `SECRET_KEY_BASE` | Yes | Phoenix session signing |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PHX_HOST` | Yes | Production hostname |
| `POOL_SIZE` | No | DB connection pool size |
| `MONETIZATION_ENABLED` | No | Set to `true` to enable paid tiers |
| `PAYSTACK_SECRET_KEY` | If monetization | Paystack secret key |
| `PAYSTACK_PUBLIC_KEY` | If monetization | Paystack public key |
| `PAYSTACK_CALLBACK_URL` | If monetization | Post-payment redirect URL |
| `FREE_TTL_DAYS` | No | Free tier TTL (default: 7) |
| `PAID_TTL_DAYS` | No | Paid tier TTL (default: 365) |
| `PRICE_CENTS` | No | Price in smallest currency unit (default: 200) |
| `PAYMENT_CURRENCY` | No | ISO 4217 currency code (default: USD) |

Salts (`ROOM_SALT`, `ACCESS_SALT`, `SENDER_SALT`, `ENC_SALT`) are public constants in client JS; optionally overridable via env vars for self-hosters. Rotating salts is a breaking change.

## Testing

Target: 90% minimum coverage (CI-enforced via ExCoveralls). Test layers:
- Unit: ExUnit for Rooms context and schemas
- Integration: `Phoenix.ChannelTest` for channel, `Phoenix.LiveViewTest` + `LazyHTML` for LiveViews
- Security headers tests verify CSP and all response headers

Run `mix precommit` before submitting changes — it runs the full quality suite.

## Design system

Dark-first glassmorphism UI. All surfaces use `backdrop-filter: blur(16px)` with translucent dark backgrounds. Accent colour is emerald green (`#10B981`).

**Fonts:** Outfit (display/headings), Inter (body/UI), JetBrains Mono (code/hashes). **Self-hosted** — Latin-normal WOFF2 files live in [priv/static/fonts/](priv/static/fonts/), sourced from the Fontsource npm packages (`@fontsource/inter`, `@fontsource/outfit`, `@fontsource/jetbrains-mono`). Not loaded from Google Fonts CDN — doing so would ping `fonts.googleapis.com` / `fonts.gstatic.com` on every pageload and leak IP + UA + timestamp to Google. `font-src` and `style-src` in CSP are locked to `'self'`.

**Key CSS tokens:** `--color-primary` (#10B981), `--bg-dark` (#030712), `--text-main` (#f9fafb), `--text-muted` (#9ca3af), `--color-surface` (rgba(17,24,39,0.6)), `--color-surface-border` (rgba(255,255,255,0.1)).

**Component classes:** `.glass-panel`, `.glass-input`, `.glass-button`, `.btn-ghost`, `.btn-danger`, `.btn-icon`, `.entry-card`, `.chat-layout`, `.bubble.sent`, `.bubble.received`, `.modal-card`, `.lock-overlay`, `.wordmark`.

**Chat bubble geometry:** sent `border-radius: 1.5rem 1.5rem 0.25rem 1.5rem` (24px with 4px tail bottom-right), received `1.5rem 1.5rem 1.5rem 0.25rem` (4px tail bottom-left). Sent uses emerald gradient, received uses frosted glass.

**Touch targets:** 56px minimum height on interactive elements (exceeds WCAG 44px). All motion respects `prefers-reduced-motion`. Mobile-first: 320px minimum width.

**SessionStorage keys** (cleared on logout/panic/room-expiry):
- Session state (6 keys, persisted across lock/re-auth): `stelegano_phone`, `stelegano_room_id`, `stelegano_room_hash`, `stelegano_sender_hash`, `stelegano_access_hash`, `stelegano_extension_secret`
- Transient (read-once): `stelegano_handoff_phone` — set by `/steg-number` just before navigation, read & deleted by `AnonChat.mounted()` on `/chat`. Keeps the phone out of the URL, address bar, history, and server logs.
- UX preference (persists across sessions): `stelgano_selected_country` — last-picked country on `/steg-number`.
