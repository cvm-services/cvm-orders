/**
 * The order store — DURABLE (SQLite, WAL) as of t_bd0f57a8.
 *
 * Why this is a database and not a `Map`: the order carries two things that must
 * outlive the process. (1) the invoice — if a restart re-quoted a SECOND bolt11
 * for an order whose first invoice the customer already paid, the sats are
 * stranded and the order can never reach `paid`; (2) the sats-settlement claim —
 * `awaiting_payment -> paid` is a claim about money, and "exactly once" has to
 * hold across processes and restarts, not just inside one isolate.
 *
 * Money-safety rules this file implements (ADR-0008 / ADR-0012 / ADR-0013):
 *   * an order is BORN `awaiting_payment`; nothing in this store can mint a
 *     `paid` order out of a request body;
 *   * `claimSettlement()` is the exactly-once, cross-process settlement claim.
 *     It is one conditional UPDATE inside a `BEGIN IMMEDIATE` transaction, plus
 *     a `settlement_proofs` row whose PRIMARY KEY on the payment request is a
 *     reuse barrier: one quote settles at most ONE order, forever;
 *   * the invoice is written with a compare-and-set, so a process that lost the
 *     race cannot overwrite the invoice the customer is looking at;
 *   * `expired` and `refunded` are terminal — there is no edge out of them, so a
 *     late poll or a restart cannot revive an order that was never paid;
 *   * Idempotency-Key replay is durable, so a retry after a restart returns the
 *     ORIGINAL order instead of creating a second one.
 *
 * Concurrency note: SQLite's unix VFS takes POSIX advisory locks, which are
 * per-process — so the cross-process exactly-once property is proven with real
 * OS processes in `tests/settlement_claim_test.ts`, not with threads.
 */
import { DatabaseSync } from "node:sqlite";
import { assertNoCardMaterial, CardMaterialRefused } from "./hygiene.ts";
// The fulfilment method set is the VENUE's, defined once in the catalog layer
// (chandi-berlin prices dine_in only), so the store shares it instead of
// re-declaring a narrower copy that silently refuses a served venue.
import type { Fulfilment } from "./catalog.ts";

/**
 * An order is BORN unpaid: `awaiting_payment` is what `create()` produces, and
 * the ONLY way into `paid` is the rail-verified settlement (ADR-0008). `expired`
 * is a separate, terminal outcome — an order whose invoice died was never paid
 * and must never look like one that was.
 */
export type OrderState =
  | "awaiting_payment"
  | "expired"
  | "paid"
  | "placing"
  | "placed"
  | "ready"
  | "refunded";

/** States nothing can leave. A restart must not resurrect one. */
export const TERMINAL_STATES: readonly OrderState[] = ["expired", "ready", "refunded"];

export const isTerminal = (state: OrderState): boolean => TERMINAL_STATES.includes(state);

/**
 * The venue receipt the facilitator captures by hand after ordering the food.
 * Persisted server-side so the only durable copy is no longer the facilitator's
 * device. `payment_reference` is a PSP/terminal reference — never card material
 * (ADR-0013); `assertNoCardMaterial` enforces that on the way in.
 */
export interface Receipt {
  venue_reference: string;
  ready_at?: string;
  paid_with?: string;
  payment_reference?: string;
  captured_at?: string;
}

export interface Order {
  id: string;
  state: OrderState;
  payload: unknown;
  /**
   * Server-computed money, present on a customer order (absent on an order a
   * facilitator created by hand). Every field is recomputed from the catalog by
   * `src/catalog.ts`; none of it is ever taken from the client.
   */
  venue_slug?: string;
  items?: OrderMoney["items"];
  subtotal?: number;
  fee?: number;
  total?: number;
  fulfilment?: OrderMoney["fulfilment"];
  inputs?: Record<string, unknown>;
  /**
   * The order's single invoice. Created once by the rail and cached here, so a
   * repeat call returns the SAME bolt11 instead of a second quote — including
   * after a restart, which is the whole point of persisting it.
   */
  invoice?: OrderInvoice;
  /** present from `placed` onward; survives later transitions */
  receipt?: Receipt;
  updatedAt: string;
}

