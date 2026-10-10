# t_d790103d — cvm-orders: server-side NIP-98 verification + durable venue receipt

Branch: `pr/orders-nip98-auth-receipt` (off `main` 809c872) in `cvm-services/cvm-orders`.
Pull request: **#3** — https://github.com/cvm-services/cvm-orders/pull/3 (OPEN, MERGEABLE, 14 files).
Commits: `54c652c` implementation · `20e3acc` tests · `6a95efb` route test + docs · `399bf3b` card
guard + flake. Head pushed and verified on the remote (`6a95efb` → `399bf3b`, `git rev-parse` on
both sides equal, `git ls-remote` listed).
Verification: `deno task test` → **37 passed, 0 failed over three consecutive runs** (each 3s).
Coverage: 89.0% line / 98.3% function / 86.2% branch (gate `.coverage-threshold` = 80).
No CI is configured in this repo (no `.github/workflows`, no `.ngit/act/workflows`), so the runs
above are the verification; there is no CI status to report.

## 1. Server-side NIP-98 verification (`src/nip98.ts`, `main.ts`)

`GET /auth/challenge` still issues a single-use nonce, but the service now verifies the event
itself instead of delegating to the console:

| check | implementation |
|---|---|
| header | `authorization: Nostr <base64 event>`, standard or url-safe base64 of a JSON event |
| shape | kind 27235, 64-hex `pubkey`/`id`, 128-hex `sig`, `tags` array of string arrays |
| identity | `pubkey == FACILITATOR_NPUB` **and** schnorr verification of the NIP-01 id + signature (`@noble/curves`, not a string compare). The key is validated as a real x-only point, so an unusable `FACILITATOR_NPUB` closes the routes instead of opening them |
| freshness | `created_at` within the challenge TTL, ≤ 60s in the future |
| binding | `payload` tag = `sha256(nonce)` of a live challenge; `u`/`method` must name this request |
| replay | single-use nonce store (`sha256(nonce) -> nonce`) with TTL = `expiresIn`; one nonce backs exactly one event id; expired nonces swept on sight |
| fail closed | no valid event ⇒ **401 before the body is read**, no state change; unset/invalid `FACILITATOR_NPUB` closes every facilitator route |

Two credential forms are accepted, and this is the one deliberate design decision on the card:

* **request-bound** (`u` = the request URL, `method` = the method) — one-shot; the nonce is spent.
* **challenge-bound** (`u` = the challenge endpoint, `method` = GET) — what the deployed console
  (`cvm-registry` `pr/facilitator-console`, `site/console/app.js` `signIn()`/`authHeaders()`)
  actually sends: it signs the challenge **once** at sign-in and re-attaches that same event to
  every call. Without this form the console breaks on its first POST, and the card names that
  branch as the consumer. A *different* event for the same nonce is still refused as replay, and
  `NIP98_STRICT=1` refuses the form outright and requires a fresh request-bound event per call.

`u` path matching is equal-or-suffix, because the public vhost mounts the service under `/api/*`
and caddy's `handle_path` strips that prefix before the reverse proxy (so the console signs
`https://cvm-pwa.orangesync.tech/api/orders/:id/transition` and the service sees
`/orders/:id/transition`). The host must still be this request's own host (`Host`/`X-Forwarded-Host`
included), which is what the `foreign host, same path` test pins.

## 2. Durable venue receipt (`src/store.ts`, `main.ts`)

* `Order.receipt` = `{venue_reference, ready_at?, paid_with?, payment_reference?, captured_at?}`.
* `OrderStore.transition(id, to, meta?)` where `meta = {from?, receipt?}`: `from` is an explicit
  compare-and-set on the caller's view of the state, and the receipt lands in the **same atomic
  swap** as the state change. Everything is validated before anything is written, so a refused
  transition leaves the order byte-identical (state *and* receipt) — the same discipline `claim`
  used.
* Receipt validation: object, `venue_reference` required and non-blank, known fields only, strings
  only, trimmed; empty optional fields dropped.
* Returned by the transition response (this is the exact field the console tests:
  `saveReceipt(..., res?.receipt ? "persisted server-side" : "captured on device")`) and by
  `GET /orders/:id`. A queue listing never carries a receipt and receipts never affect who is in
  `queue()` (filtering stays on state alone).
* `GET /orders/:id` still accepts an unauthenticated customer poll; a credential that is *present*
  must be valid (401), so an expired console credential cannot silently degrade into an
  unauthenticated read.

## 3. Two defects found and fixed on the way

**(a) The ADR-0013 guard refused the service's own data.** `captured_at` is
`new Date().toISOString()`; stripping its separators leaves a 17-digit value inside the PAN window
that passes Luhn for ~1 in 10 seconds, so the guard refused a legitimate receipt at random
(intermittent 422 on `placed`). The same defect was found and fixed on the console's copy of the
guard first (`cvm-registry` `1d53cac` on `pr/console-happy-path-video`, by the T4 recording,
card t_4726349b). `src/hygiene.ts` exempts ISO-8601 values; the regression test measures the rate
(60 of 600 consecutive seconds are PAN-shaped without the exemption) so the exemption cannot be
removed silently.

