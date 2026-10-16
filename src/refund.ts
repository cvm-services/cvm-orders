/**
 * REFUND — the leg that returns a customer's sats (R1).
 *
 * CONTEXT, because the naming here is load-bearing. When a customer's invoice
 * settles we do NOT leave the sats at the mint as their money: `claimEcash()`
 * MINTS our own ecash proofs, so the customer has no sats and we hold them. That
 * is correct for a placed order and catastrophic for an unplaced one — which is
 * precisely the loss the operator hit, because "refund" was only a state label.
 *
 * A refund is therefore a NUT-05 MELT: we hand the mint our ecash and ask it to
 * pay the CUSTOMER's invoice. `src/rail.ts` has had `meltQuote()`/`checkMelt()`
 * since Phase A; this module is the missing orchestration, and nothing else in
 * the codebase is allowed to spend a refund melt.
 *
 * THE ONE RULE THAT MATTERS: only the MINT may say a melt went through. Our own
 * state machine can say "we asked" (`refunding`); it may say "it is done"
 * (`refunded`) exclusively on a mint verdict of `paid`. Everything below is
 * shaped by that.
 */

import type { OrderStore } from "./store.ts";

/** A refund failed in a way the caller should surface (and may retry). */
export class RefundError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "RefundError";
  }
}

/** The rail surface a refund needs. `CashuRail` satisfies this structurally. */
export interface RefundRails {
  meltQuote(req: { request: string; memo?: string }): Promise<{ quoteId: string; state: string }>;
  checkMelt(quoteId: string): Promise<"unpaid" | "pending" | "paid">;
}

export interface RefundResult {
  orderId: string;
  state: "refunding" | "refunded";
  /** The melt quote carrying this refund, for the operator to inspect. */
  quoteId: string | null;
  /** True when THIS call observed the mint's PAID verdict. */
  confirmed: boolean;
}

/**
 * Drive one order toward `refunded`, idempotently.
 *
 * Idempotency comes from the store, not from here: `claimRefundMelt()` is a
 * compare-and-set latch on a durable column, so two facilitators racing produce
 * exactly one melt. Callers that lose the race (or re-enter after a crash)
 * simply observe the existing quote's verdict instead of melting again.
 *
 * A refund the mint has NOT confirmed is deliberately left in `refunding` and
 * NOT marked refunded, so a later attempt can finish it. A dead mint surfaces as
 * `RefundError` rather than a silent "we tried".
 */
export async function reconcileRefund(
  store: OrderStore,
  rails: RefundRails,
  orderId: string,
): Promise<RefundResult> {
  const order = store.get(orderId);
  if (!order) throw new RefundError(`no such order: ${orderId}`);

  // Already done: report it, spend nothing, melt nothing. Reachable repeatedly
  // (a facilitator clicking twice, a sweeper retrying) and must stay a no-op.
  if (order.state === "refunded") {
    return { orderId, state: "refunded", quoteId: store.refundMeltQuote(orderId), confirmed: false };
  }

  const target = store.refundTargetFor(orderId);
  if (!target) {
    // Should be unreachable: creation refuses an order with no refund target.
    // If it happens anyway (a row predating the refusal), say so instead of
    // pretending we can pay someone we have no invoice for.
    throw new RefundError(
      `order ${orderId} has no refund invoice recorded — nothing to melt to. ` +
        "Collect one from the customer before any further attempt.",
    );
  }

  // Move to `refunding` (from paid/placing) if we are not there yet. Committing
  // this BEFORE the network call is what makes the state visible to an operator
  // while the melt is in flight, and what makes a crash recoverable.
  if (order.state === "paid" || order.state === "placing") {
    store.transition(orderId, "refunding");
  } else if (order.state !== "refunding") {
    throw new RefundError(
      `order ${orderId} is in state '${order.state}' — only a paid or in-flight order can be refunded`,
    );
  }

  // --- the melt, exactly once ------------------------------------------------
  //
  // ORDER MATTERS AND IS NOT OBVIOUS. The latch must be claimed BEFORE the
  // network call, not after: two racing tasks both read `refund_melt_quote` as
  // null while awaiting the first `meltQuote()`, so a claim placed AFTER the
  // quote would let both mint a melt — a double refund, the exact bug this
  // module exists to prevent. Reserving the intent first makes it impossible.
  let quoteId = store.refundMeltQuote(orderId);
  if (!quoteId) {
    const reservation = store.reserveRefundMelt(orderId);
    if (!reservation.won) {
      // A racer owns the melt. Two sub-cases, and neither may start a melt:
      //   * it has a quote id -> we can poll that same quote below;
      //   * it is still mid-quote (`pending`) -> there is nothing to poll yet, so
      //     report "refunding" and let the owner finish. Quoting here is exactly
      //     the double-refund this latch exists to prevent.
      if (!reservation.quoteId) {
        return { orderId, state: "refunding", quoteId: null, confirmed: false };
      }
      quoteId = reservation.quoteId;
    }
  }

  if (!quoteId) {
    let quoted: { quoteId: string; state: string };
    try {
      // No amount is sent: the mint reads the bolt11, so the amount can never
      // disagree with the customer's own invoice.
      quoted = await rails.meltQuote({ request: target, memo: `refund ${orderId}` });
    } catch (e) {
      // Release the reservation so a later attempt is not permanently barred by
      // a transient mint failure — the order stays refundable.
      store.releaseRefundReservation(orderId);
      throw new RefundError(`refund melt quote failed for ${orderId}: ${(e as Error).message}`, e);
    }
    if (!quoted?.quoteId) {
      store.releaseRefundReservation(orderId);
      throw new RefundError(`refund melt quote for ${orderId} returned no quote id`);
    }
    store.recordRefundQuote(orderId, quoted.quoteId);
    quoteId = quoted.quoteId;
  }

  // --- the only thing that may authorise `refunded` --------------------------
  let state: "unpaid" | "pending" | "paid";
  try {
    state = await rails.checkMelt(quoteId);
  } catch (e) {
    throw new RefundError(`refund melt status failed for ${orderId} (quote ${quoteId}): ${(e as Error).message}`, e);
  }

  if (state !== "paid") {
    // unpaid | pending -> we asked; the mint has not confirmed. Stay refunding so
    // a retry can complete it. NEVER set refunded here.
    return { orderId, state: "refunding", quoteId, confirmed: false };
  }

  const committed = store.transition(orderId, "refunded");
  return { orderId, state: committed.state as "refunded", quoteId, confirmed: true };
}
