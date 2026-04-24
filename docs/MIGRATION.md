<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# v2 Rewrite — Phoenix to Cloudflare Workers + Durable Objects + D1

This document is the canonical record of the migration from the Phoenix/Elixir
implementation of sTELgano (v1) to a Cloudflare Workers + Durable Objects + D1
implementation (v2). It exists so that future-me — or any maintainer who picks
this up months from now — can understand *why* the rewrite is happening, *how*
the two branches are being managed during the transition, *what* the new
architecture looks like, and *what carries over unchanged*.

If you only read one section, read **Why this rewrite** and **Branch
strategy**. Everything else is reference.

---

## Why this rewrite

The constraints that drove the decision, in priority order:

1. **Solo dev, no on-call rotation possible.** A self-hosted Phoenix + Postgres
   stack on a DigitalOcean droplet — even refactored to be architecturally
   ideal — still requires a human to handle OS patches, Postgres backups and
   upgrades, cert renewal monitoring, disk-fill alerts, log rotation, systemd
   recovery, OOM events, and the inevitable 3am incident. None of that can be
   on one person's plate sustainably.

2. **No-ops is a hard requirement, not a preference.** "I'll automate the ops"
   is itself ops. The only stack that genuinely delivers no-ops is one where
   the platform is responsible for all of it. CF Workers + DO + D1 fits this.
   Phoenix on Fly / Render / Gigalixir reduces ops but doesn't eliminate it
   (you still own Postgres, monitor machines, handle deploy issues).

3. **Global presence matters.** The product targets users worldwide. Phoenix
   on a single droplet has one location. Phoenix on Fly multi-region works for
   reads but every chat write hits a single Postgres primary, so distant users
   pay the cross-continent hop on every message. CF DOs instantiate near the
   first user who joins the room and the second user connects to that same DO
   from wherever they are — there is no global database to phone home to.

4. **The N=1 invariant maps cleanly to a single-threaded actor.** Today the
   "at most one message per room" guarantee is enforced by a Postgres `UNIQUE`
   index plus a delete-then-insert transaction in
   `lib/stelgano/rooms.ex:send_message/4`. A Durable Object is single-threaded
   by definition; the invariant becomes a property of the runtime instead of a
   guarded property of the database. This is the architectural argument for
   the rewrite — but it would not be sufficient on its own. Solo + no-ops +
   global is what tipped it.

### Why not "Phoenix + GenServer-per-room" instead

This was seriously considered. A `Stelgano.RoomServer` GenServer keyed by
`room_hash`, supervised under a `DynamicSupervisor` + `Registry`, hibernating
on idle and persisting via Postgres write-behind, would deliver the same
single-threaded-per-room property without leaving Elixir. The refactor would
take ~2 weeks instead of ~2–3 months.

It was rejected because **it solves the architecture problem but does nothing
about ops**. The droplet, Postgres, certs, nginx, systemd are all still there.
For a different priority ordering (preserve existing investment, minimize
rewrite cost) it would be the right call.

### Why not other stacks

| Option | Why rejected |
|---|---|
| Phoenix on Fly.io | Multi-region writes still hit a single Postgres primary; not actually no-ops (Postgres + machines are still yours); marginal vs. status quo |
| Phoenix on Render / Gigalixir | Same as Fly: less ops than self-hosted but not no-ops; single region |
| Bun / Deno Deploy + custom actors | Hand-rolling what OTP / DOs do for free; no benefit |
| Supabase / Convex / Firebase | Wrong direction — they include auth, opinionated data layers, and analytics surfaces that fight the passcode test |
| PartyKit | DOs with a wrapper, owned by Cloudflare; if you want DOs, use DOs directly |
| Pure WebRTC P2P, no server | Changes product semantics — both parties must be online simultaneously; sTELgano's actual usage is store-and-forward |
| Nostr / libp2p | Wrong data model (append-only event log vs. N=1 single-message-per-room) |
| Self-hosted Matrix / XMPP | Wrong threat model — designed around server-side state, federation, history |

---

## Branch strategy

### Current state (during v2 development)

- `main` — Phoenix/Elixir implementation, v1, **active maintenance**.
  Continues to receive bug fixes, security patches, dep bumps, and any
  cross-cutting updates (spec, threat-model docs, design tweaks).
- `v2-cloudflare` — this branch. CF Workers + DO + D1 rewrite. Active
  development. **Not yet deployed anywhere.**

