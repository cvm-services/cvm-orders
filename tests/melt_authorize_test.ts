/**
 * MELT AUTHORISATION — the test that would have caught the missing payment step.
 *
 * WHAT WENT WRONG WITHOUT THIS FILE
 *
 * R1 shipped a refund orchestration whose tests reached `refunded`. Nothing POSTed
 * proofs to /v1/melt/bolt11, so no melt could ever settle — but the fake rail set
 * `state = "paid"` directly, so the suite stayed green while the customer got
 * nothing. The lesson is narrow and worth pinning: a double may fake the MINT'S
 * ANSWER, but it must never fake OUR REQUEST. Every test below asserts on the
 * request we send, not only on the state we end up in.
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  authorizeMelt,
  blankOutputs,
  MeltAuthorizeError,
  type MeltProof,
  totalOf,
} from "../src/melt_authorize.ts";

const LADDER = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];

/** A proof set worth exactly `amount`. */
const proofsWorth = (amount: number, id = "keyset-1"): MeltProof[] =>
  [{ amount, id, secret: "s".repeat(32), C: "02" + "a".repeat(64) }];

/** Captures the outbound melt request so we can assert on it. */
function recordingFetch(responseBody: unknown, status = 200) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

// --- M1: the bug the whole file exists for -------------------------------------

Deno.test("M1: the melt is AUTHORISED — proofs are actually POSTed to /v1/melt/bolt11", async () => {
  const { calls, fetchImpl } = recordingFetch({ state: "PENDING" });
  const proofs = proofsWorth(105);
  await authorizeMelt({
    baseUrl: "https://mint.test/Bitcoin",
    fetchImpl,
    quoteId: "q-1",
    amount: 100,
    feeReserve: 5,
    proofs,
    ladder: LADDER,
  });

  assertEquals(calls.length, 1, "one authorise call");
  assertEquals(calls[0].url, "https://mint.test/Bitcoin/v1/melt/bolt11",
    "it must hit the AUTHORIZE endpoint, not the quote endpoint");
  assertEquals(calls[0].body.quote, "q-1");
  assert(Array.isArray(calls[0].body.inputs) && calls[0].body.inputs.length === 1,
    "the proofs must travel as `inputs` — without them the mint has nothing to spend");
  assertEquals(calls[0].body.inputs[0].secret, "s".repeat(32));
  assertEquals(calls[0].body.inputs[0].C, "02" + "a".repeat(64));
});

// --- M2: posture before the network --------------------------------------------

Deno.test("M2: an underfunded melt is refused BEFORE the network call", () => {
  const { calls, fetchImpl } = recordingFetch({ state: "PAID" });
  // proofs worth 100, but the quote needs 100 + 5 reserve.
  return authorizeMelt({
    baseUrl: "https://mint.test/Bitcoin",
    fetchImpl,
    quoteId: "q-1",
    amount: 100,
    feeReserve: 5,
    proofs: proofsWorth(100),
    ladder: LADDER,
  }).then(
    () => assert(false, "an underfunded melt must be refused"),
    (e) => {
      assert(e instanceof MeltAuthorizeError, `expected MeltAuthorizeError, got ${e}`);
      assert(String(e.message).includes("underfunded"), `message must explain: ${e.message}`);
      assertEquals(calls.length, 0, "we must not touch the network when we already know we cannot pay");
    },
  );
});

Deno.test("M3: a melt with no proofs is refused (never a silent no-op)", () => {
  return authorizeMelt({
    baseUrl: "https://mint.test/Bitcoin",
    quoteId: "q-1",
    amount: 100,
    feeReserve: 5,
    proofs: [],
    ladder: LADDER,
  }).then(
    () => assert(false, "no proofs must be refused"),
    (e) => assert(e instanceof MeltAuthorizeError, String(e)),
  );
});

// --- M4: NUT-08 change is requested, so sats are not silently kept --------------

Deno.test("M4: blank outputs are sent so a fee-reserve overpayment is NOT stranded", async () => {
  const { calls, fetchImpl } = recordingFetch({ state: "PENDING", change: [{ amount: 3, C_: "02bb" }] });
  const res = await authorizeMelt({
    baseUrl: "https://mint.test/Bitcoin",
    fetchImpl,
    quoteId: "q-1",
    amount: 100,
    feeReserve: 16,
    proofs: proofsWorth(116),
    ladder: LADDER,
  });

  assert(Array.isArray(calls[0].body.outputs) && calls[0].body.outputs.length > 0,
    "NUT-08 blank outputs must be supplied, or the mint keeps the unused reserve");
  for (const o of calls[0].body.outputs) {
    assert(typeof o.B_ === "string" && o.B_.length > 0, "each blank output needs a blinded message");
    assert(typeof o.amount === "number", "each blank output needs an amount");
  }
  // The blinding factors come back so the caller can actually unblind the change.
  assertEquals(res.changeBlindings.length, calls[0].body.outputs.length,
    "we must keep the blinding factors for every blank output we sent");
  assertEquals(res.changeSignatures.length, 1, "the mint's change signature is surfaced");
});

Deno.test("M5: a zero fee reserve sends no blank outputs", () => {
  assertEquals(blankOutputs(0, LADDER), [], "nothing to reserve, nothing to blank");
  assert(blankOutputs(5, LADDER).length > 0, "a real reserve must produce blanks");
});

// --- M6: only the mint may say PAID --------------------------------------------

Deno.test("M6: a 200 from the mint is NOT interpreted as PAID", async () => {
  const { fetchImpl } = recordingFetch({ state: "PENDING" });
  const res = await authorizeMelt({
    baseUrl: "https://mint.test/Bitcoin",
    fetchImpl,
    quoteId: "q-1",
    amount: 100,
    feeReserve: 5,
    proofs: proofsWorth(105),
    ladder: LADDER,
  });
  // We report the state the mint gave us and nothing stronger. PAID only ever
  // arrives via checkMelt, and only on the mint's word.
  assertEquals(res.state, "PENDING", "a 200 is not a verdict — surface the mint's own state");
});

Deno.test("M7: an HTTP failure surfaces as an error, never as success", async () => {
  const { fetchImpl } = recordingFetch({ detail: "quote expired" }, 400);
  await assertRejects(
    () =>
      authorizeMelt({
        baseUrl: "https://mint.test/Bitcoin",
        fetchImpl,
        quoteId: "q-1",
        amount: 100,
        feeReserve: 5,
        proofs: proofsWorth(105),
        ladder: LADDER,
      }),
    MeltAuthorizeError,
  );
});

// --- M8: helpers ---------------------------------------------------------------

Deno.test("M8: totalOf sums proofs and ignores non-finite amounts", () => {
  assertEquals(totalOf([]), 0);
  assertEquals(totalOf(proofsWorth(50)), 50);
  assertEquals(totalOf([...proofsWorth(50), { ...proofsWorth(25)[0] }]), 75);
  assertEquals(
    totalOf([{ amount: Number.NaN, id: "k", secret: "x", C: "02" }]),
    0,
    "a NaN amount must not inflate the total — that would fake funding",
  );
});
