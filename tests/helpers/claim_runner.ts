/**
 * One OS process, one settlement claim attempt. This is what makes the
 * exactly-once proof real: SQLite's unix VFS uses POSIX advisory locks, which
 * are per-*process*, so two stores inside one process (or two threads) do not
 * model two independent callers at all — they fight over lock state SQLite does
 * not expect to be shared.
 *
 * Not a test module (deno test does not collect this name). Prints one word:
 *   won | lost | proof_spent | missing | locked | error:<message>
 *
 *   deno run --allow-read --allow-write --allow-env tests/helpers/claim_runner.ts \
 *     <db-path> <order-id> <quote-id> <start-at-epoch-ms>
 */
import { OrderStore } from "../../src/store.ts";

const [path, orderId, quoteId, startAtArg] = Deno.args;
const startAt = Number(startAtArg);

const store = new OrderStore({ path });

// A common start barrier: without it the first process would finish before the
// rest had even opened the file, and the "race" would be fiction.
while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 1));

let outcome: string;
try {
  outcome = store.claimSettlement(orderId, { quoteId });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  // A lock timeout fails CLOSED: this caller claims nothing.
  outcome = /locked|busy/i.test(message) ? "locked" : `error:${message}`;
}

store.close();
console.log(outcome);
