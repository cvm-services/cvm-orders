/**
 * Server-side venue pricing. ADR-0008: the money is recomputed here, from the
 * committed venue catalog, for every order — a client-supplied `amount` is an
 * input to nothing.
 *
 * The shipped PWA (https://cvm-pwa.orangesync.tech/order/) drives this: it reads
 * `/menu.json`, whose items carry `prices_by_order_method.{pickup,delivery}` in
 * EUR, and posts basket lines shaped `{name, qty, amount, options}` — with NO
 * `sku`. So an item may be identified by `sku` *or* by its exact catalog name,
 * and either way the price comes from the catalog row. (The currency rate and
 * the option surcharge table are mirrored from that client only so the customer
 * sees the same number it was shown; they are still server-side numbers.)
 */

export type Fulfilment = "pickup" | "delivery" | "dine_in" | "room_service";

/**
 * Order methods the venue CVMs are known to publish. A venue prices its own
 * items per method, and the set is not ours to choose: chandi-berlin prices
 * every item `dine_in` only, three-buddies prices pickup/delivery/dine_in/
 * room_service, pizza-e-pasta prices pickup only. The order API therefore accepts
 * any method the venue actually priced, and refuses one it did not. Adding a
 * method here is cheap; the real gate is the per-item price lookup below.
 */
export const KNOWN_FULFILMENTS: readonly Fulfilment[] = [
  "pickup",
  "delivery",
  "dine_in",
  "room_service",
];

/** Facilitator fee, in basis points of the subtotal. Operator decision 2026-10-13: 21%. */
export const FEE_BASIS_POINTS = 2100;
/** EUR -> sats, matching the shipped client's own display rate. */
export const DEFAULT_SATS_PER_EUR = 1000;
export const MAX_QTY = 50;
export const MAX_LINES = 50;
export const MAX_OPTIONS = 8;

export interface CatalogItem {
  sku: string;
  name: string;
  /** EUR per fulfilment method, exactly as the venue published it. */
  prices_by_order_method: Record<string, number>;
  available: boolean;
}

export interface Venue {
  venue_slug: string;
  name?: string | null;
  items: CatalogItem[];
  /**
   * The venue's OWN ordering page, when it declares one. This is the hand-off
   * target the facilitator console opens: the basket is entered there, on the
   * facilitator's device, and we never see card data (ADR-0013).
   *
   * `null` (or absent on a hand-built catalog) means the venue declared none —
   * pay at the terminal. It is never invented, and a non-https value is refused
   * at parse time.
   */
  order_url?: string | null;
}

export interface Catalog {
  sats_per_eur: number;
  option_surcharges_sats: Record<string, number>;
  venues: Venue[];
}

/**
 * The venue hand-off shape the facilitator console reads
 * (`order.payload.venue = { slug, rail, checkout_url }`).
 */
export interface CheckoutVenue {
  slug: string;
  /** The venue's own rail, for display. */
  rail: string;
  /** Where the facilitator opens the venue's ordering page. null = none declared. */
  checkout_url: string | null;
  /**
   * Whether we can settle this venue's order in sats at all.
   *
   * The operator rule (2026-10-14): only venues that take payment ONLINE are
   * supportable. A venue whose settlement is a physical terminal needs the card
   * (or cash) at the counter, which our model cannot serve — so it is NOT
   * orderable, and the console must say that plainly instead of offering an
   * order the facilitator would have to abandon.
   *
   * Derived from whether the venue declares an online ordering page; a
   * separately-onboarded venue without one is genuinely unsupportable.
   */
  orderable: boolean;
}

/**
 * A venue's ordering URL, or null. ONLY https is accepted: the console renders
 * this as a link the facilitator clicks, so `javascript:`, `data:` and plain
 * http would be an injection or a downgrade. An unparseable value is treated as
 * absent rather than passed through.
 */
export function normaliseOrderUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Project a catalog venue into the shape the facilitator console reads. */
export function buildCheckoutVenue(venue: Venue): CheckoutVenue {
  const checkout_url = normaliseOrderUrl(venue.order_url);
  return {
    slug: venue.venue_slug,
    // The venue's own rail. "unknown" is honest: we have not verified how the
    // venue settles, and the console displays exactly that.
    rail: "unknown",
    checkout_url,
    // No online checkout => we cannot settle this venue in sats. Not a
    // temporary condition and not something a facilitator can work around.
    orderable: checkout_url !== null,
  };
}