Cross-cutting changes (spec edits, threat-model wording, design system) made
on `main` should be periodically merged forward into `v2-cloudflare`:

```bash
git checkout v2-cloudflare
git merge main
# resolve any conflicts; usually only docs/ and CLAUDE.md are affected
```

Do this often enough that the merge is small. Quarterly at minimum, monthly
ideally. A long-divergence merge with hundreds of conflicting Elixir/TS files
is the failure mode to avoid.

### At cutover (when v2 is production-ready)

The cutover is a single coordinated sequence. Run it when v2 has reached
feature parity, has been smoke-tested on a `*.workers.dev` URL, and the
production domain is ready to swap.

```bash
# Step 1: snapshot v1 as a long-lived branch (NOT just a tag — we keep
# pushing commits to it after cutover for security/maintenance work)
git checkout main && git pull
git branch v1-elixir
git push -u origin v1-elixir

# Step 2: tag the cutover moment for permanent reference
git tag -a v1-elixir-cutover -m "Final state of Phoenix/Elixir implementation when CF v2 became canonical"
git push origin v1-elixir-cutover

# Step 3: replace main's tree with v2-cloudflare's tree, single commit
git checkout main
git rm -rf .
git checkout v2-cloudflare -- .
git commit -m "Migrate to Cloudflare Workers + Durable Objects + D1

Replaces the Phoenix/Elixir implementation. The previous tree is preserved
on the v1-elixir branch and tagged at v1-elixir-cutover for archival and
AGPL forks.

Architecture:
- Workers + Hono routing
- Durable Object per room_hash (single-threaded N=1 enforcement)
- D1 for aggregate metrics + extension tokens
- DO alarms replace Oban TTL sweep
- Hibernatable WebSockets for chat channels
- Same client-side crypto, no protocol break

See docs/MIGRATION.md for the full migration record."
git push origin main

# Step 4: optional — delete the v2-cloudflare branch since main now contains it
git branch -d v2-cloudflare
git push origin --delete v2-cloudflare
```

### After cutover

- `main` — v2 (CF). Primary development.
- `v1-elixir` — v1 (Phoenix). Maintenance branch. Receives:
  - Security patches that apply to the Elixir version.
  - Cross-cutting updates that are version-independent (spec edits, /security
    page wording, threat-model documents) — apply on whichever branch first,
    then cherry-pick to the other.
- `v1-elixir-cutover` tag — permanent immutable marker of the moment of
  transition. Anyone running `git checkout v1-elixir-cutover` gets exactly
  the v1 state at the swap.

### How long do we maintain v1-elixir?

This is a decision deferred until we have data. Realistic options:

- **Indefinitely**, if a real community of operators picks up v1 and depends
  on continued patches.
- **Until v2 has been stable in production for N months**, then stop and let
  AGPL forks carry it forward.
- **Security-only**, applying CVE fixes for some defined period but not
  features.

Pick the policy when we have the data. AGPL guarantees anyone can fork
v1-elixir and continue it whether we do or not.

---

## Three things to set up so the dual-branch life isn't painful

These need to be in place **before or at cutover** to keep the parallel
branches from constantly stepping on each other.

### 1. Branch-scope GitHub Actions workflows

GitHub Actions runs whichever workflow files exist on the branch being
pushed. Workflows for v1 should live on `v1-elixir`; workflows for v2 on
`main`. They naturally don't collide because each branch carries its own
`.github/workflows/*.yml`, but make the trigger explicit in each YAML to
remove any ambiguity:

```yaml
# .github/workflows/deploy.yml on v1-elixir
on:
  push:
    branches: [v1-elixir]
  workflow_dispatch:
```

```yaml
# .github/workflows/wrangler-deploy.yml on main (after cutover)
on:
  push:
    branches: [main]
  workflow_dispatch:
```

This also makes the GitHub UI's "Actions" tab clearer — each workflow is
labelled by the branch it runs on.

### 2. Per-branch Dependabot configuration

`.github/dependabot.yml` supports multiple `updates:` entries with different
`target-branch:` values. After cutover:

```yaml
version: 2
updates:
  # v1 Elixir mix deps
  - package-ecosystem: mix
    directory: /
    schedule:
      interval: weekly
    target-branch: v1-elixir

  # v1 GitHub Actions (used by the Elixir deploy workflow)
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    target-branch: v1-elixir

  # v2 npm deps
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    target-branch: main

  # v2 GitHub Actions (used by the wrangler deploy workflow)
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    target-branch: main
```

