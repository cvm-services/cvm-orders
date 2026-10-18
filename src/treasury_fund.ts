// Funding an ecash mint through the treasury NWC rail — with the two guarantees
// that the 2026-10-18 incident proved are necessary.
//
// WHAT WENT WRONG, CONCRETELY
//   A harness created a 128-sat Minibits invoice, paid it over NWC, and the client
//   timed out waiting for the reply. The broker HAD executed the payment (balance
//   20002 -> 19874, exactly 128 sats). But the mint quote id was never written to
//   durable storage before the payment left, so the resulting ecash became
//   unclaimable: paid for, no longer addressable. 128 sats stranded.
//
// THE TWO RULES THIS MODULE ENFORCES
//
//   1. PERSIST BEFORE YOU SPEND. `journal.begin()` (which must be durable) runs
//      BEFORE `wallet.payInvoice()`. If the process dies between the two, the
//      recovery path still knows the quote id and can claim what was paid for.
//
//   2. A TIMEOUT IS NOT A FAILURE. `payInvoice` timing out has an UNKNOWN
//      outcome — the broker may well have paid. So:
//        * it surfaces as PaymentOutcomeUnknown carrying the quote id,
//        * it is NEVER auto-retried (that would double-pay),
//        * the recovery path is `resumeClaim`, which asks the MINT whether the
//          quote is settled and claims if so — without ever paying again.
//
// The mint is the authority on whether money arrived. We never infer it.

export interface FundingRecord {
  quoteId: string;
  amountSats: number;
  bolt11: string;
  startedAt: number;
  state: "paying" | "paid" | "claimed";
  preimage?: string;
  proofs?: unknown[];
}

/** Durable by contract: implementations must have written before returning. */
export interface FundingJournal {
  begin(rec: Omit<FundingRecord, "state">): void;
  markPaid(quoteId: string, preimage: string): void;
  markClaimed(quoteId: string, proofs: unknown[]): void;
  get(quoteId: string): FundingRecord | undefined;
}

/** The outcome of a payment is genuinely UNKNOWN — do not retry. */
export class PaymentOutcomeUnknown extends Error {
  constructor(readonly quoteId: string, readonly detail: string) {
    super(
      `payment outcome unknown for quote ${quoteId}: ${detail}. ` +
        `Do NOT retry — the invoice may already be paid. Recover with resumeClaim().`,
    );
    this.name = "PaymentOutcomeUnknown";
  }
}

export interface FundRail {
  createInvoice(o: { sats: number; memo?: string }): Promise<{ quoteId: string; bolt11: string }>;
  checkSettlement(quoteId: string): Promise<"settled" | "unpaid" | "unknown">;
}

export interface FundWallet {
  payInvoice(bolt11: string): Promise<{ preimage: string }>;
}

export type ClaimFn = (
  quoteId: string,
) => Promise<{ proofs: unknown[]; keysetId: string }>;

/**
 * Create an invoice, record it durably, pay it, then claim the ecash.
 * Throws PaymentOutcomeUnknown (quote preserved) if the payment cannot be confirmed.
 */
