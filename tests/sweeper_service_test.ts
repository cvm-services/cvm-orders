/**
 * G1, end to end, through the wiring the deployed service actually uses.
 *
 * The unit suite (tests/sweeper_test.ts) pins the reconciler's behaviour with an
 * injected clock and rail. This one deliberately uses NO mocks of our own code:
 * `main.ts`'s own store, its own route and its own `startOrderSweeper`, talking
 * to a fake Cashu mint over real HTTP.
 *
 * The card's measured failure was that paid depended on the customer's browser.
 * So the proof here is a negative one: this test NEVER calls `GET /orders/:id`
 * (the poll) — it watches the mint instead — and asserts that no outbound
 * request was ever made to an order URL. The only reads of order state are
 * `store.queue()` and `store.get()`.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakeRail } from "../src/rail.ts";

const ORIGIN = "https://cvm-pwa.example";

/** The shipped PWA's own POST body, priced by the committed config/venues.json. */
const pwaBody = {
  venue_slug: "pizza-e-pasta-ruedesheimerplatz",
  items: [{ name: "Pizza Margherita", qty: 1, amount: 9.9, options: "House · Single" }],
  fulfilment: "pickup",
  inputs: { "contact.phone": "+491****5678", "contact.name": "Ada" },
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!what()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the service's own sweep");
    await sleep(5);
  }
}

const post = (path: string, body: unknown): Request =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const get = (path: string): Request => new Request(`${ORIGIN}${path}`);

/**
 * A minimal NUT-04 mint: it quotes, it answers about quotes, and a test can move
 * a quote's state exactly as a customer paying (or a quote dying) would.
 */
function fakeMint() {
  const quotes = new Map<string, { state: string; expiry: number }>();
  let seq = 0;
  let ready: (addr: Deno.NetAddr) => void = () => {};
  const addrReady = new Promise<Deno.NetAddr>((resolve) => {
    ready = resolve;
  });

  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: (addr) => ready(addr) }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/v1/mint/quote/bolt11") {
      const body = await req.json() as { amount?: unknown };
      const quote = `quote-${++seq}`;
      const entry = { state: "UNPAID", expiry: nowSeconds() + 900 };
      quotes.set(quote, entry);
      return Response.json({
        quote,
        request: `lnbc${Number(body.amount)}n1fakemint${seq}`,
        state: entry.state,
        expiry: entry.expiry,
      });
    }
    const match = url.pathname.match(/^\/v1\/mint\/quote\/bolt11\/(.+)$/);
    if (req.method === "GET" && match) {
      const entry = quotes.get(decodeURIComponent(match[1]));
      if (!entry) return new Response("no such quote", { status: 404 });
      return Response.json({ quote: decodeURIComponent(match[1]), state: entry.state, expiry: entry.expiry });
    }
    return new Response("not found", { status: 404 });
  });

  return {
    server,
    addrReady,
    /** The customer's wallet pays this invoice. */
    settle(quote: string) {
      const entry = quotes.get(quote);
      if (!entry) throw new Error(`no such quote: ${quote}`);
      entry.state = "PAID";
    },
    /** The mint says this quote is still unpaid and its invoice has since died. */
    backdate(quote: string) {
      const entry = quotes.get(quote);
      if (!entry) throw new Error(`no such quote: ${quote}`);
      entry.state = "UNPAID";
      entry.expiry = nowSeconds() - 5;
    },
  };
}

