import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createRoute, type RouteDeps } from "../main.ts";
import { OrderStore } from "../src/store.ts";
import { ChallengeStore } from "../src/nip98.ts";
import { type Catalog } from "../src/catalog.ts";

/**
 * ADR-0014 — the customer surface returns the venue's OWN order number once a
 * facilitator has recorded it, so the customer holds a handle they can check
 * with the venue. Present iff recorded; absent otherwise. Never invented.
 */

const CATALOG: Catalog = {
  sats_per_eur: 1000,
  option_surcharges_sats: { "Bacon": 150, "Jalapeños": 90, "Extra cheese": 120 },
  venues: [{
    venue_slug: "three-buddies-berlin",
    name: "Three Buddies Steglitz",
    order_url: "https://shop.three-buddies-berlin.example/checkout",
    items: [{
      sku: "1052491",
      name: "Curly Fries",
      prices_by_order_method: { pickup: 4.5, delivery: 4.5 },
      available: true,
    }],
  }],
} as unknown as Catalog;

function deps(): RouteDeps {
  return {
    store: new OrderStore({ path: ":memory:" }),
    challenges: new ChallengeStore(),
    facilitatorPubkey: null,
    catalog: CATALOG,
    rail: null,
    now: () => 1_791_000_000,
  };
}

const createBody = {
  venue_slug: "three-buddies-berlin",
  items: [{ sku: "1052491", qty: 1, options: {} }],
  fulfilment: "pickup",
  inputs: { "contact.name": "p", "contact.phone": "+491700000000" },
};

async function newOrder(d: RouteDeps): Promise<string> {
  const route = createRoute(d);
  const res = await route(new Request("http://x/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createBody),
  }));
  assertEquals(res.status, 201);
  const body = await res.json();
  assertExists(body.id);
  return body.id as string;
}

Deno.test("ADR-0014: an order with no recorded receipt reports venue_reference null", async () => {
  const d = deps();
  const id = await newOrder(d);
  const route = createRoute(d);
  const res = await route(new Request(`http://x/orders/${id}`));
  assertEquals(res.status, 200);
  const order = await res.json();
  assertEquals(order.venue_reference, null);
});

Deno.test("ADR-0014: a recorded venue reference is returned on the customer surface", async () => {
  const d = deps();
  const id = await newOrder(d);
  // The store is the durable home of the receipt, so drive it directly here:
  // the route's own transition path is exercised by the console tests.
  d.store.transition(id, "paid", { from: "awaiting_payment" });
  d.store.transition(id, "placing", { from: "paid" });
  d.store.transition(id, "placed", {
    from: "placing",
    receipt: { venue_reference: "4471", ready_at: "18:25" },
  });

  const route = createRoute(d);
  const res = await route(new Request(`http://x/orders/${id}`));
  assertEquals(res.status, 200);
  const order = await res.json();
  assertEquals(order.venue_reference, "4471");
});

Deno.test("ADR-0014: the reference survives a store reopen (durable, not device-only)", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  try {
    const first = new OrderStore({ path });
    const d: RouteDeps = {
      store: first,
      challenges: new ChallengeStore(),
      facilitatorPubkey: null,
      catalog: CATALOG,
      rail: null,
      now: () => 1_791_000_000,
    };
    const id = await newOrder(d);
    first.transition(id, "paid", { from: "awaiting_payment" });
    first.transition(id, "placing", { from: "paid" });
    first.transition(id, "placed", { from: "placing", receipt: { venue_reference: "A-99" } });
    first.close?.();

    const reopened = new OrderStore({ path });
    const route = createRoute({
      store: reopened,
      challenges: new ChallengeStore(),
      facilitatorPubkey: null,
      catalog: CATALOG,
      rail: null,
      now: () => 1_791_000_000,
    });
    const res = await route(new Request(`http://x/orders/${id}`));
    const order = await res.json();
    assertEquals(order.venue_reference, "A-99");
    reopened.close?.();
  } finally {
    await Deno.remove(path).catch(() => {});
  }
});
