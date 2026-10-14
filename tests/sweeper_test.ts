/**
 * G1 — the order service sweeps its own orders.
 *
 * Measured live 2026-10-11: the ONLY thing that ever asked the mint "was this
 * invoice paid?" was the CUSTOMER's browser (`GET /orders/:id`, every 5s while
 * the pay screen is open). Pay in a wallet app on a phone, close the tab — or
 * let the frozen timer of a backgrounded tab mean the poll simply stops — and
 * the order sat in `awaiting_payment` forever: money stranded, no state change,
 * and the invoice itself never expired either, because expiry rode that same
 * poll.
 *
 * What these tests pin is the replacement: a periodic reconciler INSIDE the
 * order service, driven by an injected clock and an injected rail, which runs
 * with no HTTP client attached at all. ADR-0008 does not move: the sweep asks
 * the rail and applies its verdict through the store's compare-and-set; it
 * never writes `paid` on its own opinion, and it never decides that money
 * arrived when the rail cannot answer.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  DEFAULT_SWEEP_INTERVAL_MS,
  startSweeper,
  sweepIntervalMsFromEnv,
  sweepOnce,
} from "../src/sweeper.ts";
import {
  FakeRail,
  type Invoice,
  type InvoiceRequest,
  type PaymentRail,
  RailError,
  type SettlementStatus,
} from "../src/rail.ts";
import { type OrderInvoice, type OrderState, OrderStore } from "../src/store.ts";
import { createRoute, type RouteDeps } from "../main.ts";
import { ChallengeStore } from "../src/nip98.ts";
import type { Catalog } from "../src/catalog.ts";

/** Fixed epoch milliseconds: every clock in this file is injected. */
const T0 = 1_800_000_000_000;
const T0_SECONDS = Math.floor(T0 / 1000);

const money = {
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
    items: [{
      sku: "100",
      name: "Pizza Margherita",
      prices_by_order_method: { pickup: 9.9 },
      available: true,
    }],
  }],
};

const QR = "data:image/svg+xml;base64,c3dlZXA=";

/** A new store, a FakeRail and the log lines a sweep emitted. */
function bench(now: () => number = () => T0) {
  const lines: string[] = [];
  const store = new OrderStore();
  const rail = new FakeRail({ now });
  const log = (line: string) => lines.push(line);
  const deps = { store, rail, now, log };
  return { store, rail, lines, deps };
}

/** An order in `awaiting_payment` carrying the invoice the rail just quoted. */
async function awaitingOrder(
  store: OrderStore,
  rail: Pick<PaymentRail, "createInvoice">,
  id = "o-1",
  expiresAtMs = T0 + 900_000,
): Promise<string> {
  store.create(id, { venue_slug: "test-venue" }, money);
  const invoice = await rail.createInvoice({ sats: 10692, memo: `cvm-orders ${id}`, idempotencyKey: id });
  await store.ensureInvoice(id, () =>
    Promise.resolve<OrderInvoice>({ ...invoice, expiresAt: new Date(expiresAtMs).toISOString(), qr: QR }));
  return store.get(id)!.invoice!.quoteId;
}

/** Records every quote it is asked about, and answers with a fixed verdict. */
class RecordingRail implements PaymentRail {
  readonly name = "recording";
  checks: string[] = [];
  constructor(readonly verdict: SettlementStatus | Error) {}
  createInvoice(req: InvoiceRequest): Promise<Invoice> {
    return Promise.reject(new RailError(`this rail does not quote (${req.sats})`));
  }
  checkSettlement(quoteId: string): Promise<SettlementStatus> {
    this.checks.push(quoteId);
    if (this.verdict instanceof Error) return Promise.reject(this.verdict);
    return Promise.resolve(this.verdict);
  }
}

