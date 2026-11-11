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
stub_pid=
cleanup() {
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  if [ -n "$stub_pid" ]; then kill "$stub_pid" 2>/dev/null || true; wait "$stub_pid" 2>/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT
mkdir -p "$scratch/home/.config/corral" "$scratch/data" "$scratch/bin" "$scratch/gh"
# Do not let the periodic pull refresh consult the user's GitHub account.
printf '#!/bin/sh\nexit 1\n' > "$scratch/bin/gh"
chmod +x "$scratch/bin/gh"
# Pages that read the harness catalog (benchmarks) can point at a synthetic
# catalog instead of the unreachable backend: CORRAL_FIXTURE_HARNESSES=1.
omnigent_url=http://127.0.0.1:1
if [ "${CORRAL_FIXTURE_HARNESSES:-}" = "1" ]; then
  stub_port=$(node -e 'const s=require("node:net").createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port); s.close()})')
  node "$fixture_root/scripts/omnigent-stub.ts" "$stub_port" > "$scratch/stub.log" 2>&1 &
  stub_pid=$!
  for _ in {1..100}; do
    if curl -fs "http://127.0.0.1:$stub_port/v1/agents" > /dev/null; then break; fi
    if ! kill -0 "$stub_pid" 2>/dev/null; then cat "$scratch/stub.log" >&2; exit 1; fi
    sleep 0.1
  done
  omnigent_url="http://127.0.0.1:$stub_port"
fi
printf '{"omnigent":{"baseUrl":"%s"},"workspaceRoots":[]}\n' "$omnigent_url" > "$scratch/home/.config/corral/config.json"
node "$fixture_root/scripts/screenshot-fixture.ts" "$scratch/data/corral.db" "$scratch/home/.config/corral/config.json"
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
# Wait for the page's own post-mount fetches before capturing (the benchmark
# matrix waits for the harness catalog). Pages without data settle immediately.
case "$route" in
  /benchmarks*) settle="!document.body.innerText.includes('Loading models from your harnesses')" ;;
  *) settle="true" ;;
esac
settle=${CORRAL_FIXTURE_SETTLE:-$settle}
node "$fixture_root/scripts/screenshot-page.ts" "$chrome" \
  "http://127.0.0.1:$port/?token=screenshot-fixture#$route" "$output" "$settle"
test -s "$output"
echo "Saved $output"
