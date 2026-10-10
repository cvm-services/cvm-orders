/**
 * Cashu mint discovery, validation and selection.
 *
 * Design: discovery is an OPERATIONAL step (a CLI runs it and writes config),
 * never a request-path dependency. Serving a customer order must not wait on
 * a relay round-trip or a mint probe.
 *
 * A mint is "reliable" when it can actually do the two things our order rail
 * needs, proves it with NUT-06 capabilities, and answers quickly:
 *   - NUT-04 mint quotes on method=bolt11 unit=sat  (customer pays us -> ecash)
 *   - NUT-05 melt (BOLT11)                           (we pay the venue's rail)
 *   - NUT-07 checkstate                              (prove a token is unspent)
 *
 * Measured 2026-10-10 against live mints: mint.minibits.cash/Bitcoin
 * (cdk-mintd/0.17.7), mint.coinos.io (Nutshell/0.21.0), mint.cashu.chat
 * (Nutshell/0.20.2), mint.gitvid.net (Nutshell/0.20.1) all satisfy the three.
 */

export interface MintInfo {
  name?: string;
  version?: string;
  pubkey?: string;
  contact?: unknown;
  nuts?: Record<string, unknown>;
  [k: string]: unknown;
}

export type MintSource = "seed" | "nip87";

export interface MintProbe {
  url: string;
  source: MintSource;
  reachable: boolean;
  latencyMs: number | null;
  name: string | null;
  version: string | null;
  nuts: string[];
  supportsMintBolt11: boolean;
  supportsMeltBolt11: boolean;
  supportsCheckstate: boolean;
  audited: boolean;
  score: number;
  reject?: string;
}

/** NUTs our rail cannot work without. */
export const REQUIRED_NUTS = { mint: "4", melt: "5", checkstate: "7" } as const;

/**
 * A mint URL we must never auto-select: test/regtest fixtures, loopback, or
 * anything non-TLS. Auto-selecting a test mint would accept worthless ecash.
 */
export function isRejectableHost(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "unparseable url";
  }
  if (u.protocol !== "https:") return `not https (${u.protocol})`;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return "loopback/local host";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return "bare ipv4 host";
  if (/^\[?::1\]?$/.test(host) || host.endsWith("::1")) return "loopback ipv6";
  // testnut / test / regtest / example fixtures
  const parts = host.split(/[.\-/]/);
  for (const bad of ["testnut", "test", "regtest", "example", "staging", "demo"]) {
    if (parts.includes(bad) || host.includes(bad)) return `test/fixture host (${bad})`;
  }
  return undefined;
}

function hasMethod(nut: unknown, method: string, unit: string): boolean {
  if (!nut || typeof nut !== "object") return false;
  const methods = (nut as { methods?: unknown }).methods;
  if (!Array.isArray(methods)) return false;
  return methods.some(
    (m) => m && typeof m === "object" &&
      (m as Record<string, unknown>).method === method &&
      (m as Record<string, unknown>).unit === unit,
  );
}

/** Derive the capability booleans from a NUT-06 info body. */
export function capabilities(info: MintInfo): {
  supportsMintBolt11: boolean;
  supportsMeltBolt11: boolean;
  supportsCheckstate: boolean;
  nuts: string[];
} {
  const nuts = info?.nuts && typeof info.nuts === "object" ? info.nuts : {};
  const has = (n: string) => Object.prototype.hasOwnProperty.call(nuts, n);
  return {
    supportsMintBolt11: has("4") && hasMethod((nuts as Record<string, unknown>)["4"], "bolt11", "sat"),
    supportsMeltBolt11: has("5") && hasMethod((nuts as Record<string, unknown>)["5"], "bolt11", "sat"),
    supportsCheckstate: has("7"),
    nuts: Object.keys(nuts).sort((a, b) => Number(a) - Number(b)),
  };
}

/**
 * Score a reachable mint 0-100. Unreachable or incapable mints score 0.
 * Weighting: capability is worth far more than speed. A fast mint that cannot
 * melt is useless to us; a slow one that can is merely annoying.
 */
export function scoreMint(p: Omit<MintProbe, "score">): number {
  if (!p.reachable) return 0;
  if (!p.supportsMintBolt11) return 0;
  if (!p.supportsMeltBolt11) return 0;
  let s = 0;
  s += 45; // mint bolt11 - the rail we cannot operate without
  s += 30; // melt bolt11  - paying out
  s += 15; // checkstate   - proof verification
  if (p.audited) s += 5;
  const l = p.latencyMs;
  if (l !== null) {
    if (l < 250) s += 5;
    else if (l < 600) s += 3;
    else if (l < 1500) s += 1;
  }
  return s;
}

export interface ProbeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  audited?: boolean;
  source?: MintSource;
}

