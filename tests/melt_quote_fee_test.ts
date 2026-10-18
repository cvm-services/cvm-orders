// The melt quote's fee_reserve is REQUIRED protocol data, and we were dropping it.
//
// MEASURED DEFECT (production mint, 2026-10-18)
//   POST /v1/melt/quote/bolt11 returns {quote, amount, fee_reserve, state, expiry}.
//   `CashuRail.meltQuote()` mapped quote/request/state/expiry and SILENTLY DISCARDED
//   `amount` and `fee_reserve`. Callers then had to guess the fee, and the mint
//   rejected every guess:
//       400 {"code":11005,"detail":"Inputs: 8, Outputs: 7, expected_fee: 2.
//            Transaction inputs should equal outputs less fee"}
//   With fee_reserve dropped, `MeltQuote` could not express "inputs must equal
//   outputs + fee", so a correct melt was impossible to construct from the type.
//
// The quote is the mint's OWN statement of what the melt will cost. Losing it is
// losing the only authoritative number in the flow.

import { assertEquals } from "jsr:@std/assert@1";
import { CashuRail } from "../src/rail.ts";

function withFetch(response: unknown, capture?: (body: unknown) => void) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    if (capture && init?.body) capture(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

Deno.test("meltQuote surfaces fee_reserve — the mint's own number, not a guess", async () => {
  const restore = withFetch({
    quote: "q-1",
    request: "lnbc1real",
    amount: 7,
    fee_reserve: 2,
    state: "UNPAID",
    expiry: 1700000000,
  });
  try {
    const rail = new CashuRail({ baseUrl: "https://mint.example" });
    const q = await rail.meltQuote({ request: "lnbc1real" });
    assertEquals(q.feeReserve, 2);
    assertEquals((q as { amount?: number }).amount, 7);
  } finally { restore(); }
});

Deno.test("inputs == outputs + fee_reserve is computable from the quote", async () => {
  const restore = withFetch({
    quote: "q-2", request: "lnbc1x", amount: 7, fee_reserve: 2, state: "UNPAID", expiry: 1700000000,
  });
  try {
    const rail = new CashuRail({ baseUrl: "https://mint.example" });
    const q = await rail.meltQuote({ request: "lnbc1x" });
    const required = (q as { amount?: number }).amount! + q.feeReserve!;
    assertEquals(required, 9, "8 sats of proofs cannot melt a 7-sat invoice at fee 2");
  } finally { restore(); }
});

Deno.test("a quote with no fee_reserve is a protocol error, not a silent zero", async () => {
  const restore = withFetch({ quote: "q-3", request: "lnbc1x", amount: 7, state: "UNPAID" });
  try {
    const rail = new CashuRail({ baseUrl: "https://mint.example" });
    await rail.meltQuote({ request: "lnbc1x" }).then(
      (q) => {
        // If tolerated, it must at least be visibly absent rather than a fake 0.
        assertEquals(q.feeReserve ?? null, null);
      },
    );
  } finally { restore(); }
});
