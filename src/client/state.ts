// SPDX-License-Identifier: AGPL-3.0-only
//
// Chat state machine.
//
// Models the v1 chat_live.ex state machine in plain TypeScript:
//
//   entry → deriving → [new_channel?] → connecting → chat
//                                                    ↓ ↑
//                                                  locked
//                                                    ↓
//                                                  expired (terminal)
//
// The state object is the single source of truth for what the UI
// shows. The view layer (Phase 5d) subscribes via onStateChange()
// and rebuilds the DOM. The state machine itself never touches the
// DOM and never imports from a view module — it's pure data + a
// thin RPC layer over RoomClient + AnonCrypto.
//
// Side effects (network, crypto, sessionStorage) happen inside the
// async action methods. Each action is the v1 equivalent of a
// handle_event clause and produces 0+ setState() calls before
// resolving.

import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";
import { type CountryNames, generatePhoneNumber } from "phone-number-generator-js";
import type { JoinReply, MessagePayload } from "../protocol";
import {
  decrypt,
  accessHash as deriveAccessHash,
  deriveKeyInWorker,
  roomHash as deriveRoomHash,
  senderHash as deriveSenderHash,
  encrypt,
  fromBase64,
  generateExtensionToken,
  type ProgressCallback,
  toBase64,
} from "./crypto/anon";
import { RoomClient, type RoomClientError } from "./room_client";

