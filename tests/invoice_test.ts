/**
 * The customer-facing order/invoice surface the shipped PWA drives:
 *
 *   POST /orders                  {venue_slug, items, fulfilment, inputs}
 *   GET  /orders/:id/invoice      -> {bolt11, qr}   (client throws without both)
 *   GET  /orders/:id              -> polled status
 *
 * and the money rule that ADR-0008 makes binding: `paid` is reachable ONLY via a
 * rail-verified settlement. No request body, and no credential, can post its way
 * into `paid`.
 *
 * The request shapes here are copied from the shipped client's own app.js
 * (https://cvm-pwa.orangesync.tech/order/app.js): basket lines are
 * `{name, qty, amount, options}` — no `sku` — `options` is a display string like
 * `"House · +bacon · Single"`, and `amount` is the client's own arithmetic.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createRoute, type RouteDeps } from "../main.ts";
import { ChallengeStore } from "../src/nip98.ts";
import { OrderStore } from "../src/store.ts";
import type { Catalog } from "../src/catalog.ts";
import { loadCatalog } from "../src/catalog.ts";
import {
  FakeRail,
  type Invoice,
  type InvoiceRequest,
  type PaymentRail,
  type SettlementStatus,
} from "../src/rail.ts";
import { authHeader, challengeBoundEvent, facilitatorPubkey } from "./signing.ts";

const T0 = 1_800_000_000;
const ORIGIN = "https://cvm-pwa.example";
const CHALLENGE_URL = `${ORIGIN}/api/auth/challenge`;

const catalog: Catalog = {
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
        { sku: "101", name: "Sold Out Pizza", prices_by_order_method: { pickup: 5 }, available: false },
      ],
    },
  ],
};

/** Counts rail traffic, so "created once" and "checked once" are observable. */
class CountingRail implements PaymentRail {
  readonly name = "counting";
  creates = 0;
  checks = 0;
  constructor(readonly inner: FakeRail) {}
  createInvoice(req: InvoiceRequest): Promise<Invoice> {
    this.creates++;
    return this.inner.createInvoice(req);
  }
  checkSettlement(quoteId: string): Promise<SettlementStatus> {
    this.checks++;
    return this.inner.checkSettlement(quoteId);
  }
}

function app(overrides: Partial<RouteDeps> = {}) {
  const store = new OrderStore();
  const challenges = new ChallengeStore({ ttlSeconds: 300 });
  const rail = new CountingRail(new FakeRail({ now: () => T0 * 1000 }));
  const deps: RouteDeps = {
    store,
    challenges,
    facilitatorPubkey,
    now: () => T0,
    rail,
    catalog,
    ...overrides,
  };
  return { store, challenges, rail, handle: createRoute(deps) };
}

