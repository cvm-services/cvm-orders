# ADR-0018 — The customer's npub on the order

**Status:** Accepted (2026-10-13)
**Depends on:** ADR-0017 (customer identity), ADR-0008 (sats settle before fiat)

## Context

ADR-0017 gave the customer a Nostr identity on the order surface. Nothing in the
order pipeline knew about it: the service stored a contact phone at best, and the
facilitator console read a `payload.customer.{phone,npub}` shape the service had
never written — so the queue always said "no phone" and there was no way to reach
a customer about a problem with their order.

Two flows must both work:
- the customer signs in **before** ordering, and
- (the common one) they **pay first and sign in at the receipt** — so the
  identity arrives *after* the order exists.

## Decision

The order carries an optional `customer_npub`.

**One encoding.** A bare 64-character lowercase-hex x-only pubkey. `npub1…`
bech32 is refused at the API boundary — accepting both would mean one identity
in two encodings and a facilitator tool that has to guess which it holds.

**Absent means anonymous.** A blank/whitespace value is "no identity", not an
error: an empty form field must not fail an order. Anything else non-empty that
is not a real pubkey is a hard 400 with `reason: invalid_customer_npub`, so the
customer learns immediately instead of the facilitator's DM tool failing later.

**The first identity wins.** `POST /orders/:id/identity` attaches an npub to an
order that has none. It is deliberately **unauthenticated** — the customer is not
a facilitator — and safe without auth because the write is a compare-and-set on
`customer_npub IS NULL`. Knowing an order id therefore cannot redirect the
facilitator's messages to someone else. Outcomes: `attached`, `unchanged` (same
key again — idempotent), `conflict` (a different key is already there, 409), or
`missing` (404).

**Facilitator-visible, customer-invisible.** The npub appears in the facilitator
queue and the order detail. It is NOT echoed into the customer-facing order body
(the customer already knows their own key) and not in the printed receipt, so no
public surface starts carrying it.

**Durability.** The npub is a column on `orders`, added by the existing additive
migration, so it survives a restart like the invoice and the settlement claim.

## Consequences

- The console can show "npub 4f355bdc…" and DM the customer; an anonymous order
  says so plainly, which is honest rather than a tool that silently does nothing.
- The console's DM path and phone display now read the shapes the service
  actually writes (`inputs["contact.phone"]`, `order.customer_npub`) instead of
  the shape it appeared to write. This fixes a pre-existing display bug: every
  order showed "no phone" even when the customer had given one.
- An order can hold one identity, forever. A customer who loses their key cannot
  replace it on an existing order; that is the price of not letting an order id
  be a takeover handle.

## Alternatives rejected

- **Authenticate the attach call (NIP-98 from the customer).** Real customers on
  a phone at a restaurant table will not sign a second time for a nicety, and the
  compare-and-set already removes the attack the auth would prevent.
- **Overwrite on attach.** Turns a leaked order id into a way to hijack the
  facilitator's messages about another customer's order.
- **Store the npub inside `payload` only.** `payload` is the client-supplied
  blob; the identity is service-owned state and belongs in a column.
