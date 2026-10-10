#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write
/**
 * discover-mints.ts - probe candidate Cashu mints and SELECT a reliable one.
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-write scripts/discover-mints.ts [--write] [--json] [--min-score N]
 *
 * Without --write this is a read-only REPORT (safe to run anywhere, incl. CI).
 * With --write it persists the selection to config/mint.json.
 *
 * The service does NOT call this at request time: it reads CASHU_MINT_URL (or
 * config/mint.json). Discovery is an ops step, so a slow relay can never delay
 * a customer's payment.
 */
import {
  discoverFromNip87,
  probeAll,
  selectMint,
  type MintProbe,
} from "../src/mints.ts";

const args = Deno.args;
const flag = (n: string) => args.includes(`--${n}`);
const val = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const MIN_SCORE = Number(val("min-score", "60"));
const TIMEOUT = Number(val("timeout", "6000"));
const PERSIST = flag("write");
const AS_JSON = flag("json");

const here = new URL(".", import.meta.url).pathname;
const seedPath = here + "../config/mints.seed.json";

const seed = JSON.parse(await Deno.readTextFile(seedPath)) as {
  relays?: string[];
  mints: { url: string; note?: string }[];
};

// 1. collect candidates: curated seeds + best-effort NIP-87 announcements
const candidates = new Map<string, { url: string; source: "seed" | "nip87" }>();
for (const m of seed.mints) {
  candidates.set(m.url.replace(/\/+$/, ""), { url: m.url.replace(/\/+$/, ""), source: "seed" });
}

const relays = seed.relays ?? [];
let announced: string[] = [];
if (relays.length) {
  announced = await discoverFromNip87(relays, { timeoutMs: TIMEOUT });
  for (const u of announced) {
    if (!candidates.has(u)) candidates.set(u, { url: u, source: "nip87" });
  }
}
// NIP-87 announcements are self-published: treat them as candidates only.
// We probe them, but only ever AUTO-SELECT if they pass the same bar as a seed.
const urls = [...candidates.values()];

if (!AS_JSON) {
  console.error(`discover-mints: ${urls.length} candidates ` +
    `(${seed.mints.length} seed, ${Math.max(0, urls.length - seed.mints.length)} from NIP-87), ` +
    `min-score=${MIN_SCORE}`);
}

// 2. probe them all, best first
const probes: MintProbe[] = await probeAll(urls, { timeoutMs: TIMEOUT });

// 3. select
const { chosen, ranked, rejected } = selectMint(probes, MIN_SCORE);

type Selection = {
  selected: string | null;
  score: number | null;
  version: string | null;
  probed_at: string;
  min_score: number;
  ranked: { url: string; score: number; latencyMs: number | null; version: string | null; source: string }[];
  rejected: { url: string; reason: string }[];
};

const result: Selection = {
  selected: chosen?.url ?? null,
  score: chosen?.score ?? null,
  version: chosen?.version ?? null,
  probed_at: new Date().toISOString(),
  min_score: MIN_SCORE,
  ranked: ranked.map((p) => ({
    url: p.url, score: p.score, latencyMs: p.latencyMs, version: p.version, source: p.source,
  })),
  rejected: rejected.map((p) => ({ url: p.url, reason: p.reject ?? "insufficient score" })),
};

if (AS_JSON) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.error("");
  for (const p of probes) {
    const mark = p.reject ? "x" : (p.score >= MIN_SCORE ? "+" : "~");
    console.error(` ${mark} ${String(p.score).padStart(3)}  ${p.url}  ` +
      `${p.latencyMs ?? "-"}ms ${p.version ?? ""} ${p.source}${p.reject ? "  <- " + p.reject : ""}`);
  }
  console.error("");
}

if (!chosen) {
  if (!AS_JSON) console.error(`NO reliable mint found (all candidates scored < ${MIN_SCORE}). Refusing to set one.`);
  Deno.exit(2);
}

if (PERSIST) {
  const outPath = here + "../config/mint.json";
  await Deno.writeTextFile(outPath, JSON.stringify(result, null, 2) + "\n");
  if (!AS_JSON) {
    console.error(`SELECTED ${chosen.url} (score ${chosen.score}) -> wrote config/mint.json`);
    console.error(`To use it:  export CASHU_MINT_URL=${chosen.url}`);
  }
} else if (!AS_JSON) {
  console.error(`SELECTED ${chosen.url} (score ${chosen.score}); not persisted (pass --write).`);
  console.error(`To use it:  export CASHU_MINT_URL=${chosen.url}`);
}

if (AS_JSON) {
  console.log(`CASHU_MINT_URL=${chosen.url}`);
}