/** Answers a tick later, so the poll and the sweep really do overlap. */
class SlowRail implements PaymentRail {
  readonly name = "slow";
  constructor(readonly inner: FakeRail) {}
  createInvoice(req: InvoiceRequest): Promise<Invoice> {
    return this.inner.createInvoice(req);
  }
  async checkSettlement(quoteId: string): Promise<SettlementStatus> {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return await this.inner.checkSettlement(quoteId);
  }
}

/**
 * Counts the settlement claims the store actually WON.
 *
 * Counting `transition()` is not the same measurement any more: since the sweep
 * settles through the SAME durable claim as the poll (`claimSettlement`), a losing
 * racer never calls `transition` at all — it returns `lost` and writes nothing. So
 * "exactly once" is measured on the claim, which is where the exactly-once
 * property lives.
 */
class CountingStore extends OrderStore {
  paid = 0;
  expired = 0;
  reused = 0;
  override claimSettlement(
    id: string,
    claim: Parameters<OrderStore["claimSettlement"]>[1],
    to: Parameters<OrderStore["claimSettlement"]>[2] = "paid",
  ) {
    const outcome = super.claimSettlement(id, claim, to);
    if (outcome === "won") {
      if (to === "paid") this.paid++;
      else this.expired++;
    } else if (outcome === "proof_spent") {
      this.reused++;
    }
    return outcome;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!what()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the sweep");
    await sleep(5);
  }
}

const env = (values: Record<string, string>) => ({ get: (key: string) => values[key] });

// --- the sweep reaches `paid` with no HTTP client anywhere --------------------

Deno.test("a settled quote reaches paid on the sweep alone — zero HTTP requests", async () => {
  const { store, rail, lines, deps } = bench();
  const quoteId = await awaitingOrder(store, rail);
  assertEquals(store.get("o-1")?.state, "awaiting_payment");

  // The whole point: nobody is polling. Any HTTP call at all fails this test.
  const realFetch = globalThis.fetch;
  let httpCalls = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    httpCalls++;
    return realFetch(...args);
  }) as typeof fetch;
  try {
    rail.setStatus(quoteId, "settled");
    const report = await sweepOnce(deps);
    assertEquals(report.checked, 1, "the one awaiting_payment order was asked about");
    assertEquals(report.paid, 1);
  } finally {
    globalThis.fetch = realFetch;
  }

  assertEquals(httpCalls, 0, "the sweep reaches the mint through the injected rail, not the network");
  assertEquals(store.get("o-1")?.state, "paid", "the sats arrived, so the order is paid work");
  assertEquals(store.queue().map((o) => o.id), ["o-1"]);
  assert(lines.some((l) => l.includes("o-1") && l.includes("paid")), `no transition line in ${JSON.stringify(lines)}`);
});

Deno.test("the sweep never pays what the rail has not settled", async () => {
  const { store, rail, deps } = bench();
  await awaitingOrder(store, rail);
  const report = await sweepOnce(deps);
  assertEquals(report.checked, 1);
  assertEquals(report.unchanged, 1, "a pending quote is not money");
  assertEquals(store.get("o-1")?.state, "awaiting_payment");
  assertEquals(store.queue(), []);
});

// --- expiry, with no client timer involved -----------------------------------

Deno.test("an expired quote expires the order, and expiry is terminal", async () => {
  const { store, rail, deps } = bench();
  const quoteId = await awaitingOrder(store, rail);
  rail.setStatus(quoteId, "expired");

  const report = await sweepOnce(deps);
  assertEquals(report.expired, 1);
  assertEquals(store.get("o-1")?.state, "expired");
  assertEquals(store.queue(), [], "an expired order was never paid");

  // A mint that afterwards reports the quote settled cannot resurrect it.
  rail.setStatus(quoteId, "settled");
  await sweepOnce(deps);
  assertEquals(store.get("o-1")?.state, "expired");
});

