// R1c — THE MELT-BACK, using proofs already claimed (costs 0 additional sats).
//
// The threshold sweep proved funding works at 8 sats and journalled the claimed
// proofs. This melts THOSE proofs back out, which is the refund leg of the product:
// the customer's sats leaving the platform and arriving as a real Lightning payment.
//
// Using journalled proofs rather than minting again is deliberate: the money is
// already spent, so the audit trail is complete and nothing extra is at risk.
//
// Rules that must not bend:
//   * meltQuote sends NO amount — the mint reads the destination invoice,
//   * only the MINT may say PAID,
//   * an unknown/expired state throws rather than being assumed,
//   * change (NUT-08) is requested so an over-reserved fee is not silently kept.

import { CashuRail } from "./src/rail.ts";
import { authorizeMelt, type MeltProof } from "./src/melt_authorize.ts";
import { FileFundingJournal } from "./src/treasury_fund.ts";

const MINT = Deno.env.get("R1C_MINT") ?? "https://mint.minibits.cash/Bitcoin";
const JOURNAL = Deno.env.get("R1C_JOURNAL") ?? `${Deno.env.get("HOME")}/.hermes/treasury-funding.json`;

const journal = new FileFundingJournal(JOURNAL);
const claimed = journal.pending().filter((r) => r.state === "claimed" || (r.proofs && r.proofs.length > 0));
const all = [...journal.pending()];
// pending() excludes claimed; read the raw store for claimed records too.
const raw = JSON.parse(Deno.readTextFileSync(JOURNAL)) as Array<{
  quoteId: string; amountSats: number; state: string; proofs?: MeltProof[];
}>;
const withProofs = raw.filter((r) => Array.isArray(r.proofs) && r.proofs.length > 0 && r.state === "claimed");

if (withProofs.length === 0) {
  console.error("no claimed proofs in the journal — run the threshold probe first");
  Deno.exit(2);
}

const best = withProofs[withProofs.length - 1];
const proofs = best.proofs!;
const total = proofs.reduce((n, p) => n + p.amount, 0);
console.log(`using quote ${best.quoteId.slice(0, 8)}: ${proofs.length} proof(s), ${total} sats`);
console.log(`mint: ${MINT}\n`);

const rail = new CashuRail({ baseUrl: MINT });

// NUT-05 ACCOUNTING, measured on the real mint:
//   error 11005: "Inputs: 8, Outputs: 7, expected_fee: 2.
//                 Transaction inputs should equal outputs less fee"
// So the melt amount must be total - feeReserve, where feeReserve is the MINT's
// figure from the quote — not a number we assume. Quote a candidate, read the fee,
// and only proceed when the proofs actually cover amount + fee.
let destAmount = 0, dest: Awaited<ReturnType<typeof rail.createInvoice>> | null = null;
let mq: Awaited<ReturnType<typeof rail.meltQuote>> | null = null;

for (let candidate = total - 1; candidate >= 1; candidate--) {
  const inv = await rail.createInvoice({
    sats: candidate, memo: "r1c refund destination", idempotencyKey: `r1c-melt-${candidate}-${Date.now()}`,
  });
  const q = await rail.meltQuote({ request: inv.bolt11, memo: "r1c refund" });
  const fee = q.feeReserve ?? 0;
  if (total >= candidate + fee && total === candidate + fee) {
    destAmount = candidate; dest = inv; mq = q;
    console.log(`destination invoice: ${candidate} sats | fee_reserve: ${fee} | inputs ${total} = outputs ${candidate} + fee ${fee} ✓`);
    break;
  }
  if (total >= candidate + fee) {
    // Over-covered: the mint would want change outputs. Prefer the exact fit, but
    // fall back to the first affordable candidate if no exact one exists.
    destAmount = candidate; dest = inv; mq = q;
    console.log(`destination invoice: ${candidate} sats | fee_reserve: ${fee} | inputs ${total} >= ${candidate + fee} (change via NUT-08)`);
    break;
  }
}
if (!dest || !mq) {
  console.error(`no affordable melt amount from ${total} sats of proofs`);
  Deno.exit(3);
}

const keys = await (await fetch(`${MINT}/v1/keys`)).json();
const sat = keys.keysets.find((k: any) => k.unit === "sat") ?? keys.keysets[0];
const ladder = Object.keys(sat.keys).map(Number).sort((a, b) => a - b);

const res = await authorizeMelt({
  baseUrl: MINT,
  quoteId: mq.quoteId,
  amount: destAmount,
  feeReserve: mq.feeReserve ?? 1,
  proofs,
  ladder,
  keysetId: proofs[0].id ?? sat.id,
});
console.log(`AUTHORISED. state=${res.state ?? "(none)"} change outputs=${res.changeSignatures.length}`);

// Only the mint may say PAID.
let verdict = "unpaid";
for (let i = 0; i < 90; i++) {
  verdict = await rail.checkMelt(mq.quoteId);
  if (verdict === "paid") break;
  await new Promise((r) => setTimeout(r, 1000));
}

console.log("\n============ R1c MELT-BACK ============");
console.log(`mint:         ${MINT}`);
console.log(`proofs:       ${total} sats (already paid for)`);
console.log(`melted:       ${destAmount} sats`);
console.log(`melt quote:   ${mq.quoteId}`);
console.log(`MINT VERDICT: ${verdict.toUpperCase()}`);
console.log(verdict === "paid"
  ? "PROVEN: sats entered as ecash and left as a real Lightning payment on the PRODUCTION mint. The refund leg moves money."
  : "NOT PROVEN: the mint did not say PAID.");
Deno.exit(verdict === "paid" ? 0 : 1);
