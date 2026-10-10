/**
 * Payment rails: create a BOLT11 invoice for an order, and later prove it was
 * settled. ADR-0008 makes settlement proof the ONLY way an order reaches
 * `paid`, so this module is the gate's source of truth.
 *
 * The rail never sees card data and never holds funds: it asks a Cashu mint for
 * a NUT-04 mint quote, and the customer paying that invoice is what mints the
 * ecash. Nothing here trusts a client.
 */

export interface InvoiceRequest {
  /** Integer sats, already computed server-side. Never a client-supplied price. */
  sats: number;
  memo: string;
  idempotencyKey: string;
}

export interface Invoice {
  bolt11: string;
  quoteId: string;
  expiresAt: string;
}

export type SettlementStatus = "pending" | "settled" | "expired";

export interface PaymentRail {
  readonly name: string;
  createInvoice(req: InvoiceRequest): Promise<Invoice>;
  checkSettlement(quoteId: string): Promise<SettlementStatus>;
}

export class RailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RailError";
  }
}

export class RailUnavailableError extends Error {
  constructor(message = "no payment rail configured") {
    super(message);
    this.name = "RailUnavailableError";
  }
}

export interface CashuRailOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Epoch milliseconds. Injectable so expiry is testable without sleeping. */
  now?: () => number;
  defaultTtlSeconds?: number;
}

/**
 * A real Cashu mint over NUT-04.
 *
 * POST /v1/mint/quote/bolt11 {amount, unit:"sat"} -> {quote, request, state}
 * GET  /v1/mint/quote/bolt11/{quote}            -> {state: UNPAID|PAID|ISSUED}
 *
 * We only ever READ the mint. Minting the ecash happens as a consequence of the
 * customer paying, which is exactly the property ADR-0008 wants.
 */
export class CashuRail implements PaymentRail {
  readonly name = "cashu";
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #ttlSeconds: number;

  constructor(opts: CashuRailOptions) {
    if (!opts.baseUrl || !opts.baseUrl.trim()) throw new RailError("mint base url is required");
    this.#baseUrl = opts.baseUrl.trim().replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 8000;
    this.#now = opts.now ?? (() => Date.now());
    this.#ttlSeconds = opts.defaultTtlSeconds ?? 900;
  }

  async createInvoice(req: InvoiceRequest): Promise<Invoice> {
    // Integer sats only: a fractional or zero amount would ask the mint for
    // something we cannot reconcile against the order total.
    if (!Number.isInteger(req.sats) || req.sats <= 0) {
      throw new RailError(`invoice amount must be a positive integer of sats, got ${req.sats}`);
    }
    const res = await this.#send(`${this.#baseUrl}/v1/mint/quote/bolt11`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ amount: req.sats, unit: "sat" }),
    });
    const body = await this.#readJson(res, "mint quote");
    const bolt11 = body.request;
    const quoteId = body.quote;
    if (typeof bolt11 !== "string" || !bolt11) throw new RailError("mint returned no bolt11");
    if (typeof quoteId !== "string" || !quoteId) throw new RailError("mint returned no quote id");

    const expirySeconds = typeof body.expiry === "number" ? body.expiry : null;
    const expiresAt = new Date(
      expirySeconds !== null ? expirySeconds * 1000 : this.#now() + this.#ttlSeconds * 1000,
    ).toISOString();

    return { bolt11, quoteId, expiresAt };
  }

  async checkSettlement(quoteId: string): Promise<SettlementStatus> {
    const res = await this.#send(
      `${this.#baseUrl}/v1/mint/quote/bolt11/${encodeURIComponent(quoteId)}`,
      { method: "GET", headers: { accept: "application/json" } },
    );
    const body = await this.#readJson(res, "mint quote status");
    const state = String(body.state ?? "").toUpperCase();

    // ISSUED means we already minted the ecash; PAID means the invoice is
    // settled and mintable. Both are "the customer's sats arrived".
    if (state === "ISSUED" || state === "PAID") return "settled";
    if (state === "UNPAID") {
      const expirySeconds = typeof body.expiry === "number" ? body.expiry : null;
      if (expirySeconds !== null && this.#now() >= expirySeconds * 1000) return "expired";
      return "pending";
    }
    // Anything else is not something we may treat as settlement.
    throw new RailError(`unknown mint quote state: ${state || "(empty)"}`);
  }

  async #send(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.#fetch(url, { ...init, signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (e) {
      throw new RailError(`mint unreachable: ${String((e as Error)?.name ?? e)}`);
    }
    if (!res.ok) throw new RailError(`mint returned http ${res.status}`);
    return res;
  }

  async #readJson(res: Response, what: string): Promise<Record<string, unknown>> {
    try {
      const body = await res.json();
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new RailError(`${what}: expected a json object`);
      }
      return body as Record<string, unknown>;
    } catch (e) {
      if (e instanceof RailError) throw e;
      throw new RailError(`${what}: response was not json`);
    }
  }
}

/** Deterministic in-memory rail for tests. Never used in production. */
export class FakeRail implements PaymentRail {
  readonly name = "fake";
  #seq = 0;
  readonly #quotes = new Map<string, { sats: number; status: SettlementStatus }>();
  #now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.#now = opts.now ?? (() => Date.now());
  }

  createInvoice(req: InvoiceRequest): Promise<Invoice> {
    if (!Number.isInteger(req.sats) || req.sats <= 0) {
      return Promise.reject(new RailError(`bad amount: ${req.sats}`));
    }
    const quoteId = `quote-${++this.#seq}`;
    const bolt11 = `lnbc${req.sats}n1fake${this.#seq}`;
    this.#quotes.set(quoteId, { sats: req.sats, status: "pending" });
    return Promise.resolve({
      bolt11,
      quoteId,
      expiresAt: new Date(this.#now() + 900_000).toISOString(),
    });
  }

  checkSettlement(quoteId: string): Promise<SettlementStatus> {
    const q = this.#quotes.get(quoteId);
    if (!q) return Promise.reject(new RailError(`unknown quote ${quoteId}`));
    return Promise.resolve(q.status);
  }

  /** Test control: mark a quote settled/expired. */
  setStatus(quoteId: string, status: SettlementStatus): void {
    const q = this.#quotes.get(quoteId);
    if (!q) throw new RailError(`unknown quote ${quoteId}`);
    q.status = status;
  }
}

/**
 * Build the rail from the environment. Returns null when no mint is configured
 * so the caller can fail closed (503) instead of inventing an invoice.
 */
export function railFromEnv(
  env: { get(key: string): string | undefined },
  opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
): PaymentRail | null {
  const baseUrl = env.get("CASHU_MINT_URL");
  if (!baseUrl || !baseUrl.trim()) return null;
  return new CashuRail({ baseUrl, fetchImpl: opts.fetchImpl, now: opts.now });
}

/**
 * Render a QR for the invoice as a self-contained image URI, so the client can
 * use it directly as <img src> with no second fetch.
 */
export async function qrDataUri(text: string): Promise<string> {
  if (!text) throw new RailError("cannot render a QR for an empty payload");
  const mod = await import("npm:qrcode@1.5.4") as unknown as {
    default: { toString(t: string, o: unknown): Promise<string> };
  };
  const svg = await mod.default.toString(text, { type: "svg", margin: 1 });
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}
