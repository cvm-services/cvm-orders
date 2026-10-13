/**
 * claimEcash: turn a PAID mint quote into spendable proofs (NUT-04 step 2).
 *
 * This is the call cvm-orders has never made — the reason the customer's sats
 * sit unclaimed. Wire shape per cdk-mintd:
 *
 *   POST /v1/mint/bolt11  { quote: <id>, outputs: [{ amount, B_: <hex> }...] }
 *   -> 200 { signatures: [{ amount, C_: <hex>, id: <keyset id> }...] }
 *
 * The proofs are DERIVED CLIENT-SIDE from the signatures (unblind + construct),
 * then persisted by the caller. Secrets/blinding factors never leave this
 * process; the mint only ever sees B_.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { claimEcash } from "../src/ecash_client.ts";
import { secp256k1 } from "jsr:@noble/curves@1/secp256k1";

/**
 * A REAL-math mint over fake HTTP: signs B^k with per-amount keys and publishes
 * A=G^k, so the client's unblind genuinely reconstructs proofs. These tests pin
 * the wire shapes and sequencing; the math round-trip is exercised for real.
 */
function mintStub(opts: {
  ladder?: number[];
  mintStatus?: number;
  mintBody?: unknown;
} = {}) {
  const ladder = opts.ladder ?? [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
  const calls: { url: string; body?: string }[] = [];

  // A real keyset: sk = deterministic per amount, pk = G^sk.
  const keys = new Map<number, { sk: bigint; pk: Uint8Array }>();
  for (const a of ladder) {
    const sk = BigInt(a + 1); // any valid scalar
    const pk = secp256k1.ProjectivePoint.BASE.multiply(sk).toRawBytes(true);
    keys.set(a, { sk, pk });
  }

  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/v1/mint/bolt11") && init?.method === "POST") {
      if (opts.mintStatus) {
        return Promise.resolve(new Response(JSON.stringify(opts.mintBody ?? {}), { status: opts.mintStatus }));
      }
      const body = JSON.parse(String(init?.body));
      const sigs = (body.outputs as Array<{ amount: number; B_: string }>).map((o) => {
        const k = keys.get(o.amount);
        if (!k) throw new Error(`KEYSET_NOT_FOUND ${o.amount}`);
        const B = secp256k1.ProjectivePoint.fromHex(o.B_);
        const C_ = B.multiply(k.sk).toRawBytes(true);
        return { amount: o.amount, C_: Buffer.from(C_).toString("hex"), id: "00deadbeef" };
      });
      return Promise.resolve(new Response(JSON.stringify({ signatures: sigs }), { status: 200 }));
    }
    if (url.endsWith("/v1/keys") || url.endsWith("/v1/keysets")) {
      const ks: Record<string, string> = {};
      for (const [a, { pk }] of keys) ks[String(a)] = Buffer.from(pk).toString("hex");
      return Promise.resolve(
        new Response(JSON.stringify({ keysets: [{ id: "00deadbeef", unit: "sat", keys: ks }] }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 404 }));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

Deno.test("claimEcash posts the quote + blinded outputs and returns unblinded proofs", async () => {
  const { impl, calls } = mintStub();
  const out = await claimEcash({
    baseUrl: "https://mint.example",
    fetchImpl: impl,
    quoteId: "q-1",
    amount: 1620,
  });

  assertEquals(out.proofs.length, 5, "1620 splits into 5 ladder denominations");
  assertEquals(out.proofs.reduce((p, c) => p + c.amount, 0), 1620);
  // The mint saw ONLY blinded messages and the quote id — never secrets.
  const sent = JSON.parse(calls.find((c) => c.url.endsWith("/v1/mint/bolt11"))!.body!);
  assertEquals(sent.quote, "q-1");
  assertEquals(sent.outputs.length, 5);
  for (const o of sent.outputs) {
    assert(typeof o.B_ === "string" && /^[0-9a-f]{66}$/.test(o.B_), "B_ must be 33-byte compressed hex");
  }
  // Every proof carries the keyset id and a 33-byte C.
  for (const p of out.proofs) {
    assert(/^[0-9a-f]{66}$/.test(p.C), "C must be 33-byte compressed hex");
    assert(/^[0-9a-f]{64}$/.test(p.secret), "secret must be 32-byte hex");
  }
});

Deno.test("claimEcash refuses an amount the keyset cannot express", async () => {
  const { impl, calls } = mintStub({ ladder: [2, 4] }); // evens only
  let threw = false;
  try {
    await claimEcash({ baseUrl: "https://mint.example", fetchImpl: impl, quoteId: "q", amount: 3 });
  } catch {
    threw = true;
  }
  assert(threw, "must refuse before any mint call");
  assertEquals(calls.filter((c) => c.url.endsWith("/v1/mint/bolt11")).length, 0);
});

Deno.test("claimEcash surfaces a mint refusal with the status, not a silent empty", async () => {
  const { impl } = mintStub({ mintStatus: 400, mintBody: { code: 20008, detail: "quote not paid" } });
  let msg = "";
  try {
    await claimEcash({ baseUrl: "https://mint.example", fetchImpl: impl, quoteId: "q", amount: 8 });
  } catch (e) {
    msg = (e as Error).message;
  }
  assert(msg.includes("400"), `must name the status: ${msg}`);
});

Deno.test("claimEcash refuses a mint response with no signatures", async () => {
  const { impl } = mintStub({ mintStatus: 200, mintBody: { signatures: [] } });
  let threw = false;
  try {
    await claimEcash({ baseUrl: "https://mint.example", fetchImpl: impl, quoteId: "q", amount: 8 });
  } catch {
    threw = true;
  }
  assert(threw, "an empty signature set is not a claim");
});
