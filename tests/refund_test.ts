/**
 * REFUND — the money-safety contract (R1).
 *
 * The bug this file exists to kill: `refund` today only flips a state label and
 * sends a Nostr DM (site/console/app.js `refund()` — its own notice admits
 * "melt to origin is the paid leg's job"). `src/rail.ts` has had `meltQuote()`
 * and `checkMelt()` (NUT-05) since Phase A, but NO route calls them. So a
 * customer whose order is never placed keeps nothing: we hold their ecash and
 * they have neither food nor sats. That is the loss the operator reported.
 *
 * The invariants pinned here, in order of importance:
 *
 *   I1  A refund is only "done" when the MINT says PAID. Never on our say-so.
 *       (Only the mint may say a melt went through — same rule as settlement.)
 *   I2  A refund needs somewhere to send the money. Without a customer-supplied
 *       bolt11 we cannot melt, so we must refuse the order UP FRONT rather than
 *       accept sats we have no way to return.
 *   I3  A sats amount is never LOST: for every terminal outcome it is either
 *       still owed (a live order) or paid back (a confirmed melt).
 *   I4  Exactly one melt per order, even with two facilitators racing. A
 *       double-refund is theft from the platform, not a UX bug.
 *   I5  A refund that the mint has NOT confirmed must be retryable — a failed
 *       attempt leaves the order refundable, never stuck.
 *   I6  `refunded` is terminal and unreachable except through a confirmed melt.
 */

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { OrderStore, type OrderMoney } from "../src/store.ts";
import { reconcileRefund, RefundError, type RefundRails } from "../src/refund.ts";
import { TEST_REFUND_BOLT11 } from "./helpers/refund_fixture.ts";
import type { MeltProof } from "../src/melt_authorize.ts";

/**
 * Fake rail: records melts, and RECORDS THE SPEND.
 *
 * It now implements `authorizeMelt`/`spendableFor`, because a rail that can only
 * quote cannot refund — and the previous version of this double was the reason a
 * missing payment step went unnoticed. Its `state` is still settable, because the
 * MINT'S ANSWER is legitimately the test's to choose; what is no longer the test's
 * to fake is whether we sent a payment.
 */
class FakeRefundRails implements RefundRails {
  melts: Array<{ request: string; memo?: string }> = [];
  /** Every spend we were asked to make. Asserted on in the spend tests. */
  spends: Array<{ quoteId: string; amount: number; feeReserve: number; proofs: number }> = [];
  /** What `checkMelt` reports for the most recent quote. */
  state: "unpaid" | "pending" | "paid" = "unpaid";
  quoteId = "melt-quote-1";
  throwOnQuote = false;
  throwOnCheck = false;
  throwOnSpend = false;

  async meltQuote(req: { request: string; memo?: string }) {
    if (this.throwOnQuote) throw new Error("mint unreachable");
    this.melts.push(req);
    return { quoteId: this.quoteId, request: req.request, state: this.state, amount: 1500, feeReserve: 15 };
  }

  async checkMelt(_quoteId: string) {
    if (this.throwOnCheck) throw new Error("mint unreachable");
    return this.state;
  }

  async authorizeMelt(req: { quoteId: string; amount: number; feeReserve: number; proofs: MeltProof[] }) {
    if (this.throwOnSpend) throw new Error("mint unreachable mid-spend");
    this.spends.push({
      quoteId: req.quoteId,
      amount: req.amount,
      feeReserve: req.feeReserve,
      proofs: req.proofs.length,
    });
    return { state: "PENDING" };
  }

  async spendableFor() {
    return {
      proofs: [{ amount: 1515, id: "keyset-1", secret: "s".repeat(32), C: "02" + "a".repeat(64) }] as MeltProof[],
      ladder: [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024],
    };
  }
}

const REFUND_INVOICE = "lnbc1500n1p3refundexampleinvoice"; // shape only; never paid in tests

const MONEY: OrderMoney = {
  venue_slug: "three-buddies-berlin",
  items: [],
  subtotal: 1500,
  fee: 315,
  total: 1815,
  fulfilment: "pickup",
  inputs: {},
};

/** A customer order that already carries its refund target, walked to `paid`. */
function paidOrder(store: OrderStore, id = "o-refund-1"): void {
  store.create(id, { refund_bolt11: REFUND_INVOICE }, MONEY);
  store.transition(id, "paid");
}

// ---------------------------------------------------------------- I2: the up-front refusal

Deno.test("I2: sats are NOT claimed for an order with no refund invoice", () => {
  // The binding rule is at the EDGE THAT ACCEPTS MONEY, not at creation. An order
  // may legally exist before its refund invoice is known (a facilitator-made
  // order, or one whose target arrives later) — but money may never be claimed
  // while there is nowhere to send it back.
  const store = new OrderStore({ path: ":memory:" });
  store.create("o-norefund", {}, MONEY); // allowed: no target yet
  const outcome = store.claimSettlement("o-norefund", { quoteId: "q-norefund" });
  assertEquals(outcome, "no_refund_target",
    "settling an order with nowhere to refund must be refused");
  assertEquals(store.get("o-norefund")!.state, "awaiting_payment",
    "refused claim leaves the order unsettled — nothing is owed, nothing is stranded");
  assertEquals(store.queue().length, 0, "and it is certainly not paid work");
});

Deno.test("I2: once a refund target is recorded, the same order settles normally", () => {
  // The refusal above must be a delayed 'not yet', not a permanent dead end.
  const store = new OrderStore({ path: ":memory:" });
  store.create("o-later", {}, MONEY);
  store.setRefundTarget("o-later", REFUND_INVOICE);
  assertEquals(store.claimSettlement("o-later", { quoteId: "q-later" }), "won");
  assertEquals(store.get("o-later")!.state, "paid");
});

