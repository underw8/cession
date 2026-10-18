---
name: setup
description: Configure this machine to report Claude Code sessions and cost to a cession server
disable-model-invocation: true
---

Configure cession on this machine. Arguments, if given: $ARGUMENTS

The bundled `setup.sh` does all of it: checks the URL and dependencies, logs the machine in with a device login (like `gh auth login`) when it has no token, checks the token against the server, and merges the hook and OTel settings into `~/.claude/settings.json`. Never ask the user for the token, never print it, and never read the token file yourself.

1. Get the cession Worker URL (for example `https://cession.<you>.workers.dev`) from the arguments, otherwise ask the user.
2. Run the script in the background (it can wait up to 10 minutes for approval), substituting URL:
   ```sh
   sh "${CLAUDE_SKILL_DIR}/setup.sh" "URL"
   ```
   As soon as its output shows a link and a code, tell the user to open the link in a browser signed in to cession (signing in first if asked), check that the code and machine name match, and click Approve. Then wait for the script to finish.
3. Act on its exit code:
   - `0`: setup is done. Relay the script's last lines: restart Claude Code, and delete `~/.claude/settings.json.bak` once things work.
   - `3`: existing OTel settings would be replaced. Show the user the keys it listed and ask whether to continue. If they agree, run it again with `--yes` as the second argument: `sh "${CLAUDE_SKILL_DIR}/setup.sh" "URL" --yes`.
   - `1`: stop and show its error message.

A user who prefers to manage the token by hand can create one on the Devices page ("New token") and put it in `CESSION_TOKEN` or `~/.config/cession/token`; the script then skips the login.
