import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { DEFAULT_BIND_ADDR, DEFAULT_PORT, serveOptions } from "../src/serve_options.ts";

const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] });

Deno.test("binds loopback on the default port when nothing is configured", () => {
  const opts = serveOptions(env({}));
  assertEquals(opts.hostname, DEFAULT_BIND_ADDR);
  assertEquals(opts.port, DEFAULT_PORT);
  // The whole point: never 0.0.0.0 unless BIND_ADDR says so.
  assertEquals(opts.hostname, "127.0.0.1");
});

Deno.test("PORT and BIND_ADDR override the defaults", () => {
  assertEquals(serveOptions(env({ PORT: "8788" })).port, 8788);
  assertEquals(serveOptions(env({ BIND_ADDR: "0.0.0.0" })).hostname, "0.0.0.0");
  assertEquals(serveOptions(env({ PORT: "8788", BIND_ADDR: "0.0.0.0" })), {
    port: 8788,
    hostname: "0.0.0.0",
  });
});

Deno.test("refuses a nonsense PORT instead of silently serving on NaN", () => {
  assertThrows(() => serveOptions(env({ PORT: "eight-thousand" })), Error, "PORT must be");
  assertThrows(() => serveOptions(env({ PORT: "0" })), Error, "PORT must be");
  assertThrows(() => serveOptions(env({ PORT: "70000" })), Error, "PORT must be");
});
