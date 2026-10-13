/**
 * The NUT-04/NUT-03 ecash layer (Phase A2 of PLAN-pay-with-2fiat).
 *
 * Nothing in cvm-orders has ever CLAIMED the customer's minted sats: the
 * invoice flow mints (NUT-04 quote) and polls, but no blind-signature mint
 * call exists, so the ecash backing a paid order sits unclaimed. Melting
 * (NUT-05, already shipped) requires proofs in hand. This module is that piece.
 *
 * Tests run against a FAKE MINT that implements the real B-DHKE protocol, so
 * the blind-signature math round-trips offline and the wire shapes are pinned.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  blindMessage,
  constructProof,
  deriveSecret,
  splitAmounts,
  verifyBlindSignature,
} from "../src/ecash.ts";
import { FakeCashuMint } from "./helpers/fake_mint.ts";

const KEYSET_LADDER = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];

// --- splitAmounts ----------------------------------------------------------

Deno.test("splitAmounts produces the power-of-2 ladder against the published keyset", () => {
  assertEquals(splitAmounts(1620, KEYSET_LADDER), [1024, 512, 64, 16, 4]);
  assertEquals(splitAmounts(1, KEYSET_LADDER), [1]);
  assertEquals(splitAmounts(2048, KEYSET_LADDER), [2048]);
});

Deno.test("splitAmounts refuses an amount no ladder combination can express", () => {
  // A keyset with only even denominations cannot express 3.
  let threw = false;
  try {
    splitAmounts(3, [2, 4]);
  } catch {
    threw = true;
  }
  assert(threw, "must refuse rather than mint a wrong total");
});

Deno.test("splitAmounts refuses zero/negative/non-integer", () => {
  for (const bad of [0, -1, 1.5, NaN]) {
    let threw = false;
    try {
      splitAmounts(bad, KEYSET_LADDER);
    } catch {
      threw = true;
    }
    assert(threw, `${bad} must be refused`);
  }
});

Deno.test("splitAmounts fills greedily largest-first (fewest proofs to store/verify)", () => {
  const amounts = splitAmounts(300, KEYSET_LADDER);
  assertEquals(amounts, [256, 32, 8, 4]);
  assertEquals(amounts.reduce((a, b) => a + b, 0), 300);
});

// --- the blind-signature round trip against a mint that signs for real -----

Deno.test("B-DHKE round trip: blind, mint-sign, unblind, verify, construct proof", async () => {
  const mint = new FakeCashuMint({ ladder: KEYSET_LADDER });
  const keys = await mint.keys();

  for (const amount of [1, 1620, 300]) {
    const amounts = splitAmounts(amount, KEYSET_LADDER);
    const outputs = amounts.map((a) => {
      const secret = deriveSecret();
      const { B, r } = blindMessage(secret);
      return { amount: a, B, r, secret };
    });

    // The mint signs the blinded messages (it cannot see the secrets).
    const Cs = mint.signOutputs(outputs.map((o) => ({ amount: o.amount, B: o.B })));

    // We unblind; the result must verify against the mint's published key.
    const proofs = outputs.map((o, i) => {
      const C = verifyBlindSignature(Cs[i], o.r, keys[o.amount]);
      return constructProof(o.secret, o.amount, C, "test-keyset");
    });

    assertEquals(proofs.reduce((p, c) => p + c.amount, 0), amount);
    // And the mint itself confirms every proof is ITS valid signature (the
    // fake mint takes raw bytes; decode the hex the proof carries).
    assert(
      mint.verifyProofs(proofs.map((p) => ({
        amount: p.amount,
        secret: new Uint8Array(Buffer.from(p.secret, "hex")),
        C: new Uint8Array(Buffer.from(p.C, "hex")),
      }))),
      `every proof verifies for ${amount}`,
    );
  }
});

Deno.test("a proof made with the WRONG key does not verify", async () => {
  const mint = new FakeCashuMint({ ladder: KEYSET_LADDER });
  const keys = mint.keys();
  const secret = deriveSecret();
  const { B, r } = blindMessage(secret);
  const [C] = mint.signOutputs([{ amount: 8, B }]);
  // Unblind with a DIFFERENT amount's key than the mint used.
  const wrong = verifyBlindSignature(C, r, keys[16]);
  assert(!mint.verifyProofs([{ amount: 16, secret, C: wrong }]));
});

Deno.test("secrets are unique per derivation (never reuse a nonce)", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(Buffer.from(deriveSecret()).toString("hex"));
  assertEquals(seen.size, 200, "a repeated secret is a double-spend vector");
});
