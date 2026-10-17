---
name: setup
description: Configure this machine to report Claude Code sessions and cost to a cession server
disable-model-invocation: true
---

Configure cession on this machine. Arguments, if given: $ARGUMENTS

The machine token comes from the `CESSION_TOKEN` environment variable or, when that is unset, from the file `~/.config/cession/token` (under `$XDG_CONFIG_HOME` if set). The bundled `login.sh` gets one through a device login, like `gh auth login`, and writes that file itself. Never ask the user to paste the token, never print it, never write it to any file yourself, and never substitute its value into a command — use the `token=` line below and let the shell expand it.

1. Get the cession Worker URL (for example `https://cession.<you>.workers.dev`) from the arguments, otherwise ask the user. Remove any trailing `/`. Stop unless the URL matches `^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$`, or `^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$` for local testing. If it is plain http to another host, tell the user the token would cross the network in plain text, so it must be https (`report.sh` refuses such URLs too); otherwise say it contains characters a cession URL never has, which matters because the URL is pasted into shell commands below.
2. Check the dependencies with `command -v jq curl`. If either is missing, tell the user to install it (`brew install jq`) and stop.
3. Check for a token:
   ```sh
   token=${CESSION_TOKEN:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/cession/token" 2>/dev/null)}; [ -n "$token" ] && echo set || echo missing
   ```
   If missing, log this machine in. Substitute URL, and run it with a Bash timeout of 660000 ms, since it waits up to 10 minutes for approval:
   ```sh
   sh "${CLAUDE_SKILL_DIR}/login.sh" "URL"
   ```
   It prints a link and a code, and opens the link in a browser when it can. Tell the user to open the link in a browser signed in to cession (signing in first if asked), check that the code and machine name match, and click Approve. It exits 0 once the token is saved; otherwise stop and show its message. A user who prefers to manage the token by hand can instead create one on the Devices page ("New token") and put it in `CESSION_TOKEN` or the token file.
4. Check the server and token. Substitute URL:
   ```sh
   token=${CESSION_TOKEN:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/cession/token" 2>/dev/null)}
   printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -s -o /dev/null -w '%{http_code}\n' -K - -X POST "URL/events" -H 'Content-Type: application/json' -d '{}'
   ```
   - `400`: the URL and token are correct, so continue.
   - `401`: the token is wrong or was revoked. If `CESSION_TOKEN` is unset, run `login.sh` as in step 3 again (it replaces the token file) and repeat this step; otherwise tell the user to update or unset `CESSION_TOKEN`, and stop.
   - Anything else: the URL is unreachable or wrong, so stop and show the code.
5. Check for OTel settings this setup would overwrite:
   ```sh
   f="$HOME/.claude/settings.json"
   [ -f "$f" ] && jq -r '(.env // {} | to_entries[] | select(.key | startswith("OTEL_")) | if (.key | test("HEADERS")) then "\(.key)=<redacted>" else "\(.key)=\(.value)" end), (.otelHeadersHelper // empty | "otelHeadersHelper=\(.)")' "$f"
   ```
   If this lists any `OTEL_` key or `otelHeadersHelper` whose value differs from what step 6 will write, show the user the affected keys (`HEADERS` values print as `<redacted>`; treat any existing `HEADERS` key as differing — step 6 removes it) and ask them to confirm before continuing.
6. Merge the settings with the following command, which keeps every other key in the file. Substitute URL. It writes no secret: `otelHeadersHelper` builds the OTel header at runtime from the same environment variable or token file, and any token left by an older cession setup is removed.
   ```sh
   f="$HOME/.claude/settings.json"; [ -f "$f" ] || echo '{}' > "$f"
   cp "$f" "$f.bak"
   helper='sh -c '\''t=${CESSION_TOKEN:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/cession/token" 2>/dev/null)}; printf "%s\n" "$t" | jq -Rc "{Authorization: (\"Bearer \" + .)}"'\'''
   jq --arg url "URL" --arg helper "$helper" '($url | rtrimstr("/")) as $u
     | .env = ((.env // {}) | del(.CESSION_TOKEN, .OTEL_EXPORTER_OTLP_METRICS_HEADERS)) + {
         CESSION_URL: $u,
         CLAUDE_CODE_ENABLE_TELEMETRY: "1",
         OTEL_METRICS_EXPORTER: "otlp",
         OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json",
         OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: ($u + "/v1/metrics")
       }
     | .otelHeadersHelper = $helper' \
     "$f" > "$f.tmp" && cat "$f.tmp" > "$f" && rm -f "$f.tmp" || { rm -f "$f.tmp"; echo "settings.json is not valid JSON; nothing changed" >&2; }
   ```
   If `jq` fails because the file is not valid JSON, stop and tell the user. Do not overwrite the file.
7. Tell the user that setup is done, that a backup is at `~/.claude/settings.json.bak` (it may contain a token from an older setup — suggest deleting it once things work), and that they should restart Claude Code for the change to apply. Optionally, set `CESSION_MACHINE` in the same `env` block to override the machine name, which defaults to `hostname -s`.
