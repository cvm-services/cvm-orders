import { assertNoCardMaterial, CardMaterialRefused } from "./hygiene.ts";

export type OrderState = "paid" | "placing" | "placed" | "ready" | "refunded";

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
  /** present from `placed` onward; survives later transitions */
  receipt?: Receipt;
  updatedAt: string;
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
  paid: ["placing", "refunded"],
  placing: ["placed", "refunded"],
  placed: ["ready"],
  ready: [],
  refunded: [],
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

  create(id: string, payload: unknown = {}): Order {
    if (this.#orders.has(id)) throw new Error("order already exists");
    assertNoCardMaterial(payload, "payload");
    const order: Order = { id, state: "paid", payload, updatedAt: new Date().toISOString() };
    this.#orders.set(id, order);
    return this.#copy(order);
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
    return { ...order, receipt: order.receipt && { ...order.receipt } };
  }
}

export { CardMaterialRefused };
