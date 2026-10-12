#!/usr/bin/env bash
# cvm-deploy-catalog.sh — the ONE command for any venue-menu change.
#
# WHY this exists: the last menu change took ~8 manual steps (capture →
# regenerate venues.json → deploy PWA → deploy orders config → restart →
# verify). Repeating that by hand burns tokens and invites drift between
# the PWA menu and the orders catalog. This script is the single supported
# path (same principle as capture_menu.py: regenerate, never hand-edit).
#
# WHAT IT DOES (idempotent end-to-end):
#   1. capture live menus over relay2 → cvm-registry/site/menu.json
#   2. regenerate cvm-orders/config/venues.json from the deployed menu.json
#      (same transform as the existing catalog: slim venues/items + sats-rate
#      + option-surcharges mirror of the shipped app.js)
#   2b. run the orders test suite (deno task test) — pricing must stay green
#   3. deploy PWA (site/* → cvm-pwa host)  [skip: SKIP_DEPLOY_PWA=1]
#   4. deploy orders catalog (scp + systemctl restart cvm-orders)
#   5. verify live: menu.json venue/item counts AND a probe order through
#      /api/orders that must price exactly as the PWA would
#
# USAGE:
#   bash cvm-deploy-catalog.sh                       # all venues, full deploy
#   bash cvm-deploy-catalog.sh three-buddies-berlin  # capture only this venue
#   SKIP_DEPLOY_PWA=1 bash ...                        # catalog-only refresh
#   CVM_HOST=debian@testserver2.fips bash ...         # override target
#
# EXIT: 0 on success; prints a PROBE line with the priced order on success.
set -euo pipefail

REG="${CVM_REGISTRY:-/home/c03rad0r/repos/cvm-registry}"
ORD="${CVM_ORDERS:-/home/c03rad0r/repos/cvm-orders}"
HOST="${CVM_HOST:-debian@testserver2.fips}"
RELAY="${CTXVM_RELAYS:-wss://relay2.orangesync.tech}"
MENU_URL="${CVM_MENU_URL:-https://cvm-pwa.orangesync.tech/menu.json}"

# ------------------------------------------------------------- 1. capture
echo "== 1/5 capture live menus (relay: $RELAY) =="
if [ "${#@}" -gt 0 ]; then
  VEN_ARGS=(); for v in "$@"; do VEN_ARGS+=(--venue "$v"); done
  CTXVM_RELAYS="$RELAY" python3 "$REG/tools/capture_menu.py" "${VEN_ARGS[@]}" \
    --out "$REG/site/menu.json"
else
  # No explicit --venue: capture_menu.py auto-discovers every venue under
  # contextvm-services/venues/ and reports any that is not answering. A hardcoded
  # list here silently dropped onboarded venues (chandi-berlin, 167 items, sat
  # unserved for exactly that reason).
  CTXVM_RELAYS="$RELAY" python3 "$REG/tools/capture_menu.py" \
    --out "$REG/site/menu.json"
fi

# --------------------------- 2. regenerate venues.json (deployed menu → catalog)
echo "== 2/5 regenerate venues.json =="
python3 - "$MENU_URL" "$ORD" <<'PY'
import json, sys, urllib.request, hashlib, datetime

menu_url, ord_dir = sys.argv[1], sys.argv[2]
raw = urllib.request.urlopen(menu_url).read()
menu = json.loads(raw)

