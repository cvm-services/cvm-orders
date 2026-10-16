/**
 * Shared test constant: a placeholder BOLT11 refund target.
 *
 * WHY EVERY ORDER FIXTURE CARRIES ONE
 *
 * Since R1 (2026-10-15) `POST /orders` REFUSES an order that does not state
 * where a refund would go. That is the money-safety rule: we must never accept
 * sats we have no way to return, because the refund leg melts BACK to this very
 * invoice. An order without one has only two possible outcomes — the food
 * arrives, or we keep the customer's money — and the second is the loss the
 * operator actually hit.
 *
 * So this is not test noise. A fixture that omits it is modelling an order the
 * production route would reject, and the correct fix is for the fixture to be
 * honest rather than to weaken the route.
 *
 * It is deliberately NOT a valid, payable invoice: nothing in the suite melts
 * real money, and the mint is only ever a fake. `looksLikeBolt11()` accepts it
 * structurally; `RefundRails` in tests is always a stub.
 */
export const TEST_REFUND_BOLT11 =
  "lnbc1500n1p3zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

/** Spread into any order request body whose subject is NOT the refund leg. */
export const REFUND_TARGET = { refund_bolt11: TEST_REFUND_BOLT11 } as const;
