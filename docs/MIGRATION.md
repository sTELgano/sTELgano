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
   `elixir/lib/stelgano/rooms.ex:send_message/4`. A Durable Object is single-threaded
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

### Layout on `v2-cloudflare`

The Phoenix tree lives entirely under `elixir/` on this branch. v2 code
(Workers, DOs, client TS, public assets) lives at the repo root. This is
deliberate — not just for visual cleanliness:

- **Reference stays in reach.** Porting `elixir/lib/stelgano_web/channels/anon_room_channel.ex`
  to a DO message handler is much easier when the Elixir source is one
  `Read` away at `elixir/lib/...` rather than requiring `git show main:...`
  every time.
- **Cutover is one command.** When v2 is ready, the final pre-cutover
  commit is just `git rm -r elixir/`. Everything else on `v2-cloudflare`
  is already in its final shape for `main`.
- **No accidental tooling crossover.** TypeScript compiler, Vitest,
  Wrangler, esbuild, and Tailwind v4 all see only the v2 tree (the root
  excludes `elixir/` in their respective configs). Mix tooling never gets
  pointed at v2 paths.
- **Disabled v1 CI on this branch.** GitHub Actions only reads workflows
  from `.github/workflows/` at the repo root. The Phoenix CI and deploy
  workflows have moved to `elixir/.github/workflows/`, where GitHub
  ignores them. The v2 wrangler-deploy workflow lands at the root in
  Phase 8.

Files that stayed at root on `v2-cloudflare` (version-independent or v2
governance):

- `LICENSE`, `NOTICE`, `README.md`, `CLAUDE.md` (will be updated for v2 in
  Phase 4 or so), `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, `COMMERCIAL.md`,
  `CONTRIBUTING.md`, `SECURITY.md`
- `docs/` (this file lives here)
- `.well-known/` (security.txt etc., served by both v1 and v2)
- `.github/dependabot.yml`, `.github/ISSUE_TEMPLATE/`
- `.gitignore` (rewritten to cover both trees)

### Cross-tree changes during development

Cross-cutting changes (spec edits, threat-model wording, design system) made
on `main` should be periodically merged forward into `v2-cloudflare`. They
will land under `elixir/` automatically on the v2 branch (since main's tree
is now nested):

```bash
git checkout v2-cloudflare
git merge main
# resolve any conflicts — usually only docs/ and CLAUDE.md are touched.
# Note: changes that landed on main at lib/foo.ex will appear in the merge
# at elixir/lib/foo.ex on v2-cloudflare, which is what we want.
```

Do this often enough that the merge is small. Quarterly at minimum, monthly
ideally. A long-divergence merge with hundreds of conflicting files is the
failure mode to avoid.

**Important:** `git merge main` from `v2-cloudflare` will try to merge the
root-level Elixir files on `main` (e.g. `mix.exs`) with the moved versions
on `v2-cloudflare` (e.g. `elixir/mix.exs`). Git's rename detection usually
handles this, but for unusually large changes you may need to merge with
`-X find-renames=50%` or resolve a few paths by hand.

### At cutover (when v2 is production-ready)

The cutover is a single coordinated sequence. Run it when v2 has reached
feature parity, has been smoke-tested on a `*.workers.dev` URL, and the
production domain is ready to swap.

```bash
# Step 1: on v2-cloudflare, drop the elixir/ reference subtree.
# This is the only "destructive" commit of the cutover and it's mechanical
# — no logic changes, just the deletion of v1 reference material that
# served its purpose during the rewrite.
git checkout v2-cloudflare && git pull
git rm -r elixir/
git commit -m "Remove elixir/ reference subtree ahead of v2 cutover

The Phoenix/Elixir tree was kept under elixir/ on this branch as
reference material during the rewrite. With v2 ready to ship, the
reference is no longer needed here — v1 lives on the v1-elixir
branch (created in the next step) and at the v1-elixir-cutover tag."
git push origin v2-cloudflare

