/**
 * The settlement claim — the ONE edge that spends money's consequence.
 *
 * ADR-0008 makes `paid` a claim about money that only a rail verdict may make.
 * This file pins the other half of that rule: the claim itself is EXACTLY ONCE,
 * across processes and across restarts, and one payment request can never settle
 * two orders.
 *
 * The concurrency test spawns real OS processes (helpers/claim_runner.ts). Threads
 * would not do: SQLite's unix VFS takes POSIX advisory locks, which are per-
 * process, so threads in one process share lock state SQLite does not expect them
 * to share and the test proves nothing about two independent callers.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { OrderStore, type OrderMoney } from "../src/store.ts";
import { TEST_REFUND_BOLT11 } from "./helpers/refund_fixture.ts";

const money: OrderMoney = {
  venue_slug: "test-venue",
  items: [
    {
      sku: "100",
      name: "Pizza Margherita",
      qty: 1,
      options: ["House"],
      unit_price_sats: 9900,
      line_total_sats: 9900,
    },
  ],
  subtotal: 9900,
  fee: 792,
  total: 10692,
  fulfilment: "pickup",
  inputs: {},
};

const tmpDb = async (label: string): Promise<string> => {
  const dir = await Deno.makeTempDir({ prefix: `cvm-orders-${label}-` });
  return `${dir}/orders.sqlite`;
};

/** An order with an invoice attached — the only state a claim can be made on. */
async function orderWithInvoice(store: OrderStore, id: string, quote: string): Promise<void> {
  store.create(id, {  venue_slug: "test-venue", refund_bolt11: TEST_REFUND_BOLT11 }, money);
  await store.ensureInvoice(id, () =>
    Promise.resolve({
      bolt11: `lnbc106920n1${quote}`,
      quoteId: quote,
      expiresAt: "2026-10-11T05:48:18.000Z",
      qr: "data:image/svg+xml;base64,x",
    }));
}

Deno.test("claimSettlement is exactly-once: the second claim loses and writes nothing", async () => {
  const store = new OrderStore();
  await orderWithInvoice(store, "o-1", "quote-1");

  assertEquals(store.claimSettlement("o-1", { quoteId: "quote-1" }), "won");
  assertEquals(store.claimSettlement("o-1", { quoteId: "quote-1" }), "lost");

  const after = store.get("o-1");
  assertEquals(after?.state, "paid");
  assertEquals(store.queue().map((o) => o.id), ["o-1"], "exactly one row of paid work");

  // Positive control: the same two calls on a FRESH order behave the same way, so
  // this is not an implementation that simply answers "won" once per process.
  await orderWithInvoice(store, "o-2", "quote-2");
  assertEquals(store.claimSettlement("o-2", { quoteId: "quote-2" }), "won");
  assertEquals(store.claimSettlement("o-2", { quoteId: "quote-2" }), "lost");
  assertEquals(store.queue().map((o) => o.id).sort(), ["o-1", "o-2"]);

  // A claim on an order that does not exist never wins.
  assertEquals(store.claimSettlement("no-such-order", { quoteId: "q" }), "missing");
  store.close();
});

Deno.test("one payment request cannot settle TWO orders (reuse barrier)", async () => {
  const store = new OrderStore();
  await orderWithInvoice(store, "a", "quote-shared");
  await orderWithInvoice(store, "b", "quote-shared");

  assertEquals(store.claimSettlement("a", { quoteId: "quote-shared" }), "won");
  assertEquals(store.claimSettlement("b", { quoteId: "quote-shared" }), "proof_spent");
  assertEquals(store.get("b")?.state, "awaiting_payment", "the second order was not paid");
  assertEquals(store.proofSpentBy("quote-shared"), "a");
  assertEquals(store.queue().map((o) => o.id), ["a"]);
  store.close();
});