export async function fundAndClaim(o: {
  rail: FundRail;
  wallet: FundWallet;
  journal: FundingJournal;
  claim: ClaimFn;
  sats: number;
  memo?: string;
  /** How long to wait for the MINT to confirm, when the wallet stays silent. */
  settlementDeadlineMs?: number;
  /** Poll interval while waiting on the mint. */
  pollMs?: number;
}): Promise<{ proofs: unknown[]; keysetId: string }> {
  const inv = await o.rail.createInvoice({ sats: o.sats, memo: o.memo });

  // RULE 1 — durable BEFORE the money moves. This single ordering is the whole
  // difference between "recoverable" and "128 sats gone".
  o.journal.begin({
    quoteId: inv.quoteId,
    amountSats: o.sats,
    bolt11: inv.bolt11,
    startedAt: Date.now(),
  });

  // RULE 3 — THE MINT IS THE AUTHORITY, NOT THE WALLET.
  //
  // Measured on the fleet broker (2026-10-18): pay_invoice publishes NO reply and
  // times out at 60s, while the broker HAS executed the payment. get_balance and
  // lookup_invoice both reply in ~440ms, so the relay and encryption are fine —
  // the broker simply goes quiet on spends.
  //
  // Therefore a silent wallet must not fail the funding. The mint knows whether its
  // own quote was paid, over plain HTTP, and that is the only answer that matters.
  let preimage = "";
  let walletSilent = false;
  try {
    preimage = (await o.wallet.payInvoice(inv.bolt11)).preimage;
  } catch (e) {
    // Unknown outcome: the money may already have moved. Never retry the payment.
    walletSilent = true;
    preimage = `unconfirmed:${String((e as Error)?.message ?? e)}`;
  }

  if (walletSilent) {
    // Wait on the MINT rather than the wallet's reply.
    const deadline = Date.now() + (o.settlementDeadlineMs ?? 120_000);
    const pollMs = o.pollMs ?? 1_000;
    let settled = false;
    while (Date.now() < deadline) {
      if ((await o.rail.checkSettlement(inv.quoteId)) === "settled") {
        settled = true;
        break;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (!settled) {
      // Still unknown. The quote is journalled, so recovery is possible later.
      throw new PaymentOutcomeUnknown(
        inv.quoteId,
        `wallet stayed silent and the mint did not report settled within the ` +
          `deadline. The payment may still land; recover with resumeClaim(), ` +
          `which asks the mint again and never pays twice.`,
      );
    }
  }

  o.journal.markPaid(inv.quoteId, preimage);

  // Poll the mint once more before claiming: a successful wallet reply is not
  // itself proof of settlement, and claiming too early returns an error the caller
  // would misread as a permanent failure.
  const claimDeadline = Date.now() + (o.settlementDeadlineMs ?? 120_000);
  const pollMs = o.pollMs ?? 1_000;
  while ((await o.rail.checkSettlement(inv.quoteId)) !== "settled") {
    if (Date.now() > claimDeadline) {
      throw new PaymentOutcomeUnknown(
        inv.quoteId,
        "payment accepted but the mint never reported the quote settled",
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  const res = await o.claim(inv.quoteId);
  o.journal.markClaimed(inv.quoteId, res.proofs);
  return res;
}

/**
 * Recover a quote whose payment outcome was unknown. NEVER pays.
 * The mint decides whether there is anything to claim.
 */
export async function resumeClaim(o: {
  rail: FundRail;
  journal: FundingJournal;
  claim: ClaimFn;
  quoteId: string;
}): Promise<
  | { claimed: true; proofs: unknown[]; keysetId: string }
  | { claimed: false; reason: "not_settled" | "unknown_quote" }
> {
  const rec = o.journal.get(o.quoteId);
  if (!rec) return { claimed: false, reason: "unknown_quote" };

  const state = await o.rail.checkSettlement(o.quoteId);
  if (state !== "settled") return { claimed: false, reason: "not_settled" };

  const res = await o.claim(o.quoteId);
  o.journal.markClaimed(o.quoteId, res.proofs);
  return { claimed: true, proofs: res.proofs, keysetId: res.keysetId };
}

// ---------------------------------------------------------------------------
// A durable journal on disk. Written atomically (tmp + rename) so a crash cannot
// leave a half-written record — the failure mode we are defending against is
// exactly a crash/timeout mid-flight.
// ---------------------------------------------------------------------------

export class FileFundingJournal implements FundingJournal {
  #path: string;
  #cache: Map<string, FundingRecord> | null = null;

  constructor(path: string) {
    this.#path = path;
  }

  #load(): Map<string, FundingRecord> {
    if (this.#cache) return this.#cache;
    const m = new Map<string, FundingRecord>();
    try {
      const raw = Deno.readTextFileSync(this.#path);
      for (const rec of JSON.parse(raw) as FundingRecord[]) m.set(rec.quoteId, rec);
    } catch {
      // absent or unreadable -> start empty; the journal is a recovery aid, not a
      // ledger of record. The mint remains the authority on settlement.
    }
    this.#cache = m;
    return m;
  }

  #flush(): void {
    const m = this.#load();
    const tmp = `${this.#path}.tmp`;
    Deno.writeTextFileSync(tmp, JSON.stringify([...m.values()], null, 2));
    Deno.renameSync(tmp, this.#path); // atomic
  }

  begin(rec: Omit<FundingRecord, "state">): void {
    const m = this.#load();
    m.set(rec.quoteId, { ...rec, state: "paying" });
    this.#flush();
  }

  markPaid(quoteId: string, preimage: string): void {
    const m = this.#load();
    const r = m.get(quoteId);
    if (r) m.set(quoteId, { ...r, state: "paid", preimage });
    this.#flush();
  }

  markClaimed(quoteId: string, proofs: unknown[]): void {
    const m = this.#load();
    const r = m.get(quoteId);
    if (r) m.set(quoteId, { ...r, state: "claimed", proofs });
    this.#flush();
  }

  get(quoteId: string): FundingRecord | undefined {
    return this.#load().get(quoteId);
  }

  /** Unfinished records — what a recovery run must reconcile. */
  pending(): FundingRecord[] {
    return [...this.#load().values()].filter((r) => r.state !== "claimed");
  }
}
