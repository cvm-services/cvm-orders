/**
 * Store-level half of ADR-0008: an order is BORN unpaid.
 *
 * `create()` used to hand back a `paid` order, which made "paid" a value any
 * caller could produce with no sats behind it — the bug this file pins. The
 * store now starts every order in `awaiting_payment`, and `paid` is only
 * reachable through the legal edge `awaiting_payment -> paid` that the route
 * gates on a rail settlement (see tests/invoice_test.ts).
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { InvalidTransitionError, type OrderState, OrderStore, StaleOrderStateError } from "../src/store.ts";

const money = {
  venue_slug: "test-venue",
  items: [{ sku: "100", name: "Pizza Margherita", qty: 1, options: ["House"], unit_price_sats: 9900, line_total_sats: 9900 }],
  subtotal: 9900,
  fee: 792,
  total: 10692,
  fulfilment: "pickup" as const,
  inputs: { "contact.phone": "+4915112345678" },
};

Deno.test("create() never yields a paid order", () => {
  const store = new OrderStore();
  const order = store.create("o-1", { item: "pizza" }, money);
  assertEquals(order.state, "awaiting_payment");
  assertEquals(store.get("o-1")?.state, "awaiting_payment");
  assertEquals(store.queue(), [], "an unverified order is not paid work");
});

Deno.test("the money fields travel with the order, so the invoice has a server-side total", () => {
  const store = new OrderStore();
  const order = store.create("o-m1", { item: "pizza" }, money);
  assertEquals(order.venue_slug, "test-venue");
  assertEquals(order.subtotal, 9900);
  assertEquals(order.fee, 792);
  assertEquals(order.total, 10692);
  assertEquals(order.fulfilment, "pickup");
  assertEquals(order.items?.[0].sku, "100");
  assertEquals(order.invoice, undefined, "no invoice until the rail makes one");
});

Deno.test("awaiting_payment is paid or expired; expired is terminal", () => {
  const store = new OrderStore();
  store.create("o-e1", {}, money);
  assertEquals(store.transition("o-e1", "expired", { from: "awaiting_payment" }).state, "expired");
  assertThrows(() => store.transition("o-e1", "paid"), InvalidTransitionError, undefined, "no resurrection");
  assertEquals(store.get("o-e1")?.state, "expired");

  // The paid edge is legal at the store level (the route is the gate) ...
  store.create("o-e2", {}, money);
  assertEquals(store.transition("o-e2", "paid", { from: "awaiting_payment" }).state, "paid");
  // ... and a second compare-and-set on it loses, which is how "exactly once" holds.
  assertThrows(
    () => store.transition("o-e2", "paid", { from: "awaiting_payment" }),
    StaleOrderStateError,
    undefined,
    "the second settlement poll cannot transition twice",
  );
  assertEquals(store.transition("o-e2", "placing").state, "placing");
  assertThrows(
    () => store.transition("o-e2", "expired"),
    InvalidTransitionError,
    undefined,
    "an expired quote cannot un-pay an order",
  );
});

Deno.test("ensureInvoice creates one invoice per order, sharing it with concurrent callers", async () => {
  const store = new OrderStore();
  store.create("o-i1", {}, money);
  let calls = 0;
  const factory = () => {
    calls++;
    return Promise.resolve({
      bolt11: `lnbc${calls}`,
      quoteId: `quote-${calls}`,
      expiresAt: "2026-10-10T18:00:00.000Z",
      qr: "data:image/svg+xml;base64,x",
    });
  };

  const [a, b, c] = await Promise.all([
    store.ensureInvoice("o-i1", factory),
    store.ensureInvoice("o-i1", factory),
    store.ensureInvoice("o-i1", factory),
  ]);
  assertEquals(calls, 1, "one order, one rail call");
  assertEquals(a.invoice?.bolt11, "lnbc1");
  assertEquals(b.invoice?.bolt11, "lnbc1");
  assertEquals(c.invoice?.bolt11, "lnbc1");
  assertEquals(store.get("o-i1")?.invoice?.quoteId, "quote-1", "cached on the order");

  const again = await store.ensureInvoice("o-i1", factory);
  assertEquals(calls, 1, "the cached invoice is returned, not re-quoted");
  assertEquals(again.invoice?.bolt11, "lnbc1");

  // A reader cannot rewrite the cached invoice.
  again.invoice!.bolt11 = "tampered";
  assertEquals(store.get("o-i1")?.invoice?.bolt11, "lnbc1");
});

Deno.test("a failed invoice stays unset, so the next call can try again", async () => {
  const store = new OrderStore();
  store.create("o-i2", {}, money);
  let calls = 0;
  const flaky = () => {
    calls++;
    if (calls === 1) return Promise.reject(new Error("mint unreachable"));
    return Promise.resolve({
      bolt11: "lnbcOK",
      quoteId: "quote-ok",
      expiresAt: "2026-10-10T18:00:00.000Z",
      qr: "data:image/svg+xml;base64,y",
    });
  };

  await assertThrowsAsync(() => store.ensureInvoice("o-i2", flaky), "mint unreachable");
  assertEquals(store.get("o-i2")?.invoice, undefined, "nothing half-written");
  const retried = await store.ensureInvoice("o-i2", flaky);
  assertEquals(retried.invoice?.bolt11, "lnbcOK");
  assertEquals(calls, 2);
});

async function assertThrowsAsync(fn: () => Promise<unknown>, message: string): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  assertEquals((caught as Error | undefined)?.message, message);
}

Deno.test("a lifecycle that assumed create() meant paid is now explicit", () => {
  const store = new OrderStore();
  store.create("o-l1", {}, money);
  const states: OrderState[] = ["paid", "placing", "placed", "ready"];
  for (const state of states) {
    const from = state === "paid" ? "awaiting_payment" : undefined;
    assertEquals(store.transition("o-l1", state, from ? { from } : {}).state, state);
  }
  assertEquals(store.queue(), [], "a ready order has left the paid queue");
});
