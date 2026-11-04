#!/bin/bash
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "Usage: $0 <built-checkout> <output.png> [hash-route]" >&2
  exit 2
fi
fixture_root=$(cd "$(dirname "$0")/.." && pwd)
checkout=$(cd "$1" && pwd)
output=$2
route=${3:-/tasks}
chrome=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
if [ ! -f "$checkout/web/dist/index.html" ] || [ ! -x "$chrome" ]; then
  echo "Build the checkout first and set CHROME to a Chrome/Chromium executable." >&2
  exit 1
fi
case "$output" in /*) ;; *) echo "Use an absolute output path outside the checkout." >&2; exit 2;; esac
if [ -e "$output" ]; then echo "Output already exists: $output" >&2; exit 2; fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/corral-screenshot.XXXXXX")
server_pid=
cleanup() {
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT
mkdir -p "$scratch/home/.config/corral" "$scratch/data" "$scratch/bin" "$scratch/gh"
# Do not let the periodic pull refresh consult the user's GitHub account.
printf '#!/bin/sh\nexit 1\n' > "$scratch/bin/gh"
chmod +x "$scratch/bin/gh"
printf '%s\n' '{"omnigent":{"baseUrl":"http://127.0.0.1:1"},"workspaceRoots":[]}' > "$scratch/home/.config/corral/config.json"
node "$fixture_root/scripts/screenshot-fixture.ts" "$scratch/data/corral.db"
port=$(node -e 'const s=require("node:net").createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port); s.close()})')
cd "$checkout"
env -i HOME="$scratch/home" PATH="$scratch/bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v node)")" \
  GH_CONFIG_DIR="$scratch/gh" CORRAL_DATA_DIR="$scratch/data" CORRAL_PORT="$port" \
  CORRAL_HOST=127.0.0.1 CORRAL_TOKEN=screenshot-fixture \
  "$(command -v node)" "$checkout/server/index.ts" > "$scratch/server.log" 2>&1 &
server_pid=$!
ready=false
for _ in {1..100}; do
  if ! kill -0 "$server_pid" 2>/dev/null; then cat "$scratch/server.log" >&2; exit 1; fi
  if curl -fs -H 'Authorization: Bearer screenshot-fixture' "http://127.0.0.1:$port/api/tasks" > "$scratch/tasks.json"; then ready=true; break; fi
  sleep 0.1
done
if [ "$ready" != true ] || ! grep -q 'sample-open' "$scratch/tasks.json"; then
  cat "$scratch/server.log" >&2
  echo "Fixture server did not become ready." >&2
  exit 1
fi
"$chrome" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --user-data-dir="$scratch/browser" --window-size=1440,1000 --timeout=10000 \
  --screenshot="$output" "http://127.0.0.1:$port/?token=screenshot-fixture#$route"
test -s "$output"
echo "Saved $output"
