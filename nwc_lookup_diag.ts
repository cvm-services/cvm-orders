// Does the broker support lookup_invoice? This is the correct NIP-47 way to resolve
// an UNKNOWN payment outcome: ask by payment hash instead of blocking on the reply.
//
// It also answers a money question: did the 4-sat invoice actually get paid? The
// balance did not move (19871 -> 19871), which suggests it did not — but "suggests"
// is not measurement.
import { finalizeEvent, nip04 } from "nostr-tools";
import { Relay } from "nostr-tools/relay";

const url = Deno.env.get("NWC_URL") ?? "";
const bolt11 = Deno.env.get("BOLT11") ?? "";
if (!url || !bolt11) { console.error("NWC_URL and BOLT11 required"); Deno.exit(2); }

const u = new URL(url.replace(/^nostr\+walletconnect:\/\//, "https://"));
const walletPubkey = u.hostname;
const relayUrl = u.searchParams.get("relay")!;
const secretHex = u.searchParams.get("secret")!;
const secret = new Uint8Array(secretHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));

// Extract the payment hash from the bolt11 (bech32 field 'p').
function paymentHashFromInvoice(inv: string): string {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const s = inv.toLowerCase();
  const sep = s.lastIndexOf("1");
  const data = s.slice(sep + 1, sep + 1 + s.length - sep - 1 - 6);
  const words = [...data].map((c) => CHARSET.indexOf(c));
  // 5-bit words -> bytes
  const bytes: number[] = [];
  let acc = 0, bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w; bits += 5;
    while (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
  }
  // hrp length in 5-bit words
  const hrpWords = Math.ceil((sep * 8) / 5);
  const tsField = bytes.slice(hrpWords);
  // timestamp is 7 words (35 bits) then fields: tag, len, data
  let i = 7;
  while (i + 2 <= tsField.length) {
    const tag = tsField[i], len = tsField[i + 1];
    const data2 = tsField.slice(i + 2, i + 2 + len);
    if (tag === 23 && data2.length === 52) {
      return data2.map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    i += 2 + len;
  }
  return "";
}

const hash = paymentHashFromInvoice(bolt11);
console.log(`payment hash: ${hash || "(could not parse)"}`);

const relay = await Relay.connect(relayUrl);
console.log("relay connected");

async function ask(method: string, params: Record<string, unknown>, waitMs = 30_000) {
  const content = nip04.encrypt(secret, walletPubkey, JSON.stringify({ method, params }));
  const ev = finalizeEvent(
    { kind: 23194, created_at: Math.floor(Date.now() / 1000), tags: [["p", walletPubkey]], content },
    secret,
  );
  const t0 = Date.now();
  return await new Promise<any>((resolve) => {
    const timer = setTimeout(() => { sub.close(); resolve({ __timeout: true, ms: Date.now() - t0 }); }, waitMs);
    const sub = relay.subscribe([{ kinds: [23195], authors: [walletPubkey], limit: 0 }], {
      onevent: (e: any) => {
        const eTag = e.tags?.find((t: string[]) => t[0] === "e");
        if (eTag?.[1] !== ev.id) return;
        clearTimeout(timer); sub.close();
        let plain = "";
        try { plain = nip04.decrypt(secret, walletPubkey, e.content); } catch { /* fall through */ }
        if (!plain) { resolve({ __undecryptable: true, ms: Date.now() - t0 }); return; }
        resolve({ ...JSON.parse(plain), ms: Date.now() - t0 });
      },
    });
    relay.publish(ev);
  });
}

const r = await ask("lookup_invoice", { payment_hash: hash });
console.log(`\nlookup_invoice result (${r.ms}ms):`);
console.log(JSON.stringify(r, null, 2).slice(0, 700));

if (r.__timeout) console.log("\n=> lookup_invoice TIMED OUT: the broker does not answer it.");
else if (r.error) console.log(`\n=> NIP-47 ERROR: ${JSON.stringify(r.error)}`);
else if (r.result) console.log(`\n=> SUPPORTED. state=${r.result.state ?? "(none)"} settled_at=${r.result.settled_at ?? "-"}`);

relay.close();
