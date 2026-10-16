/**
 * The corners of the HTTP surface that the other suites never touch, plus the two
 * defensive branches of the wiring above them.
 *
 * Why this file exists: G1 raised main.ts's own line-coverage floor to 80% — the
 * card's guard against "the sweep was added, but nothing proves the code around
 * it is even reachable". Each case here is a real answer the shipped client or
 * an operator can provoke: a CORS preflight, a health probe, a malformed body, a
 * credential that is present but bad, an order that was never priced, a mint
 * that fails in each of its two ways, and a poll that loses the
 * compare-and-set to another writer (the sweep) mid-flight.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createRoute, type RouteDeps, startOrderSweeper } from "../main.ts";
import { ChallengeStore } from "../src/nip98.ts";
import { type OrderInvoice, OrderStore } from "../src/store.ts";
import {
  FakeRail,
  type Invoice,
  type InvoiceRequest,
  type PaymentRail,
  RailError,
  RailUnavailableError,
  type SettlementStatus,
} from "../src/rail.ts";
import type { Catalog } from "../src/catalog.ts";
import { TEST_REFUND_BOLT11 } from "./helpers/refund_fixture.ts";

const T0 = 1_800_000_000_000;
const ORIGIN = "https://cvm-pwa.example";

const money = {
  venue_slug: "test-venue",
  refund_bolt11: TEST_REFUND_BOLT11,
  items: [{
    sku: "100",
    name: "Pizza Margherita",
    qty: 1,
    options: ["House"],
    unit_price_sats: 9900,
    line_total_sats: 9900,
  }],
  subtotal: 9900,
  fee: 792,
  total: 10692,
  fulfilment: "pickup" as const,
  inputs: {},
};

const catalog: Catalog = {
  sats_per_eur: 1000,
  option_surcharges_sats: {},
  venues: [{
    venue_slug: "test-venue",
    name: "Test Venue",
    order_url: "https://shop.test-venue.example/checkout",
    items: [{ sku: "100", name: "Pizza Margherita", prices_by_order_method: { pickup: 9.9 }, available: true }],
  }],
};

function app(overrides: Partial<RouteDeps> = {}) {
  const store = new OrderStore();
  const challenges = new ChallengeStore({ ttlSeconds: 300 });
  const deps: RouteDeps = {
    store,
    challenges,
    facilitatorPubkey: null,
    now: () => Math.floor(T0 / 1000),
    rail: new FakeRail({ now: () => T0 }),
    catalog,
    ...overrides,
  };
  return { store, challenges, handle: createRoute(deps) };
}

type Handle = (req: Request) => Promise<Response>;

const get = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}${path}`, { headers });

const post = (path: string, body: string): Request =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

/** An order that has money and an invoice, ready for the settlement poll. */
async function invoiceOrder(store: OrderStore, id: string, expiresAt = T0 + 900_000): Promise<OrderInvoice> {
  store.create(id, { refund_bolt11: TEST_REFUND_BOLT11 }, money);
  const invoice: OrderInvoice = {
    bolt11: `lnbc10692n1${id}`,
    quoteId: `quote-${id}`,
    expiresAt: new Date(expiresAt).toISOString(),
    qr: "data:image/svg+xml;base64,eA==",
  };
  await store.ensureInvoice(id, () => Promise.resolve(invoice));
  return invoice;
}

class FailingRail implements PaymentRail {
  readonly name = "failing";
  constructor(readonly error: Error) {}
  createInvoice(_req: InvoiceRequest): Promise<Invoice> {
    return Promise.reject(this.error);
  }
  checkSettlement(_quoteId: string): Promise<SettlementStatus> {
    return Promise.reject(this.error);
  }
}

/** Commits the transition itself, between the poll's read and its compare-and-set. */
class SneakyRail implements PaymentRail {
  readonly name = "sneaky";
  constructor(readonly store: OrderStore, readonly id: string) {}
  createInvoice(req: InvoiceRequest): Promise<Invoice> {
    return Promise.resolve({ bolt11: `lnbc${req.sats}n1sneaky`, quoteId: "q-sneaky", expiresAt: new Date(T0 + 900_000).toISOString() });
  }
  async checkSettlement(_quoteId: string): Promise<SettlementStatus> {
    this.store.transition(this.id, "paid", { from: "awaiting_payment" });
    return "settled";
  }
}

