#!/usr/bin/env bash
#
# Start the local dev stack (API + web) so ANOTHER machine on the same Wi-Fi
# can open the app.
#
# ── Why only the web server gets exposed ────────────────────────────────────
# apps/web/.env.local points every API base at a RELATIVE path:
#     VITE_API_URL=/api   VITE_PORTAL_API_URL=/portal-api   VITE_PUBLIC_API_BASE=
# so the browser only ever talks to the Vite dev server. Vite then proxies
# /api, /portal-api, /public-api and /webhooks to the API *from this Mac*
# (see apps/web/vite.config.ts).
#
# Consequence: the API stays private on localhost — there is nothing to expose
# and no CORS to widen. The visiting PC only needs to reach port 5173.
#
# ── Usage ───────────────────────────────────────────────────────────────────
#   npm run dev:lan
#   bash scripts/dev-lan.sh
#   WEB_PORT=5174 API_PORT=3002 bash scripts/dev-lan.sh
#
# Ctrl-C stops both servers.

set -euo pipefail

WEB_PORT="${WEB_PORT:-5173}"
API_PORT="${API_PORT:-3001}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── This Mac's LAN address ──────────────────────────────────────────────────
# Ask the routing table which interface carries the default route (Wi-Fi is
# usually en0, but it is en1 on machines with Ethernet), then read its IP.
lan_ip() {
  local iface ip
  iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')" || true
  if [ -n "${iface:-}" ]; then
    ip="$(ipconfig getifaddr "$iface" 2>/dev/null)" || true
    if [ -n "${ip:-}" ]; then echo "$ip"; return; fi
  fi
  for i in en0 en1 en2 en3; do
    ip="$(ipconfig getifaddr "$i" 2>/dev/null)" || true
    if [ -n "${ip:-}" ]; then echo "$ip"; return; fi
  done
  echo ""
}
IP="$(lan_ip)"

# ── The web app imports @kason/shared's built dist, not its source ──────────
if [ ! -f packages/shared/dist/index.js ]; then
  echo "▸ @kason/shared is not built yet — building it first…"
  npx turbo run build --filter=@kason/shared
fi

# ── Preflight: don't fight whatever is already running ──────────────────────
# Running this next to a plain `npm run dev` is the normal case, so handle it
# instead of starting a doomed second copy. A second API just dies on
# EADDRINUSE *in the background*, which otherwise prints a scary stack trace
# under a banner that claims everything is fine.
port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

REUSE_API=0
if port_in_use "$API_PORT"; then
  REUSE_API=1
  echo "▸ an API is already listening on :${API_PORT} — reusing it, not starting a second."
fi

if port_in_use "$WEB_PORT"; then
  echo "" >&2
  echo "✖ Port ${WEB_PORT} is already taken — most likely a plain \`npm run dev\`." >&2
  echo "  That server is bound to loopback only, so other PCs cannot reach it." >&2
  echo "" >&2
  echo "  Stop it (Ctrl-C in its terminal), then re-run this script:" >&2
  echo "      npm run dev:lan" >&2
  echo "" >&2
  echo "  …or run this one alongside it on another port:" >&2
  echo "      WEB_PORT=5174 npm run dev:lan" >&2
  echo "" >&2
  exit 1
fi

# ── Start the servers; Ctrl-C takes down whatever we started ────────────────
pids=()
cleanup() {
  trap - INT TERM EXIT
  echo ""
  echo "▸ stopping dev servers…"
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# PORT is the API's own knob (runtime-config.ts reads process.env.PORT), so it
# is set ONLY on the API process — exporting it globally would also be picked
# up by anything else started from this shell.
if [ "$REUSE_API" -eq 0 ]; then
  echo "▸ API   → http://localhost:${API_PORT} (not exposed to the LAN)"
  PORT="$API_PORT" npm run dev --workspace @kason/api &
  pids+=("$!")
fi

# --host 0.0.0.0 is the whole trick: without it Vite binds to loopback only and
# other machines get "connection refused".
# VITE_DEV_API_TARGET keeps the proxy pointed at the API when API_PORT is custom.
echo "▸ web   → binding 0.0.0.0:${WEB_PORT}"
VITE_DEV_API_TARGET="http://localhost:${API_PORT}" \
  npm run dev --workspace @kason/web -- --host 0.0.0.0 --port "$WEB_PORT" &
pids+=("$!")

sleep 3
echo ""
echo "────────────────────────────────────────────────────────────────"
echo "  Kason-Hub dev — open on any device on this Wi-Fi"
echo "────────────────────────────────────────────────────────────────"
echo "  This Mac  :  http://localhost:${WEB_PORT}"
if [ -n "$IP" ]; then
  echo "  Other PC  :  http://${IP}:${WEB_PORT}"
else
  echo "  Other PC  :  LAN IP not detected — run: ipconfig getifaddr en0"
fi
echo ""
echo "  The API stays private on localhost:${API_PORT}; Vite proxies to it."
echo "  First run may raise a macOS firewall prompt — click Allow."
echo "  Ctrl-C stops both."
echo "────────────────────────────────────────────────────────────────"
echo ""

wait
