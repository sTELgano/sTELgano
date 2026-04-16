# sTELgano — Product Requirements Document

**Product:** sTELgano
**Domain:** `stelgano.com`
**Standard:** sTELgano-std-1
**Version:** 2.2
**Date:** April 2026
**Status:** MVP implemented — core messaging, crypto, chat UI, admin dashboard, blog, and public pages are live. Business model (Stripe/dedicated numbers), advanced room lifecycle cleanup, and user-defined TTL slider are not yet built.
**Licence:** AGPL-3.0

---

## Table of Contents

1. [Product Vision](#1-product-vision)
2. [Name & Brand](#2-name--brand)
3. [Design Language](#3-design-language)
4. [Threat Model](#4-threat-model)
5. [The Passcode Test](#5-the-passcode-test)
6. [User Flow](#6-user-flow)
7. [Fake Number System](#7-fake-number-system)
8. [Cryptographic Architecture](#8-cryptographic-architecture)
9. [Messaging Model — N=1 Async](#9-messaging-model--n1-async)
10. [Chat UI Features](#10-chat-ui-features)
11. [Lock & Session Features](#11-lock--session-features)
12. [Multi-Device Access](#12-multi-device-access)
9. [Room Lifecycle & Automated Cleanup](#9-room-lifecycle--automated-cleanup)
10. [User-Defined TTL](#10-user-defined-ttl)
13. [Analytics Strategy](#13-analytics-strategy)
14. [Public Pages](#14-public-pages)
15. [Technical Architecture](#15-technical-architecture)
16. [Deployment Strategy](#16-deployment-strategy)
17. [Testing Requirements](#17-testing-requirements)
18. [Code Quality & Open Source](#18-code-quality--open-source)
19. [Security Disclosure](#19-security-disclosure)
20. [Non-Functional Requirements](#20-non-functional-requirements)
21. [Out of Scope — v1](#21-out-of-scope--v1)
22. [Glossary](#22-glossary)
23. [Admin Dashboard](#23-admin-dashboard)
24. [The sTELgano Standard](#24-the-stelegano-standard)
25. [Business Model](#25-business-model)

---

## 1. Product Vision

sTELgano (Steganographic TELephone numbering) is a privacy-focused anonymous messaging application and open protocol standard. It protects users from the people in their lives — partners, family members, anyone with physical access to their device — not from governments or institutions. It says this clearly, because honesty is the product.

**The name encodes the concept:**

- **s** — steganography: the practice of hiding a message inside an innocent carrier
- **TEL** — telephone number: the carrier medium — a plausible phone number stored in the contacts app
- **gano** — completing "steganographic" — the discipline that defines the product's entire security model

**What makes sTELgano a new category:** The product formalises *contact-layer steganography* — using a standard phone contact as the hiding place for a cryptographic key. The key is not a password, not a link, not a QR code. It is a phone number that looks like every other number in the contacts app. This technique did not have a name before sTELgano.

**The sTELgano Standard (sTELgano-std-1):** sTELgano is simultaneously a consumer application and an open protocol specification. Other developers can build sTELgano-compatible applications — different stacks, different interfaces — that are interoperable at the protocol level. The Standard defines the steg number format, the cryptographic derivation chain, and the N=1 messaging invariant.

**The core promise:** Two people can have a completely private conversation using nothing but a steganographic telephone number (steg number) stored in their regular contacts app and a personal PIN they never share with anyone. Nothing about the conversation is visible in browser history. Nothing is stored on the server in readable form. When the conversation is done, it is gone.

---

## 2. Name & Brand

### 2.1 Names and URLs

| Asset | Value |
|-------|-------|
| Domain | `stelgano.com` |
| Brand name | sTELgano |
| Tagline | *Hidden in the contact layer.* |
| Sub-tagline | *The key lives in your contacts.* |
| Protocol identifier | sTELgano-std-1 |

`stelgano.com` is the single canonical domain. No redirects. Browser history shows only `stelgano.com` — short, generic, reveals nothing about the nature of the service to a casual observer. The name "sTELgano" is intentionally meaningless to anyone outside the steganography community. A name like "SecretChat" or "HiddenMessages" would fail the Passcode Test before the app even opens. The brand itself is steganographic — it hides the purpose of the tool in plain sight.

### 2.2 Tone of voice

sTELgano speaks with the authority of a protocol specification and the warmth of a human product.


- Honest and direct — never oversells, explicitly states what it does not protect against
- Calm confidence — no fear-mongering, no dark patterns
- Technical when needed, human always
- The word "private" appears sparingly in UI copy — replaced by "hidden", "yours alone", "between you two"
- "Steg number" is always referred to as "steg number" in technical contexts and "your key" or "the number in your contacts" in user-facing copy
- "Channel" is preferred over "conversation" or "chat" in UI copy — it is more neutral and less revealing

### 2.3 Licence

**AGPL-3.0** — inspired by Signal's model. Anyone can run it, fork it, and audit it. Anyone who modifies it and runs it as a service must publish their changes. This is the strongest open-source signal of trustworthiness available and the clearest expression of the "vet" principle.

---

## 3. Design Language

### 3.1 Philosophy

The design must feel like the product: **minimal surface, maximum trust**. Every element on screen should earn its place. Nothing decorative. The UI is the security model made visible.

Key principles:
- **Invisible by design** — the entry screen looks like nothing. A blank field and a PIN. That is the security.
- **Calm, not clinical** — warm neutrals, not cold grays. This is a human product.
- **Typography carries the weight** — no icons where words are clearer
- **Mobile-first** — designed for the phone first, scales to desktop

### 3.2 Colour Palette — Dark-First Glassmorphism

The design uses a **dark-first** glassmorphism approach. All surfaces use `backdrop-filter: blur(16px)` with translucent dark backgrounds. The accent colour is emerald green (#10B981) — signalling trust, safety, and go.

| Token | Value | Purpose |
|-------|-------|---------|
| `--bg-dark` | `#030712` | Page background (near-black) |
| `--color-surface` | `rgba(17, 24, 39, 0.6)` | Glass panels, cards, headers |
| `--color-surface-border` | `rgba(255, 255, 255, 0.1)` | All borders |
| `--color-surface-glow` | `rgba(16, 185, 129, 0.1)` | Hover glow effect |
| `--text-main` | `#f9fafb` | Primary text |
| `--text-muted` | `#9ca3af` | Captions, hints, placeholders |
| `--color-primary` | `#10B981` | Primary actions, accent |
| `--color-primary-hover` | `#059669` | Hover state for primary |
| `--color-primary-soft` | `rgba(16, 185, 129, 0.15)` | Focus rings, selection |
| `--danger` | `#ef4444` | Destructive actions |
| `--warning` | `#f59e0b` | Warnings |

The page background includes subtle radial gradients: emerald (top-right) and indigo (bottom-left) at 5% opacity, creating depth without distraction.

Rationale for emerald accent: green reads as "safe", "go", "verified" — it avoids the grey anonymity of most privacy tools and the paranoia-signalling of red/black palettes.

### 3.3 Typography

| Role | Font | Weight | Size |
|------|------|--------|------|
| Brand wordmark / Display | `Outfit` | 300 (s/gano) · 600 (TEL) | 14–72px |
| Body / UI text | `Inter` | 300–600 | 14–18px |
| Monospace (hashes, phone numbers, code) | `JetBrains Mono` | 400–500 | 12–16px |

The wordmark renders as: `s` (weight 300, italic, `--text-muted`) + `TEL` (weight 600, `--color-primary`) + `gano` (weight 600, `--text-main`). This typographically encodes the concept — the telephone number (TEL) is the visible signal; the steganographic wrapper (s, gano) frames it.

All fonts loaded via Google Fonts CDN. TODO: self-host for stricter CSP.

### 3.4 Spacing & Geometry

- Base unit: `4px` (`--spacing: 0.25rem`)
- Component padding: `16px` (sm), `24px` (md), `32px` (lg)
- Border radius: `--radius-xl: 1rem` (inputs), `--radius-2xl: 1.5rem` (cards, bubbles), `--radius-3xl: 2rem` (large panels)
- Bubble geometry: sent `border-radius: 1.5rem 1.5rem 0.25rem 1.5rem` (24px base, 4px tail bottom-right), received `border-radius: 1.5rem 1.5rem 1.5rem 0.25rem` (4px tail bottom-left)
- Sent bubble: emerald gradient (`linear-gradient(135deg, #10B981, #047857)`) with shadow
- Received bubble: frosted glass (`rgba(255, 255, 255, 0.08)` with `backdrop-filter: blur(8px)`)
- Touch targets: 56px minimum height (exceeds WCAG 44px recommendation)

### 3.5 Motion

- Hover/focus transitions: `300ms ease` on glass components
- Bubble appear: `300ms ease-out` fadeIn (translateY + opacity)
- Typing indicator: three dots with staggered `1.4s` bounce animation
- Button hover: `translateY(-2px)` lift with emerald shadow
- Button shine: `::after` pseudo-element sweep on hover (`500ms`)
- Lock overlay: instant (no animation, security-critical)
- All motion respects `prefers-reduced-motion: reduce`

### 3.6 Iconography

Lucide Icons (via the `lucide_icons` Elixir package). Used only where the icon unambiguously communicates faster than a word. Never decorative.

### 3.7 Theme System

**Dark-only design.** The theme toggle has been removed. sTELgano uses a single dark theme exclusively — this simplifies the UI, reduces code surface, and aligns with the glassmorphism design language which is inherently dark-first. No theme preference is stored; no toggle is exposed to the user.

### 3.8 Component Library

All components are hand-written with CSS custom properties and Tailwind utilities. No daisyUI or third-party component libraries.

| Component | Class | Usage |
|-----------|-------|-------|
| Glass panel | `.glass-panel` | Cards, entry form, modals |
| Glass input | `.glass-input` | All form inputs |
| Glass button | `.glass-button` | Primary CTAs |
| Ghost button | `.btn-ghost` | Secondary actions |
| Danger button | `.btn-danger` | Destructive confirmations |
| Icon button | `.btn-icon` | Header actions (44px min) |
| Entry card | `.entry-card` | Login/entry form container |
| Chat layout | `.chat-layout` | Full-screen chat container |
| Chat bubble | `.bubble.sent` / `.bubble.received` | Message bubbles |
| Modal | `.modal-backdrop` + `.modal-card` | Expire confirmation |
| Lock overlay | `.lock-overlay` + `.lock-card` | PIN re-entry screen |
| Wordmark | `.wordmark` + `.wm-s` `.wm-tel` `.wm-gano` | Brand identity |

---

## 4. Threat Model

### 4.1 Who sTELgano protects against

- A partner who picks up your unlocked phone
- A family member with device access
- Casual snooping by anyone in your life
- Browser history inspection — only `stelgano.com` or `stelgano.com` appears
- Database breach — no readable phone numbers, PINs, or messages are stored

### 4.2 Who sTELgano does NOT protect against

- Government subpoenas or legal discovery
- Nation-state surveillance or network interception
- Law enforcement with a warrant
- Institutional monitoring (employer, school)

This is stated clearly on the homepage, in the security page, in the app onboarding, and in the terms of service. No exceptions. Honesty is the product.

### 4.3 The attacker profile

The attacker is not a state actor. They are someone who knows the user personally, has physical access to their device, and is looking for evidence of private communication. They know how to use a smartphone. They may know or have access to the user's phonebook. Even if they find the steg number in the contacts app, they still need the PIN to enter the room — and even if they somehow obtain both, they can only see the single most recent message (N=1 guarantees no history exists anywhere).

---

## 5. The Passcode Test

Every design decision must pass the following test:

> A suspicious partner who knows your phone PIN unlocks your phone and opens sTELgano in the browser. What do they see?

**Required answer:** A blank entry screen with two unlabelled fields and the sTELgano wordmark. Nothing else. No history. No recent conversations. No contact names. No indication a conversation occurred or is occurring.

Any design decision that would reveal more than this to an unauthorised person with device access fails and must be redesigned.

---

## 6. User Flow

### 6.1 First-time setup — out-of-band, no app involvement

1. User A and User B agree to use sTELgano, in person or on a call
2. One of them opens `/steg-number`, selects a country from the dropdown, and generates a steg number
3. The number is automatically copied to clipboard. A warning instructs them to **save it in their contacts before proceeding** — once they leave the page, the number cannot be recovered
4. Each saves the steg number in the other person's real phonebook contact as an additional number — hidden in plain sight
5. Each independently chooses their own personal PIN — never discussed, never shared, written nowhere
6. They click "Open channel with this number" which navigates to `/chat?phone=<e164>` with the phone pre-populated — they only need to enter their PIN

### 6.2 PIN strategy — user's choice

Users may choose how they use PINs:

- **Same PIN across all chats** — simpler to remember, slightly less secure (if one room is compromised and the PIN is somehow exposed, all rooms are at risk)
- **Unique PIN per chat** — stronger isolation, requires remembering more PINs

This is entirely the user's decision. The app does not enforce either strategy. The onboarding guidance explains the tradeoff. There is no PIN management interface — PINs are never stored anywhere.

### 6.3 Returning user flow

1. User opens `stelgano.com` — sees blank entry screen with phone number and PIN fields
2. Opens contacts app, finds the other person's contact, notes the steg number
3. Enters steg number + personal PIN → room opens
4. If a message is waiting → it is displayed. If none → blank chat screen.
5. Chat, lock, logout, or close tab

Alternatively, a returning user can go to `/steg-number`, regenerate/recall their number, and use the "Open channel" button to pre-populate the phone field.

### 6.4 What is shared out-of-band

| Item | Shared? | How |
|------|---------|-----|
| Steg number | Yes — both users | In person, on a call |
| PIN | No — each user's own | Never shared |
| Real email or identity | No | — |
| Any sTELgano link or room ID | No | — |

---

## 7. Fake Number System

### 7.1 Generator requirements

- Generates internationally valid-format phone numbers in E.164 format: `+[country code][number]`
- Powered by `phone-number-generator-js` npm package
- **Country selector dropdown** — 19 curated countries (Kenya, US, UK, Germany, France, Canada, Japan, Australia, India, Brazil, South Africa, Nigeria, Egypt, Morocco, Ethiopia, Ghana, Tanzania, Uganda, Rwanda). Users pick a specific country from the dropdown.
- Display format: E.164 canonical form (the number is both displayed and copied in this format)
- Generator is a standalone page at `/steg-number`
- Number is automatically copied to clipboard on generation
- After generation, a warning card instructs users to save the number in contacts before proceeding
- "Open channel with this number" button navigates to `/chat?phone=<e164>` with the phone pre-populated

### 7.2 Custom number entry — removed

Custom number entry and availability checking have been removed. Users must use the system-generated number. This simplifies the flow, eliminates the risk of users choosing guessable numbers, and enforces the recommended path.

### 7.3 Collision handling

Two entirely different pairs of users could theoretically generate or choose the same steg number. The server detects this (room_hash already exists). Random generation makes this astronomically unlikely; custom entry is where realistic collisions occur. The "taken" check prevents this silently and asks the user to choose another.

### 7.4 Hidden in plain sight

The primary UX guidance — shown on the onboarding screen, the help page, and the homepage — is:

> Open your contacts app. Find [the other person's] contact. Add this number alongside their real number. That number is your key. You never need to remember it — it lives in your contacts, invisible to anyone who doesn't know what it means.

This is the core UX insight of sTELgano. The "password" is stored in the most obvious, innocent-looking place imaginable.

---

## 8. Cryptographic Architecture

All cryptography runs client-side in the browser using the **Web Crypto API** (`crypto.subtle`). No external crypto libraries. No Argon2, no WASM, no native code. The browser's built-in primitives are the only dependency.

### 8.1 Derivation chain

```
phone       = normalise(raw_input)
              strips: spaces · dashes · dots · + · parentheses
              result: digits only with country code prefix

room_hash   = SHA-256(phone + ":" + ROOM_SALT)
              Sent to server. Locates the room. Cannot be reversed to find phone.
              Server stores this; the phone number never reaches the server.

access_hash = SHA-256(phone + ":" + PIN + ":" + ACCESS_SALT)
              Sent to server. PIN gate per user.
              User A and User B have DIFFERENT access_hashes for the same room_hash.
              Server stores both and accepts either for the same room.
              A third party who knows the phone number alone cannot compute this
              without also knowing the PIN.

enc_key     = PBKDF2(
                password  : phone,
                salt      : room_id + ENC_SALT,
                iterations: 600_000,
                hash      : SHA-256,
                keylen    : 256 bits → AES-256-GCM key
              )
              Derived client-side AFTER server returns room_id on successful join.
              NEVER transmitted to the server.
              Identical for both users — same phone → same key, regardless of PIN.
              600,000 iterations matches current OWASP PBKDF2-SHA256 recommendation.

sender_hash = SHA-256(phone + ":" + access_hash + ":" + room_hash + ":" + SENDER_SALT)
              Stored in sessionStorage only (cleared on tab close).
              Determines message bubble side (right = sent, left = received).
              Sent to server as message metadata but not linked to any identity.
```

### 8.2 PBKDF2 iteration count rationale

600,000 iterations is the **OWASP 2023 recommendation** for PBKDF2-HMAC-SHA256. This is chosen deliberately over lower values for the following reasons:

- The phone number (the PBKDF2 password) is typically 10–13 digits — relatively low entropy on its own
- The encryption key protects all message content — the highest-value target
- 600,000 iterations on a modern mid-range mobile device takes approximately 1.5–2.5 seconds — acceptable for a one-time join operation
- An attacker with the server database who knows the phone number must perform 600,000 SHA-256 iterations per key guess — making offline key recovery computationally expensive

A loading indicator is shown during key derivation so the user understands why the brief pause occurs.

### 8.3 Why PIN is not part of enc_key

The PIN is personal and never shared. If it were part of enc_key, User A and User B would derive different keys and could not decrypt each other's messages. The PIN is used only for server-side access control (access_hash). The enc_key is derived from the phone number alone (plus room_id), so both users independently arrive at the same decryption key.

### 8.4 Why SHA-256 is sufficient for access_hash

- The access_hash combines the phone number (10–13 digits) with the PIN — the combined entropy is substantially higher than either alone
- The server enforces a hard lockout after 10 failed attempts per room — online brute force is impractical regardless of hash function
- Offline brute force requires access to the server database — at which point the attacker has hashes they cannot feasibly reverse given phone+PIN entropy
- The expensive KDF (PBKDF2 at 600,000 iterations) is applied where it matters most: the encryption key protecting message content
- Argon2id is intentionally excluded because it requires WASM or a native library — both are external dependencies that add attack surface and cannot be verified purely against the Web Crypto API specification

### 8.5 Message encryption

```
Algorithm  : AES-256-GCM
Key        : 256-bit from PBKDF2 above
IV/Nonce   : 96-bit, cryptographically random per message (crypto.getRandomValues)
Auth tag   : 128-bit (GCM default — ensures integrity; tampered ciphertext throws before plaintext is returned)
Storage    : server stores binary (nonce || ciphertext || auth_tag), base64 in transit
```

### 8.6 What the server stores

| Stored value | Can server reverse it? |
|-------------|----------------------|
| `room_hash` | No — cannot find phone number |
| `access_hash` | No — cannot find phone number or PIN |
| Encrypted message ciphertext | No — enc_key never reaches server |
| `sender_hash` per message | No — not linked to phone or persistent identity |
| `room_id` (internal UUID) | Yes — this is a server-generated identifier, returned to authenticated clients only |

### 8.7 What the server never sees

- Phone number in any form
- PIN in any form
- Encryption key
- Message plaintext

### 8.8 The N=1 defence against the found-credentials attacker

Requirement 12 states: *even if a malicious actor finds the steg number, they don't have the PIN; even if they find the PIN, they only see the last sent message.*

This is guaranteed by the intersection of two independent protections:
- **access_hash with PIN** — knowledge of phone number alone is insufficient to join the room
- **N=1 invariant** — even if both phone number and PIN are known, there is at most one message on the server at any time; there is no history to retrieve

A full compromise of both credentials yields only the single message currently in flight, which may have already been read and deleted.

### 8.9 Salt management

All salts are public constants in the open-source code. Their purpose is domain separation — preventing hash reuse across different contexts — not secrecy. Security does not depend on salt secrecy; it depends on the entropy of the combined phone number and PIN inputs.

Salts may optionally be injected as environment variables for server-operator control. Rotating salts is a breaking change (all existing rooms become inaccessible) and requires a documented migration procedure.

---

## 9. Messaging Model — N=1 Async

### 9.1 The N=1 invariant

At any moment, **at most one message exists** in any room on the server. When a user replies, the server permanently and irreversibly deletes the previous message before inserting the new one, inside a single atomic database transaction. There is no message history anywhere — not on the server, not in the browser, not in any log. There is no thread. There is no way to recover a deleted message.

This invariant is enforced at the database level (atomic transaction), not just the application level.

### 9.2 Async delivery

Users do not need to be online at the same time. The message waits on the server, encrypted, until the recipient opens the app:

1. User A sends a message → server stores encrypted ciphertext
2. User A closes the app and goes offline
3. User B opens the app at any later time → server delivers the ciphertext
4. User B decrypts client-side, reads, and replies
5. Server atomically deletes User A's message and stores User B's message
6. User A returns at any time → receives User B's reply

### 9.3 Turn-based conversation rhythm

- A user who has sent a message **cannot send another until the other party replies**
- The sender's input area disappears entirely, replaced by the "Waiting for reply…" animation
- The sender **can** edit their sent message before the other party reads it
- The sender **can** delete their sent message before the other party reads it
- Once the message is read (`read_at` is set), editing and deletion are no longer possible
- A reply permanently deletes the previous message (N=1 enforcement)

This creates the rhythm of spoken conversation — speak, then genuinely listen.

### 9.4 Read receipts

| Status | Display |
|--------|---------|
| Delivered to server | Single tick ✓ |
| Opened and read by recipient | Double tick ✓✓ |

Read receipt fires when the recipient's browser opens and decrypts the message. An IntersectionObserver with 500ms dwell confirms the message was actually viewed, not just loaded in a background tab.

### 9.5 Typing indicator

- Broadcast via Phoenix Channel when the recipient is actively typing a reply
- Displayed to the sender as a three-dot animation above the waiting state
- Automatically disappears after 3 seconds of no keystroke, or when a message is sent

### 9.6 Multi-device access

If User A sends from laptop and later opens the app on their phone:

1. User A enters the same steg number + PIN on their phone
2. Server delivers the current room state: the message User A sent (still waiting for reply)
3. Client derives enc_key from phone + room_id (identical derivation — same result)
4. Message decrypts and displays correctly on the phone
5. Input remains locked — still waiting for reply — on all User A's devices simultaneously

The `sender_hash` is derived deterministically from phone + access_hash + room_hash, so it is consistent across all of User A's devices (same phone + same PIN = same sender_hash). Any device User A uses correctly identifies the message as "sent" and displays it on the right side.

### 9.7 Room persistence and TTL

Rooms persist indefinitely by default. Users may optionally set a TTL at room creation: `1 hour · 24 hours · 7 days · 30 days · custom · none`. Either party may expire the room manually at any time.

Room expiry:
- Permanently deletes all messages
- Permanently deletes room_hash and access_hash records
- Cannot be undone
- The steg number can be reused to create a new room after expiry

---

## 10. Chat UI Features

### 10.1 Entry screen

- Two fields: phone number field, PIN field
- Phone field: password-type input by default (masked), eye-toggle to reveal
- PIN field: `inputmode="numeric"`, max 12 digits, masked, digits only
- "Enter" button: triggers client-side hash derivation then server verification
- Loading indicator during PBKDF2 key derivation (600,000 iterations — 1–2s on mobile)
- Error state: neutral, non-specific — "Could not open this room" — never reveals whether the room exists, the phone number was wrong, or the PIN was wrong (prevents enumeration)
- Lockout: after 10 failed PIN attempts, 30-minute lockout (server-enforced); counter shown ("3 attempts remaining")

### 10.2 Chat bubbles

- Sent messages: right-aligned, emerald gradient background (`linear-gradient(135deg, #10B981, #047857)`), white text, `border-radius: 1.5rem 1.5rem 0.25rem 1.5rem`
- Received messages: left-aligned, frosted glass background (`rgba(255, 255, 255, 0.08)` with `backdrop-filter: blur(8px)`), `--text-main` text, `border-radius: 1.5rem 1.5rem 1.5rem 0.25rem`
- Bubble tails per §3.4 geometry
- Each bubble contains: decrypted plaintext, read receipt indicator (sent only), "edited" label if applicable
- Long messages wrap naturally — no truncation, no "read more"

### 10.3 Sender input — active (recipient's turn to respond, or empty room)

- Full-width auto-resizing textarea (max ~140px then internal scroll)
- `Enter` to send, `Shift+Enter` for newline on desktop
- Send button (paper-airplane icon)
- Character limit: 4,000 characters with a soft counter appearing at 3,500

### 10.4 Sender input — waiting state (user has sent, awaiting reply)

When the user has sent a message and it has not yet been replied to, the textarea and send button **are removed entirely** and replaced by:

```
  ●  ●  ●   Waiting for reply…
```

Three dots in a looping staggered-bounce animation plus the label. Not a disabled input — genuinely absent. There is nothing to tap, nothing to try.

### 10.5 Typing indicator

When the other party is actively typing:

- A three-dot animation appears above the message area (or above the waiting label)
- No text label — just the dots
- Disappears after 3 seconds of no keystroke or on message send

### 10.6 Edit before read

- Long-press (mobile) or right-click (desktop) on own sent bubble reveals "Edit" (only if unread)
- The bubble's text is loaded into the input field for editing
- Sending the edit replaces the ciphertext on the server and broadcasts `:message_edited` to both parties
- "Edited" label appears beneath the bubble after a successful edit

### 10.7 Delete before read

- Long-press / right-click on own sent bubble reveals "Delete" (only if unread)
- Single tap confirmation — "Delete this message?" — one button: "Delete"
- Permanently removes the message from the server
- Room returns to empty state — both parties' inputs become active

### 10.8 Theme toggle — removed

The theme toggle has been removed. sTELgano uses a dark-only design. See §3.7.

### 10.9 Expire room

- Trash icon in the session header
- Confirmation modal: "End this conversation? This cannot be undone."
- On confirm: server deletes room + all messages; both parties' screens return to entry
- If the other party is connected, they see a "conversation ended" state and are returned to entry

### 10.10 Mobile responsiveness

- Designed and tested mobile-first at 320px minimum width
- Touch targets minimum 44×44px
- Keyboard-safe: chat input uses `position: sticky` at bottom, viewport-aware to avoid virtual keyboard overlap
- Tested on: iPhone SE (375px), Pixel 4a (393px), standard 390px, tablet 768px, desktop 1280px+

---

## 11. Lock & Session Features

### 11.1 Lock screen

The lock screen protects an open chat from anyone who finds an open browser tab. It is analogous to a screen lock, not authentication.

**Trigger conditions:**
- User explicitly taps the lock icon in the session header
- Configurable inactivity timeout: `30s · 1min · 5min · 15min · 30min · never`
- Browser tab loses focus for longer than the inactivity timeout

**Lock behaviour:**
- Chat content is immediately blurred and overlaid with the lock screen
- A PIN entry field is displayed over the overlay
- Correct PIN: enc_key is re-derived from phone + room_id (both retained in sessionStorage) → chat resumes instantly
- Wrong PIN: 2-second delay, attempt counter shown ("4 remaining")
- 5 consecutive wrong attempts on the lock screen: full session clear → returns to entry screen

**What the lock screen shows:**
- sTELgano wordmark
- PIN entry field
- "Enter PIN to resume"
- "Clear session" link (subtle — for panic use)
- Nothing about who the conversation is with, message content, or timestamps

### 11.2 Session storage model

| Value | Storage key | Storage location | Cleared when |
|-------|-------------|-----------------|-------------|
| Normalised phone number | `stelegano_phone` | `sessionStorage` | Tab close, logout, panic |
| `room_id` | `stelegano_room_id` | `sessionStorage` | Tab close, logout, panic |
| `room_hash` | `stelegano_room_hash` | `sessionStorage` | Tab close, logout, panic |
| `sender_hash` | `stelegano_sender_hash` | `sessionStorage` | Tab close, logout, panic |
| `access_hash` | `stelegano_access_hash` | `sessionStorage` | Tab close, logout, panic |
| `enc_key` (CryptoKey object) | — | JS memory only | Tab close, lock screen clear |
| PIN | — | **Never stored** | — |

On tab close, all session data is gone. Re-entry requires the steg number and PIN.

### 11.3 Logout

- "Leave" button in the session header (distinct from lock and expire)
- Immediate, no confirmation
- Clears sessionStorage, discards enc_key from memory
- Returns to entry screen
- Does **not** expire the room — the conversation and its current message remain on the server

### 11.4 Panic clear

- "Clear session" link on the lock screen — subtle text link, not a button
- One tap, no confirmation
- Immediately clears all sessionStorage and discards enc_key
- Returns to entry screen
- Does **not** expire the room

---

## 12. Multi-Device Access

The same user can access the same room from multiple devices simultaneously or sequentially. Because enc_key is derived deterministically from the phone number and room_id, any device that knows both can derive the correct key independently.

### 12.1 Simultaneous multi-device

If User A is connected on laptop and phone at the same time:
- Both receive new messages via Phoenix Channel simultaneously
- Both show the same decrypted message content
- Both show the same input state (locked if User A sent the last message)
- Typing indicator from User B appears on all of User A's connected devices

### 12.2 Sequential multi-device

If User A opens a new device:
1. Enter phone number + PIN
2. Server verifies access_hash, returns room_id and current message ciphertext
3. Client derives enc_key from phone + room_id
4. Current message decrypts and displays
5. Input state (locked/active) determined by whether current message's sender_hash matches this device's derived sender_hash

### 12.3 Session isolation

Each device maintains independent sessionStorage. Closing one device's tab does not affect other devices' sessions or the server-side room state.

---

## 13. Analytics Strategy

### 13.1 The tension

sTELgano's privacy claims are the product. Traditional analytics (Google Analytics, Mixpanel, etc.) contradict those claims — they introduce third-party scripts, send IP addresses and user-agent strings to external servers, and create persistent tracking identifiers. Using GA would undermine the "vet" principle: the code would claim to be private while quietly sending behavioural data elsewhere.

### 13.2 Decision

**No Google Analytics. No Mixpanel. No third-party analytics of any kind.**

This is a firm product decision, not a temporary one. It is documented in the privacy policy and on the homepage. Violating it would be a material breach of the product's core promise.

### 13.3 What is measured instead

Analytics are replaced by **server-side aggregate metrics only** — no individual tracking, no persistent identifiers, no cross-session correlation:

| Metric | How collected | Retained |
|--------|--------------|---------|
| Active rooms count | DB query | Real-time |
| Messages sent per day | DB aggregate | 90 days |
| Rooms created per day | DB aggregate | 90 days |
| Peak concurrent WebSocket connections | OTP telemetry | 90 days |
| Error rates by type | Logger aggregation | 30 days |
| Page load p50/p95 latency | Phoenix Telemetry | 30 days |

All metrics are computed server-side from existing operational data. No client-side instrumentation. No external requests. No user identifiers in any metric.

### 13.4 Plausible Analytics — considered and rejected

Plausible (self-hosted) and Fathom are privacy-respecting alternatives. However, even Plausible's cookieless tracking sends page URLs and IP-derived country data — a meaningful privacy concession for a product with sTELgano's positioning. The server-side aggregate model above provides sufficient product insight without any client-side instrumentation.

### 13.5 Open-source telemetry dashboard

An internal admin dashboard (accessible only via admin authentication) will display the server-side aggregate metrics. This dashboard is built into the Phoenix app and makes no external requests.

---

## 14. Public Pages

All public pages pass the Passcode Test — no page reveals that a conversation is occurring.

### 14.1 Homepage (`/`)

**Above the fold:**
- Wordmark and tagline
- Hero headline: one line that explains the product
- Sub-headline: the mechanism in plain English (steg number + PIN, no account)
- Primary CTA: "Start a private conversation" → `/chat`
- Secondary CTA: "Read the code" → GitHub

**Sections (in order):**
1. **How it works** — three numbered steps with illustrations
2. **Hidden in plain sight** — the phonebook trick, explained with a visual
3. **What the server stores** — honest two-column table (stores / never stores)
4. **Turn-based conversation** — explain N=1 as a feature, not just a constraint
5. **What we protect / don't protect** — explicit two-column list
6. **Open source** — AGPL explanation, GitHub link, the "vet" principle
7. **PRY + VET** — name etymology and product philosophy
8. **Donation / sustainability** — how the product stays running without monetising users

### 14.2 `/chat`

Application entry point. Blank screen. Two fields. sTELgano wordmark. The only URL in browser history from using the app.

### 14.3 `/security`

Full public cryptographic specification:
- Complete derivation chain with all salts and parameters
- PBKDF2 iteration count rationale (600,000 — OWASP 2023)
- AES-256-GCM parameters
- What the server stores (table) vs never stores (table)
- Full threat model (§4)
- Why SHA-256 is sufficient for access_hash (full reasoning)
- Why Argon2id was not used (Web Crypto API constraint, not a security shortcut)
- The N=1 defence against found-credentials attackers (§8.8)
- Comparison to Signal, WhatsApp, Telegram — what they do differently and why

### 14.4 `/privacy`

Privacy policy. Plain English. Key commitments:
- No personal data collected
- No email, phone number, or real identity stored
- Server stores only opaque hashes and encrypted ciphertext
- No analytics, no tracking pixels, no third-party scripts of any kind
- IP addresses appear in standard web server logs (disclosed) — purged within 48 hours
- No cookies beyond the session cookie (disclosed)
- GDPR/CCPA-compliant by design — there is no personal data to request, export, or delete

### 14.5 `/terms`

Terms of service. Plain English:
- Do not use for illegal activity
- No warranty — AGPL-3.0 open-source software provided as-is
- We cannot read your messages — we hold no decryption key
- We cannot recover lost rooms — if you lose your steg number and PIN, the room is inaccessible
- Dispute resolution and governing law

### 14.6 `/blog`

Technical blog. Implemented with `BlogController` (index + show by slug). Articles are date-ordered with slug-based routing at `/blog/:slug`.

### 14.7 `/about`

Who built this and why. Links to GitHub.

### 14.8 `/spec`

The sTELgano-std-1 protocol specification page. Published at `/spec` (not `/standard` as originally planned). Contains the full protocol specification for contact-layer steganographic messaging.

### 14.9 `/steg-number`

Standalone steg number generator page. Features a country selector dropdown (19 curated countries: Kenya, US, UK, Germany, France, Canada, Japan, Australia, India, Brazil, South Africa, Nigeria, Egypt, Morocco, Ethiopia, Ghana, Tanzania, Uganda, Rwanda) and a generate button. The generated number is shown in E.164 format, automatically copied to clipboard, and accompanied by a warning to save the number in contacts before proceeding. An "Open channel with this number" button navigates directly to `/chat?phone=<e164>` with the phone field pre-populated. Includes the "hidden in plain sight" setup guide.

---

## 15. Technical Architecture

### 15.1 Stack

| Layer | Technology |
|-------|-----------|
| Language | Elixir ~> 1.15 |
| Framework | Phoenix 1.8 / LiveView 1.1 |
| Real-time | Phoenix Channels (unauthenticated WebSocket) |
| Database | PostgreSQL 16 via Ecto |
| Background jobs | Oban |
| HTTP server | Bandit |
| Frontend CSS | Tailwind CSS v4 |
| Frontend JS | Vanilla JS + LiveView hooks |
| Crypto | Web Crypto API — browser built-in, zero external libraries |
| E2E testing | Wallaby |

### 15.2 Database schema

```sql
CREATE TABLE rooms (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_hash      VARCHAR(64) NOT NULL UNIQUE,   -- SHA-256 hex, 64 chars
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  ttl_expires_at TIMESTAMPTZ,
  inserted_at    TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON rooms (is_active);
CREATE INDEX ON rooms (ttl_expires_at);

CREATE TABLE room_access (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_hash       VARCHAR(64) NOT NULL,          -- references rooms.room_hash
  access_hash     VARCHAR(64) NOT NULL,          -- SHA-256(phone:PIN:ACCESS_SALT)
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  inserted_at     TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  UNIQUE (room_hash, access_hash)
);
CREATE INDEX ON room_access (room_hash);

CREATE TABLE messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id      UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender_hash  VARCHAR(64) NOT NULL,             -- SHA-256(phone:access_hash:room_hash:SENDER_SALT)
  ciphertext   BYTEA NOT NULL,
  iv           BYTEA NOT NULL,                   -- 96-bit GCM nonce (exactly 12 bytes)
  read_at      TIMESTAMPTZ,
  inserted_at  TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON messages (room_id);

-- NOTE: Messages use immediate hard-delete (not soft-delete).
-- When a reply is sent, the previous message is permanently removed
-- from the database in the same atomic transaction. No deleted_at column.
```

### 15.3 Phoenix Channel protocol

```
Socket path:    /anon_socket   (no session, no auth cookie required)
Channel topic:  anon_room:{room_hash}

Client → Server events:
  join            {room_hash, access_hash, sender_hash}     join the room (all 64-char hex)
  send_message    {ciphertext, iv}                          N=1 enforced server-side
  read_receipt    {message_id}                              triggers double tick
  edit_message    {message_id, ciphertext, iv}              sender only, unread only
  delete_message  {message_id}                              sender only, unread only
  typing          {}                                        broadcast to counterparty
  expire_room     {}                                        permanent deletion

Server → Client broadcasts (PubSub → all channel members):
  new_message         {id, sender_hash, ciphertext, iv, inserted_at}
  message_read        {message_id}
  message_edited      {message_id, ciphertext, iv}
  message_deleted     {message_id}
  counterparty_typing {}
  room_expired        {}
```

### 15.4 Client-side crypto — single source of truth

Lives at `assets/js/crypto/anon.js`. Vanilla JS. No npm dependencies. This file is the canonical implementation. The security page links directly to it on GitHub.

```js
// All constants defined here and nowhere else
const ROOM_SALT   = 'stelegano-room-v1-2026';
const ACCESS_SALT = 'stelegano-access-v1-2026';
const SENDER_SALT = 'stelegano-sender-v1-2026';
const ENC_SALT    = 'stelegano-enc-v1-2026';
const PBKDF2_ITER = 600_000;  // OWASP 2023 PBKDF2-SHA256 recommendation

export const AnonCrypto = {
  normalise, roomHash, accessHash, senderHash, deriveKey, encrypt, decrypt
};
```

`assets/js/hooks/chat.js` imports from `../crypto/anon.js` and `phone-number-generator-js` (npm).

### 15.5 Steg number generator — `phone-number-generator-js` npm package

The steg number generator uses the [`phone-number-generator-js`](https://www.npmjs.com/package/phone-number-generator-js) npm package (installed in `assets/package.json`). This replaces the former custom `phone-gen.js`.

- Supports 227 countries via the `CountryNames` enum (19 curated in the UI dropdown)
- E.164 format output
- Country-specific generation via `generatePhoneNumber({ countryName: CountryNames.Kenya })`
- Random country when no config is passed: `generatePhoneNumber()`
- The `PhoneGenerator` LiveView hook populates a `<select>` dropdown with all country names at mount time, reads the user's selection, and passes it to the generator
- Number is auto-copied to clipboard on generation

### 15.6 Security headers

Applied to all responses:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-{nonce}';
  style-src 'self' 'unsafe-inline'; connect-src 'self' wss://stelgano.com wss://stelgano.com;
  img-src 'self' data:; font-src 'self' data:; object-src 'none'; frame-ancestors 'none';
  base-uri 'self'; form-action 'self'; upgrade-insecure-requests
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
```

No external scripts permitted by CSP. All script tags use nonces generated per-request.

### 15.7 What is kept out of the repository

| Secret | Purpose | Delivery |
|--------|---------|---------|
| `SECRET_KEY_BASE` | Phoenix session signing | Environment variable |
| `DATABASE_URL` | PostgreSQL connection string | Environment variable |
| `ROOM_SALT` | SHA-256 domain separator | Optional env override |
| `ACCESS_SALT` | SHA-256 domain separator | Optional env override |
| `SENDER_SALT` | SHA-256 domain separator | Optional env override |
| `ENC_SALT` | PBKDF2 salt suffix | Optional env override |

The salts published in the open-source client JS are the default values. Self-hosters may override them via environment variables. The security model does not depend on salt secrecy — this is documented.

### 15.8 Repository structure

```
stelgano/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                  quality gates on every push
│   │   └── deploy.yml              auto-deploy main to Fly.io
│   ├── dependabot.yml              automated dependency updates
│   └── ISSUE_TEMPLATE/
│       └── bug_report.yml          bug report template
├── assets/
│   ├── css/
│   │   └── app.css                 Tailwind v4 — design tokens defined here
│   ├── js/
│   │   ├── app.js                  LiveSocket bootstrap
│   │   ├── crypto/
│   │   │   └── anon.js             AnonCrypto — single source of truth for all crypto
│   │   └── hooks/
│   │       └── chat.js             LiveView hooks — imports anon.js + phone-number-generator-js
│   ├── vendor/
│   │   └── topbar.js
│   ├── package.json                npm deps (phone-number-generator-js, phoenix file links)
│   └── node_modules/
├── config/
│   ├── config.exs
│   ├── dev.exs
│   ├── prod.exs
│   ├── runtime.exs                 secrets from env — never committed
│   └── test.exs
├── lib/
│   ├── stelgano/
│   │   ├── application.ex
│   │   ├── repo.ex
│   │   ├── rooms.ex                context — all business logic
│   │   ├── rooms/
│   │   │   ├── room.ex
│   │   │   ├── room_access.ex
│   │   │   └── message.ex
│   │   └── jobs/
│   │       └── expire_ttl_rooms.ex Oban job — hourly TTL expiry
│   └── stelgano_web/
│       ├── channels/
│       │   ├── anon_socket.ex
│       │   └── anon_room_channel.ex
│       ├── components/
│       │   ├── core_components.ex
│       │   └── layouts/
│       ├── controllers/
│       │   ├── page_controller.ex
│       │   ├── page_html/
│       │   │   ├── home.html.heex
│       │   │   ├── security.html.heex
│       │   │   ├── privacy.html.heex
│       │   │   ├── terms.html.heex
│       │   │   ├── about.html.heex
│       │   │   └── spec.html.heex
│       │   ├── blog_controller.ex
│       │   ├── blog_html/
│       │   └── panic_controller.ex
│       ├── plugs/
│       │   ├── security_headers.ex
│       │   ├── rate_limiter.ex
│       │   └── admin_auth.ex       HTTP Basic Auth for /admin
│       ├── live/
│       │   ├── chat_live.ex
│       │   ├── steg_number_live.ex
│       │   └── admin_dashboard_live.ex
│       ├── endpoint.ex
│       └── router.ex
├── priv/
│   ├── repo/migrations/            6 migrations (rooms, access, messages, oban, rate_limit, remove_deleted_at)
│   └── static/
│       ├── sw.js                    service worker (privacy-first caching)
│       ├── manifest.json            PWA manifest
│       ├── favicon.ico
│       └── images/
│           ├── icon-192.png         PWA icon
│           ├── icon-512.png         PWA icon
│           ├── apple-touch-icon.png
│           ├── favicon.svg
│           └── favicon-96x96.png
├── project/
│   ├── stelgano_PRD_v2_1.md        this document
│   ├── stelgano_Epics_v2_1.md      epics & user stories
│   ├── launch_content.md            launch copy for all platforms
│   ├── compliance_and_recommendations.md
│   └── *.html / *.css               design system reference files
├── test/                            ≥ 90% coverage enforced
├── AGENTS.md
├── CHANGELOG.md
├── CLAUDE.md
├── CODE_OF_CONDUCT.md
├── COMMERCIAL.md
├── CONTRIBUTING.md
├── LICENSE                          AGPL-3.0
├── README.md
├── SECURITY.md
├── mix.exs
└── mix.lock
```

---

## 16. Deployment Strategy

### 16.1 Multi-target approach

The application is deployable to both Digital Ocean and Fly.io with no code changes. Only environment variables differ between deployments.

### 16.2 Digital Ocean — initial deployment

```
Droplet: Ubuntu 24.04 LTS (4GB RAM, 2 vCPUs minimum)
├── Nginx (TLS termination, reverse proxy, HTTP→HTTPS redirect)
│   └── Let's Encrypt certificate via Certbot (auto-renewal)
├── sTELgano OTP release (Elixir/OTP)
│   └── Systemd service (restart on failure, log to journald)
└── PostgreSQL 16 (DO Managed Database — separate from app droplet)
```

Both `stelgano.com` and `stelgano.com` point to the same Droplet. Nginx handles both server names, serves identical content, and sets `Referrer-Policy: no-referrer` to prevent cross-domain leakage.

**Nginx configuration:**

```nginx
server {
  listen 443 ssl http2;
  server_name stelgano.com www.stelgano.com stelgano.com www.stelgano.com;

  ssl_certificate     /etc/letsencrypt/live/stelgano.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/stelgano.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # WebSocket support
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 3600s;                    # Long-lived WebSocket connections
  }
}

server {
  listen 80;
  server_name stelgano.com www.stelgano.com stelgano.com www.stelgano.com;
  return 301 https://stelgano.com$request_uri;
}
```

### 16.3 Fly.io — production scale

```toml
# fly.toml
app = "stelegano"
primary_region = "jnb"   # Africa-first

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 4000
  force_https = true
  auto_stop_machines = false  # keep alive for WebSocket persistence

[env]
  PHX_HOST = "stelgano.com"
  POOL_SIZE = "10"

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
```

Multi-region nodes use `libcluster` with `Cluster.Strategy.Fly` for automatic node discovery and `Phoenix.PubSub` with `pg` adapter for cross-node message broadcasting.

### 16.4 Dockerfile

```dockerfile
FROM hexpm/elixir:1.16.0-erlang-26.2.1-debian-bookworm-20231009-slim AS build

RUN apt-get update -y && apt-get install -y build-essential git nodejs npm curl

WORKDIR /app
COPY mix.exs mix.lock ./
RUN mix local.hex --force && mix local.rebar --force
RUN mix deps.get --only prod

COPY assets/package.json assets/package-lock.json assets/
RUN npm install --prefix assets

COPY . .
RUN MIX_ENV=prod mix assets.deploy
RUN MIX_ENV=prod mix release

FROM debian:bookworm-slim AS app
RUN apt-get update -y && apt-get install -y libssl3 libncurses5 locales

WORKDIR /app
COPY --from=build /app/_build/prod/rel/stelegano ./

ENV PHX_SERVER=true
EXPOSE 4000
CMD ["/app/bin/stelegano", "start"]
```

### 16.5 CI/CD pipeline

```yaml
# .github/workflows/ci.yml
on: [push, pull_request]

jobs:
  quality:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres

    steps:
      - uses: actions/checkout@v4
      - uses: erlef/setup-beam@v1
        with: { elixir-version: '1.16', otp-version: '26' }
      - run: mix deps.get
      - run: mix compile --warnings-as-errors
      - run: mix format --check-formatted
      - run: mix credo --strict
      - run: mix sobelow --config
      - run: mix dialyzer
      - run: mix test --cover
      - run: mix coveralls.github    # fails if < 90%

# .github/workflows/deploy.yml
  deploy:
    needs: quality
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions@master
        with:
          args: "deploy --remote-only"
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

---

## 17. Testing Requirements

### 17.1 Coverage target

**Minimum 90% line coverage**, enforced in CI via `excoveralls`. PRs that drop coverage below 90% are blocked from merging.

### 17.2 Test layers

| Layer | Tool | Target |
|-------|------|--------|
| Unit — context, schemas, crypto | ExUnit | 95% |
| Integration — channel, LiveView | ExUnit + Phoenix.ChannelTest | 90% |
| Property-based — crypto correctness | StreamData | Key invariants |
| E2E — full browser flow | Wallaby | Critical user journeys |

### 17.3 Required test cases

**Rooms context:**
- `join_room/2` — new room created; returning user admitted; wrong PIN rejected; lockout triggered at 10 attempts; expired room rejected; access record created on first join
- `send_message/4` — N=1 atomic enforcement; invalid base64 rejected; room not found
- `mark_read/2` — sender cannot mark own message; `read_at` set and broadcast; no-op on already-read
- `edit_message/4` — sender only; unread only; correct broadcast; invalid base64 rejected; already-read rejected
- `delete_message/2` — sender only; unread only; correct broadcast; room returns to empty; already-read rejected
- `expire_room/1` — messages hard-deleted; room marked inactive; broadcast sent
- `purge_expired/0` — only rooms past TTL purged; active rooms untouched

**Channel tests:**
- Join with valid room_hash and sender_hash → `{:ok, %{current_message: ...}}`
- Join with non-existent room_hash → `{:error, %{reason: "room_not_found"}}`
- Full cycle: send → read_receipt → reply → N=1 deletion confirmed
- Typing broadcast reaches counterparty only
- Room expiry broadcast reaches all connected members

**LiveView tests:**
- Entry screen renders correctly in both themes
- `chat_join_room` event: success path; locked path; expired path
- `set_input_locked` toggles waiting state correctly
- `expire_room` clears assigns and returns to entry

**Crypto property-based (StreamData):**
- `roomHash` is deterministic — same input always produces same output
- `accessHash` varies with PIN — `accessHash(p, "1234") ≠ accessHash(p, "5678")`
- `senderHash` varies with room_hash
- `encrypt → decrypt` round-trip is lossless for all valid UTF-8 strings
- Tampered ciphertext raises `DOMException` on decrypt
- `normalise` is idempotent — `normalise(normalise(x)) === normalise(x)`

**E2E (Wallaby):**
- Full conversation: User A sends → User B opens app → reads → replies → User A receives
- Lock screen: correct PIN resumes; wrong PIN shows counter; 5 failures clear session
- Edit flow: message edited before read; "edited" label appears; counterparty sees updated text
- Delete flow: message deleted; room returns to empty; both inputs activate
- Expire room: both parties returned to entry screen
- Theme toggle: persists on reload
- Mobile viewport: all interactions function at 375px width

---

## 18. Code Quality & Open Source

### 18.1 Quality gates — all run in CI and locally

| Tool | Purpose | Fail condition |
|------|---------|---------------|
| `mix compile --warnings-as-errors` | Zero compiler warnings | Any warning |
| `mix format --check-formatted` | Consistent formatting | Any unformatted file |
| `mix credo --strict` | Elixir static analysis | Any Credo issue |
| `mix sobelow --config` | Phoenix security audit | Any Sobelow finding |
| `mix dialyzer` | Type correctness | Any type violation |
| `mix test --cover` | Test suite | Any failing test |
| `mix coveralls.github` | Coverage enforcement | < 90% coverage |

### 18.2 Local precommit alias

```elixir
# mix.exs
"precommit": [
  "compile --warnings-as-errors",
  "deps.unlock --check-unused",
  "format",
  "credo --strict",
  "test"
]
```

### 18.3 CONTRIBUTING.md requirements

- All quality gates must pass before PR submission
- Any cryptography changes require explicit security review in the PR description
- New features require test coverage at or above the existing average
- Security vulnerabilities must be reported via `security@stelgano.com` before PR submission

---

## 19. Security Disclosure

- **Contact:** `security@stelgano.com`
- **Response time:** within 48 hours
- **Patch target:** 7 days for confirmed critical issues
- **Public disclosure:** after patch is released and deployed
- **No public GitHub issues** for unpatched vulnerabilities
- **Credit:** reporters credited by name or alias in CHANGELOG and SECURITY.md

---

## 20. Non-Functional Requirements

| Requirement | Target | Notes |
|-------------|--------|-------|
| Message delivery latency | < 500ms | WebSocket under normal conditions |
| PBKDF2 key derivation time | 1.5–2.5s | Mobile mid-range; loading indicator shown |
| Mobile responsiveness | 320px minimum width | Tested at 320, 375, 390, 393px |
| Touch target size | 44×44px minimum | WCAG 2.5.5 |
| Lighthouse performance (mobile) | ≥ 90 | Measured on `/` |
| Lighthouse accessibility | ≥ 95 | WCAG 2.1 AA |
| Uptime target | 99.5% monthly | |
| PIN lockout threshold | 10 attempts | Then 30-minute server lockout |
| N=1 atomicity | Guaranteed | Single DB transaction |
| IP log retention | 48 hours | Then purged |
| Test coverage | ≥ 90% | CI-enforced |
| CSP compliance | Strict nonce-based | No unsafe-inline or unsafe-eval |
| HTTPS enforcement | HSTS preload | max-age ≥ 2 years |
| Analytics third-party | None | Server-side aggregates only |

---

## 21. Out of Scope — v1

- Group conversations — strictly 1:1 in v1
- Media messages — text only in v1
- Native mobile app — PWA installation from browser only
- Push notifications — async delivery handles the use case; tab must be open
- Message search — no history means no search
- Government or institutional privacy protection
- Account recovery — no account exists; lost credentials mean lost room access
- Paid features or subscription tier
- End-to-end voice or video

---

## 22. Glossary

| Term | Definition |
|------|------------|
| Steg number | A steg number agreed out-of-band between two users, stored in each other's real phonebook contact, used as the shared secret |
| PIN | A personal numeric code chosen independently by each user. Never shared. Never stored anywhere. Used only for server-side access control via access_hash. |
| Same-PIN strategy | Using the same PIN across multiple rooms — simpler to remember, slightly weaker isolation |
| Unique-PIN strategy | Using a different PIN for each room — stronger isolation, requires more memory |
| room_hash | `SHA-256(phone + ROOM_SALT)` — opaque room identifier stored on server |
| access_hash | `SHA-256(phone + PIN + ACCESS_SALT)` — PIN gate. Different per user for the same room. |
| enc_key | `PBKDF2(phone, room_id + ENC_SALT, 600,000 iter)` — AES-256-GCM key. Browser only. Identical for both users. |
| sender_hash | `SHA-256(phone + access_hash + room_hash + SENDER_SALT)` — bubble-side determination. Includes access_hash so users with different PINs produce different sender identities. sessionStorage only. |
| N=1 | At most one message exists in a room at any time. A reply atomically deletes the previous message. |
| Async delivery | Messages wait encrypted on the server until the recipient opens the app. Simultaneous presence not required. |
| Turn-based | After sending, a user cannot send again until the other party replies. |
| Passcode test | If an unauthorised person with the device PIN opens sTELgano, they see only a blank entry screen. |
| Hidden in plain sight | The steg number is stored in the real phonebook contact of the other person — undetectable to a casual observer. |
| AGPL-3.0 | Licence requiring that anyone who modifies and runs this software as a service must publish their modifications. |
| Out-of-band | Communication happening outside sTELgano — in person, on a call. Used to share the steg number. |
| OWASP 2023 | Open Web Application Security Project — 600,000 iterations is their current recommendation for PBKDF2-SHA256. |

---

---

## 9. Room Lifecycle & Automated Cleanup

### 9.1 Design principle

The database should contain only rooms that are either actively in use or have been recently created and are waiting for a second party. Stale, abandoned, and expired rooms are a liability — they consume storage, bloat the steg number pool, and make accurate metrics harder to compute.

### 9.2 Room states (current implementation)

| State | Definition | Cleanup trigger |
|-------|------------|----------------|
| `active` | `is_active = TRUE`; room is usable | TTL expiry or manual expiry |
| `expired` | `is_active = FALSE`; manually ended or TTL elapsed | Terminal state |

### 9.3 Automated cleanup (current implementation)

An Oban job (`Stelgano.Jobs.ExpireTtlRooms`) runs **hourly** and expires rooms past their TTL:

| Condition | Action |
|-----------|--------|
| `ttl_expires_at < NOW() AND is_active = TRUE` | Sets `is_active = false`, hard-deletes all messages, broadcasts `room_expired` |
| Manual expiry via `expire_room` channel event | Same atomic expiry via `Rooms.expire_room/1` |

**Queue:** `:maintenance` with 2 workers, max 3 attempts per job.

### 9.4 Future: Advanced cleanup (not yet implemented)

The following cleanup states and rules are planned but not yet built:

- `pending_peer` — auto-delete rooms where the second party never joined (24h)
- `stale` — auto-delete rooms where no message was ever sent (48h)
- Dedicated number subscription lapse with 7-day grace period
- Steg number pool recycling

These features require additional database columns (`peer_joined_at`, `first_message_at`, `is_dedicated`, `stripe_sub_id`) that are not yet in the schema.

---

## 10. User-Defined TTL

### 10.1 Current implementation

Rooms have an optional `ttl_expires_at` column. When set, the `ExpireTtlRooms` Oban job automatically expires the room after the TTL elapses. Either party can also manually expire the room at any time via the `expire_room` channel event.

The in-chat TTL progress bar is implemented — a 3px bar beneath the chat header shows time remaining with green → amber → red colour transitions.

### 10.2 Future: TTL slider (not yet implemented)

The following TTL selection UI is planned but not yet built:

- TTL slider on new channel creation (1–7 day range, step 1 day)
- Countdown ring visualisation
- Expiry warning toasts at 2 days and 12 hours remaining
- Upgrade nudge to dedicated numbers

---

## 25. Business Model (not yet implemented)

> **Implementation status:** The entire business model — Stripe integration, dedicated numbers, billing firewall, pricing page, and transparency reports — is planned but not yet built. The specification below is retained for future implementation.

### 25.1 Philosophy

sTELgano operates on a **Stewardship-First** model. The product's privacy guarantees are a public commitment — they are not a feature tier. No privacy capability is gated behind payment. The distinction between free and paid is **number longevity**, not security level.

### 25.2 Tiers

| | Temporary (Free) | Dedicated |
|--|--|--|
| **Price** | $0 | **$2.00 / year** |
| **TTL** | 1–7 days, user-set | 1 year, renewable |
| **Number pool** | Shared — recycled on expiry | Dedicated — yours while active |
| **N=1 messaging** | Full | Full |
| **Encryption** | Identical | Identical |
| **Account required** | No | No |
| **Renewal** | Not applicable | Annual; 30/7/1-day reminders |
| **Grace on lapse** | Not applicable | 7 days before pool release |

**What the paid tier buys:** A steg number that is yours alone, for a year. Nothing else. The word "private" does not appear in the upgrade CTA — because privacy is not what you're buying.

**What the paid tier does not buy:** More privacy, stronger encryption, any security feature, message cap removal (there is no message cap), or any preferential treatment.

### 25.3 Why $2/year

$2/year is:
- Below any meaningful psychological price threshold — it removes no potential users on cost grounds
- Enough to cover infrastructure costs at scale for dedicated number holders
- Honest — it is a stewardship fee, not a SaaS subscription

### 25.4 Revenue allocation — the Guardian Salary model

| Allocation | Percentage | Purpose |
|------------|------------|---------|
| Infrastructure | 15% | Servers, bandwidth, DDoS protection |
| Payment processing | 10% | Stripe fees |
| Stewardship salary | 75% | Security monitoring, dependency auditing, zero-day response, browser compatibility |

The stewardship salary is drawn as a function of hours spent, capped at a published maximum. Excess revenue is held in reserve or directed to upstream open-source dependency maintainers.

A **Quarterly Transparency Report** is published on Open Collective covering: revenue received, infrastructure costs incurred, salary drawn, and security milestones achieved. This is a commitment, not a marketing claim.

### 25.5 Payment implementation

- Payment processor: **Stripe** — standard card payments only
- Cryptocurrency: **not accepted** — adds KYC complexity, regulatory risk, and operational overhead that is disproportionate to a $2/year product
- Billing firewall: the Stripe webhook returns only `{ttl_expires_at: timestamp, is_dedicated: true}` to the relay — no name, no email, no card metadata crosses into the sTELgano application database
- No Stripe customer ID is stored in the rooms table — only the Stripe subscription ID for renewal checking
- Stripe customer record contains email (for renewal reminders) — this is disclosed in the privacy policy

### 25.6 The honesty hook

Published verbatim on the pricing page, /about, and in the launch announcement:

> *"We will never put a privacy feature behind a paywall. You are not buying more security — you are buying a number that is yours alone, and the certainty that someone is awake to keep the protocol honest."*

### 25.7 What is explicitly rejected from the submitted proposal

The following elements from the submitted business model proposal were considered and rejected:

| Rejected element | Reason |
|-----------------|--------|
| "10 turns" message cap on free tier | Breaks the N=1 invariant; makes the free product worse for the wrong reason |
| Standard / Power tier matrix | Unnecessary complexity; the free/dedicated binary is cleaner and more honest |
| Monero / Bitcoin payments | Disproportionate operational and regulatory complexity for a $2 product |
| "Dead drops" language | Implies illegal use cases; attracts regulatory attention |
| Enterprise B2B "Vaults" | Premature; adds product complexity before product-market fit |
| "Tactical HUD" branding | Belongs to a different product concept; contradicts sTELgano's design language |

---

## 23. Admin Dashboard

### 23.1 Overview

sTELgano's admin dashboard is an internal, server-side-rendered panel built directly into the Phoenix application. It is accessible only via `/admin` and is protected by HTTP Basic Auth. It makes no external requests, loads no third-party scripts, and is excluded from the public-facing Content Security Policy.

The dashboard exists to provide the operator with meaningful operational insight while strictly upholding the product's privacy guarantees. The admin can see *how the system is performing* — never *what any individual is doing*.

**Design principle:** If a query could identify a room, a user, or a conversation, it is blocked.

---

### 23.2 Authentication — HTTP Basic Auth

#### 23.2.1 Current implementation

- Authentication: HTTP Basic Auth with constant-time credential comparison
- Credentials sourced from `ADMIN_USERNAME` (default: `"admin"`) and `ADMIN_PASSWORD` environment variables
- `ADMIN_PASSWORD` is required in production — startup fails without it
- Constant-time comparison uses SHA-256 hash equality to prevent timing attacks
- Unauthorized requests receive HTTP 401 with `WWW-Authenticate` header

#### 23.2.2 Admin route security

- `/admin/*` is declared in a separate Phoenix scope with a custom `AdminAuth` plug
- Pipeline: `pipe_through [:browser, :admin_auth]`
- Not linked from any public page; not present in `robots.txt` allow list
- CSP for admin routes is identical to public routes — no loosened policy

#### 23.2.3 Future: TOTP upgrade (not yet implemented)

The PRD originally specified TOTP authentication. This is planned as a future upgrade but is not yet built. The current HTTP Basic Auth is sufficient for single-operator deployments.

---

### 23.3 Privacy-Safe Metrics (current implementation)

All metrics are computed server-side from existing database operational data via `Stelgano.Rooms.aggregate_metrics/0`. No client-side instrumentation. No user identifiers in any metric.

#### 23.3.1 Implemented metrics (AdminDashboardLive)

The admin dashboard currently displays four aggregate metric cards:

| Metric | Query | Privacy note |
|--------|-------|--------------|
| Active chats | `COUNT(*) FROM rooms WHERE is_active = TRUE` | Count only, no identifiers |
| New chats today | Rooms created in last 24 hours | Count only |
| Messages sent today | Messages inserted in last 24 hours | Count only, encrypted content |
| Total chats (90 days) | Rooms created in last 90 days | Count only |

- Auto-refresh: 30-second timer with manual refresh button
- Info panel: lists operational guidelines and data retention policy
- No individual room identifiers, hashes, or content visible anywhere

#### 23.3.2 Future metrics (not yet implemented)

The following metrics are planned but not yet built:

- Room lifetime distribution (bucketed)
- WebSocket connection tracking (peak/current)
- Error rate breakdown by type
- Message delivery latency p50/p95
- PIN verification failure rates
- Performance metrics (page load, DB query latency)

---

### 23.4 Future: NL → SQL Query Interface (not yet implemented)

The PRD originally specified a natural language → SQL interface powered by Claude. This feature is planned but not yet built. The specification is retained here for future implementation reference. Key design points: SELECT-only queries, privacy guardrails blocking sensitive columns (`room_hash`, `access_hash`, `sender_hash`, `ciphertext`, `iv`), read-only transactions, and aggregate-only results.

### 23.5 Future: Analytics Visualisation (not yet implemented)

Time-series charts (Chart.js, self-hosted) showing message/room activity, room lifetime distribution, WebSocket connections, and error rates are planned but not yet built.

### 23.6 Future: Audit Log (not yet implemented)

An `admin_audit_log` table recording all admin actions is planned but not yet built.

---

### 23.7 Admin implementation (actual)

#### 23.7.1 Files

```
lib/
├── stelgano_web/
│   ├── plugs/
│   │   └── admin_auth.ex                 HTTP Basic Auth guard
│   └── live/
│       └── admin_dashboard_live.ex       overview with 4 metric cards + auto-refresh
├── stelgano/
│   └── rooms.ex                          aggregate_metrics/0 function
```

#### 23.7.2 Environment variables

| Variable | Purpose | Required |
|----------|---------|---------|
| `ADMIN_USERNAME` | Admin username (default: `"admin"`) | No |
| `ADMIN_PASSWORD` | Admin password | Yes (production) |

#### 23.7.3 Router scope

```elixir
scope "/admin", StelganoWeb do
  pipe_through [:browser, :admin_auth]

  live "/", AdminDashboardLive
end
```

---

### 23.8 What the admin cannot see

This is as important as what they can see. The admin panel is designed with the following explicit prohibitions:

| What | Why |
|------|-----|
| Any room_hash | Would allow enumeration of rooms |
| Any access_hash | Would allow targeted brute-force offline |
| Any ciphertext or IV | Encrypted message content — operator cannot decrypt |
| Any sender_hash | Would allow tracking conversation participants |
| Raw IP addresses | Purged within 48 hours; only hashed form in audit log |
| Message content in any form | The operator genuinely cannot read messages |
| Which rooms are active right now | Count only — not identifiers |
| Individual user behaviour | No persistent user identity exists |

This section is published in the privacy policy and on the `/security` page. It is the "vet" principle applied to the admin: even the operator can verify, via the open-source code, that they cannot access what they claim they cannot access.

---

---

## 24. The sTELgano Standard

### 24.1 What is the sTELgano Standard?

sTELgano-std-1 is an open protocol specification for contact-layer steganographic messaging. It defines the technique and its cryptographic requirements in enough detail that any developer can build a conforming implementation. The reference implementation is the sTELgano application at stelgano.com, released under AGPL-3.0.

The Standard is the "vet" principle made concrete: not only can users audit the code, third-party developers can build alternative implementations and test them against the same conformance requirements.

### 24.2 What the Standard defines

| Component | Specification |
|-----------|--------------|
| Steg number format | Valid E.164, unassigned/fictional ranges, generated with `crypto.getRandomValues` |
| Normalisation | Digits + country code prefix only; strips spaces, dashes, dots, parentheses, leading `+` |
| room_hash | `SHA-256(normalise(steg_number) ∥ ROOM_SALT)` |
| access_hash | `SHA-256(normalise(steg_number) ∥ PIN ∥ ACCESS_SALT)` |
| enc_key | `PBKDF2-SHA256(steg_number, room_id ∥ ENC_SALT, 600 000 iter, 256-bit output)` |
| Message encryption | AES-256-GCM, 96-bit random IV per message, 128-bit GCM auth tag |
| N=1 invariant | At most one message per room at any time; reply atomically replaces previous |
| Lockout | ≥ 10 failed access attempts triggers ≥ 30-minute lockout per (room_hash, access_hash) |
| Storage prohibition | steg_number, PIN, enc_key, plaintext MUST NOT be stored server-side |
| Analytics | No third-party analytics scripts; server-side aggregates only |
| Licence | AGPL-3.0 or compatible open-source licence REQUIRED for conforming implementations |

### 24.3 What the Standard does not define

The Standard deliberately leaves the following to implementors:

- UI design and visual language (implementations may use any design)
- Server technology (Elixir/Phoenix is the reference; any stack is valid)
- Database engine (PostgreSQL is the reference; any ACID-compliant DB is valid)
- Real-time transport (Phoenix Channels is the reference; WebSockets, SSE, or polling are all valid)
- Salt values (the reference salts are published; self-hosters may override them)
- TTL and expiry policies (rooms may have any TTL; the N=1 invariant is non-negotiable)

### 24.4 Conformance levels

**sTELgano-std-1 Compatible** — implements all MUST requirements. May display the compatibility badge.

**sTELgano-std-1 Reference** — the stelgano.com application itself. Sets the canonical interpretation of all requirements.

### 24.5 Compatibility badge

Conforming implementations may display the following badge in their README, app, and documentation:

```
sTELgano | std-1 compatible
```

Rendered as: the wordmark (`s` light · `TEL` accent · `gano` light) alongside "std-1 compatible" in Protocol Amber. Self-attestation is accepted — the AGPL-3.0 requirement ensures the claim is auditable against the published source code.

### 24.6 How to submit a conforming implementation

1. Publish the source code under AGPL-3.0 or a compatible licence
2. Implement all MUST requirements from §24.2
3. Open a GitHub issue on the sTELgano reference repository with a link to your implementation
4. The reference repository will maintain a list of known conforming implementations

### 24.7 The Standard and the Passcode Test

The Passcode Test (§5) is a **conformance requirement of sTELgano-std-1**. Any implementation where an unauthorised person with device access can determine that a private conversation is occurring or has occurred **fails conformance**, regardless of whether the cryptographic requirements are met.

The Passcode Test is the human-facing expression of the contact-layer steganography principle: the channel must be as invisible as the steg number in the contacts app.

---

*sTELgano PRD v2.2 — April 2026*
*stelgano.com · sTELgano-std-1 · AGPL-3.0*
*Hidden in the contact layer. Open by principle.*
