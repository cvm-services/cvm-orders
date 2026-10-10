/**
 * Test-only signing kit. Uses the reference implementation (nostr-tools) to
 * produce real NIP-98 events, so the verifier under test is checked against
 * signatures it did not generate itself.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { sha256Hex } from "../src/nip98.ts";

export const facilitatorSecret = generateSecretKey();
export const facilitatorPubkey = getPublicKey(facilitatorSecret);
export const impostorSecret = generateSecretKey();
export const impostorPubkey = getPublicKey(impostorSecret);

export interface SignOptions {
  secret?: Uint8Array;
  created_at?: number;
  content?: string;
}

/** Challenge-bound credential: exactly what the deployed console signs at sign-in. */
export function challengeBoundEvent(
  nonce: string,
  challengeUrl: string,
  options: SignOptions = {},
) {
  return finalizeEvent({
    kind: 27235,
    created_at: options.created_at ?? Math.floor(Date.now() / 1000),
    tags: [["u", challengeUrl], ["method", "GET"], ["payload", sha256Hex(nonce)]],
    content: options.content ?? "",
  }, options.secret ?? facilitatorSecret);
}

/** Request-bound credential: names the request it authorizes. */
export function requestBoundEvent(
  nonce: string,
  url: string,
  method: string,
  options: SignOptions = {},
) {
  return finalizeEvent({
    kind: 27235,
    created_at: options.created_at ?? Math.floor(Date.now() / 1000),
    tags: [["u", url], ["method", method], ["payload", sha256Hex(nonce)]],
    content: options.content ?? "",
  }, options.secret ?? facilitatorSecret);
}

export function authHeader(event: unknown): string {
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

/** A signed event first, then mutated afterwards (id no longer matches). */
export function tamperedEvent(nonce: string, challengeUrl: string, created_at: number) {
  const event = challengeBoundEvent(nonce, challengeUrl, { created_at });
  return { ...event, content: "tampered after signing" };
}
