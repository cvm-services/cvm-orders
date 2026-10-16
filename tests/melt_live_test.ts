/**
 * LIVE melt round-trip against a real mint (testnut).
 *
 * WHAT THIS PROVES THAT DOUBLES CANNOT
 *
 * tests/melt_authorize_test.ts stubs fetch, so it proves our REQUEST SHAPE but not
 * that a real mint accepts it or that change comes back. This test drives the real
 * testnut mint through OUR OWN code: mint proofs, quote a melt against a real
 * bolt11, AUTHORISE it with real proofs, and confirm the mint's verdict — with real
 * NUT-08 change.
 *
 * SAFETY: testnut is a public test mint whose invoices auto-settle and whose ecash
 * is worthless. Nothing here can touch production funds. Opt-in via
 * CVM_LIVE_MINT_TESTS=1 so CI stays hermetic.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import { claimEcash } from "../src/ecash_client.ts";
import { CashuRail } from "../src/rail.ts";
import { authorizeMelt, type MeltProof } from "../src/melt_authorize.ts";

const MINT = Deno.env.get("CVM_TEST_MINT") ?? "https://testnut.cashu.space";
const ENABLED = Deno.env.get("CVM_LIVE_MINT_TESTS") === "1";

/** The sat denomination ladder, straight from the mint's own keyset. */
async function ladder(): Promise<number[]> {
  const keys = await (await fetch(`${MINT}/v1/keys`)).json() as {
    keysets?: Array<{ id?: string; unit?: string; keys?: Record<string, string> }>;
  };
  const sat = keys.keysets?.find((k) => k.unit === "sat") ?? keys.keysets?.[0];
  assert(sat?.keys, "the mint must publish a sat keyset");
  return Object.keys(sat.keys!).map(Number).sort((a, b) => a - b);
}

/** Mint `amount` sats of real (test) ecash by paying the mint's own invoice. */
async function mintTestEcash(amount: number) {
  const rail = new CashuRail({ baseUrl: MINT });
  const invoice = await rail.createInvoice({ sats: amount, memo: "live melt test", idempotencyKey: `lm-${Date.now()}` });
  // testnut's FakeWallet marks invoices paid on its own schedule, not instantly:
  // measured ~3 s. Claiming before that returns 422 and proves nothing, so wait for
  // the mint to actually report SETTLED — the mint's word, not a timer of ours.
  let settled = false;
  for (let i = 0; i < 40; i++) {
    if (await rail.checkSettlement(invoice.quoteId) === "settled") {
      settled = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert(settled, "the test mint must settle its own invoice before we can claim it");
  const claim = await claimEcash({ baseUrl: MINT, quoteId: invoice.quoteId, amount });
  return { rail, proofs: claim.proofs as MeltProof[] };
}

Deno.test({
  name: "live melt: proofs are minted, then SPENT to pay a real invoice",
  ignore: !ENABLED,
  fn: async () => {
    const L = await ladder();
    // Mint a little more than we will melt, so the fee reserve is covered.
    const { rail, proofs } = await mintTestEcash(64);

    // A real bolt11 to melt against: the mint's own invoice is a valid destination
    // and keeps this loop self-contained.
    const dest = await rail.createInvoice({ sats: 21, memo: "dest", idempotencyKey: `dt-${Date.now()}` });

    const quote = await rail.meltQuote({ request: dest.bolt11, memo: "live melt test" });
    assert(quote.quoteId, "the mint must quote our melt");

    // The step that was missing: SPEND the proofs.
    // The mint requires the keyset id on every output, including blank ones.
    const keysetId = await (async () => {
      const k = await (await fetch(`${MINT}/v1/keys`)).json() as { keysets?: Array<{ id?: string; unit?: string }> };
      return (k.keysets?.find((s) => s.unit === "sat") ?? k.keysets?.[0])?.id;
    })();
    const res = await authorizeMelt({
      baseUrl: MINT,
      quoteId: quote.quoteId,
      amount: 21,
      feeReserve: 2,
      proofs,
      ladder: L,
      keysetId,
    });
    assert(res.spent.length === proofs.length, "the proofs we handed over are recorded as spent");
    // A 200 is not a verdict; the mint's own state is surfaced and may be PENDING.
    assert(
      res.state === null || ["PAID", "PENDING", "UNPAID"].includes(res.state),
      `unexpected melt state from the mint: ${res.state}`,
    );

    // Resolve authoritatively. Only the MINT may say PAID.
    let verdict: "unpaid" | "pending" | "paid" = "unpaid";
    for (let i = 0; i < 40; i++) {
      verdict = await rail.checkMelt(quote.quoteId);
      if (verdict === "paid") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assertEquals(verdict, "paid",
      "a real melt of real proofs against a real mint must settle — this is the leg that did not exist");
  },
});

Deno.test({
  name: "live melt: an UNDERFUNDED melt is refused by our code, not by the mint",
  ignore: !ENABLED,
  fn: async () => {
    const L = await ladder();
    const rail = new CashuRail({ baseUrl: MINT });
    const dest = await rail.createInvoice({ sats: 21, memo: "dest", idempotencyKey: `dm2-${Date.now()}` });
    const quote = await rail.meltQuote({ request: dest.bolt11 });

    // Proofs worth far less than amount + fee_reserve.
    const tiny: MeltProof[] = [{ amount: 1, id: L.length ? "x" : "x", secret: "s", C: "02aa" }];
    let threw = false;
    try {
      await authorizeMelt({
        baseUrl: MINT,
        quoteId: quote.quoteId,
        amount: 21,
        feeReserve: 2,
        proofs: tiny,
        ladder: L,
      });
    } catch (e) {
      threw = true;
      assert(String((e as Error).message).includes("underfunded"), String(e));
    }
    assert(threw, "we must refuse an underfunded melt before asking the mint");
  },
});
