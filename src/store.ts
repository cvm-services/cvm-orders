export type OrderState = "paid" | "placing" | "placed" | "ready" | "refunded";
export interface Order {
  id: string;
  state: OrderState;
  payload: unknown;
  updatedAt: string;
}
const transitions: Record<OrderState, OrderState[]> = {
  paid: ["placing", "refunded"],
  placing: ["placed", "refunded"],
  placed: ["ready"],
  ready: [],
  refunded: [],
};
export class InvalidTransitionError extends Error {
  constructor(from: OrderState, to: OrderState) {
    super(`illegal order transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}
export class OrderStore {
  #orders = new Map<string, Order>();
  create(id: string, payload: unknown = {}): Order {
    if (this.#orders.has(id)) throw new Error("order already exists");
    const order = { id, state: "paid" as const, payload, updatedAt: new Date().toISOString() };
    this.#orders.set(id, order);
    return { ...order };
  }
  get(id: string): Order | undefined {
    const order = this.#orders.get(id);
    return order && { ...order };
  }
  transition(id: string, to: OrderState): Order {
    const order = this.#orders.get(id);
    if (!order) throw new Error("order not found");
    if (!transitions[order.state].includes(to)) throw new InvalidTransitionError(order.state, to);
    order.state = to;
    order.updatedAt = new Date().toISOString();
    return { ...order };
  }
  queue(): Order[] {
    return [...this.#orders.values()].filter((o) => o.state === "paid").map((o) => ({ ...o }));
  }
  all(): Order[] {
    return [...this.#orders.values()].map((o) => ({ ...o }));
  }
}
