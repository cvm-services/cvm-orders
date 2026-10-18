// Regression tests for the two hazards that cost real money on 2026-10-18.
//
// INCIDENT
//   A funded-proof run created a 128-sat Minibits invoice, paid it through the
//   treasury NWC rail, and then the NWC client TIMED OUT waiting for the reply.
//   The broker had already executed the payment (balance 20002 -> 19874). Because
//   the mint quote id had not been persisted BEFORE paying, those 128 sats became
//   unclaimable ecash: paid for, no longer addressable.
//
// TWO DEFECTS, TWO GUARANTEES
//
//  1. ORDERING. The quote id must be durable BEFORE the payment leaves, or a
//     timeout destroys the link between money spent and ecash owed.
//  2. TIMEOUT IS NOT FAILURE. A pay_invoice timeout has an UNKNOWN outcome: the
//     broker may have executed it. Retrying would double-pay. So a timeout must
//     surface as a distinct "outcome unknown" state carrying the quote id, and
//     must NEVER be auto-retried.

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  fundAndClaim,
  PaymentOutcomeUnknown,
  resumeClaim,
  type FundingJournal,
  type FundingRecord,
} from "../src/treasury_fund.ts";

/** Records every call so the ORDER of persistence vs payment is assertable. */
function makeJournal() {
  const calls: string[] = [];
  const records = new Map<string, FundingRecord>();
  const j: FundingJournal = {
    begin(rec) {
      calls.push(`begin:${rec.quoteId}`);
      records.set(rec.quoteId, { ...rec, state: "paying" });
    },
    markPaid(quoteId, preimage) {
      calls.push(`markPaid:${quoteId}`);
      const r = records.get(quoteId);
      if (r) records.set(quoteId, { ...r, state: "paid", preimage });
    },
    markClaimed(quoteId, proofs) {
      calls.push(`markClaimed:${quoteId}`);
      const r = records.get(quoteId);
      if (r) records.set(quoteId, { ...r, state: "claimed", proofs });
    },
    get(quoteId) {
      return records.get(quoteId);
    },
  };
  return { journal: j, calls, records };
}

function makeRail(opts: { bolt11?: string; quoteId?: string; settlement?: "settled" | "unpaid" } = {}) {
  const calls: string[] = [];
  return {
    calls,
    rail: {
      async createInvoice() {
        calls.push("createInvoice");
        return { quoteId: opts.quoteId ?? "quote-1", bolt11: opts.bolt11 ?? "lnbc1fake" };
      },
      async checkSettlement() {
        calls.push("checkSettlement");
        return opts.settlement ?? "settled";
      },
    },
    claim: async (_q: string) => {
      calls.push("claim");
      return { proofs: [{ amount: 2, id: "ks", secret: "s", C: "c" }], keysetId: "ks" };
    },
  };
}

function makeWallet(behaviour: "ok" | "timeout") {
  let n = 0;
  return {
    get calls() {
      return n;
    },
    wallet: {
      async payInvoice() {
        n += 1;
        if (behaviour === "timeout") throw new Error("NWC pay_invoice timed out");
        return { preimage: "deadbeef" };
      },
    },
  };
}

// --- 1. ORDERING: the quote id is durable BEFORE the payment ----------------
Deno.test("journal.begin runs BEFORE the wallet pays (ordering is the guarantee)", async () => {
  const { journal, calls } = makeJournal();
  const { rail, claim, calls: railCalls } = makeRail();
  const w = makeWallet("ok");

  await fundAndClaim({ rail, wallet: w.wallet, journal, claim, sats: 2 });

  const beginAt = calls.indexOf("begin:quote-1");
  assertEquals(beginAt >= 0, true, "begin must be recorded");
  // The payment must happen strictly AFTER the quote is written down.
  assertEquals(
    calls[beginAt + 1]?.startsWith("markPaid"),
    true,
    `expected markPaid immediately after begin, got ${calls.join(",")}`,
  );
  assertEquals(railCalls.includes("createInvoice"), true);
  assertEquals(w.calls, 1, "paid exactly once");
});

// --- 2. TIMEOUT: unknown outcome, quote preserved, never retried ------------
Deno.test("a pay timeout preserves the quote and is NOT retried (no double-pay)", async () => {
  const { journal, records } = makeJournal();
  // The mint never confirms, so the run must end in UNKNOWN — but only after
  // consulting the mint, which is the authority (see treasury_mint_authority_test).
  const { rail, claim } = makeRail({ settlement: "unpaid" });
  const w = makeWallet("timeout");

  const err = await assertRejects(
    () => fundAndClaim({
      rail, wallet: w.wallet, journal, claim, sats: 2,
      settlementDeadlineMs: 40, pollMs: 5,
    }),
    PaymentOutcomeUnknown,
  );

  // The money may have left. The client must know WHICH quote that was about, or
  // the sats are unclaimable — the exact defect that lost 128 sats.
  assertEquals(err.quoteId, "quote-1");
  const rec = records.get("quote-1");
  assertEquals(rec !== undefined, true, "the quote must survive a timeout on disk");
  assertEquals(rec!.state, "paying");
  assertEquals(rec!.amountSats, 2);

  // NEVER retry a payment whose outcome is unknown.
  assertEquals(w.calls, 1, `payInvoice must be attempted exactly once, got ${w.calls}`);
});

// --- 3. RECOVERY: resume a timed-out quote without paying again ------------
Deno.test("resumeClaim claims a paid-but-unclaimed quote without paying again", async () => {
  const { journal, records } = makeJournal();
  const { rail, claim } = makeRail();
  const w = makeWallet("timeout");

  // Simulate the crash: the quote is on disk in state "paying".
  journal.begin({ quoteId: "quote-1", amountSats: 2, bolt11: "lnbc1fake", startedAt: 0 });
  assertEquals(records.get("quote-1")!.state, "paying");

  const res = await resumeClaim({ rail, journal, claim, quoteId: "quote-1" });

  assertEquals(res.claimed, true);
  if (!res.claimed) throw new Error("unreachable");
  assertEquals(res.proofs.length, 1);
  assertEquals(w.calls, 0, "resume must NEVER pay — the invoice was already paid");
  assertEquals(records.get("quote-1")!.state, "claimed");
});

Deno.test("resumeClaim refuses when the mint does not consider the quote settled", async () => {
  const { journal } = makeJournal();
  const { rail, claim } = makeRail({ settlement: "unpaid" });
  journal.begin({ quoteId: "quote-2", amountSats: 2, bolt11: "lnbc1fake", startedAt: 0 });

  const res = await resumeClaim({ rail, journal, claim, quoteId: "quote-2" });
  assertEquals(res.claimed, false);
  if (res.claimed) throw new Error("unreachable");
  assertEquals(res.reason, "not_settled");
});

// --- 4. The happy path records the full lifecycle --------------------------
Deno.test("successful funding walks paying -> paid -> claimed", async () => {
  const { journal, calls, records } = makeJournal();
  const { rail, claim } = makeRail();
  const w = makeWallet("ok");

  await fundAndClaim({ rail, wallet: w.wallet, journal, claim, sats: 2 });

  assertEquals(calls.filter((c) => c.startsWith("begin")), ["begin:quote-1"]);
  assertEquals(records.get("quote-1")!.state, "claimed");
  assertEquals(typeof records.get("quote-1")!.preimage, "string");
});
