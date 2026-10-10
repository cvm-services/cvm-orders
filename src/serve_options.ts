// Serve options for the order service.
//
// Kept in its own module (not inline in main.ts) so it can be unit-tested
// without importing main.ts, which reads the environment at module scope.
//
// Loopback by default: this service is reachable only through the Caddy `/api`
// reverse proxy on the same host (see the deploy notes in README.md). Set
// BIND_ADDR=0.0.0.0 only when it is deliberately exposed — the store has no
// authentication of its own today.

export type EnvReader = { get(key: string): string | undefined };

export const DEFAULT_PORT = 8000;
export const DEFAULT_BIND_ADDR = "127.0.0.1";

export function serveOptions(env: EnvReader): { port: number; hostname: string } {
  const port = Number(env.get("PORT") ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be an integer in 1..65535, got ${JSON.stringify(env.get("PORT"))}`);
  }
  return { port, hostname: env.get("BIND_ADDR") ?? DEFAULT_BIND_ADDR };
}
