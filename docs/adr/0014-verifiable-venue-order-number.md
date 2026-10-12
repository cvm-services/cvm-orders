# ADR-0014 — Verifiable venue order number on the customer surface

**Status:** Accepted (2026-10-12)
**Context:** CVM facilitated-orders, Stage-1.5 (facilitator checkout, manual venue hand-off)
**Supersedes:** nothing. **Related:** ADR-0008 (payment-rail arbiter), ADR-0013 (no card material), ADR-0007 (fail-closed adapters)

## Decision

The customer-facing order status surface returns a **`venue_reference`** — the
venue's OWN order number, captured by the facilitator from the venue's checkout —
as a first-class, top-level field of the public `GET /orders/:id` response.

- Field name: **`venue_reference`** (same name as the receipt field it mirrors).
- Shape: `{ venue_reference: string | null, venue_reference_url: string | null }`
  — `null` until a facilitator records the venue confirmation on the
  `placing -> placed` transition; non-null from `placed` onward.
- The PWA status screen shows it as **"Venue order #"** *in addition to* the
  facilitator's own sats reference (`id`). Both are shown; neither replaces the
  other, because they are different identifiers for different systems.
- **The customer cannot verify the number on the venue's own website today.**
  That is not a UI gap this ADR can close: the venue's storefront exposes
  authenticated, account-scoped order APIs (see Consequences). This ADR therefore
  delivers a **recorded, verifiable-by-the-human** reference, not a live lookup.

## Why a recorded reference and not a live venue lookup

Recon of the venue rail (FoodAmigos storefront, 2026-10-12) established:

| probe | result | meaning |
|---|---|---|
| `GET app.foodamigos.io/api/franchises?hostname=…` | 200 JSON | public, franchise resolution works |
| `GET app.foodamigos.io/api/orders` (list) | **401** | the customer's order list needs auth |
| `GET app.foodamigos.io/api/orders/{uuid}` | 404 JSON ("No query results for model …") | single-order read is reachable but keyed by the storefront's own UUID, not by an order number |
| customer tracker page `…/order-details/{uuid}` | exists, account-scoped | shows `fulfillment.number` to the *logged-in* customer |

So the venue's order number is **real** (`fulfillment.number`, falling back to
the order UUID) but it is **not** addressable by "type the number into the
website". A pass-through lookup would require the storefront's auth token — i.e.
acting as the customer's account, which is out of contract for Stage-1.5 and a
privacy problem.

**Consequence for the operator test:** the loop is verifiable at the *venue*
(phone/staff/receipt, and the storefront tracker for a logged-in customer), and
the captured number is shown back to the customer by our PWA. It is not typed
into `threebuddies.de` to confirm. Claiming otherwise would be a false promise —
which is exactly what the pre-existing "with order number" timeline line did.

## Fail-closed rules

1. `venue_reference` is present **iff** the persisted receipt has one. No
   fabricated number, no placeholder, no "pending" string.
2. The field is read from the **durable** receipt (SQLite), so it survives a
   restart — the facilitator's device is not the only copy.
3. `assertNoCardMaterial` continues to refuse card data on the way in (ADR-0013),
   so the field can never carry a PAN.

## Consequences

- **Positive:** the customer gets a stable, human-checkable handle to the venue's
  own system; the facilitator's typed confirmation becomes customer-visible; the
  false "with order number" promise is replaced by a real one.
- **Negative / accepted:** the customer still cannot self-verify on the venue
  site. Full automation is Stage-2 (merchant integration: the venue's API or a
  facilitator account), and is explicitly out of scope here.
- **Neutral:** the field is additive; an order without a receipt omits the value
  (`null`) and the UI hides the row rather than showing an empty one.