# Step 2: snapshot v1 as a long-lived branch (NOT just a tag — we keep
# pushing commits to it after cutover for security/maintenance work)
git checkout main && git pull
git branch v1-elixir
git push -u origin v1-elixir

# Step 3: tag the cutover moment for permanent reference
git tag -a v1-elixir-cutover -m "Final state of Phoenix/Elixir implementation when CF v2 became canonical"
git push origin v1-elixir-cutover

# Step 4: replace main's tree with v2-cloudflare's tree, single commit
git checkout main
git rm -rf .
git checkout v2-cloudflare -- .
git commit -m "Migrate to Cloudflare Workers + Assets + Durable Objects + D1

Replaces the Phoenix/Elixir implementation. The previous tree is preserved
on the v1-elixir branch and tagged at v1-elixir-cutover for archival and
AGPL forks.

Architecture:
- Cloudflare Workers + Assets (no framework, no Pages)
- Static pages served from public/ via the ASSETS binding
- Durable Object per room_hash (single-threaded N=1 enforcement)
- D1 for aggregate metrics + extension tokens
- DO alarms replace Oban TTL sweep
- Hibernatable WebSockets for chat channels
- Same client-side crypto, no protocol break

See docs/MIGRATION.md for the full migration record."
git push origin main

# Step 5: optional — delete the v2-cloudflare branch since main now contains it
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

### Why Workers + Assets (and not Pages)

Cloudflare offers two ways to ship this kind of app:

- **Workers + the `[assets]` binding** — one Worker that does
  everything, with static files served by an asset binding from the
  same deployment.
- **Cloudflare Pages** — Pages serves `public/` natively, with dynamic
  routes either as file-based functions in `functions/` or via a
  single `_worker.ts` at the project root ("Advanced Mode").

We started on Workers + Assets (Phase 1 skeleton), flipped to Pages
after an exploration about which product fit better, hit a DO-export
bug with Pages' file-based routing (next section), moved to Pages
Advanced Mode as a workaround, and then flipped back to Workers +
Assets once it was clear we were using **zero Pages-specific
features** — Advanced Mode is, functionally, a Worker script that
Pages happens to host. The four commits telling this story:
`fbeae33` (Workers skeleton), `bf05903` (flip to Pages), `17e957c`
(Advanced Mode after the file-based bug), and the flip recorded in
this revision of the doc.

Why the final landing is Workers + Assets:

1. **Mental-model clarity.** `_worker.ts` + the `[assets]` binding is
   literally a Worker. Keeping it on Pages meant calling the same
   thing by two names and explaining Advanced Mode in every file
   header.
2. **Deploy-time controls.** `wrangler deploy` supports version
   uploads, gradual rollouts, and instant rollback. For a
   privacy-focused app a bad deploy is worse than a delayed one, so
   those matter.
3. **Cloudflare's forward path.** Workers + Assets is where the
   platform is being invested in; Pages remains supported but
   feature-static.
4. **We already tripped a Pages-specific bug once.** Less attack
   surface for unknown Pages quirks in the future.

What we gave up vs. Pages:

- **Native git-integrated build + preview URLs.** Replaced by
  `.github/workflows/deploy.yml` (~70 lines, runs tests + deploys
  via `cloudflare/wrangler-action`). One-time setup, not ongoing ops.
- **Metered bandwidth ceiling.** Workers' paid plan has a generous
  bandwidth allowance; Pages has none. Unlikely to matter at our
  scale, and if it does, we re-evaluate.

What we did **not** give up: every binding (DO, D1, KV, R2, Queues,
Cron, AI), the `ASSETS` fall-through, `_worker.ts` as the entry, the
`public/` layout, the `wrangler.toml` bindings — all unchanged. The
flip touched `wrangler.toml` (`main` + `[assets]` instead of
`pages_build_output_dir`), `package.json` (`wrangler dev` /
`wrangler deploy` instead of the `pages` subcommands), and the
deploy workflow.

### Why file-based `functions/` didn't work (historical)

