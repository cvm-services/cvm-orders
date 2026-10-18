// Diagnose WHERE the NWC reply goes missing: publish a read-only request and log
// every candidate reply event RAW (no decryption), then try both NIP-04 and NIP-44.
//
// The suspect is lnwallet.ts's `catch { /* ignore undecryptable events */ }` — if the
// broker replies with a scheme we don't expect, we silently discard a valid answer and
// wait for the timeout. That is a silent failure, the same class of bug that has cost
// this project repeatedly.
import { finalizeEvent, nip04, nip44 } from "nostr-tools";
import { Relay } from "nostr-tools/relay";

const url = Deno.env.get("NWC_URL") ?? "";
if (!url) { console.error("NWC_URL not set"); Deno.exit(2); }

const u = new URL(url.replace(/^nostr\+walletconnect:\/\//, "https://"));
const walletPubkey = u.hostname;
const relayUrl = u.searchParams.get("relay")!;
const secretHex = u.searchParams.get("secret")!;
const declared = u.searchParams.get("encryption") ?? "(none declared)";
const secret = new Uint8Array(secretHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));

console.log(`wallet pubkey: ${walletPubkey.slice(0, 16)}…`);
console.log(`relay: ${relayUrl}`);
console.log(`declared encryption: ${declared}`);

const relay = await Relay.connect(relayUrl);
console.log("relay connected");

const method = Deno.env.get("NWC_METHOD") ?? "get_balance";
const payload = JSON.stringify({ method, params: {} });

// Send the request NIP-04 encrypted (what the URL declares).
const content = nip04.encrypt(secret, walletPubkey, payload);
const reqEvent = finalizeEvent(
  { kind: 23194, created_at: Math.floor(Date.now() / 1000), tags: [["p", walletPubkey]], content },
  secret,
);
console.log(`request id: ${reqEvent.id.slice(0, 16)}… method=${method}`);

const t0 = Date.now();
const seen: any[] = [];

const sub = relay.subscribe([{ kinds: [23195], authors: [walletPubkey], limit: 0 }], {
  onevent: async (event: any) => {
    const dt = Date.now() - t0;
    const eTag = event.tags?.find((t: string[]) => t[0] === "e");
    seen.push({ dt, id: event.id, e: eTag?.[1], match: eTag?.[1] === reqEvent.id });

    // Try BOTH schemes and report which (if any) works. Silent failure ends here.
    let via = "NONE";
    let plain = "";
    try {
      plain = nip04.decrypt(secret, walletPubkey, event.content);
      via = "nip04";
    } catch {
      try {
        const key = nip44.v2.utils.getConversationKey(secret, walletPubkey);
        plain = nip44.v2.decrypt(event.content, key);
        via = "nip44";
      } catch { /* genuinely undecryptable */ }
    }
    console.log(`\nREPLY after ${dt}ms | e-match=${eTag?.[1] === reqEvent.id} | decrypted-with=${via}`);
    if (via !== "NONE") console.log(`  payload: ${plain.slice(0, 300)}`);
    else console.log(`  RAW (could not decrypt): ${event.content.slice(0, 120)}`);
  },
});

await relay.publish(reqEvent);
console.log("published; waiting up to 90s for ANY reply…");

await new Promise((r) => setTimeout(r, 90_000));
sub.close();
relay.close();

console.log(`\n=== SUMMARY ===`);
console.log(`events seen: ${seen.length}`);
for (const s of seen) console.log(`  ${s.dt}ms e-match=${s.match}`);
if (seen.length === 0) {
  console.log("NO 23195 reply at all — the broker is not publishing to this relay,");
  console.log("or it is publishing after our 90s window.");
}
