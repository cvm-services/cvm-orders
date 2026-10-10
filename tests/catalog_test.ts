/**
 * Server-side pricing. ADR-0008: an order is charged the sum of the venue
 * catalog's own prices for the requested fulfilment method — never a number the
 * client sent. Every client field that looks like a price (`amount`, `name`) is
 * either ignored or used only to *identify* an item whose price then comes from
 * the catalog.
 *
 * The shipped PWA (https://cvm-pwa.orangesync.tech/order/) posts basket lines
 * shaped `{name, qty, amount, options}` — with NO `sku` (read from its app.js
 * `state.basket.push(...)`). So identity may be a sku *or* an exact item name,
 * and both resolve to the same catalog row and the same catalog price.
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { CatalogRefusal, feeSats, loadCatalog, priceOrder } from "../src/catalog.ts";

const fixture = {
  sats_per_eur: 1000,
  option_surcharges_sats: { "Bacon": 150, "Jalapeños": 90, "Extra cheese": 120 },
  venues: [
    {
      venue_slug: "test-venue",
      name: "Test Venue",
      items: [
        {
          sku: "100",
          name: "Pizza Margherita",
          prices_by_order_method: { pickup: 9.9, delivery: 11.5 },
          available: true,
        },
        {
          sku: "101",
          name: "Sold Out Pizza",
          prices_by_order_method: { pickup: 5 },
          available: false,
        },
        { sku: "bbox", name: "Boundary Box", prices_by_order_method: { pickup: 12.499 }, available: true },
        { sku: "latte", name: "Latte", prices_by_order_method: { pickup: 3.2 }, available: true },
      ],
    },
  ],
};

const reason = (fn: () => unknown): string => {
  const error = assertThrows(fn, CatalogRefusal) as CatalogRefusal;
  return error.reason;
};

Deno.test("a client-supplied amount is ignored: the catalog price is the price", () => {
  const honest = priceOrder(fixture, {
    venue_slug: "test-venue",
    fulfilment: "pickup",
    items: [{ sku: "100", qty: 2, amount: 9900, name: "Pizza Margherita", options: "House · Single" }],
  });
  // 9.9 EUR × 1000 sats/EUR × 2 = 19800
  assertEquals(honest.subtotal, 19800);

  // The same basket with a client that claims one sat per pizza.
  const cheap = priceOrder(fixture, {
    venue_slug: "test-venue",
    fulfilment: "pickup",
    items: [{ sku: "100", qty: 2, amount: 1, name: "Pizza Margherita", options: "House · Single" }],
  });
  assertEquals(cheap.subtotal, honest.subtotal, "amount is not an input to the price");
  assertEquals(cheap.total, honest.total);

  // ... and a client that claims an absurdly HIGH amount is not over-charged either.
  const inflated = priceOrder(fixture, {
    venue_slug: "test-venue",
    fulfilment: "pickup",
    items: [{ sku: "100", qty: 1, amount: 999_999, name: "Pizza Margherita" }],
  });
  assertEquals(inflated.subtotal, 9900);
});

Deno.test("an item is identified by sku OR by exact name (the shipped client sends no sku)", () => {
  const byName = priceOrder(fixture, {
    venue_slug: "test-venue",
    fulfilment: "pickup",
    items: [{ name: "Latte", qty: 1, amount: 3.2, options: "Single" }],
  });
  assertEquals(byName.lines[0].sku, "latte");
  assertEquals(byName.lines[0].unit_price_sats, 3200);

  const bySku = priceOrder(fixture, {
    venue_slug: "test-venue",
    fulfilment: "pickup",
    items: [{ sku: "latte", qty: 1 }],
  });
  assertEquals(bySku.lines[0].unit_price_sats, 3200);
  assertEquals(bySku.subtotal, byName.subtotal);
});

Deno.test("the fulfilment method picks the price: delivery costs what delivery costs", () => {
  const delivery = priceOrder(fixture, {
    venue_slug: "test-venue",
    fulfilment: "delivery",
    items: [{ sku: "100", qty: 1 }],
  });
  assertEquals(delivery.subtotal, 11500, "11.5 EUR, not the pickup 9.9");
  assertEquals(delivery.fee, 920);
  assertEquals(delivery.total, 12420);
});

Deno.test("fee is floor(8% of subtotal) in integer sats — boundary pinned", () => {
  // Documented rule: fee = Math.floor(subtotal * 800 / 10000). Never rounds up,
  // so the customer is never charged a fractional-sat rounding artefact.
  assertEquals(feeSats(12), 0, "0.96 sats floors to 0");
  assertEquals(feeSats(13), 1, "1.04 sats floors to 1");
  assertEquals(feeSats(100), 8, "exact");
  assertEquals(feeSats(12499), 999, "999.92 floors to 999");
  assertEquals(feeSats(12500), 1000, "exactly 1000");

  // The same boundary through the whole priced order: 12.499 EUR = 12499 sats.
  const order = priceOrder(fixture, {
    venue_slug: "test-venue",
    fulfilment: "pickup",
    items: [{ sku: "bbox", qty: 1 }],
  });
  assertEquals(order.subtotal, 12499);
  assertEquals(order.fee, 999);
  assertEquals(order.total, 13498);
  assert(Number.isInteger(order.total) && Number.isInteger(order.fee) && Number.isInteger(order.subtotal));
  // One sat lower, the fee is one sat lower too: the table above is not a coincidence.
  assertEquals(feeSats(12499) + 1, feeSats(12499 + 12), "fee is monotone across the boundary");
});

Deno.test("priced option surcharges are added server-side from the catalog, not from the client", () => {
  const plain = priceOrder(fixture, {
    venue_slug: "test-venue",
    fulfilment: "pickup",
    items: [{ name: "Pizza Margherita", qty: 1, options: "House · Single" }],
  });
  // The client's own option string shape: "House · +bacon · Single".
  const bacon = priceOrder(fixture, {
    venue_slug: "test-venue",
    fulfilment: "pickup",
    items: [{ name: "Pizza Margherita", qty: 1, amount: 0.01, options: "House · +bacon · Single" }],
  });
  assertEquals(plain.subtotal, 9900);
  assertEquals(bacon.subtotal, 10050, "9.9 EUR + 0.15 EUR bacon");
  const two = priceOrder(fixture, {
    venue_slug: "test-venue",
    fulfilment: "pickup",
    items: [{ name: "Pizza Margherita", qty: 2, options: "House · +extra cheese · +jalapeños · Single" }],
  });
  assertEquals(two.subtotal, (9900 + 120 + 90) * 2, "surcharges are per unit");

  // An unknown token (sauce/size are free-text in the shipped client) adds nothing.
  const unknown = priceOrder(fixture, {
    venue_slug: "test-venue",
    fulfilment: "pickup",
    items: [{ name: "Pizza Margherita", qty: 1, options: "House · +avocado · Double" }],
  });
  assertEquals(unknown.subtotal, 9900);
});

Deno.test("a basket that cannot be priced is refused with a reason, never guessed at", () => {
  const cases: Array<[string, unknown, string]> = [
    ["missing venue", { fulfilment: "pickup", items: [{ sku: "100", qty: 1 }] }, "unknown_venue"],
    ["unknown venue", { venue_slug: "nope", fulfilment: "pickup", items: [{ sku: "100", qty: 1 }] }, "unknown_venue"],
    ["empty basket", { venue_slug: "test-venue", fulfilment: "pickup", items: [] }, "empty_basket"],
    ["items not an array", { venue_slug: "test-venue", fulfilment: "pickup", items: {} }, "bad_items"],
    ["item not an object", { venue_slug: "test-venue", fulfilment: "pickup", items: ["100"] }, "bad_items"],
    ["no sku and no name", { venue_slug: "test-venue", fulfilment: "pickup", items: [{ qty: 1 }] }, "bad_items"],
    ["unknown sku", { venue_slug: "test-venue", fulfilment: "pickup", items: [{ sku: "zzz", qty: 1 }] }, "unknown_item"],
    ["unknown name", { venue_slug: "test-venue", fulfilment: "pickup", items: [{ name: "Sushi", qty: 1 }] }, "unknown_item"],
    ["unavailable item", { venue_slug: "test-venue", fulfilment: "pickup", items: [{ sku: "101", qty: 1 }] }, "unavailable"],
    ["zero qty", { venue_slug: "test-venue", fulfilment: "pickup", items: [{ sku: "100", qty: 0 }] }, "bad_qty"],
    ["negative qty", { venue_slug: "test-venue", fulfilment: "pickup", items: [{ sku: "100", qty: -3 }] }, "bad_qty"],
    ["fractional qty", { venue_slug: "test-venue", fulfilment: "pickup", items: [{ sku: "100", qty: 1.5 }] }, "bad_qty"],
    ["string qty", { venue_slug: "test-venue", fulfilment: "pickup", items: [{ sku: "100", qty: "2" }] }, "bad_qty"],
    ["absurd qty", { venue_slug: "test-venue", fulfilment: "pickup", items: [{ sku: "100", qty: 10_000 }] }, "bad_qty"],
    [
      "delivery where the venue has no delivery price",
      { venue_slug: "test-venue", fulfilment: "delivery", items: [{ sku: "bbox", qty: 1 }] },
      "unpriced_fulfilment",
    ],
    [
      "unknown fulfilment",
      { venue_slug: "test-venue", fulfilment: "teleport", items: [{ sku: "100", qty: 1 }] },
      "unsupported_fulfilment",
    ],
  ];
  for (const [label, request, expected] of cases) {
    assertEquals(reason(() => priceOrder(fixture, request)), expected, label);
  }
});

Deno.test("the committed catalog is the shipped PWA's own menu, and it prices", async () => {
  const catalog = await loadCatalog();
  const venue = catalog.venues.find((v) => v.venue_slug === "pizza-e-pasta-ruedesheimerplatz");
  assert(venue, "the venue the shipped PWA sends as venue_slug is in the catalog");
  assert(catalog.venues.some((v) => v.venue_slug === "doppelt-kaese-berlin"));

  const order = priceOrder(catalog, {
    venue_slug: "pizza-e-pasta-ruedesheimerplatz",
    fulfilment: "pickup",
    items: [{ name: "Pizza Margherita", qty: 1, amount: 0.01, options: "House · Single" }],
  });
  assertEquals(order.lines[0].sku, "100");
  assertEquals(order.subtotal, 9900);
  assertEquals(order.fee, 792);
  assertEquals(order.total, 10692);
});
