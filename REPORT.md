# cvm-orders task report

Implemented and published `cvm-services/cvm-orders` on branch `worker-worker-base/t_22628f46`.

- TDD state-machine tests: 3/3 pass.
- Lifecycle: paid -> placing -> placed -> ready, with refund alternatives and illegal-transition refusal.
- HTTP poll API: customer order status and facilitator queue.
- Nostr challenge endpoint returns nonce, facilitator npub configuration, expiry, and signing statement.
- Scaffold: Deno runner, MIT license, README/run notes, coverage threshold.

Commit: 10576cd (pushed; verify remote branch before merge).
Coverage run reports 87.5% line coverage for store.ts; generated coverage output is currently committed as evidence.

Known limitation: store is in-memory for the demo; challenge signature verification/session issuance and durable persistence belong to integration follow-ups.
