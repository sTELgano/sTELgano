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
- `Room` — identified by `room_hash` (SHA-256 hex), has `is_active` flag and optional `ttl_expires_at`
- `RoomAccess` — `(room_hash, access_hash)` pairs with failed-attempt lockout (10 attempts → 30min lock)
- `Message` — opaque `ciphertext` + `iv` (binary), `sender_hash`; hard-deleted immediately on reply (N=1)

### Real-time: Phoenix Channels (not LiveView sockets)

Chat uses a raw Phoenix Channel ([anon_room_channel.ex](lib/stelgano_web/channels/anon_room_channel.ex)), not LiveView. Socket ([anon_socket.ex](lib/stelgano_web/channels/anon_socket.ex)) is fully anonymous — no session, no auth cookie.

- Topic: `anon_room:{room_hash}` (64-char lowercase hex)
- Join requires `(room_hash, access_hash, sender_hash)` — all validated as 64-char hex
- Events: `send_message`, `read_receipt`, `edit_message`, `delete_message`, `typing`, `expire_room`
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

[assets/js/hooks/chat.js](assets/js/hooks/chat.js) — LiveView hooks: `AnonChat` (main orchestrator), `AutoResize` (textarea), `IntersectionReader` (read receipts), `PhoneGenerator` (country selector + number generation on `/steg-number` page).

### ChatLive state machine

`ChatLive` uses a single `@state` atom to track the current screen:

```
:entry → :deriving → :connecting → :chat → :locked → :expired
```

- `:entry` — blank form with PIN field (phone pre-populated and read-only when arriving from `/steg-number?phone=`, otherwise editable). Passcode test compliant.
- `:deriving` — three-dot loading while hashes are computed
- `:connecting` — three-dot loading while PBKDF2 derives the encryption key
- `:chat` — active chat with message area, input, and header controls
- `:locked` — PIN re-entry screen (re-derives key without re-joining channel)
- `:expired` — terminal state after room expiry

The `can_type?/1` helper enforces turn-based input: you can type when the room is empty or when the last message is from the other party.

### LiveViews

- `ChatLive` — chat UI; crypto + channel interaction happen in JS hooks, not server-side
- `StegNumberLive` — steg number generator at `/steg-number` with country selector dropdown and "Open channel" flow (copies number to clipboard, navigates to `/chat?phone=<e164>`)
- `AdminDashboardLive` — aggregate metrics at `/admin` (HTTP Basic Auth via `AdminAuth` plug)

### Background jobs (Oban)

- `ExpireTtlRooms` — expires rooms past their TTL and hard-deletes all their messages (hourly)
- Queue: `:maintenance` with 2 workers

### Security plugs

- `SecurityHeaders` — HSTS, X-Robots-Tag, Cache-Control: no-store
- `RateLimiter` — IP-based throttling via PlugAttack (ETS-backed, runs in endpoint before router)
- `AdminAuth` — HTTP Basic Auth for `/admin` scope
- CSP in router: strict `default-src 'self'` with specific allowances for fonts.googleapis.com/gstatic.com
- Panic route: `GET /x` — instant session clear, no confirmation
- Service worker (`priv/static/sw.js`) — privacy-first caching: app shell cache-first, sensitive routes (`/chat`, `/steg-number`) network-only, panic route (`/x`) clears all caches

### Routes

- `/` — homepage; `/security`, `/privacy`, `/terms`, `/about` — static pages
- `/spec` — sTELgano-std-1 protocol specification
- `/blog` — blog index; `/blog/:slug` — individual blog posts
- `/chat` — anonymous chat LiveView; accepts optional `?phone=<e164>` query param to pre-populate phone field
- `/steg-number` — steg number generator
- `/admin` — admin dashboard (behind `:admin_auth` pipeline)
- `/.well-known/security.txt` — security disclosure info
- `/dev/dashboard`, `/dev/mailbox` — dev-only tools (not compiled in prod)

## Key conventions

- All IDs are binary UUIDs (`binary_id: true`); all timestamps are `utc_datetime`
- Use `Req` for HTTP requests (already included), not HTTPoison/Tesla/httpc
- Tailwind CSS v4 — no `tailwind.config.js`; uses `@import "tailwindcss"` syntax in `app.css`
- Write Tailwind-based components manually — do NOT use daisyUI components
- No inline `<script>` tags in templates (except theme bootstrap and SW registration in root layout) — use colocated JS hooks or external hooks in `assets/js/`
- No third-party analytics, tracking pixels, or external scripts — CSP enforces this
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

Salts (`ROOM_SALT`, `ACCESS_SALT`, `SENDER_SALT`, `ENC_SALT`) are public constants in client JS; optionally overridable via env vars for self-hosters. Rotating salts is a breaking change.

## Testing

Target: 90% minimum coverage (CI-enforced via ExCoveralls). Test layers:
- Unit: ExUnit for Rooms context and schemas
- Integration: `Phoenix.ChannelTest` for channel, `Phoenix.LiveViewTest` + `LazyHTML` for LiveViews
- Security headers tests verify CSP and all response headers

Run `mix precommit` before submitting changes — it runs the full quality suite.

## Design system

Dark-first glassmorphism UI. All surfaces use `backdrop-filter: blur(16px)` with translucent dark backgrounds. Accent colour is emerald green (`#10B981`).

**Fonts:** Outfit (display/headings), Inter (body/UI), JetBrains Mono (code/hashes). Loaded via Google Fonts CDN.

**Key CSS tokens:** `--color-primary` (#10B981), `--bg-dark` (#030712), `--text-main` (#f9fafb), `--text-muted` (#9ca3af), `--color-surface` (rgba(17,24,39,0.6)), `--color-surface-border` (rgba(255,255,255,0.1)).

**Component classes:** `.glass-panel`, `.glass-input`, `.glass-button`, `.btn-ghost`, `.btn-danger`, `.btn-icon`, `.entry-card`, `.chat-layout`, `.bubble.sent`, `.bubble.received`, `.modal-card`, `.lock-overlay`, `.wordmark`.

**Chat bubble geometry:** sent `border-radius: 1.5rem 1.5rem 0.25rem 1.5rem` (24px with 4px tail bottom-right), received `1.5rem 1.5rem 1.5rem 0.25rem` (4px tail bottom-left). Sent uses emerald gradient, received uses frosted glass.

**Touch targets:** 56px minimum height on interactive elements (exceeds WCAG 44px). All motion respects `prefers-reduced-motion`. Mobile-first: 320px minimum width.

**SessionStorage keys** (5 items, cleared on logout/panic/room-expiry):
- `stelegano_phone`, `stelegano_room_id`, `stelegano_room_hash`, `stelegano_sender_hash`, `stelegano_access_hash`
