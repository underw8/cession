#!/bin/sh
# Device login, like `gh auth login`: asks the cession server for a code, opens the approval page,
# waits for the owner to approve it in a signed-in browser, then saves the machine token.
# Prints only the link, the code and the outcome; the token goes straight to the file.
# Usage: login.sh URL [machine-name]
set -eu
url=${1%/}
name=${2:-${CESSION_MACHINE:-$(hostname -s)}}
dir="${XDG_CONFIG_HOME:-$HOME/.config}/cession"

# The token must not cross plain http; localhost is for dev.
case "$url" in
  https://* | http://localhost | http://localhost:* | http://localhost/* | http://127.0.0.1 | http://127.0.0.1:* | http://127.0.0.1/*) ;;
  *) echo "cession: $url must be https" >&2; exit 1 ;;
esac

res=$(jq -nc --arg n "$name" '{name: $n}' | curl -sf --max-time 10 -X POST "$url/auth/device" -H 'Content-Type: application/json' -d @-) ||
  { echo "cession: could not start a login at $url" >&2; exit 1; }
field() { printf '%s' "$res" | jq -r ".$1"; }
device=$(field device_code)
code=$(field user_code)
interval=$(field interval)
expires=$(field expires_in)
# Server values reach $(( )), the terminal and Claude's context; sh evaluates a[$(cmd)] in arithmetic, so only digits pass.
case "$interval" in '' | *[!0-9]* | 0*) interval=3 ;; esac
case "$expires" in '' | *[!0-9]*) expires=600 ;; esac
[ "$interval" -le 30 ] 2>/dev/null || interval=3
[ "$expires" -le 900 ] 2>/dev/null || expires=900
# Explicit letters, not A-Z: bash 3.2 matches ranges by locale collation.
case "$code" in *[!ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-]*) code= ;; esac
[ -n "$code" ] && [ ${#code} -le 16 ] || { echo "cession: the server returned a malformed code; nothing saved" >&2; exit 1; }
link="$url/device?code=$code"

printf 'Approve "%s" in a browser signed in to cession:\n' "$name"
printf '  %s\n' "$link"
printf '  code: %s\n' "$code"
# $BROWSER first: code-server sets it to open tabs on the client machine.
for open in "${BROWSER:-}" open xdg-open; do
  if [ -n "$open" ] && command -v "$open" >/dev/null 2>&1; then "$open" "$link" >/dev/null 2>&1 & break; fi
done

deadline=$(( $(date +%s) + expires ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep "$interval"
  # The device code goes on stdin, not argv.
  out=$(printf '{"device_code":"%s"}' "$device" | curl -s --max-time 10 -X POST "$url/auth/device/token" -H 'Content-Type: application/json' -d @-) || continue
  token=$(printf '%s' "$out" | jq -r '.token // empty' 2>/dev/null) || token=""
  if [ -n "$token" ]; then
    # Machine tokens are cs_ + base64url; anything else could smuggle options into curl's -K config later.
    case "$token" in *[!A-Za-z0-9_-]*) echo "cession: the server returned a malformed token; nothing saved" >&2; exit 1 ;; esac
    # The origin binds the token: report.sh and the OTel helper send it nowhere else.
    # setup.sh passes the origin it already computed via $CESSION_ORIGIN; a standalone run computes it here.
    origin=${CESSION_ORIGIN:-}
    [ -n "$origin" ] || { rest=${url#*://}; origin="${url%%://*}://${rest%%/*}"; }
    # Origin emptied first: until the new one lands, an empty origin file makes everything send nothing.
    (umask 077 && mkdir -p "$dir" && : > "$dir/origin" && printf '%s\n' "$token" > "$dir/token.tmp" && mv "$dir/token.tmp" "$dir/token" &&
      printf '%s\n' "$origin" > "$dir/origin.tmp" && mv "$dir/origin.tmp" "$dir/origin")
    echo "Approved. Token saved to $dir/token"
    exit 0
  fi
  [ "$(printf '%s' "$out" | jq -r '.error // empty' 2>/dev/null)" = "expired_token" ] &&
    { echo "cession: the code expired or was already used; run setup again" >&2; exit 1; }
done
echo "cession: timed out waiting for approval; run setup again" >&2
exit 1
