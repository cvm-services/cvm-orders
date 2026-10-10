# cvm-orders — feat/invoice-endpoint

Worktree: /home/c03rad0r/worktrees/order-invoice @ origin/main 3e92e97, branch feat/invoice-endpoint

- [x] recon: shipped PWA read (https://cvm-pwa.orangesync.tech/order/) — POST /api/orders {venue_slug,items,fulfilment,inputs}; items are {name,qty,amount,options} with NO sku; GET /api/orders/:id/invoice -> {bolt11,qr}; GET /api/orders/:id poll. Catalog = /menu.json (EUR, prices_by_order_method), client rate 1 EUR = 1000 sats, fee = 8%.
- [x] config/venues.json — server-side catalog copy of the shipped /menu.json (sha256 pinned)
- [x] RED tests committed + failing output captured (lifecycle 6/6 FAILED; catalog/invoice did not load)
- [x] store: awaiting_payment/expired + money fields + ensureInvoice (one invoice/order, shared in flight)
- [x] src/catalog.ts: server-side pricing (fee floor(8%), boundary pinned; sku OR exact-name identity)
- [x] POST /orders (validate + recompute + Idempotency-Key)
- [x] GET /orders/:id/invoice (once per order, cached, 503 without rail)
- [x] GET /orders/:id rail settlement -> exactly one CAS to paid; expired stays expired
- [x] POST /orders/:id/transition refuses awaiting_payment -> paid unless rail-verified
- [x] deno check clean; deno task test green (98 passed / 0 failed)
- [x] README updated; REPORT.md written

RESUME NOTE (2026-10-10): the dispatched worker finished A-F but its session timed out at 3600s
before it could commit/push/PR. Manager recovered the tree, fixed one dangling `store` reference in
tests/route_test.ts (line 238 destructured only `handle`), verified 98/0, and shipped.
