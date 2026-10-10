/**
 * NIP-98 HTTP auth, verified *here* — the server is the boundary.
 *
 * `GET /auth/challenge` issues a single-use nonce. Every facilitator request
 * carries `authorization: Nostr <base64 event>` (kind 27235) and this module
 * decides whether the call is allowed to touch state:
 *
 *   1. the event must be signed by FACILITATOR_NPUB (real schnorr verification,
 *      not a pubkey string comparison),
 *   2. its `payload` tag must be sha256 of a live challenge nonce,
 *   3. `created_at` must be fresh (within the challenge TTL, no future drift),
 *   4. `u`/`method` must name this request (request-bound credential) or the
 *      challenge endpoint (challenge-bound credential — see below),
 *   5. the nonce is redeemed once; replay is refused.
 *
 * Two credential forms are accepted, because the deployed console (cvm-registry
 * `pr/facilitator-console`) signs the challenge once at sign-in and re-attaches
 * that same event to every call:
 *
 *   (a) request-bound  — `u` = the request URL, `method` = the request method.
 *       One-shot: the nonce is spent by that request.
 *   (b) challenge-bound — `u` = the challenge endpoint, `method` = GET. The
 *       signed event acts as a short-lived credential for the nonce's TTL
 *       (`expiresIn`). One nonce still backs exactly one event, so presenting a
 *       *different* event for the same nonce is refused as replay.
 *
 * `NIP98_STRICT=1` refuses form (b) entirely and requires a fresh request-bound
 * event per call.
 */

import { schnorr } from "jsr:@noble/curves@1/secp256k1";
import { sha256 } from "jsr:@noble/hashes@1/sha256";

export const NIP98_KIND = 27235;
export const AUTH_SCHEME = "nostr ";
export const CHALLENGE_PATH = "/auth/challenge";
/** Tolerated clock drift for `created_at` in the future. */
export const FUTURE_SKEW_SECONDS = 60;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export class InvalidPubkeyError extends Error {
  constructor(value: string) {
    super(`not a facilitator public key (npub1… or 64-char hex): ${value.slice(0, 16)}…`);
    this.name = "InvalidPubkeyError";
  }
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const HEX64 = /^[0-9a-f]{64}$/;

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

/** NIP-01 event id: sha256 of the serialized [0,pubkey,created_at,kind,tags,content]. */
export function canonicalEventId(event: NostrEvent): string {
  return sha256Hex(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]));
}

export function validateEventShape(value: unknown): value is NostrEvent {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  if (typeof e.kind !== "number" || typeof e.created_at !== "number") return false;
  if (typeof e.content !== "string" || typeof e.sig !== "string") return false;
  if (typeof e.pubkey !== "string" || !HEX64.test(e.pubkey)) return false;
  if (typeof e.id !== "string" || !HEX64.test(e.id)) return false;
  if (!/^[0-9a-f]{128}$/.test(e.sig)) return false;
  if (!Array.isArray(e.tags)) return false;
  return e.tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === "string"));
}

/** id must match the event, and the schnorr signature must verify under pubkey. */
export function verifyEventSignature(event: NostrEvent): boolean {
  try {
    if (canonicalEventId(event) !== event.id) return false;
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ bech32 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values: number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GENERATOR[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

/** npub1… (NIP-19) -> 64-char hex pubkey, or null when the string is not one. */
export function decodeNpub(value: string): string | null {
  const lower = value.toLowerCase();
  if (lower !== value) return null;
  if (lower.length < 8 || lower.length > 90) return null;
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length) return null;
  const hrp = lower.slice(0, pos);
  if (hrp !== "npub") return null;
  const data: number[] = [];
  for (const c of lower.slice(pos + 1)) {
    const v = CHARSET.indexOf(c);
    if (v === -1) return null;
    data.push(v);
  }
  if (bech32Polymod(hrpExpand(hrp).concat(data)) !== 1) return null;
  const bytes = convertBits(data.slice(0, -6), 5, 8, false);
  if (!bytes || bytes.length !== 32) return null;
  return bytesToHex(new Uint8Array(bytes));
}

/** Accepts either encoding an operator may put in FACILITATOR_NPUB. */
export function normalizePubkey(value: string): string {
  const trimmed = value.trim();
  if (HEX64.test(trimmed.toLowerCase())) return trimmed.toLowerCase();
  const decoded = decodeNpub(trimmed);
  if (decoded) return decoded;
  throw new InvalidPubkeyError(trimmed);
}

function bech32Checksum(hrp: string, data: number[]): number[] {
  const polymod = bech32Polymod(hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0])) ^ 1;
  return [0, 1, 2, 3, 4, 5].map((i) => (polymod >> (5 * (5 - i))) & 31);
}

