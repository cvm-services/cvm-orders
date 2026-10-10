# t_d790103d — cvm-orders: server-side NIP-98 verification + durable venue receipt

Branch: `pr/orders-nip98-auth-receipt` (off `main` 809c872) in `cvm-services/cvm-orders`.
Commits: `54c652c` (implementation), `20e3acc` (tests), plus the docs commit below.
Verification: `deno task test` → **35 passed, 0 failed**; coverage 88.8% line / 98.2% function.

## 1. Server-side NIP-98 verification (`src/nip98.ts`, `main.ts`)

`GET /auth/challenge` still issues a single-use nonce, but the service now verifies the event
itself instead of delegating to the console:

| check | implementation |
|---|---|
| header | `authorization: Nostr <base64 event>`, base64 (standard or url-safe) of a JSON event |
| shape | kind 27235, 64-hex `pubkey`/`id`, 128-hex `sig`, `tags` array of string arrays |
| identity | `pubkey == FACILITATOR_NPUB` **and** schnorr verification of the NIP-01 id + signature (`@noble/curves`, not a string compare) |
| freshness | `created_at` within the challenge TTL, ≤ 60s in the future |
| binding | `payload` tag = `sha256(nonce)` of a live challenge; `u`/`method` must name this request |
| replay | single-use nonce store (`sha256(nonce) -> nonce`) with TTL = `expiresIn`; one nonce backs exactly one event id; expired nonces swept on sight |
| fail closed | no valid event ⇒ **401 before the body is read**, no state change; unset/invalid `FACILITATOR_NPUB` closes every facilitator route |

Two credential forms are accepted, and this is the one deliberate design decision on the card:

* **request-bound** (`u` = the request URL, `method` = the method) — one-shot; the nonce is spent.
* **challenge-bound** (`u` = the challenge endpoint, `method` = GET) — what the deployed console
  (`cvm-registry` `pr/facilitator-console`, `site/console/app.js` `signIn()`/`authHeaders()`)
  actually sends: it signs the challenge **once** at sign-in and re-attaches that same event to
  every call. Without this form the console would break on its first POST, and the card names that
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

## 3. Defect found and fixed on the way (ADR-0013 guard)

`captured_at` is `new Date().toISOString()`. Stripping its separators leaves a 17-digit run that
passes the Luhn check for ~1 in 10 seconds, so the server-side card guard refused the console's own
receipt at random (intermittent 422 on `placed`). `src/hygiene.ts` now exempts ISO-8601 timestamps;
the regression test measures the rate (60 of 600 consecutive seconds PAN-shaped) so the exemption
cannot be removed silently. This is the same defect the console fixed in its own copy of the guard
in `cvm-registry` t_4726349b — found there first, fixed here before it could bite the server.

## Evidence

* `deno task test` (test task now grants `--allow-read --allow-env --allow-net`, matching the
  sister repo `cvm-registry`): 35 passed / 0 failed, 2s. Coverage: `src/store.ts` 99.1% line,
  `src/hygiene.ts` 95.8%, `src/nip98.ts` 88.7%, `main.ts` 76.1%.
* Real signatures everywhere: `tests/signing.ts` signs with `nostr-tools` (`finalizeEvent`), so the
  verifier is never checked against signatures it produced itself; npub/hex helpers are compared
  against `nip19`.
* `tests/route_test.ts` ends with a **real HTTP** test: `Deno.serve` on an ephemeral port, an
  unauthenticated `POST /orders/:id/transition` over the socket → 401 with the order still `paid`,
  then the console's sign-in challenge → `placed` → receipt returned and readable on
  `GET /orders/:id`.
* Live pre-state probe of the deployed service (unchanged code, no credential):
  * `GET https://cvm-pwa.orangesync.tech/api/orders/queue` → **200** `{"orders":[]}` (should be 401)
  * `POST .../api/orders/kanban-probe-does-not-exist/transition {"state":"placing"}` → **409**
    `{"error":"order not found"}` (should be 401 — the request reached the store with no credential)
  * `GET .../api/health` → 200.
    The probe used a non-existent order id, so no real order was touched.

## Constraints (ADR-0013 / ADR-0008 / t_63be63f1)

* No card material anywhere: order payloads and receipts pass `assertNoCardMaterial` (card field
  names, Luhn-valid PAN-shaped values) and are refused with 422 before any state change. The
  receipt is the receipt only — `payment_reference` is a PSP/terminal reference.
* The fiat step stays gated on a proven sats settlement: this change never invents, weakens or
  bypasses the settlement gate — it only verifies *who* is calling and stores what the venue said.
  No settlement field is written, defaulted or inferred here, so `t_63be63f1`'s gate is untouched.
* Nothing in this change is persisted outside the in-memory store (still a demo store; a restart
  empties it).

## Follow-ups (not done here)

1. **Deploy.** The running instance at `cvm-pwa.orangesync.tech` is still the unpatched code (probe
   above). Re-run `cvm-registry` `deploy/orders-setup.sh` (FACILITATOR_NPUB + `NIP98_STRICT=1`
   where the console is updated to sign per request) after this branch merges.
2. **Console cross-device display.** The console prefers its device copy and only falls back to
   `o.payload?.receipt` (`receiptOf`), so a *second* device still shows no receipt. The persistence
   indicator the card mentions (`res?.receipt`) works with no console change; a one-line console
   change to read `order.receipt` would close the cross-device case.
3. **Durability.** The store is in memory: `OrderStore` needs a database adapter that preserves
   `receipt` semantics (atomic with the state change, receipts out of the queue projection).
