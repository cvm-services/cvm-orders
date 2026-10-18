// The fix for the silent broker: the WALLET is just the payer, the MINT is the
// authority on whether money arrived.
//
// MEASURED PROBLEM (fleet broker, 2026-10-18)
//   get_balance    -> reply in 438ms
//   lookup_invoice -> reply in 448ms (not_implemented)
//   pay_invoice    -> NO reply, timeout at 60s, while the broker HAD executed the
//                     payment (balance 20002 -> 19874 for a 128-sat invoice).
//
// So blocking on pay_invoice's reply is the wrong dependency. A real Cashu mint
// always knows whether its own quote is paid, over plain HTTP. `fundAndClaim` must
// therefore treat a payment timeout as "in flight" and poll the MINT, not fail.

import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  fundAndClaim,
  PaymentOutcomeUnknown,
  type FundingJournal,
  type FundingRecord,
} from "../src/treasury_fund.ts";

function makeJournal() {
  const records = new Map<string, FundingRecord>();
  const calls: string[] = [];
  const j: FundingJournal = {
    begin(rec) {
      calls.push("begin");
      records.set(rec.quoteId, { ...rec, state: "paying" });
    },
    markPaid(quoteId, preimage) {
      calls.push("markPaid");
      const r = records.get(quoteId);
      if (r) records.set(quoteId, { ...r, state: "paid", preimage });
    },
    markClaimed(quoteId) {
      calls.push("markClaimed");
      const r = records.get(quoteId);
      if (r) records.set(quoteId, { ...r, state: "claimed" });
    },
    get(q) {
      return records.get(q);
    },
  };
  return { journal: j, records, calls };
}

/** A rail whose settlement answer can be scripted, e.g. unpaid twice then settled. */
function makeRail(settlementSequence: Array<"settled" | "unpaid" | "unknown">) {
  let i = 0;
  const seen: string[] = [];
  return {
    seen,
    rail: {
      async createInvoice() {
        return { quoteId: "q1", bolt11: "lnbc1fake" };
      },
      async checkSettlement(q: string) {
        seen.push(q);
        const state = settlementSequence[Math.min(i, settlementSequence.length - 1)];
        i += 1;
        return state;
      },
    },
  };
}

const claim = async () => ({ proofs: [{ amount: 4 }], keysetId: "ks" });

// --- THE KEY TEST ---------------------------------------------------------
Deno.test("a silent wallet does not fail the funding: the MINT settles it", async () => {
  const { journal, records } = makeJournal();
  const { rail } = makeRail(["unpaid", "unpaid", "settled"]);
  let paid = 0;

  const res = await fundAndClaim({
    rail,
    wallet: {
      async payInvoice() {
        paid += 1;
        throw new Error("NWC pay_invoice timed out"); // the broker's silence
      },
    },
    journal,
    claim,
    sats: 4,
    settlementDeadlineMs: 5_000,
    pollMs: 5,
  });

  assertEquals(paid, 1, "must pay exactly once — never retry a silent payment");
  assertEquals(res.proofs.length, 1, "ecash must still be claimed");
  assertEquals(records.get("q1")!.state, "claimed");
});

Deno.test("it polls the mint repeatedly while the payment is in flight", async () => {
  const { journal } = makeJournal();
  const { rail, seen } = makeRail(["unpaid", "unpaid", "unpaid", "settled"]);

  await fundAndClaim({
    rail,
    wallet: { async payInvoice() { throw new Error("timed out"); } },
    journal,
    claim,
    sats: 4,
    settlementDeadlineMs: 5_000,
    pollMs: 5,
  });

  assertEquals(seen.length >= 4, true, `expected repeated mint polls, got ${seen.length}`);
  assertEquals(seen.every((q) => q === "q1"), true, "poll the SAME quote");
});

Deno.test("if the mint never settles, it reports UNKNOWN with the quote preserved", async () => {
  const { journal, records } = makeJournal();
  const { rail } = makeRail(["unpaid"]);

  const err = await assertRejects(
    () => fundAndClaim({
      rail,
      wallet: { async payInvoice() { throw new Error("timed out"); } },
      journal,
      claim,
      sats: 4,
      settlementDeadlineMs: 40,
      pollMs: 5,
    }),
    PaymentOutcomeUnknown,
  );

  assertEquals(err.quoteId, "q1");
  assertStringIncludes(err.message, "mint");
  // Still recoverable later: the record is on disk, unfinished.
  assertEquals(records.get("q1")!.state, "paying");
});

Deno.test("a fresh error (not a timeout) still does not retry the payment", async () => {
  const { journal } = makeJournal();
  const { rail } = makeRail(["unpaid"]);
  let paid = 0;

  await assertRejects(
    () => fundAndClaim({
      rail,
      wallet: {
        async payInvoice() {
          paid += 1;
          throw new Error("insufficient balance");
        },
      },
      journal,
      claim,
      sats: 4,
      settlementDeadlineMs: 40,
      pollMs: 5,
    }),
    PaymentOutcomeUnknown,
  );
  assertEquals(paid, 1);
});

Deno.test("even a successful wallet reply confirms with the MINT before claiming", async () => {
  // The mint is the authority, always. A wallet saying "paid" is a claim; the mint's
  // own quote state is the evidence. Claiming an unsettled quote returns an error
  // that reads like a permanent failure, so we confirm first.
  const { journal } = makeJournal();
  const { rail, seen } = makeRail(["unpaid", "settled"]);

  const res = await fundAndClaim({
    rail,
    wallet: { async payInvoice() { return { preimage: "abc" }; } },
    journal,
    claim,
    sats: 4,
    pollMs: 5,
  });

  assertEquals(res.proofs.length, 1);
  assertEquals(seen.length >= 2, true, "must confirm with the mint, then claim");
});