export interface OrderLine {
  sku: string;
  name: string;
  qty: number;
  options: string[];
  unit_price_sats: number;
  line_total_sats: number;
}

export interface PricedOrder {
  venue_slug: string;
  fulfilment: Fulfilment;
  lines: OrderLine[];
  subtotal: number;
  fee: number;
  total: number;
}

export type RefusalReason =
  | "bad_request"
  | "bad_items"
  | "empty_basket"
  | "too_many_lines"
  | "unknown_venue"
  | "unknown_item"
  | "ambiguous_item"
  | "unavailable"
  | "bad_qty"
  | "unsupported_fulfilment"
  | "unpriced_fulfilment"
  | "venue_not_supportable"
  | "catalog_unavailable";

/** Fail closed: a refusal is always a thrown error with a machine-readable reason. */
export class CatalogRefusal extends Error {
  constructor(readonly reason: RefusalReason, message: string) {
    super(message);
    this.name = "CatalogRefusal";
  }
}

/**
 * Facilitator fee, in integer sats.
 *
 * ROUNDING RULE: `floor(subtotal * 21 / 100)`. The fee is never rounded up, so a
 * fractional-sat artefact can never increase what the customer is charged; the
 * fee is always <= 21% of the subtotal. Pinned at the boundary in
 * tests/catalog_test.ts (feeSats(12499) === 2624, feeSats(12500) === 2625).
 */
export function feeSats(subtotal: number): number {
  return Math.floor((subtotal * FEE_BASIS_POINTS) / 10_000);
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Validate a catalog document. A malformed catalog is a service fault, not a request fault. */
export function parseCatalog(raw: unknown): Catalog {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CatalogRefusal("catalog_unavailable", "catalog must be a json object");
  }
  const doc = raw as Record<string, unknown>;
  const rate = doc.sats_per_eur ?? DEFAULT_SATS_PER_EUR;
  if (!isFinitePositiveNumber(rate)) {
    throw new CatalogRefusal("catalog_unavailable", "catalog sats_per_eur must be a positive number");
  }
  if (!Array.isArray(doc.venues) || doc.venues.length === 0) {
    throw new CatalogRefusal("catalog_unavailable", "catalog has no venues");
  }
  const surcharges: Record<string, number> = {};
  const rawSurcharges = doc.option_surcharges_sats;
  if (rawSurcharges !== undefined) {
    if (typeof rawSurcharges !== "object" || rawSurcharges === null || Array.isArray(rawSurcharges)) {
      throw new CatalogRefusal("catalog_unavailable", "option_surcharges_sats must be an object");
    }
    for (const [name, value] of Object.entries(rawSurcharges as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new CatalogRefusal("catalog_unavailable", `option surcharge ${name} must be a number >= 0`);
      }
      surcharges[name] = value;
    }
  }
  const venues: Venue[] = [];
  for (const rawVenue of doc.venues) {
    if (typeof rawVenue !== "object" || rawVenue === null) {
      throw new CatalogRefusal("catalog_unavailable", "venue must be an object");
    }
    const v = rawVenue as Record<string, unknown>;
    if (typeof v.venue_slug !== "string" || !v.venue_slug.trim()) {
      throw new CatalogRefusal("catalog_unavailable", "venue_slug is required");
    }
    if (!Array.isArray(v.items) || v.items.length === 0) {
      throw new CatalogRefusal("catalog_unavailable", `venue ${v.venue_slug} has no items`);
    }
    const items: CatalogItem[] = [];
    for (const rawItem of v.items) {
      if (typeof rawItem !== "object" || rawItem === null) {
        throw new CatalogRefusal("catalog_unavailable", "item must be an object");
      }
      const i = rawItem as Record<string, unknown>;
      if (typeof i.sku !== "string" || !i.sku.trim()) {
        throw new CatalogRefusal("catalog_unavailable", "item sku is required");
      }
      if (typeof i.name !== "string" || !i.name.trim()) {
        throw new CatalogRefusal("catalog_unavailable", `item ${i.sku} has no name`);
      }
      const prices: Record<string, number> = {};
      const rawPrices = i.prices_by_order_method ?? {};
      if (typeof rawPrices !== "object" || rawPrices === null || Array.isArray(rawPrices)) {
        throw new CatalogRefusal("catalog_unavailable", `item ${i.sku} prices must be an object`);
      }
      for (const [method, value] of Object.entries(rawPrices as Record<string, unknown>)) {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
          throw new CatalogRefusal("catalog_unavailable", `item ${i.sku} price ${method} must be > 0`);
        }
        prices[method] = value;
      }
      items.push({
        sku: i.sku.trim(),
        name: i.name,
        prices_by_order_method: prices,
        available: i.available !== false,
      });
    }
    venues.push({
      venue_slug: v.venue_slug.trim(),
      name: typeof v.name === "string" ? v.name : null,
      items,
      order_url: normaliseOrderUrl(v.order_url),
    });
  }
  return { sats_per_eur: rate, option_surcharges_sats: surcharges, venues };
}

