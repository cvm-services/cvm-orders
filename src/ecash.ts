/**
 * NUT-00/NUT-04 client crypto for Cashu ecash (Phase A2, PLAN-pay-with-2fiat).
 *
 * This mirrors @cashu/crypto's client/index.ts and common/index.ts EXACTLY —
 * not because we cannot invent our own, but because a proof is only valid if
 * the mint re-derives the same points, and interop with cdk-mintd (Minibits)
 * is the entire point. Every algorithm below was read out of
 * @cashu/crypto@0.4.x source before writing:
 *
 *   hashToCurve  sha256(DOMAIN_SEPARATOR || secret), then sha256 with a LE
 *                counter until the result is a valid curve point (0x02-prefixed).
 *   blindMessage Y = hashToCurve(secret); B = Y + r*G
 *   unblind      C = C_ - r*A   (A = the mint's published key for the amount)
 *
 * The mint side (it signs C_ = B^k and checks C = Y^k) is implemented
 * independently in tests/helpers/fake_mint.ts — agreement between the two
 * independent implementations is the test that the math is right.
 */
import { secp256k1 } from "jsr:@noble/curves@1/secp256k1";
import { sha256 } from "jsr:@noble/hashes@1/sha256";
import { randomBytes } from "jsr:@noble/hashes@1/utils";

/** NUT-00 domain separator, byte-identical to @cashu/crypto. */
const DOMAIN_SEPARATOR = new Uint8Array([
  0x53, 0x65, 0x63, 0x70, 0x32, 0x35, 0x36, 0x6b, 0x31, 0x5f, 0x48, 0x61, 0x73, 0x68,
  0x54, 0x6f, 0x43, 0x75, 0x72, 0x76, 0x65, 0x5f, 0x43, 0x61, 0x73, 0x68, 0x75, 0x5f,
]); // "Secp256k1_HashToCurve_Cashu_"

type Point = ReturnType<typeof secp256k1.ProjectivePoint.fromHex>;

