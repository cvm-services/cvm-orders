/**
 * ADR-0014 end-to-end, through the ROUTES: a rail-SETTLED order that a facilitator
 * places with a recorded venue number exposes `venue_reference` on the CUSTOMER
 * poll.
 *
 * Why this file exists. tests/venue_reference_test.ts proves the *mapping* (receipt
 * -> top-level field) against a store. tests/route_test.ts drives the signed
 * lifecycle but asserts the raw `receipt` object — it is about the facilitator auth
 * surface, not the customer's view. Neither pins the seam between them, which is
 * exactly where the deployed PWA reads from. This file drives the whole chain:
 *
 *     rail verdict -> paid -> placing -> placed(+receipt) -> customer poll
 *
 * and asserts the customer sees `venue_reference`. Nothing here is seeded: the
 * `paid` edge is produced by a rail settlement verdict the customer's own poll
 * claims (ADR-0008 / main.ts GET /orders/:id), and the venue number arrives only
 * through a signed facilitator transition. Every hop is the real route.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createRoute, type RouteDeps } from "../main.ts";
import { ChallengeStore } from "../src/nip98.ts";
import { type Order, type OrderMoney, OrderStore } from "../src/store.ts";
import { FakeRail } from "../src/rail.ts";
import { authHeader, challengeBoundEvent, facilitatorPubkey } from "./signing.ts";
import { TEST_REFUND_BOLT11 } from "./helpers/refund_fixture.ts";

const T0 = 1_800_000_000;
const ORIGIN = "https://cvm-pwa.example";
const CONSOLE_CHALLENGE_URL = `${ORIGIN}/api/auth/challenge`;

/** What the facilitator records at the counter — the venue's OWN number. */
const RECEIPT = {
  venue_reference: "#4471",
  ready_at: "18:25",
  paid_with: "card at venue terminal",
  payment_reference: "pi_1AbC",
  captured_at: "2026-10-10T18:20:03.123Z",
};

const money: OrderMoney = {
  venue_slug: "test-venue",
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
  fulfilment: "pickup",
  inputs: {},
};

/** The customer surface as the PWA actually consumes it (route adds these). */
type CustomerView = Order & { venue_reference: string | null; venue_reference_url: string | null };

function app(overrides: Partial<RouteDeps> = {}) {
  const store = new OrderStore();
  const challenges = new ChallengeStore({ ttlSeconds: 300 });
  const deps: RouteDeps = { store, challenges, facilitatorPubkey, now: () => T0, ...overrides };
  return { store, challenges, handle: createRoute(deps) };
}

type Handle = (req: Request) => Promise<Response>;

