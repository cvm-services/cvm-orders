# PLAN — "Pay with 2fiat": customer sats → 2fiat top-up → card pays the venue

**Status:** awaiting operator approval (PLAN GATE)
**Date:** 2026-10-13
**Repos:** cvm-orders (rail + order states), contextvm-services (fiat-cvm tools), cvm-registry (console UI)
**Prepared by:** manager session, after the operator's instruction:

> pay with 2fiat should use the sats from the customer to topup the 2fiat account
> via the contextvm and then use the 2fiat card to pay the bill.

## The flow this implements

```
customer pays invoice ──▶ sats at Minibits mint (minted, UNCLAIMED today)
                              │
                              ▼  (1) MELT the quote at the mint
                          sats → Lightning payment
                              │
                              ▼  (2) 2fiat's OWN LN top-up (BTC LN rail)
                          2fiat card balance + amount−6.5%
                              │
                              ▼  (3) 2fiat card charged by the venue/PSP
                          venue paid in fiat. Order placed.
```

Today the chain breaks at step (1): cvm-orders can CREATE mint quotes and poll
them, but it has no melt/claim path, so the customer's sats sit unclaimed at the
mint (documented in the CVM memory notes as the payout-path gap).

## Why this design is right

- **The margin is already sats in the mint.** Fee = 8% (now 21%) of subtotal,
  computed in sats, held as ecash at the mint keyed by quote id. Melting to fund
  the 2fiat wallet reuses money we already hold — no new funding source.
- **The Lightning leg becomes 2fiat's problem, not ours.** 2fiat's BTC-LN rail is
  their documented top-up path; we hand them a payment they already support.
- **Card custody stays exactly where ADR-0013 puts it.** The 2fiat card is charged
  by the venue's PSP (3DS may apply — 2fiat's own UI shows the challenge when it
- does). We never hold or see PAN/CVV. The console only ever sees masked last-4.
- **It is honest about what is automatic.** Steps (1) and (2) are fully unattended.
  Step (3) — the card charge — is 3DS-gated upstream; the console opens the 2fiat
  wallet at the right screen with the amount pre-filled, and tracks the card
  balance/transactions to confirm the charge. "Automatic" ends where 3DS begins,
  and the UI says so.

## Work breakdown

### Phase A — cvm-orders: the melt rail (the missing piece)

TDD. `src/rail.ts` gains a melt path alongside mint quotes:

- `meltQuote(sats) -> {quoteId, bolt11-request-to-pay}` — NUT-05
  `POST /v1/melt/quote/bolt11` with the mint URL from config
- `checkMelt(quoteId)` — poll until PAID
- **Key question this must answer:** how does the mint bind the customer's
  payment to OUR melt? Minibits is NUT-04/05 capable; the exact keyset/blind-
  signature flow (we mint with the quote as input; melt requires the ecash
  tokens) — the sweep logic must hold the tokens from mint time. The sweeper
  service (`src/sweeper.ts`) exists and already polls quote states; extend it,
  don't duplicate it.
- **Operational note:** the mint is `mint.minibits.cash`. Melting consumes the
  ecash the customer paid for. This is REAL money movement — the melt amount is
  bounded by the order total minus the fee already taken, and it can only be
  triggered after the settlement gate opens.

### Phase B — fiat-cvm: the top-up + pay tools

TDD. New tools in `services/fiat-cvm/tools.ts` (server: ADR-0016 architecture):

- `topup(amount_sats)` — calls 2fiat's BTC-LN top-up with the melted sats via
  the ContextVM wire (gift-wrapped kind-25910 MCP calls, same as `cards`/`quote`).
  The fiat-cvm service on x280 currently cannot reach 2fiat (egress blocked) —
  the topup tool executes ON the fiat-cvm service host, so either the block
  clears, or the service moves to testserver2 (reachable). **Decision needed.**
- `pay_bill(card_id, amount_fiat)` — attempts the card charge via 2fiat's API.
  **Depends on discovering a payment endpoint; none was found in the surface
  probe (payments/transfers/payouts all 404).** Without it, `pay_bill` stays
  honest: it returns the 2fiat wallet deep-link pre-filled with the amount and
  the card, tracks the card balance + `vccTransactions` for the charge, and
  reports `requires_3ds`/`confirmed_by_balance` — never a fabricated captured.
- `status(card_id)` — extended to corroborate: balance + latest AUTHORIZATION
  row in vccTransactions matching amount±tolerance.

### Phase C — console: the "Pay with 2fiat" button

TDD + Playwright. In the Venue hand-off pane (ADR-0013 pane), a new action:

- Enabled only when the sats gate is OPEN (unchanged law: sats before fiat).
- Click → runs `quote` → melt → topup automatically (Phases A+B), shows a
  3-step progress (sats melted ✓ → 2fiat topped up ✓ → card charge), then
  hands off to the 2fiat wallet for the card charge (3DS), tracking the
  balance until the charge lands.
- On confirmation, records the venue_reference exactly as the manual flow does
  (same receipt endpoint, same audit trail).

## Non-negotiable invariants (all testable)

1. **Sats before fiat, always.** The button never appears before the gate opens.
2. **No fabricated capture.** `pay_bill` reports only observed states.
3. **Card material never enters the console.** Only masked last-4 and balances.
4. **The melt is bounded by the order total − fee.** No melting more than the
   customer paid; the margin stays in the mint as ecash (operator can sweep
   later; separate workstream).
5. **Every state change is signed by the facilitator key** (NIP-98, same as
   transitions today).

## Open questions for the operator

1. **Where does the fiat-cvm service run?** x280 is blocked by 2fiat's edge
   (self-inflicted). Options: (a) wait for the block to clear (unknown), (b)
   move the service to testserver2 (reachable, proven 200), (c) route x280
   egress via testserver2 (a SOCKS/HTTP proxy or SSH -D). **My recommendation:
   (b) or (c) — decide now so the build target is known.**

2. **The 21% margin vs the 6.5% top-up fee.** Customer pays 121% of venue total;
   operator keeps 21%; 2fiat takes 6.5% on top of the top-up amount. On a 10 EUR
   order: customer pays 12.10 EUR in sats; 10 EUR must land on the card; fee
   already took 2.10; top-up fee at 6.5% of 10 = 0.65. So the operator funds
   0.65 from the 2.10 margin → net margin 1.45 EUR (14.5%). Confirm this
   economics is acceptable, or cap the top-up to (total − fee − topup_fee).

3. **Melt binding mechanics at Minibits.** NUT-05 melt requires ecash tokens,
   which exist only after the customer's payment mints them. The sweeper must
   hold tokens from mint time. I need to read `src/sweeper.ts` and the mint's
   NUT-05 surface before Phase A implementation; if the mint's melt path
   requires keyset info we don't hold, this is a hard blocker to report, not
    work around.

## Urgency

Operator-directed feature with a live blocked order needing resolution.
**NOW** for the design (this document); Phase A start immediately after
approval. Quota: proxy gate passes; ours 5-hour window spent, weekly 40% —
headroom exists on weekly, prefer implementing now with the operator present.