The Pages Advanced Mode detour happened because file-based routing
broke first. Keeping the note here because anyone reading this in
git history will want to know what we tried:

We initially used `functions/_middleware.ts` +
`functions/room/[roomHash]/ws.ts` (Pages' file-based routing). The
DO class (`RoomDO`) was re-exported from the middleware so
`[[durable_objects.bindings]]` in `wrangler.toml` could resolve
`class_name = "RoomDO"`.

Empirically that path failed: Pages' bundler does not reliably hoist
named exports from individual function files to the bundled
`functionsWorker` entry, and `wrangler pages dev` died with:

> Your Worker depends on the following Durable Objects, which are
> not exported in your entrypoint file: RoomDO. You should export
> these objects from your entrypoint, …functionsWorker-*.mjs.

Re-exporting from `_middleware.ts` (the documented workaround) did
not fix it on wrangler 4.84.1. The Advanced Mode workaround avoided
the bug but we are no longer on Pages at all — so the bug is
irrelevant to the current build.

### Build + deploy flow

- `_worker.ts` at the project root is the Worker entry. `main` in
  `wrangler.toml` points at it; wrangler bundles on `wrangler dev` /
  `wrangler deploy` (no separate `build:worker` step).
- `npm run build` produces the static assets under `public/`: HTML
  (from `scripts/build-html.mjs`), icon sprite, CSP hashes, the
  client chat bundle, the PBKDF2 worker, and Tailwind CSS.
- `wrangler dev` runs the Worker locally with D1 + DO emulation and
  serves `public/` via the ASSETS binding; `.dev.vars` supplies
  secrets.
- `wrangler deploy` uploads a new Worker version and promotes it to
  production. Unlike Pages, there is no automatic per-branch preview
  URL — GitHub Actions handles CI; manual previews can be produced
  via `wrangler versions upload` if/when we need them.

### Stack at a glance

| Layer | v1 (Elixir) | v2 (Cloudflare) |
|---|---|---|
| Hosting product | DigitalOcean droplet | Cloudflare Workers + Assets |
| Routing | Phoenix Router | Single `_worker.ts` (switch/match) |
| Real-time | Phoenix Channels | Hibernatable WebSockets on Durable Objects |
| Per-room state | Postgres rows + UNIQUE index | One Durable Object per `room_hash` |
| Aggregate metrics | Postgres tables | D1 (SQLite at the edge) |
| Payment tokens | Postgres table | D1 table |
| TTL expiry | Oban hourly sweep job | DO alarms (per-room, exact-time) |
| Background jobs | Oban | Workers Cron Triggers + DO alarms |
| Static assets | Phoenix `Plug.Static` from droplet | Workers ASSETS binding serving `public/` |
| Client UI | LiveView state machine + JS hooks | Static HTML shell + vanilla TS |
| Crypto | Web Crypto API in `elixir/assets/js/crypto/anon.js` | **Same code, ported unchanged** |
| Rate limiting | PlugAttack (ETS) | Cloudflare native rate-limiting rules |
| Security headers / CSP | `SecurityHeaders` plug + nonce plug | Header injection in `_worker.ts` (SHA-256 pinning for the inline shell script — see Phase 8 notes) |
| Admin dashboard | LiveView + HTTP Basic Auth | Worker HTML route + D1 query |
| Payment provider | `elixir/lib/stelgano/monetization/providers/paystack.ex` | Ported TypeScript adapter, same protocol |
| Migrations | `Stelgano.Release.migrate/0` | `wrangler d1 migrations apply` (run by GH Actions on deploy) |
| Deploy | scp tarball + systemd restart | `wrangler deploy` via GitHub Actions |
| Preview environments | None | On-demand via `wrangler versions upload` |

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
`elixir/lib/stelgano/rooms.ex:send_message/4` both disappear — they exist because
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

- **`elixir/assets/js/crypto/anon.js`** — the entire client-side crypto module. Same
  hashes, same key derivation, same constants, same protocol. Salts
  (`ROOM_SALT`, `ACCESS_SALT`, `SENDER_SALT`, `ENC_SALT`) are unchanged so
  v1 and v2 produce identical hashes for the same `(phone, PIN)` input.
- **`elixir/assets/js/workers/pbkdf2_worker.js`** — the Web Worker for PBKDF2 key
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
  `elixir/priv/static/fonts/` move to `public/fonts/` (Workers Assets) but are the
  same WOFF2 files.
- **No-PWA policy.** No manifest.json, no service worker, no theme-color
  meta. Same as today.
- **No third-party scripts, no analytics, no tracking pixels.** CSP enforces
  this in v2 the same way it does in v1.
- **AGPL-3.0 licence** and SPDX headers on source files.

### What needs porting (mechanical)

These have no semantic change but get rewritten in TypeScript:

- LiveView state machine in `elixir/lib/stelgano_web/live/chat_live.ex` →
  client-side TS state machine. The states (`:entry → :deriving →
  :new_channel → :connecting → :chat → :locked → :expired`) are unchanged.
- Phoenix Channel handlers in
  `elixir/lib/stelgano_web/channels/anon_room_channel.ex` → DO message handlers.
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
- The entire `elixir/.github/workflows/deploy.yml` scp-and-restart pipeline
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

## Rate limiting

v1's ETS-backed PlugAttack rules (20/IP/min on /admin, 30/IP/min on
WebSocket upgrades, 200/IP/min globally) don't port directly — there's
no cross-request in-memory store in Workers. Two options v2 can use:

