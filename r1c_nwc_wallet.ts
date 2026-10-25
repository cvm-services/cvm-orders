// Minimal NIP-47 wallet for the R1c harness.
//
// Self-contained on purpose: the first version imported `NwcLnWallet` from a
// SIBLING cvm-service-kit checkout, which cannot exist on a fresh clone. This
// file implements only the three methods the harness needs, so the proof is
// reproducible from the cvm-orders repo alone.

import { type Event, finalizeEvent, nip04, nip44 } from "nostr-tools";
import { Relay } from "nostr-tools/relay";

export interface MintedInvoice {
  bolt11: string;
  paymentHash: string;
}

export interface PaymentReceipt {
  preimage: string;
  feeSats?: number;
}

export class NwcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NwcError";
  }
}

/**
 * Nostr Wallet Connect (NIP-47) wallet.
 * URI: nostr+walletconnect://<wallet-pubkey-hex>?relay=wss://...&secret=<hex>&encryption=nip44
 */
export class NwcLnWallet {
  private readonly walletPubkey: string;
  private readonly relayUrl: string;
  private readonly secret: Uint8Array;
  private readonly encryption: "nip04" | "nip44";
  private readonly timeoutMs: number;
  private relay?: Relay;

  constructor(nwcUrl: string, opts: { timeoutMs?: number } = {}) {
    const u = new URL(nwcUrl.replace(/^nostr\+walletconnect:\/\//, "https://"));
    this.walletPubkey = u.hostname;
    const relay = u.searchParams.get("relay");
    const secretHex = u.searchParams.get("secret");
    if (!relay || !secretHex) throw new NwcError("NWC URI missing relay or secret");
    this.relayUrl = relay;
    this.secret = new Uint8Array(secretHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    this.encryption = u.searchParams.get("encryption") === "nip44" ? "nip44" : "nip04";
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  private async connect(): Promise<Relay> {
    if (!this.relay) this.relay = await Relay.connect(this.relayUrl);
    return this.relay;
  }

  private async encrypt(plaintext: string): Promise<string> {
    if (this.encryption === "nip44") {
      return nip44.v2.encrypt(
        plaintext,
        nip44.v2.utils.getConversationKey(this.secret, this.walletPubkey),
      );
    }
    return nip04.encrypt(this.secret, this.walletPubkey, plaintext);
  }

  private async decrypt(ciphertext: string): Promise<string> {
    if (this.encryption === "nip44") {
      return nip44.v2.decrypt(
        ciphertext,
        nip44.v2.utils.getConversationKey(this.secret, this.walletPubkey),
      );
    }
    return nip04.decrypt(this.secret, this.walletPubkey, ciphertext);
  }

  private async request(method: string, params: Record<string, unknown>): Promise<any> {
    const relay = await this.connect();
    const reqEvent: Event = finalizeEvent(
      {
        kind: 23194,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", this.walletPubkey]],
        content: await this.encrypt(JSON.stringify({ method, params })),
      },
      this.secret,
    );

    let eventsSeen = 0;

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.close();
        reject(
          new NwcError(
            `${method} timed out (${eventsSeen === 0 ? "no reply" : "unreadable reply"})`,
          ),
        );
      }, this.timeoutMs);

      const sub = relay.subscribe([{ kinds: [23195], authors: [this.walletPubkey], limit: 0 }], {
        onevent: async (event: any) => {
          const eTag = event.tags?.find((t: string[]) => t[0] === "e");
          if (eTag && eTag[1] !== reqEvent.id) return;
          eventsSeen += 1;
          try {
            const plain = await this.decrypt(event.content);
            const msg = JSON.parse(plain);
            clearTimeout(timer);
            sub.close();
            if (msg.error) {
              reject(
                new NwcError(
                  `${method}: ${msg.error?.message ?? JSON.stringify(msg.error)}`,
                ),
              );
              return;
            }
            resolve(msg.result);
          } catch {
            // Another candidate reply may still be readable; keep waiting.
          }
        },
      });

      relay.publish(reqEvent).catch((e: any) => {
        clearTimeout(timer);
        sub.close();
        reject(e);
      });
    });
  }

  async balanceSats(): Promise<number> {
    const result = await this.request("get_balance", {});
    return Math.floor((result.balance ?? 0) / 1000);
  }

  async makeInvoice(sats: number, memo?: string): Promise<MintedInvoice> {
    const result = await this.request("make_invoice", {
      amount: sats * 1000,
      description: memo ?? "",
    });
    return { bolt11: result.invoice, paymentHash: result.payment_hash };
  }

  async payInvoice(bolt11: string): Promise<PaymentReceipt> {
    const result = await this.request("pay_invoice", { invoice: bolt11 });
    return {
      preimage: result.preimage,
      feeSats: result.fees_paid ? Math.ceil(result.fees_paid / 1000) : undefined,
    };
  }
}
