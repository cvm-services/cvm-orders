/**
 * RED probe for the durability gap in `src/store.ts` (t_bd0f57a8).
 *
 * Not a test module (deno test does not collect this name) — a standalone script
 * whose stdout is the evidence. It drives the store through ONE public entry
 * point that must survive a restart, twice:
 *
 *   run 1 (process A)  create the order, attach its invoice
 *   run 2 (process B)  open the SAME durable path and look
 *
 * Against an in-process `Map` store, run 2 has nothing (PERSIST: LOST). Against a
 * durable store it sees the order, its state and its invoice (PERSIST: OK).
 * It also probes the settlement claim, so the same script measures the
 * exactly-once property after the fix.
 *
 *   deno run --allow-read --allow-write --allow-env tests/helpers/durable_probe.ts <db-path>
 */
// deno-lint-ignore no-explicit-any
const Store: any = (await import("../../src/store.ts")).OrderStore;

const dbPath = Deno.args[0] ?? "/tmp/durable-probe.sqlite";
const mode = Deno.args[1] ?? "full";

const open = () => new Store({ path: dbPath });

if (mode === "create-then-exit" || mode === "full") {
  const a = open();
  a.create("probe-1", { venue_slug: "v", items: [], inputs: {} }, {
    venue_slug: "v",
    items: [],
    subtotal: 100,
    fee: 8,
    total: 108,
    fulfilment: "pickup",
    inputs: {},
  });
  await a.ensureInvoice("probe-1", () =>
    Promise.resolve({
      bolt11: "lnbc1080n1probe",
      quoteId: "quote-probe-1",
      expiresAt: "2026-01-01T00:00:00.000Z",
      qr: "data:image/svg+xml;base64,x",
    }));
  a.close?.();
  if (mode === "create-then-exit") Deno.exit(0);
}

// A SECOND store over the same path = the restart.
const b = open();
const after = b.get("probe-1");
if (!after) {
  console.log("PERSIST: LOST — a second store over the same path sees no order");
  console.log("INVOICE: LOST — nothing to read");
  b.close?.();
  Deno.exit(3);
}
const invoiceSurvived = after.invoice?.bolt11 === "lnbc1080n1probe";
console.log(`PERSIST: OK — order probe-1 state=${after.state} total=${after.total}`);
console.log(`INVOICE: ${invoiceSurvived ? "OK — the same bolt11" : "REQUOTED/LOST"}`);

// Exactly-once claim, measured in one process here (the cross-process race lives
// in tests/settlement_claim_test.ts). Two callers, one transition.
let first = "n/a";
let second = "n/a";
if (typeof b.claimSettlement === "function") {
  first = b.claimSettlement("probe-1", { quoteId: "quote-probe-1" });
  second = b.claimSettlement("probe-1", { quoteId: "quote-probe-1" });
} else {
  console.log("CLAIM: no claimSettlement() — settlement is an in-process transition only");
}
console.log(`CLAIM: first=${first} second=${second} (want won/lost)`);
console.log(`PROOFS: ${typeof b.proofSpentBy === "function" ? b.proofSpentBy("quote-probe-1") : "no barrier"}`);
b.close?.();
