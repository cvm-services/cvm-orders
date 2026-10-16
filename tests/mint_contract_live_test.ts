/**
 * LIVE contract test against the real Minibits mint (NUT-04/NUT-05).
 *
 * WHY THIS EXISTS AND WHY IT MATTERS
 *
 * The refund leg (src/refund.ts) is tested against a FAKE rail that implements the
 * real NUT-05 protocol. A fake that speaks the protocol correctly is a good test
 * double — but it is not proof that our request SHAPE matches a real mint. Every
 * assertion below is one the fake simply cannot falsify, because the fake was
 * written by the same person who wrote the client.
 *
 * This test found a real discrepancy on first contact: a mint quote with
 * `{"amount":"21"}` (STRING) is rejected with `Invalid payment method`, while
 * `{"amount":21}` (NUMBER) succeeds. Our mint path had never been exercised
 * against a real mint. It also confirmed the melt shape is correct.
 *
 * SAFETY: no funds move and none are needed. It reads /v1/info, obtains an INVOICE
 * from the mint (which is free — nothing is paid), quotes a melt against that
 * unpaid invoice, and reads back its status. UNPAID is the expected terminal state
 * here; a melt only proceeds once proofs are supplied, which this test never does.
 *
 * OPT-IN: live network tests do not run by default. Set CVM_LIVE_MINT_TESTS=1.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";

const MINT = Deno.env.get("CASHU_MINT_URL") ?? "https://mint.minibits.cash/Bitcoin";
const ENABLED = Deno.env.get("CVM_LIVE_MINT_TESTS") === "1";

const post = (path: string, body: unknown) =>
  fetch(`${MINT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });

const get = (path: string) =>
  fetch(`${MINT}${path}`, { headers: { accept: "application/json" } });

Deno.test({
  name: "live mint: advertises NUT-04 (mint) and NUT-05 (melt) for bolt11/sat",
  ignore: !ENABLED,
  fn: async () => {
    const info = await (await get("/v1/info")).json();
    const nuts = Object.keys(info.nuts ?? {}).map(Number);
    assert(nuts.includes(4), "NUT-04 (mint) must be served");
    assert(nuts.includes(5), "NUT-05 (melt) must be served — the refund leg depends on it");
    const meltMethods = (info.nuts?.["5"]?.methods ?? []).map((m: { method: string }) => m.method);
    assert(meltMethods.includes("bolt11"), `melt must serve bolt11, got ${meltMethods}`);
    const mintMethods = (info.nuts?.["4"]?.methods ?? []).map((m: { method: string }) => m.method);
    assert(mintMethods.includes("bolt11"), `mint must serve bolt11, got ${mintMethods}`);
  },
});

Deno.test({
  name: "live mint: a mint quote needs a NUMERIC amount (string is rejected)",
  ignore: !ENABLED,
  fn: async () => {
    // The shape our ecash claim path must use. A string amount is refused by
    // cdk-mintd with `Invalid payment method` — a misleading error, and exactly
    // the kind of mismatch only a real mint exposes.
    const numeric = await post("/v1/mint/quote/bolt11", { amount: 21, unit: "sat", method: "bolt11" });
    assertEquals(numeric.status, 200, "numeric amount must be accepted");
    const body = await numeric.json();
    assert(typeof body.request === "string" && body.request.startsWith("lnbc"),
      "the mint must return a real bolt11 we can melt against");
    assert(typeof body.quote === "string" && body.quote.length > 0, "a quote id must come back");

    const stringy = await post("/v1/mint/quote/bolt11", { amount: "21", unit: "sat", method: "bolt11" });
    assert(stringy.status !== 200,
      "a STRING amount is rejected by the real mint — if this ever starts passing, " +
        "re-check every call site for what type it sends");
  },
});

Deno.test({
  name: "live mint: OUR melt request shape is accepted and returns the fields rail.ts reads",
  ignore: !ENABLED,
  fn: async () => {
    // Get a real invoice to quote against (free: nothing is paid).
    const mq = await (await post("/v1/mint/quote/bolt11", { amount: 21, unit: "sat", method: "bolt11" })).json();

    // EXACTLY the body src/rail.ts sends: { request, unit } — no amount, because
    // the mint reads the amount from the invoice itself.
    const res = await post("/v1/melt/quote/bolt11", { request: mq.request, unit: "sat" });
    assertEquals(res.status, 200, "our melt shape must be accepted by the real mint");

    const q = await res.json();
    // These are the exact fields rail.ts consumes.
    assert(typeof q.quote === "string" && q.quote.length > 0,
      "rail.ts requires a string `quote` id");
    assert(typeof q.expiry === "number",
      "rail.ts requires a numeric `expiry` (it converts seconds -> ISO)");
    assert(String(q.state).toUpperCase() === "UNPAID",
      `a freshly quoted melt must be UNPAID, got ${q.state}`);
    assertEquals(q.unit, "sat");
    // The quote must echo the invoice we asked about, or we would be quoting the
    // wrong destination — the failure that would send a refund somewhere else.
    assertEquals(q.request, mq.request, "the quote must reference the invoice we supplied");
  },
});

Deno.test({
  name: "live mint: melt status round-trips, and only the mint may say PAID",
  ignore: !ENABLED,
  fn: async () => {
    const mq = await (await post("/v1/mint/quote/bolt11", { amount: 21, unit: "sat", method: "bolt11" })).json();
    const q = await (await post("/v1/melt/quote/bolt11", { request: mq.request, unit: "sat" })).json();

    const status = await (await get(`/v1/melt/quote/bolt11/${encodeURIComponent(q.quote)}`)).json();
    // checkMelt() maps UNPAID|PENDING|PAID and THROWS on anything else, so an
    // unrecognised state must not appear here.
    const state = String(status.state).toUpperCase();
    assert(["UNPAID", "PENDING", "PAID"].includes(state),
      `checkMelt only understands UNPAID/PENDING/PAID; mint said '${status.state}'`);
    // Unpaid is the honest terminal state for a quote we never funded.
    assertEquals(state, "UNPAID", "we funded nothing, so this must not be PAID");

    // An unknown quote must be a clear failure — never a silent success. The refund
    // leg treats anything other than PAID as "not yet", so a 404/400 is safe; what
    // would be unsafe is the mint inventing a PAID for a quote that does not exist.
    const bogus = await get("/v1/melt/quote/bolt11/00000000-0000-0000-0000-000000000000");
    assert(bogus.status !== 200,
      "an unknown melt quote must not answer 200 — that would let a phantom refund read as settled");
  },
});
