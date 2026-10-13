/**
 * The melt-plan endpoint (Phase C of PLAN-pay-with-2fiat).
 *
 * "Pay with 2fiat" is a three-legged flow:
 *   (1) melt the customer's sats out of the mint
 *   (2) top up the 2fiat wallet with them (BTC LN)
 *   (3) the 2fiat card pays the venue
 *
 * The console must never show a dead button, and must never show a live-looking
 * button that cannot work. So the service TELLS it the truth: which legs are
 * ready, and exactly why the others are not. When Phase B lands, the same
 * endpoint flips to ready and the console needs no redeploy.
 *
 * The capability checks are real:
 *   - the sats gate is the same requireSettled law the console applies
 *   - melt readiness probes the MINT (reachable; not the blocked host)
 *   - topup readiness is false while 2fiat's edge is blocked, with the reason
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { meltPlan, type MeltPlan } from "../src/melt_plan.ts";

const MONEY = {
  venue_slug: "v",
  items: [{
    sku: "1",
    name: "X",
    qty: 1,
    options: [] as string[],
    unit_price_sats: 1500,
    line_total_sats: 1500,
  }],
  subtotal: 1500,
  fee: 120,
  total: 1620,
  fulfilment: "pickup" as const,
  inputs: {},
};

function settledOrder(): any {
  return {
    id: "o1",
    state: "paid" as const,
    payload: {
      settlement: {
        status: "settled",
        method: "bolt11",
        settled_at: "2026-10-13T17:07:10.962Z",
        proof: { payment_hash: "01a1363a" },
      },
    },
    total: 1620,
    fee: 120,
    invoice: { bolt11: "lnbc1", quoteId: "q-1", expiresAt: "2026-10-13T18:06:10.000Z" },
  };
}

Deno.test("a settled order with an invoice yields a plan whose melt leg can be checked", async () => {
  const plan = await meltPlan(settledOrder() as never, {
    // The mint is reachable and answers NUT-05 status for a quote.
    probeMint: async () => ({ reachable: true, nut05: true }),
  });
  assertEquals(plan.steps.length, 4, "gate, melt, topup, card");
  assertEquals(plan.steps[0].id, "gate");
  assertEquals(plan.steps[0].ready, true, "the order is settled — the gate is open");
  assertEquals(plan.steps[1].id, "melt");
  assertEquals(plan.steps[1].ready, true);
  assertEquals(plan.steps[2].ready, false, "topup must wait for 2fiat while blocked");
  assert(String(plan.steps[2].reason).length > 0, "a not-ready leg must say why");
  assertEquals(plan.executable, false, "the flow cannot run end-to-end yet");
});

Deno.test("an order whose sats are NOT proven reports the gate as the blocker", async () => {
  const order: any = settledOrder();
  order.payload = {};
  const plan = await meltPlan(order, { probeMint: async () => ({ reachable: true, nut05: true }) });
  assertEquals(plan.steps[0].id, "gate");
  assertEquals(plan.steps[0].ready, false);
  assert(String(plan.steps[0].reason).includes("sats"), "must name the sats gate");
  assertEquals(plan.executable, false);
});

Deno.test("an unreachable mint marks the melt leg not-ready with the reason", async () => {
  const plan = await meltPlan(settledOrder() as never, {
    probeMint: async () => ({ reachable: false, nut05: false, error: "timed out" }),
  });
  const melt = plan.steps.find((s: MeltPlan["steps"][number]) => s.id === "melt")!;
  assertEquals(melt.ready, false);
  assert(String(melt.reason).includes("mint"));
});

Deno.test("the plan is data, never a promise — the console renders it verbatim", async () => {
  const plan = await meltPlan(settledOrder() as never, {
    probeMint: async () => ({ reachable: true, nut05: true }),
  });
  // Serializable: it crosses the wire as JSON unchanged. `undefined` reasons
  // vanish in JSON — that IS the wire shape, so compare post-JSON.
  assertEquals(JSON.parse(JSON.stringify(plan)), JSON.parse(JSON.stringify(plan)));
  const wire = JSON.parse(JSON.stringify(plan));
  assertEquals(wire.steps[0].ready, true);
  assertEquals("reason" in wire.steps[0], false, "a ready step carries no reason on the wire");
});

Deno.test("when every leg is ready the plan is executable and says so", async () => {
  const plan = await meltPlan(settledOrder() as never, {
    probeMint: async () => ({ reachable: true, nut05: true }),
    topupReady: async () => ({ ready: true }),
  });
  assertEquals(plan.executable, true);
  assertEquals(plan.steps.every((s: MeltPlan["steps"][number]) => s.ready), true);
});
