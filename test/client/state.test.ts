// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node
//
// Unit tests for the client state machine (src/client/state.ts) — ChatState.
//
// Strategy: ChatState pulls in three heavy collaborators we don't want to run
// for real in a unit test:
//   - RoomClient (a WebSocket) → mocked so each test scripts the join() reply.
//   - deriveKeyInWorker (600k-iteration PBKDF2 in a Web Worker) → mocked to a
//     cheap real AES key; every OTHER crypto helper (room/access/sender hashes,
//     generatePairingOtp, hashOtp, normaliseOtp) runs for real.
//   - fireFunnel (sendBeacon/fetch telemetry) → no-op.
// Plus minimal sessionStorage + fetch (the /exists probe) stubs.
//
// Coverage focus is the NEW sign-in / sign-up / pairing-OTP routing: surface
// switching, the international "+"-prepend formatting, the no-channel bounce,
// the second-party pair flow (otp_required → pair → claim / wrong code / lost
// race), and the creator's in-chat pairing banner (party_paired + re-issue).

import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared, hoisted control surface the mocks read from (vi.mock factories are
// hoisted above imports, so they can't close over normal `let`s).
const ctl = vi.hoisted(() => ({
  join: {
    fn: (async () => ({
      room_id: "room",
      ttl_expires_at: new Date(0).toISOString(),
      awaiting_party: true,
    })) as (...a: unknown[]) => Promise<unknown>,
  },
  reset: { fn: (async () => ({})) as () => Promise<unknown> },
  client: { ref: null as null | { listeners: Record<string, (...a: unknown[]) => void> } },
  joinArgs: { last: [] as unknown[] },
}));

vi.mock("../../src/client/funnel", () => ({ fireFunnel: () => {}, captureCampaign: () => {} }));

vi.mock("../../src/client/crypto/anon", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // Cheap real AES key — instant, no 600k PBKDF2.
    deriveKeyInWorker: async () =>
      globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]),
  };
});

vi.mock("../../src/client/room_client", () => {
  class RoomClient {
    listeners: Record<string, (...a: unknown[]) => void>;
    constructor(_roomHash: string, listeners: Record<string, (...a: unknown[]) => void>) {
      this.listeners = listeners;
      ctl.client.ref = this;
    }
    open() {
      return Promise.resolve();
    }
    join(...args: unknown[]) {
      ctl.joinArgs.last = args;
      return ctl.join.fn(...args);
    }
    resetPairing() {
      return ctl.reset.fn();
    }
    close() {}
    redeemExtension() {
      return Promise.reject({ reason: "monetization_disabled" });
    }
    sendMessage() {
      return Promise.resolve({ message_id: "m" });
    }
    editMessage() {
      return Promise.resolve({});
    }
    deleteMessage() {
      return Promise.resolve({});
    }
    expireRoom() {
      return Promise.resolve({});
    }
    markRead() {}
    typing() {}
  }
  return { RoomClient };
});

import { ChatState, type Config } from "../../src/client/state";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const CFG: Config = {
  monetizationEnabled: false,
  freeTtlDays: 7,
  paidTtlDays: 365,
  priceCents: 200,
  currency: "USD",
  cfCountry: "",
};

// Canonical libphonenumber example numbers (valid in the bundled metadata).
const KE_NUMBER = "254712345678"; // → +254 712 345 678 (KE)
const US_NUMBER = "14155552671"; // → +1 415 555 2671 (US)

let existsValue = true;

function makeSessionStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      m.set(k, String(v));
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

function okReply(awaiting: boolean) {
  return async () => ({
    room_id: "room",
    ttl_expires_at: new Date(0).toISOString(),
    awaiting_party: awaiting,
  });
}

function rejectWith(reason: string, extra: Record<string, unknown> = {}) {
  return async () => {
    throw { reason, ...extra };
  };
}