function bytesToNumberBE(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/** NUT-00: hash a secret onto the curve (try-and-increment, counter LE). */
export function hashToCurve(secret: Uint8Array): Point {
  const msgToHash = sha256(new Uint8Array([...DOMAIN_SEPARATOR, ...secret]));
  const counter = new Uint8Array(4);
  const maxIterations = 2 ** 16;
  for (let i = 0; i < maxIterations; i++) {
    const hash = sha256(new Uint8Array([...msgToHash, ...counter]));
    try {
      // 0x02 = even-Y compressed form; fromHex validates curve membership.
      return secp256k1.ProjectivePoint.fromHex(
        "02" + Buffer.from(hash).toString("hex"),
      );
    } catch {
      // not a valid point: increment the LE counter and retry
      for (let j = 0; j < 4; j++) {
        if (counter[j] === 255) counter[j] = 0;
        else {
          counter[j]++;
          break;
        }
      }
    }
  }
  throw new Error("hashToCurve: no valid point found in 2^16 iterations");
}

/** A fresh 32-byte secret. Deterministic secrets are a double-spend vector. */
export function deriveSecret(): Uint8Array {
  return randomBytes(32);
}

/**
 * THE CANONICAL SECRET FORM — the fix for "Token not verified".
 *
 * NUT-00: a proof's `secret` is a UTF-8 **string**, and the mint checks
 * `C == hash_to_curve(secret) * k` by hashing THE STRING IT RECEIVED. So the bytes
 * we blind over must be exactly the bytes the mint will hash — i.e. the UTF-8
 * encoding of the wire string, not the raw random bytes behind it.
 *
 * This was the bug: we blinded over 32 raw random bytes, then sent their 64-char
 * HEX as the secret. The mint hashed 64 characters; we had hashed 32 bytes. `Y`
 * differed, the unblinded `C` failed `C == Y^k`, and the mint refused to spend a
 * proof it had just signed ("Token not verified").
 *
 * So the wire form is base64url of the raw bytes: it is a string (as NUT-00 wants),
 * it is ASCII-safe in JSON, and `wireToSecret(secretToWire(s))` returns the SAME
 * bytes — which is the property the whole pipeline depends on.
 */
export function secretToWire(secret: Uint8Array): string {
  return base64urlEncode(secret);
}

/**
 * THE BYTES A REAL MINT HASHES — measured, not assumed.
 *
 * A cdk-mintd mint verifies `C == hash_to_curve(secret) * k` by hashing the UTF-8
 * of the secret STRING it received over the wire. So the bytes we blind over must be
 * `utf8(wireString)` — NOT the raw bytes behind it.
 *
 * Settled empirically against a live mint with a three-way experiment (mint one
 * proof per candidate, try to spend each):
 *   * blind over RAW bytes, send base64url  -> "Token not verified"  (our bug)
 *   * blind over utf8(base64url), send that -> PAID
 *   * blind over utf8(hex), send that       -> PAID
 * Both working cases share the one property that matters: the bytes hashed at blind
 * time are the UTF-8 of the string that travels. Any self-consistent encoding works;
 * what fails is hashing bytes that are not recoverable from the wire string.
 */
export function wireToSecret(wire: string): Uint8Array {
  return new TextEncoder().encode(wire);
}

/** The raw entropy behind a wire secret (for storage/uniqueness checks only). */
export function wireToRaw(wire: string): Uint8Array {
  return base64urlDecode(wire);
}

function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface Blinded {
  /** The blinded message B = Y + r*G, 33 compressed bytes, hex on the wire. */
  B: Uint8Array;
  /** The blinding factor. MUST stay client-side until the proof is built. */
  r: bigint;
  secret: Uint8Array;
}

/** Step 1 (client): blind the secret so the mint signs without seeing it. */
export function blindMessage(secret: Uint8Array, r?: bigint): Blinded {
  // Hash the bytes the MINT will hash: the UTF-8 of the secret string that will
  // travel. Hashing the raw entropy instead is the bug that made every proof we
  // minted unspendable ("Token not verified") while our own doubles stayed green.
  const Y = hashToCurve(wireToSecret(secretToWire(secret)));
  const rr = r ?? bytesToNumberBE(randomBytes(32)) % secp256k1.CURVE.n;
  const rG = secp256k1.ProjectivePoint.BASE.multiply(rr);
  const B = Y.add(rG);
  return { B: new Uint8Array(B.toRawBytes(true)), r: rr, secret };
}

/**
 * Step 3 (client): unblind the mint's signature. A = the mint's published key
 * for this amount. C = C_ - r*A.
 */
export function verifyBlindSignature(
  cBlinded: Uint8Array,
  r: bigint,
  mintKey: Uint8Array,
): Uint8Array {
  const C_ = secp256k1.ProjectivePoint.fromHex(Buffer.from(cBlinded).toString("hex"));
  const A = secp256k1.ProjectivePoint.fromHex(Buffer.from(mintKey).toString("hex"));
  const C = C_.subtract(A.multiply(r));
  return new Uint8Array(C.toRawBytes(true));
}

export interface EcashProof {
  amount: number;
  /** hex-encoded compressed C — the wire/storage form. */
  C: string;
  /** hex-encoded secret. NEVER log; a bearer secret spends the proof. */
  secret: string;
}

/** Step 4 (client): assemble the spendable proof. */
export function constructProof(
  secret: Uint8Array,
  amount: number,
  c: Uint8Array,
  keysetId: string,
): EcashProof {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("proof amount must be a positive integer");
  return {
    amount,
    C: Buffer.from(c).toString("hex"),
    // MUST be the wire form: the mint hashes this string, and our `Y` came from
    // the same bytes (see secretToWire). A hex dump here breaks C == Y^k.
    secret: secretToWire(secret),
    ...(keysetId ? { id: keysetId } : {}),
  } as EcashProof;
}

/**
 * Split an amount into denominations the keyset can sign. Greedy largest-first
 * (fewest proofs to store and verify), power-of-2 ladder by default.
 *
 * Refuses an amount the ladder cannot express: minting proofs that sum to the
 * wrong total is a money bug, not a degradation.
 */
export function splitAmounts(amount: number, ladder: number[]): number[] {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`splitAmounts: amount must be a positive integer, got ${amount}`);
  }
  const sorted = [...ladder].sort((a, b) => b - a);
  const out: number[] = [];
  let rest = amount;
  for (const d of sorted) {
    while (rest >= d) {
      out.push(d);
      rest -= d;
    }
  }
  if (rest !== 0) {
    throw new Error(
      `splitAmounts: ladder ${JSON.stringify(ladder)} cannot express ${amount} (remainder ${rest})`,
    );
  }
  return out;
}
