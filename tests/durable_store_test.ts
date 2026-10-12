/**
 * Durable state: what must still be true after the process died.
 *
 * The store used to be an in-process `Map` — and the deploy script said so
 * ("The order store is IN MEMORY: a restart empties the queue by design"). Two
 * of the things it lost are money: the order's invoice (a restart that re-quoted
 * a second bolt11 for an order whose first invoice was already paid leaves the
 * sats stranded) and the Idempotency-Key (a retry after a restart created a
 * second order for one basket).
 *
 * Every test here opens a SECOND store over the same file, which is exactly what
 * a service restart is.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createRoute, createService, orderDbPath, type RouteDeps } from "../main.ts";
import { type Catalog } from "../src/catalog.ts";
import { ChallengeStore } from "../src/nip98.ts";
import { FakeRail } from "../src/rail.ts";
import { OrderStore, type OrderMoney } from "../src/store.ts";
import { facilitatorPubkey } from "./signing.ts";

const money: OrderMoney = {
  venue_slug: "test-venue",
  items: [
    {
      sku: "100",
      name: "Pizza Margherita",
      qty: 1,
      options: ["House"],
      unit_price_sats: 9900,
      line_total_sats: 9900,
    },
  ],
  subtotal: 9900,
  fee: 792,
  total: 10692,
  fulfilment: "pickup",
  inputs: {},
};

const catalog: Catalog = {
  sats_per_eur: 1000,
  option_surcharges_sats: {},
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
      ],
    },
  ],
};

const tmpDb = async (label: string): Promise<string> => {
  const dir = await Deno.makeTempDir({ prefix: `cvm-orders-durable-${label}-` });
  return `${dir}/orders.sqlite`;
};

const invoice = (n: string) => ({
  bolt11: `lnbc106920n1${n}`,
  quoteId: `quote-${n}`,
  expiresAt: "2026-10-11T05:48:18.000Z",
  qr: "data:image/svg+xml;base64,x",
});

Deno.test("an order, its money and its invoice survive a restart", async () => {
  const path = await tmpDb("restart");
  const before = new OrderStore({ path });
  before.create("o-1", { venue_slug: "test-venue" }, money);
  await before.ensureInvoice("o-1", () => Promise.resolve(invoice("r")));
  before.transition("o-1", "paid", { from: "awaiting_payment" });
  before.close();

  const after = new OrderStore({ path });
  const order = after.get("o-1");
  assertEquals(order?.state, "paid");
  assertEquals(order?.total, 10692);
  assertEquals(order?.fee, 792);
  assertEquals(order?.items?.[0].sku, "100");
  assertEquals(order?.invoice?.bolt11, invoice("r").bolt11, "the SAME invoice came back");
  assertEquals(after.queue().map((o) => o.id), ["o-1"], "the facilitator's queue survived");
  after.close();
});

Deno.test("a restart never re-quotes an order that already has an invoice", async () => {
  const path = await tmpDb("requote");
  const before = new OrderStore({ path });
  before.create("o-1", {}, money);
  await before.ensureInvoice("o-1", () => Promise.resolve(invoice("first")));
  before.close();

  const after = new OrderStore({ path });
  let factories = 0;
  const again = await after.ensureInvoice("o-1", () => {
    factories++;
    return Promise.resolve(invoice("second"));
  });
  assertEquals(factories, 0, "the mint is not asked for a SECOND bolt11");
  assertEquals(again.invoice?.bolt11, invoice("first").bolt11);
  // And a customer poll still sees the invoice they were paying, not a new one.
  assertEquals(after.get("o-1")?.invoice?.quoteId, "quote-first");
  after.close();
});

Deno.test("two stores over one file racing ensureInvoice: the FIRST invoice wins", async () => {
  const path = await tmpDb("invoice-race");
  const a = new OrderStore({ path });
  a.create("o-1", {}, money);
  const b = new OrderStore({ path });

  // Both callers reach the rail before either has committed — the situation the
  // shipped code had no defence against at all.
  const pa = a.ensureInvoice("o-1", () => Promise.resolve(invoice("a")));
  const pb = b.ensureInvoice("o-1", () => Promise.resolve(invoice("b")));
  const [ra, rb] = await Promise.all([pa, pb]);

  assertEquals(ra.invoice?.bolt11, rb.invoice?.bolt11, "both callers saw ONE invoice");
  const stored = new OrderStore({ path }).get("o-1")?.invoice?.bolt11;
  assertEquals(stored, ra.invoice?.bolt11, "the durable copy is the winner's");
  a.close();
  b.close();
});

Deno.test("terminal states survive a restart and cannot be revived", async () => {
  const path = await tmpDb("terminal");
  const before = new OrderStore({ path });
  before.create("e1", {}, money);
  before.transition("e1", "expired", { from: "awaiting_payment" });
  before.create("r1", {}, money);
  before.transition("r1", "paid", { from: "awaiting_payment" });
  before.transition("r1", "refunded");
  before.close();

  const after = new OrderStore({ path });
  assertEquals(after.get("e1")?.state, "expired");
  assertEquals(after.get("r1")?.state, "refunded");
  for (const id of ["e1", "r1"]) {
    assert(
      (() => {
        try {
          after.transition(id, "paid");
          return false;
        } catch {
          return true;
        }
      })(),
      `${id} stayed terminal across the restart`,
    );
  }
  assertEquals(after.queue(), [], "a refunded order is not paid work");
  after.close();
});

Deno.test("an Idempotency-Key replay survives a restart (one basket, one order)", async () => {
  const path = await tmpDb("idem");
  const app = (store: OrderStore) => {
    const deps: RouteDeps = {
      store,
      challenges: new ChallengeStore({ ttlSeconds: 300 }),
      facilitatorPubkey,
      now: () => 1_800_000_000,
      rail: new FakeRail({ now: () => 1_800_000_000_000 }),
      catalog,
    };
    return createRoute(deps);
  };
  const body = {
    venue_slug: "test-venue",
    items: [{ name: "Pizza Margherita", qty: 1, amount: 9.9, options: "House · Single" }],
    fulfilment: "pickup",
    inputs: {},
  };
  const post = (key: string) =>
    new Request("https://cvm-pwa.example/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body),
    });

  const first = new OrderStore({ path });
  const res1 = await app(first)(post("tap-1"));
  const order1 = await res1.json() as { id: string };
  assertEquals(res1.status, 201);
  first.close();

  // Restart, then the customer's client retries the same tap.
  const second = new OrderStore({ path });
  const res2 = await app(second)(post("tap-1"));
  const order2 = await res2.json() as { id: string };
  assertEquals(res2.status, 200);
  assertEquals(res2.headers.get("idempotency-replayed"), "true");
  assertEquals(order2.id, order1.id, "the retry got the ORIGINAL order, not a second one");
  assertEquals(second.all().length, 1, "exactly one order exists for that key");
  second.close();
});

Deno.test("a double-tap on Pay creates ONE order, not two", async () => {
  const path = await tmpDb("double-tap");
  const store = new OrderStore({ path });
  const respond = () => ({ id: "ignored" });
  const a = store.createIdempotent("key", "id-a", {}, money, respond);
  const b = store.createIdempotent("key", "id-b", {}, money, respond);
  assertEquals(a.replayed, false);
  assertEquals(b.replayed, true);
  assertEquals(a.order.id, "id-a");
  assertEquals(b.order.id, "id-a");
  assertEquals(store.all().length, 1);
  store.close();
});

Deno.test("create() refuses an order with no id (the PWA contract bug)", () => {
  const store = new OrderStore();
  // The old route did `store.create(body.id, body.payload)` on a body that has
  // neither field, which created an order under the key `undefined`.
  let refused = false;
  try {
    store.create(undefined as unknown as string, {});
  } catch {
    refused = true;
  }
  assert(refused, "an order without a server-assigned id is refused");
  assertEquals(store.all(), []);
  store.close();
});

Deno.test("the schema migrates a deployed (v1) database in place", async () => {
  const path = await tmpDb("migrate");
  // A deployed v1 file: the ORIGINAL table, one legacy row, and no `ALTER`
  // applied — `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so
  // the migration has to add what is missing itself.
  const { DatabaseSync } = await import("node:sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL,
      venue_slug TEXT, items TEXT, subtotal INTEGER, fee INTEGER, total INTEGER,
      fulfilment TEXT, inputs TEXT, invoice TEXT, receipt TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  legacy.prepare(
    "INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "legacy-1",
    "awaiting_payment",
    "{}",
    "test-venue",
    null,
    9900,
    792,
    10692,
    "pickup",
    null,
    JSON.stringify(invoice("legacy")),
    null,
    "2026-10-10T00:00:00.000Z",
    "2026-10-10T00:00:00.000Z",
  );
  legacy.exec("PRAGMA user_version = 1");
  legacy.close();

  const store = new OrderStore({ path });
  const migrated = store.get("legacy-1");
  assertEquals(migrated?.state, "awaiting_payment", "no legacy row was lost");
  assertEquals(migrated?.total, 10692);
  assertEquals(migrated?.invoice?.bolt11, invoice("legacy").bolt11, "its invoice survived");
  // New columns exist, and the new operations work against the migrated file.
  assertEquals(store.claimSettlement("legacy-1", { quoteId: "quote-legacy" }), "won");
  assertEquals(store.get("legacy-1")?.state, "paid");
  store.create("new-1", {}, money);
  assertEquals(store.all().map((o) => o.id), ["legacy-1", "new-1"]);
  store.close();
});

Deno.test("the order store is durable for every entrypoint, an import included", () => {
  const env = (values: Record<string, string>) => ({
    get: (k: string) => values[k],
  });
  assertEquals(orderDbPath(env({})), "data/orders.sqlite", "a bare start writes to a file");
  assertEquals(orderDbPath(env({ ORDER_DB_PATH: "/var/lib/cvm-orders/o.sqlite" })), "/var/lib/cvm-orders/o.sqlite");
  assertEquals(orderDbPath(env({ ORDER_DB_PATH: "  " })), "data/orders.sqlite");
  // There is deliberately no `isMain` arm any more. An import used to silently
  // select `:memory:`, so whatever imported this file lost the persisted invoice —
  // and a restart re-quoted a SECOND bolt11 for an order whose first invoice the
  // customer had already paid. Every caller now gets the durable path; the suite
  // injects its own store through `createRoute({ store })` instead.
});

Deno.test("a cold start creates the store's directory instead of dying on it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cvm-orders-cold-start-" });
  const path = `${dir}/nested/orders.sqlite`;
  const env = { get: (k: string) => (k === "ORDER_DB_PATH" ? path : undefined) };
  try {
    // No parent directory exists yet — which is exactly what a fresh checkout with
    // the default `data/orders.sqlite` looks like. `node:sqlite` used to answer
    // "unable to open database file" and the service never started.
    const { store } = createService(env);
    store.create("o-cold", { venue_slug: "test-venue" }, money);
    store.close();

    // And it really is a file, not a memory store: a second start reads it back.
    const second = createService(env);
    assertEquals(second.store.get("o-cold")?.state, "awaiting_payment", "a restart sees the order");
    second.store.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
