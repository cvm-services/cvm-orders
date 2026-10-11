# Server-side settlement sweep (G1) — task report

Goal: the order service must settle its **own** orders.

Measured live 2026-10-11: the only thing that ever asked the mint "was this invoice paid?" was the
**customer's browser** (`GET /orders/:id`, polled from the tab). Close the tab, lose the connection,
or hand the order to a different device, and a paid invoice sat in `awaiting_payment` forever — the
service never reconciled anything itself. `paid` (and therefore the kitchen queue) depended on a
client staying open.

Branch: `pr/orders-server-sweep` (based on `origin/main`; worktree `/home/c03rad0r/worktrees/t_cc2809fb`).

| Commit | Subject |
|--------|---------|
| `6592d34` | test(orders): RED-first suite for the server-side settlement sweep (G1) |
| `8b1e421` | feat(orders): server-side settlement + expiry sweep |
| `08a71e1` | feat(orders): start the sweep with the service, sharing one rail resolver |
| `c09d55a` | test(orders): cover the route corners and the wiring's defensive branches |

## What changed

| Area | Change |
|------|--------|
| `src/sweeper.ts` (new, 243 lines) | `createSweeper({ store, rail, now, onEvent })` + `startSweeper(intervalMs)` / `startOrderSweeper(options)`. One tick asks the rail about every order that is `awaiting_payment` **and** has an invoice; `settled` → CAS to `paid`, `expired` → CAS to `expired` (terminal), `unpaid`/unreachable → leave alone. A rail that throws changes nothing and is logged once per tick, never once per order. `ORDER_SWEEP_INTERVAL_MS` (default 30 000; `0` disables loudly; garbage falls back to the default and never disables). |
| `main.ts` | `createRailResolver()` — one lazy, per-process rail, so the HTTP route and the sweep see the **same** rail instead of resolving the environment twice. Exported `store` and `startOrderSweeper()`. At boot the service now starts the sweep on the configured interval (`import.meta.main` path only — importing `main.ts` in tests does not start a timer). |
| `tests/sweeper_test.ts` (new, 12 tests) | The reconciler's behaviour with an injected clock and rail: settle, never pay an unsettled quote, expire, expiry beats a stale local timer, money beats a stale local expiry, rail-dead tolerance, the customer-poll/sweep race (exactly one transition), tick scoping, interval parsing, `stop()`, and a throwing rail not killing the timer. |
| `tests/sweeper_service_test.ts` (new, 2 tests) | End-to-end through the real wiring: `main.ts` is imported, `startOrderSweeper` started on a 25 ms interval, and a request-scoped fetch spy proves the order actually reaches `paid` (and `expired`) with **zero** reads of any order endpoint — the only outbound traffic is to the mint. Also pins that `createRailResolver` resolves once and caches, including an explicit `null`. |
| `tests/route_surface_test.ts` (new, 9 tests) | The surface no other suite touched: CORS preflight, `/health`, a malformed body, a bogus credential on the invoice endpoint, an unpriced order, both rail failure modes (502/503), a poll whose CAS is lost to the sweep mid-flight, and the `0`-disables branch of the wiring. |
| `README.md` | The boot-time sweep, the `ORDER_SWEEP_INTERVAL_MS` knob, why the client's poll used to be the only actor, and the one-rail-per-process rule — added to "Pricing and the sats gate". |

## Exact commands and real output

RED #1 — the suite exists before the module does, and says so:

```
$ deno test --allow-env --allow-net --allow-read tests/sweeper_test.ts
TS2307 [ERROR]: Cannot find module 'file:///home/c03rad0r/worktrees/t_cc2809fb/src/sweeper.ts'.
    at file:///home/c03rad0r/worktrees/t_cc2809fb/tests/sweeper_test.ts:25:8
error: Type checking failed.
```

A signatures-only stub (no logic) was then committed so the tests fail on **behaviour**, not on an
import error:

