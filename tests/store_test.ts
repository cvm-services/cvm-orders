import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  InvalidReceiptError,
  InvalidTransitionError,
  type OrderState,
  OrderStore,
  StaleOrderStateError,
} from "../src/store.ts";
import { CardMaterialRefused } from "../src/hygiene.ts";

defaultDenoTest();

function defaultDenoTest() {/* keeps this file discoverable by deno test */}

/**
 * The store is no longer able to mint a paid order: `create()` produces
 * `awaiting_payment` and only the rail-verified edge reaches `paid` (ADR-0008).
 * Tests that want the facilitator's half of the lifecycle settle the order
 * first, which is exactly the edge the route gates (tests/invoice_test.ts).
 */
function paid(store: OrderStore, id: string, payload: unknown = {}): void {
  store.create(id, payload);
  store.transition(id, "paid", { from: "awaiting_payment" });
}

Deno.test("creates awaiting_payment orders and advances the legal lifecycle", () => {
  const store = new OrderStore();
  const order = store.create("o-1", { item: "pizza" });
  assertEquals(order.state, "awaiting_payment");
  assertEquals(store.queue(), [], "an unpaid order is not paid work");
  for (const state of ["paid", "placing", "placed", "ready"] as OrderState[]) {
    assertEquals(store.transition("o-1", state).state, state);
  }
});

Deno.test("rejects illegal transitions without mutating state", () => {
  const store = new OrderStore();
  store.create("o-2");
  assertThrows(() => store.transition("o-2", "ready"), InvalidTransitionError);
  assertThrows(() => store.transition("o-2", "placing"), InvalidTransitionError, undefined, "unpaid is not placing");
  assertEquals(store.get("o-2")?.state, "awaiting_payment");
});

Deno.test("allows refund only before placement and lists paid queue", () => {
  const store = new OrderStore();
  store.create("o-3");
  store.transition("o-3", "paid", { from: "awaiting_payment" });
  assertEquals(store.transition("o-3", "refunded").state, "refunded");
  paid(store, "o-4");
  assertEquals(store.queue().map((o) => o.id), ["o-4"]);
});

/** The receipt the console posts on `placed` (shape from cvm-registry pr/facilitator-console). */
const receipt = () => ({
  venue_reference: "#4471",
  ready_at: "18:25",
  paid_with: "card at venue terminal",
  payment_reference: "pi_1AbC",
  captured_at: "2026-10-10T18:20:03.123Z",
});

Deno.test("persists the receipt in the same step as the state change", () => {
  const store = new OrderStore();
  paid(store, "o-r1", { item: "pizza" });
  assertEquals(store.get("o-r1")?.receipt, undefined, "no receipt before the venue is used");

  store.transition("o-r1", "placing");
  const placed = store.transition("o-r1", "placed", { receipt: receipt() });
  assertEquals(placed.receipt, receipt());
  assertEquals(store.get("o-r1")?.receipt, receipt(), "durable, not just returned");

  // The durable copy outlives the last transition.
  assertEquals(store.transition("o-r1", "ready").receipt, receipt());
  assertEquals(store.get("o-r1")?.receipt, receipt());
});

Deno.test("a stored receipt is a copy: a reader cannot rewrite the record", () => {
  const store = new OrderStore();
  paid(store, "o-r2");
  store.transition("o-r2", "placing");
  const placed = store.transition("o-r2", "placed", { receipt: receipt() });

  placed.receipt!.venue_reference = "tampered";
  store.get("o-r2")!.receipt!.payment_reference = "tampered";
  assertEquals(store.get("o-r2")?.receipt?.venue_reference, "#4471");
  assertEquals(store.get("o-r2")?.receipt?.payment_reference, "pi_1AbC");
});

Deno.test("a receipt is the only place the venue reference is required", () => {
  const store = new OrderStore();
  paid(store, "o-r3");
  store.transition("o-r3", "placing");

  const cases: Array<[string, unknown, new (detail: string) => Error]> = [
    ["not an object", "nope", InvalidReceiptError],
    ["null", null, InvalidReceiptError],
    ["array", [], InvalidReceiptError],
    ["missing venue_reference", { ready_at: "18:25" }, InvalidReceiptError],
    ["blank venue_reference", { venue_reference: "   " }, InvalidReceiptError],
    ["non-string venue_reference", { venue_reference: 4471 }, InvalidReceiptError],
    ["unknown field", { venue_reference: "#4471", pan: "x" }, InvalidReceiptError],
    ["non-string field", { venue_reference: "#4471", ready_at: 1825 }, InvalidReceiptError],
    [
      "card material in a free-text field",
      { venue_reference: "#4471", payment_reference: "4111 1111 1111 1111" },
      CardMaterialRefused,
    ],
  ];
  for (const [label, value, error] of cases) {
    assertThrows(() => store.transition("o-r3", "placed", { receipt: value as never }), error, undefined, label);
    const order = store.get("o-r3");
    assertEquals(order?.state, "placing", `${label}: state untouched`);
    assertEquals(order?.receipt, undefined, `${label}: nothing written`);
  }

  // Whitespace is trimmed, not stored raw, and empty optional fields are dropped.
  assertEquals(
    store.transition("o-r3", "placed", {
      receipt: { venue_reference: "  #4471 ", ready_at: " ", paid_with: "2fiat" },
    }).receipt,
    { venue_reference: "#4471", paid_with: "2fiat" },
  );
});

Deno.test("a lost compare-and-set writes neither the state nor the receipt", () => {
  const store = new OrderStore();
  paid(store, "o-r4");

  assertThrows(
    () => store.transition("o-r4", "placed", { from: "placing", receipt: receipt() }),
    StaleOrderStateError,
  );
  assertEquals(store.get("o-r4")?.state, "paid");
  assertEquals(store.get("o-r4")?.receipt, undefined);

  // An illegal step carrying a receipt is refused just as atomically.
  assertThrows(() => store.transition("o-r4", "ready", { receipt: receipt() }), InvalidTransitionError);
  assertEquals(store.get("o-r4")?.receipt, undefined);

  // The winning compare-and-set attaches it.
  assertEquals(store.transition("o-r4", "placing", { from: "paid" }).state, "placing");
  const placed = store.transition("o-r4", "placed", { from: "placing", receipt: receipt() });
  assertEquals(placed.state, "placed");
  assertEquals(placed.receipt, receipt());
});

Deno.test("a receipt never changes who is in the queue", () => {
  const store = new OrderStore();
  paid(store, "o-q1");
  paid(store, "o-q2");
  store.transition("o-q2", "placing", { receipt: receipt() });

  assertEquals(store.queue().map((o) => o.id), ["o-q1"], "queue filtering is on state alone");
  assertEquals(store.queue()[0].receipt, undefined, "a queue listing carries no receipt");
  assertEquals(store.get("o-q2")?.receipt, receipt(), "the receipt itself is kept");
  assertEquals(store.all().length, 2);
});

Deno.test("an unknown order is a not-found, not a silent create", () => {
  const store = new OrderStore();
  assertThrows(() => store.transition("nope", "placing", { receipt: receipt() }), Error);
  assertEquals(store.get("nope"), undefined);
});
