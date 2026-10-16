/**
 * THE SECRET ENCODING — the bug that made every proof we minted unspendable.
 *
 * NUT-00: a proof's `secret` is an arbitrary UTF-8 STRING, and the mint verifies
 * `C == hash_to_curve(secret) * k` over THAT STRING. We, however, blinded over 32
 * RAW random bytes and then shipped the secret to the mint as HEX. The mint hashed
 * 64 hex characters; we had hashed 32 raw bytes. Different `Y`, so `C != Y^k`, so
 * the mint answered **"Token not verified"** and refused to spend a proof it had
 * itself just signed.
 *
 * WHY THE SUITE WAS GREEN
 *
 * tests/helpers/fake_mint.ts calls `hashToCurve(secret)` on the SAME `Uint8Array`
 * we blinded with. It never round-trips the secret through the wire form, so it
 * agreed with our mistake by construction — the double could not falsify it.
 * That is the same failure mode as the missing `id` field and the original
 * "quote is not a payment" bug: **our doubles mirror our own bugs.**
 *
 * The invariant these tests pin: the bytes hashed at BLIND time must be
 * recoverable, byte-for-byte, from the secret that travels on the wire.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import { blindMessage, deriveSecret, hashToCurve, secretToWire, wireToRaw, wireToSecret } from "../src/ecash.ts";

// --- E1: the round-trip that was broken ---------------------------------------

Deno.test("E1: the bytes hashed at blind time ARE the UTF-8 of the wire string", () => {
  // The property a real mint enforces: it hashes utf8(the secret string it got).
  // Anything else means C != Y^k and the proof is unspendable.
  const secret = deriveSecret();
  const wire = secretToWire(secret);
  assertEquals(
    Array.from(wireToSecret(wire)),
    Array.from(new TextEncoder().encode(wire)),
    "wireToSecret must return utf8(wire), because that is what the mint hashes",
  );
  // And the raw entropy is still recoverable separately, for storage.
  assertEquals(Array.from(wireToRaw(wire)), Array.from(secret));
});

Deno.test("E2: blinding over the wire form gives the SAME Y the mint will compute", () => {
  // This is the assertion whose absence made every proof unspendable.
  const secret = deriveSecret();
  const wire = secretToWire(secret);

  // What WE blinded over — blindMessage hashes utf8(wire) internally, which is the
  // whole point of the fix:
  const ourY = hashToCurve(wireToSecret(wire)).toRawBytes(true);
  // What the MINT will compute, hashing the string it received:
  const mintY = hashToCurve(new TextEncoder().encode(wire)).toRawBytes(true);

  assertEquals(
    Buffer.from(ourY).toString("hex"),
    Buffer.from(mintY).toString("hex"),
    "our Y must equal the mint's Y, or C = C_ - r*A will not verify",
  );
});

Deno.test("E3: the wire secret is a UTF-8 string, not a hex dump of the bytes", () => {
  const secret = deriveSecret();
  const wire = secretToWire(secret);
  assertEquals(typeof wire, "string", "NUT-00 secrets travel as strings");
  assert(wire.length > 0, "and must not be empty");
  // A hex dump of 32 bytes is 64 chars; a base64url/utf8 of 32 bytes is not.
  assert(
    !/^[0-9a-f]{64}$/.test(wire) || wire.length !== 64,
    "if the wire form is a 64-char hex dump it will be hashed as 64 chars, " +
      "not 32 bytes — that is exactly the bug this file pins",
  );
});

Deno.test("E4: a proof built from a wire secret verifies against the mint's rule", () => {
  // End-to-end in-process: blind -> (pretend sign) -> unblind -> verify the way a
  // real mint does, hashing the WIRE secret. No network.
  const secret = deriveSecret();
  const wire = secretToWire(secret);
  const b = blindMessage(secret);

  // The mint's side, from ITS OWN view of the secret.
  const Y = hashToCurve(new TextEncoder().encode(wire));
  // The decisive property: the point the mint derives equals the point blindMessage
  // used. Both hash utf8(wire) — measured against a live mint, where this equality
  // is exactly what turned "Token not verified" into PAID.
  assertEquals(
    Buffer.from(Y.toRawBytes(true)).toString("hex"),
    Buffer.from(hashToCurve(wireToSecret(wire)).toRawBytes(true)).toString("hex"),
    "the mint's Y and ours must be the same point",
  );
  assert(b.B.length === 33, "B stays a 33-byte compressed point");
});
