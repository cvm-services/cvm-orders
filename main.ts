import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { type Order, type OrderInvoice, type OrderState, OrderStore, type Receipt } from "./src/store.ts";
import { serveOptions } from "./src/serve_options.ts";
import { assertNoCardMaterial, CardMaterialRefused } from "./src/hygiene.ts";
import { CashuRail, type PaymentRail, qrDataUri, RailError, RailUnavailableError, railFromEnv } from "./src/rail.ts";
import { resolveMintUrl } from "./src/mints.ts";
import { type Catalog, CatalogRefusal, loadCatalog, priceOrder } from "./src/catalog.ts";
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
  /**
   * Payment rail. `undefined` => resolved lazily from the environment
   * (CASHU_MINT_URL, else config/mint.json) on the first invoice request;
   * `null` => explicitly no rail, so the invoice endpoint fails closed with 503.
   * Tests inject a FakeRail and never touch the network.
   */
  rail?: PaymentRail | null;
  /**
   * Venue catalog. `undefined` => loaded lazily from config/venues.json;
   * `null` => no catalog, so POST /orders fails closed with 503 instead of
   * pricing anything from the request body.
   */
  catalog?: Catalog | null;
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
  if (name === "CatalogRefusal") return 400;
  if (name === "RailUnavailableError") return 503;
  if (name === "RailError") return 502;
  return 400;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "bad request";

/** The invoice body the shipped PWA requires: BOTH fields non-empty, or it throws. */
function invoiceBody(order: Order): Record<string, unknown> {
  return {
    bolt11: order.invoice?.bolt11 ?? "",
    qr: order.invoice?.qr ?? "",
    expires_at: order.invoice?.expiresAt ?? null,
    total: order.total ?? null,
  };
}

