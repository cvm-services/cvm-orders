import { assert, assertEquals } from "jsr:@std/assert@1";
import { nip19 } from "nostr-tools";
import {
  authorizeRequest,
  canonicalEventId,
  ChallengeStore,
  decodeNpub,
  encodeNpub,
  normalizePubkey,
  sha256Hex,
  validateEventShape,
  verifyEventSignature,
  type AuthConfig,
} from "../src/nip98.ts";
import {
  authHeader,
  challengeBoundEvent,
  facilitatorPubkey,
  facilitatorSecret,
  impostorPubkey,
  impostorSecret,
  requestBoundEvent,
  tamperedEvent,
} from "./signing.ts";

const T0 = 1_800_000_000;
const CHALLENGE_URL = "https://orders.example/api/auth/challenge";
const POST_URL = "https://orders.example/orders/o-1/transition";

function config(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    facilitatorPubkey,
    challenges: new ChallengeStore({ ttlSeconds: 300 }),
    now: () => T0,
    ...overrides,
  };
}

function request(url: string, method: string, header?: string): Request {
  return new Request(url, {
    method,
    headers: header ? { authorization: header } : {},
  });
}

Deno.test("npub/hex helpers agree with the reference implementation", () => {
  assertEquals(decodeNpub(nip19.npubEncode(facilitatorPubkey)), facilitatorPubkey);
  assertEquals(encodeNpub(facilitatorPubkey), nip19.npubEncode(facilitatorPubkey));
  assertEquals(normalizePubkey(facilitatorPubkey.toUpperCase()), facilitatorPubkey);
  assertEquals(normalizePubkey(nip19.npubEncode(facilitatorPubkey)), facilitatorPubkey);
  assert(!decodeNpub(facilitatorPubkey), "hex is not an npub");
  // Deterministic corruption: the fixture key is generated per run, so appending
  // a fixed character is a no-op ~1 run in 32 (when the npub already ends in it)
  // and the test would pass without probing anything.
  const npub = nip19.npubEncode(facilitatorPubkey);
  const last = npub.slice(-1);
  assert(!decodeNpub(npub.slice(0, -1) + (last === "q" ? "p" : "q")), "checksum enforced");
  let threw = false;
  try {
    normalizePubkey("not-a-key");
  } catch {
    threw = true;
  }
  assert(threw, "garbage key must be refused");
});

Deno.test("recomputes the NIP-01 event id and verifies a real signature", async () => {
  const nonce = "nonce-1";
  const event = challengeBoundEvent(nonce, CHALLENGE_URL, { created_at: T0 });
  assertEquals(canonicalEventId(event), event.id);
  assert(verifyEventSignature(event));
  assert(!verifyEventSignature({ ...event, content: "x" }), "id mismatch must fail");
  assert(!verifyEventSignature({ ...event, sig: event.sig.replace(/^../, "00") }));
  assert(validateEventShape(event));
  assert(!validateEventShape({ ...event, tags: [["u", 5]] }), "tag shape enforced");
  assert(!validateEventShape({ ...event, sig: "not-hex" }));
  const { id: _dropped, ...withoutId } = event;
  assert(!validateEventShape(withoutId), "id is required");
});

Deno.test("request-bound credential is accepted and the nonce is spent (single use)", () => {
  const challenges = new ChallengeStore({ ttlSeconds: 300 });
  const cfg = config({ challenges });
  const nonce = challenges.issue(T0).nonce;

  const event = requestBoundEvent(nonce, POST_URL, "POST", { created_at: T0 });
  const first = authorizeRequest(request(POST_URL, "POST", authHeader(event)), cfg);
  assert(first.ok, `expected accept, got ${JSON.stringify(first)}`);

  const replay = authorizeRequest(request(POST_URL, "POST", authHeader(event)), cfg);
  assert(!replay.ok, "a spent nonce must not authorize a second request");
  assertEquals(replay.status, 401);
});

Deno.test("the console's challenge-bound credential works for its TTL (documented)", () => {
  const challenges = new ChallengeStore({ ttlSeconds: 300 });
  const cfg = config({ challenges, now: () => T0 + 10 });
  const nonce = challenges.issue(T0).nonce;
  const event = challengeBoundEvent(nonce, CHALLENGE_URL, { created_at: T0 + 10 });
  const header = authHeader(event);

  for (const [url, method] of [
    ["https://orders.example/orders/queue", "GET"],
    [POST_URL, "POST"],
  ] as const) {
    const result = authorizeRequest(request(url, method, header), cfg);
    assert(result.ok, `console credential refused for ${method} ${url}`);
    assertEquals(result.mode, "challenge");
  }
});

Deno.test("strict mode refuses the challenge-bound credential", () => {
  const challenges = new ChallengeStore({ ttlSeconds: 300 });
  const cfg = config({ challenges, allowChallengeCredential: false });
  const nonce = challenges.issue(T0).nonce;
  const challenge = challengeBoundEvent(nonce, CHALLENGE_URL, { created_at: T0 });
  const refused = authorizeRequest(request(POST_URL, "POST", authHeader(challenge)), cfg);
  assert(!refused.ok);
  assertEquals(refused.status, 401);

  const nonce2 = challenges.issue(T0).nonce;
  const bound = requestBoundEvent(nonce2, POST_URL, "POST", { created_at: T0 });
  assert(authorizeRequest(request(POST_URL, "POST", authHeader(bound)), cfg).ok);
});

