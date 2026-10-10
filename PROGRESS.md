finding -> status -> files touched
workspace scratch was empty; created public cvm-services/cvm-orders repository -> published branch -> repository files
TDD lifecycle tests red then green -> 3 passing -> tests/store_test.ts, src/store.ts
poll and auth endpoints added -> implemented -> main.ts, README.md
t_d790103d: run 257 died leaving uncommitted work and 1 failing test (proxied `u` path) -> verified, repaired, extended -> src/nip98.ts, src/store.ts, src/hygiene.ts, main.ts, deno.json, tests/nip98_test.ts, tests/route_test.ts
t_d790103d: /api mount prefix strips before the service, so the console's u tag never matched -> equal-or-suffix path match (+ host still checked) -> src/nip98.ts:342-410
t_d790103d: captured_at (ISO-8601) strips to a 17-digit run that is Luhn-valid ~1 in 10 seconds -> intermittent 422 on placed -> ISO-8601 exempted in src/hygiene.ts + measured regression test -> tests/hygiene_test.ts
t_d790103d: verified -> 35 tests pass (`deno task test`), coverage 88.8% line / 98.2% function -> tests/*, push 54c652c + 20e3acc -> origin/pr/orders-nip98-auth-receipt
t_d790103d: live probe of the deployed origin BEFORE the patch -> unauthenticated GET /api/orders/queue = 200, unauthenticated POST transition on an unknown order = 409 "order not found" (not 401) -> the running service still needs this patch deployed