Deno.test("I2: a non-invoice value for refund_bolt11 is refused (no garbage stored)", () => {
  const store = new OrderStore({ path: ":memory:" });
  let threw = false;
  try {
    store.create("o-badrefund", { refund_bolt11: "not-a-lightning-invoice" }, MONEY);
  } catch {
    threw = true;
  }
  assertEquals(threw, true, "an unpayable refund target must be refused, not stored");
});

// ---------------------------------------------------------------- I1/I3: melt then confirm

Deno.test("I1/I3: refund melts to the customer's invoice and confirms ONLY on the mint's PAID", async () => {
  const store = new OrderStore({ path: ":memory:" });
  paidOrder(store);
  store.setRefundTarget("o-refund-1", REFUND_INVOICE);
  const rails = new FakeRefundRails();
  rails.state = "unpaid";

  // First pass: we quote the melt, the mint has NOT confirmed -> NOT refunded.
  const first = await reconcileRefund(store, rails, "o-refund-1");
  assertEquals(rails.melts.length, 1, "one melt quote was requested");
  assertEquals(rails.melts[0].request, REFUND_INVOICE, "the melt pays the CUSTOMER's invoice");
  assertEquals(first.state === "refunded", false, "an unpaid melt must not mark the order refunded");
  assertEquals(store.get("o-refund-1")!.state, "refunding", "the order is refunding, not refunded");

  // The mint now confirms. Only THEN may we say refunded.
  rails.state = "paid";
  const second = await reconcileRefund(store, rails, "o-refund-1");
  assertEquals(second.state, "refunded");
  assertEquals(store.get("o-refund-1")!.state, "refunded", "mint PAID -> refunded");
});

// ---------------------------------------------------------------- I5: retryable

Deno.test("I5: a refund the mint has not confirmed stays retryable", async () => {
  const store = new OrderStore({ path: ":memory:" });
  paidOrder(store, "o-retry");
  store.setRefundTarget("o-retry", REFUND_INVOICE);
  const rails = new FakeRefundRails();
  rails.throwOnQuote = true;

  // 3rd arg to assertRejects is the error CLASS, not a message.
  await assertRejects(() => reconcileRefund(store, rails, "o-retry"), RefundError);
  assertEquals(store.get("o-retry")!.state, "refunding",
    "still refunding -> a later attempt can finish it");

  rails.throwOnQuote = false;
  rails.state = "paid";
  const done = await reconcileRefund(store, rails, "o-retry");
  assertEquals(done.state, "refunded", "the retry completes");
});

// ---------------------------------------------------------------- I4: exactly once

Deno.test("I4: two racing refund passes produce exactly ONE melt", async () => {
  const store = new OrderStore({ path: ":memory:" });
  paidOrder(store, "o-race");
  store.setRefundTarget("o-race", REFUND_INVOICE);
  const rails = new FakeRefundRails();
  rails.state = "paid";

  const settled = await Promise.allSettled([
    reconcileRefund(store, rails, "o-race"),
    reconcileRefund(store, rails, "o-race"),
  ]);
  assertEquals(rails.melts.length, 1, "exactly one melt quote, not two");
  assertEquals(store.get("o-race")!.state, "refunded", "the order ends refunded exactly once");
  // One caller wins and observes `refunded`; a racer that reached the transition
  // after the winner may surface an InvalidTransition — also fine, because the
  // money moved ONCE either way. What must never happen is two melts.
  const refunded = settled
    .filter((r) => r.status === "fulfilled")
    .map((r) => (r as PromiseFulfilledResult<{ state: string }>).value.state)
    .filter((s) => s === "refunded").length;
  assertEquals(refunded >= 1, true, "at least one caller observed the confirmed refund");
});

Deno.test("I4: a second refund on an already-refunded order is a no-op, never a new melt", async () => {
  const store = new OrderStore({ path: ":memory:" });
  paidOrder(store, "o-twice");
  store.setRefundTarget("o-twice", REFUND_INVOICE);
  const rails = new FakeRefundRails();
  rails.state = "paid";

  await reconcileRefund(store, rails, "o-twice");
  await reconcileRefund(store, rails, "o-twice");
  assertEquals(rails.melts.length, 1, "the second attempt must not melt again");
});

// ---------------------------------------------------------------- I6: terminality

Deno.test("I6: refunded is terminal — nothing transitions out of it", () => {
  const store = new OrderStore({ path: ":memory:" });
  paidOrder(store, "o-term");
  store.setRefundTarget("o-term", REFUND_INVOICE);
  // The legal path to refunded runs THROUGH refunding — a state label can no
  // longer be set directly, which is the whole point of the change.
  store.transition("o-term", "refunding");
  store.transition("o-term", "refunded");
  let threw = false;
  try {
    store.transition("o-term", "placing");
  } catch {
    threw = true;
  }
  assertEquals(threw, true, "a refunded order cannot be placed afterwards");
});

Deno.test("I6: an order cannot be marked refunded without a confirmed melt", async () => {
  const store = new OrderStore({ path: ":memory:" });
  paidOrder(store, "o-nomelt");
  store.setRefundTarget("o-nomelt", REFUND_INVOICE);
  const rails = new FakeRefundRails();
  rails.state = "pending";

  const res = await reconcileRefund(store, rails, "o-nomelt");
  assertEquals(res.state, "refunding");
  assertEquals(store.get("o-nomelt")!.state === "refunded", false,
    "a pending melt must never read as refunded");
});
