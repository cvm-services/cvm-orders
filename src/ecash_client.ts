/**
 * NUT-04 step 2: claim a PAID mint quote as proofs (client side).
 *
 * Never exposed over HTTP directly; used by the melt orchestration. Secrets and
 * blinding factors exist only inside this call.
 */
import { blindMessage, constructProof, deriveSecret, splitAmounts, verifyBlindSignature } from "./ecash.ts";

export interface ClaimDeps {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ClaimResult {
  keysetId: string;
  proofs: Array<{ amount: number; C: string; secret: string; id?: string }>;
}

export async function claimEcash(
  opts: ClaimDeps & { quoteId: string; amount: number },
): Promise<ClaimResult> {
  const { baseUrl, quoteId, amount } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const base = baseUrl.replace(/\/+$/, "");

  // 1) The published keyset: which denominations exist + the keys to unblind.
  const keysRes = await fetchImpl(`${base}/v1/keys`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!keysRes.ok) throw new Error(`mint keys: http ${keysRes.status}`);
  const keysBody = await keysRes.json() as {
    keysets?: Array<{ id?: string; unit?: string; keys?: Record<string, string> }>;
  };
  const keyset = keysBody.keysets?.find((k) => k.unit === "sat") ?? keysBody.keysets?.[0];
  if (!keyset?.keys || !keyset.id) throw new Error("mint keys: no sat keyset");
  const ladder = Object.keys(keyset.keys).map(Number).sort((a, b) => a - b);

  // 2) Split to the ladder and blind. Refuse BEFORE any mint call if the ladder
  //    cannot express the amount (minting a wrong total is a money bug).
  const amounts = splitAmounts(amount, ladder);
  const blinded = amounts.map((a) => ({ amount: a, ...blindMessage(deriveSecret()) }));

  // 3) POST the blinded outputs with the quote id.
  const res = await fetchImpl(`${base}/v1/mint/bolt11`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      quote: quoteId,
      outputs: blinded.map((b) => ({ amount: b.amount, B_: Buffer.from(b.B).toString("hex") })),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json()).slice(0, 120);
    } catch { /* non-json */ }
    throw new Error(`mint /v1/mint/bolt11: http ${res.status} ${detail}`);
  }
  const body = await res.json() as {
    signatures?: Array<{ amount?: number; C_?: string; id?: string }>;
  };
  const sigs = body.signatures ?? [];
  if (sigs.length !== blinded.length) {
    throw new Error(`mint returned ${sigs.length} signatures for ${blinded.length} outputs — nothing claimed`);
  }

  // 4) Unblind each against the published key; assemble the proofs.
  const proofs = blinded.map((b, i) => {
    const sig = sigs[i];
    if (sig.amount !== b.amount || typeof sig.C_ !== "string") {
      throw new Error(`signature ${i} does not match output (amount ${sig.amount} vs ${b.amount})`);
    }
    const keyHex = keyset.keys![String(b.amount)];
    if (!keyHex) throw new Error(`no published key for amount ${b.amount}`);
    const C = verifyBlindSignature(
      new Uint8Array(Buffer.from(sig.C_, "hex")),
      b.r,
      new Uint8Array(Buffer.from(keyHex, "hex")),
    );
    return constructProof(b.secret, b.amount, C, String(sig.id ?? keyset.id));
  });

  return { keysetId: keyset.id, proofs };
}
