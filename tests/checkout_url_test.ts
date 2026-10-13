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
import { buildCheckoutVenue, parseCatalog } from "../src/catalog.ts";

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
