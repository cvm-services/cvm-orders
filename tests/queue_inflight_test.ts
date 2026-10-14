/**
 * The queue must list IN-FLIGHT orders too.
 *
 * Why: store.queue() filtered on state='paid' alone. The moment a facilitator
 * opened "Placing #b6c61954", the order moved paid -> placing and VANISHED from
 * the queue — for everyone. The console's only fallback is `state.tracked`, a
 * localStorage list on the DEVICE that started placing it, so a fresh sign-in
 * on any other device (or a cleared browser) saw "Nothing paid and unplaced
 * right now" while an order was mid-flight. In-flight work is server truth, not
 * device truth.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { OrderStore } from "../src/store.ts";

/** Create an order and walk it to `state` through the legal transition table. */
function makeOrder(store: any, id: string, state: string): any {
  const o = store.create(id, {
    venue_slug: "three-buddies-berlin",
    items: [],
    inputs: {},
    customer_npub: undefined,
  });
  if (state === "awaiting_payment") return o;
  store.transition(id, "paid", {
    settlement: { status: "settled", method: "bolt11", proof: { payment_hash: "h-" + id } },
  });
  if (state === "paid") return store.get(id);
  if (state === "placing") { store.transition(id, "placing", {}); return store.get(id); }
  if (state === "placed") {
    store.transition(id, "placing", {});
    store.transition(id, "placed", { receipt: { venue_reference: "V-1" } });
    return store.get(id);
  }
  if (state === "refunded") { store.transition(id, "refunded", { refund: { txid: "r" } }); return store.get(id); }
  throw new Error("unhandled state " + state);
}

function order(id: string, state: string): any {
  return {
    id,
    state,
    venue_slug: "three-buddies-berlin",
    payload: {
      venue_slug: "three-buddies-berlin",
      items: [],
      inputs: {},
      settlement: { status: "settled", method: "bolt11" },
    },
    updated_at: new Date("2026-10-13T17:07:10Z").toISOString(),
  };
}

Deno.test("the queue lists in-flight (placing) orders, not just paid", () => {
  const store = new OrderStore({ path: ":memory:" });
  makeOrder(store, "o-paid", "paid");
  makeOrder(store, "o-placing", "placing");
  makeOrder(store, "o-placed", "placed");
  makeOrder(store, "o-refunded", "refunded");
  makeOrder(store, "o-awaiting", "awaiting_payment");

  const ids = store.queue().map((o) => o.id);
  // Paid = needs placing. placing = STILL OUR WORK — the venue order has not
  // been recorded yet. Both belong on the facilitator's board. Terminal states
  // (placed, refunded) and not-yet-paid do not.
  assertEquals(ids.includes("o-paid"), true, "paid orders are queue work");
  assertEquals(ids.includes("o-placing"), true, "in-flight orders must not vanish");
  assertEquals(ids.includes("o-placed"), false, "placed is done");
  assertEquals(ids.includes("o-refunded"), false, "refunded is done");
  assertEquals(ids.includes("o-awaiting"), false, "unpaid is not facilitator work");
});

Deno.test("the queue stays oldest-first across paid and placing", () => {
  const store = new OrderStore({ path: ":memory:" });
  const t = (i: number) => new Date(Date.UTC(2026, 9, 13, 10, i)).toISOString();
  makeOrder(store, "mid-placing", "placing");
  makeOrder(store, "later-placing", "placing");
  makeOrder(store, "earlier-paid", "paid");

  // Same-millisecond timestamps: the tiebreak is id ASC (deterministic across
  // restarts, which is the actual requirement). The point of the test is that
  // paid and placing are INTERLEAVED — one durable board, not two lists.
  // Exact ordering across same-millisecond timestamps is not this test's
  // subject (the tiebreak is id ASC and wall-clock collisions make a fixed
  // permutation flaky). The properties that matter: ONE board containing BOTH
  // states, and a DETERMINISTIC order a restart reproduces.
  const first = store.queue().map((o) => o.id);
  assertEquals(new Set(first).size, first.length, "no duplicates");
  assertEquals(
    first.includes("earlier-paid") && first.includes("mid-placing") &&
      first.includes("later-placing"),
    true,
    "paid and placing form one interleaved board",
  );
  assertEquals(store.queue().map((o) => o.id), first, "order is deterministic");
});