/** The committed copy of the shipped PWA's own menu.json. */
export async function loadCatalog(
  path = new URL("../config/venues.json", import.meta.url).pathname,
): Promise<Catalog> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    throw new CatalogRefusal("catalog_unavailable", `catalog unreadable: ${String((e as Error)?.name ?? e)}`);
  }
  try {
    return parseCatalog(JSON.parse(text));
  } catch (e) {
    if (e instanceof CatalogRefusal) throw e;
    throw new CatalogRefusal("catalog_unavailable", "catalog is not valid json");
  }
}

/** Normalize one option token: `"+Extra Cheese"` and `"extra cheese"` are the same option. */
const normalizeOption = (token: string): string => token.trim().replace(/^\+\s*/, "").toLowerCase();

function optionsOf(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  const tokens = Array.isArray(value)
    ? value.map((t) => String(t))
    : String(value).split(/[·,]|\s\+\s/);
  const out = tokens.map((t) => t.trim()).filter((t) => t !== "");
  if (out.length > MAX_OPTIONS) {
    throw new CatalogRefusal("bad_items", `too many options on one line (max ${MAX_OPTIONS})`);
  }
  return out;
}

/**
 * Resolve a basket line to a catalog item.
 *
 * `sku` wins when present. Falling back to an exact name match is what makes the
 * shipped client work; a name that is ambiguous across items whose prices differ
 * is REFUSED rather than guessed, because guessing is how a cheap item's price
 * gets attached to an expensive item.
 */
function resolveItem(
  venue: Venue,
  requestedSku: unknown,
  requestedName: unknown,
  method: Fulfilment,
): CatalogItem {
  if (typeof requestedSku === "string" && requestedSku.trim()) {
    const sku = requestedSku.trim();
    const item = venue.items.find((i) => i.sku === sku);
    if (!item) throw new CatalogRefusal("unknown_item", `unknown sku ${sku} at ${venue.venue_slug}`);
    return item;
  }
  if (typeof requestedName === "string" && requestedName.trim()) {
    const name = requestedName.trim();
    const matches = venue.items.filter((i) => i.name.trim() === name);
    if (matches.length === 0) {
      throw new CatalogRefusal("unknown_item", `unknown item ${JSON.stringify(name)} at ${venue.venue_slug}`);
    }
    if (matches.length > 1) {
      const prices = new Set(matches.map((i) => i.prices_by_order_method[method]));
      if (prices.size > 1) {
        throw new CatalogRefusal(
          "ambiguous_item",
          `${matches.length} items named ${JSON.stringify(name)} price ${method} differently; send an explicit sku`,
        );
      }
      return matches[0];
    }
    return matches[0];
  }
  throw new CatalogRefusal("bad_items", "each item needs a sku or a catalog name");
}

/**
 * Price a whole basket from the catalog. Throws `CatalogRefusal` with a reason
 * for anything it cannot price exactly, and never falls back to a client number.
 */
