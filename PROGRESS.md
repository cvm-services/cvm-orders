# cvm-orders — pr/orders-server-sweep (G1: the service settles its own orders)

Worktree: /home/c03rad0r/worktrees/t_cc2809fb, branch `pr/orders-server-sweep`, forked from origin/main.
Reports + raw command output: /home/c03rad0r/reports/t_cc2809fb/ (red-1-module-missing.txt,
red-2-behavioural.txt, green-sweeper-unit.txt, full-suite.txt, deno-check.txt).

- [x] recon: the gap, measured live 2026-10-11 — the only thing that ever asked the mint "was this
      invoice paid?" was the CUSTOMER's browser polling `GET /orders/:id`. No server-side reconciler.
- [x] RED #1: tests/sweeper_test.ts committed before src/sweeper.ts exists (TS2307, module missing) → 6592d34
- [x] RED #2: signatures-only stub, so the 12 tests fail on BEHAVIOUR (1 passed / 11 failed) → captured
- [x] GREEN: src/sweeper.ts — settle/expire CAS, rail-dead tolerance, tick scoping, interval parsing → 8b1e421
- [x] wiring: main.ts — one lazy per-process rail resolver shared by route + sweep; sweep starts at boot → 08a71e1
- [x] end-to-end: tests/sweeper_service_test.ts drives the real wiring against a fake mint over HTTP;
      the order reaches paid/expired with ZERO order-endpoint reads
- [x] coverage: new tests/route_surface_test.ts lifts main.ts 73.7% -> 86.4% line (floor is 80%);
      all files 87.0% -> c09d55a
- [x] deno check clean on main.ts, src/sweeper.ts and the three suites
- [x] full suite: 121 passed (2 steps) / 0 failed (18s)  [98 on origin/main]
- [x] README (ORDER_SWEEP_INTERVAL_MS, boot-time sweep, one-rail-per-process) + REPORT.md rolled
- [x] coverage/ restored (never committed), tree clean apart from docs

RESUME NOTE: if this branch is picked up again, the only thing deliberately left unproven is
behaviour against a REAL mint — see "What this does NOT prove" in REPORT.md. Nothing here is durable
(the store is in-memory) and the sweep assumes one process per store.
