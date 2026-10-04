#!/usr/bin/env bash
# Browser-native host smoke: loads the CURRENT root build of Crosswalker
# (main.js, manifest.json, styles.css) into OpenClast's shimmed Obsidian in
# headless Chromium and checks that the search index persists across a tab
# reload. Starts OpenClast's own static server unmodified; writes nothing into
# the OpenClast checkout.
#
#   OPENCLAST_REPO  OpenClast checkout (default: ../../obsidian-in-the-browser
#                   relative to this repo's root)
#   OPENCLAST_OUT   where report.json, console-raw.log and screenshots go
#                   (default: test-screenshots/openclast, gitignored)
#   OC_PORT         server port (default 8712, OpenClast's server default)
#
# Build first: `bun run build` (the probe reads the root main.js).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
OC_REPO="${OPENCLAST_REPO:-$REPO_ROOT/../../obsidian-in-the-browser}"
OC_DIR="$OC_REPO/experimental/browser-native"
OUT="${OPENCLAST_OUT:-$REPO_ROOT/test-screenshots/openclast}"
PORT="${OC_PORT:-8712}"

if [ ! -f "$OC_DIR/server.mjs" ]; then
  echo "OpenClast not found at $OC_DIR. Set OPENCLAST_REPO to the OpenClast checkout." >&2
  exit 2
fi
if [ ! -f "$REPO_ROOT/main.js" ]; then
  echo "No root main.js. Run 'bun run build' first." >&2
  exit 2
fi
mkdir -p "$OUT"

cd "$OC_DIR" || exit 2
OC_BROWSER_NATIVE_PORT="$PORT" node server.mjs > "$OUT/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT
for _ in $(seq 1 30); do
  sleep 0.2
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/" && break
done
kill -0 "$SERVER_PID" 2>/dev/null || { echo "OpenClast server failed to start" >&2; cat "$OUT/server.log" >&2; exit 2; }

OC_DIR="$OC_DIR" CW_ROOT="$REPO_ROOT" OUT_DIR="$OUT" OC_URL="http://127.0.0.1:$PORT/" \
  node "$HERE/cw-probe.mjs"
