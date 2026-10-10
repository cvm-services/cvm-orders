import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  CashuRail,
  FakeRail,
  qrDataUri,
  RailError,
  railFromEnv,
} from "../src/rail.ts";

/** Fake fetch that answers the two NUT-04 endpoints. */
function mint(opts: {
  quote?: Record<string, unknown>;
  status?: Record<string, unknown>;
  quoteStatus?: number;
  throws?: boolean;
} = {}) {
  const calls: { url: string; body?: string }[] = [];
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (opts.throws) return Promise.reject(new TypeError("fetch failed"));
    const isQuote = url.includes("/v1/mint/quote/bolt11") && !/bolt11\/[^/]+$/.test(url);
    const code = isQuote ? (opts.quoteStatus ?? 200) : 200;
    const body = isQuote
      ? (opts.quote ?? { quote: "q-1", request: "lnbc5000n1real", state: "UNPAID" })
      : (opts.status ?? { quote: "q-1", state: "UNPAID" });
    return Promise.resolve(new Response(JSON.stringify(body), { status: code }));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// --- CashuRail.createInvoice ---------------------------------------------

Deno.test("createInvoice posts amount+unit and returns bolt11/quoteId/expiry", async () => {
  const { impl, calls } = mint({ quote: { quote: "q-9", request: "lnbc1234n1xyz", expiry: 1_800_000_000 } });
  const rail = new CashuRail({ baseUrl: "https://mint.example/", fetchImpl: impl });
  const inv = await rail.createInvoice({ sats: 5022, memo: "order o-1", idempotencyKey: "k1" });

  assertEquals(inv.bolt11, "lnbc1234n1xyz");
  assertEquals(inv.quoteId, "q-9");
  assertEquals(inv.expiresAt, new Date(1_800_000_000 * 1000).toISOString());
  assertEquals(calls[0].url, "https://mint.example/v1/mint/quote/bolt11", "trailing slash normalised");
  assertEquals(JSON.parse(calls[0].body!), { amount: 5022, unit: "sat" });
});

Deno.test("createInvoice refuses a non-integer or non-positive amount without calling the mint", async () => {
  const { impl, calls } = mint();
  const rail = new CashuRail({ baseUrl: "https://mint.example", fetchImpl: impl });
  for (const bad of [0, -1, 1.5, NaN]) {
    await assertRejects(() => rail.createInvoice({ sats: bad, memo: "m", idempotencyKey: "k" }), RailError);
  }
  assertEquals(calls.length, 0, "must not hit the network for an invalid amount");
});

Deno.test("createInvoice refuses a body with no bolt11 or no quote", async () => {
  const rail = (q: Record<string, unknown>) =>
    new CashuRail({ baseUrl: "https://mint.example", fetchImpl: mint({ quote: q }).impl });
  await assertRejects(() => rail({ quote: "q" }).createInvoice({ sats: 10, memo: "m", idempotencyKey: "k" }), RailError);
  await assertRejects(() => rail({ request: "lnbc" }).createInvoice({ sats: 10, memo: "m", idempotencyKey: "k" }), RailError);
});

Deno.test("createInvoice falls back to a local TTL when the mint omits expiry", async () => {
  const now = () => 1_700_000_000_000;
  const { impl } = mint({ quote: { quote: "q", request: "lnbc" } });
  const rail = new CashuRail({ baseUrl: "https://mint.example", fetchImpl: impl, now, defaultTtlSeconds: 600 });
  const inv = await rail.createInvoice({ sats: 10, memo: "m", idempotencyKey: "k" });
  assertEquals(inv.expiresAt, new Date(now() + 600_000).toISOString());
});

Deno.test("createInvoice surfaces an http error and an unreachable mint as RailError", async () => {
  const bad = new CashuRail({ baseUrl: "https://mint.example", fetchImpl: mint({ quoteStatus: 503 }).impl });
  await assertRejects(() => bad.createInvoice({ sats: 10, memo: "m", idempotencyKey: "k" }), RailError);
  const dead = new CashuRail({ baseUrl: "https://mint.example", fetchImpl: mint({ throws: true }).impl });
  await assertRejects(() => dead.createInvoice({ sats: 10, memo: "m", idempotencyKey: "k" }), RailError);
});

Deno.test("a rail with no base url cannot be constructed", () => {
  let threw = false;
  try { new CashuRail({ baseUrl: "  " }); } catch { threw = true; }
  assertEquals(threw, true);
});

// --- settlement mapping (the ADR-0008 gate's input) ------------------------

Deno.test("checkSettlement maps UNPAID->pending, PAID->settled, ISSUED->settled", async () => {
  const rail = (state: string) =>
    new CashuRail({ baseUrl: "https://mint.example", fetchImpl: mint({ status: { state } }).impl });
  assertEquals(await rail("UNPAID").checkSettlement("q"), "pending");
  assertEquals(await rail("PAID").checkSettlement("q"), "settled");
  assertEquals(await rail("ISSUED").checkSettlement("q"), "settled");
});

Deno.test("checkSettlement reports an expired unpaid quote as expired", async () => {
  const now = () => 2_000 * 1000; // expiry below is 1000s => in the past
  const rail = new CashuRail({
    baseUrl: "https://mint.example",
    fetchImpl: mint({ status: { state: "UNPAID", expiry: 1000 } }).impl,
    now,
  });
  assertEquals(await rail.checkSettlement("q"), "expired");
});

Deno.test("checkSettlement never treats an unknown state as settled", async () => {
  const rail = new CashuRail({
    baseUrl: "https://mint.example",
    fetchImpl: mint({ status: { state: "WEIRD" } }).impl,
  });
  await assertRejects(() => rail.checkSettlement("q"), RailError);
});

// --- FakeRail -------------------------------------------------------------

Deno.test("FakeRail invoices are pending until settled, then settled", async () => {
  const rail = new FakeRail();
  const inv = await rail.createInvoice({ sats: 5022, memo: "o", idempotencyKey: "k" });
  assertEquals(inv.bolt11.length > 0, true);
  assertEquals(await rail.checkSettlement(inv.quoteId), "pending");
  rail.setStatus(inv.quoteId, "settled");
  assertEquals(await rail.checkSettlement(inv.quoteId), "settled");
});

// --- railFromEnv: fail closed --------------------------------------------

Deno.test("railFromEnv returns null when CASHU_MINT_URL is unset or blank", () => {
  assertEquals(railFromEnv({ get: () => undefined }), null);
  assertEquals(railFromEnv({ get: () => "   " }), null);
  const r = railFromEnv({ get: () => "https://mint.example" });
  assertEquals(r?.name, "cashu");
});

// --- QR: must be self-contained so <img src> needs no second fetch --------

Deno.test("qrDataUri returns a self-contained data: URI", async () => {
  const uri = await qrDataUri("lnbc5000n1real");
  assertEquals(uri.startsWith("data:image/svg+xml;base64,"), true, `got ${uri.slice(0, 40)}`);
  const svg = atob(uri.split(",")[1]);
  assertEquals(svg.includes("<svg"), true, "decodes to real svg");
  await assertRejects(() => qrDataUri(""), RailError);
});
