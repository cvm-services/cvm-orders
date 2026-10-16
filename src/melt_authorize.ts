/**
 * MELT AUTHORISATION — the step that actually spends the sats (R1 fix).
 *
 * WHY THIS FILE EXISTS
 *
 * The refund leg (src/refund.ts) quoted a melt and polled it, and its own tests
 * showed a mint confirming PAID. But nothing anywhere POSTed proofs to
 * /v1/melt/bolt11. The melt therefore quoted and never settled: in production the
 * customer still received nothing. The tests could not catch it because the fake
 * rail set `state = "paid"` by assignment — a legitimate state-machine double, but
 * one written by the same hand as the client, so it never asked "who pays?".
 *
 * NUT-05 has three steps, and only the third moves money:
 *   1. POST /v1/melt/quote/bolt11   -> quote + fee_reserve   (rail.ts, existed)
 *   2. POST /v1/melt/bolt11         -> signatures over the proofs  (THIS FILE)
 *   3. GET  /v1/melt/quote/bolt11/X -> only the mint may say PAID (rail.ts, existed)
 *
 * THE MONEY TRAPS THIS FILE MUST AVOID
 *
 *  * OVERPAY. A melt quote reserves `fee_reserve` sats beyond the invoice amount.
 *    We must hand the mint proofs worth AT LEAST amount + fee_reserve, or the melt
 *    is rejected after the invoice is already committed.
 *  * STRANDED CHANGE. If the actual fee is less than the reserve, the mint returns
 *    CHANGE (NUT-08 blank outputs). If we do not ask for it and keep it, those sats
 *    leave the wallet silently — a slow leak that no state machine reports.
 *  * DOUBLE SPEND. Proofs are bearer money. Once POSTed they may be spent, so a
 *    retry must never re-POST the same proofs; a timeout is "ask the mint", not
 *    "try again".
 *
 * `blankOutputs()` derives NUT-08 blank outputs so change has somewhere to land.
 * The blinding factor is retained by the caller so the value can be unblinded.
 */
import { blindMessage, deriveSecret, splitAmounts } from "./ecash.ts";

/** A Cashu proof, as the mint's API speaks it. */
export interface MeltProof {
  amount: number;
  id: string;
  secret: string;
  C: string;
}

export interface MeltAuthorizeDeps {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface MeltAuthorizeResult {
  /** Proofs the mint accepted and spent. */
  spent: MeltProof[];
  /** Change returned as blind signatures, if we asked for change. */
  changeSignatures: Array<{ amount: number; B_: string; id?: string }>;
  /** The blank-output blinding factors, so the caller can unblind the change. */
  changeBlindings: Array<{ amount: number; r: bigint; secret: Uint8Array }>;
  /** Raw state the mint reported on THIS call, if any. */
  state: string | null;
}

export class MeltAuthorizeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "MeltAuthorizeError";
  }
}

/**
 * NUT-08 blank outputs. The mint may overpay change up to the number of blank
 * outputs we supply; more outputs means less is left behind. We supply one per
 * possible power-of-two remainder plus one, which is the standard heuristic.
 */
export function blankOutputs(
  feeReserve: number,
  ladder: number[],
  keysetId?: string,
): Array<{ amount: number; id?: string; B_: string; r: bigint; secret: Uint8Array }> {
  if (feeReserve <= 0) return [];
  // A binary decomposition of the reserve: the change can be any sum of these.
  const amounts = splitAmounts(feeReserve, ladder);
  // `id` is required per output by cdk-mintd 0.18, same as the mint path.
  const mk = (amount: number) => {
    const secret = deriveSecret();
    const b = blindMessage(secret);
    return { amount, ...(keysetId ? { id: keysetId } : {}), B_: Buffer.from(b.B).toString("hex"), r: b.r, secret };
  };
  const outs = amounts.map((amount) => mk(amount));
  // One extra output of amount 1 covers an exact-fee case where the mint still
  // wants somewhere to send a zero-remainder signature.
  outs.push(mk(1));
  return outs;
}