Deno.test("a nonce backs exactly one event: a second signature is a replay", () => {
  const challenges = new ChallengeStore({ ttlSeconds: 300 });
  const cfg = config({ challenges });
  const nonce = challenges.issue(T0).nonce;
  const first = challengeBoundEvent(nonce, CHALLENGE_URL, { created_at: T0 });
  const second = challengeBoundEvent(nonce, CHALLENGE_URL, { created_at: T0 + 1 });

  assert(authorizeRequest(request(POST_URL, "POST", authHeader(first)), cfg).ok);
  const replay = authorizeRequest(request(POST_URL, "POST", authHeader(second)), cfg);
  assert(!replay.ok, "a differently-signed event for the same nonce is a replay");
  assertEquals(replay.status, 401);
});

Deno.test("nonce expires with the challenge TTL", () => {
  const challenges = new ChallengeStore({ ttlSeconds: 300 });
  const nonce = challenges.issue(T0).nonce;
  const event = challengeBoundEvent(nonce, CHALLENGE_URL, { created_at: T0 + 301 });
  const result = authorizeRequest(
    request(POST_URL, "POST", authHeader(event)),
    config({ challenges, now: () => T0 + 301 }),
  );
  assert(!result.ok);
  assertEquals(result.status, 401);
  assertEquals(challenges.size, 0, "expired nonces are swept");
});

Deno.test("every malformed credential is refused", () => {
  const challenges = new ChallengeStore({ ttlSeconds: 300 });
  const cfg = config({ challenges });
  const nonce = challenges.issue(T0).nonce;
  const cases: Array<[string, Request]> = [
    ["no header", request(POST_URL, "POST")],
    ["empty header", request(POST_URL, "POST", "")],
    ["wrong scheme", request(POST_URL, "POST", `Bearer ${btoa("{}")}`)],
    ["not base64", request(POST_URL, "POST", "Nostr !!!not-base64!!!")],
    ["base64 of junk", request(POST_URL, "POST", `Nostr ${btoa("nope")}`)],
    [
      "signed by another key",
      request(POST_URL, "POST", authHeader(
        challengeBoundEvent(nonce, CHALLENGE_URL, { created_at: T0, secret: impostorSecret }),
      )),
    ],
    [
      "tampered after signing",
      request(POST_URL, "POST", authHeader(tamperedEvent(nonce, CHALLENGE_URL, T0))),
    ],
    [
      "stale",
      request(POST_URL, "POST", authHeader(challengeBoundEvent(nonce, CHALLENGE_URL, { created_at: T0 - 400 }))),
    ],
    [
      "future",
      request(POST_URL, "POST", authHeader(challengeBoundEvent(nonce, CHALLENGE_URL, { created_at: T0 + 120 }))),
    ],
    [
      "unknown nonce",
      request(POST_URL, "POST", authHeader(challengeBoundEvent("never-issued", CHALLENGE_URL, { created_at: T0 }))),
    ],
    [
      "wrong method",
      request(POST_URL, "POST", authHeader(requestBoundEvent(nonce, POST_URL, "DELETE", { created_at: T0 }))),
    ],
    [
      "foreign host, same path",
      request(POST_URL, "POST", authHeader(requestBoundEvent(nonce, "https://evil.example/orders/o-1/transition", "POST", { created_at: T0 }))),
    ],
  ];

  for (const [label, req] of cases) {
    const result = authorizeRequest(req, cfg);
    assert(!result.ok, `${label}: expected 401`);
    assertEquals(result.status, 401, label);
  }
  assert(impostorPubkey !== facilitatorPubkey, "the impostor key is a different key");
});

Deno.test("an unconfigured facilitator key closes every facilitator endpoint", () => {
  const challenges = new ChallengeStore({ ttlSeconds: 300 });
  const nonce = challenges.issue(T0).nonce;
  const event = challengeBoundEvent(nonce, CHALLENGE_URL, { created_at: T0 });
  const result = authorizeRequest(
    request(POST_URL, "POST", authHeader(event)),
    config({ challenges, facilitatorPubkey: null }),
  );
  assert(!result.ok);
  assertEquals(result.status, 401);
});

Deno.test("a request-bound event may target the proxied public host", () => {
  const challenges = new ChallengeStore({ ttlSeconds: 300 });
  const nonce = challenges.issue(T0).nonce;
  const event = requestBoundEvent(
    nonce,
    "https://cvm-pwa.example/api/orders/o-1/transition",
    "POST",
    { created_at: T0 },
  );
  const proxied = new Request("http://127.0.0.1:8000/orders/o-1/transition", {
    method: "POST",
    headers: { authorization: authHeader(event), "x-forwarded-host": "cvm-pwa.example" },
  });
  const result = authorizeRequest(proxied, config({ challenges }));
  assert(result.ok, `expected the forwarded host to satisfy the u tag: ${JSON.stringify(result)}`);
  assertEquals(result.mode, "request");
});