Deno.test("a pending quote past its own expires_at expires without the client's timer", async () => {
  const { store, rail, deps } = bench();
  await awaitingOrder(store, rail, "o-1", T0 - 1000);
  const report = await sweepOnce(deps);
  assertEquals(report.expired, 1, "the sweep owns expiry, not the pay screen");
  assertEquals(store.get("o-1")?.state, "expired");
});

Deno.test("a settled quote beats a stale local expiry: money first, then the clock", async () => {
  const { store, rail, deps } = bench();
  const quoteId = await awaitingOrder(store, rail, "o-1", T0 - 1000);
  rail.setStatus(quoteId, "settled");
  const report = await sweepOnce(deps);
  assertEquals(report.paid, 1);
  assertEquals(store.get("o-1")?.state, "paid", "an expired-looking invoice that was paid is still paid work");
});

// --- fail-closed -------------------------------------------------------------

Deno.test("an unreachable rail changes nothing, logs once per tick, and never throws", async () => {
  const { store, lines, deps } = bench();
  const rail = new RecordingRail(new RailError("mint unreachable: TimeoutError"));
  for (const id of ["o-1", "o-2", "o-3"]) {
    store.create(id, {}, money);
    await store.ensureInvoice(id, () =>
      Promise.resolve<OrderInvoice>({
        bolt11: `lnbc1${id}`,
        quoteId: `quote-${id}`,
        expiresAt: new Date(T0 + 900_000).toISOString(),
        qr: QR,
      }));
  }

  const report = await sweepOnce({ ...deps, rail });
  assertEquals(report.checked, 3);
  assertEquals(report.unavailable, 3);
  assertEquals(report.paid + report.expired, 0, "an unanswerable rail is not a verdict");
  for (const id of ["o-1", "o-2", "o-3"]) assertEquals(store.get(id)?.state, "awaiting_payment");
  assertEquals(lines.length, 1, `exactly one log line for the whole tick, got ${JSON.stringify(lines)}`);
  assert(lines[0].includes("3"), "the line names how many orders were left alone");

  // A second tick still does not crash the service.
  await sweepOnce({ ...deps, rail });
  assertEquals(store.get("o-1")?.state, "awaiting_payment");
});

// --- exactly-once, against a concurrent customer poll ------------------------

Deno.test("a customer poll and the sweep racing produce exactly one transition", async () => {
  const store = new CountingStore();
  const rail = new SlowRail(new FakeRail({ now: () => T0 }));
  const challenges = new ChallengeStore({ ttlSeconds: 300 });
  const deps: RouteDeps = {
    store,
    challenges,
    facilitatorPubkey: null,
    now: () => T0_SECONDS,
    rail,
    catalog,
  };
  const handle = createRoute(deps);
  const quoteId = await awaitingOrder(store, rail, "o-race");
  rail.inner.setStatus(quoteId, "settled");

  // Both read `awaiting_payment`, both ask the rail, both try to commit.
  const poll = handle(new Request("https://cvm-pwa.example/orders/o-race"));
  const sweep = sweepOnce({ store, rail, now: () => T0, log: () => {} });
  await Promise.all([poll, sweep]);

  assertEquals(store.paid, 1, "exactly one settlement claim won; the loser lost the compare-and-set");
  assertEquals(store.get("o-race")?.state, "paid");
  assertEquals(store.queue().map((o) => o.id), ["o-race"]);
  rail.inner.setStatus(quoteId, "expired");
  await sweepOnce({ store, rail, now: () => T0, log: () => {} });
  assertEquals(store.get("o-race")?.state, "paid", "a paid order is never re-read as expired");
});

// --- the sweep and the poll spend the SAME payment request -------------------

