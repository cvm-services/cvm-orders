// R1c — the FUNDED refund proof, on the PRODUCTION mint, at 1 sat.
//
// Small on purpose: the CHAIN is what is being proven (treasury pays a real Mint
// invoice -> ecash -> melt back -> mint says PAID), not the size. Fees and NUT-08
// change behave the same at 1 sat as at 128.
//
// It uses fundAndClaim(), which journals the quote id BEFORE paying. If the payment
// times out, the quote survives on disk and resumeClaim() recovers the ecash
// WITHOUT paying twice. That is the defect that stranded 128 sats on 2026-10-18.

import { CashuRail } from "./src/rail.ts";
import { claimEcash } from "./src/ecash_client.ts";
import { authorizeMelt, type MeltProof } from "./src/melt_authorize.ts";
import { NwcLnWallet } from "../cvm-service-kit/src/lnwallet.ts";
import {
  FileFundingJournal,
  fundAndClaim,
  PaymentOutcomeUnknown,
  resumeClaim,
} from "./src/treasury_fund.ts";

const MINT = Deno.env.get("R1C_MINT") ?? "https://mint.minibits.cash/Bitcoin";
const FUND = Number(Deno.env.get("R1C_FUND") ?? "1");   // sats to mint (1 = minimal)
const JOURNAL = Deno.env.get("R1C_JOURNAL") ?? `${Deno.env.get("HOME")}/.hermes/treasury-funding.json`;

if (Deno.env.get("R1C_CONFIRM") !== "yes") {
  console.error("refusing: set R1C_CONFIRM=yes — this spends real sats");
  Deno.exit(2);
}
const nwcUrl = Deno.env.get("NWC_URL") ?? "";
if (!nwcUrl) { console.error("NWC_URL not set"); Deno.exit(2); }

const wallet = new NwcLnWallet(nwcUrl);
const rail = new CashuRail({ baseUrl: MINT });
const journal = new FileFundingJournal(JOURNAL);

const balBefore = await wallet.balanceSats();
console.log(`treasury before: ${balBefore} sats | mint: ${MINT}`);
if (balBefore < FUND + 10) { console.error("treasury too low"); Deno.exit(3); }

// --- 1+2. mint and pay, with the quote journalled BEFORE the payment ---------
const claimFn = async (quoteId: string) => {
  const c = await claimEcash({ baseUrl: MINT, quoteId, amount: FUND });
  return { proofs: c.proofs, keysetId: c.keysetId };
};

let proofs: unknown[] = [];
let keysetId = "";
try {
  const r = await fundAndClaim({ rail, wallet, journal, claim: claimFn, sats: FUND,
    settlementDeadlineMs: 240_000, pollMs: 3_000 });
  proofs = r.proofs;
  keysetId = r.keysetId;
  console.log(`minted + claimed ${FUND} sat (${proofs.length} proof(s))`);
} catch (e) {
  if (e instanceof PaymentOutcomeUnknown) {
    // The money may have moved. Do NOT pay again — ask the mint.
    console.error(`payment outcome unknown: ${e.message}`);
    const resumed = await resumeClaim({ rail, journal, claim: claimFn, quoteId: e.quoteId });
    if (!resumed.claimed) {
      console.error(`could not recover yet (${resumed.reason}) — quote ${e.quoteId} is journalled, rerun to retry recovery (never a new payment)`);
      Deno.exit(5);
    }
    proofs = resumed.proofs;
    keysetId = resumed.keysetId;
    console.log(`RECOVERED ${FUND} sat via resumeClaim without paying again`);
  } else {
    throw e;
  }
}

// --- 3. melt back — the refund leg -------------------------------------------
const meltable = (proofs as MeltProof[]).reduce((n, p) => n + p.amount, 0);
console.log(`proofs total: ${meltable} sats`);

const destAmount = Math.max(1, meltable - 1);
const dest = await rail.createInvoice({
  sats: destAmount, memo: "r1c refund destination", idempotencyKey: `r1c-dest-${Date.now()}`,
});
const mq = await rail.meltQuote({ request: dest.bolt11, memo: "r1c refund" });
console.log(`melt quote ${mq.quoteId} state=${mq.state} (amount ${mq.amount} + fee ${mq.feeReserve})`);

const keys = await (await fetch(`${MINT}/v1/keys`)).json();
const sat = keys.keysets.find((k: any) => k.unit === "sat") ?? keys.keysets[0];
const ladder = Object.keys(sat.keys).map(Number).sort((a, b) => a - b);

// Melt the whole proof set; the mint returns change for the fee reserve (NUT-08).
const res = await authorizeMelt({
  baseUrl: MINT,
  quoteId: mq.quoteId,
  amount: destAmount,
  feeReserve: mq.feeReserve ?? 1,
  proofs: proofs as MeltProof[],
  ladder,
  keysetId,
});
console.log(`AUTHORISED. state=${res.state ?? "(none)"} change=${res.changeSignatures.length}`);

let verdict = "unpaid";
for (let i = 0; i < 60; i++) {
  verdict = await rail.checkMelt(mq.quoteId);
  if (verdict === "paid") break;
  await new Promise((r) => setTimeout(r, 1000));
}
const balAfter = await wallet.balanceSats();

console.log("\n============ R1c RESULT ============");
console.log(`mint:         ${MINT}`);
console.log(`funded:       ${FUND} sat (real, paid by the treasury over NWC)`);
console.log(`melt quote:   ${mq.quoteId}`);
console.log(`MINT VERDICT: ${verdict.toUpperCase()}`);
console.log(`treasury:     ${balBefore} -> ${balAfter} (spent ${balBefore - balAfter} sats)`);
console.log(verdict === "paid"
  ? "PROVEN: real sats became ecash and were MELTED BACK on the production mint."
  : "NOT PROVEN: the mint did not say PAID.");
Deno.exit(verdict === "paid" ? 0 : 1);