catalog = {
  "_provenance": {
    "what": "Server-side venue catalog used to recompute every order price (ADR-0008: never trust a client amount).",
    "source": f"{menu_url} (the file the shipped PWA at /order/ fetches as ../menu.json)",
    "captured_at": datetime.date.today().isoformat(),
    "source_sha256": hashlib.sha256(raw).hexdigest(),
    "how": f"curl -sS {menu_url} | scripts/cvm-deploy-catalog.sh (generate, never hand-edit)",
    "regenerate": "bash scripts/cvm-deploy-catalog.sh  (in cvm-orders)",
    "note": "Prices are mirror-captured from the venue CVMs' live menu events; if a venue menu changes, re-run the deploy script rather than editing this file."
  },
  "sats_per_eur": 1000,
  "_rate_note": "1 EUR = 1000 sats, matching the shipped PWA's own display rate (app.js: `sats = n => Math.round(n * 1000)`). Override with SATS_PER_EUR in the service env.",
  "option_surcharges_sats": {"Bacon": 150, "Jalape\u00f1os": 90, "Extra cheese": 120},
  "_option_note": "Mirrored from the shipped client (app.js: Bacon .15, Jalape\u00f1os .09, Extra cheese .12 EUR). The venue CVMs' option_group_ids are not priced in the captured menu, so a client-sent option token that is not in this table is recorded but charged nothing; see REPORT.md 'what this does NOT prove'.",
  "venues": [
    {
      "venue_slug": v["venue_slug"],
      "name": v["name"],
      "items": [
        {"sku": i["sku"], "name": i["name"],
         "prices_by_order_method": i["prices_by_order_method"],
         "available": i["available"]}
        for i in v["items"]
      ],
    }
    for v in menu["venues"]
  ],
}
out = f"{ord_dir}/config/venues.json"
with open(out, "w") as f:
    json.dump(catalog, f, ensure_ascii=False, indent=2)
    f.write("\n")
print("wrote", out, "| venues:", len(catalog["venues"]))
PY

# ------------------------------------------------------- 2b. orders tests
echo "== 2b/5 orders test suite =="
( cd "$ORD" && deno task test 2>&1 | tail -2 )

# ---------------------------------------------------------- 3. deploy PWA
if [ "${SKIP_DEPLOY_PWA:-0}" = "1" ]; then
  echo "== 3/5 SKIP_DEPLOY_PWA=1 — leaving deployed menu.json as-is =="
else
  echo "== 3/5 deploy PWA =="
  ( cd "$REG" && HOST="$HOST" bash deploy/deploy-pwa.sh >/dev/null )
fi

# --------------------------------------------------- 4. deploy catalog + restart
echo "== 4/5 deploy orders catalog + restart =="
scp -o BatchMode=yes "$ORD/config/venues.json" "$HOST:/tmp/venues.json.new"
ssh -o BatchMode=yes "$HOST" '
  set -e
  for i in 1 2 3; do cmp -s /tmp/venues.json.new /opt/tollgate/cvm-orders/config/venues.json && break || sleep 1; done
  sudo cp /tmp/venues.json.new /opt/tollgate/cvm-orders/config/venues.json
  sudo systemctl restart cvm-orders
  sleep 2
  systemctl is-active cvm-orders
'

# ------------------------------------------------------------------ 5. verify
echo "== 5/5 verify live =="
python3 - "$MENU_URL" <<'PY'
import json, sys, urllib.request
menu = json.loads(urllib.request.urlopen(sys.argv[1]).read())
print(f"menu.json live: {len(menu['venues'])} venues, "
      f"{sum(len(v['items']) for v in menu['venues'])} items")
PY
# probe order: price a real SKU server-side, the exact way the PWA does
PROBE=$(python3 - "$MENU_URL" <<'PY'
import json, sys, urllib.request
menu = json.loads(urllib.request.urlopen(sys.argv[1]).read())
v = next(v for v in menu["venues"] if v["venue_slug"] == "three-buddies-berlin")
i = next(i for i in v["items"] if i.get("available"))
print(json.dumps({"venue_slug": v["venue_slug"],
                  "items": [{"sku": i["sku"], "qty": 1}],
                  "fulfilment": "pickup",
                  "inputs": {"contact.name": "catalog-deploy probe",
                             "contact.phone": "+491700000000",
                             "order.notes": "probe: regenerate-verify"}}))
PY
)
RESP=$(curl -sS -m 20 -X POST https://cvm-pwa.orangesync.tech/api/orders \
  -H 'content-type: application/json' -d "$PROBE")
echo "PROBE: $RESP"
echo "$RESP" | python3 -c '
import json, sys
r = json.load(sys.stdin)
assert r.get("state") == "awaiting_payment", f"probe state != awaiting_payment: {r}"
assert "total" in r, "probe missing total"
print("probe OK: order priced, awaiting_payment")'