1. **Cloudflare dashboard Rate Limiting Rules** (recommended). In the
   CF dashboard, route the Worker's custom domain through a zone,
   then go to the zone → Security → WAF → Rate Limiting Rules and
   add:
   - `http.request.uri.path eq "/admin"` → 20 requests / minute / IP, block
   - `http.request.uri.path matches "^/room/[a-f0-9]{64}/ws$"` →
     30 requests / minute / IP, block
   - (optional) `http.request.uri.path matches "^/api/"` →
     200 requests / minute / IP, block

   These run at CF's edge BEFORE the Worker executes, so they're
   strictly better than an in-application limiter at the same budget.

2. **DO-backed limiter** if you need finer-grained logic (e.g. per-
   room-hash lockout). Each limiter instance is a tiny DO keyed by
   `(rule, ip)`; it stores a count + window start and refuses over
   budget. Adds latency (~1ms per request), only worth it if the
   dashboard rules aren't enough.

v2 ships with no application-level rate limiting — the CF dashboard
rules are set up as part of the production deploy (Phase 10 smoke
test + cutover). The Worker does not enforce anything rate-related
itself.

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

1. **Skeleton.** ✅ _done 2026-04-24 (fbeae33)._ `wrangler.toml`,
   `package.json`, `tsconfig.json`, a `_worker.ts` stub at the
   project root, the project layout (`public/` for static, `src/`
   for shared code). Confirm `wrangler dev` returns 200 at
   `/healthz` and serves `public/index.html` at `/`. (Originally
   shipped on Pages; the flip back to Workers + Assets is
   documented in the architecture section above.)
2. **One DO end-to-end.** ✅ _done 2026-04-24 (f2c8fbb)._ Implement
   `RoomDO` in `src/room.ts` with `join`, `send_message`, `read_receipt`.
   Re-export the class from `_worker.ts` so the bundler keeps it.
   Hand-test via a minimal HTML page that opens a WebSocket. No UI
   polish, no D1, no payments — prove the architecture.
3. **D1 schema for metrics + tokens.** ✅ _done 2026-04-24 (977348d)._
   Ports the existing `country_metrics`, `daily_metrics`,
   `extension_tokens` schemas. Migrations via
   `wrangler d1 migrations apply stelgano`.
4. **Static pages.** ✅ _done 2026-04-24 (e885793 → b7b160c)._ Port
   `/`, `/security`, `/privacy`, `/terms`, `/about`, `/spec`, `/blog`
   as static HTML files in `public/`. Served via the ASSETS binding
   with the Worker wrapping responses in security headers. Same
   Tailwind output. (Split into 4a scaffolding, 4b icons, 4c
   marketing pages, 4d blog.)
