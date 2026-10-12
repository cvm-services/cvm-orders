# cvm-orders — durable settlement, rebased onto the G1 sweep

This branch now carries TWO changes (the rebase onto `origin/main` @ `adda597` merged them):

* **Part A** — the server-side settlement/expiry sweep (G1), already on `main` as PR #8.
* **Part B** — the durable order store (this PR, #7).

Both sections are kept as each change wrote them, plus a REBASE NOTE where the merge changes a claim.

## Part A — G1: the service settles its own orders (already on main as PR #8)

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

## 2026-10-12
- cvm-deploy-catalog.sh: one-command menu change (capture->catalog->tests->deploy->probe). Proven: 2x idempotent run, probe order priced 15120 sats.
- cvm-record-pay-video.py: deterministic pay-flow recorder + regression test. Proven: full flow green, invoice rendered.
REBASE NOTE: "Nothing here is durable" was true of PR #8 alone. On this branch the sweep runs against
Part B's SQLite store, so the sweep's compare-and-set is now durable too (one process per store file).

## Part B — durable settlement (worker-base/t_bd0f57a8)

Base: origin/main 1ebe0dc (PR #6, invoice endpoint). Branch: `pr/orders-durable-settlement`.

## What was already live before this branch
`POST /orders` (server-priced, born `awaiting_payment`), `GET /orders/:id/invoice` (real BOLT11 +
`data:` QR), `GET /orders/:id` (rail-verified settlement to `paid`), NIP-98 facilitator auth,
ADR-0013 hygiene. Verified live at https://cvm-pwa.orangesync.tech/api on 2026-10-11:
`POST /api/orders` -> 201 `{total: 9612}` (subtotal 8900 + fee 712 = floor(8%)),
`GET /api/orders/:id/invoice` -> 200 `lnbc96120n1p4vk9gj…` + `data:image/svg+xml;base64,…`.

## This branch: durable state (the gap the card names)
`src/store.ts` was an in-process `Map`; `deploy/cvm-orders-remote-setup.sh` even said "a restart
empties the queue by design". Now SQLite via `node:sqlite` (WAL, `busy_timeout`):

- [x] `claimSettlement()` — `awaiting_payment -> paid` exactly once, atomically, ACROSS PROCESSES and
      RESTARTS: one conditional UPDATE + a single-use `settlement_proofs` row in one
      `BEGIN IMMEDIATE` transaction. `lost` / `proof_spent` / `missing` write nothing.
- [x] one payment request settles at most ONE order (PRIMARY KEY on the quote; a second order gets
      409 `settlement_proof_reused` and stays `awaiting_payment`).
- [x] durable invoice: compare-and-set write, so a restart never re-quotes a second BOLT11 for the
      same order (that would strand sats already paid) and concurrent callers share one invoice.
- [x] durable `Idempotency-Key`: order + key claimed in ONE transaction; the replay still works
      after a restart, so a double-tap is one order.
- [x] terminal states (`expired`, `ready`, `refunded`) survive a restart and cannot be revived.
- [x] `#migrate()` with `PRAGMA user_version` + `PRAGMA table_info` backfill (a DDL-only change is a
      no-op on a deployed file — a real v1 file is migrated in the test suite).
- [x] `ORDER_DB_PATH` (production) with a durable `data/orders.sqlite` fallback for a bare
      `deno run main.ts`. FIXED on this rebase: the `import.meta.main === false => ":memory:"` arm is
      gone. It was unreachable from the deployed entrypoint, so it was invisible in production, and
      it silently handed an EPHEMERAL store to any future entrypoint that imported the wiring
      (`route`/`store`) instead of running the file — the exact bug class this PR exists to fix.
      The wiring is now built explicitly by `createService(env)` (durable path, no memory arm) and
      the suite injects its own store through `createRoute({ store })`.
- [x] `create()` refuses an order without an id (the `t_5198c7da` contract bug: `body.id` was
      `undefined`).

## The rebase's composition hole — fixed on this branch (review of worker-base/t_89dcb160)

Merging PR #8 (the sweep) onto PR #7 (durable settlement) produced two halves of ONE feature that did
not compose:

- the poll (`GET /orders/:id`) settles through `claimSettlement({quoteId})` — one conditional UPDATE
  plus a single-use `settlement_proofs` row;
- the SWEEP (PR #8) settled through a bare `store.transition(id, "paid")`.

So a sweep-settled order reached `paid` with `settlement_proofs` EMPTY: the payment request was never
marked spent, and the SAME quote could settle a second order through the poll. Measured, not
theorised — with only `src/sweeper.ts` reverted (everything else on this branch in place):
`report.paid === 1` for the second order and `proofSpentBy(quote) === undefined`. One payment, two
paid orders.

- [x] `SweeperStore` declares `claimSettlement`, not `transition`; every rail verdict the sweep
      applies goes through the durable claim. `won` is the only outcome that changes anything; `lost`
      is a concurrent poll (that IS the exactly-once mechanism) and counts as `unchanged`;
      `proof_spent` is NOT a race — the invoice already paid a DIFFERENT order — so it gets
      `SweepReport.reused` plus a warning line instead of being folded into "nothing to do".
- [x] expiry uses `claimSettlement(id, claim, "expired")`: the same compare-and-set, no proof row (an
      expired invoice was never paid, so there is nothing to spend).
- [x] `ensureStoreDir()` — now that the durable path is the ONLY path, a fresh checkout died on
      `unable to open database file` because `data/` does not exist. A durable-by-default service
      makes its own directory; a real error (permissions) still throws.
- [x] the sweep test counted *transitions*. After this change a losing racer never calls `transition`
      at all — it returns `lost` and writes nothing — so "exactly once" is measured on the claim,
      where the property lives. Two new tests pin the barrier from both sides.

## Evidence
- RED probe (`tests/helpers/durable_probe.ts`) against the pre-fix store:
  `PERSIST: LOST — a second store over the same path sees no order`.
  Same probe after: `PERSIST: OK … INVOICE: OK — the same bolt11  CLAIM: first=won second=lost`.
- Composition-hole RED/GREEN: `~/reports/t_bd0f57a8-p7fix/test-red-composition-hole.txt` (12 passed /
  2 failed with only `src/sweeper.ts` reverted) -> `test-green.txt` (139 passed / 0 failed).
- `deno check main.ts src/*.ts tests/*.ts` clean; `deno task test` -> **139 passed (2 steps) | 0 failed**
  (up from 113 before the rebase: PR #8's sweep suite plus the two new barrier tests), including the
  4-OS-process claim race (`4 spawns -> exactly one won`, none failed open).

## Not proven here (stated, not hidden)
- No live settlement was executed end to end: that needs a real payment to the mint behind the
  deployed `CASHU_MINT_URL`. The live probes cover order creation and real invoice issuance.
- The rail's mint is a single point of truth; a mint reporting `PAID` for an unpaid quote is out of
  scope (the rail trusts the mint — see `docs/mint-discovery.md` for why the mint is chosen
  carefully).
## 2026-10-12 — ADR-0014 venue order number, DEPLOYED
- `main.ts`: GET /orders/:id returns `venue_reference` + `venue_reference_url` (from durable receipt; null until recorded).
- `docs/adr/0014-verifiable-venue-order-number.md` — recon table proving the FoodAmigos tracker is account-scoped (list=401, single-order keyed by storefront UUID) => customer cannot type the number into the venue's public site. Stage-2 integration, not papered over.
- `tests/venue_reference_test.ts` — 3 tests (null / recorded / survives reopen). Suite 142/0.
- `scripts/cvm-deploy-service.sh` — NEW. The catalog script never shipped main.ts/src, so a committed fix could sit undeployed. Prints live response shape BEFORE/AFTER.
- Deploy gate bugs found by running it: pipe-into-grep hung on the coverage reporter; deno ANSI-wraps `ok` so `^ok` never matched. Both fixed in `795bd86`.
- DEPLOYED + verified live: BEFORE venue_reference_field=False, AFTER =True.
- cvm-registry `24048d2`: PWA status card + timeline honesty + console "→ customer" marker. Deployed; served bundle verified.
- VENUE_RECEIPT gate: `paid` is a rail claim (ADR-0008), so the settled path needs a real paid invoice — worker proving the signed lifecycle against the live service.
