
// The DISK journal is the part that makes recovery real: it must survive a process
// death, so it is tested against a real file, not a Map.
import { assertEquals } from "jsr:@std/assert@1";
import { FileFundingJournal } from "../src/treasury_fund.ts";

function tmpPath() {
  return `${Deno.makeTempDirSync()}/funding.json`;
}

Deno.test("FileFundingJournal persists begin and reloads from disk", () => {
  const p = tmpPath();
  const j = new FileFundingJournal(p);
  j.begin({ quoteId: "q1", amountSats: 4, bolt11: "lnbc1x", startedAt: 1 });

  // A FRESH instance must see it — that is what surviving a crash means.
  const j2 = new FileFundingJournal(p);
  const rec = j2.get("q1");
  assertEquals(rec?.quoteId, "q1");
  assertEquals(rec?.state, "paying");
  assertEquals(rec?.amountSats, 4);
});

Deno.test("FileFundingJournal walks paying -> paid -> claimed on disk", () => {
  const p = tmpPath();
  const j = new FileFundingJournal(p);
  j.begin({ quoteId: "q1", amountSats: 4, bolt11: "lnbc1x", startedAt: 1 });
  j.markPaid("q1", "deadbeef");
  assertEquals(new FileFundingJournal(p).get("q1")?.state, "paid");
  j.markClaimed("q1", [{ amount: 4 }]);
  const rec = new FileFundingJournal(p).get("q1");
  assertEquals(rec?.state, "claimed");
  assertEquals(rec?.preimage, "deadbeef");
  assertEquals(rec?.proofs?.length, 1);
});

Deno.test("pending() returns unfinished records only", () => {
  const p = tmpPath();
  const j = new FileFundingJournal(p);
  j.begin({ quoteId: "done", amountSats: 1, bolt11: "a", startedAt: 1 });
  j.markClaimed("done", []);
  j.begin({ quoteId: "stuck", amountSats: 4, bolt11: "b", startedAt: 2 });
  assertEquals(j.pending().map((r) => r.quoteId), ["stuck"]);
});

Deno.test("a missing file yields an empty journal, not a crash", () => {
  const j = new FileFundingJournal("/nonexistent/dir/nope.json");
  assertEquals(j.get("anything"), undefined);
  assertEquals(j.pending(), []);
});

Deno.test("the write is atomic: no .tmp file is left behind", () => {
  const p = tmpPath();
  const j = new FileFundingJournal(p);
  j.begin({ quoteId: "q1", amountSats: 1, bolt11: "a", startedAt: 1 });
  let tmpExists = true;
  try { Deno.statSync(`${p}.tmp`); } catch { tmpExists = false; }
  assertEquals(tmpExists, false);
  assertEquals(Deno.readTextFileSync(p).includes("q1"), true);
});