5. **Chat UI.** ✅ _done 2026-04-24 (70e9fbb → bea46e7)._ Vanilla TS
   state machine, port the LiveView state transitions. Wire to the DO
   via WebSocket. The chat UI was redone once (bea46e7) after the
   initial port diverged too far from v1; shipped as a verbatim port.
6. **Generator drawer + payment flow + admin dashboard.** ✅ _done
   2026-04-24 (0ef27f3, a99597b, 0d3362a)._ Port the remaining
   LiveView surfaces.
7. **Paystack adapter port.** ✅ _done 2026-04-24 (4dfc2ac → 7ad2ade)._
   `initialize`, webhook verification (HMAC-SHA512). FX-rate caching
   is deferred — see `src/lib/paystack.ts` docstring: if
   `PAYSTACK_SETTLEMENT_CURRENCY` differs from `PAYMENT_CURRENCY`,
   `initialize()` returns `fx_conversion_not_wired` rather than
   silently losing money. Will wire when we first need a settlement
   currency that differs from the display currency.
8. **CSP, security headers, rate limiting.** ✅ _done 2026-04-24
   (1efe406)._ Header injection in `_worker.ts`'s fetch handler
   (wraps responses from both ASSETS and the DO routes). The
   bootstrap inline `<script>` in the layout is byte-identical
   across requests, so script-src pins it via SHA-256 rather than
   nonce. Rate limiting deferred to CF dashboard rules at deploy
   time (no application-layer PlugAttack equivalent shipped).
9. **Tests.** ✅ _done 2026-04-24 (9082f5e + 43e1929)._ Two-project
   vitest workspace: pure-function tests (crypto + paystack helpers)
   run in Node, Worker/DO runtime tests run under workerd via
   `@cloudflare/vitest-pool-workers`. 85 tests green covering
   healthz + security headers, admin Basic Auth, /api/room/:hash/exists,
   /api/payment/initiate gates, /api/webhooks/paystack signature
   handling, full RoomDO WebSocket protocol (join, turn-taking, N=1
   overwrite, read-gated edits, lockout math), and the D1 lib
   modules (extension_tokens lifecycle, country/daily UPSERT
   counters). D1 migrations apply per test realm via a setup file.
10. **Smoke test on `workers.dev`.** Add GitHub secrets
    (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`), create the D1
    database (`wrangler d1 create stelgano`, paste the ID into
    `wrangler.toml`), and let `.github/workflows/deploy.yml` run
    against a throwaway branch merged into `main` (or flip the `if:`
    in the workflow to include `v2-cloudflare` for a one-off
    pre-cutover deploy). The worker comes up at
    `stelgano.<account>.workers.dev` by default. Smoke-test
    end-to-end there before touching the production domain.
11. **Cutover.** Run the cutover commands above. Point the
    production custom domain at the Worker (Workers routes or a
    custom domain attached to the Worker). Drain v1 traffic.
    Archive the droplet (don't terminate it for ~30 days in case
    rollback is needed).

---

## References

- `CLAUDE.md` — project invariants that survive the rewrite (threat model,
  passcode test, design system, no-PWA policy, AGPL header convention,
  commit message convention).
- `elixir/lib/stelgano/rooms.ex` — the v1 N=1 enforcement that the DO replaces.
- `elixir/lib/stelgano_web/channels/anon_room_channel.ex` — the v1 channel
  handlers that DO message handlers replace.
- `elixir/assets/js/crypto/anon.js` — the crypto module that ports unchanged.
- `elixir/lib/stelgano/monetization/providers/paystack.ex` — the Paystack adapter
  to port to TS.
- `elixir/priv/repo/migrations/` — the v1 schema, source for the D1 schema port.
- `elixir/.github/workflows/deploy.yml` — the v1 deploy pipeline being replaced
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
