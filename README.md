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

Endpoints: `POST /orders` (`{id,payload}`), `GET /orders/:id`, `POST /orders/:id/transition`
(`{state}`), `GET /orders/queue`, and `GET /auth/challenge`. The challenge nonce is short-lived by
contract; signature verification/session issuance is intentionally delegated to the console boundary
in this first store slice.

## Deploy

Run behind the existing reverse proxy as a systemd service, bind localhost, and set
`FACILITATOR_NPUB` in an environment file. Persist the store behind the next database adapter before
production; this in-memory implementation is for the working demo only.

Live deployment (2026-10-10): `/opt/tollgate/cvm-orders` on the PWA host, unit `cvm-orders.service`,
`EnvironmentFile=/etc/cvm-orders/config.env` (`FACILITATOR_NPUB`, `PORT=8788`). Caddy on the same
host serves `cvm-pwa.orangesync.tech` and strips `/api/*` onto `127.0.0.1:8788`, so both PWAs call
`/api/...` on their own origin. `BIND_ADDR` defaults to `127.0.0.1`; setting it to `0.0.0.0` exposes
an unauthenticated store to the network.
