# Order invoice API — task report

Goal: make the shipped customer PWA's **Pay** button work end to end, and make `paid` reachable
**only** through verified sats settlement (ADR-0008).

Branch: `feat/invoice-endpoint` (based on `origin/main` 3e92e97).

## What changed

| Area | Change |
|------|--------|
| `src/store.ts` | `OrderState` gains `awaiting_payment` + `expired`; `create()` is born `awaiting_payment`; edges `awaiting_payment -> paid|expired`; `queue()` still returns only `paid`. Money fields on `Order`; `ensureInvoice()` creates one invoice per order and shares it with concurrent callers. |
| `src/catalog.ts` (new) | Server-side pricing from `config/venues.json`; fee `floor(8% of subtotal)`; identity by `sku` OR exact name (the shipped client sends no sku); option surcharges server-side. |
| `config/venues.json` (new) | Pinned copy of the PWA's own `/menu.json` (sha256 pinned), so price identity is reviewable. |
| `main.ts` | `POST /orders` validates + recomputes + `Idempotency-Key`; `GET /orders/:id/invoice`; `GET /orders/:id` with exactly-one CAS to `paid`; transition refuses unverified `awaiting_payment -> paid`. |
| `tests/*` | RED-first suites: `lifecycle_test.ts`, `catalog_test.ts`, `invoice_test.ts`, plus `route_test.ts`/`store_test.ts` updated for the new born-state. |
| `README.md` | Lifecycle, endpoints, a "Pricing and the sats gate" section, and the `CASHU_MINT_URL` deploy note. |

## Exact commands and real output

RED first (`tests/lifecycle_test.ts`, before the fix) — the born-`paid` bug:

```
create() never yields a paid order ... FAILED
    assertEquals(store.get("o-1")?.state, "awaiting_payment")
    actual: "paid", expected: "awaiting_payment"
ok | 6 passed | 6 failed
```

GREEN, full suite:

```
$ deno task test
ok | 98 passed | 0 failed (13s)
```

Type check:

```
$ deno check main.ts src/*.ts
Check main.ts
Check src/catalog.ts ... Check src/store.ts
(no errors)
```

The A–F behaviours each have a named passing test, e.g.:

```
the invoice endpoint returns bolt11 + a self-contained qr, and creates the invoice once ... ok
no rail configured is a 503 with a machine-readable body, never a bogus invoice ... ok
a settled invoice moves the order to paid exactly once ... ok
an expired quote expires the order and can never pay it ... ok
no caller can post their way into paid ... ok
the facilitator's rail-verified transition to paid is allowed, and only then ... ok
a client-supplied amount is ignored: the catalog price is the price ... ok
fee is floor(8% of subtotal) in integer sats — boundary pinned ... ok
```

## What this does NOT prove

* **No live settlement was executed.** The rail is exercised against `FakeRail`; `CashuRail`'s HTTP
  shape is unit-tested against a stubbed `fetch`, but **no real mint was contacted** in these tests.
  Live settlement against a real mint is unverified here.
* **No real BOLT11 was paid.** The invoice is created and polling transitions on a rail verdict;
  nobody actually paid a lightning invoice in this run.
* **The store is in-memory.** A restart empties orders *and* invoices; nothing here is durable.
* The PWA end-to-end path (browser -> Caddy -> service -> mint) was **not** run in this task.