**(b) The guard let an embedded card number through — the server half of the gap the console's
copy has** (`cvm-registry` t_d38f4d20, which holds the decision for the client half).
`looksLikePan()` stripped the whole value down to digits and tested that once, so the paste that
card measures — `"pi_3Qk9Zx2eZvKYlo2C 4242424242424242"` — returned false: the reference's own
digits collapse into the card number, the stripped value lands outside the 13..19 window, and on
this side the value would have been **persisted**. The guard now refuses both shapes:

* the value *is* a card number however it is grouped (strip, then test once);
* the value *contains* one as a contiguous 13..19 digit run (scan the runs).

Neither check alone is sufficient, and the first draft of the fix proved it: run scanning alone
silently stopped refusing a **spaced** PAN (`"4111 1111 1111 1111"`) because each 4-digit group is
its own run. The existing store/route/hygiene tests caught that regression immediately.

Known **residual, stated rather than hidden and pinned by a test**: a *space-grouped* card number
that follows another digit run in the same value (`"ref 1234 " + a 4-4-4-4 card number`) is
stripped to more than 19 digits and has no 13..19 run, so it is not caught. Closing it needs
sliding windows inside the stripped value, which would refuse epoch-millisecond-shaped data at
random — the same bug class as (a). The window (13..19 + Luhn) is deliberately unchanged.

**(c) A genuine 1-in-32 flake in my own test suite.** `tests/nip98_test.ts` corrupted a per-run
random npub by appending a fixed character, so when the npub already ended in it the mutation was a
no-op and the assertion passed without probing the checksum. The corruption is now deterministic.

## Evidence

* `deno task test` three consecutive times: **37 passed / 0 failed**, 3s each. Coverage:
  `src/store.ts` 99.1% line, `src/hygiene.ts` 95.8%, `src/nip98.ts` 89.0%, `main.ts` 76.1%,
  all files 89.0% line / 98.3% function / 86.2% branch.
* Real signatures everywhere: `tests/signing.ts` signs with `nostr-tools` (`finalizeEvent`), so the
  verifier is never checked against signatures it produced itself; npub/hex helpers are compared
  against `nip19`.
* `tests/route_test.ts` ends with a **real HTTP** test: `Deno.serve` on an ephemeral port, an
  unauthenticated `POST /orders/:id/transition` over the socket → 401 with the order still `paid`,
  then the console's sign-in challenge → `placed` → receipt returned and readable on
  `GET /orders/:id`.
* Local-only check that no test card number ships in the service sources (a test asserts it).
* Live pre-state probe of the deployed service (unchanged code, no credential):
  * `GET https://cvm-pwa.orangesync.tech/api/orders/queue` → **200** `{"orders":[]}` (should be 401)
  * `POST .../api/orders/kanban-probe-does-not-exist/transition {"state":"placing"}` → **409**
    `{"error":"order not found"}` (should be 401 — the request reached the store with no credential)
  * `GET .../api/health` → 200.
    The probe used a non-existent order id, so no real order was touched.

## Constraints (ADR-0013 / ADR-0008 / t_63be63f1)

* No card material anywhere: order payloads and receipts pass `assertNoCardMaterial` (card field
  names, PAN-shaped values) and are refused with 422 before any state change. The receipt is a
  receipt only — `payment_reference` is a PSP/terminal reference.
* The fiat step stays gated on a proven sats settlement: this change never invents, weakens or
  bypasses the settlement gate — it only verifies *who* is calling and stores what the venue said.
  No settlement field is written, defaulted or inferred here, so `t_63be63f1`'s gate is untouched.
* Nothing in this change is persisted outside the in-memory store (still a demo store; a restart
  empties it).

## Follow-ups (not done here)

1. **Deploy.** The running instance at `cvm-pwa.orangesync.tech` is still the unpatched code (probe
   above): unauthenticated callers can read the queue and reach the store. Re-run `cvm-registry`
   `deploy/orders-setup.sh` (`FACILITATOR_NPUB`, plus `NIP98_STRICT=1` once the console signs per
   request) after this branch merges. **Security-relevant: the hole is live until then.**
2. **Console half of the card guard.** `site/console/app.js` still has the whole-value form;
   t_d38f4d20 owns that decision. This branch implements its option (a) on the server and leaves a
   comment on that card with the measurements, so the two halves can converge on one rule.
3. **Console cross-device display.** The console prefers its device copy and only falls back to
   `o.payload?.receipt` (`receiptOf`), so a *second* device still shows no receipt. The persistence
   indicator the card mentions (`res?.receipt`) works with no console change; a one-line console
   change to read `order.receipt` would close the cross-device case.
4. **Durability.** The store is in memory: `OrderStore` needs a database adapter that preserves
   `receipt` semantics (atomic with the state change, receipts out of the queue projection).