function post(url: string, body: unknown, header?: string): Request {
  return new Request(url, {
    method: "POST",
    headers: header
      ? { authorization: header, "content-type": "application/json" }
      : { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const authed = (url: string, body: unknown, header: string) => post(url, body, header);

/** The console's sign-in: read the challenge, sign it once, reuse the event. */
async function signIn(challenges: ChallengeStore, handle: Handle): Promise<string> {
  const res = await handle(new Request(`${ORIGIN}/auth/challenge`));
  assertEquals(res.status, 200);
  const challenge = await res.json() as { nonce: string };
  const event = challengeBoundEvent(challenge.nonce, CONSOLE_CHALLENGE_URL, { created_at: T0 });
  return authHeader(event);
}

/** An order with an invoice attached — the only state a rail verdict can act on. */
async function orderWithInvoice(
  store: OrderStore,
  rail: FakeRail,
  id: string,
): Promise<string> {
  store.create(id, {  venue_slug: "test-venue", refund_bolt11: TEST_REFUND_BOLT11 }, money);
  const invoice = await rail.createInvoice({
    sats: money.total,
    memo: `cvm-orders ${id}`,
    idempotencyKey: id,
  });
  await store.ensureInvoice(id, () =>
    Promise.resolve({ ...invoice, qr: "data:image/svg+xml;base64,x" }));
  return store.get(id)!.invoice!.quoteId;
}

Deno.test(
  "ADR-0014 e2e: rail-settled order + recorded receipt -> venue_reference on the customer poll",
  async () => {
    const rail = new FakeRail({ now: () => T0 * 1000 });
    const { store, challenges, handle } = app({ rail });
    const quoteId = await orderWithInvoice(store, rail, "o-1");

    // ---- before anything: the customer sees no venue number, and no paid state.
    const pre = await handle(new Request(`${ORIGIN}/orders/o-1`));
    assertEquals(pre.status, 200);
    const preBody = await pre.json() as CustomerView;
    assertEquals(preBody.state, "awaiting_payment", "an unsettled quote never reads as paid");
    assertEquals(preBody.venue_reference, null, "no venue number is invented");
    assertEquals(preBody.venue_reference_url, null);

    // ---- the mint settles. The customer's OWN poll claims it (ADR-0008).
    rail.setStatus(quoteId, "settled");
    const paidRes = await handle(new Request(`${ORIGIN}/orders/o-1`));
    const paid = await paidRes.json() as CustomerView;
    assertEquals(paid.state, "paid", "a rail verdict moves the order, with no facilitator in the loop");
    assertEquals(paid.venue_reference, null, "paid is still not a venue confirmation");

    // ---- a facilitator signs in and places the order, recording the venue number.
    const header = await signIn(challenges, handle);

    const placing = await handle(authed(`${ORIGIN}/orders/o-1/transition`, { state: "placing" }, header));
    assertEquals(placing.status, 200);
    // `venue_reference` is a CUSTOMER-surface field (added on GET /orders/:id only),
    // not something the transition echo carries — so assert it where the PWA reads it.
    const midPoll = await (await handle(new Request(`${ORIGIN}/orders/o-1`))).json() as CustomerView;
    assertEquals(midPoll.state, "placing");
    assertEquals(midPoll.venue_reference, null, "placing is not yet a venue confirmation");

    const placed = await handle(authed(
      `${ORIGIN}/orders/o-1/transition`,
      { state: "placed", from: "placing", receipt: RECEIPT },
      header,
    ));
    assertEquals(placed.status, 200);

    // ---- THE POINT: the customer's poll now carries the venue's own number.
    const finalRes = await handle(new Request(`${ORIGIN}/orders/o-1`));
    assertEquals(finalRes.status, 200);
    const view = await finalRes.json() as CustomerView;
    assertEquals(view.state, "placed");
    assertEquals(view.venue_reference, RECEIPT.venue_reference, "the venue's number reaches the customer");
    assertEquals(view.receipt?.ready_at, RECEIPT.ready_at, "and the rest of the receipt is still there");

    // ---- and it survives the last step of the lifecycle.
    const ready = await handle(authed(`${ORIGIN}/orders/o-1/transition`, { state: "ready" }, header));
    assertEquals(ready.status, 200);
    const afterReady = await (await handle(new Request(`${ORIGIN}/orders/o-1`))).json() as CustomerView;
    assertEquals(afterReady.state, "ready");
    assertEquals(afterReady.venue_reference, RECEIPT.venue_reference);

    store.close();
  },
);

Deno.test(
  "ADR-0014 e2e: the venue number is unreachable without a signed placement",
  async () => {
    const rail = new FakeRail({ now: () => T0 * 1000 });
    const { store, handle } = app({ rail });
    await orderWithInvoice(store, rail, "o-2");

    // Settle it, so state is not the obstacle — auth is.
    const quoteId = (await (await handle(new Request(`${ORIGIN}/orders/o-2`))).json() as Order)
      .invoice?.quoteId ?? "";
    assert(quoteId.length > 0);
    rail.setStatus(quoteId, "settled");
    await handle(new Request(`${ORIGIN}/orders/o-2`));

    // An unauthenticated caller cannot record a receipt, so cannot mint a number.
    const denied = await handle(post(`${ORIGIN}/orders/o-2/transition`, {
      state: "placed",
      receipt: RECEIPT,
    }));
    assertEquals(denied.status, 401);
    const view = await (await handle(new Request(`${ORIGIN}/orders/o-2`))).json() as CustomerView;
    assertEquals(view.venue_reference, null, "no credential, no venue number");

    store.close();
  },
);
