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

export interface Blinded {
  /** The blinded message B = Y + r*G, 33 compressed bytes, hex on the wire. */
  B: Uint8Array;
  /** The blinding factor. MUST stay client-side until the proof is built. */
  r: bigint;
  secret: Uint8Array;
}

/** Step 1 (client): blind the secret so the mint signs without seeing it. */
export function blindMessage(secret: Uint8Array, r?: bigint): Blinded {
  const Y = hashToCurve(secret);
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
    secret: Buffer.from(secret).toString("hex"),
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