/** The rail's answer, plus the QR rendered from it once. */
export interface OrderInvoice {
  bolt11: string;
  quoteId: string;
  expiresAt: string;
  /** Self-contained `data:image/svg+xml;base64,` URI — derived from `bolt11`. */
  qr: string;
}

/** Everything POST /orders prices and stores server-side. */
export interface OrderMoney {
  venue_slug: string;
  items: Array<{
    sku: string;
    name: string;
    qty: number;
    options: string[];
    unit_price_sats: number;
    line_total_sats: number;
  }>;
  subtotal: number;
  fee: number;
  total: number;
  /**
   * The fulfilment method the venue's own catalog priced this order for. The set
   * lives in `src/catalog.ts` (`Fulfilment`) because it is the venue's set, not
   * ours: chandi-berlin prices `dine_in` only. Imported rather than re-declared so
   * the two cannot drift.
   */
  fulfilment: Fulfilment;
  inputs: Record<string, unknown>;
}

/** Everything one transition may carry besides the target state. */
export interface TransitionMeta {
  /**
   * Compare-and-set on the caller's view of the current state: a mismatch is a
   * lost claim and changes nothing. (The legal-transition table below is
   * already an implicit CAS on the state read; `from` makes the caller's
   * expected state explicit.)
   */
  from?: OrderState;
  /** Attached to the order in the same atomic step as the state change. */
  receipt?: Receipt;
}

/**
 * The result of a settlement claim.
 *   won         — this caller took the claim; the order is now `paid`
 *   lost        — the row was not in `awaiting_payment` (someone else won, or a
 *                 restart already applied it). Nothing was written.
 *   proof_spent — the payment request already settled a DIFFERENT order. Nothing
 *                 was written.
 *   missing     — no such order.
 */
export type ClaimOutcome = "won" | "lost" | "proof_spent" | "missing";

export interface SettlementClaim {
  /** The rail's quote/payment request — the settlement proof's identity. */
  quoteId: string;
  /** sha256 of the proof, when the rail gives us one. Never the raw token. */
  proofHash?: string;
}

const transitions: Record<OrderState, OrderState[]> = {
  // `awaiting_payment -> paid` is the rail-verified settlement edge. The store
  // keeps the edge legal (facilitator-console tests and the explicit path use
  // it); the ROUTE gates it on a rail verdict AND takes it through
  // `claimSettlement()`, which is exactly-once across processes — see main.ts.
  awaiting_payment: ["paid", "expired"],
  paid: ["placing", "refunded"],
  placing: ["placed", "refunded"],
  placed: ["ready"],
  ready: [],
  refunded: [],
  // Terminal: an expired invoice was never paid, so there is nothing to refund
  // and nothing to place.
  expired: [],
};

const RECEIPT_FIELDS = new Set([
  "venue_reference",
  "ready_at",
  "paid_with",
  "payment_reference",
  "captured_at",
]);

export class OrderNotFoundError extends Error {
  constructor() {
    super("order not found");
    this.name = "OrderNotFoundError";
  }
}

