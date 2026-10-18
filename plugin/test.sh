#!/bin/sh
# Integration test for hooks/report.sh. Needs `npm run dev` running in server/ (its DEV_SKIP_AUTH bypass is baked into the script, no .dev.vars needed).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# Always local: the user's shell exports the production CESSION_URL/CESSION_TOKEN.
export CESSION_URL=http://localhost:8787 CESSION_MACHINE=test-mac
curl -s -o /dev/null --max-time 2 "$CESSION_URL/" || { echo "FAIL: no server on $CESSION_URL; run \`make dev\` first"; exit 1; }
# DEV_SKIP_AUTH=1 makes this unauthenticated POST a browser session, same as a signed-in owner minting a token.
export CESSION_TOKEN=$(curl -s -X POST "$CESSION_URL/api/machines" -H 'Content-Type: application/json' -d '{"name":"plugin-test"}' | jq -r .token)
sid="plugin-test-$(date +%s)-$$"

hook() { printf '{"session_id":"%s","hook_event_name":"%s","cwd":"%s","prompt":"secret prompt"}' "$sid" "$1" "$here" | "$here/hooks/report.sh"; }
# Prints "unreachable" on a failed or non-2xx read, so no expected value can match it.
field() {
  json=$(curl -sf "$CESSION_URL/api/sessions") || { echo unreachable; return; }
  printf '%s' "$json" | jq -r --arg id "$sid" ".sessions[] | select(.id == \$id) | .$1 // \"\""
}
expect() {
  i=0
  while [ "$(field status)" != "$1" ]; do
    i=$((i + 1)); [ "$i" -lt 30 ] || { echo "FAIL: expected status $1, got '$(field status)'"; exit 1; }
    sleep 0.1
  done
  echo "ok: ${1:-gone from the live view}"
}

hook SessionStart;      expect idle
hook UserPromptSubmit;  expect working
hook PermissionRequest; expect needs_you
hook PostToolUse;       expect working
hook Stop;              expect idle

[ "$(field machine)" = test-mac ] && echo "ok: machine" || { echo "FAIL: machine"; exit 1; }
[ "$(field project)" = plugin ] && echo "ok: project" || { echo "FAIL: project"; exit 1; }
[ "$(field branch)" = "$(git -C "$here" branch --show-current)" ] && echo "ok: branch" || { echo "FAIL: branch"; exit 1; }

hook SessionEnd;        expect ""

# Token file fallback, for hosts whose Claude Code never reads the shell profile.
cfg=$(mktemp -d); mkdir "$cfg/cession"; printf '%s\n' "$CESSION_TOKEN" > "$cfg/cession/token"
sid="$sid-file"
printf '{"session_id":"%s","hook_event_name":"SessionStart","cwd":"%s"}' "$sid" "$here" |
  env -u CESSION_TOKEN XDG_CONFIG_HOME="$cfg" "$here/hooks/report.sh"
rm -rf "$cfg"
expect idle
echo "ok: token read from \$XDG_CONFIG_HOME/cession/token when CESSION_TOKEN is unset"

# Device login: login.sh waits while the owner approves its code, then writes the token file.
cfg=$(mktemp -d); out="$cfg/login.out"
XDG_CONFIG_HOME="$cfg" BROWSER=true sh "$here/skills/setup/login.sh" "$CESSION_URL" "plugin-test-login" > "$out" 2>&1 &
login=$!
i=0; until grep -q "code:" "$out"; do i=$((i + 1)); [ "$i" -lt 50 ] || { echo "FAIL: login.sh printed no code: $(cat "$out")"; exit 1; }; sleep 0.1; done
code=$(sed -n 's/.*code: //p' "$out")
# DEV_SKIP_AUTH makes this a signed-in browser approving the code.
curl -sf -o /dev/null -X POST "$CESSION_URL/api/device/approve" -H 'Content-Type: application/json' -d "{\"code\":\"$code\"}" || { echo "FAIL: approve"; exit 1; }
wait "$login" || { echo "FAIL: login.sh: $(cat "$out")"; exit 1; }
grep -q "$CESSION_TOKEN" "$cfg/cession/token" && { echo "FAIL: login wrote the old token"; exit 1; }
# GNU stat first: BSD's -f means a format there but filesystem mode on Linux.
[ "$(stat -c %a "$cfg/cession/token" 2>/dev/null || stat -f %Lp "$cfg/cession/token")" = 600 ] || { echo "FAIL: token file not 600"; exit 1; }
grep -q "$(cat "$cfg/cession/token")" "$out" && { echo "FAIL: login.sh printed the token"; exit 1; }
sid="$sid-login"
printf '{"session_id":"%s","hook_event_name":"SessionStart","cwd":"%s"}' "$sid" "$here" |
  env -u CESSION_TOKEN XDG_CONFIG_HOME="$cfg" "$here/hooks/report.sh"
