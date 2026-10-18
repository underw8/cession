# cession

See every Claude Code session on all your machines in one place. For each session it shows the machine, project and branch, whether it's working, waiting on you or idle, and what it costs. It also keeps daily and per-project cost history.

```
Claude Code ── hooks ──> POST /events ─────┐
Claude Code ── OTel ───> POST /v1/metrics ─┤
                                           ▼
                  Cloudflare Worker + Durable Object (SQLite)
                                           │
   Dashboard / macOS widget  <── WS /live ─┘   (passkey login)
```

## Components

- **`server/`** is a Cloudflare Worker that ingests events and metrics, stores sessions, and serves the live dashboard.
- **`plugin/`** is a Claude Code plugin. Its hooks report session events, and its `/cession:setup` skill wires up OTel cost metrics.
- **`widget/`** is a macOS floating panel that shows the dashboard. It stays on top, even over fullscreen apps, and you can drag and resize it.

## Deploy the server

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/underw8/cession/tree/main/server)

Prompts you for `SETUP_CODE` (a random string of at least 32 characters, e.g. `openssl rand -hex 16`) and deploys to your own `*.workers.dev` subdomain. Or deploy by hand:

```bash
cd server
npm install
npx wrangler login
npx wrangler secret put SETUP_CODE   # random, at least 32 characters
npx wrangler deploy
```

## First run

1. Open the deployed URL, enter your setup code, and register a passkey — that's the only login. Keep the setup code to recover a lost passkey.
2. On each machine, install the plugin and run setup in Claude Code:
   ```
   /plugin marketplace add underw8/cession
   /plugin install cession@cession
   /cession:setup https://cession.<you>.workers.dev
   ```
   Like `gh auth login`, setup shows a code and opens your cession site; check the machine name and click **Approve**. The machine's token is saved to `~/.config/cession/token`, readable only by you, so it works where Claude Code never reads your shell profile (code-server, an app launched from the Dock). Setup also writes `CESSION_URL` and the OTel settings to `~/.claude/settings.json`, and keeps a `.bak` backup.

   To manage the token by hand instead, create one under **Devices → New token** and set `CESSION_TOKEN`, which takes precedence over the file.

The hook needs `jq` and `curl`. To override the machine name, set `CESSION_MACHINE`; otherwise it's `hostname -s`.

## Security

- Treat `SETUP_CODE` like a password: anyone who knows it can add a passkey.
- A signed-in browser session can add passkeys too. Revoke any session or passkey you don't recognise on the **Devices** page.

## Updating

- **Server:** pull the latest code and run `make deploy` (or `npx wrangler deploy` in `server/`). If you deployed with the button, sync your copy from upstream on GitHub and Workers Builds redeploys it.
- **Plugin:** run `/plugin marketplace update cession` in Claude Code, then restart it.
- **Widget:** download the newest `.dmg` from Releases, or `git pull` and `make widget`.

## macOS widget

Download the `.dmg` from the latest [widget release](https://github.com/underw8/cession/releases?q=widget) (Apple silicon), open it and drag **cession-widget** to Applications. The build isn't signed, so the first time, right-click the app in Applications and choose **Open**, then confirm. Or build it yourself:

```bash
cd widget
cargo run
```

- The widget has no Dock icon. Use the menu bar icon to show it, pair it with a server, reload it after a deploy (**Reload status**) or quit it.
- Hover the widget to show its bar: drag ⠿ to move it, ↕ switches between the full panel and a thin bar, ⇥ sends it to the next display, ✕ hides it. Drag the bottom-right grip to resize.
- In bar mode it shows one line per session with its run time and cost, and today's total; the bar pulses amber while a session is waiting for you.
- ⌘-drag anywhere also moves it.
- Resize it from any edge or corner, or ⌥-drag anywhere to resize from the nearest corner.
- Its size and position are remembered between launches.
- On first launch, pair it: open **Devices** in the dashboard, click "Pair widget" for a code, and enter the server URL and code in the widget. It remembers the server after that. Repair against a different server any time from the tray's "Pair with server…" item.

## Develop

Run `make` to list shortcuts: `make test`, `make deploy` (tests first), `make widget` (rebuild and relaunch), `make icons`.

```bash
cd server
npm run dev            # http://localhost:8787, auth bypassed for local testing
npm test
npm run typecheck
sh ../plugin/test.sh   # end-to-end hook test against npm run dev
```

To test real passkey login locally instead of the bypass, put `SETUP_CODE=<your own value>` in `server/.dev.vars` (copied from `.dev.vars.example`) and run `npx wrangler dev --local-upstream localhost:8787` directly, without `npm run dev`'s `--var DEV_SKIP_AUTH:1`.

