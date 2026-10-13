/**
 * The order route's handling of customer_npub (ADR-0018).
 *
 * The store refuses a malformed key; the ROUTE must turn that into a 400 with a
 * reason, so the customer sees why instead of a 500 — and so nothing invalid is
 * ever stored for the facilitator's DM tool to trip over later.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normaliseCustomerNpub } from "../src/store.ts";

const PK = "a".repeat(64);

Deno.test("a bare 64-char lowercase hex key is accepted", () => {
  assertEquals(normaliseCustomerNpub(PK), PK);
});

Deno.test("blank means anonymous (the empty-form-field case)", () => {
  for (const v of ["", "   ", undefined, null]) assertEquals(normaliseCustomerNpub(v), null);
});

Deno.test("an npub1... bech32 string is NOT accepted as-is", () => {
  // The API stores hex. Accepting bech32 here would mean two encodings for one
  // identity and a facilitator tool that has to guess which it holds.
  let threw = false;
  try {
    normaliseCustomerNpub("npub1c03rad0r6q833vh57kyd3ndu2jry30nkr0wepqfpsm05vq7he25slryrnw");
  } catch {
    threw = true;
  }
  assert(threw, "bech32 npub must be refused; callers convert to hex first");
});

Deno.test("uppercase, wrong length and non-hex are all refused", () => {
  for (const bad of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), "hello"]) {
    let threw = false;
    try {
      normaliseCustomerNpub(bad);
    } catch {
      threw = true;
    }
    assert(threw, `${bad.slice(0, 12)}… must be refused`);
  }
});
