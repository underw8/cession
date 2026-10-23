#!/bin/sh
# Posts this hook event to cession. Must never block, print, or fail: curl runs detached, token stays out of argv.
# The token comes from the environment, or from a file for hosts whose Claude Code never reads
# the shell profile (code-server, apps launched from the Dock).
token=${CESSION_TOKEN:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/cession/token" 2>/dev/null)}
[ -n "${CESSION_URL:-}" ] && [ -n "$token" ] || exit 0
# A file token goes only to the origin login.sh saved with it; no origin file means an install from before origins.
origin_file="${XDG_CONFIG_HOME:-$HOME/.config}/cession/origin"
if [ -z "${CESSION_TOKEN:-}" ] && [ -e "$origin_file" ]; then
  origin=$(cat "$origin_file" 2>/dev/null) && [ -n "$origin" ] || exit 0
  rest=${CESSION_URL#*://}
  [ "${CESSION_URL%%://*}://${rest%%/*}" = "$origin" ] || exit 0
fi
# Machine tokens are cs_ + base64url. Anything else could smuggle options into curl's -K config.
case "$token" in *[!A-Za-z0-9_-]*) exit 0 ;; esac
# The token never crosses plain http; localhost is for dev. No userinfo, or curl's host isn't the one checked here.
case "$CESSION_URL" in *@*) exit 0 ;; esac
case "$CESSION_URL" in
  https://*) ;;
  http://localhost* | http://127.0.0.1*)
    rest=${CESSION_URL#http://localhost}
    [ "$rest" = "$CESSION_URL" ] && rest=${CESSION_URL#http://127.0.0.1}
    # Host must be followed by nothing, or :<digits>, before any /.
    case "${rest%%/*}" in
      "") ;;
      : | :*[!0-9]*) exit 0 ;;
      :*) ;;
      *) exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
command -v jq >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 || exit 0

# Only these fields leave the machine (plus workflow name, phase and agent counts); prompt text and
# tool input are dropped here. transcript_path is used locally, then removed before sending.
# ts is taken now, before backgrounding, so it orders events as they happened.
body=$(jq -c --arg machine "${CESSION_MACHINE:-$(hostname -s)}" \
  '{session_id, event: .hook_event_name, cwd, machine: $machine, branch: null, ts: (now * 1000 | floor), workflow: null, transcript_path}' 2>/dev/null) || exit 0

# git can hang on a network or FUSE cwd, so it runs in the background with curl.
(
  trap '' HUP
  cwd=$(printf '%s' "$body" | jq -r '.cwd // empty')
  branch=""
  [ -n "$cwd" ] && branch=$(git -C "$cwd" branch --show-current 2>/dev/null || true)
  [ -n "$branch" ] && body=$(printf '%s' "$body" | jq -c --arg branch "$branch" '.branch = $branch')
  # A workflow run journals agents under <session>/subagents/workflows/<run>/ and writes
  # <session>/workflows/<run>.json once it finishes. Subagent hooks may pass their own transcript path.
  # ponytail: a run killed before writing its result keeps showing until the next run or session end.
  dir=$(printf '%s' "$body" | jq -r '.transcript_path // empty')
  dir=${dir%%/subagents/*}; dir=${dir%.jsonl}
  journal=$(ls -t "$dir"/subagents/workflows/*/journal.jsonl 2>/dev/null | head -n 1)
  run=$(basename "$(dirname "$journal")")
  if [ -n "$dir" ] && [ -n "$journal" ] && [ ! -e "$dir/workflows/$run.json" ]; then
    script=$(ls "$dir"/workflows/scripts/*-"$run".js 2>/dev/null | head -n 1)
    name=$(basename "$script" "-$run.js")
    started=$(grep -c '^{"type":"started"' "$journal")
    finished=$(( $(grep -c '"agentId"' "$journal") - started ))
    phase=$(grep '^{"type":"started"' "$journal" | tail -n 1 | jq -r '.phase // empty')
    body=$(printf '%s' "$body" | jq -c --arg name "$name" --arg phase "$phase" --argjson done "$finished" --argjson started "$started" \
      '.workflow = {name: (if $name == "" then null else $name end), phase: (if $phase == "" then null else $phase end), $done, $started}')
  fi
  body=$(printf '%s' "$body" | jq -c 'del(.transcript_path)')
  printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl -s -o /dev/null --max-time 2 -K - -X POST "${CESSION_URL%/}/events" \
      -H "Content-Type: application/json" -d "$body"
) </dev/null >/dev/null 2>&1 &
exit 0
