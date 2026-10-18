#!/bin/sh
# Configures this machine to report to a cession server: checks the URL and dependencies, logs the
# machine in (device login) when it has no token, checks the token, then merges the hook and OTel
# settings into ~/.claude/settings.json. Never prints the token.
#
# Usage: setup.sh URL [--yes]
# Exit:  0 done · 1 error (message on stderr) · 3 existing OTel settings differ; rerun with --yes to replace them
set -eu
here=$(cd "$(dirname "$0")" && pwd)
url=${1:-}
url=${url%/}
yes=${2:-}

fail() { echo "cession: $*" >&2; exit 1; }

# The URL is used in shell commands and must not send the token over plain http.
printf '%s' "$url" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$|^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$' ||
  fail "usage: setup.sh https://cession.<you>.workers.dev — the URL must be https (http only for localhost) and contain no unusual characters"

for dep in jq curl; do
  command -v "$dep" >/dev/null 2>&1 || fail "$dep is missing; install it (e.g. brew install $dep) and run setup again"
done

token_file="${XDG_CONFIG_HOME:-$HOME/.config}/cession/token"
token() { printf '%s' "${CESSION_TOKEN:-$(cat "$token_file" 2>/dev/null)}"; }
# 400 means the server knows the token and rejected only the empty event.
check() {
  printf 'header = "Authorization: Bearer %s"\n' "$(token)" |
    curl -s -o /dev/null -w '%{http_code}' --max-time 15 -K - -X POST "$url/events" -H 'Content-Type: application/json' -d '{}'
}

# Machine tokens are cs_ + base64url; anything else could smuggle options into curl's -K config.
case "$(token)" in *[!A-Za-z0-9_-]*) fail "the token has unexpected characters; create a new one on the Devices page" ;; esac

[ -n "$(token)" ] || sh "$here/login.sh" "$url"
code=$(check) || code=000
if [ "$code" = 401 ] && [ -z "${CESSION_TOKEN:-}" ]; then
  echo "The saved token was rejected (revoked?); logging this machine in again."
  sh "$here/login.sh" "$url"
  code=$(check) || code=000
fi
case "$code" in
  400) echo "Token accepted by $url" ;;
  401) fail "CESSION_TOKEN is set but $url rejects it; update or unset CESSION_TOKEN and run setup again" ;;
  *) fail "$url answered $code; check the URL and that the server is deployed" ;;
esac

f="$HOME/.claude/settings.json"
mkdir -p "$HOME/.claude"
[ -f "$f" ] || echo '{}' > "$f"
jq -e . "$f" >/dev/null 2>&1 || fail "$f is not valid JSON; nothing changed"

# Builds the OTel auth header at runtime from the same token source, so settings.json holds no secret.
# shellcheck disable=SC2016 # expanded later by the helper's own shell, not here
helper='sh -c '\''t=${CESSION_TOKEN:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/cession/token" 2>/dev/null)}; printf "%s\n" "$t" | jq -Rc "{Authorization: (\"Bearer \" + .)}"'\'''

# Existing OTel settings that this setup would change; header values are never shown.
differs=$(jq -r --arg u "$url" --arg helper "$helper" '
  {OTEL_METRICS_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: ($u + "/v1/metrics")} as $want
  | ((.env // {}) | to_entries[] | select(.key | startswith("OTEL_")) | select($want[.key] != .value)
      | if (.key | test("HEADERS")) then "\(.key)=<redacted>" else "\(.key)=\(.value)" end),
    (.otelHeadersHelper // empty | select(. != $helper) | "otelHeadersHelper=\(.)")' "$f")
if [ -n "$differs" ] && [ "$yes" != "--yes" ]; then
  echo "These existing settings in $f would be replaced:"
  printf '%s\n' "$differs"
  exit 3
fi

cp "$f" "$f.bak"
jq --arg url "$url" --arg helper "$helper" '
  .env = ((.env // {}) | del(.CESSION_TOKEN, .OTEL_EXPORTER_OTLP_METRICS_HEADERS)) + {
    CESSION_URL: $url,
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: ($url + "/v1/metrics")
  }
  | .otelHeadersHelper = $helper' "$f" > "$f.tmp" && cat "$f.tmp" > "$f" && rm -f "$f.tmp"

echo "Done. Settings written to $f (backup at $f.bak, which may hold a token from an older setup; delete it once things work)."
echo "Restart Claude Code for the change to apply. Set CESSION_MACHINE in the same env block to rename this machine (default: hostname -s)."
