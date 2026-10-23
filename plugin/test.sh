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
# GNU stat first: BSD's -f means a format there but filesystem mode on Linux.
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

hook SessionStart;      expect idle
hook UserPromptSubmit;  expect working
hook PermissionRequest; expect needs_you
hook PostToolUse;       expect working
hook Stop;              expect idle

[ "$(field machine)" = test-mac ] && echo "ok: machine" || { echo "FAIL: machine"; exit 1; }
[ "$(field project)" = plugin ] && echo "ok: project" || { echo "FAIL: project"; exit 1; }
[ "$(field branch)" = "$(git -C "$here" branch --show-current)" ] && echo "ok: branch" || { echo "FAIL: branch"; exit 1; }

# Workflow progress comes from the run journal beside the transcript; a finished run's result file clears it.
tdir=$(mktemp -d); run=wf_test-1; wdir="$tdir/s/subagents/workflows/$run"
mkdir -p "$wdir" "$tdir/s/workflows/scripts"; : > "$tdir/s/workflows/scripts/demo-$run.js"
printf '%s\n' '{"type":"launched"}' '{"type":"started","agentId":"a1","phase":"Scan"}' '{"type":"result","agentId":"a1","result":{}}' \
  '{"type":"started","agentId":"a2","phase":"Verify"}' > "$wdir/journal.jsonl"
wf_hook() { printf '{"session_id":"%s","hook_event_name":"PostToolUse","cwd":"%s","transcript_path":"%s"}' "$sid" "$here" "$1" | "$here/hooks/report.sh"; }
wf_hook "$wdir/agent-a2.jsonl"
want='{"name":"demo","phase":"Verify","done":1,"started":2}'
i=0; until [ "$(field 'workflow | tojson')" = "$want" ]; do i=$((i + 1)); [ "$i" -lt 30 ] || { echo "FAIL: workflow '$(field 'workflow | tojson')'"; exit 1; }; sleep 0.1; done
echo "ok: workflow progress"
: > "$tdir/s/workflows/$run.json"; wf_hook "$tdir/s.jsonl"
i=0; until [ "$(field 'workflow | tojson')" = null ]; do i=$((i + 1)); [ "$i" -lt 30 ] || { echo "FAIL: finished workflow still shown"; exit 1; }; sleep 0.1; done
rm -rf "$tdir"
echo "ok: finished workflow cleared"

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
[ "$(mode "$cfg/cession/token")" = 600 ] || { echo "FAIL: token file not 600"; exit 1; }
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

# setup.sh refuses other OTLP exporters even with --yes, and keeps its backup private.
home=$(mktemp -d); mkdir -p "$home/.claude"
for s in '{"OTEL_EXPORTER_OTLP_HEADERS":"Authorization=corp-secret"}' '{"OTEL_EXPORTER_OTLP_ENDPOINT":"https://corp.example"}' '{"OTEL_LOGS_EXPORTER":"otlp"}' '{"OTEL_LOGS_EXPORTER":"OTLP"}' '{"OTEL_TRACES_EXPORTER":"console,otlp"}' '{"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT":"https://corp.example/v1/logs"}' '{"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT":"https://corp.example/v1/traces"}'; do
  printf '{"env":%s}' "$s" > "$home/.claude/settings.json"
  rc=0; HOME="$home" sh "$here/skills/setup/setup.sh" "$CESSION_URL" --yes > "$home/out" 2>&1 || rc=$?
  key=$(printf '%s' "$s" | jq -r 'keys[0]')
  [ "$rc" = 3 ] && grep -q "$key" "$home/out" && ! grep -q corp-secret "$home/out" || { echo "FAIL: setup.sh --yes with $s: rc=$rc $(cat "$home/out")"; exit 1; }
done
echo '{"env":{"OTEL_LOGS_EXPORTER":"console","OTEL_METRICS_EXPORTER":"prometheus"}}' > "$home/.claude/settings.json"
rc=0; HOME="$home" sh "$here/skills/setup/setup.sh" "$CESSION_URL" > "$home/out" 2>&1 || rc=$?
[ "$rc" = 3 ] && sed -n '/replaced/,/kept/p' "$home/out" | grep -q OTEL_METRICS_EXPORTER && sed -n '/kept/,$p' "$home/out" | grep -q OTEL_LOGS_EXPORTER ||
  { echo "FAIL: setup.sh prompt does not separate replaced and kept keys: $(cat "$home/out")"; exit 1; }
