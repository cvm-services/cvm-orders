// HTTP boundary of the facilitator surface: what the *server* verifies, what a
// refused credential is allowed to touch, and what the persisted receipt looks
// like on the wire. The console in cvm-registry is the client this mirrors — the
// sign-in it performs is reproduced here verbatim (challenge-bound credential,
// public origin + the `/api` mount prefix in the `u` tag).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createRoute, type RouteDeps } from "../main.ts";
import { ChallengeStore } from "../src/nip98.ts";
import { type Order, OrderStore } from "../src/store.ts";
import {
  authHeader,
  challengeBoundEvent,
  facilitatorPubkey,
  impostorSecret,
  requestBoundEvent,
} from "./signing.ts";

const T0 = 1_800_000_000;
const ORIGIN = "https://cvm-pwa.example";
/** Exactly what the console signs: the public origin plus the /api mount prefix. */
const CONSOLE_CHALLENGE_URL = `${ORIGIN}/api/auth/challenge`;
const RECEIPT = {
  venue_reference: "#4471",
  ready_at: "18:25",
  paid_with: "card at venue terminal",
  payment_reference: "pi_1AbC",
  captured_at: "2026-10-10T18:20:03.123Z",
};

function app(overrides: Partial<RouteDeps> = {}) {
  const store = new OrderStore();
  const challenges = new ChallengeStore({ ttlSeconds: 300 });
  const deps: RouteDeps = { store, challenges, facilitatorPubkey, now: () => T0, ...overrides };
  return { store, challenges, handle: createRoute(deps) };
}

type Handle = (req: Request) => Promise<Response>;

