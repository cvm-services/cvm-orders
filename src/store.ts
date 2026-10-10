import { assertNoCardMaterial, CardMaterialRefused } from "./hygiene.ts";

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
   * repeat call returns the SAME bolt11 instead of a second quote.
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
  fulfilment: "pickup" | "delivery";
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

const transitions: Record<OrderState, OrderState[]> = {
  // `awaiting_payment -> paid` is the rail-verified settlement edge. The store
  // keeps the edge legal (the settlement poll uses it); the ROUTE is the gate
  // that refuses it without a rail verdict — see main.ts.
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

export class OrderStore {
  #orders = new Map<string, Order>();
  /** One in-flight invoice per order, so concurrent callers share a rail call. */
  #invoices = new Map<string, Promise<Order>>();

  /**
   * Create an order. It is ALWAYS `awaiting_payment`: this store cannot mint a
   * paid order, because `paid` is a claim about money that only the rail can
   * make (ADR-0008). `money` carries the prices recomputed from the catalog.
   */
  create(id: string, payload: unknown = {}, money?: OrderMoney): Order {
    if (this.#orders.has(id)) throw new Error("order already exists");
    assertNoCardMaterial(payload, "payload");
    if (money) assertNoCardMaterial(money, "order-money");
    const order: Order = {
      id,
      state: "awaiting_payment",
      payload,
      updatedAt: new Date().toISOString(),
      ...(money ? { ...money, items: money.items.map((i) => ({ ...i, options: [...i.options] })) } : {}),
    };
    this.#orders.set(id, order);
    return this.#copy(order);
  }

  /**
   * Create the order's invoice at most once and cache it on the order.
   *
   * `factory` is only called when the order has no invoice; a second caller —
   * including one that arrives while the first is still awaiting the mint —
   * gets the SAME invoice, so a client retry can never produce two quotes for
   * one order. A factory that throws leaves the order without an invoice, so
   * the next call can try again.
   */
  async ensureInvoice(id: string, factory: () => Promise<OrderInvoice>): Promise<Order> {
    const existing = this.#orders.get(id);
    if (!existing) throw new OrderNotFoundError();
    if (existing.invoice) return this.#copy(existing);

    const pending = this.#invoices.get(id) ?? (async (): Promise<Order> => {
      try {
        const invoice = await factory();
        assertNoCardMaterial(invoice, "invoice");
        const order = this.#orders.get(id);
        if (!order) throw new OrderNotFoundError();
        // A concurrent creator may have won the race; the first invoice wins.
        if (!order.invoice) {
          order.invoice = { ...invoice };
          order.updatedAt = new Date().toISOString();
        }
        return this.#copy(order);
      } finally {
        this.#invoices.delete(id);
      }
    })();
    this.#invoices.set(id, pending);
    return await pending;
  }

  get(id: string): Order | undefined {
    const order = this.#orders.get(id);
    return order && this.#copy(order);
  }

  /**
   * Compare-and-set transition. Everything is validated before anything is
   * written, so a rejected transition leaves the order byte-identical (state
   * *and* receipt), and a receipt accepted with a transition lands in the same
   * atomic swap as the state change.
   */
  transition(id: string, to: OrderState, meta: TransitionMeta = {}): Order {
    const order = this.#orders.get(id);
    if (!order) throw new OrderNotFoundError();
    if (meta.from !== undefined && order.state !== meta.from) {
      throw new StaleOrderStateError(order.state, meta.from);
    }
    if (!transitions[order.state].includes(to)) throw new InvalidTransitionError(order.state, to);

    const receipt = meta.receipt === undefined ? order.receipt : validateReceipt(meta.receipt);
    const next: Order = { ...order, state: to, updatedAt: new Date().toISOString() };
    if (receipt) next.receipt = receipt;
    else delete next.receipt;
    this.#orders.set(id, next);
    return this.#copy(next);
  }

  /**
   * Paid-only work queue. Filtering stays on state alone — a receipt never
   * changes who is in the queue — and receipts are not part of a queue listing.
   */
  queue(): Order[] {
    return [...this.#orders.values()]
      .filter((o) => o.state === "paid")
      .map((o) => {
        const copy = this.#copy(o);
        delete copy.receipt;
        return copy;
      });
  }

  all(): Order[] {
    return [...this.#orders.values()].map((o) => this.#copy(o));
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

export { CardMaterialRefused };