Deno.test("a sweep-settled quote is spent everywhere: the same payment cannot settle a second order", async () => {
  const { store, rail, deps } = bench();
  const quoteId = await awaitingOrder(store, rail, "o-first");
  rail.setStatus(quoteId, "settled");
  await sweepOnce(deps);

  assertEquals(store.get("o-first")?.state, "paid", "setup: the sweep settled the first order");
  // The whole composition hole in one assertion: a sweep that settles with a bare
  // `transition()` leaves this empty, and the payment request stays unspent — free
  // to settle a SECOND order through the poll.
  assertEquals(store.proofSpentBy(quoteId), "o-first", "the sweep must spend the payment request, exactly like the poll");

  // A second order carrying the SAME payment request (mint replay, or a bug).
  store.create("o-second", { venue_slug: "test-venue" }, money);
  await store.ensureInvoice("o-second", () =>
    Promise.resolve<OrderInvoice>({
      bolt11: "lnbc-replayed",
      quoteId,
      expiresAt: new Date(T0 + 900_000).toISOString(),
      qr: QR,
    }));

  const handle = createRoute({
    store,
    challenges: new ChallengeStore({ ttlSeconds: 300 }),
    facilitatorPubkey: null,
    now: () => T0_SECONDS,
    rail,
    catalog,
  });
  const res = await handle(new Request("https://cvm-pwa.example/orders/o-second"));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.state, "awaiting_payment", "the sats already paid o-first; the poll must not pay a second order");
  assertEquals(store.get("o-second")?.state, "awaiting_payment");
  assertEquals(store.queue().map((o) => o.id), ["o-first"], "one payment, one order in the queue");
});

Deno.test("the sweep leaves an order alone — and says so — when its payment already settled another", async () => {
  const { store, rail, deps, lines } = bench();
  const quoteId = await awaitingOrder(store, rail, "o-first");
  rail.setStatus(quoteId, "settled");
  await sweepOnce(deps);
  assertEquals(store.get("o-first")?.state, "paid");

  store.create("o-second", { venue_slug: "test-venue" }, money);
  await store.ensureInvoice("o-second", () =>
    Promise.resolve<OrderInvoice>({
      bolt11: "lnbc-replayed",
      quoteId,
      expiresAt: new Date(T0 + 900_000).toISOString(),
      qr: QR,
    }));

  const report = await sweepOnce(deps);

  assertEquals(report.checked, 1);
  assertEquals(report.paid, 0, "the rail says settled, but this payment has already been spent");
  assertEquals(report.reused, 1, "a reuse is not 'nothing to do': it is a money anomaly and it is counted");
  assertEquals(store.get("o-second")?.state, "awaiting_payment", "one payment must never pay two orders");
  assert(
    lines.some((l) => l.includes("payment request already settled")),
    `no reuse warning line in ${JSON.stringify(lines)}`,
  );
});

// --- scope: only awaiting_payment orders with an invoice ---------------------

Deno.test("the sweep touches only awaiting_payment orders that have an invoice", async () => {
  const { lines, deps } = bench();
  const rail = new RecordingRail("pending");
  const store = deps.store;

  store.create("o-no-invoice", {}, money);
  const untouched: Array<[string, Parameters<OrderStore["transition"]>[1]]> = [
    ["o-paid", "paid"],
    ["o-placing", "placing"],
    ["o-placed", "placed"],
    ["o-ready", "ready"],
    ["o-refunded", "refunded"],
  ];
  for (const [id, state] of untouched) {
    store.create(id, {}, money);
    const path: OrderState[] = state === "refunded" ? ["paid", "refunded"] : ["paid", "placing", "placed", "ready"];
    const stop = path.indexOf(state) + 1;
    for (const [i, next] of path.slice(0, stop).entries()) {
      store.transition(id, next, i === 0 ? { from: "awaiting_payment" } : {});
    }
  }
  store.create("o-expired", {}, money);
  store.transition("o-expired", "expired", { from: "awaiting_payment" });
  await store.ensureInvoice("o-paid", () => Promise.resolve<OrderInvoice>({ bolt11: "x", quoteId: "q-paid", expiresAt: new Date(T0 + 900_000).toISOString(), qr: QR }));

  const before = new Map(store.all().map((o) => [o.id, `${o.state}@${o.updatedAt}`]));
  const quoteId = await awaitingOrder(store, new FakeRail({ now: () => T0 }), "o-awaiting");

  const report = await sweepOnce({ ...deps, rail });
  assertEquals(rail.checks, [quoteId], "one check, for the one reconcilable order");
  assertEquals(report.checked, 1);
  for (const [id, snapshot] of before) {
    assertEquals(`${store.get(id)?.state}@${store.get(id)?.updatedAt}`, snapshot, `${id} must not move`);
  }
  assertEquals(store.get("o-no-invoice")?.state, "awaiting_payment");
  assertEquals(lines, [], "nothing was worth reporting");
});

