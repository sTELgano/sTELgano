// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for src/lib/extension_tokens — the D1 access layer for the
// payment-token table. These are runtime tests, not unit tests:
// they hit a real (in-memory) D1 instance and verify the actual
// SQL behaves the way the helpers claim it does.
//
// Schema preserved across tests within a file (singleWorker mode +
// d1Persist:false → fresh DB per file). Each test uses a unique
// token_hash to stay independent.

import { describe, expect, it } from "vitest";
// @ts-expect-error — see healthz.test.ts
import { env } from "cloudflare:test";

import {
  createPending,
  deleteExpired,
  findByTokenHash,
  markPaid,
  markRedeemed,
} from "../../src/lib/extension_tokens";

function hex64(seed: string): string {
  const base = seed.padEnd(32, "0");
  const hex = Array.from(base)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 64).padEnd(64, "0");
}

const TOMORROW = new Date(Date.now() + 86_400_000).toISOString();

describe("createPending", () => {
  it("inserts a new pending token and returns the row", async () => {
    const tokenHash = hex64("create-pending-ok");
    const row = await createPending(env.DB, {
      tokenHash,
      amountCents: 200,
      currency: "USD",
      expiresAt: TOMORROW,
    });
    expect(row.token_hash).toBe(tokenHash);
    expect(row.status).toBe("pending");
    expect(row.amount_cents).toBe(200);
    expect(row.currency).toBe("USD");
    expect(row.paid_at).toBeNull();
    expect(row.redeemed_at).toBeNull();
  });

  it("rejects invalid token_hash (must be 64-char lowercase hex)", async () => {
    await expect(
      createPending(env.DB, {
        tokenHash: "not-hex",
        amountCents: 200,
        currency: "USD",
        expiresAt: TOMORROW,
      }),
    ).rejects.toThrow(/lowercase hex/);
  });

  it("rejects non-positive amount_cents", async () => {
    await expect(
      createPending(env.DB, {
        tokenHash: hex64("bad-amount"),
        amountCents: 0,
        currency: "USD",
        expiresAt: TOMORROW,
      }),
    ).rejects.toThrow(/positive integer/);
  });

  it("rejects unsupported currency", async () => {
    await expect(
      createPending(env.DB, {
        tokenHash: hex64("bad-ccy"),
        amountCents: 200,
        currency: "JPY",
        expiresAt: TOMORROW,
      }),
    ).rejects.toThrow(/currency must be/);
  });
});

describe("findByTokenHash", () => {
  it("returns null for an unknown hash", async () => {
    const row = await findByTokenHash(env.DB, hex64("never-inserted"));
    expect(row).toBeNull();
  });

  it("returns null for malformed hashes (no DB hit)", async () => {
    const row = await findByTokenHash(env.DB, "nope");
    expect(row).toBeNull();
  });
});

describe("markPaid", () => {
  it("flips a pending token to paid and records provider_ref + paid_at", async () => {
    const tokenHash = hex64("mark-paid");
    await createPending(env.DB, {
      tokenHash,
      amountCents: 200,
      currency: "USD",
      expiresAt: TOMORROW,
    });

    const changed = await markPaid(env.DB, tokenHash, "provider-xyz");
    expect(changed).toBe(1);

    const row = await findByTokenHash(env.DB, tokenHash);
    expect(row?.status).toBe("paid");
    expect(row?.provider_ref).toBe("provider-xyz");
    expect(row?.paid_at).not.toBeNull();
  });

  it("is idempotent at the SQL level — second call returns 0", async () => {
    const tokenHash = hex64("mark-paid-twice");
    await createPending(env.DB, {
      tokenHash,
      amountCents: 200,
      currency: "USD",
      expiresAt: TOMORROW,
    });
    expect(await markPaid(env.DB, tokenHash)).toBe(1);
    expect(await markPaid(env.DB, tokenHash)).toBe(0);
  });

  it("returns 0 for an unknown token_hash", async () => {
    expect(await markPaid(env.DB, hex64("ghost"))).toBe(0);
  });
});

describe("markRedeemed", () => {
  it("flips paid → redeemed and records redeemed_at", async () => {
    const tokenHash = hex64("redeem-ok");
    await createPending(env.DB, {
      tokenHash,
      amountCents: 200,
      currency: "USD",
      expiresAt: TOMORROW,
    });
    await markPaid(env.DB, tokenHash);

    expect(await markRedeemed(env.DB, tokenHash)).toBe(1);
    const row = await findByTokenHash(env.DB, tokenHash);
    expect(row?.status).toBe("redeemed");
    expect(row?.redeemed_at).not.toBeNull();
  });

  it("returns 0 if token is still pending (must be paid first)", async () => {
    const tokenHash = hex64("redeem-pending");
    await createPending(env.DB, {
      tokenHash,
      amountCents: 200,
      currency: "USD",
      expiresAt: TOMORROW,
    });
    expect(await markRedeemed(env.DB, tokenHash)).toBe(0);
  });

  it("returns 0 on second redeem (replay defence)", async () => {
    const tokenHash = hex64("redeem-replay");
    await createPending(env.DB, {
      tokenHash,
      amountCents: 200,
      currency: "USD",
      expiresAt: TOMORROW,
    });
    await markPaid(env.DB, tokenHash);
    expect(await markRedeemed(env.DB, tokenHash)).toBe(1);
    expect(await markRedeemed(env.DB, tokenHash)).toBe(0);
  });
});

describe("deleteExpired", () => {
  it("deletes only rows whose expires_at is strictly before the cutoff", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const farFuture = new Date(Date.now() + 30 * 86_400_000).toISOString();

    const stale = hex64("expired-row");
    const fresh = hex64("fresh-row");

    await createPending(env.DB, {
      tokenHash: stale,
      amountCents: 200,
      currency: "USD",
      expiresAt: yesterday,
    });
    await createPending(env.DB, {
      tokenHash: fresh,
      amountCents: 200,
      currency: "USD",
      expiresAt: farFuture,
    });

    const cutoff = new Date().toISOString();
    const removed = await deleteExpired(env.DB, cutoff);
    expect(removed).toBe(1);

    expect(await findByTokenHash(env.DB, stale)).toBeNull();
    expect(await findByTokenHash(env.DB, fresh)).not.toBeNull();
  });
});
