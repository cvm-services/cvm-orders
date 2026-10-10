import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { type OrderState, OrderStore, type Receipt } from "./src/store.ts";
import { assertNoCardMaterial, CardMaterialRefused } from "./src/hygiene.ts";
import {
  CHALLENGE_PATH,
  ChallengeStore,
  encodeNpub,
  InvalidPubkeyError,
  normalizePubkey,
  nowSeconds,
  authorizeRequest,
} from "./src/nip98.ts";

export interface RouteDeps {
  store: OrderStore;
  challenges: ChallengeStore;
  /** FACILITATOR_NPUB normalized to hex; `null` closes every facilitator endpoint. */
  facilitatorPubkey: string | null;
  /** false => request-bound NIP-98 only (NIP98_STRICT=1). */
  allowChallengeCredential?: boolean;
  now?: () => number;
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      ...extraHeaders,
    },
  });
}

function statusFor(error: unknown): number {
  const name = error instanceof Error ? error.name : "";
  if (name === "OrderNotFoundError") return 404;
  if (name === "CardMaterialRefused") return 422;
  if (name === "StaleOrderStateError" || name === "InvalidTransitionError") return 409;
  if (name === "InvalidReceiptError") return 409;
  return 400;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "bad request";

export function createRoute(deps: RouteDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? nowSeconds;
  const auth = {
    facilitatorPubkey: deps.facilitatorPubkey,
    challenges: deps.challenges,
    allowChallengeCredential: deps.allowChallengeCredential,
    now,
  };

  return async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,authorization",
        },
      });
    }

    if (req.method === "GET" && url.pathname === "/health") return json({ ok: true });

    // Public: issues a single-use nonce. Verification of the signed nonce is the
    // server's job (see src/nip98.ts) — this is no longer just a hint.
    if (req.method === "GET" && url.pathname === CHALLENGE_PATH) {
      const challenge = deps.challenges.issue(now());
      return json({
        nonce: challenge.nonce,
        // Hex on purpose: this is the value a NIP-98 event carries in `pubkey`,
        // and what the console compares its signer against.
        facilitatorNpub: deps.facilitatorPubkey,
        facilitatorNpubEncoded: deps.facilitatorPubkey ? encodeNpub(deps.facilitatorPubkey) : null,
        expiresIn: challenge.expiresIn,
        statement: "Sign this nonce to access the facilitator console.",
        u: CHALLENGE_PATH,
        method: "GET",
      });
    }

    // Facilitator only: the paid-work queue is not a public listing.
    if (req.method === "GET" && url.pathname === "/orders/queue") {
      const denied = authorizeRequest(req, auth);
      if (!denied.ok) return json({ error: denied.error }, 401);
      return json({ orders: deps.store.queue() });
    }

    const match = url.pathname.match(/^\/orders\/([^/]+)$/);
    if (match && req.method === "GET") {
      // Customer poll (the ordering PWA reads its own order unauthenticated).
      // A credential that is *present* must still be valid — no half-authenticated
      // reads, and no silent downgrade of an expired one.
      if (req.headers.get("authorization") !== null) {
        const authorized = authorizeRequest(req, auth);
        if (!authorized.ok) return json({ error: authorized.error }, 401);
      }
      const order = deps.store.get(match[1]);
      if (!order) return json({ error: "not found" }, 404);
      // The persisted venue receipt is part of the order from `placed` onward and
      // is returned here; it holds no card material (assertNoCardMaterial refused
      // it on the way in — ADR-0013).
      return json(order);
    }

    if (match && req.method === "POST" && url.pathname.endsWith("/transition")) {
      return json({ error: "invalid path" }, 400);
    }

    const transition = url.pathname.match(/^\/orders\/([^/]+)\/transition$/);
    if (transition && req.method === "POST") {
      // Fail closed BEFORE the body is even read: a bad credential cannot move
      // state, and cannot be distinguished from a good one by side effects.
      const denied = authorizeRequest(req, auth);
      if (!denied.ok) return json({ error: denied.error }, 401);
      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid json body" }, 400);
      }
      try {
        return json(deps.store.transition(transition[1], body.state as OrderState, {
          from: body.from as OrderState | undefined,
          receipt: body.receipt as Receipt | undefined,
        }));
      } catch (e) {
        return json({ error: message(e) }, statusFor(e));
      }
    }

    // Public by design: the paid leg creates the order the customer then polls.
    if (req.method === "POST" && url.pathname === "/orders") {
      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid json body" }, 400);
      }
      try {
        assertNoCardMaterial(body, "order-request");
        return json(deps.store.create(body.id as string, body.payload), 201);
      } catch (e) {
        return json({ error: message(e) }, statusFor(e));
      }
    }

    return json({ error: "not found" }, 404);
  };
}

const store = new OrderStore();
const challenges = new ChallengeStore();

function facilitatorPubkeyFromEnv(): string | null {
  const raw = Deno.env.get("FACILITATOR_NPUB");
  if (!raw) return null;
  try {
    return normalizePubkey(raw);
  } catch (error) {
    // Fail closed, loudly: an unusable key closes facilitator endpoints rather
    // than opening them. The message carries no secret (public key material).
    console.error(
      `FACILITATOR_NPUB unusable (${error instanceof InvalidPubkeyError ? "bad key" : "error"}); facilitator endpoints are closed`,
    );
    return null;
  }
}

export const route = createRoute({
  store,
  challenges,
  facilitatorPubkey: facilitatorPubkeyFromEnv(),
  allowChallengeCredential: Deno.env.get("NIP98_STRICT") !== "1",
});

export { CardMaterialRefused };

if (import.meta.main) serve(route, { port: Number(Deno.env.get("PORT") ?? 8000) });
