# cvm-orders — feat/invoice-endpoint

Worktree: /home/c03rad0r/worktrees/order-invoice @ origin/main 3e92e97, branch feat/invoice-endpoint

- [x] recon: shipped PWA read (https://cvm-pwa.orangesync.tech/order/) — POST /api/orders {venue_slug,items,fulfilment,inputs}; items are {name,qty,amount,options} with NO sku; GET /api/orders/:id/invoice -> {bolt11,qr}; GET /api/orders/:id poll. Catalog = /menu.json (EUR, prices_by_order_method), client rate 1 EUR = 1000 sats, fee = 8%.
- [x] config/venues.json — server-side catalog copy of the shipped /menu.json (sha256 pinned)
- [ ] RED tests committed + failing output captured
- [ ] store: awaiting_payment/expired + money fields + ensureInvoice
- [ ] src/catalog.ts: server-side pricing (fee floor, boundary tested)
- [ ] POST /orders (validate + recompute + Idempotency-Key)
- [ ] GET /orders/:id/invoice (once per order, cached, 503 without rail)
- [ ] GET /orders/:id rail settlement -> exactly one CAS to paid; expired stays expired
- [ ] POST /orders/:id/transition refuses awaiting_payment -> paid unless rail-verified
- [ ] deno check + deno task test green; push; PR; REPORT.md
