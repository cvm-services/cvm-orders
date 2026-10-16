/**
 * A mint that implements the REAL B-DHKE protocol, offline.
 *
 * It holds a keyset, signs blinded messages exactly as cdk-mintd does, and
 * verifies proofs with the same check the real mint runs. The point: the math
 * in src/ecash.ts is validated against a counterparty that shares NO code with
 * it — if both sides agree, the protocol steps are right.
 *
 * The mint-side operations are the STANDARD ones (independent of the client
 * library): C_ = B^k, and the proof check C == Y^k where Y = hashToCurve(secret).
 */
import { secp256k1 } from "jsr:@noble/curves@1/secp256k1";
import { sha256 } from "jsr:@noble/hashes@1/sha256";
import { hashToCurve, wireToSecret } from "../../src/ecash.ts";

export interface BlindOutput {
  amount: number;
  B: Uint8Array;
}

export interface FakeProof {
  amount: number;
  /**
   * The WIRE secret: a string, exactly as NUT-00 defines it and as the real mint
   * receives it. It used to be `Uint8Array`, which let this double hash the same
   * bytes we blinded with — so it could never catch a wire/reality mismatch, and
   * every proof we minted stayed unspendable against a real mint ("Token not
   * verified") while the suite stayed green.
   */
  secret: string;
  C: Uint8Array;
}

export class FakeCashuMint {
  readonly #privkeys = new Map<number, bigint>();
  readonly #pubkeys = new Map<number, Uint8Array>();

  constructor(opts: { ladder: number[] }) {
    for (const amount of opts.ladder) {
      // A private key per amount, as real keysets have.
      const sk = bytesToNumberBE(secp256k1.utils.randomPrivateKey());
      this.#privkeys.set(amount, sk);
      this.#pubkeys.set(amount, secp256k1.ProjectivePoint.BASE.multiply(sk).toRawBytes(true));
    }
  }

  /** The published keyset: amount -> 33-byte compressed public key. */
  keys(): Record<number, Uint8Array> {
    return Object.fromEntries([...this.#pubkeys.entries()]);
  }

  /**
   * Sign blinded outputs: C_ = B^k mod n (blinded Diffie-Hellman). The mint
   * never sees the secret or the blinding factor — only B.
   */
  signOutputs(outputs: BlindOutput[]): Uint8Array[] {
    return outputs.map(({ amount, B }) => {
      const k = this.#privkeys.get(amount);
      if (!k) throw new Error(`no key for amount ${amount} (KEYSET_NOT_FOUND)`);
      const Bp = secp256k1.ProjectivePoint.fromHex(Buffer.from(B).toString("hex"));
      return Bp.multiply(k).toRawBytes(true);
    });
  }

  /** The mint's proof check: C == hash_to_curve(secret) * k. */
  verifyProofs(proofs: FakeProof[]): boolean {
    return proofs.every(({ amount, secret, C }) => {
      const k = this.#privkeys.get(amount);
      if (!k) return false;
      // Hash the string the way a REAL mint does: over the UTF-8 bytes of the wire
      // secret. Never re-derive it from anything local — that is what hid the bug.
      const Y = hashToCurve(wireToSecret(secret));
      const expected = Y.multiply(k);
      const got = secp256k1.ProjectivePoint.fromHex(Buffer.from(C).toString("hex"));
      return expected.equals(got);
    });
  }
}

function bytesToNumberBE(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}