function post(url: string, body: unknown, header?: string): Request {
  return new Request(url, {
    method: "POST",
    headers: header ? { authorization: header, "content-type": "application/json" } : {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const authed = (url: string, body: unknown, header: string) => post(url, body, header);

/**
 * Seed a rail-SETTLED order, which is now the only way an order is `paid`
 * (ADR-0008: `store.create()` yields `awaiting_payment`, and the route refuses the
 * paid edge without a rail verdict — see tests/invoice_test.ts). These tests are
 * about the facilitator auth surface, not about pricing, so they start from the
 * state the rail would have produced.
 */
function seedPaid(store: OrderStore, id: string): void {
  store.create(id, {});
  store.transition(id, "paid", { from: "awaiting_payment" });
}

/** The console's sign-in: read the challenge, sign it once, reuse the event. */
async function signIn(challenges: ChallengeStore, handle: Handle): Promise<{ header: string }> {
  const res = await handle(new Request(`${ORIGIN}/auth/challenge`));
  assertEquals(res.status, 200);
  const challenge = await res.json() as { nonce: string; expiresIn: number };
  assertEquals(challenge.expiresIn, challenges.ttlSeconds);
  const event = challengeBoundEvent(challenge.nonce, CONSOLE_CHALLENGE_URL, { created_at: T0 });
  return { header: authHeader(event) };
}

Deno.test("the challenge describes what the server will verify, not a hint", async () => {
  const { handle } = app();
  const res = await handle(new Request(`${ORIGIN}/auth/challenge`));
  assertEquals(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert(typeof body.nonce === "string" && body.nonce.length >= 16, "a real nonce is issued");
  assertEquals(body.facilitatorNpub, facilitatorPubkey, "the hex pubkey the event must carry");
  assertEquals(body.u, "/auth/challenge");
  assertEquals(body.method, "GET");
  assertEquals(body.expiresIn, 300, "the nonce TTL the server enforces");
});

Deno.test("an unauthenticated caller can neither read the queue nor move state", async () => {
  const { store, handle } = app();
  seedPaid(store, "o-1");

  assertEquals((await handle(new Request(`${ORIGIN}/orders/queue`))).status, 401);

  // No body at all: the credential is refused before the body is read.
  const bodyless = await handle(new Request(`${ORIGIN}/orders/o-1/transition`, { method: "POST" }));
  assertEquals(bodyless.status, 401);

  const denied = await handle(post(`${ORIGIN}/orders/o-1/transition`, { state: "placing" }));
  assertEquals(denied.status, 401);
  const error = await denied.json() as { error: string };
  assert(error.error.length > 0, "the refusal says why");
  assertEquals(store.get("o-1")?.state, "paid", "no state change without a valid event");

  // Same for a credential that only *looks* like one.
  const forged = await handle(
    post(`${ORIGIN}/orders/o-1/transition`, { state: "placing" }, `Nostr ${btoa("{}")}`),
  );
  assertEquals(forged.status, 401);
  assertEquals(store.get("o-1")?.state, "paid");
});

Deno.test("the console's signed challenge drives the flow and the receipt persists", async () => {
  const { store, challenges, handle } = app();
  const { header } = await signIn(challenges, handle);
  seedPaid(store, "o-2");

  const queue = await handle(new Request(`${ORIGIN}/orders/queue`, { headers: { authorization: header } }));
  assertEquals(queue.status, 200);
  const queued = await queue.json() as { orders: Order[] };
  assertEquals(queued.orders.map((o) => o.id), ["o-2"]);

  const placing = await handle(authed(`${ORIGIN}/orders/o-2/transition`, { state: "placing" }, header));
  assertEquals(placing.status, 200);

  const placed = await handle(authed(
    `${ORIGIN}/orders/o-2/transition`,
    { state: "placed", from: "placing", receipt: RECEIPT },
    header,
  ));
  assertEquals(placed.status, 200);
  const placedBody = await placed.json() as Order;
  assertEquals(placedBody.state, "placed");
  // This is the field the console tests for: present => "persisted server-side".
  assertEquals(placedBody.receipt, RECEIPT);
  assertEquals(store.get("o-2")?.receipt, RECEIPT);

  // Durable and readable on the customer poll, and it survives the last step.
  const polled = await handle(new Request(`${ORIGIN}/orders/o-2`));
  assertEquals(polled.status, 200);
  assertEquals((await polled.json() as Order).receipt, RECEIPT);

  const ready = await handle(authed(`${ORIGIN}/orders/o-2/transition`, { state: "ready" }, header));
  assertEquals(ready.status, 200);
  assertEquals((await ready.json() as Order).receipt, RECEIPT);
});

Deno.test("a request-bound credential authorizes exactly one request", async () => {
  const { store, challenges, handle } = app();
  seedPaid(store, "o-3");

  const url = `${ORIGIN}/orders/o-3/transition`;
  const nonce = challenges.issue(T0).nonce;
  const header = authHeader(requestBoundEvent(nonce, url, "POST", { created_at: T0 }));

  assertEquals((await handle(authed(url, { state: "placing" }, header))).status, 200);
  assertEquals((await handle(authed(url, { state: "placed" }, header))).status, 401);
  assertEquals(store.get("o-3")?.state, "placing", "the replay moved nothing");
});

Deno.test("a credential signed by another key, or for another host, moves nothing", async () => {
  const { store, challenges, handle } = app();
  seedPaid(store, "o-4");
  const url = `${ORIGIN}/orders/o-4/transition`;

  const impostor = authHeader(challengeBoundEvent(challenges.issue(T0).nonce, CONSOLE_CHALLENGE_URL, {
    created_at: T0,
    secret: impostorSecret,
  }));
  assertEquals((await handle(authed(url, { state: "placing" }, impostor))).status, 401);

  const foreignHost = authHeader(
    requestBoundEvent(challenges.issue(T0).nonce, "https://evil.example/orders/o-4/transition", "POST", {
      created_at: T0,
    }),
  );
  assertEquals((await handle(authed(url, { state: "placing" }, foreignHost))).status, 401);

  assertEquals(store.get("o-4")?.state, "paid");
});

Deno.test("a nonce that was never issued is refused at the route", async () => {
  const { store, handle } = app();
  seedPaid(store, "o-5");
  const header = authHeader(challengeBoundEvent(crypto.randomUUID(), CONSOLE_CHALLENGE_URL, {
    created_at: T0,
  }));
  const res = await handle(authed(`${ORIGIN}/orders/o-5/transition`, { state: "placing" }, header));
  assertEquals(res.status, 401);
  assertEquals(store.get("o-5")?.state, "paid");
});

Deno.test("the nonce expires: a stale credential cannot move state", async () => {
  const challenges = new ChallengeStore({ ttlSeconds: 300 });
  const store = new OrderStore();
  // The clock only moves forward for the authorizer, as it would in production.
  const { handle } = app({ store, challenges, now: () => T0 + 301 });
  seedPaid(store, "o-6");
  const header = authHeader(challengeBoundEvent(challenges.issue(T0).nonce, CONSOLE_CHALLENGE_URL, {
    created_at: T0,
  }));
  const res = await handle(authed(`${ORIGIN}/orders/o-6/transition`, { state: "placing" }, header));
  assertEquals(res.status, 401);
  assertEquals(store.get("o-6")?.state, "paid");
});

Deno.test("CARD CUSTODY: card material in a receipt is 422 and changes nothing (ADR-0013)", async () => {
  const { store, challenges, handle } = app();
  const { header } = await signIn(challenges, handle);
  seedPaid(store, "o-7");
  const url = `${ORIGIN}/orders/o-7/transition`;
  assertEquals((await handle(authed(url, { state: "placing" }, header))).status, 200);

  const refused = await handle(authed(url, {
    state: "placed",
    receipt: { venue_reference: "#4471", payment_reference: "4111 1111 1111 1111" },
  }, header));
  assertEquals(refused.status, 422);
  assertEquals(store.get("o-7")?.state, "placing");
  assertEquals(store.get("o-7")?.receipt, undefined);

  // A malformed receipt is a 409, and equally unable to move the order.
  const malformed = await handle(authed(url, { state: "placed", receipt: { ready_at: "18:25" } }, header));
  assertEquals(malformed.status, 409);
  assertEquals(store.get("o-7")?.state, "placing");
});

Deno.test("a stale `from` loses the compare-and-set and moves nothing", async () => {
  const { store, challenges, handle } = app();
  const { header } = await signIn(challenges, handle);
  seedPaid(store, "o-8");
  const url = `${ORIGIN}/orders/o-8/transition`;
  assertEquals((await handle(authed(url, { state: "placing" }, header))).status, 200);

  const lost = await handle(authed(url, { state: "placed", from: "paid", receipt: RECEIPT }, header));
  assertEquals(lost.status, 409);
  assertEquals(store.get("o-8")?.state, "placing");
  assertEquals(store.get("o-8")?.receipt, undefined);
});

Deno.test("a credential that is present but invalid is 401 on the public read too", async () => {
  const { store, handle } = app();
  seedPaid(store, "o-9");

  const half = await handle(new Request(`${ORIGIN}/orders/o-9`, {
    headers: { authorization: `Nostr ${btoa("not-an-event")}` },
  }));
  assertEquals(half.status, 401, "no half-authenticated read");

  assertEquals((await handle(new Request(`${ORIGIN}/orders/o-9`))).status, 200);
  assertEquals((await handle(new Request(`${ORIGIN}/orders/unknown`))).status, 404);
});

Deno.test("an unusable or missing FACILITATOR_NPUB closes the facilitator routes", async () => {
  const { store, handle } = app({ facilitatorPubkey: null });
  seedPaid(store, "o-10");
  const header = authHeader(challengeBoundEvent(crypto.randomUUID(), CONSOLE_CHALLENGE_URL, {
    created_at: T0,
  }));

  assertEquals((await handle(new Request(`${ORIGIN}/orders/queue`, { headers: { authorization: header } }))).status, 401);
  assertEquals((await handle(authed(`${ORIGIN}/orders/o-10/transition`, { state: "placing" }, header))).status, 401);
  assertEquals(store.get("o-10")?.state, "paid");
  // The challenge still answers so the console can explain the misconfiguration.
  const challenge = await handle(new Request(`${ORIGIN}/auth/challenge`));
  assertEquals(challenge.status, 200);
  assertEquals((await challenge.json() as { facilitatorNpub: string | null }).facilitatorNpub, null);
});

Deno.test("over real HTTP: unauthenticated is 401 and a signed call persists the receipt", async () => {
  const { store, handle } = app();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, handle);
  const { port } = server.addr as Deno.NetAddr;
  const base = `http://127.0.0.1:${port}`;
  const headers = { "content-type": "application/json" };

  try {
    seedPaid(store, "o-live");

    const denied = await fetch(`${base}/orders/o-live/transition`, {
      method: "POST",
      headers,
      body: JSON.stringify({ state: "placing" }),
    });
    assertEquals(denied.status, 401);
    assertEquals(store.get("o-live")?.state, "paid", "the socket-level caller moved nothing");

    // Sign-in against the challenge this very server issued, as the console does.
    const challenge = await (await fetch(`${base}/auth/challenge`)).json() as { nonce: string };
    const header = authHeader(challengeBoundEvent(challenge.nonce, CONSOLE_CHALLENGE_URL, { created_at: T0 }));
    const signed = { ...headers, authorization: header };

    assertEquals(
      (await fetch(`${base}/orders/o-live/transition`, {
        method: "POST",
        headers: signed,
        body: JSON.stringify({ state: "placing" }),
      })).status,
      200,
    );
    const placed = await fetch(`${base}/orders/o-live/transition`, {
      method: "POST",
      headers: signed,
      body: JSON.stringify({ state: "placed", from: "placing", receipt: RECEIPT }),
    });
    assertEquals(placed.status, 200);
    assertEquals((await placed.json() as Order).receipt, RECEIPT);

    const polled = await fetch(`${base}/orders/o-live`);
    assertEquals(polled.status, 200);
    assertEquals((await polled.json() as Order).receipt, RECEIPT);
  } finally {
    await server.shutdown();
  }
});
