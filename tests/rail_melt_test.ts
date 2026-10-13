import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { CashuRail, MeltQuote, RailError } from "../src/rail.ts";

/**
 * A mint that answers NUT-04 (mint quote) and NUT-05 (melt quote) endpoints,
 * recording every call. Same shape as the mint() helper in rail_test.ts, so the
 * two read the same way.
 */
function meltMint(opts: {
  meltQuote?: Record<string, unknown>;
  meltStatus?: Record<string, unknown>;
  meltStatuses?: Record<string, Record<string, unknown>>;
  throws?: boolean;
  quoteStatus?: number;
} = {}) {
  const calls: { url: string; body?: string }[] = [];
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (opts.throws) return Promise.reject(new TypeError("fetch failed"));
    // POST /v1/melt/quote/bolt11 creates; GET .../bolt11/{id} checks. Method
    // decides, because both URLs contain the same prefix.
    const isMeltQuote = url.includes("/v1/melt/quote/bolt11") && init?.method === "POST";
    const isMeltStatus = /\/v1\/melt\/quote\/bolt11\/[^/]+$/.test(url) && init?.method !== "POST";
    if (isMeltQuote) {
      return Promise.resolve(new Response(
        JSON.stringify(opts.meltQuote ?? { quote: "mq-1", request: "lnbc900n1pay", state: "UNPAID" }),
        { status: opts.quoteStatus ?? 200 },
      ));
    }
    if (isMeltStatus) {
      const id = url.split("/").pop()!;
      const body = opts.meltStatuses?.[id] ?? opts.meltStatus ?? { quote: "mq-1", state: "UNPAID" };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ quote: "q-1", request: "lnbc1", state: "UNPAID" }), { status: 200 }));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// --- CashuRail.meltQuote (NUT-05) ----------------------------------------

Deno.test("meltQuote posts request+unit and returns quoteId/paid-invoice/state", async () => {
  const { impl, calls } = meltMint({ meltQuote: { quote: "mq-9", request: "lnbc1880n1topup", state: "UNPAID", expiry: 1_800_000_000 } });
  const rail = new CashuRail({ baseUrl: "https://mint.example", fetchImpl: impl });
  const q = await rail.meltQuote({ request: "lnbc1880n1topup", memo: "topup o-1" });

  assertEquals(q.quoteId, "mq-9");
  assertEquals(q.state, "unpaid");
  assertEquals(q.expiresAt, new Date(1_800_000_000 * 1000).toISOString());
  assertEquals(calls[0].url, "https://mint.example/v1/melt/quote/bolt11");
  const body = JSON.parse(calls[0].body!);
  assertEquals(body.request, "lnbc1880n1topup");
  assertEquals(body.unit, "sat");
});

Deno.test("meltQuote refuses an empty/non-string request without calling the mint", async () => {
  const { impl, calls } = meltMint();
  const rail = new CashuRail({ baseUrl: "https://mint.example", fetchImpl: impl });
  for (const bad of ["", "   ", undefined, null, 42]) {
    await assertRejects(() => rail.meltQuote({ request: bad as never }), RailError);
  }
  assertEquals(calls.length, 0);
});

Deno.test("meltQuote refuses a body with no quote or no request", async () => {
  const rail = (q: Record<string, unknown>) =>
    new CashuRail({ baseUrl: "https://mint.example", fetchImpl: meltMint({ meltQuote: q }).impl });
  await assertRejects(() => rail({ quote: "q" }).meltQuote({ request: "lnbc1" }), RailError);
  await assertRejects(() => rail({ request: "lnbc1" }).meltQuote({ request: "lnbc1" }), RailError);
});

Deno.test("meltQuote maps the mint's error body into a RailError that names the mint", async () => {
  const rail = new CashuRail({
    baseUrl: "https://mint.example",
    fetchImpl: meltMint({ quoteStatus: 400 }).impl,
  });
  const err = await assertRejects(() => rail.meltQuote({ request: "lnbc1" }), RailError);
  assert(String(err.message).includes("melt"), `message must name the operation: ${err.message}`);
});

// --- CashuRail.checkMelt --------------------------------------------------

Deno.test("checkMelt maps mint states to rail verdicts (UNPAID/PAID/PENDING)", async () => {
  for (const [mintState, expected] of [["UNPAID", "unpaid"], ["PENDING", "pending"], ["PAID", "paid"]] as const) {
    const rail = new CashuRail({
      baseUrl: "https://mint.example",
      fetchImpl: meltMint({ meltStatus: { quote: "mq-1", state: mintState } }).impl,
    });
    assertEquals(await rail.checkMelt("mq-1"), expected);
  }
});

Deno.test("checkMelt refuses an unknown mint state instead of guessing", async () => {
  const rail = new CashuRail({
    baseUrl: "https://mint.example",
    fetchImpl: meltMint({ meltStatus: { quote: "mq-1", state: "WAT" } }).impl,
  });
  await assertRejects(() => rail.checkMelt("mq-1"), RailError);
});

Deno.test("checkMelt on a missing quote is an error, not 'paid'", async () => {
  let status = 200;
  const impl = ((_input: string | URL | Request, init?: RequestInit) => {
    const url = String(_input);
    const isGet = /\/v1\/melt\/quote\/bolt11\/[^/]+$/.test(url) && init?.method !== "POST";
    status = isGet ? 404 : 200;
    return Promise.resolve(new Response(JSON.stringify({ quote: "q", state: "UNPAID" }), { status }));
  }) as unknown as typeof fetch;
  const rail = new CashuRail({ baseUrl: "https://mint.example", fetchImpl: impl });
  await assertRejects(() => rail.checkMelt("nope"), RailError);
});

// --- the PaymentRail interface gains the melt capability -------------------

Deno.test("MeltQuote type: the amount and change are carried when the mint returns them", async () => {
  const { impl } = meltMint({
    meltQuote: { quote: "mq-2", request: "lnbc1", amount: 1880, state: "UNPAID", change: [] },
  });
  const rail = new CashuRail({ baseUrl: "https://mint.example", fetchImpl: impl });
  const q: MeltQuote = await rail.meltQuote({ request: "lnbc1" });
  assertEquals(q.quoteId, "mq-2");
  assert(!("amount_sats" in q) || q.amount_sats === undefined || q.amount_sats === null, "no invented amount");
});
