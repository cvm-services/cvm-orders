import { assertEquals, assert } from "jsr:@std/assert@1";
import {
  capabilities,
  discoverFromNip87,
  isRejectableHost,
  probeAll,
  probeMint,
  scoreMint,
  selectMint,
  resolveMintUrl,
  type MintProbe,
} from "../src/mints.ts";

/** Build a fake fetch that answers /v1/info and /v1/keys. */
function fakeFetch(opts: {
  info?: Record<string, unknown> | null;
  infoStatus?: number;
  keys?: unknown;
  keysStatus?: number;
  throwOn?: "info" | "keys";
} = {}) {
  return ((input: string | URL | Request) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (url.endsWith("/v1/info")) {
      if (opts.throwOn === "info") return Promise.reject(new TypeError("fetch failed"));
      if (opts.infoStatus && opts.infoStatus !== 200) return json({}, opts.infoStatus);
      return json(opts.info ?? {});
    }
    if (url.endsWith("/v1/keys")) {
      if (opts.throwOn === "keys") return Promise.reject(new TypeError("fetch failed"));
      if (opts.keysStatus && opts.keysStatus !== 200) return json({}, opts.keysStatus);
      return json(opts.keys ?? { keysets: [{ id: "00ad", unit: "sat" }] });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
}

const GOOD_INFO = {
  name: "Minibits mint",
  version: "cdk-mintd/0.17.7",
  nuts: {
    "4": { methods: [{ method: "bolt11", unit: "sat" }] },
    "5": { methods: [{ method: "bolt11", unit: "sat" }] },
    "7": { supported: true },
  },
};

// --- host rejection: a test mint must never be auto-selected --------------

Deno.test("isRejectableHost refuses test/regtest/loopback fixtures", () => {
  assert(isRejectableHost("https://testnut.cashu.space"));
  assert(isRejectableHost("https://nofee.testnut.cashu.space"));
  assert(isRejectableHost("http://mint.example.com")); // not https
  assert(isRejectableHost("https://localhost:3338"));
  assert(isRejectableHost("https://127.0.0.1:3338"));
  assert(isRejectableHost("https://mint.local"));
  assert(isRejectableHost("not a url"));
  assertEquals(isRejectableHost("https://mint.minibits.cash/Bitcoin"), undefined);
  assertEquals(isRejectableHost("https://mint.coinos.io"), undefined);
});

Deno.test("probeMint rejects a test mint WITHOUT making a network call", async () => {
  let called = false;
  const f = ((() => { called = true; return Promise.resolve(new Response("{}")); }) as unknown as typeof fetch);
  const p = await probeMint("https://testnut.cashu.space", { fetchImpl: f });
  assertEquals(p.score, 0);
  assert(p.reject?.includes("fixture") || p.reject?.includes("test"), `got ${p.reject}`);
  assertEquals(called, false, "must not probe a rejected host");
});

// --- capability parsing ---------------------------------------------------

Deno.test("capabilities reads NUT-04/05 methods and NUT-07", () => {
  const c = capabilities(GOOD_INFO);
  assertEquals(c.supportsMintBolt11, true);
  assertEquals(c.supportsMeltBolt11, true);
  assertEquals(c.supportsCheckstate, true);
  assertEquals(c.nuts, ["4", "5", "7"]);
});

Deno.test("capabilities: a mint with NUT-04 but not bolt11/sat is not usable", () => {
  const c = capabilities({ nuts: { "4": { methods: [{ method: "onchain", unit: "sat" }] }, "5": {} } });
  assertEquals(c.supportsMintBolt11, false);
  assertEquals(c.supportsMeltBolt11, false);
});

Deno.test("capabilities tolerates an empty/absent nuts block", () => {
  const c = capabilities({});
  assertEquals(c.supportsMintBolt11, false);
  assertEquals(c.nuts, []);
});

// --- scoring --------------------------------------------------------------

Deno.test("scoreMint: capability dominates speed", () => {
  const slowCapable = scoreMint({
    url: "https://a", source: "seed", reachable: true, latencyMs: 3000,
    name: null, version: null, nuts: ["4", "5", "7"], audited: false,
    supportsMintBolt11: true, supportsMeltBolt11: true, supportsCheckstate: true,
  } as Omit<MintProbe, "score">);
  const fastCripple = scoreMint({
    url: "https://b", source: "seed", reachable: true, latencyMs: 30,
    name: null, version: null, nuts: ["4"], audited: true,
    supportsMintBolt11: true, supportsMeltBolt11: false, supportsCheckstate: false,
  } as Omit<MintProbe, "score">);
  assertEquals(fastCripple, 0, "cannot melt => unusable regardless of speed");
  assert(slowCapable >= 90, `expected >=90, got ${slowCapable}`);
});

Deno.test("scoreMint: unreachable or non-minting mints score 0", () => {
  const base = {
    url: "https://a", source: "seed" as const, latencyMs: null, name: null,
    version: null, nuts: [] as string[], audited: false, supportsMintBolt11: false,
    supportsMeltBolt11: false, supportsCheckstate: false,
  };
  assertEquals(scoreMint({ ...base, reachable: false }), 0);
  assertEquals(scoreMint({ ...base, reachable: true }), 0);
  assertEquals(scoreMint({ ...base, reachable: true, supportsMintBolt11: true }), 0);
});

// --- probing --------------------------------------------------------------

Deno.test("probeMint scores a capable mint and records latency/version", async () => {
  const p = await probeMint("https://mint.minibits.cash/Bitcoin", { fetchImpl: fakeFetch({ info: GOOD_INFO }) });
  assertEquals(p.reachable, true);
  assertEquals(p.score >= 90, true);
  assertEquals(p.version, "cdk-mintd/0.17.7");
  assertEquals(typeof p.latencyMs, "number");
  assertEquals(p.reject, undefined);
});

Deno.test("probeMint refuses a mint whose keys do not load", async () => {
  const p = await probeMint("https://mint.alpha-mint.net", {
    fetchImpl: fakeFetch({ info: GOOD_INFO, keys: { keysets: [] } }),
  });
  assertEquals(p.reachable, true);
  assertEquals(p.score, 0);
  assertEquals(p.reject, "no keysets");
});

Deno.test("probeMint refuses a mint that cannot melt, and says why", async () => {
  const info = { nuts: { "4": { methods: [{ method: "bolt11", unit: "sat" }] }, "7": {} } };
  const p = await probeMint("https://mint.alpha-mint.net", { fetchImpl: fakeFetch({ info }) });
  assertEquals(p.score, 0);
  assertEquals(p.reject, "no NUT-05 bolt11/sat");
});

Deno.test("probeMint reports an unreachable mint without throwing", async () => {
  const p = await probeMint("https://mint.alpha-mint.net", { fetchImpl: fakeFetch({ throwOn: "info" }) });
  assertEquals(p.reachable, false);
  assertEquals(p.score, 0);
  assert(p.reject?.startsWith("unreachable"), `got ${p.reject}`);
});

Deno.test("probeMint surfaces a non-200 info as a rejection", async () => {
  const p = await probeMint("https://mint.alpha-mint.net", { fetchImpl: fakeFetch({ infoStatus: 503 }) });
  assertEquals(p.score, 0);
  assertEquals(p.reject, "http 503");
});

// --- selection ------------------------------------------------------------

function probe(url: string, score: number, extra: Partial<MintProbe> = {}): MintProbe {
  return {
    url, source: "seed", reachable: true, latencyMs: 100, name: null, version: null,
    nuts: ["4", "5", "7"], supportsMintBolt11: true, supportsMeltBolt11: true,
    supportsCheckstate: true, audited: false, score, ...extra,
  };
}

Deno.test("selectMint picks the highest score and honours minScore", () => {
  const best = selectMint([probe("https://a", 70), probe("https://b", 95)]);
  assertEquals(best.chosen?.url, "https://b");
  const none = selectMint([probe("https://a", 40)], 60);
  assertEquals(none.chosen, null);
  assertEquals(none.rejected.length, 1);
});

Deno.test("selectMint: an unverified-but-fast mint never outranks a verified one", () => {
  // this is the regression that matters: auto-select must never prefer a
  // probe that failed its capability check just because it answered quickly.
  const s = selectMint([
    probe("https://fast-unverified", 0, { reject: "no NUT-05 bolt11/sat" }),
    probe("https://slow-verified", 90, { latencyMs: 2000 }),
  ]);
  assertEquals(s.chosen?.url, "https://slow-verified");
});

Deno.test("probeAll ranks best-first and keeps rejected entries", async () => {
  const fetchImpl = ((input: string | URL | Request) => {
    const url = String(input);
    const capable = { nuts: { "4": { methods: [{ method: "bolt11", unit: "sat" }] }, "5": { methods: [{ method: "bolt11", unit: "sat" }] }, "7": {} } };
    const crippled = { nuts: { "4": { methods: [{ method: "bolt11", unit: "sat" }] } } };
    if (url.startsWith("https://slow")) {
      return Promise.resolve(new Response(JSON.stringify(url.endsWith("info") ? capable : { keysets: [{ id: "x" }] })));
    }
    if (url.startsWith("https://crippled-mint")) {
      return Promise.resolve(new Response(JSON.stringify(url.endsWith("info") ? crippled : { keysets: [{ id: "x" }] })));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as unknown as typeof fetch;
  const r = await probeAll(["https://crippled-mint.net", "https://slow-mint.net"], { fetchImpl });
  assertEquals(r[0].url, "https://slow-mint.net");
  assertEquals(r[0].score > r[1].score, true);
});

// --- NIP-87 discovery -----------------------------------------------------

Deno.test("discoverFromNip87 extracts mint urls from kind-38172 tags", async () => {
  class FakeWS {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(public url: string) {
      setTimeout(() => {
        this.onopen?.();
        this.onmessage?.({ data: JSON.stringify(["EVENT", "s", { tags: [["u", "https://mint.cashu.chat"]] }]) });
        this.onmessage?.({ data: JSON.stringify(["EVENT", "s", { tags: [["d", "https://mint.gitvid.net"]] }]) });
        this.onmessage?.({ data: JSON.stringify(["EVENT", "s", { tags: [["u", "not-a-url"]] }]) });
        this.onmessage?.({ data: JSON.stringify(["EOSE", "s"]) });
      }, 0);
    }
    send() {}
    close() {}
  }
  const urls = await discoverFromNip87(["wss://fake.relay"], {
    timeoutMs: 500,
    WebSocketImpl: FakeWS as unknown as typeof WebSocket,
  });
  assert(urls.includes("https://mint.cashu.chat"));
  assert(urls.includes("https://mint.gitvid.net"));
  assertEquals(urls.includes("not-a-url"), false);
});

Deno.test("discoverFromNip87 survives a relay that throws on connect", async () => {
  class Boom {
    constructor() { throw new Error("connect refused"); }
  }
  const urls = await discoverFromNip87(["wss://dead.relay"], {
    timeoutMs: 300,
    WebSocketImpl: Boom as unknown as typeof WebSocket,
  });
  assertEquals(urls, []);
});

Deno.test("probeAll accepts {url,source} objects and preserves the source", async () => {
  // regression: the CLI passes candidate objects, not bare strings. Passing an
  // object straight into probeMint threw "url.trim is not a function".
  const f = ((input: string | URL | Request) => {
    const url = String(input);
    const body = { nuts: { "4": { methods: [{ method: "bolt11", unit: "sat" }] }, "5": { methods: [{ method: "bolt11", unit: "sat" }] }, "7": {} } };
    return Promise.resolve(new Response(JSON.stringify(url.endsWith("info") ? body : { keysets: [{ id: "x" }] })));
  }) as unknown as typeof fetch;
  const r = await probeAll([{ url: "https://announced-mint.net", source: "nip87" }], { fetchImpl: f });
  assertEquals(r.length, 1);
  assertEquals(r[0].url, "https://announced-mint.net");
  assertEquals(r[0].source, "nip87");
  assertEquals(r[0].score >= 90, true);
});

// --- mint resolution (the "setting" half) ---------------------------------
Deno.test("resolveMintUrl prefers CASHU_MINT_URL over config", async () => {
  const got = await resolveMintUrl({
    env: { CASHU_MINT_URL: "https://env-mint.net/" },   // trailing slash must be normalised
    readFile: () => Promise.resolve(JSON.stringify({ selected: "https://cfg-mint.net" })),
    configPath: "/x",
  });
  assertEquals(got, "https://env-mint.net");
});

Deno.test("resolveMintUrl falls back to config when env is unset", async () => {
  const got = await resolveMintUrl({
    env: {},
    readFile: () => Promise.resolve(JSON.stringify({ selected: "https://cfg-mint.net" })),
    configPath: "/x",
  });
  assertEquals(got, "https://cfg-mint.net");
});

Deno.test("resolveMintUrl returns null (fail closed) when neither is available", async () => {
  assertEquals(await resolveMintUrl({ env: {}, readFile: () => Promise.reject(new Error("ENOENT")), configPath: "/x" }), null);
  assertEquals(await resolveMintUrl({ env: {}, readFile: () => Promise.resolve("not json"), configPath: "/x" }), null);
  assertEquals(await resolveMintUrl({ env: { CASHU_MINT_URL: "   " }, readFile: () => Promise.resolve('{"selected":null}'), configPath: "/x" }), null);
});