Without this, Dependabot only scans the default branch (main = CF after
cutover) and silently stops updating v1's mix deps.

### 3. READMEs that point at each other

After cutover, the `main` README needs a one-liner pointing to v1, and the
`v1-elixir` README needs the converse. Suggested wording:

**On `main` (v2 README):**

> The Phoenix/Elixir implementation is preserved on the
> [`v1-elixir`](../../tree/v1-elixir) branch and may continue to receive
> security patches. Both implementations are AGPL — fork either freely.

**On `v1-elixir` (v1 README):**

> This is the Phoenix/Elixir implementation of sTELgano (v1). The current
> canonical implementation is on [`main`](../../tree/main) (Cloudflare
> Workers + Durable Objects + D1). This branch may receive security patches
> for some period but is no longer the focus of active feature development.
> Both are AGPL — fork either freely.

Without these, anyone landing on the GitHub URL after cutover sees only the
TypeScript code and may not realise the Elixir version exists at all.

---

## New architecture

### Stack at a glance

| Layer | v1 (Elixir) | v2 (Cloudflare) |
|---|---|---|
| Routing | Phoenix Router | Hono on Workers |
| Real-time | Phoenix Channels | Hibernatable WebSockets on Durable Objects |
| Per-room state | Postgres rows + UNIQUE index | One Durable Object per `room_hash` |
| Aggregate metrics | Postgres tables | D1 (SQLite at the edge) |
| Payment tokens | Postgres table | D1 table |
| TTL expiry | Oban hourly sweep job | DO alarms (per-room, exact-time) |
| Background jobs | Oban | Workers Cron Triggers + DO alarms |
| Static assets | Phoenix `Plug.Static` from droplet | Workers Assets (or R2) |
| Client UI | LiveView state machine + JS hooks | Static HTML shell + vanilla TS |
| Crypto | Web Crypto API in `assets/js/crypto/anon.js` | **Same code, ported unchanged** |
| Rate limiting | PlugAttack (ETS) | Cloudflare native rate-limiting rules |
| Security headers / CSP | `SecurityHeaders` plug + nonce plug | Workers middleware (same nonce strategy) |
| Admin dashboard | LiveView + HTTP Basic Auth | Worker route + HTML + D1 query |
| Payment provider | `Stelgano.Monetization.Providers.Paystack` | Ported TypeScript adapter, same protocol |
| Migrations | `Stelgano.Release.migrate/0` | `wrangler d1 migrations apply` |
| Deploy | scp tarball + systemd restart | `wrangler deploy` |

### Per-room Durable Object

The room is the DO. There is no `rooms` row in any database — the DO *is* the
room. Its identity is `room_hash` (the SHA-256 of `normalise(phone) + ":" +
ROOM_SALT`, exactly as today).

A DO has:

- **In-memory state** — `currentMessage`, `accessLockoutCounter`, `ttlExpiresAt`
- **DO Storage** — durable key-value backing for the in-memory state, survives
  hibernation
- **WebSocket connections** — both parties' channel connections attach to the
  same DO instance
- **Alarms** — schedule a future wakeup at `ttlExpiresAt` to self-destruct

The N=1 invariant is automatic: only one instance of the DO's code runs at a
time, so concurrent senders serialise naturally. The `UNIQUE` index on
`messages.room_id` and the delete-then-insert transaction in
`lib/stelgano/rooms.ex:send_message/4` both disappear — they exist because
Postgres can't guarantee what a single-threaded actor gives for free.

### Hibernation behaviour

DOs hibernate when idle. With Hibernatable WebSockets enabled, an idle room
with both parties connected but silent costs essentially nothing — the
connections are tracked by the platform, not by an active worker.

When activity resumes, the DO wakes, restores in-memory state from DO Storage,
and processes the message. From the client's perspective there is no
difference; from a billing perspective the room only consumes wall-clock
duration when actually executing.

### TTL via DO alarms

Each room schedules its own expiry alarm at creation:

```typescript
await this.state.storage.setAlarm(ttlExpiresAt);
```

