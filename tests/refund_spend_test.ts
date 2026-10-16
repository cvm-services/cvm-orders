/**
 * THE TEST THAT WOULD HAVE CAUGHT IT: a refund must SPEND, not just quote.
 *
 * The original R1 suite reached `refunded` with a fake rail that set
 * `state = "paid"` by assignment. Nothing asserted that the rail was ever asked to
 * pay, so a missing payment step stayed green and the customer silently received
 * nothing. These tests assert on the SPEND, and on what happens when a rail cannot
 * spend at all.
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { OrderStore } from "../src/store.ts";
import { reconcileRefund, RefundError, type RefundRails } from "../src/refund.ts";
import type { MeltProof } from "../src/melt_authorize.ts";

const REFUND_INVOICE = "lnbc1500n1p3spendexampleinvoice";
const MONEY = {
  venue_slug: "test-venue",
  items: [{ sku: "100", name: "X", qty: 1, options: [], unit_price_sats: 1500, line_total_sats: 1500 }],
  subtotal: 1500,
  fee: 315,
  total: 1815,
  fulfilment: "pickup" as const,
  inputs: {},
};

/** A rail that records the spend, and only reports `paid` after one happened. */
class SpendingRail implements RefundRails {
  quotes = 0;
  authorisations: Array<{ quoteId: string; amount: number; feeReserve: number; proofs: number }> = [];
  pastQuoteId = "melt-quote-1";

  async meltQuote(req: { request: string; memo?: string }) {
    this.quotes += 1;
    return { quoteId: this.pastQuoteId, request: req.request, state: "UNPAID", amount: 1500, feeReserve: 15 };
  }

  async authorizeMelt(req: { quoteId: string; amount: number; feeReserve: number; proofs: MeltProof[] }) {
    this.authorisations.push({
      quoteId: req.quoteId,
      amount: req.amount,
      feeReserve: req.feeReserve,
      proofs: req.proofs.length,
    });
    return { state: "PENDING" };
  }

  async spendableFor() {
    return { proofs: [{ amount: 1515, id: "k1", secret: "s", C: "02aa" }] as MeltProof[], ladder: [1, 2, 4, 8, 16] };
  }

  /** The mint's verdict — paid only once we actually authorised. */
  async checkMelt(_id: string): Promise<"unpaid" | "pending" | "paid"> {
    return this.authorisations.length ? "paid" : "unpaid";
  }
}

/** A rail that can quote and poll but CANNOT spend (the shape that shipped). */
class QuoteOnlyRail implements RefundRails {
  async meltQuote() {
    return { quoteId: "q-only", state: "UNPAID" };
  }
  async checkMelt() {
    return "unpaid" as const;
  }
}

function paidOrder(store: OrderStore, id = "o-1") {
  store.create(id, { refund_bolt11: REFUND_INVOICE }, MONEY);
  store.claimSettlement(id, { quoteId: `q-${id}` });
  return id;
}

// --- S1: the regression guard for the whole bug --------------------------------

Deno.test("S1: a refund REQUESTS a payment — authoriseMelt is called with the proofs", async () => {
  const store = new OrderStore({ path: ":memory:" });
  const id = paidOrder(store);
  const rails = new SpendingRail();

  const res = await reconcileRefund(store, rails, id);

  assertEquals(rails.authorisations.length, 1, "the melt must actually be AUTHORISED, not merely quoted");
  assertEquals(rails.authorisations[0].quoteId, "melt-quote-1", "the spend names the quote we created");
  assertEquals(rails.authorisations[0].proofs, 1, "proofs must be handed to the mint");
  assertEquals(res.confirmed, true, "and only then is the refund confirmed");
  assertEquals(store.get(id)!.state, "refunded");
});

Deno.test("S2: a rail that cannot spend must FAIL, not pretend to refund", async () => {
  const store = new OrderStore({ path: ":memory:" });
  const id = paidOrder(store, "o-quoteonly");
  const rails = new QuoteOnlyRail();

  await assertRejects(
    () => reconcileRefund(store, rails, id),
    RefundError,
    "cannot authorise a melt",
  );
  // Critically: the order is NOT marked refunded. The old code would have left it
  // `refunding` forever, which reads like work in progress and never completes.
  assertEquals(store.get(id)!.state, "refunding", "a rail that cannot pay must not yield `refunded`");
});

// --- S3: no double spend -------------------------------------------------------

Deno.test("S3: a second pass does NOT re-authorise the same proofs", async () => {
  const store = new OrderStore({ path: ":memory:" });
  const id = paidOrder(store, "o-twice");
  const rails = new SpendingRail();

  await reconcileRefund(store, rails, id);
  await reconcileRefund(store, rails, id); // already refunded -> no-op

  assertEquals(rails.authorisations.length, 1, "proofs are bearer money: never POST them twice");
  assertEquals(rails.quotes, 1, "and never re-quote a settled melt");
});

Deno.test("S4: the quote funds the melt — amount and fee reserve reach the spend", async () => {
  const store = new OrderStore({ path: ":memory:" });
  const id = paidOrder(store, "o-funded");
  const rails = new SpendingRail();

  await reconcileRefund(store, rails, id);

  const a = rails.authorisations[0];
  assertEquals(a.amount, 1500, "the invoice amount from the quote");
  assertEquals(a.feeReserve, 15, "the fee reserve must be reserved, or the melt is underfunded");
});