Deno.test("the same proof HASH cannot settle two orders either", async () => {
  const store = new OrderStore();
  await orderWithInvoice(store, "h1", "quote-h1");
  await orderWithInvoice(store, "h2", "quote-h2");

  assertEquals(store.claimSettlement("h1", { quoteId: "quote-h1", proofHash: "sha-abc" }), "won");
  assertEquals(
    store.claimSettlement("h2", { quoteId: "quote-h2", proofHash: "sha-abc" }),
    "proof_spent",
  );
  assertEquals(store.get("h2")?.state, "awaiting_payment");
  store.close();
});

Deno.test("a restart cannot claim the same settlement twice", async () => {
  const path = await tmpDb("restart-claim");
  const first = new OrderStore({ path });
  await orderWithInvoice(first, "r1", "quote-r1");
  assertEquals(first.claimSettlement("r1", { quoteId: "quote-r1" }), "won");
  first.close();

  // Restart: a brand-new store over the same file must see the claim as taken,
  // so a replayed poll (or a retry after a crash mid-settlement) cannot pay the
  // order a second time.
  const second = new OrderStore({ path });
  assertEquals(second.get("r1")?.state, "paid");
  assertEquals(second.claimSettlement("r1", { quoteId: "quote-r1" }), "lost");
  assertEquals(second.proofSpentBy("quote-r1"), "r1");
  assertEquals(second.queue().length, 1);
  second.close();
});

Deno.test("an expired claim is terminal and consumes no payment request", async () => {
  const store = new OrderStore();
  await orderWithInvoice(store, "x1", "quote-x1");

  assertEquals(store.claimSettlement("x1", { quoteId: "quote-x1" }, "expired"), "won");
  assertEquals(store.get("x1")?.state, "expired");
  assertEquals(store.queue(), [], "an expired invoice was never paid work");
  // Expiry is not a settlement: the quote is still free to be used by the order
  // it was really issued for, and the expired order is terminal either way.
  assertEquals(store.proofSpentBy("quote-x1"), undefined);
  assertEquals(store.claimSettlement("x1", { quoteId: "quote-x1" }), "lost");
  store.close();
});

Deno.test("N INDEPENDENT PROCESSES racing one claim: exactly one wins", async () => {
  const path = await tmpDb("cas");
  const setup = new OrderStore({ path });
  await orderWithInvoice(setup, "race", "quote-race");
  setup.close();

  const runners = 4;
  const startAt = Date.now() + 1500; // common barrier, so the race is real
  const children = Array.from({ length: runners }, () =>
    new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        new URL("./helpers/claim_runner.ts", import.meta.url).pathname,
        path,
        "race",
        "quote-race",
        String(startAt),
      ],
      stdout: "piped",
      stderr: "piped",
    }).spawn());

  const outcomes: string[] = [];
  for (const child of children) {
    const { stdout, stderr, code } = await child.output();
    const text = new TextDecoder().decode(stdout).trim();
    if (code !== 0) {
      outcomes.push(`error:exit${code}:${new TextDecoder().decode(stderr).trim()}`);
    } else {
      outcomes.push(text);
    }
  }

  const wins = outcomes.filter((o) => o === "won").length;
  const errors = outcomes.filter((o) => o.startsWith("error:"));
  assertEquals(errors, [], `no process may fail open or crash: ${JSON.stringify(outcomes)}`);
  assertEquals(wins, 1, `exactly one process may win: ${JSON.stringify(outcomes)}`);
  // `locked` is the fail-closed outcome: that caller claimed nothing. Counting
  // wins is the invariant; locked is reported so the number is honest.
  assert(
    outcomes.filter((o) => o === "lost" || o === "locked").length === runners - 1,
    `every other process must have claimed nothing: ${JSON.stringify(outcomes)}`,
  );

  const verify = new OrderStore({ path });
  assertEquals(verify.get("race")?.state, "paid");
  assertEquals(verify.queue().map((o) => o.id), ["race"]);
  verify.close();
});