When the alarm fires (7 days for free, 365 days for paid), the DO's
`alarm()` handler runs, deletes its own state, broadcasts an `expire_room`
event to any connected sockets, and the room ceases to exist. No Oban sweep,
no clock-skew window, no hourly poll — exact-time per-room expiry handled by
the platform.

### What carries over unchanged

These survive the rewrite without modification:

- **`assets/js/crypto/anon.js`** — the entire client-side crypto module. Same
  hashes, same key derivation, same constants, same protocol. Salts
  (`ROOM_SALT`, `ACCESS_SALT`, `SENDER_SALT`, `ENC_SALT`) are unchanged so
  v1 and v2 produce identical hashes for the same `(phone, PIN)` input.
- **`assets/js/workers/pbkdf2_worker.js`** — the Web Worker for PBKDF2 key
  derivation. Pure JS, no Phoenix dependency.
- **The threat model and passcode test.** Unchanged. Every design decision
  in v2 must still pass: "A suspicious partner unlocks your phone and opens
  sTELgano. What do they see?" — a blank entry screen with two fields.
- **Protocol spec sTELgano-std-1.** Unchanged. v2 implements the same
  protocol; an interoperability test between v1 and v2 should pass message
  exchange (though they won't actually need to interop in production since
  v2 replaces v1).
- **Design system.** Tailwind v4 stays. Design tokens (`--color-primary`,
  `--bg-dark`, etc.), component classes (`.glass-panel`, `.bubble.sent`,
  etc.), and the chat bubble geometry all port verbatim. The font files in
  `priv/static/fonts/` move to `public/fonts/` (Workers Assets) but are the
  same WOFF2 files.
- **No-PWA policy.** No manifest.json, no service worker, no theme-color
  meta. Same as today.
- **No third-party scripts, no analytics, no tracking pixels.** CSP enforces
  this in v2 the same way it does in v1.
- **AGPL-3.0 licence** and SPDX headers on source files.

### What needs porting (mechanical)

These have no semantic change but get rewritten in TypeScript:

- LiveView state machine in `lib/stelgano_web/live/chat_live.ex` →
  client-side TS state machine. The states (`:entry → :deriving →
  :new_channel → :connecting → :chat → :locked → :expired`) are unchanged.
- Phoenix Channel handlers in
  `lib/stelgano_web/channels/anon_room_channel.ex` → DO message handlers.
  Same events (`send_message`, `read_receipt`, `edit_message`,
  `delete_message`, `typing`, `expire_room`, `redeem_extension`).
- `Stelgano.Rooms` context functions → DO methods + D1 queries (only
  metrics/tokens go to D1; room state is in the DO itself).
- `country_metrics` and `daily_metrics` tables → D1 schema, same shape.
- `extension_tokens` table → D1 schema, same shape, **same privacy
  guarantee** (no `room_id` column).
- `Stelgano.Monetization.Providers.Paystack` adapter → TS port, same
  initialize/verify-webhook protocol, same FX-rate caching logic.
- `AdminAuth` plug → Worker middleware doing HTTP Basic Auth.
- `SecurityHeaders` plug + `CspNonce` plug → Worker middleware. The
  per-request CSP nonce strategy is preserved.
- `RateLimiter` (PlugAttack) → Cloudflare's native rate-limiting rules,
  configured in the dashboard or `wrangler.toml`. Better than the ETS
  implementation because it runs at the edge before Workers execute.
- `ExpireUnredeemedTokens` Oban job → Workers Cron Trigger, daily.
- `ExpireTtlRooms` Oban job → **deleted entirely**, replaced by per-room
  DO alarms.

### What disappears

- Phoenix, LiveView, Ecto, Oban, Mix tooling, Dialyzer, Credo
- Postgres (the database, the migrations, the connection pool)
- ExUnit (replaced by vitest, bun:test, or similar)
- DigitalOcean droplet + systemd unit + nginx + Let's Encrypt
- The entire `.github/workflows/deploy.yml` scp-and-restart pipeline
- BEAM-specific deployment artefacts (releases, runtime config eval)

---

## Frontend stack decision

**Vanilla TypeScript** for the chat UI, **static HTML** for the public pages,
**no meta-framework**.

Rationale (full reasoning in conversation history; summary here):

- The passcode test requires the entry screen to render as static HTML on
  first paint. JS-rendered shells with hydration fail this.
- `/chat` is the only interactive route. Everything else (`/`, `/security`,
  `/privacy`, `/terms`, `/about`, `/spec`, `/blog`) is static.
