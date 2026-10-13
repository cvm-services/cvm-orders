/**
 * ADR-0015: a venue that publishes only dine-in prices must be orderable.
 *
 * The order API accepted only `pickup` and `delivery`, but real venues publish
 * their own set of order methods. chandi-berlin (Berlin-Steglitz, 167 items)
 * prices every item `dine_in` ONLY, so it was served in the menu yet refused by
 * every order attempt with `unsupported_fulfilment` — a venue you could look at
 * but never order from.
 *
 * The contract: any method the venue actually priced in its own catalog is
 * orderable. A method the venue did not price stays refused, with a reason that
 * names it.
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { type Catalog, CatalogRefusal, priceOrder } from "../src/catalog.ts";

const fixture: Catalog = {
  sats_per_eur: 1000,
  option_surcharges_sats: {},
  venues: [
    {
      venue_slug: "dine-in-only",
      name: "Dine In Only",
      items: [
        { sku: "1", name: "Subzi Shorba A, G", prices_by_order_method: { dine_in: 6 }, available: true },
      ],
    },
    {
      venue_slug: "mixed",
      name: "Mixed Methods",
      items: [
        { sku: "2", name: "Curry", prices_by_order_method: { pickup: 10, dine_in: 12 }, available: true },
      ],
    },
  ],
};

Deno.test("ADR-0015: a dine_in-only venue can be ordered from", () => {
  const order = priceOrder(fixture, {
    venue_slug: "dine-in-only",
    fulfilment: "dine_in",
    items: [{ sku: "1", qty: 1 }],
  });
  assertEquals(order.lines[0].sku, "1");
  // 6 EUR at 1000 sats/EUR, plus the 8% facilitator fee.
  assertEquals(order.subtotal, 6000);
  assertEquals(order.fee, 480);
  assertEquals(order.total, 6480);
  assertEquals(order.fulfilment, "dine_in");
});

Deno.test("ADR-0015: a method the venue did not price is still refused, by name", () => {
  const err = assertThrows(
    () =>
      priceOrder(fixture, {
        venue_slug: "dine-in-only",
        // deno-lint-ignore no-explicit-any
        fulfilment: "delivery" as any,
        items: [{ sku: "1", qty: 1 }],
      }),
    CatalogRefusal,
  ) as CatalogRefusal;
  assert(
    err.reason === "unsupported_fulfilment" || err.reason === "unpriced_fulfilment",
    `expected a fulfilled rejection naming the method, got ${err.reason}`,
  );
});

Deno.test("ADR-0015: a genuinely unknown method is refused", () => {
  const err = assertThrows(
    () =>
      priceOrder(fixture, {
        venue_slug: "mixed",
        // deno-lint-ignore no-explicit-any
        fulfilment: "teleport" as any,
        items: [{ sku: "2", qty: 1 }],
      }),
    CatalogRefusal,
  ) as CatalogRefusal;
  assertEquals(err.reason, "unsupported_fulfilment");
});