export class StaleOrderStateError extends Error {
  constructor(from: OrderState, expected: OrderState) {
    super(`order is ${from}, not ${expected}`);
    this.name = "StaleOrderStateError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(from: OrderState, to: OrderState) {
    super(`illegal order transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class InvalidReceiptError extends Error {
  constructor(detail: string) {
    super(`invalid receipt: ${detail}`);
    this.name = "InvalidReceiptError";
  }
}

function validateReceipt(value: unknown): Receipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidReceiptError("must be an object");
  }
  const input = value as Record<string, unknown>;
  const venueReference = input.venue_reference;
  if (typeof venueReference !== "string" || venueReference.trim() === "") {
    throw new InvalidReceiptError("venue_reference is required");
  }
  for (const [key, field] of Object.entries(input)) {
    if (!RECEIPT_FIELDS.has(key)) throw new InvalidReceiptError(`unknown field ${key}`);
    if (field !== undefined && field !== null && typeof field !== "string") {
      throw new InvalidReceiptError(`${key} must be a string`);
    }
  }
  // ADR-0013 — a hand-typed receipt is exactly where a PAN could leak in.
  assertNoCardMaterial(input, "receipt");
  const receipt: Receipt = { venue_reference: venueReference.trim() };
  for (const key of ["ready_at", "paid_with", "payment_reference", "captured_at"] as const) {
    const field = input[key];
    if (typeof field === "string" && field.trim() !== "") receipt[key] = field.trim();
  }
  return receipt;
}

/** Bump when a NEW column or table is added; `#migrate` applies it to old files. */
const SCHEMA_VERSION = 2;

/**
 * Columns added after the first shipped schema. `CREATE TABLE IF NOT EXISTS` is a
 * NO-OP on a table that already exists, so a DDL-only change would work on a
 * fresh CI database and do NOTHING on a deployed one — every added column must
 * also be backfilled here, guarded by `PRAGMA table_info`.
 */
const ADDED_COLUMNS: Array<[string, string]> = [
  ["settlement_claim", "TEXT"],
  ["settled_at", "TEXT"],
];

export interface OrderStoreOptions {
  /**
   * SQLite path. Defaults to `:memory:` (tests). PRODUCTION MUST SET THIS —
   * `main.ts` reads it from ORDER_DB_PATH so the invoice, the queue and the
   * settlement claim survive a service restart.
   */
  path?: string;
}

interface OrderRow {
  id: string;
  state: string;
  payload: string;
  venue_slug: string | null;
  items: string | null;
  subtotal: number | null;
  fee: number | null;
  total: number | null;
  fulfilment: string | null;
  inputs: string | null;
  invoice: string | null;
  receipt: string | null;
  updated_at: string;
}

/**
 * Durable order store. Every method is synchronous (node:sqlite is synchronous),
 * so a single process cannot interleave two writers on the JS side, and the
 * `BEGIN IMMEDIATE` transactions are what make two PROCESSES safe.
 */
export class OrderStore {
  readonly #db: DatabaseSync;
  /** One in-flight invoice per order, so concurrent callers share a rail call. */
  #invoices = new Map<string, Promise<Order>>();

  constructor(opts: OrderStoreOptions = {}) {
    this.#db = new DatabaseSync(opts.path ?? ":memory:");
    // Wait rather than throw when another process holds the write lock: a burst
    // of settlement polls must not surface as a 500. A timeout still fails
    // CLOSED (the caller sees an exception and does not claim anything).
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        payload TEXT NOT NULL,
        venue_slug TEXT,
        items TEXT,
        subtotal INTEGER,
        fee INTEGER,
        total INTEGER,
        fulfilment TEXT,
        inputs TEXT,
        invoice TEXT,
        receipt TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
    const present = new Set(
      (this.#db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>)
        .map((r) => r.name),
    );
    for (const [name, ddl] of ADDED_COLUMNS) {
      if (!present.has(name)) this.#db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${ddl}`);
    }

    // One row per settled payment request. The PRIMARY KEY is the reuse barrier:
    // the second order to present the same quote is refused, not merged.
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS settlement_proofs (
        quote_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        proof_hash TEXT,
        claimed_at TEXT NOT NULL
      )`);
    this.#db.exec(
      "CREATE INDEX IF NOT EXISTS settlement_proofs_order ON settlement_proofs (order_id)",
    );
    this.#db.exec(
      "CREATE INDEX IF NOT EXISTS settlement_proofs_hash ON settlement_proofs (proof_hash)",
    );

    // Durable Idempotency-Key replay: a client retry (or a retry after a
    // restart) must get the ORIGINAL order, not a second one.
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);

    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Create an order. It is ALWAYS `awaiting_payment`: this store cannot mint a
   * paid order, because `paid` is a claim about money that only the rail can
   * make (ADR-0008). `money` carries the prices recomputed from the catalog.
   */
  create(id: string, payload: unknown = {}, money?: OrderMoney): Order {
    if (typeof id !== "string" || id.trim() === "") {
      // Without this the old code happily created an order under `undefined`,
      // which is not a row any client can poll.
      throw new Error("order id is required");
    }
    assertNoCardMaterial(payload, "payload");
    if (money) assertNoCardMaterial(money, "order-money");

    const now = new Date().toISOString();
    const order: Order = {
      id,
      state: "awaiting_payment",
      payload,
      updatedAt: now,
      ...(money
        ? { ...money, items: money.items.map((i) => ({ ...i, options: [...i.options] })) }
        : {}),
    };
    try {
      this.#db.prepare(
        `INSERT INTO orders (id, state, payload, venue_slug, items, subtotal, fee, total,
                             fulfilment, inputs, invoice, receipt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      ).run(
        id,
        order.state,
        JSON.stringify(order.payload ?? {}),
        order.venue_slug ?? null,
        order.items ? JSON.stringify(order.items) : null,
        order.subtotal ?? null,
        order.fee ?? null,
        order.total ?? null,
        order.fulfilment ?? null,
        order.inputs ? JSON.stringify(order.inputs) : null,
        now,
        now,
      );
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test(String((e as Error)?.message ?? e))) {
        throw new Error("order already exists");
      }
      throw e;
    }
    return this.#copy(order);
  }

  /**
   * Create the order's invoice at most once and persist it on the order.
   *
   * `factory` is only called when the order has no invoice; a second caller —
   * including one that arrives while the first is still awaiting the mint — gets
   * the SAME invoice. The write itself is a compare-and-set (`WHERE invoice IS
   * NULL`) inside one transaction, so two processes cannot both install an
   * invoice, and a restart cannot re-quote an order that already has one. A
   * factory that throws leaves the order without an invoice, so the next call
   * can try again.
   */
  async ensureInvoice(id: string, factory: () => Promise<OrderInvoice>): Promise<Order> {
    const existing = this.get(id);
    if (!existing) throw new OrderNotFoundError();
    if (existing.invoice) return existing;

    // In-process dedupe only; the durable winner is decided by the UPDATE below.
    const inFlight = this.#invoices.get(id);
    if (inFlight) return await inFlight;

    const pending = (async (): Promise<Order> => {
      try {
        const invoice = await factory();
        assertNoCardMaterial(invoice, "invoice");
        const now = new Date().toISOString();
        const result = this.#db.prepare(
          "UPDATE orders SET invoice = ?, updated_at = ? WHERE id = ? AND invoice IS NULL",
        ).run(JSON.stringify(invoice), now, id);
        if (result.changes === 0) {
          // Another process installed one first: the FIRST invoice wins, and it
          // is the one the customer was shown. Ours is an unpaid mint quote that
          // nothing ever claims (no order points at it), so it is inert.
          const current = this.get(id);
          if (!current) throw new OrderNotFoundError();
          return current;
        }
        const updated = this.get(id);
        if (!updated) throw new OrderNotFoundError();
        return updated;
      } finally {
        this.#invoices.delete(id);
      }
    })();
    this.#invoices.set(id, pending);
    return await pending;
  }

  get(id: string): Order | undefined {
    const row = this.#db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as
      | OrderRow
      | undefined;
    return row ? rowToOrder(row) : undefined;
  }

  /**
   * Compare-and-set transition. Everything is validated before anything is
   * written, so a rejected transition leaves the order byte-identical (state
   * *and* receipt), and a receipt accepted with a transition lands in the same
   * atomic swap as the state change.
   */
  transition(id: string, to: OrderState, meta: TransitionMeta = {}): Order {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as
        | OrderRow
        | undefined;
      if (!row) throw new OrderNotFoundError();
      const current = rowToOrder(row);
      if (meta.from !== undefined && current.state !== meta.from) {
        throw new StaleOrderStateError(current.state, meta.from);
      }
      if (!transitions[current.state].includes(to)) {
        throw new InvalidTransitionError(current.state, to);
      }
      const receipt = meta.receipt === undefined
        ? current.receipt
        : validateReceipt(meta.receipt);
      this.#db.prepare("UPDATE orders SET state = ?, receipt = ?, updated_at = ? WHERE id = ?")
        .run(to, receipt ? JSON.stringify(receipt) : null, new Date().toISOString(), id);
      const committed = this.get(id);
      if (!committed) throw new OrderNotFoundError();
      this.#db.exec("COMMIT");
      return committed;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * THE settlement claim: `awaiting_payment -> paid` exactly once, atomically,
   * across processes and restarts.
   *
   * One `BEGIN IMMEDIATE` transaction does three things or none: checks the row
   * is still `awaiting_payment`, inserts the payment request into
   * `settlement_proofs` (refusing a request that already settled a different
   * order), and flips the state with a conditional UPDATE. The loser of a race
   * writes nothing — so it can never hand out a second "the sats arrived".
   *
   * A claim is only ever taken by the route AFTER a rail verdict of `settled`;
   * `claimSettlement` itself answers "may I claim this", not "was it paid".
   */
  claimSettlement(
    id: string,
    claim: SettlementClaim,
    to: Extract<OrderState, "paid" | "expired"> = "paid",
  ): ClaimOutcome {
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT state FROM orders WHERE id = ?").get(id) as
        | { state: string }
        | undefined;
      if (!row) {
        this.#db.exec("ROLLBACK");
        return "missing";
      }
      if (row.state !== "awaiting_payment") {
        // Someone already claimed it (another poll, another process, or a
        // restart replaying its own durable state). Nothing is written.
        this.#db.exec("ROLLBACK");
        return "lost";
      }
      if (to === "paid") {
        if (!claim.quoteId) {
          throw new Error("a settlement claim needs the payment request it settles");
        }
        const owner = this.#db
          .prepare("SELECT order_id FROM settlement_proofs WHERE quote_id = ?")
          .get(claim.quoteId) as { order_id: string } | undefined;
        if (owner && owner.order_id !== id) {
          this.#db.exec("ROLLBACK");
          return "proof_spent";
        }
        if (claim.proofHash) {
          const byHash = this.#db
            .prepare("SELECT order_id FROM settlement_proofs WHERE proof_hash = ?")
            .get(claim.proofHash) as { order_id: string } | undefined;
          if (byHash && byHash.order_id !== id) {
            this.#db.exec("ROLLBACK");
            return "proof_spent";
          }
        }
        try {
          this.#db.prepare(
            `INSERT INTO settlement_proofs (quote_id, order_id, proof_hash, claimed_at)
             VALUES (?, ?, ?, ?)`,
          ).run(claim.quoteId, id, claim.proofHash ?? null, now);
        } catch (e) {
          // UNIQUE on quote_id: another order claimed it between our check and
          // this insert. That is a reuse, and the whole claim rolls back.
          if (/UNIQUE|PRIMARY KEY/i.test(String((e as Error)?.message ?? e))) {
            this.#db.exec("ROLLBACK");
            return "proof_spent";
          }
          throw e;
        }
      }
      const result = this.#db.prepare(
        "UPDATE orders SET state = ?, updated_at = ? WHERE id = ? AND state = 'awaiting_payment'",
      ).run(to, now, id);
      if (result.changes !== 1) {
        this.#db.exec("ROLLBACK");
        return "lost";
      }
      this.#db.exec("COMMIT");
      return "won";
    } catch (e) {
      try {
        this.#db.exec("ROLLBACK");
      } catch { /* already rolled back */ }
      throw e;
    }
  }

  /** Which order (if any) already settled with this payment request. */
  proofSpentBy(quoteId: string): string | undefined {
    const row = this.#db
      .prepare("SELECT order_id FROM settlement_proofs WHERE quote_id = ?")
      .get(quoteId) as { order_id: string } | undefined;
    return row?.order_id;
  }

  /**
   * Create the order AND claim the Idempotency-Key in ONE transaction.
   *
   * A double-tap on Pay (or a retry after a restart) must never produce a second
   * order for one key: either this call creates the order and the key row
   * together, or it returns the response the first call stored. Making it one
   * transaction is what makes that hold across processes, not just within the
   * window where an in-memory map happened to still be warm.
   */
  createIdempotent(
    key: string,
    id: string,
    payload: unknown,
    money: OrderMoney | undefined,
    respond: (order: Order) => Record<string, unknown>,
  ): { order: Order; response: Record<string, unknown>; replayed: boolean } {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#db
        .prepare("SELECT order_id, response FROM idempotency WHERE key = ?")
        .get(key) as { order_id: string; response: string } | undefined;
      if (existing) {
        const order = this.get(existing.order_id);
        this.#db.exec("COMMIT");
        if (!order) throw new OrderNotFoundError();
        return {
          order,
          response: JSON.parse(existing.response) as Record<string, unknown>,
          replayed: true,
        };
      }
      const order = this.create(id, payload, money);
      const response = respond(order);
      this.#db.prepare(
        "INSERT INTO idempotency (key, order_id, response, created_at) VALUES (?, ?, ?, ?)",
      ).run(key, order.id, JSON.stringify(response), new Date().toISOString());
      this.#db.exec("COMMIT");
      return { order, response, replayed: false };
    } catch (e) {
      try {
        this.#db.exec("ROLLBACK");
      } catch { /* already rolled back */ }
      throw e;
    }
  }

  /** Durable Idempotency-Key replay: the response body of the original order. */
  idempotentReplay(key: string): Record<string, unknown> | undefined {
    const row = this.#db.prepare("SELECT response FROM idempotency WHERE key = ?").get(key) as
      | { response: string }
      | undefined;
    return row ? JSON.parse(row.response) as Record<string, unknown> : undefined;
  }

  /** Remember an Idempotency-Key's response, in the same store as the order. */
  rememberIdempotency(
    key: string,
    orderId: string,
    response: Record<string, unknown>,
  ): void {
    this.#db.prepare(
      `INSERT INTO idempotency (key, order_id, response, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
    ).run(key, orderId, JSON.stringify(response), new Date().toISOString());
  }

  /**
   * Paid-only work queue. Filtering stays on state alone — a receipt never
   * changes who is in the queue — and receipts are not part of a queue listing.
   * Durably ordered oldest-first, so a restart lists the same queue.
   */
  queue(): Order[] {
    const rows = this.#db
      .prepare("SELECT * FROM orders WHERE state = 'paid' ORDER BY updated_at ASC, id ASC")
      .all() as unknown as OrderRow[];
    return rows.map((row) => {
      const copy = rowToOrder(row);
      delete copy.receipt;
      return copy;
    });
  }

  all(): Order[] {
    const rows = this.#db
      .prepare("SELECT * FROM orders ORDER BY created_at ASC, id ASC")
      .all() as unknown as OrderRow[];
    return rows.map(rowToOrder);
  }

  /** Close the underlying handle. Tests use it to model a process exit. */
  close(): void {
    this.#invoices.clear();
    this.#db.close();
  }

  #copy(order: Order): Order {
    return {
      ...order,
      items: order.items?.map((i) => ({ ...i, options: [...i.options] })),
      invoice: order.invoice && { ...order.invoice },
      receipt: order.receipt && { ...order.receipt },
    };
  }
}

/** One row -> one order, materialising the JSON columns. */
function rowToOrder(row: OrderRow): Order {
  const order: Order = {
    id: row.id,
    state: row.state as OrderState,
    payload: row.payload ? JSON.parse(row.payload) : {},
    updatedAt: row.updated_at,
  };
  if (row.venue_slug !== null) order.venue_slug = row.venue_slug;
  if (row.items !== null) order.items = JSON.parse(row.items) as OrderMoney["items"];
  if (row.subtotal !== null) order.subtotal = row.subtotal;
  if (row.fee !== null) order.fee = row.fee;
  if (row.total !== null) order.total = row.total;
  if (row.fulfilment !== null) order.fulfilment = row.fulfilment as OrderMoney["fulfilment"];
  if (row.inputs !== null) order.inputs = JSON.parse(row.inputs) as Record<string, unknown>;
  if (row.invoice !== null) order.invoice = JSON.parse(row.invoice) as OrderInvoice;
  if (row.receipt !== null) order.receipt = JSON.parse(row.receipt) as Receipt;
  return order;
}

export { CardMaterialRefused };