- Strict CSP (`default-src 'self'`, no `'unsafe-inline'` for scripts) makes
  meta-frameworks more painful than they're worth for a one-route app.
- The state machine is finite (~6 states) and the data model is simple (one
  WebSocket, one current message). Reactive frameworks earn the least here.

If the hand-rolled state machine ever grows to feel painful, the fallback is
**Alpine.js with the CSP build** (`@alpinejs/csp`). Avoid Next/Remix/Nuxt/
SvelteKit/Astro entirely — they optimise for a problem this app doesn't have.

---

## Trust boundary changes

This is a meaningful shift and warrants explicit acknowledgement.

### Today (v1)

- **In flight:** TLS terminates on the droplet. Only the droplet operator
  sees encrypted traffic.
- **At rest:** Postgres on the droplet. Only the droplet operator can read
  it.
- **Compute:** BEAM process on the droplet. Only the droplet operator can
  introspect it.
- Single trust boundary: the operator (you, today).

### After v2 cutover

- **In flight:** TLS terminates at Cloudflare's edge. CF sees encrypted
  blobs and metadata (room_hash patterns, IP→room linkage, timing).
- **At rest:** DO Storage and D1 are on Cloudflare infrastructure. CF can
  read what's stored there (encrypted blobs, hashes, aggregate counters).
- **Compute:** Workers and DOs run in CF's V8 isolates. CF controls the
  runtime.
- Single trust boundary: Cloudflare. (No droplet to operate; CF is the
  operator.)

### Required disclosure update

`/security` (the operator disclosure page) needs a one-paragraph addition
post-cutover, plain language:

> sTELgano v2 is operated on Cloudflare's serverless platform (Workers,
> Durable Objects, D1). This means Cloudflare can read all data the server
> stores (encrypted message blobs, room hashes, aggregate metrics) and all
> traffic in transit (encrypted blobs, IP addresses, request timing). The
> client-side encryption guarantees that Cloudflare cannot read message
> *plaintext* — that never leaves your browser. But Cloudflare can see
> who is talking to whom and when, in exactly the same way the server
> operator already can. This is consistent with our existing threat-model
> statement that sTELgano does not protect against governments or law
> enforcement: a US-issued subpoena to Cloudflare reaches the same
> material a subpoena to the operator already would.

### Why we accept this

The user we serve (intimate-access threat model) is unaffected — encrypted
ciphertext at rest on Cloudflare is no more readable to a partner with the
victim's unlocked phone than ciphertext on the droplet was. The threat model
disclosure page already says this app does not protect against
state-level adversaries. CF being in the trust boundary doesn't change that
promise.

The user we don't serve (state-level adversaries) was never in scope.

---

## Vendor lock-in: explicit acknowledgement

Durable Objects do not exist on any other platform. Migrating off Cloudflare
later means rewriting the stateful layer from scratch. We accept this for the
following reasons, recorded here so future-me doesn't have to reconstruct the
argument:

1. **The realistic alternative is being our own SRE.** For a solo dev, that
   is the worse lock-in. Vendor lock-in is escapable with a rewrite at a
   moment of our choosing; SRE lock-in is escapable only by ceasing to
   develop the product.
2. **The migration cost is bounded.** A future port off CF would rewrite the
   DO layer. The crypto, the protocol, the UI, the design system, the
   threat-model docs all carry over to the next platform unchanged.
3. **Cloudflare is broadly aligned with the project's privacy story.** Not
   perfectly — they're a US company subject to subpoenas — but they have a
   track record of resisting overreach and publishing transparency reports.
4. **The other "no-ops" options have similar lock-in.** Convex, Supabase,
   Firebase, PartyKit all bind you to their primitives. CF's primitives are
   at least the most generic of the set.

Conditions under which we'd reconsider:

- CF significantly raises prices in a way that breaks the cost model.
- CF discontinues Hibernatable WebSockets or DO alarms without equivalent
  replacement.
- A pattern of CF outages affecting the product materially.
- A policy change at CF (e.g. changes to acceptable use, content moderation,
  encryption stance) that conflicts with the project's values.

None of these are imminent.

---

## Open decisions deferred

Things that don't need a decision today but should not be forgotten:

- **v1 maintenance policy.** Decide post-cutover, with data on whether
  anyone is using v1.