/** Sum a proof set. Used to prove we cover amount + fee_reserve before spending. */
export function totalOf(proofs: MeltProof[]): number {
  return proofs.reduce((n, p) => n + (Number.isFinite(p.amount) ? p.amount : 0), 0);
}

/**
 * Step 2 of NUT-05: spend `proofs` to pay the invoice behind `quoteId`.
 *
 * Preconditions are checked BEFORE the network call, because a rejected melt
 * after the POST is a worse position than a refusal before it.
 */
export async function authorizeMelt(
  opts: MeltAuthorizeDeps & {
    quoteId: string;
    /** What the mint wants: invoice amount + fee_reserve, from the quote. */
    amount: number;
    feeReserve: number;
    proofs: MeltProof[];
    /** The sat denomination ladder, for blank outputs. */
    ladder: number[];
    /** The keyset id every output must carry (required by cdk-mintd 0.18). */
    keysetId?: string;
  },
): Promise<MeltAuthorizeResult> {
  const { quoteId, amount, feeReserve, proofs } = opts;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15000;

  if (!quoteId) throw new MeltAuthorizeError("melt needs the quote it is paying");
  if (!proofs.length) throw new MeltAuthorizeError("melt needs proofs to spend — nothing to pay with");

  const needed = amount + feeReserve;
  const have = totalOf(proofs);
  if (have < needed) {
    // Refuse rather than hand the mint an underfunded melt: the invoice is already
    // committed at this point, so a rejection here would leave it unpaid AND still
    // owe the fee reserve.
    throw new MeltAuthorizeError(
      `melt underfunded: proofs total ${have} but the quote needs ${needed} ` +
        `(amount ${amount} + fee_reserve ${feeReserve})`,
    );
  }

  // Ask for change so an over-reserved fee is not silently kept by the mint.
  const blanks = blankOutputs(feeReserve, opts.ladder, opts.keysetId);

  const res = await fetchImpl(`${base}/v1/melt/bolt11`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      quote: quoteId,
      inputs: proofs.map((p) => ({ amount: p.amount, id: p.id, secret: p.secret, C: p.C })),
      // `id` is REQUIRED on melt outputs too — the same defect as the mint path,
      // one layer deeper. Without it the real mint answers 400 "Invalid payment
      // request" (measured: no outputs -> PAID; outputs with id -> accepted;
      // outputs without id -> Invalid payment request). blankOutputs() computes the
      // id, so dropping it here was silently discarding it.
      outputs: blanks.map((b) => ({
        amount: b.amount,
        ...(b.id ? { id: b.id } : {}),
        B_: b.B_,
      })),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json()).slice(0, 160);
    } catch { /* non-json body */ }
    // A non-2xx is NOT a licence to retry with the same proofs: the mint may have
    // spent them before failing to answer. The caller must resolve via checkMelt.
    throw new MeltAuthorizeError(`melt /v1/melt/bolt11: http ${res.status} ${detail}`, res.status);
  }

  const body = await res.json() as {
    signatures?: Array<{ amount?: number; C_?: string; id?: string }>;
    state?: string;
    change?: Array<{ amount?: number; C_?: string; id?: string }>;
  };

  // The mint may reply with signatures (NUT-08 change) and/or a state. Both shapes
  // are legal; what is NOT legal is inventing PAID from a 200 alone.
  const raw = body.signatures ?? body.change ?? [];
  const changeSignatures = raw.map((s) => ({
    amount: Number(s.amount ?? 0),
    B_: String(s.C_ ?? ""),
    id: s.id,
  }));

  return {
    spent: proofs,
    changeSignatures,
    changeBlindings: blanks.map((b) => ({ amount: b.amount, r: b.r, secret: b.secret })),
    state: typeof body.state === "string" ? body.state.toUpperCase() : null,
  };
}