/** 64-char hex pubkey -> npub1… (for humans; the wire format is hex). */
export function encodeNpub(hexPubkey: string): string {
  const bytes = [...hexToBytes(hexPubkey)];
  const data = convertBits(bytes, 8, 5, true) ?? [];
  return "npub1" + [...data, ...bech32Checksum("npub", data)].map((d) => CHARSET[d]).join("");
}


/* --------------------------------------------------------------- challenges */

interface NonceRecord {
  nonce: string;
  expiresAt: number;
  /** the only event id that may redeem this nonce (null until first use) */
  usedByEventId: string | null;
  /** set once a request-bound credential spent the nonce: no second request. */
  oneShot: boolean;
}

export interface Challenge {
  nonce: string;
  expiresIn: number;
  expiresAt: number;
}

export class ChallengeStore {
  #ttl: number;
  #nonces = new Map<string, NonceRecord>();
  /** sha256(nonce) -> nonce, so a `payload` tag is an O(1) lookup. */
  #hashes = new Map<string, string>();

  constructor(options: { ttlSeconds?: number } = {}) {
    this.#ttl = Math.max(1, Math.floor(options.ttlSeconds ?? 300));
  }

  get ttlSeconds(): number {
    return this.#ttl;
  }

  get size(): number {
    return this.#nonces.size;
  }

  issue(now: number = nowSeconds()): Challenge {
    const nonce = crypto.randomUUID();
    const expiresAt = now + this.#ttl;
    this.#nonces.set(nonce, { nonce, expiresAt, usedByEventId: null, oneShot: false });
    this.#hashes.set(sha256Hex(nonce), nonce);
    this.sweep(now);
    return { nonce, expiresIn: this.#ttl, expiresAt };
  }

  /** Unexpired record, or undefined (expired records are dropped on sight). */
  live(nonce: string, now: number = nowSeconds()): NonceRecord | undefined {
    const record = this.#nonces.get(nonce);
    if (!record) return undefined;
    if (record.expiresAt <= now) {
      this.#forget(nonce, record);
      return undefined;
    }
    return record;
  }

  /**
   * Single-use redemption, keyed by the `payload` tag (sha256 of the nonce). A
   * nonce backs exactly one event id; a request-bound redemption also spends it
   * outright.
   */
  redeem(
    payloadHash: string,
    eventId: string,
    mode: "request" | "challenge",
    now: number = nowSeconds(),
  ): { ok: true } | { ok: false; error: string } {
    const nonce = this.#hashes.get(payloadHash);
    if (nonce === undefined) {
      return { ok: false, error: "authorization event does not bind a live challenge nonce" };
    }
    const record = this.live(nonce, now);
    if (!record) {
      return { ok: false, error: "authorization event does not bind a live challenge nonce" };
    }
    if (record.usedByEventId !== null && record.usedByEventId !== eventId) {
      return { ok: false, error: "challenge nonce already redeemed by another event (replay)" };
    }
    if (record.oneShot) return { ok: false, error: "challenge nonce already spent (replay)" };
    record.usedByEventId = eventId;
    if (mode === "request") record.oneShot = true;
    return { ok: true };
  }

  #forget(nonce: string, record: NonceRecord): void {
    this.#nonces.delete(nonce);
    this.#hashes.delete(sha256Hex(record.nonce));
  }

