# Mint discovery and selection

Our order rail needs a Cashu mint that can do three things; anything else is a
liability. `scripts/discover-mints.ts` probes candidates and selects one.

## Required capabilities

| Need | NUT | Requirement |
|---|---|---|
| Customer pays us -> ecash | NUT-04 | mint quote, `method=bolt11`, `unit=sat` |
| We pay out (venue / card rail) | NUT-05 | melt, `method=bolt11`, `unit=sat` |
| Prove a token is unspent | NUT-07 | checkstate |

A mint missing any of these scores 0 and is never selected, however fast it is.

## Usage

```bash
# report only (read-only, safe in CI)
deno run --allow-net --allow-read scripts/discover-mints.ts

# probe, select, and persist the choice
deno run --allow-net --allow-read --allow-write scripts/discover-mints.ts --write
```

`--write` updates `config/mint.json` and prints the value to set:

```
export CASHU_MINT_URL=https://mint.minibits.cash/Bitcoin
```

Exit codes: `0` selected, `2` **no mint met the bar** (it refuses to set one).

## Sources of candidates

1. **Seed list** — `config/mints.seed.json`, versioned and reviewed.
2. **NIP-87 announcements** — kind `38172` events fetched from the relays in the
   seed file. Best-effort: a dead relay never fails discovery. Announcements are
   self-published, so they are *candidates only* — they must pass the same
   probing bar as a seed before selection.

## How the selection is made

Each candidate is probed live: `GET /v1/info` for NUT-06 capabilities, then
`GET /v1/keys` — because an `/v1/info` that answers proves nothing if the mint
cannot actually issue. Score is capability-weighted, not speed-weighted:

- +45 mint bolt11 · +30 melt bolt11 · +15 checkstate · +5 audited · up to +5 latency

Rejected outright: non-HTTPS, loopback/`.local`, bare IPv4, and any host matching
`test|testnut|regtest|example|staging|demo` — auto-selecting a test mint would
mean accepting worthless ecash for a real order.

## How the service consumes it

`resolveMintUrl()` (in `src/mints.ts`) resolves in this order:

1. `CASHU_MINT_URL` — deploy-time override, per environment
2. `config/mint.json` -> `selected` — the probed, reviewed choice

It returns `null` when neither yields a URL, so the caller **fails closed**
(503) instead of minting against a wrong or dead mint.

## Verified live 2026-10-10

Probed over the real network; all four passed every capability check:

| Mint | Version | Latency | Score | Source |
|---|---|---|---|---|
| `mint.minibits.cash/Bitcoin` | cdk-mintd/0.17.7 | 289 ms | 93 | seed |
| `mint.cashu.chat` | Nutshell/0.20.2 | 1347 ms | 91 | seed |
| `mint.coinos.io` | Nutshell/0.21.0 | 716 ms | 91 | seed |
| `mint.gitvid.net` | Nutshell/0.20.1 | 935 ms | 91 | **NIP-87** |

Selected: `https://mint.minibits.cash/Bitcoin`.

Two operational notes learned by probing rather than assuming:

- **`coinos.io` is not a mint.** It is the wallet; the mint is
  **`mint.coinos.io`**. `https://coinos.io/v1/info` 404s.
- **`bitcoinmints.com` is dead** (Vercel `DEPLOYMENT_NOT_FOUND`), so third-party
  directory sites are not a dependable input. Seeds + NIP-87 are.

## Tests

```bash
deno test --allow-read tests/mints_test.ts
```

21 tests, no network: a fake `fetch` covers capability parsing, scoring,
rejection rules, the fail-closed resolver, and a fake WebSocket for NIP-87.
