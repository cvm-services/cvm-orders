// ADR-0013 — the server-side half of card custody. The guard must refuse card
// material *and* must not refuse the service's own data (timestamps, phone
// numbers, venue order numbers), or `placed` fails at random.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { assertNoCardMaterial, CardMaterialRefused, looksLikePan } from "../src/hygiene.ts";

/** Standard Luhn-valid test number — never real card data, never shipped in src/. */
const TEST_PAN = "4111 1111 1111 1111";
const BARE_PAN = TEST_PAN.replaceAll(" ", "");

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

Deno.test("a PAN embedded in a longer string is refused too (containment)", () => {
  // The first string is the one measured against the console's copy of this
  // guard (cvm-registry t_d38f4d20): it strips the whole value down to digits
  // and tests that once, so the reference's own "3", "9", "2", "2" collapse into
  // the card number, the result is 20 digits long, and the paste was accepted.
  const embedded = [
    `pi_3Qk9Zx2eZvKYlo2C ${BARE_PAN}`,
    `ref 1234 ${BARE_PAN}`,
    `#4471 / ${BARE_PAN}`,
    "4242-4242-4242-4242",
  ];
  for (const value of embedded) {
    assert(looksLikePan(value), `embedded PAN must be caught: ${value}`);
    assertThrows(
      () => assertNoCardMaterial({ payment_reference: value }, "receipt"),
      CardMaterialRefused,
      undefined,
      `embedded PAN must be refused: ${value}`,
    );
  }
});

Deno.test("documented residual: a space-grouped PAN behind another digit run", () => {
  // Stated rather than hidden. Stripping this value leaves 20 digits (outside
  // the 13..19 window) and it has no 13..19 digit run, so the guard does not
  // catch it. Closing it needs sliding windows inside the stripped value, which
  // would refuse the service's own epoch-millisecond-shaped data at random —
  // the bug class the ISO exemption exists to fix. Pinned so the boundary cannot
  // change silently, and mirrored on the decision card for the console half.
  assert(!looksLikePan(`ref 1234 ${TEST_PAN}`), "space-grouped PAN behind a digit run evades");
  assert(looksLikePan(`ref 1234 ${BARE_PAN}`), "the same PAN unspaced is caught");
});

Deno.test("an ISO-8601 timestamp is never refused, even when it looks like a PAN", () => {
  // Stripping the separators from `new Date().toISOString()` leaves a 17-digit
  // value inside the PAN window, and ~1 in 10 of those pass the Luhn check — the
  // console found this on its own copy of the guard (cvm-registry t_4726349b,
  // fixed 1d53cac), where `captured_at` made `placed` fail at random. Ten
  // minutes of seconds proves both halves: 60 of the 600 really are PAN-shaped,
  // and the ISO exemption in the walk accepts every one of them.
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