// Mapping of ISO codes to Flag Emojis
function getFlag(iso: string): string {
  if (iso === "XK") return "🇽🇰";
  return iso
    .toUpperCase()
    .replace(/./g, (char) => String.fromCodePoint(127397 + char.charCodeAt(0)));
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

export const COUNTRY_DATA = getCountries()
  .map((iso) => ({
    iso,
    flag: getFlag(iso),
    dialCode: `+${getCountryCallingCode(iso)}`,
    name: regionNames.of(iso) || iso,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

// Adapter for phone-number-generator-js
export const COUNTRY_LIST: Array<{ name: string; iso: string }> = COUNTRY_DATA.map((c) => ({
  name: c.name,
  iso: c.iso,
}));

// ---------------------------------------------------------------------------
// Public state shape
// ---------------------------------------------------------------------------

/** Decrypted message visible to the UI. ciphertext + iv are kept so
 *  edit/delete can re-validate ownership, and so the displayed text
 *  can be re-rendered without holding a DOM reference. */
export type PlainMessage = {
  id: string;
  senderHash: string;
  plaintext: string;
  /** ISO timestamp the server stamped at insert. */
  insertedAt: string;
  /** ISO timestamp when the recipient marked it read, or null. */
  readAt: string | null;
  /** True after the sender has edited this message. */
  edited: boolean;
};

/** Server-side monetization + TTL settings fetched from /api/config. */
export type Config = {
  monetizationEnabled: boolean;
  freeTtlDays: number;
  paidTtlDays: number;
  priceCents: number;
  currency: string;
};

const DEFAULT_CONFIG: Config = {
  monetizationEnabled: false,
  freeTtlDays: 7,
  paidTtlDays: 365,
  priceCents: 200,
  currency: "USD",
};

/** Generator drawer state — orthogonal to the main flow but only
 *  reachable from the entry surface (Phase 6 scope). */
export type GeneratorState = {
  open: boolean;
  /** CountryNames enum value e.g. "United Arab Emirates", or null
   *  when nothing's been picked yet. */
  selectedCountry: string | null;
  /** Live filter for the country dropdown. */
  searchQuery: string;
  /** Whether the country dropdown is visible (focus/click toggles it). */
  showCountries: boolean;
  /** Generated number in E.164. null until generate runs. */
  generatedNumber: string | null;
  /** True while the generator is running (brief — there's a
   *  cosmetic 600ms delay v1 used for "calculating" feel). */
  generating: boolean;
  /** True for 2 seconds after auto-copying the generated number. */
  copiedNumber: boolean;
};

type BaseState = {
  /** Optional overlay for informational pages (Terms, Spec, etc.) to prevent reloads. */
  overlay?: { title: string; html: string; loading: boolean } | null;
};

export type State = BaseState &
  /** Initial. Form is empty (or the phone is pre-populated from
   *  sessionStorage / generator drawer / handoff). */
  (
    | {
        kind: "entry";
        /** Pre-populated phone, or "" when blank. */
        phone: string;
        /** Typed PIN. masked in UI. */
        pin: string;
        /** Confirmation PIN. */
        confirmPin: string;
        /** ISO country code for the dropdown e.g. "US". */
        countryIso: string;
        /** True when the phone field was set by a previous session
         *  or the post-payment handoff — UI renders it read-only. */
        phoneLocked: boolean;
        /** Eye-toggle state for the phone field. */
        phoneVisible: boolean;
        /** Whether the terms have been accepted. */
        acceptedTerms: boolean;
        /** Whether the user has confirmed they've saved their identity. */
        confirmedSaved: boolean;
        /** Current onboarding step (0-2), or null if skipped/finished. */
        onboardingStep: number | null;
        /** Error banner copy (e.g. "Wrong PIN") — null means no
         *  banner. Cleared on next submit. */
        error: string | null;
        /** When error is a failed-auth, how many attempts remain
         *  before the 30-minute lockout. */
        attemptsRemaining: number | null;
        /** True while generating a new number. */
        generating: boolean;
        /** Whether the country dropdown is visible. */
        showCountries: boolean;
        /** Live filter for the country dropdown. */
        searchQuery: string;
        /** True if the phone number is valid according to libphonenumber-js. */
        phoneValid: boolean;
      }
    /** PBKDF2 in flight. The 600k iterations take ~1.5–2.5s. */
    | {
        kind: "deriving";
        phone: string;
        pin: string;
        countryIso: string;
        /** 0–100; updated by the worker. */
        progress: number;
      }
    /** Monetization-on case: room doesn't exist on the server yet, the
     *  user has to pick a tier. Skipped when monetization is off (the
     *  state machine auto-fires continueFree() in that path). */
    | {
        kind: "new_channel";
        phone: string;
        pin: string;
        countryIso: string;
        roomHash: string;
        accessHash: string;
        senderHash: string;
        /** True while the paid-tier button is in flight (token
         *  generation + POST /api/payment/initiate + redirect). */
        paymentLoading: boolean;
        /** Error banner copy after a failed payment init, null
         *  otherwise. Cleared when the user clicks a tier again. */
        paymentError: string | null;
        /** Free TTL in days from server config — rendered in the Free button. */
        freeTtlDays: number;
        /** Price in minor currency units (e.g. cents). */
        priceCents: number;
        /** ISO 4217 currency code (e.g. "USD"). */
        currency: string;
      }
    /** Opening the WebSocket and joining. Brief — under a second
     *  typically. */
    | { kind: "connecting"; phone: string; countryIso: string }
    /** The chat surface. */
    | {
        kind: "chat";
        phone: string;
        countryIso: string;
        senderHash: string;
        /** N=1: at most one. */
        current: PlainMessage | null;
        /** True iff the OTHER party is composing. UI shows the
         *  indicator; resets on next state change. */
        counterpartyTyping: boolean;
        /** Inline edit of own message. The edit textarea is
         *  uncontrolled — the initial value comes from
         *  current.plaintext at the moment startEdit() is called, and
         *  saveEdit(text) reads the textarea's DOM value directly.
         *  Keeps the textarea focus stable across renders. */
        editing: boolean;
        /** Destruction modal: renders over the chat when true. */
        confirmExpire: boolean;
        /** ISO timestamp when the room TTL expires. null = no TTL (or unknown). */
        ttlExpiresAt: string | null;
        /** True while a payment redirect is in flight from the Extend button. */
        paymentLoading: boolean;
        /** Error copy after a failed extend attempt. */
        paymentError: string | null;
      }
    /** Wrong PIN OR 30-min lockout. PIN re-entry only — phone stays
     *  the same. Splits from v1 into two sub-flows keyed by `reason`. */
    | {
        kind: "locked";
        phone: string;
        countryIso: string;
        reason: "unauthorized" | "locked";
        attemptsRemaining?: number;
        /** Error copy for a failed unlock attempt, e.g. "Wrong PIN". */
        lockError: string | null;
        /** Number of pips shown in v1's corner — how many failed
         *  attempts so far in this lock session. */
        lockAttempts: number;
      }
    /** Terminal. Room TTL hit, expire_room fired, or connection
     *  bounced after expiry. */
    | { kind: "expired" }
  );

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SessionStorage keys (cleared on logout / panic / room expiry)
// ---------------------------------------------------------------------------

const STORAGE_KEYS = [
  "stelegano_phone",
  "stelegano_room_hash",
  "stelegano_sender_hash",
  "stelegano_access_hash",
  "stelegano_extension_secret",
  "stelegano_handoff_phone",
  "stelegano_handoff_pin",
  "stelegano_handoff_country",
  "stelegano_handoff_tier",
] as const;

function clearSession() {
  try {
    for (const k of STORAGE_KEYS) sessionStorage.removeItem(k);
  } catch {
    // sessionStorage may be disabled
  }
}

function paymentErrorCopy(code: string): string {
  switch (code) {
    case "monetization_disabled":
      return "Paid tiers are not available on this instance.";
    case "paystack_not_configured":
      return "Checkout is not configured yet. Try Free for now.";
    case "invalid_token_hash":
      return "Token generation failed. Try again.";
    case "create_token_failed":
      return "Could not create payment token. Try again.";
    case "provider_unavailable":
      return "Payment provider is unreachable. Check your connection and try again.";
    case "provider_error":
      return "Payment provider returned an error. Try again.";
    default:
      return "Payment could not start. Try again.";
  }
}

function readHandoffPhone(): string {
  try {
    return sessionStorage.getItem("stelegano_handoff_phone") ?? "";
  } catch {
    return "";
  }
}

function readHandoffPin(): string {
  try {
    return sessionStorage.getItem("stelegano_handoff_pin") ?? "";
  } catch {
    return "";
  }
}

function readHandoffCountry(): string {
  try {
    return sessionStorage.getItem("stelegano_handoff_country") ?? "US";
  } catch {
    return "US";
  }
}

/** Reads stelegano_handoff_tier. Set by initiatePayment
 *  before the Paystack redirect; read once on return to decide
 *  whether to skip the new_channel screen. */
function readHandoffTier(): string | null {
  try {
    return sessionStorage.getItem("stelegano_handoff_tier");
  } catch {
    return null;
  }
}

function clearHandoff(): void {
  try {
    sessionStorage.removeItem("stelegano_handoff_phone");
    sessionStorage.removeItem("stelegano_handoff_pin");
    sessionStorage.removeItem("stelegano_handoff_tier");
  } catch {
    // ignore
  }
}

/** GET /api/room/:roomHash/exists — probes whether the DO has a
 *  state row. Used before full join to route first-time numbers
 *  through new_channel. On any failure (network error, non-200,
 *  unparseable body), returns true so the caller auto-joins —
 *  false positives on the probe would surface as a "tier
 *  selection" screen for a returning user, which is worse than
 *  the alternative of silently auto-creating a free room. */
async function probeRoomExists(roomHash: string): Promise<boolean> {
  try {
    const r = await fetch(`/api/room/${roomHash}/exists`);
    if (!r.ok) return true;
    const body = (await r.json()) as { exists?: boolean };
    return body.exists === true;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// ChatState
// ---------------------------------------------------------------------------

export class ChatState {
  private state: State;
  private readonly listeners: Array<(s: State) => void> = [];

  // Side-effect-y handles, NOT part of the public State (so the view
  // doesn't accidentally consume them and bypass the action API).
  private client: RoomClient | null = null;
  private key: CryptoKey | null = null;
  /** Used for re-deriving on locked → re-enter without re-typing. */
  private cachedHashes: {
    phone: string;
    roomHash: string;
    accessHash: string;
    senderHash: string;
  } | null = null;
  private config: Config = DEFAULT_CONFIG;

  constructor() {
    const handoffPhone = readHandoffPhone();
    const handoffPin = readHandoffPin();
    const handoffCountry = readHandoffCountry();

    // If we have both, we skip the entry form entirely on return.
    if (handoffPhone && handoffPin) {
      this.state = this.initialEntry(handoffPhone, handoffCountry, true, true);
      // Fill the PIN so submit() can pick it up.
      this.state.pin = handoffPin;
      this.state.confirmPin = handoffPin;
      this.state.acceptedTerms = true;
      this.state.confirmedSaved = true;
      // Defer submission to the next tick so the state machine is ready.
      setTimeout(() => this.submit(), 0);
    } else {
      this.state = this.initialEntry(handoffPhone, handoffCountry, !!handoffPhone, !!handoffPhone);
    }
  }

  private initialEntry(
    phone = "",
    countryIso = "US",
    phoneLocked = false,
    phoneVisible = false,
  ): Extract<State, { kind: "entry" }> {
    return {
      kind: "entry",
      phone: phone || readHandoffPhone(),
      pin: "",
      confirmPin: "",
      countryIso: countryIso || readHandoffCountry(),
      phoneLocked,
      phoneVisible,
      acceptedTerms: false,
      confirmedSaved: false,
      onboardingStep: null,
      error: null,
      attemptsRemaining: null,
      generating: false,
      showCountries: false,
      searchQuery: "",
      phoneValid: false,
    };
  }

  /** Apply server-side configuration fetched from /api/config. */
  updateConfig(c: Config): void {
    this.config = c;
  }

  // -------------------------------------------------------------------------
  // Subscription API (used by the view layer)
  // -------------------------------------------------------------------------

  getState(): State {
    return this.state;
  }

  onStateChange(fn: (s: State) => void): () => void {
    this.listeners.push(fn);
    fn(this.state);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  private setState(s: State): void {
    this.state = s;
    for (const l of this.listeners) {
      try {
        l(s);
      } catch {
        // never let a listener crash kill the state machine
      }
    }
  }

  // -------------------------------------------------------------------------
  // Action: submit the entry form
  // -------------------------------------------------------------------------

  /** Derives the room/access/sender hashes, derives the AES key
   *  (PBKDF2, off-thread), opens the WS, joins. Routes to
   *  new_channel/connecting/chat/locked based on the join reply.
   *  Callers are responsible for validating inputs before calling. */
  async submit(phoneOverride?: string, pinOverride?: string): Promise<void> {
    const s = this.state;
    // We allow submit from 'entry' (standard) or 'locked' (re-auth)
    if (s.kind !== "entry" && s.kind !== "locked") return;

    const phone = phoneOverride ?? (s.kind === "entry" ? s.phone : s.phone);
    const pin = pinOverride ?? (s.kind === "entry" ? s.pin : "");
    const confirmPin = s.kind === "entry" ? s.confirmPin : pin;
    const acceptedTerms = s.kind === "entry" ? s.acceptedTerms : true;
    const confirmedSaved = s.kind === "entry" ? s.confirmedSaved : true;

    // Validation
    if (!phone) {
      if (s.kind === "entry") this.setState({ ...s, error: "phone number required" });
      return;
    }

    if (!pin) {
      if (s.kind === "entry") this.setState({ ...s, error: "PIN required" });
      else this.setState({ ...s, lockError: "PIN required" });
      return;
    }

    if (pin !== confirmPin) {
      if (s.kind === "entry") this.setState({ ...s, error: "PINs do not match" });
      else this.setState({ ...s, lockError: "PINs do not match" });
      return;
    }

    if (!acceptedTerms || !confirmedSaved) {
      if (s.kind === "entry")
        this.setState({ ...s, error: "Please accept terms and confirm you saved your number" });
      return;
    }

    // Normalise based on current country if not already international
    const countryIso = s.countryIso;
    let fullPhone = phone;

    if (!phone.startsWith("+")) {
      // Try prepending the dial code vs prepending just '+' (in case it already has the dial code)
      const dialCode = COUNTRY_DATA.find((c) => c.iso === countryIso)?.dialCode ?? "";
      const dialPhone = `${dialCode}${phone}`;
      const plusPhone = `+${phone}`;

      const p1 = parsePhoneNumberFromString(dialPhone);
      const p2 = parsePhoneNumberFromString(plusPhone);

      if (p2?.isValid()) {
        fullPhone = p2.number;
      } else if (p1?.isValid()) {
        fullPhone = p1.number;
      } else {
        fullPhone = dialPhone;
      }
    }
    const parsed = parsePhoneNumberFromString(fullPhone);

    if (!parsed?.isValid()) {
      if (s.kind === "entry") this.setState({ ...s, error: `invalid ${countryIso} phone number` });
      else this.setState({ ...s, lockError: `invalid phone number` });
      return;
    }

    const normalisedPhone = this.normalised(fullPhone);

    // Phase 1: derive identifiers (instant — three SHA-256 calls).
    // room_hash and access_hash can derive in parallel; sender_hash
    // depends on both so waits.
    const [roomHash, accessHash] = await Promise.all([
      deriveRoomHash(normalisedPhone),
      deriveAccessHash(normalisedPhone, pin),
    ]);
    const senderHash = await deriveSenderHash(normalisedPhone, accessHash, roomHash);

    this.cachedHashes = {
      phone: normalisedPhone,
      roomHash,
      accessHash,
      senderHash,
    };

    // Phase 2: PBKDF2 (slow). Visualise progress.
    this.setState({ kind: "deriving", phone: normalisedPhone, pin, countryIso, progress: 0 });

    const onProgress: ProgressCallback = (percent) => {
      // Only update if we haven't been thrown off this state by a
      // panic / cancel.
      if (this.state.kind === "deriving") {
        this.setState({ ...this.state, progress: percent });
      }
    };

    try {
      // We use the room_hash as the room_id for PBKDF2 salt — both
      // parties derive it identically from the phone number, so they
      // arrive at the same key.
      this.key = await deriveKeyInWorker(normalisedPhone, roomHash, onProgress);
    } catch {
      // Crypto failure — usually means the browser blocks Web Crypto
      // (very old browsers). Drop back to entry.
      this.setState(this.initialEntry(phone, countryIso, false));
      return;
    }

    // Phase 3: probe the room. If it exists (returning user) OR the
    // caller is landing back from a Paystack checkout with
    // handoff_tier=free stashed, connectAndJoin directly. Otherwise
    // route through new_channel so the user picks a tier — only
    // Free calls connectAndJoin next; Paid sends the user through
    // Paystack first.
    const exists = await probeRoomExists(roomHash);
    const handoffTier = readHandoffTier();
    if (exists || handoffTier === "free" || !this.config.monetizationEnabled) {
      await this.connectAndJoin(normalisedPhone, countryIso, roomHash, accessHash, senderHash);
    } else {
      this.setState({
        kind: "new_channel",
        phone: normalisedPhone,
        pin,
        countryIso,
        roomHash,
        accessHash,
        senderHash,
        paymentLoading: false,
        paymentError: null,
        freeTtlDays: this.config.freeTtlDays,
        priceCents: this.config.priceCents,
        currency: this.config.currency,
      });
    }
  }

  /** Normalises a phone number to digits only. */
  private normalised(raw: string): string {
    return raw.replace(/\D/g, "");
  }

  // -------------------------------------------------------------------------
  // Action: locked → re-enter PIN (re-derive without re-typing phone)
  // -------------------------------------------------------------------------

  async reauthenticate(pin: string): Promise<void> {
    if (this.state.kind !== "locked") return;
    await this.submit(this.state.phone, pin);
  }

  // -------------------------------------------------------------------------
  // Action: free-tier confirm on the new_channel screen
  //
  // Phase 7 (Paystack) will add `initiatePayment` for the paid path.
  // For now the state machine treats new_channel as a one-button
  // confirm — both v1 monetization-off and the "Continue Free" click
  // route through here.
  // -------------------------------------------------------------------------

  async continueFree(): Promise<void> {
    if (this.state.kind !== "new_channel") return;
    const { phone, countryIso, roomHash, accessHash, senderHash } = this.state;
    await this.connectAndJoin(phone, countryIso, roomHash, accessHash, senderHash);
  }

  // -------------------------------------------------------------------------
  // Action: paid-tier checkout (new_channel)
  //
  // Generates a fresh extension secret + its SHA-256 hash, stashes
  // the secret + phone in sessionStorage so the client can redeem
  // after returning from Paystack, POSTs the hash to the server to
  // create the extension_tokens row, and redirects to the returned
  // Paystack URL.
  //
  // The server endpoint is /api/payment/initiate. Phase 7 wires the
  // actual Paystack.initialize call; for now the endpoint returns
  // 501 when monetization is on but Paystack isn't configured, and
  // 503 when monetization is off entirely.
  // -------------------------------------------------------------------------

  async initiatePayment(): Promise<void> {
    const s = this.state;
    if (s.kind !== "new_channel" && s.kind !== "chat") return;
    if (s.paymentLoading) return;

    const phone = s.phone;
    if (s.kind === "new_channel") {
      this.setState({ ...s, paymentLoading: true, paymentError: null });
    } else {
      this.setState({ ...s, paymentLoading: true, paymentError: null });
    }

    const { secret, tokenHash } = await generateExtensionToken();

    // Stash for post-Paystack return — the chat entry form reads
    // stelegano_handoff_phone on mount and pre-fills the phone
    // field, and the redeem flow reads stelegano_extension_secret
    // when the channel joins.
    try {
      sessionStorage.setItem("stelegano_extension_secret", secret);
      sessionStorage.setItem("stelegano_handoff_phone", phone);
      // Persist the country ISO so validation passes on return.
      sessionStorage.setItem("stelegano_handoff_country", s.countryIso);

      // Persist the PIN so we can auto-submit on return.
      if ("pin" in s) {
        sessionStorage.setItem("stelegano_handoff_pin", s.pin);
      }
      // v1 also stashed handoff_tier=free so the return path
      // auto-creates the room as free (the extension upgrades it
      // on redeem). Match.
      sessionStorage.setItem("stelegano_handoff_tier", "free");
    } catch {
      // sessionStorage disabled — unlikely but not fatal. The
      // redeem will silently fail later. Continue to checkout
      // anyway so the user sees the flow.
    }

    let response: Response;
    try {
      response = await fetch("/api/payment/initiate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token_hash: tokenHash }),
      });
    } catch {
      const cs = this.state;
      if (cs.kind === "new_channel") {
        this.setState({
          ...cs,
          paymentLoading: false,
          paymentError: "Network error. Check your connection and try again.",
        });
      } else if (cs.kind === "chat") {
        this.setState({
          ...cs,
          paymentLoading: false,
          paymentError: "Network error. Check your connection and try again.",
        });
      }
      return;
    }

    type InitiateResponse = { checkout_url: string } | { error: string; detail?: string };
    let parsed: InitiateResponse;
    try {
      parsed = (await response.json()) as InitiateResponse;
    } catch {
      const cs = this.state;
      if (cs.kind === "new_channel") {
        this.setState({
          ...cs,
          paymentLoading: false,
          paymentError: "Server returned an unparseable response.",
        });
      } else if (cs.kind === "chat") {
        this.setState({
          ...cs,
          paymentLoading: false,
          paymentError: "Server returned an unparseable response.",
        });
      }
      return;
    }

    if ("checkout_url" in parsed && parsed.checkout_url) {
      // Leaving the page — no further state transitions.
      location.href = parsed.checkout_url;
      return;
    }

    // Error response — map the known codes to user copy.
    const errorKey = "error" in parsed ? parsed.error : "unknown_error";
    const copy = paymentErrorCopy(errorKey);
    const cs = this.state;
    if (cs.kind === "new_channel") {
      this.setState({ ...cs, paymentLoading: false, paymentError: copy });
    } else if (cs.kind === "chat") {
      this.setState({ ...cs, paymentLoading: false, paymentError: copy });
    }
  }

  // -------------------------------------------------------------------------
  // Action: send a message
  // -------------------------------------------------------------------------

  async sendMessage(plaintext: string): Promise<void> {
    if (this.state.kind !== "chat" || !this.key || !this.client) return;
    const trimmed = plaintext.trim();
    if (!trimmed) return;

    // Turn-based input enforcement (mirrors v1 can_type?/4): only
    // type if the room is empty or the last message is from the
    // other party. The state.current check covers it; the server
    // also enforces via :sender_blocked in case of races.
    if (this.state.current && this.state.current.senderHash === this.state.senderHash) {
      return;
    }

    const { iv, ciphertext } = await encrypt(this.key, trimmed);
    try {
      await this.client.sendMessage(toBase64(ciphertext), toBase64(iv));
      // The DO broadcasts new_message back to us too (matches v1 —
      // server pushes to sender first then broadcasts). The
      // onNewMessage listener installed in connectAndJoin updates
      // state.current. No-op here.
    } catch (err) {
      const e = err as RoomClientError;
      if (e.reason === "not_your_turn") return; // benign race
      // Other errors are silent for now; Phase 5d may surface them.
    }
  }

  /** Marks the current message as read. Idempotent — server returns
   *  no reply on duplicate. */
  markCurrentRead(): void {
    if (this.state.kind !== "chat") return;
    const m = this.state.current;
    if (!m || m.readAt) return;
    if (m.senderHash === this.state.senderHash) return; // can't read your own
    this.client?.markRead(m.id);
  }

  /** Edit the current message (only if it's ours and unread). */
  async editCurrent(newPlaintext: string): Promise<void> {
    if (this.state.kind !== "chat" || !this.key || !this.client) return;
    const m = this.state.current;
    if (!m || m.senderHash !== this.state.senderHash || m.readAt) return;
    const trimmed = newPlaintext.trim();
    if (!trimmed) return;

    const { iv, ciphertext } = await encrypt(this.key, trimmed);
    try {
      await this.client.editMessage(m.id, toBase64(ciphertext), toBase64(iv));
      // The DO broadcasts message_edited back to us; listener
      // updates state.current.
    } catch {
      // silent
    }
  }

  /** Delete the current message (only if it's ours and unread). */
  async deleteCurrent(): Promise<void> {
    if (this.state.kind !== "chat" || !this.client) return;
    const m = this.state.current;
    if (!m || m.senderHash !== this.state.senderHash || m.readAt) return;
    try {
      await this.client.deleteMessage(m.id);
    } catch {
      // silent
    }
  }

  /** Fire-and-forget typing indicator. */
  typing(): void {
    if (this.state.kind !== "chat") return;
    this.client?.typing();
  }

  /** Manually expire the room. Terminal action. */
  async expireRoom(): Promise<void> {
    if (this.state.kind !== "chat" || !this.client) return;
    try {
      await this.client.expireRoom();
    } catch {
      // ignore
    }
    // The DO broadcasts room_expired then closes; listener handles
    // the state transition.
  }

  /** User-initiated logout. Closes the socket and wipes session
   *  storage. The view layer typically navigates to / after this. */
  logout(): void {
    this.client?.close(1000, "logout");
    this.client = null;
    this.key = null;
    this.cachedHashes = null;
    clearSession();
    this.setState(this.initialEntry());
  }

  /** Lock the chat without destroying session data. Drops the
   *  encryption key from memory (re-derived on unlock) but keeps
   *  the phone + hashes + socket so unlock is fast. v1
   *  `lock_chat`. */
  lockChat(): void {
    if (this.state.kind !== "chat") return;
    const phone = this.state.phone;
    this.key = null;
    this.client?.close(1000, "lock");
    this.client = null;
    this.setState({
      kind: "locked",
      phone,
      countryIso: this.state.countryIso,
      reason: "unauthorized",
      attemptsRemaining: undefined,
      lockError: null,
      lockAttempts: 0,
    });
  }

  /** Wipe all session data and return to the blank entry form.
   *  v1 `clear_session`. Used from the locked screen's "Erase All"
   *  button. */
  clearSession(): void {
    this.logout();
  }

  /** Set an error banner on the entry screen. Used by the view layer
   *  after client-side validation (e.g. invalid phone format). */
  setEntryError(error: string): void {
    if (this.state.kind !== "entry") return;
    this.setState({ ...this.state, error });
  }

  /** Toggle password-masking of the phone field on entry.
   *  Pass the current DOM input value so it's preserved through the re-render. */
  togglePhoneVisibility(currentPhone?: string): void {
    if (this.state.kind !== "entry") return;
    const phone = currentPhone !== undefined ? currentPhone : this.state.phone;
    this.setState({ ...this.state, phone, phoneVisible: !this.state.phoneVisible });
  }

  // -------------------------------------------------------------------------
  // Generator drawer (entry-state only)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // New Integrated Identity Actions
  // -------------------------------------------------------------------------

  setPhone(phone: string): void {
    const s = this.state;
    if (s.kind !== "entry" || s.phoneLocked) return;

    // Strip non-digits except leading plus to avoid double-formatting confusion
    const digits = phone.startsWith("+")
      ? `+${phone.slice(1).replace(/\D/g, "")}`
      : phone.replace(/\D/g, "");

    // Use AsYouType for real-time formatting
    const formatter = digits.startsWith("+")
      ? new AsYouType()
      : new AsYouType(s.countryIso as CountryCode);
    const formatted = formatter.input(digits);
    const parsed = parsePhoneNumberFromString(formatted, s.countryIso as CountryCode);

    // Smart country detection
    let countryIso = s.countryIso;
    if (digits.startsWith("+") && parsed?.country) {
      countryIso = parsed.country;
    }

    const isValid = parsed ? parsed.isValid() : false;
    let error = s.error;
    if (digits.length > 5 && !isValid) {
      error = "Invalid phone number";
    } else if (isValid && error === "Invalid phone number") {
      error = null;
    }

    this.setState({ ...s, phone: formatted, countryIso, phoneValid: isValid, error });
  }

  setCountry(iso: string): void {
    const s = this.state;
    if (s.kind !== "entry" || s.phoneLocked) return;
    this.setState({ ...s, countryIso: iso, showCountries: false, searchQuery: "", error: null });
  }

  toggleCountries(): void {
    const s = this.state;
    if (s.kind !== "entry" || s.phoneLocked) return;
    this.setState({ ...s, showCountries: !s.showCountries, searchQuery: "" });
  }

  openCountries(): void {
    const s = this.state;
    if (s.kind !== "entry" || s.phoneLocked || s.showCountries) return;
    this.setState({ ...s, showCountries: true, searchQuery: "" });
  }

  closeCountries(): void {
    const s = this.state;
    if (s.kind !== "entry" || !s.showCountries) return;
    this.setState({ ...s, showCountries: false, searchQuery: "" });
  }

  setSearchQuery(q: string): void {
    const s = this.state;
    if (s.kind !== "entry") return;
    this.setState({ ...s, searchQuery: q });
  }

  async generateNewNumber(): Promise<void> {
    const s = this.state;
    if (s.kind !== "entry" || s.phoneLocked || s.generating) return;

    this.setState({ ...s, generating: true });

    try {
      // Since we use phone-number-generator-js, we need to map the ISO back to
      // the country name string it expects. A simple mapping or using the label.
      // For now, we'll use a representative set or the existing COUNTRY_LIST.
      const countryName = COUNTRY_LIST.find((c) => c.iso === s.countryIso)?.name ?? "United States";

      // v1 has a 600ms cosmetic delay for "calculating" feel.
      await new Promise((r) => setTimeout(r, 600));

      const num = await generatePhoneNumber({ countryName: countryName as CountryNames });

      const formatter = num.startsWith("+")
        ? new AsYouType()
        : new AsYouType(s.countryIso as CountryCode);
      const formatted = formatter.input(num);
      const parsed = parsePhoneNumberFromString(formatted, s.countryIso as CountryCode);
      const isValid = parsed ? parsed.isValid() : false;

      this.setState({ ...s, phone: formatted, generating: false, phoneValid: isValid });
    } catch {
      this.setState({ ...s, generating: false });
    }
  }

  setPin(pin: string): void {
    const s = this.state;
    if (s.kind !== "entry") return;

    let error = s.error;
    if (pin && s.confirmPin && pin !== s.confirmPin) {
      error = "PINs do not match";
    } else if (pin && pin.length < 4) {
      error = "PIN must be at least 4 digits";
    } else if (error === "PINs do not match" || error === "PIN must be at least 4 digits") {
      error = null;
    }

    this.setState({ ...s, pin, error });
  }

  setConfirmPin(confirmPin: string): void {
    const s = this.state;
    if (s.kind !== "entry") return;

    let error = s.error;
    if (s.pin && confirmPin && s.pin !== confirmPin) {
      error = "PINs do not match";
    } else if (error === "PINs do not match") {
      error = null;
    }

    this.setState({ ...s, confirmPin, error });
  }

  setAcceptedTerms(acceptedTerms: boolean): void {
    const s = this.state;
    if (s.kind !== "entry") return;
    this.setState({ ...s, acceptedTerms });
  }

  setConfirmedSaved(confirmedSaved: boolean): void {
    const s = this.state;
    if (s.kind !== "entry") return;
    this.setState({ ...s, confirmedSaved });
  }

  setOnboardingStep(onboardingStep: number | null): void {
    const s = this.state;
    if (s.kind !== "entry") return;
    this.setState({ ...s, onboardingStep });
  }

  togglePhoneVisible(): void {
    const s = this.state;
    if (s.kind !== "entry") return;
    this.setState({ ...s, phoneVisible: !s.phoneVisible, error: null });
  }

  /** Enter inline-edit mode for the current (own, unread) message. */
  startEdit(): void {
    if (this.state.kind !== "chat") return;
    const m = this.state.current;
    if (!m || m.senderHash !== this.state.senderHash || m.readAt) return;
    this.setState({ ...this.state, editing: true });
  }

  /** Cancel inline edit. */
  cancelEdit(): void {
    if (this.state.kind !== "chat") return;
    this.setState({ ...this.state, editing: false });
  }

  /** Save the edited message. The caller reads the textarea's DOM
   *  value and passes it in. Clears editing regardless of success
   *  (matches v1 — the edit form dismisses even if the send fails;
   *  the server's broadcast is the source of truth for the final
   *  text). */
  async saveEdit(text: string): Promise<void> {
    if (this.state.kind !== "chat" || !this.state.editing) return;
    this.setState({ ...this.state, editing: false });
    await this.editCurrent(text);
  }

  /** Show the "nuclear wipe" confirmation modal. */
  confirmExpireShow(): void {
    if (this.state.kind !== "chat") return;
    this.setState({ ...this.state, confirmExpire: true });
  }

  /** Dismiss the "nuclear wipe" confirmation modal. */
  confirmExpireHide(): void {
    if (this.state.kind !== "chat") return;
    this.setState({ ...this.state, confirmExpire: false });
  }

  // -------------------------------------------------------------------------
  // Internal: open WS, send join, route by reply
  // -------------------------------------------------------------------------

  private async connectAndJoin(
    phone: string,
    countryIso: string,
    roomHash: string,
    accessHash: string,
    senderHash: string,
  ): Promise<void> {
    this.setState({ kind: "connecting", phone, countryIso });

    // Tear down any previous client (locked → reauthenticate path).
    this.client?.close();
    this.client = new RoomClient(roomHash, {
      onNewMessage: (msg) => this.onNewMessage(msg),
      onMessageRead: (id) => this.onMessageRead(id),
      onMessageEdited: (data) => this.onMessageEdited(data),
      onMessageDeleted: (id) => this.onMessageDeleted(id),
      onCounterpartyTyping: () => this.onCounterpartyTyping(),
      onRoomExpired: () => this.onRoomExpired(),
      onTtlExtended: (ttl) => this.onTtlExtended(ttl),
      onClose: (code) => this.onSocketClose(code),
    });

    try {
      await this.client.open();
    } catch {
      // Couldn't open WS — drop to entry. (Phase 5d UI may show an
      // error toast.)
      this.client = null;
      // We don't have countryIso here easily, pull from handoff or fallback
      this.setState(this.initialEntry(phone, countryIso, false));
      return;
    }

    // phone is the normalised (digits-only) form.

    // Read the extension secret before joining so we can pass it in the
    // join payload. For a new paid room the server creates it as paid
    // atomically; for an existing room the server ignores it and we fall
    // through to the post-join redeemExtension call below.
    // Read and immediately remove the secret so it never lingers in
    // sessionStorage past this point. A crash or navigation between
    // checkout-return and join-success would otherwise leave the
    // raw secret in sessionStorage, allowing a replay on next open.
    let pendingSecret: string | null = null;
    try {
      pendingSecret = sessionStorage.getItem("stelegano_extension_secret");
    } catch {
      // sessionStorage disabled
    }

    let joinReply: JoinReply | undefined;
    try {
      joinReply = await this.client.join(
        senderHash,
        accessHash,
        countryIso,
        pendingSecret ?? undefined,
      );
    } catch (err) {
      const e = err as RoomClientError;
      if (e.reason === "locked" || e.reason === "unauthorized") {
        // If we came from :locked state already, preserve
        // lockAttempts + bump it. Otherwise start at 1.
        const prevAttempts = this.state.kind === "locked" ? this.state.lockAttempts : 0;
        this.setState({
          kind: "locked",
          phone,
          countryIso,
          reason: e.reason,
          attemptsRemaining: e.attempts_remaining,
          lockError: e.reason === "locked" ? "LOCKOUT ACTIVE · 30 MIN" : "INVALID PIN",
          lockAttempts: prevAttempts + 1,
        });
        return;
      }
      // not_found / invalid_* / internal_error → back to entry with
      // an error banner so the user sees what happened.
      this.client?.close();
      this.client = null;
      const entry = this.initialEntry(phone, countryIso, false);
      entry.error =
        e.reason === "not_found"
          ? "No active channel for that number."
          : "Connection failed. Try again.";
      this.setState(entry);
      return;
    }

    // Persist enough to survive a panic-and-restore cycle.
    try {
      sessionStorage.setItem("stelegano_phone", phone);
      sessionStorage.setItem("stelegano_room_hash", roomHash);
      sessionStorage.setItem("stelegano_access_hash", accessHash);
      sessionStorage.setItem("stelegano_sender_hash", senderHash);
      // Consume the handoff markers now that join is successful.
      clearHandoff();
    } catch {
      // sessionStorage disabled — ignore
    }

    // Decrypt the current message if one was returned.
    let current: PlainMessage | null = null;
    if (joinReply.current_message) {
      current = await this.tryDecrypt(joinReply.current_message);
    }

    this.setState({
      kind: "chat",
      phone,
      countryIso,
      senderHash,
      current,
      counterpartyTyping: false,
      editing: false,
      confirmExpire: false,
      ttlExpiresAt: joinReply.ttl_expires_at ?? null,
      paymentLoading: false,
      paymentError: null,
    });

    // If we returned from a Paystack checkout, attempt to redeem the
    // extension secret. For new paid rooms the server already handled it
    // atomically during join (via extension_secret in the join payload),
    // so this call will return invalid_token and be silently swallowed.
    // For existing-room extends (the "Extend" button in chat), this is
    // the primary redemption path — the join ignored the secret.
    //
    // If the webhook is delayed, the server returns payment_pending.
    // We retry a few times before giving up.
    if (pendingSecret && this.client) {
      this.attemptRedeem(pendingSecret);
    }
  }

  private async attemptRedeem(secret: string, attempt = 0): Promise<void> {
    if (!this.client || this.state.kind !== "chat") return;

    try {
      const res = await this.client.redeemExtension(secret, this.state.countryIso);
      // Success! Update local state immediately.
      if (this.state.kind === "chat") {
        this.setState({ ...this.state, ttlExpiresAt: res.ttl_expires_at });
      }
      // Success! Clear the secret so we don't try again on next join.
      try {
        sessionStorage.removeItem("stelegano_extension_secret");
      } catch {
        // ignore
      }
    } catch (err) {
      const e = err as RoomClientError;
      if (e.reason === "payment_pending" && attempt < 10) {
        // Webhook hasn't landed yet. Wait 3s and retry.
        setTimeout(() => this.attemptRedeem(secret, attempt + 1), 3000);
      } else if (e.reason === "invalid_token") {
        // Truly invalid or already redeemed. Clear it.
        try {
          sessionStorage.removeItem("stelegano_extension_secret");
        } catch {
          // ignore
        }
      }
      // other errors (internal_error, monetization_disabled) just stop
    }
  }

  // -------------------------------------------------------------------------
  // Broadcast handlers (installed in connectAndJoin)
  // -------------------------------------------------------------------------

  private async onNewMessage(msg: MessagePayload): Promise<void> {
    if (this.state.kind !== "chat") return;
    const decrypted = await this.tryDecrypt(msg);
    if (!decrypted) return;
    this.setState({ ...this.state, current: decrypted, counterpartyTyping: false });
  }

  private onMessageRead(messageId: string): void {
    if (this.state.kind !== "chat") return;
    if (!this.state.current || this.state.current.id !== messageId) return;
    this.setState({
      ...this.state,
      current: { ...this.state.current, readAt: new Date().toISOString() },
    });
  }

  private async onMessageEdited(data: {
    message_id: string;
    ciphertext: string;
    iv: string;
  }): Promise<void> {
    if (this.state.kind !== "chat") return;
    if (!this.state.current || this.state.current.id !== data.message_id) return;
    const ct = fromBase64(data.ciphertext);
    const iv = fromBase64(data.iv);
    let plaintext: string;
    try {
      plaintext = await decrypt(this.key!, iv, ct);
    } catch {
      return; // can't decrypt — ignore the edit
    }
    this.setState({
      ...this.state,
      current: { ...this.state.current, plaintext, edited: true },
    });
  }

  private onMessageDeleted(messageId: string): void {
    if (this.state.kind !== "chat") return;
    if (!this.state.current || this.state.current.id !== messageId) return;
    this.setState({ ...this.state, current: null, counterpartyTyping: false });
  }

  private onCounterpartyTyping(): void {
    if (this.state.kind !== "chat") return;
    if (this.state.counterpartyTyping) return;
    this.setState({ ...this.state, counterpartyTyping: true });
    // Auto-clear after a bit so the indicator doesn't stick if the
    // other party stops typing without sending.
    setTimeout(() => {
      if (this.state.kind === "chat" && this.state.counterpartyTyping) {
        this.setState({ ...this.state, counterpartyTyping: false });
      }
    }, 3000);
  }

  private onRoomExpired(): void {
    this.client?.close();
    this.client = null;
    this.key = null;
    this.cachedHashes = null;
    clearSession();
    this.setState({ kind: "expired" });
  }

  private onTtlExtended(ttlExpiresAt: string): void {
    if (this.state.kind !== "chat") return;
    this.setState({ ...this.state, ttlExpiresAt });
  }

  private onSocketClose(code: number): void {
    // 1000 = normal (we initiated). Ignore — the action that closed
    // it has already set the appropriate state.
    if (code === 1000) return;
    // Unclean close — drop to entry. User can retry.
    if (this.state.kind === "chat" || this.state.kind === "connecting") {
      this.client = null;
      const entry = this.initialEntry(this.cachedHashes?.phone ?? "", readHandoffCountry(), false);
      entry.error = "Connection lost. Reconnect to continue.";
      this.setState(entry);
    }
  }

  // -------------------------------------------------------------------------
  // Action: Overlay handling (Terms, Spec, etc.)
  // -------------------------------------------------------------------------

  async openOverlay(path: string): Promise<void> {
    const title =
      path === "/"
        ? "Home"
        : path.slice(1).charAt(0).toUpperCase() + path.slice(2).replace(".html", "");

    this.setState({ ...this.state, overlay: { title, html: "", loading: true } });

    try {
      const r = await fetch(path);
      const text = await r.text();
      // Extract main content from the HTML if possible
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, "text/html");
      const main = doc.querySelector("main");
      // If no <main>, try to find the first <header> + <section> combos or just use body
      const content = main ? main.innerHTML : doc.body.innerHTML;

      this.setState({ ...this.state, overlay: { title, html: content, loading: false } });
    } catch {
      this.setState({ ...this.state, overlay: null });
    }
  }

  closeOverlay(): void {
    this.setState({ ...this.state, overlay: null });
  }

  // -------------------------------------------------------------------------
  // Internal: decrypt a wire-format MessagePayload to a PlainMessage
  // -------------------------------------------------------------------------

  private async tryDecrypt(msg: MessagePayload): Promise<PlainMessage | null> {
    if (!this.key) return null;
    try {
      const ct = fromBase64(msg.ciphertext);
      const iv = fromBase64(msg.iv);
      const plaintext = await decrypt(this.key, iv, ct);
      return {
        id: msg.id,
        senderHash: msg.sender_hash,
        plaintext,
        insertedAt: msg.inserted_at,
        readAt: msg.read_at,
        edited: false,
      };
    } catch {
      // Decryption failed — wrong key, tampered ciphertext, or a
      // protocol mismatch. Caller treats this as "no message".
      return null;
    }
  }
}