/** Probe one mint: reachability, latency, NUT-06 capabilities, score. */
export async function probeMint(url: string, opts: ProbeOptions = {}): Promise<MintProbe> {
  const clean = url.trim().replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 5000;
  const f = opts.fetchImpl ?? fetch;
  const base: MintProbe = {
    url: clean,
    source: opts.source ?? "seed",
    reachable: false,
    latencyMs: null,
    name: null,
    version: null,
    nuts: [],
    supportsMintBolt11: false,
    supportsMeltBolt11: false,
    supportsCheckstate: false,
    audited: opts.audited ?? false,
    score: 0,
  };

  const reject = isRejectableHost(clean);
  if (reject) return { ...base, reject };

  const t0 = Date.now();
  let info: MintInfo;
  try {
    const res = await f(`${clean}/v1/info`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ...base, reject: `http ${res.status}` };
    info = await res.json() as MintInfo;
  } catch (e) {
    return { ...base, reject: `unreachable: ${String((e as Error)?.name ?? e)}` };
  }
  const latencyMs = Date.now() - t0;
  const caps = capabilities(info);

  // /v1/keys must actually answer - an info body alone does not prove the mint
  // can issue. A mint serving stale info with dead keys would pass /v1/info.
  try {
    const kr = await f(`${clean}/v1/keys`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!kr.ok) {
      return { ...base, reachable: true, latencyMs, reject: `keys http ${kr.status}` };
    }
    const kj = await kr.json() as { keysets?: unknown[] };
    if (!Array.isArray(kj?.keysets) || kj.keysets.length === 0) {
      return { ...base, reachable: true, latencyMs, reject: "no keysets" };
    }
  } catch (e) {
    return { ...base, reachable: true, latencyMs, reject: `keys: ${String((e as Error)?.name ?? e)}` };
  }

  const partial = {
    ...base,
    reachable: true,
    latencyMs,
    name: typeof info.name === "string" ? info.name : null,
    version: typeof info.version === "string" ? info.version : null,
    ...caps,
  };
  const score = scoreMint(partial);
  const out: MintProbe = { ...partial, score };
  if (!out.supportsMintBolt11) out.reject = "no NUT-04 bolt11/sat";
  else if (!out.supportsMeltBolt11) out.reject = "no NUT-05 bolt11/sat";
  return out;
}

/** Probe many mints concurrently, best first. Accepts bare urls or {url,source}. */
export async function probeAll(
  items: (string | { url: string; source?: MintSource })[],
  opts: ProbeOptions = {},
): Promise<MintProbe[]> {
  const out = await Promise.all(items.map((it) => {
    const url = typeof it === "string" ? it : it.url;
    const source = typeof it === "string" ? undefined : it.source;
    return probeMint(url, source ? { ...opts, source } : opts);
  }));
  return out.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
}

export interface Selection {
  chosen: MintProbe | null;
  ranked: MintProbe[];
  rejected: MintProbe[];
}

/** Pick the best mint, refusing anything below `minScore` (default 60). */
export function selectMint(probes: MintProbe[], minScore = 60): Selection {
  const ranked = [...probes].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  const eligible = ranked.filter((p) => p.reachable && !p.reject && p.score >= minScore);
  return {
    chosen: eligible[0] ?? null,
    ranked: eligible,
    rejected: ranked.filter((p) => !eligible.includes(p)),
  };
}

/**
 * Collect candidate mint URLs announced over Nostr NIP-87 (kind 38172).
 * Best-effort: a dead relay must never fail discovery, so errors are swallowed
 * and the seed list still applies.
 */
export async function discoverFromNip87(
  relays: string[],
  opts: { timeoutMs?: number; WebSocketImpl?: typeof WebSocket } = {},
): Promise<string[]> {
  const WS = opts.WebSocketImpl ?? WebSocket;
  const timeoutMs = opts.timeoutMs ?? 6000;
  const found = new Set<string>();
  await Promise.all(relays.map((relay) =>
    new Promise<void>((resolve) => {
      let ws: WebSocket | null = null;
      const done = () => {
        try { ws?.close(); } catch { /* ignore */ }
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      try {
        ws = new WS(relay);
      } catch {
        clearTimeout(timer);
        resolve();
        return;
      }
      ws.onopen = () => {
        try {
          ws!.send(JSON.stringify(["REQ", "mints", { kinds: [38172], limit: 100 }]));
        } catch { /* ignore */ }
      };
      ws.onmessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (!Array.isArray(msg)) return;
          if (msg[0] === "EVENT" && msg[2]?.tags) {
            for (const t of msg[2].tags as string[][]) {
              if (t[0] === "u" && typeof t[1] === "string" && /^https:\/\//.test(t[1])) {
                found.add(t[1].trim().replace(/\/+$/, ""));
              }
              if (t[0] === "d" && typeof t[1] === "string" && /^https:\/\//.test(t[1])) {
                found.add(t[1].trim().replace(/\/+$/, ""));
              }
            }
          }
          if (msg[0] === "EOSE") done();
        } catch { /* ignore malformed */ }
      };
      ws.onerror = done;
      ws.onclose = () => { clearTimeout(timer); resolve(); };
    })
  ));
  return [...found];
}


/**
 * Resolve the mint URL the service should serve orders with.
 *
 * Precedence: CASHU_MINT_URL (deploy-time override / per-environment) then the
 * committed config/mint.json (the reviewed, probed selection). Returns null if
 * neither yields a usable URL, so the caller can fail closed with a 503 rather
 * than silently minting against a wrong or dead mint.
 */
export async function resolveMintUrl(
  opts: {
    env?: Record<string, string | undefined>;
    configPath?: string;
    readFile?: (p: string) => Promise<string>;
  } = {},
): Promise<string | null> {
  const getEnv = opts.env
    ? (k: string) => opts.env![k]
    : (k: string) => Deno.env.get(k);
  const fromEnv = getEnv("CASHU_MINT_URL");
  if (fromEnv && fromEnv.trim()) return fromEnv.trim().replace(/\/+$/, "");

  const configPath = opts.configPath ??
    new URL("../config/mint.json", import.meta.url).pathname;
  const read = opts.readFile ?? (async (f: string) => await Deno.readTextFile(f));
  try {
    const cfg = JSON.parse(await read(configPath)) as { selected?: string | null };
    if (cfg?.selected && cfg.selected.trim()) return cfg.selected.trim().replace(/\/+$/, "");
  } catch {
    // missing/corrupt config is not fatal - caller decides (fail closed)
  }
  return null;
}
