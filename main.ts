import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { type OrderState, OrderStore } from "./src/store.ts";
const store = new OrderStore();
const facilitatorNpub = Deno.env.get("FACILITATOR_NPUB") ?? null;
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}
function route(req: Request): Response {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,authorization",
      },
    });
  }
  if (req.method === "GET" && url.pathname === "/health") return json({ ok: true });
  if (req.method === "GET" && url.pathname === "/auth/challenge") {
    return json({
      nonce: crypto.randomUUID(),
      facilitatorNpub,
      expiresIn: 300,
      statement: "Sign this nonce to access the facilitator console.",
    });
  }
  if (req.method === "GET" && url.pathname === "/orders/queue") {
    return json({ orders: store.queue() });
  }
  const match = url.pathname.match(/^\/orders\/([^/]+)$/);
  if (match && req.method === "GET") {
    const order = store.get(match[1]);
    return order ? json(order) : json({ error: "not found" }, 404);
  }
  if (match && req.method === "POST" && url.pathname.endsWith("/transition")) {
    return json({ error: "invalid path" }, 400);
  }
  const transition = url.pathname.match(/^\/orders\/([^/]+)\/transition$/);
  if (transition && req.method === "POST") {
    return req.json().then((body) => {
      try {
        return json(store.transition(transition[1], body.state as OrderState));
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "bad request" }, 409);
      }
    });
  }
  if (req.method === "POST" && url.pathname === "/orders") {
    return req.json().then((body) => {
      try {
        return json(store.create(body.id, body.payload), 201);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "bad request" }, 409);
      }
    });
  }
  return json({ error: "not found" }, 404);
}
if (import.meta.main) serve(route, { port: Number(Deno.env.get("PORT") ?? 8000) });
export { route };
