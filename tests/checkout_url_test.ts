/**
 * CONTRACT TEST — the facilitator console must receive a venue hand-off URL.
 *
 * Why: the console reads `order.payload.venue.checkout_url` (site/console/app.js
 * `custodyPlan`) and, when absent, tells the facilitator "no venue checkout URL
 * declared". Nothing in the service ever WROTE that field, so every order showed
 * the dead-end message and the facilitator had no link to the venue's own
 * ordering page — even though our venue records already carry one
 * (`venue.ordering.urls.platform_shop`).
 *
 * This test pins BOTH halves:
 *   1. the catalog carries the venue's ordering URL, and
 *   2. POST /orders puts it at `payload.venue.checkout_url` for the console.
 *
 * It also pins the honest fallback: a venue that declares NO ordering URL must
 * produce no URL at all — never a guessed or invented one.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildCheckoutVenue, parseCatalog, priceOrder, CatalogRefusal } from "../src/catalog.ts";

const CATALOG = {
  sats_per_eur: 1000,
  option_surcharges_sats: {},
  venues: [
    {
      venue_slug: "three-buddies-berlin",
      name: "Three Buddies",
      // The venue's own ordering shop, as captured from its record.
      order_url: "https://threebuddies.online-karte.com/threebuddies",
      items: [{ sku: "1", name: "Capri Sun Kirsche 0,2l", prices_by_order_method: { pickup: 1.62 }, available: true }],
    },
    {
      venue_slug: "mystery-kiosk",
      name: "Mystery Kiosk",
      // No ordering page declared — the fallback must stay honest.
      order_url: null,
      items: [{ sku: "1", name: "Water", prices_by_order_method: { pickup: 1.0 }, available: true }],
    },
  ],
};

Deno.test("the catalog carries each venue's ordering URL", () => {
  const catalog = parseCatalog(CATALOG);
  const three = catalog.venues.find((v) => v.venue_slug === "three-buddies-berlin")!;
  assertEquals(three.order_url, "https://threebuddies.online-karte.com/threebuddies");
  const kiosk = catalog.venues.find((v) => v.venue_slug === "mystery-kiosk")!;
  assertEquals(kiosk.order_url, null);
});

Deno.test("buildCheckoutVenue puts the URL where the console reads it", () => {
  const catalog = parseCatalog(CATALOG);
  const three = catalog.venues.find((v) => v.venue_slug === "three-buddies-berlin")!;
  const venue = buildCheckoutVenue(three);
  assertEquals(venue.checkout_url, "https://threebuddies.online-karte.com/threebuddies");
  assertEquals(venue.slug, "three-buddies-berlin");
});

Deno.test("a venue with no ordering URL produces NO checkout_url (never invented)", () => {
  const catalog = parseCatalog(CATALOG);
  const kiosk = catalog.venues.find((v) => v.venue_slug === "mystery-kiosk")!;
  const venue = buildCheckoutVenue(kiosk);
  assertEquals(venue.checkout_url, null, "must be null, not a guess");
  // The console treats a falsy url as 'no venue checkout URL declared' — correct.
  assert(!venue.checkout_url);
});

Deno.test("priceOrder REFUSES a known venue we cannot settle (money risk)", () => {
  // The operator rule (2026-10-14): only venues that take payment ONLINE are
  // supportable. If POST /orders still accepted an unsupportable venue, the
  // customer could pay sats for an order no facilitator can ever finish — real
  // money stuck. So the refusal must happen at PRICING time, before any order
  // exists to pay into.
  const catalog = parseCatalog(CATALOG);
  const kiosk = catalog.venues.find((v) => v.venue_slug === "mystery-kiosk")!;
  let refused: CatalogRefusal | null = null;
  try {
    priceOrder(catalog, {
      venue_slug: kiosk.venue_slug,
      items: [{ sku: "snack", qty: 1 }],
      fulfilment: "pickup",
      inputs: {},
    });
  } catch (e) {
    refused = e instanceof CatalogRefusal ? e : null;
  }
  assertEquals(refused !== null, true, "an unsupportable venue must be refused");
  assertEquals(refused!.reason, "venue_not_supportable");
  assertEquals(
    refused!.message.includes("online checkout"),
    true,
    `the refusal must say WHY: ${refused!.message}`,
  );
});

Deno.test("priceOrder accepts a supportable venue (online checkout declared)", () => {
  const catalog = parseCatalog(CATALOG);
  const three = catalog.venues.find((v) => v.venue_slug === "three-buddies-berlin")!;
  // The pricing itself is covered elsewhere; here only that the supportability
  // gate does not fire.
  let refused: CatalogRefusal | null = null;
  try {
    priceOrder(catalog, {
      venue_slug: three.venue_slug,
      items: [{ sku: "1", qty: 1 }],
      fulfilment: "pickup",
      inputs: {},
    });
  } catch (e) {
    refused = e instanceof CatalogRefusal ? e : null;
  }
  assertEquals(refused?.reason ?? null, null);
});

Deno.test("a venue with no online checkout is NOT orderable (not a mere missing URL)", () => {
  // The operator rule: we can only support venues that take payment ONLINE.
  // A venue whose only settlement is a physical terminal is not supportable —
  // the console must say that, not offer an order the facilitator abandons.
  const catalog = parseCatalog(CATALOG);
  const kiosk = catalog.venues.find((v) => v.venue_slug === "mystery-kiosk")!;
  const venue = buildCheckoutVenue(kiosk);
  assertEquals(venue.orderable, false);
  assertEquals(venue.checkout_url, null);
});

Deno.test("a venue WITH an online ordering shop is orderable", () => {
  const catalog = parseCatalog(CATALOG);
  const three = catalog.venues.find((v) => v.venue_slug === "three-buddies-berlin")!;
  const venue = buildCheckoutVenue(three);
  assertEquals(venue.orderable, true);
});

Deno.test("buildCheckoutVenue refuses a non-https ordering URL (no javascript:/http: link)", () => {
  const bad = parseCatalog({
    ...CATALOG,
    venues: [{
      ...CATALOG.venues[0],
      order_url: "javascript:alert(1)",
    }],
  }).venues[0];
  // A hostile or broken URL must not reach the facilitator's browser as a link.
  assertEquals(buildCheckoutVenue(bad).checkout_url, null);
});
