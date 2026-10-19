// R1c step 2 — claim ecash for a Minibits quote the treasury ALREADY PAID.
//
// The previous run's pay_invoice timed out on the reply while the broker DID execute
// it (balance moved 20002 -> 19874 = exactly 128 sats). So the mint invoice is paid
// and its ecash is claimable. This resumes from the quote id rather than re-paying —
// re-paying would double-spend real money, so the id is passed in explicitly.
//
// Then it melts back, which is the actual refund proof.

import { CashuRail } from "./src/rail.ts";
import { claimEcash } from "./src/ecash_client.ts";
import { authorizeMelt, type MeltProof } from "./src/melt_authorize.ts";

const MINT = Deno.env.get("R1C_MINT") ?? "https://mint.minibits.cash/Bitcoin";
const QUOTE = Deno.env.get("R1C_QUOTE") ?? "";
const AMOUNT = Number(Deno.env.get("R1C_AMOUNT") ?? "128");
const MELT = Number(Deno.env.get("R1C_MELT") ?? "21");

if (!QUOTE) {
  console.error("R1C_QUOTE (the paid mint quote id) is required — refusing to re-pay");
  Deno.exit(2);
}

const rail = new CashuRail({ baseUrl: MINT });
console.log(`mint: ${MINT}`);
console.log(`quote: ${QUOTE}`);

// The mint is the authority on whether that quote is actually paid.
let state = "unknown";
for (let i = 0; i < 60; i++) {
  state = await rail.checkSettlement(QUOTE);
  if (state === "settled") break;
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`mint says: ${state}`);
if (state !== "settled") {
  console.error("the mint does not consider this quote paid — nothing to claim");
  Deno.exit(4);
}

const claim = await claimEcash({ baseUrl: MINT, quoteId: QUOTE, amount: AMOUNT });
const proofs = claim.proofs as MeltProof[];
console.log(`claimed ${proofs.length} proof(s) totalling ${proofs.reduce((n, p) => n + p.amount, 0)} sats`);

// --- the refund: melt those proofs back out ----------------------------------
const dest = await rail.createInvoice({
  sats: MELT, memo: "r1c refund destination", idempotencyKey: `r1c-dest-${Date.now()}`,
});
const mq = await rail.meltQuote({ request: dest.bolt11, memo: "r1c refund" });
console.log(`melt quote: ${mq.quoteId} state=${mq.state}`);

const keys = await (await fetch(`${MINT}/v1/keys`)).json();
const sat = keys.keysets.find((k: any) => k.unit === "sat") ?? keys.keysets[0];
const ladder = Object.keys(sat.keys).map(Number).sort((a, b) => a - b);

const res = await authorizeMelt({
  baseUrl: MINT,
  quoteId: mq.quoteId,
  amount: MELT,
  feeReserve: 2,
  proofs,
  ladder,
  keysetId: claim.keysetId,
});
console.log(`AUTHORISED. mint state: ${res.state ?? "(none)"} | change outputs: ${res.changeSignatures.length}`);

let verdict: "unpaid" | "pending" | "paid" = "unpaid";
for (let i = 0; i < 60; i++) {
  verdict = await rail.checkMelt(mq.quoteId);
  if (verdict === "paid") break;
  await new Promise((r) => setTimeout(r, 1000));
}

console.log("\n============ R1c RESULT ============");
console.log(`mint:          ${MINT}`);
console.log(`claimed:       ${AMOUNT} sats (already paid by the treasury)`);
console.log(`melted back:   ${MELT} sats`);
console.log(`melt quote:    ${mq.quoteId}`);
console.log(`MINT VERDICT:  ${verdict.toUpperCase()}`);
console.log(verdict === "paid"
  ? "PROVEN: real sats became ecash and were MELTED BACK on the PRODUCTION mint."
  : "NOT PROVEN: the mint did not say PAID.");
Deno.exit(verdict === "paid" ? 0 : 1);