export function priceOrder(catalog: Catalog, request: unknown): PricedOrder {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new CatalogRefusal("bad_request", "order body must be a json object");
  }
  const body = request as Record<string, unknown>;

  const venueSlug = typeof body.venue_slug === "string" ? body.venue_slug.trim() : "";
  const venue = catalog.venues.find((v) => v.venue_slug === venueSlug);
  if (!venue) {
    throw new CatalogRefusal(
      "unknown_venue",
      `unknown venue ${JSON.stringify(venueSlug || String(body.venue_slug ?? ""))}`,
    );
  }

  // Supportability gate (operator rule 2026-10-14): only venues that take
  // payment ONLINE are supportable, because our sats flow cannot pay at a
  // physical terminal. Accepting an order we can never finish would trap the
  // customer's sats — so this refuses BEFORE an order exists to pay into, at
  // the same place every other pricing refusal happens.
  if (!buildCheckoutVenue(venue).orderable) {
    throw new CatalogRefusal(
      "venue_not_supportable",
      `venue ${JSON.stringify(venueSlug)} has no online checkout: its orders cannot be settled in sats, so orders are refused (an adapter would be needed first)`,
    );
  }

  const rawFulfilment = body.fulfilment;
  // Accept any method we know a venue to publish; the per-item price lookup below
  // is what actually decides. A venue that priced only `dine_in` (chandi-berlin)
  // used to be refused here outright and could never be ordered from.
  if (
    typeof rawFulfilment !== "string" ||
    !KNOWN_FULFILMENTS.includes(rawFulfilment as Fulfilment)
  ) {
    throw new CatalogRefusal(
      "unsupported_fulfilment",
      `fulfilment must be one of ${KNOWN_FULFILMENTS.join(", ")}`,
    );
  }
  const fulfilment = rawFulfilment as Fulfilment;

  if (!Array.isArray(body.items)) {
    throw new CatalogRefusal("bad_items", "items must be an array");
  }
  if (body.items.length === 0) throw new CatalogRefusal("empty_basket", "the basket is empty");
  if (body.items.length > MAX_LINES) {
    throw new CatalogRefusal("too_many_lines", `at most ${MAX_LINES} lines per order`);
  }

  const lines: OrderLine[] = [];
  for (const rawItem of body.items) {
    if (typeof rawItem !== "object" || rawItem === null || Array.isArray(rawItem)) {
      throw new CatalogRefusal("bad_items", "each item must be an object");
    }
    const line = rawItem as Record<string, unknown>;
    const qty = line.qty;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      throw new CatalogRefusal("bad_qty", `qty must be an integer between 1 and ${MAX_QTY}, got ${JSON.stringify(qty)}`);
    }

    const item = resolveItem(venue, line.sku, line.name, fulfilment);
    if (!item.available) {
      throw new CatalogRefusal("unavailable", `${item.name} is not available at ${venue.venue_slug}`);
    }
    const eur = item.prices_by_order_method[fulfilment];
    if (!isFinitePositiveNumber(eur)) {
      throw new CatalogRefusal(
        "unpriced_fulfilment",
        `${item.name} has no ${fulfilment} price at ${venue.venue_slug}`,
      );
    }
    const unit = Math.round(eur * catalog.sats_per_eur);
    if (!Number.isInteger(unit) || unit < 1) {
      throw new CatalogRefusal("unpriced_fulfilment", `${item.name} prices below one sat`);
    }

    // `amount` from the client is deliberately not read anywhere in this file.
    const options = optionsOf(line.options);
    let surcharge = 0;
    for (const token of options) {
      const known = Object.keys(catalog.option_surcharges_sats).find((k) => normalizeOption(k) === normalizeOption(token));
      if (known) surcharge += catalog.option_surcharges_sats[known];
    }

    lines.push({
      sku: item.sku,
      name: item.name,
      qty,
      options,
      unit_price_sats: unit,
      line_total_sats: (unit + surcharge) * qty,
    });
  }

  const subtotal = lines.reduce((n, l) => n + l.line_total_sats, 0);
  const fee = feeSats(subtotal);
  return {
    venue_slug: venue.venue_slug,
    fulfilment,
    lines,
    subtotal,
    fee,
    total: subtotal + fee,
  };
}
