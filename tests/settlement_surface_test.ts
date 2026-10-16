import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { OrderStore } from "../src/store.ts";
import { TEST_REFUND_BOLT11 } from "./helpers/refund_fixture.ts";

const money = {
  venue_slug: "test-venue",
  refund_bolt11: TEST_REFUND_BOLT11,
  items: [{ sku: "1", name: "X", qty: 1, options: [], unit_price_sats: 1000, line_total_sats: 1000 }],
  subtotal: 1000,
  fee: 210,
  total: 1210,
  fulfilment: "pickup" as const,
  inputs: {},
};

Deno.test("a paid order carries its settlement proof on GET — the console gate depends on it", () => {
  const store = new OrderStore();
  store.create("o-1", {  venue_slug: "test-venue", refund_bolt11: TEST_REFUND_BOLT11 }, money);
  const out = store.claimSettlement("o-1", { quoteId: "q-1", proofHash: "h-1" }, "paid");
  assertEquals(out, "won");

  const order = store.get("o-1")!;
  // RED until surfaced: the console's requireSettled() reads payload.settlement,
  // and the service must actually put it there when the rail claim exists.
  const s = (order.payload as Record<string, unknown>).settlement as Record<string, unknown> | undefined;
  assertEquals(order.state, "paid");
  if (!s || s.status !== "settled") {
    throw new Error(
      "settlement proof not surfaced: the facilitator console's fiat gate can never open " +
        "(it reads payload.settlement which the service leaves absent)",
    );
  }
  assertEquals(s.method, "bolt11");
  assertEquals(typeof s.settled_at, "string");
  assertEquals((s.proof as Record<string, unknown>).payment_hash, "q-1");
});

Deno.test("an awaiting_payment order carries no settlement (nothing to prove yet)", () => {
  const store = new OrderStore();
  store.create("o-2", {  venue_slug: "test-venue", refund_bolt11: TEST_REFUND_BOLT11 }, money);
  const order = store.get("o-2")!;
  const s = (order.payload as Record<string, unknown>).settlement;
  assertEquals(order.state, "awaiting_payment");
  assertEquals(s, undefined);
});

Deno.test("the surfaced proof survives a restart (durable, like the invoice)", async () => {
  const path = await Deno.makeTempFile();
  const a = new OrderStore({ path });
  a.create("o-3", {  venue_slug: "test-venue", refund_bolt11: TEST_REFUND_BOLT11 }, money);
  a.claimSettlement("o-3", { quoteId: "q-3", proofHash: "h-3" }, "paid");
  a.close();
  const b = new OrderStore({ path });
  const order = b.get("o-3")!;
  const s = (order.payload as Record<string, unknown>).settlement as Record<string, unknown>;
  assertEquals(order.state, "paid");
  assertEquals(s.status, "settled");
  assertEquals((s.proof as Record<string, unknown>).payment_hash, "q-3");
  b.close();
});