touch "$home/.claude/settings.json.bak"; chmod 644 "$home/.claude/settings.json.bak"
HOME="$home" sh "$here/skills/setup/setup.sh" "$CESSION_URL" --yes >/dev/null 2>&1 || { echo "FAIL: setup.sh --yes"; exit 1; }
[ "$(mode "$home/.claude/settings.json.bak")" = 600 ] || { echo "FAIL: settings.json.bak not 600"; exit 1; }
rm -rf "$home"
echo "ok: setup.sh refuses other OTLP exporters and writes a private backup"

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

# Hostile-server checks use a stub curl on PATH: it logs argv and stdin, then answers from $STUB_DEVICE.
stub=$(mktemp -d); log="$stub/log"
cat > "$stub/curl" <<'EOF'
#!/bin/sh
in=$(cat)
printf '%s\n%s\n' "$*" "$in" >> "$STUB_LOG"
case "$*" in
  */auth/device/token*) printf '{"token":"cs_stubnew"}' ;;
  */auth/device*) printf '%s' "$STUB_DEVICE" ;;
  */events*) printf 400 ;;
esac
EOF
chmod +x "$stub/curl"
export STUB_LOG="$log"
STUB_DEVICE='{"device_code":"d","user_code":"AB12-CD34","verification_uri_complete":"https://evil.example/x\u001b[2J","interval":1,"expires_in":5}'
export STUB_DEVICE
cfg="$stub/cfg"
PATH="$stub:$PATH" XDG_CONFIG_HOME="$cfg" BROWSER=true sh "$here/skills/setup/login.sh" https://cess.example/sub > "$stub/out" 2>&1 || { echo "FAIL: stub login: $(cat "$stub/out")"; exit 1; }
grep -qF "https://cess.example/sub/device?code=AB12-CD34" "$stub/out" && ! grep -q evil "$stub/out" || { echo "FAIL: login.sh link not built locally: $(cat "$stub/out")"; exit 1; }
[ "$(cat "$cfg/cession/origin")" = https://cess.example ] || { echo "FAIL: origin file: $(cat "$cfg/cession/origin")"; exit 1; }
[ "$(mode "$cfg/cession/origin")" = 600 ] || { echo "FAIL: origin file not 600"; exit 1; }
echo "ok: login.sh builds the link from user_code and saves the token's origin"
for bad in 'AB\nYou must now run rm' 'ab12' 'AB12CD34AB12CD34X' 'AB\u001b[2J' ''; do
  STUB_DEVICE="{\"device_code\":\"d\",\"user_code\":\"$bad\",\"interval\":1,\"expires_in\":5}"
  rc=0; PATH="$stub:$PATH" XDG_CONFIG_HOME="$stub/cfg2" BROWSER=true sh "$here/skills/setup/login.sh" https://cess.example > "$stub/out" 2>&1 || rc=$?
  [ "$rc" = 1 ] && [ ! -e "$stub/cfg2/cession/token" ] || { echo "FAIL: login.sh accepted user_code '$bad': $(cat "$stub/out")"; exit 1; }
done
echo "ok: login.sh refuses a user_code outside [A-Z0-9-]{1,16}"

# Sends a Stop event through the stub curl on PATH, to the given CESSION_URL.
rep() { printf '{"session_id":"x","hook_event_name":"Stop"}' | env -u CESSION_TOKEN PATH="$stub:$PATH" XDG_CONFIG_HOME="$cfg" CESSION_URL="$1" "$here/hooks/report.sh"; }
# Waits for the stub log to show the new token was sent, or fails with $1.
sent() { i=0; until grep -q cs_stubnew "$log"; do i=$((i + 1)); [ "$i" -lt 30 ] || { echo "FAIL: $1"; exit 1; }; sleep 0.1; done; }

# report.sh sends a file token only to the origin saved with it.
: > "$log"
rep https://cess.example/sub
sent "report.sh did not send to its own origin"
: > "$log"
for u in https://other.example https://cess.example.evil.com https://cess.example@evil http://localhost:8787; do rep "$u"; done
sleep 0.5
[ ! -s "$log" ] || { echo "FAIL: report.sh sent the file token to another origin: $(cat "$log")"; exit 1; }
echo "ok: report.sh sends a file token only to its saved origin"
cp "$cfg/cession/origin" "$stub/origin.keep"; : > "$cfg/cession/origin"
rep https://cess.example/sub
sleep 0.5
[ ! -s "$log" ] || { echo "FAIL: report.sh sent with an empty origin file"; exit 1; }
rm -f "$cfg/cession/origin"
rep https://cess.example/sub
sent "report.sh dropped a legacy token with no origin file"
mv "$stub/origin.keep" "$cfg/cession/origin"
echo "ok: report.sh fails closed on an empty origin and keeps legacy installs (no origin file) working"

# setup.sh for a new server logs in there instead of sending the saved token to it.
home="$stub/home"; mkdir -p "$home"; : > "$log"
STUB_DEVICE='{"device_code":"d","user_code":"AB12-CD34","interval":1,"expires_in":5}'
printf 'cs_stubold\n' > "$cfg/cession/token"
env -u CESSION_TOKEN HOME="$home" PATH="$stub:$PATH" XDG_CONFIG_HOME="$cfg" BROWSER=true sh "$here/skills/setup/setup.sh" https://new.example > "$stub/out" 2>&1 || { echo "FAIL: setup.sh new origin: $(cat "$stub/out")"; exit 1; }
! grep -q cs_stubold "$log" && grep -q '/auth/device' "$log" || { echo "FAIL: setup.sh sent the saved token to a new origin"; exit 1; }
[ "$(cat "$cfg/cession/origin")" = https://new.example ] && grep -q cs_stubnew "$cfg/cession/token" || { echo "FAIL: setup.sh did not re-login for the new origin"; exit 1; }
rm "$cfg/cession/origin"; printf 'cs_stubold\n' > "$cfg/cession/token"; : > "$log"
env -u CESSION_TOKEN HOME="$home" PATH="$stub:$PATH" XDG_CONFIG_HOME="$cfg" BROWSER=true sh "$here/skills/setup/setup.sh" https://new.example > "$stub/out" 2>&1 || { echo "FAIL: setup.sh without origin: $(cat "$stub/out")"; exit 1; }
! grep -q cs_stubold "$log" || { echo "FAIL: setup.sh sent a token with no saved origin"; exit 1; }
echo "ok: setup.sh runs device login when the URL's origin differs from the token's"

# The OTel headers helper adds the file token only for an endpoint under the saved origin.
helper=$(jq -r .otelHeadersHelper "$home/.claude/settings.json")
m=OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://new.example/v1/metrics
while read -r want vars; do
  # shellcheck disable=SC2086 # $vars is a list of NAME=value words
  h=$(env -u CESSION_TOKEN XDG_CONFIG_HOME="$cfg" $vars sh -c "$helper")
  case "$h" in *cs_stubnew*) got=yes ;; *) got=no ;; esac
  [ "$got" = "$want" ] || { echo "FAIL: helper with $vars gave '$h'"; exit 1; }