```
$ deno test --allow-env --allow-net --allow-read tests/sweeper_test.ts
 FAILURES
a settled quote reaches paid on the sweep alone — zero HTTP requests => ./tests/sweeper_test.ts:153:6
the sweep never pays what the rail has not settled => ./tests/sweeper_test.ts:180:6
an expired quote expires the order, and expiry is terminal => ./tests/sweeper_test.ts:192:6
a pending quote past its own expires_at expires without the client's timer => ./tests/sweeper_test.ts:208:6
a settled quote beats a stale local expiry: money first, then the clock => ./tests/sweeper_test.ts:216:6
an unreachable rail changes nothing, logs once per tick, and never throws => ./tests/sweeper_test.ts:227:6
a customer poll and the sweep racing produce exactly one transition => ./tests/sweeper_test.ts:256:6
the sweep touches only awaiting_payment orders that have an invoice => ./tests/sweeper_test.ts:286:6
ORDER_SWEEP_INTERVAL_MS: 30s by default, 0 disables, garbage never disables => ./tests/sweeper_test.ts:323:6
startSweeper converges on its own interval, and stop() halts it => ./tests/sweeper_test.ts:347:6
a throwing rail cannot crash the sweep timer => ./tests/sweeper_test.ts:368:6
FAILED | 1 passed | 11 failed (5s)
```

GREEN — the unit suite, then the whole suite:

```
$ deno test --allow-env --allow-net --allow-read tests/sweeper_test.ts
ok | 12 passed | 0 failed

$ deno task test
ok | 121 passed (2 steps) | 0 failed (18s)
```

(The suite was 98 tests on `origin/main`; 23 were added here.)

Type check (no errors):

```
$ deno check main.ts src/sweeper.ts tests/sweeper_test.ts tests/sweeper_service_test.ts tests/route_surface_test.ts
Check main.ts
Check src/sweeper.ts
Check tests/route_surface_test.ts
Check tests/sweeper_service_test.ts
Check tests/sweeper_test.ts
```

Coverage (`deno task test` collects `coverage/`; these are the reported **line** numbers):

| File | Before | After |
|------|-------:|------:|
| `main.ts` | 73.7 (per the card) | **86.4** |
| `src/sweeper.ts` | — (new) | 80.4 |
| all files | — | 87.0 (1334/1534 lines) |

`main.ts` is the file that matters for this card (it is where the wiring lives); its floor of 80 %
is met. No file's line coverage went down. The stubs/route surface tests are what closed the gap
after the sweep itself left `main.ts` at 77.2 %.

The behaviours, each a named passing test:

```
a settled quote reaches paid on the sweep alone — zero HTTP requests ... ok
the sweep never pays what the rail has not settled ... ok
an expired quote expires the order, and expiry is terminal ... ok
a pending quote past its own expires_at expires without the client's timer ... ok
a settled quote beats a stale local expiry: money first, then the clock ... ok
an unreachable rail changes nothing, logs once per tick, and never throws ... ok
a customer poll and the sweep racing produce exactly one transition ... ok
the sweep touches only awaiting_payment orders that have an invoice ... ok
ORDER_SWEEP_INTERVAL_MS: 30s by default, 0 disables, garbage never disables ... ok
startSweeper converges on its own interval, and stop() halts it ... ok
a throwing rail cannot crash the sweep timer ... ok
interval 0 disables the sweep: no rail calls, no state change ... ok
the service's own wiring pays an order after the customer's tab is gone ... ok
the wiring expires an invoice the mint reports dead ... ok
one resolver per process: the routes and the sweep share the same rail ... ok
```

## What this does NOT prove

* **No real mint was contacted and no real invoice was paid.** The service-level test runs a fake
  mint (`Deno.serve` + a stubbed `fetch`) over real HTTP on localhost; `CashuRail` itself is only
  exercised against stubbed HTTP. Live settlement against `CASHU_MINT_URL` remains unverified here.
* **The store is in-memory.** A restart still empties orders and invoices, so the sweep's world is
  also lost on restart. Nothing about durability changed.
* **One process is assumed.** The sweep runs in-process, so N replicas would run N sweepers over
  whatever each one's store holds. There is no leader election and no distributed lock; the CAS in
  `store.transition` is only atomic *within* a process.
* **Settlement latency is bounded by the interval**, not by anything the mint pushes. There is no
  webhook/SSE/WS from the mint; worst case an order sits `awaiting_payment` for ~`ORDER_SWEEP_INTERVAL_MS`
  after being paid (default 30 s), and the customer's own poll is what usually wins the race.
* **The sweep is not attested to have ever run in a deployed process.** `startOrderSweeper()` is
  called on the `import.meta.main` path, which the test suite deliberately does not execute (no test
  can observe a real boot). The wiring is proven by calling the exported function, not by restarting
  the deployed service.
* Ordering between the sweep and the customer's poll is tested with an injected rail and an injected
  clock; real timing on a loaded box is not measured.
