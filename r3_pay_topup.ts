// Fund ONE 2fiat card for real (operator-approved). Pays a topup BOLT11 from the
// treasury NWC wallet.
//
// A timeout is NOT a failure: the broker executes and stays silent, so this
// script NEVER retries. It pays once, then the CALLER proves funding by polling
// the 2fiat card balance — an invoice paid is not a card funded.
//
// Usage: NWC_URL=... deno run --allow-net --allow-env r3_pay_topup.ts <bolt11>
import { finalizeEvent, nip04, nip44 } from "nostr-tools";
import { Relay } from "nostr-tools/relay";

const bolt11 = Deno.args[0];
if (!bolt11 || !/^lnbc/i.test(bolt11)) {
  console.error("usage: r3_pay_topup.ts <bolt11 starting lnbc>");
  Deno.exit(2);
}
const url = Deno.env.get("NWC_URL") ?? "";
if (!url) { console.error("NWC_URL not set"); Deno.exit(2); }

const u = new URL(url.replace(/^nostr\+walletconnect:\/\//, "https://"));
const walletPubkey = u.hostname;
const relayUrl = u.searchParams.get("relay")!;
const secretHex = u.searchParams.get("secret")!;
const scheme = u.searchParams.get("encryption") === "nip44" ? "nip44" : "nip04";
const secret = new Uint8Array(secretHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
console.log(`relay: ${relayUrl}  scheme: ${scheme}`);

const relay = await Relay.connect(relayUrl);
console.log("relay connected");

function encrypt(plain: string): string {
  if (scheme === "nip44") {
    const key = nip44.v2.utils.getConversationKey(secret, walletPubkey);
    return nip44.v2.encrypt(plain, key);
  }
  return nip04.encrypt(secret, walletPubkey, plain);
}
function decrypt(ct: string): string {
  if (scheme === "nip44") {
    const key = nip44.v2.utils.getConversationKey(secret, walletPubkey);
    return nip44.v2.decrypt(ct, key);
  }
  return nip04.decrypt(secret, walletPubkey, ct);
}

async function call(method: string, params: Record<string, unknown>): Promise<any> {
  const payload = JSON.stringify({ method, params });
  const req = finalizeEvent({
    kind: 23194, created_at: Math.floor(Date.now() / 1000),
    tags: [["p", walletPubkey]], content: encrypt(payload),
  }, secret);
  const t0 = Date.now();
  return await new Promise((resolve) => {
    const sub = relay.subscribe([{ kinds: [23195], authors: [walletPubkey], limit: 0 }], {
      onevent: (ev: any) => {
        const e = ev.tags?.find((t: string[]) => t[0] === "e")?.[1];
        if (e !== req.id) return;
        try {
          resolve({ ok: true, ms: Date.now() - t0, body: JSON.parse(decrypt(ev.content)) });
        } catch (err) {
          resolve({ ok: false, ms: Date.now() - t0, error: String(err) });
        }
        sub.close();
      },
    });
    setTimeout(() => { sub.close(); resolve({ ok: false, timeout: true, ms: Date.now() - t0 }); }, 45_000);
  });
}

// 1. balance first — never pay blind
const bal = await call("get_balance", {});
console.log("balance:", JSON.stringify(bal).slice(0, 200));

// 2. pay ONCE
const t0 = Date.now();
const pay = await call("pay_invoice", { invoice: bolt11 });
console.log("pay_invoice result:", JSON.stringify(pay).slice(0, 400), "in", Date.now() - t0, "ms");
console.log(pay.ok && pay.body?.result?.preimage
  ? "PREIMAGE PRESENT — payment executed"
  : "NO REPLY / NO PREIMAGE — outcome UNKNOWN; do NOT retry");

// 3. balance after
const bal2 = await call("get_balance", {});
console.log("balance after:", JSON.stringify(bal2).slice(0, 200));
relay.close();