// --- startSweeper: interval, disabling, and never crashing the service -------

Deno.test("ORDER_SWEEP_INTERVAL_MS: 30s by default, 0 disables, garbage never disables", () => {
  assertEquals(sweepIntervalMsFromEnv(env({})), DEFAULT_SWEEP_INTERVAL_MS);
  assertEquals(DEFAULT_SWEEP_INTERVAL_MS, 30_000);
  assertEquals(sweepIntervalMsFromEnv(env({ ORDER_SWEEP_INTERVAL_MS: "" })), 30_000);
  assertEquals(sweepIntervalMsFromEnv(env({ ORDER_SWEEP_INTERVAL_MS: "0" })), 0);
  assertEquals(sweepIntervalMsFromEnv(env({ ORDER_SWEEP_INTERVAL_MS: " 250 " })), 250);
  assertEquals(sweepIntervalMsFromEnv(env({ ORDER_SWEEP_INTERVAL_MS: "-5" })), 30_000);
  assertEquals(sweepIntervalMsFromEnv(env({ ORDER_SWEEP_INTERVAL_MS: "soon" })), 30_000);
});

Deno.test("interval 0 disables the sweep: no rail calls, no state change", async () => {
  const { store, deps } = bench();
  const rail = new RecordingRail("settled");
  await awaitingOrder(store, new FakeRail({ now: () => T0 }));

  const handle = startSweeper({ ...deps, rail }, { intervalMs: 0 });
  assertEquals(handle.active, false);
  assertEquals(handle.intervalMs, 0);
  await sleep(25);
  handle.stop();
  assertEquals(rail.checks, [], "a disabled sweep must not touch the rail");
  assertEquals(store.get("o-1")?.state, "awaiting_payment");
});

Deno.test("startSweeper converges on its own interval, and stop() halts it", async () => {
  const { store, rail, lines, deps } = bench();
  const quoteId = await awaitingOrder(store, rail);
  const handle = startSweeper(deps, { intervalMs: 5 });
  assertEquals(handle.active, true);
  try {
    rail.setStatus(quoteId, "settled");
    await waitFor(() => store.get("o-1")?.state === "paid");
  } finally {
    handle.stop();
  }
  assertEquals(store.queue().map((o) => o.id), ["o-1"]);

  // After stop() the timer is gone: a second, settled order stays untouched.
  const other = await awaitingOrder(store, rail, "o-2");
  rail.setStatus(other, "settled");
  await sleep(40);
  assertEquals(store.get("o-2")?.state, "awaiting_payment", "stop() really stopped it");
  assert(lines.some((l) => l.includes("o-1") && l.includes("paid")));
});

Deno.test("a throwing rail cannot crash the sweep timer", async () => {
  const { store, lines, deps } = bench();
  await awaitingOrder(store, new FakeRail({ now: () => T0 }));
  const rail = new RecordingRail(new Error("boom"));
  const handle = startSweeper({ ...deps, rail }, { intervalMs: 5 });
  try {
    await waitFor(() => lines.length >= 2);
  } finally {
    handle.stop();
  }
  assertEquals(store.get("o-1")?.state, "awaiting_payment");
  assert(lines.every((l) => typeof l === "string" && l.length > 0));
});