type Handle = (req: Request) => Promise<Response>;

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const get = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}${path}`, { headers });

/** Exactly what the shipped PWA sends for one Pizza Margherita, pickup. */
const pwaRequest = (extra: Record<string, unknown> = {}) => ({
  venue_slug: "test-venue",
  items: [{ name: "Pizza Margherita", qty: 1, amount: 9.9, options: "House · Single" }],
  fulfilment: "pickup",
  inputs: { "contact.phone": "+4915112345678", "contact.name": "Ada" },
  ...extra,
});

async function signIn(challenges: ChallengeStore, handle: Handle): Promise<string> {
  const res = await handle(get("/auth/challenge"));
  const challenge = await res.json() as { nonce: string };
  return authHeader(challengeBoundEvent(challenge.nonce, CHALLENGE_URL, { created_at: T0 }));
}

const createOrder = async (handle: Handle, body: unknown, headers: Record<string, string> = {}) => {
  const res = await handle(post("/orders", body, headers));
  return { res, body: await res.clone().json() as Record<string, unknown> };
};

Deno.test("a fresh order is awaiting_payment — never paid — and stays out of the paid queue", async () => {
  const { store, challenges, handle } = app();
  const { res, body } = await createOrder(handle, pwaRequest());
  assertEquals(res.status, 201);
  assertEquals(body.state, "awaiting_payment");
  assertEquals(body.subtotal, 9900);
  assertEquals(body.fee, 792);
  assertEquals(body.total, 10692);
  assertEquals(body.expires_at, null, "no invoice yet, so no expiry to claim");
  assert(typeof body.id === "string" && body.id.length >= 16);

  const id = body.id as string;
  assertEquals(store.get(id)?.state, "awaiting_payment");
  assertEquals(store.queue(), [], "an unpaid order is not work for the facilitator");

  const header = await signIn(challenges, handle);
  const queue = await handle(get("/orders/queue", { authorization: header }));
  assertEquals(queue.status, 200);
  assertEquals((await queue.json() as { orders: unknown[] }).orders, []);
});

Deno.test("POST /orders ignores the client's amount in both directions", async () => {
  const { handle } = app();
  const cheap = await createOrder(handle, {
    venue_slug: "test-venue",
    items: [{ name: "Pizza Margherita", qty: 1, amount: 1, options: "House · Single" }],
    fulfilment: "pickup",
    inputs: {},
  });
  assertEquals(cheap.body.total, 10692, "1 sat for a 9.9 EUR pizza buys the same pizza at the same price");

  const inflated = await createOrder(handle, {
    venue_slug: "test-venue",
    items: [{ name: "Pizza Margherita", qty: 1, amount: 99_999_999, options: "House · Single" }],
    fulfilment: "pickup",
    inputs: {},
  });
  assertEquals(inflated.body.total, 10692);
});

Deno.test("an unpriceable basket is 400 with a reason and creates no order", async () => {
  const { store, handle } = app();
  const cases: Array<[string, unknown, string]> = [
    ["unknown venue", pwaRequest({ venue_slug: "nope" }), "unknown_venue"],
    ["unknown item", pwaRequest({ items: [{ name: "Sushi", qty: 1 }] }), "unknown_item"],
    ["empty basket", pwaRequest({ items: [] }), "empty_basket"],
    ["bad qty", pwaRequest({ items: [{ name: "Pizza Margherita", qty: 0 }] }), "bad_qty"],
    ["sold out", pwaRequest({ items: [{ name: "Sold Out Pizza", qty: 1 }] }), "unavailable"],
  ];
  for (const [label, body, expected] of cases) {
    const { res, body: json } = await createOrder(handle, body);
    assertEquals(res.status, 400, label);
    assertEquals(json.reason, expected, label);
  }
  assertEquals(store.all(), [], "a refused order is not persisted at all");
});

Deno.test("CARD CUSTODY: card material in an order request is 422 and creates nothing (ADR-0013)", async () => {
  const { store, handle } = app();
  const cited = await createOrder(handle, pwaRequest({ inputs: { "order.notes": "card 4111 1111 1111 1111" } }));
  assertEquals(cited.res.status, 422);
  const fielded = await createOrder(handle, pwaRequest({ inputs: { cvv: "123" } }));
  assertEquals(fielded.res.status, 422);
  assertEquals(store.all(), []);
});

Deno.test("an Idempotency-Key replay returns the same order, not a second one", async () => {
  const { store, handle } = app();
  const key = { "idempotency-key": "retry-abc-1" };
  const first = await createOrder(handle, pwaRequest(), key);
  const second = await createOrder(handle, pwaRequest(), key);
  assertEquals(second.body.id, first.body.id);
  assertEquals(second.body.total, first.body.total);
  assert(second.res.status < 300);
  assertEquals(store.all().length, 1, "the client's retry did not double-charge");

  const other = await createOrder(handle, pwaRequest(), { "idempotency-key": "retry-abc-2" });
  assert(other.body.id !== first.body.id, "a different key is a different order");
  assertEquals(store.all().length, 2);
});

Deno.test("the invoice endpoint returns bolt11 + a self-contained qr, and creates the invoice once", async () => {
  const { store, rail, handle } = app();
  const { body } = await createOrder(handle, pwaRequest());
  const id = body.id as string;

  const res = await handle(get(`/orders/${id}/invoice`));
  assertEquals(res.status, 200);
  const invoice = await res.json() as Record<string, unknown>;
  assert(typeof invoice.bolt11 === "string" && invoice.bolt11.length > 0, "bolt11 is a non-empty string");
  assert(
    typeof invoice.qr === "string" && invoice.qr.startsWith("data:image/svg+xml;base64,"),
    `qr must be a self-contained image URL, got ${String(invoice.qr).slice(0, 40)}`,
  );
  assertEquals(invoice.total, 10692);
  assert(typeof invoice.expires_at === "string" && !Number.isNaN(Date.parse(invoice.expires_at as string)));
  assertEquals(rail.creates, 1);

  // Repeat: same bolt11, still one invoice.
  const again = await handle(get(`/orders/${id}/invoice`));
  const repeated = await again.json() as Record<string, unknown>;
  assertEquals(repeated.bolt11, invoice.bolt11, "a repeat call returns the same invoice");
  assertEquals(repeated.qr, invoice.qr);
  assertEquals(rail.creates, 1);

  // Concurrent callers (a client that retried while the first was in flight).
  const raced = await Promise.all([
    handle(get(`/orders/${id}/invoice`)),
    handle(get(`/orders/${id}/invoice`)),
    handle(get(`/orders/${id}/invoice`)),
  ]);
  for (const r of raced) assertEquals((await r.json() as { bolt11: string }).bolt11, invoice.bolt11);
  assertEquals(rail.creates, 1, "one order, one invoice");

  // Cached on the order itself, so a restart of the request path cannot re-quote.
  assertEquals(store.get(id)?.invoice?.bolt11, invoice.bolt11);
});

Deno.test("no rail configured is a 503 with a machine-readable body, never a bogus invoice", async () => {
  const { handle } = app({ rail: null });
  const { body } = await createOrder(handle, pwaRequest());
  const res = await handle(get(`/orders/${body.id}/invoice`));
  assertEquals(res.status, 503);
  const err = await res.json() as Record<string, unknown>;
  assertEquals(err.reason, "rail_unavailable");
  assertEquals(err.bolt11, undefined, "there is no invoice to show");
  assert(typeof err.error === "string" && err.error.length > 0);
});

Deno.test("a settled invoice moves the order to paid exactly once", async () => {
  const { store, rail, handle } = app();
  const { body } = await createOrder(handle, pwaRequest());
  const id = body.id as string;
  await handle(get(`/orders/${id}/invoice`));
  const quoteId = store.get(id)!.invoice!.quoteId;

  assertEquals((await (await handle(get(`/orders/${id}`))).json() as { state: string }).state, "awaiting_payment");

  rail.inner.setStatus(quoteId, "settled");
  const first = await handle(get(`/orders/${id}`));
  assertEquals(first.status, 200);
  const paid = await first.json() as { state: string; total: number };
  assertEquals(paid.state, "paid");
  assertEquals(paid.total, 10692);
  const checksAfterFirst = rail.checks;

  // The second poll must not re-transition (and must not even ask again).
  const second = await (await handle(get(`/orders/${id}`))).json() as { state: string };
  assertEquals(second.state, "paid");
  assertEquals(store.get(id)?.state, "paid");
  assertEquals(rail.checks, checksAfterFirst, "a paid order is not re-checked");

  // Paid is now the facilitator's queue: the invoice really did its job.
  assertEquals(store.queue().map((o) => o.id), [id]);
});

Deno.test("an expired quote expires the order and can never pay it", async () => {
  const { store, rail, handle } = app();
  const { body } = await createOrder(handle, pwaRequest());
  const id = body.id as string;
  await handle(get(`/orders/${id}/invoice`));
  const quoteId = store.get(id)!.invoice!.quoteId;

  rail.inner.setStatus(quoteId, "expired");
  const res = await handle(get(`/orders/${id}`));
  assertEquals(res.status, 200);
  assertEquals((await res.json() as { state: string }).state, "expired");
  assertEquals(store.queue(), [], "an expired order is not work");
  assertEquals((await handle(get(`/orders/${id}/invoice`))).status, 410, "no invoice for an expired order");

  // Even if the mint later reports the quote settled, `expired` is terminal.
  rail.inner.setStatus(quoteId, "settled");
  assertEquals((await (await handle(get(`/orders/${id}`))).json() as { state: string }).state, "expired");
  assertEquals(store.get(id)?.state, "expired");
});

Deno.test("no caller can post their way into paid", async () => {
  const { store, challenges, handle } = app();
  const { body } = await createOrder(handle, pwaRequest());
  const id = body.id as string;

  // Anonymous, and a credential that only looks like one.
  assertEquals((await handle(post(`/orders/${id}/transition`, { state: "paid" }))).status, 401);
  assertEquals(
    (await handle(post(`/orders/${id}/transition`, { state: "paid" }, { authorization: `Nostr ${btoa("{}")}` })))
      .status,
    401,
  );
  assertEquals(store.get(id)?.state, "awaiting_payment");

  // The facilitator's own credential, with no rail settlement to point at.
  const header = await signIn(challenges, handle);
  const forged = await handle(post(`/orders/${id}/transition`, { state: "paid" }, { authorization: header }));
  assertEquals(forged.status, 402, "refused: payment required");
  const err = await forged.json() as Record<string, unknown>;
  assertEquals(err.reason, "settlement_not_verified");
  assertEquals(store.get(id)?.state, "awaiting_payment", "the gate held");
  assertEquals(store.queue(), []);
});

Deno.test("the facilitator's rail-verified transition to paid is allowed, and only then", async () => {
  const { store, rail, challenges, handle } = app();
  const { body } = await createOrder(handle, pwaRequest());
  const id = body.id as string;
  const header = await signIn(challenges, handle);

  const refused = await handle(post(`/orders/${id}/transition`, { state: "paid" }, { authorization: header }));
  assertEquals(refused.status, 402);
  assertEquals(store.get(id)?.state, "awaiting_payment");

  await handle(get(`/orders/${id}/invoice`));
  rail.inner.setStatus(store.get(id)!.invoice!.quoteId, "settled");

  const allowed = await handle(post(
    `/orders/${id}/transition`,
    { state: "paid", from: "awaiting_payment" },
    { authorization: header },
  ));
  assertEquals(allowed.status, 200);
  assertEquals((await allowed.json() as { state: string }).state, "paid");
  assertEquals(store.get(id)?.state, "paid");
});

Deno.test("the shipped PWA's exact request works against the real committed catalog", async () => {
  const real = await loadCatalog();
  const { store, rail, handle } = app({ catalog: real });

  // Copied from app.js: no sku, EUR amount, `·`-separated options string.
  const { res, body } = await createOrder(handle, {
    venue_slug: "pizza-e-pasta-ruedesheimerplatz",
    items: [{ name: "Pizza Margherita", qty: 1, amount: 9.9, options: "House · Single" }],
    fulfilment: "pickup",
    inputs: { "contact.phone": "+4915112345678" },
  });
  assertEquals(res.status, 201, "the Pay button's POST is accepted");
  assertEquals(body.total, 10692);

  const invoice = await (await handle(get(`/orders/${body.id as string}/invoice`))).json() as Record<string, unknown>;
  assert(typeof invoice.bolt11 === "string" && invoice.bolt11.length > 0);
  assert(String(invoice.qr).startsWith("data:image/svg+xml;base64,"));

  rail.inner.setStatus(store.get(body.id as string)!.invoice!.quoteId, "settled");
  const polled = await (await handle(get(`/orders/${body.id as string}`))).json() as { state: string };
  assertEquals(polled.state, "paid", "the sats arrived, so the order is paid");
});