export function createRoute(deps: RouteDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? nowSeconds;
  const auth = {
    facilitatorPubkey: deps.facilitatorPubkey,
    challenges: deps.challenges,
    allowChallengeCredential: deps.allowChallengeCredential,
    now,
  };

  // Lazy, per-process resolution of the two external services. Discovery is an
  // operational step (src/mints.ts), never a request-path dependency: it happens
  // once, here, on the first request that needs it.
  let railCache: PaymentRail | null | undefined;
  let catalogCache: Catalog | null | undefined;

  async function railFor(): Promise<PaymentRail | null> {
    if (deps.rail !== undefined) return deps.rail;
    if (railCache === undefined) {
      const url = await resolveMintUrl();
      railCache = url ? new CashuRail({ baseUrl: url }) : null;
    }
    return railCache;
  }

  async function catalogFor(): Promise<Catalog | null> {
    if (deps.catalog !== undefined) return deps.catalog;
    if (catalogCache === undefined) {
      try {
        catalogCache = await loadCatalog();
      } catch {
        catalogCache = null;
      }
    }
    return catalogCache;
  }

  /**
   * Ask the rail what the mint says about this order's invoice. `unavailable`
   * is not a verdict: an unreachable mint, an unconfigured rail or an order with
   * no invoice can never be read as "settled".
   */
  async function settlementVerdict(order: Order): Promise<"pending" | "settled" | "expired" | "unavailable"> {
    if (!order.invoice) return "unavailable";
    const rail = await railFor();
    if (!rail) return "unavailable";
    try {
      return await rail.checkSettlement(order.invoice.quoteId);
    } catch {
      return "unavailable";
    }
  }

  /**
   * Orders created from an Idempotency-Key, so a client retry (a flaky network,
   * a double-tap on Pay) gets its original order back instead of a second one.
   * Bounded: this is a convenience for retries, not a durable store.
   */
  const idempotency = new Map<string, Record<string, unknown>>();
  const IDEMPOTENCY_LIMIT = 1000;

  /** A credential that is present must be valid, on every order read. */
  function denyBadCredential(req: Request): Response | null {
    if (req.headers.get("authorization") === null) return null;
    const authorized = authorizeRequest(req, auth);
    return authorized.ok ? null : json({ error: authorized.error }, 401);
  }

  return async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,authorization,idempotency-key",
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

    /**
     * The customer's invoice. Created ONCE per order and cached on it: a repeat
     * or concurrent call returns the same bolt11. With no rail configured this
     * is a 503 — never a made-up invoice the customer could pay into the void.
     */
    const invoiceMatch = url.pathname.match(/^\/orders\/([^/]+)\/invoice$/);
    if (invoiceMatch && req.method === "GET") {
      const badCredential = denyBadCredential(req);
      if (badCredential) return badCredential;

      const order = deps.store.get(invoiceMatch[1]);
      if (!order) return json({ error: "not found" }, 404);
      if (order.state === "expired") {
        return json({ error: "the invoice expired", reason: "order_expired" }, 410);
      }
      if (order.invoice) return json(invoiceBody(order));
      if (typeof order.total !== "number" || !Number.isInteger(order.total) || order.total <= 0) {
        return json({ error: "order has no server-computed total", reason: "order_not_priced" }, 409);
      }

      const rail = await railFor();
      if (!rail) {
        return json({
          error: "no payment rail configured",
          reason: "rail_unavailable",
          detail: "set CASHU_MINT_URL or commit a selected mint in config/mint.json",
        }, 503);
      }

      try {
        const updated = await deps.store.ensureInvoice(order.id, async (): Promise<OrderInvoice> => {
          const invoice = await rail.createInvoice({
            sats: order.total as number,
            memo: `cvm-orders ${order.id}`,
            idempotencyKey: order.id,
          });
          return {
            bolt11: invoice.bolt11,
            quoteId: invoice.quoteId,
            expiresAt: invoice.expiresAt,
            qr: await qrDataUri(invoice.bolt11),
          };
        });
        return json(invoiceBody(updated));
      } catch (e) {
        if (e instanceof RailUnavailableError) {
          return json({ error: message(e), reason: "rail_unavailable" }, 503);
        }
        return json({ error: message(e), reason: "rail_error" }, 502);
      }
    }

    const match = url.pathname.match(/^\/orders\/([^/]+)$/);
    if (match && req.method === "GET") {
      // Customer poll (the ordering PWA reads its own order unauthenticated).
      // A credential that is *present* must still be valid — no half-authenticated
      // reads, and no silent downgrade of an expired one.
      const badCredential = denyBadCredential(req);
      if (badCredential) return badCredential;

      let order = deps.store.get(match[1]);
      if (!order) return json({ error: "not found" }, 404);

      // ADR-0008, the automatic half: the rail is the only thing that can move an
      // order out of awaiting_payment here. A settled quote transitions EXACTLY
      // once (the compare-and-set loses on every later poll, which is why the
      // state is checked first), and an expired quote expires the order instead
      // of paying it.
      if (order.state === "awaiting_payment" && order.invoice) {
        const verdict = await settlementVerdict(order);
        if (verdict === "settled" || verdict === "expired") {
          try {
            order = deps.store.transition(order.id, verdict === "settled" ? "paid" : "expired", {
              from: "awaiting_payment",
            });
          } catch {
            // Lost the compare-and-set: another poll already moved it. The
            // current state is the answer, and no second transition happened.
            order = deps.store.get(order.id) ?? order;
          }
        }
      }

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

      // The facilitator's own credential is NOT enough to claim sats arrived.
      // Without a rail verdict of `settled` this call cannot reach `paid`, so the
      // public API has no path into the paid state that skips the rail (ADR-0008).
      if (body.state === "paid") {
        const current = deps.store.get(transition[1]);
        if (!current) return json({ error: "not found" }, 404);
        if (current.state === "awaiting_payment") {
          const verdict = await settlementVerdict(current);
          if (verdict !== "settled") {
            return json({
              error: "refused: an order reaches paid only on a rail-verified settlement (ADR-0008)",
              reason: "settlement_not_verified",
              settlement: verdict,
            }, 402);
          }
        }
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

    // Public by design: the customer's own order, priced server-side. Nothing in
    // the body can set a price (src/catalog.ts reads the catalog, never `amount`),
    // and the order it creates is `awaiting_payment` — never paid.
    if (req.method === "POST" && url.pathname === "/orders") {
      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid json body" }, 400);
      }
      // ADR-0013 before anything is priced or stored.
      try {
        assertNoCardMaterial(body, "order-request");
      } catch (e) {
        return json({ error: message(e) }, statusFor(e));
      }

      const key = req.headers.get("idempotency-key")?.trim();
      if (key) {
        const replayed = idempotency.get(key);
        if (replayed) return json(replayed, 200, { "idempotency-replayed": "true" });
      }

      const catalog = await catalogFor();
      if (!catalog) {
        return json({
          error: "no venue catalog configured",
          reason: "catalog_unavailable",
          detail: "config/venues.json is missing or unreadable",
        }, 503);
      }

      let priced;
      try {
        priced = priceOrder(catalog, body);
      } catch (e) {
        if (e instanceof CatalogRefusal) return json({ error: e.message, reason: e.reason }, 400);
        throw e;
      }

      const inputs = typeof body.inputs === "object" && body.inputs !== null && !Array.isArray(body.inputs)
        ? body.inputs as Record<string, unknown>
        : {};
      const id = crypto.randomUUID();
      const order = deps.store.create(
        id,
        { venue_slug: priced.venue_slug, fulfilment: priced.fulfilment, items: priced.lines, inputs },
        {
          venue_slug: priced.venue_slug,
          items: priced.lines,
          subtotal: priced.subtotal,
          fee: priced.fee,
          total: priced.total,
          fulfilment: priced.fulfilment,
          inputs,
        },
      );

      const response = {
        id,
        state: order.state,
        subtotal: order.subtotal,
        fee: order.fee,
        total: order.total,
        // No invoice exists yet (it is created on the invoice endpoint), so there
        // is no expiry to promise. The invoice call returns the real one.
        expires_at: null,
      };
      if (key) {
        if (idempotency.size >= IDEMPOTENCY_LIMIT) {
          const oldest = idempotency.keys().next().value;
          if (oldest !== undefined) idempotency.delete(oldest);
        }
        idempotency.set(key, response);
      }
      return json(response, 201);
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

/**
 * Module-level wiring: the rail is left `undefined` so it resolves from the
 * environment on first use (CASHU_MINT_URL, else the selected mint in
 * config/mint.json), exactly like `railFromEnv`/`resolveMintUrl` describe.
 */
export const route = createRoute({
  store,
  challenges,
  facilitatorPubkey: facilitatorPubkeyFromEnv(),
  allowChallengeCredential: Deno.env.get("NIP98_STRICT") !== "1",
  ...(Deno.env.get("CASHU_MINT_URL") ? { rail: railFromEnv(Deno.env) } : {}),
});

export { CardMaterialRefused, serveOptions };

if (import.meta.main) serve(route, serveOptions(Deno.env));
