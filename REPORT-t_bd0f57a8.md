# REPORT — cvm-orders PR #7: the import seam, and the composition hole the rebase exposed

Task: **t_89dcb160** (worker-base, board `contextvm-services`). The cold-review verdict routed through
t_89dcb160 names `cvm-orders` PR #7 / `main.ts` import-time wiring, which is **t_bd0f57a8**'s
deliverable. Both cards are worker-base's, so this is the same actor: the work is done once and
recorded on both cards.

Worktree: `/home/c03rad0r/worktrees/t_89dcb160/cvm-orders`
Branch: `fix/p7-orderdb-import-seam` — **also pushed as `pr/orders-durable-settlement`** (PR #7's head)
Commit: `64dcb17` (rebased onto `origin/main` `adda597`, i.e. after PR #8 merged)
Evidence: `/home/c03rad0r/reports/t_bd0f57a8-p7fix/{check-baseline,test-baseline,test-red-composition-hole,test-green}.txt`

## 1. The verdict's defect, and the state I found it in

PR #7 (`durable order state`) and PR #8 (`server-side sweep`) each merged a half of one feature. After
#8 landed on `main`, PR #7 was **unmergeable** (conflicts in `main.ts`, `README.md`, `PROGRESS.md`),
and rebasing it surfaced two things the verdict had pointed at:

* `main.ts` resolved its store path from `import.meta.main` — so any entrypoint that **imported** the
  wiring got `:memory:`. Invisible in production, and the failure mode is money: an import loses the
  persisted invoice, and a restart re-quotes a **second** bolt11 for an order whose first invoice the
  customer already paid.
* PR #8 exported a module-level `store` for its sweep, which is the same defect wearing a different
  hat: importing `main.ts` wired a live store at import time.

Both are gone: `main.ts` no longer wires anything at import. `createService(env)` builds ONE store,
explicitly, and `import.meta.main` calls it — the routes and the sweep share it.

## 2. What the rebase exposed that neither PR knew about (the important part)

Rebasing was not a mechanical merge. `deno task test` on the rebased tree failed, and the failure was
not a stale test:

```
the sweep's race test commits 0 transitions where it expects 1
```

Cause: the two halves settle **differently**.

| path | how it settles |
| --- | --- |
| poll `GET /orders/:id` | `claimSettlement({quoteId})` — conditional UPDATE **plus** a single-use `settlement_proofs` row |
| sweep (PR #8) | bare `store.transition(id, "paid")` |

A sweep-settled order therefore reached `paid` with `settlement_proofs` **empty**. The payment request
was never spent, so the **same sats could settle a second order** through the poll. PR #7's whole
durable claim (one quote settles at most one order, forever) was bypassed by the very sweep that
existed to make settlement independent of the customer's browser.

Measured, not theorised — with **only `src/sweeper.ts` reverted** to its pre-fix text and everything
else in place:

```
a sweep-settled quote is spent everywhere: the same payment cannot settle a second order ... FAILED
  the sweep must spend the payment request, exactly like the poll
  [Diff] Actual / Expected     - undefined    + "o-first"

the sweep leaves an order alone — and says so — when its payment already settled another ... FAILED
  the rail says settled, but this payment has already been spent
  [Diff] Actual / Expected     - 1    + 0        <-- the SECOND order was paid with the same quote

FAILED | 12 passed | 2 failed
```

That second failure is the bug: `report.paid === 1` for an order whose payment had already purchased a
different order. One payment, two paid orders.

## 3. The fix

* `src/sweeper.ts` — `SweeperStore` declares `claimSettlement(id, claim, to?)` instead of `transition`;
  every rail verdict goes through it.
  * `won` — the only outcome that moves anything.
  * `lost` — a concurrent poll got there first. That **is** the exactly-once mechanism, so it counts as
    `unchanged`.
  * `proof_spent` — NOT a race: this invoice already paid a DIFFERENT order. It gets its own
    `SweepReport.reused` counter and a warning log line, instead of being folded into "nothing to do".
  * expiry uses `claimSettlement(id, claim, "expired")`: the same compare-and-set, and no proof row —
    an expired invoice was never paid, so there is nothing to spend (unchanged in `src/store.ts`).
* `main.ts` — explicit `createService(env)`; no module-level `store`/`route`; `orderDbPath(env)` has no
  `isMain` arm.
* `main.ts` — `ensureStoreDir()`: with the durable path now the *only* path, a fresh checkout died on
  `unable to open database file` because `data/` does not exist. A durable-by-default service creates
  its own directory. Failures that are not `AlreadyExists` still throw. This is the one change beyond
  the literal verdict; it is required for the verdict's own guarantee to hold on a cold start, and it
  is covered by `a cold start creates the store's directory instead of dying on it`.
* Tests: the sweep test counted *transitions*, and after this change a losing racer never calls
  `transition` at all — so "exactly once" is measured on the **claim**, where the property lives. Two
  new tests pin the barrier from both sides (sweep-then-poll, and the sweep's own `reused` report).

## 4. Verification (real output)

```
deno check main.ts src/*.ts tests/*.ts                      -> clean (no errors)
deno task test                                              -> ok | 139 passed (2 steps) | 0 failed (22s)
                                                     before -> 1 failed (the composition hole)
reverted-sweeper run (RED, --no-check)                       -> 12 passed | 2 failed
```

Coverage (from the same run): all files 86.0% line / 95.5% branch; `src/sweeper.ts` 83.3%,
`main.ts` 84.4% — above the repo's 80% floor.

Remote state, verified with `git ls-remote` (not asserted from memory):

```
64dcb17  refs/heads/fix/p7-orderdb-import-seam
64dcb17  refs/heads/pr/orders-durable-settlement      <- PR #7 head, force-with-lease from b61d939
```

`b61d939` (the previous PR #7 head) is recoverable from this repo's object database: it is the parent
history of the rebase, and the pre-force ref is named in the card record.

## 5. Not proven here (stated, not hidden)

* **No real mint was paid.** Every settlement path here is exercised against injected rails and a fake
  mint over HTTP (`tests/sweeper_service_test.ts`). A live end-to-end settlement needs a real payment.
* **Multi-process sweeps are not coordinated.** The claim is atomic across processes (proven with real
  OS processes in `tests/settlement_claim_test.ts`), but nothing prevents two replicas from each
  running a sweep; they will contend, and exactly one will win each claim.
* **`coverage/` is tracked in this repo** (no `.gitignore`), so a test run dirties the tree with ~300
  JSON files. Pre-existing, unrelated to this fix, and deliberately not touched here — it deserves its
  own change (`.gitignore` + `git rm -r --cached coverage`).
* **The PR #7 body was not rewritten.** The description's "before" text still describes the branch as
  it was before the rebase; the corrected story is in `PROGRESS.md` and here. `REPORT.md` (PR #8's own
  report) is likewise left as the historical artifact of that merged PR — it says the wiring "exported
  `store`", which this fix deliberately undoes, so read `REPORT-t_bd0f57a8.md` for the current state.
