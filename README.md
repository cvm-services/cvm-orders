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
ORDER_DB_PATH=/var/lib/cvm-orders/orders.sqlite \
  FACILITATOR_NPUB=npub1... deno run --allow-net --allow-env --allow-read --allow-write main.ts
```

`ORDER_DB_PATH` is where the orders live and it is **required in production** (see "Durable state").
A bare `deno run main.ts` — no `ORDER_DB_PATH` — falls back to `data/orders.sqlite` rather than to
memory, so a forgetful start is still durable.

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
* `GET /orders/:id` asks the rail for settlement and takes **exactly once** the claim
  `awaiting_payment -> paid` (`OrderStore.claimSettlement()`: one conditional UPDATE plus a single-use
  `settlement_proofs` row, inside one `BEGIN IMMEDIATE` transaction). A second poll, a second process
  and a restart replay all lose that claim and write nothing. An expired quote expires the order and
  can never pay it.
* `POST /orders/:id/transition` **refuses** `awaiting_payment -> paid` unless the settlement is
  rail-verified, so the public API cannot be used to post an order into `paid`. When it is verified,
  the console takes the *same* exactly-once claim the poll takes — a console click and a customer poll
  racing each other cannot both settle one order.
* One payment request (mint quote) may settle **at most one order**, forever: the second order to
  present the same quote is refused with `settlement_proof_reused` (409) and stays `awaiting_payment`.
* **The service reconciles its own orders** (`src/sweeper.ts`). A sweep starts with the process and
  asks the rail about every `awaiting_payment` order that has an invoice, every
  `ORDER_SWEEP_INTERVAL_MS` (default `30000`; `0` disables it, loudly in the log; a garbage value
  falls back to the default rather than disabling the sweep). `settled` moves the order to `paid`,
  `expired` to `expired` (terminal), and a rail that is unreachable changes nothing and is logged
  once per tick, not once per order.

  Before this, the **only** thing that ever asked the mint "was this invoice paid?" was the
  customer's own browser polling `GET /orders/:id` — close the tab and a paid invoice sat in
  `awaiting_payment` forever. Now a paid invoice settles with the tab gone; the cost is that
  settlement latency is bounded by the interval (the client's poll still usually wins the race), and
  the sweep reads the same store the route does, so a multi-replica deploy would run one sweep per
  replica (the compare-and-set is atomic only within a process).

The rail is `CASHU_MINT_URL` (Cashu NUT-04 over BOLT11). Tests inject an in-memory fake and need no
network. Which mint to point at is [its own document](docs/mint-discovery.md): candidates are probed
for NUT-04/05/07 capability rather than trusted.
The route and the sweep resolve that rail through one lazy per-process `createRailResolver()`, so
they always observe the same rail.

## Durable state (the invoice and the claim outlive the process)

The store is SQLite (`node:sqlite`, WAL) — previously an in-process `Map`, which the deploy script
documented as "a restart empties the queue by design". Two things it lost were money:

* **the invoice.** If a restart re-quoted a second BOLT11 for an order whose first invoice the
  customer had already paid, the sats were stranded and the order could never reach `paid`. The
  invoice is now written with a compare-and-set (`UPDATE ... WHERE invoice IS NULL`), so the first
  invoice wins, survives restarts, and a repeat/concurrent call gets the same `bolt11`.
* **the settlement claim.** `awaiting_payment -> paid` is a claim about money; "exactly once" has to
  hold across processes and restarts, not just inside one isolate. `claimSettlement()` is one
  conditional UPDATE plus a `settlement_proofs` row (PRIMARY KEY on the payment request) inside one
  `BEGIN IMMEDIATE` transaction, and `busy_timeout` makes lock contention wait instead of throwing.

Also durable: the `Idempotency-Key` replay (one basket, one order, still true after a restart) and the
terminal states (`expired`, `ready`, `refunded` have no outgoing edge, so a late poll or a restart
cannot revive an order that was never paid).

Tables: `orders`, `settlement_proofs`, `idempotency`, with `PRAGMA user_version` as the schema
version. `#migrate()` also backfills columns added after the first shipped schema via
`PRAGMA table_info` — `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so a DDL-only
change would work in CI and do nothing on a deployed file (`tests/durable_store_test.ts` opens a real
v1 file and migrates it).

Proof, not assertion (`tests/durable_store_test.ts`, `tests/settlement_claim_test.ts`): restart
durability with a second store over the same file; the first-invoice-wins race; a restart that cannot
re-quote and cannot re-claim; and **four independent OS processes** racing one claim, where exactly
one may win (threads would prove nothing — SQLite's unix VFS takes per-*process* POSIX advisory
locks).

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
