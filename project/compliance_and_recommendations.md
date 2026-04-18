# sTELgano — Open Source Compliance & Product Recommendations

---

## OPEN SOURCE COMPLIANCE CHECKLIST

### Legal / Licence (must-have)

- [x] **LICENSE file** — AGPL-3.0 full text in root. ✅ Added.
- [ ] **Copyright notices** — add `Copyright (C) 2026 sTELgano Contributors` to
      the top of every source file. AGPL requires this. Automate with:
      ```bash
      # Add to all .ex files
      find lib -name "*.ex" | xargs sed -i '1s/^/# Copyright (C) 2026 sTELgano Contributors. AGPL-3.0.\n/'
      ```
- [ ] **SPDX identifiers** — optionally add `SPDX-License-Identifier: AGPL-3.0-only`
      to file headers. Makes licence scanning tooling (FOSSA, Licensee) faster.
- [x] **COMMERCIAL.md** — dual-licence terms documented. ✅ Added.
- [ ] **Third-party licence attribution** — run `mix licenses` (add
      `{:licensir, only: :dev}` dep) and generate a `NOTICE` file listing all
      dependency licences. Required by AGPL when distributing.
- [ ] **Contributor Licence Agreement (CLA)** — you've chosen the lightweight
      inbound=outbound approach in CONTRIBUTING.md (no separate signature required).
      If you ever want to relicence or sell the project, you'll need contributor
      consent. Consider CLA Assistant (cla-assistant.io) at that point.
- [ ] **Dependency licence audit** — check all deps are AGPL-compatible:
      - MIT ✅, Apache-2.0 ✅, BSD ✅ — all compatible
      - GPL-2.0-only ❌ — not compatible with AGPL-3.0
      - LGPL ✅ with caveats — generally compatible
      - Run: `mix licenses` and review

### Repository hygiene (should-have)

- [x] **README.md** — comprehensive, with install, crypto spec, threat model. ✅
- [x] **CONTRIBUTING.md** — dev setup, quality tools, PR checklist. ✅
- [x] **SECURITY.md** — private disclosure policy, scope, hall of fame. ✅
- [x] **CHANGELOG.md** — Keep a Changelog format, version policy. ✅
- [x] **CODE_OF_CONDUCT.md** ✅
- [x] **CI/CD workflows** — GitHub Actions for quality gates and deploy. ✅
- [x] **Issue templates** — bug report template with security warning. ✅
- [x] **.well-known/security.txt** ✅
- [ ] **GitHub repository settings:**
      - Enable "Require PR reviews before merging" on `main`
      - Enable "Require status checks to pass before merging" (CI workflow)
      - Enable "Dismiss stale pull request approvals when new commits are pushed"
      - Add repository topics (see GitHub description in launch content)
      - Pin the security contact in About panel
- [ ] **Branch protection rules** on `main` — no force pushes, require CI green
- [ ] **Dependabot** — add `.github/dependabot.yml` for automated dep updates:
      ```yaml
      version: 2
      updates:
        - package-ecosystem: mix
          directory: /
          schedule:
            interval: weekly
        - package-ecosystem: github-actions
          directory: /
          schedule:
            interval: weekly
      ```

### Compliance tooling (nice-to-have)

- [ ] **FOSSA or Licensee** — automated licence compliance scanning in CI
- [ ] **Trivy or Grype** — container vulnerability scanning in Docker build CI
- [ ] **OpenSSF Scorecard** — security posture scoring for the repository
- [ ] **REUSE compliance** (reuse.software) — the most thorough SPDX approach;
      more than you need for now but worth knowing exists

---

## PRODUCT IMPROVEMENTS & ADDITIONS

### High priority — things that add significant value

**1. Rate limiting on the join endpoint (server-side)**
The `failed_attempts` counter exists but it's per `(room_hash, access_hash)` pair.
A brute-force attacker with the `room_hash` could enumerate new `access_hash` values
indefinitely. Add IP-based rate limiting (e.g. `plug_attack` or a simple ETS counter)
as an additional layer. This is not a replacement for the per-record lockout — it's a
second line of defence.

```elixir
# In endpoint.ex or a plug
plug PlugAttack  # or custom ETS-based rate limiter
```

**2. Oban for background cleanup jobs**
The PRD mentions cleanup jobs. Currently `purge_deleted_messages/1` and
`expire_ttl_rooms/0` exist but nothing calls them. Add Oban:
```elixir
# mix.exs
{:oban, "~> 2.19"}

# Jobs:
# - Stelgano.Jobs.PurgeMessages (daily)
# - Stelgano.Jobs.ExpireTTLRooms (hourly)
```

**3. Admin dashboard (PRD §23)**
The aggregate metrics context is implemented but there's no UI.
A simple LiveView behind `Plug.BasicAuth` showing:
- Active rooms count
- Messages sent today / this week
- Peak WebSocket connections (from Telemetry)
- Error rates

No user data. No room contents. Pure aggregates.

**4. `security.txt` served as a route (not just a file)**
The `.well-known/security.txt` file needs to be served by the Phoenix router.
Add a static file route or a controller action:
```elixir
# router.ex
get "/.well-known/security.txt", PageController, :security_txt
```

