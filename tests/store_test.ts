import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { InvalidTransitionError, type OrderState, OrderStore } from "../src/store.ts";

defaultDenoTest();

function defaultDenoTest() {/* keeps this file discoverable by deno test */}

Deno.test("creates paid orders and advances the legal lifecycle", () => {
  const store = new OrderStore();
  const order = store.create("o-1", { item: "pizza" });
  assertEquals(order.state, "paid");
  for (const state of ["placing", "placed", "ready"] as OrderState[]) {
    assertEquals(store.transition("o-1", state).state, state);
  }
});

Deno.test("rejects illegal transitions without mutating state", () => {
  const store = new OrderStore();
  store.create("o-2");
  assertThrows(() => store.transition("o-2", "ready"), InvalidTransitionError);
  assertEquals(store.get("o-2")?.state, "paid");
});

Deno.test("allows refund only before placement and lists paid queue", () => {
  const store = new OrderStore();
  store.create("o-3");
  assertEquals(store.transition("o-3", "refunded").state, "refunded");
  store.create("o-4");
  assertEquals(store.queue().map((o) => o.id), ["o-4"]);
});
