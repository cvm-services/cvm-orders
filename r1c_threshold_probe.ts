// Find the LOWEST amount the treasury rail will actually pay.
//
// MEASURED SO FAR
//   1 sat  -> mint quote issued, payment never landed, mint never settled (cost 0)
//   4 sats -> same (cost 0)
//   128    -> payment LANDED (balance 20002 -> 19874, preimage recorded) (cost 128)
//
// So the threshold is somewhere in (4, 128]. Failed attempts cost NOTHING — the
// balance does not move — so ascending is nearly free: we only pay for the amount
// that works.
//
// Two changes make each attempt fast instead of 60s-silent:
//   1. a SHORT NWC client timeout (the broker never replies to pay_invoice anyway),
//   2. the MINT is polled for settlement, which is the only authority that matters.
//
// Money safety: a quote is journalled before the payment, we never retry a payment,
// and we only claim once the mint says settled. After the sweep, every quote is
// re-checked so a late-landing payment is caught rather than assumed dead.

import { CashuRail } from "./src/rail.ts";
import { claimEcash } from "./src/ecash_client.ts";
import { NwcLnWallet } from "../cvm-service-kit/src/lnwallet.ts";
import { FileFundingJournal } from "./src/treasury_fund.ts";

const MINT = Deno.env.get("R1C_MINT") ?? "https://mint.minibits.cash/Bitcoin";
const JOURNAL = Deno.env.get("R1C_JOURNAL") ?? `${Deno.env.get("HOME")}/.hermes/treasury-funding.json`;
const AMOUNTS = (Deno.env.get("R1C_AMOUNTS") ?? "8,16,32,64").split(",").map(Number);

if (Deno.env.get("R1C_CONFIRM") !== "yes") {
  console.error("refusing: set R1C_CONFIRM=yes");
  Deno.exit(2);
}
const nwcUrl = Deno.env.get("NWC_URL") ?? "";
if (!nwcUrl) { console.error("NWC_URL not set"); Deno.exit(2); }

// Short client timeout: the broker is silent on spends, so waiting 60s buys nothing.
const wallet = new NwcLnWallet(nwcUrl, { timeoutMs: 15_000 });
const rail = new CashuRail({ baseUrl: MINT });
const journal = new FileFundingJournal(JOURNAL);

const balStart = await wallet.balanceSats();
console.log(`treasury start: ${balStart} sats`);
console.log(`sweep: ${AMOUNTS.join(", ")} sats\n`);

type Row = { sats: number; settled: boolean; preimage: string; quote: string; claimed: number };
const rows: Row[] = [];

for (const sats of AMOUNTS) {
  const inv = await rail.createInvoice({ sats, memo: `threshold probe ${sats}`, idempotencyKey: `probe-${sats}-${Date.now()}` });
  journal.begin({ quoteId: inv.quoteId, amountSats: sats, bolt11: inv.bolt11, startedAt: Date.now() });
  process.stdout.write(`${sats} sats: quoting ok, paying... `);

  let preimage = "";
  let silent = false;
  try {
    preimage = (await wallet.payInvoice(inv.bolt11)).preimage;
  } catch {
    silent = true;
  }

  // The mint decides. Poll up to 75s — a payment that lands late still gets caught.
  let settled = false;
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    if ((await rail.checkSettlement(inv.quoteId)) === "settled") { settled = true; break; }
    await new Promise((r) => setTimeout(r, 3_000));
  }

  let claimed = 0;
  if (settled) {
    journal.markPaid(inv.quoteId, preimage || "settled-without-reply");
    const c = await claimEcash({ baseUrl: MINT, quoteId: inv.quoteId, amount: sats });
    journal.markClaimed(inv.quoteId, c.proofs);
    claimed = (c.proofs as { amount: number }[]).reduce((n, p) => n + p.amount, 0);
  }

  console.log(settled ? `SETTLED (claimed ${claimed})` : `not settled${silent ? " (wallet silent)" : ""}`);
  rows.push({ sats, settled, preimage: preimage.slice(0, 12), quote: inv.quoteId, claimed });

  if (settled) break; // lowest working amount found
}

// Final re-check of everything still open, so a late payment is not lost silently.
const balEnd = await wallet.balanceSats();
console.log("\n============ THRESHOLD SWEEP ============");
for (const r of rows) {
  console.log(`${String(r.sats).padStart(4)} sats  ${r.settled ? "WORKS  " : "no     "}  claimed=${r.claimed}  quote=${r.quote.slice(0, 8)}`);
}
console.log(`\ntreasury: ${balStart} -> ${balEnd} (spent ${balStart - balEnd} sats)`);

const winner = rows.find((r) => r.settled);
console.log(winner
  ? `\nLOWEST WORKING AMOUNT: ${winner.sats} sats`
  : `\nNo amount in the sweep settled. Next: try above ${AMOUNTS[AMOUNTS.length - 1]}.`);

// Open quotes worth reconciling later.
const open = rows.filter((r) => !r.settled).map((r) => r.quote);
if (open.length) console.log(`\nunsettled quotes (cost nothing if the mint never settles): ${open.length}`);
Deno.exit(winner ? 0 : 1);
