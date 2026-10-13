/**
 * Attaching the customer's npub to an order AFTER it was created (ADR-0018).
 *
 * The customer pays first and signs in at the receipt, so identity usually
 * arrives late. Two rules keep that safe:
 *
 *   * attach only when the order has NO identity yet — otherwise whoever learns
 *     an order id could later redirect the facilitator's DMs to themselves;
 *   * idempotent for the SAME key, so a repeated save is not an error.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { OrderStore } from "../src/store.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const MONEY = {
  venue_slug: "v",
  items: [{
    sku: "1",
    name: "X",
    qty: 1,
    options: [] as string[],
    unit_price_sats: 100,
    line_total_sats: 100,
  }],
  subtotal: 100,
  fee: 21,
  total: 121,
  fulfilment: "pickup" as const,
  inputs: {},
};

function fresh() {
  const s = new OrderStore();
  s.create("o1", { venue_slug: "v" }, MONEY);
  return s;
}

Deno.test("an npub can be attached to an anonymous order", () => {
  const s = fresh();
  assertEquals(s.attachCustomerNpub("o1", A), "attached");
  assertEquals(s.get("o1")?.customer_npub, A);
});

Deno.test("attaching the SAME npub twice is idempotent, not an error", () => {
  const s = fresh();
  assertEquals(s.attachCustomerNpub("o1", A), "attached");
  assertEquals(s.attachCustomerNpub("o1", A), "unchanged");
  assertEquals(s.get("o1")?.customer_npub, A);
});

Deno.test("a DIFFERENT npub cannot overwrite an attached one", () => {
  const s = fresh();
  s.attachCustomerNpub("o1", A);
  // Otherwise anyone who learns the order id could redirect the facilitator's
  // messages about an order that is not theirs.
  assertEquals(s.attachCustomerNpub("o1", B), "conflict");
  assertEquals(s.get("o1")?.customer_npub, A, "the first identity wins");
});

Deno.test("attaching to an unknown order reports missing", () => {
  assertEquals(fresh().attachCustomerNpub("nope", A), "missing");
});

Deno.test("a malformed npub is refused and attaches nothing", () => {
  const s = fresh();
  let threw = false;
  try {
    s.attachCustomerNpub("o1", "not-a-key");
  } catch {
    threw = true;
  }
  assert(threw, "must refuse");
  assertEquals(s.get("o1")?.customer_npub ?? null, null, "nothing was written");
});

Deno.test("the attached npub shows up in the facilitator queue after settlement", () => {
  const s = fresh();
  s.attachCustomerNpub("o1", A);
  s.claimSettlement("o1", { quoteId: "q1" });
  assertEquals(s.queue()[0].customer_npub, A);
});

Deno.test("attaching works after payment too (the late sign-in case)", () => {
  const s = fresh();
  s.claimSettlement("o1", { quoteId: "q1" });
  assertEquals(s.attachCustomerNpub("o1", A), "attached");
  assertEquals(s.queue()[0].customer_npub, A);
});