**5. CSP nonce implementation**
The current CSP uses `'unsafe-inline'` for scripts (necessary for the LiveView
CSRF bootstrap script). A proper nonce-based CSP would be stronger:
```elixir
# In a plug, generate a nonce per request and inject into assigns
# Reference it in root.html.heex as nonce={@csp_nonce}
```
This is non-trivial with Phoenix's LiveView reload scripts in dev — address in production only.

**6. Canonical URL redirect**
Ensure `www.stelgano.com` redirects to `stelgano.com` (not the other way).
Browser history shows `stelgano.com` — any `www.` redirect would show up in history.

---

### Medium priority — meaningful improvements

**7. Panic button / emergency wipe**
A URL-based panic route (e.g. `/x`) that immediately clears sessionStorage and
redirects to the homepage — no confirmation, no delay. Useful for someone who
needs to close the app in a hurry. Different from the "Clear session" link on
the lock screen (which is contextually available).

**8. `rel="noopener noreferrer"` on all external links**
All `<a href="https://...">` links need `rel="noopener noreferrer"` to prevent
the target page learning that stelgano.com was the referrer. Currently missing
on the GitHub links.

**9. Self-host fonts (rather than Google Fonts CDN) — DONE**
Status: resolved. WOFF2 files for Inter, Outfit, and JetBrains Mono live in
`priv/static/fonts/` (sourced from the `@fontsource/*` npm packages) and are
served from the same origin. The `@import url("https://fonts.googleapis.com/…")`
was removed from `app.css`, and the CSP's `font-src` / `style-src` allowances
for `fonts.googleapis.com` / `fonts.gstatic.com` were dropped accordingly.
Regression test in `test/stelgano_web/plugs/security_headers_test.exs`.

**10. PWA manifest (standalone mode) — REJECTED**
Status: deliberately not done. Every PWA surface (install banner, app drawer,
`chrome://apps`, iOS home-screen long-press menu) exposes the app's name,
description, and category to anyone inspecting the device — a direct
passcode-test failure. sTELgano is now an explicitly pure web app: no
`manifest.json`, no service worker, no installable icon. Users who want to
hide the URL bar can use their browser's existing full-screen mode.

**11. Auto-format phone number input**
On the entry screen, the steg number field currently accepts raw input.
A light formatting hook that auto-inserts spaces as the user types (matching
the E.164 display format of the generated number) would reduce entry errors.
Keep the underlying value unformatted for the crypto derivation.

**12. `X-Robots-Tag: noindex` header**
The `/chat` route should not be indexed by search engines. A person searching
for sTELgano should find the homepage — not the chat entry screen.
```elixir
# In a plug or the browser pipeline
plug :put_resp_header, "x-robots-tag", "noindex"
# Apply selectively to /chat
```

**13. Telemetry dashboard (Prometheus + Grafana)**
Export Phoenix telemetry metrics (request latency, LiveView duration, channel
events) to Prometheus for self-hosters who want observability. The
`telemetry_metrics_prometheus` library works well here. This is for self-hosters,
not the cloud version (where aggregate metrics dashboard is sufficient).

---

### Things to remove or avoid

**Remove daisyUI from the vendor bundle**
The current `app.css` imports daisyUI via `@plugin`. The AGENTS.md explicitly
says to use handwritten Tailwind components instead. daisyUI adds ~250KB to the
vendor bundle and introduces opinionated class semantics. Since the implementation
already uses inline CSS custom properties for the design tokens, daisyUI is
providing no value. Remove it:
```css
/* Remove from app.css: */
/* @plugin "../vendor/daisyui" { ... } */
/* @plugin "../vendor/daisyui-theme" { ... } */
```
This reduces the bundle significantly and matches the design intent.

**Remove the donation CTA from the homepage**
As discussed — replace with a clear commercial offering: self-hosting support,
managed hosting, and organisational licences. A `/pricing` page is more credible
than a donation link for a B2B offering.

**Don't add real-time presence (who's online)**
It would be technically easy with Phoenix Presence. But showing "other party is
online" leaks information — a surveillance-capable partner could infer timing
of communications. The async model is a privacy feature, not a limitation.

**Don't add read confirmation beyond double-tick**
Some apps show "User A read your message at 14:32". sTELgano should not expose
the timestamp of reading — the double-tick is sufficient. The read time is
metadata that reveals when the other person was active.

---

## REVENUE / COMMERCIAL SETUP

### Immediate actions

1. **Create `stelgano.com/pricing`** — three tiers:
   - **Self-hosted** (free, AGPL): documentation, community support
   - **Organisation** ($X/month or $X/year): managed hosting, SLA, support contract
   - **OEM / Protocol** (negotiated): embed in proprietary product, written agreement

2. **Add Stripe** for the managed hosting tier. Keep it simple:
   - Monthly subscription
   - Custom domain support
   - Automated certificate management
   - No user-visible difference from self-hosted; it's just ops-as-a-service

3. **`legal@stelgano.com` and `security@stelgano.com`** — set up before launch.
   Both are referenced in COMMERCIAL.md and SECURITY.md.

4. **Remove all donation language** from the homepage and `/about`.
   Replace with: "sTELgano is sustained by commercial licences and managed hosting.
   The open-source release remains free forever."

### Positioning note

Frame the commercial offering as "we run it for you" rather than "pay to unlock
features". The AGPL is your moat — anyone can use the software, but running it
well (updates, backups, certificate management, monitoring) has real value.
That's what organisations are paying for.