beforeEach(() => {
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = makeSessionStorage();
  existsValue = true;
  ctl.join.fn = okReply(true);
  ctl.reset.fn = async () => ({});
  ctl.client.ref = null;
  ctl.joinArgs.last = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes("/exists")) {
      return { ok: true, json: async () => ({ exists: existsValue }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
});

// Drives a fresh ChatState to the `pair` screen as a first-time second party.
async function reachPair(pin = "1234"): Promise<ChatState> {
  const cs = new ChatState();
  cs.setPhone(KE_NUMBER);
  cs.setPin(pin);
  existsValue = true;
  ctl.join.fn = rejectWith("otp_required");
  await cs.submit();
  return cs;
}

// Drives a fresh ChatState to the creator's chat with an open pairing slot.
async function reachCreatorChat(otp = "ABCD1234"): Promise<ChatState> {
  const cs = new ChatState();
  sessionStorage.setItem("stelegano_pairing_otp", otp);
  cs.setPhone(KE_NUMBER);
  cs.setPin("1234");
  existsValue = true;
  ctl.join.fn = okReply(true);
  await cs.submit();
  return cs;
}

// ---------------------------------------------------------------------------
// Tier A — entry surfaces (pure, synchronous)
// ---------------------------------------------------------------------------

describe("ChatState — entry surfaces", () => {
  it("defaults to a blank Join-channel (sign-in) surface", () => {
    const st = new ChatState().getState();
    expect(st.kind).toBe("entry");
    if (st.kind !== "entry") throw new Error("not entry");
    expect(st.mode).toBe("signin");
    expect(st.phone).toBe("");
    expect(st.offerCreate).toBe(false);
  });

  it("setPhone auto-prepends + and detects the country/flag", () => {
    const cs = new ChatState();
    cs.setPhone(KE_NUMBER);
    const st = cs.getState();
    if (st.kind !== "entry") throw new Error("not entry");
    expect(st.phone.startsWith("+")).toBe(true);
    expect(st.phone.replace(/\D/g, "")).toBe(KE_NUMBER);
    expect(st.countryIso).toBe("KE");
    expect(st.phoneValid).toBe(true);
  });

  it("setPhone clears to empty so the placeholder can show", () => {
    const cs = new ChatState();
    cs.setPhone(KE_NUMBER);
    cs.setPhone("");
    const st = cs.getState();
    if (st.kind !== "entry") throw new Error("not entry");
    expect(st.phone).toBe("");
    expect(st.phoneValid).toBe(false);
  });

  it("setPhone is a no-op in sign-up mode (no custom numbers)", () => {
    const cs = new ChatState();
    cs.showSignin(); // ensure signin first
    cs.setPhone(KE_NUMBER);
    // switch to signup and try to type — should not change the generated field
    const before = cs.getState();
    if (before.kind !== "entry") throw new Error("not entry");
  });

  it("setPin enforces a 4-digit minimum", () => {
    const cs = new ChatState();
    cs.setPin("12");
    let st = cs.getState();
    if (st.kind !== "entry") throw new Error("not entry");
    expect(st.error).toMatch(/4/);
    cs.setPin("1234");
    st = cs.getState();
    if (st.kind !== "entry") throw new Error("not entry");
    expect(st.error).toBeNull();
  });

  it("showSignup switches to the generator surface; showSignin returns blank", () => {
    const cs = new ChatState();
    cs.showSignup();
    let st = cs.getState();
    if (st.kind !== "entry") throw new Error("not entry");
    expect(st.mode).toBe("signup");
    cs.showSignin();
    st = cs.getState();
    if (st.kind !== "entry") throw new Error("not entry");
    expect(st.mode).toBe("signin");
    expect(st.phone).toBe("");
  });

  it("updateConfig seeds the default flag from CF-IPCountry while pristine", () => {
    const cs = new ChatState();
    cs.updateConfig({ ...CFG, cfCountry: "KE" });
    const st = cs.getState();
    if (st.kind !== "entry") throw new Error("not entry");
    expect(st.countryIso).toBe("KE");
  });

  it("updateConfig does not override a country the user already typed", () => {
    const cs = new ChatState();
    cs.setPhone(US_NUMBER); // detects US
    cs.updateConfig({ ...CFG, cfCountry: "KE" });
    const st = cs.getState();
    if (st.kind !== "entry") throw new Error("not entry");
    expect(st.countryIso).toBe("US");
  });
});

// ---------------------------------------------------------------------------
// Tier B — join routing (mocked client + crypto)
// ---------------------------------------------------------------------------

describe("ChatState — join routing", () => {
  it("sign-in to an existing channel opens chat", async () => {
    const cs = new ChatState();
    cs.setPhone(KE_NUMBER);
    cs.setPin("1234");
    existsValue = true;
    ctl.join.fn = okReply(false);
    await cs.submit();
    const st = cs.getState();
    expect(st.kind).toBe("chat");
    if (st.kind !== "chat") throw new Error("not chat");
    expect(st.awaitingParty).toBe(false);
  });

  it("sign-in to a non-existent number bounces with an actionable Create offer", async () => {
    const cs = new ChatState();
    cs.setPhone(KE_NUMBER);
    cs.setPin("1234");
    existsValue = false;
    await cs.submit();
    const st = cs.getState();
    expect(st.kind).toBe("entry");
    if (st.kind !== "entry") throw new Error("not entry");
    expect(st.mode).toBe("signin");
    expect(st.offerCreate).toBe(true);
    expect(st.error).toBeTruthy();
    // B3: the typed number keeps its + formatting on the bounce.
    expect(st.phone.startsWith("+")).toBe(true);
  });

  it("routes a first-time second party to the pair screen", async () => {
    const cs = await reachPair();
    expect(cs.getState().kind).toBe("pair");
  });

  it("pair: a wrong code stays on the pair screen; a valid code joins", async () => {
    const cs = await reachPair("1234");

    cs.setPairOtp("WRONGCOD");
    cs.setPairConfirmPin("1234");
    ctl.join.fn = rejectWith("otp_invalid");
    await cs.submitPair();
    const st = cs.getState();
    expect(st.kind).toBe("pair");
    if (st.kind !== "pair") throw new Error("not pair");
    expect(st.error).toMatch(/code/i);

    cs.setPairOtp("ABCD1234");
    cs.setPairConfirmPin("1234");
    ctl.join.fn = okReply(false);
    await cs.submitPair();
    expect(cs.getState().kind).toBe("chat");
  });

  it("pair: a mismatched confirm-PIN is rejected before any join", async () => {
    const cs = await reachPair("1234");
    cs.setPairOtp("ABCD1234");
    cs.setPairConfirmPin("9999");
    await cs.submitPair();
    const st = cs.getState();
    expect(st.kind).toBe("pair");
    if (st.kind !== "pair") throw new Error("not pair");
    expect(st.error).toMatch(/match/i);
  });

  it("pair: losing the slot race shows 'claimed by someone else'", async () => {
    const cs = await reachPair("1234");
    cs.setPairOtp("ABCD1234");
    cs.setPairConfirmPin("1234");
    ctl.join.fn = rejectWith("unauthorized", { attempts_remaining: 9 });
    await cs.submitPair();
    const st = cs.getState();
    expect(st.kind).toBe("pair");
    if (st.kind !== "pair") throw new Error("not pair");
    expect(st.error).toMatch(/claimed/i);
  });

  it("pairBack returns to a blank sign-in", async () => {
    const cs = await reachPair();
    cs.pairBack();
    const st = cs.getState();
    expect(st.kind).toBe("entry");
    if (st.kind !== "entry") throw new Error("not entry");
    expect(st.mode).toBe("signin");
    expect(st.phone).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Tier B — creator pairing banner
// ---------------------------------------------------------------------------

describe("ChatState — creator pairing banner", () => {
  it("creator chat shows awaitingParty + the stashed code", async () => {
    const cs = await reachCreatorChat("ABCD1234");
    const st = cs.getState();
    expect(st.kind).toBe("chat");
    if (st.kind !== "chat") throw new Error("not chat");
    expect(st.awaitingParty).toBe(true);
    expect(st.pairingOtp).toBe("ABCD1234");
  });

  it("party_paired clears the banner and the stashed code", async () => {
    const cs = await reachCreatorChat("ABCD1234");
    ctl.client.ref?.listeners.onPartyPaired?.();
    const st = cs.getState();
    if (st.kind !== "chat") throw new Error("not chat");
    expect(st.awaitingParty).toBe(false);
    expect(st.pairingOtp).toBeNull();
    expect(sessionStorage.getItem("stelegano_pairing_otp")).toBeNull();
  });

  it("regeneratePairingOtp swaps in a new code on success", async () => {
    const cs = await reachCreatorChat("ABCD1234");
    ctl.reset.fn = async () => ({});
    await cs.regeneratePairingOtp();
    const st = cs.getState();
    if (st.kind !== "chat") throw new Error("not chat");
    expect(st.pairingOtp).not.toBe("ABCD1234");
    expect(st.pairingOtp).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(st.pairingError).toBeNull();
  });

  it("regeneratePairingOtp surfaces an error and keeps the old code on failure", async () => {
    const cs = await reachCreatorChat("ABCD1234");
    ctl.reset.fn = rejectWith("internal_error");
    await cs.regeneratePairingOtp();
    const st = cs.getState();
    if (st.kind !== "chat") throw new Error("not chat");
    expect(st.pairingOtp).toBe("ABCD1234");
    expect(st.pairingError).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tier B — create-channel (generator → confirm → create) mints the OTP
// ---------------------------------------------------------------------------

describe("ChatState — create channel", () => {
  it("mints + stashes a pairing OTP, passes its hash to join, and awaits the 2nd party", async () => {
    const cs = new ChatState();
    cs.showSignup();
    // Wait for the generator to mint a number (600ms cosmetic delay).
    await vi.waitFor(
      () => {
        const st = cs.getState();
        if (st.kind !== "entry" || st.mode !== "signup" || !st.phone) {
          throw new Error("not generated yet");
        }
      },
      { timeout: 4000, interval: 50 },
    );
    cs.setPin("1234");
    existsValue = false;
    await cs.submit();
    let st = cs.getState();
    expect(st.kind).toBe("new_channel");

    cs.setNewChannelConfirmPin("1234");
    cs.setNewChannelAcceptedTerms(true);
    ctl.join.fn = okReply(true);
    await cs.createChannel();

    st = cs.getState();
    expect(st.kind).toBe("chat");
    if (st.kind !== "chat") throw new Error("not chat");
    expect(st.awaitingParty).toBe(true);
    expect(st.pairingOtp).toBeTruthy();
    // The plaintext is stashed for relay; the SHA-256 hash is what went over the
    // wire (join arg index 3), never the plaintext.
    expect(sessionStorage.getItem("stelegano_pairing_otp")).toBe(st.pairingOtp);
    const otpHashArg = ctl.joinArgs.last[3];
    expect(typeof otpHashArg).toBe("string");
    expect(otpHashArg).toMatch(/^[a-f0-9]{64}$/);
    expect(otpHashArg).not.toBe(st.pairingOtp);
  });
});
