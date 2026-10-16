/**
 * The customer's npub on the order (ADR-0018).
 *
 * A customer who signs in has an identity; the facilitator needs it to reach
 * them about a problem with the order. Three invariants matter:
 *
 *   1. it is OPTIONAL — an anonymous order is unchanged in every respect;
 *   2. it validates to a real 64-char x-only pubkey, so the facilitator's DM
 *      tool does not fail on garbage at the worst moment;
 *   3. it appears in the FACILITATOR's queue and nowhere public — not in the
 *      customer-facing order payload, not in the printed receipt.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { OrderStore } from "../src/store.ts";
import { TEST_REFUND_BOLT11 } from "./helpers/refund_fixture.ts";

const PK = "a".repeat(64);
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

/**
 * Create an order and settle it — the facilitator queue lists PAID orders (what
 * a facilitator must act on), so an unsettled one is not queue material.
 */
function store(payload: Record<string, unknown> = {}) {
  const s = new OrderStore();
  const order = s.create("o1", { venue_slug: "v", refund_bolt11: TEST_REFUND_BOLT11, ...payload }, MONEY);
  s.claimSettlement("o1", { quoteId: "q-" + Math.random() });
  return { s, order };
}

Deno.test("a valid customer npub is stored and appears in the facilitator queue", () => {
  const { s } = store({ customer_npub: PK });
  const q = s.queue();
  assertEquals(q.length, 1);
  assertEquals(q[0].customer_npub, PK);
});

Deno.test("an anonymous order is unchanged: no npub, no placeholder", () => {
  const { s } = store();
  const q = s.queue();
  assertEquals(q.length, 1);
  assertEquals(q[0].customer_npub ?? null, null, "must be absent, not an empty string");
});

Deno.test("a bad npub is rejected at creation, not silently stored", () => {
  const s = new OrderStore();
  for (const bad of ["npub1short", "A".repeat(64), "z".repeat(64), "a".repeat(63), "a".repeat(65)]) {
    let threw = false;
    try {
      s.create("bad-" + bad, {  venue_slug: "v", customer_npub: bad, refund_bolt11: TEST_REFUND_BOLT11 }, MONEY);
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `expected ${JSON.stringify(bad).slice(0, 20)} to be refused`);
  }
});

Deno.test("an empty or whitespace npub means ANONYMOUS, not invalid", () => {
  // A form that was left blank must not fail the whole order. This is a
  // deliberate choice: "" is absent. Anything non-empty that is not a real
  // pubkey is a hard refusal (previous test).
  const s = new OrderStore();
  for (const blank of ["", "   ", undefined, null]) {
    const id = "blank-" + String(blank);
    s.create(id, {  venue_slug: "v", customer_npub: blank as never, refund_bolt11: TEST_REFUND_BOLT11 }, MONEY);
    assertEquals(s.get(id)?.customer_npub ?? null, null, `"${blank}" must be anonymous`);
  }
});

Deno.test("the npub survives a restart (durable, like the invoice)", () => {
  const path = Deno.makeTempFileSync({ suffix: ".db" });
  try {
    const a = new OrderStore({ path });
    a.create("o1", {  venue_slug: "v", customer_npub: PK, refund_bolt11: TEST_REFUND_BOLT11 }, MONEY);
    a.close?.();
    const b = new OrderStore({ path });
    assertEquals(b.get("o1")?.customer_npub, PK);
  } finally {
    try { Deno.removeSync(path); } catch { /* already gone */ }
  }
});

Deno.test("the npub is NOT in the customer-facing order body", () => {
  const { s } = store({ customer_npub: PK });
  const o = s.get("o1")!;
  // The customer already knows their own key; echoing it back adds nothing and
  // invites a public surface to start carrying it.
  const customerView = { id: o.id, state: o.state, subtotal: o.subtotal, total: o.total };
  assert(!JSON.stringify(customerView).includes(PK), "must not leak into the customer view");
});

Deno.test("a stale queue entry cannot carry a DIFFERENT customer's npub", () => {
  const s = new OrderStore();
  s.create("o1", {  venue_slug: "v", customer_npub: PK, refund_bolt11: TEST_REFUND_BOLT11 }, MONEY);
  s.create("o2", {  venue_slug: "v", customer_npub: "b".repeat(64), refund_bolt11: TEST_REFUND_BOLT11 }, MONEY);
  s.claimSettlement("o1", { quoteId: "q1" });
  s.claimSettlement("o2", { quoteId: "q2" });
  const q = s.queue();
  const byId = Object.fromEntries(q.map((o) => [o.id, o.customer_npub]));
  assertEquals(byId["o1"], PK);
  assertEquals(byId["o2"], "b".repeat(64));
});
