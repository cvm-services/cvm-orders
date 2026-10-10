finding -> status -> files touched
workspace scratch was empty; created public cvm-services/cvm-orders repository -> published branch -> repository files
TDD lifecycle tests red then green -> 3 passing -> tests/store_test.ts, src/store.ts
poll and auth endpoints added -> implemented -> main.ts, README.md
t_d790103d: run 257 died leaving uncommitted work and 1 failing test (proxied `u` path) -> verified, repaired, extended -> src/nip98.ts, src/store.ts, src/hygiene.ts, main.ts, deno.json, tests/nip98_test.ts, tests/route_test.ts
t_d790103d: /api mount prefix strips before the service, so the console's u tag never matched -> equal-or-suffix path match (+ host still checked) -> src/nip98.ts:342-410
t_d790103d: captured_at (ISO-8601) strips to a 17-digit run that is Luhn-valid ~1 in 10 seconds -> intermittent 422 on placed -> ISO-8601 exempted in src/hygiene.ts + measured regression test -> tests/hygiene_test.ts
t_d790103d: verified -> 35 tests pass (`deno task test`), coverage 88.8% line / 98.2% function -> tests/*, push 54c652c + 20e3acc -> origin/pr/orders-nip98-auth-receipt
t_d790103d: live probe of the deployed origin BEFORE the patch -> unauthenticated GET /api/orders/queue = 200, unauthenticated POST transition on an unknown order = 409 "order not found" (not 401) -> the running service still needs this patch deployed
t_d790103d: docs+route test -> README rewritten (the delegated-verification claim was the bug), real-socket Deno.serve test, handoff report -> push 6a95efb, PR #3 opened (https://github.com/cvm-services/cvm-orders/pull/3)
t_d790103d: guard had the containment gap the sibling card t_d38f4d20 measured on the console -> first draft (run scan alone) silently regressed SPACED PANs, caught by the existing tests -> both shapes refused now (strip-once OR 13..19 run) + residual pinned -> src/hygiene.ts, tests/hygiene_test.ts
t_d790103d: tests/nip98_test.ts flake (fixed char appended to a per-run random npub = no-op 1 run in 32) -> deterministic corruption -> tests/nip98_test.ts
t_d790103d: verified again -> 37 tests pass over 3 consecutive runs, coverage 89.0% line / 98.3% function -> push 399bf3b