Deno.test("the service's own wiring settles and expires with no customer poll", async (t) => {
  const mint = fakeMint();
  const addr = await mint.addrReady;
  const mintUrl = `http://127.0.0.1:${addr.port}`;

  // Read BEFORE main.ts is imported: the module resolves its rail on first use,
  // exactly as the deployed process does.
  Deno.env.set("CASHU_MINT_URL", mintUrl);
  Deno.env.set("ORDER_SWEEP_INTERVAL_MS", "25");
  // The service is durable by default now, and durable means a FILE. Point it at a
  // temp path so this test never writes into the repo — and at a path whose
  // directory does not exist yet, so the cold-start case is the one exercised.
  const dbDir = await Deno.makeTempDir({ prefix: "cvm-orders-service-" });
  Deno.env.set("ORDER_DB_PATH", `${dbDir}/nested/orders.sqlite`);

  // Every outbound HTTP call this test's service makes, recorded.
  const outbound: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    outbound.push(String(input instanceof Request ? input.url : input));
    return realFetch(input, init);
  }) as typeof fetch;

  const sweepLog: string[] = [];
  try {
    const service = await import("../main.ts");
    // Build the service the way `import.meta.main` does: explicitly, at call
    // time. Importing main.ts must wire nothing on its own — that was the bug the
    // import-time store used to hide.
    const { route, store } = service.createService();
    // The SAME starter `import.meta.main` calls, with the same env-driven
    // interval and the same shared rail resolver.
    const sweep = service.startOrderSweeper(
      { store, rail: service.createRailResolver({}), log: (line) => sweepLog.push(line) },
    );
    assertEquals(sweep.active, true, "ORDER_SWEEP_INTERVAL_MS=25 enables the sweep");

    try {
      await t.step("a settled invoice becomes paid work even though the tab is long gone", async () => {
        const created = await route(post("/orders", pwaBody));
        assertEquals(created.status, 201);
        const order = await created.json() as { id: string; total: number; state: string };
        assertEquals(order.state, "awaiting_payment");
        assertEquals(order.total, 11979, "priced server-side from the committed catalog");

        const invoiceRes = await route(get(`/orders/${order.id}/invoice`));
        assertEquals(invoiceRes.status, 200);
        assert(((await invoiceRes.json()) as { bolt11: string }).bolt11.startsWith("lnbc"));
        const quote = store.get(order.id)!.invoice!.quoteId;

        // From here on: no poll, no browser, no HTTP client of ours at all.
        mint.settle(quote);
        await waitFor(() => store.get(order.id)?.state === "paid");
        assertEquals(store.get(order.id)?.state, "paid");
        assertEquals(store.queue().map((o) => o.id), [order.id], "paid work reached the facilitator queue");
        assert(
          sweepLog.some((line) => line.includes(order.id) && line.includes("paid")),
          `the sweep reported the transition: ${JSON.stringify(sweepLog)}`,
        );
      });

      await t.step("an invoice the mint reports dead expires, and expiry is terminal", async () => {
        const created = await route(post("/orders", pwaBody));
        const order = await created.json() as { id: string };
        assertEquals((await route(get(`/orders/${order.id}/invoice`))).status, 200);
        const quote = store.get(order.id)!.invoice!.quoteId;

        mint.backdate(quote);
        await waitFor(() => store.get(order.id)?.state === "expired");
        assertEquals(store.get(order.id)?.state, "expired");
        assertEquals(store.queue().map((o) => o.id).includes(order.id), false, "an expired order is not work");
      });
    } finally {
      sweep.stop();
    }

    assertEquals(
      outbound.filter((url) => url.includes("/orders/")),
      [],
      `nothing ever fetched an order endpoint: ${JSON.stringify(outbound)}`,
    );
    assert(outbound.length > 0, "the invoice really was quoted by the fake mint over HTTP");
    assert(
      outbound.every((url) => url.startsWith(mintUrl)),
      `every outbound call went to the mint: ${JSON.stringify(outbound)}`,
    );
  } finally {
    globalThis.fetch = realFetch;
    Deno.env.delete("CASHU_MINT_URL");
    Deno.env.delete("ORDER_SWEEP_INTERVAL_MS");
    Deno.env.delete("ORDER_DB_PATH");
    await Deno.remove(dbDir, { recursive: true });
    await mint.server.shutdown();
  }
});

Deno.test("one resolver per process: the routes and the sweep share the same rail", async () => {
  // Guard on the wiring refactor in main.ts: a tick and a customer poll must
  // never end up talking to two different rails inside one process.
  const { createRailResolver } = await import("../main.ts");
  const rail = new FakeRail();
  const shared = createRailResolver({ rail });
  assertEquals(await shared(), rail);
  assertEquals(await shared(), rail, "resolved once and cached for both callers");

  assertEquals(await createRailResolver({ rail: null })(), null, "an explicit no-rail stays a decision");
});