- **Frontend framework upgrade path.** Vanilla TS is the start. Revisit
  Alpine.js (CSP build) only if the state machine grows past comfortable
  hand-rolling.
- **D1 vs DO storage for tokens.** Currently planned in D1 for ease of
  admin queries. Could move to a dedicated DO if the privacy story argues
  for it. Defer.
- **Static asset hosting: Workers Assets vs R2.** Workers Assets is
  simpler; R2 is more flexible if assets grow large. Start with Workers
  Assets.
- **Multi-currency settlement story.** The Paystack adapter's FX-rate
  caching logic ports over. If we add a second payment provider (Stripe,
  Flutterwave) the settlement-currency handling is per-adapter, same as
  today.
- **Admin dashboard parity.** v1's `AdminDashboardLive` needs a v2
  equivalent. Plan: Worker route + server-rendered HTML + D1 query. No
  LiveView replacement needed since admin doesn't need real-time.
- **Test framework.** Vitest is the default candidate. `wrangler dev` +
  `@cloudflare/vitest-pool-workers` for DO testing. Coverage target stays
  90%.

---

## Migration phasing

Suggested order of work on the `v2-cloudflare` branch, each phase ending in
a commit that compiles and runs (even if incomplete):

1. **Skeleton.** `wrangler.toml`, `package.json`, `tsconfig.json`, Hono
   route stub, "hello world" Worker. Confirm `wrangler dev` works locally.
2. **One DO end-to-end.** Implement `RoomDO` with `join`, `send_message`,
   `read_receipt`. Hand-test via a minimal HTML page that opens a
   WebSocket. No UI polish, no D1, no payments — prove the architecture.
3. **D1 schema for metrics + tokens.** Ports the existing `country_metrics`,
   `daily_metrics`, `extension_tokens` schemas. Migrations via
   `wrangler d1 migrations`.
4. **Static pages.** Port `/`, `/security`, `/privacy`, `/terms`, `/about`,
   `/spec`, `/blog` as static HTML files served by Workers Assets. Same
   content, same Tailwind output.
5. **Chat UI.** Vanilla TS state machine, port the LiveView state
   transitions. Wire to the DO via WebSocket.
6. **Generator drawer + payment flow + admin dashboard.** Port the
   remaining LiveView surfaces.
7. **Paystack adapter port.** `initialize`, webhook verification (HMAC-
   SHA512), FX-rate caching. Same protocol, TS instead of Elixir.
8. **CSP, security headers, rate limiting.** Worker middleware for headers
   + per-request CSP nonce. CF dashboard rate-limiting rules for the
   PlugAttack equivalents.
9. **Tests.** Port the integration tests. Vitest + DO test harness.
   Reach 90% coverage parity.
10. **Smoke test on `*.workers.dev`.** Run end-to-end on a CF-provided
    subdomain before touching the production domain.
11. **Cutover.** Run the cutover commands above. Swap DNS to the Worker.
    Drain v1 traffic. Archive the droplet (don't terminate it for ~30 days
    in case rollback is needed).

---

## References

- `CLAUDE.md` — project invariants that survive the rewrite (threat model,
  passcode test, design system, no-PWA policy, AGPL header convention,
  commit message convention).
- `lib/stelgano/rooms.ex` — the v1 N=1 enforcement that the DO replaces.
- `lib/stelgano_web/channels/anon_room_channel.ex` — the v1 channel
  handlers that DO message handlers replace.
- `assets/js/crypto/anon.js` — the crypto module that ports unchanged.
- `lib/stelgano/monetization/providers/paystack.ex` — the Paystack adapter
  to port to TS.
- `priv/repo/migrations/` — the v1 schema, source for the D1 schema port.
- `.github/workflows/deploy.yml` — the v1 deploy pipeline being replaced
  by `wrangler deploy`.

---

## Maintenance notes for this document

This file should be updated as the migration progresses. Specifically:

- When phases complete, mark them done above with a date.
- When deferred decisions get made, move them out of "Open decisions
  deferred" and into the relevant section above.
- After cutover, this file moves with the codebase to v2 main and continues
  to serve as the historical record. Do not delete it post-cutover — future
  contributors will need it to understand why the architecture is what it
  is.
- The cutover commands above are the canonical script. If the migration
  takes longer than expected and the conversation that produced them is
  long gone, this document is the source of truth.
