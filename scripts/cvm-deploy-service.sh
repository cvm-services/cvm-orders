#!/usr/bin/env bash
# cvm-deploy-service.sh — ship the cvm-orders SERVICE code (main.ts + src/) to the
# host and restart it. Companion to cvm-deploy-catalog.sh, which only ships the
# catalog (venues.json) and never the code.
#
# WHY: the catalog script restarts the service to pick up a new venues.json. It
# does NOT ship main.ts/src — so a code change (e.g. a new response field) can sit
# committed-but-undeployed while the catalog looks "done". That gap is exactly how
# a fix appears to do nothing. This script closes it.
#
# WHAT IT DOES (idempotent):
#   1. run the orders test suite (deno task test)      [skip: SKIP_TESTS=1]
#   2. record the live response shape BEFORE (GET /api/orders/<new>)
#   3. tar main.ts, src/, config/ -> host, write into /opt/tollgate/cvm-orders
#   4. restart cvm-orders, wait for active
#   5. record the live response shape AFTER + print both so the change is visible
#
# USAGE:
#   bash scripts/cvm-deploy-service.sh
#   CVM_HOST=debian@testserver2.fips bash scripts/cvm-deploy-service.sh
#   SKIP_TESTS=1 bash scripts/cvm-deploy-service.sh
#
# EXIT: 0 on success, non-zero if tests fail or the service does not come back.
set -euo pipefail

ORD="${CVM_ORDERS:-/home/c03rad0r/repos/cvm-orders}"
HOST="${CVM_HOST:-debian@testserver2.fips}"
APP="${CVM_APP_DIR:-/opt/tollgate/cvm-orders}"
API="${CVM_API_URL:-https://cvm-pwa.orangesync.tech}"
VENUE="${CVM_PROBE_VENUE:-three-buddies-berlin}"
SKU="${CVM_PROBE_SKU:-1052491}"

# --------------------------------------------------------------- 1. tests
if [ "${SKIP_TESTS:-0}" = "1" ]; then
  echo "== 1/5 SKIP_TESTS=1 — not running the suite =="
else
  echo "== 1/5 orders test suite =="
  # Run in a subshell and grep AFTER the run finishes. Piping `deno task test`
  # straight into `grep` can leave the pipe open on the coverage reporter and
  # hang the whole script with no output — capture, then filter.
  # NOTE: deno colours its summary (`\e[32mok\e[0m | …`), so strip ANSI before
  # matching `^ok` — otherwise the guard never fires and every deploy aborts.
  _testlog="$(cd "$ORD" && NO_COLOR=1 ~/.local/bin/deno task test 2>&1 || true)"
  _plain="$(printf '%s' "$_testlog" | sed -E 's/\x1b\[[0-9;]*m//g')"
  echo "$_plain" | grep -E "^ok \|" || true
  if ! echo "$_plain" | grep -qE "^ok \| [0-9]+ passed.*\| 0 failed"; then
    echo "ERROR: test suite not green — aborting deploy" >&2
    echo "$_plain" | tail -20 >&2
    exit 1
  fi
fi

# --------------------------------------------------- 2. shape BEFORE
probe_shape() {
  python3 - "$API" "$VENUE" "$SKU" <<'PY'
import json, sys, urllib.request, urllib.error

api, venue, sku = sys.argv[1], sys.argv[2], sys.argv[3]
body = json.dumps({
    "venue_slug": venue,
    "items": [{"sku": sku, "qty": 1, "amount": 4.5, "options": "probe"}],
    "fulfilment": "pickup",
    "inputs": {"contact.name": "deploy-probe", "contact.phone": "+491700000000"},
}).encode()
try:
    req = urllib.request.Request(f"{api}/api/orders", data=body,
                                 headers={"content-type": "application/json"})
    order = json.loads(urllib.request.urlopen(req, timeout=25).read())
except Exception as e:  # noqa: BLE001
    print(f"  probe CREATE failed: {e}")
    raise SystemExit(0)
oid = order.get("id")
got = json.loads(urllib.request.urlopen(f"{api}/api/orders/{oid}", timeout=25).read())
have_vr = "venue_reference" in got
print(f"  order {oid} state={got.get('state')} "
      f"total={got.get('total')} venue_reference_field={have_vr} "
      f"value={got.get('venue_reference')!r}")
PY
}

echo "== 2/5 live response shape BEFORE =="
probe_shape

# ------------------------------------------------------------- 3. ship code
echo "== 3/5 ship service code -> $HOST:$APP =="
tar -C "$ORD" -cf - main.ts src config deno.json | \
  ssh -o BatchMode=yes "$HOST" 'tar -C /tmp -xf - && ls /tmp/main.ts >/dev/null && echo "   staged in /tmp"'

# ------------------------------------------------------------- 4. restart
echo "== 4/5 install + restart =="
ssh -o BatchMode=yes "$HOST" "
  set -e
  sudo mkdir -p $APP
  sudo cp -r /tmp/main.ts /tmp/src /tmp/config /tmp/deno.json $APP/
  sudo systemctl restart cvm-orders
  sleep 2
  systemctl is-active cvm-orders
  rm -rf /tmp/main.ts /tmp/src /tmp/config /tmp/deno.json
"

# -------------------------------------------------- 5. shape AFTER
echo "== 5/5 live response shape AFTER =="
probe_shape
echo
echo "PROBE complete. A field that appears here is DEPLOYED, not just committed."
