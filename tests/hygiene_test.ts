// ADR-0013 — the server-side half of card custody. The guard must refuse card
// material *and* must not refuse the service's own data (timestamps, phone
// numbers, venue order numbers), or `placed` fails at random.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { assertNoCardMaterial, CardMaterialRefused, looksLikePan } from "../src/hygiene.ts";

/** Standard Luhn-valid test number — never real card data, never shipped in src/. */
const TEST_PAN = "4111 1111 1111 1111";

Deno.test("a Luhn-valid card number is refused wherever it hides", () => {
  assert(looksLikePan(TEST_PAN), "the fixture must be Luhn-valid or this test proves nothing");
  assertThrows(() => assertNoCardMaterial({ payment_reference: TEST_PAN }, "receipt"), CardMaterialRefused);
  assertThrows(() => assertNoCardMaterial({ note: { deep: [TEST_PAN] } }, "payload"), CardMaterialRefused);
  assertThrows(() => assertNoCardMaterial({ pan: "x" }, "payload"), CardMaterialRefused);
  assertThrows(() => assertNoCardMaterial({ card_number: "x" }, "payload"), CardMaterialRefused);
  assertThrows(() => assertNoCardMaterial({ cvv: "123" }, "payload"), CardMaterialRefused);
});

Deno.test("no test PAN ships in the service sources", () => {
  for (const file of ["src/hygiene.ts", "src/store.ts", "src/nip98.ts", "main.ts"]) {
    const source = Deno.readTextFileSync(file);
    assert(!source.includes(TEST_PAN), `${file} carries card-shaped test data`);
    assert(!source.includes(TEST_PAN.replaceAll(" ", "")), `${file} carries card-shaped test data`);
  }
});

Deno.test("the service's own data is not mistaken for card material", () => {
  assert(!looksLikePan("+49 151 1234 5678"), "a phone number is not a PAN");
  assert(!looksLikePan("#4471"), "a venue order number is not a PAN");
  assert(!looksLikePan("pi_1AbC"), "a PSP reference is not a PAN");
  assertNoCardMaterial({
    payload: {
      venue_slug: "pizza-e-pasta",
      customer: { phone: "+4915112345678" },
      settlement: { status: "settled", settled_at: "2026-10-10T18:19:58Z" },
      items: [{ name: "Pizza", unit_fiat: "9.50", unit_sats: 12500 }],
    },
  }, "payload");
});

Deno.test("an ISO-8601 timestamp is never refused, even when it looks like a PAN", () => {
  // Stripping the separators from `new Date().toISOString()` leaves a 17-digit
  // run, and ~1 in 10 of those pass the Luhn check. The console found this on its
  // own copy of the guard (cvm-registry t_4726349b): `captured_at` made `placed`
  // fail at random. Ten minutes of seconds is enough to prove both halves.
  const base = Date.UTC(2026, 9, 10, 18, 0, 0);
  let panShaped = 0;
  for (let i = 0; i < 600; i++) {
    const timestamp = new Date(base + i * 1000).toISOString();
    if (looksLikePan(timestamp)) panShaped++;
    assertNoCardMaterial({ venue_reference: "#4471", captured_at: timestamp }, "receipt");
  }
  assert(panShaped > 0, "the sample must contain PAN-shaped timestamps, or this proves nothing");
  assertEquals(panShaped, 60, "measured rate for this window: 1 in 10 timestamps");
});
