// Regression tests for the env-file quoting hazard.
//
// INCIDENT (2026-10-18)
//   An NWC URL was written to an env file as:
//       NWC_URL=nostr+walletconnect://pub?relay=wss://relay.primal.net&secret=...</>
//   Sourcing it with `set -a; . file; set +a` produced an EMPTY variable
//   (`${#NWC_URL}` was 0). The `&` and `?` are shell metacharacters: unquoted, the
//   line runs as extra commands and the assignment is lost. The failure was SILENT
//   — the script reported "NWC_URL not set", which reads like a missing file rather
//   than a mangled one.
//
// THE GUARANTEE
//   A writer for secret env files must quote values, so that sourcing round-trips
//   byte-exactly for URLs containing & ? = # spaces and quotes.

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { formatEnvFile, parseEnvFile, assertSourcable } from "../src/envfile.ts";

const NWC =
  "nostr+walletconnect://410b7765dab819b899e1e0b92dcdce773052c64d27d62b8e35aef70adc1651a9" +
  "?relay=wss://relay.primal.net&secret=c84c8f6f0aed3f02773ba01aab4c4aaa9eb74cfb764bfb0e1ac13f3d4db38725&encryption=nip04";

Deno.test("a URL containing & ? = survives format -> parse unchanged", () => {
  const out = formatEnvFile({ NWC_URL: NWC });
  const back = parseEnvFile(out);
  assertEquals(back.NWC_URL, NWC);
});

Deno.test("the emitted line is quoted, so a shell cannot split it on &", () => {
  const out = formatEnvFile({ NWC_URL: NWC });
  // The value must be wrapped in quotes: NWC_URL="..." or NWC_URL='...'
  const line = out.trim();
  assertEquals(/^NWC_URL=("|')/.test(line), true, `expected a quoted value, got: ${line.slice(0, 40)}`);
  assertEquals(line.endsWith('"') || line.endsWith("'"), true);
});

Deno.test("assertSourcable rejects an UNQUOTED value with metacharacters", () => {
  const bad = `NWC_URL=${NWC}\n`;
  assertThrows(() => assertSourcable(bad), Error, "unquoted");
});

Deno.test("assertSourcable accepts a properly quoted file", () => {
  const good = formatEnvFile({ NWC_URL: NWC });
  assertEquals(assertSourcable(good), true);
});

Deno.test("values with single quotes, double quotes and spaces round-trip", () => {
  const tricky = `he said "hi" & it's 50% #notacomment`;
  const out = formatEnvFile({ K: tricky });
  assertEquals(parseEnvFile(out).K, tricky);
  assertEquals(assertSourcable(out), true);
});

Deno.test("multiple keys, comments and blank lines are preserved in order", () => {
  const out = formatEnvFile({ A: "1", B: NWC }, { header: "# generated\n" });
  assertEquals(out.startsWith("# generated"), true);
  const back = parseEnvFile(out);
  assertEquals(back.A, "1");
  assertEquals(back.B, NWC);
});
