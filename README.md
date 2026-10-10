# cvm-orders

Small Deno service that is the source of truth for facilitated order status.

Lifecycle: `paid -> placing -> placed -> ready` or `refunded`. State changes are explicit and
illegal transitions return HTTP 409. The customer polls `GET /orders/:id`; the facilitator polls
`GET /orders/queue`.

## Run

```sh
deno task test
FACILITATOR_NPUB=npub1... deno run --allow-net --allow-env main.ts
```

Endpoints: `POST /orders` (`{id,payload}`), `GET /orders/:id`,
`POST /orders/:id/transition` (`{state, from?, receipt?}`), `GET /orders/queue`, and
`GET /auth/challenge`.

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
(ISO-8601 timestamps are exempt from the PAN heuristic — see `src/hygiene.ts`.)

## Deploy

Run behind the existing reverse proxy as a systemd service, bind localhost, and set
`FACILITATOR_NPUB` in an environment file (`cvm-registry` `deploy/orders-setup.sh`). Persist the
store behind the next database adapter before production; this in-memory implementation is for the
working demo only — a restart empties the queue, and receipts live no longer than the process.
