#!/usr/bin/env bash
# cvm-deploy-state.sh — one-shot provenance/state dump for CVM services.
#
# WHY: "where is this committed and pushed?" was being re-derived by hand
# (tokens burned on the same git-log/status/remote dance every time). This is
# the deterministic answer; run it instead of asking.
#
# Usage:  bash ~/.hermes/profiles/manager/scripts/cvm-deploy-state.sh
set -uo pipefail

REPOS=(
  contextvm-services:~/.hermes/secrets/venues
  cvm-registry:
  cvm-orders:
)
GITHUB_ORG="cvm-services"
HOST="debian@testserver2.fips"

echo "=== LOCAL REPOS (branch / tip / dirty) ==="
for entry in "${REPOS[@]}"; do
  name="${entry%%:*}"
  dir="$HOME/repos/$name"
  [ -d "$dir/.git" ] || { echo "$name: MISSING at $dir"; continue; }
  branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD)
  tip=$(git -C "$dir" log --oneline -1)
  dirty=$(git -C "$dir" status --porcelain | grep -v '^?? coverage/' | wc -l | tr -d ' ')
  echo "$name"
  echo "  branch : $branch"
  echo "  tip    : $tip"
  echo "  dirty  : $dirty tracked change(s)"
  echo "  remotes:"
  git -C "$dir" remote -v | awk '{print "    "$1" -> "$2}' | sort -u
done

echo
echo "=== GITHUB vs LOCAL (main tip equality) ==="
for entry in "${REPOS[@]}"; do
  name="${entry%%:*}"
  dir="$HOME/repos/$name"
  [ -d "$dir/.git" ] || continue
  local_tip=$(git -C "$dir" rev-parse main 2>/dev/null | cut -c1-7)
  remote_tip=$(gh api "repos/$GITHUB_ORG/$name/commits/main" -q '.sha' 2>/dev/null | cut -c1-7)
  if [ -n "$remote_tip" ]; then
    [ "$local_tip" = "$remote_tip" ] \
      && echo "$name: main local=$local_tip == github=$remote_tip  (PUSHED)" \
      || echo "$name: main local=$local_tip != github=$remote_tip  (NOT PUSHED)"
  else
    echo "$name: main local=$local_tip  (no github repo $GITHUB_ORG/$name)"
  fi
done

echo
echo "=== DEPLOYED ON HOST ($HOST) ==="
ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" '
  echo "cvm-orders (systemd):"
  systemctl is-active cvm-orders 2>/dev/null | sed "s/^/  active: /"
  grep -c venue_slug /opt/tollgate/cvm-orders/config/venues.json 2>/dev/null | sed "s/^/  catalog venues: /"
  grep -o "\"venue_slug\": *\"[a-z-]*\"" /opt/tollgate/cvm-orders/config/venues.json 2>/dev/null | sed "s/^/    /"
  echo "PWA bundle (/opt/tollgate/cvm-pwa):"
  python3 -c "import json;d=json.load(open(\"/opt/tollgate/cvm-pwa/menu.json\"));print(\"  menu venues:\",[v[\"venue_slug\"] for v in d[\"venues\"]])" 2>/dev/null
' || echo "  (host unreachable)"

echo
echo "=== LIVE ENDPOINTS ==="
for u in /order/ /console/ /api/auth/challenge; do
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://cvm-pwa.orangesync.tech$u")
  echo "  https://cvm-pwa.orangesync.tech$u -> $code"
done