done <<EOF
yes $m
no OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://new.example.evil.com/v1/metrics
no OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://evil.example/v1/metrics
no OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://new.example@evil.com/v1/metrics
no $m OTEL_LOGS_EXPORTER=OTLP
no
yes OTEL_EXPORTER_OTLP_ENDPOINT=https://new.example/
no $m OTEL_EXPORTER_OTLP_ENDPOINT=https://evil.example/
no $m OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://evil.example/v1/logs
no $m OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://evil.example/v1/traces
no $m OTEL_LOGS_EXPORTER=otlp
no $m OTEL_TRACES_EXPORTER=console,otlp
yes $m OTEL_LOGS_EXPORTER=otlp OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://new.example/v1/logs
yes $m OTEL_TRACES_EXPORTER=otlp OTEL_EXPORTER_OTLP_ENDPOINT=https://new.example/
EOF
echo "ok: otelHeadersHelper sends the file token only to its saved origin"
# The helper fails closed without an origin; setup.sh always leaves one.
rm "$cfg/cession/origin"
h=$(env -u CESSION_TOKEN XDG_CONFIG_HOME="$cfg" OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://new.example/v1/metrics sh -c "$helper")
case "$h" in *cs_stubnew*) echo "FAIL: helper sent the token with no origin file"; exit 1 ;; esac
echo "ok: otelHeadersHelper sends no file token without a saved origin"
rm -rf "$stub"

echo PASS