// --- the surface the client actually speaks to -------------------------------

Deno.test("the CORS preflight the PWA needs is answered", async () => {
  const { handle } = app();
  const res = await handle(new Request(`${ORIGIN}/orders`, { method: "OPTIONS" }));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertEquals(res.headers.get("access-control-allow-methods"), "GET,POST,OPTIONS");
  assert(String(res.headers.get("access-control-allow-headers")).includes("idempotency-key"));
});

Deno.test("health is a public probe", async () => {
  const { handle } = app();
  const res = await handle(get("/health"));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

Deno.test("a malformed order body is a 400, not a 500", async () => {
  const { handle } = app();
  const res = await handle(post("/orders", "{not json"));
  assertEquals(res.status, 400);
  assertEquals((await res.json() as { error: string }).error, "invalid json body");
});

// --- invoices that cannot be issued, for reasons that must be distinguishable -

Deno.test("a credential that is present but invalid is refused before any order is read", async () => {
  const { handle } = app();
  const res = await handle(get("/orders/whatever/invoice", { authorization: "Nostr bm90LWEtc2lnbmVkLWV2ZW50" }));
  assertEquals(res.status, 401);
});

Deno.test("an invoice for an unknown order is a 404", async () => {
  const { handle } = app();
  assertEquals((await handle(get("/orders/nope/invoice"))).status, 404);
});

Deno.test("an order that was never priced has no invoice to show", async () => {
  const { store, handle } = app();
  store.create("o-unpriced", {});
  const res = await handle(get("/orders/o-unpriced/invoice"));
  assertEquals(res.status, 409);
  assertEquals((await res.json() as { reason: string }).reason, "order_not_priced");
});

Deno.test("a rail that fails is 502; a rail that is missing is 503", async () => {
  const failing = app({ rail: new FailingRail(new RailError("mint returned http 500")) });
  failing.store.create("o-r1", { refund_bolt11: TEST_REFUND_BOLT11 }, money);
  const err = await failing.handle(get("/orders/o-r1/invoice"));
  assertEquals(err.status, 502);
  assertEquals((await err.json() as { reason: string }).reason, "rail_error");

  const unavailable = app({ rail: new FailingRail(new RailUnavailableError("no rail today")) });
  unavailable.store.create("o-r2", { refund_bolt11: TEST_REFUND_BOLT11 }, money);
  const down = await unavailable.handle(get("/orders/o-r2/invoice"));
  assertEquals(down.status, 503);
  assertEquals((await down.json() as { reason: string }).reason, "rail_unavailable");
});

// --- the poll that loses the race to another writer --------------------------

Deno.test("a poll that loses the compare-and-set returns the state the winner wrote", async () => {
  const store = new OrderStore();
  const challenges = new ChallengeStore({ ttlSeconds: 300 });
  const handle: Handle = createRoute({
    store,
    challenges,
    facilitatorPubkey: null,
    now: () => Math.floor(T0 / 1000),
    rail: new SneakyRail(store, "o-lost"),
    catalog,
  });
  await invoiceOrder(store, "o-lost");

  const res = await handle(get("/orders/o-lost"));
  assertEquals(res.status, 200);
  assertEquals((await res.json() as { state: string }).state, "paid", "the winner's state, not a second transition");
  assertEquals(store.get("o-lost")?.state, "paid");
});

// --- the wiring's own two branches -------------------------------------------

Deno.test("ORDER_SWEEP_INTERVAL_MS=0 turns the sweep off, loudly", async () => {
  const store = new OrderStore();
  const lines: string[] = [];
  const handle = startOrderSweeper(
    { store, rail: new FakeRail({ now: () => T0 }), log: (line) => lines.push(line) },
    { get: (key: string) => (key === "ORDER_SWEEP_INTERVAL_MS" ? "0" : undefined) },
  );
  assertEquals(handle.active, false);
  assertEquals(handle.intervalMs, 0);
  assertEquals(lines.length, 1);
  assert(lines[0].includes("DISABLED"), `the operator is told: ${JSON.stringify(lines)}`);
  handle.stop();
});
