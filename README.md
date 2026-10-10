# cvm-orders

Small Deno service that is the source of truth for facilitated order status.

Lifecycle: `awaiting_payment -> paid -> placing -> placed -> ready`, or `awaiting_payment ->
expired`, or `refunded` before placement. State changes are explicit and illegal transitions return
HTTP 409. The customer polls `GET /orders/:id`; the facilitator polls `GET /orders/queue`.

An order is **born `awaiting_payment`, never `paid`**. `paid` is reachable only through a verified
payment-rail settlement (ADR-0008), so `GET /orders/queue` — the facilitator's payable list — only
ever contains orders whose sats are already final.

## Run

```sh
deno task test
FACILITATOR_NPUB=npub1... deno run --allow-net --allow-env main.ts
```

Endpoints: `POST /orders` (the basket: `{venue_slug, items, fulfilment, inputs}`),
`GET /orders/:id/invoice`, `GET /orders/:id`,
`POST /orders/:id/transition` (`{state, from?, receipt?}`), `GET /orders/queue`, and
`GET /auth/challenge`.

## Pricing and the sats gate (ADR-0008)

Prices are **never** taken from the client. `POST /orders` receives `{venue_slug, items, fulfilment,
inputs}` and the server recomputes every line from the committed catalog (`config/venues.json`, a
pinned copy of the PWA's own `/menu.json`; `src/catalog.ts`). A client sending `amount: 1` for a €12
pizza does not change the charge — there are tests for both directions. An item is identified by
`sku` **or** by exact name, because the shipped client sends no sku. A basket that cannot be priced
is a 400 with a reason, and creates no order.

The facilitator fee is **`floor(8% of subtotal)` in integer sats**, added to the subtotal. The
rounding rule is deliberate (floor; never round-up, never float) and the boundary is pinned in
`tests/catalog_test.ts`. `POST /orders` returns `{id, state, subtotal, fee, total, expires_at}` and
honours an `Idempotency-Key` header, so a client retry returns the same order rather than creating a
second one.

Sats are final **before** any fiat spend. The gate is structural, not advisory:

* `GET /orders/:id/invoice` creates the BOLT11 **once** per order through the rail (`src/rail.ts`),
  caches it, and returns `{bolt11, qr, expires_at, total}`; repeat calls return the same invoice
  while it is unexpired. `qr` is a self-contained `data:` URI, so the client's `<img src>` needs no
  extra fetch. With no rail configured the endpoint is a **503 with a machine-readable body — never
  a bogus invoice**.
* `GET /orders/:id` asks the rail for settlement and performs **exactly one** compare-and-set
  `awaiting_payment -> paid`. A second poll does not transition again. An expired quote expires the
  order and can never pay it.
* `POST /orders/:id/transition` **refuses** `awaiting_payment -> paid` unless the settlement is
  rail-verified, so the public API cannot be used to post an order into `paid`.

The rail is `CASHU_MINT_URL` (Cashu NUT-04 over BOLT11). Tests inject an in-memory fake and need no
network. Which mint to point at is [its own document](docs/mint-discovery.md): candidates are probed
for NUT-04/05/07 capability rather than trusted.

## Authentication (NIP-98, verified here)

The service is the boundary. `GET /auth/challenge` issues a single-use nonce; the facilitator
signs it with a NIP-07/NIP-46 signer and sends the signed event back on every facilitator call:

```
authorization: Nostr <base64(JSON event)>
```

The event must be kind `27235`, signed by `FACILITATOR_NPUB` (real schnorr verification, not a
pubkey string comparison), carry `payload` = `sha256(nonce)` of a live challenge, keep
`created_at` inside the challenge TTL (with 60s of tolerated future drift), and name the request
in `u`/`method`. Nonces are single use with a TTL of `expiresIn` (300s). Anything that is not
demonstrably a fresh facilitator event is a 401 **before the body is read**, and no state changes.
An unset, unusable or non-public `FACILITATOR_NPUB` closes every facilitator route.

Two credential forms are accepted:

* **request-bound** — `u` = the request URL, `method` = the request method. One-shot: the nonce is
  spent by that request. Preferred.
* **challenge-bound** — `u` = the challenge endpoint, `method` = GET. This is what the deployed
  facilitator console (`cvm-registry` `pr/facilitator-console`) signs once at sign-in and
  re-attaches to every call, so the event acts as a short-lived credential for the nonce's TTL. A
  different event for the same nonce is still refused as replay.

Set `NIP98_STRICT=1` to refuse the challenge-bound form and require a fresh request-bound event per
call (the console would then have to sign per request).

The service is mounted behind the PWA vhost under `/api/*` (caddy `handle_path` strips the prefix),
so the `u` tag usually reads `https://<host>/api/orders/...` while the service sees
`/orders/...`; the path match accepts that suffix, the host must still be this request's own host.

## The venue receipt

When the facilitator marks an order `placed`, the console posts what the venue told them:

```json
{"state":"placed","receipt":{"venue_reference":"#4471","ready_at":"18:25",
 "paid_with":"card at venue terminal","payment_reference":"pi_1AbC",
 "captured_at":"2026-10-10T18:20:03.123Z"}}
```

The receipt is stored **server-side** in the same atomic step as the state change
(`OrderStore.transition(id, to, {from, receipt})` — `from` is an explicit compare-and-set, and
everything is validated before anything is written), is returned by the transition response and by
`GET /orders/:id`, and never affects who is in `GET /orders/queue`. The console reports "persisted
server-side" when the transition response carries the receipt, and "captured on device" when it
does not.

## Card custody (ADR-0013)

Card material never enters this service: `POST /orders` payloads and receipts pass through
`assertNoCardMaterial`, which refuses card field names and Luhn-valid PAN-shaped values with HTTP
422 before any state change. `payment_reference` is a PSP/terminal reference, never a card number.

The PAN check refuses two shapes: a value that *is* a card number however it is grouped
(`"4111 1111 1111 1111"`) and a card number *embedded* in a longer value
(`"pi_3Qk9Zx2eZvKYlo2C <card>"`, the plausible paste after a PSP reference — the client half of
this guard misses that one, see `cvm-registry` t_d38f4d20). Known residual, stated rather than
hidden: a *space-grouped* card number that follows another digit run in the same value is not
caught. ISO-8601 timestamps are exempt from the heuristic — without that exemption the guard
refuses the console's own `captured_at` at random. Details and the measured rates are in
`src/hygiene.ts` and `tests/hygiene_test.ts`.

## Deploy

Run behind the existing reverse proxy as a systemd service, bind localhost, and set
`FACILITATOR_NPUB` in an environment file (`cvm-registry` `deploy/orders-setup.sh`). Set
`CASHU_MINT_URL` to a mint that passed `scripts/discover-mints.ts` (see
[docs/mint-discovery.md](docs/mint-discovery.md)); without it the invoice endpoint answers 503 and
the PWA's Pay button cannot complete a payment. Persist the
store behind the next database adapter before production; this in-memory implementation is for the
working demo only — a restart empties the queue, and receipts live no longer than the process.

Live deployment (2026-10-10): `/opt/tollgate/cvm-orders` on the PWA host, unit `cvm-orders.service`,
`EnvironmentFile=/etc/cvm-orders/config.env` (`FACILITATOR_NPUB`, `PORT=8788`). Caddy on the same
host serves `cvm-pwa.orangesync.tech` and strips `/api/*` onto `127.0.0.1:8788`, so both PWAs call
`/api/...` on their own origin. `BIND_ADDR` defaults to `127.0.0.1`; setting it to `0.0.0.0` exposes
an unauthenticated store to the network.