  sweep(now: number = nowSeconds()): number {
    let dropped = 0;
    for (const [nonce, record] of [...this.#nonces]) {
      if (record.expiresAt <= now) {
        this.#forget(nonce, record);
        dropped++;
      }
    }
    return dropped;
  }
}

/* ----------------------------------------------------------- verification */

export type Authorized = { ok: true; event: NostrEvent; mode: "request" | "challenge" };
export type Rejected = { ok: false; status: 401; error: string };

const reject = (error: string): Rejected => ({ ok: false, status: 401, error });

export interface AuthConfig {
  /** FACILITATOR_NPUB, normalized to hex. `null` closes every facilitator endpoint. */
  facilitatorPubkey: string | null;
  challenges: ChallengeStore;
  /** false (NIP98_STRICT=1) refuses the challenge-bound credential form. */
  allowChallengeCredential?: boolean;
  now?: () => number;
}

function tagValue(event: NostrEvent, name: string): string | undefined {
  const tag = event.tags.find((t) => t[0] === name);
  return tag?.[1];
}

function base64ToBytes(input: string): Uint8Array | null {
  const normalized = input.trim().replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** `authorization: Nostr <base64 event>` -> event (shape-checked, not yet verified). */
export function parseAuthHeader(header: string | null | undefined): NostrEvent | null {
  if (typeof header !== "string") return null;
  const scheme = header.slice(0, AUTH_SCHEME.length).toLowerCase();
  if (scheme !== AUTH_SCHEME) return null;
  const encoded = header.slice(AUTH_SCHEME.length).trim();
  if (!encoded) return null;
  const bytes = base64ToBytes(encoded);
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  return validateEventShape(parsed) ? parsed : null;
}

function pathOf(value: string): string | null {
  try {
    return new URL(value).pathname;
  } catch {
    return value.startsWith("/") ? value.split("?")[0] : null;
  }
}

/**
 * The service is mounted under `/api/*` on the public vhost (caddy `handle_path`
 * strips that prefix before the reverse proxy), so the console's `u` tag carries
 * `/api/orders/:id/transition` while the service sees `/orders/:id/transition`.
 * A path match is therefore equal-or-`u`-suffix — the host must still be this
 * request's own host, and the event is signed by the facilitator either way.
 */
function pathNames(uPath: string | null, requestPath: string | null): boolean {
  if (uPath === null || requestPath === null) return false;
  if (uPath === requestPath) return true;
  return requestPath.length > 1 && uPath.endsWith(requestPath);
}

/**
 * Fail closed: anything that is not demonstrably a fresh, facilitator-signed,
 * nonce-bearing NIP-98 event for this request is a 401 and no state changes.
 */
export function authorizeRequest(req: Request, config: AuthConfig): Authorized | Rejected {
  const now = (config.now ?? nowSeconds)();
  if (!config.facilitatorPubkey) {
    return reject("facilitator key is not configured; facilitator endpoints are closed");
  }

  const event = parseAuthHeader(req.headers.get("authorization"));
  if (!event) return reject("missing or malformed authorization: Nostr <base64 event>");

  if (event.kind !== NIP98_KIND) return reject(`authorization event must be kind ${NIP98_KIND}`);
  if (event.pubkey.toLowerCase() !== config.facilitatorPubkey) {
    return reject("authorization event is not signed by the facilitator key");
  }
  if (!verifyEventSignature(event)) return reject("invalid authorization signature");

  const age = now - event.created_at;
  if (age > config.challenges.ttlSeconds) return reject("authorization event is stale");
  if (age < -FUTURE_SKEW_SECONDS) return reject("authorization event is not yet valid");

  const payloadTag = tagValue(event, "payload");
  if (!payloadTag) return reject("authorization event is missing the payload (challenge nonce) tag");

  const methodTag = (tagValue(event, "method") ?? "").toUpperCase();
  const uTag = tagValue(event, "u");
  if (!uTag) return reject("authorization event is missing the u tag");

  const requestPath = pathOf(req.url);
  // The service sits behind a reverse proxy, so the public host arrives in Host
  // / X-Forwarded-Host rather than in req.url's origin.
  const hosts = new Set(
    [new URL(req.url).host, req.headers.get("host"), req.headers.get("x-forwarded-host")]
      .filter((host): host is string => typeof host === "string" && host !== ""),
  );
  const namesThisRequest = (() => {
    if (uTag === req.url) return true;
    if (!pathNames(pathOf(uTag), requestPath)) return false;
    try {
      return hosts.has(new URL(uTag, req.url).host);
    } catch {
      return false;
    }
  })();
  const requestBound = methodTag === req.method.toUpperCase() && namesThisRequest;
  const challengeBound = methodTag === "GET" && pathNames(pathOf(uTag), CHALLENGE_PATH);

  let mode: "request" | "challenge" | null = null;
  if (requestBound) mode = "request";
  else if (challengeBound && config.allowChallengeCredential !== false) mode = "challenge";
  if (mode === null) {
    if (challengeBound) {
      return reject("challenge-bound credential refused: NIP98_STRICT requires a request-bound event");
    }
    return reject("authorization event u/method tags do not name this request");
  }

  const redeemed = config.challenges.redeem(payloadTag, event.id, mode, now);
  if (!redeemed.ok) return reject(redeemed.error);

  return { ok: true, event, mode };
}