expect idle
rm -rf "$cfg"
echo "ok: device login saves a private token that report.sh uses"

# setup.sh on a throwaway HOME: fresh merge, idempotent rerun, refusal to overwrite foreign OTel settings.
home=$(mktemp -d)
mkdir -p "$home/.claude" && echo '{"model":"keep-me"}' > "$home/.claude/settings.json"
HOME="$home" sh "$here/skills/setup/setup.sh" "$CESSION_URL" > "$home/out" 2>&1 || { echo "FAIL: setup.sh: $(cat "$home/out")"; exit 1; }
jq -e --arg u "$CESSION_URL" '.model == "keep-me" and .env.CESSION_URL == $u and .env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT == ($u + "/v1/metrics") and (.otelHeadersHelper | startswith("sh -c"))' "$home/.claude/settings.json" >/dev/null ||
  { echo "FAIL: setup.sh wrote unexpected settings"; exit 1; }
grep -q "$CESSION_TOKEN" "$home/.claude/settings.json" "$home/out" && { echo "FAIL: setup.sh leaked the token"; exit 1; }
HOME="$home" sh "$here/skills/setup/setup.sh" "$CESSION_URL" >/dev/null 2>&1 || { echo "FAIL: setup.sh rerun"; exit 1; }
jq '.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "https://other.example/v1/metrics"' "$home/.claude/settings.json" > "$home/s" && mv "$home/s" "$home/.claude/settings.json"
rc=0; HOME="$home" sh "$here/skills/setup/setup.sh" "$CESSION_URL" > "$home/out" 2>&1 || rc=$?
[ "$rc" = 3 ] && grep -q "other.example" "$home/out" || { echo "FAIL: setup.sh should stop with 3, got $rc"; exit 1; }
HOME="$home" sh "$here/skills/setup/setup.sh" "$CESSION_URL" --yes >/dev/null 2>&1 || { echo "FAIL: setup.sh --yes"; exit 1; }
jq -e --arg u "$CESSION_URL" '.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT == ($u + "/v1/metrics")' "$home/.claude/settings.json" >/dev/null || { echo "FAIL: --yes did not replace"; exit 1; }
rc=0; HOME="$home" sh "$here/skills/setup/setup.sh" "http://evil.example" >/dev/null 2>&1 || rc=$?
[ "$rc" = 1 ] || { echo "FAIL: setup.sh accepted plain http"; exit 1; }
rm -rf "$home"
echo "ok: setup.sh merges settings, keeps the token out, asks before replacing OTel settings"

# Runs report.sh with CESSION_URL=$2 and stdin $3; it must exit 0 at once and print nothing.
noop() {
  start=$(date +%s)
  if [ $# -ge 3 ]; then in=$3; else in='{"session_id":"x","hook_event_name":"Stop"}'; fi
  out=$(printf '%s' "$in" | CESSION_URL=$2 "$here/hooks/report.sh"; echo "rc=$?")
  [ "$out" = "rc=0" ] && [ $(( $(date +%s) - start )) -le 1 ] && echo "ok: $1" || { echo "FAIL: $1: $out"; exit 1; }
}
noop "black-holed server returns at once, silently" https://10.255.255.1
noop "plain-http remote is a silent no-op" http://example.com
for u in http://localhost:@evil.com http://127.0.0.1:80@evil.com; do noop "userinfo $u is a silent no-op" "$u"; done
noop "unconfigured is a silent no-op" "" "{}"
pwn=$(mktemp -u)
CESSION_TOKEN="x\"
output = \"$pwn" noop "a token that would inject curl config is refused" "$CESSION_URL"
[ ! -e "$pwn" ] || { echo "FAIL: curl config injection wrote $pwn"; exit 1; }
noop "garbage stdin is a silent no-op" "$CESSION_URL" "not json"
echo PASS
